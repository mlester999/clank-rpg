import type { ClassDef } from "../rules";
import type { CharacterSettings } from "../settings";
import { STAT_KEYS, addStats, roundStats, zeroStats, type StatBlock, type StatKey } from "../stats";
import { round2 } from "../util/math";
import type { Rng } from "../util/rng";

/**
 * Small, BOUNDED random variation applied once at creation. Each stat varies by at most
 * ±variation.stat (HP ±variation.hp); the net shift across non-HP stats is clamped to
 * ±maxNetShift; and the resulting change in summary POWER is clamped to ±maxPowerShift.
 * So a lucky roll can never make a hero dramatically stronger than an equivalent peer.
 */
export function rollVariation(rng: Rng, settings: CharacterSettings): StatBlock {
  const v = settings.variation;
  const out = zeroStats();
  for (const key of STAT_KEYS) {
    out[key] = key === "hp" ? rng.range(-v.hp, v.hp) : rng.range(-v.stat, v.stat);
  }
  const core = STAT_KEYS.filter((k) => k !== "hp");
  const pull = (keys: readonly StatKey[], weightOf: (k: StatKey) => number, signOf: number) => {
    let target: StatKey | null = null;
    for (const key of keys) {
      if (Math.sign(out[key]) !== signOf) continue;
      if (target === null || Math.abs(out[key]) * weightOf(key) > Math.abs(out[target]) * weightOf(target)) target = key;
    }
    if (target === null) return false;
    out[target] -= signOf;
    return true;
  };
  let net = core.reduce((sum, k) => sum + out[k], 0);
  while (Math.abs(net) > v.maxNetShift) {
    const sign = Math.sign(net);
    if (!pull(core, () => 1, sign)) break;
    net -= sign;
  }
  const powerShift = () => STAT_KEYS.reduce((sum, k) => sum + out[k] * settings.power[k], 0);
  let shift = powerShift();
  while (Math.abs(shift) > v.maxPowerShift) {
    const sign = Math.sign(shift);
    if (!pull(STAT_KEYS, (k) => settings.power[k], sign)) break;
    shift = powerShift();
  }
  return out;
}

/** Spread `points` over stats by weight. HP receives `hpPerPoint` HP for each point. */
export function distributePoints(points: number, weights: Partial<StatBlock>, hpPerPoint: number): StatBlock {
  const out = zeroStats();
  const total = STAT_KEYS.reduce((sum, k) => sum + (weights[k] ?? 0), 0);
  if (points <= 0 || total <= 0) return out;
  for (const key of STAT_KEYS) {
    const share = (weights[key] ?? 0) / total;
    out[key] = round2(points * share * (key === "hp" ? hpPerPoint : 1));
  }
  return out;
}

export function telegramStatBonus(points: number, classDef: ClassDef, settings: CharacterSettings): StatBlock {
  return distributePoints(points, classDef.telegramWeights, settings.telegramBonus.hpPerPoint);
}

/**
 * The class baseline. Heroes have NO permanent level: nothing a hero does in the Arena makes this
 * (or any other component) grow, so a member who qualifies tomorrow starts level with one who
 * qualified last month.
 */
export function baseStats(classDef: ClassDef): StatBlock {
  const out = zeroStats();
  for (const key of STAT_KEYS) out[key] = classDef.base[key];
  return out;
}

export interface StatComponents {
  variation: StatBlock;
  telegram: StatBlock;
  holdings: StatBlock;
  loyalty: StatBlock;
  trading: StatBlock;
}

export interface EffectiveStatsInput extends StatComponents {
  classDef: ClassDef;
  gear?: Partial<StatBlock> | null;
  /** Special characters: admin-authored stats replace everything. */
  fixed?: Partial<StatBlock> | null;
}

export interface EffectiveStats {
  total: StatBlock;
  breakdown: {
    base: StatBlock;
    variation: StatBlock;
    telegram: StatBlock;
    holdings: StatBlock;
    loyalty: StatBlock;
    trading: StatBlock;
    gear: StatBlock;
  };
}

export function computeEffectiveStats(input: EffectiveStatsInput): EffectiveStats {
  const base = baseStats(input.classDef);
  const gear = addStats(input.gear);
  const breakdown = {
    base,
    variation: input.variation,
    telegram: input.telegram,
    holdings: input.holdings,
    loyalty: input.loyalty,
    trading: input.trading,
    gear,
  };
  if (input.fixed) {
    const fixed = addStats(input.fixed);
    for (const key of STAT_KEYS) fixed[key] = Math.max(1, Math.round(fixed[key]));
    return { total: fixed, breakdown };
  }
  const summed = addStats(base, input.variation, input.telegram, input.holdings, input.loyalty, input.trading, gear);
  const total = roundStats(summed);
  for (const key of STAT_KEYS) total[key] = Math.max(1, total[key]);
  return { total, breakdown };
}

/**
 * POWER is a derived SUMMARY used for display and leaderboards. The combat engine never reads
 * it — individual stats, classes and skills decide fights (asserted in tests).
 */
export function computePower(stats: StatBlock, settings: CharacterSettings): number {
  let power = 0;
  for (const key of STAT_KEYS) power += stats[key] * settings.power[key];
  return Math.round(power);
}

/** Power contributed by wallet-derived components (holdings + loyalty + trading). */
export function walletPowerShare(input: EffectiveStatsInput, settings: CharacterSettings): { total: number; wallet: number; fraction: number } {
  const full = computePower(computeEffectiveStats(input).total, settings);
  const zero = zeroStats();
  const without = computePower(
    computeEffectiveStats({ ...input, holdings: zero, loyalty: zero, trading: zero }).total,
    settings,
  );
  return { total: full, wallet: full - without, fraction: full > 0 ? (full - without) / full : 0 };
}
