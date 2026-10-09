import type { PicksRewardDto, UpcomingBattleDto } from "@/lib/dto";

import { PICKS_FREE, PICKS_HOW } from "./prizeView";

/**
 * Pure view logic of the Arena Picks panel (no React), so what the panel shows can be tested on its own.
 *
 * The server DECIDES whether the upcoming battle's picks are open (domain/arena/picksWindow.ts, published in
 * `upcoming.picks`). The browser only DISPLAYS that verdict — and it may display a close EARLIER than the snapshot said (its
 * synced clock has passed the server's own `locksAt`), never later. It can therefore never show OPEN for a window the server has
 * closed, and a late click is refused by the server regardless of what the panel showed.
 */
export type WindowDisplay = "OPEN" | "LOCKED";

export function windowDisplay(upcoming: UpcomingBattleDto | null, serverNow: number): WindowDisplay | null {
  if (!upcoming) return null;
  if (upcoming.picks.status === "LOCKED") return "LOCKED";
  if (upcoming.picks.locksAt !== null && serverNow >= upcoming.picks.locksAt) return "LOCKED";
  // A battle that has taken the stage is the fight being watched, never the one being picked.
  if (serverNow >= upcoming.startsAt) return "LOCKED";
  return "OPEN";
}

/** Whole seconds until the server closes an OPEN window (null when not open / not known). */
export function secondsUntilLock(upcoming: UpcomingBattleDto | null, serverNow: number): number | null {
  if (!upcoming || windowDisplay(upcoming, serverNow) !== "OPEN" || upcoming.picks.locksAt === null) return null;
  return Math.max(0, Math.ceil((upcoming.picks.locksAt - serverNow) / 1000));
}

/**
 * The panel's words around the prize plaques. Short on purpose; nothing here mentions a per-battle token reward (Arena Picks feed the Daily and Weekly
 * leaderboards, and the PRIZE amounts live on the plaques — see prizeView.ts).
 */
export interface PickCopy {
  /** The one-line game explanation. */
  lead: string;
  /** Only while the reward programme is off: where Points lead. */
  scoring: string | null;
  free: string;
}

export function pickCopy(reward: PicksRewardDto | undefined): PickCopy {
  const live = reward !== undefined && reward.status === "ACTIVE" && reward.pointsPerCorrectPick > 0;
  return {
    lead: live ? PICKS_HOW(reward.pointsPerCorrectPick) : "Pick who wins the next fight.",
    scoring: live ? null : "Correct Picks earn Clank Points toward the Daily and Weekly leaderboards.",
    free: PICKS_FREE,
  };
}
