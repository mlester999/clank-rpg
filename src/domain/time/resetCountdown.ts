import { countdownParts } from "../rewards/leaderboard";

/**
 * THE COUNTDOWN TEXT every "resets / ends in" label of the game uses — one formatter, so the Daily board, the Weekly board and the free-reroll
 * allowance all read the same way:
 *
 *   under a day (and always for a DAILY timer):   "23H 59M 59S"   "08H 24M 12S"
 *   a day or more (WEEKLY, `allowDays`):           "06D 23H 59M"   "02D 14H 09M"
 *
 * UTC is the source of truth for every boundary; this only turns "milliseconds left" into text. Zero reads "00H 00M 00S".
 */
const two = (n: number): string => String(n).padStart(2, "0");

export interface ResetCountdownOptions {
  /** A timer that can exceed a day (the Weekly board) switches to "DD HH MM" while at least one whole day is left. A Daily timer never does. */
  allowDays?: boolean;
}

export function formatResetCountdown(remainingMs: number, opts: ResetCountdownOptions = {}): string {
  const p = countdownParts(remainingMs);
  if (opts.allowDays && p.days >= 1) return `${two(p.days)}D ${two(p.hours)}H ${two(p.minutes)}M`;
  return `${two(p.days * 24 + p.hours)}H ${two(p.minutes)}M ${two(p.seconds)}S`;
}

/** The same figure for a screen reader: "23 hours 59 minutes 59 seconds" / "2 days 14 hours 9 minutes". */
export function spokenResetCountdown(remainingMs: number, opts: ResetCountdownOptions = {}): string {
  const p = countdownParts(remainingMs);
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (opts.allowDays && p.days >= 1) return `${unit(p.days, "day")} ${unit(p.hours, "hour")} ${unit(p.minutes, "minute")}`;
  return `${unit(p.days * 24 + p.hours, "hour")} ${unit(p.minutes, "minute")} ${unit(p.seconds, "second")}`;
}
