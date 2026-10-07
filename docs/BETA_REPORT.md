# Clank RPG Beta — status report

> **SUPERSEDED IN PART (2026-10-06):** this report calls rarity "cosmetic-only". Rarity is now a real strength tier (PWR bands, stat budgets, richer visuals) — see [`RARITY_POWER.md`](RARITY_POWER.md). The rest of the report is unchanged history.

> **SUPERSEDED (2026-10-05, later the same day):** the betting direction mentioned below (test betting, wagering, a future 90/5/5 split) was abandoned and fully removed. Arena Picks are now free and reward Clank Points + tiered $CLANKRPG. The current design is [`ARENA_PICKS.md`](ARENA_PICKS.md); treat any betting/wagering text in this report as historical.

> **Update 2026-10-05:** spritesheet heroes, the redesigned arena page and free picks were added in a second phase — see [`PHASE2_REPORT.md`](PHASE2_REPORT.md) (and [`SPRITES.md`](SPRITES.md)). The test counts and the "procedural appearance" description below describe the original Beta.

Built from an empty directory (`clank-rpg/` contained nothing, so there was no existing code to reuse; the sibling `kalstonk` project was read only as a reference for the Clank.trade/Robinhood data contract, and none of its code or credentials were used). **Nothing was committed, pushed or deployed. No Docker. No real-money betting.**

## 1. What was implemented

**Global Idle Arena (the headline feature)** — one global, server-authoritative arena:
* Persisted cycles & queue: CSPRNG-seeded shuffle stored with the cycle, groups of 8 from the persisted order, each hero exactly one appearance per cycle, final partial group **carried forward** to the front of the next cycle (never padded/duplicated), banned/suspended heroes skipped, restart-safe.
* Battles: 8 heroes standing idle → 3·2·1 → combat starts immediately → ≤ 30 s hard cap → 1.2 s victory beat → **5 s results (#1 winner + #2 runner-up with portrait and name)** → next group, forever. Fixed camera; name · level · HP above every fighter; effects for attacks, hits, abilities, damage and eliminations; a closing storm ring and damage ramp so ~99 % of fights end with one survivor (median 18.5 s).
* Deterministic combat engine (versioned `1.0.0`): seeded RNG, simultaneous resolution, class AIs and tactics, central tie-break order, snapshot + seed + ruleset hash + events hash persisted, results frozen by trigger, replays re-simulated and verified.
* Synchronised for all viewers (server clock offset estimation, transition-aware polling); lazily advanced by viewers, a cron endpoint, or `pnpm arena:worker`.

**Heroes & Telegram** — official-chat-only webhook; deterministic anti-spam scoring (duplicates, rate, burst, short, filler, links, forwards, daily cap); hybrid activity score; auto-flagging; 50-qualifying-message threshold creates a hero automatically (no website visit needed); six data-driven classes (mostly random, subtly nudged, bounded 13.7–31.7 %), permanent class; bounded stat variation; procedural, modular, animated appearance with cosmetic-only rarity; special-character support (admin-authored, inactive by default); historical import from Telegram Desktop exports through the same pipeline.

**Ownership & chain** — Telegram Login verification and claiming by immutable id; signed-message wallet linking; bonded-coin catalog scan with admin approval; holdings → capped, strongly diminishing bonus; Diamond Hands streaks/milestones (1/7/30/90 d) with honest "observed-since" semantics; tiny wash-resistant trading component; draft-only boss pipeline with a database-enforced approval gate.

**Economy & progression** — Clank Gold append-only ledger (idempotent, overdraft-proof, auditable); ~~XP/levels (cap 30)~~ (removed after the Beta report — see ECONOMY_AND_CHAIN.md: no permanent XP/levels; seasonal rank instead); seasons with independent seasonal stats; equipment with rarity/class rules and deterministic loot drops; 23 data-driven achievements.

**Product surface** — Arena, Character (sign-in, claim, tactics, wallet), Inventory, Leaderboard (7 boards, none ranked by wealth), five polished locked previews (Bosses, Expeditions, PvP, Guilds, World) plus a "not in Beta" betting note; responsive wide and tall arena camera; skeleton/empty/error states with no raw errors; admin console (heroes, Telegram moderation + import, balance/classes/skills editor, arena controls, seasons, items, achievements, coins & boss drafts, flags, special characters, audit log).

## 2. Migrations (`supabase/migrations`, 40 tables, RLS on all)

`20261004000100_foundation` · `…000200_telegram` · `…000300_characters_and_economy` · `…000400_chain` · `…000500_arena` · `…000600_security_hardening` (`clank_harden_schema()`; run it at the end of every future migration).

## 3. Verification results

| Check | Result |
| --- | --- |
| `tsc --noEmit` | ✅ clean |
| `eslint --max-warnings=0` (incl. React-compiler hook rules) | ✅ clean |
| `vitest` | ✅ **249 / 249 passing** in 15 files (unit 111 · integration 97 · security 41) — repeated 3× with no flakiness |
| `next build` (production) | ✅ compiles; every page and all 20 API routes generate |
| Production-mode smoke | ✅ no `DATABASE_URL` → 503 (no fallback DB); dev login 404 even with the flag set; webhook 503 unconfigured; cron 403 without secret |
| Mutation spot-check | ✅ 11 of 12 injected bugs caught (the 12th is an equivalent mutant: the nonce pre-check is redundant with the atomic update) |
| Balance (1,000 battles ×2) | ✅ median 18.5 s · p90 24 s · 99 % single survivor · class win-rates 7–17 % (fair share 12.5 %) |
| In-browser | ✅ arena live (idle line-up → 3·2·1 → fight → results), mobile layout, character/claim/tactics flow, leaderboard, locked pages, admin login/overview/config editor |

Requested coverage map: 50-message boundary ✔ · spam filtering ✔ · duplicate Telegram events ✔ · auto-generation ✔ · deterministic class rules ✔ · claiming ✔ · wallet signatures ✔ · holdings diminishing returns ✔ · queue fairness ✔ · one appearance per cycle ✔ · incomplete final group ✔ · deterministic combat ✔ · 30 s cap ✔ · tie-breakers ✔ · settlement idempotency ✔ · ledger integrity ✔ · leaderboards ✔ · season separation ✔ · unauthorized mutations ✔ · RLS/security boundaries ✔. There were no pre-existing tests to run.

## 4. Integrations that genuinely work (verified in this environment)

* **Robinhood Chain RPC** — `eth_chainId` = 4663; ERC-20 `totalSupply`/`decimals`/`balanceOf` through the project's own viem reader; on-chain supply **matches** Clank.trade's API exactly for a bonded coin (`pnpm chain:probe`).
* **Clank.trade public-app JSON** — catalog (392 coins), detail (supply, price in quote currency), trades with `trader` — through the project's Zod-validated client. *Unofficial interface; observed 2026-10-04.*
* **EVM signature verification** — real ECDSA signatures (EOA wallets).
* **Embedded PostgreSQL 18 (PGlite)** running the real migrations — RLS, roles, triggers and constraints exercised for real.

## 5. Required environment variables

`DATABASE_URL`, `SESSION_SECRET`, `CLASS_ROLL_SECRET`, `TELEGRAM_HASH_PEPPER`, `ADMIN_ACCESS_KEY`, `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OFFICIAL_CHAT_ID`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`, `ROBINHOOD_RPC_URL` (dedicated provider), optional `ROBINHOOD_CHAIN_ID`, `CLANK_TRADE_API_URL`, `CLANK_AUTO_APPROVE_BONDED`, `NEXT_PUBLIC_APP_URL`. Dev-only: `CLANK_DEV_LOGIN`, `CLANK_ALLOW_DEMO_HEROES`. See `.env.example`.

## 6. Blocked by external credentials / data

| Blocked | Needs |
| --- | --- |
| Live Telegram ingestion, Login Widget, reactions | A bot token, the official group's chat id, webhook secret, BotFather `/setdomain` (`docs/TELEGRAM.md`) |
| **Real historical counts** | A Telegram Desktop JSON export of the official group (the Bot API cannot read history) → `pnpm telegram:import` |
| Hosted Supabase | A project + pooled `DATABASE_URL` → `pnpm db:migrate` |
| Production-grade chain reads | A dedicated Robinhood Chain RPC (public one is rate-limited) |
| USD/non-ETH valuation of holdings | A price source (none exists); value counts only for native-ETH-quoted coins |
| Meaning of Clank.trade `state` | Confirmation from the Clank.trade team that `state 3 + progress 100` = bonded/graduated |

## 7. Known limitations

* The Postgres production path (`postgres.js` → Supabase) and RLS role matrix are **unverified against a live Supabase project**; tests run on an embedded single-connection Postgres, so true multi-connection lock contention was not exercised.
* Telegram code paths are fixture-tested only.
* Clank.trade's API is unofficial and can change; "bonded" is an inference.
* The arena advances while someone watches, or on cron / worker — not by itself on pure serverless without one of them (Vercel Hobby cron is daily-only → use the worker).
* Admin uses one shared key (no per-operator identity/2FA); rate limiting is per-instance.
* Appearance customisation by claimed owners, quests, audio, and realtime push (it polls with transition-aware wake-ups) are not built; skill-priority/target-preference tactics are shown as locked.
* Rogue is the weakest class (≈ 7–8 % wins); a balance follow-up is recommended once real data exists.
* On phones the in-canvas nameplates can overlap when all eight fighters cluster (the roster below the arena always shows everyone clearly).
* No automated browser (e2e) tests; the UI was verified manually in a browser.
* Local development is single-process (embedded database): don't run the worker and dev server together.

## 8. Recommended next step

Create the Supabase project and run `DATABASE_URL=… pnpm db:migrate`, then smoke-test the live Postgres driver and the RLS role matrix against it (re-point `tests/support/db.ts` at a disposable schema) — that is the only layer between the verified engine and a real launch that could not be exercised here. In parallel, connect the Telegram bot to a **private test group** first (`docs/TELEGRAM.md`), import the official group's Desktop export, and approve the first bonded coins in the admin console.
