# Combat — rules version 3.0.0 (static arena, longer fights)

`src/domain/combat/engine.ts` is a **pure function**: `simulateBattle({ seed, ruleset, units, maxCombatMs }) → outcome`. No I/O, no wall-clock, no `Math.random`, no trigonometry (only `+ − × ÷ √`), so outcomes are reproducible for a given **snapshot + seed + rules version**. Bump `COMBAT_RULES_VERSION` (`src/domain/rules.ts`) for any behavioural change; every battle stores the version and a content hash of the exact ruleset it used.

## Tick model

Fixed 100 ms ticks, ≤ 600 ticks (**60 s hard cap**, `arena.maxCombatMs`; battles stored under rules ≤ 2.0.0 carry their own 30 s cap). Each tick: (1) every living unit **decides** from the state at the start of the tick (target, skill, attack, move); (2) movement + separation; (3) in-flight projectiles arrive; (4) all effects resolve in a **seeded shuffle** order; (5) regeneration; (6) **deaths are processed after all damage**, so mutual kills happen and slot order never decides who "got there first"; (7) frame recorded; (8) stop if ≤ 1 unit remains. Starting slots are assigned by the seed (not input order).

## Stats → combat

`HP` → max HP (× `hpScale` 1.55; 1.5 before 3.0.0) · `STR`/`INT` → physical/magic power (× `atkPerStr`/`atkPerInt` 0.925; 1.0 before 3.0.0) · `DEF` → damage reduction `DEF/(DEF+55)` (cap 70 %; magic ignores half) · `AGI` → attack speed, move speed, dodge · `CHA` → cooldown reduction (cap 40 %) · `LUCK` → crit & dodge. **POWER is never an input** — a test injects absurd `power`/`rarity` fields and proves the outcome hash is unchanged.

## A static arena (rules 2.0.0) — what replaced the storm ring

Rules 1.0.0 had a **storm ring**: a zone that shrank from the full arena to a small centre, damaging anything outside it and herding every fighter inward. It was removed completely, because it shaped class balance rather than being neutral: it forced everyone into close range and handed melee a late-fight advantage over Rangers, ranged Mages and Clerics.

Rules 2.0.0 has **no zone of any kind**: no shrinking radius, no zone or out-of-bounds damage, no forced movement or centre attraction, no AI that reads a changing radius. Fighters move inside a **fixed boundary** (radius 300, units stop at 284); the wall is the only limit. The arena may still *look* circular — the floor art is decoration.

What keeps fights finishing and ranged play honest instead of the ring:

* **Overtime** — all damage ramps +8 %/s after 10 s (unchanged).
* **The finite wall.** A fighter backing away from a melee opponent ends up against it. There is no tangential escape logic, so kiting cannot circle forever; a slower melee class (Tank) catches a ranged one, a faster one (Warrior, Rogue) much sooner.
* **Plant-to-fire** (`combat.rangedPlantMs`, default **100 ms**, 0 = off). A ranged fighter cannot move on the tick it looses a basic attack, so shots are not free while running — spacing is a skill that costs uptime. It applies to every ranged class alike.
* **Melee** closes to striking range and does not overshoot; **ranged** holds its preferred range, steps back when someone gets inside `kiteBelow`, and otherwise closes to range. Hurt fighters back away from the nearest threat.

### Why plant-to-fire (the numbers)

Removing the ring alone moved the balance sharply toward casters (3,000-battle random lineups, win rate per appearance, fair share 12.5 %):

| | ring (1.0.0) | static, no plant | **static + 100 ms plant (shipped)** | static + 200 ms | static + 300 ms |
| --- | --- | --- | --- | --- | --- |
| Warrior | 12.2 | 12.8 | **15.2** | 16.9 | 18.8 |
| Mage | 16.9 | 18.3 | **17.0** | 16.5 | 15.5 |
| Rogue | 7.2 | 6.5 | **8.9** | 10.0 | 10.3 |
| Ranger | 14.2 | 15.9 | **13.9** | 10.5 | 7.0 |
| Tank | 10.7 | **5.6** | **9.0** | 10.6 | 13.1 |
| Cleric | 13.5 | 15.8 | **11.0** | 10.6 | 10.5 |
| strongest ÷ weakest | 2.35 | 3.27 | **1.91** | 1.69 | 2.70 |

The Tank had been quietly propped up by the ring (it outlasted kiters the zone killed) and halved without it. The dial was chosen so the **Ranger keeps its ring-era strength** (13.9 % vs 14.2 %) — 200 ms+ would have bought a tighter table by taking ~4 points off Rangers, which is the over-nerf this change must not make. A pure melee chase-speed bonus was also tried and did essentially nothing (Tank 6.0 → 6.1 %). 1v1 duels were identical before and after (the ring never mattered in a 10–20 s duel); the shift was entirely in 8-fighter free-for-alls. 5.8 % of fights now reach the 30 s limit (0.7 % before) — mostly a Tank nobody can finish, not ranged stalemates. Reproduce with `pnpm balance:sim -- --battles 4000` and `pnpm exec tsx scripts/duel-matrix.ts --n 300 [--legacy]`.

## Rules 3.0.0 — longer fights (median ≈ 37 s, hard cap 60 s)

**Goal** (product decision): median fight 35–45 s, most fights 25–55 s, hard cap 60 s, few timeouts, the *same* class identity and relative balance, no shrinking ring, no dead air. Not "30 → 60": raising only the cap changes nothing (rules 2.0.0 fights ended by ~25 s; at a 60 s cap a 2.0.0 fight is still ~19 s).

**What changed** — all of it settings, no class or skill was edited:

| Setting | 2.0.0 | **3.0.0** | Why |
| --- | --- | --- | --- |
| `combat.pace.time` | *(absent = 1)* | **1.95** | stretches every class-defined duration — attack interval, skill cooldowns and cast times, stun / slow / shield / buff / taunt / empower durations, the ranged plant — and divides regeneration, so every class keeps its relation to every other class while everything takes ~2× longer |
| `combat.pace.move` | 1 | **1.1** | slower walking and projectile flight (a lighter touch than `time`: a bigger value hurts the ranged classes) |
| `combat.hpScale` | 1.5 | **1.55** | modest extra survivability |
| `combat.derive.atkPerStr` / `atkPerInt` | 1.0 | **0.925** | modest damage reduction |
| `combat.overtime` (start · ramp) | 10 s · 0.08 /s | **28 s · 0.16 /s** | overtime is wall-clock (deliberately **not** paced): later and steeper means long stalemates are broken without shortening normal fights |
| `arena.maxCombatMs` | 30 000 | **60 000** | the hard cap; at the cap the existing deterministic time-limit ranking decides |

**How it was tuned** (`pnpm balance:sim`, `scripts/lib/balanceSim.ts`): the *same* seeded battles and lineups for both rulesets (common random numbers: random classes, BALANCED tactic, class baseline + creation roll), 20,000 battles per row. A grid over `pace.time` (1.85–2.15), `pace.move` (1.0–1.2) and overtime start × ramp showed: a higher `time` lengthens fights but distorts class balance (win-rate L1 distance from 2.0.0 ≈ 12 vs ≈ 7), and later+steeper overtime is what removes timeouts without moving the median. The shipped row is the one that keeps the median centred in the target window with the lowest timeout rate *and* the closest class balance.

**Result** (20,000 battles, 2.0.0 @ 30 s cap → 3.0.0 @ 60 s cap):

| | 2.0.0 | **3.0.0** |
| --- | --- | --- |
| median fight | 19.5 s | **37.4 s** |
| p25 · p75 | 16.3 · 23.0 s | 32.1 · 41.8 s |
| p90 · p95 · p99 | 27.8 · 30.0 · 30.0 s | **47.4 · 52.6 · 60.0 s** |
| finish window 15–25 / 25–35 / 35–45 / 45–55 / 55+ s | 67.6 / 17.6 / 0 / 0 / 0 % | 5.6 / 32.4 / **46.6** / 11.7 / 3.7 % |
| ended by timeout (cap) | 6.0 % | **3.1 %** |
| single survivor | 94.0 % | 96.9 % |
| first kill (median) | 4.5 s | 8.8 s |
| damage landing | 5.1 hits/s | 3.0 hits/s |
| longest damage-free stretch (median · p95) | 1.1 · 4.9 s | 1.9 · 8.9 s |
| simulation cost | 0.64 ms / battle | 1.13 ms / battle (run once per battle, 17–36 s ahead of its start) |

| Class | win % 2.0.0 → **3.0.0** | top-2 % | median survival |
| --- | --- | --- | --- |
| Warrior | 14.7 → **16.3** | 29.2 → 30.6 | 11.1 → 21.5 s |
| Mage | 17.1 → **15.7** | 25.1 → 23.2 | 7.3 → 14.0 s |
| Rogue | 9.0 → **11.1** | 22.3 → 23.5 | 10.9 → 20.8 s |
| Ranger | 13.4 → **13.3** | 22.4 → 21.5 | 8.3 → 15.7 s |
| Tank | 9.2 → **8.9** | 29.8 → 32.2 | 18.2 → 36.0 s |
| Cleric | 11.5 → **9.7** | 21.1 → 19.0 | 10.2 → 18.1 s |

No class moved more than ~2 points; the extremes keep their order (Mage / Warrior high, Tank / Cleric / Rogue low). Honest trade-offs: the fights are a little *quieter* (3.0 hits/s vs 5.1; about 9 % of seconds contain no hit, the longest damage-free stretch p95 is 8.9 s vs 4.9 s) — that is the nature of "everything twice as slow" and is why `pace.time` was kept below 2; and 3.1 % of fights still reach the 60 s cap (almost always Tank / Warrior stalemates, decided by the deterministic time-limit ranking). A fight with one survivor ends that tick — it is never padded to the cap.

**Throughput.** One battle slot = intro 2.5 s + 3 · 2 · 1 (3 s) + combat + victory beat 1.2 s + results 5 s = combat + 11.7 s, i.e. ≈ 49 s at the median fight (35–52 s across the middle half) — roughly **70–75 battles/hour**, not one per minute by design. A member who predicts ~50 % correctly collects ~36 correct picks an hour; leaderboard prizes are fixed per period (nothing is paid per battle), so a faster or slower arena changes only how many picks fit in a day. Picks open for the *next* battle while the current one is fought, so a longer fight is simply a longer window to inspect the upcoming eight.

### Old battles still replay (rules 1.0.0, 2.0.0 and 3.0.0)

A battle stores its ruleset snapshot (content-addressed in `ruleset_snapshots`) **and** its own `snapshot.maxCombatMs`, and a replay loads it with `validateRuleset`. A 2.0.0 snapshot has no `pace` key; the schema's default (`time 1`, `move 1`) is an *exact* no-op — `x × 1` and `x ÷ 1` are exact in IEEE-754 — so every earlier battle replays bit for bit with the 30 s cap it was fought under. `tests/unit/no-level.test.ts` pins three hash sets that must never change: **GOLDEN** (1.0.0, ring era, legacy path), **GOLDEN_V2** (2.0.0 *as stored*: no `pace`, the frozen 2.0.0 numbers from `tests/support/rules200.ts`, 30 s cap) and **GOLDEN_V3** (the current rules); `tests/integration/combat-pacing-migration.test.ts` also proves a stored 2.0.0 battle replays to the same hash before and after settings migration 1700. New battles are stamped 3.0.0 and get new hashes; no historical battle is rewritten.

**Rolling it out on a database that already holds settings.** The app reads combat numbers from `game_settings`, and the seed never overwrites an existing row, so the shipped 3.0.0 defaults do not reach an older database by themselves. Settings-only migration `20261005001700_combat_pacing_3_0_0.sql` moves the `combat` and `arena` rows — **only if** they still hold exactly the 2.0.0 shipped numbers (an admin-tuned row is left alone; re-running is a no-op). It changes no schema and no battle data.

### Earlier notes — old battles and the legacy ring

Every stored battle carries its rules version and the exact ruleset it ran with. Battles stored under **1.0.0** are replayed through an isolated legacy path in the engine, reachable *only* when a ruleset's version is exactly `1.0.0` (a current ruleset that still carries a stale `ring` field ignores it). The three golden event hashes recorded before the ring was removed are asserted byte-for-byte in `tests/unit/no-level.test.ts`, so `battle:verify` and `/replay` keep working for history. New battles never take that path.

## Class AI (data-driven)

Each class has target weights (distance / low-HP / threat / class bias), a preferred range and kite distance, skills with trigger conditions (`opener`, `crowded`, `engage`, `low_hp`) and passive traits. Examples: **Tank** hugs nearby threats, raises *Brass Bulwark* when hurt, *Foundry Slam* taunts; **Ranger** holds ~140 range and backs away when pressed; **Mage** bursts from range and novas when cornered; **Rogue** targets wounded foes and *Shadowsteps* behind them for a ×2.6 opener; **Cleric** smites with lifesteal and shields/heals when low; **Warrior** cleaves crowds and *Piston Charges* distant targets. **Tactics** (claimed owners): Aggressive / Balanced / Defensive change low-HP targeting, retreat threshold and when defensive skills fire. Unclaimed heroes always use the class default (Balanced).

## Placement & tie-breaks (single source: `combat/ranking.ts`)

1. Alive beats eliminated. 2. Both alive → higher **remaining HP %** (exact integer cross-multiplication); both eliminated → survived longer. 3. More eliminations. 4. More damage dealt. 5. Less damage taken. 6. **Lower starting slot** — assigned by the seed *before* the fight, so ties are never resolved randomly afterwards. The engine's placements are tested against this function and it is checked to be a consistent total order.

## Balance

See the tables above. Rules 3.0.0 (20,000 random lineups): Warrior 16.3 %, Mage 15.7 %, Rogue 11.1 %, Ranger 13.3 %, Tank 8.9 %, Cleric 9.7 %; median fight 37.4 s, p90 47.4 s, 96.9 % end with a single survivor. (Rules 2.0.0, for the record: Warrior 14.7 %, Mage 17.1 %, Rogue 9.0 %, Ranger 13.4 %, Tank 9.2 %, Cleric 11.5 %; median 19.5 s.) `tests/unit/combat-pace.test.ts` pins the 3.0.0 distribution (median window, finish window, timeout rate, class band, no dead air). An automated guard (`tests/unit/static-arena.test.ts`) asserts every class stays between 6 % and 22 % and that fights keep ending by elimination. Rogue is the lowest and remains a follow-up candidate. Tune with `pnpm balance:sim -- --battles 4000`, then edit via Admin → Balance & config (`combat.rangedPlantMs` is a setting; class data lives in the database — default-data changes do not overwrite an existing database row).

## Verifying a stored battle

`pnpm battle:verify -- --last 50` re-simulates stored battles from their frozen snapshot + seed + ruleset snapshot and compares the hash. The public replay endpoint does the same on every cold read and returns 503 (and logs `[INTEGRITY]`) if a battle ever fails to reproduce.
