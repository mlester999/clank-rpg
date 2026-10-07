-- Clank RPG — layered-sprite appearance persistence + free arena picks.
--
-- 1. character_appearances gains the PERSISTED sprite configuration (which catalogue item sits in
--    every visual slot) so a hero never changes look on refresh or after a catalogue update, and a
--    separate `cosmetic_overrides` object for player-chosen cosmetics (the generated look is kept
--    untouched underneath, so clearing overrides restores it). Both are cosmetic only — nothing in
--    combat reads them.
-- 2. arena_picks: free "who wins this battle?" picks. No stake, no loss, no custody, no money.

alter table public.character_appearances
  add column sprite jsonb,
  add column cosmetic_overrides jsonb not null default '{}'::jsonb;

comment on column public.character_appearances.sprite is
  'Generated layered-sprite config (slot -> catalogue item id). NULL = legacy row, derived and backfilled at boot.';
comment on column public.character_appearances.cosmetic_overrides is
  'Player-chosen cosmetics layered over `sprite`. Validated server-side against class compatibility. Cosmetic only.';

create table public.arena_picks (
  battle_id uuid not null references public.arena_battles (id) on delete cascade,
  -- Identity is the immutable Telegram id proven by the signed session — never a body-supplied value.
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id) on delete cascade,
  character_id uuid not null,
  submitted_at timestamptz not null default now(),
  changed_count integer not null default 0 check (changed_count >= 0),
  -- Stamped when combat begins (the pick can no longer change).
  locked_at timestamptz,
  result text check (result in ('CORRECT', 'INCORRECT', 'VOID')),
  reward_gold integer not null default 0 check (reward_gold >= 0),
  -- The hero whose Clank Gold account received the reward (a picker only has one if they own a claimed hero).
  rewarded_character_id uuid references public.characters (id),
  settled_at timestamptz,
  -- One pick per member per battle.
  primary key (battle_id, telegram_user_id),
  -- A pick must name one of THIS battle's eight fighters.
  foreign key (battle_id, character_id) references public.arena_participants (battle_id, character_id) on delete cascade,
  check ((result is null) = (settled_at is null)),
  check (reward_gold = 0 or result = 'CORRECT')
);
create index arena_picks_battle_idx on public.arena_picks (battle_id, character_id);
create index arena_picks_member_idx on public.arena_picks (telegram_user_id, submitted_at desc);

-- Integrity guard (defence in depth: the service enforces the clock; the database refuses the rest).
create or replace function public.guard_arena_pick()
returns trigger
language plpgsql
as $$
declare
  battle_status text;
begin
  select status into battle_status from public.arena_battles where id = new.battle_id;

  if tg_op = 'INSERT' then
    if battle_status is distinct from 'SIMULATED' then
      raise exception 'picks are only accepted for the battle on stage' using errcode = '23000';
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
  if new.character_id is distinct from old.character_id then
    if old.locked_at is not null then
      raise exception 'pick is locked' using errcode = '23000';
    end if;
    if battle_status is distinct from 'SIMULATED' then
      raise exception 'picks can only change while the battle is on stage' using errcode = '23000';
    end if;
  end if;
  return new;
end;
$$;
create trigger arena_picks_guard before insert or update on public.arena_picks
  for each row execute function public.guard_arena_pick();

select public.clank_harden_schema();
