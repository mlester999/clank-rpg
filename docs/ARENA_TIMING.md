# Arena battle transitions — what was wrong, what changed, what production needs

The Global Arena is **server-authoritative**: every viewer sees the same battle, the same eight fighters and the same
countdown, all derived from the server clock. This document covers the seam between two battles — the moment the
5-second results screen ends and the next eight heroes must appear.

## Second pass (2026-10-05): "the new battle appears already 10 seconds in"

The fix below made the results → next-battle flip a pure clock read **when the next battle was already prepared**. It was
prepared in the few seconds between the previous fight ending and its results ending — a window of ≈ 6.2 s — and on a
database 100–250 ms away that is not enough. This pass measured it end to end instead of assuming it.

### How it was measured

`src/components/arena/telemetry.ts` records, on the **synced server clock** and at React commit: the snapshot that first
contained the battle, the first roster render, the countdown 3 / 2 / 1 renders and the first combat frame
(`window.__clankArena.reports()`), and separates a viewer who was **watching** (tab visible throughout) from one whose tab
was **hidden/throttled** across the boundary (`viewer: "foreground" | "recovered"`). The server logs each arena step
(`CLANK_ARENA_TIMING_LOG=true`: duration, and how far *before its planned start* a battle was made ready). Both run against
a real PostgreSQL 18 (a throwaway cluster, not the embedded PGlite — PGlite has one connection, so an open settlement
transaction blocks every reader, which made the first reading 9–12 s and was an artefact) with a fixed per-statement delay
(`CLANK_DEV_DB_LATENCY_MS`, now honoured by the Postgres driver too; ignored in production).

### Where the seconds went (120 ms per statement, before)

| Step | Cost | Consequence |
| --- | --- | --- |
| Settlement (≈ 77 statements) | 9.3 s | longer than the whole results window |
| **Preparing the next battle** | 1.4 s, **but skipped when a hero was in both rosters** | the prepare-ahead step refused to run, so it waited for the entire settlement and finished **3.1 s and 4.8 s after the battle's planned start** (2 of 8 boundaries) — viewers joined mid-intro, or mid-fight at higher latency |
| Building the state snapshot | ≈ 12 sequential queries | even when prepared in time, 3 of 5 boundaries showed the roster **0.8–0.95 s late** |
| Browser: render, countdown, sprites | negligible | countdown 3 / 2 / 1 landed at 2.53 / 3.53 / 4.53 s; first combat frame within 40–70 ms — **the client was not the problem** |

Roster visible after the boundary: **125, 878, 952, 814, 87 ms**, with two battles prepared late. (With 250 ms per statement
the settlement alone is 19 s, so the overlap case is ~13 s late: the reported "joins with 20 s left".)

### The fix

* **Prepare the next battle as soon as it exists** (`stepArena` R0): it is simulated and persisted right after it is lined
  up — a whole battle (17–36 s) before its slot, not in the results window. The "no hero in both battles" guard was removed:
  a fighter is built from stat rows, equipped gear, claim and tactic, none of which settlement changes (loot arrives
  unequipped; achievements grant badges, titles and gold). Prepared first, settled after — the order is unchanged.
* **A battle that cannot be ready before its planned start moves its OWN start** to just after it is ready (margin = three
  measured statement round trips), once, on the server, for everyone — so no viewer can join a battle already underway.
  A battle prepared ahead that waited behind a stalled arena (its whole slot passed) has its timeline shifted to "now"
  instead of being settled unseen. Nothing is faked per viewer; there is still exactly one battle at a time.
* **The public snapshot builds in ≈ 3 round trips**: independent reads run together, classes are cached, flag refills are
  shared (guarded by a test that counts sequential statement waves).
* **Client**: requests time out (a hung connection cannot freeze the poll loop), the viewer resyncs on focus / `pageshow` /
  `online` as well as `visibilitychange`, and the photos of the fighters in a snapshot start downloading the instant it
  arrives (the panel loads them eagerly). The next battle's roster is **not** exposed early: it is not needed — the
  held request answers at the boundary, and sprite atlases (class-level, not hero-level) already load once at page mount.

A bug introduced and caught on the way (kept here as a warning): evaluating "is a battle already prepared?" over only the
two oldest unsettled battles let a prepared battle go unnoticed as soon as an older one occupied those slots, and the arena
scheduled a runaway chain of battles. The queue is now gated on ALL unsettled battles (`tests/integration/arena-transition`,
"the queue gate").

### Measured after (real Postgres, a viewer watching continuously, consecutive boundaries)

| per-statement delay | boundaries | roster visible after the boundary | countdown 3 / 2 / 1 | first combat frame | next battle made ready |
| --- | --- | --- | --- | --- | --- |
| 120 ms | 8 | 32–69 ms (one at 272 ms) | 2.53 / 3.53 / 4.53 s | 31–152 ms into combat | 17–36 s ahead |
| 250 ms (settlement 19 s) | 9 | 36–53 ms | 2.55–2.61 / 3.54–3.61 / 4.55–4.61 s | 44–109 ms into combat | 9.7–26 s ahead |

No boundary showed a foreground viewer more than 152 ms into combat at its first frame. Targets: results → roster < 250 ms
(7 of 8 and 9 of 9; one 272 ms), drift < 500 ms hard (all).

### Foreground vs backgrounded

A tab the browser has frozen or throttled across a boundary cannot be helped: everything on screen is a pure function of the
synced server clock, so on return one fresh snapshot puts it in the LIVE battle at the authoritative time — it never
rewinds or restarts the battle and never replays the opening. Telemetry records it as `viewer: "recovered"`, not as lag.
Tests: `tests/unit/arena-viewer-sync.test.ts` (clock offset, opening instants, held-answer lateness model, mid-battle
refresh, frozen-tab resume, foreground/recovered classification), `tests/integration/arena-transition.test.ts`.

## The bug

After the results screen reached `NEXT BATTLE IN 0 SEC` it could sit there for several seconds before the next battle
appeared.

### Measured (read-only probe, `pnpm arena:probe`)

14 simulated viewers using the browser's polling rules against a real dev server, 5 consecutive battle boundaries.
"Dead time" = the moment a viewer receives the next battle − the previous battle's `slotEndsAt` (i.e. how long they
looked at `0 SEC`). The embedded database was given a fixed 30 ms per statement (`CLANK_DEV_DB_LATENCY_MS=30`) to behave
like a hosted Postgres seen from a serverless function.

| | p50 | p95 / max | viewers stuck > 1 s | stale responses at the boundary |
|---|---|---|---|---|
| **Before** (30 ms DB) | **7,038 ms** | 7,315 ms / 7,317 ms | **70 of 70** | **42** |
| Before (0 ms DB, local; stale reads not yet instrumented in that run) | 233 ms | 3,498 ms / 6,657 ms | 14 of 70 | n/a |
| **After** (30 ms DB, quiet machine, final code) | **18 ms** | 186 ms / 187 ms | **0 of 70** | **0** |
| After, in a real browser (0 ms DB, 6 consecutive boundaries) | 42 ms | 64 ms max | 0 | 0 |

Per boundary in the final run: four boundaries at 12–20 ms (p50), one at 184 ms (all 14 viewers: 50–187 ms). An earlier
"after" run that overlapped with file writes (which make the Next dev server recompile) had one boundary at ~770 ms; it is
kept here rather than hidden — treat dev-server probe numbers as ±200 ms and re-measure on the real host.

### Root cause (three compounding problems)

1. **The next battle was simulated lazily, on the critical path.** Its roster was known ~30 s earlier (it was
   `SCHEDULED`), but the simulation + persistence only ran when the *first request after its start time* arrived. That
   request then also scheduled the battle after it. Measured: ≈ 77 statements for settle + simulate and ≈ 42 for the
   first-advance chain; at 30 ms per statement that is **1.4–4 s of server work with every viewer waiting on it**.
2. **Stale snapshots at the boundary.** The state endpoint cached its answer for 250 ms and the advance step was
   re-used for 400 ms. Both windows straddle the boundary, so viewers who asked right after the slot ended were handed
   the *previous* battle again (42 stale responses in the "before" runs).
3. **A 5 s retry after a stale answer.** The client's polling rule only had one speed once a slot had passed: the 5 s
   idle cadence. A stale response therefore cost 5 s more, which is why the dead time was ≈ 7 s (≈ 1.4 s slow response
   + 5 s wait).

(An outage also exposed a fourth, rarer defect: a battle that was already `SCHEDULED` when the arena stalled was
simulated with its old, long-gone start time and settled instantly, unseen — a skipped battle. Observed once during
measurement after a ~96 s host suspension. Fixed as part of this change.)

## The fix

### Server

* **Prepare the next battle before the results screen ends** (`stepArena`, `src/server/services/arena.ts`).
  When the finished battle is due to settle, the next one is simulated **first** (if no hero is in both) and
  persisted with its future `starts_at`; settlement (rewards, season points, loot, picks) follows. The prepared
  battle is invisible: the public state shows a battle only once `starts_at` has passed, and the replay stays withheld
  until combat starts. Only **one** battle is ever queued ahead (the battle after it is lined up when the prepared one
  takes the stage), so season rollovers and admin changes take effect exactly as before.
* **The flip is a pure clock read.** `getArenaState(now)` is a function of the clock and persisted rows; at the
  instant the slot ends the prepared battle simply becomes `current`. No simulation, no scheduling, no write.
* **Outage recovery.** A `SCHEDULED` battle whose planned start is more than `arena.staleAnchorMs` in the past is
  re-anchored to "now" before it is simulated, so it is watchable instead of being settled unseen.
* **No stale snapshots** (`src/domain/arena/boundary.ts`, `/api/arena/state`). A cached snapshot is never served —
  or kept — across a phase boundary that has passed; the advance step is never re-used across a transition that has
  fallen due (`dueAtMs`).
* **Held request at the boundary** (`GET /api/arena/state?hold=<epoch ms>`). A viewer whose results timer is about to
  end sends one request timed to arrive just before the boundary and asks to be answered *at* it. The server builds the
  snapshot **for that future instant** while it waits (it is a pure function of the clock) and answers when the clock
  reaches it. Safeguards: only the real new-battle boundary of the last snapshot is holdable (±150 ms), never longer than
  1.5 s, and the next roster is **not** published early — the answer is sent at the boundary, not before.
* **A state read never waits for work that is merely in progress — above all never for a settlement**
  (`advanceForRead`, `src/server/runtime.ts`). Settlement is bookkeeping (≈ 77 statements); the battle on stage, the
  prepared next battle and the placements are already persisted, so a read answers at once and the advance (settling,
  lining up the following battle, locking picks) runs in the background. A read waits only where it cannot answer
  correctly otherwise: a cold process (capped at 1.5 s, then it answers from the persisted rows) or an arena nobody has
  advanced for 10 s with nothing in flight (outage recovery). The client learns settlement is still pending from
  `current.status === "SIMULATED"` after combat ends and looks again every 500 ms until the rewards exist
  (see "Follow-up" below for why).
* **Worker** sleeps until the next transition is due (`dueAtMs`), at most 1 s, instead of ticking blindly.
* `serverReceivedAt` is stamped next to `serverTime`, so clients do an NTP-style clock sample that is immune to slow or
  deliberately held responses (a slow cold-start sample used to skew the first clock estimate by up to half its
  round trip).

### Client (`src/components/arena/pollSchedule.ts`, `useArena.ts`, `ArenaScreen.tsx`)

* The held request is sent early enough for the server to build the boundary snapshot: its lead is
  `rtt/2 + max(500 ms, 1.5 × typical server build time + 250 ms)`, capped at 1.4 s (so it adapts to a slow database).
* One planned, held request per boundary; if the next battle is nevertheless late the retry backoff is
  250 → 400 → 650 → 1000 → 1500 ms — **never the 5 s idle cadence** once a slot has ended.
* The results line reads `NEXT BATTLE IN n SEC` → `NEXT BATTLE STARTING…` (a few ms at zero) → only if the backend is
  genuinely > 1.2 s late, `PREPARING NEXT BATTLE…`. Under healthy operation the last state is not seen
  (0 occurrences in 6 consecutive browser boundaries).

### What is deliberately *not* done

* No client-authoritative timing, and no arbitrary extra seconds anywhere.
* The next roster is never exposed early (not even hidden in the payload): the held-request design needs no early data.
* Picks, replay gating and the "no exploitable outcome before combat starts" rules are unchanged (tests below).

## Follow-up: the one failing test, and what it was really telling us

After the first version of this change, `tests/security/arena-boundary-http.test.ts` failed once in the full suite
(`max dead time` 1,422 ms against a bound of 800 ms) and passed 6 of 6 times in isolation, even under 8 CPU burners.
Reproduced deterministically by slowing the per-statement latency of that test's database (15 ms → 22 ms: p50 10 ms →
1,029 ms; 30 ms: 1,379 ms, matching the failure). Traces at 30 ms showed **no held request was ever sent** and every
viewer's ordinary poll sat for 3–4 s inside `advanceForRead` waiting for the advance.

* **Root cause (runtime, genuine):** the first version let a state read wait for a *due settlement* (and for any
  advance older than 2 s). Settlement is ≈ 77 statements. Whenever it outlasts the victory-beat + results window — a
  slow database or a loaded host — every viewer's own request was queued behind it at the moment the next battle was
  due, and because the viewer loop is sequential the held request could not even be sent. The dead time equals the
  overrun. Reads must not depend on settlement duration at all; that is fixed (above) and guarded by the deterministic
  test.
* **Amplifier (test environment only):** the in-process database (PGlite) has a *single* connection, so an open
  settlement transaction blocks every other query. Measured: a plain `select 1` issued mid-settlement waited 1,405 ms
  (vs ~20 ms). Production uses a pooled Postgres client (`max: 5`, `sql.begin` reserves one connection) where readers
  are not blocked by a writer, so this part cannot occur there. It does mean a real-time PGlite test is only meaningful
  when settlement fits inside the window; the test now uses production's 6.2 s window against ≈ 1 s of settlement (it was
  2.9 s against 1.4 s, a 2× margin that a busy test machine could erase). No assertion bound was loosened.
* With the fix, the original tight configuration improved but cannot be made to pass at 22–30 ms purely by runtime
  changes (22 ms: p50 10 ms, max 973 ms; 30 ms: p50 1,386 ms) — the remainder is PGlite's lock, shown above.

## Production requirement — is `pnpm arena:worker` needed?

**Yes, for continuous operation.** The arena only advances when something calls `advanceArena()`:

| Driver | Behaviour |
|---|---|
| Viewers (browser tabs) | Advance it while at least one tab is open. With the fix above this is enough for a seamless transition. When the last viewer leaves, **nothing advances**: battles stop, XP/Gold/season points stop accruing, and the first visitor after a gap finds a re-anchored battle (missed battles are not replayed in a burst). |
| `/api/internal/tick` on a scheduler | Vercel Cron on Hobby is **once a day**; a 1-minute cron keeps the arena roughly alive but cannot hit the 6 s window between a battle ending and the next starting. Use it for the slow jobs (`?scan=1`, `?trades=1&holdings=1`, `?photos=1`), not as the arena clock. |
| **`pnpm arena:worker`** on an always-on host (Fly, Railway, a VPS — same region as the database) | Advances exactly when a transition falls due, independent of any browser. **This is the production requirement for "the Global Arena runs on its own".** Safe to run next to the web app and even in two copies (row-locked); restart-safe (see tests). |

Minimum production setup: web app (serverless is fine) + **one** `pnpm arena:worker` + the 1-minute `/api/internal/tick`
for the slow jobs. The worker needs `DATABASE_URL` and nothing Telegram- or chain-related.

Latency budget (statements counted from the real code, `settle` and `prepare` each run in their own transaction):
*prepare* = **13 statements**, *settle* = **77 statements**, a state read = 9. After a battle's combat ends *prepare* runs
first, so the next battle is persisted after ≈ 13 × (per-statement latency) — well inside the 6.2 s victory-beat +
results window for any plausible database (even 150 ms per statement ≈ 2 s). *Settlement* then finishes at ≈ 90 × latency;
up to ~65 ms per statement it also finishes inside the window, and beyond that it completes after the flip without
anyone waiting (the only visible effect is the XP-less "+Gold" line on the results card arriving a little later).

## Known remaining variance

* Roughly one boundary in five can be ~150–200 ms instead of ~15 ms on a dev server (the held request's snapshot was not
  usable and the answer was rebuilt after the boundary). It is still ~35× better than before and never reaches the 1.2 s
  point where the label would change to "Preparing next battle…". In the in-process real-time test (40 held boundaries)
  there were 0 fallbacks.
* If the arena is unattended (no worker, no viewers) while a battle is already on stage or prepared, that one battle is
  settled without being watched when the arena next advances. Nothing *waiting* is ever skipped.

## Tests

* `tests/unit/arena-boundary.test.ts` — boundary rules, hold validation, polling plan (no 5 s gap, no double hold),
  labels, clock-offset recovery under skew and slow samples.
* `tests/integration/arena-transition.test.ts` — next battle prepared before the 5 s result phase ends; zero-second flip
  without an advance; no roster / winner / replay / pick leak while it waits; no duplicate or skipped battle across 7
  consecutive battles (gapless, never overlapping); six concurrent advancers at the seam produce exactly one next
  battle; worker restart; 90 s outage recovery; `dueAtMs` reporting.
* `tests/security/arena-reads-never-wait.test.ts` — **deterministic**: parks the advance "in flight" forever (an
  infinitely slow settlement) after combat has ended and requires that state reads still answer at once, that the results
  carry `SIMULATED` until it completes and then the rewards, that a cold process waits at most the cap, and that an
  outage still triggers a recovery advance. (Verified to fail — hang — against the old wait-for-settlement rule.)
* `tests/security/arena-boundary-http.test.ts` — real time, real route handler, 10 ms-per-statement database and
  production's own 6.2 s victory-beat + results window, 4 viewers ×
  4 boundaries: p50 < 250 ms, max < 800 ms, identical battles and rosters for everyone, held-request path exercised;
  an older client that does not use the held request never gets the previous battle again.
* Probe: `pnpm arena:probe -- --url http://localhost:3711 --rounds 5 --viewers 14` (GET-only; safe against production, keep
  `--viewers` small there).
