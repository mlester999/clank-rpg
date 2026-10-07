/**
 * THE ARENA PICKS WINDOW — one pure rule, used by the pick service, the public state, the arena's lock step and the tests.
 *
 * Picks are made on the UPCOMING battle (B) while the battle on stage (A) is being fought:
 *
 *     A on stage ─ picks for B OPEN ─ A's result is DECIDED ─ picks for B LOCK ─ A's results ─ 3·2·1 ─ B takes the stage
 *
 * B's window is open while ALL of these hold:
 *   · B is PREPARED (simulated and committed: its roster is final and is exactly who will fight),
 *   · B has not been stamped closed (`picksLockedAt`: written once, by the arena, in the same transaction as the transition
 *     that closed it),
 *   · B is the NEXT fight (its predecessor has taken the stage),
 *   · its predecessor's result is not decided yet, and
 *   · B has not taken the stage itself (`now < B.startsAt`).
 *
 * A predecessor is DECIDED once it is no longer SIMULATED (settled / voided), or the SERVER clock has reached its persisted
 * `combatEndsAt` — the instant the server itself publishes that battle's winner. The arena materialises that transition as the
 * stamp on B (`PREDECESSOR_DECIDED`) a few milliseconds later, but the rule never waits for it: a late advance, a slow worker or
 * a slow settlement cannot extend the window past the moment viewers see the winner.
 *
 * FALLBACK — no predecessor has the stage (the arena just started, or restarted, or the previous battle was voided or its slot
 * is already over): the window is the pre-fight window, open until B takes the stage (`startsAt`), then stamped OWN_START. It
 * never stays disabled and never reaches into B's own fight.
 *
 * The browser may DISPLAY this. It never DECIDES it: only the server clock and the database stamp do.
 */

export type BattleStatus = "SCHEDULED" | "SIMULATED" | "SETTLED" | "VOID";
export type PicksLockReason = "PREDECESSOR_DECIDED" | "OWN_START" | "VOID";

export interface WindowBattle {
  status: BattleStatus;
  startsAt: number;
  /** The persisted close moment (null while open / not yet stamped). */
  picksLockedAt: number | null;
  picksLockReason: PicksLockReason | null;
}

/** The battle immediately before it in the queue (null when there is none). */
export interface WindowPredecessor {
  status: BattleStatus;
  startsAt: number;
  combatEndsAt: number | null;
  slotEndsAt: number | null;
}

export type PicksWindowState =
  /** Not a pick target (yet): its roster is not committed, or an earlier battle is still to take the stage first. */
  | "NOT_OPEN"
  | "OPEN"
  | "LOCKED"
  | "VOID"
  /** The battle is over: picks are settled. */
  | "RESOLVED";

export interface PicksWindow {
  state: PicksWindowState;
  /** PREDECESSOR = the battle on stage closes it; FALLBACK = nothing is on stage ahead of it, so its own start does. */
  mode: "PREDECESSOR" | "FALLBACK";
  /** Why a LOCKED window is closed. */
  reason: PicksLockReason | null;
  /** The SERVER-clock instant at which an OPEN window will close (a display hint — the state above is the authority). */
  locksAt: number | null;
}

/** Whether a battle still holds the stage as far as pick gating goes: unsettled, or settled but its slot has not ended. */
export function holdsStage(p: WindowPredecessor, nowMs: number): boolean {
  return p.status === "SIMULATED" || (p.status === "SETTLED" && p.slotEndsAt !== null && nowMs < p.slotEndsAt);
}

/** Has the predecessor's winner been decided on the server? (Not-yet-simulated predecessors are never decided.) */
export function isDecided(p: WindowPredecessor, nowMs: number): boolean {
  if (p.status === "SETTLED" || p.status === "VOID") return true;
  return p.status === "SIMULATED" && p.combatEndsAt !== null && nowMs >= p.combatEndsAt;
}

export function picksWindow(b: WindowBattle, pred: WindowPredecessor | null, nowMs: number): PicksWindow {
  const mode: PicksWindow["mode"] = pred !== null && holdsStage(pred, nowMs) ? "PREDECESSOR" : "FALLBACK";
  const closed = (state: PicksWindowState, reason: PicksLockReason | null = null): PicksWindow => ({ state, mode, reason, locksAt: null });

  if (b.status === "VOID") return closed("VOID", "VOID");
  if (b.status === "SETTLED") return closed("RESOLVED", b.picksLockReason);
  if (b.status === "SCHEDULED") return closed("NOT_OPEN");

  // SIMULATED = prepared.
  if (b.picksLockedAt !== null) return closed("LOCKED", b.picksLockReason ?? "OWN_START");
  // An earlier battle that has not yet taken the stage is the next fight; this one is still queued behind it.
  if (nowMs < b.startsAt && pred !== null && (pred.status === "SIMULATED" || pred.status === "SCHEDULED") && pred.startsAt > nowMs) return closed("NOT_OPEN");

  if (mode === "PREDECESSOR" && pred !== null) {
    // The battle in front decided first (even if this one has since taken the stage, e.g. after an outage): that is the real reason.
    if (isDecided(pred, nowMs)) return closed("LOCKED", "PREDECESSOR_DECIDED");
    if (nowMs >= b.startsAt) return closed("LOCKED", "OWN_START");
    return { state: "OPEN", mode, reason: null, locksAt: pred.combatEndsAt !== null ? Math.min(pred.combatEndsAt, b.startsAt) : b.startsAt };
  }
  if (nowMs >= b.startsAt) return closed("LOCKED", "OWN_START");
  return { state: "OPEN", mode: "FALLBACK", reason: null, locksAt: b.startsAt };
}

/**
 * Should the arena stamp this battle's window closed NOW? True for a prepared, unstamped battle whose window is closed by the
 * rules above (for any reason but being voided — the database stamps a void itself).
 */
export function lockDue(b: WindowBattle, pred: WindowPredecessor | null, nowMs: number): PicksLockReason | null {
  if (b.status !== "SIMULATED" || b.picksLockedAt !== null) return null;
  const w = picksWindow(b, pred, nowMs);
  return w.state === "LOCKED" ? w.reason : null;
}

/**
 * The instant to record as the close moment: the DECIDING instant (the predecessor's persisted `combatEndsAt`, the battle's own
 * start), not whenever the arena happened to get round to writing the stamp — so every writer (the arena's lock step, a
 * settlement, a test) stamps the same value, and a late advance can never make a window look longer than it was.
 */
export function lockMoment(reason: PicksLockReason, b: WindowBattle, pred: WindowPredecessor | null, nowMs: number): number {
  if (reason === "OWN_START") return Math.min(b.startsAt, nowMs);
  if (reason === "PREDECESSOR_DECIDED" && pred !== null && pred.combatEndsAt !== null) return Math.min(pred.combatEndsAt, nowMs);
  return nowMs;
}
