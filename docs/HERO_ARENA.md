# Hero Arena — the HERO competition, its rewards, and the Hall of Champions

*2026-10-07. Nothing was committed, pushed or deployed, and no migration was applied to any live database by this work. Migration `20261007002200_hero_arena_rewards.sql` is a new file and is **not applied** anywhere.*

The Leaderboard page is the **Hall of Champions**. It has three sections, each readable by **Daily · Weekly · Season**:

| Section | Competes | Ranked by | Rewards |
| --- | --- | --- | --- |
| **Arena Picks** | players | correct Picks (Points) — rules unchanged, see [ARENA_PICKS.md](ARENA_PICKS.md) | Daily and Weekly. **Season = standings only.** |
| **Hero Arena** | heroes | **Arena Wins** — settled battles only | Daily and Weekly. **Season = standings only.** |
| **Hero Records** | heroes | Top-2 · KOs (Daily/Weekly/Season) and current PWR | **None, ever.** |

The two rewarded programs are independent: their own tables, their own pools, their own finalization, their own audit source. Neither reads the other.

## Ranking

* **Arena Wins** = `arena_participants.placement = 1` in a battle that is `SETTLED`. A battle belongs to the UTC day / Monday-week of its `settled_at` (the rule Picks use). Cancelled (`VOID`) and merely simulated battles count nowhere.
* **One season per period.** A Daily/Weekly board ranks one season only: the season of the last battle settled in the period among the seasons that count (`public.season_counts`). A new season's Tuesday never contains the old season's Tuesday, and Season 2 starts at zero everywhere.
* **Season scope** reads `season_character_stats` for the chosen season (current by default; `?season=<id>` for a past one). Standings only — no ladder, no payout.
* **Competition ranking by wins only** (1, 1, 3, 4, 4 …). Nothing else is a tiebreaker: not PWR, rarity, class, wallet, Telegram activity, or who won first. Tied heroes **pool** the prizes of the positions they occupy and split them equally (`distributePrizeGroups`, remainders in whole micro-tokens, never created from nothing).
* A hero must have at least `minimumWins` (default 1) wins to be prize-eligible.
* **Suspended heroes keep the wins they settled** (their row stays; it has no public link, like the hero page). A suspended hero cannot enter new battles. Re-rolling a hero does not touch its performance: results hang on the hero's id, not its look.

## Rewards

| | |
| --- | --- |
| Setting | `game_settings.hero_arena` = `{ enabled, dailyPrizePool, weeklyPrizePool, prizeSplitBps, minimumWins }` |
| Pools | **`null` = not set** (the default). The board says **Reward pool not set**; it still ranks and freezes, and pays nothing. **No amount is invented anywhere** — the Picks pools are not copied. Set them in Admin → Balance & config (`hero_arena`; an audited `settings.put`, like every setting). Admin → Hero Arena rewards shows both programs side by side (pools, what was paid, what is reserved or held) and resolves `HELD` prizes; it never edits a pool. |
| Ladder | `prizeSplitBps` — default Top 10: 30 / 20 / 15 / 10 / 8 / 6 / 4 / 3 / 2 / 2 % (the same shape as Picks, a separate setting) |
| Holder bonus | **None.** A wallet never changes a hero's rank or prize. |
| Payment | Credited to the owner's reward account (the same claimable balance every reward uses). There is no treasury key and no automatic on-chain payment: claims remain manual. |

### Owner attribution (no stealing path)

A prize belongs to the hero's **owner** — the Telegram member the hero is bound to:

| Hero state at finalization | Prize status | What happens |
| --- | --- | --- |
| claimed | `CREDITED` | credited to the owner's reward account |
| not claimed | `RESERVED` | held against that hero + owner; credited when **that** member claims the hero (a Telegram sign-in as that member). Never redistributed to another hero. |
| owner under review / flagged / banned | `HELD` | an admin releases or forfeits it (audited); nobody shifts up silently |
| no Telegram owner (special character) | `NONE` | keeps its rank; its share returns to the reserve |
| held prize forfeited | `FORFEITED` | returns to the reserve |

The public board shows `CREDITED`, `RESERVED` and `NONE` only; `HELD` / `FORFEITED` are never shown publicly. A claim releases its reserved prizes in a **separate transaction after** the claim commits; a sweep also releases any reservation whose hero has since been claimed (safety net), so a crash between the two loses nothing.

### Finalization

`finalizeDueHeroBoards` (the worker's sweep and `/api/internal/tick`) freezes every ended Daily/Weekly period that has settled battles, oldest first, at most **8 per kind per pass** (catch-up is bounded; while a backlog remains the next pass starts straight away). **Finding what is due is constant-cost:** every pass probes only the last 8 ended periods (one index probe each); the exact scan of *all* settled battles — which catches a period that was stuck behind an unsettled battle, or an outage longer than the window — runs on the first pass, every 5 minutes after that, and while a backlog drains. Idempotent, safe from many workers, a quiet no-op before the migration, never throws into the caller. A finalized period is read from its frozen rows — never recomputed. The `FINALIZING` chip appears for an ended period that is not frozen yet. Hero periods count toward "unfinalized periods" in END SEASON / LAUNCH only when a pool is set and prizes are on.

### Ledger and audit

`arena_reward_ledger` learns two kinds, `HERO_ARENA_DAILY_REWARD` and `HERO_ARENA_WEEKLY_REWARD`, with their **own** reference columns (`hero_period_kind`, `hero_period_start`, `hero_character_id`) so a Hero Arena credit can never satisfy the foreign key of a Picks one. A generated `reward_source` labels every ledger row: `ARENA_PICKS_DAILY`, `ARENA_PICKS_WEEKLY`, `HERO_ARENA_DAILY`, `HERO_ARENA_WEEKLY`. One prize per (hero, kind, period) is enforced by a unique index. `public.audit_hero_arena()` returns one row per violation: `CREDITED_WITHOUT_LEDGER`, `LEDGER_WITHOUT_CREDITED_RESULT`, `LEDGER_AMOUNT_OR_OWNER_MISMATCH` (the credit differs from the frozen prize or went to someone other than the hero's owner), `BOARD_TOTAL_MISMATCH` and `PRIZE_WITHOUT_OWNER`. It must return no rows.

## API

| Endpoint | Notes |
| --- | --- |
| `GET /api/leaderboard/hero-arena?scope=daily\|weekly\|season[&start=YYYY-MM-DD][&season=<id>]` | Hero Arena board + finalized period list + seasons. |
| `GET /api/leaderboard/records?metric=top2\|kos\|pwr[&scope=daily\|weekly\|season][&season=<id>]` | Hero Records. PWR has no scope (a current figure). |
| `GET /api/leaderboard/picks?period=daily\|weekly\|season` | Picks. `season` = standings only. |
| `GET /api/admin/hero-arena/overview` | Admin: boards, reserved/held prizes, pools. |
| `POST /api/admin/hero-arena/boards/:kind/:start/prizes/:hero/resolve` | Admin: release or forfeit a `HELD` prize (audited; it can only go to that hero's owner). |

Public rows carry the hero's public id, name, class, rarity, PWR and the period's numbers — **no Telegram id, no username, no wallet**. All handlers are wrapped in `guarded()` (503 `DB_UNAVAILABLE` + `Retry-After` on a database outage). Boards are cached in memory for 4 s; `serverNow` and personal data are stamped per request.

## Performance

Every board is a handful of **set-based** statements (3–7, flat regardless of how many heroes are shown) — no per-row queries. Indexes: `arena_battles_settled_idx` (partial, `settled_at` where `SETTLED`), and the result/board indexes of the migration.

**Measured on real Postgres** (scratch data set: 4,000 heroes, 40,000 settled battles = 320,000 participant rows over 30 days, 34 frozen periods = ~126,000 result rows; pool of 1 connection; the 4 s HTTP cache bypassed so this is the query cost; 60 runs each):

| Board | statements | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| Hero Arena Daily — running | 7 | 20 ms | 24 ms | 98 ms |
| Hero Arena Daily — finalized | 6 | 8 ms | 9 ms | 10 ms |
| Hero Arena Weekly — running | 7 | 24 ms | 26 ms | 27 ms |
| Hero Arena Weekly — finalized | 6 | 8 ms | 8 ms | 9 ms |
| Hero Arena Season | 3 | 11 ms | 12 ms | 13 ms |
| Records Top-2 / KOs — Daily · Weekly | 4 | 18–23 ms | 20–25 ms | 21–27 ms |
| Records Top-2 / KOs — Season · PWR | 3 | 10–11 ms | 12 ms | 12–15 ms |
| Picks Season | 3 | 0.4 ms | 0.5 ms | 0.9 ms |
| Idle worker sweep (what every tick pays) | — | 4 ms | 5 ms | 6 ms |
| Idle sweep, exact full scan (first pass / every 5 min) | — | 30 ms | 37 ms | 64 ms |

Two scans were found and fixed while measuring — both called `public.season_counts()` / `public.period_season()` **per row**:

* **Hero Arena** (`findFinalizingHeroPeriod`, run on every Daily/Weekly request, and the sweep's due-period query, run every tick): 139 ms per call at 40,000 battles and growing with history. The season test is now evaluated once against the few season rows, and the sweep probes the last periods by index (see Finalization): 139 ms → 0.3 ms (probe) / 11 ms (exact scan). Daily board p50 158 ms → 20 ms; a finalized board 151 ms → 8 ms.
* **Arena Picks** (pre-existing; `findFinalizingPeriod` runs on **every** Picks board request): it called `public.period_season()` once per score row, and that function scans the period's scores itself — quadratic in the number of picks (1.3 s for a few hundred rows). The three scans that list periods with scores (`findFinalizingPeriod`, the Picks sweep, the admin overview) now use the equivalent row-level `COUNTING_SEASON_SCORE` test: 1,338 ms → 14 ms Daily, 567 ms → 1 ms Weekly on the scratch data set, identical results (the Picks, lifecycle and rewards suites pass unchanged; `tests/unit/period-scan.test.ts` keeps the quadratic form out).

## Season lifecycle

* **While the game is still in DEVELOPMENT**, `rewardLiabilities` counts Hero Arena prizes that are `RESERVED` (owners who have not claimed their hero yet) or `HELD` (under review) next to the Picks ones: while any exist, resetting the development run and **LAUNCH SEASON 1** are blocked with the reason "Reward obligations exist". A development warning also says when a pool is set (finalized development boards would credit or reserve prizes — pause them while testing).
* **END SEASON** is blocked while a Daily/Weekly board of the season has results but is not finalized — Picks always, Hero Arena only when a pool is set and prizes are on (a period that was never going to pay cannot hold up the season).
* DB guards (unchanged): battles only in the ACTIVE season; no scheduling while `NOT_STARTED`; settled results frozen; roster of a prepared battle final.

## UI

`/leaderboard` — three section cards (the active one explains itself on a phone), one Daily/Weekly/Season selector shared by all of them, a **DEVELOPMENT / BETA** chip while the season is a development run, a season selector when there is more than one season, prize ladders **only** on rewarded Daily/Weekly views, compact empty states, and a hero link only for active heroes. The state is shareable as a link: `?section=picks|hero-arena|records&scope=daily|weekly|season&metric=top2|kos|pwr`. Verified at 1920 · 1600 · 1440 · 1366 · 1280 · 1024 · 900 · 768 · 430 · 390 · 375 · 360 · 320 with no horizontal overflow on any of the 13 views.

The old "Community" and "Season Rank" top-level boards are gone; "Hero Records" replaces them (Season Rank is the Season scope of Hero Arena).

## Migration `20261007002200_hero_arena_rewards.sql`

Additive only: nothing at or below `20261007002100` is edited and no row is rewritten. **Not applied to any live database.** The code is safe to deploy **before** the migration: `heroArenaReady()` (cached 30 s, never caches an outage as "not ready") makes the boards read as empty-and-unrewarded and the sweep a no-op; the Picks ledger insert path is untouched.

Rollback notes: before any `HERO_ARENA_*` ledger row exists, the migration can be reversed in dependency order — drop `audit_hero_arena()`, the `reward_source` column and its index, the hero columns/constraints/indexes on `arena_reward_ledger` (restore `arena_reward_ledger_kind_check` / `_sign_rules` from `20261006002100`), then the `hero_arena_results` and `hero_arena_boards` tables and `guard_hero_arena_result()`. **After** a Hero Arena credit exists, do not roll back (the ledger is append-only and a credit is a liability): set `hero_arena.enabled = false` (prizes pause; boards still freeze) or leave the pools unset instead.

## Tests

`tests/unit/hero-arena-domain.test.ts`, `hall-ui.test.ts`, `period-scan.test.ts`; `tests/integration/hero-arena.test.ts`, `hero-arena-migration.test.ts`; real-Postgres `hero-arena-postgres.test.ts` (`CLANK_TEST_PG_URL`: 20 parallel finalizations, a day and a week at once, claim racing the sweep, two admins resolving one held prize, Picks and Hero Arena finalizing side by side); `tests/security/hero-arena-http.test.ts`; extended `db-pressure` / `db-outage-http`; the generic `tests/security/rls.test.ts` covers the new tables (RLS on, `clank_harden_schema()`). They cover: wins-only ranking, UTC boundaries, pooled ties, owner attribution (claimed / unclaimed / banned / special), release on claim, exactly-once under concurrency, Season 1 → Season 2 isolation, separate finalization and ledger sources, admin resolution, and no PII in any public payload.
