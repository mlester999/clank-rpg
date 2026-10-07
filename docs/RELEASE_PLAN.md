# Staged LIVE release plan — leaderboard economy · upcoming Picks · Telegram 50 · combat 3.0.0 · hero versions · rarity power · game lifecycle & seasons · +69 heroes

> **THIS IS A PLAN. NOTHING IN IT HAS BEEN EXECUTED.** Every command below writes to the LIVE database or to production, so each is run **by the owner**, one stage at a time,
> after reading the verification of the stage before. Nothing here was applied, deployed, committed or pushed by the build sessions.
>
> Never run plain `pnpm db:migrate` against live: it applies *every* pending migration at once and then seeds reference data. Use the explicit `--up-to <version>` commands below
> (they apply the pending migrations up to and including that version only, and skip seeding), with `pnpm release:audit` (strictly read-only) between stages.

## 0. What is pending, in order

| # | version | purpose | destructive? | guards |
|---|---|---|---|---|
| 1 | `20261005001400_arena_picks_leaderboards` | the final leaderboard economy: **every valid Pick counts** (no per-day cap), Daily pool 100,000 / Weekly pool 500,000 `$CLANKRPG`, prize minimums 20 / 100 Picks, **logical** reward amounts (6-place micro-tokens, no contract decimals), holder-bonus ladder as DATA, append-only scoring / leaderboard / observation tables | drops the old cap columns and the per-battle reward schema | **refuses to run** if any per-battle reward, any reward amount, any claim or any unscored legacy pick exists (live has none) |
| 2 | `20261005001500_arena_picks_upcoming` | Arena Picks target the **upcoming** battle; the window closes when the battle on stage is decided; roster frozen after SCHEDULED | no (additive columns + trigger / function replacements) | — |
| 3 | `20261005001600_telegram_hero_threshold_50` | hero threshold 100 → **50** qualifying messages (one `UPDATE` of `game_settings.telegram`; creates nothing) | no | only moves a row that still holds exactly `100` |
| 4 | `20261005001700_combat_pacing_3_0_0` | combat rules **3.0.0** (median ≈ 37 s, hard cap 60 s) — settings only | no | only moves rows that still hold the exact 2.0.0 seed |
| 5 | `20261005001800_hero_versions` | **hero versions** (v1 INITIAL for every existing hero), stable public hero ids, reroll previews, integrity triggers + `audit_hero_versions()` | no data is dropped (`ALTER TABLE … ADD COLUMN`, new tables, new functions / triggers) | idempotent snapshot function; unique INITIAL per hero; deferred consistency triggers |
| 6 | `20261006001900_hero_rarity_power` | **rarity power system** (hero generator 2): the `SYSTEM_REBALANCE` hero-version action, the database tier guard (a generator-2 version's PWR must lie inside its rarity's band — Common 130–149 · Rare 150–169 · Epic 170–189 · Legendary 190–209), the read-only auditor `audit_hero_rarity_power()`, and a corrected column comment. **Touches no hero row, no version and no Arena row** — the existing heroes only move in the separate, guarded rebalance of Stage E3 | one `DROP CONSTRAINT` (the action CHECK is replaced by its superset; every old action stays valid) | **refuses to run** unless 1800 is applied |
| 7 | `20261006002000_game_lifecycle_seasons` | **game lifecycle & seasons** (see [`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md)): the persisted game phase (`game_state`, default **DEVELOPMENT**), season kinds (existing seasons become "Development / Beta" runs) with per-season **public battle numbers**, the Arena's persisted runtime **status** (the Arena keeps the state it had: paused → PAUSED, has run → RUNNING, never ran → NOT_STARTED), season-stamped Picks scores / points / boards, a database guard against rostering a non-eligible hero and against scheduling while NOT_STARTED / PAUSED, the read-only `audit_game_lifecycle()`. **Touches no hero, version, battle result, snapshot, hash, queue row or score; launches, resets and starts nothing** | none dropped (`ADD COLUMN`, new table / functions / triggers; the `seasons.number` NOT NULL is relaxed for development runs; one `UPDATE` relabels existing seasons as development runs and one adds the new columns' values) | **refuses to run** unless 1400 and 1500 are applied |
| 8 | `20261006002100_development_economy_archive` | **development progress must not carry into Season 1** (see [`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md) §Development economy): achievement unlocks get an `id`, a `season_id` and an `archived_at` (the (hero, achievement) primary key becomes a unique index over the NON-archived rows, so an archived development unlock never blocks the same achievement being earned officially), loot gets `archived_at` / `archived_season_id` plus a CHECK that archived loot is never equipped, and the read-only auditor `audit_development_economy()`. **Archives nothing by itself, touches no hero, version, ledger row, battle or reward row; the game stays in DEVELOPMENT** — the archiving happens only inside the (separate, typed-confirmation) Season 1 launch | none dropped (`ADD COLUMN`; one primary-key constraint is replaced by a surrogate key + partial unique index over the same columns) | **refuses to run** unless 2000 is applied |

The exact sha256 prefixes to approve **by hash** are printed by `pnpm release:audit` and listed in §9.

## 1. Why this order, and why the app and the database cannot be upgraded independently

* **Dependencies:** 1400, 1500, 1600, 1700 and 1800 do not need each other (any order gives the same schema); **1900 needs 1800** (it extends `hero_versions` and refuses to run without it); **2000 needs 1400 and 1500** (it extends the Picks leaderboard tables and the roster guard, and refuses to run without them); **2100 needs 2000** (it extends the lifecycle tables and refuses to run without them). The order above is chosen for risk: the economy first (it refuses to run on a
  database that holds money records, so it is the best canary), the pick lifecycle, then the two settings-only migrations, then the hero versions last.
* **1700 and 1800 must both be applied BEFORE the hero backfill:** the guarded backfill refuses while *any* migration is pending (its "schema behind" blocker), and the new hero-creation
  code writes `hero_versions` / `public_id`, which exist only after 1800. **1600 (threshold 50) must precede the Telegram webhook**, and **the excluded bot-like member must be blocked in Admin before the
  webhook is enabled** — the threshold migration lowers the bar, and the live webhook would otherwise turn that account into a hero on its next message (a test proves exactly this).
* **The code needs ALL of 1400–1800:** the matching app reads `arena_battles.picks_locked_at` (1500), the reward tables (1400) and `characters.public_id` / `hero_versions` (1800) unguarded.
  *New code on the old schema* shows `RECONNECTING… 0 / 8 HEROES` (the Arena state cannot be built). *Old code on the new schema* is also not safe: with 1500 applied the database refuses a
  pick for any battle that is already on stage — which is the only thing old code ever offers — and with 1400 applied the old leaderboard queries address a renamed table.
  **So there is no overlap that works: migrate and deploy in ONE short window, with the Arena stopped and the Picks feature flag OFF, and bring the new code up before anything starts the Arena again.**
  The window is Stages A → H (minutes; the longest step is the 69-hero backfill, ~1–2 minutes). Until Stage J the Telegram webhook stays off, so no hero can be created by old code against the new constraint.
* **Never run old code against the new database:** a deploy that is *rolled back* after Stage E must be rolled back together with the database (§8), not left half-way.

## STAGE 0 — preparation (no migration, no data change)

```bash
# 0.1 Stop everything on YOUR machine that talks to the live database. Look first; stop only what you recognise (never `pkill` by pattern).
lsof -nP -iTCP:3700 -sTCP:LISTEN            # your `pnpm dev` (it uses the live .env) — Ctrl-C it in its terminal
ps -axo pid,etime,command | grep -E "arena-worker|arena:worker|next dev|next-server" | grep -v grep     # nothing may be left
```
```bash
# 0.2 Confirm no Arena worker anywhere else (a worker on another host would keep advancing the arena through the migrations):
#     Admin → Arena shows "last advance"; it must stop moving. `pnpm release:audit` prints it too.
pnpm release:audit -- --excluded-ids 5530802189 --json /tmp/clank-pre-release.json
#   EXPECT (as audited): 10 applied (…001300 last) · 8 pending in the order 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100 · characters 70 (52 ACTIVE / 18 SUSPENDED → ARENA-ELIGIBLE 52) ·
#           reward ledger / claims / accounts / unscored = 0 · hero versions NOT PRESENT · unsettled battles: none (the arena is idle) ·
#           the excluded id: status + "no hero" — and, until you complete 0.6, the warning "NOT blocked".
#   "TOTAL heroes" and "ARENA-ELIGIBLE" are DIFFERENT numbers: a suspended hero exists (it keeps its history and its public id) but is not queued and has no public page.
```
```bash
# 0.3 Recovery point. Supabase dashboard → Project → Database → Backups: confirm a backup / point-in-time-recovery position from the last hour (Pro), or take your own dump
#     with the DIRECT connection string (not the pooler), and keep the file:
pg_dump "$DIRECT_DATABASE_URL" --no-owner --format=custom --file "clank-pre-release-$(date +%Y%m%d-%H%M).dump"
```
```bash
# 0.4 Verify the files are the ones that were audited (compare with §9):
shasum -a 256 supabase/migrations/20261005001[4-8]*.sql supabase/migrations/20261006001900*.sql supabase/migrations/20261006002000*.sql supabase/migrations/20261006002100*.sql | awk '{print substr($1,1,8), $2}'
# 0.5 Dry run: lists, changes nothing. EXPECT exactly: 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100 pending, in this order.
pnpm db:migrate -- --dry-run
```
```bash
# 0.6 Block the excluded bot-like member through the ordinary moderation control, BEFORE anything lowers the threshold:
#     Admin → Telegram → find the member → set status FLAGGED (or BANNED) with a reason, e.g. "community bot — not a player".
#     (Nothing in the code knows this id; the live webhook refuses to create a hero for any member whose status is not OK.)
pnpm release:audit -- --excluded-ids 5530802189          # EXPECT: status FLAGGED/BANNED "(blocked)"
# 0.7 Switch the Picks feature off for the window so no player meets an error: Admin → Feature flags → `arena.picks` OFF.
# 0.8 The fresh, read-only hero preview (reads LIVE through read-only transactions; replays into an in-memory scratch database):
pnpm telegram:backfill-heroes -- --preview-shipped-threshold --scratch-check --exclude-ids 5530802189 --report /tmp/clank-hero-preview-pre.json
#   EXPECT: 70 existing · 69 NEW · 139 total · 0 drift · scratch: existing/created/total 70/69/139 · TOTAL 139 / ARENA-ELIGIBLE 121 / not eligible 18 (the 18 suspended heroes, all existing) ·
#           preserved true/true/true · hero versions: existing with INITIAL v1 70 · new 69 · total 139 · missing 0 · existing changed 0 · snapshot mismatches 0 · 2nd run 0 · audit violations 0 ·
#           info: 70 heroes whose CACHED characters.power is stale (see STAGE E2 — the migration does not touch it).
#           RARITY POWER (the scratch replay now also rebalances the 70 and checks all 139): attempted/rebalanced/deferred 70/70/0 · SYSTEM_REBALANCE v2 on 70 · v1 rows changed 0 · class/rarity/identity changed 0 ·
#           versions created by a 2nd run 0 · all 139 on hero-gen/2 · invalid PWR 0 · outside rarity band 0 · bands non-overlapping true · missing sprite layers 0 · audit_hero_rarity_power() rows 0 ·
#           rarity counts COMMON 105 / RARE 22 / EPIC 12 / LEGENDARY 0 (as audited 2026-10-06; a re-preview after new messages may differ slightly) · all-139 PWR: Common 131–147 · Rare 151–165 · Epic 174–185.
#   If the numbers differ: STOP. Do not guess — find out why (the report lists every member that crossed the threshold).
```
**GO / NO-GO:** every EXPECT above holds, the backup exists, the hashes match, no process is writing to live.

## STAGE A — leaderboard economy

```bash
pnpm db:migrate -- --up-to 20261005001400
pnpm release:audit
```
Verify: `20261005001400` applied; `game_settings.arena_picks` upgraded (Daily pool 100,000 / Weekly 500,000, minimums 20 / 100, no per-day cap key); the reward tables exist and are empty. If it **refuses**, nothing was changed (it aborts before writing): read the message.

## STAGE B — upcoming Picks

```bash
pnpm db:migrate -- --up-to 20261005001500
pnpm release:audit
```
Verify: `arena_battles.picks_locked_at` exists; no unsettled battles; nothing else changed.

## STAGE C — Telegram threshold 100 → 50

```bash
pnpm db:migrate -- --up-to 20261005001600
pnpm release:audit -- --excluded-ids 5530802189
```
Verify: `telegram.qualifyingThreshold` = **50**; **characters = 70 still** (the migration creates nothing); the excluded member is still blocked and has no hero.

## STAGE D — combat rules 3.0.0

```bash
pnpm db:migrate -- --up-to 20261005001700
pnpm release:audit
```
Verify: `arena.maxCombatMs` = **60000**; `combat.pace` = `{"time":1.95,"move":1.1}`.

## STAGE E — hero versions + public hero ids

```bash
pnpm db:migrate -- --up-to 20261005001800
pnpm release:audit
```
Verify (all must hold): **70 characters, 70 INITIAL versions, 0 heroes without one, `audit_hero_versions()` = 0 violations**; characters still 70; the same suspended heroes are still suspended. (The migration copies each hero's stored state verbatim; every pre-existing column is unchanged, `updated_at` included.)

## STAGE E3 — rarity power: migration 1900, then the SYSTEM REBALANCE of the existing heroes

*Why a separate step:* rarity became a real strength tier (see [`RARITY_POWER.md`](RARITY_POWER.md)). The 70 existing heroes were made by the first generator, whose PWR sits outside the new bands. The migration only adds the schema; the heroes themselves move through a guarded, deterministic script that appends ONE `SYSTEM_REBALANCE` version per hero (same hero, owner, public URL, **class, rarity and identity**; stats/PWR fitted into the hero's own rarity band; rarity visual layers added). **v1 is never touched.** No Arena result is read or written.

```bash
pnpm db:migrate -- --up-to 20261006001900
pnpm release:audit                                                    # rarity power: 70 on hero-gen/1 · audit_hero_rarity_power(): 70 not yet rebalanced / 0 outside band
pnpm exec tsx scripts/rebalance-heroes.ts --report /tmp/clank-rebalance-dry.json          # DRY RUN: reads in read-only transactions, writes nothing
pnpm exec tsx scripts/rebalance-heroes.ts --apply --expect-heroes 70                      # appends the 70 SYSTEM_REBALANCE versions
pnpm release:audit                                                    # rarity power: 70 on hero-gen/2 · audit_hero_rarity_power(): 0 / 0 · hero versions 140 (70 INITIAL + 70 SYSTEM_REBALANCE)
```
Dry-run EXPECT: 70 community heroes due · results outside their band **0** · non-deterministic **0** · class / rarity / seed / identity changes **0**. `--apply` refuses unless `--expect-heroes` equals the number due, refuses while 1900 is missing, and DEFERS (reports, does not touch) any hero that sits in an unsettled Arena roster — the arena is idle at this point, so none should be deferred; run again if any were. The run is idempotent (a rebalanced hero is skipped). Rebalancing also refreshes each hero's cached `characters.power`, which makes Stage E2 unnecessary for these heroes.
Verify: every hero's CURRENT version is `hero-gen/2`; the public `/heroes` page shows every PWR inside its rarity's band; a spot-check of one hero shows v1 INITIAL unchanged and v2 SYSTEM_REBALANCE with the same class and rarity.
**Do the rebalance BEFORE the app is deployed / the Arena restarted** — until a hero is rebalanced the new pages show its old stats under the new PWR formula, which can sit outside its rarity's band.

## STAGE E4 — game lifecycle & seasons: migrations 2000 and 2100 (nothing is launched, reset, archived or started)

*Why:* the game is in development — today's battles, wins and Picks are test data — and Season 1 must later start clean with every hero exactly as it is. This migration is the database side of that ([`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md)). It is **additive and switches nothing on**: the game stays in **DEVELOPMENT**, nothing is reset, the Arena is not started.

```bash
pnpm db:migrate -- --up-to 20261006002100      # 2000 (lifecycle) then 2100 (development-economy archive columns): both additive, both archive nothing
pnpm release:audit                    # "Game lifecycle": phase DEVELOPMENT · Arena status RUNNING (live has run battles: the migration carries the state it had; an idle worker-less Arena just stays idle) ·
                                      #   seasons: the existing season is now ONE development run "Development / Beta" (still ACTIVE) with its last public battle number · audit_game_lifecycle() findings 0 ·
                                      #   reward liabilities: none (the reward tables are empty on live) · launch preconditions listed (NOT YET until the Arena is paused, which is expected)
```
Verify: `characters` still 70 (or 139 after Stage G), every hero row, version and battle result unchanged (the audit's hero counts match Stage 0.2); `arena_state.paused` still mirrors the status; the old season is now a **development run** — never called "Season 1".
**Order:** apply after 1400 and 1500 (it refuses otherwise), before the code deploy (Stage H) — the new application needs the new tables. The previous app version keeps working against the new schema until then (its Admin pause toggle is translated to a status move).
**After the deploy the Arena keeps the state it had.** On live it was running (1,488 settled test battles, no worker), so once a worker starts (Stage I) it will keep making *development* battles exactly as before. If you want a quiet Arena until the launch, open Admin → **Game control** after Stage H and press **Pause Arena** (it pauses at once when nothing is committed). **Do NOT press Launch Season 1 as part of this release** — that is the separate, explicitly approved launch ([`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md) §9).

## STAGE E2 — OPTIONAL, owner decision: refresh the stale cached POWER

*A finding of the final read-only audit, present on live TODAY and not caused by anything in this release.* `characters.power` is a cache that only some events refresh. For all **70 of 70** live heroes it is 2–9 points
**higher** than the arithmetic on their stored components (no wallet, gear or claim is involved) — consistent with heroes created before the level / XP removal and never refreshed. Consequences today: the **POWER** leaderboard and the Admin hero list show the cached figure,
while the hero page, the Arena snapshots and the new cards show the freshly computed one. Migration 1800 **does not touch the cache** (the 70 existing heroes stay byte-identical, as required), and the new public pages always show the fresh figure (a directory tile can never disagree with its profile).
If you want the leaderboard to agree with what heroes fight with, run this once **after Stage E** (a deliberate change of up to 70 cached numbers; heroes with a wallet or gear component are skipped):

```sql
-- 1) dry run (read-only): who would change
select c.public_id, c.power as cached, v.power as fresh
  from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id join public.character_stats s on s.character_id = c.id
 where c.power <> v.power and s.holdings_bonus = '{}'::jsonb and s.loyalty_bonus = '{}'::jsonb and s.trading_bonus = '{}'::jsonb
   and not exists (select 1 from public.inventory_items i where i.character_id = c.id and i.equipped)
 order by c.power - v.power desc;
-- 2) apply
begin;
update public.characters c set power = v.power
  from public.hero_versions v, public.character_stats s
 where v.id = c.current_hero_version_id and s.character_id = c.id and c.power <> v.power
   and s.holdings_bonus = '{}'::jsonb and s.loyalty_bonus = '{}'::jsonb and s.trading_bonus = '{}'::jsonb
   and not exists (select 1 from public.inventory_items i where i.character_id = c.id and i.equipped);
commit;
```
Verify: `pnpm release:audit` → "heroes whose CACHED characters.power is stale … 0 of 70". Skip this stage and nothing breaks; the only visible effect is the existing mismatch between the POWER leaderboard and the hero page.

## STAGE F — fresh hero preview (expect 69)

```bash
pnpm telegram:backfill-heroes -- --preview-shipped-threshold --scratch-check --exclude-ids 5530802189 --report /tmp/clank-hero-preview-post.json
```
EXPECT: 70 existing · **69** new · 139 total, with the scratch proof lines of Stage 0.8. (`--preview-shipped-threshold` is not needed once Stage C has run — the stored threshold is already 50 — but is harmless and pins the preview.)

## STAGE G — guarded hero backfill (APPLY)

```bash
pnpm telegram:backfill-heroes -- --apply --expect-new-heroes 69 --exclude-ids 5530802189
pnpm release:audit -- --excluded-ids 5530802189
pnpm telegram:backfill-heroes -- --preview-shipped-threshold --exclude-ids 5530802189      # a SECOND preview: must report 0 new
```
Verify: **139 characters, 139 INITIAL versions (209 versions in all: + the 70 SYSTEM_REBALANCE ones), 0 missing, `audit_hero_versions()` = 0, `audit_hero_rarity_power()` = 0 rows (the 69 new heroes are born on hero generator 2, inside their bands), ARENA-ELIGIBLE 121** (139 minus the 18 suspended; subtract any further suspension), the excluded member has no hero, the second preview says **0 new**. (`--expect-new-heroes 69` makes the run refuse unless exactly 69 are due; each hero is created in its own transaction together with its INITIAL v1, so a rerun after an interruption is safe — take a fresh preview and a fresh `--expect-new-heroes`.)
Note: `pnpm telegram:verify -- <export> --require-heroes` *fails by design* while a member is excluded (one eligible member has no hero) — that is expected.

## STAGE H — deploy the matching application code

Deploy exactly the tree that was audited (the one `pnpm build` passed on) through your usual route, **with the new schema already in place**. Make sure the deploy environment has the same `CLASS_ROLL_SECRET`, `TELEGRAM_HASH_PEPPER`, `SESSION_SECRET`, `NEXT_PUBLIC_APP_URL` (the canonical origin used in hero share links and Open Graph tags), and **no** `CLANKRPG_TOKEN_DECIMALS` (retired). `CLANKRPG_TOKEN_ADDRESS` stays unset — the token has not launched.
Verify on the deployed site: `/api/health` ok · `/heroes` lists the heroes (139 minus any suspended) · a hero profile opens and its **Download card** returns a 1200 × 1200 PNG · the nav **BUY $CLANKRPG** button points to `https://clank.trade/` · Admin → Heroes → open a hero → "Hero card & versions" loads (do **not** apply a reroll as a test on live — use *Preview* only).

## STAGE I — start EXACTLY ONE Arena worker

```bash
pnpm arena:worker          # on the always-on host; ONE copy
```
Verify within a minute (if the Arena is RUNNING — see Stage E4; a paused / not-started Arena shows its own calm screen and makes no battle): the Arena page leaves `RECONNECTING…` and shows `8 / 8`; `pnpm release:audit` shows 3 unsettled battles (on stage + 2 prepared); battles settle and new ones are prepared; Admin → Arena "last advance" keeps moving. Then turn the `arena.picks` flag back **ON** and make one test pick as yourself.

## STAGE J — enable the Telegram webhook LAST

```bash
pnpm telegram:webhook -- info
pnpm telegram:webhook -- set https://<your-domain>/api/telegram/webhook
```
Verify: a test message from a normal member is ingested; the **blocked member's** next message (or a message from any FLAGGED / BANNED member) creates **no** hero — `pnpm release:audit -- --excluded-ids 5530802189` still says "no hero". Watch Admin → Telegram for the first creations: every new hero must appear with its INITIAL v1 (`audit_hero_versions()` stays 0).

The token contract is **not** needed for any of this. Holder bonus stays 0 % and claims stay closed until `CLANKRPG_TOKEN_ADDRESS` is set after launch.

## 8. If something goes wrong

* **Stages A–D** are settings/data-guarded or additive — stop at the failing stage; nothing after it has run. 1400 refuses on its own preconditions without writing.
* **Stage E (hero versions)** — if you must back out BEFORE any reroll or backfill: with the app stopped, run in the Supabase SQL editor (one transaction):
  ```sql
  begin;
  drop trigger if exists characters_hero_projection on public.characters;
  drop trigger if exists character_stats_hero_projection on public.character_stats;
  drop trigger if exists character_appearances_hero_projection on public.character_appearances;
  drop trigger if exists characters_require_current_version on public.characters;
  drop trigger if exists characters_guard_public_id on public.characters;
  alter table public.characters drop constraint characters_current_version_fk;
  alter table public.characters drop column current_hero_version_id, drop column public_id;
  drop table public.hero_reroll_previews;
  drop table public.hero_versions;
  drop function public.audit_hero_versions(), public.hero_projection_mismatch(uuid), public.check_hero_projection(), public.require_current_hero_version(),
                public.hero_snapshot_initial_version(uuid, text), public.hero_generated_stat(jsonb, jsonb, jsonb, jsonb, text), public.guard_hero_version_immutable(),
                public.guard_hero_public_id(), public.new_hero_public_id();
  delete from supabase_migrations.schema_migrations where version = '20261005001800';
  commit;
  ```
  After the backfill (Stage G) or any reroll, restore from the Stage 0.3 recovery point instead of editing.
* **After Stage H** an app rollback must be paired with the database rollback above; never leave the old code running against the new schema (§1).

## 9. Approved hashes (sha256 prefix of each pending file) — as audited

| version | sha256 (first 8) |
|---|---|
| `20261005001400_arena_picks_leaderboards` | `603118b4` |
| `20261005001500_arena_picks_upcoming` | `8477f73b` |
| `20261005001600_telegram_hero_threshold_50` | `f1a94367` |
| `20261005001700_combat_pacing_3_0_0` | `ffbb47a4` |
| `20261005001800_hero_versions` | `be921aea` |
| `20261006001900_hero_rarity_power` | `f2d2660f` |
| `20261006002000_game_lifecycle_seasons` | `9c65aac4` |
| `20261006002100_development_economy_archive` | `a108e808` |

Re-print them with `pnpm release:audit` (or `shasum -a 256 supabase/migrations/20261005001[4-8]*.sql supabase/migrations/2026100600[12]*.sql` (the glob includes 2100)). **If any prefix differs from this table, the file changed after the audit — stop and re-audit before applying it.**
