import { describe, expect, it } from "vitest";

import { ArenaPoller, backoffDelayMs, POLLER_DEFAULTS, retryAfterMs, type Connection, type PollResult, type PollerEnv } from "@/components/arena/arenaPoller";

/**
 * The viewer's poll loop on a VIRTUAL clock (no browser, no React, no real waiting): one request at a time, one fresh read for a burst of "look now" events,
 * exponential backoff with jitter while the server fails, and an immediate return to normal on the first success.
 */
class Clock implements PollerEnv {
  t = 1_000_000;
  private seq = 0;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  randomValue = 0.5;
  now = () => this.t;
  random = () => this.randomValue;
  setTimer = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, fn });
    return id;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== handle);
  };
  /** A promise that resolves after `ms` of virtual time (a network round trip). */
  sleep = (ms: number) => new Promise<void>((resolve) => this.setTimer(resolve, ms));
  private flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    await this.flush();
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x.id !== next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
      await this.flush();
    }
    this.t = end;
    await this.flush();
  }
  get pendingTimers(): number {
    return this.timers.length;
  }
}

interface Harness {
  clock: Clock;
  poller: ArenaPoller;
  requests: Array<{ at: number; hold: number | null; aborted: () => boolean }>;
  applied: number[];
  statuses: Connection[];
  /** What the next request does: latency, and its outcome. */
  next: { latencyMs: number; result: PollResult };
  live: { now: number; max: number };
}

const harness = (overrides: Partial<{ plan: (heldFor: number | null) => { delayMs: number; holdUntil: number | null }; config: typeof POLLER_DEFAULTS }> = {}): Harness => {
  const clock = new Clock();
  const h = { clock, requests: [], applied: [], statuses: [], next: { latencyMs: 40, result: { ok: true } as PollResult }, live: { now: 0, max: 0 } } as unknown as Harness;
  h.poller = new ArenaPoller(
    {
      fetchOnce: async (hold, signal) => {
        const index = h.requests.length;
        h.requests.push({ at: clock.t, hold, aborted: () => signal.aborted });
        h.live.max = Math.max(h.live.max, ++h.live.now);
        const plan = h.next;
        await clock.sleep(plan.latencyMs);
        h.live.now--;
        if (signal.aborted) return { ok: false }; // superseded: a real fetch applies nothing
        if (plan.result.ok) h.applied.push(index);
        return plan.result;
      },
      planAfterSuccess: overrides.plan ?? (() => ({ delayMs: 5000, holdUntil: null })),
      onConnection: (c) => h.statuses.push(c),
    },
    clock,
    overrides.config ?? POLLER_DEFAULTS,
  );
  return h;
};

describe("one request at a time", () => {
  it("polls on the planned cadence, never overlapping, and schedules the next poll only AFTER the current one has settled", async () => {
    const h = harness();
    h.next.latencyMs = 3000; // a slow answer
    h.poller.start(0);
    await h.clock.advance(60_000);
    expect(h.live.max).toBe(1);
    expect(h.poller.stats.maxLive).toBe(1);
    // 3 s of latency + 5 s plan = one request per 8 s, not one per 5 s: the cadence started when the answer arrived.
    expect(h.requests.map((r) => r.at - h.requests[0]!.at)).toEqual(Array.from({ length: h.requests.length }, (_, i) => i * 8000));
    expect(h.requests.length).toBe(8);
  });

  it("a burst of look-now events (visibilitychange + pageshow + focus + online, all at once) makes exactly ONE request", async () => {
    const h = harness();
    h.poller.start(0);
    await h.clock.advance(100); // first poll done
    const before = h.requests.length;
    await h.clock.advance(20_000); // the tab sat hidden; the 5 s cadence kept (or would keep) going — measure from a quiet point
    const base = h.requests.length;
    h.poller.trigger("visible");
    h.poller.trigger("pageshow");
    h.poller.trigger("focus");
    h.poller.trigger("online");
    await h.clock.advance(60);
    expect(h.requests.length - base).toBe(1);
    expect(h.poller.stats.coalesced).toBe(3);
    expect(before).toBe(1);
    expect(h.live.max).toBe(1);
  });

  it("browser Back restore after a long time away: ONE immediate fresh request, then normal polling resumes only after it completes", async () => {
    const h = harness();
    h.poller.start(0);
    await h.clock.advance(100);
    // simulate a frozen tab: no virtual time passes for the page, then it is restored 10 minutes later
    h.clock.t += 600_000;
    const count = h.requests.length;
    h.poller.trigger("pageshow");
    expect(h.requests.length - count).toBe(1); // immediate, synchronously started
    expect(h.requests.at(-1)!.at).toBe(h.clock.t);
    expect(h.statuses.at(-1)).toBe("syncing");
    await h.clock.advance(41);
    expect(h.statuses.at(-1)).toBe("live");
    await h.clock.advance(4_900);
    expect(h.requests.length - count).toBe(1); // the next poll is a full cadence after the answer, not queued behind the restore
    await h.clock.advance(200);
    expect(h.requests.length - count).toBe(2);
  });

  it("a trigger that finds a STALE request still in flight (started before the burst window) replaces it with ONE fresh request; the stale answer is discarded", async () => {
    const h = harness();
    h.next.latencyMs = 6_000; // a request that hangs across a tab freeze
    h.poller.start(0);
    await h.clock.advance(2_000);
    expect(h.poller.pending).toBe(true);
    h.next.latencyMs = 50;
    h.poller.trigger("visible");
    await h.clock.advance(100);
    expect(h.poller.stats.aborted).toBe(1);
    expect(h.requests[0]!.aborted()).toBe(true);
    expect(h.applied).toEqual([1]); // only the fresh answer was applied
    await h.clock.advance(8_000);
    expect(h.live.max).toBeLessThanOrEqual(2); // the replaced one ends within its own network round trip; the poller itself never had two live
    expect(h.poller.stats.maxLive).toBe(1);
  });

  it("a trigger right after a request started is covered by it (no second request), even while it is still in flight", async () => {
    const h = harness();
    h.next.latencyMs = 500;
    h.poller.start(0);
    await h.clock.advance(100);
    h.poller.trigger("focus");
    await h.clock.advance(1000);
    expect(h.requests.length).toBe(1);
  });

  it("stop() cancels everything: no timer, no request, a late answer is ignored", async () => {
    const h = harness();
    h.next.latencyMs = 1000;
    h.poller.start(0);
    await h.clock.advance(100);
    h.poller.stop();
    await h.clock.advance(60_000);
    expect(h.requests.length).toBe(1);
    expect(h.applied).toEqual([]);
    expect(h.clock.pendingTimers).toBe(0);
    h.poller.trigger("visible");
    expect(h.requests.length).toBe(1);
  });
});

describe("failures back off — there is no retry storm", () => {
  it("the delay doubles from 2 s to a 30 s cap, with ±25 % jitter", () => {
    const at = (n: number, r = 0.5) => backoffDelayMs(n, r);
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => at(n))).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(at(1, 0)).toBe(1500);
    expect(at(1, 1)).toBe(2500);
    expect(at(5, 0)).toBe(22500);
    expect(at(5, 1)).toBe(37500);
    for (const r of [0, 0.25, 0.5, 0.99]) expect(at(3, r)).toBeGreaterThanOrEqual(6000);
  });

  it("a Retry-After from the server is a floor (capped at 60 s); header formats are parsed", () => {
    expect(backoffDelayMs(1, 0.5, 10_000)).toBe(10_000);
    expect(backoffDelayMs(1, 0.5, 600_000)).toBe(60_000);
    expect(backoffDelayMs(3, 0.5, 1_000)).toBe(8_000);
    expect(retryAfterMs("5")).toBe(5000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
    expect(retryAfterMs(new Date(10_000 + 7000).toUTCString(), 10_000)).toBeGreaterThanOrEqual(6000);
  });

  it("503 / 504 / network failures retry on 2 s, 4 s, 8 s, 16 s, 30 s, 30 s … — status 'reconnecting' from the first failure", async () => {
    const h = harness();
    h.next = { latencyMs: 10, result: { ok: false } };
    h.poller.start(0);
    await h.clock.advance(200_000);
    const gaps = h.requests.slice(1).map((r, i) => r.at - h.requests[i]!.at - 10);
    expect(gaps.slice(0, 6)).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
    expect(h.statuses).toEqual(["reconnecting"]);
    expect(h.poller.consecutiveFailures).toBe(h.requests.length);
    expect(h.requests.length).toBeLessThanOrEqual(10); // 200 s of outage → under ten requests, from one viewer
  });

  it("look-now events cannot defeat the backoff: while failing, a trigger probes at most once per 2 s", async () => {
    const h = harness();
    h.next = { latencyMs: 10, result: { ok: false } };
    h.poller.start(0);
    await h.clock.advance(100);
    const base = h.requests.length; // the first request failed at t≈10; its scheduled retry is ~2 s after that
    for (let i = 0; i < 15; i++) {
      h.poller.trigger(i % 2 ? "visible" : "online"); // a user flicking between tabs, a flapping network
      await h.clock.advance(100);
    }
    expect(h.requests.length - base).toBe(0); // inside the 2 s cooldown nothing got through
    expect(h.poller.stats.coalesced).toBe(15);
    await h.clock.advance(1_000); // the SCHEDULED retry happens (once)…
    expect(h.requests.length - base).toBe(1);
    await h.clock.advance(2_100); // …and 2 s after a start, a trigger is allowed to probe
    h.poller.trigger("online");
    await h.clock.advance(50);
    expect(h.requests.length - base).toBe(2);
  });

  it("recovery resets the backoff: the first success returns to 'live' and the planned cadence", async () => {
    const h = harness();
    h.next = { latencyMs: 10, result: { ok: false } };
    h.poller.start(0);
    await h.clock.advance(10_000); // three failures
    expect(h.poller.consecutiveFailures).toBeGreaterThanOrEqual(3);
    h.next = { latencyMs: 10, result: { ok: true } };
    await h.clock.advance(20_000);
    expect(h.poller.consecutiveFailures).toBe(0);
    expect(h.statuses).toEqual(["reconnecting", "live"]);
    const last = h.requests.slice(-3);
    expect(last[2]!.at - last[1]!.at).toBe(5010); // back on the 5 s plan
    // …and a later failure starts again from the SHORT end of the ladder
    const count = h.requests.length;
    h.next = { latencyMs: 10, result: { ok: false } };
    await h.clock.advance(5_100);
    await h.clock.advance(2_100);
    expect(h.requests.length - count).toBe(2);
  });

  it("honours Retry-After from a 503", async () => {
    const h = harness();
    h.next = { latencyMs: 10, result: { ok: false, retryAfterMs: 12_000 } };
    h.poller.start(0);
    await h.clock.advance(30_000);
    expect(h.requests[1]!.at - h.requests[0]!.at).toBeGreaterThanOrEqual(12_000);
  });

  it("a held request (the boundary hold) is passed to the next poll once, and never twice for the same boundary", async () => {
    const holds: Array<number | null> = [];
    let plans = 0;
    const h = harness({
      plan: (heldFor) => {
        holds.push(heldFor);
        return ++plans === 1 ? { delayMs: 1000, holdUntil: 123_456 } : { delayMs: 1000, holdUntil: null };
      },
    });
    h.poller.start(0);
    await h.clock.advance(4_000);
    expect(h.requests.map((r) => r.hold)).toEqual([null, 123_456, null, null]);
    expect(holds.slice(0, 3)).toEqual([null, 123_456, 123_456]); // the poll knows which boundary it already asked for
  });
});

describe("a 30-minute session, with outages and a restless user", () => {
  it("never overlaps, never storms: ≤ 1 request live at once; request volume bounded through three outages and 200 look-now events", async () => {
    const h = harness({ plan: () => ({ delayMs: 2500, holdUntil: null }) });
    h.clock.randomValue = 0.3;
    h.poller.start(0);
    const outages = [
      [120_000, 420_000], // 5 minutes down
      [900_000, 960_000], // 1 minute
      [1_500_000, 1_620_000], // 2 minutes
    ];
    const t0 = h.clock.t;
    let triggers = 0;
    for (let second = 0; second < 1800; second++) {
      const elapsed = h.clock.t - t0;
      const down = outages.some(([from, to]) => elapsed >= from! && elapsed < to!);
      h.next = { latencyMs: down ? 8000 : 60, result: down ? { ok: false } : { ok: true } }; // a down server times out at the client's 8 s deadline
      if (second % 9 === 0 && triggers < 200) {
        h.poller.trigger(second % 2 ? "visible" : "pageshow");
        triggers++;
      }
      await h.clock.advance(1000);
    }
    expect(h.live.max).toBeLessThanOrEqual(2); // the poller itself: 1; a replaced stale request may finish its own round trip
    expect(h.poller.stats.maxLive).toBe(1);
    // During the 8 minutes of outage the viewer made far fewer requests than one per backoff cap (30 s + 8 s latency) plus the 2 s-gated triggers…
    const duringOutage = h.requests.filter((r) => outages.some(([from, to]) => r.at - t0 >= from! && r.at - t0 < to!));
    expect(duringOutage.length).toBeLessThanOrEqual(8 * 60 / 2 + 5); // never faster than one probe per cooldown, even with a trigger every 9 s
    expect(duringOutage.length).toBeLessThanOrEqual(75);
    const healthy = h.requests.length - duringOutage.length;
    expect(healthy).toBeGreaterThan(300);
    expect(healthy).toBeLessThan(900); // ≈ 22 healthy minutes at ~one request per 2.6 s + triggers
    expect(h.statuses.at(-1)).toBe("live");
    expect(h.poller.consecutiveFailures).toBe(0);
  });
});
