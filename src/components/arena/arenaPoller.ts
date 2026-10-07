/**
 * THE VIEWER'S POLL LOOP, as a small state machine with no React and no browser in it (so it is tested with a fake clock).
 *
 * What it guarantees — for ONE browser tab:
 *   · NEVER two requests at once. One loop, one timer, one request in flight. The next poll is scheduled only after the current one has settled.
 *   · Events that mean "look now" (tab visible again, browser Back / bfcache restore, network back, window focus) all call `trigger()`. They typically
 *     arrive together (visibilitychange + pageshow + focus within a few ms): ONE fresh request serves the whole burst.
 *   · A trigger that finds a request in flight which started before the burst window (a frozen tab's stale request) replaces it with ONE fresh request
 *     (the stale one is aborted and its answer discarded); it never runs next to it.
 *   · A failed request (network error, 503, 504, a timeout) backs off exponentially — 2 s, 4 s, 8 s … capped at 30 s — with ±25 % jitter so thousands of viewers do not
 *     come back in lock-step after an outage, and honouring a `Retry-After` the server sent. Triggers cannot defeat the backoff: while the server is failing a
 *     trigger probes at most once per FAILURE_COOLDOWN_MS.
 *   · The first successful answer resets the backoff and the status goes straight back to "live".
 */

/** live = the last answer arrived · syncing = a fresh look is in flight after a restore · reconnecting = the last request failed */
export type Connection = "live" | "syncing" | "reconnecting";

export interface PollResult {
  ok: boolean;
  /** A `Retry-After` the server sent, in ms (a floor for the next delay). */
  retryAfterMs?: number;
}

export type TriggerReason = "visible" | "pageshow" | "online" | "focus" | "manual";

export interface PollerEnv {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  random(): number;
}

export interface PollerHooks {
  /** One authoritative read. Must apply its result only if `signal` has not been aborted (a superseded answer is stale). Never rejects: failures are `{ ok: false }`. */
  fetchOnce(holdUntil: number | null, signal: AbortSignal): Promise<PollResult>;
  /** After a SUCCESS: when to look again (boundary-aware — see planNextPoll) and whether the next request asks to be held until a boundary. */
  planAfterSuccess(heldFor: number | null): { delayMs: number; holdUntil: number | null };
  onConnection?(connection: Connection): void;
}

export interface PollerConfig {
  /** Triggers within this long of a request START are already covered by it. */
  burstMs: number;
  /** While failing, a trigger may start a request only if the last start is at least this old. */
  failureCooldownMs: number;
  backoffBaseMs: number;
  backoffCapMs: number;
}

export const POLLER_DEFAULTS: PollerConfig = { burstMs: 750, failureCooldownMs: 2000, backoffBaseMs: 2000, backoffCapMs: 30_000 };

/** The delay before retrying after the `failures`-th consecutive failure (1 → base, 2 → 2×base …), jittered ±25 %, never below a server-sent Retry-After (capped at 60 s). */
export function backoffDelayMs(failures: number, random: number, retryAfterMs = 0, config: Pick<PollerConfig, "backoffBaseMs" | "backoffCapMs"> = POLLER_DEFAULTS): number {
  const base = Math.min(config.backoffCapMs, config.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  const jittered = Math.round(base * (0.75 + Math.min(1, Math.max(0, random)) * 0.5));
  return Math.max(jittered, Math.min(Math.max(0, retryAfterMs), 60_000));
}

/** Parses a `Retry-After` header (delta-seconds or an HTTP date) to ms; undefined if absent or unusable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export class ArenaPoller {
  private timer: unknown = null;
  private inFlight: { id: number; controller: AbortController } | null = null;
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private failures = 0;
  private pendingHold: number | null = null;
  private heldFor: number | null = null;
  private running = false;
  private seq = 0;
  private connection: Connection = "live";
  /** Counters for tests and diagnostics. */
  readonly stats = { requests: 0, failures: 0, aborted: 0, coalesced: 0, /** most requests that were live (started, not aborted, not settled) at the same moment — 1 by design */ maxLive: 0 };
  private live = 0;
  /** What the most recent look-now event was (diagnostics). */
  lastTrigger: TriggerReason | null = null;

  constructor(
    private readonly hooks: PollerHooks,
    private readonly env: PollerEnv,
    private readonly config: PollerConfig = POLLER_DEFAULTS,
  ) {}

  get status(): Connection {
    return this.connection;
  }
  get consecutiveFailures(): number {
    return this.failures;
  }
  get pending(): boolean {
    return this.inFlight !== null;
  }

  /** Begin polling: the first request goes out after `firstDelayMs`. */
  start(firstDelayMs: number): void {
    if (this.running) return;
    this.running = true;
    this.schedule(firstDelayMs);
  }

  stop(): void {
    this.running = false;
    this.cancelTimer();
    if (this.inFlight) this.live--;
    this.inFlight?.controller.abort();
    this.inFlight = null;
  }

  /** "Look now" (tab visible, Back restore, network back, focus, a manual refresh). Coalesces bursts; never overlaps; never beats the failure backoff. */
  trigger(reason: TriggerReason = "manual"): void {
    if (!this.running) return;
    this.lastTrigger = reason;
    const sinceStart = this.env.now() - this.lastStartAt;
    if (sinceStart < this.config.burstMs || (this.failures > 0 && sinceStart < this.config.failureCooldownMs)) {
      this.stats.coalesced++;
      return;
    }
    if (this.inFlight) {
      // Older than the burst window: it began before whatever just happened (a frozen tab, a sleeping laptop). One fresh request replaces it.
      this.stats.aborted++;
      this.inFlight.controller.abort();
      this.inFlight = null;
      this.live--;
    }
    this.cancelTimer();
    this.pendingHold = null;
    void this.run(null, true);
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.cancelTimer();
    if (!this.running) return;
    this.timer = this.env.setTimer(() => {
      this.timer = null;
      const hold = this.pendingHold;
      this.pendingHold = null;
      void this.run(hold, false);
    }, Math.max(0, delayMs));
  }

  private setConnection(next: Connection): void {
    if (next === this.connection) return;
    this.connection = next;
    this.hooks.onConnection?.(next);
  }

  private async run(hold: number | null, fromTrigger: boolean): Promise<void> {
    if (!this.running || this.inFlight) return; // a timer that fires next to a request in flight does nothing: requests never overlap
    if (hold !== null) this.heldFor = hold;
    const id = ++this.seq;
    const controller = new AbortController();
    this.inFlight = { id, controller };
    this.lastStartAt = this.env.now();
    this.stats.requests++;
    this.stats.maxLive = Math.max(this.stats.maxLive, ++this.live);
    if (fromTrigger && this.failures === 0) this.setConnection("syncing");
    let result: PollResult;
    try {
      result = await this.hooks.fetchOnce(hold, controller.signal);
    } catch {
      result = { ok: false };
    }
    if (!this.running || this.inFlight?.id !== id) return; // superseded by a newer request (this answer is stale) or stopped
    this.inFlight = null;
    this.live--;
    if (result.ok) {
      this.failures = 0;
      this.setConnection("live");
      const plan = this.hooks.planAfterSuccess(this.heldFor);
      this.pendingHold = plan.holdUntil;
      this.schedule(plan.delayMs);
    } else {
      this.failures++;
      this.stats.failures++;
      this.setConnection("reconnecting");
      this.pendingHold = null;
      this.schedule(backoffDelayMs(this.failures, this.env.random(), result.retryAfterMs, this.config));
    }
  }
}
