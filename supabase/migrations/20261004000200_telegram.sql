-- Clank RPG — Telegram identity + activity foundation.
-- Only message FEATURES are stored (hash, lengths, flags) — never message text.
-- Telegram's immutable numeric user id is the identity; usernames are display data.
-- Demo/dev users use NEGATIVE ids, which can never collide with a real Telegram id.

create table public.telegram_users (
  telegram_user_id bigint primary key,
  username text,
  display_name text not null default '',
  is_demo boolean not null default false,
  status text not null default 'OK' check (status in ('OK', 'FLAGGED', 'BANNED')),
  flag_reason text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz,
  first_message_at timestamptz,
  last_message_at timestamptz,
  total_message_count integer not null default 0 check (total_message_count >= 0),
  qualifying_message_count integer not null default 0 check (qualifying_message_count >= 0),
  active_days integer not null default 0 check (active_days >= 0),
  reply_count integer not null default 0 check (reply_count >= 0),
  replies_received integer not null default 0 check (replies_received >= 0),
  reactions_received integer not null default 0 check (reactions_received >= 0),
  quality_sum real not null default 0 check (quality_sum >= 0),
  activity_score real not null default 0 check (activity_score >= 0),
  behavior jsonb not null default '{}'::jsonb,
  eligible_at timestamptz,
  session_epoch integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((telegram_user_id < 0) = is_demo)
);
create index telegram_users_username_idx on public.telegram_users (lower(username));
create index telegram_users_activity_idx on public.telegram_users (activity_score desc);
create index telegram_users_status_idx on public.telegram_users (status) where status <> 'OK';
create trigger telegram_users_updated_at before update on public.telegram_users
  for each row execute function public.set_updated_at();

-- Webhook retry de-duplication (pruned periodically).
create table public.telegram_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);
create index telegram_updates_received_idx on public.telegram_updates (received_at);

-- One row per message the pipeline has seen. (chat_id, message_id) makes imports and
-- webhook retries idempotent. `source` separates live traffic from imported history.
create table public.telegram_messages (
  chat_id bigint not null,
  message_id bigint not null,
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id) on delete cascade,
  sent_at timestamptz not null,
  day date not null,
  text_hash text,
  char_count integer not null default 0 check (char_count >= 0),
  word_count integer not null default 0 check (word_count >= 0),
  features jsonb not null default '{}'::jsonb,
  is_reply boolean not null default false,
  reply_to_user_id bigint,
  source text not null check (source in ('LIVE', 'IMPORT')),
  qualifies boolean not null default false,
  weight real not null default 0 check (weight >= 0),
  reject_reason text,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id)
);
create index telegram_messages_user_time_idx on public.telegram_messages (telegram_user_id, sent_at desc);
create index telegram_messages_user_hash_idx on public.telegram_messages (telegram_user_id, text_hash) where text_hash is not null;

-- Per-user, per-day counters (daily qualification cap + active-day tracking).
create table public.telegram_daily_activity (
  telegram_user_id bigint not null references public.telegram_users (telegram_user_id) on delete cascade,
  day date not null,
  message_count integer not null default 0 check (message_count >= 0),
  qualifying_count integer not null default 0 check (qualifying_count >= 0),
  primary key (telegram_user_id, day)
);

-- One reaction row per (message, reactor): engagement signal for the message author.
create table public.telegram_reactions (
  chat_id bigint not null,
  message_id bigint not null,
  reactor_user_id bigint not null,
  author_user_id bigint not null references public.telegram_users (telegram_user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (chat_id, message_id, reactor_user_id),
  check (reactor_user_id <> author_user_id)
);
create index telegram_reactions_author_idx on public.telegram_reactions (author_user_id);

-- Telegram Login Widget payloads are single-use (replay protection).
create table public.telegram_login_proofs (
  hash text primary key,
  telegram_user_id bigint not null,
  auth_date timestamptz not null,
  used_at timestamptz not null default now()
);
create index telegram_login_proofs_used_idx on public.telegram_login_proofs (used_at);
