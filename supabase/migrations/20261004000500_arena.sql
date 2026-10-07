-- Clank RPG — Global Idle Arena: cycles, persisted queue, battles, participants,
-- seasonal stats. Battles are server-authoritative and replayable: the pre-battle
-- snapshot, seed, rules version and ruleset hash are persisted and frozen.

create table public.arena_state (
  id integer primary key check (id = 1),
  paused boolean not null default false,
  last_advance_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.arena_state (id) values (1);

create table public.arena_cycles (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique check (number >= 1),
  season_id uuid not null references public.seasons (id),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'COMPLETED', 'ABORTED')),
  seed text not null,
  hero_count integer not null check (hero_count >= 0),
  carried_in_count integer not null default 0 check (carried_in_count >= 0),
  carried_out_count integer not null default 0 check (carried_out_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
-- Only one cycle may be running; restarts resume it instead of reshuffling.
create unique index arena_cycles_single_active on public.arena_cycles ((true)) where status = 'ACTIVE';

create table public.arena_battles (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  season_id uuid not null references public.seasons (id),
  cycle_id uuid not null references public.arena_cycles (id),
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'SIMULATED', 'SETTLED', 'VOID')),
  rules_version text,
  ruleset_hash text references public.ruleset_snapshots (hash),
  seed text,
  snapshot jsonb,
  events jsonb,
  events_hash text,
  result jsonb,
  duration_ms integer check (duration_ms is null or duration_ms between 0 and 120000),
  ended_by text check (ended_by in ('LAST_STANDING', 'TIME_LIMIT')),
  starts_at timestamptz not null,
  combat_starts_at timestamptz,
  combat_ends_at timestamptz,
  slot_ends_at timestamptz,
  simulated_at timestamptz,
  settled_at timestamptz,
  winner_id uuid references public.characters (id),
  runner_up_id uuid references public.characters (id),
  created_at timestamptz not null default now(),
  check (status = 'SCHEDULED' or status = 'VOID' or (seed is not null and snapshot is not null and ruleset_hash is not null))
);
create index arena_battles_status_idx on public.arena_battles (status, starts_at);
create index arena_battles_starts_idx on public.arena_battles (starts_at desc);
create index arena_battles_cycle_idx on public.arena_battles (cycle_id);

create table public.arena_queue_entries (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.arena_cycles (id) on delete cascade,
  character_id uuid not null references public.characters (id),
  position integer not null check (position >= 0),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'IN_BATTLE', 'COMPLETED', 'SKIPPED', 'CARRIED_FORWARD')),
  carried_in boolean not null default false,
  battle_id uuid references public.arena_battles (id),
  unique (cycle_id, character_id),
  unique (cycle_id, position)
);
create index arena_queue_entries_pending_idx on public.arena_queue_entries (cycle_id, status, position);
create index arena_queue_entries_battle_idx on public.arena_queue_entries (battle_id) where battle_id is not null;

create table public.arena_participants (
  battle_id uuid not null references public.arena_battles (id) on delete cascade,
  character_id uuid not null references public.characters (id),
  slot integer check (slot between 0 and 15),
  placement integer check (placement between 1 and 16),
  eliminations integer not null default 0 check (eliminations >= 0),
  damage_dealt integer not null default 0 check (damage_dealt >= 0),
  damage_taken integer not null default 0 check (damage_taken >= 0),
  healing_done integer not null default 0 check (healing_done >= 0),
  survived_ms integer check (survived_ms is null or survived_ms >= 0),
  final_hp integer check (final_hp is null or final_hp >= 0),
  max_hp integer check (max_hp is null or max_hp > 0),
  killed_by uuid references public.characters (id),
  xp_awarded integer not null default 0 check (xp_awarded >= 0),
  gold_awarded integer not null default 0 check (gold_awarded >= 0),
  season_points integer not null default 0 check (season_points >= 0),
  item_drop_id uuid references public.inventory_items (id),
  primary key (battle_id, character_id),
  unique (battle_id, slot)
);
create index arena_participants_character_idx on public.arena_participants (character_id, battle_id);

-- Seasonal competitive stats (permanent progression lives on characters).
create table public.season_character_stats (
  season_id uuid not null references public.seasons (id) on delete cascade,
  character_id uuid not null references public.characters (id) on delete cascade,
  points integer not null default 0 check (points >= 0),
  battles integer not null default 0 check (battles >= 0),
  wins integer not null default 0 check (wins >= 0),
  top2 integer not null default 0 check (top2 >= 0),
  eliminations integer not null default 0 check (eliminations >= 0),
  damage bigint not null default 0 check (damage >= 0),
  updated_at timestamptz not null default now(),
  primary key (season_id, character_id)
);
create index season_character_stats_rank_idx on public.season_character_stats (season_id, points desc, wins desc);

-- ---------------------------------------------------------------------------
-- Integrity guards: simulated results are frozen; settlement is one-way.
-- ---------------------------------------------------------------------------

create or replace function public.guard_arena_battle()
returns trigger
language plpgsql
as $$
begin
  if old.status = new.status then
    null;
  elsif (old.status, new.status) not in (
    ('SCHEDULED', 'SIMULATED'), ('SIMULATED', 'SETTLED'), ('SCHEDULED', 'VOID'), ('SIMULATED', 'VOID')
  ) then
    raise exception 'illegal battle transition % -> %', old.status, new.status using errcode = '23000';
  end if;

  if old.status in ('SIMULATED', 'SETTLED') and (
       new.seed is distinct from old.seed
    or new.snapshot is distinct from old.snapshot
    or new.ruleset_hash is distinct from old.ruleset_hash
    or new.rules_version is distinct from old.rules_version
    or new.events_hash is distinct from old.events_hash
  ) then
    raise exception 'simulated battle inputs are frozen' using errcode = '23000';
  end if;

  if old.status = 'SETTLED' and (
       new.result is distinct from old.result
    or new.events is distinct from old.events
    or new.winner_id is distinct from old.winner_id
    or new.runner_up_id is distinct from old.runner_up_id
    or new.duration_ms is distinct from old.duration_ms
  ) then
    raise exception 'settled battle results are frozen' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_battles_guard before update on public.arena_battles
  for each row execute function public.guard_arena_battle();

create or replace function public.guard_arena_participant()
returns trigger
language plpgsql
as $$
declare
  battle_status text;
begin
  select status into battle_status from public.arena_battles where id = new.battle_id;
  if battle_status = 'SETTLED' and (
       new.slot is distinct from old.slot
    or new.placement is distinct from old.placement
    or new.eliminations is distinct from old.eliminations
    or new.damage_dealt is distinct from old.damage_dealt
    or new.damage_taken is distinct from old.damage_taken
    or new.survived_ms is distinct from old.survived_ms
    or new.final_hp is distinct from old.final_hp
    or new.killed_by is distinct from old.killed_by
  ) then
    raise exception 'settled battle results are frozen' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_participants_guard before update on public.arena_participants
  for each row execute function public.guard_arena_participant();
