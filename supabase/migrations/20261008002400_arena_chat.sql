-- Clank RPG — ARENA CHAT: ONE permanent, global chat room under the Live Arena.
--
-- Durable history lives here (Postgres); delivery to open browsers is Supabase Realtime BROADCAST, sent by the SERVER after the row has committed
-- (docs/ARENA_CHAT.md). The browser never reads or writes these tables: every table has RLS enabled with NO policies and no API-role privileges
-- (clank_harden_schema), exactly like the rest of the schema. Messages are written by the Next.js server only, for the member whose signed Telegram
-- session made the request.
--
-- Two tables:
--   arena_chat_messages  one row per message. `id` is a monotone cursor (history is keyset-paged on it, newest first); `created_at` is the SERVER's clock.
--                        A moderator HIDES a message (soft delete: `deleted_at`), the row stays for the audit trail. `rev` counts hide / restore
--                        so a late or replayed broadcast can never undo a newer moderation decision.
--   arena_chat_mutes     a muted member can read the room but not write. A mute is timed (`muted_until`) or permanent; the reason is PRIVATE (never
--                        sent to any public endpoint).
-- Moderation actions are recorded in the existing append-only `admin_audit_log` (actions chat.hide / chat.restore / chat.mute / chat.unmute).
--
-- Spam limits (3 s between messages, 10 per minute, no repeat of the same text within a minute) are enforced by the server INSIDE the insert
-- transaction under one advisory lock (key 7300102), so they cannot be raced and ids are issued in commit order (a reader that has seen id N has seen
-- every smaller id). `client_nonce` makes a retried request idempotent: the same (member, nonce) can only ever produce one message.

create table public.arena_chat_messages (
  id bigint generated always as identity primary key,
  sender_member_id bigint not null references public.telegram_users (telegram_user_id),
  body text not null check (char_length(body) between 1 and 280 and octet_length(body) <= 1400),
  client_nonce text not null check (client_nonce ~ '^[A-Za-z0-9_-]{8,64}$'),
  created_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  deleted_by text check (deleted_by is null or char_length(deleted_by) <= 60),
  rev integer not null default 0 check (rev >= 0),
  check ((deleted_at is null) = (deleted_by is null)),
  unique (sender_member_id, client_nonce)
);
comment on table public.arena_chat_messages is 'The global Arena Chat room (one room, all history). Written only by the server for the verified Telegram session; hidden = deleted_at set.';
comment on column public.arena_chat_messages.rev is 'Bumped on every hide / restore. Broadcast events carry it so clients ignore stale or replayed moderation.';

-- The room as people read it: the newest visible messages first, then older ones (keyset on id).
create index arena_chat_messages_visible_idx on public.arena_chat_messages (id desc) where deleted_at is null;
-- A member's recent messages: the rate limit and the repeat check look at the last minute only. The index serves the filter AND the order, so a member who
-- rarely writes costs an index probe, never a walk through the table.
create index arena_chat_messages_sender_idx on public.arena_chat_messages (sender_member_id, created_at desc, id desc);

-- The moderation log is the existing append-only audit log; this keeps "recent chat actions" a short index scan however long that log grows.
create index admin_audit_log_chat_idx on public.admin_audit_log (id desc) where action like 'chat.%';

create table public.arena_chat_mutes (
  id bigint generated always as identity primary key,
  member_id bigint not null references public.telegram_users (telegram_user_id),
  permanent boolean not null default false,
  muted_until timestamptz,
  -- PRIVATE: shown to admins only, never to the muted member and never by a public endpoint.
  reason text check (reason is null or char_length(reason) <= 300),
  created_by text not null check (char_length(created_by) between 1 and 60),
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  lifted_by text check (lifted_by is null or char_length(lifted_by) <= 60),
  check (permanent = (muted_until is null)),
  check ((lifted_at is null) = (lifted_by is null))
);
-- At most ONE open mute per member (a new mute lifts the previous one first; an expired timed mute is simply not active any more).
create unique index arena_chat_mutes_open_idx on public.arena_chat_mutes (member_id) where lifted_at is null;
comment on table public.arena_chat_mutes is 'Members who may read but not write the Arena Chat. `reason` is private to admins.';

-- ---------------------------------------------------------------------------
-- Realtime AUTHORIZATION (Supabase Realtime, private channel `arena-chat`)
-- ---------------------------------------------------------------------------
-- Everybody — signed in or not, the browser holds only the publishable key — may RECEIVE the room's broadcasts. NOBODY can SEND from a browser: there is
-- deliberately no INSERT policy, so a client publish is refused. Only the server (service role, over the Realtime REST API) broadcasts, and every
-- broadcast is additionally SIGNED by the server (Ed25519) and verified by the client, so even a project whose "Allow public access" Realtime setting was
-- never switched off cannot make a forged message appear as real (docs/ARENA_CHAT.md).
--
-- `realtime.messages` only exists on a Supabase project (plain Postgres / PGlite have no `realtime` schema) and the migration must never fail because of
-- it: where the schema is missing nothing happens, and where the role may not create the policy a NOTICE says what to run by hand.
do $$
begin
  if to_regclass('realtime.messages') is not null then
    execute 'drop policy if exists "arena chat: everyone may listen" on realtime.messages';
    execute $policy$
      create policy "arena chat: everyone may listen" on realtime.messages
        for select to anon, authenticated
        using ( realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'arena-chat' )
    $policy$;
  end if;
exception when others then
  raise notice 'The Realtime policy for the Arena Chat was not created automatically (%). Run the CREATE POLICY from docs/ARENA_CHAT.md in the Supabase SQL editor.', sqlerrm;
end
$$;

select public.clank_harden_schema();
