/**
 * What the SHARED arena state payload says about the Arena Picks reward programme. Display strings and public rules only: no
 * per-member data, no raw token amount, no balance and no holder tier ever rides on the payload every viewer receives.
 *
 * Arena Picks pay NO tokens per battle. Correct picks earn leaderboard Points; the DAILY and WEEKLY boards pay their Top 10.
 */
export interface PicksRewardDto {
  /** ACTIVE = the leaderboards are running; OFF = the reward tables are absent or the programme is disabled. Picks and Points continue in both cases. */
  status: "ACTIVE" | "OFF";
  /** "$CLANKRPG". */
  symbol: string;
  /** Points a correct pick earns. EVERY valid pick counts — there is no daily cap (identical for every member, holders included). */
  pointsPerCorrectPick: number;
  /** Valid picks needed in the UTC day / week to be eligible for a Daily / Weekly prize (they still rank below it). */
  dailyMinimumPicks: number;
  weeklyMinimumPicks: number;
  /** The Daily board: prize pool (whole tokens, display "100,000"), how many ranks are rewarded, and when it ends (next 00:00 UTC, ms). */
  daily: { prizePool: string; topRewarded: number; endsAt: number };
  /** The Weekly board: same fields; ends next Monday 00:00 UTC (ms). */
  weekly: { prizePool: string; topRewarded: number; endsAt: number };
}

/** What a database without the reward tables (or a viewer-less fallback) reports: the programme is off, nothing is promised. */
export const PICKS_REWARD_OFF: PicksRewardDto = {
  status: "OFF",
  symbol: "$CLANKRPG",
  pointsPerCorrectPick: 0,
  dailyMinimumPicks: 0,
  weeklyMinimumPicks: 0,
  daily: { prizePool: "0", topRewarded: 0, endsAt: 0 },
  weekly: { prizePool: "0", topRewarded: 0, endsAt: 0 },
};
