/**
 * Rules 3.0.0 vs 3.1.0 (engagement) on the SAME seeded fights — pacing, class balance, matchups, and the ranged-vs-melee commitment / kiting
 * metrics (definitions in scripts/lib/engagementSim.ts). Pure simulation: no database.
 *
 *   pnpm exec tsx scripts/engagement-sim.ts                                  20,000 battles + duel matrix + 5,000 ranged-vs-melee duels
 *   pnpm exec tsx scripts/engagement-sim.ts --battles 2000 --duels 100       quick look
 *   pnpm exec tsx scripts/engagement-sim.ts --only new --set combat.engagement.backpedal=0.7   tune one number (3.1.0 only)
 *   --json out.json                                                         also write everything as JSON
 */
import { writeFileSync } from "node:fs";

import { PRE_ENGAGEMENT_RULES_VERSION, validateRuleset, type Ruleset } from "../src/domain/rules";
import { OVERTIME_300 } from "../src/domain/settings";

import { applyOverrides } from "./lib/balanceSim";
import { duel, emptyDuel, ffa, RANGED, summariseDuel, defaultRuleset, type DuelMetrics } from "./lib/engagementSim";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const sets = process.argv.flatMap((a, i) => (a === "--set" ? [process.argv[i + 1] as string] : []));
const BATTLES = Number(arg("battles", "20000"));
const DUELS = Number(arg("duels", "300"));
const RVM = Number(arg("rvm", "5000"));
const ONLY = arg("only", "both");

const latest = applyOverrides(defaultRuleset(), sets);
/** Rules 3.0.0 exactly as it shipped: no `engagement`, the 3.0.0 overtime. */
const pre: Ruleset = (() => {
  const { engagement: _e, ...combat } = defaultRuleset().combat;
  void _e;
  return validateRuleset({ ...defaultRuleset(), rulesVersion: PRE_ENGAGEMENT_RULES_VERSION, combat: { ...combat, overtime: { ...OVERTIME_300 } } });
})();

function report(rs: Ruleset) {
  const classes = Object.keys(rs.classes);
  const f = ffa(rs, BATTLES);
  // duel matrix (row beats column %)
  const matrix: Record<string, Record<string, number>> = {};
  for (const a of classes) {
    matrix[a] = {};
    for (const b of classes) {
      if (a === b) continue;
      const r = duel(rs, a, b, DUELS, "matrix");
      matrix[a]![b] = Math.round((r.aWins / DUELS) * 1000) / 10;
    }
  }
  const avg = (pairs: Array<[string, string]>) => {
    const xs = pairs.map(([a, b]) => matrix[a]![b]!);
    return Math.round((xs.reduce((x, y) => x + y, 0) / Math.max(1, xs.length)) * 10) / 10;
  };
  const melee = classes.filter((c) => !RANGED(rs, c));
  const ranged = classes.filter((c) => RANGED(rs, c));
  const categories = {
    meleeBeatsRangedPct: avg(melee.flatMap((m) => ranged.map((r) => [m, r] as [string, string]))),
    meleeVsMeleeFirstSlotPct: avg(melee.flatMap((a) => melee.filter((b) => b !== a).map((b) => [a, b] as [string, string]))),
    rangedVsRangedFirstSlotPct: avg(ranged.flatMap((a) => ranged.filter((b) => b !== a).map((b) => [a, b] as [string, string]))),
  };
  const important = ([["warrior", "ranger"], ["tank", "ranger"], ["warrior", "mage"], ["rogue", "mage"], ["rogue", "cleric"], ["tank", "cleric"], ["ranger", "mage"]] as Array<[string, string]>).map(([a, b]) => ({ matchup: `${a} vs ${b}`, [`${a}WinPct`]: matrix[a]![b]!, [`${b}WinPct`]: matrix[b]![a]! }));
  // 5,000 ranged-vs-melee duels spread over every ranged × melee pair
  const pairs = ranged.flatMap((r) => melee.map((m) => [r, m] as [string, string]));
  const per = Math.ceil(RVM / pairs.length);
  const all: DuelMetrics = emptyDuel();
  for (const [r, m] of pairs) {
    const d = duel(rs, r, m, per, "rvm").m!;
    for (const k of Object.keys(all) as Array<keyof DuelMetrics>) {
      const v = d[k];
      if (Array.isArray(v)) (all[k] as number[]).push(...v);
      else (all[k] as number) += v as number;
    }
  }
  return { rulesVersion: rs.rulesVersion, ffa: f, categories, important, rangedVsMeleeDuels: summariseDuel(all), matrix };
}

const out: Record<string, unknown> = {};
if (ONLY !== "new") out.before = report(pre);
if (ONLY !== "old") out.after = report(latest);
for (const [label, r] of Object.entries(out) as Array<[string, ReturnType<typeof report>]>) {
  console.log(`\n=== ${label}: rules ${r.rulesVersion} ===`);
  console.log("FFA", JSON.stringify({ ...r.ffa, finalDuel: undefined }));
  console.log("final ranged-vs-melee duels", JSON.stringify(r.ffa.finalDuel));
  console.log("categories", JSON.stringify(r.categories));
  console.log("important", JSON.stringify(r.important));
  console.log("ranged-vs-melee 1v1", JSON.stringify(r.rangedVsMeleeDuels));
}
const json = arg("json");
if (json) writeFileSync(json, JSON.stringify(out, null, 2));
