/**
 * Arena transition telemetry — what a viewer actually experienced at each battle boundary.
 *
 * The question it answers: "when the previous battle's results ended, how late did THIS viewer see the new eight, and
 * how much of the opening (intro → 3 · 2 · 1 → first combat frame) did they miss?" Every time is on the SYNCED server
 * clock (client clock + estimated offset), so a viewer whose laptop clock is wrong is not blamed for it.
 *
 * Two kinds of lateness are kept apart on purpose:
 *   · a viewer who was WATCHING (tab visible the whole time) — a late opening here is a real bug;
 *   · a viewer whose tab was hidden / throttled across the boundary — the browser froze the page's timers, nothing the
 *     app can undo; it must resync to the live battle (never rewind it) and that is recorded, not counted as lag.
 *
 * Pure bookkeeping: no network, no secrets, bounded memory. Exposed on `window.__clankArena` for QA and tests.
 */
export type TelemetryKind = "state" | "roster" | "countdown" | "combat" | "visibility";

export interface TelemetryEvent {
  kind: TelemetryKind;
  /** Client wall clock (Date.now) when it was recorded. */
  clientAt: number;
  /** Synced server clock at the same instant. */
  serverAt: number;
  battleId: string | null;
  /** state: the server's own stamp of the snapshot; countdown: 3 | 2 | 1; combat: authoritative ms since combat start. */
  value?: number;
  /** state: the snapshot was a held (boundary) answer. visibility: hidden=true / visible=false. */
  flag?: boolean;
  /** state: round-trip ms. */
  rtt?: number;
  /** state/roster: ms the battle's `startsAt` was before this moment (negative = not started yet). */
  sinceStart?: number;
}

export interface BoundaryReport {
  battleId: string;
  /** The battle's authoritative start (end of the previous results screen). */
  startsAt: number;
  /** When the snapshot that first contained it reached this client (synced server clock), minus startsAt. */
  stateLateMs: number | null;
  /** When the new eight were first RENDERED, minus startsAt. The number that matters: results → roster visible. */
  rosterLateMs: number | null;
  countdownLateMs: { 3: number | null; 2: number | null; 1: number | null };
  /** Authoritative combat time at the first combat frame this viewer drew (0 = saw the fight from the beginning). */
  combatMsAtFirstFrame: number | null;
  /** Did this viewer miss any of the opening (joined at or after the countdown ended)? */
  missedOpening: boolean;
  /** The tab was hidden at some point between 2 s before the boundary and the first combat frame. */
  hiddenAcrossBoundary: boolean;
  /** foreground = continuously visible; recovered = hidden/throttled across it. */
  viewer: "foreground" | "recovered";
}

const MAX_EVENTS = 600;
/** Visible this long before the boundary counts as "was watching". */
const WATCH_MARGIN_MS = 2000;

export class ArenaTelemetry {
  readonly events: TelemetryEvent[] = [];
  private starts = new Map<string, number>();

  push(e: Omit<TelemetryEvent, "sinceStart"> & { sinceStart?: number }): void {
    const start = e.battleId ? this.starts.get(e.battleId) : undefined;
    this.events.push(start !== undefined ? { ...e, sinceStart: e.serverAt - start } : e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  /** Tell the telemetry when a battle was meant to start (taken from the state, so it never depends on the client). */
  knowStart(battleId: string, startsAt: number): void {
    this.starts.set(battleId, startsAt);
    if (this.starts.size > 40) this.starts.delete(this.starts.keys().next().value as string);
  }

  reports(): BoundaryReport[] {
    return summarizeBoundaries(this.events, this.starts);
  }

  clear(): void {
    this.events.length = 0;
    this.starts.clear();
  }
}

/** Pure: events + battle start times → one report per battle that this viewer saw begin. */
export function summarizeBoundaries(events: readonly TelemetryEvent[], starts: ReadonlyMap<string, number>): BoundaryReport[] {
  const out: BoundaryReport[] = [];
  const visibility = events.filter((e) => e.kind === "visibility");
  const hiddenBetween = (from: number, to: number): boolean => {
    // The tab was hidden at `from`, or became hidden at any time up to `to`.
    let hidden = false;
    for (const v of visibility) {
      if (v.serverAt <= from) hidden = Boolean(v.flag);
      else if (v.serverAt <= to && v.flag) return true;
    }
    return hidden;
  };
  for (const [battleId, startsAt] of starts) {
    const mine = events.filter((e) => e.battleId === battleId);
    const roster = mine.find((e) => e.kind === "roster");
    if (!roster) continue;
    const state = mine.find((e) => e.kind === "state");
    const cd = (n: number) => {
      const e = mine.find((x) => x.kind === "countdown" && x.value === n);
      return e ? e.serverAt - startsAt : null;
    };
    const combat = mine.find((e) => e.kind === "combat");
    const end = combat ? combat.serverAt : roster.serverAt;
    const hiddenAcross = hiddenBetween(startsAt - WATCH_MARGIN_MS, end);
    out.push({
      battleId,
      startsAt,
      stateLateMs: state ? state.serverAt - startsAt : null,
      rosterLateMs: roster.serverAt - startsAt,
      countdownLateMs: { 3: cd(3), 2: cd(2), 1: cd(1) },
      combatMsAtFirstFrame: combat?.value ?? null,
      missedOpening: combat !== undefined && (combat.value ?? 0) > 400,
      hiddenAcrossBoundary: hiddenAcross,
      viewer: hiddenAcross ? "recovered" : "foreground",
    });
  }
  return out.sort((a, b) => a.startsAt - b.startsAt);
}

export const telemetry = new ArenaTelemetry();

declare global {
  interface Window {
    __clankArena?: { telemetry: ArenaTelemetry; reports: () => BoundaryReport[] };
  }
}

/** Expose for QA / tests (idempotent). */
export function exposeTelemetry(): void {
  if (typeof window !== "undefined") window.__clankArena = { telemetry, reports: () => telemetry.reports() };
}
