-- Clank RPG — FREE DAILY HERO REROLL: persistence and database-level guarantees (migration 2500).
--
-- A member may reroll their own hero ONCE per UTC calendar day, for free. The reroll itself is the existing hero-version machinery: it APPENDS a
-- `hero_versions` row (action 'REROLL', created_by 'member:<telegram id>') and moves the hero's pointer + projection in one transaction
-- (docs/HERO_VERSIONS.md). Nothing about the version model, the class guard, the projection triggers or any historical row changes here.
--
-- What this migration adds is only the ALLOWANCE and the rules that make it impossible to cheat at the database level:
--
--   hero_free_rerolls   one immutable row per USED free reroll: (member, UTC day) is the PRIMARY KEY, so a second reroll for the same member on the same UTC
--                       day cannot be inserted, whatever the application does (parallel requests, replays, two tabs, two servers). The row also names the
--                       version the reroll created, the version it replaced and the before/after class · rarity · PWR (a compact, permanent audit trail).
--   a guard trigger     a row can only describe a REAL player reroll: the hero belongs to that member, the version is a REROLL made by `member:<id>`, it is
--                       the direct successor of the version it says it replaced, the request key and the before/after figures match the version rows.
--   a deferred check    the other direction — a version made by a member can NOT commit without its allowance row. A reroll that is not counted cannot
--                       exist, and an allowance cannot be consumed without a reroll: they commit together or not at all.
--   audit_hero_free_rerolls()   every row it returns is a violation (must return none).
--
-- No existing row is read, rewritten or deleted. The feature itself is OFF until the feature flag `hero.free_reroll` is switched on in the Admin console
-- (the flag is seeded disabled; a missing flag also means disabled).

create table public.hero_free_rerolls (
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  -- The UTC calendar day the allowance was used on. Derived from `created_at` by the CHECK below, so the two can never disagree.
  utc_day date not null,
  character_id uuid not null references public.characters (id) on delete cascade,
  -- The client's idempotency key for this reroll (also stored on the hero version it created). A retry with the same key returns the same result.
  request_id uuid not null,
  hero_version_id uuid not null,
  previous_version_id uuid not null,
  from_class_id text not null,
  from_rarity text not null check (from_rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  from_power integer not null check (from_power >= 0),
  to_class_id text not null,
  to_rarity text not null check (to_rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  to_power integer not null check (to_power >= 0),
  created_at timestamptz not null default clock_timestamp(),
  -- THE LIMIT: one free reroll per member per UTC day. Enforced here, not in application memory.
  primary key (telegram_user_id, utc_day),
  unique (request_id),
  unique (hero_version_id),
  constraint hero_free_rerolls_day_matches_instant check (utc_day = (created_at at time zone 'UTC')::date),
  foreign key (hero_version_id, character_id) references public.hero_versions (id, character_id) on delete cascade,
  foreign key (previous_version_id, character_id) references public.hero_versions (id, character_id) on delete cascade,
  check (hero_version_id <> previous_version_id)
);
create index hero_free_rerolls_character_idx on public.hero_free_rerolls (character_id, created_at desc);
create index hero_free_rerolls_day_idx on public.hero_free_rerolls (utc_day);
comment on table public.hero_free_rerolls is
  'One row per USED free daily hero reroll. PRIMARY KEY (member, UTC day) = at most one per member per UTC day. Immutable; created in the same transaction as the REROLL hero version it describes.';

-- Immutable: never updated; deleted only as the cascade of deleting the whole hero (its parent row is already gone then).
create or replace function public.guard_hero_free_reroll_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'free reroll records are immutable (update rejected)' using errcode = '23000';
  end if;
  if exists (select 1 from public.characters where id = old.character_id) then
    raise exception 'free reroll records are append-only (delete rejected)' using errcode = '23000';
  end if;
  return old;
end;
$$;
create trigger hero_free_rerolls_immutable before update or delete on public.hero_free_rerolls
  for each row execute function public.guard_hero_free_reroll_immutable();

-- A row can only describe a REAL reroll of the member's OWN hero.
create or replace function public.guard_hero_free_reroll_insert()
returns trigger
language plpgsql
as $$
declare
  owner_id bigint;
  v public.hero_versions%rowtype;
  p public.hero_versions%rowtype;
begin
  select telegram_user_id into owner_id from public.characters where id = new.character_id;
  if owner_id is distinct from new.telegram_user_id then
    raise exception 'a free reroll belongs to the hero''s own member' using errcode = '23000';
  end if;
  select * into v from public.hero_versions where id = new.hero_version_id and character_id = new.character_id;
  select * into p from public.hero_versions where id = new.previous_version_id and character_id = new.character_id;
  if v.id is null or p.id is null then
    raise exception 'a free reroll must point at versions of the same hero' using errcode = '23503';
  end if;
  if v.action <> 'REROLL' or v.created_by <> 'member:' || new.telegram_user_id::text or v.request_id is distinct from new.request_id
     or v.previous_version_id is distinct from new.previous_version_id or v.version_number <> p.version_number + 1 then
    raise exception 'the free reroll does not match the hero version it claims to describe' using errcode = '23000';
  end if;
  if v.class_id <> new.to_class_id or v.rarity <> new.to_rarity or v.power <> new.to_power
     or p.class_id <> new.from_class_id or p.rarity <> new.from_rarity or p.power <> new.from_power then
    raise exception 'the free reroll''s before/after figures do not match the hero versions' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger hero_free_rerolls_guard before insert on public.hero_free_rerolls
  for each row execute function public.guard_hero_free_reroll_insert();

-- The other direction: a version made by a MEMBER cannot commit unless its allowance row exists in the same transaction.
create or replace function public.check_member_reroll_has_allowance()
returns trigger
language plpgsql
as $$
begin
  if new.created_by like 'member:%' then
    if new.action <> 'REROLL' or not exists (select 1 from public.hero_free_rerolls r where r.hero_version_id = new.id) then
      raise exception 'a member-made hero version must consume a free reroll (version % of hero %)', new.version_number, new.character_id using errcode = '23000';
    end if;
  end if;
  return null;
end;
$$;
create constraint trigger hero_versions_member_reroll_allowance after insert on public.hero_versions
  deferrable initially deferred for each row execute function public.check_member_reroll_has_allowance();

-- The auditor: every row it returns is a violation. Expected result: no rows.
create or replace function public.audit_hero_free_rerolls()
returns table (ref text, problem text)
language sql
stable
as $$
  select v.character_id::text || ':' || v.version_number::text, 'MEMBER_VERSION_WITHOUT_ALLOWANCE'
    from public.hero_versions v
   where v.created_by like 'member:%' and not exists (select 1 from public.hero_free_rerolls r where r.hero_version_id = v.id)
  union all
  select r.character_id::text || ':' || r.utc_day::text, 'ALLOWANCE_VERSION_IS_NOT_A_MEMBER_REROLL'
    from public.hero_free_rerolls r join public.hero_versions v on v.id = r.hero_version_id
   where v.action <> 'REROLL' or v.created_by <> 'member:' || r.telegram_user_id::text
  union all
  select r.character_id::text || ':' || r.utc_day::text, 'ALLOWANCE_FOR_ANOTHER_MEMBERS_HERO'
    from public.hero_free_rerolls r join public.characters c on c.id = r.character_id
   where c.telegram_user_id is distinct from r.telegram_user_id
  union all
  select r.character_id::text || ':' || r.utc_day::text, 'ALLOWANCE_FIGURES_DO_NOT_MATCH_THE_VERSIONS'
    from public.hero_free_rerolls r
    join public.hero_versions v on v.id = r.hero_version_id
    join public.hero_versions p on p.id = r.previous_version_id
   where v.class_id <> r.to_class_id or v.rarity <> r.to_rarity or v.power <> r.to_power
      or p.class_id <> r.from_class_id or p.rarity <> r.from_rarity or p.power <> r.from_power
  union all
  select r.character_id::text || ':' || r.utc_day::text, 'REROLL_NOT_THE_DIRECT_SUCCESSOR'
    from public.hero_free_rerolls r
    join public.hero_versions v on v.id = r.hero_version_id
    join public.hero_versions p on p.id = r.previous_version_id
   where v.version_number <> p.version_number + 1 or v.previous_version_id is distinct from r.previous_version_id
$$;
comment on function public.audit_hero_free_rerolls() is 'Violations of the free-reroll rules (must return no rows). Run after enabling the feature and after any incident.';

select public.clank_harden_schema();
