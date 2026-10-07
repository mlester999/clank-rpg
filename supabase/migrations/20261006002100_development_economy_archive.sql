-- 2100 — DEVELOPMENT PROGRESS MUST NOT CARRY INTO SEASON 1 (archivable achievements and loot, a Gold launch auditor).
--
-- Everything earned while the game is in DEVELOPMENT is test data: arena achievements, Clank Gold, loot. When Season 1 launches the heroes stay exactly as they
-- are, but that progress must not give anyone a head start. This migration is the database side of that (the launch action does the archiving, in its own
-- transaction, see services/developmentEconomy.ts):
--
--   · character_achievements   an unlock row gets its own id, the season it belongs to and an `archived_at`. The old primary key (character, achievement)
--                              becomes a unique index over the NON-archived rows, so an archived development unlock never blocks the same achievement from
--                              being earned again, officially. Nothing is deleted.
--   · inventory_items          loot gets `archived_at` / `archived_season_id` and a CHECK that an archived item can never be equipped. Archived loot stays
--                              inspectable; it simply is not part of anyone's inventory or combat stats any more.
--   · Clank Gold               needs NO schema: the launch posts one offsetting ledger entry per account (append-only audit preserved, balance back to 0).
--   · audit_development_economy()   read-only auditor: once the game is LIVE, no development achievement / loot / Gold may be active. Expected: no rows.
--
-- What it does NOT do: it changes no hero, hero version, appearance, stat, rarity, PWR, public id, battle, snapshot, hash or reward row, deletes nothing,
-- and archives nothing by itself — the game stays in DEVELOPMENT and nothing is reset until the (separate, typed-confirmation) launch action. Additive.

do $$
begin
  if to_regclass('public.game_state') is null or to_regprocedure('public.audit_game_lifecycle()') is null then
    raise exception 'development_economy_archive: the game lifecycle migration (20261006002000) must be applied first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Achievements: seasonal, archivable unlocks
-- ---------------------------------------------------------------------------

alter table public.character_achievements drop constraint character_achievements_pkey;
alter table public.character_achievements
  add column id uuid not null default gen_random_uuid(),
  -- The season that was active when the achievement was unlocked (null = unlocked before seasons were recorded on unlocks).
  add column season_id uuid references public.seasons (id),
  -- Set when the unlock is archived (a development unlock at the launch): it no longer counts, is no longer shown, and no longer blocks a new unlock.
  add column archived_at timestamptz;
alter table public.character_achievements add primary key (id);
create unique index character_achievements_active_unique on public.character_achievements (character_id, achievement_id) where archived_at is null;
create index character_achievements_archived_idx on public.character_achievements (archived_at) where archived_at is not null;

create or replace function public.stamp_achievement_season()
returns trigger
language plpgsql
as $$
begin
  if new.season_id is null then
    select id into new.season_id from public.seasons where status = 'ACTIVE' limit 1;
  end if;
  return new;
end;
$$;
create trigger character_achievements_season before insert on public.character_achievements
  for each row execute function public.stamp_achievement_season();

comment on column public.character_achievements.archived_at is
  'Set by the Season 1 launch for achievements unlocked from DEVELOPMENT arena activity: archived rows are history only (never counted, shown or blocking).';

-- ---------------------------------------------------------------------------
-- 2. Loot: archivable, and archived loot can never fight
-- ---------------------------------------------------------------------------

alter table public.inventory_items
  add column archived_at timestamptz,
  add column archived_season_id uuid references public.seasons (id),
  add constraint inventory_items_archived_not_equipped check (archived_at is null or not equipped);
create index inventory_items_active_idx on public.inventory_items (character_id) where archived_at is null;

comment on column public.inventory_items.archived_at is
  'Set by the Season 1 launch for loot dropped by DEVELOPMENT battles: archived items stay inspectable but are not in the inventory, cannot be equipped and add nothing to combat stats.';

-- ---------------------------------------------------------------------------
-- 3. Auditor: once LIVE, no development progress may be active. Every row is a finding. Expected result: no rows.
-- ---------------------------------------------------------------------------

create or replace function public.audit_development_economy()
returns table (problem text, detail text)
language sql
stable
as $$
  -- an arena-metric achievement still active that was earned before the launch (development activity)
  select 'DEVELOPMENT_ACHIEVEMENT_ACTIVE_IN_LIVE'::text, ca.character_id::text || ':' || ca.achievement_id
    from public.character_achievements ca
    join public.achievements a on a.id = ca.achievement_id
    join public.game_state g on g.phase = 'LIVE'
   where ca.archived_at is null
     and a.criteria->>'metric' in ('battles', 'wins', 'top2', 'eliminations')
     and coalesce(ca.context->>'granted', '') <> 'admin'
     and ca.unlocked_at < g.launched_at
  union all
  -- loot from before the launch still in an inventory
  select 'DEVELOPMENT_LOOT_ACTIVE_IN_LIVE', i.id::text
    from public.inventory_items i join public.game_state g on g.phase = 'LIVE'
   where i.archived_at is null and i.acquired_at < g.launched_at
  union all
  -- Season 1 Gold must equal what was earned AFTER the launch (the launch posted an offsetting entry, in its own transaction = launched_at, for every development balance)
  select 'DEVELOPMENT_GOLD_ACTIVE_IN_LIVE', a.character_id::text || ':' || a.balance::text
    from public.currency_accounts a join public.game_state g on g.phase = 'LIVE'
   where a.balance <> coalesce((select sum(l.delta) from public.currency_ledger l where l.character_id = a.character_id and l.created_at > g.launched_at), 0)
$$;

select public.clank_harden_schema();
