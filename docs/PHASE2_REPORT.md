# Phase 2 — Spritesheet heroes, Arena redesign, Free Picks

> **SUPERSEDED (2026-10-06):** this report says rarity is cosmetic-only. That is no longer true — rarity is a real strength tier (PWR bands, stat budgets, richer visuals). See [`RARITY_POWER.md`](RARITY_POWER.md); treat every "cosmetic-only rarity" line below as historical.
>
> **SUPERSEDED (2026-10-05, later the same day):** the betting direction mentioned below (test betting, wagering, a future 90/5/5 split) was abandoned and fully removed. Arena Picks are now free and reward Clank Points + tiered $CLANKRPG. The current design is [`ARENA_PICKS.md`](ARENA_PICKS.md); treat any betting/wagering text in this report as historical.

*2026-10-05. Nothing was committed, pushed or deployed. No Docker. No real-money betting, deposits, custody or wagering of any kind.*

## 1. What was preserved

The core loop and everything under it is untouched and re-asserted by tests: **8 fighters per battle · one global synchronised arena · 3·2·1 → combat starts immediately · ≤ 30 s fight · #1 + #2 result screen for 5 s · each eligible hero fights once per cycle · reshuffle · server-authoritative, deterministic, replayable combat · Telegram-generated heroes with permanent class · cosmetic-only rarity · Supabase architecture**. Specifically kept: the combat engine and `COMBAT_RULES_VERSION` (no combat behaviour changed), queue/cycle planner, settlement and ledger, `phase.ts`, the existing canvas arena (`scene.ts` hall, camera, HP/name plates, storm ring, intro drop-in, KO burst, confetti), the HUD/countdown/FIGHT!/Victory/results overlays and kill feed, the nav shell with locked future features, the dark-industrial + gold/teal identity, and **all 249 pre-existing tests** (one existing test's *setup* had to change — see §2.4; its assertions are untouched). The original procedural vector hero (`drawHero.ts`) is **kept as the automatic fallback renderer**.

Before changing anything I wrote characterization tests of the live arena contract (`integration/arena-state`: current 8, timing constants, withheld results, cycle progress, recent winners, `phaseNow`) and confirmed they passed on the untouched code.

## 2. What changed

### 2.1 Hero rendering → spritesheets
New layered-spritesheet engine (details §3), the placeholder generator, validators, `HeroPortrait` and the arena renderer migrated onto it (vector hero as fallback), per-class effects polish (§6), live per-fighter stats.

### 2.2 Arena page → game-first hierarchy
Arena ≈ **73 %** (measured) / Current Round ≈ **27 %** on desktop; "Up next" is gone; Recent Winners, queue, how-it-works and locked features moved below/aside (§6).

### 2.3 Free Picks (§7)
Service, API, settlement, DB table + guards, UI, flag, setting.

### 2.4 Behaviour/API changes you should know about
| Change | Why |
| --- | --- |
| **The replay is now served only from `combat_starts_at`** (was: from the slot start) | A replay contains the whole outcome. With picks open for the first 5.5 s, a script could read the winner and "pick" it — farming the reward at a 100 % hit-rate, and invalidating any future betting. Clients now start fetching ~150 ms before the bell; the server pre-builds the replay when the battle is simulated. The one existing replay test (`security/http`) now moves the battle window into the past before fetching; it also asserts the 404 while picks are open. |
| `ArenaStateDto.next` no longer carries `fighters` | Players should discover who fights when the eight appear. The DB still schedules the next group early; only the public payload changed (tested: no next-roster id appears anywhere in the state JSON). |
| `FighterDto` gains `power`; appearance DTOs gain `sprite`/`overrides`; state gains `picks` and `visuals` | UI needs. No secrets: tests assert no seed/secret/token appears. |

## 3. Spritesheet architecture

* **Layered, one frame grid.** body · outfit (+ trim, + front sleeve) · eyes · mouth · hair · headgear · accessory · cape · weapon · off-hand · aura. Every layer shares frame size/anchor, so any compatible combination aligns. Multi-part items (`of`) let a sleeve draw in front of the torso.
* **Manifest-driven.** `manifest.json` (validated by a strict zod schema) describes frame size, anchor, clips, directions, layers, tint roles and attack style per weapon. The renderer knows nothing about particular art — **a set with a different frame size is proven by a test to work with no code change.**
* **Compose once, draw cheaply.** Tinting (`hard-light` of grey art onto palette colour) and layer compositing happen once per (hero, clip) into a strip; the arena then does one `drawImage` per hero per frame. 48-hero LRU. Canvas-based, DOM-free via an injected factory, so the *same code* runs in the browser, the preview script and the tests.
* **Fallbacks at three levels:** missing optional layer → skipped; missing outfit/body → that hero uses the vector renderer; manifest/atlases fail → everything uses the vector renderer. Atlases that partially fail only lose their layers.
* **Contract + acceptance check.** `docs/SPRITES.md` is the production-art brief. `pnpm sprites:validate -- <set> --strict` checks the manifest, atlas bounds, **no art touching the frame edge**, empty body/outfit cells and catalogue coverage (it found and I fixed 41 clipped cells in my own placeholder art).

## 4. Animation states supported
IDLE · MOVE · ATTACK (slash / thrust / shoot, chosen by the weapon) · ABILITY/SKILL · HIT · KO · VICTORY. Priority `KO > VICTORY > latest(SKILL, ATTACK) > HIT > MOVE > IDLE` (pure, tested). Frames advance with time since the *server event*. A damage flash and slow-tint overlay work on any clip; KO plays, holds, then fades. **Directions:** authored `right`, `left` mirrors; `up`/`down` blocks are supported by the manifest/renderer but **not authored** (the battle engine only needs left/right).

## 5. Procedural character visuals
Deterministic and stable: the already-rolled appearance parts + the class look → a `SpriteConfig` (catalogue item per slot + colour picks), **stored** in `character_appearances.sprite` at creation (so catalogue updates can never change an existing hero), backfilled for legacy rows at boot, and **frozen into each battle snapshot**. No extra randomness is consumed — class, stats, rarity and appearance for a given Telegram member are bit-identical to before. Rarity is cosmetic only (asserted: legendary flair + overrides leave `fighterToUnit`, POWER and a re-simulated battle's events hash identical). Weapon family and outfit are class-locked so classes stay readable; the other slots are open. Foundation for customisation: `cosmetic_overrides` + `applyOverrides` (validated, class-compatible, reversible); no shop. Admin: settings `visuals` (sprite set, disabled cosmetics) and `picks`, flag `arena.picks` — via the existing generic console, nothing exposed to players.

## 6. Arena page / layout changes
* **Desktop** (≥ 1280): status strip (live · battle · cycle `n · fought/total` · season) → arena (≈73 %) with **spectator strip** beneath (per-fighter live HP, KO count, damage, status pills: stunned/slowed/shield/taunted/buffed, eliminated/winner) | **Current Round** (≈27 %): all 8 heroes, each *portrait · name · `Lv · class` · Power · pick action*, plus a compact queue card. Below: Recent Winners (hero · "#1 Winner" · battle # · level/class/power as frozen when they won · relative time · runner-up), How it works, Coming soon (five polished locked tiles + the Beta betting note).
* **Mobile/tablet:** arena → Current Round → spectator strip → the rest; verified at 390, 820, 1100 and 1440 px, no horizontal overflow.
* **Results:** #1 Winner + #2 Runner-up (large animated portraits, class/POWER, KOs, damage, Gold — the old "+XP" line was removed with permanent XP), trophy, glow, your pick's outcome, "Next battle in N sec" — no navigation, then straight into the next eight.
* **Effects (restrained):** class-specific melee (rogue thrust streak, heavier tank arc), cleric holy bolt, mage orb, ranger arrows, rotating cast-rune ring under any caster, hit flash, damage numbers, KO fall + burst.
* **Performance structure:** HUD data lives in an external store; only the strip subscribes to ~10 Hz data.

## 7. Free Picks — implementation status: ✅ built, tested, browser-verified
* Window = existing intro + 3·2·1 (**5.5 s by default** — there is no extra timer; `arena.introMs` is a setting if you want a longer idle line-up). Pick → **PICKED**; change freely until the bell; **LOCKED** at combat start (server clock). Results: Winner / Runner-up / KO per row; your row shows **Correct +N** or **Missed**.
* One pick per member per battle (PK), must be one of the 8 (composite FK), identity from the signed session only (body-supplied identity is a 422), same-origin, 30/min, flag `arena.picks`, `locked_at` stamped when combat starts, DB trigger guards, settlement inside the one-shot battle transition.
* **Reward:** small off-chain Clank Gold (`picks.rewardGold`, default **2**, 0 = off), idempotent ledger key per (battle, member); only a member who owns a claimed hero can receive it (Gold lives on heroes) — others are CORRECT with no reward.
* **No stake, no loss, no custody, no pools.** Tested: the table has no money-shaped columns; RLS test still asserts no betting/custody tables exist; `betting.enabled` still cannot be enabled. **The 90/5/5 split was not implemented.** The data model (battle · member · hero · times · result) and the Current Round panel are where a future wagering feature would extend; the one requirement already enforced is that the outcome stays secret until the lock.

## 8. Database migrations
`supabase/migrations/20261005000700_sprites_and_picks.sql` — adds `character_appearances.sprite` + `cosmetic_overrides`; creates `arena_picks` (PK, composite FK, check constraints, indexes, guard trigger); ends with `clank_harden_schema()` (RLS on, no policies, API roles revoked — covered by the existing RLS tests). **Not applied to any hosted database.** New settings keys and the flag need no migration. See `docs/OPERATIONS.md` for the apply-before-deploy ordering.

## 9. Tests added (119)
`unit/sprites` (46: catalogue, determinism, class-compat, overrides incl. corrupt input, manifest contract, planning/fallback, geometry/directions, animation priority) · `unit/sprite-assets` (20: validator on the shipped set, the **real compositor in Node** — determinism, tint maths, class distinctness measured over 5 seeds × 15 pairs, rarity flair, missing-layer/atlas/outfit fallback, the vector fallback hero, a **different-frame-size set**) · `integration/sprites-persistence` (11: stored/derived/backfilled looks, old-snapshot fallback, cosmetics never touch combat or events hash, settings/flag defaults) · `integration/picks` (19) · `security/picks-http` (11: session/CSRF/identity/validation/precise error codes/rate limit/flag/own-pick-only/state contents/**no roster or outcome leak**/admin config) · `integration/arena-state` (12 characterization + new contract).

## 10. Test results
| Check | Result |
| --- | --- |
| `tsc --noEmit` | ✅ clean |
| `eslint --max-warnings=0` | ✅ clean |
| `vitest` | ✅ **401 / 401** in 25 files (unit 190 · integration 159 · security 52). Baseline was 249/249 in 15 files; +119 mine, +33 added meanwhile by another session's Telegram-import work |
| `pnpm sprites:validate -- clank-dev-v1 --strict` | ✅ OK — 51 layers, 8 atlases, 1,992 cells, zero clipped |
| `next build` (production) | ✅ compiles; all routes incl. `/api/arena/picks` |
| In-browser (Claude's built-in browser, dev server, **isolated local database**) | ✅ idle line-up → picks open → pick/switch → lock → fight → results → next eight; signed-out and signed-in states; leaderboard and hero-profile portraits; 390/820/1100/1440 px |

Tests surfaced and I fixed real defects: the reward/freeze trigger conflict, an `applyOverrides` crash on non-object input, and the replay-leak above; the validator caught 41 clipped placeholder cells.

## 11. Performance
Measured in a dev build while a fight played: **p50 16.7 ms · p95 17.6 ms (60 fps), 0 long tasks, 23 MB JS heap**. Sprites: **1 manifest + 8 atlases = 372 KB, fetched once per page** (≈ 53 MB decoded — the cost of 48 full-size layer blocks; budget it if a production set is larger); 0 sprite requests per battle; 1 replay request per battle; state polled with transition-aware wake-ups. No per-frame allocations in the hero path; no React render per frame. **Not measured:** low-end phones, retina scaling feel (non-integer pixel scaling may shimmer slightly on moving heroes — eyeballed only), Safari/Firefox.

## 12. Placeholder vs production-ready
* **Placeholder (not production art):** the entire sprite set. It is code-generated pixel art (`pnpm sprites:build`), labelled `dev-placeholder` in its manifest, and meant only to prove the engine. It reads well (six classes are distinct at a glance) but is programmer art, with minimal faces and no gear-driven variation.
* **Production-ready:** the engine, manifest contract, validator, persistence, fallback behaviour, picks, and the page. `docs/SPRITES.md` is the brief for the real art.

## 13. Blocked / unverified / watch-outs
* **Live Supabase is untouched and unverified** for all of this. Another Claude session is importing the real Telegram export into live; it asked that migration 7 not be applied by Claude, and found (separately) that jsonb parameters were being double-encoded on live and wrote `pnpm db:repair-jsonb` (not run). **Order for a live rollout: repair-jsonb → migration 7 → deploy** (the new code reads the new columns).
* **`.env` points `DATABASE_URL` at live.** `pnpm dev` / scripts hit it by default; I only ever ran against an isolated embedded DB (`DATABASE_URL= CLANK_PGLITE_DIR=…`). An older `next dev` (PID 28909, started 2026-10-04 21:20) is still running on :3700 and is not mine.
* **Picks reward economics:** 2 Gold per correct pick, one pick per member per battle, ~90 battles/hour; no daily cap. Only members who claimed a hero (50 qualifying messages) can be paid, but if Gold matters economically add a daily cap.
* Outcome secrecy is now a hard requirement for any future betting (§7).
* Not built: gear-driven look changes (items' `look` JSON isn't used by the sprite system yet), `up`/`down` art, a cosmetics UI, per-operator admin identity, e2e browser tests.
* Housekeeping I introduced: devDependency `@napi-rs/canvas` (art generator + tests only, never bundled); opt-in `NEXT_DIST_DIR` in `next.config.ts` + ESLint/gitignore entries; `CLANK_PGLITE_DIR` honoured by the app DB opener; a second launch config `clank-rpg-local` (isolated DB, port 3711) in `.claude/launch.json`. The existing `clank-rpg` launch config still points at whatever `.env` says.

## 14. Recommended next step
**Commission the real sprite art against `docs/SPRITES.md`** (start with `body.base`, the four outfits and six weapons — the validator's `--strict` mode tells you what's missing), and drop it in as a new set id. In parallel, before any live rollout: run `pnpm db:repair-jsonb` (dry-run first), apply migration 7, then deploy — and decide the pick-reward cap.
