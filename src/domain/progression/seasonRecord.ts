import { UNRANKED } from "../lifecycle";
import type { SeasonRankTier } from "../settings";

import { seasonRankFor } from "./seasonRank";

/**
 * A hero's CURRENT-SEASON record, as the public sees it. Wins, matches, win rate and rank all belong to the active season: a season (or a development
 * run) starts everyone at 0 matches / 0 wins / no win rate / Unranked, whatever the hero did before — the hero's identity (rarity, class, stats, PWR,
 * look, versions) is a different thing and never resets.
 */

/** Win rate as a whole percent, or `null` when there is nothing to divide (no matches this season → shown as "—", never "0%"). */
export function winRatePercent(battles: number, wins: number): number | null {
  if (!Number.isFinite(battles) || battles <= 0) return null;
  return Math.round((Math.max(0, wins) / battles) * 100);
}

export const formatWinRate = (battles: number, wins: number): string => {
  const pct = winRatePercent(battles, wins);
  return pct === null ? "—" : `${pct}%`;
};

export interface SeasonRankView {
  id: string;
  name: string;
  /** -1 = Unranked (no pip lit). */
  index: number;
  tierCount: number;
  next: { name: string; minPoints: number } | null;
  pointsToNext: number | null;
  progress: number;
}

/** The ladder position for a season record: a hero with no matches this season is "Unranked" — the lowest TIER (e.g. Bronze) is earned by playing. */
export function seasonRankView(points: number, battles: number, tiers: readonly SeasonRankTier[]): SeasonRankView {
  if (battles <= 0 || tiers.length === 0) {
    return { id: "unranked", name: UNRANKED, index: -1, tierCount: tiers.length, next: null, pointsToNext: null, progress: 0 };
  }
  const standing = seasonRankFor(points, tiers);
  return {
    id: standing.tier.id,
    name: standing.tier.name,
    index: standing.index,
    tierCount: tiers.length,
    next: standing.next ? { name: standing.next.name, minPoints: standing.next.minPoints } : null,
    pointsToNext: standing.pointsToNext,
    progress: standing.progress,
  };
}
