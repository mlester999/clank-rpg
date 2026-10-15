import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import { periodWindow, periodWindowOf, previousPeriodStart, type PeriodKind } from "@/domain/rewards/time";
import type { ClassVisual } from "@/lib/dto";

/**
 * EVENTS — the pure vocabulary and rules of the champions history (no database, no clock, no browser).
 *
 * The Events page shows who WON each completed Daily and Weekly period of the two competitions:
 *
 *   ARENA PICKS   the PLAYER competition. A period's champion is the PRIZE-ELIGIBLE member who finished first (prize position 1); members tied on correct picks AND
 *                 accuracy are JOINT champions. A member who led the board but did not reach the minimum number of valid Picks is a LEADER, never a champion and never
 *                 a prize winner: if nobody was eligible, the period honestly says NO ELIGIBLE WINNER.
 *   HERO ARENA    the HERO competition, ranked by Arena Wins only (no tiebreaker exists: heroes with the same number of wins are joint champions).
 *
 * Every figure comes from a FROZEN, finalized period (the existing idempotent finalizers write them once). Nothing here ranks anything, invents a winner or
 * fills an empty period. A champion is recognition; a prize is a separate fact (an allocation to a reward balance) — and neither is a payment.
 */

export const EVENT_PROGRAMS = ["picks", "hero"] as const;
export type EventProgram = (typeof EVENT_PROGRAMS)[number];
export const EVENT_KINDS = ["daily", "weekly"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const isEventProgram = (v: unknown): v is EventProgram => v === "picks" || v === "hero";
export const isEventKind = (v: unknown): v is EventKind => v === "daily" || v === "weekly";
export const eventPeriodKind = (kind: EventKind): PeriodKind => (kind === "daily" ? "DAILY" : "WEEKLY");

/** Where the Events page stands: before the official season, during it, or between two official seasons. */
export type EventsPhase = "PRE_SEASON" | "SEASON_ACTIVE" | "BETWEEN_SEASONS";

export interface EventsSeasonView {
  id: string;
  /** "Season 1". */
  label: string;
  number: number;
  status: "ACTIVE" | "ENDED";
  startsAt: number;
  endsAt: number | null;
  /** The season being played now (or, between seasons, the one that ended last). */
  current: boolean;
}

export interface EventsStateDto {
  phase: EventsPhase;
  /** The official season whose history is shown. Null before Season 1 exists. */
  season: EventsSeasonView | null;
  /** Official seasons, newest first (a selector appears only with two or more). Development runs are never listed. */
  seasons: EventsSeasonView[];
  serverNow: number;
}

/** How a period ended, for the Events card. */
export type PeriodOutcome =
  | "CHAMPION" // exactly one champion
  | "JOINT_CHAMPIONS" // an exact tie for first: nobody is picked arbitrarily
  | "NO_ELIGIBLE_WINNER" // there were participants, but nobody qualified to win
  | "NO_COMPLETED_RESULTS" // the period closed with nothing to rank
  | "FINALIZING"; // the period closed and its results are being frozen

export type AllocationStatus = "NONE" | "ALLOCATED";
/** A prize as the PUBLIC may see it: an allocation to the winner's reward balance. Never "paid": a payment is a per-account fact that is not published here. */
export interface AllocationDto {
  status: AllocationStatus;
  /** Formatted amount in whole tokens ("30,000"), null when nothing was allocated. */
  amount: string | null;
  symbol: string;
  /** Picks only: the holder bonus that rode on the prize, kept apart. */
  bonusPart: string | null;
}

export interface EventArt {
  rarity: Rarity;
  parts: AppearanceParts;
  sprite?: unknown;
  overrides?: unknown;
}

interface RowBase {
  rank: number;
  /** True when another entry shares this exact rank. */
  tied: boolean;
  /** The public name: the hero's name as it was when the period was frozen. */
  name: string;
  classId: string;
  rarity: Rarity | null;
  /** PWR of the hero's version when the period closed. */
  power: number | null;
  heroVersion: number | null;
  /** The hero's stable public id when it may be linked (active, member not banned); otherwise null. */
  heroPublicId: string | null;
  /** The portrait data of that version; null when no snapshot exists. */
  art: EventArt | null;
  allocation: AllocationDto;
}

export interface PicksRowDto extends RowBase {
  program: "picks";
  points: number;
  picks: number;
  correctPicks: number;
  /** Percent with one decimal; null with no picks. */
  accuracy: number | null;
  prizeEligible: boolean;
  /** Position among PRIZE-ELIGIBLE members (1 = the champion), null when not eligible. `rank` is the position on the whole board — the two differ when a leader had too few valid Picks. */
  prizeRank: number | null;
}

export interface HeroRowDto extends RowBase {
  program: "hero";
  matches: number;
  wins: number;
  top2: number;
  kos: number;
  /** Percent with one decimal; null with no matches. */
  winRate: number | null;
}

export type EventRowDto = PicksRowDto | HeroRowDto;

export interface PeriodRulesDto {
  /** Picks: minimum valid Picks for a prize; Hero Arena: minimum wins. */
  minimum: number;
  minimumUnit: "Picks" | "wins";
  /** Whole-token pool the period was frozen with; null when no pool was set (Hero Arena) or prizes were off. */
  prizePool: string | null;
  symbol: string;
  /** Prizes were switched off / no pool was set when the period closed: recognition only. */
  recognitionOnly: boolean;
}

export interface PeriodDto {
  program: EventProgram;
  kind: EventKind;
  /** The period's identifier: the UTC date it starts on (a Monday for weekly). */
  start: string;
  startsAt: number;
  endsAt: number;
  outcome: PeriodOutcome;
  finalizedAt: number | null;
  participants: number;
  eligibleParticipants: number;
  /** The champion(s): one, or the joint winners of an exact tie. Empty for NO_ELIGIBLE_WINNER / NO_COMPLETED_RESULTS / FINALIZING. */
  champions: EventRowDto[];
  /** Joint champions beyond the ones listed. */
  moreChampions: number;
  /** Arena Picks only, when the board's leader was NOT prize-eligible: said plainly, never shown as a champion. */
  leader: { name: string; picks: number; correctPicks: number; minimum: number } | null;
  rules: PeriodRulesDto | null;
}

export interface PeriodDetailDto extends PeriodDto {
  /** The final Top 10 (rank 10 inclusive, ties included, capped). */
  standings: EventRowDto[];
  /** Entries tied inside the Top 10 that the cap cut off. */
  standingsCut: number;
}

export interface EventsListDto {
  state: EventsStateDto;
  program: EventProgram;
  kind: EventKind;
  /** Newest first. Empty before the first period of the season closes. */
  periods: PeriodDto[];
  /** Pass as `before` for the next (older) page; null at the end of the season's history. */
  nextBefore: string | null;
  /** How each class is drawn (colours, weapon…) — the portraits are rendered from the snapshot's look plus its class. Added by the API route. */
  classes: Record<string, ClassVisual>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The newest period of `kind` that is COMPLETE for a season that began at `seasonStartsAt` and (if ended) ended at `seasonEndsAt`: its end is at or before `nowMs`,
 * and it started no later than the season's end. Null when no period has closed yet. (The same UTC boundaries as the live boards — there is no second clock.)
 */
export function lastCompletedPeriod(kind: PeriodKind, nowMs: number, seasonStartsAt: number, seasonEndsAt: number | null): string | null {
  const first = periodWindow(kind, seasonStartsAt);
  const cursorMs = seasonEndsAt === null ? nowMs : Math.min(nowMs, seasonEndsAt);
  let w = periodWindow(kind, cursorMs);
  // The period that contains "now" (or the season's end) is not complete unless it already closed.
  if (w.endsAt > nowMs) w = periodWindowOf(kind, previousPeriodStart(kind, w.start));
  return w.startsAt < first.startsAt ? null : w.start;
}

/** The first period of a season: the one containing its start. */
export const firstPeriodOfSeason = (kind: PeriodKind, seasonStartsAt: number): string => periodWindow(kind, seasonStartsAt).start;

/**
 * One page of period identifiers, newest first, from `last` (inclusive) down to `first` (inclusive); `before` (exclusive) continues from a previous page. Pure and
 * bounded by `limit` — never by the length of the season.
 */
export function periodPage(kind: PeriodKind, first: string, last: string, before: string | null, limit: number): { starts: string[]; next: string | null } {
  const n = Math.min(Math.max(Math.floor(limit), 1), 60);
  let cursor = before === null ? last : previousPeriodStart(kind, before);
  if (cursor > last) cursor = last;
  const starts: string[] = [];
  while (cursor >= first && starts.length < n) {
    starts.push(cursor);
    cursor = previousPeriodStart(kind, cursor);
  }
  const lastShown = starts[starts.length - 1];
  const next = lastShown !== undefined && previousPeriodStart(kind, lastShown) >= first ? lastShown : null;
  return { starts, next };
}

// ---------------------------------------------------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------------------------------------------------

export interface OutcomeInput {
  /** A frozen board exists for the period. */
  frozen: boolean;
  /** No frozen board, but the season has results in the period that the finalizer has not frozen yet. */
  finalizing: boolean;
  /** The number of champions found among the frozen results. */
  champions: number;
}

export function periodOutcome(i: OutcomeInput): PeriodOutcome {
  if (!i.frozen) return i.finalizing ? "FINALIZING" : "NO_COMPLETED_RESULTS";
  if (i.champions === 0) return "NO_ELIGIBLE_WINNER";
  return i.champions === 1 ? "CHAMPION" : "JOINT_CHAMPIONS";
}

/** "OCT 14" / "WEEK OF OCT 12" are built by the page; this is the spoken form for assistive technology and metadata. */
export const periodWord = (kind: EventKind): string => (kind === "daily" ? "Daily" : "Weekly");
export const programWord = (program: EventProgram): string => (program === "picks" ? "Arena Picks" : "Hero Arena");

/** The most champions listed on a card; an exact tie larger than this lists the first few and says how many more. */
export const MAX_CHAMPIONS_SHOWN = 4;
/** The final standings shown for a period. */
export const STANDINGS_RANK_LIMIT = 10;
export const STANDINGS_ROW_CAP = 25;
