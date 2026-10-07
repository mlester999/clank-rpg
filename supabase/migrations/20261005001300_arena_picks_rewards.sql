-- Clank RPG — ARENA PICKS rewards ($CLANKRPG).
--
-- The product: eligible members make ONE FREE pick per battle (unlimited battles); the battle's Arena #1 is the correct pick.
-- TWO reward layers: CLANK POINTS (off-chain, lifetime, unlimited) for every correct pick, and $CLANKRPG tokens: the battle's
-- fixed pool is divided among ALL correct pickers, but only pickers still within their DAILY allowance (1/day FREE, more for
-- verified holders — tiers are settings) receive their share; capped pickers' shares go back to the reserve, never to other
-- winners. A separate WEEKLY ARENA PICKS LEADERBOARD ranks only each member's first N valid picks per UTC day (so it rewards
-- skill, not uptime) and pays a fixed weekly prize pool. Nobody deposits, wagers or loses anything. Telegram is the player
-- identity; a wallet is optional (holder tiers).
--
-- TOKENS ARE PAID BY HAND. The application holds no signing key and never sends a transaction. A claim is a REQUEST that
-- reserves the member's claimable balance (PENDING); an admin transfers the tokens manually and names the transaction, which
-- the server verifies read-only on-chain before marking the claim SENT (or the admin DENIES it and the reservation returns).
-- The holder wallet (proves holdings → reward tier) and a claim's destination (where ONE payout goes) are different things.
--
-- This REPLACES the abandoned test-betting design (betting migrations 20261005001000/-1100/-1200 were never applied to
-- any live database and were removed from the repo; this migration depends on none of them).
--
-- Accounting model
--   * Token quantities are INTEGER BASE UNITS (numeric(78,0): fits any uint256). No floats anywhere.
--   * arena_reward_ledger is APPEND-ONLY. Every balance change is one row with a unique idempotency key.
--   * arena_reward_accounts holds the balances and is maintained ONLY by triggers on the ledger (a direct UPDATE of a
--     balance is refused), so there is exactly one mutation path and a replayed request is a no-op. CHECKs make a negative
--     balance impossible, and  earned = claimable + reserved + claimed  is a database CHECK (conservation).
--   * A settlement splits its pool as  pool = share × correct_pickers + returned_to_reserve  (CHECK). Nothing rolls over.
--   * A member has at most ONE credit per battle, ONE weekly prize per week, and at most ONE pending claim (unique indexes).
--   * A finalized week is IMMUTABLE: its ranking, scores and prizes are frozen rows (only an admin's resolution of a prize
--     held for review may change that one row's status).
--
-- Nothing here touches arena rules, combat, queue fairness or any hero rule.

-- ---------------------------------------------------------------------------
-- 1. Evolve the existing free picks (no historical row becomes a token reward)
-- ---------------------------------------------------------------------------
alter table public.arena_picks
  -- Eligibility for the token reward, snapshotted on every submit and FROZEN when picks lock (see guard below).
  add column reward_eligible boolean not null default false,
  add column eligibility jsonb,
  -- Written by a trigger at the instant picks LOCK (see below): holder tier, daily allowance, rewarded wins already used that UTC day.
  add column tier_snapshot jsonb;

comment on column public.arena_picks.reward_eligible is
  'True when the member was eligible for the $CLANKRPG reward at their last submit before lock. Frozen at lock.';

create or replace function public.guard_arena_pick()
returns trigger
language plpgsql
as $$
declare
  b record;
begin
  select status, combat_starts_at into b from public.arena_battles where id = new.battle_id;

  if tg_op = 'INSERT' then
    if b.status is distinct from 'SIMULATED' then
      raise exception 'picks are only accepted for the battle on stage' using errcode = '23000';
    end if;
    -- The lock is also enforced HERE, against the battle's authoritative combat start (the service checks the same clock).
    if b.combat_starts_at is not null and new.submitted_at >= b.combat_starts_at then
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
  if new.character_id is distinct from old.character_id then
    if old.locked_at is not null then
      raise exception 'pick is locked' using errcode = '23000';
    end if;
    if b.status is distinct from 'SIMULATED' then
      raise exception 'picks can only change while the battle is on stage' using errcode = '23000';
    end if;
  end if;
  -- A re-submit (any change of fighter or eligibility snapshot) must still be before combat starts …
  if (new.character_id is distinct from old.character_id or new.reward_eligible is distinct from old.reward_eligible
      or new.eligibility is distinct from old.eligibility)
     and b.combat_starts_at is not null and new.submitted_at >= b.combat_starts_at then
    raise exception 'picks are locked for this battle' using errcode = '23000';
  end if;
  -- … and the eligibility and tier snapshots are frozen once picks lock.
  if old.locked_at is not null and (new.reward_eligible is distinct from old.reward_eligible or new.eligibility is distinct from old.eligibility
                                    or new.tier_snapshot is distinct from old.tier_snapshot) then
    raise exception 'the eligibility snapshot is frozen at lock' using errcode = '23000';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reward accounts: balances (ledger-maintained) + the verified HOLDER wallet + the review state
-- ---------------------------------------------------------------------------
create table public.arena_reward_accounts (
  telegram_user_id bigint primary key references public.telegram_users (telegram_user_id),
  -- Balances in token base units. Maintained ONLY by the ledger triggers.
  claimable numeric(78, 0) not null default 0 check (claimable >= 0),
  reserved numeric(78, 0) not null default 0 check (reserved >= 0),
  claimed_total numeric(78, 0) not null default 0 check (claimed_total >= 0),
  earned_total numeric(78, 0) not null default 0 check (earned_total >= 0),
  -- The HOLDER wallet: the member PROVED control of it by signing a server challenge, and its $CLANKRPG balance decides the
  -- reward tier. Lower-case 0x…. It is NOT where payouts go (every claim names its own destination).
  holder_wallet_address text check (holder_wallet_address ~ '^0x[0-9a-f]{40}$'),
  wallet_verified_at timestamptz,
  -- Admin-approved exception: this account may use a holder wallet that another account already uses.
  wallet_exception boolean not null default false,
  -- NORMAL = may claim. REVIEW = rewards are still recorded but CLAIMS are held. SUSPENDED = nothing new is credited and claims are held.
  review_state text not null default 'NORMAL' check (review_state in ('NORMAL', 'REVIEW', 'SUSPENDED')),
  review_reason text check (review_reason is null or char_length(review_reason) <= 300),
  review_updated_at timestamptz,
  review_updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- CONSERVATION: every unit ever earned is claimable, reserved by a claim in flight, or claimed.
  check (earned_total = claimable + reserved + claimed_total),
  check ((holder_wallet_address is null) = (wallet_verified_at is null))
);
-- One verified holder wallet belongs to ONE account (an admin-approved exception is the only way around it).
create unique index arena_reward_accounts_wallet_unique on public.arena_reward_accounts (holder_wallet_address)
  where holder_wallet_address is not null and not wallet_exception;
create index arena_reward_accounts_review_idx on public.arena_reward_accounts (review_state) where review_state <> 'NORMAL';

create or replace function public.guard_arena_reward_account()
returns trigger
language plpgsql
as $$
begin
  -- Balances change ONLY through the ledger's own trigger (nesting depth 2). Nobody — not application code, not an admin
  -- query — edits a balance directly.
  if tg_op = 'INSERT' then
    if pg_trigger_depth() < 2 and (new.claimable <> 0 or new.reserved <> 0 or new.claimed_total <> 0 or new.earned_total <> 0) then
      raise exception 'balances are maintained by the reward ledger only' using errcode = '23000';
    end if;
  elsif pg_trigger_depth() < 2 and (
       new.claimable is distinct from old.claimable or new.reserved is distinct from old.reserved
    or new.claimed_total is distinct from old.claimed_total or new.earned_total is distinct from old.earned_total) then
    raise exception 'balances are maintained by the reward ledger only' using errcode = '23000';
  end if;
  -- Another account already uses this holder wallet (and nobody holds an exception): refuse, whatever the application does.
  if new.holder_wallet_address is not null and not new.wallet_exception and exists (
       select 1 from public.arena_reward_accounts a
        where a.holder_wallet_address = new.holder_wallet_address and a.telegram_user_id <> new.telegram_user_id) then
    raise exception 'this wallet is already linked to another account' using errcode = '23505';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger arena_reward_accounts_guard before insert or update on public.arena_reward_accounts
  for each row execute function public.guard_arena_reward_account();

-- Every HOLDER wallet binding / change (append-only): old address, new address, actor, when. Admin eyes only.
create table public.arena_reward_wallet_history (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  old_address text check (old_address is null or old_address ~ '^0x[0-9a-f]{40}$'),
  new_address text not null check (new_address ~ '^0x[0-9a-f]{40}$'),
  actor text not null,
  reason text,
  created_at timestamptz not null default now()
);
create index arena_reward_wallet_history_user_idx on public.arena_reward_wallet_history (telegram_user_id, id desc);
create trigger arena_reward_wallet_history_append_only before update or delete on public.arena_reward_wallet_history
  for each row execute function public.forbid_mutation();

-- Attempts to bind a holder wallet that another account already uses, or to claim to another account's verified holder wallet
-- (append-only): the admin review trail.
create table public.arena_reward_wallet_attempts (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  attempted_address text not null check (attempted_address ~ '^0x[0-9a-f]{40}$'),
  conflicting_user_id bigint references public.telegram_users (telegram_user_id),
  created_at timestamptz not null default now()
);
create index arena_reward_wallet_attempts_user_idx on public.arena_reward_wallet_attempts (telegram_user_id, id desc);
create trigger arena_reward_wallet_attempts_append_only before update or delete on public.arena_reward_wallet_attempts
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 3. Settlements: one immutable record per battle (the exactly-once anchor)
-- ---------------------------------------------------------------------------
create table public.arena_pick_settlements (
  id uuid primary key default gen_random_uuid(),
  -- ONE settlement per battle: running it twice cannot create a second.
  battle_id uuid not null unique references public.arena_battles (id),
  -- REWARDED: ≥ 1 correct picker was within their daily allowance and was paid. NO_CORRECT_PICKS: nobody was right — the pool
  -- returns to the reserve (no jackpot). ALL_CAPPED: people were right but every one had used their daily allowance — the pool
  -- returns. PAUSED: rewards off / out of daily budget (nothing offered; Points still awarded). VOID: the battle was void.
  status text not null check (status in ('REWARDED', 'NO_CORRECT_PICKS', 'ALL_CAPPED', 'PAUSED', 'VOID')),
  winner_character_id uuid references public.characters (id),
  token_decimals integer not null check (token_decimals between 0 and 36),
  -- The pool OFFERED for this battle (0 when PAUSED / VOID).
  reward_pool_raw numeric(78, 0) not null default 0 check (reward_pool_raw >= 0),
  picks_total integer not null default 0 check (picks_total >= 0),
  correct_picks integer not null default 0 check (correct_picks >= 0),
  -- ALL valid (eligible) correct pickers: the number the pool is divided by. Capped pickers still count here.
  correct_pickers integer not null default 0 check (correct_pickers >= 0),
  -- Of those, how many were within their daily allowance and actually received tokens.
  rewarded_pickers integer not null default 0 check (rewarded_pickers >= 0),
  -- pool ÷ correct_pickers, computed from ALL valid correct pickers FIRST; a capped picker's share is NOT redistributed.
  share_raw numeric(78, 0) not null default 0 check (share_raw >= 0),
  distributed_raw numeric(78, 0) not null default 0 check (distributed_raw >= 0),
  -- Unallocated: shares of capped pickers + the division remainder (+ the whole pool when nobody was paid). Back to the Arena reward reserve.
  returned_to_reserve_raw numeric(78, 0) not null default 0 check (returned_to_reserve_raw >= 0),
  points_awarded integer not null default 0 check (points_awarded >= 0),
  -- The reward configuration in force (reward per battle, cap, points…) — so the numbers can be audited later.
  config jsonb not null,
  settled_at timestamptz not null default now(),
  check (distributed_raw = share_raw * rewarded_pickers),
  check (reward_pool_raw = distributed_raw + returned_to_reserve_raw),
  check (rewarded_pickers <= correct_pickers and correct_pickers <= correct_picks and correct_picks <= picks_total),
  check (status <> 'REWARDED' or (rewarded_pickers >= 1 and share_raw > 0)),
  check (status <> 'NO_CORRECT_PICKS' or (correct_pickers = 0 and distributed_raw = 0)),
  check (status <> 'ALL_CAPPED' or (correct_pickers >= 1 and rewarded_pickers = 0 and distributed_raw = 0)),
  check (status not in ('PAUSED', 'VOID') or (reward_pool_raw = 0 and rewarded_pickers = 0)),
  check (status <> 'VOID' or (correct_pickers = 0 and points_awarded = 0))
);
create index arena_pick_settlements_settled_idx on public.arena_pick_settlements (settled_at desc);
create trigger arena_pick_settlements_append_only before update or delete on public.arena_pick_settlements
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 4. Claims: MANUAL payout requests (declared before the ledger that references them)
-- ---------------------------------------------------------------------------
create table public.arena_reward_claims (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  -- The amount comes from the member's ledger balance at request time — never from the browser, never editable by an admin.
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  -- Where THIS payout goes: frozen at request time. HOLDER_WALLET = the member's verified holder wallet; CUSTOM = an address
  -- they typed for this claim only (it never changes their holder wallet).
  destination_address text not null check (destination_address ~ '^0x[0-9a-f]{40}$'),
  destination_kind text not null check (destination_kind in ('HOLDER_WALLET', 'CUSTOM')),
  -- The token configuration the amount was accounted in (frozen), so the payout can always be verified against it.
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  token_decimals integer not null check (token_decimals between 0 and 36),
  -- PENDING: reserved, waiting for an admin to pay by hand. SENT: paid (transaction verified). DENIED: refused; reservation returned.
  status text not null default 'PENDING' check (status in ('PENDING', 'SENT', 'DENIED')),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  sent_at timestamptz,
  sent_by text,
  -- What the server read back from the chain when it verified the transfer (block, confirmations, the matched Transfer event).
  verification jsonb,
  denied_at timestamptz,
  denied_by text,
  denial_reason text check (denial_reason is null or denial_reason in ('INVALID_WALLET', 'SUSPICIOUS', 'NEEDS_REVIEW', 'OTHER')),
  denial_note text check (denial_note is null or char_length(denial_note) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (telegram_user_id, idempotency_key),
  check ((status = 'SENT') = (tx_hash is not null and sent_at is not null)),
  check ((status = 'DENIED') = (denied_at is not null and denial_reason is not null))
);
-- A transaction hash can back ONE claim, ever.
create unique index arena_reward_claims_tx_hash on public.arena_reward_claims (tx_hash) where tx_hash is not null;
-- ONE pending claim per member: the reserved units can never be claimed twice, whatever races.
create unique index arena_reward_claims_one_pending on public.arena_reward_claims (telegram_user_id) where status = 'PENDING';
create index arena_reward_claims_status_idx on public.arena_reward_claims (status, requested_at);
create index arena_reward_claims_user_idx on public.arena_reward_claims (telegram_user_id, requested_at desc);
create index arena_reward_claims_destination_idx on public.arena_reward_claims (destination_address);

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
  if new.telegram_user_id is distinct from old.telegram_user_id or new.amount_raw is distinct from old.amount_raw
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
create trigger arena_reward_claims_guard before insert or update on public.arena_reward_claims
  for each row execute function public.guard_arena_reward_claim();
create trigger arena_reward_claims_no_delete before delete on public.arena_reward_claims
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 5. The append-only reward ledger
-- ---------------------------------------------------------------------------
create table public.arena_reward_ledger (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  kind text not null check (kind in ('ARENA_PICK_REWARD', 'WEEKLY_LEADERBOARD_REWARD', 'CLAIM_RESERVED', 'CLAIM_SENT', 'CLAIM_RELEASED', 'ADMIN_ADJUSTMENT')),
  claimable_delta numeric(78, 0) not null,
  reserved_delta numeric(78, 0) not null default 0,
  claimed_delta numeric(78, 0) not null default 0,
  earned_delta numeric(78, 0) not null default 0,
  claimable_after numeric(78, 0) not null default 0 check (claimable_after >= 0),
  reserved_after numeric(78, 0) not null default 0 check (reserved_after >= 0),
  claimed_after numeric(78, 0) not null default 0 check (claimed_after >= 0),
  earned_after numeric(78, 0) not null default 0 check (earned_after >= 0),
  -- What a reward credit references: the battle, the settlement, what was picked, who won, the pool and the headcount.
  battle_id uuid references public.arena_battles (id),
  settlement_id uuid references public.arena_pick_settlements (id),
  picked_character_id uuid references public.characters (id),
  winning_character_id uuid references public.characters (id),
  reward_pool_raw numeric(78, 0),
  correct_pickers integer check (correct_pickers is null or correct_pickers >= 1),
  claim_id uuid references public.arena_reward_claims (id),
  -- WEEKLY_LEADERBOARD_REWARD: the Monday (UTC) of the finalized week it pays.
  week_start date,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- The sign rule of every kind. A row that breaks it cannot exist, whatever the application does.
  check (
       (kind = 'ARENA_PICK_REWARD' and claimable_delta > 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta
          and battle_id is not null and settlement_id is not null and picked_character_id is not null and winning_character_id is not null
          and reward_pool_raw is not null and correct_pickers is not null)
    or (kind = 'WEEKLY_LEADERBOARD_REWARD' and claimable_delta > 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta and week_start is not null)
    or (kind = 'CLAIM_RESERVED' and claimable_delta < 0 and reserved_delta = -claimable_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_SENT'     and claimable_delta = 0 and reserved_delta < 0 and claimed_delta = -reserved_delta and earned_delta = 0 and claim_id is not null)
    or (kind = 'CLAIM_RELEASED' and reserved_delta < 0 and claimable_delta = -reserved_delta and claimed_delta = 0 and earned_delta = 0 and claim_id is not null)
    or (kind = 'ADMIN_ADJUSTMENT' and claimable_delta <> 0 and reserved_delta = 0 and claimed_delta = 0 and earned_delta = claimable_delta)
  )
);
create index arena_reward_ledger_user_idx on public.arena_reward_ledger (telegram_user_id, id desc);
create index arena_reward_ledger_battle_idx on public.arena_reward_ledger (battle_id) where battle_id is not null;
-- At most ONE reward credit per member per battle.
create unique index arena_reward_ledger_one_credit on public.arena_reward_ledger (telegram_user_id, battle_id) where kind = 'ARENA_PICK_REWARD';
-- A member earns at most ONE prize per finalized week.
create unique index arena_reward_ledger_one_weekly_prize on public.arena_reward_ledger (telegram_user_id, week_start) where kind = 'WEEKLY_LEADERBOARD_REWARD';
-- A claim is reserved once and ends once (sent, or its reservation returned).
create unique index arena_reward_ledger_claim_once on public.arena_reward_ledger (claim_id, kind) where claim_id is not null;

-- BEFORE: lock the account row, compute the balances after this entry, reject anything that would go negative.
-- Safe with `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`: a skipped duplicate writes nothing durable.
create or replace function public.arena_reward_ledger_before_insert()
returns trigger
language plpgsql
as $$
declare
  cur record;
begin
  insert into public.arena_reward_accounts (telegram_user_id) values (new.telegram_user_id)
    on conflict (telegram_user_id) do nothing;
  select claimable, reserved, claimed_total, earned_total into cur from public.arena_reward_accounts
    where telegram_user_id = new.telegram_user_id for update;
  new.claimable_after := cur.claimable + new.claimable_delta;
  new.reserved_after := cur.reserved + new.reserved_delta;
  new.claimed_after := cur.claimed_total + new.claimed_delta;
  new.earned_after := cur.earned_total + new.earned_delta;
  if new.claimable_after < 0 then
    raise exception 'insufficient claimable balance' using errcode = '23514';
  end if;
  if new.reserved_after < 0 or new.claimed_after < 0 or new.earned_after < 0 then
    raise exception 'a reward balance cannot go negative' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger arena_reward_ledger_before_insert before insert on public.arena_reward_ledger
  for each row execute function public.arena_reward_ledger_before_insert();

-- AFTER: fires only for rows that were really inserted.
create or replace function public.arena_reward_ledger_after_insert()
returns trigger
language plpgsql
as $$
begin
  update public.arena_reward_accounts
     set claimable = new.claimable_after, reserved = new.reserved_after, claimed_total = new.claimed_after, earned_total = new.earned_after
   where telegram_user_id = new.telegram_user_id;
  return new;
end;
$$;
create trigger arena_reward_ledger_after_insert after insert on public.arena_reward_ledger
  for each row execute function public.arena_reward_ledger_after_insert();

create trigger arena_reward_ledger_append_only before update or delete on public.arena_reward_ledger
  for each row execute function public.forbid_mutation();

-- Integrity check: every account must equal the sum of its ledger rows. Any row returned is a violation.
create or replace function public.audit_arena_reward_accounts()
returns table (telegram_user_id bigint, claimable numeric, reserved numeric, claimed_total numeric, earned_total numeric,
               ledger_claimable numeric, ledger_reserved numeric, ledger_claimed numeric, ledger_earned numeric)
language sql
stable
as $$
  select a.telegram_user_id, a.claimable, a.reserved, a.claimed_total, a.earned_total,
         coalesce(sum(l.claimable_delta), 0), coalesce(sum(l.reserved_delta), 0), coalesce(sum(l.claimed_delta), 0), coalesce(sum(l.earned_delta), 0)
    from public.arena_reward_accounts a
    left join public.arena_reward_ledger l on l.telegram_user_id = a.telegram_user_id
   group by a.telegram_user_id, a.claimable, a.reserved, a.claimed_total, a.earned_total
  having a.claimable <> coalesce(sum(l.claimable_delta), 0) or a.reserved <> coalesce(sum(l.reserved_delta), 0)
      or a.claimed_total <> coalesce(sum(l.claimed_delta), 0) or a.earned_total <> coalesce(sum(l.earned_delta), 0)
$$;

-- ---------------------------------------------------------------------------
-- 6. Per-pick settlement outcomes (append-only) — and the DAILY ALLOWANCE guard
-- ---------------------------------------------------------------------------
-- One row per CORRECT, eligible picker per battle: what the pool was, how many shared it, the base share, the tier and daily
-- allowance, how many rewarded wins that UTC day were already used, and what was actually issued. The daily counter is NOT a
-- mutable number: "rewarded wins used" is the COUNT of REWARDED rows of that UTC day, so it cannot drift or be edited.
create table public.arena_pick_outcomes (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  battle_id uuid not null references public.arena_battles (id),
  settlement_id uuid not null references public.arena_pick_settlements (id),
  picked_character_id uuid not null references public.characters (id),
  winning_character_id uuid not null references public.characters (id),
  reward_pool_raw numeric(78, 0) not null check (reward_pool_raw >= 0),
  correct_pickers integer not null check (correct_pickers >= 1),
  base_share_raw numeric(78, 0) not null check (base_share_raw >= 0),
  tier_index integer not null check (tier_index >= 0),
  daily_allowance integer not null check (daily_allowance >= 1),
  -- Overwritten by the guard trigger with the authoritative count (the caller cannot lie about it).
  daily_wins_before integer not null default 0 check (daily_wins_before >= 0),
  utc_date date not null,
  token_reward_raw numeric(78, 0) not null default 0 check (token_reward_raw >= 0),
  -- The part of the base share this picker did NOT receive (capped / paused): it returns to the reserve, it is NOT redistributed.
  unused_raw numeric(78, 0) not null default 0 check (unused_raw >= 0),
  points_awarded integer not null default 0 check (points_awarded >= 0),
  outcome text not null check (outcome in ('REWARDED', 'DAILY_CAP', 'POOL_PAUSED')),
  created_at timestamptz not null default now(),
  -- ONE outcome per member per battle (the idempotency anchor of per-member settlement).
  unique (telegram_user_id, battle_id),
  check (token_reward_raw + unused_raw = base_share_raw),
  check ((outcome = 'REWARDED') = (token_reward_raw > 0))
);
create index arena_pick_outcomes_day_idx on public.arena_pick_outcomes (telegram_user_id, utc_date) where outcome = 'REWARDED';
create index arena_pick_outcomes_battle_idx on public.arena_pick_outcomes (battle_id);
create trigger arena_pick_outcomes_append_only before update or delete on public.arena_pick_outcomes
  for each row execute function public.forbid_mutation();

-- THE DAILY ALLOWANCE GUARD. Serialises on the member's account row, counts that UTC day's REWARDED outcomes, stamps the
-- authoritative `daily_wins_before`, and REFUSES a rewarded win beyond the allowance — whatever the application does.
create or replace function public.guard_arena_pick_outcome()
returns trigger
language plpgsql
as $$
declare
  used integer;
begin
  insert into public.arena_reward_accounts (telegram_user_id) values (new.telegram_user_id) on conflict (telegram_user_id) do nothing;
  perform 1 from public.arena_reward_accounts where telegram_user_id = new.telegram_user_id for update;
  select count(*)::int into used from public.arena_pick_outcomes
   where telegram_user_id = new.telegram_user_id and utc_date = new.utc_date and outcome = 'REWARDED';
  new.daily_wins_before := used;
  if new.outcome = 'REWARDED' and used >= new.daily_allowance then
    raise exception 'the daily rewarded-win allowance is used up' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger arena_pick_outcomes_guard before insert on public.arena_pick_outcomes
  for each row execute function public.guard_arena_pick_outcome();

-- ---------------------------------------------------------------------------
-- 7. CLANK POINTS: an append-only, source-agnostic ledger (weekly boards, events, quests, cosmetics can all build on it)
-- ---------------------------------------------------------------------------
create table public.arena_points_ledger (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  -- ARENA_PICK_CORRECT today; EVENT / QUEST / ADMIN_ADJUSTMENT are reserved for later (and never multiplied by holdings).
  kind text not null check (kind in ('ARENA_PICK_CORRECT', 'EVENT', 'QUEST', 'ADMIN_ADJUSTMENT')),
  points integer not null check (points <> 0),
  battle_id uuid references public.arena_battles (id),
  settlement_id uuid references public.arena_pick_settlements (id),
  -- Free-form reference for non-arena sources (an event / quest id).
  source_ref text,
  -- The Monday (UTC) of the week this was earned in — the weekly leaderboard groups by it; lifetime ignores it.
  week_start date not null,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (kind = 'ADMIN_ADJUSTMENT' or points > 0),
  check (kind <> 'ARENA_PICK_CORRECT' or (battle_id is not null and settlement_id is not null))
);
create index arena_points_ledger_week_idx on public.arena_points_ledger (week_start, telegram_user_id);
create index arena_points_ledger_user_idx on public.arena_points_ledger (telegram_user_id, id desc);
-- A pick is worth Points ONCE: a settlement retry cannot award them twice.
create unique index arena_points_ledger_one_per_pick on public.arena_points_ledger (telegram_user_id, battle_id) where kind = 'ARENA_PICK_CORRECT';
create trigger arena_points_ledger_append_only before update or delete on public.arena_points_ledger
  for each row execute function public.forbid_mutation();

-- ---------------------------------------------------------------------------
-- 7b. WEEKLY ARENA PICKS: per-pick scoring, and finalized (frozen) weeks with their prizes
-- ---------------------------------------------------------------------------
-- One row per VALID settled pick (correct or not). Only a member's first `daily_limit` valid picks of a UTC day are SCORED —
-- the others still count for lifetime stats, streaks and token eligibility but add nothing to the weekly board. Holder tiers
-- never change `daily_limit` or the points per correct pick.
create table public.arena_weekly_pick_scores (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  battle_id uuid not null references public.arena_battles (id),
  settlement_id uuid not null references public.arena_pick_settlements (id),
  -- The Monday (UTC) of the week the battle settled in, and its UTC day.
  week_start date not null,
  utc_date date not null,
  correct boolean not null,
  -- Counted toward the weekly score (within the day's limit). Enforced by the guard trigger below.
  scored boolean not null,
  -- 1.. for scored picks (stamped by the trigger from the authoritative count), null otherwise.
  scored_index integer check (scored_index is null or scored_index >= 1),
  daily_limit integer not null check (daily_limit >= 1),
  weekly_points integer not null default 0 check (weekly_points >= 0),
  created_at timestamptz not null default now(),
  -- ONE weekly score row per pick: a settlement retry can never score it twice.
  unique (telegram_user_id, battle_id),
  check (scored or weekly_points = 0),
  check (weekly_points = 0 or correct),
  check (scored = (scored_index is not null))
);
create index arena_weekly_pick_scores_week_idx on public.arena_weekly_pick_scores (week_start, telegram_user_id);
create index arena_weekly_pick_scores_day_idx on public.arena_weekly_pick_scores (telegram_user_id, utc_date) where scored;
create trigger arena_weekly_pick_scores_append_only before update or delete on public.arena_weekly_pick_scores
  for each row execute function public.forbid_mutation();

-- THE WEEKLY SCORING GUARD. Serialises on the member's account row, counts that UTC day's scored picks, stamps the
-- authoritative `scored_index` and REFUSES a scored pick beyond the day's limit — and any scored pick of a week already finalized.
-- (Declared after arena_weeks below.)

-- A FINALIZED week: one immutable row per week plus one immutable row per participant (rank, scores, accuracy, prize).
create table public.arena_weeks (
  week_start date primary key check (extract(isodow from week_start) = 1),
  -- The configuration the week was finalized under (frozen).
  token_decimals integer not null check (token_decimals between 0 and 36),
  prize_pool_raw numeric(78, 0) not null check (prize_pool_raw >= 0),
  prize_split_bps jsonb not null,
  scored_picks_per_day integer not null check (scored_picks_per_day >= 1),
  minimum_scored_picks integer not null check (minimum_scored_picks >= 0),
  points_per_correct_pick integer not null check (points_per_correct_pick >= 0),
  participants integer not null check (participants >= 0),
  eligible_participants integer not null check (eligible_participants >= 0),
  -- Awarded to prize positions (credited to claimable or held for review) + returned to the reserve = the pool.
  prizes_awarded_raw numeric(78, 0) not null default 0 check (prizes_awarded_raw >= 0),
  returned_to_reserve_raw numeric(78, 0) not null default 0 check (returned_to_reserve_raw >= 0),
  finalized_at timestamptz not null default now(),
  check (prizes_awarded_raw + returned_to_reserve_raw = prize_pool_raw),
  check (eligible_participants <= participants)
);
create trigger arena_weeks_append_only before update or delete on public.arena_weeks
  for each row execute function public.forbid_mutation();

create or replace function public.guard_arena_weekly_pick_score()
returns trigger
language plpgsql
as $$
declare
  used integer;
begin
  -- A finalized week never changes: a (very late) pick of that week may be recorded as UNSCORED, never scored.
  if new.scored and exists (select 1 from public.arena_weeks w where w.week_start = new.week_start) then
    raise exception 'this week is already finalized' using errcode = '23514';
  end if;
  insert into public.arena_reward_accounts (telegram_user_id) values (new.telegram_user_id) on conflict (telegram_user_id) do nothing;
  perform 1 from public.arena_reward_accounts where telegram_user_id = new.telegram_user_id for update;
  select count(*)::int into used from public.arena_weekly_pick_scores
   where telegram_user_id = new.telegram_user_id and utc_date = new.utc_date and scored;
  if new.scored then
    if used >= new.daily_limit then
      raise exception 'the weekly scoring limit for this UTC day is used up' using errcode = '23514';
    end if;
    new.scored_index := used + 1;
  else
    new.scored_index := null;
  end if;
  return new;
end;
$$;
create trigger arena_weekly_pick_scores_guard before insert on public.arena_weekly_pick_scores
  for each row execute function public.guard_arena_weekly_pick_score();

create table public.arena_week_results (
  week_start date not null references public.arena_weeks (week_start),
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  -- The hero as it was when the week was frozen (a later rename never rewrites history).
  character_id uuid references public.characters (id),
  hero_name text not null,
  class_id text not null,
  rank integer not null check (rank >= 1),
  weekly_points integer not null check (weekly_points >= 0),
  scored_picks integer not null check (scored_picks >= 0),
  correct_picks integer not null check (correct_picks >= 0),
  -- Accuracy across SCORED picks, in basis points (floored).
  accuracy_bps integer not null check (accuracy_bps between 0 and 10000),
  current_streak integer not null default 0 check (current_streak >= 0),
  best_streak integer not null default 0 check (best_streak >= 0),
  prize_eligible boolean not null,
  -- Position among prize-eligible members (ties share a position).
  prize_rank integer check (prize_rank is null or prize_rank >= 1),
  prize_raw numeric(78, 0) not null default 0 check (prize_raw >= 0),
  -- NONE = no prize. CREDITED = added to claimable. HELD = a prize position, but the account was under review: nothing is
  -- credited until an admin resolves it (release → CREDITED, forfeit → FORFEITED and the amount returns to the reserve).
  prize_status text not null default 'NONE' check (prize_status in ('NONE', 'CREDITED', 'HELD', 'FORFEITED')),
  hold_reason text,
  resolved_at timestamptz,
  resolved_by text,
  resolution_reason text,
  created_at timestamptz not null default now(),
  primary key (week_start, telegram_user_id),
  check ((prize_status = 'NONE') = (prize_raw = 0)),
  check (prize_eligible or prize_raw = 0),
  check (correct_picks <= scored_picks)
);
create index arena_week_results_rank_idx on public.arena_week_results (week_start, rank);
create index arena_week_results_held_idx on public.arena_week_results (prize_status) where prize_status = 'HELD';

-- History never changes silently: a result row is frozen, EXCEPT that a HELD prize may be resolved once by an admin.
create or replace function public.guard_arena_week_result()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'finalized weekly results cannot be deleted' using errcode = '23000';
  end if;
  if old.prize_status = 'HELD' and new.prize_status in ('CREDITED', 'FORFEITED')
     and row(new.week_start, new.telegram_user_id, new.character_id, new.hero_name, new.class_id, new.rank, new.weekly_points, new.scored_picks,
             new.correct_picks, new.accuracy_bps, new.current_streak, new.best_streak, new.prize_eligible, new.prize_rank, new.prize_raw, new.hold_reason)
         is not distinct from
         row(old.week_start, old.telegram_user_id, old.character_id, old.hero_name, old.class_id, old.rank, old.weekly_points, old.scored_picks,
             old.correct_picks, old.accuracy_bps, old.current_streak, old.best_streak, old.prize_eligible, old.prize_rank, old.prize_raw, old.hold_reason)
     and new.resolved_at is not null and new.resolved_by is not null and new.resolution_reason is not null then
    return new;
  end if;
  raise exception 'finalized weekly results are frozen' using errcode = '23000';
end;
$$;
create trigger arena_week_results_guard before update or delete on public.arena_week_results
  for each row execute function public.guard_arena_week_result();

-- A weekly prize credit must reference a real, CREDITED prize of that member's finalized week.
alter table public.arena_reward_ledger
  add constraint arena_reward_ledger_weekly_prize_fk foreign key (week_start, telegram_user_id)
  references public.arena_week_results (week_start, telegram_user_id);

-- ---------------------------------------------------------------------------
-- 8. Holder verification: wallet challenges, holder tier status and its audit trail
-- ---------------------------------------------------------------------------
-- A server-issued, single-use, expiring challenge the member signs (personal_sign) to PROVE they control the wallet.
create table public.arena_wallet_challenges (
  nonce text primary key check (char_length(nonce) >= 16),
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id) on delete cascade,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index arena_wallet_challenges_user_idx on public.arena_wallet_challenges (telegram_user_id, created_at desc);

-- The verified holder state of an account. Tier ACTIVE = what the allowance uses; CANDIDATE = a higher tier the wallet has been
-- holding toward (activates only after `holderTierActivationHours` of continuous holding — anti token-hopping).
create table public.arena_holder_status (
  telegram_user_id bigint primary key references public.telegram_users (telegram_user_id) on delete cascade,
  wallet_address text not null check (wallet_address ~ '^0x[0-9a-f]{40}$'),
  verified_balance_raw numeric(78, 0) not null default 0 check (verified_balance_raw >= 0),
  balance_verified_at timestamptz,
  active_tier_index integer not null default 0 check (active_tier_index >= 0),
  -- Denormalised at activation so the lock-time snapshot (a database trigger) needs no settings lookup.
  active_allowance integer check (active_allowance is null or active_allowance >= 1),
  active_since timestamptz,
  -- The active tier only counts while its verification is FRESH; after this instant the member is FREE until re-verified.
  effective_until timestamptz,
  candidate_tier_index integer check (candidate_tier_index is null or candidate_tier_index >= 1),
  candidate_since timestamptz,
  last_observed_at timestamptz,
  last_check_at timestamptz,
  last_error text,
  -- Background verification schedule: the 1-minute tick re-reads only wallets whose next_check_at is due (a bounded batch,
  -- ~30 min apart with jitter). Failures back off and are counted; a success resets the count.
  next_check_at timestamptz not null default now(),
  check_failures integer not null default 0 check (check_failures >= 0),
  -- The member's own "Refresh holdings" clicks are rate-limited separately from background checks.
  last_manual_refresh_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((candidate_tier_index is null) = (candidate_since is null)),
  check ((active_tier_index = 0) = (active_allowance is null))
);
create index arena_holder_status_refresh_idx on public.arena_holder_status (next_check_at);

create table public.arena_holder_tier_history (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  kind text not null check (kind in ('UPGRADED', 'DOWNGRADED', 'CANDIDATE_STARTED', 'CANDIDATE_CANCELLED', 'WALLET_CHANGED')),
  from_index integer,
  to_index integer,
  balance_raw numeric(78, 0),
  wallet_address text,
  created_at timestamptz not null default now()
);
create index arena_holder_tier_history_user_idx on public.arena_holder_tier_history (telegram_user_id, id desc);
create trigger arena_holder_tier_history_append_only before update or delete on public.arena_holder_tier_history
  for each row execute function public.forbid_mutation();

-- A holder's tier belongs to ONE wallet: changing the holder wallet drops it (the new wallet must verify and qualify again).
create or replace function public.reset_holder_on_wallet_change()
returns trigger
language plpgsql
as $$
begin
  delete from public.arena_holder_status where telegram_user_id = new.telegram_user_id;
  insert into public.arena_holder_tier_history (telegram_user_id, kind, wallet_address) values (new.telegram_user_id, 'WALLET_CHANGED', new.holder_wallet_address);
  return new;
end;
$$;
create trigger arena_reward_accounts_wallet_change after update of holder_wallet_address on public.arena_reward_accounts
  for each row when (old.holder_wallet_address is distinct from new.holder_wallet_address)
  execute function public.reset_holder_on_wallet_change();

-- At the instant a pick LOCKS (the arena stamps `locked_at`), freeze what decides its token eligibility: the member's EFFECTIVE
-- holder tier, daily allowance and the rewarded wins already used that UTC day. A tier change after the lock cannot alter it.
create or replace function public.snapshot_pick_tier()
returns trigger
language plpgsql
as $$
declare
  h record;
  fresh boolean;
  used integer;
  day date := (new.locked_at at time zone 'utc')::date;
begin
  select active_tier_index, active_allowance, effective_until into h from public.arena_holder_status where telegram_user_id = new.telegram_user_id;
  fresh := found and h.active_tier_index > 0 and h.effective_until is not null and h.effective_until > new.locked_at;
  select count(*)::int into used from public.arena_pick_outcomes where telegram_user_id = new.telegram_user_id and utc_date = day and outcome = 'REWARDED';
  new.tier_snapshot := jsonb_build_object(
    'tierIndex', case when fresh then h.active_tier_index else 0 end,
    'allowance', case when fresh then h.active_allowance else null end, -- null = the FREE tier's allowance (a setting, applied by the settlement)
    'usedBefore', used,
    'day', day,
    'capturedAt', new.locked_at
  );
  return new;
end;
$$;
create trigger arena_picks_lock_snapshot before update of locked_at on public.arena_picks
  for each row when (old.locked_at is null and new.locked_at is not null)
  execute function public.snapshot_pick_tier();

select public.clank_harden_schema();
