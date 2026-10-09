import type { PicksRewardDto } from "@/domain/rewards/picksDto";

/**
 * ARENA PICKS — what the two prize TILES say, as pure functions (no React), so every number and every sentence is testable on its own.
 *
 * The Arena shows a QUICK SUMMARY only: the Daily and the Weekly pool. Everything that explains them — how many ranks share a pool, the minimum valid Picks, the
 * holder bonus, the token's launch status and the live countdowns — lives on the Leaderboards page (`/leaderboard`), which reads the same server rules.
 *
 * Nothing is configured twice: the amounts come from the server's `PicksRewardDto` (`state.picks.reward`), built from the one authoritative setting
 * (`arena_picks.dailyPrizePool` / `weeklyPrizePool`, editable by an admin). The tiles only DISPLAY them: they never compute a reward, a rank or a boundary.
 */

export type PrizeKind = "DAILY" | "WEEKLY";

export interface PrizeTile {
  kind: PrizeKind;
  /** "Daily pool" / "Weekly pool" — a POOL, shared by the winners; never "per winner". */
  label: string;
  /** The TOTAL pool, comma-grouped ("100,000"). */
  amount: string;
  /** "$CLANKRPG". */
  symbol: string;
}

/** "100000" / "100,000" / "1234567.5" → "100,000" / "100,000" / "1,234,567.5". Anything that is not a plain number is returned untouched (never invented). */
export function groupDigits(display: string): string {
  const m = /^(\d+)(\.\d+)?$/.exec(display.replace(/,/g, ""));
  if (!m) return display;
  return `${(m[1] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[2] ?? ""}`;
}

/**
 * How wide an amount is in `em` for the pixel display face (measured: "500,000" = 4.65 em). Deliberately a little generous, so the CSS that divides the tile's width by it
 * always lands on a size that FITS — including a pool an admin later sets to 12,500,000 or 1,000,000,000. Digits 0.72 em, group commas and the decimal point 0.5 em.
 */
export function amountWidthEm(amount: string): number {
  let em = 0;
  for (const ch of amount) em += /\d/.test(ch) ? 0.72 : 0.5;
  return Math.round(em * 100) / 100;
}

const isPositive = (display: string): boolean => /[1-9]/.test(display.replace(/,/g, "").split(".")[0] ?? "");

/**
 * The two tiles — or null when nothing may be promised: the reward programme is OFF (tables absent / prizes disabled), a pool is zero, or no rank is
 * rewarded. (Picks and Points continue either way; the panel then simply shows no prize.)
 */
export function prizeTiles(reward: PicksRewardDto | undefined): { daily: PrizeTile; weekly: PrizeTile } | null {
  if (!reward || reward.status !== "ACTIVE" || reward.pointsPerCorrectPick <= 0) return null;
  if (!isPositive(reward.daily.prizePool) || !isPositive(reward.weekly.prizePool)) return null;
  if (reward.daily.topRewarded < 1 || reward.weekly.topRewarded < 1) return null;
  const make = (kind: PrizeKind): PrizeTile => ({
    kind,
    label: kind === "DAILY" ? "Daily pool" : "Weekly pool",
    amount: groupDigits((kind === "DAILY" ? reward.daily : reward.weekly).prizePool),
    symbol: reward.symbol,
  });
  return { daily: make("DAILY"), weekly: make("WEEKLY") };
}

/** The words the panel uses around the tiles — short, and not a second copy of the Leaderboards page. */
export const PICKS_HOW = (points: number): string => `Correct Pick = +${points} Points`;
export const PICKS_FREE = "Free to play";
/** The one link under the tiles: the rules (Top-N, minimum Picks, holder bonus, countdowns) are on the Leaderboards. */
export const PRIZE_RULES_LINK = { href: "/leaderboard", text: "Prize rules & countdowns" } as const;
