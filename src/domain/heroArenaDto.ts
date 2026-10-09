import type { ClassVisual } from "@/lib/dto";

import type { AppearanceParts, Rarity } from "./character/appearance";
import type { HeroScope, RecordMetric } from "./heroArena";
import type { PeriodKind } from "./rewards/time";

/**
 * The WIRE shapes of the Hero Arena boards and Hero Records — pure types shared by the server (which builds them) and the client (which renders them).
 * Display strings only: no Telegram id, no wallet, no internal owner id ever travels here. A hero is public by its stable public id.
 */
export interface LeaderboardSeasonView {
  id: string;
  /** "Season 1", "Development" … */
  label: string;
  kind: "DEVELOPMENT" | "COMPETITIVE";
  status: "ACTIVE" | "ENDED";
  /** The default: the season being played now. */
  current: boolean;
  /**
   * When the season ends (ms, UTC) — present ONLY when the database holds a real, FUTURE end time for the ACTIVE season. Today seasons end when an operator ends them, so this is
   * normally null and no season countdown is shown: an end date is never invented. Optional so an older payload stays valid.
   */
  endsAt?: number | null;
}

export interface HeroRulesView {
  kind: PeriodKind;
  minimumWins: number;
  /** false → "REWARD POOL NOT SET": no amount has been configured, none is shown, none is paid. */
  poolSet: boolean;
  /** Whole $CLANKRPG, display ("250,000"); null when the pool is not set. */
  prizePool: string | null;
  symbol: string;
  topRewarded: number;
  prizes: Array<{ position: number; share: string; amount: string | null }>;
  /** Hero Arena prizes are switched off by an admin. */
  prizesPaused: boolean;
}

export type HeroPrizeStatus = "NONE" | "CREDITED" | "RESERVED" | "HELD" | "FORFEITED";

export interface HeroRowDto {
  rank: number;
  /** Another hero shares exactly this value (an exact tie — nothing breaks it). */
  tied: boolean;
  characterId: string;
  /** The hero's stable PUBLIC id when it has a public profile (active, owner not banned) — what the row links to. Suspended heroes keep their row, without a link. */
  heroPublicId: string | null;
  name: string;
  classId: string;
  rarity: Rarity | null;
  /** CURRENT power (display only; never an input). */
  power: number;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
  /** Percent of matches won, one decimal. */
  winRate: number;
  /** Seasonal ladder tier (Season scope only). */
  seasonRank: { id: string; name: string } | null;
  appearance: { rarity: Rarity; parts: AppearanceParts; sprite?: unknown; overrides?: unknown } | null;
  avatarUrl: string | null;
  claimed: boolean;
  isDemo: boolean;
  prizeEligible: boolean;
  /** Rewarded boards only: the prize of this position ("0" none). A PROJECTION while the period runs. */
  prize: string;
  /** FINAL rewarded boards only. */
  prizeStatus: HeroPrizeStatus;
}

export interface HeroBoardDto {
  scope: HeroScope;
  /** Does this view pay? Daily / Weekly of HERO ARENA do; Season and every HERO RECORDS view do not. */
  rewarded: boolean;
  state: "CURRENT" | "FINALIZING" | "FINAL" | "SEASON";
  /** The UTC date the period starts on (a Monday for WEEKLY); null for Season. */
  start: string | null;
  serverNow: number;
  startsAt: number | null;
  endsAt: number | null;
  season: LeaderboardSeasonView | null;
  /** Prize rules — present only on REWARDED views (never on Season standings or records). */
  rules: HeroRulesView | null;
  participants: number;
  rows: HeroRowDto[];
  finalizedAt: number | null;
  classes: Record<string, ClassVisual>;
}

export interface HeroPeriodListItem {
  start: string;
  participants: number;
}

export interface HeroBoardPayload {
  board: HeroBoardDto;
  /** Finalized periods of this kind (Daily / Weekly only), newest first. */
  periods: HeroPeriodListItem[];
  /** The just-ended period that is not frozen yet (shown as FINALIZING for the few seconds it takes), or null. */
  finalizing: string | null;
  seasons: LeaderboardSeasonView[];
}

export interface HeroRecordsPayload {
  metric: RecordMetric;
  board: HeroBoardDto;
  seasons: LeaderboardSeasonView[];
}

/** Arena Picks SEASON standings (cumulative, standings only — there is no season payout). */
export interface PicksSeasonRowDto {
  rank: number;
  tied: boolean;
  characterId: string | null;
  heroPublicId: string | null;
  rarity: Rarity | null;
  name: string;
  classId: string;
  picks: number;
  correctPicks: number;
  accuracy: number;
  points: number;
}

export interface PicksSeasonPayload {
  rewarded: false;
  season: LeaderboardSeasonView | null;
  serverNow: number;
  participants: number;
  rows: PicksSeasonRowDto[];
  me: { rank: number | null; picks: number; correctPicks: number; accuracy: number | null; points: number } | null;
  seasons: LeaderboardSeasonView[];
}
