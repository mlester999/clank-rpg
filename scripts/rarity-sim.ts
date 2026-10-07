/**
 * Rarity balance harness: simulates Arena battles with fighters drawn the way hero generator 2 draws them and reports who wins.
 *
 *   pnpm rarity:sim -- --battles 10000                      # all four scenarios, 10,000 battles each
 *   pnpm rarity:sim -- --battles 4000 --scenario uniform    # one scenario
 *   pnpm rarity:sim -- --battles 4000 --band COMMON=130-149 --band LEGENDARY=190-209 --json /tmp/r.json   # what-if bands
 *
 * Scenarios: production (the real rarity odds) · uniform (every slot a random rarity) · per-rarity (all 8 the same rarity) ·
 * duel (one fighter of the rarity under test vs seven Commons). See scripts/lib/raritySim.ts.
 */
import { writeFileSync } from "node:fs";

import { RARITIES, type Rarity } from "../src/domain/character/appearance";
import { RARITY_RULES } from "../src/domain/hero/rarity";

import { runRaritySim, type RaritySimScenario, type RaritySimSummary } from "./lib/raritySim";

const args = process.argv.slice(2).filter((a) => a !== "--");
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? ""] : []));

const battles = Number(arg("battles", "2000"));
const only = args.includes("--scenario") ? (arg("scenario", "uniform") as RaritySimScenario) : null;
const salt = arg("salt", "rs");
const scenarios: RaritySimScenario[] = only ? [only] : ["production", "uniform", "per-rarity", "duel"];

let bands: Record<Rarity, { powerMin: number; powerMax: number }> | undefined;
for (const spec of all("band")) {
  const m = /^(COMMON|RARE|EPIC|LEGENDARY)=(\d+)-(\d+)$/.exec(spec);
  if (!m) throw new Error(`--band expects RARITY=min-max, got "${spec}"`);
  bands ??= Object.fromEntries(RARITIES.map((r) => [r, { powerMin: RARITY_RULES[r].powerMin, powerMax: RARITY_RULES[r].powerMax }])) as Record<Rarity, { powerMin: number; powerMax: number }>;
  bands[m[1] as Rarity] = { powerMin: Number(m[2]), powerMax: Number(m[3]) };
}

const results: RaritySimSummary[] = scenarios.map((scenario) => runRaritySim({ battles, scenario, salt, ...(bands ? { bands } : {}), label: arg("label", bands ? "what-if" : "shipped") }));
if (args.includes("--json")) writeFileSync(arg("json", "rarity-sim.json"), JSON.stringify({ bands: bands ?? "shipped", results }, null, 2));

const f = (n: number, w = 5) => n.toFixed(1).padStart(w);
for (const r of results) {
  console.log(`\n=== ${r.scenario.toUpperCase()}  battles=${r.battles} fighters=${r.fighters}  rules=${r.rulesVersion}  bands=${bands ? "WHAT-IF" : "shipped"}  (${(r.wallClockMs / 1000).toFixed(0)}s)`);
  console.log(`duration median ${r.duration.median}s  p90 ${r.duration.p90}s  p95 ${r.duration.p95}s  max ${r.duration.max}s   time-limit ${r.timeoutPct}%`);
  console.log("rarity      fighters   win%   top2%  avgPlace   PWR min/p25/med/p75/max (mean)");
  for (const [k, v] of Object.entries(r.byRarity)) {
    const p = r.powerByRarity[k]!;
    console.log(`${k.padEnd(10)} ${String(v.appearances).padStart(9)}  ${f(v.winPct)}  ${f(v.top2Pct)}  ${v.avgPlace.toFixed(2).padStart(8)}   ${p.min}/${p.p25}/${p.median}/${p.p75}/${p.max} (${p.mean})`);
  }
  console.log(`who wins the battle (share of 1st places): ${Object.entries(r.winnerRarityShare).map(([k, v]) => `${k} ${v}%`).join("  ")}`);
  const pw = Object.entries(r.pairwise);
  if (pw.length) console.log(`head-to-head (higher rarity out-places lower): ${pw.map(([k, v]) => `${k} ${v.higherOutplacesPct}% (${v.pairs})`).join("  ")}`);
  console.log("class        fighters   win%   top2%  avgPlace   | win% by rarity: " + RARITIES.join("  "));
  for (const [c, v] of Object.entries(r.byClass)) {
    const cells = RARITIES.map((x) => { const cell = r.byClassRarity[c]?.[x]; return cell ? `${f(cell.winPct, 5)}` : "    -"; }).join("  ");
    console.log(`${c.padEnd(11)} ${String(v.appearances).padStart(9)}  ${f(v.winPct)}  ${f(v.top2Pct)}  ${v.avgPlace.toFixed(2).padStart(8)}   | ${cells}`);
  }
}
