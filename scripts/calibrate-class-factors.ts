/**
 * Re-fits the per-class PWR factors (src/domain/hero/power.ts: CLASS_STRENGTH_SCALE / CLASS_POWER_FACTOR) against the real combat engine.
 *
 *   pnpm rarity:calibrate -- --battles 20000 --rounds 5
 *
 * The goal is the property PWR is defined by — EQUAL PWR MEANS EQUAL EXPECTED STRENGTH: when every fighter in a battle has the same PWR (the
 * "per-rarity" scenario of scripts/lib/raritySim.ts: all eight slots one rarity, classes drawn at random), every class should win the same
 * share of battles. Each round measures the class win rates, then nudges every class's factor against its deviation (a class that over-performs
 * is worth more PWR per raw stat point, so it gets fewer points at the same PWR), keeping the mean factor unchanged. It only PRINTS suggested
 * constants — nothing in the source is edited. Paste them into power.ts, then re-run `pnpm rarity:sim` and the balance test.
 *
 * Flags: --battles N (per round, default 20000) · --rounds N (default 4) · --damping x (0–1, default 0.7) · --salt s
 */
import { RARITIES } from "../src/domain/character/appearance";
import { DEFAULT_CLASSES } from "../src/domain/content";
import { CLASS_POWER_FACTOR, CLASS_STRENGTH_SCALE, POWER_BASELINE, weightedStatSum } from "../src/domain/hero/power";
import type { StatBlock } from "../src/domain/stats";

import { runRaritySim } from "./lib/raritySim";

const args = process.argv.slice(2).filter((a) => a !== "--");
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const battles = Number(arg("battles", "20000"));
const rounds = Number(arg("rounds", "4"));
const damping = Number(arg("damping", "0.7"));
const salt = arg("salt", "cal");
/** Measured elasticity: ln(win rate) moves about 4.3 × ln(PWR) (4.9 % → 22.8 % while PWR grows by 1.43 across the ladder). */
const ELASTICITY = 4.3;

const ids = DEFAULT_CLASSES.map((c) => c.id);
let factors: Record<string, number> = { ...CLASS_POWER_FACTOR };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const meanFactor = mean(ids.map((id) => factors[id]!));

console.log(`start factors: ${ids.map((id) => `${id} ${factors[id]!.toFixed(4)}`).join("  ")}\n`);
for (let round = 1; round <= rounds; round++) {
  const r = runRaritySim({ battles, scenario: "per-rarity", salt: `${salt}-${round}`, classFactors: factors, label: `calibration round ${round}` });
  const win = Object.fromEntries(ids.map((id) => [id, r.byClass[id]!.winPct])) as Record<string, number>;
  const avg = mean(ids.map((id) => win[id]!));
  const perRarity = RARITIES.map((q) => ids.map((id) => `${r.byClassRarity[id]?.[q]?.winPct ?? 0}`.padStart(5)).join(" "));
  console.log(`round ${round}: win% ${ids.map((id) => `${id} ${win[id]!.toFixed(1)}`).join("  ")}   spread ${(Math.max(...ids.map((id) => win[id]!)) - Math.min(...ids.map((id) => win[id]!))).toFixed(1)} pts`);
  console.log(`          by rarity (${ids.join(" ")}):`);
  RARITIES.forEach((q, i) => console.log(`            ${q.padEnd(9)} ${perRarity[i]}`));
  const next: Record<string, number> = {};
  for (const id of ids) next[id] = factors[id]! * Math.pow(win[id]! / avg, damping / ELASTICITY);
  const scale = meanFactor / mean(ids.map((id) => next[id]!));
  for (const id of ids) next[id] = next[id]! * scale;
  factors = next;
}

console.log("\nSUGGESTED CONSTANTS (rounded to 4 decimals):");
console.log("export const CLASS_STRENGTH_SCALE = {");
for (const c of DEFAULT_CLASSES) {
  const f = Math.round(factors[c.id]! * 1e4) / 1e4;
  console.log(`  ${c.id}: ${(POWER_BASELINE / (f * weightedStatSum(c.base as StatBlock))).toFixed(3)},   // was ${CLASS_STRENGTH_SCALE[c.id]}`);
}
console.log("};\nexport const CLASS_POWER_FACTOR = {");
for (const c of DEFAULT_CLASSES) console.log(`  ${c.id}: ${(Math.round(factors[c.id]! * 1e4) / 1e4).toFixed(4)},   // was ${CLASS_POWER_FACTOR[c.id]}`);
console.log("};");
