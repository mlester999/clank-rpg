-- Clank RPG — HERO VERSIONS, stable public hero ids and admin rerolls.
--
-- A hero is ONE permanent identity (characters.id + telegram_user_id). What changes over time is only its generated RPG state:
-- class, rarity, generated stat components, look. That state becomes an immutable, append-only HISTORY of versions:
--
--   v1 INITIAL   — captured from the hero exactly as it is today (no re-roll, no new seed, nothing re-derived)
--   v2 REROLL    — an admin-approved candidate from the SAME generator that creates new heroes
--   v3 ROLLBACK  — an exact copy of an older version, appended (history is never rewritten or deleted)
--
-- WHICH REPRESENTATION IS AUTHORITATIVE
--   hero_versions  +  characters.current_hero_version_id   ← the source of truth (ONE pointer ⇒ exactly one current version)
--   characters.class_id · character_stats.{variation, telegram_bonus} · character_appearances.{rarity, parts, seed, sprite}
--                                                          ← the MATERIALISED current projection. Every reader (combat, the arena
--                                                            snapshots, leaderboards, cards) keeps reading these columns unchanged;
--                                                            they are written ONLY together with the pointer, in one transaction.
--   Split brain is refused by the database itself: deferred constraint triggers compare the projection with the current version at
--   COMMIT and abort the transaction if they differ, and every hero must have a current version at commit (a hero can never exist
--   without its INITIAL v1). public.audit_hero_versions() reports any violation (it must return zero rows).
--
-- NOT versioned on purpose: name / name_override (presentation), moderation status, claims, wallets, profile photos, cosmetic_overrides,
-- wallet-derived stat components (holdings/loyalty/trading), gear, tactics. Those never move when a hero is rerolled or rolled back.
-- characters.power stays what it was: the cached EFFECTIVE power (generated stats + wallet/gear parts). A version's `stats`/`power` are the
-- GENERATED figures (class base + variation + Telegram bonus, or the authored fixed stats) — equal to the effective ones whenever a hero has
-- no wallet or gear bonus (true for every hero today).
--
-- Historical battles are untouched: every battle carries its own frozen snapshot (units + display) and ruleset hash. Nothing here reads or
-- writes arena tables; the application refuses to change a hero that sits in an unsettled (SCHEDULED / SIMULATED) roster.

-- ---------------------------------------------------------------------------
-- 1. Stable PUBLIC hero id — what public URLs use. Random, permanent, collision-safe; never derived from the name, the Telegram id
--    or a sequence, so renaming, rerolling or a duplicate display name can never change or collide with it.
--    12 symbols from 31 (no 0 / 1 / i / l / o) ⇒ ~7.8e17 ids.
-- ---------------------------------------------------------------------------

create or replace function public.new_hero_public_id()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  bytes bytea;
  candidate text;
  i integer;
begin
  loop
    bytes := decode(md5(gen_random_uuid()::text || clock_timestamp()::text), 'hex');
    candidate := '';
    for i in 0..11 loop
      candidate := candidate || substr(alphabet, 1 + (get_byte(bytes, i) % 31), 1);
    end loop;
    exit when not exists (select 1 from public.characters where public_id = candidate);
  end loop;
  return candidate;
end;
$$;

-- The two backfill UPDATEs below must not look like a "change" to the 70 existing heroes: keep updated_at exactly as it was.
alter table public.characters disable trigger characters_updated_at;

alter table public.characters add column public_id text;
update public.characters set public_id = public.new_hero_public_id() where public_id is null;
alter table public.characters alter column public_id set default public.new_hero_public_id();
alter table public.characters alter column public_id set not null;
alter table public.characters add constraint characters_public_id_format check (public_id ~ '^[2-9a-hj-km-np-z]{12}$');
create unique index characters_public_id_key on public.characters (public_id);

create or replace function public.guard_hero_public_id()
returns trigger
language plpgsql
as $$
begin
  if new.public_id is distinct from old.public_id then
    raise exception 'a hero''s public id is permanent' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger characters_guard_public_id before update on public.characters
  for each row execute function public.guard_hero_public_id();

-- ---------------------------------------------------------------------------
-- 2. The version history (immutable, append-only)
-- ---------------------------------------------------------------------------

create table public.hero_versions (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  version_number integer not null check (version_number >= 1),
  action text not null check (action in ('INITIAL', 'REROLL', 'ROLLBACK')),
  -- ROLLBACK: the older version whose state this one copies.  REROLL / ROLLBACK: the version that was current just before.
  source_version_id uuid,
  previous_version_id uuid,
  -- Idempotency key: the preview id of an applied reroll, or the caller's key for a rollback. A retry returns the same row.
  request_id uuid,
  -- INTERNAL. Never sent to a browser or a public page. For heroes that existed before versioning this is the stored 16-character seed.
  generation_seed text not null check (char_length(generation_seed) between 1 and 128),
  generator_version text not null check (char_length(generator_version) between 1 and 40),
  class_id text not null references public.character_classes (id),
  rarity text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  -- The generated components the engine's stat formula reads (projected into character_stats) …
  variation jsonb not null,
  telegram_bonus jsonb not null,
  -- … and the figures they add up to (class base + variation + Telegram bonus, or the authored fixed stats), captured when the version was made.
  stats jsonb not null,
  power integer not null check (power >= 0),
  -- The look: the value stored in character_appearances.seed / .parts / .sprite (sprite NULL = a legacy hero whose sprite is derived from `parts`).
  appearance_seed text not null,
  appearance jsonb not null,
  sprite jsonb,
  -- Render / portrait configuration that applies to the version (which sprite set drew it).
  render jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- 'system:…' for versions made by the migration or by hero creation, 'admin' (the audited actor) for rerolls and rollbacks.
  created_by text not null check (char_length(created_by) between 1 and 80),
  unique (character_id, version_number),
  unique (id, character_id),
  foreign key (source_version_id, character_id) references public.hero_versions (id, character_id),
  foreign key (previous_version_id, character_id) references public.hero_versions (id, character_id),
  check ((action = 'INITIAL') = (version_number = 1)),
  check ((action = 'ROLLBACK') = (source_version_id is not null)),
  check ((action = 'INITIAL') = (previous_version_id is null)),
  check ((action = 'INITIAL') = (request_id is null))
);
create index hero_versions_character_idx on public.hero_versions (character_id, version_number desc);
-- Exactly one INITIAL per hero (also makes the backfill and concurrent creation idempotent).
create unique index hero_versions_one_initial on public.hero_versions (character_id) where action = 'INITIAL';
create unique index hero_versions_request_key on public.hero_versions (request_id) where request_id is not null;

-- Immutable: no UPDATE ever; DELETE only as the cascade of deleting the whole character (its parent row is already gone then).
create or replace function public.guard_hero_version_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'hero versions are immutable (update rejected)' using errcode = '23000';
  end if;
  if exists (select 1 from public.characters where id = old.character_id) then
    raise exception 'hero versions are append-only (delete rejected)' using errcode = '23000';
  end if;
  return old;
end;
$$;
create trigger hero_versions_immutable before update or delete on public.hero_versions
  for each row execute function public.guard_hero_version_immutable();

-- The pointer. The composite FK makes it impossible to point at another hero's version.
alter table public.characters add column current_hero_version_id uuid;
alter table public.characters
  add constraint characters_current_version_fk foreign key (current_hero_version_id, id)
  references public.hero_versions (id, character_id);

comment on column public.characters.current_hero_version_id is
  'AUTHORITATIVE pointer to the hero''s current version (hero_versions). class_id and the generated stat/appearance columns are its projection.';

-- ---------------------------------------------------------------------------
-- 3. Reroll candidates — previews are NOT versions. A row is a short-lived, server-generated candidate; applying it (and only that)
--    appends a version. The browser never supplies a seed, class, rarity or any stat: it can only name a preview it was shown.
-- ---------------------------------------------------------------------------

create table public.hero_reroll_previews (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  -- The version that was current when the candidate was drawn: applying is refused if the hero moved on since (stale preview).
  base_version_id uuid not null,
  -- INTERNAL server-generated seed (HMAC-derived, 128-bit random nonce). The candidate below is reproducible from it.
  generation_seed text not null check (char_length(generation_seed) between 1 and 128),
  candidate jsonb not null,
  created_by text not null check (char_length(created_by) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  applied_version_id uuid references public.hero_versions (id),
  applied_at timestamptz,
  foreign key (base_version_id, character_id) references public.hero_versions (id, character_id),
  check (expires_at > created_at),
  check ((applied_version_id is null) = (applied_at is null))
);
create index hero_reroll_previews_character_idx on public.hero_reroll_previews (character_id, created_at desc);
create index hero_reroll_previews_expiry_idx on public.hero_reroll_previews (expires_at);

-- ---------------------------------------------------------------------------
-- 4. Version 1 for every hero that exists today — a pure SNAPSHOT of what is stored. Nothing is re-rolled or re-derived:
--    class, rarity, components, seed, parts and sprite are copied verbatim; only the two summary figures (`stats`, `power`) are computed,
--    with the exact arithmetic the application uses (IEEE doubles, same addition order, round-half-up).
-- ---------------------------------------------------------------------------

create or replace function public.hero_generated_stat(p_base jsonb, p_variation jsonb, p_telegram jsonb, p_fixed jsonb, p_key text)
returns integer
language sql
immutable
as $$
  select case
    when p_fixed is not null
      then greatest(1, floor(coalesce((p_fixed ->> p_key)::double precision, 0) + 0.5))::integer
    else greatest(1, floor(
           ((coalesce((p_base ->> p_key)::double precision, 0) + coalesce((p_variation ->> p_key)::double precision, 0))
              + coalesce((p_telegram ->> p_key)::double precision, 0)) + 0.5))::integer
  end
$$;

create or replace function public.hero_snapshot_initial_version(p_character_id uuid, p_created_by text default 'system')
returns uuid
language plpgsql
as $$
declare
  c public.characters%rowtype;
  s public.character_stats%rowtype;
  a public.character_appearances%rowtype;
  v_base jsonb;
  v_weights jsonb;
  v_visuals jsonb;
  v_stats jsonb;
  v_power double precision;
  v_id uuid;
begin
  select * into c from public.characters where id = p_character_id;
  if not found then
    raise exception 'unknown character %', p_character_id using errcode = '23503';
  end if;

  select id into v_id from public.hero_versions where character_id = p_character_id and action = 'INITIAL';
  if found then
    update public.characters set current_hero_version_id = v_id where id = p_character_id and current_hero_version_id is null;
    return v_id;
  end if;

  select * into s from public.character_stats where character_id = p_character_id;
  select * into a from public.character_appearances where character_id = p_character_id;
  if s.character_id is null or a.character_id is null then
    raise exception 'hero % has no stats / appearance rows to capture', p_character_id using errcode = '23514';
  end if;

  select definition -> 'base' into v_base from public.character_classes where id = c.class_id;
  v_stats := jsonb_build_object(
    'hp',   public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'hp'),
    'str',  public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'str'),
    'def',  public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'def'),
    'int',  public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'int'),
    'agi',  public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'agi'),
    'cha',  public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'cha'),
    'luck', public.hero_generated_stat(v_base, s.variation, s.telegram_bonus, s.fixed_stats, 'luck'));

  select case when jsonb_typeof(value) = 'object' then value -> 'power' end into v_weights from public.game_settings where key = 'character';
  if v_weights is null or jsonb_typeof(v_weights) <> 'object' then
    v_weights := '{"hp": 0.4, "str": 2, "def": 2, "int": 2, "agi": 2, "cha": 1, "luck": 1}'::jsonb;
  end if;
  v_power := (((((( 0::double precision
      + (v_stats ->> 'hp')::double precision   * (v_weights ->> 'hp')::double precision)
      + (v_stats ->> 'str')::double precision  * (v_weights ->> 'str')::double precision)
      + (v_stats ->> 'def')::double precision  * (v_weights ->> 'def')::double precision)
      + (v_stats ->> 'int')::double precision  * (v_weights ->> 'int')::double precision)
      + (v_stats ->> 'agi')::double precision  * (v_weights ->> 'agi')::double precision)
      + (v_stats ->> 'cha')::double precision  * (v_weights ->> 'cha')::double precision)
      + (v_stats ->> 'luck')::double precision * (v_weights ->> 'luck')::double precision;

  select case when jsonb_typeof(value) = 'object' then value end into v_visuals from public.game_settings where key = 'visuals';

  insert into public.hero_versions (
    character_id, version_number, action, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus,
    stats, power, appearance_seed, appearance, sprite, render, created_at, created_by)
  values (
    p_character_id, 1, 'INITIAL', a.seed, 'hero-gen/1', c.class_id, a.rarity, s.variation, s.telegram_bonus,
    v_stats, floor(v_power + 0.5)::integer, a.seed, a.parts, a.sprite,
    jsonb_build_object('spriteSet', coalesce(v_visuals ->> 'spriteSet', 'clank-dev-v1')), c.created_at, p_created_by)
  returning id into v_id;

  update public.characters set current_hero_version_id = v_id where id = p_character_id;
  return v_id;
end;
$$;

-- Backfill: every existing hero (ACTIVE, SUSPENDED, INACTIVE, special, demo — moderation is irrelevant here) gets exactly one INITIAL v1.
select public.hero_snapshot_initial_version(c.id, 'system:migration:20261005001800') from public.characters c where c.current_hero_version_id is null;

alter table public.characters enable trigger characters_updated_at;

-- ---------------------------------------------------------------------------
-- 5. Integrity: the projection must equal the current version — and every hero must have one — at COMMIT.
--    (Created AFTER the backfill: a deferred trigger and the backfill's own writes cannot share a transaction with later DDL.)
-- ---------------------------------------------------------------------------

create or replace function public.hero_projection_mismatch(p_character_id uuid)
returns text
language plpgsql
stable
as $$
declare
  c public.characters%rowtype;
  v public.hero_versions%rowtype;
  s public.character_stats%rowtype;
  a public.character_appearances%rowtype;
begin
  select * into c from public.characters where id = p_character_id;
  if not found then return null; end if;
  if c.current_hero_version_id is null then return 'NO_CURRENT_VERSION'; end if;
  select * into v from public.hero_versions where id = c.current_hero_version_id;
  select * into s from public.character_stats where character_id = p_character_id;
  select * into a from public.character_appearances where character_id = p_character_id;
  if s.character_id is null then return 'MISSING_STATS_ROW'; end if;
  if a.character_id is null then return 'MISSING_APPEARANCE_ROW'; end if;
  if c.class_id <> v.class_id then return 'CLASS'; end if;
  if a.rarity <> v.rarity then return 'RARITY'; end if;
  if a.parts is distinct from v.appearance then return 'APPEARANCE'; end if;
  if a.seed <> v.appearance_seed then return 'SEED'; end if;
  if v.sprite is not null and a.sprite is distinct from v.sprite then return 'SPRITE'; end if;
  if s.variation is distinct from v.variation then return 'VARIATION'; end if;
  if s.telegram_bonus is distinct from v.telegram_bonus then return 'TELEGRAM_BONUS'; end if;
  return null;
end;
$$;

create or replace function public.check_hero_projection()
returns trigger
language plpgsql
as $$
declare
  cid uuid;
  problem text;
begin
  if tg_table_name = 'characters' then
    cid := new.id;
  else
    cid := new.character_id;
  end if;
  problem := public.hero_projection_mismatch(cid);
  -- "no current version" has its own, clearer trigger below (require_current_hero_version).
  if problem is not null and problem <> 'NO_CURRENT_VERSION' then
    raise exception 'hero % is inconsistent with its current hero version (%): class, stats and look change only through a new hero version', cid, problem
      using errcode = '23514';
  end if;
  return null;
end;
$$;

create constraint trigger characters_hero_projection
  after insert or update of class_id, current_hero_version_id on public.characters
  deferrable initially deferred for each row execute function public.check_hero_projection();
create constraint trigger character_stats_hero_projection
  after insert or update of variation, telegram_bonus on public.character_stats
  deferrable initially deferred for each row execute function public.check_hero_projection();
create constraint trigger character_appearances_hero_projection
  after insert or update of rarity, parts, seed, sprite on public.character_appearances
  deferrable initially deferred for each row execute function public.check_hero_projection();

-- Never a hero without its version: creation must insert the INITIAL v1 in the same transaction or the whole creation fails.
create or replace function public.require_current_hero_version()
returns trigger
language plpgsql
as $$
begin
  if not exists (select 1 from public.characters where id = new.id and current_hero_version_id is not null) then
    raise exception 'hero % has no current hero version (every hero must be created together with its INITIAL v1)', new.id using errcode = '23514';
  end if;
  return null;
end;
$$;
create constraint trigger characters_require_current_version
  after insert or update of current_hero_version_id on public.characters
  deferrable initially deferred for each row execute function public.require_current_hero_version();

-- The auditor: every row it returns is a violation. Expected result: no rows.
create or replace function public.audit_hero_versions()
returns table (character_id uuid, problem text)
language sql
stable
as $$
  select c.id, 'NO_CURRENT_VERSION'::text from public.characters c where c.current_hero_version_id is null
  union all
  select c.id, 'NO_INITIAL_VERSION' from public.characters c
   where not exists (select 1 from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL')
  union all
  select g.character_id, 'VERSION_NUMBERS_NOT_CONTIGUOUS'
    from (select v.character_id, count(*) as n, max(v.version_number) as hi, min(v.version_number) as lo from public.hero_versions v group by v.character_id) g
   where g.lo <> 1 or g.hi <> g.n
  union all
  select c.id, 'CURRENT_IS_NOT_THE_LATEST_VERSION' from public.characters c
   where c.current_hero_version_id is not null
     and c.current_hero_version_id <> (select v.id from public.hero_versions v where v.character_id = c.id order by v.version_number desc limit 1)
  union all
  select c.id, 'PROJECTION_' || public.hero_projection_mismatch(c.id) from public.characters c
   where c.current_hero_version_id is not null and public.hero_projection_mismatch(c.id) is not null
$$;

select public.clank_harden_schema();
