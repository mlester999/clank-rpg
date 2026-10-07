import type { LoyaltySettings } from "../settings";
import { round2 } from "../util/math";
import type { StatBlock } from "../stats";
import type { ClassDef } from "../rules";
import { distributePoints } from "../character/stats";

export interface StreakState {
  startedAtMs: number;
  peakBalance: bigint;
  lastVerifiedAtMs: number;
}

export type StreakAction =
  | { action: "NONE"; next: null }
  | { action: "START"; next: StreakState; ended?: undefined }
  | { action: "CONTINUE"; next: StreakState }
  | { action: "RESTART"; next: StreakState | null; endReason: "SOLD_DOWN" | "VERIFY_GAP" };

/**
 * Diamond Hands streak transition, evaluated at each VERIFIED balance snapshot.
 *
 *  - First observed non-zero balance starts a streak (duration is measured from OUR first
 *    observation — we never claim holding history we have not indexed).
 *  - Selling down below `retainFraction` × peak balance ends the streak; any remaining balance
 *    starts a fresh one.
 *  - If we have no verified snapshot for longer than `maxVerifyGapHours`, we cannot rule out a
 *    sell-and-rebuy, so the streak restarts rather than being assumed intact.
 */
export function evolveStreak(
  previous: StreakState | null,
  balance: bigint,
  nowMs: number,
  s: Pick<LoyaltySettings, "retainFraction" | "maxVerifyGapHours">,
): StreakAction {
  if (previous === null) {
    return balance > 0n
      ? { action: "START", next: { startedAtMs: nowMs, peakBalance: balance, lastVerifiedAtMs: nowMs } }
      : { action: "NONE", next: null };
  }
  const gapMs = nowMs - previous.lastVerifiedAtMs;
  if (gapMs > s.maxVerifyGapHours * 3_600_000) {
    return {
      action: "RESTART",
      endReason: "VERIFY_GAP",
      next: balance > 0n ? { startedAtMs: nowMs, peakBalance: balance, lastVerifiedAtMs: nowMs } : null,
    };
  }
  const retainPermille = BigInt(Math.round(s.retainFraction * 1000));
  if (balance * 1000n < previous.peakBalance * retainPermille) {
    return {
      action: "RESTART",
      endReason: "SOLD_DOWN",
      next: balance > 0n ? { startedAtMs: nowMs, peakBalance: balance, lastVerifiedAtMs: nowMs } : null,
    };
  }
  return {
    action: "CONTINUE",
    next: {
      startedAtMs: previous.startedAtMs,
      peakBalance: balance > previous.peakBalance ? balance : previous.peakBalance,
      lastVerifiedAtMs: nowMs,
    },
  };
}

export const streakDays = (state: StreakState, nowMs: number): number => Math.max(0, Math.floor((nowMs - state.startedAtMs) / 86_400_000));

export function reachedMilestones(days: number, s: Pick<LoyaltySettings, "milestones">): number[] {
  return s.milestones.filter((m) => days >= m.days).map((m) => m.days);
}

/** Loyalty bonus from the BEST milestone reached across tokens, hard-capped (defensive stats only). */
export function loyaltyStatBonus(longestStreakDays: number, classDef: ClassDef, s: LoyaltySettings): { bonus: StatBlock; points: number } {
  if (!s.enabled) return { bonus: distributePoints(0, {}, 0), points: 0 };
  const reached = s.milestones.filter((m) => longestStreakDays >= m.days);
  const best = reached.reduce((max, m) => Math.max(max, m.points), 0);
  const points = round2(Math.min(best, s.maxPoints));
  void classDef;
  return { bonus: distributePoints(points, { hp: s.distribution.hp, def: s.distribution.def }, 3), points };
}
