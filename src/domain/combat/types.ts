import type { Ruleset } from "../rules";
import type { StatBlock } from "../stats";

export type Tactic = "AGGRESSIVE" | "BALANCED" | "DEFENSIVE";
export const TACTICS: readonly Tactic[] = ["AGGRESSIVE", "BALANCED", "DEFENSIVE"];

/** Everything the simulation needs to know about one fighter — the frozen pre-battle snapshot. */
export interface CombatUnitInput {
  characterId: string;
  name: string;
  classId: string;
  tactic: Tactic;
  /** Effective stats (class + Telegram + holdings + gear …), already rounded. POWER is NOT an input. */
  stats: StatBlock;
}

export interface BattleInput {
  seed: string;
  ruleset: Ruleset;
  units: CombatUnitInput[];
  /** Hard cap on combat length. */
  maxCombatMs: number;
  /** Also record per-tick positions/HP for rendering (not needed for settlement). */
  recordFrames?: boolean;
  /**
   * ANALYSIS TOOLING ONLY — never set by the Arena, never stored: start a fighter (by INPUT index) at a given position, HP fraction and skill
   * readiness, to replay a measured situation (e.g. the last two survivors of a free-for-all) as a controlled experiment. Absent = the
   * normal start, exactly as before (every stored battle and every hash is unaffected).
   */
  scenario?: { start: Array<ScenarioStart | undefined> };
}

export interface ScenarioStart {
  x: number;
  y: number;
  /** 0..1 of max HP (default 1). */
  hpFrac?: number;
  /** ms until each of the class's skills is ready, in the class's skill order (default: all ready). */
  skillReadyMs?: number[];
}

/** Event tuple: [tick, kind, a, b, value, flags]. Unit references are slot indexes (-1 = none). */
export type EventTuple = [tick: number, kind: number, a: number, b: number, value: number, flags: number];

export const EV = {
  ATTACK: 1,
  HIT: 2,
  MISS: 3,
  SKILL: 4,
  HEAL: 5,
  SHIELD: 6,
  STATUS: 7,
  ELIM: 8,
  HAZARD: 9,
  RING: 10,
  DASH: 11,
  END: 12,
} as const;

export const EV_FLAG = { CRIT: 1, AOE: 2, PROJECTILE: 4, LIFESTEAL: 8, BASIC: 16 } as const;

export const STATUS_CODE = { STUN: 1, SLOW: 2, TAUNT: 3, SHIELD: 4, DODGE: 5, EMPOWER: 6, BUFF: 7 } as const;

/**
 * Frame flag bits (per unit, per tick). From rules 3.1.0 a fighter's COMBAT STATE is in the frame too: WINDUP (committed to a basic attack, not yet
 * released), RECOVER (just released — recovering), RETREAT (backing away from a threat). Older rules never set them. Frames are presentation data
 * (they are not part of the events hash), so these bits change no stored hash.
 */
export const FRAME_FLAG = {
  ALIVE: 1, STUNNED: 2, CASTING: 4, SHIELDED: 8, SLOWED: 16, BUFFED: 32, EMPOWERED: 64, TAUNTED: 128, WINDUP: 256, RECOVER: 512, RETREAT: 1024,
} as const;
export const FRAME_STRIDE = 5; // x10, y10, hp, flags, target+1

export interface ParticipantOutcome {
  slot: number;
  characterId: string;
  placement: number;
  alive: boolean;
  finalHp: number;
  maxHp: number;
  eliminatedAtTick: number | null;
  survivedMs: number;
  eliminations: number;
  damageDealt: number;
  damageTaken: number;
  healingDone: number;
  killedBySlot: number | null;
}

export interface BattleOutcome {
  rulesVersion: string;
  tickMs: number;
  ticks: number;
  durationMs: number;
  endedBy: "LAST_STANDING" | "TIME_LIMIT";
  /** Skill ids referenced by SKILL events (value = index into this list). */
  skillIds: string[];
  /** Indexed by slot. */
  participants: ParticipantOutcome[];
  /** Slots from best to worst. */
  ranking: number[];
  events: EventTuple[];
  eventsHash: string;
  /** Flat: (ticks + 1) × units × FRAME_STRIDE, present only when recordFrames. */
  frames?: number[];
  /** Slot → starting position (for the intro pose). */
  startPositions: Array<[number, number]>;
  /** Input order → slot, so callers can map characters to slots. */
  slotOf: Record<string, number>;
}
