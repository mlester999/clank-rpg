# Combat — rules version 3.1.0 (static arena, longer fights, committed attacks)

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

## Rules 3.1.0 — engagement: committed attacks, honest spacing, readable melee

**Goal:** ranged play must be a *discipline*, not free damage — no shooting at full speed while running, no endless kiting, real melee
counterplay, a fair final 1 v 1, fights that read on screen (who attacks whom, from which side) — without breaking the 3.0.0 pacing or the
class / rarity balance. Everything is the optional `combat.engagement` settings block (`src/domain/settings.ts`, `engagementSchema`); a ruleset
**without** it runs the exact 3.0.0 code path, so every stored battle replays bit for bit. `rulesVersionFor(combat)` stamps 3.1.0 only when the
block is present.

**What a fighter does now** (`decideEngaged`, `src/domain/combat/engine.ts`):

* **Every basic attack is WINDUP → release → RECOVERY, and you can see it.** A ranged fighter plants for both: 2 ticks of aim and 2 of recovery
  (≈ 300 ms standing still before the arrow / spell leaves, ≈ 100 ms after) — move → stop → aim → shoot → recover → move. That window is long
  enough for the sprite's draw → aim → release (283 ms) to play on a hero that is not moving. Melee steps in at half speed during a 2-tick windup
  (Rogue 1 + 1, Tank 3 + 2). The windup is taken *out* of the attack interval, never added to it. A stun breaks a windup; a release whose
  target died or got clear whiffs; **a wound-up attack keeps its target** (and the hero keeps facing it). Frames carry `WINDUP` / `RECOVER` /
  `RETREAT` flags (not hashed) so the client can show it.
* **A planted fighter holds its ground.** Body separation moves whoever walked (or dashed) into a fighter that is aiming / casting / stunned —
  an archer is never shoved across the floor mid-shot. A fighter committed to an attack holds firmer than one casting or stunned; equals split
  the push as before.
* **Retreat stamina.** Backing away from a threat spends stamina: at most `retreatMaxMs` (× pace ≈ 5.9 s) in one go; it refills while not
  retreating (empty → full in ≈ 2.3 s) and a fighter that ran it dry cannot retreat again before it is half full — it must stand and fight.
  Near the wall a retreat slides **along** it. A fighter **taunted** by a living Tank never retreats.
* **Melee counterplay.** Path prediction (`leadTicks`: aim where a backpedalling target is going), a pursuit step while the target backs away
  (`chaseMult` 1.1; the Tank — the slowest class, the one an archer could otherwise kite — 1.3), and no wasted swings at a fleeing archer
  (`runnerReach`: strike when it plants).
* **Engage from the side** (`flank` 2). On the final approach to a target that stands its ground, a melee fighter settles on the target's left
  or right — the way heroes face — instead of above / below it, and a second attacker takes the free side (the one closer to the target keeps
  its side, so nobody swaps back and forth). Blows read, and two attackers on one target no longer stack into one figure (visual overlap of
  living fighters 8.3 % → 6.1 % of pairs). A chase after a fleeing target stays a straight line.
* **Gap-closers enter the reach first** (`openerReach` 0.5). A dash opener (Piston Charge, Shadowstep) aimed at an archer / caster fires only
  from inside half that fighter's attack range — it closes the last stretch instead of leaping over the whole reach. Before, the Charge (170)
  out-ranged the Ranger (165) and the Mage (150): the Warrior arrived and stunned before a single shot (Warrior vs Mage 93 % → 50 %).
* **Aimed shots** (`aimedDodge` 0.5). A ranged basic attack was aimed standing still, so dodge against it is halved. The Rogue's Evasion
  (+50 % dodge) blanked about a third of a Ranger's arrows and decided the duel by itself.
* **Healing fades in overtime** (`overtimeHealCut` 0.05). Every kind of healing (spells, lifesteal, regeneration) loses 5 % per second of
  overtime — overtime exists to end a fight, and sustain that outlasts the damage ramp made a Tank vs Cleric duel a foregone conclusion (8 %).
* **Skills** telegraph for `skillWindupMs` (an instant skill commits like a cast) and none fires in the first `skillGraceMs`.
* **Per class** (`engagement.classes`, tuned on realistic heroes — below): Ranger cadence × 0.52 from a longer reach (prefers 150, backs away
  under 85), Mage × 0.8 (backs away under 80) — they stand still for every shot now, so their committed shots come faster; Tank windup
  3 ticks, cadence × 1.1, pursuit × 1.2; Cleric × 1.2 (its strength is sustain, not its staff); Warrior × 1.04, Rogue × 1.05.

**How it was tuned.** `scripts/engagement-sim.ts` runs rules 3.0.0 and 3.1.0 on the *same* seeded fights (free-for-alls, a duel matrix,
ranged-vs-melee duels); `scripts/lib/raritySim.ts` measures class balance on **realistic heroes** (hero generator 2, every rarity — what live
heroes are). The commitment windows, the class cadences and the Tank's pursuit were tuned against the realistic population *and* the kiting
metrics together (a cadence that balanced the synthetic population left the realistic Ranger at 8 %).

**Result — free-for-alls** (20,000 battles, same seeds — `scripts/engagement-sim.ts`):

| | 3.0.0 | **3.1.0** |
| --- | --- | --- |
| median · p75 · p90 · p95 · p99 | 37.4 · 41.8 · 47.4 · 52.6 · 60.0 s | **35.7 · 40.4 · 45.4 · 48.4 · 55.6 s** |
| ended by the 60 s cap | 3.1 % | **0.5 %** |
| ranged basic attacks released on the run | (no commitment window) | **0 voluntary** of 1,028,680; 3 displaced ≥ ½ step by an external dash collision between two committed fighters (504 smaller nudges) |

**Class balance — realistic heroes** (`scripts/lib/raritySim.ts`, 10,000 battles per scenario, ± 0.5–0.6 points at 95 %; fair share 12.5 %):

| Class | equal rarity 3.0.0 → **3.1.0** | production rarity odds → **3.1.0** | uniform rarity → **3.1.0** |
| --- | --- | --- | --- |
| Warrior | 13.1 → **10.8** | 13.0 → **11.3** | 12.9 → **11.8** |
| Mage | 12.5 → **13.9** | 12.4 → **13.4** | 12.3 → **13.4** |
| Rogue | 13.0 → **11.1** | 12.7 → **11.0** | 12.9 → **11.2** |
| Ranger | 12.1 → **13.1** | 12.9 → **13.1** | 11.9 → **11.9** |
| Tank | 11.8 → **13.6** | 12.0 → **13.9** | 12.5 → **14.3** |
| Cleric | 12.6 → **12.5** | 12.0 → **12.3** | 12.4 → **12.5** |

Rarity ladder (uniform): Common / Rare / Epic / Legendary 4.9 / 8.5 / 14.3 / 22.2 → **4.3 / 8.1 / 14.4 / 23.1 %**; a lone Legendary against
seven Commons wins 48.8 → **54.6 %**. Synthetic population (class baselines + a creation roll, 20,000 battles): Warrior 14.2 · Mage 17.0 ·
Rogue 9.7 · Ranger 15.4 · Tank 9.2 · Cleric 9.4 % (3.0.0: 16.3 · 15.7 · 11.1 · 13.3 · 8.9 · 9.7).

### Matchup fairness — fresh 1 v 1, measured properly

`scripts/matchup-sim.ts` (`scripts/lib/matchupSim.ts`): two heroes rolled exactly as hero generator 2 rolls them, **equal rarity** (rotating
Common → Legendary, so the same PWR band), both start orders, from a random pair of the eight **Arena spawn points** (165–430 apart), seeds
`matrix-<a>-<b>-<i>`; Wilson 95 % intervals. 700 duels per pair, 10,500 in all. (The duel matrix in `engagement-sim.ts` uses base-stat heroes
and is kept only for comparison with older reports — it exaggerates every counter.)

| A vs B (A wins) | 3.0.0 (realistic, 400) | **3.1.0** | | A vs B (A wins) | 3.0.0 | **3.1.0** |
| --- | --- | --- | --- | --- | --- | --- |
| Warrior vs Ranger | 99.8 | **82.9** [79.9–85.5] | | Rogue vs Ranger | — | **83.9** [80.9–86.4] |
| Warrior vs Mage | 97.5 | **50.1** [46.4–53.8] | | Rogue vs Tank | — | **67.9** [64.3–71.2] |
| Warrior vs Rogue | — | **34.6** [31.1–38.2] | | Rogue vs Cleric | 94.3 | **86.6** [83.8–88.9] |
| Warrior vs Tank | — | **61.3** [57.6–64.8] | | Ranger vs Tank | 84.7 | **58.4** [54.7–62.0] |
| Warrior vs Cleric | — | **56.7** [53.0–60.3] | | Ranger vs Cleric | — | **62.0** [58.3–65.5] |
| Mage vs Rogue | — | **37.0** [33.5–40.6] | | Ranger vs Mage | 4.3 | **48.0** (Mage vs Ranger 52.0 [48.3–55.7]) |
| Mage vs Tank | — | **57.6** [53.9–61.2] | | Tank vs Cleric | 14.8 | **27.6** [24.4–31.0] |
| Mage vs Cleric | — | **64.7** [61.1–68.2] | | | | |

Melee beats ranged in **59.4 %** [58.2–60.6] of 6,300 mixed duels. The start order never decides a duel (A's rate in slot 0 vs slot 1 differs
by ≤ 5 points everywhere). **Three counters remain at 83–87 %**, all a fast melee diver against a fragile ranged fighter in a straight duel
(Warrior / Rogue vs Ranger, Rogue vs Cleric): once the diver is in contact, the ranged fighter has no tool left that changes the outcome.
Pushing them below ~80 % costs the eight-hero balance (tried: the class band widens to 10–15 %), and the eight-hero Arena is the game.

### The final duel of a free-for-all — what decides it

Ranged heroes win **68.1 %** [66.9–69.4] of the ranged-vs-melee finals of 12,000 realistic eight-hero battles (5,445 finals), against 41 % of
fresh 1 v 1s. Each final was **replayed as a controlled duel from its own situation** (`BattleInput.scenario`: the two survivors' positions,
HP and skill cooldowns), then with one factor removed at a time:

| replay of the 5,445 finals | ranged wins |
| --- | --- |
| as it was (same winner 85.2 % of the time) | 70.7 % |
| both at the SAME HP (their mean) | 66.1 % |
| same HP and every skill ready | 58.3 % |
| full HP, every skill ready, their real positions | 44.5 % |
| the same two heroes as a fresh 1 v 1 (full HP, skills ready, standard spawn) | 41.4 % |

So: the ranged survivor brings more HP (55 % of max vs 42 %, ≈ 4 points), the melee survivor has spent its gap-closer / defensive skill in the
brawl (≈ 8 points), and — the largest share — a final between two WOUNDED heroes is short, and a short fight is won by whoever lands damage
first, which at range is the archer (≈ 13 points). Positions alone favour nobody, and the heroes who survive are only slightly stronger than
average (41 % vs 37–41 % fresh). That is attrition, not a broken mechanic: no kiting, no stall, no attack on the run — the final duels have
**0** infinite kites, **0** boundary stalls and **0** shots taken while moving.

**Ranged-vs-melee duels — kiting and commitment** (20,000-battle finals of the synthetic population, and 5,004 fresh 1 v 1s):

| | final duels 3.0.0 | **final duels 3.1.0** | 1v1 3.0.0 | **1v1 3.1.0** |
| --- | --- | --- | --- | --- |
| shots taken while moving (the 2 ticks before the release) | 71.1 % | **0** | 25.9 % | **0** |
| attack-while-running violations (strict window) | — | **0** | — | **0** |
| kite locks (8 s in reach, melee lands nothing, ranged keeps hitting) | 512 | **41** | 55 | **29** |
| terminal kites (the melee never lands a hit again) | 323 | **11** | 0 | **0** |
| infinite kites (a terminal kite that reaches the cap) | 5 | **0** | 0 | **0** |
| boundary stalls (≥ 4 s pinned at the wall) | 588 | **0** | 1 | **0** |
| reach the cap | 2.1 % | **0.4 %** | 0 % | **0 %** |
| average distance · time spent retreating | 96.5 · 36.9 % | **82.3 · 27.4 %** | 67.4 · 25.8 % | **71.3 · 20.4 %** |
| ranged side wins | 69.6 % | **73.0 %** | 18.3 % | **40.8 %** |

Honest trade-offs: the three diver counters above; the Warrior and the Rogue sit about 1.5 points under fair share in eight-hero battles and
the Tank / Mage about 1.4 over; on the synthetic population the Mage is strongest and the Tank / Cleric weakest, as in 3.0.0.

Tests: `tests/unit/engagement.test.ts` (every ranged shot aimed ≥ 2 ticks and recovered from standing still — 0 shots on the run across
thousands; a planted archer holds its ground; WINDUP / RECOVER on every release; retreat stamina cap; taunt; duels end; spacing; a gap-closer
fires at an archer only from inside half its reach — 3.0.0 leapt from its full reach; an aimed shot is about half as easy to dodge; no healing
of any kind after 20 s of overtime; 3.0.0 frames carry none of the new flags), `tests/unit/combat-pace.test.ts` (3.0.0 *and* 3.1.0 distributions), `tests/unit/rarity-balance.test.ts` (realistic
balance), `tests/unit/no-level.test.ts` (**GOLDEN_V31** pins the current rules; GOLDEN / V2 / V3 keep 1.0.0 / 2.0.0 / 3.0.0 as stored).
Reproduce: `pnpm exec tsx scripts/engagement-sim.ts` (20,000 battles + duel matrix + 5,000 ranged-vs-melee duels, both rule sets). Rolling
it out: settings migration `20261007002300_combat_engagement_3_1_0_renderer_v2.sql` adds the block to a `combat` row that still holds the
3.0.0 pacing exactly (an admin-tuned row is left alone; re-running is a no-op) — `tests/integration/engagement-migration.test.ts`.

### Old battles still replay (rules 1.0.0, 2.0.0, 3.0.0 and 3.1.0)

A battle stores its ruleset snapshot (content-addressed in `ruleset_snapshots`) **and** its own `snapshot.maxCombatMs`, and a replay loads it with `validateRuleset`. A 2.0.0 snapshot has no `pace` key; the schema's default (`time 1`, `move 1`) is an *exact* no-op — `x × 1` and `x ÷ 1` are exact in IEEE-754 — so every earlier battle replays bit for bit with the 30 s cap it was fought under. `tests/unit/no-level.test.ts` pins four hash sets that must never change: **GOLDEN** (1.0.0, ring era, legacy path), **GOLDEN_V2** (2.0.0 *as stored*: no `pace`, the frozen 2.0.0 numbers from `tests/support/rules200.ts`, 30 s cap), **GOLDEN_V3** (3.0.0 *as stored*: no `engagement`, `tests/support/rules300.ts`) and **GOLDEN_V31** (the current rules); `tests/integration/combat-pacing-migration.test.ts` and `engagement-migration.test.ts` prove stored 2.0.0 / 3.0.0 battles replay to the same hash before and after settings migrations 1700 / 2300. New battles are stamped 3.1.0 and get new hashes; no historical battle is rewritten.

**Rolling it out on a database that already holds settings.** The app reads combat numbers from `game_settings`, and the seed never overwrites an existing row, so the shipped 3.0.0 defaults do not reach an older database by themselves. Settings-only migration `20261005001700_combat_pacing_3_0_0.sql` moves the `combat` and `arena` rows — **only if** they still hold exactly the 2.0.0 shipped numbers (an admin-tuned row is left alone; re-running is a no-op). It changes no schema and no battle data.

### Earlier notes — old battles and the legacy ring

Every stored battle carries its rules version and the exact ruleset it ran with. Battles stored under **1.0.0** are replayed through an isolated legacy path in the engine, reachable *only* when a ruleset's version is exactly `1.0.0` (a current ruleset that still carries a stale `ring` field ignores it). The three golden event hashes recorded before the ring was removed are asserted byte-for-byte in `tests/unit/no-level.test.ts`, so `battle:verify` and `/replay` keep working for history. New battles never take that path.

## Class AI (data-driven)

Each class has target weights (distance / low-HP / threat / class bias), a preferred range and kite distance, skills with trigger conditions (`opener`, `crowded`, `engage`, `low_hp`) and passive traits. Examples: **Tank** hugs nearby threats, raises *Brass Bulwark* when hurt, *Foundry Slam* taunts; **Ranger** holds ~140 range and backs away when pressed; **Mage** bursts from range and novas when cornered; **Rogue** targets wounded foes and *Shadowsteps* behind them for a ×2.6 opener; **Cleric** smites with lifesteal and shields/heals when low; **Warrior** cleaves crowds and *Piston Charges* distant targets. **Tactics** (claimed owners): Aggressive / Balanced / Defensive change low-HP targeting, retreat threshold and when defensive skills fire. Unclaimed heroes always use the class default (Balanced).

## Placement & tie-breaks (single source: `combat/ranking.ts`)

1. Alive beats eliminated. 2. Both alive → higher **remaining HP %** (exact integer cross-multiplication); both eliminated → survived longer. 3. More eliminations. 4. More damage dealt. 5. Less damage taken. 6. **Lower starting slot** — assigned by the seed *before* the fight, so ties are never resolved randomly afterwards. The engine's placements are tested against this function and it is checked to be a consistent total order.

## Balance

See the tables above. Rules 3.1.0: realistic heroes 10.8–13.9 % per class at equal rarity / 11.0–13.9 % at production odds (fair share 12.5 %); fresh realistic 1 v 1s between 27.6 % and 86.6 % for every pair (three diver counters at 83–87 %); synthetic random lineups (20,000) Warrior 14.2 %, Mage 17.0 %, Rogue 9.7 %, Ranger 15.4 %, Tank 9.2 %, Cleric 9.4 %; median fight 35.7 s, p90 45.4 s, 0.5 % reach the cap. Rules 3.0.0 (20,000 random lineups): Warrior 16.3 %, Mage 15.7 %, Rogue 11.1 %, Ranger 13.3 %, Tank 8.9 %, Cleric 9.7 %; median fight 37.4 s, p90 47.4 s, 96.9 % end with a single survivor. (Rules 2.0.0, for the record: Warrior 14.7 %, Mage 17.1 %, Rogue 9.0 %, Ranger 13.4 %, Tank 9.2 %, Cleric 11.5 %; median 19.5 s.) `tests/unit/combat-pace.test.ts` pins the 3.0.0 distribution (median window, finish window, timeout rate, class band, no dead air). An automated guard (`tests/unit/static-arena.test.ts`) asserts every class stays between 6 % and 22 % and that fights keep ending by elimination. Rogue is the lowest and remains a follow-up candidate. Tune with `pnpm balance:sim -- --battles 4000`, then edit via Admin → Balance & config (`combat.rangedPlantMs` is a setting; class data lives in the database — default-data changes do not overwrite an existing database row).

## Verifying a stored battle

`pnpm battle:verify -- --last 50` re-simulates stored battles from their frozen snapshot + seed + ruleset snapshot and compares the hash. The public replay endpoint does the same on every cold read and returns 503 (and logs `[INTEGRITY]`) if a battle ever fails to reproduce.
