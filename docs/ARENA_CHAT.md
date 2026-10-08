# Arena Chat — the one global room under the Live Arena

> Code: `src/domain/chat/*` (limits, text rules, the room reducer, relative time, wire readers), `src/server/chat/*` (service, signing, broadcaster, runtime),
> `src/app/api/arena/chat/messages/route.ts` (public API), `src/app/api/admin/[...path]/route.ts` (`chat/*` moderation), `src/components/arena/chat/*` (the section),
> `src/components/admin/ChatModeration.tsx`, `supabase/migrations/20261008002400_arena_chat.sql`, `scripts/dev-realtime.ts` + `tests/support/fakeRealtime.ts` (local stand-in).
> Tests: `tests/unit/arena-chat-{domain,signing,controller,ui}.test.ts`, `tests/integration/arena-chat{,-migration,-realtime,-postgres}.test.ts`, `tests/security/arena-chat-http.test.ts`.
> **Status (2026-10-08): migrations 2200 / 2300 / 2400 are applied to the live database and the code is deployed.** Everything below was developed and verified on scratch infrastructure; the two
> things checked on the live project afterwards are a read-only comparison of the live schema with the migration file (identical) and ONE listen-only join of the private channel (see
> [live verification](#live-verification-after-the-deploy)). No message has been sent on the live site by the developer tooling.

## What it is

ONE persistent room for the whole community, directly below the Live Arena (and the fighter status cards). Not tied to a battle: it keeps its history through fights,
refreshes, sign-outs and new viewers. **Anyone can read it. Only a member signed in with Telegram can write** — a guest sees "Sign in with Telegram to chat." and no
input and no send button at all. Messages are plain text, at most 280 characters / 4 lines.

```
 SEND   browser ─POST {body, nonce}─► Next route ─► verified Telegram session (cookie + revocation epoch + not banned) + same-origin check
                                         │            the sender is the SESSION's member; the body carries no identity (strict schema)
                                         ▼
                              ONE short transaction on the pooled connection:
                              advisory lock → sender/mute → "already sent?" (nonce) → last minute → INSERT  ──► committed = confirmed
                                         │
                                         ▼ after commit, never before
                              signed envelope ─POST /realtime/v1/api/broadcast (service key, private topic)─► Supabase Realtime
                                                                                                                    │
 RECEIVE  browser ◄─ WebSocket (private channel `arena-chat`, listen-only policy) ◄────────────────────────────────┘
             verifies the Ed25519 signature → only then reads it → merges by id into the room
 HISTORY  browser ─GET /api/arena/chat/messages[?before=|?after=]─► ONE indexed, bounded statement (shared for 1 s per server instance)
```

## Who the sender is — and what the page may show

* **Identity is the existing Telegram session** (`clank_session`, HMAC-signed, `session_epoch` revocation, banned members refused) — no second auth system and no
  Supabase Auth user. Telegram sign-in does **not** create a Supabase identity and the chat does not need one.
* A send needs the session **and** a same-origin request. The request body is `{ body, nonce }` and nothing else (a strict schema: `senderId`, `name`, `memberId`,
  `createdAt`, … are refused with 422). The server writes `sender_member_id` from the session.
* **Name and photo are resolved by the server**, from the existing rules: the member's hero name (`coalesce(name_override, name)`) and hero profile photo (admin override →
  Telegram photo, the same `hero_profile_photos` view and `/api/avatars/<heroId>?v=<hash>` URLs the rest of the site uses) while the hero is ACTIVE; otherwise the Telegram
  display name; otherwise "Telegram member". Names are cleaned (no bidirectional overrides / invisible characters, one line, ≤ 40 characters). No photo → an initial.
* **A message exposes only** `id, at, name, avatarUrl, senderKey, body, rev`. Never a Telegram id, username, e-mail, token, session id or wallet. `senderKey` is an
  opaque 16-character HMAC (key derived from `SESSION_SECRET`) that means "the same sender" — it is how the page marks the viewer's own messages.
* Admins see real member ids and usernames, in the admin console only.

## Realtime: what is trusted, and why

The browser **never** treats something that arrived over the WebSocket as a verified chat message by virtue of arriving. Two independent layers:

1. **Supabase Realtime Authorization (private channel).** The channel is `arena-chat`, joined with `private: true`. The migration creates exactly one policy on
   `realtime.messages`: `SELECT` for `anon, authenticated` where `extension = 'broadcast'` and `realtime.topic() = 'arena-chat'`. There is **no INSERT policy**, so a browser
   cannot publish. Only the server publishes — over the Realtime REST API with the service-role key (the key never reaches a browser). Everyone may listen because the
   room is public to read; that is why no JWT bridge between the Telegram session and Supabase is needed (and none was built): nothing about *reading* depends on who you are,
   and *writing* never goes through Realtime.
2. **Every broadcast is signed.** The server signs each event (`{t:"msg", m}` or `{t:"hide", id, rev}`) with Ed25519; the key pair is derived from `SESSION_SECRET` with HKDF under a
   separate label (nothing new to configure). The public key is delivered with the first page over this site's own HTTPS API. The browser verifies the signature with WebCrypto
   **before it reads the payload**: a forged, unsigned, tampered or replayed-with-other-text frame is dropped; a browser that cannot verify (no WebCrypto Ed25519) treats the frame only as a
   *hint* to fetch the room from the server and never displays it. This holds **even if** the dashboard's "Allow public access" Realtime setting was left on (see below) and a peer
   on a public channel published to the same topic name.
* A moderator's hide travels as a signed event carrying the message's moderation `rev`; the browser keeps a tombstone, so a late or replayed copy of the message can never undo a
  newer decision, while a restore (a newer `rev`) brings it back.
* Rotating `SESSION_SECRET` changes the signing key (it signs sessions too, so everyone signs in again anyway); browsers fetch the key with every first page.

## The database

`supabase/migrations/20261008002400_arena_chat.sql` — one focused migration, additive, ending with `clank_harden_schema()`:

| Object | Purpose |
| --- | --- |
| `arena_chat_messages` | `id` (identity — the keyset cursor and the order), `sender_member_id → telegram_users`, `body` (1–280 characters, DB-checked), `client_nonce` (unique per member → idempotent retries), `created_at` (the server's `clock_timestamp()`), `deleted_at` / `deleted_by` (a hide is a soft delete), `rev` |
| `arena_chat_mutes` | one open mute per member (partial unique index); timed (`muted_until`) or `permanent`; `reason` is **private** |
| indexes | `(id desc) where deleted_at is null` (the room), `(sender_member_id, created_at desc, id desc)` (the rate limit), `unique (sender_member_id, client_nonce)`, and a partial index on `admin_audit_log` for `chat.%` |
| Realtime policy | created only where `realtime.messages` exists (a Supabase project); never blocks the migration (a NOTICE says what to run by hand) |

Moderation actions are rows in the existing append-only `admin_audit_log` (`chat.hide`, `chat.restore`, `chat.mute`, `chat.unmute`). Both tables are server-only: RLS enabled, no policies, no
`anon` / `authenticated` privileges (`tests/security/rls.test.ts` covers every table; the chat tests assert it again).

**Ordering.** A send takes `pg_advisory_xact_lock(7300102)` first (distinct from the lifecycle and worker locks). Writers are serialised, so ids are issued in **commit order**: a reader that has
seen id N has seen every smaller id and "after N" can never skip a message (`tests/integration/arena-chat-postgres.test.ts` proves it with a reader racing 60 writers on real Postgres).
The transaction is five short statements; the lock is held for milliseconds.

**Pagination.** The first page is the newest 50, ascending. Older pages use `before=<id>` (keyset, never `OFFSET`); `limit` is 1–100. `after=<id>` returns the newest page of what is newer than the
cursor and says `hasMore` when more than a page was missed (the browser then replaces its window rather than stitching). On a 100 000-message table the latest page costs 157 buffer hits and
≈ 0.1 ms, a page from the middle of the history 3 buffer hits, and the per-member rate-limit probe is an index condition on `(member, created_at)` — all asserted from `EXPLAIN` in the Postgres suite.

## Spam and abuse (all server-side, atomic)

| Rule | Where / how |
| --- | --- |
| ≥ 3 s between a member's messages | `TOO_FAST` (429 + `Retry-After`), decided inside the send transaction from the database clock |
| ≤ 10 messages in any rolling minute | `RATE_LIMITED` (429 + `Retry-After` = when the 10th-newest ages out) |
| the same text again within the minute (case / spacing ignored) | `DUPLICATE_MESSAGE` (409) |
| same request retried (double click, flaky network) | the same `(member, nonce)` returns the stored message; never a second row |
| 280 characters / 4 lines, 2 KB request body | refused before the database (`TOO_LONG`, `TOO_MANY_LINES`, 413) |
| per-instance brakes ahead of the database | 30 sends / min / member, 90 / min / address, 600 reads / min / address (a campus can sit behind one address) |
| muted member | `MUTED` (403) — they keep reading; the reason is never returned |
| guest / banned / expired session | 401 |

Content is **plain text**: normalised (NFC), controls / lone surrogates / private-use / soft hyphens / bidirectional overrides / zero-width spaces removed (the joiner and non-joiner stay, emoji and
Persian need them), runs of combining marks cut to three, spaces collapsed. It is rendered as a React text node and never as HTML; there are no clickable links, no mentions and no system-message
styling a user could imitate. A stored `<script>` is displayed as the literal text `<script>`.

## Moderation (Admin → Arena Chat)

Real controls only: list the newest messages **including hidden ones** with member names and ids; **Hide** / **Restore** (open rooms drop or re-show the message at once via a signed event);
**Mute…** (minutes or permanent, with a private reason); the list of open mutes with **Unmute**; and the log of `chat.*` actions. All of it goes through `/api/admin/chat/*` — the admin session
and a same-origin request (non-GET) are required, a signed-in player is not an admin. Normal members cannot touch anyone's messages.

## Reconnecting, catching up, scrolling

* The room's brain (`ChatController`) is plain TypeScript — React only reads snapshots — so every behaviour below is unit-tested with a manual clock.
* **Every way of being out of date funnels into ONE guarded catch-up**: one request at a time, never closer than 1.5 s, failures back off (×2 up to 2 min, jittered). It runs after every (re)join, when a tab
  becomes visible, when the network returns, after a back/forward-cache restore, when a broadcast could not be verified, and on a slow timer: **90 s while live, 20 s without a live connection, 60 s while the room
  is closed**, only while the tab is visible. That timer is the safety net; delivery is the broadcast. There is **no per-second polling** anywhere.
* The Realtime client (`@supabase/realtime-js`, loaded on demand) reconnects with a jittered exponential backoff (≈ 1 s → 30 s). A watchdog rebuilds the client if it does not become live in time; after six refused
  joins in a row it rests for five minutes instead of hammering a channel that refuses it. A tab hidden for a minute lets go of its socket and rejoins when seen. The header chip says **Live**, **Connecting…**,
  **Reconnecting…**, or **Updating** (no live delivery: new messages appear within ~20 s) — "Live" is only shown when the room is actually joined.
* A catch-up **merges**: held history stays, new messages appear in id order, a message hidden meanwhile disappears, duplicates (a broadcast and the sender's own response) are the same message.
* Scrolling: at the bottom the list **follows**; scrolled up it **stays put** and shows "↓ New messages (n)"; older pages loaded at the top **keep the viewer's place**; the viewer's own message always goes to the
  bottom; only the list scrolls, never the page; the in-memory room is capped at 600 messages and trimmed (only while following).

## Cost and safety for the database and the host

* **A send** = the cookie check (1 statement) + the send transaction (lock, sender, nonce, last minute, insert) + one HTTP call to Realtime. **A history read** = one statement, shared for a second by every request on an
  instance (a burst of viewers or a reconnect storm is one read). No LISTEN/NOTIFY, no session state, no temp tables, no per-message client, no N+1 (sender names/photos are joined in the same statement).
* It uses the existing shared handle (`DATABASE_POOL_MAX=1` per instance, transaction pooler safe: only transaction-scoped advisory locks). Suites pass on the real driver with a pool of 1 and of 4.
* A Realtime outage cannot fail or slow a send beyond 2.5 s once, and a circuit then skips the call for 30 s; the message is already saved and reaches browsers on their next catch-up.
* Chat and Arena share nothing in the browser (separate component, separate fetches, separate timers, no shared state) and nothing blocks the other: the Arena canvas never re-renders for a message, and a chat failure shows
  inside the chat only.
* **Supabase Realtime plan limits** (published, per project): Free 200 concurrent connections · 100 messages/s · 100 channel joins/s; Pro 500 · 500 · 500; Pro without a spend cap / Team 10 000 · 2 500 · 2 500. "An
  event is a WebSocket message delivered to, or sent from a client" — **one chat message delivered to 80 viewers is 80 events**. On Free, 100 events/s means e.g. 80 viewers at 1 message/s; a quiet room supports
  its 200 connections. Hidden tabs release their socket, which helps. Check the plan's numbers in *Project Settings → Realtime* before launch; they are configurable per project.

## Enablement and the closed states

* `feature_flags.arena.chat` (seeded **on**, switchable in Admin → Feature flags): off → the room shows "Arena Chat is resting", reads and sends are refused (503 `CHAT_CLOSED`), nothing is queried.
* **If the migration is not applied yet the chat is simply closed** ("Arena Chat opens soon"; `GET` answers `enabled:false, reason:"NOT_READY"`, no error, no spinner) and opens by itself within ~10 s of the migration being applied.
* Live delivery needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (all four, else the chat runs in "Updating" mode). The server hands the browser the URL, the
  publishable key and the verification key at runtime (no rebuild for a change). `CHAT_REALTIME_URL` overrides the Realtime base for local development only.

## The eventual launch order (NOT done by this change)

Nothing below was executed. The live ledger (read-only check on 2026-10-08) ends at `20261006002100`: **two earlier migrations are pending as well** — `20261007002200_hero_arena_rewards.sql` and
`20261007002300_combat_engagement_3_1_0_renderer_v2.sql` — and the migration runner applies pending files in order, so applying this one means applying all three. Decide on those deliberately.

1. **Verify migration status** (read-only): `pnpm db:inspect` against the live URL, or `pnpm db:migrate -- --dry-run`. Expect `2200`, `2300`, `2400` pending.
2. **Create a backup** (a Supabase backup / `pg_dump`), and have the previous deployment ready to roll back to.
3. **Apply the approved migrations** (`pnpm db:migrate` with the **session/direct** URL, or `npx supabase db push --db-url …`). Read the output: if it prints *"The Realtime policy for the Arena Chat was not created automatically"*, run this once in the SQL editor:
   ```sql
   create policy "arena chat: everyone may listen" on realtime.messages
     for select to anon, authenticated
     using ( realtime.messages.extension = 'broadcast' and (select realtime.topic()) = 'arena-chat' );
   ```
4. **Confirm Realtime permissions** (dashboard-only steps): *Realtime → Settings → turn **off** "Allow public access"* (Supabase: "To enforce private channels you need to disable the 'Allow public access' setting");
   confirm the policy exists on `realtime.messages`; confirm the plan's connection / message limits suit the audience. The signature layer protects the room even if this step is forgotten, but do it.
5. **Verify the production environment**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (already used for photos), `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the publishable key — never the service key),
   `SESSION_SECRET`, `TELEGRAM_BOT_TOKEN` / `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`. Names only here; never paste values.
6. **Deploy** the application (the chat opens by itself once the tables exist; until then it shows "opens soon").
7. **Smoke test** with a throwaway Telegram account: guest read-only; sign in; send; a second browser receives it live; refresh keeps it; mute / hide from Admin; watch the Live chip.
   Keep `feature_flags.arena.chat` ready as the kill switch.
8. **Monitor**: Realtime logs (limit errors: `too_many_connections`, `too_many_joins`, `tenant_events`), the app log line `[arena-chat] Realtime is not accepting broadcasts` (circuit opened), 429 rates on
   `/api/arena/chat/messages`, and `pg_stat_activity` — the chat adds two short transactions per message and one cached read per second per instance.

**Roll back / switch off:** flip `arena.chat` off (instant, no deploy). The tables can stay; removing the migration is never needed.

## What was verified, and how (scratch infrastructure only)

| Check | Result |
| --- | --- |
| Unit / integration / security suites (domain rules, signing, controller, UI markup, service, migration, HTTP, realtime, real Postgres) | 141 chat tests (the 7 that need a throwaway Postgres run with `CLANK_TEST_PG_URL`; all also pass on the real driver with a pool of 1 and of 4), plus 6 for the speaker button; the whole project suite passes |
| Real Chrome, 4 people (a guest and three Telegram-signed members + a long-named one), production build, scratch Postgres | 110 / 110 checks: live delivery without refresh, identical order for everyone, double-submit, 3 s rule, 280 limit, XSS payload inert, name left / time far right, refresh, browser Back, 120-message history + pagination with the place preserved, "New messages", reconnect + back-fill, hide / restore live, mute, forged broadcasts ignored, 9 viewport widths 320–1920 px with no horizontal overflow |
| Load (this application's side; the Realtime stand-in is not Supabase) | 10 / 50 / 100 real client controllers + 40 signed-in senders posting ≈ 5.5 messages/s for 50 s, with every socket dropped mid-run: **0 duplicate deliveries, 0 messages missing after back-fill, 0 refused sends**; propagation (POST start → viewer's room) p50 10–13 ms, p95 19–24 ms, p99 46–52 ms, max 55–97 ms; all viewers live again ≈ 1.0 s after the drop; database ≈ 1.7 transactions per message above the Arena's own baseline (one cookie check + one send transaction), never more than the app's one pooled connection; server memory flat |
| Client cost | the Realtime client is a lazy chunk (≈ 57 KB, 17 KB gzip) fetched only when the chat joins |

## Live verification after the deploy

* **Schema:** a read-only comparison of the live database with `20261008002400_arena_chat.sql` — tables, constraints, all four indexes, RLS on with **no** policies on the chat tables, no `anon` / `authenticated` privileges, and the
  listen-only `arena chat: everyone may listen` policy on `realtime.messages` — matched exactly. The `arena.chat` flag is on.
* **Private-channel join with the new-style publishable key** (`sb_publishable_…`, not a JWT) — the one thing that could not be tried on scratch infrastructure: ONE listen-only join from a script, exactly as the browser does it
  (`private: true`, key as access token, nothing published). Result: the first join reported `CHANNEL_ERROR MissingPartition: Realtime was unable to find the expected messages partition` (Realtime creates the day's `realtime.messages`
  partition on demand the first time a private channel is used) and **~1 s later `SUBSCRIBED`**. So the private channel works with the publishable key on this project. The client counts that first error as one of its six allowed
  failures and resets on `SUBSCRIBED`; nothing needs doing. If it ever reappears after a long quiet spell it heals the same way.
* **Not done on live, by design:** sending a message (no test messages in the real room) and the dashboard's "Allow public access" switch (a dashboard-only step; the signature layer protects the room regardless).

## What is NOT verified

* **No hosted Supabase project was touched.** The Realtime behaviour was exercised against a stand-in that speaks the same wire protocol (Phoenix v2 over WebSocket, the REST broadcast endpoint) to the **real**
  `@supabase/realtime-js` client in real Chrome — it proves our client and server behave correctly against that protocol, **not** that a given hosted project is configured correctly. The listen-only policy was verified
  against real Postgres with a stand-in `realtime` schema shaped like Supabase's (`realtime.messages` with RLS, `realtime.topic()` reading the channel setting).
* Browsers other than Chrome were not driven (WebCrypto Ed25519 needs Chrome 137+ / Firefox 129+ / Safari 17+; older browsers fall back to "hint → fetch", never to showing unverified content).
* There is **no online-viewer count**: the app has no trustworthy presence system and none was invented.
* The Realtime stand-in is not a load test of Supabase; its numbers measure this application's side (route, database, signature checks, client merge).

## Running it locally without Supabase

```bash
pnpm exec tsx scripts/dev-realtime.ts --port 54380      # the stand-in (Realtime + minimal photo storage)
# then run the app with  SUPABASE_URL=http://127.0.0.1:54380  NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54380
#   SUPABASE_SERVICE_ROLE_KEY=dev-service-role-key-0123456789  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=dev-publishable-key-0123456789
```

Never point a stand-in run at the live database (`.env` holds the live `DATABASE_URL`: override it, see `docs/OPERATIONS.md`).

## Tests

```bash
pnpm exec vitest run tests/unit/arena-chat-*.test.ts tests/integration/arena-chat*.test.ts tests/security/arena-chat-http.test.ts
CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:<port>/postgres pnpm exec vitest run tests/integration/arena-chat-postgres.test.ts          # real concurrency (throwaway server)
CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1 CLANK_TEST_PG_URL=… pnpm exec vitest run tests/integration/arena-chat.test.ts tests/security/arena-chat-http.test.ts   # the production pool shape
```
