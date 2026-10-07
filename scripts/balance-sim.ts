/**
 * Balance harness: runs many seeded battles with random lineups and reports fight duration, timeouts, pacing (damage-free
 * stretches) and per-class results. Pure domain code — no database.
 *
 *   pnpm balance:sim -- --battles 5000
 *   pnpm balance:sim -- --battles 20000 --set combat.hpScale=2.4 --set combat.overtime.startMs=22000 --max-combat-ms 60000
 *   pnpm balance:sim -- --battles 5000 --json /tmp/sim.json --label candidate-a
 *
 * Common random numbers: battle `b` always uses the same lineup rolls and the same seed, so two runs with different
 * `--set` overrides compare the SAME fights under different rules (differences are the rules, not luck).
 *
 * Heroes have no permanent level, so every simulated fighter is a fresh class baseline plus a bounded
 * creation roll — the same footing a newly eligible Telegram member starts on.
 *
 * Flags: --battles N · --max-combat-ms N (default: the shipped arena cap) · --set <path>=<number> (repeatable; a path inside the
 * ruleset, e.g. combat.hpScale, combat.pace.time, combat.overtime.startMs) · --dilate k [--dilate-move m] (what-if: slow every
 * time constant by k, movement/projectiles by m) · --json <file> · --label <text> · --quiet
 */
import { writeFileSync } from "node:fs";

import { buildDefaultRuleset } from "../src/domain/content";
import { DEFAULT_SETTINGS } from "../src/domain/settings";

import { applyOverrides, dilateRuleset, runBalanceSim } from "./lib/balanceSim";

const args = process.argv.slice(2).filter((a) => a !== "--");
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const all = (name: string): string[] => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1] ?? ""] : []));
const battles = Number(arg("battles", "300"));
const maxCombatMs = Number(arg("max-combat-ms", String(DEFAULT_SETTINGS.arena.maxCombatMs)));
const dilation = Number(arg("dilate", "1"));
const moveDilation = Number(arg("dilate-move", String(dilation)));
const overrides = [...all("set"), ...(dilation !== 1 || moveDilation !== 1 ? [`dilate=${dilation}/move ${moveDilation}`] : [])];

const base = buildDefaultRuleset();
const ruleset = applyOverrides(dilation !== 1 || moveDilation !== 1 ? dilateRuleset(base, dilation, moveDilation) : base, all("set"));
const summary = runBalanceSim({ battles, maxCombatMs, ruleset, label: arg("label", "default") });

if (args.includes("--json")) writeFileSync(arg("json", "balance-sim.json"), JSON.stringify({ ...summary, overrides }, null, 2));

if (!args.includes("--quiet")) {
  const d = summary.duration;
  console.log(`battles=${battles}  rules=${summary.rulesVersion}  cap=${maxCombatMs / 1000}s  label=${summary.label}${overrides.length ? `  overrides: ${overrides.join(" ")}` : ""}`);
  console.log(`duration  p10=${d.p10}s  p25=${d.p25}s  median=${d.median}s  p75=${d.p75}s  p90=${d.p90}s  p95=${d.p95}s  p99=${d.p99}s  max=${d.max}s`);
  console.log(`finishing window: ${Object.entries(summary.histogram).map(([k, v]) => `${k} ${v}%`).join("  ")}`);
  console.log(`single survivor: ${summary.singleSurvivorPct}%   time-limit: ${summary.timeoutPct}%   wipe(0 alive): ${summary.wipePct}%`);
  const p = summary.pacing;
  console.log(`pacing: first kill median ${p.firstKillMedianS}s · longest damage-free stretch median ${p.longestQuietMedianS}s / p95 ${p.longestQuietP95S}s · seconds with no hit ${p.quietSecondsSharePct}% · hits/s ${p.hitsPerSecondMedian}`);
  if (summary.timeoutPct > 0) console.log(`alive at the time limit (by class): ${Object.entries(summary.aliveAtTimeLimit).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  console.log("class        appearances  win%   top2%  avgPlace  power     survS  medSurvS  dealt  taken  elims");
  for (const [c, row] of Object.entries(summary.classes)) {
    console.log(
      `${c.padEnd(12)} ${String(row.appearances).padStart(11)}  ${row.winPct.toFixed(1).padStart(5)}  ${row.top2Pct.toFixed(1).padStart(5)}  ${row.avgPlace.toFixed(2).padStart(8)}  ${String(row.power).padEnd(8)} ${row.avgSurvivalS.toFixed(1).padStart(6)}  ${row.medianSurvivalS.toFixed(1).padStart(8)}  ${String(row.dealt).padStart(5)}  ${String(row.taken).padStart(5)}  ${row.elims.toFixed(2).padStart(5)}`,
    );
  }
}
