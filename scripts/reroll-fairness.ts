/**
 * FREE DAILY REROLL — fairness report. Read-only, no database: it draws heroes through the REAL generator and works the long-run maths out exactly.
 *
 *   pnpm reroll:fairness                              # 60,000 rolls, exact tables, Monte-Carlo cross-check, combat what-if (1,500 battles per mix)
 *   pnpm reroll:fairness -- --rolls 200000 --battles 6000 --json /tmp/reroll-fairness.json
 *   pnpm reroll:fairness -- --skip-combat             # no Arena what-if
 *
 * What it answers (docs/HERO_FREE_REROLL.md §4):
 *   1. Does a reroll use the SAME odds, PWR bands and classes as every hero?               (empirical check of the generator)
 *   2. What can a member who stops when they like a roll reach, and how fast?               (exact chance / expected / median rerolls)
 *   3. What does the population look like after N days if members follow a strategy?        (exact, cross-checked by simulation)
 *   4. What does that do to who wins Arena fights?                                          (the real combat engine, converged rarity mixes)
 */
import { writeFileSync } from "node:fs";

import { RARITIES, type Rarity } from "../src/domain/character/appearance";
import { generateCharacter } from "../src/domain/character/generate";
import { DEFAULT_CLASSES } from "../src/domain/content";
import { chanceAtLeast, chanceToReach, expectedRerollsTo, populationAfter, rarityOdds, meanPower, medianRerollsTo, type RarityOdds, type RerollStrategy } from "../src/domain/hero/rerollFairness";
import { isPowerInBand, RARITY_RULES } from "../src/domain/hero/rarity";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { createRng } from "../src/domain/util/rng";

import { runRaritySim } from "./lib/raritySim";

const args = process.argv.slice(2).filter((a) => a !== "--");
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const ROLLS = Number(arg("rolls", "60000"));
const BATTLES = Number(arg("battles", "1500"));
const skipCombat = args.includes("--skip-combat");

const settings = DEFAULT_SETTINGS;
const classes = [...DEFAULT_CLASSES];
const odds = rarityOdds(settings.character.rarityWeights);
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const SECRET = "reroll-fairness-report-secret-0123456789";

// ---------------------------------------------------------------------------------------------------------------------
// 1 · the generator, as a reroll uses it (a fresh salt per roll — exactly what rerollOwnHero does)
// ---------------------------------------------------------------------------------------------------------------------
const seen: Record<Rarity, { n: number; sum: number; min: number; max: number; outside: number }> = Object.fromEntries(RARITIES.map((r) => [r, { n: 0, sum: 0, min: Infinity, max: -Infinity, outside: 0 }])) as never;
const byClass: Record<string, number> = {};
const t0 = performance.now();
for (let i = 0; i < ROLLS; i++) {
  const g = generateCharacter({
    telegramUserId: 7_000_000 + (i % 997),
    displayName: "Reroll Report",
    behavior: {},
    activityScore: (i % 7) * 12,
    classes,
    settings,
    secret: SECRET,
    seedSalt: `report-${i}`,
  });
  const s = seen[g.rarity];
  s.n++;
  s.sum += g.power;
  s.min = Math.min(s.min, g.power);
  s.max = Math.max(s.max, g.power);
  if (!isPowerInBand(g.rarity, g.power)) s.outside++;
  byClass[g.classId] = (byClass[g.classId] ?? 0) + 1;
}
const meanByRarity = Object.fromEntries(RARITIES.map((r) => [r, seen[r].n ? seen[r].sum / seen[r].n : (RARITY_RULES[r].powerMin + RARITY_RULES[r].powerMax) / 2])) as Record<Rarity, number>;
const maxAbsOddsError = Math.max(...RARITIES.map((r) => Math.abs(seen[r].n / ROLLS - odds[r])));

console.log(`\n=== 1 · THE GENERATOR AS A REROLL USES IT  (${ROLLS.toLocaleString()} fresh-salt rolls, ${((performance.now() - t0) / 1000).toFixed(1)} s)`);
console.log("rarity      configured   observed    PWR band    min–max seen     mean PWR   outside band");
for (const r of RARITIES) {
  const s = seen[r];
  console.log(`${r.padEnd(10)}  ${pct(odds[r]).padStart(8)}   ${pct(s.n / ROLLS, 2).padStart(8)}    ${String(RARITY_RULES[r].powerMin)}–${String(RARITY_RULES[r].powerMax)}      ${String(s.min)}–${String(s.max)}`.padEnd(70) + `${meanByRarity[r].toFixed(1).padStart(8)}   ${s.outside}`);
}
console.log(`max |observed − configured| = ${pct(maxAbsOddsError, 2)}   ·   classes: ${Object.entries(byClass).map(([c, n]) => `${c} ${pct(n / ROLLS)}`).join("  ")}`);

// ---------------------------------------------------------------------------------------------------------------------
// 2 · how fast can a member who stops when they like a roll get there?
// ---------------------------------------------------------------------------------------------------------------------
const TARGETS: Rarity[] = ["RARE", "EPIC", "LEGENDARY"];
const DAYS = [1, 7, 30, 90, 180, 365];
console.log("\n=== 2 · A MEMBER WHO KEEPS REROLLING UNTIL THEY HAVE THE TARGET (one free reroll a day, starting hero counted)");
console.log("target (or better)   one draw   expected rerolls   median   " + DAYS.map((d) => `by day ${d}`.padStart(11)).join(""));
for (const t of TARGETS) {
  console.log(`${(t + "+").padEnd(19)}  ${pct(chanceAtLeast(odds, t)).padStart(8)}   ${expectedRerollsTo(odds, t).toFixed(1).padStart(15)}   ${String(medianRerollsTo(odds, t)).padStart(6)}   ${DAYS.map((d) => pct(chanceToReach(odds, t, d)).padStart(11)).join("")}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// 3 · a whole population following a strategy
// ---------------------------------------------------------------------------------------------------------------------
const STRATEGIES: Array<{ name: string; s: RerollStrategy }> = [
  { name: "never reroll", s: { kind: "NEVER" } },
  { name: "always reroll", s: { kind: "ALWAYS" } },
  { name: "stop at Rare+", s: { kind: "STOP_AT", target: "RARE" } },
  { name: "stop at Epic+", s: { kind: "STOP_AT", target: "EPIC" } },
  { name: "stop at Legendary", s: { kind: "STOP_AT", target: "LEGENDARY" } },
];
const POP_DAYS = [7, 30, 90, 180, 365];
console.log("\n=== 3 · THE POPULATION IF EVERY ACTIVE MEMBER FOLLOWS ONE STRATEGY (exact)  — Common / Rare / Epic / Legendary, mean PWR");
for (const st of STRATEGIES) {
  console.log(`\n${st.name}`);
  for (const d of POP_DAYS) {
    const p = populationAfter(odds, st.s, d);
    console.log(`  day ${String(d).padStart(3)}   ${RARITIES.map((r) => pct(p[r]).padStart(7)).join(" ")}    mean PWR ${meanPower(p, meanByRarity).toFixed(1)}`);
  }
}

// Monte-Carlo cross-check of the closed form (so the table above is not just algebra)
function simulate(strategy: RerollStrategy, days: number, members: number, seed: string): RarityOdds {
  const rng = createRng(seed);
  const count: Record<Rarity, number> = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
  const draw = (): Rarity => rng.weighted(RARITIES, (r) => odds[r]);
  for (let m = 0; m < members; m++) {
    let hero = draw();
    if (strategy.kind !== "NEVER") {
      for (let d = 0; d < days; d++) {
        if (strategy.kind === "STOP_AT" && RARITIES.indexOf(hero) >= RARITIES.indexOf(strategy.target)) break;
        hero = draw();
      }
    }
    count[hero]++;
  }
  return Object.fromEntries(RARITIES.map((r) => [r, count[r] / members])) as RarityOdds;
}
let worst = 0;
for (const st of STRATEGIES) {
  for (const d of [30, 180]) {
    const sim = simulate(st.s, d, 40_000, `mc-${st.name}-${d}`);
    const exact = populationAfter(odds, st.s, d);
    worst = Math.max(worst, ...RARITIES.map((r) => Math.abs(sim[r] - exact[r])));
  }
}
console.log(`\nMonte-Carlo cross-check (40,000 members, 30 and 180 days, every strategy): worst |simulated − exact| = ${pct(worst, 2)}`);

// ---------------------------------------------------------------------------------------------------------------------
// 4 · what it does to who wins Arena fights (the real combat engine)
// ---------------------------------------------------------------------------------------------------------------------
interface CombatRow { mix: string; shares: string; perSlotWinPct: Record<string, number>; winnerShare: Record<string, number> }
const combat: CombatRow[] = [];
if (!skipCombat) {
  const MIXES: Array<{ name: string; p: RarityOdds }> = [
    { name: "today (70 / 22 / 7 / 1)", p: odds },
    { name: "everyone stops at Epic+, day 90", p: populationAfter(odds, { kind: "STOP_AT", target: "EPIC" }, 90) },
    { name: "everyone stops at Legendary, day 30", p: populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 30) },
    { name: "everyone stops at Legendary, day 180", p: populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 180) },
    { name: "everyone stops at Legendary, day 365", p: populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 365) },
  ];
  console.log(`\n=== 4 · WHO WINS ARENA FIGHTS IN EACH MIX  (real combat engine, ${BATTLES.toLocaleString()} battles per mix, 8 fighters each)`);
  console.log("mix                                     rarity mix C/R/E/L                  win% per slot  C / R / E / L                    who wins the battle  C / R / E / L");
  for (const m of MIXES) {
    const weights = Object.fromEntries(RARITIES.map((r) => [r, Math.max(m.p[r], 1e-9)])) as Record<Rarity, number>;
    const r = runRaritySim({ battles: BATTLES, scenario: "production", weights, salt: "reroll-fairness", label: m.name });
    const slot = Object.fromEntries(RARITIES.map((x) => [x, r.byRarity[x]?.winPct ?? 0]));
    const winner = Object.fromEntries(RARITIES.map((x) => [x, r.winnerRarityShare[x] ?? 0]));
    const f = (o: Record<string, number>) => RARITIES.map((x) => (o[x] ?? 0).toFixed(1).padStart(5)).join(" / ");
    console.log(`${m.name.padEnd(38)}  ${RARITIES.map((x) => pct(m.p[x]).padStart(6)).join(" ")}    ${f(slot)}            ${f(winner)}`);
    combat.push({ mix: m.name, shares: RARITIES.map((x) => pct(m.p[x])).join(" / "), perSlotWinPct: slot, winnerShare: winner });
  }
}

const out = {
  rolls: ROLLS,
  configuredOdds: odds,
  observed: Object.fromEntries(RARITIES.map((r) => [r, { share: seen[r].n / ROLLS, meanPower: meanByRarity[r], min: seen[r].min, max: seen[r].max, outsideBand: seen[r].outside }])),
  reach: Object.fromEntries(TARGETS.map((t) => [t, { oneDraw: chanceAtLeast(odds, t), expectedRerolls: expectedRerollsTo(odds, t), medianRerolls: medianRerollsTo(odds, t), byDay: Object.fromEntries(DAYS.map((d) => [d, chanceToReach(odds, t, d)])) }])),
  population: Object.fromEntries(STRATEGIES.map((st) => [st.name, Object.fromEntries(POP_DAYS.map((d) => [d, populationAfter(odds, st.s, d)]))])),
  monteCarloWorstError: worst,
  combat,
};
if (args.includes("--json")) writeFileSync(arg("json", "reroll-fairness.json"), JSON.stringify(out, null, 2));
const bad = Object.values(seen).reduce((n, s) => n + s.outside, 0);
if (bad > 0) {
  console.error(`\nFAIL: ${bad} rolls fell outside their rarity's PWR band`);
  process.exit(1);
}
