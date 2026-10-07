import type { Rarity } from "../character/appearance";
import type { ClassDef } from "../rules";
import { STAT_KEYS, zeroStats, type StatBlock } from "../stats";

import { computeHeroPower, fitStatsToPower } from "./power";
import { RARITY_RULES, powerAtPosition } from "./rarity";

/**
 * The RARITY STAT BUDGET (hero generator 2).
 *
 *   rarity   → the total budget: a PWR band (RARITY_RULES) — Legendary heroes are simply built from more stat points;
 *   class    → how that budget is spent: the class's own stat shape (a Warrior's points go to STR/HP, a Mage's to INT …);
 *   seed     → where inside the band this hero sits, and the fine shape of its stats (a few points moved between stats).
 *
 * The result is a full integer stat block whose PWR is inside the rarity's band BY CONSTRUCTION — the stats are fitted to the target
 * PWR (power.ts), never the other way round, and nothing is clamped afterwards — so stats, PWR and rarity always agree.
 *
 * What is stored as the hero's `variation` is the whole generated offset from the class baseline (stats − class base): the rarity
 * budget and the seed's shape together. From generator 2 on `telegram_bonus` is empty, so base + variation = the generated stats.
 */
export interface TierStats {
  /** The PWR this hero was fitted to (equals computeHeroPower(stats)). */
  power: number;
  /** The generated stat block. */
  stats: StatBlock;
  /** stats − class baseline, per stat (integers, may be negative). */
  variation: StatBlock;
  /** Where in the rarity's band the hero sits, 0 (lowest PWR) … 1 (highest). */
  position: number;
}

export interface TierStatsInput {
  classDef: Pick<ClassDef, "id" | "base">;
  rarity: Rarity;
  /** [0, 1): picks the PWR inside the band (uniform → every PWR of the band equally likely). */
  position: number;
  /** Fine shape variation in stat points at budget 1.0 (see rollVariation). Scales with the budget. */
  shape?: Partial<StatBlock> | null;
}

export function buildTierStats(input: TierStatsInput): TierStats {
  const power = powerAtPosition(input.rarity, input.position);
  const base = input.classDef.base as StatBlock;
  const stats = fitStatsToPower(input.classDef.id, base, power, input.shape);
  const variation = zeroStats();
  for (const key of STAT_KEYS) variation[key] = stats[key] - base[key];
  const { powerMin, powerMax } = RARITY_RULES[input.rarity];
  return { power, stats, variation, position: powerMax > powerMin ? (power - powerMin) / (powerMax - powerMin) : 0 };
}

/**
 * The position of a hero that was made BEFORE rarity budgets existed, expressed on the new 0…1 scale — used only by the deterministic
 * rebalance of existing heroes. A hero keeps its STANDING among its class peers: how far its old generated stats were above (or below)
 * the plain class baseline, measured with the same stat weights, decides where in its rarity's band it lands (with a little of its own
 * seed mixed in so heroes with an identical old standing do not all collapse onto one PWR).
 *
 * `legacyPower` / `legacyBasePower` are the weighted sums of the old stats and of the class baseline under the SAME (old) weights.
 */
export function standingPosition(legacyPower: number, legacyBasePower: number, seedUnit: number): number {
  const delta = legacyPower - legacyBasePower; // about −6 … +18 for first-generator heroes
  const standing = Math.min(1, Math.max(0, (delta + 6) / 24));
  return Math.min(0.999999, Math.max(0, 0.8 * standing + 0.2 * Math.min(1, Math.max(0, seedUnit))));
}

/** True when a generated stat block reads a PWR inside its rarity's band and agrees with the stored PWR. */
export function statsMatchTier(rarity: Rarity, classId: string, stats: StatBlock, power: number): boolean {
  const { powerMin, powerMax } = RARITY_RULES[rarity];
  return computeHeroPower(stats, classId) === power && power >= powerMin && power <= powerMax;
}
