# Arena Picks lifecycle — picks are made on the UPCOMING battle

*Status 2026-10-05 — implemented, tested, browser-QA'd on a scratch database. NOT committed, NOT deployed, migration `20261005001500` NOT applied anywhere but scratch/test databases.*

The Arena Picks panel used to list the eight heroes **already fighting** and lock when their combat started (a 5.5 s window in which they stood idle). It is now a rolling prediction queue:

```
battle A on stage ── picks for battle B OPEN ── A's winner is DECIDED ── B's picks LOCK ── A's results ── 3·2·1 ── B on stage
                                                                                                   └─ picks for battle C OPEN …
```

Everything below is decided **on the server**; the browser only displays it.

## 1. Why the current fighters were appearing in the panel

`getArenaState` published one battle — `current`, the latest battle whose `starts_at` had passed — and the panel (`CurrentRound`) was fed `state.current.fighters`, the Picks hook was keyed on `state.current.id`, and the server accepted a pick only for the battle on stage, locking at its `combat_starts_at`. The *next* battle's roster was deliberately never published ("players discover who is fighting when the eight appear"). So "pick" and "watch" targeted the same battle.

## 2. Architecture: `current` and `upcoming` are two explicit objects

`GET /api/arena/state` (and the server-rendered first paint) now carries:

| field | meaning |
| --- | --- |
| `current` | the battle on stage (fight, results). **Never a pick target.** Unchanged shape. |
| `upcoming` | the battle that fights next: `{ id, startsAt, fighters[8], picks: { status, mode, lockReason, locksAt, lockedAt } }` — **the only pick target** |
| `next` | timing only (`{ id, startsAt }`) — also present while the upcoming roster is still being prepared |
| `picks` | `{ enabled, rewardGold, reward }` — flags and display copy inputs, nothing per-battle |

* `upcoming.fighters` is identity + POWER only (`characterId, name, classId, title, isDemo, claimed, power, appearance, avatarUrl`). **Never** slot, HP, start position, placement, winner, events, seed or replay — the outcome is already persisted in the database at preparation time, so none of it is published before the fight (asserted by key in `tests/integration/arena-transition.test.ts`, `tests/security/picks-http.test.ts`).
* It rides on the **same snapshot** as the arena (the same cached, boundary-aware `/api/arena/state`) — no second endpoint, no second polling loop. The roster read is issued in the same parallel wave as the current battle's: +1 statement, no extra round trip (see §11).
* The shared payload stays viewer-independent: no per-member data, **no crowd counts** (anti-herding). "My pick" and "the crowd once locked" come from `/api/arena/picks?battleId=`.
* The battle *behind* the upcoming one is never published at all.

Because `current` and `upcoming` come from one snapshot, the panel moves from battle B to battle C in the **same render** in which the arena moves from A to B. There is no frame in which the panel treats the battle on stage as the pick target (verified, see §12).

## 3. The Pick-OPEN rule

Implemented once, as a pure function — `src/domain/arena/picksWindow.ts` — used by the pick service, the public state, the arena's lock step and the tests, so display and enforcement cannot drift.

The window of the upcoming battle **B** is **OPEN** while all of these hold:

1. B is **prepared**: simulated and committed (`status = SIMULATED`). Its roster is final and is exactly who will fight.
2. B has not been stamped closed (`arena_battles.picks_locked_at is null`).
3. B is the **next fight**: its predecessor has taken the stage (a battle queued behind the upcoming one answers `NOT_OPEN`).
4. B's predecessor's result is **not decided** yet.
5. B has not taken the stage itself (`now < B.starts_at`).

It opens the instant B is prepared *and* its predecessor takes the stage — the whole of A's intro + 3·2·1 + combat (≥ 5.5 s even for a very fast fight).

## 4. The Pick-LOCK rule

B's window **closes exactly once**, at the first of:

* **the predecessor is DECIDED** — it is no longer `SIMULATED` (settled/voided) **or** the server clock has reached its persisted `combat_ends_at`, the instant the server itself publishes that battle's winner (`state.current.results` appears then). Reason `PREDECESSOR_DECIDED`;
* **B takes the stage** (`now ≥ B.starts_at`) — reason `OWN_START` (also the fallback, §6);
* **B is voided** — reason `VOID` (§8).

The close moment recorded is the **deciding instant** (`A.combat_ends_at`, `B.starts_at`), not "whenever the arena got round to writing it": a slow worker cannot make a window longer than it was, and every writer stamps the same value (`tests/integration/picks.test.ts`: the stamp equals `combat_ends_at` even when written 5 s late).

"Decided" is `combat_ends_at`, not "the settlement transaction committed", on purpose: settlement is bookkeeping (≈ 77 statements — seconds on a hosted database) and viewers see the winner at `combat_ends_at`. Tying the lock to the commit would leave "PICKS OPEN" on screen under a visible winner. The settlement transaction nevertheless **also** closes the window (§5), so the guarantee does not depend on the lock step.

The browser may close the panel *earlier* than its last snapshot said (its synced clock passed the server's `locksAt` — a timer fires at that exact instant), never later, and never shows OPEN for a snapshot the server marked LOCKED.

## 5. Database / server enforcement

* **Migration `20261005001500_arena_picks_upcoming.sql`** (additive; apply BEFORE deploying the code — the code reads the new columns):
  * `arena_battles.picks_locked_at`, `picks_lock_reason` (+ a pair CHECK) and a trigger that **refuses to move or clear them** → a window closes exactly once, in the database;
  * `guard_arena_pick()` replaced: a pick is only accepted for a `SIMULATED` battle whose window is not stamped closed and whose submit time is before its start; a change of choice or eligibility snapshot needs the same;
  * a voided battle is stamped `VOID` and **all its open picks are resolved `VOID`** by trigger (§8);
  * `arena_participants` insert/delete is refused once the battle leaves `SCHEDULED` — the roster shown is the roster that fights; nothing can reshuffle it.
* **Arena lock step** (`stepArena` R-0): the moment a prepared battle's window is due it is stamped in its **own tiny transaction, before the heavy settlement**, together with `arena_picks.locked_at` of its picks. So the lock is committed within one round trip of the deciding instant, not after the 77-statement settlement.
* **Settlement** (`settleBattle`): the first write after the `SIMULATED → SETTLED` gate closes the successor's window (idempotent). Normally a no-op; it makes the invariant independent of the lock step.
* **Pick service** (`submitPick`): one transaction, holding a **shared row lock on B**. The lock stamp is an UPDATE of B, so it waits for an in-flight pick: a pick either commits before the lock (and is frozen by it) or sees the stamp and is refused. The submitter's own clock is never consulted; a request that was *timestamped* before the deciding instant but arrives after the stamp is refused.
* `arena_picks.battle_id` is **always the predicted battle** (the upcoming battle at pick time). Nothing is renamed; the FK `(battle_id, character_id) → arena_participants` still forces "one of that battle's eight".
* The replay endpoint is still withheld until the battle's own `combat_starts_at`, which is always after the lock.

## 6. First battle / restart / outage

* **First battle** (no predecessor): it is never a pick target — its window is stamped `OWN_START` at its own start. The *next* battle is prepared in the same advance, so picks for it open the moment the first battle takes the stage.
* **Fallback** — a prepared battle with *no actively fighting predecessor* (the one in front was voided, or its slot is already over): picks use the **pre-fight window**, open until the battle takes the stage (`mode: "FALLBACK"`, `locksAt = startsAt`), then are stamped `OWN_START`, and the panel moves to the battle after it. Picks are never permanently disabled.
* **Worker/server restart mid-fight**: the prepared upcoming battle and its OPEN window are persisted; advancing again is a no-op (`tests/integration/arena-picks-lifecycle.test.ts`).
* **Outage past a whole slot**: the waiting battle's timeline (and the one behind it) is shifted forward together; its window was already closed by the rule at the predecessor's decision, so nothing reopens or extends.

## 7. Fast battles / the pipeline is two deep

The next battle's roster has never waited for combat; it is prepared (simulated, persisted) as soon as there is room. It is now kept **two** battles ahead (`AHEAD_TARGET = 2`): the upcoming battle (the picks target) **and** the one behind it, so that when the upcoming battle takes the stage the panel can switch to a battle that already exists — no empty "preparing" frame, no simulation on the boundary's critical path (battle *D* is lined up right after the boundary, off the response path).

Consequences (all asserted in tests): ≤ 2 prepared battles ahead, ≤ 4 unsettled; gapless slots; a season rollover now takes effect one battle later than before; a hero's tactic/equipment change reaches the fight about one battle later.

A fast fight still leaves the whole intro + 3·2·1 + combat of pick time, because the roster is exposed the moment the battle in front takes the stage (`tests/integration/arena-picks-lifecycle.test.ts` forces a 1.5 s fight: 7 s of pick time).

## 8. Cancelled pick periods are VOID, explicitly

Voiding a battle (admin "void unsettled", or any direct status change) stamps its window `VOID` and resolves its picks `VOID` (`settled_at` set, nothing earned) in the same transaction; the next prepared battle becomes the target and the panel shows nothing stale (`upcoming` is `null` until one is prepared). The roster is never silently replaced: a prepared battle cannot change, it can only be voided.

## 9. Queue fairness is untouched

Planning (`planCycle`), the persisted queue, 8 distinct heroes per battle, one appearance per cycle, carry-forward of a final partial group and the CSPRNG-seeded shuffle are unchanged and re-asserted (`tests/integration/arena.test.ts`, `arena-queue.test.ts`). Only *when* groups are assembled changed: up to two groups ahead of the stage instead of one.

## 10. UI

Right rail: **ARENA PICKS — PICK THE NEXT WINNER**, chip `PICKS OPEN · 12s` / `PICKS LOCKED`, short copy ("Pick who wins the next fight. Every valid Pick counts toward the Daily and Weekly leaderboards. A correct Pick earns +10 Points. Free to play. No wallet required."; the numbers and the Daily/Weekly prize line come from `state.picks.reward` and are omitted when the programme is OFF), then the upcoming eight (avatar, name, class, POWER, PICK). Locked: the chosen row stays highlighted and a card reads **YOUR PICK · name · Locked for the next fight.** Signed-out visitors see the eight and the state, with *Sign in with Telegram to make your Pick.* A small card shows how the member's *earlier* pick on the fight now on stage is going / turned out (correct / not this time / settling / cancelled) — it names the member's own choice only; the panel never lists the fighters on stage. The obsolete per-battle token copy ("10,000 $CLANKRPG this round", "correct pickers share…") is gone everywhere (`OBSOLETE_COPY` is asserted absent in `tests/integration/arena-picks-panel.test.ts`; the "How the arena works" card was rewritten).

**Profile → Arena Picks → Recent picks** follows the battle the member *predicted*: a pick that is still waiting is listed first as **UPCOMING PICK** (the fight it names has not taken the stage — its picks may still be open or already locked) and then **FIGHTING NOW** (that fight is on stage); when the battle settles the same row becomes the **RESULT** — `Rin Okumura · winner Rin Okumura · CORRECT · +10`. Every row is keyed on `arena_picks.battle_id` (always the predicted battle) and shows the winner of *that* battle; the winner/outcome of a battle that has not been settled is never sent, even though it is already persisted at preparation time (`listPickHistory`, mutation-checked in `tests/integration/arena-picks-lifecycle.test.ts`). `getPickRound` no longer carries its own "locked at combat start" calculation: the window is the rule's, and `/api/arena/picks` composes `locked` / `distribution` from it.

Assets: `useArena` starts fetching the upcoming roster's profile photos the moment a snapshot arrives (and the current one's), low priority, never awaited. Combat sprites need no per-hero warming — every hero is composed from one shared sprite set loaded once per page.

## 11. Performance

* **No new request, no new polling loop.** Same `/api/arena/state`, same boundary-aware cache/hold, same poll plan.
* **No new dependency on slow systems.** The upcoming roster is plain database state; the state build still never waits on leaderboards, holder/token RPC, claims, admin analytics or Telegram (`getPicksRewardDto` is a pure function of settings plus a 30 s-cached readiness probe).
* `getArenaState` marginal cost of the upcoming roster (in-process, 30 ms per statement, 40 builds each): **median 75.5 → 78.8 ms (+3 ms), p95 81.6 → 86.2 ms** — the extra read shares the wave of the current battle's roster.
* Payload: the upcoming block is ≈ 4.6 KB of ≈ 17 KB.
* Real Postgres (throwaway local cluster) with 30 ms injected per statement, 80 sequential state builds: **min 80 ms / median 130 ms / p95 219 ms / max 586 ms**. (The first run after a server start measured p95 ≈ 1.9 s: that is Next dev compiling routes and the cold arena start preparing three battles, not steady state. On PGlite the single connection makes readers queue behind a settlement — a test artefact.)
* The arena's lock step commits 0.2–0.5 s after the deciding instant at 30 ms/statement while settlement takes 2.2–2.7 s: the lock is no longer behind bookkeeping.

## 12. Verification record (2026-10-05, night)

Everything below ran against **scratch databases only** — an isolated embedded PGlite directory, and a throwaway local PostgreSQL 18 cluster (port 5498, data in the session scratchpad) with `CLANK_DEV_DB_LATENCY_MS=30` (every statement pays 30 ms, a hosted database). Nothing touched live Supabase: no commit, push, deploy, migration or live write. **The host was heavily loaded** (load average ≈ 17: other sessions' servers, test runs, desktop apps), so absolute times are pessimistic.

**Measurement trap, so nobody repeats it:** the Browser pane is throttled to ~1 Hz (`rAF` gaps of exactly ≈ 1000 ms, `visibilityState: hidden`) whenever no tool call is running. A recorder left running across idle time reports "180 one-second freezes" that are not the app. Frame statistics below were taken while the pane was kept awake by chained 38 s tool calls (`browser_batch`), and the app's own `requestAnimationFrame` callbacks were timed independently of the throttling.

### 12.1 Ten-plus consecutive transitions in a real browser (signed-out, 1440 × 900)

A `MutationObserver` on `data-battle` / `data-window` of the stage and the Picks panel recorded **every committed DOM state**, plus per-frame sampling.

| run | transitions | panel battle ever equal to the battle on stage | empty / skeleton panel | frames |
| --- | --- | --- | --- | --- |
| dev server, PGlite | **13** (421 s) | **0** | **never** (8 rows, 0 skeleton rows in every state) | 59.6 fps; frame p95 18.5 ms, p99 18.7 ms; the app's own rAF work median 0.1 ms, p99 1.1 ms; one ≥ 50 ms long task in 421 s |
| dev server, real Postgres + 30 ms/statement | **12** (402 s) | **0** | **never** | 59.6 fps; p99 18.7 ms; app rAF work median 0.4 ms, p99 1.6 ms; 3 long tasks (51 / 97 / 51 ms — two of them at the lock instant) |

Recorded sequence (letters are battles, in order; `picks=` is the Arena Picks panel): `arena=A picks=B OPEN → arena=A picks=B LOCKED → arena=B picks=C OPEN → arena=B picks=C LOCKED → arena=C picks=D OPEN → …` through `arena=M picks=N`. At each boundary the arena **and** the panel changed in the **same** committed render; the panel's eight rows were never missing.

What the viewer saw at each step (screenshots, signed in as a demo hero): pick on the upcoming fight → row highlighted **YOUR PICK**; the fight on stage is decided → chip **PICKS LOCKED**, card **YOUR PICK · SPROCKET SUE · Locked for the next fight.**, nobody else selectable, the crowd (`1 Pick`) appears only now; the next fight starts → the panel lists the *new* eight, **PICKS OPEN**, and a small card **YOUR PICK · FIGHTING NOW** names the member's earlier choice; the fight is decided → **NOT THIS TIME · your pick Sprocket Sue · winner Soldier Sol** (judged against *that* battle's #1). Profile → Recent picks: `Rivet — Upcoming pick —` above the resolved rows. Mobile (375 px): no horizontal overflow, the panel sits directly under the arena.

### 12.2 Two independent clients, real Postgres (HTTP, the endpoints the browser uses)

Client X and client Y (different signed-in members) poll `/api/arena/state` independently and pick different heroes of the upcoming battle at every OPEN window; when Y first sees LOCKED, X — a "slow browser" that never saw it — submits a different hero anyway.

* 11 consecutive transitions: **both clients saw identical `current` / `upcoming` / pick status on every snapshot** (`allClientsAgreed`, 0 mismatches).
* **11 of 11** late submissions refused `409 LOCKED`; X's earlier pick unchanged and `locked: true` each time.
* 10 settled battles checked: each member's pick resolved against **its own** battle's winner (+10 Points only for the correct ones).
* Database invariants after 14 windows: every lock stamp equals the predecessor's `combat_ends_at` **to the millisecond** (diff 0 ms ×14); pick window open **min 19.1 s / median 27.9 s / max 35.3 s**; locked for exactly **6.2 s** (victory beat 1.2 + results 5) before the battle starts, every time; every roster has exactly 8 distinct heroes; **0** picks submitted at/after the battle's start or after its stamp.
* (A bug in the driver, not the app: its first LOCKED snapshot can precede the stamp commit by ≈ 15 ms — the clock rule covers that gap — so a `lockedAt === locksAt` comparison on that first snapshot read `false`. The database check above is the authority.)

### 12.3 Latency

`GET /api/arena/state`, a single reader at 4 Hz, no cache bypass, 110–150 s:

| backend | reads | min | median | p95 | max | server-side median |
| --- | --- | --- | --- | --- | --- | --- |
| PGlite, no latency (dev server) | 404 | 4 ms | 18 ms | 32 ms | 142 ms | 13 ms |
| real Postgres, 30 ms / statement (dev server) | 449 | 3 ms | 76 ms | 111 ms | 168 ms | 68 ms (= two round trips) |

Two clients polling at ≈ 8 Hz (1,440 reads, Postgres, 30 ms): min 3 / median 74 / p95 111 / max 168 ms.

Before/after the upcoming roster, same build with the upcoming read suppressed, 40 interleaved builds each (`getArenaState`, in-process):

| per-statement latency | before median / p95 | after median / p95 | payload |
| --- | --- | --- | --- |
| 0 ms | 6 / 8 ms | 8 / 10 ms | 7.3 → 11.9 KB (+4.6 KB) |
| 30 ms | 72 / 76 ms | 76 / 82 ms | same |
| 100 ms | 217 / 224 ms | 220 / 229 ms | same |

The roster is read in the same parallel wave as the battle on stage: +0 round trips, +3–4 ms. Arena steps (`CLANK_ARENA_TIMING_LOG`, 30 ms/statement, 14 battles): `locked` 5–15 ms (committed within one round trip of the deciding instant), `settled` 35–221 ms, `scheduled` + `simulated` ≤ 253 ms; every battle was **prepared 57–81 s before its start** (the roster is committed during the fight *before* the one that is on stage).

Hitch at "B becomes current, C becomes upcoming": none measurable — frames stay at 16.7 ms median / 18.7 ms p99 across the boundary, the snapshot with the new rosters reached the page 7–74 ms after the boundary and the roster was on screen 32–98 ms after it (`window.__clankArena.reports()`, foreground viewer), and the panel's rows come from the same snapshot, so there is no blank frame and no extra request.

**An outlier that did not reproduce:** a first, heavier driver run (two clients polling every 120 ms *and* re-reading their own pick for every unsettled battle on each loop) against the dev server on PGlite recorded one 7 s state read. PGlite has a single connection (an open settlement blocks every reader — an artefact), `next dev` compiles a route on first use, and that driver was hammering `/api/arena/picks`. It did not recur in the lean PGlite run (max 142 ms / 404 reads) or on real Postgres (max 168 ms / 1,449 reads), and the arena steps themselves never exceeded 253 ms; I did not isolate which of the three caused it.

### 12.4 Production build, and what the "lag" actually was

`next build` + `next start` (NODE_ENV=production, no dev compiler, no HMR) against a fresh throwaway Postgres 18 on localhost, signed-out viewer at 1440 × 900:

| | result |
| --- | --- |
| consecutive transitions recorded | **15** (`arena=C picks=D` … `arena=P picks=Q`, every OPEN → LOCKED → next OPEN in order) |
| panel battle ever equal to the battle on stage | **0**; rows ≥ 8 and skeleton rows 0 in every state |
| frames while the pane was awake (403 s) | median 16.7 ms, p95 17.5 ms, p99 17.7 ms, max 50 ms; 3 frames > 34 ms, none > 50 ms |
| the app's own `requestAnimationFrame` work | median 0.5 ms, p99 1.6 ms (one 49 ms outlier); **1** long task (50 ms) in 403 s |
| `GET /api/arena/state`, 4 Hz, 471 reads, no injected latency | min 5 / median 14 / p95 20 / max 39 ms; server-side median 8 ms; 14.6 KB |
| pick windows (19, from the database) | open **min 18.8 / median 25.8 / max 35.5 s**, locked **6.2 s** before the next battle every time, **0** stamps that differ from the predecessor's `combat_ends_at` |

**What I found when hunting for lag, and what I did about it:**

1. *Server / database:* nothing on the critical path. A state read is two parallel database waves (the upcoming roster rides in the first, +0 round trips); the lock step commits within one round trip of the deciding instant; preparation of the next two battles happens 57–81 s ahead; reads never wait for settlement or rewards.
2. *Frame gaps of exactly ≈ 1000 ms:* these are the **Browser pane's own throttling** (see the trap in §12), not the app. Long-animation-frame attribution shows each of them with `renderStart` ≈ 980 ms after the frame start and under 50 ms of script. They disappear when the pane is awake.
3. *Hitch at the lock / boundary instant:* with the pane awake, the only main-thread tasks ≥ 50 ms in the **dev** build (25 transitions) were four of 50–97 ms, all landing on three of the lock instants (a React commit plus the arena's own frame). A React Profiler pass attributed them: whole-screen commits are median 5.3 ms / p95 10.9 ms / max 24.9 ms in the dev build, ≈ 8.8 commits a second, of which the live roster strip is most (it shows live HP) — nothing near 50 ms by itself. **In the production build there is one 50 ms task in 15 transitions** and p99 frame time is 17.7 ms: no user-visible hitch. Not "fixed" with delays — there was nothing to delay.
4. *One real saving:* `ArenaScreen` re-renders ≈ 9 times a second (synced clock, HUD, roster) and re-rendered the static sections under the arena (Hero eligibility, How the arena works, Coming soon) every time. They are now one memoized `StaticSections` (re-renders only when the threshold it shows changes): whole-screen commit median 5.3 → 4.6 ms, p95 10.9 → 9.7 ms, max 24.9 → 20.7 ms (dev build, same machine, same profiler). It is the only render-path change made for performance.
5. *Left as is, on purpose:* the 250 ms `setNow` tick that re-renders `ArenaPicks` (≈ 1 ms a render) because the panel shows a live seconds countdown; and the roster strip's per-card updates (already memoized per card).
6. *Prefetch:* the upcoming roster's eight profile photos are requested the moment the snapshot arrives (`warmAvatars`, low priority, never awaited); combat sprites come from one shared sprite set loaded once per page, so there is nothing per-hero to warm. Measured effect: the roster of the new battle is on screen 32–98 ms after the boundary.

### 12.5 Automated

Final tree, quiet machine: `pnpm typecheck` exit 0, `pnpm lint` exit 0 (`--max-warnings=0`), `pnpm build` exit 0, **`pnpm test`: 69 files / 1,160 tests, all passing (94 s)**. The nine lifecycle-critical files (`arena-picks-lifecycle`, `picks`, `arena-transition`, `arena-picks-panel`, `arena-picks-ui`, `arena.test`, `picks-http`, `arena-boundary-http`, `arena-reads-never-wait`; 128 tests) were run three times in a row with identical results.

Added in this pass: the history lifecycle test (UPCOMING → locked, still upcoming → FIGHTING → RESULT; the winner of an unsettled battle is never sent — mutation-checked: returning `b.winner_id` unconditionally fails it) and a UI test for the pending history rows. See "Tests added / rewritten" below for the rest.

Honest notes on the test runs: (1) one full parallel run on the just-rebooted, heavily loaded machine failed `picks-http › two clients…` because its first state read came back before the cold arena had committed its first battles (`current` null). It passed 6/6 in isolation (also under 12 CPU burners), so the trigger is the documented cold-read cap (1.5 s in `advanceForRead`), not proven; the helper now re-asks like a viewer would. (2) Later full runs were interrupted or timed out while another agent's test run and my own CPU burners (a leftover from a repro attempt) were saturating the machine — real-time tests (`arena-boundary-http`, 60 s migration tests) fail when the host is that oversubscribed. The clean run above is the one that counts.

## 13. Operations

* Apply order: `…001400` (leaderboards, other session) → **`…001500` (this)**, **before** deploying the code. `pnpm db:migrate -- --dry-run` first; never against live without the owner's go-ahead.
* **Apply the migration and deploy the code in the same window.** The new code reads `picks_locked_at` (so it needs the migration first), and the migration's pick guard refuses a pick whose `submitted_at` is at/after its battle's start — which is exactly what the *old* code's "pick the battle on stage" does. A running `arena:worker` keeps whatever code it loaded at start: restart it after deploying (the new lock step is in `stepArena`).
* The seeded `arena.picks` feature-flag description changed (it still said "correct pickers share the configured $CLANKRPG reward"). The seed is `on conflict do nothing`, so an existing live row keeps the old text until someone updates it (cosmetic: it is only shown in the admin console's feature-flag list); do that with the owner's go-ahead.
* One `arena:worker` (or the cron tick) is still required for continuous operation; the worker's wake-up instants are now `starts_at` / `combat_ends_at` (`combat_starts_at` no longer needs a wake-up).
* Admin → Arena shows the new bounds ("at most one SCHEDULED and four SIMULATED battles") and the next transition ("combat ends — the next battle's picks lock, then settle").

## Tests added / rewritten

`tests/integration/arena-picks-lifecycle.test.ts` (exact A/B/C sequence, 10 consecutive transitions, race ordering, settlement-closes-too, many-callers-once, the pure rule, first battle, fallback, restart, outage, fast battles, void, six-pick off-by-one regression), `tests/integration/picks.test.ts`, `arena-transition.test.ts`, `arena-picks-panel.test.ts`, `tests/security/picks-http.test.ts` (two-client lock), the boundary fleet (`tests/support/arenaFleet.ts`: the panel's battle before a boundary **is** the battle on stage after it, with the next eight already OPEN in the first snapshot).
