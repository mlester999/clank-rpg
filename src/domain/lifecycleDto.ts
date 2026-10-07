import type { ArenaRuntimeStatus, GamePhase, SeasonKind } from "./lifecycle";

/**
 * The shapes the Admin "Game control" panel and the lifecycle service exchange (types only — no code, so the browser bundle can import this file).
 * TOTAL heroes and ARENA-ELIGIBLE heroes are different numbers: a suspended hero exists (identity, rarity, PWR, history intact); it is just not fighting.
 */

export interface ArenaPopulation {
  /** Every hero that exists (demo heroes only where they are allowed). */
  total: number;
  /** Heroes that can enter a new roster right now. */
  eligible: number;
  /** Heroes whose own status is SUSPENDED / INACTIVE (they exist; they are not fighting). */
  suspended: number;
  inactive: number;
  /** Heroes that are ACTIVE themselves but whose Telegram member is BANNED. */
  bannedMember: number;
}

export interface SeasonView {
  id: string;
  kind: SeasonKind;
  number: number | null;
  name: string;
  /** "Season 1" / "Development". */
  label: string;
  status: "UPCOMING" | "ACTIVE" | "ENDED";
  startsAt: number | null;
  endsAt: number | null;
  /** The last public battle number issued in the season (0 = none yet). */
  lastBattleNumber: number;
  endedReason: string | null;
  archive: Record<string, unknown> | null;
}

export interface RewardLiabilities {
  /** False when the reward tables do not exist (nothing can be owed). */
  checked: boolean;
  /** True when a development reset / launch must refuse: real obligations exist that would be orphaned. */
  blocking: boolean;
  /** Raw ledger totals in logical micro-tokens (decimal strings). */
  earnedMicro: string;
  claimableMicro: string;
  reservedMicro: string;
  claimedMicro: string;
  pendingOrSentClaims: number;
  heldPrizes: number;
  finalizedBoards: number;
  reasons: string[];
}

export interface Blocker {
  code: string;
  message: string;
}

export interface ActionAvailability {
  allowed: boolean;
  blockers: Blocker[];
  warnings: string[];
  /** The phrase to type, for the actions that need one. */
  phrase: string | null;
}

export type LifecycleActionId = "launch" | "startArena" | "pauseArena" | "resumeArena" | "resetDevelopment" | "endSeason" | "createSeason";

export interface GameControl {
  now: number;
  phase: GamePhase;
  launchedAt: number | null;
  /** The ACTIVE season (null between seasons). */
  season: SeasonView | null;
  arena: {
    status: ArenaRuntimeStatus;
    label: string;
    statusChangedAt: number | null;
    startedAt: number | null;
    lastAdvanceAt: number | null;
    /** Battles committed but not settled (on stage, announced, prepared). */
    openBattles: number;
    /** `openBattles` plus the settled battle whose results screen is still being shown: zero = safe to pause / archive right now. */
    committedBattles: number;
  };
  heroes: ArenaPopulation;
  battles: {
    /** Public (season) numbers. */
    current: { number: number; status: string } | null;
    next: { number: number; status: string } | null;
    last: number;
    /** The number the next battle that is made will get. */
    nextToIssue: number;
  };
  rewards: RewardLiabilities;
  seasons: SeasonView[];
  groupSize: number;
  actions: Record<LifecycleActionId, ActionAvailability>;
}
