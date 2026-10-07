-- =====================================================================================================================
-- HERO ARENA REWARDS — a reward program SEPARATE from Arena Picks.
--
--   Arena Picks   rewards the PLAYERS (Daily / Weekly boards by correct picks)          — unchanged by this migration.
--   Hero Arena    rewards the OWNERS of the HEROES with the most Arena Wins (Daily / Weekly) — NEW, below.
--
-- What it adds (everything is additive; nothing at or below migration 20261006002100 is edited, no existing row is rewritten):
--   1. hero_arena_boards   one FROZEN row per finalized Daily / Weekly Hero Arena period (pool, ladder, minimum wins, totals) — immutable.
--   2. hero_arena_results  one row per hero that fought in the period: stats, rank, prize and the prize's STATUS. A prize belongs to the hero's OWNER
--                          (the Telegram member the hero is bound to). A CLAIMED hero's prize is CREDITED to its owner's reward account; an UNCLAIMED hero's
--                          prize is RESERVED against that hero and owner — never redistributed — and is credited when that owner claims the hero.
--   3. arena_reward_ledger the reward ledger learns the two Hero Arena kinds (HERO_ARENA_DAILY_REWARD / HERO_ARENA_WEEKLY_REWARD) with their OWN
--                          reference columns (hero_*), so a Hero Arena credit can never be confused with, or satisfy the foreign key of, an Arena Picks one.
--                          A generated `reward_source` column labels EVERY ledger row: ARENA_PICKS_DAILY / ARENA_PICKS_WEEKLY / HERO_ARENA_DAILY / HERO_ARENA_WEEKLY.
--   4. an index so a period's settled battles are found without scanning the battle table, and an auditor (audit_hero_arena).
--
-- Not here, on purpose: any holder bonus for Hero Arena (it rewards the hero's performance, never a wallet), any token amount (the pools are a SETTING,
-- `hero_arena`, unset by default = "REWARD POOL NOT SET"), any season payout (Season is standings only), any on-chain transfer.
-- All amounts are LOGICAL micro-tokens, exactly like the rest of the reward ledger (see 20261005001400).
-- =====================================================================================================================

-- ---------------------------------------------------------------------------
-- 1. Frozen boards
-- ---------------------------------------------------------------------------
create table public.hero_arena_boards (
  kind text not null check (kind in ('DAILY', 'WEEKLY')),
  -- The UTC date the period starts on (a Monday for WEEKLY).
  period_start date not null,
  -- The season that owned the period when it was frozen: the season of the LAST battle settled in it among the seasons that count (public.season_counts).
  -- Only that season's battles are ranked, so a new season's Tuesday never contains the previous season's Tuesday.
  season_id uuid not null references public.seasons (id),
  -- false = no pool was configured when the period was frozen ("REWARD POOL NOT SET"): the board was ranked and frozen, and nothing was paid.
  pool_set boolean not null,
  prize_pool_micro numeric(78, 0) not null check (prize_pool_micro >= 0),
  prize_split_bps jsonb not null,
  minimum_wins integer not null check (minimum_wins >= 1),
  participants integer not null check (participants >= 0),
  eligible_participants integer not null check (eligible_participants >= 0),
  -- Prize positions held by heroes with an owner (credited, reserved or held) + what returned to the reserve = the pool.
  awarded_micro numeric(78, 0) not null default 0 check (awarded_micro >= 0),
  returned_to_reserve_micro numeric(78, 0) not null default 0 check (returned_to_reserve_micro >= 0),
  finalized_at timestamptz not null default now(),
  primary key (kind, period_start),
  check (kind = 'DAILY' or extract(isodow from period_start) = 1),
  check (awarded_micro + returned_to_reserve_micro = prize_pool_micro),
  check (eligible_participants <= participants),
  check (pool_set or prize_pool_micro = 0)
);
create trigger hero_arena_boards_append_only before update or delete on public.hero_arena_boards
  for each row execute function public.forbid_mutation();
comment on table public.hero_arena_boards is
  'A FINALIZED Daily or Weekly HERO ARENA board (ranked by Arena Wins). Immutable once written. Independent of arena_leaderboards (Arena Picks).';
create index hero_arena_boards_season_idx on public.hero_arena_boards (season_id, kind, period_start desc);

-- ---------------------------------------------------------------------------
-- 2. Frozen results (one per hero that fought in the period)
-- ---------------------------------------------------------------------------
create table public.hero_arena_results (
  kind text not null,
  period_start date not null,
  character_id uuid not null references public.characters (id),
  -- The Telegram member the hero belongs to — the only account that can ever receive its prize. Null: the hero has no Telegram owner (a special or demo
  -- character): it keeps its rank and its position, and its share returns to the reserve — it is never handed to another hero.
  owner_user_id bigint references public.telegram_users (telegram_user_id),
  -- The hero as it was when the period was frozen (a later rename or reroll never rewrites history).
  hero_name text not null,
  class_id text not null,
  rarity text,
  rank integer not null check (rank >= 1),
  matches integer not null check (matches >= 1),
  wins integer not null check (wins >= 0),
  top2 integer not null check (top2 >= 0),
  kos integer not null check (kos >= 0),
  prize_eligible boolean not null,
  -- Position among prize-eligible heroes (ties share a position) and how many heroes share exactly this number of wins.
  prize_rank integer check (prize_rank is null or prize_rank >= 1),
  tie_size integer not null default 1 check (tie_size >= 1),
  prize_micro numeric(78, 0) not null default 0 check (prize_micro >= 0),
  -- NONE      no prize.
  -- CREDITED  added to the owner's claimable reward balance (one ledger row).
  -- RESERVED  the hero is not claimed yet: the entitlement is kept against this hero and its owner, credited when the owner claims the hero.
  -- HELD      the owner's account is under review: nothing is credited until an admin releases or forfeits it.
  -- FORFEITED an admin forfeited it (the amount returns to the reserve).
  prize_status text not null default 'NONE' check (prize_status in ('NONE', 'CREDITED', 'RESERVED', 'HELD', 'FORFEITED')),
  -- Was the hero claimed (by its owner) when the period was frozen?
  owner_claimed boolean not null default false,
  hold_reason text,
  settled_at timestamptz,
  resolved_by text,
  resolution_reason text,
  created_at timestamptz not null default now(),
  primary key (kind, period_start, character_id),
  foreign key (kind, period_start) references public.hero_arena_boards (kind, period_start),
  check (wins <= top2 and top2 <= matches),
  check ((prize_status = 'NONE') = (prize_micro = 0)),
  check (prize_eligible or prize_micro = 0),
  check (prize_micro = 0 or owner_user_id is not null)
);
create index hero_arena_results_rank_idx on public.hero_arena_results (kind, period_start, rank);
create index hero_arena_results_hero_idx on public.hero_arena_results (character_id, period_start desc);
create index hero_arena_results_open_idx on public.hero_arena_results (prize_status) where prize_status in ('RESERVED', 'HELD');
create index hero_arena_results_owner_idx on public.hero_arena_results (owner_user_id) where owner_user_id is not null and prize_status in ('RESERVED', 'HELD');
comment on table public.hero_arena_results is
  'Frozen Hero Arena results. Stats, rank and prize are immutable; only the prize STATUS moves (RESERVED → CREDITED when the owner claims the hero; HELD / RESERVED → CREDITED or FORFEITED by an admin), never backwards.';

create or replace function public.guard_hero_arena_result()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'finalized hero arena results cannot be deleted' using errcode = '23000';
  end if;
  if row(new.kind, new.period_start, new.character_id, new.owner_user_id, new.hero_name, new.class_id, new.rarity, new.rank, new.matches, new.wins, new.top2, new.kos,
         new.prize_eligible, new.prize_rank, new.tie_size, new.prize_micro, new.owner_claimed, new.created_at)
     is distinct from
     row(old.kind, old.period_start, old.character_id, old.owner_user_id, old.hero_name, old.class_id, old.rarity, old.rank, old.matches, old.wins, old.top2, old.kos,
         old.prize_eligible, old.prize_rank, old.tie_size, old.prize_micro, old.owner_claimed, old.created_at) then
    raise exception 'finalized hero arena results are frozen' using errcode = '23000';
  end if;
  if new.prize_status is distinct from old.prize_status then
    if not ((old.prize_status = 'RESERVED' and new.prize_status in ('CREDITED', 'HELD', 'FORFEITED'))
         or (old.prize_status = 'HELD' and new.prize_status in ('CREDITED', 'FORFEITED'))) then
      raise exception 'illegal hero arena prize transition % -> %', old.prize_status, new.prize_status using errcode = '23000';
    end if;
  end if;
  return new;
end;
$$;
create trigger hero_arena_results_guard before update or delete on public.hero_arena_results
  for each row execute function public.guard_hero_arena_result();

-- ---------------------------------------------------------------------------
-- 3. The reward ledger learns the Hero Arena kinds (with their OWN reference columns)
-- ---------------------------------------------------------------------------
alter table public.arena_reward_ledger
  add column hero_period_kind text check (hero_period_kind in ('DAILY', 'WEEKLY')),
  add column hero_period_start date,
  add column hero_character_id uuid;

alter table public.arena_reward_ledger drop constraint arena_reward_ledger_kind_check;
alter table public.arena_reward_ledger drop constraint arena_reward_ledger_sign_rules;

alter table public.arena_reward_ledger
  add constraint arena_reward_ledger_kind_check check (kind in (
    'DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS',
    'HERO_ARENA_DAILY_REWARD', 'HERO_ARENA_WEEKLY_REWARD',
    'CLAIM_RESERVED', 'CLAIM_SENT', 'CLAIM_RELEASED', 'ADMIN_ADJUSTMENT')),
  add constraint arena_reward_ledger_sign_rules check (
       -- ARENA PICKS leaderboard prizes (unchanged), and they carry NO hero reference.
       (kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS')
          and claimable_delta > 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta
          and period_kind is not null and period_start is not null
          and hero_period_kind is null and hero_period_start is null and hero_character_id is null
          and ((kind like 'DAILY%') = (period_kind = 'DAILY')))
       -- HERO ARENA prizes: a base prize only (no bonus kind exists), referencing a real hero result and NOT an Arena Picks board.
    or (kind in ('HERO_ARENA_DAILY_REWARD', 'HERO_ARENA_WEEKLY_REWARD')
          and claimable_delta > 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta
          and hero_period_kind is not null and hero_period_start is not null and hero_character_id is not null
          and period_kind is null and period_start is null
          and ((kind = 'HERO_ARENA_DAILY_REWARD') = (hero_period_kind = 'DAILY')))
    or (kind = 'CLAIM_RESERVED' and claimable_delta < 0 and reserved_delta = -claimable_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_SENT'     and claimable_delta = 0 and reserved_delta < 0 and claimed_delta = -reserved_delta and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_RELEASED' and reserved_delta < 0 and claimable_delta = -reserved_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'ADMIN_ADJUSTMENT' and claimable_delta <> 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta));

-- A Hero Arena credit must reference a real hero result; a hero earns at most ONE prize per finalized period.
alter table public.arena_reward_ledger
  add constraint arena_reward_ledger_hero_result_fk foreign key (hero_period_kind, hero_period_start, hero_character_id)
  references public.hero_arena_results (kind, period_start, character_id);
create unique index arena_reward_ledger_one_hero_prize on public.arena_reward_ledger (hero_character_id, hero_period_kind, hero_period_start)
  where kind in ('HERO_ARENA_DAILY_REWARD', 'HERO_ARENA_WEEKLY_REWARD');
create index arena_reward_ledger_hero_period_idx on public.arena_reward_ledger (hero_period_kind, hero_period_start) where hero_period_kind is not null;

-- WHERE A CREDIT CAME FROM. Every ledger row (the old ones too — a generated column is computed, nothing is rewritten) names its reward program and period kind;
-- claim and adjustment rows have none. Audit and Admin read this instead of guessing from `kind`.
alter table public.arena_reward_ledger
  add column reward_source text generated always as (
    case kind
      when 'DAILY_LEADERBOARD_BASE_REWARD' then 'ARENA_PICKS_DAILY'
      when 'DAILY_LEADERBOARD_HOLDER_BONUS' then 'ARENA_PICKS_DAILY'
      when 'WEEKLY_LEADERBOARD_BASE_REWARD' then 'ARENA_PICKS_WEEKLY'
      when 'WEEKLY_LEADERBOARD_HOLDER_BONUS' then 'ARENA_PICKS_WEEKLY'
      when 'HERO_ARENA_DAILY_REWARD' then 'HERO_ARENA_DAILY'
      when 'HERO_ARENA_WEEKLY_REWARD' then 'HERO_ARENA_WEEKLY'
    end) stored;
create index arena_reward_ledger_source_idx on public.arena_reward_ledger (reward_source) where reward_source is not null;
comment on column public.arena_reward_ledger.reward_source is
  'The reward program and period of a credit: ARENA_PICKS_DAILY | ARENA_PICKS_WEEKLY | HERO_ARENA_DAILY | HERO_ARENA_WEEKLY (null for claims and adjustments).';

-- ---------------------------------------------------------------------------
-- 4. Finding a period's settled battles without scanning the battle table
-- ---------------------------------------------------------------------------
create index if not exists arena_battles_settled_idx on public.arena_battles (settled_at) where status = 'SETTLED';

-- Auditor: every row is a finding. Expected result: no rows.
create or replace function public.audit_hero_arena()
returns table (problem text, detail text)
language sql
stable
as $$
  select 'CREDITED_WITHOUT_LEDGER'::text, r.kind || ' ' || r.period_start::text || ' ' || r.character_id::text
    from public.hero_arena_results r
   where r.prize_status = 'CREDITED'
     and not exists (select 1 from public.arena_reward_ledger l where l.hero_character_id = r.character_id and l.hero_period_kind = r.kind and l.hero_period_start = r.period_start)
  union all
  select 'LEDGER_WITHOUT_CREDITED_RESULT', l.id::text
    from public.arena_reward_ledger l
   where l.hero_character_id is not null
     and not exists (select 1 from public.hero_arena_results r where r.character_id = l.hero_character_id and r.kind = l.hero_period_kind and r.period_start = l.hero_period_start and r.prize_status = 'CREDITED')
  union all
  select 'LEDGER_AMOUNT_OR_OWNER_MISMATCH', l.id::text
    from public.arena_reward_ledger l join public.hero_arena_results r on r.character_id = l.hero_character_id and r.kind = l.hero_period_kind and r.period_start = l.hero_period_start
   where l.claimable_delta <> r.prize_micro or l.telegram_user_id is distinct from r.owner_user_id
  union all
  select 'BOARD_TOTAL_MISMATCH', b.kind || ' ' || b.period_start::text
    from public.hero_arena_boards b
   where b.awarded_micro <> coalesce((select sum(r.prize_micro) from public.hero_arena_results r where r.kind = b.kind and r.period_start = b.period_start and r.prize_status <> 'NONE'), 0)
  union all
  select 'PRIZE_WITHOUT_OWNER', r.kind || ' ' || r.period_start::text || ' ' || r.character_id::text
    from public.hero_arena_results r where r.prize_micro > 0 and r.owner_user_id is null
$$;

select public.clank_harden_schema();
