-- Clank RPG — Robinhood Chain / Clank.trade: eligible (bonded) tokens, holdings,
-- Diamond Hands streaks, trading activity, and boss drafts.
-- Only tokens with status ELIGIBLE count toward any RPG bonus.

create table public.eligible_tokens (
  id uuid primary key default gen_random_uuid(),
  chain_id integer not null,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  symbol text not null check (char_length(symbol) between 1 and 40),
  name text not null default '',
  image_url text,
  quote_currency text,
  quote_symbol text,
  status text not null default 'CANDIDATE' check (status in ('CANDIDATE', 'ELIGIBLE', 'REJECTED', 'DELISTED')),
  bonded_observed boolean not null default false,
  bonded_observed_at timestamptz,
  catalog_state integer,
  catalog_progress numeric(7, 3),
  total_supply numeric(78, 0),
  decimals integer not null default 18 check (decimals between 0 and 36),
  price_quote numeric(38, 18),
  price_observed_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, address),
  check (status <> 'ELIGIBLE' or approved_at is not null or bonded_observed)
);
create index eligible_tokens_status_idx on public.eligible_tokens (status);
create trigger eligible_tokens_updated_at before update on public.eligible_tokens
  for each row execute function public.set_updated_at();

-- Latest verified balance snapshot per (character, token).
create table public.token_holdings (
  character_id uuid not null references public.characters (id) on delete cascade,
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  balance numeric(78, 0) not null check (balance >= 0),
  supply_fraction numeric(20, 18) not null default 0 check (supply_fraction >= 0),
  value_quote numeric(38, 18),
  observed_at timestamptz not null default now(),
  primary key (character_id, token_id)
);

-- Diamond Hands: a streak is measured from the first snapshot WE observed. History
-- before that is unknown unless an indexer back-fills it (history_indexed).
create table public.holding_streaks (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  started_at timestamptz not null,
  peak_balance numeric(78, 0) not null check (peak_balance > 0),
  last_verified_at timestamptz not null,
  ended_at timestamptz,
  end_reason text check (end_reason in ('SOLD_DOWN', 'WALLET_UNLINKED', 'TOKEN_DELISTED')),
  history_indexed boolean not null default false,
  check (ended_at is null or ended_at >= started_at)
);
create unique index holding_streaks_one_open on public.holding_streaks (character_id, token_id) where ended_at is null;
create index holding_streaks_character_idx on public.holding_streaks (character_id);

create table public.holding_milestones (
  streak_id uuid not null references public.holding_streaks (id) on delete cascade,
  days integer not null check (days > 0),
  character_id uuid not null references public.characters (id) on delete cascade,
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  achieved_at timestamptz not null default now(),
  primary key (streak_id, days)
);
create index holding_milestones_character_idx on public.holding_milestones (character_id);

-- Trading activity rollups keyed by trader wallet (independent of RPG accounts).
create table public.trade_stats (
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  trader_address text not null check (trader_address ~ '^0x[0-9a-f]{40}$'),
  trade_count integer not null default 0 check (trade_count >= 0),
  volume_quote numeric(38, 0) not null default 0 check (volume_quote >= 0),
  first_trade_at timestamptz,
  last_trade_at timestamptz,
  primary key (token_id, trader_address)
);
create table public.trade_activity_days (
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  trader_address text not null check (trader_address ~ '^0x[0-9a-f]{40}$'),
  day date not null,
  primary key (token_id, trader_address, day)
);
create table public.trade_events_seen (
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  event_id text not null,
  seen_at timestamptz not null default now(),
  primary key (token_id, event_id)
);

-- Bonded coins can become bosses. The system may prepare DRAFTS only; going live
-- requires explicit admin approval (enforced here, not just in application code).
create table public.boss_drafts (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.eligible_tokens (id) on delete cascade,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'APPROVED', 'LIVE', 'REJECTED')),
  identity jsonb not null default '{}'::jsonb,
  stats jsonb not null default '{}'::jsonb,
  abilities jsonb not null default '[]'::jsonb,
  lore text not null default '',
  loot jsonb not null default '[]'::jsonb,
  generated_by text not null default 'SYSTEM',
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status not in ('APPROVED', 'LIVE') or (approved_by is not null and approved_at is not null))
);
create unique index boss_drafts_one_per_token on public.boss_drafts (token_id) where status in ('DRAFT', 'APPROVED', 'LIVE');
create trigger boss_drafts_updated_at before update on public.boss_drafts
  for each row execute function public.set_updated_at();

create or replace function public.guard_boss_draft_transition()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' and new.status <> 'DRAFT' then
    raise exception 'boss drafts must be created as DRAFT' using errcode = '23000';
  end if;
  if tg_op = 'UPDATE' and new.status in ('APPROVED', 'LIVE') and old.status = 'DRAFT'
     and (new.approved_by is null or new.approved_by = 'SYSTEM') then
    raise exception 'a boss draft requires explicit admin approval' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger boss_drafts_guard before insert or update on public.boss_drafts
  for each row execute function public.guard_boss_draft_transition();
