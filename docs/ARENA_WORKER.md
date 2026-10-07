# The Arena worker — who advances the Arena, and how to run it

> Code: `scripts/arena-worker.ts` (the worker), `src/server/db/postgres.ts` → `acquireSessionLock` (the singleton lock),
> `src/server/runtime.ts` → `advanceForRead` / `advanceForPage` (the viewer switch), `src/server/services/arenaHealth.ts` (the "is it moving?" signal).
> Tests: `tests/integration/arena-worker-singleton.test.ts`, `arena-viewer-readonly.test.ts`, `arena-health.test.ts`.

## The architecture for launch

```
                         ┌──────────────────────────────┐
 browsers ──► Vercel ──► │ web app (Mumbai functions)   │ ──► Supabase TRANSACTION pooler :6543 ──┐
 (read only)             │ DATABASE_URL = …:6543        │       DATABASE_POOL_MAX=1                │
                         │ ARENA_VIEWER_ADVANCE=off     │                                          ▼
                         └──────────────────────────────┘                                   Supabase Postgres
                         ┌──────────────────────────────┐                                          ▲
 supervisor ──► ONE ───► │ pnpm arena:worker            │ ──► DIRECT connection (or session pooler :5432)
 (systemd/Fly/Railway)   │ DATABASE_URL = …:5432        │       session advisory lock = "I am THE worker"
                         └──────────────────────────────┘
```

* **The web tier only reads.** With `ARENA_VIEWER_ADVANCE=off`, `GET /api/arena/state` (plain, `?hold=`) and the home-page render never create, prepare, settle or lock
  anything and never move a phase: not one INSERT / UPDATE / DELETE / `FOR UPDATE` / `BEGIN` on that path (proved by `arena-viewer-readonly.test.ts`). A viewer's
  request costs the cached public state plus a handful of plain `SELECT`s, and a database that is slow or briefly gone can never stall the game — only the display.
* **The worker advances the Arena** — prepares and simulates the next battles ahead of time, locks Picks at the moment their window closes, settles battles, scores
  Picks, finalizes the Daily / Weekly boards and re-verifies due holder wallets. It sleeps until the next transition is *due* instead of ticking blindly.
* **Admin actions still kick one advance** (START / RESUME → "make battle #1 ready now") and the scheduler tick (`/api/internal/tick`, Vercel Cron) still advances
  once a minute as a safety net. Both are single, row-locked, idempotent steps: they are not "viewers driving the game".

### What changes the day the worker goes live (an operational step — NOT done by this code change)

| Step | Where | What |
|---|---|---|
| 1 | a persistent host | run `pnpm arena:worker` under a supervisor that restarts it on exit, with `DATABASE_URL` = the **direct** connection (`db.<ref>.supabase.co:5432`) or the **session pooler** (`…pooler.supabase.com:5432`). **Never** `:6543`. |
| 2 | check | the log says `singleton lock HELD`; `GET /api/health` → `arena.stalled: false`; the Admin → Arena panel shows the worker `HEALTHY` |
| 3 | Vercel env | set `ARENA_VIEWER_ADVANCE=off` (and redeploy). From now on viewers are read-only. |
| rollback | Vercel env | unset `ARENA_VIEWER_ADVANCE` → viewers advance the Arena again, exactly as before (the worker may keep running: it is safe next to them). |

**Until step 3 the default is unchanged** (`ARENA_VIEWER_ADVANCE` unset ⇒ viewers still kick the coalesced advance). Do not set `off` before the worker runs: the Arena would
stop moving the moment nobody else advances it (the scheduler tick alone moves it once a minute — too slowly for ~40 s battles).

## One worker only — and how that is enforced

At start the worker opens a **dedicated** connection and takes a **session-level advisory lock** (`pg_try_advisory_lock(7300110)`, `ARENA_WORKER_LOCK_KEY`).

| Situation | Result |
|---|---|
| a second worker starts (same database) | `pg_try_advisory_lock` is atomic: it gets `false`, prints `ANOTHER Arena worker already holds the lock`, **exits 3** without doing any work |
| five workers started at the same instant | exactly one runs, four exit 3 (tested with real processes) |
| the winner's connection dies (failover, network, `pg_terminate_backend`) | its heartbeat (every 5 s) sees the lock is no longer held by its own backend → prints `LOCK LOST`, **exits 4** (never carries on unprotected). The supervisor restarts it; the lock is free by then |
| `DATABASE_URL` is the transaction pooler (`:6543`) | **exits 2** at once: a session lock cannot live behind a transaction pooler (the backend is handed to other clients between statements) |
| SIGTERM / SIGINT | finishes its current tick, releases the lock, **exits 0** |
| embedded PGlite (local dev) | no lock (a single process owns the embedded database anyway) |

The heartbeat verifies `pg_locks.pid = pg_backend_pid()` — the lock must be held by *the backend that answers the question*. That is also what catches a pooler that
silently switches backends, so a mis-pointed `DATABASE_URL` cannot yield two "protected" workers.

**Belt and braces:** every Arena step is its own row-locked transaction (`select … from arena_state for update`), so even a second worker that somehow ran could not
duplicate a battle, a settlement or a ledger entry — the lock keeps the *work*, the logs and the reward sweeps single, and the real-Postgres lifecycle suites
(`lifecycle-postgres`, `hero-versions-postgres`) pin the row-lock guarantees independently.

### Exit codes

| code | meaning | supervisor action |
|---|---|---|
| 0 | stopped by SIGINT/SIGTERM | none (it was asked to stop) |
| 1 | fatal error (e.g. cannot open the database at all) | restart with a delay |
| 2 | refused: transaction-pooler URL | **fix `DATABASE_URL`** (restarting will not help) |
| 3 | another worker holds the lock | expected for a duplicate; do not restart in a tight loop |
| 4 | the lock was lost | restart (a replacement takes over cleanly) |

### Resilience inside the worker

* Its database handle is the same hardened driver the web tier uses (`createPostgresDb`): statement timeout 30 s, transaction cap 120 s, stale-idle liveness probe, a thrown-away
  pool on any connection failure, a pure `SELECT` retried once — and a write that loses its reply is **never** replayed by the driver.
* A failing tick (database down, pooler restarting) is logged and retried with exponential back-off, 1 s → 30 s (`advance failed (N in a row; retrying in …)`), then
  `recovered after N failed tick(s)`. It does not hammer a recovering database, and it does not exit.
* It installs the rejection guard in *rethrow* mode: a connection-class stray from a library is logged and counted; any other unhandled rejection crashes the worker
  (exactly as Node does by default) so the supervisor restarts it.

## Knowing it is moving

`GET /api/health` (public, no secrets) returns

```json
{ "ok": true, "arena": { "status": "RUNNING", "settleOverdueMs": 0, "queueDryMs": 0, "stalled": false, "advancedBy": "worker" } }
```

`stalled` turns `true` when something that was *due* has waited more than 30 s: a decided battle still unsettled (`settleOverdueMs`) or a RUNNING Arena with no battle
covering "now" (`queueDryMs`). A stopped Arena (NOT_STARTED / PAUSED) is never stalled. Point an uptime monitor at it and alert on `arena.stalled`. The Admin → Arena
panel shows the same worker health (`HEALTHY` / `STALE`) from `last_advance_at`.

## Audit: was `pnpm arena:worker` already the right production worker?

Almost. Its *loop* was right (sleep until the next transition is due, settle, score Picks, finalize boards, verify holders), but four things made it unfit to be THE production worker:

| Before | Now |
|---|---|
| "Safe to run … even multiple copies" — nothing stopped two (or ten) from running, each doing the same work and sweeps | **singleton session lock**; a duplicate exits 3, a lost lock stops the worker (exit 4) — tested with real processes |
| default driver options: pool 8, **no statement / transaction timeout**, no liveness probe | pool 2, statement timeout 30 s, transaction cap 120 s, stale-idle probe — a dead connection costs one tick, never a hung worker |
| a failed tick was retried every second, forever | exponential back-off 1 s → 30 s, `recovered after N failed tick(s)` |
| accepted any `DATABASE_URL` — including the transaction pooler | refuses `:6543` (exit 2); the lock is verified against the answering backend |

Its database access is the same `createPostgresDb` the web tier uses (`fetch_types: false`, no pipelining, replay rules): in the soak the worker survived killed pool connections, `BEGIN` / `COMMIT` / mid-transaction faults, `pg_terminate_backend` and lock loss (see `docs/DATABASE_CONNECTIONS.md` § Evidence 2) with **no duplicate battle, settlement or ledger entry**.

## What this change did NOT do

Nothing live was changed: no deploy, no env change on Vercel, no worker started anywhere, the Arena's status and Season 1 untouched. The switch ships **off by
default**; flipping it is step 3 above, after the worker is running.
