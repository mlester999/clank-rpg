# Operations

## Environment variables

See `.env.example` for the annotated list. Production **requires**: `DATABASE_URL`, `SESSION_SECRET`, `CLASS_ROLL_SECRET`, `TELEGRAM_HASH_PEPPER`; and for each feature: `ADMIN_ACCESS_KEY` (admin console), `CRON_SECRET` (scheduler), `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` + `TELEGRAM_OFFICIAL_CHAT_ID` + `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` (Telegram), `ROBINHOOD_RPC_URL` (use a dedicated provider). Blank `KEY=` lines count as unset. Missing production secrets fail closed (the relevant routes return 5xx/403/503); nothing falls back to a development secret or a toy database.

## First deploy (Supabase + Vercel-style hosting; no Docker anywhere)

1. Create a Supabase project. Copy the **transaction pooler** connection string (port 6543) → `DATABASE_URL` (the web app). The arena worker and long scripts should use a direct / session connection (5432). Why, the driver's guarantees (no query pipelining, statement timeouts, bounded pool) and how to diagnose a hang: [`DATABASE_CONNECTIONS.md`](DATABASE_CONNECTIONS.md).
2. `DATABASE_URL=… pnpm db:migrate` (applies `supabase/migrations`, seeds reference data; idempotent). Or `npx supabase db push --db-url "$DATABASE_URL"`.
3. Set the secrets above on the host. Deploy.
4. **Keep the arena alive** — pick one:
   * **Scheduler:** call `GET/POST /api/internal/tick` with `Authorization: Bearer $CRON_SECRET` every minute (Vercel Cron sends this header automatically when `CRON_SECRET` is set — but Vercel's Hobby plan only allows daily crons, so use the worker there; add `?scan=1` hourly, `?trades=1&holdings=1` every few minutes). Between ticks the arena also advances whenever someone has the site open.
   * **Worker (REQUIRED for a Global Arena that runs on its own):** run `pnpm arena:worker` on an always-on host (Fly, Railway, a VPS — ideally in the database's region). It advances the arena exactly when a transition falls due (at most 1 s apart), prepares the next battle before the results screen ends, and does not depend on any browser tab; running it alongside the web app (or two copies) is safe (row-locked). Without it the arena only advances while someone has the site open — see `docs/ARENA_TIMING.md` for the measured behaviour and the exact reasoning. Add `?photos=1` to the tick (every few minutes) once the Telegram bot is live to cache hero profile photos.
   * **Arena Picks leaderboards ($CLANKRPG):** picks are **scored** right after a battle settles, in their own transaction — the web app does it fire-and-forget; no token is credited per battle. `pnpm arena:worker` and `/api/internal/tick` do it every tick **and also** (1) re-read a bounded batch of **due holder wallets** (background holder verification, ~every 30 min per wallet with jitter; every success is an immutable observation — the evidence a holder bonus is decided from), (2) **finalize every ended Daily and Weekly board** (00:00 UTC / Monday 00:00 UTC; idempotent, waits for the period's battles to be scored, takes a fresh *close verification* of each prize winner's wallet first) and (3) **reconcile bonuses whose close verification failed** (re-checked every tick; expire after `holderReconcileHours`). Apply migrations **`20261005001300_arena_picks_rewards.sql` (already applied to live) and then `20261005001400_arena_picks_leaderboards.sql` BEFORE deploying the code that needs it** (the reward sweeps are a quiet no-op until the new tables exist; the picks/leaderboard endpoints answer 503 until then); restart any running worker/dev server afterwards. Set `CLANKRPG_TOKEN_ADDRESS` **after the token launches** — it is the only token setting (the chain is the existing `ROBINHOOD_RPC_URL` / `ROBINHOOD_CHAIN_ID`; decimals and symbol are read from the contract). Until then the token has not launched: nobody earns a holder bonus (everyone is 0 %), claims open after launch, holder verification and on-chain payout verification are unavailable, and prizes simply accumulate — the Arena, Picks and both boards are unaffected. **There is no treasury key and no sender: payouts are manual.** Run ONE worker (two are safe — every step is atomic/idempotent). **Watch Admin → Overview for *overdue holder wallets*:** a wallet that goes more than `holderMaxAgeHours` (6 h) without a successful check loses its continuity, so keep the tick running and raise `holderCheckBatchSize` if wallets outnumber ~750 per 30 minutes.
   * **Paying claims (manual):** Admin → Arena Picks → **Claims** → *Pending*. For each claim: *Copy wallet* and *Copy amount* (the **exact full-precision** amount — send exactly that), send the $CLANKRPG from your reward wallet, wait for ≥ 2 confirmations, then *Mark sent* with the transaction hash — the server verifies the transfer read-only (successful, right chain/token/recipient/amount, unique tx) before the claim becomes SENT; a message tells you what is wrong otherwise and the claim stays PENDING. *Deny* needs a reason; the member's reservation returns to claimable. Watch Overview (the leaderboard economy and its maximum liability, Season 1 plan, coverage, overdue holder wallets), Holders & token (Official Contract, Metadata Verified, Symbol and Decimals detected from the contract, RPC, each wallet's Daily/Weekly bonus qualification), Daily & Weekly (running periods, any *Not finalized yet* warning → *Re-run safe finalization*; held prizes → Release/Forfeit; bonuses pending verification → Re-verify / Give up) and Reconciliation (healthy = an empty list). There is deliberately no "reset leaderboard".
   * **Hero profile photos:** set `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (server only) and apply migration `20261005000900` (creates the private `hero-avatars` bucket) — see `docs/HERO_PROFILE_PHOTOS.md`.
   Without either, the queue still resumes exactly where it left off, but heroes only fight while someone is watching.
5. Telegram: follow `docs/TELEGRAM.md`; then `pnpm telegram:import -- result.json` for history.
6. Chain: `pnpm chain:probe`, then Admin → Coins → *Scan catalog* and approve bonded coins.
7. Sanity: `GET /api/health` → `{ ok: true, driver: "postgres", schemaVersion }`.

## Deploying the sprites + picks phase (migration order matters)

Migration `20261005000700_sprites_and_picks` adds `character_appearances.sprite` / `cosmetic_overrides` and the `arena_picks` table. **Apply it BEFORE any code from this phase runs against that database**: `loadFighters`, `createCharacterForUser` and the boot-time seed (`backfillSpriteConfigs`) all reference the new columns, so new code against an un-migrated database fails at the first arena request. New settings (`picks`, `visuals`) and the `arena.picks` flag need no migration — they are inserted at boot and missing rows fall back to defaults. Heroes that predate the migration are derived and backfilled automatically at boot.

Sprite art: `public/sprites/<set>/` is static; `pnpm sprites:build` regenerates the dev placeholder set, `pnpm sprites:validate -- <set> --strict` is the acceptance check for any set.

## Applying a single migration to a live database (hero admin: `20261005000800`)

`pnpm db:migrate` applies **every** pending file in `supabase/migrations` and then seeds reference data. When more than one migration is pending (for example `…000800_hero_admin` and `…000900_hero_profile_photos`) and you only want one, use the bounded form, and always dry-run first:

```bash
pnpm db:migrate -- --dry-run --up-to 20261005000800   # read-only: prints what WOULD be applied; changes nothing
pnpm db:migrate -- --up-to 20261005000800             # applies migrations through 800 only; later ones stay pending; no reference seeding
pnpm db:inspect                                       # read-only health report afterwards (lists applied migrations)
```

Read the printed `→ database:` line first — it says whether the target is `LIVE postgres://…` or a local PGlite directory. `--up-to` needs a 14-digit version; anything else is refused. Migration 800 only adds nullable columns and one `CHECK`, so deploying code before it breaks only the **Admin → Heroes** tab (public pages already read `name_override`) — still apply it first. Details and the rollback statement: `docs/HERO_ADMIN.md` §4.

## Hero versions, public hero pages and card images

* **Release order and checks:** `docs/RELEASE_PLAN.md` (stage by stage, with `pnpm db:migrate -- --up-to <version>` and the read-only `pnpm release:audit` between stages). Never run plain `pnpm db:migrate` against live.
* **Rarity power** (`docs/RARITY_POWER.md`): migration `…001900` adds the `SYSTEM_REBALANCE` action, a PWR-band guard and `audit_hero_rarity_power()`; the existing heroes move onto the new system with `pnpm exec tsx scripts/rebalance-heroes.ts` (dry run by default; `--apply --expect-heroes N`). After it, `select * from public.audit_hero_rarity_power();` must return no rows. `pnpm rarity:sim` / `rarity:calibrate` / `rarity:bench` re-measure balance, the class factors and the Arena effect cost.
* **Hero versions** (`docs/HERO_VERSIONS.md`): migration `…001800` snapshots every existing hero as v1 INITIAL and adds stable public ids. After it, `select * from public.audit_hero_versions();` must return no rows. Admin → Heroes → open a hero → "Hero card & versions" previews / applies / rolls back rerolls (unlimited; refused while the hero sits in an unsettled Arena roster).
* **Public pages:** `/heroes` (directory) and `/heroes/<publicId>` (profile) are server-rendered and always current; `/api/hero-cards/<publicId>` serves the 1200 × 1200 PNG (drawn with `@napi-rs/canvas`, which is a runtime dependency; the route reads `public/sprites/**` and Next's bundled UI font — both are traced for serverless builds in `next.config.ts`). `NEXT_PUBLIC_APP_URL` must be the real production origin: it builds the canonical hero URLs and the social-card image URLs.
* **`CLASS_ROLL_SECRET`** must be the production value for rerolls as well (it keys the derived seeds and never leaves the server).

## Local development

**Safety:** a local `.env` may contain a real `DATABASE_URL`. Scripts and `pnpm dev` then talk to *that* database. For an isolated local run use a blank override and your own embedded database: `DATABASE_URL= CLANK_PGLITE_DIR=/tmp/clank-pglite pnpm dev` (seed with the same two variables; `CLANK_PGLITE_DIR` is honoured by the app and by scripts). Set `NEXT_DIST_DIR=.next-local` to run a second Next server beside another one.


**Measuring the arena's timing.** `CLANK_ARENA_TIMING_LOG=true` logs every arena step (duration, and how far before its planned start each battle was made ready); `CLANK_DEV_DB_LATENCY_MS=120` adds a fixed delay per statement (both the embedded database and a real `DATABASE_URL`; ignored in production) to rehearse a distant database; in the browser, `window.__clankArena.reports()` lists, per battle, when the new roster, the 3·2·1 and the first combat frame reached *that* viewer. See `docs/ARENA_TIMING.md`.

`pnpm dev` uses an embedded PostgreSQL (PGlite, `.data/pglite`) with the same migrations. It is single-process: don't run `pnpm arena:worker` against it while `pnpm dev` is running, and run seed scripts with the dev server stopped. `pnpm db:reset:local` wipes it.

## Runbooks

| Situation | Action |
| --- | --- |
| Something looks wrong in the arena | Admin → **Game control** → **Pause Arena** (the battles already committed finish first, then it is PAUSED; state is preserved). For a battle that went wrong: Admin → Arena → *Void unsettled battles* (heroes keep their turn) or *Abort cycle* (a fresh shuffled cycle starts) — emergency tools that work in any state. |
| Spammer / abuse | Admin → Telegram → Flag / **Ban** (suspends the hero, revokes sessions, recomputes the member). |
| Change balance | Admin → Balance & config. Validated, versioned; new battles use it, old ones stay reproducible. |
| Verify fairness | `pnpm battle:verify -- --last 200` (re-simulates and compares hashes). |
| Ledger audit | `select * from audit_currency_ledger();` — must be empty. |
| Provider outage | Holdings/trading report *unavailable* and keep previous verified state; the arena and Telegram are unaffected. |
| Rotate `CLASS_ROLL_SECRET` | Only affects heroes created afterwards (existing heroes keep their class forever). |
| Retention | Optionally null `arena_battles.events` for old settled battles; snapshot + seed + ruleset still reproduce them. Prune `telegram_updates` and `telegram_login_proofs` older than a week. |

## Game lifecycle, seasons and the Arena's runtime state

Full design and runbooks: [`GAME_LIFECYCLE.md`](./GAME_LIFECYCLE.md). In short:

* The game **phase** (`DEVELOPMENT` → `LIVE`, one way), the active **season** (a development run, or Season 1, 2 …) and the Arena **status** (`NOT_STARTED` → `PREPARING` → `RUNNING` ⇄ `PAUSE_REQUESTED` → `PAUSED`) are persisted in the database. **A worker never starts the Arena**: `pnpm arena:worker` idles through `NOT_STARTED` and `PAUSED` and resumes `RUNNING` after a restart exactly where the persisted state says.
* **Launch Season 1** and **Start Arena** are two separate Admin → *Game control* actions (typed phrase `LAUNCH SEASON 1`; `RESET ARENA` / `END SEASON` likewise). Launch needs the Arena stopped (pause it and let it drain), refuses while any reward is credited / reserved / claimed / held, archives the development run (nothing is deleted), leaves every hero exactly as it was and the Arena `NOT_STARTED`.
* **Season roll-over (LIVE):** Game control → *End season* (archive) → *Create next season* → *Start Arena*. The old season keeps its battles, snapshots and results (replayable); the new season counts battles from #1 and starts every hero's record at zero. Award `seasonal_champion` from Admin → Heroes → Grant.
* While the game is in DEVELOPMENT, run with leaderboard prizes paused (Admin → Arena Picks): a finalized board credits prizes, and a credited prize blocks the launch / reset until it is reversed.
* Read-only checker for all of it, safe against live: `pnpm release:audit` ("Game lifecycle" section: phase, seasons, Arena status, reward liabilities, launch preconditions).
