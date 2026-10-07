# Clank RPG — Beta

An idle/social RPG for the Clank.trade community. **Eight heroes, one survivor — on a loop, for everyone, at the same time.** (A fight lasts about 40 seconds and never more than 60.)

Heroes are created *automatically* from activity in the **official Clank.trade Telegram** (50 qualifying messages). Nobody signs up first; nobody creates a character by hand. A hero fights in the **Global Idle Arena** whether or not its owner ever visits the site, and its owner can later **claim** it by proving the same Telegram identity.

| | |
| --- | --- |
| **Live in the Beta** | Global Idle Arena (spritesheet heroes, **Arena Picks** panel — free picks on the **next** fight; correct scored picks earn Clank Points toward the Daily and Weekly **$CLANKRPG** leaderboard prizes) · automatic hero generation · character sheets · gear & Clank Gold · leaderboards (incl. seasons) · claiming · optional wallet link with bonded-coin bonuses · admin console |
| **Arena Picks** | **Free and unlimited** predictions: eligible members (50+ qualifying messages in the official Clank.trade community, an active hero) pick who wins the **next** fight while the current one is on stage (**one pick per upcoming battle; picks lock the moment the fight on stage has its winner**, see [`docs/ARENA_PICKS_LIFECYCLE.md`](docs/ARENA_PICKS_LIFECYCLE.md)); a correct pick earns **Points** — and **no token is paid per battle**. **Every valid pick counts** (there is no daily scoring cap; +10 Points per correct pick) toward two fair leaderboards: **DAILY** (00:00 UTC, **100,000 $CLANKRPG**) and **WEEKLY** (Monday 00:00 UTC, **500,000 $CLANKRPG**), each paying its **Top 10** (30/20/15/10/8/6/4/3/2/2 %), exact ties splitting the affected prizes, a minimum of 20 (daily) / 100 (weekly) valid picks to be prize-eligible (never a scoring cap), live server-time countdowns that roll over by themselves. Holding $CLANKRPG **never** changes a score, rank or tie-break — it adds a **bonus (+5 % … +25 %) on a prize you already earned**, and only with verified holding continuity from 24 h (daily) / 7 days (weekly) *before* the period began and until it ends; buying near the close unlocks nothing. No deposits, no wagers, no odds, no betting balance — a wrong pick costs nothing. Telegram is the account and nothing needs a wallet to play, pick or climb a board. **Tokens are paid by hand — the app holds no signing key:** a claim is a request (to your connected wallet or any other EVM address), an admin pays it and the server verifies the transfer on-chain read-only before marking it SENT. See [`docs/ARENA_PICKS.md`](docs/ARENA_PICKS.md) |
| **Locked / coming soon** | Bosses · Expeditions · Ranked PvP & challenges · Guilds / Community Wars · World |
| **Stack** | Next.js 16 · React 19 · TypeScript · Supabase Postgres · viem (Robinhood Chain) · Vitest — **no Docker** |

## Quick start (local, no accounts needed)

```bash
pnpm install
pnpm db:seed:demo -- --count 48 --start-arena   # clearly-labelled DEMO heroes in an embedded local database (+ press START on the disposable arena)
pnpm dev                                        # http://localhost:3700
```

A database never runs the Arena by itself (its runtime status is persisted): `--start-arena` presses START for a disposable local database, otherwise open Admin → **Game control** → *Start Arena* (set `ADMIN_ACCESS_KEY` in `.env.local`). Demo heroes carry a **Demo** badge, use negative Telegram ids (impossible for real members), and exist only in the local embedded database (`.data/pglite`). Set `CLANK_DEV_LOGIN=true` in `.env.local` to sign in as a demo hero and try claiming/gear/tactics.

```bash
pnpm test            # domain, database, import, security, HTTP handlers
pnpm typecheck && pnpm lint && pnpm build
pnpm balance:sim -- --battles 600 --mixed      # combat balance report
pnpm chain:probe                               # live, read-only check of Robinhood RPC + Clank.trade
pnpm battle:verify -- --last 50                # re-simulate stored battles and check their hashes
pnpm sprites:build && pnpm sprites:validate -- clank-dev-v1 --strict   # (re)generate + validate the placeholder sprite set
pnpm sprites:preview -- --out sheet.png        # contact sheet through the real runtime compositor
```

## What is real and what is not (read this first)

| Integration | Status |
| --- | --- |
| Combat engine, queue/cycles, settlement, ledger, leaderboards, RLS | ✅ Implemented and tested against real Postgres semantics (embedded PostgreSQL 18 running the real migrations) |
| Robinhood Chain RPC (chain 4663) · Clank.trade catalog/detail/trades | ✅ **Verified live** via `pnpm chain:probe` (see `docs/ECONOMY_AND_CHAIN.md`). Clank.trade's JSON is the site's own *unofficial* interface. |
| Wallet signature verification | ✅ Verified with real ECDSA signatures (EOA wallets) |
| Telegram webhook · Login Widget · historical import | 🟡 Implemented and tested with **fixtures** (HMAC-signed login payloads, Bot-API-shaped updates, Telegram Desktop export files). **Not verified against the real Telegram** — needs a bot token and chat id (`docs/TELEGRAM.md`) |
| Hosted Supabase | 🟡 Migrations verified on embedded PostgreSQL 18; the production `postgres.js` driver path is **not verified against a live Supabase project** (no credentials in this environment) |

## Layout

```
supabase/migrations/   schema, RLS, triggers (the only source of schema truth)
src/domain/            pure, deterministic game logic (combat, scoring, stats, queue, holdings) — no I/O
src/server/            database drivers, services, auth, chain adapters, API plumbing
src/app/               pages + API routes
src/components/        arena renderer + page (Current Round, spectator strip, picks), spritesheet engine, vector fallback hero, UI
public/sprites/        sprite sets (manifest + atlases) — currently the generated DEV placeholder set
scripts/               migrate · seed · arena worker · Telegram import · battle verify · chain probe · balance sim
tests/                 unit · integration (real schema) · security (RLS + HTTP)
docs/                  ARCHITECTURE · SPRITES (engine + production-art spec) · TELEGRAM · COMBAT · ECONOMY_AND_CHAIN · SECURITY · OPERATIONS · HERO_ADMIN · HERO_VERSIONS · **RARITY_POWER** · **GAME_LIFECYCLE** · RELEASE_PLAN · ARENA_PICKS · BETA_REPORT · PHASE2_REPORT
```

**Rarity is a real strength tier** (Common 130–149 · Rare 150–169 · Epic 170–189 · Legendary 190–209 PWR; hero generator 2) with its own visual package and a public **`/docs`** site — [`docs/RARITY_POWER.md`](docs/RARITY_POWER.md). **Heroes** are versioned (an immutable history; Admin can preview / apply / roll back a reroll — [`docs/HERO_VERSIONS.md`](docs/HERO_VERSIONS.md)), every hero has a public profile and a downloadable 1200 × 1200 card (`/heroes`, `/heroes/<id>`), **the game lifecycle** — a persisted DEVELOPMENT → LIVE phase, seasons (a development run, then Season 1, 2 …), a one-way typed-confirmation **Launch Season 1** that keeps every hero exactly as it is and leaves the Arena **not started** until an operator presses **Start**, with season-scoped battle numbers and records and Admin **Start / Pause / Resume / Reset** — [`docs/GAME_LIFECYCLE.md`](docs/GAME_LIFECYCLE.md); and the staged live release is in [`docs/RELEASE_PLAN.md`](docs/RELEASE_PLAN.md) (`pnpm release:audit` is its read-only checker).

Start with [`docs/BETA_REPORT.md`](docs/BETA_REPORT.md) for the full status and [`docs/PHASE2_REPORT.md`](docs/PHASE2_REPORT.md) for the sprites / arena-redesign / free-picks phase, then [`docs/HERO_ADMIN.md`](docs/HERO_ADMIN.md) for Admin → Heroes, RPG display names (rename is presentation-only) and the "Who becomes a hero?" eligibility cards, then [`docs/OPERATIONS.md`](docs/OPERATIONS.md) to deploy. The hero art that ships is **generated placeholder art** — see [`docs/SPRITES.md`](docs/SPRITES.md) for the spec that real art must meet.

> **Careful:** a local `.env` may point `DATABASE_URL` at a real database. For isolated local runs use `DATABASE_URL= CLANK_PGLITE_DIR=… pnpm dev` (see `docs/OPERATIONS.md`).
