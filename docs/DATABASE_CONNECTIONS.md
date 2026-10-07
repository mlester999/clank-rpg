# Database connections on serverless hosting (Supabase poolers)

> Incident write-up and the rules the driver now enforces. Code: `src/server/db/postgres.ts` (driver), `src/server/db/index.ts` (the one shared handle),
> `src/server/seed/reference.ts` + `src/server/runtime.ts` (cold start). Tests: `tests/integration/db-serverless-driver.test.ts`, `seed-fast-path.test.ts`.

## What production did

| Pooler | Symptom |
|---|---|
| Session pooler (port 5432) | `EMAXCONNSESSION — max clients reached in session mode` |
| Transaction pooler (port 6543) | the error went away, but `/api/admin/overview` → Vercel **504 after 60 s**, `/api/arena/state` → **504 after 300 s**; the Admin page worked briefly, then every database route hung again |

The database itself was healthy during the hang (read-only check of `pg_stat_activity`: 12 of 60 connections, no transaction older than a second, no ungranted
locks). The requests were waiting for answers that never came.

## Root causes

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

## What the driver guarantees now (`createPostgresDb`)

* **No pipelining, by construction.** `max_pipeline` cannot switch it off (`0` breaks `sql.begin`, `1` still allows two in flight), so a **Gate** keeps the number
  of running statements/transactions at or below the pool size — every one gets a connection of its own — and the statements *inside* a transaction run strictly
  one after the other, even under `Promise.all`. Verified with a protocol-level proxy: `maxInFlightOnOneConnection = 1`, `pipelinedBatches = 0`.
* `prepare: false` (unchanged) — no named prepared statements.
* **Bounded waits.** `DATABASE_QUERY_TIMEOUT_MS` (default 20 000) per statement, including the BEGIN and COMMIT/ROLLBACK that postgres.js issues itself;
  `DATABASE_TX_TIMEOUT_MS` (default 120 000) per whole transaction. A statement that does not answer is treated as a dead connection: the pool is thrown away
  (the next call connects afresh) and the call fails with a connection-class error. A pure `SELECT` outside a transaction is retried **once** on the new pool;
  anything that may have written (`insert/update/delete`, `FOR UPDATE`, `nextval`, advisory locks, `set_config`, …) is never repeated.
* **Small, bounded pool.** `DATABASE_POOL_MAX` (default 8; idle connections close after 10 s, a connection lives at most 15 min). One shared handle per process
  (`globalThis`), created lazily; there is no per-request client anywhere (`getDb()` is the only constructor call).
* **Cold start is one statement.** `seedReferenceData` first asks, in one query, whether anything at all is missing; only then does the full pass (unchanged:
  insert what is missing, never overwrite an admin's edit) run. A failed or timed-out seed is forgotten so the next request retries it.
* **A stopped Arena costs one plain read.** The viewers' coalesced advance (`advanceForViewers` in `runtime.ts`) answers NOT_STARTED / PAUSED from a single
  `SELECT status` — no transaction, no lock. Every state that can advance (PREPARING / RUNNING / PAUSE_REQUESTED) still goes through the locked gate in
  `stepArena`, and the worker / scheduler call `advanceArena` exactly as before. `GET /api/arena/state` never writes anything while the Arena is stopped.

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
| `pnpm arena:worker`, long scripts (`db:migrate`, backfill, audit) | a **direct** or **session** connection (port 5432) | one long-lived process; keeps its session. If you do put a worker behind a *session* pooler set `DATABASE_POOL_MAX=2` |
| Any process behind a **session** pooler | `DATABASE_POOL_MAX` = 1–2 | each client connection pins a backend; sessions are limited to `pool_size` |

Optional tuning (all have safe defaults, no deploy-time requirement): `DATABASE_POOL_MAX`, `DATABASE_QUERY_TIMEOUT_MS` (0 = off), `DATABASE_TX_TIMEOUT_MS` (0 = off).

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

## Diagnosing it again

Read-only, safe on production (`pg_stat_activity` shows only your own role's sessions on small plans):

```sql
select application_name, state, wait_event_type, count(*), min(backend_start), min(xact_start)
  from pg_stat_activity where datname = current_database() group by 1, 2, 3 order by 4 desc;
select count(*) from pg_locks where not granted;            -- row/advisory lock waits
```

A healthy picture is a handful of `Supavisor` sessions, no `idle in transaction`, zero ungranted locks. If requests hang while that is true, the problem is on the
client / pooler path (look at the function logs for `DbConnectionError` / `CONNECTION_TIMEOUT`, which the driver now raises within 20 s instead of hanging).
