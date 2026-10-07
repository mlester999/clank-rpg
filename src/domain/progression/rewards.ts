import type { ProgressionSettings } from "../settings";

/**
 * What one Arena appearance pays. There is deliberately NO experience / level reward: heroes do
 * not grow permanently from fighting, so long-standing members can never out-level newcomers.
 * Season points only feed the seasonal ladder (they reset with the season) and Clank Gold is an
 * off-chain currency — neither changes a hero's stats, POWER or combat.
 */
export interface PlacementRewards {
  gold: number;
  seasonPoints: number;
}

/** Rewards for one arena appearance. `placement` is 1-based (1 = winner). */
export function computeRewards(placement: number, eliminations: number, p: ProgressionSettings): PlacementRewards {
  const idx = Math.min(Math.max(placement, 1), p.gold.placement.length) - 1;
  const gold = p.gold.participation + (p.gold.placement[idx] ?? 0) + p.gold.elimination * eliminations;
  const seasonPoints = p.seasonPoints[idx] ?? 0;
  return { gold, seasonPoints };
}
