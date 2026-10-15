-- 2700 — EVENTS: immutable champion snapshots, season-scoped history reads, and the launch backup attestation.
--
-- What this migration is for
--   · The Events page shows who won each COMPLETED Daily / Weekly period of Arena Picks and of Hero Arena. The ranking, the eligibility, the ties and the prizes of
--     a finished period are already FROZEN (arena_leaderboards / arena_leaderboard_results, hero_arena_boards / hero_arena_results — immutable, written once by
--     the existing, idempotent finalizers). What those rows do not carry is the HERO as it looked then: its portrait, its PWR, its hero version. A hero can be
--     rerolled later; a champion of last week must not change when that happens. So every frozen result row gets ONE immutable companion snapshot row, written
--     by the database itself in the SAME transaction as the result row (an AFTER INSERT trigger) — no code path can finalize a period without it, and a retried
--     finalization (which inserts nothing: the first insert wins) can never write a second one.
--   · The snapshot takes the hero version that was in force when the period CLOSED (the newest version created before the period's end; the current version when
--     the hero has none older), so a finalization that runs late still records the hero as it was at the end of the period. PWR is the version's own stored PWR —
--     the figure the hero's profile and card show — never the cached `characters.power`.
--   · An index so Events can list a season's finalized Arena Picks boards without scanning (Hero Arena already has one: hero_arena_boards_season_idx).
--   · `launch_backup_attestations`: the operator's append-only statement that a backup of THIS schema version was taken and verified, required by the Season 1
--     launch preflight. The application cannot inspect a Supabase backup itself, so it records who attested what and when — never pretends to have verified it.
--   · Two read-only auditors: audit_event_champions() (every frozen result of an official season has its snapshot) and audit_launch_isolation() (once the game is
--     LIVE, nothing from the development run is attributed to an official season).
--
-- What it does NOT do: it changes no hero, no hero version, no appearance, no battle, no hash, no frozen board or result, no reward row and no setting; deletes
-- nothing; backfills nothing (the snapshots of already-finalized DEVELOPMENT boards would be "today's hero", not history — and development boards are never shown
-- on Events); applies no reset and launches nothing. Additive and forward-only. Safe to apply before the matching code is deployed (the previous app version
-- ignores the new tables), and the new code tolerates a missing snapshot.

do $$
begin
  if to_regclass('public.arena_leaderboard_results') is null or to_regclass('public.hero_arena_results') is null then
    raise exception 'event_champion_snapshots: the Arena Picks and Hero Arena reward migrations (20261005001400, 20261007002200) must be applied first';
  end if;
  if to_regclass('public.game_state') is null or to_regclass('public.hero_versions') is null then
    raise exception 'event_champion_snapshots: the lifecycle and hero version migrations (20261006002000, 20261005001800) must be applied first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Snapshot of the hero behind each frozen result
-- ---------------------------------------------------------------------------

create table public.arena_leaderboard_result_snapshots (
  kind text not null,
  period_start date not null,
  telegram_user_id bigint not null,
  character_id uuid not null references public.characters (id),
  -- The stable, permanent public id of the hero (its URL). Whether the hero may still be LINKED is decided when the page is read (suspended / banned = no link).
  public_id text not null,
  hero_version_id uuid not null references public.hero_versions (id),
  version_number integer not null check (version_number >= 1),
  class_id text not null,
  rarity text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  -- The version's own stored PWR: the figure the hero's profile and card show.
  power integer not null check (power >= 0),
  -- Everything a portrait needs: { rarity, parts, sprite, overrides } exactly as stored for that version (the internal generation seed is NOT copied).
  look jsonb not null,
  created_at timestamptz not null default now(),
  primary key (kind, period_start, telegram_user_id),
  foreign key (kind, period_start, telegram_user_id) references public.arena_leaderboard_results (kind, period_start, telegram_user_id)
);
create trigger arena_leaderboard_result_snapshots_append_only before update or delete on public.arena_leaderboard_result_snapshots
  for each row execute function public.forbid_mutation();
comment on table public.arena_leaderboard_result_snapshots is
  'The hero behind a FROZEN Arena Picks result, as it was when the period closed (hero version, class, rarity, PWR, look). Written by trigger in the same transaction as the result; immutable.';

create table public.hero_arena_result_snapshots (
  kind text not null,
  period_start date not null,
  character_id uuid not null references public.characters (id),
  public_id text not null,
  hero_version_id uuid not null references public.hero_versions (id),
  version_number integer not null check (version_number >= 1),
  class_id text not null,
  rarity text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  power integer not null check (power >= 0),
  look jsonb not null,
  created_at timestamptz not null default now(),
  primary key (kind, period_start, character_id),
  foreign key (kind, period_start, character_id) references public.hero_arena_results (kind, period_start, character_id)
);
create trigger hero_arena_result_snapshots_append_only before update or delete on public.hero_arena_result_snapshots
  for each row execute function public.forbid_mutation();
comment on table public.hero_arena_result_snapshots is
  'The hero behind a FROZEN Hero Arena result, as it was when the period closed (hero version, class, rarity, PWR, look). Written by trigger in the same transaction as the result; immutable.';

-- The hero version in force at the END of a period: the newest version created before the period closed; the current version if the hero has none that old.
create or replace function public.hero_version_at(hero uuid, at_ts timestamptz)
returns uuid
language sql
stable
as $$
  select coalesce(
    (select v.id from public.hero_versions v where v.character_id = hero and v.created_at < at_ts order by v.version_number desc limit 1),
    (select c.current_hero_version_id from public.characters c where c.id = hero)
  )
$$;

create or replace function public.period_end_at(period_kind text, period_start date)
returns timestamptz
language sql
immutable
as $$
  select ((period_start + case when period_kind = 'DAILY' then 1 else 7 end)::timestamp at time zone 'UTC')
$$;

-- One function writes the snapshot for both programs (the two tables have the same shape after the key).
create or replace function public.snapshot_picks_result()
returns trigger
language plpgsql
as $$
begin
  if new.character_id is null then
    return new; -- a result with no hero behind it has nothing to snapshot; the frozen name / class stay on the result itself
  end if;
  insert into public.arena_leaderboard_result_snapshots (kind, period_start, telegram_user_id, character_id, public_id, hero_version_id, version_number, class_id, rarity, power, look)
  select new.kind, new.period_start, new.telegram_user_id, c.id, c.public_id, v.id, v.version_number, v.class_id, v.rarity, v.power,
         jsonb_build_object('rarity', v.rarity, 'parts', v.appearance, 'sprite', v.sprite, 'overrides', coalesce(ca.cosmetic_overrides, '{}'::jsonb))
    from public.characters c
    join public.hero_versions v on v.id = public.hero_version_at(c.id, public.period_end_at(new.kind, new.period_start))
    left join public.character_appearances ca on ca.character_id = c.id
   where c.id = new.character_id
  on conflict do nothing;
  return new;
end;
$$;
create trigger arena_leaderboard_results_snapshot after insert on public.arena_leaderboard_results
  for each row execute function public.snapshot_picks_result();

create or replace function public.snapshot_hero_result()
returns trigger
language plpgsql
as $$
begin
  insert into public.hero_arena_result_snapshots (kind, period_start, character_id, public_id, hero_version_id, version_number, class_id, rarity, power, look)
  select new.kind, new.period_start, c.id, c.public_id, v.id, v.version_number, v.class_id, v.rarity, v.power,
         jsonb_build_object('rarity', v.rarity, 'parts', v.appearance, 'sprite', v.sprite, 'overrides', coalesce(ca.cosmetic_overrides, '{}'::jsonb))
    from public.characters c
    join public.hero_versions v on v.id = public.hero_version_at(c.id, public.period_end_at(new.kind, new.period_start))
    left join public.character_appearances ca on ca.character_id = c.id
   where c.id = new.character_id
  on conflict do nothing;
  return new;
end;
$$;
create trigger hero_arena_results_snapshot after insert on public.hero_arena_results
  for each row execute function public.snapshot_hero_result();

-- ---------------------------------------------------------------------------
-- 2. Reads
-- ---------------------------------------------------------------------------

-- Events lists a season's finalized Arena Picks boards newest first.
create index arena_leaderboards_season_idx on public.arena_leaderboards (season_id, kind, period_start desc) where season_id is not null;

-- ---------------------------------------------------------------------------
-- 3. The launch backup attestation (operator statement; append-only)
-- ---------------------------------------------------------------------------

create table public.launch_backup_attestations (
  id uuid primary key default gen_random_uuid(),
  attested_by text not null check (char_length(attested_by) between 1 and 80),
  attested_at timestamptz not null default now(),
  -- Where the backup lives (a Supabase backup / PITR restore point, a dump file name + checksum, …). Free text, required: an attestation with no reference is not one.
  reference text not null check (char_length(btrim(reference)) between 3 and 300),
  -- true = the operator restored it somewhere (or otherwise verified it is usable); false = taken but not yet verified. Only true satisfies the preflight.
  verified boolean not null,
  -- The newest applied migration when the backup was taken: a migration applied after the backup makes the backup stale for the launch.
  schema_version text not null check (schema_version ~ '^\d{14}$'),
  notes text check (notes is null or char_length(notes) <= 1000)
);
create index launch_backup_attestations_at_idx on public.launch_backup_attestations (attested_at desc);
create trigger launch_backup_attestations_append_only before update or delete on public.launch_backup_attestations
  for each row execute function public.forbid_mutation();
comment on table public.launch_backup_attestations is
  'Operator attestations that a backup was taken (and verified) before the Season 1 launch. The application cannot inspect a backup; this records who said so, when, and for which schema version.';

-- ---------------------------------------------------------------------------
-- 4. Auditors: every row is a finding. Expected result: no rows.
-- ---------------------------------------------------------------------------

create or replace function public.audit_event_champions()
returns table (problem text, detail text)
language sql
stable
as $$
  -- an official season's frozen Arena Picks result whose hero exists but has no snapshot
  select 'PICKS_RESULT_WITHOUT_SNAPSHOT'::text, r.kind || ' ' || r.period_start::text || ' ' || r.telegram_user_id::text
    from public.arena_leaderboard_results r
    join public.arena_leaderboards b on b.kind = r.kind and b.period_start = r.period_start
    join public.seasons s on s.id = b.season_id and s.kind = 'COMPETITIVE'
   where r.character_id is not null
     and not exists (select 1 from public.arena_leaderboard_result_snapshots x where x.kind = r.kind and x.period_start = r.period_start and x.telegram_user_id = r.telegram_user_id)
  union all
  select 'HERO_RESULT_WITHOUT_SNAPSHOT', r.kind || ' ' || r.period_start::text || ' ' || r.character_id::text
    from public.hero_arena_results r
    join public.hero_arena_boards b on b.kind = r.kind and b.period_start = r.period_start
    join public.seasons s on s.id = b.season_id and s.kind = 'COMPETITIVE'
   where not exists (select 1 from public.hero_arena_result_snapshots x where x.kind = r.kind and x.period_start = r.period_start and x.character_id = r.character_id)
  union all
  -- a snapshot that disagrees with the frozen result it belongs to (class / rarity are frozen on the result as well)
  select 'PICKS_SNAPSHOT_CLASS_MISMATCH', x.kind || ' ' || x.period_start::text || ' ' || x.telegram_user_id::text
    from public.arena_leaderboard_result_snapshots x
    join public.arena_leaderboard_results r on r.kind = x.kind and r.period_start = x.period_start and r.telegram_user_id = x.telegram_user_id
    join public.arena_leaderboards b on b.kind = r.kind and b.period_start = r.period_start
    join public.seasons s on s.id = b.season_id and s.kind = 'COMPETITIVE'
   where x.character_id is distinct from r.character_id
  union all
  select 'HERO_SNAPSHOT_MISMATCH', x.kind || ' ' || x.period_start::text || ' ' || x.character_id::text
    from public.hero_arena_result_snapshots x
    join public.hero_arena_results r on r.kind = x.kind and r.period_start = x.period_start and r.character_id = x.character_id
    join public.hero_arena_boards b on b.kind = r.kind and b.period_start = r.period_start
    join public.seasons s on s.id = b.season_id and s.kind = 'COMPETITIVE'
   where r.rarity is not null and r.rarity <> x.rarity
$$;

-- Once the game is LIVE, an official season holds nothing of the development run. Every row is a finding.
create or replace function public.audit_launch_isolation()
returns table (problem text, detail text)
language sql
stable
as $$
  -- a battle of an official season that predates the launch (impossible by construction: the season was created by the launch)
  select 'OFFICIAL_BATTLE_BEFORE_LAUNCH'::text, b.id::text
    from public.arena_battles b
    join public.seasons s on s.id = b.season_id and s.kind = 'COMPETITIVE'
    join public.game_state g on g.phase = 'LIVE'
   where b.created_at < g.launched_at
  union all
  -- an official season's pick score attached to a development battle (the season is stamped from the battle, so this would be tampering)
  select 'OFFICIAL_SCORE_FOR_DEVELOPMENT_BATTLE', sc.id::text
    from public.arena_pick_scores sc
    join public.seasons ss on ss.id = sc.season_id and ss.kind = 'COMPETITIVE'
    join public.arena_battles b on b.id = sc.battle_id
    join public.seasons bs on bs.id = b.season_id and bs.kind = 'DEVELOPMENT'
  union all
  -- a finalized board credited to an official season whose period closed before the launch
  select 'OFFICIAL_BOARD_BEFORE_LAUNCH', l.kind || ' ' || l.period_start::text
    from public.arena_leaderboards l
    join public.seasons s on s.id = l.season_id and s.kind = 'COMPETITIVE'
    join public.game_state g on g.phase = 'LIVE'
   where public.period_end_at(l.kind, l.period_start) <= g.launched_at
  union all
  select 'OFFICIAL_HERO_BOARD_BEFORE_LAUNCH', l.kind || ' ' || l.period_start::text
    from public.hero_arena_boards l
    join public.seasons s on s.id = l.season_id and s.kind = 'COMPETITIVE'
    join public.game_state g on g.phase = 'LIVE'
   where public.period_end_at(l.kind, l.period_start) <= g.launched_at
  union all
  -- an official season's hero record that exists before the season's first battle was settled (a record is only ever created by a settled battle)
  select 'OFFICIAL_RECORD_WITHOUT_BATTLE', ss.character_id::text
    from public.season_character_stats ss
    join public.seasons s on s.id = ss.season_id and s.kind = 'COMPETITIVE'
   where ss.battles > 0 and not exists (select 1 from public.arena_battles b where b.season_id = ss.season_id and b.status = 'SETTLED')
$$;

select public.clank_harden_schema();
