# Events — champions history, and the Season 1 competitive reset

> **Status: built and verified on scratch databases only.** Nothing here has been applied, launched or deployed on LIVE; Season 1 has **not** been launched. The one migration is
> `supabase/migrations/20261015002700_event_champion_snapshots.sql` (sha256 `d4575fa0…`, pending). See §9 for the deployment order.

## 1. What it is

`/events` ("Events", added to the navigation; on phones it lives under **More**) is the one place that shows **who has been winning**:

```
EVENTS
RECENT CHAMPIONS      [ Arena Picks ] [ Hero Arena ]    [ Daily ] [ Weekly ]
  the latest completed period at full size, then the two before it
PAST RESULTS          every earlier completed period, newest first, "Load older results"
FULL RESULTS          the final Top 10 of any period (a dialog; also a stable link: /events?program=hero&kind=weekly&period=2026-10-12)
```

There was no Events page before this work (the nearest thing is the Hall of Champions at `/leaderboard`, which keeps the **live** boards and now links here with *Past champions*). It is a new route, not a rename.

**Everything shown is a frozen result of an official season.** Before Season 1 there is nothing to show and the page says **SEASON 1 COMING SOON**; after the launch, until the first period closes, **NO CHAMPIONS YET — the first Season 1 winners will appear after the first eligible day is finalized.** Pre-season (development) boards are never listed, backfilled, or reachable by guessing a date.

## 2. Who is a champion — the existing rules, not new ones

| | Champion | Ranking | Ties |
|---|---|---|---|
| **Arena Picks** (Daily / Weekly) | the **prize-eligible** member at prize position 1 | correct Picks, then accuracy (`domain/rewards/leaderboard.ts`) | an exact tie (same correct Picks **and** accuracy) = **joint champions**, nobody picked arbitrarily |
| **Hero Arena** (Daily / Weekly) | the hero(es) at rank 1 with ≥ 1 win | Arena **wins** only — no tiebreaker exists | same wins = joint champions |

* A board's **leader** and an eligible **champion** can differ: a member who led with 19 of 19 but did not reach the 20-Pick (daily) / 100-Pick (weekly) minimum is *not* a prize winner. The card says so plainly, the Top 10 marks them **Below minimum Picks**, and the champion is the first *eligible* player. If nobody qualified: **NO ELIGIBLE WINNER**. Nothing was settled: **NO COMPLETED RESULTS**. Closed but not frozen yet: **FINALIZING**.
* **Champion ≠ prize ≠ payment.** A title is recognition. A prize is an **allocation** to a reward balance, shown as `30,000 $CLANKRPG ALLOCATED` only when the frozen result really carries one (a held prize reads as allocated, a forfeited one as none — the live boards' convention). No Events screen says "paid"; before the token exists it says claims open once $CLANKRPG launches. Hero Arena has no approved pool, so its periods read *Recognition only — no prize pool for this period* — nothing is invented. No tokens are minted or moved by Events.

## 3. Where the data comes from — and why it cannot change

The ranking, eligibility, ties and prizes of a finished period are already **frozen** by the existing, idempotent finalizers (`arena_leaderboards` / `arena_leaderboard_results`, `hero_arena_boards` / `hero_arena_results` — immutable, first insert wins). Events reads those rows; it never recomputes a winner.

What those rows did not carry is the **hero as it looked then**. Migration 2700 adds one immutable companion row per frozen result — `arena_leaderboard_result_snapshots`, `hero_arena_result_snapshots` — written **by a database trigger in the same transaction as the result**: the hero version in force when the period **closed** (the newest version created before the period's end; a late finalization still records the end-of-period hero), its class, rarity, **PWR** (the version's stored PWR — what the profile and card show), the public id, and the portrait `look` (`parts`, `sprite`, `overrides`; the internal generation seed is never copied). A later reroll, rename or battle cannot touch them (append-only triggers; tested).

* **Idempotent**: a retried or concurrent finalization inserts nothing (the first insert wins) — tested ×8 on real Postgres: one board, one snapshot per result, one prize credit.
* **Atomic**: a reader can never see a champion without its snapshot (tested with readers racing the finalizer).
* **Season-scoped**: every Events query is limited to `seasons.kind = 'COMPETITIVE'`.
* The public **name** is the hero's name as frozen on the result (the existing public identity; Telegram ids, usernames, wallets, owner ids and review states are never returned — asserted over the whole payload).
* Not backfilled: snapshots of already-finalized *pre-season* boards would be "today's hero", not history, and those boards are never shown.

## 4. Periods, finalization and the clock

One clock: the existing UTC boundaries (`domain/rewards/time.ts`). A daily period closes at 00:00 UTC; a weekly one at Monday 00:00 UTC; a season's history starts with the period that contains its start. A period is **complete** when its end ≤ now (to the millisecond — tested). Empty days inside the season are listed as **NO COMPLETED RESULTS** (calendar-driven, so nothing is silently skipped). Finalization itself is unchanged (the existing sweeps).

## 5. Performance

* A page of 8 periods costs a constant number of indexed, set-based queries (boards, champions, ineligible leaders, link visibility, finalizing) whatever the season's length; no battle table scan, no per-row hero/member lookups. New index: `arena_leaderboards (season_id, kind, period_start desc)`.
* `GET /api/events/champions?program=picks|hero&kind=daily|weekly[&before=YYYY-MM-DD&limit=1..12&season=<id>]` and `GET /api/events/results?…&start=YYYY-MM-DD` are anonymous and viewer-independent: `Cache-Control: public, s-maxage=30..60, stale-while-revalidate`. Pagination is a cursor (`nextBefore`). Never-finalized or non-official periods are 404.

## 6. Public wording — before and after the launch

One module (`domain/publicPresentation.ts`) decides what the public is told, from the **persisted** game phase (`GET /api/season`) — never `NODE_ENV`, a Vercel variable or a deployment.

| Where | Before the launch | After the launch |
|---|---|---|
| navigation chip | **Pre-season** | **Season 1** (teal) |
| Arena header | `GLOBAL IDLE ARENA · LIVE · PRE-SEASON` | `GLOBAL IDLE ARENA · LIVE · SEASON 1` |
| Arena waiting screen | *Pre-season — Season 1 is coming soon* | *Arena preparing — Season 1 battles will begin soon* |
| Hall of Champions | `PRE-SEASON LEADERBOARDS` | `SEASON 1 LEADERBOARDS` |
| Events | `EVENTS · PRE-SEASON · SEASON 1 COMING SOON` | `SEASON 1 EVENTS` |
| footer | "Pre-season: records reset to zero when Season 1 launches." | (nothing about testing or beta) |
| hero profile / records | "Pre-season — practice battles, not an official record." | the season's own record |

Removed from every public surface: *Development*, *test battles*, *Beta*, *development run*, *not in the Beta*. Left alone on purpose (internal infrastructure, guarded by the environment, never reaching a production visitor): the non-production dev-login panel ("Local preview only"), the demo-hero chip (only where `CLANK_ALLOW_DEMO_HEROES=true`), localhost handling, logging, security checks. The **Admin** console keeps its precise vocabulary (Development / Pre-season). A test (`tests/unit/public-wording.test.ts`) renders every docs page and the waiting screens and scans the public source for the old strings.

## 7. The Season 1 reset — what the existing lifecycle already did, what was added

The lifecycle (`GAME_LIFECYCLE.md`) already archived the development run, created Season 1 NOT_STARTED, archived the development economy and fingerprinted every hero; nothing was duplicated. Added / hardened: the **idempotent** launch, the **preflight** + **backup attestation** (§3b of that document), the **in-transaction verification** that Season 1 starts at zero, and the **season-scoping fixes** (§6a there: finalized boards by list and by date, a member's own Picks record and history, the boards' memos, the scheduler anchor).

**Resets for Season 1** (archived, never deleted): Arena matches / wins / losses / Top-2 / KOs / damage / streaks, battle numbers, Picks (submitted, correct, incorrect, Points, standings, eligibility counters, community totals), Daily/Weekly boards and champions history, Hero Records, pre-season Clank Gold (offsetting ledger entry), loot, battle-earned achievements, career counters.

**Survives**: every hero exactly (id, public id, name, Telegram link and ownership, claimed status, class, rarity, PWR, stats, look, version history, moderation) — fingerprinted before and after, the launch rolls back if a byte differs; members, Telegram auth, admin roles and settings, token configuration, character art; **Arena Chat** (separate policy decision, not cleared); every pre-season battle, snapshot, seed, hash and result (replayable; hashes unchanged, tested); the reward ledger / claims / prizes (a launch **refuses** while any is owed — nothing real is orphaned or erased).

**Decisions the owner must make (reported, not decided):**

1. *Gold paid by permanent achievements.* The established policy resets **all** pre-season Gold; achievements that are kept (community / chain / admin-granted) therefore will not pay that Gold again. The preflight prints the amount. Keep as is, or exempt it.
2. *Loot that was not a battle drop* (an admin grant): archived with the rest. The preflight prints the count.
3. *Arena Chat history*: preserved. Clear it only as a separate, explicit decision.
4. *`super_admin`*: there is **no role system** in the repository — the admin session (`ADMIN_ACCESS_KEY`) is the single privileged principal and is what "super_admin" means today. The launch route is admin-session-only, same-origin-checked and audited (the admin login itself is rate-limited, 5 / minute); nothing public can reach it. Splitting roles is a separate piece of work.
5. *Pre-season Picks and boards are retained, not deleted* (restricted by RLS, season-scoped out of every read). If privacy requires deletion, the tables are `arena_picks`, `arena_pick_scores`, `arena_points_ledger`, `arena_leaderboards`, `arena_leaderboard_results`, `hero_arena_boards`, `hero_arena_results`, `season_character_stats` (rows of the archived development season) — that needs a dedicated, reviewed script (these tables are protected by append-only triggers and referenced by foreign keys, e.g. frozen results ← reward ledger) and it removes the audit trail and the replay of those periods. Nothing in this work deletes them.

## 8. Verifying it yourself (scratch only)

`scripts/qa-events-seed.ts` builds three disposable databases on a **local throwaway Postgres** (`pre`, `launch`, `history`) and **refuses any database not on localhost whose name does not start with `clank_qa`**. `history` backdates Season 1 by 16 days on the scratch copy and writes fabricated official results (champions, a tie, an ineligible leader, an empty day, nobody-eligible, long names) so the real screens can be inspected. Nothing it writes is production data.

Tests (all scratch): `events-domain`, `events-ui`, `launch-ui`, `public-wording` (unit); `events-service` (the whole story: pre-season → preflight → launch → idempotent re-launch → first official champions → reroll stability → weekly close → pagination), `events-migration`, `launch-atomicity`, `launch-read-paths`, `events-postgres` (real Postgres: finalize ×8, readers racing the finalizer, launch ×6 racing a finalization); `tests/security/events-http`.

## 9. Safe deployment order (nothing below has been done)

1. **Merge the code and the migration together; apply nothing yet.** The new code tolerates a missing 2700 (Events shows nothing; the old app ignores the new tables).
2. Apply the pending lifecycle migrations through **2600** per `RELEASE_PLAN.md` (2000 → 2100 → 2200 → 2300 → 2400 → 2500 → 2600), then **2700** (`pnpm db:migrate -- --up-to 20261015002700`). 2700 is additive: no hero, version, battle, board, result, reward row or setting changes (tested byte-for-byte), nothing is backfilled, nothing is launched.
3. Deploy the matching app version (pre-season wording, Events, the hardened lifecycle). Exactly one Arena worker.
4. Verify read-only: `select * from audit_event_champions()`, `audit_launch_isolation()`, `audit_game_lifecycle()` (all empty), Admin → Game control → *Season 1 launch readiness*.
5. When you decide to launch: pause the Arena, **take and verify a backup, record the attestation**, resolve the policy flags above, then **Launch Season 1** (typed phrase). Verify Phase LIVE, Season 1, 0 official matches, hero counts unchanged, `Season 1 status → Audit clean`.
6. **START ARENA** is a separate action. The first Season 1 champions appear after the first period closes and is finalized.
