/**
 * Balance diagnostic: class-vs-class DUEL matrix (1v1, fresh baseline + creation roll), reporting how often the ROW class beats the
 * COLUMN class, how often a duel runs out the clock, and the mean duel length. Pure domain code.
 *
 *   pnpm exec tsx scripts/duel-matrix.ts --n 300
 */
import { computeEffectiveStats, rollVariation } from "../src/domain/character/stats";
import { buildDefaultRuleset } from "../src/domain/content";
import { simulateBattle } from "../src/domain/combat/engine";
import type { CombatUnitInput } from "../src/domain/combat/types";
import { DEFAULT_SETTINGS } from "../src/domain/settings";
import { zeroStats } from "../src/domain/stats";
import { createRng } from "../src/domain/util/rng";

const args = process.argv.slice(2);
const n = Number(args[args.indexOf("--n") + 1] || 300);
/** `--legacy`: rules 1.0.0 with the retired shrinking ring, for before/after comparisons. */
const legacy = args.includes("--legacy");
const ruleset = legacy
  ? { ...buildDefaultRuleset(), rulesVersion: "1.0.0", combat: { ...buildDefaultRuleset().combat, ring: { startMs: 6000, endMs: 18_000, minRadius: 80, damagePctPerSec: 0.06, damageRampPerSec: 0.02 } } }
  : buildDefaultRuleset();
const ids = Object.keys(ruleset.classes);
const unit = (rng: ReturnType<typeof createRng>, cls: string, i: number): CombatUnitInput => {
  const stats = computeEffectiveStats({ classDef: ruleset.classes[cls]!, variation: rollVariation(rng, DEFAULT_SETTINGS.character), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
  return { characterId: `c${i}`, name: `${cls}${i}`, classId: cls, tactic: "BALANCED", stats: stats.total };
};

console.log(`${legacy ? "LEGACY rules 1.0.0 (ring)" : "rules " + ruleset.rulesVersion}  duels per pair=${n}; cell = % the ROW class wins (timeouts counted as 0.5), [mean s | % time-limit]`);
console.log("".padEnd(9) + ids.map((c) => c.padStart(17)).join(""));
for (const a of ids) {
  let line = a.padEnd(9);
  for (const b of ids) {
    if (a === b) { line += "                -"; continue; }
    let wins = 0, dur = 0, tl = 0;
    for (let k = 0; k < n; k++) {
      const rng = createRng(`duel-${a}-${b}-${k}`);
      const ua = unit(rng, a, 0), ub = unit(rng, b, 1);
      const out = simulateBattle({ seed: `s-${a}-${b}-${k}`, ruleset, units: [ua, ub], maxCombatMs: 30_000 });
      const winner = out.participants.find((p) => p.placement === 1)!;
      if (out.endedBy === "TIME_LIMIT") tl++;
      wins += winner.characterId === "c0" ? 1 : 0;
      dur += out.durationMs;
    }
    line += `${((wins / n) * 100).toFixed(0).padStart(5)}% [${(dur / n / 1000).toFixed(0).padStart(2)}|${((tl / n) * 100).toFixed(0).padStart(2)}]`;
  }
  console.log(line);
}
