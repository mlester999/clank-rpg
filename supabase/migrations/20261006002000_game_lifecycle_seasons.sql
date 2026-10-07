-- 2000 — GAME LIFECYCLE, SEASONS AND THE ARENA'S RUNTIME STATE.
--
-- Clank RPG is still in DEVELOPMENT: the Arena and the heroes are being used for testing, so today's battles, win counts and Picks are TEST DATA.
-- When the game launches there must be ONE deliberate, audited action that starts a clean Season 1 — with every hero exactly as it was — and the
-- Arena must then stay stopped until an operator presses START. This migration is the database side of that:
--
--   · game_state        the persistent GAME PHASE (DEVELOPMENT → LIVE, one way). Not NODE_ENV, not a Vercel/Supabase environment: product state.
--   · seasons           gain a KIND: the existing season(s) become the DEVELOPMENT run ("Development / Beta"); Season 1, 2, … are COMPETITIVE.
--                       A season is never deleted — it is the archive. Each carries its own battle counter.
--   · arena_battles     gain `season_sequence`: the PUBLIC battle number, scoped to its season (#1, #2, … per season; the primary key and the
--                       global `sequence` never reset). Assigned by the database, gaplessly, under the season row's lock.
--   · arena_state       gains the persisted runtime STATUS: NOT_STARTED → PREPARING → RUNNING ⇄ PAUSE_REQUESTED → PAUSED. The database refuses to
--                       schedule a battle while the Arena is NOT_STARTED or PAUSED, whoever asks (a worker, a viewer's request, a bug).
--   · picks             scores / points / finalized boards remember their season, so development Picks can never become Season 1 Picks.
--   · eligibility       a hero that is not ACTIVE (suspended / inactive) or whose member is BANNED cannot be inserted into a NEW roster —
--                       enforced here, in the database, in addition to the scheduler.
--
-- What this migration does NOT do — and the test that fingerprints the tables proves it: it changes no hero, no hero version, no appearance, no
-- stat, no class, no rarity, no PWR, no public id, no battle result, no snapshot, no hash. It does not switch the game to LIVE, does not reset
-- anything and does not start the Arena: the default lifecycle after applying it is DEVELOPMENT, and the Arena keeps the state it had
-- (paused → PAUSED, has run → RUNNING, never ran → NOT_STARTED). The launch is a separate, typed-confirmation Admin action.
--
-- Additive on purpose (the previous application keeps working until the new one is deployed): `arena_state.paused` stays, kept in step with the
-- status by a trigger; columns are added, nothing is dropped. Deploy order: apply this migration, deploy the code.

-- ---------------------------------------------------------------------------
-- 0. Guard: the Arena Picks leaderboard and roster migrations must already be applied (this file extends their tables).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.arena_pick_scores') is null or to_regclass('public.arena_leaderboards') is null then
    raise exception 'game_lifecycle: the Arena Picks leaderboard migration (20261005001400) must be applied first';
  end if;
  if to_regprocedure('public.guard_arena_roster()') is null then
    raise exception 'game_lifecycle: the upcoming-battle migration (20261005001500) must be applied first';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The game phase
-- ---------------------------------------------------------------------------

create table public.game_state (
  id integer primary key check (id = 1),
  phase text not null default 'DEVELOPMENT' check (phase in ('DEVELOPMENT', 'LIVE')),
  -- Set once, by the launch, and never changed: when the game went LIVE, with which season, by whom.
  launched_at timestamptz,
  launch_season_id uuid references public.seasons (id),
  launched_by text,
  updated_at timestamptz not null default now(),
  check ((phase = 'LIVE') = (launched_at is not null and launch_season_id is not null))
);
insert into public.game_state (id) values (1);
comment on table public.game_state is
  'The persistent GAME PHASE (product state, not an environment): DEVELOPMENT = testing before the official launch, LIVE = official competitive seasons. DEVELOPMENT → LIVE happens once, through the Admin launch flow; there is no way back.';

create or replace function public.guard_game_state()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the game state row is permanent' using errcode = '23000';
  end if;
  if old.phase = 'LIVE' and new.phase <> 'LIVE' then
    raise exception 'the game is LIVE: it cannot go back to DEVELOPMENT' using errcode = '23000';
  end if;
  if old.launched_at is not null and (new.launched_at is distinct from old.launched_at or new.launch_season_id is distinct from old.launch_season_id) then
    raise exception 'the launch record is permanent' using errcode = '23000';
  end if;
  if old.phase = 'DEVELOPMENT' and new.phase = 'LIVE' then
    -- The launch leaves the Arena stopped, with Season 1 (a COMPETITIVE season) as the active one.
    if coalesce((select status from public.arena_state where id = 1), 'NOT_STARTED') <> 'NOT_STARTED' then
      raise exception 'the Arena must be NOT_STARTED when the game goes LIVE' using errcode = '23000';
    end if;
    if not exists (select 1 from public.seasons s where s.id = new.launch_season_id and s.kind = 'COMPETITIVE' and s.status = 'ACTIVE') then
      raise exception 'the game can only go LIVE with an ACTIVE competitive season' using errcode = '23000';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger game_state_guard before update or delete on public.game_state
  for each row execute function public.guard_game_state();

-- ---------------------------------------------------------------------------
-- 2. Seasons: a kind, a run number for development runs, a battle counter, an archive
-- ---------------------------------------------------------------------------

alter table public.seasons
  add column kind text not null default 'DEVELOPMENT' check (kind in ('DEVELOPMENT', 'COMPETITIVE')),
  -- DEVELOPMENT runs are numbered 1, 2, … (a development reset starts the next run); COMPETITIVE seasons carry `number` instead.
  add column run_number integer check (run_number is null or run_number >= 1),
  -- The last PUBLIC battle number handed out in this season (see arena_battles.season_sequence).
  add column battle_counter bigint not null default 0 check (battle_counter >= 0),
  add column ended_reason text check (ended_reason is null or ended_reason in ('LAUNCH', 'DEVELOPMENT_RESET', 'SEASON_END')),
  -- What the season looked like when it was archived (counts only; the data itself is never deleted).
  add column archive jsonb,
  add column created_by text;

alter table public.seasons drop constraint if exists seasons_number_check;
alter table public.seasons alter column number drop not null;

-- Every season that exists today is the DEVELOPMENT run: its battles and records are test data, and they are not Season 1.
with ranked as (select id, row_number() over (order by number, created_at, id) as rn from public.seasons)
update public.seasons s
   set kind = 'DEVELOPMENT',
       run_number = r.rn,
       number = null,
       name = case when r.rn = 1 then 'Development / Beta' else 'Development run ' || r.rn end
  from ranked r
 where r.id = s.id;

alter table public.seasons
  add constraint seasons_kind_number check (
       (kind = 'DEVELOPMENT' and number is null and run_number is not null)
    or (kind = 'COMPETITIVE' and number is not null and number >= 1 and run_number is null)
  );
create unique index seasons_dev_run_unique on public.seasons (run_number) where kind = 'DEVELOPMENT';
comment on column public.seasons.kind is 'DEVELOPMENT = a testing run before the official launch (never paid, never counted once archived). COMPETITIVE = Season 1, 2, … (official).';
comment on column public.seasons.battle_counter is 'Last public battle number issued in this season. Battle numbers are season-scoped: every season counts from #1.';

create or replace function public.guard_season()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'seasons are never deleted: they are the archive' using errcode = '23000';
  end if;
  if tg_op = 'INSERT' then
    if new.kind = 'DEVELOPMENT' and new.status = 'ACTIVE' and coalesce((select phase from public.game_state where id = 1), 'DEVELOPMENT') = 'LIVE' then
      raise exception 'the game is LIVE: a development season cannot be started' using errcode = '23000';
    end if;
    return new;
  end if;
  if new.kind is distinct from old.kind or new.number is distinct from old.number or new.run_number is distinct from old.run_number then
    raise exception 'a season''s kind and number are permanent' using errcode = '23000';
  end if;
  if old.status = 'ENDED' and new.status <> 'ENDED' then
    raise exception 'an ended season cannot be reopened' using errcode = '23000';
  end if;
  if new.battle_counter < old.battle_counter then
    raise exception 'a season''s battle counter never goes backwards' using errcode = '23000';
  end if;
  if new.kind = 'DEVELOPMENT' and new.status = 'ACTIVE' and old.status <> 'ACTIVE'
     and coalesce((select phase from public.game_state where id = 1), 'DEVELOPMENT') = 'LIVE' then
    raise exception 'the game is LIVE: a development season cannot be started' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger seasons_guard before insert or update or delete on public.seasons
  for each row execute function public.guard_season();

-- ---------------------------------------------------------------------------
-- 3. Season-scoped battle numbers
-- ---------------------------------------------------------------------------

alter table public.arena_battles add column season_sequence integer check (season_sequence is null or season_sequence >= 1);

-- Deterministic backfill: within each season, in the order the battles were created. (Updates only this column: no result, snapshot or hash moves.)
with n as (select id, row_number() over (partition by season_id order by sequence) as rn from public.arena_battles)
update public.arena_battles b set season_sequence = n.rn from n where n.id = b.id;

update public.seasons s
   set battle_counter = coalesce((select max(b.season_sequence) from public.arena_battles b where b.season_id = s.id), 0);

alter table public.arena_battles alter column season_sequence set not null;
create unique index arena_battles_season_sequence_unique on public.arena_battles (season_id, season_sequence);
comment on column public.arena_battles.season_sequence is
  'The PUBLIC battle number, scoped to the battle''s season (Battle #1 of Season 1, …). Assigned by the database when the battle is created; the global `sequence` and the id never reset.';

-- The Arena's runtime status lives in arena_state (section 4); the trigger below reads it, so it is created after that column exists.

-- ---------------------------------------------------------------------------
-- 4. The Arena's runtime state
-- ---------------------------------------------------------------------------

alter table public.arena_state
  add column status text not null default 'NOT_STARTED' check (status in ('NOT_STARTED', 'PREPARING', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED')),
  add column status_changed_at timestamptz not null default now(),
  -- When the Arena of the CURRENT season was first started (null until then).
  add column started_at timestamptz;

-- The status this database was in, carried over exactly: paused → PAUSED; has run → RUNNING; never ran → NOT_STARTED. (Nothing is started by migrating.)
update public.arena_state
   set status = case
         when paused then 'PAUSED'
         when exists (select 1 from public.arena_battles) then 'RUNNING'
         else 'NOT_STARTED'
       end,
       started_at = (select min(b.created_at) from public.arena_battles b join public.seasons s on s.id = b.season_id and s.status = 'ACTIVE');

comment on column public.arena_state.status is
  'NOT_STARTED (nothing runs) → PREPARING (Battle #1 is being made ready) → RUNNING ⇄ PAUSE_REQUESTED (finishing the battles already committed) → PAUSED. Persisted: every process, worker and restart sees the same value.';
comment on column public.arena_state.paused is
  'LEGACY MIRROR of (status = PAUSED), kept for the previous application version. The status column is the authority.';

create or replace function public.guard_arena_state()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the arena state row is permanent' using errcode = '23000';
  end if;
  if tg_op = 'UPDATE' then
    -- The PREVIOUS application version still toggles the legacy `paused` flag (its Admin Pause / Resume buttons). While it is the one deployed, keep
    -- those working: a flag change that does not come with a status change is read as the matching status move. (The new code only writes `status`.)
    if new.paused is distinct from old.paused and new.status is not distinct from old.status then
      if new.paused and old.status in ('PREPARING', 'RUNNING', 'PAUSE_REQUESTED') then
        new.status := 'PAUSED';
      elsif not new.paused and old.status = 'PAUSED' then
        new.status := 'RUNNING';
      end if;
    end if;
    if new.status is distinct from old.status then
      if (old.status, new.status) not in (
           ('NOT_STARTED', 'PREPARING'),
           ('PREPARING', 'RUNNING'), ('PREPARING', 'PAUSE_REQUESTED'), ('PREPARING', 'PAUSED'),
           ('RUNNING', 'PAUSE_REQUESTED'), ('RUNNING', 'PAUSED'),
           ('PAUSE_REQUESTED', 'PAUSED'), ('PAUSE_REQUESTED', 'RUNNING'),
           ('PAUSED', 'RUNNING'), ('PAUSED', 'NOT_STARTED')) then
        raise exception 'illegal arena status transition % -> %', old.status, new.status using errcode = '23000';
      end if;
      new.status_changed_at := now();
      if new.status in ('PREPARING', 'RUNNING') and not exists (select 1 from public.seasons where status = 'ACTIVE') then
        raise exception 'the arena cannot run without an ACTIVE season' using errcode = '23000';
      end if;
    end if;
  elsif new.status in ('PREPARING', 'RUNNING') and not exists (select 1 from public.seasons where status = 'ACTIVE') then
    raise exception 'the arena cannot run without an ACTIVE season' using errcode = '23000';
  end if;
  new.paused := (new.status = 'PAUSED');
  return new;
end;
$$;
create trigger arena_state_guard before insert or update or delete on public.arena_state
  for each row execute function public.guard_arena_state();

-- ---------------------------------------------------------------------------
-- 5. Battles: numbered by the database, scheduled only while the Arena is being run, never in a season that is not active
-- ---------------------------------------------------------------------------

create or replace function public.assign_arena_battle_number()
returns trigger
language plpgsql
as $$
declare
  season_status text;
  runtime text;
begin
  if new.status = 'SCHEDULED' then
    select status into runtime from public.arena_state where id = 1;
    if runtime in ('NOT_STARTED', 'PAUSED') then
      raise exception 'no battle can be scheduled while the Arena is %', runtime using errcode = '23000';
    end if;
  end if;
  -- The season row is the counter: this serialises numbering per season and is rolled back with the battle if it is.
  update public.seasons set battle_counter = battle_counter + 1 where id = new.season_id returning battle_counter, status into new.season_sequence, season_status;
  if not found then
    raise exception 'unknown season' using errcode = '23000';
  end if;
  if new.status = 'SCHEDULED' and season_status <> 'ACTIVE' then
    raise exception 'battles are only scheduled in the ACTIVE season' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_battles_number before insert on public.arena_battles
  for each row execute function public.assign_arena_battle_number();

create or replace function public.guard_arena_battle_numbering()
returns trigger
language plpgsql
as $$
begin
  if new.season_id is distinct from old.season_id or new.season_sequence is distinct from old.season_sequence then
    raise exception 'a battle''s season and public number are permanent' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_battles_number_frozen before update of season_id, season_sequence on public.arena_battles
  for each row execute function public.guard_arena_battle_numbering();

-- ---------------------------------------------------------------------------
-- 6. Eligibility is enforced where the roster is written
--    (the scheduler checks it too — under a row lock, so a suspension cannot slip in beside it — but a new roster can never contain a hero
--     that is not ACTIVE or whose Telegram member is BANNED, whichever code path writes it. Rosters that already exist are never touched:
--     a hero suspended AFTER being committed to a battle still fights that battle.)
-- ---------------------------------------------------------------------------

create or replace function public.guard_arena_roster_eligibility()
returns trigger
language plpgsql
as $$
declare
  hero_status text;
  member_status text;
begin
  select c.status, tu.status into hero_status, member_status
    from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
   where c.id = new.character_id;
  if hero_status is distinct from 'ACTIVE' or member_status = 'BANNED' then
    raise exception 'a hero that is % cannot enter a new roster', case when member_status = 'BANNED' then 'banned' else lower(coalesce(hero_status, 'missing')) end using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_participants_eligible before insert on public.arena_participants
  for each row execute function public.guard_arena_roster_eligibility();

-- ---------------------------------------------------------------------------
-- 7. Arena Picks remember their season (so a development pick can never become a Season 1 pick)
-- ---------------------------------------------------------------------------

-- A season "counts" for the boards and for lifetime Points when it is official (COMPETITIVE) or is the ACTIVE one. An ENDED development run is archived:
-- its scores stay in the tables, but no board is finalized from them, no prize is paid for them and no lifetime total includes them.
create or replace function public.season_counts(sid uuid)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.seasons s where s.id = sid and (s.kind = 'COMPETITIVE' or s.status = 'ACTIVE'))
$$;

-- The season that OWNS a leaderboard period: the season of the LAST COUNTING pick scored in it (a pick of an archived development run never counts).
-- Ownership follows the data, never a wall clock: a period that began in the development run and ends after the launch is Season 1's and ranks only
-- Season 1's picks — the development picks of the same UTC day are archived, so the Daily / Weekly boards begin clean — and a period that holds nothing but
-- archived development picks has NO owner: it is never finalized and never paid. (Defined right after arena_pick_scores gets its season column, below.)

alter table public.arena_pick_scores add column season_id uuid references public.seasons (id);
alter table public.arena_pick_scores disable trigger arena_pick_scores_append_only;
update public.arena_pick_scores s set season_id = b.season_id from public.arena_battles b where b.id = s.battle_id;
alter table public.arena_pick_scores enable trigger arena_pick_scores_append_only;
alter table public.arena_pick_scores alter column season_id set not null;
create index arena_pick_scores_season_idx on public.arena_pick_scores (season_id, utc_date);

create or replace function public.period_season(period_kind text, period_start date)
returns uuid
language sql
stable
as $$
  select s.season_id from public.arena_pick_scores s
   where (case when period_kind = 'DAILY' then s.utc_date else s.week_start end) = period_start
     and public.season_counts(s.season_id)
   order by s.id desc limit 1
$$;

alter table public.arena_points_ledger add column season_id uuid references public.seasons (id);
alter table public.arena_points_ledger disable trigger arena_points_ledger_append_only;
update public.arena_points_ledger l set season_id = b.season_id from public.arena_battles b where b.id = l.battle_id;
alter table public.arena_points_ledger enable trigger arena_points_ledger_append_only;
create index arena_points_ledger_season_idx on public.arena_points_ledger (season_id) where season_id is not null;

-- The season is stamped from the battle itself, so the code that scores picks cannot get it wrong (or forget it).
create or replace function public.stamp_pick_season()
returns trigger
language plpgsql
as $$
begin
  if new.battle_id is not null then
    select b.season_id into new.season_id from public.arena_battles b where b.id = new.battle_id;
  end if;
  return new;
end;
$$;
create trigger arena_pick_scores_season before insert on public.arena_pick_scores
  for each row execute function public.stamp_pick_season();
create trigger arena_points_ledger_season before insert on public.arena_points_ledger
  for each row execute function public.stamp_pick_season();

alter table public.arena_leaderboards add column season_id uuid references public.seasons (id);
alter table public.arena_leaderboards disable trigger arena_leaderboards_append_only;
update public.arena_leaderboards l set season_id = public.period_season(l.kind, l.period_start);
alter table public.arena_leaderboards enable trigger arena_leaderboards_append_only;
comment on column public.arena_leaderboards.season_id is 'The season that owned this period when it was frozen (see period_season): the season of the last pick scored in it.';

-- ---------------------------------------------------------------------------
-- 8. Auditor: every row is a finding. Expected result: no rows.
-- ---------------------------------------------------------------------------

create or replace function public.audit_game_lifecycle()
returns table (problem text, detail text)
language sql
stable
as $$
  select 'NO_GAME_STATE_ROW'::text, ''::text where not exists (select 1 from public.game_state)
  union all select 'NO_ARENA_STATE_ROW', '' where not exists (select 1 from public.arena_state)
  union all select 'MORE_THAN_ONE_ACTIVE_SEASON', count(*)::text from public.seasons where status = 'ACTIVE' having count(*) > 1
  union all select 'LIVE_WITHOUT_COMPETITIVE_SEASON', '' from public.game_state g where g.phase = 'LIVE' and not exists (select 1 from public.seasons s where s.kind = 'COMPETITIVE')
  union all select 'LIVE_WITH_ACTIVE_DEVELOPMENT_SEASON', s.id::text from public.game_state g join public.seasons s on s.kind = 'DEVELOPMENT' and s.status = 'ACTIVE' where g.phase = 'LIVE'
  union all select 'DEVELOPMENT_PHASE_WITH_ACTIVE_COMPETITIVE_SEASON', s.id::text from public.game_state g join public.seasons s on s.kind = 'COMPETITIVE' and s.status = 'ACTIVE' where g.phase = 'DEVELOPMENT'
  union all select 'ARENA_RUNNING_WITHOUT_ACTIVE_SEASON', a.status from public.arena_state a where a.status in ('PREPARING', 'RUNNING', 'PAUSE_REQUESTED') and not exists (select 1 from public.seasons where status = 'ACTIVE')
  union all select 'BATTLE_COUNTER_BEHIND_NUMBERS', s.id::text from public.seasons s where s.battle_counter < coalesce((select max(b.season_sequence) from public.arena_battles b where b.season_id = s.id), 0)
  union all select 'OPEN_BATTLE_IN_ENDED_SEASON', b.id::text from public.arena_battles b join public.seasons s on s.id = b.season_id where s.status = 'ENDED' and b.status in ('SCHEDULED', 'SIMULATED')
  union all select 'ARENA_NOT_STARTED_WITH_OPEN_BATTLES', count(*)::text from public.arena_battles b, public.arena_state a where a.status = 'NOT_STARTED' and b.status in ('SCHEDULED', 'SIMULATED') group by a.status having count(*) > 0
  union all select 'PICK_SCORE_SEASON_MISMATCH', s.id::text from public.arena_pick_scores s join public.arena_battles b on b.id = s.battle_id where s.season_id <> b.season_id
  union all select 'BATTLE_IN_UNKNOWN_SEASON_KIND', b.id::text from public.arena_battles b join public.seasons s on s.id = b.season_id where s.kind not in ('DEVELOPMENT', 'COMPETITIVE')
$$;

select public.clank_harden_schema();
