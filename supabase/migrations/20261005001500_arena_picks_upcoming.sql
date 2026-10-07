-- Clank RPG — Arena Picks target the UPCOMING battle, and the pick window closes when the battle on stage is DECIDED.
--
-- Until now a pick named the battle that was already on stage and closed when that battle's combat started (a 5.5 s window in
-- which the fighters were standing idle). The lifecycle is now a rolling prediction queue:
--
--     battle A on stage ── picks for battle B are OPEN ── A's result is decided ── B's picks LOCK ── A's results ── 3·2·1 ── B
--     takes the stage, and the picks panel moves on to battle C.
--
-- What this migration adds (nothing is renamed or dropped; `arena_picks.battle_id` keeps meaning "the battle that was PREDICTED"):
--
--  1. `arena_battles.picks_locked_at` / `picks_lock_reason` — the ONE persisted moment a battle's pick window closed, written
--     exactly once (a trigger refuses to move or clear it). The arena stamps it when the battle on stage reaches its result
--     (reason PREDECESSOR_DECIDED), when the battle itself takes the stage (OWN_START — also the fallback when nothing is on
--     stage ahead of it) or when the battle is voided (VOID).
--  2. A VOIDED battle resolves every open pick on it as VOID, explicitly, in the same transaction — a cancelled pick period never
--     leaves picks dangling and never earns anything.
--  3. `guard_arena_pick()` (defence in depth, replaces the version in 20261005001300) now refuses a pick unless the battle is the
--     prepared (SIMULATED) battle, its window has not been stamped closed and the submit time is before its start.
--  4. The roster of a battle is frozen once the battle leaves SCHEDULED: no participant row can be added or removed. The eight
--     players are looking at are the eight who will fight.
--
-- Safe on a live database: only additive columns + trigger/function replacements; no data is rewritten. Battles prepared before
-- this migration simply have no stamp (their window is decided by the clock rule in code until the arena stamps them).

alter table public.arena_battles
  add column picks_locked_at timestamptz,
  add column picks_lock_reason text check (picks_lock_reason in ('PREDECESSOR_DECIDED', 'OWN_START', 'VOID')),
  add constraint arena_battles_picks_lock_pair check ((picks_locked_at is null) = (picks_lock_reason is null));

comment on column public.arena_battles.picks_locked_at is
  'When the pick window for THIS battle closed (picks are made on the upcoming battle). Written once; NULL = still open or never opened.';
comment on column public.arena_battles.picks_lock_reason is
  'PREDECESSOR_DECIDED = the battle on stage reached its result; OWN_START = this battle took the stage first (fallback); VOID = cancelled.';

-- The lock moment is written exactly once.
create or replace function public.guard_arena_picks_lock()
returns trigger
language plpgsql
as $$
begin
  if old.picks_locked_at is not null
     and (new.picks_locked_at is distinct from old.picks_locked_at or new.picks_lock_reason is distinct from old.picks_lock_reason) then
    raise exception 'the pick window of a battle closes exactly once' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_battles_picks_lock_once before update of picks_locked_at, picks_lock_reason on public.arena_battles
  for each row execute function public.guard_arena_picks_lock();

-- Voiding a battle closes its pick window (stamp) ...
create or replace function public.stamp_void_picks_lock()
returns trigger
language plpgsql
as $$
begin
  if new.picks_locked_at is null then
    new.picks_locked_at := now();
    new.picks_lock_reason := 'VOID';
  end if;
  return new;
end;
$$;
create trigger arena_battles_void_stamp before update of status on public.arena_battles
  for each row when (new.status = 'VOID' and old.status is distinct from 'VOID')
  execute function public.stamp_void_picks_lock();

-- ... and resolves every pick on it as VOID: a cancelled pick period pays nothing and keeps nothing open.
create or replace function public.void_battle_picks()
returns trigger
language plpgsql
as $$
begin
  update public.arena_picks
     set result = 'VOID',
         settled_at = now(),
         locked_at = coalesce(locked_at, now())
   where battle_id = new.id and result is null;
  return null;
end;
$$;
create trigger arena_battles_void_picks after update of status on public.arena_battles
  for each row when (new.status = 'VOID' and old.status is distinct from 'VOID')
  execute function public.void_battle_picks();

-- Integrity guard for picks (the service enforces the rule; the database refuses whatever slips past it).
create or replace function public.guard_arena_pick()
returns trigger
language plpgsql
as $$
declare
  b record;
begin
  select status, starts_at, picks_locked_at into b from public.arena_battles where id = new.battle_id;

  if tg_op = 'INSERT' then
    if b.status is distinct from 'SIMULATED' then
      raise exception 'picks are only accepted for the prepared upcoming battle' using errcode = '23000';
    end if;
    if b.picks_locked_at is not null then
      raise exception 'picks are locked for this battle' using errcode = '23000';
    end if;
    -- A battle that has taken the stage is never a pick target (the window closes at its start at the latest).
    if new.submitted_at >= b.starts_at then
      raise exception 'picks are locked for this battle' using errcode = '23000';
    end if;
    if new.result is not null or new.locked_at is not null or new.reward_gold <> 0 then
      raise exception 'a new pick cannot arrive resolved' using errcode = '23000';
    end if;
    return new;
  end if;

  if new.battle_id is distinct from old.battle_id or new.telegram_user_id is distinct from old.telegram_user_id then
    raise exception 'pick identity is immutable' using errcode = '23000';
  end if;
  if old.result is not null then
    raise exception 'resolved picks are frozen' using errcode = '23000';
  end if;
  -- A re-submit (a different fighter, or a refreshed eligibility snapshot) needs a window that is still open.
  if new.character_id is distinct from old.character_id
     or new.reward_eligible is distinct from old.reward_eligible
     or new.eligibility is distinct from old.eligibility then
    if old.locked_at is not null or b.picks_locked_at is not null then
      raise exception 'pick is locked' using errcode = '23000';
    end if;
    if b.status is distinct from 'SIMULATED' then
      raise exception 'picks can only change while the battle is the prepared upcoming battle' using errcode = '23000';
    end if;
    if new.submitted_at >= b.starts_at then
      raise exception 'picks are locked for this battle' using errcode = '23000';
    end if;
  end if;
  return new;
end;
$$;

-- The roster is final the moment the battle is prepared: nobody can be added to or removed from it afterwards.
create or replace function public.guard_arena_roster()
returns trigger
language plpgsql
as $$
declare
  battle_status text;
begin
  select status into battle_status from public.arena_battles where id = coalesce(new.battle_id, old.battle_id);
  -- (a battle row that is being deleted is no longer visible here: its roster may cascade away with it)
  if battle_status is not null and battle_status <> 'SCHEDULED' then
    raise exception 'the roster of a prepared battle is final' using errcode = '23000';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger arena_participants_roster_final before insert or delete on public.arena_participants
  for each row execute function public.guard_arena_roster();

select public.clank_harden_schema();
