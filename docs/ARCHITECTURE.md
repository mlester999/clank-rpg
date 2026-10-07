# Architecture

## Principles

1. **Server-authoritative.** The browser renders; it never decides outcomes, balances, stats or ownership.
2. **Pure core, thin shell.** `src/domain` is deterministic TypeScript with no I/O. `src/server` adds the database and network. Routes only validate input and call services.
3. **Data-driven balance.** Classes, skills, items, achievements, rewards, curves, combat constants, anti-spam thresholds and feature flags all live in the database (seeded from `src/domain/content` and `settings.ts`; admins edit them with validation, versioning and audit logging). Nothing in an engine hard-codes a balance number.
4. **One mutation path per concern.** Clank Gold changes only through the ledger (triggers keep balances). Battles only change through the SCHEDULED → SIMULATED → SETTLED state machine (a DB trigger forbids anything else and freezes results).
5. **Idempotency everywhere it matters.** Webhook updates (`update_id`), messages (`chat_id, message_id`), ledger entries (`idempotency_key`), drops (`source_ref`), login payloads (single-use hash), wallet challenges (single-use nonce), settlement (status gate).

## Data flow

```
Telegram ──webhook──▶ /api/telegram/webhook ─▶ ingest ─▶ features + deterministic scoring ─▶ counters
                                                              └─ 50 qualifying ─▶ createCharacterForUser ─▶ hero (class, stats, look)
Telegram Desktop export ─▶ import (same pipeline, recomputed from stored FEATURES)

 viewers / cron / worker ──▶ advanceArena() ──(row lock on arena_state)──▶ cycle → group → SCHEDULED
                                                         │                      │ starts_at reached
                                                         │                      ▼
                                                         │             simulate (frozen snapshot + CSPRNG seed + ruleset hash)
                                                         │                      │ combat_ends_at reached
                                                         ▼                      ▼
                                              next group scheduled        settle: Clank Gold · season points · loot · achievements · picks

browser ◀── /api/arena/state (clock-synced) ◀── DB       browser ◀── /api/arena/battles/:id/replay ◀── RE-SIMULATED from snapshot+seed, hash-checked
```

### The arena loop

* A **cycle** collects every eligible hero, shuffles with a CSPRNG seed that is stored with the cycle, and persists the order in `arena_queue_entries`. Groups of 8 are taken from the persisted order — a restart resumes, never reshuffles.
* **Fairness:** each hero has exactly one queue entry per cycle. A final partial group is **never padded or duplicated**; its members are *carried forward* to the very front of the next cycle (so they fight in its first battle and cannot be carried twice in a row). Heroes banned/suspended mid-cycle are skipped. With fewer than 8 eligible heroes the arena shows an honest "gathering" state — there are no fake filler fighters.
* **Timeline per battle** (all server clock): intro 2.5 s (heroes already standing, idle) → 3·2·1 → combat starts *immediately* (≤ 30 s hard cap) → 1.2 s victory beat → 5 s results (#1 and #2) → next group. The next battle is scheduled in the database while the current one is on stage and **prepared** (simulated and persisted, invisibly) as soon as the current one's combat ends — i.e. while the results screen is still showing — so the flip to the next eight is a pure clock read. Its **roster is never published**: the public state carries only its start time (a viewer may ask the server to *hold* one request until that instant; nothing is revealed early), so players discover who is fighting when the eight heroes drop into the arena. See `ARENA_TIMING.md`.
* **Advancing:** `advanceArena()` is lazy and lock-protected. It runs when anyone loads the site (coalesced), from `/api/internal/tick` (Vercel Cron / any scheduler) or from `pnpm arena:worker`. If the schedule falls more than 20 s behind (outage), the waiting battle is re-anchored to "now" before it is simulated — it is watchable, and missed battles are not replayed in a burst. For the arena to run with no one watching, run `pnpm arena:worker` (see OPERATIONS.md).
* **Seasons and lifecycle:** the battle's season is fixed when it is *scheduled*, so a rollover takes effect on the very next battle. Whether the loop runs at all is the **persisted Arena status** (`NOT_STARTED` / `PREPARING` / `RUNNING` / `PAUSE_REQUESTED` / `PAUSED`), read under the `arena_state` row lock at the top of every step — a worker, a viewer or a cron tick can never start it; only the Admin START action does ([`GAME_LIFECYCLE.md`](./GAME_LIFECYCLE.md)). Public battle numbers are **season-scoped** (`arena_battles.season_sequence`, assigned by a trigger); wins / matches / win rate / rank shown anywhere are the **active season's** (`season_character_stats`), the hero's lifetime counters are the internal career. There is no permanent XP or level (see ECONOMY_AND_CHAIN.md).

### The arena page (Phase 2 hierarchy)

Desktop (≥ 1280 px): **arena ≈ 73 % / Current Round ≈ 27 %**. Left: status strip (live · battle # · cycle progress), the canvas arena, and the **spectator strip** (live HP, KO/damage, status effects per fighter). Right: the **Current Round** panel — all eight fighters with portrait, name, `Lv · class`, POWER and the free-pick action — plus a compact queue card. Below: Recent Winners (level/power as frozen when they won), how the arena works, locked future features. On phones the order is arena → Current Round → spectator strip → the rest; nothing scrolls horizontally.

The canvas is a **pure player of server data** (positions, HP and every event come from the verified replay). React does not re-render per animation frame: the render loop publishes live roster data to an external store that only the spectator strip reads. Heroes are drawn from layered spritesheets with the vector hero as automatic fallback — see `docs/SPRITES.md`.
Rarity effects on the stage (`src/components/arena/rarityFx.ts`: ground rings, body glow + outline, rising particles, a name-plate tier mark — never a label) are a pure function of the clock, drawn after and independently of the simulation, and read the shared `RARITY_VISUALS` table. Rarity itself is a strength tier: `src/domain/hero/{rarity,power,statBudget,rebalance,rarityVisuals}.ts` — see `docs/RARITY_POWER.md`.

The public documentation lives in the app at `/docs` (`src/app/docs`, registry in `src/content/docs/registry.ts`, page bodies in `src/content/docs/pages/*.tsx`, chrome in `src/components/docs`). Every game number a page states comes from `src/domain/gameRules.ts`, which derives from the authoritative defaults.

### Arena Picks (free; $CLANKRPG rewards — not betting)

Eligible members pick which of the eight fighters they think wins — free, nothing staked, nothing deposited, nothing to lose. Correct pickers share a fixed $CLANKRPG pool. The full design (eligibility, anti-Sybil, settlement, ledger, claims, wallet binding, treasury) is in **[`ARENA_PICKS.md`](ARENA_PICKS.md)**; the shape in brief:

* **Window:** opens when the eight appear (`starts_at`), closes the instant combat starts (`combat_starts_at`), on the **server clock** — a slow browser can neither delay the round nor sneak in late (the database repeats the check). Until then a member may change their pick; after that it is `LOCKED`. The window is the existing intro + 3·2·1.
* **Identity:** the signed session's immutable Telegram id (never a body field). One pick per member per battle is the table's primary key; the pick must name one of that battle's eight (composite FK to `arena_participants`). Reward eligibility is snapshotted on the pick and frozen at lock.
* **Two settlements, deliberately separate:** the pick *result* (CORRECT/INCORRECT/VOID, and the small Clank Gold reward) resolves inside the existing `SIMULATED → SETTLED` arena transition so it happens exactly once. The **$CLANKRPG reward credit** runs afterwards in its OWN transaction (`rewards/settlement.ts`), idempotent, from the authoritative `arena_battles.winner_id` — a reward problem can never stall or fail the arena.
* **Config:** feature flag `arena.picks` (default on) and settings `arena_picks` (Points per correct pick, the Daily and Weekly prize pools and the shared payout ladder, the Daily/Weekly minimum valid picks for prize eligibility — there is no scoring cap — holder bonus tiers and qualification windows, verification cadence, minimum claim, confirmations…) and `picks.rewardGold` (the legacy Gold reward; 0 disables).
* **No crowd before the lock:** the shared state payload carries no per-fighter pick counts; the crowd is served only after the server clock passes the lock (anti-herding).
* **The replay is withheld until picks lock.** A replay contains the whole outcome; publishing it while picks were open would let a script "predict" the winner. `getReplayDto` serves it only from `combat_starts_at`; clients start fetching ~150 ms before the bell and the server pre-builds the replay when the battle is simulated.

### Replayability

Persisted per battle: the pre-battle **snapshot** (the exact stats of all 8), the **seed**, the combat **rules version**, a content-addressed **ruleset snapshot** (`ruleset_hash` → immutable row), the full compact **event log**, an **events hash**, the ranking and result, and timestamps. The API never stores frames; it **re-simulates** them from snapshot + seed + ruleset and checks the hash, so an altered battle (or code drift) is detected (`pnpm battle:verify`). A DB trigger freezes those columns once a battle is simulated.

### Names: three identities

*Telegram user id* (immutable; the only key for ownership, claims, wallets, history) → *Telegram display name / @username* (external, may change, never trusted) → *RPG display name* = `coalesce(characters.name_override, characters.name)` (what Clank RPG shows; every read path uses it). Renaming is presentation-only and goes through the single `setRpgNameInTx` (validated, audited); a battle's frozen snapshot is not touched, only the label shown for it. See `HERO_ADMIN.md`.

## Extension points

* **New class:** `PUT /api/admin/classes/:id` (+ skills). Class roll, stats, AI, combat and rendering metadata pick it up with no code change (colors/weapon/headgear come from the class definition).
* **New item / achievement / season / flag:** admin API or console.
* **New feature (bosses, PvP…):** reuse `simulateBattle` (it accepts 2–16 fighters and any lineup), the ledger, inventory, seasons and the `feature_flags` table. Boss drafts, loot hints and approval gates already exist in the schema.
* **Quality classifier (optional, future):** the Telegram pipeline deliberately works without AI. A classifier would plug in at `processMessage` *after* `scoreMessage` qualifies a message, adjusting only `weight`. It is not implemented; message text is not retained, so any classifier would have to run inline.

## Scaling & retention notes

* One battle ≈ 300 compact event tuples in a `jsonb` column (a few KB after TOAST compression); frames are never stored. At one battle per ~50 s (rules 3.0.0: ~37 s fight + results + countdown) that is ~1,700/day. Add a retention job that nulls `arena_battles.events` for old SETTLED battles if size matters — snapshot + seed + ruleset still reproduce them.
* Reads are cheap indexed queries. `/api/arena/state` is `no-store` (it carries the server clock); the replay endpoint is immutable and CDN-cacheable.
* Rate limiting is in-memory per server instance; database constraints remain the correctness backstop. Put a CDN/WAF rate limit in front for volumetric abuse.
