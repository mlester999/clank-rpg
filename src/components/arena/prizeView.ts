import { countdownParts, type CountdownParts } from "@/domain/rewards/leaderboard";
import type { PicksRewardDto } from "@/domain/rewards/picksDto";

/**
 * ARENA PICKS — what the two prize plaques SAY, as pure functions (no React), so every number and every sentence is testable on its own.
 *
 * Nothing here is configured twice: the amounts, the number of rewarded ranks, the minimum valid Picks and the moments each board ends all come from the
 * server's `PicksRewardDto` (`state.picks.reward`), which is built from the one authoritative setting (`arena_picks.dailyPrizePool` / `weeklyPrizePool`,
 * editable by an admin) and the same UTC period windows the leaderboards use. The plaques only DISPLAY them: they never compute a reward, a rank or a
 * boundary, and a client clock never decides anything.
 */

export type PrizeKind = "DAILY" | "WEEKLY";

export interface PrizePlaque {
  kind: PrizeKind;
  /** "Daily" / "Weekly". */
  title: string;
  /** "Prize pool" — together with the title it reads "Daily Prize Pool". */
  subtitle: string;
  /** The TOTAL pool, comma-grouped ("100,000"). It is shared by the Top N; it is never "per winner". */
  amount: string;
  /** "$CLANKRPG". */
  symbol: string;
  /** How many ranks share the pool. */
  top: number;
  /** "Top 10 winners". */
  topLabel: string;
  /** Valid Picks needed in the UTC day / week to be PRIZE-eligible (a participation bar for prizes only; scoring has no cap). */
  minimumPicks: number;
  /** When the board ends (ms, UTC) — the leaderboard's own boundary. */
  endsAt: number;
}

/** "100000" / "100,000" / "1234567.5" → "100,000" / "100,000" / "1,234,567.5". Anything that is not a plain number is returned untouched (never invented). */
export function groupDigits(display: string): string {
  const m = /^(\d+)(\.\d+)?$/.exec(display.replace(/,/g, ""));
  if (!m) return display;
  return `${(m[1] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${m[2] ?? ""}`;
}

/**
 * How wide an amount is in `em` for the pixel display face (measured: "500,000" = 4.65 em). Deliberately a little generous, so the CSS that divides the plaque's width by it
 * always lands on a size that FITS — including a pool an admin later sets to 12,500,000 or 1,000,000,000. Digits 0.72 em, group commas and the decimal point 0.5 em.
 */
export function amountWidthEm(amount: string): number {
  let em = 0;
  for (const ch of amount) em += /\d/.test(ch) ? 0.72 : 0.5;
  return Math.round(em * 100) / 100;
}

const isPositive = (display: string): boolean => /[1-9]/.test(display.replace(/,/g, "").split(".")[0] ?? "");

/**
 * The two plaques — or null when nothing may be promised: the reward programme is OFF (tables absent / prizes disabled), a pool is zero, or no rank is
 * rewarded. (Picks and Points continue either way; the panel then simply shows no prize.)
 */
export function prizePlaques(reward: PicksRewardDto | undefined): { daily: PrizePlaque; weekly: PrizePlaque } | null {
  if (!reward || reward.status !== "ACTIVE" || reward.pointsPerCorrectPick <= 0) return null;
  if (!isPositive(reward.daily.prizePool) || !isPositive(reward.weekly.prizePool)) return null;
  if (reward.daily.topRewarded < 1 || reward.weekly.topRewarded < 1) return null;
  const make = (kind: PrizeKind): PrizePlaque => {
    const b = kind === "DAILY" ? reward.daily : reward.weekly;
    return {
      kind,
      title: kind === "DAILY" ? "Daily" : "Weekly",
      subtitle: "Prize pool",
      amount: groupDigits(b.prizePool),
      symbol: reward.symbol,
      top: b.topRewarded,
      topLabel: `Top ${b.topRewarded} winners`,
      minimumPicks: kind === "DAILY" ? reward.dailyMinimumPicks : reward.weeklyMinimumPicks,
      endsAt: b.endsAt,
    };
  };
  return { daily: make("DAILY"), weekly: make("WEEKLY") };
}

/** The fine print under the plaques: what the pools are, who shares them, and the REAL minimums — never a promise to any one player. */
export function prizeFinePrint(p: { daily: PrizePlaque; weekly: PrizePlaque }): string {
  const top = p.daily.top === p.weekly.top ? `the Top ${p.daily.top}` : `the Top ${p.daily.top} (Daily) and Top ${p.weekly.top} (Weekly)`;
  return `Each pool is shared by ${top}, by rank. Prizes need ${p.daily.minimumPicks} valid Picks in a day (Daily) or ${p.weekly.minimumPicks} in a week (Weekly).`;
}

const two = (n: number): string => String(n).padStart(2, "0");

/** What the countdown reads for the instant a board has ended and the next one is already running. */
export const ROLLING_OVER = "Rolling over…";

/** Daily boards end within 24 h: "14:23:18". */
export function dailyResetText(p: CountdownParts): string {
  return `${two(p.days * 24 + p.hours)}:${two(p.minutes)}:${two(p.seconds)}`;
}

/** Weekly boards end within 7 days: "6d 23h 41m" (and, in the last day, "23h 41m"). */
export function weeklyResetText(p: CountdownParts): string {
  return p.days > 0 ? `${p.days}d ${two(p.hours)}h ${two(p.minutes)}m` : `${p.hours}h ${two(p.minutes)}m`;
}

/** The text for a remaining time, from the SAME `countdownParts` the leaderboards use. At zero the board is rolling over (the next state read brings the new window). */
export function resetText(kind: PrizeKind, remainingMs: number): string {
  const parts = countdownParts(remainingMs);
  if (parts.done) return ROLLING_OVER;
  return kind === "DAILY" ? dailyResetText(parts) : weeklyResetText(parts);
}

/** The words the panel uses around the plaques. */
export const PICKS_HOW = (points: number): string => `Pick the winner. Earn +${points} Points for every correct Pick.`;
export const PICKS_FREE = "Free to play · No wallet required";
