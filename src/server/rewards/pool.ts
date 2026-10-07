import type { PicksRewardDto } from "@/domain/rewards/picksDto";
import { periodWindow, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS, parseTokenAmount } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { isCapacityError, isConnectionError } from "../db/postgres";
import type { Queryable } from "../db/types";

export const REWARD_SYMBOL = "$CLANKRPG";

/** The prize pool of one board in LOGICAL units (micro-tokens) — derived from the ONE authoritative setting (`dailyPrizePool` / `weeklyPrizePool`). Independent of any token contract. */
export const boardPoolMicro = (settings: GameSettings, kind: PeriodKind): bigint =>
  parseTokenAmount(kind === "DAILY" ? settings.arena_picks.dailyPrizePool : settings.arena_picks.weeklyPrizePool, LOGICAL_DECIMALS);
export const minimumClaimMicro = (settings: GameSettings): bigint => parseTokenAmount(settings.arena_picks.minimumClaim, LOGICAL_DECIMALS);

/** Valid picks a member needs in the period to be prize-eligible (20 in a UTC day, 100 in a UTC week by default). */
export const minimumPicksFor = (settings: GameSettings, kind: PeriodKind): number =>
  kind === "DAILY" ? settings.arena_picks.dailyMinimumPicks : settings.arena_picks.weeklyMinimumPicks;

/**
 * True when the leaderboard tables exist (migration 20261005001400 has been applied). Cached briefly — it is asked on every state
 * build. Before the migration the app keeps working: picks are free, nothing is scored, boards answer "unavailable".
 *
 * A DATABASE OUTAGE IS NOT AN ANSWER: if the question itself fails because the connection is gone, that is thrown to the caller (→ 503 + Retry-After) and
 * NEVER cached as "not ready" — caching it kept the Picks boards 503 for 30 s after the database had recovered (seen in the soak).
 */
const readiness = { at: 0, ready: false };
/** Test hook: forget the cached answer. */
export function resetRewardsReadiness(): void {
  readiness.at = 0;
  readiness.ready = false;
}
export async function rewardsReady(q: Queryable, nowMs = Date.now()): Promise<boolean> {
  if (nowMs - readiness.at < 30_000 && readiness.at !== 0) return readiness.ready;
  try {
    const [r] = await q.query<{ ok: boolean }>(
      `select to_regclass('public.arena_leaderboards') is not null and to_regclass('public.arena_holder_observations') is not null
          and to_regclass('public.arena_pick_scores') is not null
          and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'arena_picks' and column_name = 'reward_eligible') as ok`,
    );
    readiness.ready = Boolean(r?.ok);
  } catch (error) {
    if (isConnectionError(error) || isCapacityError(error)) throw error;
    readiness.ready = false;
  }
  readiness.at = nowMs;
  return readiness.ready;
}
export const resetRewardsReadyCache = (): void => {
  readiness.at = 0;
};

/**
 * What the shared state payload says about the reward programme: the two prize pools and when each board ends. Display strings and
 * server-clock times only — nothing about any member. OFF = the migration is not applied or prizes are switched off; picks and
 * Points continue either way.
 */
export async function getPicksRewardDto(q: Queryable, settings: GameSettings, nowMs: number): Promise<PicksRewardDto> {
  const cfg = settings.arena_picks;
  const ready = await rewardsReady(q, nowMs);
  return {
    status: ready && cfg.enabled ? "ACTIVE" : "OFF",
    symbol: REWARD_SYMBOL,
    pointsPerCorrectPick: cfg.pointsPerCorrectPick,
    dailyMinimumPicks: cfg.dailyMinimumPicks,
    weeklyMinimumPicks: cfg.weeklyMinimumPicks,
    daily: { prizePool: formatTokenAmount(boardPoolMicro(settings, "DAILY"), LOGICAL_DECIMALS), topRewarded: cfg.prizeSplitBps.length, endsAt: periodWindow("DAILY", nowMs).endsAt },
    weekly: { prizePool: formatTokenAmount(boardPoolMicro(settings, "WEEKLY"), LOGICAL_DECIMALS), topRewarded: cfg.prizeSplitBps.length, endsAt: periodWindow("WEEKLY", nowMs).endsAt },
  };
}
