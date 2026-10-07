import type { PicksRewardDto, UpcomingBattleDto } from "@/lib/dto";

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

/** The panel's words. Short on purpose; nothing here mentions a per-battle token reward (Arena Picks feed the Daily and Weekly leaderboards). */
export interface PickCopy {
  lead: string;
  scoring: string;
  prize: string | null;
  free: string;
}

export function pickCopy(reward: PicksRewardDto | undefined): PickCopy {
  const live = reward !== undefined && reward.status === "ACTIVE" && reward.pointsPerCorrectPick > 0;
  const scoring = live
    ? `Every valid Pick counts. A correct Pick earns +${reward.pointsPerCorrectPick} Points — the Daily and Weekly leaderboards are a race for the most correct Picks.`
    : "Correct Picks earn Clank Points toward the Daily and Weekly leaderboards.";
  let prize: string | null = null;
  if (live && reward.daily.prizePool !== "0" && reward.weekly.prizePool !== "0") {
    const top = reward.daily.topRewarded === reward.weekly.topRewarded ? `to the Top ${reward.daily.topRewarded}` : `to the Top ${reward.daily.topRewarded} (Daily) / Top ${reward.weekly.topRewarded} (Weekly)`;
    prize = `Daily ${reward.daily.prizePool} · Weekly ${reward.weekly.prizePool} ${reward.symbol} ${top}`;
  }
  return { lead: "Pick who wins the next fight.", scoring, prize, free: "Free to play. No wallet required." };
}
