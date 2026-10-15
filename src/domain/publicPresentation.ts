import type { GamePhase, SeasonKind } from "@/domain/lifecycle";

/**
 * WHAT THE PUBLIC IS TOLD ABOUT WHERE THE GAME IS — one place for the words, so every page agrees and nothing says "Season 1" before it exists.
 *
 *   PRE_SEASON      the game phase is DEVELOPMENT: the Arena may be running practice battles, but nothing is an official record. The public words are neutral and
 *                   truthful ("Pre-season", "Season 1 coming soon") — never "development", "test", "beta" or "local".
 *   SEASON_LIVE     the game is LIVE with an ACTIVE official season: "Season 1".
 *   BETWEEN         the game is LIVE but no season is active (one ended, the next is not created yet).
 *
 * The persisted phase (`game_state`) decides — never NODE_ENV, a Vercel environment, or a variable. Admin screens keep their precise vocabulary; this is the public one.
 */
export type PublicStage = "PRE_SEASON" | "SEASON_LIVE" | "BETWEEN_SEASONS";

export interface PublicSeasonDto {
  phase: GamePhase;
  season: { label: string; kind: SeasonKind; number: number | null } | null;
}

export function publicStage(s: PublicSeasonDto | null | undefined): PublicStage | null {
  if (!s) return null;
  if (s.phase === "DEVELOPMENT") return "PRE_SEASON";
  return s.season && s.season.kind === "COMPETITIVE" ? "SEASON_LIVE" : "BETWEEN_SEASONS";
}

/** The chip that sits beside a page title or in the navigation. Null while the state is not known (no chip is better than a wrong one). */
export function stageBadge(s: PublicSeasonDto | null | undefined): { text: string; tone: "pre" | "live" | "wait" } | null {
  const stage = publicStage(s);
  if (stage === null) return null;
  if (stage === "PRE_SEASON") return { text: "Pre-season", tone: "pre" };
  if (stage === "SEASON_LIVE") return { text: (s as PublicSeasonDto).season?.label ?? "Season 1", tone: "live" };
  return { text: "Between seasons", tone: "wait" };
}

/** "SEASON 1 LEADERBOARDS" once live; "PRE-SEASON LEADERBOARDS" before. */
export function leaderboardsTitle(s: PublicSeasonDto | null | undefined): string {
  const stage = publicStage(s);
  if (stage === "SEASON_LIVE") return `${(s as PublicSeasonDto).season?.label ?? "Season 1"} Leaderboards`;
  if (stage === "BETWEEN_SEASONS") return "Season Leaderboards";
  return "Pre-season Leaderboards";
}

/** "SEASON 1 EVENTS" once live; before the launch the page says EVENTS and that Season 1 is coming. */
export function eventsTitle(s: PublicSeasonDto | null | undefined): { title: string; sub: string } {
  const stage = publicStage(s);
  if (stage === "SEASON_LIVE") return { title: `${(s as PublicSeasonDto).season?.label ?? "Season 1"} Events`, sub: "Every completed day and week of the season — frozen the moment it closes." };
  if (stage === "BETWEEN_SEASONS") return { title: "Season Events", sub: "Past champions stay on record between seasons." };
  return { title: "Events", sub: "Season 1 coming soon. Champions will be crowned here once the first official period closes." };
}

/** The site-wide footer note. */
export function footerNote(s: PublicSeasonDto | null | undefined): string {
  const base = "Clank RPG is an independent community game for the Clank.trade ecosystem. Off-chain Clank Gold has no cash value.";
  const stage = publicStage(s);
  if (stage === "PRE_SEASON") return `${base} Pre-season: records reset to zero when Season 1 launches.`;
  return base;
}
