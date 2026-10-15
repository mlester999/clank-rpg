-- Clank RPG — PAID HERO REROLL: persistence and database-level guarantees (migration 3000).
--
-- A member who has used today's free reroll can PAY $CLANKRPG for another (docs/HERO_PAID_REROLL.md). The payment is an ordinary ERC-20 transfer to the reward treasury that
-- the member's wallet signs; the server never holds a key — it READS the chain, verifies that the transfer really paid the price, and only then lets the reroll happen. The
-- reroll itself is the existing hero-version machinery, exactly like the free one: it APPENDS a `hero_versions` row (action 'REROLL', created_by 'member-paid:<telegram id>')
-- and moves the hero's pointer + projection in one transaction. Nothing about the version model, the class guard, the projection triggers or any historical row changes.
--
-- What this migration adds is only the PAYMENT RECORD and the rules that make it impossible to cheat at the database level:
--
--   hero_paid_rerolls   one row per VERIFIED on-chain payment, keyed by its transaction hash (UNIQUE: one payment buys one reroll, whatever the application does — replays,
--                       two tabs, two members submitting the same hash). The row is born PAID (a credit that is safely recorded even if the Arena has the hero locked
--                       right now) and moves exactly once to APPLIED, naming the version it created, the version it replaced and the before/after class · rarity · PWR.
--   guards              a row can only describe a REAL payment by the hero's own member; PAID → APPLIED is the only transition and changes nothing but the apply columns;
--                       the version it names must be a REROLL made by `member-paid:<id>`, the direct successor of the one it replaced, with matching key and figures.
--   a deferred check    the other direction — a version made by a PAID reroll cannot commit without its APPLIED payment row. A paid reroll that is not recorded cannot
--                       exist, and a payment cannot be consumed without a reroll: they commit together or not at all. (The free reroll's own check only looks at
--                       'member:%' versions, so the two programmes never interfere.)
--   audit_hero_paid_rerolls()   every row it returns is a violation (must return none).
--
-- No existing row is read, rewritten or deleted. The feature itself is OFF until the feature flag `hero.paid_reroll` is switched on in the Admin console (the flag is seeded
-- disabled; a missing flag also means disabled) AND the token is configured (CLANKRPG_TOKEN_ADDRESS + CLANKRPG_REWARD_TREASURY_ADDRESS) — until then the status is simply "not open".

create table public.hero_paid_rerolls (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id),
  character_id uuid not null references public.characters (id) on delete cascade,
  -- THE PAYMENT, as the chain reported it when the server verified it (lower-case hex).
  tx_hash text not null check (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payer_address text not null check (payer_address ~ '^0x[0-9a-f]{40}$'),
  recipient_address text not null check (recipient_address ~ '^0x[0-9a-f]{40}$'),
  token_address text not null check (token_address ~ '^0x[0-9a-f]{40}$'),
  chain_id integer not null,
  -- What the Transfer event moved, in the token's raw units, and the whole-token price it was verified against.
  amount_raw numeric(78, 0) not null check (amount_raw > 0),
  price_tokens text not null check (price_tokens ~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,18})?$'),
  paid_at timestamptz not null default clock_timestamp(),
  status text not null default 'PAID' check (status in ('PAID', 'APPLIED')),
  -- Filled exactly once, when the credit is used for a reroll.
  request_id uuid,
  hero_version_id uuid,
  previous_version_id uuid,
  from_class_id text,
  from_rarity text check (from_rarity is null or from_rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  from_power integer check (from_power is null or from_power >= 0),
  to_class_id text,
  to_rarity text check (to_rarity is null or to_rarity in ('COMMON', 'RARE', 'EPIC', 'LEGENDARY')),
  to_power integer check (to_power is null or to_power >= 0),
  applied_at timestamptz,
  utc_day date,
  -- THE LIMIT: one payment, one reroll.
  unique (tx_hash),
  unique (request_id),
  unique (hero_version_id),
  constraint hero_paid_rerolls_shape check (
    (status = 'PAID' and request_id is null and hero_version_id is null and previous_version_id is null and from_class_id is null and from_rarity is null and from_power is null
       and to_class_id is null and to_rarity is null and to_power is null and applied_at is null and utc_day is null)
    or
    (status = 'APPLIED' and request_id is not null and hero_version_id is not null and previous_version_id is not null and from_class_id is not null and from_rarity is not null
       and from_power is not null and to_class_id is not null and to_rarity is not null and to_power is not null and applied_at is not null and utc_day is not null)),
  constraint hero_paid_rerolls_day_matches_instant check (utc_day is null or utc_day = (applied_at at time zone 'UTC')::date),
  foreign key (hero_version_id, character_id) references public.hero_versions (id, character_id) on delete cascade,
  foreign key (previous_version_id, character_id) references public.hero_versions (id, character_id) on delete cascade,
  check (hero_version_id is null or hero_version_id <> previous_version_id)
);
create index hero_paid_rerolls_member_day_idx on public.hero_paid_rerolls (telegram_user_id, utc_day) where status = 'APPLIED';
create index hero_paid_rerolls_waiting_idx on public.hero_paid_rerolls (telegram_user_id, paid_at) where status = 'PAID';
create index hero_paid_rerolls_character_idx on public.hero_paid_rerolls (character_id, paid_at desc);
comment on table public.hero_paid_rerolls is
  'One row per VERIFIED on-chain payment for a paid hero reroll. UNIQUE (tx_hash) = one payment, one reroll. PAID = a recorded credit; APPLIED = it bought the version it names. Created and moved in the same transactions as the hero version it describes.';

-- A row is born PAID, for the hero's OWN member.
create or replace function public.guard_hero_paid_reroll_insert()
returns trigger
language plpgsql
as $$
declare
  owner_id bigint;
begin
  select telegram_user_id into owner_id from public.characters where id = new.character_id;
  if owner_id is distinct from new.telegram_user_id then
    raise exception 'a paid reroll belongs to the hero''s own member' using errcode = '23000';
  end if;
  if new.status <> 'PAID' then
    raise exception 'a paid reroll payment is recorded as PAID first' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger hero_paid_rerolls_guard_insert before insert on public.hero_paid_rerolls
  for each row execute function public.guard_hero_paid_reroll_insert();

-- PAID → APPLIED is the ONLY change a row ever sees: the payment facts stay exactly as verified, and the version it names must be a real paid reroll of that hero.
create or replace function public.guard_hero_paid_reroll_update()
returns trigger
language plpgsql
as $$
declare
  v public.hero_versions%rowtype;
  p public.hero_versions%rowtype;
begin
  if old.status <> 'PAID' or new.status <> 'APPLIED' then
    raise exception 'a paid reroll record moves from PAID to APPLIED exactly once and is then immutable' using errcode = '23000';
  end if;
  if new.id <> old.id or new.telegram_user_id <> old.telegram_user_id or new.character_id <> old.character_id or new.tx_hash <> old.tx_hash or new.payer_address <> old.payer_address
     or new.recipient_address <> old.recipient_address or new.token_address <> old.token_address or new.chain_id <> old.chain_id or new.amount_raw <> old.amount_raw
     or new.price_tokens <> old.price_tokens or new.paid_at <> old.paid_at then
    raise exception 'the verified payment facts of a paid reroll are immutable' using errcode = '23000';
  end if;
  select * into v from public.hero_versions where id = new.hero_version_id and character_id = new.character_id;
  select * into p from public.hero_versions where id = new.previous_version_id and character_id = new.character_id;
  if v.id is null or p.id is null then
    raise exception 'a paid reroll must point at versions of the same hero' using errcode = '23503';
  end if;
  if v.action <> 'REROLL' or v.created_by <> 'member-paid:' || new.telegram_user_id::text or v.request_id is distinct from new.request_id
     or v.previous_version_id is distinct from new.previous_version_id or v.version_number <> p.version_number + 1 then
    raise exception 'the paid reroll does not match the hero version it claims to describe' using errcode = '23000';
  end if;
  if v.class_id <> new.to_class_id or v.rarity <> new.to_rarity or v.power <> new.to_power
     or p.class_id <> new.from_class_id or p.rarity <> new.from_rarity or p.power <> new.from_power then
    raise exception 'the paid reroll''s before/after figures do not match the hero versions' using errcode = '23000';
  end if;
  return new;
end;
$$;
create trigger hero_paid_rerolls_guard_update before update on public.hero_paid_rerolls
  for each row execute function public.guard_hero_paid_reroll_update();

-- Never deleted — except as the cascade of deleting the whole hero (its parent row is already gone then).
create or replace function public.guard_hero_paid_reroll_delete()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.characters where id = old.character_id) then
    raise exception 'paid reroll records are append-only (delete rejected)' using errcode = '23000';
  end if;
  return old;
end;
$$;
create trigger hero_paid_rerolls_guard_delete before delete on public.hero_paid_rerolls
  for each row execute function public.guard_hero_paid_reroll_delete();

-- The other direction: a version made by a PAID reroll cannot commit unless its APPLIED payment row exists in the same transaction.
create or replace function public.check_member_paid_reroll_has_payment()
returns trigger
language plpgsql
as $$
begin
  if new.created_by like 'member-paid:%' then
    if new.action <> 'REROLL' or not exists (select 1 from public.hero_paid_rerolls r where r.hero_version_id = new.id and r.status = 'APPLIED') then
      raise exception 'a paid-reroll hero version must consume a verified payment (version % of hero %)', new.version_number, new.character_id using errcode = '23000';
    end if;
  end if;
  return null;
end;
$$;
create constraint trigger hero_versions_member_paid_reroll_payment after insert on public.hero_versions
  deferrable initially deferred for each row execute function public.check_member_paid_reroll_has_payment();

-- The auditor: every row it returns is a violation. Expected result: no rows.
create or replace function public.audit_hero_paid_rerolls()
returns table (ref text, problem text)
language sql
stable
as $$
  select v.character_id::text || ':' || v.version_number::text, 'PAID_VERSION_WITHOUT_PAYMENT'
    from public.hero_versions v
   where v.created_by like 'member-paid:%' and not exists (select 1 from public.hero_paid_rerolls r where r.hero_version_id = v.id and r.status = 'APPLIED')
  union all
  select r.tx_hash, 'PAYMENT_VERSION_IS_NOT_A_PAID_REROLL'
    from public.hero_paid_rerolls r join public.hero_versions v on v.id = r.hero_version_id
   where r.status = 'APPLIED' and (v.action <> 'REROLL' or v.created_by <> 'member-paid:' || r.telegram_user_id::text)
  union all
  select r.tx_hash, 'PAYMENT_FOR_ANOTHER_MEMBERS_HERO'
    from public.hero_paid_rerolls r join public.characters c on c.id = r.character_id
   where c.telegram_user_id is distinct from r.telegram_user_id
  union all
  select r.tx_hash, 'PAYMENT_FIGURES_DO_NOT_MATCH_THE_VERSIONS'
    from public.hero_paid_rerolls r
    join public.hero_versions v on v.id = r.hero_version_id
    join public.hero_versions p on p.id = r.previous_version_id
   where r.status = 'APPLIED'
     and (v.class_id <> r.to_class_id or v.rarity <> r.to_rarity or v.power <> r.to_power or p.class_id <> r.from_class_id or p.rarity <> r.from_rarity or p.power <> r.from_power)
  union all
  select r.tx_hash, 'REROLL_NOT_THE_DIRECT_SUCCESSOR'
    from public.hero_paid_rerolls r
    join public.hero_versions v on v.id = r.hero_version_id
    join public.hero_versions p on p.id = r.previous_version_id
   where r.status = 'APPLIED' and (v.version_number <> p.version_number + 1 or v.previous_version_id is distinct from r.previous_version_id)
$$;
comment on function public.audit_hero_paid_rerolls() is 'Violations of the paid-reroll rules (must return no rows). Run after enabling the feature and after any incident.';

select public.clank_harden_schema();
