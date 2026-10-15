# Game lifecycle, seasons and the Arena's runtime state

> **Status: built and verified on scratch databases only. Nothing here has been applied, launched or deployed on LIVE.** The migrations are `supabase/migrations/20261006002000_game_lifecycle_seasons.sql` and
> `20261006002100_development_economy_archive.sql` (both pending; the approved hashes are in [`RELEASE_PLAN.md`](./RELEASE_PLAN.md) §9), plus `20261015002700_event_champion_snapshots.sql` (the launch backup attestation, the champion snapshots and two auditors — see [`EVENTS.md`](./EVENTS.md)). Launching Season 1 is a separate, deliberate Admin action that happens after final approval — see §9.
>
> **Launch hardening (migration 2700 + code).** The launch now (1) is **idempotent** — once the game is LIVE any further launch request, with the typed phrase, returns the existing launch (`alreadyLaunched: true`) and resets nothing; (2) runs a **preflight** with real counts and refuses on a failing blocking condition (§3b); (3) needs a recent **verified backup attestation** (§3b); (4) **verifies Season 1 starts at zero** inside its own transaction (no battle, Pick, score, hero record or board attributed to it, and `audit_game_lifecycle` / `audit_development_economy` / `audit_launch_isolation` all clean) and rolls back whole otherwise. Public read paths that were not season-scoped are fixed (§6a).

Clank RPG is still in **development**: the Arena and the heroes are being used for testing, so today's battle numbers, wins and Picks are test data. When the game launches there must be **one
deliberate, audited action** that starts a clean **Season 1** — with every hero exactly as it was — and the Arena must then **stay stopped until an operator presses START**. This document is how
that works.

## 1. The three persisted states

Three independent pieces of **server-side, database-side** state say where the game is. None is a client variable, an environment (`NODE_ENV`, Vercel, Supabase) or a worker's memory — every
process, worker, restart and browser sees the same values.

| State | Table | Values | Meaning |
|---|---|---|---|
| **Game phase** | `game_state` (one row) | `DEVELOPMENT` → `LIVE` (one way) | DEVELOPMENT = testing before the official launch (its battles, records and Picks are test data). LIVE = official, numbered seasons. |
| **Season** | `seasons` | `kind` `DEVELOPMENT` ("Development / Beta", "Development run 2" …) or `COMPETITIVE` ("Season 1", "Season 2" …); `status` `ACTIVE`/`ENDED` | Exactly one season is ACTIVE at a time. Public records — wins, matches, rank, **battle numbers** — belong to it. A season is never deleted: it is the archive. |
| **Arena status** | `arena_state.status` | `NOT_STARTED` → `PREPARING` → `RUNNING` ⇄ `PAUSE_REQUESTED` → `PAUSED` | Whether battles are being made. |

```
GAME PHASE        DEVELOPMENT ──────── LAUNCH SEASON 1 (typed phrase, once) ────────▶ LIVE        (no way back)

ARENA STATUS      NOT_STARTED ─ START ▶ PREPARING ─ Battle #1 ready ▶ RUNNING ─ PAUSE ▶ PAUSE_REQUESTED ─ drained ▶ PAUSED
                       ▲                                                  ▲  ◀──────── RESUME / cancel pause ───────┘   │
                       └──────── LAUNCH / RESET / END SEASON (only from NOT_STARTED or PAUSED) ◀──────────────────────────┘ ◀─ RESUME
```

* **Launching Season 1 and starting the Arena are two different actions.** Launch leaves the Arena `NOT_STARTED`; nothing runs — not even with the worker process running — until START ARENA.
* The worker (`pnpm arena:worker`), a viewer's request and the cron tick all go through the **same Arena step**, whose first read is the persisted status. `NOT_STARTED` and `PAUSED` do nothing;
  `PREPARING` only prepares Battle #1; `RUNNING` advances normally; `PAUSE_REQUESTED` finishes what is already committed and makes **no new roster**. Starting the worker never starts the Arena.
* The database enforces it too: a battle cannot be **scheduled** while the Arena is `NOT_STARTED` or `PAUSED` (trigger), whoever asks.

## 2. The Admin actions (Admin → **Game control**)

Every action is **one transaction** that first locks `arena_state` (then `game_state`, then the season rows — the order the Arena's own step uses) and **re-checks its preconditions after the lock**
(compare-and-set by construction). A stale screen, a second Admin window, a double click or a retry can never do what the state forbids; the loser gets a clear refusal. All are audit-logged in the
same transaction with the previous and the new state (never a secret).

| Action | Allowed when | What it does | Audit |
|---|---|---|---|
| **START ARENA** | Arena `NOT_STARTED`, an active season, ≥ 8 Arena-eligible heroes | `NOT_STARTED → PREPARING`; the next advance prepares **Battle #1** (the same fairness rules as everywhere; no hero is special-cased), then `RUNNING`. Battles then continue by themselves — no click per fight. | `ARENA_START` |
| **PAUSE ARENA** | `RUNNING` / `PREPARING` | If nothing is committed → `PAUSED` at once. Otherwise → `PAUSE_REQUESTED` ("Pausing…"): **no new roster is made**; the battle on stage, the announced upcoming battle (players may have picked on it) and the prepared one all play out and settle **exactly as planned**; nothing visible is ever cancelled. `PAUSED` is declared only when none is left **and the last battle's own results screen has finished** — viewers are never cut off. | `ARENA_PAUSE_REQUEST`, then `ARENA_PAUSED` (by `system`) |
| **RESUME ARENA** | `PAUSED` or `PAUSE_REQUESTED` (cancels the pause) | Continues the **same** season: after Battle #25 comes **#26**, never #1; the persisted queue, hero season records and the Picks lifecycle carry on. | `ARENA_RESUME` |
| **LAUNCH SEASON 1** | phase `DEVELOPMENT`, Arena stopped (`NOT_STARTED`/`PAUSED`), **no reward liability**, preflight green (§3b) | See §3. Typed phrase **`LAUNCH SEASON 1`** (two-step dialog; the server checks the phrase again). One-way. **Idempotent:** when already LIVE it returns the existing launch and changes nothing. | `GAME_LAUNCH` |
| **RESET ARENA** (development run) | phase `DEVELOPMENT`, Arena stopped, no reward liability | Archives the test run and starts the next one (`Development run 2` …): battle numbers from #1, records at zero. Heroes and history untouched. Typed phrase **`RESET ARENA`**. **Refused once LIVE** — a live season is ended, never reset. | `SEASON_RESET` |
| **END SEASON** | phase `LIVE`, Arena stopped, nothing committed, **every Daily/Weekly board of the season finalized** | Archives the season (battles, snapshots, hashes, results stay replayable), leaves the game between seasons with the Arena `NOT_STARTED`. Typed phrase **`END SEASON`**. | `SEASON_END` |
| **CREATE NEXT SEASON** | phase `LIVE`, no active season | Season N+1: battle numbers from #1, every hero's record at zero, Arena `NOT_STARTED`. | `SEASON_CREATE` |

Invalid transitions fail clearly (`409` with a message): *cannot START while RUNNING, cannot RESUME while NOT_STARTED, cannot RESET while the Arena is running or settlement is committed…*. The old
free-form season routes (create / activate / end a season by name) are **gone**; nothing sets the phase or a season row directly, and there is no "back to DEVELOPMENT".

Admin → **Arena** keeps two *emergency* tools (void unsettled battles, abort the cycle). They work in any state (a pause would drain exactly the battle you want to void), take the same row lock, and are audited.

## 3. What LAUNCH SEASON 1 does — and does not do

In one transaction, under the locks, with the Arena stopped:

1. **Archives the development run.** Any battle that was committed but never settled is voided (its Picks resolve VOID), the active cycle is aborted and its queue entries released, and the season is marked
   `ENDED` (`ended_reason = LAUNCH`) with a summary (`archive`: settled/voided battles, last public battle number, heroes with records, pick scores…). **Nothing is deleted.** Settled battles keep their
   snapshot, seed, ruleset hash, events hash and result byte-for-byte — a development battle replays to the **same hash and winner** after the launch (tested).
2. **Creates Season 1** (`COMPETITIVE`, number 1, ACTIVE, `battle_counter = 0`), sets the game phase to `LIVE`, stamps `launched_at / launch_season_id / launched_by`, and leaves the Arena **`NOT_STARTED`**.
3. **Archives the development economy** — achievements, Clank Gold, loot and the lifetime career counters (§3a). Nothing earned while testing carries into Season 1; nothing is deleted.
4. **Fingerprints every hero before and after** (identity, public id, Telegram link, class, current version, stored look, stats and the whole append-only version history) and **rolls the whole launch back**
   if a single byte differs (tested with a trigger that tampers with a hero mid-launch).

**What is preserved exactly (the HERO):** hero identity, Telegram linkage, ownership, stable public id and URL, class, **rarity**, stats, **PWR**, appearance and sprite, profile photo, hero version history (no new
version is written — a launch is not a reroll), reroll/rollback history, generator version, moderation state (a suspended hero stays suspended), admin notes.

**What starts at zero for Season 1:** every hero's wins, matches, win rate, placements, kills, streak, rank (**Unranked** until its first battle of the season), the public battle number (**#1**), the Daily and
Weekly boards, the queue/cycle. The development run's Arena queue, cycle, carried leftovers, prepared battles and picks stay in the tables as the archive but are never read as Season 1.

**What a launch refuses:** a running Arena; an existing LIVE phase; and **real reward liabilities** — any prize credited, reserved, claimed, pending/sent claim or held prize. Those are obligations the archive
would orphan; reverse them with the audited adjustment tool in Admin → Arena Picks first. (While testing, run with prizes paused: a finalized development board credits prizes and would block the launch.
Game control warns about this.)

## 3b. The launch preflight and the backup attestation

`GET /api/admin/game/preflight` (Admin → Game control → *Season 1 launch readiness*) reads **real counts** — heroes, hero versions, pre-season battles (settled / void / open), Picks, scored rows, frozen boards and results, hero records, Gold accounts, loot, battle achievements, pending settlements, active jobs — and the conditions below. The **same decision re-runs inside the launch transaction**, under the locks, and a failing *blocking* condition refuses the launch with the check's name (`PREFLIGHT_<ID>`).

| Check | Blocking | Meaning |
|---|---|---|
| `PHASE` | yes | the game is still pre-season |
| `SCHEMA` | yes | latest applied migration ≥ the version this code needs (`REQUIRED_SCHEMA_VERSION`, pinned by a test to the newest file) and every required object exists |
| `ARENA_STOPPED` | yes | Arena `NOT_STARTED`/`PAUSED`: the database itself refuses to schedule a battle then, so no worker can write into the pre-season |
| `REWARDS` | yes | nothing credited / reserved / claimed / held (existing rule) |
| `PICK_SETTLEMENTS` | yes | every **settled** battle's eligible Picks have been scored |
| `NO_COMPETING_ACTION` | yes | the lifecycle advisory lock is free (no launch / reset / finalization in flight) |
| `BACKUP` | yes (in production) | a **verified** backup attestation from the last 24 h, taken at the **current** schema version |
| `OPEN_BATTLES`, void settlements, unfinalized periods, eligible heroes, policy notes | advisory | informational; open battles are voided by the launch as designed |

**The backup attestation.** The application cannot look inside a Supabase backup, so it does not pretend to: *Record attestation* stores who said a backup exists, what it is called and when, whether it was verified, and the schema version it was taken at (`launch_backup_attestations`, append-only, audited as `LAUNCH_BACKUP_ATTESTED`). A migration applied after the backup makes it stale. The requirement is on by default (`LifecycleDeps.requireBackup !== false`); only the automated suites switch it off.

**Policy flags the owner must confirm (not decided silently):** Gold that was paid by *permanent* achievements (community / chain / admin-granted) is reset along with all other pre-season Gold, and those achievements will not pay it again; loot that was not a battle drop (e.g. an admin grant) is archived with the rest. The preflight prints both numbers when non-zero.

## 3a. Development progress does not carry into Season 1 (the development economy)

Everything a hero earned while the game was in DEVELOPMENT is test data. The launch (step 3 above, inside the same transaction, `services/developmentEconomy.ts`) puts every one of these systems back to a clean
start **without touching the hero** and **without deleting a row**:

| System | At the launch | Where the development history stays |
|---|---|---|
| **Clank Gold** | every positive balance gets ONE offsetting ledger entry (`reason = season_launch_reset`, idempotency key per season + hero); the balance is **0** and `audit_currency_ledger()` stays clean (balance = sum of the ledger). Season 1 Gold is exactly what is earned after the launch. | the append-only `currency_ledger` (every development entry **and** the offset). `lifetime_earned` is a cumulative history counter that nothing reads for a gate, so it is left as it was (inert). |
| **Loot / inventory** | every item is `archived_at` + unequipped. Archived loot is not in the inventory, cannot be equipped (a CHECK forbids archived + equipped) and adds nothing to combat stats (`loadFighters` ignores it). | the `inventory_items` rows (`archived_at`, `archived_season_id`). |
| **Achievements — arena (seasonal)** | unlocks earned from the **arena metrics** (`battles`, `wins`, `top2`, `eliminations`) are archived (`archived_at`): not counted, not shown, not blocking. Progress is now **season-aware**: `loadMetrics` reads those four metrics from the hero's record in the **ACTIVE season** (zero when none is active), so a development battle can never pre-complete an official achievement, and a re-evaluation never hands an archived one back. They are earned again from Season 1's own record — and pay their Gold again (the reward's idempotency key is per unlock row). A title that exists only because an archived achievement granted it is cleared (a title an admin typed is kept). | `character_achievements` rows (`archived_at`, `season_id`). |
| **Achievements — permanent** | **kept**, on purpose: the community / chain metrics (`telegram_qualifying`, `telegram_active_days`, `diamond_days`, `bonded_tokens_held`) are facts about real members, not test battles; and an achievement an **admin granted** (`context.granted = admin`) is the admin's decision. | — |
| **Career counters** (`characters.arena_battles / wins / top2 / eliminations / damage`) | zeroed. Nothing public or competitive reads them; the development totals live on in the development season's own `season_character_stats` rows, which settlement maintains next to them. (`last_arena_at`, the admin "last activity" stamp, is a fact about the hero and is kept.) | `season_character_stats` of the ended development season; the totals of the launch are also in that season's `archive.economy` and in the `GAME_LAUNCH` audit entry. |

**Real value is never touched.** The reward ledger, claims and prizes are not part of this step; the launch still **refuses** while any is credited / reserved / claimed / pending / held (§3), and the reset
step only runs after that check passes. **Later seasons and a development reset do not reset the economy** — Gold, loot and permanent achievements are earned from the launch on; an *End season* /
*Create next season* only starts a new competitive record (arena achievements then count the new season, see above).

**Hero preservation is still enforced:** the fingerprint (§3 step 4) covers class, rarity, stats, PWR inputs, look and the full version history, and rolls the launch back if a byte moves. A hero's cosmetic
*title* is not part of its identity and may be cleared only as described above.

`audit_development_economy()` (read-only, in migration 2100) lists, once the game is LIVE, any development achievement / loot / Gold that is still active — **expected: no rows**; `pnpm release:audit` prints what a
launch *would* archive today.

## 4. Battle numbers and hero records are season-scoped

* `arena_battles.season_sequence` is the **public** battle number, assigned by the database (trigger) from the season row's `battle_counter` — gapless, per season, serialised under the season row's lock.
  The primary key and the global `sequence` never reset. Season 1's first battle is `#1` whatever the development run reached (`#847`, in the scratch scenario).
* The public UI shows no battle counter on the arena screen (an earlier product decision); the number is in the API (`current.number`, `upcoming.number`, `next.number`, `recent[].number`) and in Admin.
* **Records** — wins, matches, win rate, top-2, KOs, rank — are read from `season_character_stats` for the **active** season (the hero profile, directory profile, Admin hero detail, the Wins / Top-2 / KOs / Season
  boards, Recent Winners). No row means zero: **a new season starts every hero at 0 / 0 / "—" / Unranked** without deleting anything. The hero's lifetime counters on `characters` are the **all-time career**: kept
  internally (Admin hero detail shows them as "All-time (internal)"), never shown publicly, never reset.
* Win rate is **"—"** with no matches (never "0%"); rank is **"Unranked"** until the first battle of the season, then the tier the points earn.

## 5. Who may fight — total vs eligible, suspensions

`src/server/services/arenaEligibility.ts` is the **one** definition: a hero may enter a **new** roster when it is `ACTIVE`, its Telegram member is not `BANNED`, and (only where demo heroes are allowed) demo heroes count.

* **Total heroes** and **Arena-eligible heroes** are different numbers everywhere (Admin overview, Game control, the release audit): 139 total / 18 suspended / 121 eligible. A suspended hero is not missing,
  deleted or in need of regeneration.
* Enforced **server-side on every scheduling path**: cycle planning, reshuffle, carried leftovers, queue refill, the first battle after launch / resume, a future season. The scheduler locks the member and hero rows
  (key-share / share, fixed order) **before** verifying eligibility, so a suspension either committed first (the hero is skipped) or waits for the scheduling transaction. A database trigger refuses a roster row for a
  non-eligible hero as the last line.
* **Frozen rosters are never rewritten.** A hero suspended *after* it was committed to the battle on stage, the announced upcoming battle (people may already have picked on it) or a prepared one still fights that
  frozen appearance; it is excluded from every roster made afterwards. **Reactivating** a hero makes it eligible for *future* rosters only (the next cycle that is planned) — it is never injected into one that exists.

## 6. Arena Picks and rewards across seasons

* `arena_pick_scores`, `arena_points_ledger` and `arena_leaderboards` remember their **season** (stamped from the battle by a trigger). A season "counts" when it is `COMPETITIVE` or the ACTIVE one; an
  **ended development run is archived**: its scores stay but no board is finalized from them, no prize is paid for them, no lifetime total includes them.
* A Daily/Weekly period is owned by the season of its **last counting pick**: after the launch the same UTC day's board ranks only Season 1's picks (a member with 20 development picks and 5 Season 1 picks has 5);
  a period holding only archived development picks has no owner and is never finalized. Minimums (20 / 100 valid Picks) and +10 per correct Pick are unchanged.
* Finalization and the lifecycle actions are separated by an **advisory lock** (shared for finalizations, exclusive for launch / reset / end season), *not* by the Arena's row lock — a finalization writes a result
  row per participant and must never stall battles at midnight UTC. A prize is therefore either credited **before** a launch looks (and the launch refuses) or archived **by** it — never both (tested ×12 on real Postgres).

## 6a. Read paths that were NOT season-scoped, and are now

A full audit of the public read paths found these leaks (all fixed, each with a test; the pre-season rows were never deleted — they are simply no longer read as official):

* **Finalized Daily / Weekly boards** (`listFinalizedPeriods`, `getFinalBoard`, Hero Arena `listFinalizedHeroPeriods`, `getFrozenHeroBoard`) listed and served *every* frozen board — including the pre-season's — and by date. They are now filtered to seasons that count (an official season, or the one being played).
* **A member's own Picks record** (`getPickStats`: total / correct / accuracy / streak) and **Pick history** (`listPickHistory`) read all `arena_picks` ever — a member with 500 pre-season Picks would have started Season 1 with them. Now scoped through the battle's season.
* **The boards' in-process memos** (Picks, Hero Arena, Hero Records, 4 s) were keyed by period only, so for a few seconds after the launch a board computed before it could still be served (reproduced by a test, which fails without the fix). The key now includes the active season.
* **The scheduler's "previous battle" anchor** read the last settled battle of *any* season; it now reads this season's, so the first official battle is never anchored to an archived one.

## 7. The public screens (and the one real error)

Each is a designed screen in the Clank RPG style, derived from the **persisted** status — never from a process's memory:

| State | Screen |
|---|---|
| Phase DEVELOPMENT, Arena not running | **PRE-SEASON** — practice battles are not running, Season 1 is coming soon, nothing here is an official record |
| Phase DEVELOPMENT, running | the arena, with a permanent **"Pre-season"** chip (a pre-season run is never shown as a season; nothing public says development, test or beta) |
| Phase LIVE, `NOT_STARTED` | **ARENA PREPARING** — "Season 1 battles will begin soon. The Arena has not started yet." |
| `PREPARING` | **PREPARING ARENA** — the first battle is being made ready |
| `RUNNING` | the arena + Arena Picks; **"Pausing after this battle"** while a pause drains |
| `PAUSED` | **ARENA PAUSED** — "Battles are temporarily paused. The Arena will continue when the next session resumes." (the panel and the stage show nothing stale) |
| running with fewer than 8 eligible heroes | the Foundry warming up with the **only** heroes counter ("6 / 8 heroes") |
| the state endpoint cannot be reached and there is nothing to show | **RECONNECTING…** (with automatic retry) — the *only* place that word appears |

## 8. Concurrency design

* **Lock order everywhere:** `arena_state` → `game_state` → `seasons` → the rest; lifecycle actions then take the advisory lifecycle lock. Reward finalization takes only the shared advisory lock (no `arena_state`).
* **Compare-and-set:** status moves are `update … where status = <expected> returning`; the database's own transition trigger rejects anything off the table.
* Verified on **real Postgres 18** with parallel connections (`tests/integration/lifecycle-postgres.test.ts`, throwaway server): launch × launch (×10), launch vs ticks, launch / reset vs a draining settlement,
  launch vs reset (×6), start × start (×10) and vs ticks, start vs reset / pause (random order ×12), pause vs ticks (4 streams), resume × resume (×10), suspend vs the scheduler (with a widened race window),
  finalization vs launch (×12), and a whole lifecycle under load — exactly one active season, no duplicate Season 1 / Battle #1, no torn queue, no suspended hero in a later roster, no hero change, no deadlock.
  Each guard was **mutation-checked** (removing it makes the matching test fail).

## 9. Procedures

**Applying the migration (part of the staged release — [`RELEASE_PLAN.md`](./RELEASE_PLAN.md) Stage E4).** `pnpm db:migrate -- --up-to 20261006002100` (2000 after 1400 and 1500, which it requires; 2100 after 2000). Both are additive (2100 only adds the archive columns and the auditor and **archives nothing** — the archiving happens inside the launch):
it changes **no hero, hero version, battle result, snapshot, hash, queue row or score**, switches nothing on, and leaves the game in **DEVELOPMENT**. The Arena keeps the state it had (`paused → PAUSED`, has run →
`RUNNING`, never ran → `NOT_STARTED`); existing seasons become `DEVELOPMENT` runs ("Development / Beta"), battles are numbered per season in their original order. Deploy the matching code in the same window
(the previous app version keeps working against the new schema — a `paused` flag toggle from it is translated to a status move — but cannot launch).

**Launching Season 1 (later, only after explicit approval — NOT part of this release).** Checklist (`pnpm release:audit` prints the same list read-only):

1. Every migration through **2700** is applied and the matching code is deployed; exactly one Arena worker is running. Take a backup, verify it, and **record the attestation** (Admin → Game control → Backup readiness).
2. Final data review: hero counts (total / eligible / suspended), rarities, PWR; the BBOT-style exclusions are blocked in Admin → Telegram.
3. No reward liabilities (Admin → Game control → *Reward obligations* says "clear"); prizes paused while testing.
4. Admin → Game control → **Pause Arena**; wait until it says **PAUSED** (the committed battles finish first).
5. **Launch Season 1** → read the explanation → **Continue** → type `LAUNCH SEASON 1` → **Confirm Season 1 launch**. Verify: Phase LIVE, Season 1, Arena NOT STARTED, 0 battles, hero counts unchanged.
6. When ready: **Start Arena** → confirm. Battle #1 appears; battles continue by themselves.

## 10. Open decisions (reported, not decided silently)

* **Resolved:** achievements, Clank Gold and loot earned during development are **not** carried into Season 1 — see §3a (archived at the launch; permanent community / chain / admin-granted achievements are kept and listed there).
* **Lifetime Clank Points** exclude ended development runs (archived test data); manual adjustments always count.
* A Daily/Weekly period that straddles a season boundary belongs to the season of its last counting pick (the other season's picks of the same day are archived out of that board).
* The development reset and the launch **refuse** while any prize is credited — by design; reverse test credits with the audited adjustment tool, or keep prizes paused while testing.

## 11. Admin API (all admin-session + same-origin; all audited)

`GET /api/admin/game` · `GET /api/admin/game/preflight` · `GET /api/admin/game/official-season` · `POST /api/admin/game/backup-attestation` (body `{reference, verified, notes?}`) · `POST /api/admin/game/{launch|reset|end-season}` (body `{confirmation}`) · `POST /api/admin/game/{start|pause|resume|create-season}` · `GET /api/admin/seasons` (read-only) ·
`POST /api/admin/arena {action}` (legacy: pause / resume route through the lifecycle; void_unsettled / abort_cycle are the emergency tools). Public: `GET /api/arena/state` carries `status`, `phase`,
`pausing`, `season`, season-scoped battle numbers and nothing about queues or cycles.

## 12. Verification record

See the final report of the session that built this; the evidence is the test files `tests/unit/lifecycle-domain.test.ts`, `tests/integration/lifecycle-{state,launch,suspension,rewards,migration,ui,postgres,economy,economy-migration}.test.ts`,
`tests/security/lifecycle-http.test.ts`, and the browser QA (real Admin UI + real worker on scratch Postgres: start → pause/drain → launch with typed phrase → NOT_STARTED → start → pause → resume, every public
state and the real outage, at 1440 / 1024 / 768 / 375 / 320 with no horizontal overflow).
