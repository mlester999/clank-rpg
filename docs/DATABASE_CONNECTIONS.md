# Database connections on serverless hosting (Supabase poolers)

> Incident write-ups and the rules the driver now enforces. Code: `src/server/db/postgres.ts` (driver), `src/server/db/index.ts` (the one shared handle),
> `src/server/seed/reference.ts` + `src/server/runtime.ts` (cold start). Tests: `tests/integration/db-serverless-driver.test.ts`, `db-dead-connections.test.ts`,
> `seed-fast-path.test.ts`, `db-pressure.test.ts`, `tests/security/db-outage-http.test.ts`, `tests/unit/db-single-client.test.ts`.
> Second incident (`CONNECTION_DESTROYED`) and the serverless pool sizing: see **§ Incident 2** and **§ Pool sizing for serverless fan-out** below.
> Who advances the Arena, and the persistent worker: `docs/ARENA_WORKER.md`.

## Incident 1 — hangs behind the poolers

### What production did

| Pooler | Symptom |
|---|---|
| Session pooler (port 5432) | `EMAXCONNSESSION — max clients reached in session mode` |
| Transaction pooler (port 6543) | the error went away, but `/api/admin/overview` → Vercel **504 after 60 s**, `/api/arena/state` → **504 after 300 s**; the Admin page worked briefly, then every database route hung again |

The database itself was healthy during the hang (read-only check of `pg_stat_activity`: 12 of 60 connections, no transaction older than a second, no ungranted
locks). The requests were waiting for answers that never came.

### Root causes

1. **Session pooler: connection count.** The driver opened up to 5 connections per warm function instance and kept them 20 s after the last use. In *session*
   mode every client connection holds a database backend for as long as it is open, and the pooler allows only `pool_size` of them (small plans: 15). Three
   or four warm instances exhausted it. (Session mode is the wrong tool for a serverless web tier.)
2. **Transaction pooler: query pipelining.** postgres.js writes up to `max_pipeline` (default **100**) statements to one connection without waiting for the
   previous answer. Whenever more statements were running than there were connections (a `Promise.all`, two overlapping requests) it did exactly that.
   A shared transaction pooler can lose such a pipelined batch, and the query then **never answers** — there is no error, only a hang. Measured on the old
   driver: 50 concurrent reads → 45 pipelined batches, up to 10 in flight on one connection; 50 concurrent admin-overview requests → up to 47.
3. **Nothing ever gave up.** No statement timeout, no connect/idle recovery: a lost reply, or a connection the pooler (or a frozen function) dropped silently,
   held the request until the platform killed it (60 s / 300 s).
4. **The cold-start seed was the amplifier.** Every request awaits `getReadyDb()`, which runs `seedReferenceData()` once per instance: **129 sequential
   round trips** on a database that is already seeded (≈ 40 s at 150 ms to the database, ≈ 65 s at 250 ms), cached as a promise that — if it hung or failed —
   stayed hung/failed for the life of the instance. That alone reproduces "overview 504 after 60 s".
5. **Every state read opened a row-locking transaction** (`BEGIN; SELECT … FOR UPDATE; COMMIT`) even while the Arena is PAUSED / NOT_STARTED, where the step does
   nothing. (Not a cause of the hang; it is wasted work and, with serialized statements, extra latency.)

### What the driver guaranteed after incident 1 (`createPostgresDb`)

* **No pipelining, by construction.** `max_pipeline` cannot switch it off (`0` breaks `sql.begin`, `1` still allows two in flight), so a **Gate** keeps the number
  of running statements/transactions at or below the pool size — every one gets a connection of its own — and the statements *inside* a transaction run strictly
  one after the other, even under `Promise.all`. Verified with a protocol-level proxy: `maxInFlightOnOneConnection = 1`, `pipelinedBatches = 0`.
* `prepare: false` (unchanged) — no named prepared statements.
* **Bounded waits.** `DATABASE_QUERY_TIMEOUT_MS` (default 10 000 since incident 2; was 20 000) per statement, including the BEGIN and COMMIT/ROLLBACK that postgres.js issues itself;
  `DATABASE_TX_TIMEOUT_MS` (default 120 000) per whole transaction. A statement that does not answer is treated as a dead connection: the pool is thrown away
  (the next call connects afresh) and the call fails with a connection-class error. A pure `SELECT` outside a transaction is retried **once** on the new pool;
  anything that may have written (`insert/update/delete`, `FOR UPDATE`, `nextval`, advisory locks, `set_config`, …) is never repeated.
* **Small, bounded pool.** `DATABASE_POOL_MAX` (default **1** since incident 2, never above 4; idle connections close after 10 s, a connection lives at most 15 min). One shared handle per process
  (`globalThis`), created lazily; there is no per-request client anywhere (`getDb()` is the only constructor call).
* **Cold start is one statement.** `seedReferenceData` first asks, in one query, whether anything at all is missing; only then does the full pass (unchanged:
  insert what is missing, never overwrite an admin's edit) run. A failed or timed-out seed is forgotten so the next request retries it.
* **A stopped Arena costs one plain read.** The viewers' coalesced advance (`advanceForViewers` in `runtime.ts`) answers NOT_STARTED / PAUSED from a single
  `SELECT status` — no transaction, no lock. Every state that can advance (PREPARING / RUNNING / PAUSE_REQUESTED) still goes through the locked gate in
  `stepArena`, and the worker / scheduler call `advanceArena` exactly as before. `GET /api/arena/state` never writes anything while the Arena is stopped.

## Incident 2 — `Unhandled Rejection: write CONNECTION_DESTROYED <pooler>:6543` (the site recovered by itself)

Production (Vercel Mumbai → Supabase Mumbai transaction pooler) intermittently logged an **unhandled rejection** `write CONNECTION_DESTROYED aws-0-ap-south-1.pooler.supabase.com:6543`
on `/api/arena/state`, `/api/admin/game` and `/api/admin/overview`, and recovered later without anyone touching it. Not acceptable for launch.

### Root cause (reproduced, then pinned by a regression test)

postgres.js, by default (`fetch_types: true`), runs a catalog query for the array types **on every new physical connection**, from an `async` function that **nothing awaits or
catches** (`fetchArrayTypes()` in its `connection.js`). Whenever a connection dies *during that handshake* — the pooler resets a fresh connection, a Vercel instance is frozen and thawed
mid-connect, or **our own driver throws a poisoned pool away** (`recycle` → `client.end`) while a new connection is still connecting — that query rejects with
`write CONNECTION_DESTROYED host:port` / `read ECONNRESET`, and because no promise handler exists Node reports it as an **unhandled rejection**. Every database route is exposed;
the three named were simply the ones whose requests hit a cold or recycled connection. It is also a wasted round trip and a `pg_type` scan **per connection** — and a serverless
tier opens connections constantly.

*Reproduced* (scratch Postgres behind the fault-injecting proxy): a fresh connection killed while it runs the array-type query → **2 unhandled rejections** on the old driver
(`read ECONNRESET`, `write CONNECTION_DESTROYED 127.0.0.1:49198` — the production message, with a different host); **0** on the new driver.
`db-dead-connections.test.ts` keeps this alive: with `fetch_types` switched back on the suite fails with three `unhandledRejection: read ECONNRESET`.

### What changed

| Layer | Change |
|---|---|
| **The floating promise** | `fetch_types: false`. The array types the app can meet (`bool int2 int4 int8 float4 float8 numeric text varchar bpchar uuid json jsonb date timestamp timestamptz` arrays) are registered **statically** (`ARRAY_TYPES` in `postgres.ts`; parse + serialise, incl. quoting / NULL / nesting / `{a,b}` literals — the app's `any($1::text[])` convention and `array_agg(...)` results behave exactly as before; verified against real Postgres). |
| **Last line of defence** | `installRejectionGuard()` (web: on first database open; worker: in *rethrow* mode). A **connection-class** stray from any library is logged in one line and counted (`strayRejections.absorbed`) instead of surfacing as an unhandled rejection; every other rejection is left to the runtime exactly as before. In every run below it absorbed **0**. |
| **Stale idle connections** | `ensureLive`: a connection nobody has heard from for ≥ `DATABASE_LIVENESS_IDLE_MS` (5 s) gets ONE bounded `select 1` (≤ 3 s) before the next statement trusts it. Failure → the whole pool is replaced and the caller's statement runs on a fresh connection. A busy instance **never** probes (its connection was used a moment ago); concurrent callers share one probe; a brand-new pool is not probed. This is what makes a write safe against a socket the pooler closed while the instance was frozen: the *probe* meets the dead socket, not the write. |
| **Recycle on any connection failure** | a connection-class error (reset, closed, destroyed, timeout, 57P01…) now replaces the pool, not only a timeout. With a pool of one (production) the dead connection is destroyed at once, so an instance never holds two connections at the pooler; with a larger pool, in-flight work on the other connections gets 2 s to finish (graceful end) before it is destroyed. `DATABASE_QUERY_TIMEOUT_MS` is 10 s (was 20 s): with a pool of one every request queues behind a silently-dead connection's statement, so that timeout *is* the length of the outage (browsers give up on a state read after 8 s anyway). |
| **Replay rules** | A pure `SELECT` outside a transaction: retried **once**. A transaction that died **before BEGIN completed** (its body never ran): replayed **once**. Everything else — a write, any statement inside a transaction, a COMMIT whose reply is lost — is **never replayed**; it fails with a `DbConnectionError` whose `ambiguous` flag says whether it may have been applied (`true` for a write that lost its reply and for a COMMIT that was sent; `false` for a read, a transaction killed before COMMIT — the server rolls those back — or one that never began). No retry loop exists anywhere: one retry, then the error. |
| **Errors that reach callers** | always `DbConnectionError` with a generic message (`database connection lost (CONNECTION_CLOSED)`); the raw error — the one with the pooler's host and port — is its `cause`, for the server log only. |
| **Poisoned handle** | `getDb()` no longer caches a failed `open()`; `getReadyDb()` already forgot a failed seed. |
| **HTTP** | every route handler is wrapped (`guarded`) so a database outage is `503 DB_UNAVAILABLE` + `Retry-After: 3` (arena state: `ARENA_UNAVAILABLE`), never a 500 and never the driver's words; Admin gets an actionable message ("nothing was changed — retry" / "outcome unknown — check the current state before repeating"). |
| **Browser** | one poll loop, one request at a time, burst-coalesced look-now events, exponential back-off with jitter and `Retry-After` (`arenaPoller.ts`); `api()` has a 25 s deadline so no skeleton can outlive a hung request; Heroes / Leaderboard / Admin / Arena all end in a retry state. |

## Incident 3 — "The server is taking too long to answer" on equip (and on every other page at the same time)

**Symptom (2026-10-15, production).** Equipping an item left the button on "…" until the browser's 25 s deadline ("The server is taking too long to answer. Please try again in a moment."); during those minutes the Events page's
"Recent Champions" also never loaded. Nothing was wrong with the database.

**Root cause (reproduced on real Postgres, then pinned by a regression test).** `POST /api/me/equip` read the settings and the class list (`getSettings()`, `getEnabledClasses()` — cached for 2 s) from **inside** its own
`db.transaction(...)` callback. With the production pool of **one** connection, a cold cache needs a *second* connection while the transaction holds the only one: the read queues behind the very transaction that is waiting for
it, until the transaction timeout (120 s; 45 s in the test) fails it. An equip is rare, so the cache was almost always cold. And because the single connection is held, **every other request on that instance waits behind it** —
measured: an unrelated `GET /api/events/champions` waited 44.7 s behind one deadlocked equip. That is why Events "just loaded".

**Fix.** Everything async that goes through the shared handle (settings, classes, flags, the chain reader) is resolved **before** the transaction opens (`src/app/api/me/equip/route.ts`); the shop, title and paid-reroll
routes follow the same rule. The rule for every route and service: **inside `db.transaction(...)` use only the `tx` you were given.** `tests/security/equip-http.test.ts` fails on the old code (503 after the transaction timeout) when run on the real
driver — `CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1 CLANK_TEST_PG_URL=… pnpm exec vitest run tests/security/equip-http.test.ts` — and the shop / title / paid-reroll suites are run the same way (pool 1 and 4).

## Pool sizing for serverless fan-out

On a serverless host the number that matters is **not** the pool size of one process: every concurrently-warm function instance holds its **own** pool, so

> client connections the pooler must accept = **warm instances × `DATABASE_POOL_MAX`**

and the transaction pooler additionally multiplexes those onto a small `pool_size` of real backends (15 by default). Two ceilings can be hit: the pooler's **client-connection limit**
(Supabase documents 200 on Free / Micro, 400 on Small, 600 on Medium … — read yours in *Project Settings → Database → Connection pooling*) and Postgres's own `max_connections`.

| Warm instances | pool 1 (**recommended**) | pool 2 | pool 4 | pool 8 (the old default) |
|---|---|---|---|---|
| 10 | 10 | 20 | 40 | 80 |
| 25 | 25 | 50 | 100 | 200 |
| 50 | **50** | 100 | 200 | **400** |
| 100 | 100 | 200 | 400 | 800 |
| 200 | 200 | 400 | 800 | 1600 |

**Recommendation: `DATABASE_POOL_MAX=1`** (now also the code default; values above 4 are clamped to 4 with a warning, so a typo cannot become a connection explosion).
It costs nothing the app can feel: the driver already serialises statements (a Gate keeps one statement per connection — no pipelining), a Mumbai ↔ Mumbai round trip is a few
milliseconds, and the hot read (`/api/arena/state`) is cached per instance for 250 ms, so a burst of viewers on one instance is *one* computation. Raising the pool inside one
instance only helps a single process benchmark; it multiplies the fan-out by that factor. If the project ever grows past ~150 simultaneously warm instances on the 200-client plan,
the fix is **Fluid compute / fewer, busier instances** or a larger compute add-on — never a bigger pool per instance.

## Session-level state and advisory locks (audit of the whole code base)

| Feature | Uses | Transaction pooler safe? |
|---|---|---|
| Session advisory locks (`pg_advisory_lock`, `pg_try_advisory_lock`) | **0** | — |
| Transaction advisory locks | **2**, both in `services/lifecycleLock.ts` (`pg_advisory_xact_lock`, `pg_advisory_xact_lock_shared`, key 7300101: exclusive for launch / reset / end season / create season, shared for board finalization) | yes — they live and die with the transaction, which the pooler keeps on one backend |
| `set_config(..., true)` (local) | 1 (`heroVersions.ts`: `clank.allow_class_change`) | yes (transaction-local) |
| `SET`, `SET LOCAL ROLE` (runtime) | none in `src/` (only `scripts/db-inspect.ts`, inside a rolled-back transaction) | yes |
| `LISTEN` / `NOTIFY`, temp tables, `WITH HOLD` cursors, named prepared statements | **0** | — |
| Row locks (`FOR UPDATE` on `arena_state`, hero rows, …) | many | yes — transaction-scoped |

Nothing in the application needs a session pooler. Lock semantics are unchanged by the hotfix; the real-Postgres suites (`lifecycle-postgres`,
`hero-versions-postgres`: launch × launch, launch vs ticks, START/PAUSE races, suspension vs scheduler, finalization vs launch, reroll races) pass.

## Which connection string to use

| Process | Use | Why |
|---|---|---|
| **Vercel (the web app)** → `DATABASE_URL` | **Transaction pooler**, port **6543** | designed for serverless; clients are cheap, a backend is held only while a statement/transaction runs. Requires `prepare: false` and no pipelining — both guaranteed above |
| `pnpm arena:worker` | a **direct** or **session** connection (port 5432) — **never :6543, the worker refuses it** | one long-lived process; it holds a session advisory lock (singleton) and its pool is fixed at 2 (not `DATABASE_POOL_MAX`). See `docs/ARENA_WORKER.md` |
| long scripts (`db:migrate`, backfill, audit) | a **direct** or **session** connection (port 5432) | one long-lived process; keeps its session. Behind a *session* pooler set `DATABASE_POOL_MAX=2` |
| Any process behind a **session** pooler | `DATABASE_POOL_MAX` = 1–2 | each client connection pins a backend; sessions are limited to `pool_size` |

Optional tuning (all have safe defaults, no deploy-time requirement): `DATABASE_POOL_MAX` (1), `DATABASE_QUERY_TIMEOUT_MS` (10000; 0 = off), `DATABASE_TX_TIMEOUT_MS` (120000; 0 = off), `DATABASE_LIVENESS_IDLE_MS` (5000; 0 = off).

## Evidence (scratch Postgres 18 behind a latency + pooler-emulation proxy; nothing touched the live database)

`next start` (production build, one warm instance) → proxy (150 ms round trip) → throwaway Postgres with the full schema, 139 heroes, Arena PAUSED.
The proxy parses the wire protocol: it counts request batches in flight per connection and can (a) swallow a batch that arrives while another is still
unanswered — an **emulation** of the transaction-pooler limitation, not Supavisor itself — and (b) silently drop idle connections.

| | old driver | new driver |
|---|---|---|
| first request of a cold instance — `/api/arena/state` | 41.3 s | **2.0 s** |
| first request of a cold instance — `/api/admin/overview` | 41.1 s | **1.7 s** |
| DB round trips of that cold request | 151 / 136 | **24 / 8** |
| warm `/api/arena/state`, sequential polling (p50 / p95) | 474 / 493 ms | **325 / 490 ms** |
| 50 concurrent `/api/arena/state` | 494 ms | **485 ms** |
| 50 concurrent `/api/admin/overview` (stress; each = 6 sequential statements) | 4.2 s (47 in flight on one connection) | 6.9 s (1 in flight) |
| max database sessions during the run | 6 | **9 (8 + the observer)**, constant across repeated bursts |
| **behind a pooler that loses pipelined batches** — cold state read | **hung (client gave up at 120 s)** | 2.0 s |
| … then 40 sequential polls + 50 concurrent state reads + 50 overview + 180 mixed requests | **0 of 320 answered** (25 s client timeout) | **320 of 320** |
| silently dropped (dead) connection, then a `SELECT` | hung forever | recovered in ≈ 1.6 s (statement timeout 1.5 s, one retry) |
| … a write / a transaction on a dead connection | hung forever | fails in ≈ 1.5 s with a connection error, the next call works |
| Arena status before → after every run | — | PAUSED → PAUSED; arena row, battles, heroes, ledger, seasons, settings unchanged |

Reading the table: removing pipelining trades a little peak throughput under extreme concurrency (statements now wait for a free connection instead of
queueing on a busy one) for never losing a reply; the hot reads (state, polling) are as fast or faster because the stopped-Arena advance no longer opens a
transaction and the seed is gone from the cold path.

## Evidence 2 — incident 2 fixes (scratch Postgres 18 only; nothing touched the live database)

Everything below ran against a throwaway local PostgreSQL 18 cluster behind `tests/support/pgProxy.ts`, which EMULATES the failure modes (a pooler that loses pipelined batches,
connections reset or silently dropped, a pooler that is briefly unreachable, a connection killed at an exact protocol moment such as `BEGIN` or the reply to `COMMIT`). It is **not**
Supavisor; it exercises this driver's reaction to those failures, not Supabase's behaviour.

**A. The reproduction** (`CONNECTION_DESTROYED`): a fresh connection killed during postgres.js's array-type fetch → old driver **2 unhandled rejections**, new driver **0**.
`db-dead-connections.test.ts` fails with three `unhandledRejection: read ECONNRESET` if `fetch_types` is switched back on.

**B. The dead-connection matrix** (`tests/integration/db-dead-connections.test.ts`, 22 tests, real Postgres): idle connection closed before the next SELECT (reset **and** silently dropped) ·
connection destroyed during a SELECT (before the server saw it / after it ran it) · destroyed before `BEGIN` · destroyed inside a transaction · destroyed during `COMMIT` (reply lost / never
sent) · pooler unavailable then recovering · connection-limit rejection (`53300`) · 40 warm instances killed at once. Invariants asserted in every one: no `unhandledRejection` /
`uncaughtException`; a SELECT retried **once**, never twice; a write never replayed (`ambiguous` correct, row applied exactly once); a transaction replayed only if its body never ran
(executed exactly once); the next call works. Result: **22/22**.

**C. The whole suite on the production driver with a pool of ONE** (`CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1`): **124/124 files, 1897/1897 tests** — i.e. nothing in the 62 transaction
sites needs a second connection (a service that queried the outer `db` from inside a transaction would deadlock a pool of one; none does).

**D. Fan-out** (`max_connections=100`, 6 concurrent requests per instance, each a 9-statement group like the arena state):

| Scenario | client connections at the pooler | database backends (peak) | requests OK |
|---|---|---|---|
| 50 instances × pool **1** (recommended) | **50** | 50 | **900 / 900** |
| 90 instances × pool 1 | 90 | 90 | 1620 / 1620 |
| 45 instances × pool 2 | 90 | 90 | 810 / 810 |
| 50 instances × pool **8** (the old default, "accidental") | **400** | 99 (**exhausted**) | **226 / 900** — 406 × `53300` too many clients, 254 × `ECONNRESET`, 14 × `EPIPE` |

(0 stray rejections even while the database refused 400 connections.)

**E. A frozen serverless instance** (SIGSTOP the real `next start` process, the pooler closes or silently loses its sockets, SIGCONT, a **write** is the first thing it does; 5 rounds each):

| | connections killed while frozen | connections silently lost while frozen |
|---|---|---|
| liveness probe **on** (default) | 5/5 writes OK, ≈ 0.1 s | 5/5 OK, **≈ 3.1 s** (the bounded probe finds the dead socket; the write then runs on a fresh one) |
| probe off | 5/5 OK | 5/5 OK, but **≈ 10.1 s** (the statement waits for its timeout; a transaction is saved by the pre-BEGIN retry, a bare write would have failed as ambiguous) |

In every round the note was saved exactly as sent and the server log held no unhandled rejection. (Whether the `close` event is processed before the first request after a thaw is not
deterministic; the probe is what makes the outcome independent of that ordering.)

**F. The 33-minute production-shaped soak** (final code; the harness is a scratch tool, not part of the repository). Three real `next start` instances (production build,
`DATABASE_POOL_MAX=1`, `ARENA_VIEWER_ADVANCE=off`) behind the pooler-emulating proxy, ONE supervised `arena:worker` on a direct path (singleton lock), 30 viewers driven by the **real**
`ArenaPoller` (+ tab-switch bursts), admin reads (overview / game / arena ops), hero page / profile / search reads, leaderboard reads, and 50- / 100-wide state bursts every 3 minutes —
with one injected fault about every 20 s: 22 × all web connections reset, 10 × silently dropped (hang), 8 × pooler unreachable for 2.5–4.9 s, 13 × `pg_terminate_backend`,
6 × one instance's connections killed, 10 × `SIGKILL` + cold start of a web instance, and on the worker 7 × `BEGIN`, 4 × `COMMIT` reply lost, 1 × mid-transaction, 5 × all pool connections, 4 × its lock
connection (18 worker restarts by the supervisor). 90 s warm-up first and a 150 s fault-free tail at the end.

| | result |
|---|---|
| requests | **28,730** (14,946 viewer polls): 27,866 OK · 497 graceful `503` · 358 client timeouts (8 s deadline, every one inside a silent-drop window) · 9 network errors (a `SIGKILL`ed instance's in-flight requests) · **0 other 5xx** |
| **every one of the 864 failures lies inside the window of an injected fault** | **0 unattributable** |
| availability during the fault phase | 96.4 % (one fault per ≈ 20 s, 10 of them hangs) |
| fault-free tail | **1972 / 1972** OK — no client was left poisoned |
| unhandled rejections / uncaught exceptions / absorbed strays, all four server logs | **0 / 0 / 0** (and 0 in the harness itself) |
| latency of OK requests | **p50 126 ms · p95 512 ms · p99 1676 ms**; the slowest (≈ 11.9 s) is a request that met a silently-dead connection, waited the 10 s statement timeout and then succeeded on the retry |
| arena state | p50 128 · p95 516 · p99 1371 ms · admin overview 74 / 308 / 1814 · admin game 362 / 751 / 1840 · heroes page 85 / 240 · leaderboard 51 / 197 / 1118 |
| 50- and 100-wide state bursts (18 of them: clean, mid-fault, tail) | **1400 / 1400 OK**, worst p95 406 ms |
| browser side | never more than **1** live request per viewer; 4,300 look-now events coalesced; 57 stale requests replaced; 411 entered "reconnecting", the **longest streak 8.1 s**, **0** stuck > 120 s, **0** still reconnecting at the end |
| database sessions (sampled twice a second) | **max 5** (nominal 7: 3 web + worker 2 pool + 1 lock + observer); pooler saw ≤ 4 web connections at once |
| pipelining behind the "loses pipelined batches" emulation | `pipelinedBatches 0`, `swallowedBatches 0`, `maxInFlightOnOneConnection 1` |
| secrets / internals in public errors | **0** (no host, port, SQL, driver text) |
| Arena integrity afterwards | 43 battles (40 settled, 3 prepared ahead) · duplicate sequences **0** · overlapping slots **0** · ledger anomalies **0** · `audit_game_lifecycle()` **0 rows** · all 7 integrity checks OK |

Two defects were found by the first soak and fixed before this one (both are pinned by tests): `rewardsReady()` cached a database outage as "rewards not installed" for 30 s
(46 responses were `REWARDS_UNAVAILABLE` after the database had recovered), and a silently-dead connection stalled every request for the full 20 s statement timeout
(longest "reconnecting" streak 24.1 s → now 8.1 s with a 10 s timeout) while the recycle left a draining socket next to its replacement (max sessions 8 → 5).

*Not proven here, and said plainly:* Supavisor itself. The proxy emulates the failure modes; the first deploy should be watched for `database unavailable` log lines and `[db] stray connection rejection absorbed` (expected: none).

## Diagnosing it again

Read-only, safe on production (`pg_stat_activity` shows only your own role's sessions on small plans):

```sql
select application_name, state, wait_event_type, count(*), min(backend_start), min(xact_start)
  from pg_stat_activity where datname = current_database() group by 1, 2, 3 order by 4 desc;
select count(*) from pg_locks where not granted;            -- row/advisory lock waits
```

A healthy picture is a handful of `Supavisor` sessions, no `idle in transaction`, zero ungranted locks. If requests hang while that is true, the problem is on the
client / pooler path (look at the function logs for `DbConnectionError` / `CONNECTION_TIMEOUT`, which the driver now raises within 20 s instead of hanging).
