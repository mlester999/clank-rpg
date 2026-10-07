/**
 * Phase boundaries of the PUBLIC arena state, and the three rules built on them. A state snapshot is a pure
 * function of the server clock, so a snapshot computed BEFORE a boundary is wrong the instant that boundary
 * passes — which is exactly when every viewer asks for the next battle.
 *
 *  1. `isStaleAcrossBoundary`  — never hand out (or keep caching) a snapshot that predates a boundary that has passed.
 *  2. `holdDelayMs`            — a request that arrives a moment BEFORE the new-battle boundary may ask the server
 *                                to hold the response until that instant, so the new roster lands the moment the
 *                                results timer ends without the client polling again. Nothing is published early:
 *                                the server simply answers at the boundary.
 *  3. `nextBoundaryAfter`      — when a cached snapshot must expire.
 */

export interface BoundaryState {
  current: { combatStartsAt: number | null; combatEndsAt: number | null; resultsStartAt: number | null; slotEndsAt: number | null } | null;
  next: { startsAt: number } | null;
}

/** Longest a request may be held. Must stay well under any platform timeout; the client asks for ≤ ~1.4 s. */
export const MAX_HOLD_MS = 1500;
/** A hold target must match a real boundary of the state to within this (clock rounding between viewers). */
export const HOLD_MATCH_TOLERANCE_MS = 150;

/** Every instant at which the public state changes shape (sorted, de-duplicated, nulls dropped). */
export function stateBoundaries(s: BoundaryState): number[] {
  const out: number[] = [];
  if (s.current) {
    for (const t of [s.current.combatStartsAt, s.current.combatEndsAt, s.current.resultsStartAt, s.current.slotEndsAt]) if (t !== null) out.push(t);
  }
  if (s.next) out.push(s.next.startsAt);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The first boundary strictly after `afterMs`, or null. */
export function nextBoundaryAfter(s: BoundaryState, afterMs: number): number | null {
  return stateBoundaries(s).find((t) => t > afterMs) ?? null;
}

/** True when `computedAtMs` is before a boundary that is at or before `nowMs` — the snapshot no longer matches the clock. */
export function isStaleAcrossBoundary(s: BoundaryState, computedAtMs: number, nowMs: number): boolean {
  return stateBoundaries(s).some((t) => t > computedAtMs && t <= nowMs);
}

/**
 * How long the server should wait before answering a request that asked to be held until `requestedUntilMs`
 * (0 = answer immediately). Only the new-battle boundary is holdable, only if the request names it accurately
 * (a client cannot park a connection on an arbitrary timestamp), and never longer than `MAX_HOLD_MS`.
 */
export function holdDelayMs(requestedUntilMs: number, s: BoundaryState, nowMs: number, maxHoldMs = MAX_HOLD_MS): number {
  if (!Number.isFinite(requestedUntilMs)) return 0;
  const wait = requestedUntilMs - nowMs;
  if (wait <= 0 || wait > maxHoldMs) return 0;
  const holdable = [s.next?.startsAt, s.current?.slotEndsAt].filter((t): t is number => typeof t === "number");
  if (!holdable.some((t) => Math.abs(t - requestedUntilMs) <= HOLD_MATCH_TOLERANCE_MS)) return 0;
  return Math.ceil(wait);
}
