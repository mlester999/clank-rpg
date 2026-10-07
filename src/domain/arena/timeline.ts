import type { ArenaSettings } from "../settings";

export type ArenaPhase = "INTRO" | "COUNTDOWN" | "COMBAT" | "VICTORY" | "RESULTS" | "DONE";

export interface BattleTimes {
  startsAtMs: number;
  combatStartsAtMs: number;
  combatEndsAtMs: number;
  resultsStartAtMs: number;
  slotEndsAtMs: number;
}

/**
 * Wall-clock layout of one battle slot, derived from `startsAt` and the (server-simulated)
 * combat duration:
 *
 *   |-- intro (heroes standing, idle) --|-- 3·2·1 --|-- combat (≤ the arena's maxCombatMs, 60 s by default) --|-- victory beat --|-- results (5 s) --|
 *
 * Combat begins the instant the countdown ends — there is no extra pre-fight timer.
 */
export function layoutBattle(startsAtMs: number, combatDurationMs: number, a: ArenaSettings): BattleTimes {
  const combatStartsAtMs = startsAtMs + a.introMs + a.countdownMs;
  const combatEndsAtMs = combatStartsAtMs + Math.min(combatDurationMs, a.maxCombatMs);
  const resultsStartAtMs = combatEndsAtMs + a.victoryHoldMs;
  return { startsAtMs, combatStartsAtMs, combatEndsAtMs, resultsStartAtMs, slotEndsAtMs: resultsStartAtMs + a.resultsMs };
}

export interface PhaseInfo {
  phase: ArenaPhase;
  /** 3, 2, 1 during COUNTDOWN, otherwise null. */
  countdown: number | null;
  /** ms since combat started (0 before). */
  combatElapsedMs: number;
}

export function phaseAt(nowMs: number, t: BattleTimes, a: ArenaSettings): PhaseInfo {
  if (nowMs < t.startsAtMs + a.introMs) return { phase: "INTRO", countdown: null, combatElapsedMs: 0 };
  if (nowMs < t.combatStartsAtMs) {
    const remaining = t.combatStartsAtMs - nowMs;
    return { phase: "COUNTDOWN", countdown: Math.max(1, Math.ceil(remaining / (a.countdownMs / 3))), combatElapsedMs: 0 };
  }
  if (nowMs < t.combatEndsAtMs) return { phase: "COMBAT", countdown: null, combatElapsedMs: nowMs - t.combatStartsAtMs };
  if (nowMs < t.resultsStartAtMs) return { phase: "VICTORY", countdown: null, combatElapsedMs: t.combatEndsAtMs - t.combatStartsAtMs };
  if (nowMs < t.slotEndsAtMs) return { phase: "RESULTS", countdown: null, combatElapsedMs: t.combatEndsAtMs - t.combatStartsAtMs };
  return { phase: "DONE", countdown: null, combatElapsedMs: t.combatEndsAtMs - t.combatStartsAtMs };
}
