-- Clank RPG — ARENA PICKS: the FINAL reward economy. Daily + Weekly leaderboards, holder PRIZE BONUS, no per-battle emission.
--
-- This is a FOLLOW-UP to 20261005001300_arena_picks_rewards.sql, which is already applied to the live database (and must never
-- be edited). It evolves that schema forward:
--
--   REMOVED   the per-battle token pool ("10,000 $CLANKRPG shared by every battle's correct pickers"), the per-day rewarded-win
--             allowance by holder tier, the 24 h tier-upgrade state machine and the lock-time tier snapshot.
--   KEPT      free unlimited picks, Telegram identity, signed holder wallets, Clank Points (lifetime), the append-only reward
--             ledger and its balances, manual claims, one-wallet-one-account, review holds.
--   ADDED     DAILY and WEEKLY leaderboards (one table pair serves both), a Top-10 ladder paid from FIXED pools, a holder BONUS
--             on earned prizes decided from an append-only log of balance observations (verified holding continuity), and
--             base / bonus kept apart in the ledger.
--   NO CAP    EVERY valid pick counts toward both boards: there is no per-day scoring limit. The 1300-era `scored`, `scored_index` and
--             `daily_limit` columns of the score table, their CHECKs and the trigger that counted a member's day are removed, so no
--             hidden database rule can stop Points after pick #20. Prize eligibility is a PARTICIPATION minimum (valid picks in the
--             period: 20 daily, 100 weekly by default), not a cap.
--
-- A correct pick can no longer credit tokens, by construction: the ledger's kind and sign rules below do not contain it.
--
-- LOGICAL AMOUNTS (the token does not exist yet). Every reward amount in the database is now a LOGICAL $CLANKRPG quantity: an integer
-- number of micro-tokens (1 unit = 1/1,000,000 of a whole token; 30,000 $CLANKRPG = 30,000,000,000). That is a property of the GAME,
-- not of any contract, so a board finalizes identically before and after the token launches and NOTHING about a contract's decimals
-- is ever frozen into a finished period. 1300 stored amounts "in token base units under an assumed scale" (and the board stored that
-- scale as `token_decimals`); this migration retires that: the board columns are renamed `*_micro`, `token_decimals` is dropped from
-- the board, a claim carries its LOGICAL amount plus the exact raw on-chain amount derived from the CONTRACT's decimals() at the moment
-- the claim is made (the database CHECKs the conversion), and the contract's symbol / decimals live in `arena_reward_token`, a cache of
-- what the contract itself reported — never configured. Raw chain quantities (`balance_raw`, `verified_balance_raw`, `amount_raw`)
-- stay raw: they are what the chain says.
--
-- SAFETY. The reward tables were empty when this was written. The migration refuses (and rolls back whole) if any per-battle token
-- credit exists, or if ANY reward amount exists at all (they would be in token base units at an assumed scale, which cannot be
-- reinterpreted as logical amounts automatically) — it never discards or guesses at money records. Everything runs in the runner's one
-- transaction per file.

-- ---------------------------------------------------------------------------
-- 0. Refuse to retire the per-battle schema if it ever paid anyone
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from public.arena_reward_ledger where kind = 'ARENA_PICK_REWARD')
     or exists (select 1 from public.arena_pick_outcomes where token_reward_raw > 0)
     or exists (select 1 from public.arena_pick_settlements where distributed_raw > 0) then
    raise exception 'refusing to retire the per-battle token reward schema: per-battle $CLANKRPG rewards were credited on this database. Resolve them first (an admin adjustment) — this migration will not discard money records.';
  end if;
  if exists (select 1 from public.arena_weekly_pick_scores where not scored) then
    raise exception 'refusing to remove the per-day scoring cap: this database holds picks that the old cap left unscored. Their meaning under "every valid pick counts" needs a human decision — this migration will not guess.';
  end if;
  -- Reward amounts recorded under 1300 are in token base units at an assumed scale; they cannot be reinterpreted as logical amounts
  -- automatically. (The live database holds none — every reward table was empty when this was written.)
  if exists (select 1 from public.arena_reward_ledger)
     or exists (select 1 from public.arena_reward_claims)
     or exists (select 1 from public.arena_weeks)
     or exists (select 1 from public.arena_reward_accounts where earned_total <> 0 or claimable <> 0 or reserved <> 0 or claimed_total <> 0) then
    raise exception 'refusing to reinterpret reward amounts: this database holds reward amounts recorded in token base units. They must be converted by a human (an audited adjustment) — this migration will not guess a token scale.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Settings: rewrite a stored row of the superseded design to the final economy
-- ---------------------------------------------------------------------------
-- Same rule as the application's reader (`upgradeLegacyArenaPicks`): retired keys go, the economy numbers that belonged to the old
-- design (pools, ladder, minimums) take the FINAL defaults, operational knobs the admin may have tuned carry over. Only rows that
-- still have an old-design key are touched, so re-running this (or a row already in the new shape) is a no-op.
update public.game_settings
   set value =
         jsonb_build_object(
           'enabled', true,
           'minimumClaim', '10000',
           'pointsPerCorrectPick', 10,
           'holderRefreshMinutes', 30,
           'holderRefreshJitterPct', 20,
           'holderCheckBatchSize', 25,
           'holderMaxAgeHours', 6,
           'holderManualRefreshSeconds', 300,
           'minConfirmations', 2,
           'walletChangeFreshMinutes', 15,
           'holderDailyQualifyHours', 24,
           'holderWeeklyQualifyHours', 168,
           'holderReconcileHours', 24,
           'holderBonusTiers', jsonb_build_array(
             jsonb_build_object('minimum', '0', 'bonusBps', 0),
             jsonb_build_object('minimum', '100000', 'bonusBps', 500),
             jsonb_build_object('minimum', '500000', 'bonusBps', 1000),
             jsonb_build_object('minimum', '1000000', 'bonusBps', 1500),
             jsonb_build_object('minimum', '5000000', 'bonusBps', 2000),
             jsonb_build_object('minimum', '10000000', 'bonusBps', 2500)),
           'seasonPlanWeeks', 12,
           'seasonRewardAllocation', '20000000')
         || (value - array['rewardPerBattle', 'dailyEmissionCap', 'holderTiers', 'holderTierActivationHours', 'weeklyScoredPicksPerDay', 'weeklyPrizeSplitBps', 'weeklyPrizePool', 'weeklyMinimumScoredPicks',
                           'scoredPicksPerDay', 'dailyMinimumScoredPicks'])
         || jsonb_build_object(
           'dailyPrizePool', '100000',
           'weeklyPrizePool', '500000',
           'prizeSplitBps', jsonb_build_array(3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200),
           'dailyMinimumPicks', 20,
           'weeklyMinimumPicks', 100),
       version = version + 1,
       updated_by = 'migration:20261005001400',
       updated_at = now()
 where key = 'arena_picks'
   and value ?| array['rewardPerBattle', 'holderTiers', 'weeklyScoredPicksPerDay', 'scoredPicksPerDay', 'dailyMinimumScoredPicks'];

-- ---------------------------------------------------------------------------
-- 2. Retire the per-battle machinery
-- ---------------------------------------------------------------------------
-- The lock-time holder-allowance snapshot (the column `tier_snapshot` stays, inert, because the pick guard still names it).
drop trigger if exists arena_picks_lock_snapshot on public.arena_picks;
drop function if exists public.snapshot_pick_tier();
comment on column public.arena_picks.tier_snapshot is 'RETIRED: holder tiers no longer limit anything per pick. Kept (always null) so the pick guard and old rows stay valid.';

-- Per-battle token outcomes + the daily rewarded-win guard (empty by the check above, apart from rows that paid nothing).
drop table public.arena_pick_outcomes;
drop function if exists public.guard_arena_pick_outcome();

-- ---------------------------------------------------------------------------
-- 3. The reward ledger: new kinds (base and holder bonus kept APART), no per-battle columns
-- ---------------------------------------------------------------------------
alter table public.arena_reward_ledger drop constraint arena_reward_ledger_weekly_prize_fk;
alter table public.arena_reward_ledger drop constraint arena_reward_ledger_check;
alter table public.arena_reward_ledger drop constraint arena_reward_ledger_kind_check;
drop index public.arena_reward_ledger_one_weekly_prize;
drop index public.arena_reward_ledger_one_credit;

-- The per-battle reference columns can only have been filled by ARENA_PICK_REWARD rows, which do not exist (step 0).
alter table public.arena_reward_ledger
  drop column battle_id,
  drop column settlement_id,
  drop column picked_character_id,
  drop column winning_character_id,
  drop column reward_pool_raw,
  drop column correct_pickers;

alter table public.arena_reward_ledger rename column week_start to period_start;
alter table public.arena_reward_ledger add column period_kind text check (period_kind in ('DAILY', 'WEEKLY'));

-- (The ledger is empty here — step 0 refuses otherwise — so there are no rows of the previous design to re-label.)

alter table public.arena_reward_ledger
  add constraint arena_reward_ledger_kind_check check (kind in (
    'DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS',
    'CLAIM_RESERVED', 'CLAIM_SENT', 'CLAIM_RELEASED', 'ADMIN_ADJUSTMENT')),
  -- The sign rule of every kind. A row that breaks it cannot exist, whatever the application does. Note what is NOT here: any
  -- credit that is not a finalized leaderboard prize (or a bonus on one) or an audited admin adjustment — a correct pick cannot pay.
  add constraint arena_reward_ledger_sign_rules check (
       (kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS')
          and claimable_delta > 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta
          and period_kind is not null and period_start is not null
          and ((kind like 'DAILY%') = (period_kind = 'DAILY')))
    or (kind = 'CLAIM_RESERVED' and claimable_delta < 0 and reserved_delta = -claimable_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_SENT'     and claimable_delta = 0 and reserved_delta < 0 and claimed_delta = -reserved_delta and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_RELEASED' and reserved_delta < 0 and claimable_delta = -reserved_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'ADMIN_ADJUSTMENT' and claimable_delta <> 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta));

-- A member earns at most ONE base prize and ONE holder bonus per finalized period.
create unique index arena_reward_ledger_one_base_prize on public.arena_reward_ledger (telegram_user_id, period_kind, period_start)
  where kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_BASE_REWARD');
create unique index arena_reward_ledger_one_holder_bonus on public.arena_reward_ledger (telegram_user_id, period_kind, period_start)
  where kind in ('DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_HOLDER_BONUS');
create index arena_reward_ledger_period_idx on public.arena_reward_ledger (period_kind, period_start) where period_kind is not null;

-- ---------------------------------------------------------------------------
-- 4. Per-battle settlement: now only the exactly-once SCORING anchor (no token fields)
-- ---------------------------------------------------------------------------
alter table public.arena_pick_settlements drop constraint arena_pick_settlements_status_check;
alter table public.arena_pick_settlements disable trigger arena_pick_settlements_append_only;
update public.arena_pick_settlements set status = case when status = 'VOID' then 'VOID' else 'SCORED' end;
alter table public.arena_pick_settlements enable trigger arena_pick_settlements_append_only;
-- Dropping the token columns also drops every CHECK that mentions them.
alter table public.arena_pick_settlements
  drop column reward_pool_raw,
  drop column rewarded_pickers,
  drop column share_raw,
  drop column distributed_raw,
  drop column returned_to_reserve_raw,
  drop column token_decimals;
alter table public.arena_pick_settlements
  -- Valid picks that counted toward the Daily and Weekly boards: all of them (there is no daily cap). `points_awarded` is the Points they earned.
  add column valid_picks integer not null default 0 check (valid_picks >= 0),
  add constraint arena_pick_settlements_status_check check (status in ('SCORED', 'VOID')),
  add constraint arena_pick_settlements_counts_check check (correct_pickers <= correct_picks and correct_picks <= picks_total and valid_picks <= picks_total);
comment on table public.arena_pick_settlements is
  'ONE row per battle: the exactly-once anchor of Arena Picks SCORING (leaderboard points and lifetime Clank Points). It carries no token amount: no battle ever pays tokens.';

-- ---------------------------------------------------------------------------
-- 5. Per-pick scoring: one table feeds the Daily AND the Weekly board
-- ---------------------------------------------------------------------------
alter table public.arena_weekly_pick_scores rename to arena_pick_scores;
alter table public.arena_pick_scores rename column weekly_points to points;
alter index public.arena_weekly_pick_scores_week_idx rename to arena_pick_scores_week_idx;
alter trigger arena_weekly_pick_scores_append_only on public.arena_pick_scores rename to arena_pick_scores_append_only;
drop trigger arena_weekly_pick_scores_guard on public.arena_pick_scores;
drop function public.guard_arena_weekly_pick_score();
-- NO CAP: every valid pick is one counted row. The counting columns go (dropping a column also drops the CHECKs and the partial index that
-- mention it); the only remaining rule on a points row is "points only for a correct pick" (kept from 1300).
alter table public.arena_pick_scores
  drop column scored,
  drop column scored_index,
  drop column daily_limit;
create index arena_pick_scores_day_idx on public.arena_pick_scores (utc_date, telegram_user_id);
create index arena_pick_scores_member_day_idx on public.arena_pick_scores (telegram_user_id, utc_date);
comment on table public.arena_pick_scores is
  'One row per VALID settled pick (correct or not) — EVERY valid pick counts toward the Daily and the Weekly board (there is no per-day limit); a correct one carries the Points. Holder tiers never change a row.';

-- ---------------------------------------------------------------------------
-- 6. Leaderboards: DAILY and WEEKLY periods, their frozen results and prizes
-- ---------------------------------------------------------------------------
create table public.arena_leaderboards (
  kind text not null check (kind in ('DAILY', 'WEEKLY')),
  -- The UTC date the period starts on (a Monday for WEEKLY).
  period_start date not null,
  -- The terms the period was finalized under (frozen): what it paid, how, and the holder-bonus rules in force. All amounts are LOGICAL
  -- micro-tokens (see the header): no token, no contract and no decimals are involved in a finished board.
  prize_pool_micro numeric(78, 0) not null check (prize_pool_micro >= 0),
  prize_split_bps jsonb not null,
  minimum_picks integer not null check (minimum_picks >= 0),
  points_per_correct_pick integer not null check (points_per_correct_pick >= 0),
  -- The bonus ladder as frozen: [{ "index": 1, "minimum": "100000", "bonusBps": 500 }, …] — WHOLE-TOKEN minimums as text, never a balance in some
  -- token's raw units (they become raw thresholds only when a balance is compared, at the contract's decimals()).
  holder_bonus_tiers jsonb not null default '[]'::jsonb,
  holder_qualification_hours integer not null default 0 check (holder_qualification_hours >= 0),
  holder_max_gap_hours integer not null default 6 check (holder_max_gap_hours >= 1),
  -- A bonus whose close verification failed waits (PENDING VERIFICATION) until here, then expires. The base prize never waits.
  bonus_reconcile_until timestamptz not null,
  participants integer not null check (participants >= 0),
  eligible_participants integer not null check (eligible_participants >= 0),
  -- BASE prizes only (holder bonuses are extra and accounted per result row): awarded to prize positions + returned = the pool.
  base_awarded_micro numeric(78, 0) not null default 0 check (base_awarded_micro >= 0),
  returned_to_reserve_micro numeric(78, 0) not null default 0 check (returned_to_reserve_micro >= 0),
  finalized_at timestamptz not null default now(),
  primary key (kind, period_start),
  check (kind = 'DAILY' or extract(isodow from period_start) = 1),
  check (base_awarded_micro + returned_to_reserve_micro = prize_pool_micro),
  check (eligible_participants <= participants)
);
create trigger arena_leaderboards_append_only before update or delete on public.arena_leaderboards
  for each row execute function public.forbid_mutation();
comment on table public.arena_leaderboards is
  'A FINALIZED Daily or Weekly Arena Picks board. Immutable once written: scores, ranks and prizes are frozen rows.';

create table public.arena_leaderboard_results (
  kind text not null,
  period_start date not null,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  -- The hero as it was when the period was frozen (a later rename never rewrites history).
  character_id uuid references public.characters (id),
  hero_name text not null,
  class_id text not null,
  rank integer not null check (rank >= 1),
  points integer not null check (points >= 0),
  picks integer not null check (picks >= 0),
  correct_picks integer not null check (correct_picks >= 0),
  -- Accuracy across ALL valid picks of the period (correct / picks), in basis points (floored).
  accuracy_bps integer not null check (accuracy_bps between 0 and 10000),
  current_streak integer not null default 0 check (current_streak >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  prize_eligible boolean not null,
  -- Position among prize-eligible members (ties share a position) and how many members share this exact (correct picks, accuracy).
  prize_rank integer check (prize_rank is null or prize_rank >= 1),
  tie_size integer not null default 1 check (tie_size >= 1),
  -- THE BASE PRIZE (from the fixed pool and the ladder; independent of holdings).
  base_prize_micro numeric(78, 0) not null default 0 check (base_prize_micro >= 0),
  -- NONE = no prize. CREDITED = added to claimable. HELD = a prize position, but the account was under review: nothing is
  -- credited until an admin resolves it (release → CREDITED, forfeit → FORFEITED and the amount returns to the reserve).
  base_status text not null default 'NONE' check (base_status in ('NONE', 'CREDITED', 'HELD', 'FORFEITED')),
  hold_reason text,
  -- THE HOLDER BONUS (extra, on top of the base prize; never taken from another player).
  --   NONE                  not a holder / not qualified / no prize.
  --   PENDING_VERIFICATION  the final close verification failed: waits a limited window, never granted blindly.
  --   CREDITED / HELD / FORFEITED  decided from the evidence; credited with the base, held with it, forfeited with it.
  --   EXPIRED               could not be verified inside the reconciliation window.
  bonus_status text not null default 'NONE' check (bonus_status in ('NONE', 'PENDING_VERIFICATION', 'CREDITED', 'HELD', 'FORFEITED', 'EXPIRED')),
  bonus_tier_index integer check (bonus_tier_index is null or bonus_tier_index >= 1),
  bonus_label text,
  bonus_bps integer not null default 0 check (bonus_bps between 0 and 10000),
  bonus_micro numeric(78, 0) not null default 0 check (bonus_micro >= 0),
  -- The continuity proof (admin eyes only): tiers evaluated, run start, close observation, gaps. Never served to players.
  bonus_evidence jsonb,
  bonus_resolved_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  created_at timestamptz not null default now(),
  primary key (kind, period_start, telegram_user_id),
  foreign key (kind, period_start) references public.arena_leaderboards (kind, period_start),
  check (correct_picks <= picks),
  check ((base_status = 'NONE') = (base_prize_micro = 0)),
  check (prize_eligible or base_prize_micro = 0),
  -- A bonus exists only on an earned prize, and is EXACTLY floor(base × bps / 10000) (div() is exact integer division — numeric '/' may round).
  check (bonus_status = 'NONE' or base_prize_micro > 0),
  check (bonus_status not in ('NONE', 'PENDING_VERIFICATION', 'EXPIRED') or (bonus_micro = 0 and bonus_bps = 0 and bonus_tier_index is null)),
  check (bonus_status not in ('CREDITED', 'HELD', 'FORFEITED') or (bonus_bps > 0 and bonus_tier_index is not null and bonus_micro > 0 and bonus_micro = div(base_prize_micro * bonus_bps, 10000::numeric))),
  -- The bonus can only be credited / held / forfeited together with its base prize, and cannot wait on a prize that no longer exists.
  check (bonus_status <> 'CREDITED' or base_status = 'CREDITED'),
  check (bonus_status <> 'HELD' or base_status = 'HELD'),
  check (bonus_status <> 'FORFEITED' or base_status = 'FORFEITED'),
  check (bonus_status <> 'PENDING_VERIFICATION' or base_status in ('CREDITED', 'HELD'))
);
create index arena_leaderboard_results_rank_idx on public.arena_leaderboard_results (kind, period_start, rank);
create index arena_leaderboard_results_user_idx on public.arena_leaderboard_results (telegram_user_id, period_start desc);
create index arena_leaderboard_results_held_idx on public.arena_leaderboard_results (base_status) where base_status = 'HELD';
create index arena_leaderboard_results_pending_bonus_idx on public.arena_leaderboard_results (kind, period_start) where bonus_status = 'PENDING_VERIFICATION';

-- The weekly boards of the previous design are NOT carried over: they would be amounts in token base units (the guard in step 0 refuses to run
-- when any exist — none do on the live database). Their tables are retired.
drop table public.arena_week_results;
drop function public.guard_arena_week_result();
drop table public.arena_weeks;

-- A leaderboard credit must reference a real result row of that member (base and bonus share it).
alter table public.arena_reward_ledger
  add constraint arena_reward_ledger_result_fk foreign key (period_kind, period_start, telegram_user_id)
  references public.arena_leaderboard_results (kind, period_start, telegram_user_id);

-- A finalized result is FROZEN. Exactly two things may change, once each, and always with a record of who/why:
--   · a prize HELD for review is released / forfeited by an admin (its bonus follows it);
--   · a bonus that was PENDING VERIFICATION is resolved by reconciliation (or expires).
create or replace function public.guard_arena_leaderboard_result()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'finalized leaderboard results cannot be deleted' using errcode = '23000';
  end if;
  if row(new.kind, new.period_start, new.telegram_user_id, new.character_id, new.hero_name, new.class_id, new.rank, new.points, new.picks, new.correct_picks,
         new.accuracy_bps, new.current_streak, new.best_streak, new.prize_eligible, new.prize_rank, new.tie_size, new.base_prize_micro, new.hold_reason, new.created_at)
     is distinct from
     row(old.kind, old.period_start, old.telegram_user_id, old.character_id, old.hero_name, old.class_id, old.rank, old.points, old.picks, old.correct_picks,
         old.accuracy_bps, old.current_streak, old.best_streak, old.prize_eligible, old.prize_rank, old.tie_size, old.base_prize_micro, old.hold_reason, old.created_at) then
    raise exception 'finalized leaderboard results are frozen' using errcode = '23000';
  end if;

  if old.base_status is distinct from new.base_status then
    if not (old.base_status = 'HELD' and new.base_status in ('CREDITED', 'FORFEITED')
            and new.resolved_at is not null and new.resolved_by is not null and new.resolution_reason is not null) then
      raise exception 'illegal prize transition % -> %', old.base_status, new.base_status using errcode = '23000';
    end if;
  elsif row(new.resolved_at, new.resolved_by, new.resolution_reason) is distinct from row(old.resolved_at, old.resolved_by, old.resolution_reason) then
    raise exception 'a resolution is recorded only with the prize transition' using errcode = '23000';
  end if;

  if old.bonus_status is distinct from new.bonus_status then
    if old.bonus_status = 'PENDING_VERIFICATION' and new.bonus_status in ('NONE', 'CREDITED', 'HELD', 'EXPIRED', 'FORFEITED') and new.bonus_resolved_at is not null then
      null; -- reconciliation (or the base prize it waited on was forfeited)
    elsif old.bonus_status = 'HELD' and new.bonus_status in ('CREDITED', 'FORFEITED') and old.base_status = 'HELD' and new.base_status = new.bonus_status then
      null; -- released / forfeited together with its base prize
    else
      raise exception 'illegal bonus transition % -> %', old.bonus_status, new.bonus_status using errcode = '23000';
    end if;
  elsif row(new.bonus_tier_index, new.bonus_label, new.bonus_bps, new.bonus_micro, new.bonus_evidence, new.bonus_resolved_at)
        is distinct from row(old.bonus_tier_index, old.bonus_label, old.bonus_bps, old.bonus_micro, old.bonus_evidence, old.bonus_resolved_at) then
    raise exception 'the bonus is fixed unless its status changes' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger arena_leaderboard_results_guard before update or delete on public.arena_leaderboard_results
  for each row execute function public.guard_arena_leaderboard_result();

-- THE SCORING GUARD. EVERY valid pick counts, so there is nothing to count or cap: the only rule is that a FINALIZED period (day OR
-- week) never changes — a score row for a period that is already frozen is refused, so a frozen board can never be altered by a late
-- settlement.
create or replace function public.guard_arena_pick_score()
returns trigger
language plpgsql
as $$
begin
  if exists (
       select 1 from public.arena_leaderboards l
        where (l.kind = 'DAILY' and l.period_start = new.utc_date) or (l.kind = 'WEEKLY' and l.period_start = new.week_start)) then
    raise exception 'this leaderboard period is already finalized' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger arena_pick_scores_guard before insert on public.arena_pick_scores
  for each row execute function public.guard_arena_pick_score();

-- ---------------------------------------------------------------------------
-- 7. Holder verification: an append-only LOG of authoritative balance reads (the continuity evidence)
-- ---------------------------------------------------------------------------
-- The previous design kept a mutable tier state machine (active / candidate tier, 24 h activation). Continuity is now PROVEN from
-- evidence instead: every successful `balanceOf` read of a member's verified holder wallet is one immutable row here. A bonus is
-- decided from these rows at finalization — nothing mutable can be edited to fake a holding history.
create table public.arena_holder_observations (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  balance_raw numeric(78, 0) not null check (balance_raw >= 0),
  observed_at timestamptz not null default now(),
  -- CONNECT = the signed wallet link · MANUAL = "Refresh holdings" · BACKGROUND = the scheduled ~30 min check · CLOSE = the final
  -- authoritative verification of a prize winner at leaderboard close.
  source text not null check (source in ('CONNECT', 'MANUAL', 'BACKGROUND', 'CLOSE')),
  created_at timestamptz not null default now()
);
create index arena_holder_observations_user_idx on public.arena_holder_observations (telegram_user_id, observed_at);
create trigger arena_holder_observations_append_only before update or delete on public.arena_holder_observations
  for each row execute function public.forbid_mutation();

-- An observation is of the member's CURRENT verified holder wallet, or it does not exist (a balance read for a wallet the member
-- just replaced can never become evidence for the new one).
create or replace function public.guard_arena_holder_observation()
returns trigger
language plpgsql
as $$
declare
  w text;
begin
  select holder_wallet_address into w from public.arena_reward_accounts where telegram_user_id = new.telegram_user_id;
  if w is null or w <> new.wallet_address then
    raise exception 'an observation must be of the member''s current verified holder wallet' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger arena_holder_observations_guard before insert on public.arena_holder_observations
  for each row execute function public.guard_arena_holder_observation();

-- The holder status row is now only the latest read + the verification schedule (a cache the 1-minute tick works from).
-- Its tier/candidate/activation columns belonged to the retired allowance design.
alter table public.arena_holder_status
  drop column active_tier_index,
  drop column active_allowance,
  drop column active_since,
  drop column effective_until,
  drop column candidate_tier_index,
  drop column candidate_since,
  drop column last_observed_at;
comment on table public.arena_holder_status is
  'The latest authoritative read of a holder wallet and its verification schedule (next_check_at, failures). The tier is NEVER stored: it is derived from the balance and, for a bonus, from arena_holder_observations.';
comment on table public.arena_holder_tier_history is
  'LEGACY audit trail of the retired tier / 24 h activation model. Kept (never deleted); still receives WALLET_CHANGED when a holder wallet changes.';

-- ---------------------------------------------------------------------------
-- 8. Claims carry a LOGICAL amount; the raw on-chain amount is DERIVED from the contract's decimals() and the database checks it
-- ---------------------------------------------------------------------------
-- A claim exists only once the token has launched and its contract has been verified (the application refuses before that and the
-- member simply keeps a CLAIMABLE balance — nothing is denied). `amount_micro` is the logical amount the ledger reserved;
-- `amount_raw` is the exact raw amount an admin must send, = amount_micro × 10^(token_decimals − 6) (token_decimals is what the contract's
-- decimals() reported when the claim was made). The CHECK below is that conversion, so the two can never disagree.
alter table public.arena_reward_claims
  add column amount_micro numeric(78, 0) not null check (amount_micro > 0),
  add constraint arena_reward_claims_conversion check (amount_raw = amount_micro * power(10::numeric, token_decimals - 6));
comment on column public.arena_reward_claims.amount_micro is 'LOGICAL amount reserved on the ledger (micro-tokens: 1 unit = 1/1,000,000 $CLANKRPG).';
comment on column public.arena_reward_claims.amount_raw is 'The exact on-chain amount to send, in the token''s raw units = amount_micro × 10^(token_decimals − 6). Verified against the transfer.';
comment on column public.arena_reward_claims.token_decimals is 'The contract''s own decimals() when the claim was made (read from the contract, never configured).';

create or replace function public.guard_arena_reward_claim()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'PENDING' then
      raise exception 'claims start as PENDING' using errcode = '23000';
    end if;
    return new;
  end if;
  -- The amount, the destination and the token terms are frozen the moment the claim exists.
  if new.telegram_user_id is distinct from old.telegram_user_id or new.amount_micro is distinct from old.amount_micro or new.amount_raw is distinct from old.amount_raw
     or new.destination_address is distinct from old.destination_address or new.destination_kind is distinct from old.destination_kind
     or new.token_address is distinct from old.token_address or new.chain_id is distinct from old.chain_id
     or new.token_decimals is distinct from old.token_decimals or new.idempotency_key is distinct from old.idempotency_key
     or new.requested_at is distinct from old.requested_at then
    raise exception 'claim terms are immutable' using errcode = '23000';
  end if;
  if old.status in ('SENT', 'DENIED') then
    raise exception 'a finished claim is frozen' using errcode = '23000';
  end if;
  if old.status <> new.status and (old.status, new.status) not in (('PENDING', 'SENT'), ('PENDING', 'DENIED')) then
    raise exception 'illegal claim transition % -> %', old.status, new.status using errcode = '23000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on table public.arena_reward_accounts is 'Balances in LOGICAL micro-tokens (1 unit = 1/1,000,000 $CLANKRPG), maintained only by the ledger triggers — independent of any token contract or its decimals.';
comment on table public.arena_reward_ledger is 'Append-only reward ledger. Every delta is a LOGICAL micro-token amount (see the 1400 header); the ledger works identically before and after the token exists.';

-- ---------------------------------------------------------------------------
-- 9. The official token's metadata: a CACHE of what the CONTRACT itself reported (never configured)
-- ---------------------------------------------------------------------------
-- One row. Written by the server after it verified the contract (right chain, bytecode present, decimals() and symbol() readable). It lets the
-- Admin console and the profile show the symbol / decimals without a chain call; holder verification and claims need a verified contract and
-- stay CLOSED without one. The Arena, the boards, finalization and reward accounting never read it.
create table public.arena_reward_token (
  id smallint primary key default 1 check (id = 1),
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  symbol text not null check (char_length(symbol) between 1 and 40),
  decimals integer not null check (decimals between 0 and 36),
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.arena_reward_token is 'Cache of the official $CLANKRPG contract''s own symbol() / decimals(), written after the server verified the contract. Never a setting.';

select public.clank_harden_schema();
