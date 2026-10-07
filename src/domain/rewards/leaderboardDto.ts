import type { PeriodKind } from "./time";

/**
 * The WIRE shapes of the Daily / Weekly Arena Picks leaderboards — pure types shared by the server (which builds them) and the
 * client (which renders them). Display strings only: nothing here carries a Telegram id, a wallet address or a balance. A
 * FINAL (finished) board shows each prize winner's holder bonus and the TIER LABEL that qualified it ("10M") — a published
 * result — but never a balance, a wallet or the evidence behind it.
 */
export interface BoardRuleView {
  kind: PeriodKind;
  /** Valid picks needed in this period to be prize-eligible (below it a member still appears, marked NOT YET PRIZE ELIGIBLE). */
  minimumPicks: number;
  pointsPerCorrectPick: number;
  /** Whole $CLANKRPG, display ("100,000"). */
  prizePool: string;
  prizePoolPlain: string;
  symbol: string;
  /** How many positions the ladder pays. */
  topRewarded: number;
  /** Prize per position (display), #1 first. */
  prizes: Array<{ position: number; share: string; amount: string }>;
  /** Prizes are switched off by an admin (a finalized period would award nothing). */
  prizesPaused: boolean;
  /** The holder bonus ladder (display only — it never changes rank or score). */
  holderBonuses: Array<{ label: string; minimum: string; bonus: string }>;
}

export type BonusPublicStatus = "NONE" | "PENDING" | "CREDITED" | "EXPIRED";

export interface BoardRowDto {
  rank: number;
  /** Public identity is the HERO — never the Telegram id or username. */
  characterId: string | null;
  /** The hero's stable PUBLIC id when the hero has a public profile (active, not banned) — what the row links to. */
  heroPublicId: string | null;
  /**
   * The hero's CURRENT rarity, for the small badge beside its name. Display only: it is read when the board is served, never stored in a
   * result row and never an input to points, rank, tie-breaks or prizes — rarity has nothing to do with Arena Picks scoring.
   */
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" | null;
  name: string;
  classId: string;
  points: number;
  /** Every valid pick of the period — there is no daily cap. */
  picks: number;
  correctPicks: number;
  /** Percent of picks that were correct, one decimal (59.6). */
  accuracy: number;
  currentStreak: number;
  bestStreak: number;
  prizeEligible: boolean;
  /** Base prize (display, "0" when none). For a running period this is a PROJECTION from the current standings. */
  basePrize: string;
  /** FINAL boards only: the holder bonus ("0" when none), the qualifying tier label ("10M") and the total. */
  holderBonus: string;
  holderTier: string | null;
  bonusStatus: BonusPublicStatus;
  totalReward: string;
  /** More than one member shares exactly this rank (same correct picks and accuracy). */
  tied: boolean;
}

export interface BoardDto {
  kind: PeriodKind;
  /** `CURRENT` = the running period (live, projected prizes); `FINALIZING` = ended but not frozen yet; `FINAL` = frozen. */
  state: "CURRENT" | "FINALIZING" | "FINAL";
  /** The period's identifier: the UTC date it starts on (a Monday for WEEKLY). */
  start: string;
  /** The server's clock when this was built — the client anchors its countdown to it, never to its own wall clock. */
  serverNow: number;
  startsAt: number;
  endsAt: number;
  rules: BoardRuleView;
  participants: number;
  eligibleParticipants: number;
  rows: BoardRowDto[];
  finalizedAt: number | null;
}

export interface BoardMeDto {
  rank: number | null;
  points: number;
  /** Every valid pick of the period. */
  picks: number;
  correctPicks: number;
  /** Percent correct, one decimal (null with no picks). */
  accuracy: number | null;
  prizeEligible: boolean;
  /** Picks still needed in this period to be prize-eligible (0 when already eligible). */
  picksToEligible: number;
  /** After the period is finalized: this member's own base prize, bonus and status (a held prize is only ever shown to its owner). */
  prize?: { base: string; bonus: string; total: string; status: "CREDITED" | "HELD" | "FORFEITED" | "NONE"; bonusStatus: BonusPublicStatus };
}

export interface PeriodListItem {
  start: string;
  participants: number;
  prizePool: string;
}

/** The whole `GET /api/leaderboard/picks` payload. */
export interface BoardPayload {
  board: BoardDto;
  me: BoardMeDto | null;
  /** Finalized periods of this kind, newest first (the history selector). */
  periods: PeriodListItem[];
  /** The running period of this kind. */
  current: { kind: PeriodKind; start: string; startsAt: number; endsAt: number };
  /** An ended period that is not frozen yet (shown as FINALIZING in the selector), or null. */
  finalizing: string | null;
  serverNow: number;
  /**
   * The season being played now ("Development", "Season 1"…): the Hall of Champions says DEVELOPMENT / BETA when it is a development run. Optional so a payload
   * served by an older server (or built by a test) stays valid.
   */
  season?: { label: string; kind: "DEVELOPMENT" | "COMPETITIVE" } | null;
}
