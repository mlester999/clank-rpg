import type { SeasonRankTier } from "../settings";

export interface SeasonRankStanding {
  tier: SeasonRankTier;
  /** 0-based position in the ladder (0 = lowest tier). */
  index: number;
  points: number;
  next: SeasonRankTier | null;
  /** Points still needed for the next tier (null at the top tier). */
  pointsToNext: number | null;
  /** 0..1 progress between this tier and the next (1 at the top tier). */
  progress: number;
}

/**
 * Seasonal rank is a pure function of the points a hero has earned THIS season. It is status and
 * competition only — never an input to stats, POWER, matchmaking or combat.
 */
export function seasonRankFor(points: number, tiers: readonly SeasonRankTier[]): SeasonRankStanding {
  const pts = Math.max(0, Math.floor(Number.isFinite(points) ? points : 0));
  let index = 0;
  for (let i = 0; i < tiers.length; i++) if (pts >= (tiers[i] as SeasonRankTier).minPoints) index = i;
  const tier = tiers[index] as SeasonRankTier;
  const next = tiers[index + 1] ?? null;
  return {
    tier,
    index,
    points: pts,
    next,
    pointsToNext: next ? next.minPoints - pts : null,
    progress: next ? Math.min(1, Math.max(0, (pts - tier.minPoints) / (next.minPoints - tier.minPoints))) : 1,
  };
}
