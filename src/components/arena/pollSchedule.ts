/** The slice of the arena state that decides when a viewer should ask the server again. */
export interface PollState {
  current: { combatEndsAt: number | null; slotEndsAt: number | null; status?: "SCHEDULED" | "SIMULATED" | "SETTLED" } | null;
  next: { startsAt: number } | null;
}

export interface PollInput {
  state: PollState | null;
  /** Server-clock "now" (client clock + estimated offset). */
  now: number;
  /** Did the request that produced `state` succeed? */
  ok: boolean;
  /** Consecutive failures so far (capped by the caller). */
  failures: number;
  /** Consecutive responses that still showed a battle whose slot had already ended (the next one hadn't arrived). */
  overdueStreak: number;
  /** Recent round-trip time to the server, ms. */
  rttMs: number;
  /** Typical server processing time of an ordinary (not held) read, ms — how long building a snapshot takes. */
  serverMs?: number;
  /** The boundary a held request has already been sent for — never ask to be held for it twice. */
  heldFor: number | null;
}

export interface PollPlan {
  /** Wait this long, then poll. */
  delayMs: number;
  /** When set, the poll asks the server to hold its answer until this server-clock instant (the new-battle boundary). */
  holdUntil: number | null;
}

/** One round trip, reduced to what matters for clock sync. `offset` = (server clock) − (client clock). */
export interface ClockSample {
  rtt: number;
  offset: number;
  /** Server processing time (finished − started), when the server stamped both. Includes any deliberate hold. */
  serverMs?: number;
}

/**
 * One clock sample. With the server's receive and send stamps this is the NTP exchange — server processing (a held
 * or slow request) cancels out of both the offset and the network round trip. Without them it falls back to
 * Cristian's algorithm, which assumes the server answered instantly.
 */
export function clockSample(serverTime: number, sentAt: number, receivedAt: number, serverReceivedAt?: number): ClockSample {
  if (serverReceivedAt !== undefined && serverReceivedAt <= serverTime) {
    return { rtt: receivedAt - sentAt - (serverTime - serverReceivedAt), offset: (serverReceivedAt - sentAt + (serverTime - receivedAt)) / 2, serverMs: serverTime - serverReceivedAt };
  }
  const rtt = receivedAt - sentAt;
  return { rtt, offset: serverTime + rtt / 2 - receivedAt };
}

/**
 * Typical server processing time of an ordinary read: the MEDIAN of the last three, so one slow outlier (the cold
 * start of a serverless instance, a settlement-heavy moment) cannot stretch every later hold lead to its cap.
 */
export function typicalServerMs(recentDwellMs: readonly number[]): number {
  const last = recentDwellMs.slice(-3);
  if (last.length === 0) return 0;
  const sorted = [...last].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** The lowest-latency sample is the most trustworthy (least room for asymmetric delay). */
export function bestOffset(samples: readonly ClockSample[]): number {
  return samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
}

/** Idle cadence: nothing is about to change. */
export const IDLE_POLL_MS = 5000;
/** The result screen shows "Preparing next battle…" only if the new battle is this late (an outage-class delay). */
export const PREPARING_AFTER_MS = 1200;
/** Retry cadence while the next battle is overdue: fast first, then settling — never the 5 s idle cadence. */
const OVERDUE_BACKOFF_MS = [250, 400, 650, 1000, 1500] as const;

/** How often to look again while the battle's settlement (rewards) has not been written yet. */
export const SETTLEMENT_POLL_MS = 500;

/**
 * How early before the boundary to send the held request: long enough for it to reach the server AND for the server
 * to build the snapshot for that instant (about as long as an ordinary read takes) before the boundary arrives.
 * A slow database or a loaded host lengthens `serverMs`, and the lead grows with it.
 */
export function holdLeadMs(rttMs: number, serverMs = 0): number {
  return Math.min(1400, Math.max(500, Math.round(rttMs / 2 + Math.max(500, serverMs * 1.5 + 250))));
}

/**
 * When to poll next. The decisive moment is the end of the results screen (the slot boundary):
 *   · BEFORE it, send one request timed to arrive just ahead of the boundary, asking the server to answer AT it
 *     (`holdUntil`). The next eight heroes arrive the instant the results timer ends — no second poll, no gap.
 *   · AFTER it, if the previous battle is somehow still what the server shows (a genuine backend delay), retry
 *     quickly with a short backoff instead of waiting out the 5 s idle cadence.
 */
export function planNextPoll({ state: s, now, ok, failures, overdueStreak, rttMs, serverMs = 0, heldFor }: PollInput): PollPlan {
  if (!ok) return { delayMs: Math.min(15000, 1500 * 2 ** failures), holdUntil: null };

  let delay = IDLE_POLL_MS;
  if (s && !s.current) delay = Math.min(delay, 3000); // gathering: heroes can appear any moment
  let boundaryDelay: number | null = null;
  let holdUntil: number | null = null;

  if (s?.current) {
    const c = s.current;
    if (c.combatEndsAt && c.combatEndsAt > now) delay = Math.min(delay, c.combatEndsAt - now + 250); // results rows exist right after settlement
    // Combat is over but the server has not written the settlement yet (a read never waits for it): look again soon so
    // the rewards appear as soon as they exist. Bounded by the slot — once the next battle is on, nobody cares.
    if (c.status === "SIMULATED" && c.combatEndsAt !== null && c.combatEndsAt <= now && (c.slotEndsAt === null || c.slotEndsAt > now)) delay = Math.min(delay, SETTLEMENT_POLL_MS);
    const upcoming = [c.slotEndsAt, s.next?.startsAt].filter((t): t is number => typeof t === "number" && t > now);
    if (upcoming.length > 0) {
      const boundary = Math.min(...upcoming);
      if (heldFor === boundary) {
        boundaryDelay = Math.max(20, boundary - now + 30); // already asked to be held and it did not land: wake just after the boundary
      } else {
        boundaryDelay = Math.max(20, boundary - holdLeadMs(rttMs, serverMs) - now);
        holdUntil = boundary;
      }
    } else if (c.slotEndsAt !== null && c.slotEndsAt <= now) {
      boundaryDelay = OVERDUE_BACKOFF_MS[Math.min(overdueStreak, OVERDUE_BACKOFF_MS.length - 1)] as number;
    }
  } else if (s?.next && s.next.startsAt > now) {
    boundaryDelay = Math.max(20, s.next.startsAt - now + 120);
  }

  delay = Math.max(250, delay);
  if (boundaryDelay !== null && boundaryDelay <= delay) return { delayMs: boundaryDelay, holdUntil };
  return { delayMs: delay, holdUntil: null };
}

/** Back-compat helper for tools that only need the delay. */
export function nextPollDelayMs(input: Omit<PollInput, "overdueStreak" | "rttMs" | "heldFor"> & Partial<Pick<PollInput, "overdueStreak" | "rttMs" | "heldFor">>): number {
  return planNextPoll({ overdueStreak: 0, rttMs: 100, heldFor: null, ...input }).delayMs;
}

/** What the results screen should say about the next battle, from the clock alone. */
export type NextBattleLabel =
  | { kind: "countdown"; seconds: number }
  | { kind: "starting" }
  | { kind: "preparing" };

/**
 * `seconds` is whole seconds REMAINING (rounded up). At zero the new battle should already be arriving, so the
 * label becomes "starting"; only if it is genuinely late (a real backend problem) does it say "preparing".
 */
export function nextBattleLabel(nextStartsAt: number, now: number): NextBattleLabel {
  const left = nextStartsAt - now;
  if (left > 0) return { kind: "countdown", seconds: Math.ceil(left / 1000) };
  return -left > PREPARING_AFTER_MS ? { kind: "preparing" } : { kind: "starting" };
}
