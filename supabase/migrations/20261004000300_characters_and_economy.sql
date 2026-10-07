-- Clank RPG — characters, appearance, claims, wallet links, Clank Gold, inventory, achievements.

-- ---------------------------------------------------------------------------
-- Characters
-- ---------------------------------------------------------------------------

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'COMMUNITY' check (kind in ('COMMUNITY', 'SPECIAL_CHARACTER')),
  telegram_user_id bigint unique references public.telegram_users (telegram_user_id),
  class_id text not null references public.character_classes (id),
  name text not null check (char_length(name) between 1 and 40),
  name_override text check (name_override is null or char_length(name_override) between 1 and 40),
  level integer not null default 1 check (level between 1 and 500),
  xp bigint not null default 0 check (xp >= 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'INACTIVE', 'SUSPENDED')),
  origin text not null check (origin in ('TELEGRAM', 'HISTORICAL_IMPORT', 'ADMIN', 'DEV_SEED')),
  is_demo boolean not null default false,
  tactic text not null default 'BALANCED' check (tactic in ('AGGRESSIVE', 'BALANCED', 'DEFENSIVE')),
  title text check (title is null or char_length(title) <= 60),
  power integer not null default 0 check (power >= 0),
  arena_battles integer not null default 0 check (arena_battles >= 0),
  arena_wins integer not null default 0 check (arena_wins >= 0),
  arena_top2 integer not null default 0 check (arena_top2 >= 0),
  arena_eliminations integer not null default 0 check (arena_eliminations >= 0),
  arena_damage bigint not null default 0 check (arena_damage >= 0),
  last_arena_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'COMMUNITY' or telegram_user_id is not null),
  check (is_demo = (origin = 'DEV_SEED'))
);
create index characters_wins_idx on public.characters (arena_wins desc, arena_top2 desc) where status = 'ACTIVE';
create index characters_level_idx on public.characters (level desc, xp desc) where status = 'ACTIVE';
create index characters_power_idx on public.characters (power desc) where status = 'ACTIVE';
create index characters_name_idx on public.characters (lower(name));
create index characters_status_idx on public.characters (status, is_demo);
create trigger characters_updated_at before update on public.characters
  for each row execute function public.set_updated_at();

-- The originally generated class is PERMANENT. Only an audited admin operation that
-- sets the transaction-local flag `clank.allow_class_change` may change it.
create or replace function public.guard_character_class()
returns trigger
language plpgsql
as $$
begin
  if new.class_id is distinct from old.class_id
     and coalesce(current_setting('clank.allow_class_change', true), '') <> 'on' then
    raise exception 'character class is permanent' using errcode = '23000';
  end if;
  if new.telegram_user_id is distinct from old.telegram_user_id then
    raise exception 'character identity is immutable' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger characters_guard_class before update on public.characters
  for each row execute function public.guard_character_class();

-- Permanent per-character stat inputs. Effective stats are computed server-side from
-- class + level + these components + equipped gear; they are never client-writable.
create table public.character_stats (
  character_id uuid primary key references public.characters (id) on delete cascade,
  variation jsonb not null,
  telegram_bonus jsonb not null default '{}'::jsonb,
  holdings_bonus jsonb not null default '{}'::jsonb,
  loyalty_bonus jsonb not null default '{}'::jsonb,
  trading_bonus jsonb not null default '{}'::jsonb,
  holding_power real not null default 0,
  fixed_stats jsonb,
  updated_at timestamptz not null default now()
);
create trigger character_stats_updated_at before update on public.character_stats
  for each row execute function public.set_updated_at();

-- Procedural appearance. Rarity is COSMETIC ONLY and has no combat effect.
create table public.character_appearances (
  character_id uuid primary key references public.characters (id) on delete cascade,
  rarity text not null check (rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  parts jsonb not null,
  seed text not null,
  updated_at timestamptz not null default now()
);
create trigger character_appearances_updated_at before update on public.character_appearances
  for each row execute function public.set_updated_at();

-- Manually authored team/staff characters (identity decided later by admins).
create table public.special_character_profiles (
  character_id uuid primary key references public.characters (id) on delete cascade,
  role text not null default '',
  bio text not null default '',
  fixed_abilities jsonb not null default '[]'::jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Claiming (proof of the SAME immutable Telegram id) and wallet links
-- ---------------------------------------------------------------------------

create table public.character_claims (
  character_id uuid primary key references public.characters (id) on delete cascade,
  telegram_user_id bigint not null unique references public.telegram_users (telegram_user_id),
  claimed_at timestamptz not null default now(),
  auth_date timestamptz not null
);

create table public.wallet_challenges (
  nonce text primary key check (char_length(nonce) >= 16),
  character_id uuid not null references public.characters (id) on delete cascade,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index wallet_challenges_character_idx on public.wallet_challenges (character_id, created_at desc);

create table public.wallet_links (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  address text not null check (address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz
);
-- A wallet can back at most one character, and a character has at most one active wallet.
create unique index wallet_links_active_address on public.wallet_links (address) where unlinked_at is null;
create unique index wallet_links_active_character on public.wallet_links (character_id) where unlinked_at is null;

-- ---------------------------------------------------------------------------
-- Clank Gold (off-chain currency). Ledger is the source of truth; balances are
-- maintained by triggers so there is exactly one mutation path.
-- ---------------------------------------------------------------------------

create table public.currency_accounts (
  character_id uuid primary key references public.characters (id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  lifetime_earned bigint not null default 0 check (lifetime_earned >= 0),
  updated_at timestamptz not null default now()
);

create table public.currency_ledger (
  id bigint generated always as identity primary key,
  character_id uuid not null references public.characters (id) on delete restrict,
  delta bigint not null check (delta <> 0),
  reason text not null check (char_length(reason) between 1 and 80),
  ref_type text,
  ref_id text,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  balance_after bigint not null default 0 check (balance_after >= 0),
  created_at timestamptz not null default now()
);
create index currency_ledger_character_idx on public.currency_ledger (character_id, id desc);

-- BEFORE: lock the account, compute balance_after, reject overdrafts. Safe with
-- `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING` because it writes nothing durable.
create or replace function public.currency_ledger_before_insert()
returns trigger
language plpgsql
as $$
declare
  current_balance bigint;
begin
  insert into public.currency_accounts (character_id) values (new.character_id)
    on conflict (character_id) do nothing;
  select balance into current_balance from public.currency_accounts
    where character_id = new.character_id for update;
  new.balance_after := current_balance + new.delta;
  if new.balance_after < 0 then
    raise exception 'insufficient Clank Gold' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger currency_ledger_before_insert before insert on public.currency_ledger
  for each row execute function public.currency_ledger_before_insert();

-- AFTER: only fires for rows that were actually inserted (never for skipped duplicates).
create or replace function public.currency_ledger_after_insert()
returns trigger
language plpgsql
as $$
begin
  update public.currency_accounts
     set balance = balance + new.delta,
         lifetime_earned = lifetime_earned + greatest(new.delta, 0),
         updated_at = now()
   where character_id = new.character_id;
  return new;
end;
$$;
create trigger currency_ledger_after_insert after insert on public.currency_ledger
  for each row execute function public.currency_ledger_after_insert();

create trigger currency_ledger_append_only before update or delete on public.currency_ledger
  for each row execute function public.forbid_mutation();

-- Integrity check: every account balance must equal the sum of its ledger rows.
create or replace function public.audit_currency_ledger()
returns table (character_id uuid, balance bigint, ledger_sum bigint)
language sql
stable
as $$
  select a.character_id, a.balance, coalesce(sum(l.delta), 0)::bigint
    from public.currency_accounts a
    left join public.currency_ledger l on l.character_id = a.character_id
   group by a.character_id, a.balance
  having a.balance <> coalesce(sum(l.delta), 0)
$$;

-- ---------------------------------------------------------------------------
-- Items + inventory
-- ---------------------------------------------------------------------------

create table public.item_templates (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,50}$'),
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '',
  slot text not null check (slot in ('WEAPON', 'ARMOR', 'TRINKET')),
  rarity text not null check (rarity in ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  class_restriction jsonb,
  min_level integer not null default 1 check (min_level >= 1),
  stat_mods jsonb not null default '{}'::jsonb,
  look jsonb not null default '{}'::jsonb,
  source_tag text not null default 'ARENA_DROP',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  character_id uuid not null references public.characters (id) on delete cascade,
  template_id text not null references public.item_templates (id),
  slot text not null check (slot in ('WEAPON', 'ARMOR', 'TRINKET')),
  equipped boolean not null default false,
  acquired_via text not null default 'ARENA_DROP',
  source_ref text,
  acquired_at timestamptz not null default now()
);
create index inventory_items_character_idx on public.inventory_items (character_id);
-- Drops are idempotent per source (e.g. one drop per battle per character).
create unique index inventory_items_source_ref on public.inventory_items (character_id, source_ref) where source_ref is not null;
-- Exactly one equipped item per slot.
create unique index inventory_items_one_equipped_per_slot on public.inventory_items (character_id, slot) where equipped;

create or replace function public.inventory_items_copy_slot()
returns trigger
language plpgsql
as $$
declare
  template_slot text;
begin
  select slot into template_slot from public.item_templates where id = new.template_id;
  if template_slot is null then
    raise exception 'unknown item template %', new.template_id using errcode = '23503';
  end if;
  new.slot := template_slot;
  return new;
end;
$$;
create trigger inventory_items_copy_slot before insert on public.inventory_items
  for each row execute function public.inventory_items_copy_slot();

-- ---------------------------------------------------------------------------
-- Achievements
-- ---------------------------------------------------------------------------

create table public.achievements (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,50}$'),
  name text not null check (char_length(name) between 1 and 60),
  description text not null default '',
  category text not null default 'GENERAL',
  criteria jsonb not null,
  reward jsonb not null default '{}'::jsonb,
  hidden boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

create table public.character_achievements (
  character_id uuid not null references public.characters (id) on delete cascade,
  achievement_id text not null references public.achievements (id),
  unlocked_at timestamptz not null default now(),
  context jsonb not null default '{}'::jsonb,
  primary key (character_id, achievement_id)
);
create index character_achievements_recent_idx on public.character_achievements (unlocked_at desc);
