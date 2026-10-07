import type { BattleDto } from "@/lib/dto";

import type { ArenaPhase } from "./ArenaRenderer";

export interface PhaseNow {
  phase: ArenaPhase;
  countdown: number | null;
  sinceStart: number;
  combatMs: number;
  /** ms until combat hard-ends (for the timer bar) */
  combatLeftMs: number;
}

/** Same layout rules as the server's timeline, evaluated against the synced server clock. */
export function phaseNow(b: BattleDto | null, now: number, countdownMs: number, maxCombatMs: number): PhaseNow {
  if (!b || b.combatStartsAt === null || b.combatEndsAt === null || b.resultsStartAt === null || b.slotEndsAt === null) {
    return { phase: "IDLE", countdown: null, sinceStart: 0, combatMs: 0, combatLeftMs: maxCombatMs };
  }
  const sinceStart = now - b.startsAt;
  const duration = b.combatEndsAt - b.combatStartsAt;
  const cdStart = b.combatStartsAt - countdownMs;
  if (now < cdStart) return { phase: "INTRO", countdown: null, sinceStart, combatMs: 0, combatLeftMs: maxCombatMs };
  if (now < b.combatStartsAt) {
    const left = b.combatStartsAt - now;
    return { phase: "COUNTDOWN", countdown: Math.max(1, Math.ceil(left / (countdownMs / 3))), sinceStart, combatMs: 0, combatLeftMs: maxCombatMs };
  }
  if (now < b.combatEndsAt) {
    const combatMs = now - b.combatStartsAt;
    return { phase: "COMBAT", countdown: null, sinceStart, combatMs, combatLeftMs: Math.max(0, maxCombatMs - combatMs) };
  }
  const left = Math.max(0, maxCombatMs - duration);
  if (now < b.resultsStartAt) return { phase: "VICTORY", countdown: null, sinceStart, combatMs: duration, combatLeftMs: left };
  if (now < b.slotEndsAt) return { phase: "RESULTS", countdown: null, sinceStart, combatMs: duration, combatLeftMs: left };
  return { phase: "DONE", countdown: null, sinceStart, combatMs: duration, combatLeftMs: left };
}
