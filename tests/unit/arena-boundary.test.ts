import { describe, expect, it } from "vitest";

import { HOLD_MATCH_TOLERANCE_MS, holdDelayMs, isStaleAcrossBoundary, MAX_HOLD_MS, nextBoundaryAfter, stateBoundaries } from "@/domain/arena/boundary";
import { bestOffset, clockSample, holdLeadMs, nextBattleLabel, planNextPoll, PREPARING_AFTER_MS, type PollInput } from "@/components/arena/pollSchedule";

// A battle whose slot runs 1_000_000 → 1_041_700; the next one starts the instant it ends.
const T = 1_041_700;
const state = {
  current: { combatStartsAt: 1_005_500, combatEndsAt: 1_035_500, resultsStartAt: 1_036_700, slotEndsAt: T },
  next: { startsAt: T },
};

describe("state boundaries", () => {
  it("lists every instant the public state changes shape, sorted and de-duplicated", () => {
    expect(stateBoundaries(state)).toEqual([1_005_500, 1_035_500, 1_036_700, T]);
    expect(stateBoundaries({ current: null, next: null })).toEqual([]);
  });

  it("finds the next boundary strictly after an instant", () => {
    expect(nextBoundaryAfter(state, 1_036_700)).toBe(T);
    expect(nextBoundaryAfter(state, T)).toBeNull();
  });

  it("flags a snapshot that predates a boundary which has already passed — the stale read that left viewers on '0 SEC'", () => {
    // Computed 100 ms before the slot ended, served 150 ms after it: wrong, must not be reused.
    expect(isStaleAcrossBoundary(state, T - 100, T + 150)).toBe(true);
    // Computed at/after the boundary, or the boundary has not arrived yet: fine.
    expect(isStaleAcrossBoundary(state, T, T + 150)).toBe(false);
    expect(isStaleAcrossBoundary(state, T - 300, T - 1)).toBe(false);
    expect(isStaleAcrossBoundary(state, T - 100, T)).toBe(true); // the boundary instant itself counts as passed
  });
});

describe("holding a request until the new-battle boundary", () => {
  it("waits exactly until the boundary when asked accurately and in time", () => {
    expect(holdDelayMs(T, state, T - 600)).toBe(600);
    expect(holdDelayMs(T + 90, state, T - 600)).toBe(690); // within the match tolerance
  });

  it("never holds for an arbitrary timestamp, the past, a far future, or garbage", () => {
    expect(holdDelayMs(T - 200_000 + 5000, state, T - 600)).toBe(0); // not a boundary
    expect(holdDelayMs(T + HOLD_MATCH_TOLERANCE_MS + 1, state, T - 600)).toBe(0);
    expect(holdDelayMs(T, state, T + 1)).toBe(0); // already passed
    expect(holdDelayMs(T, state, T - MAX_HOLD_MS - 1)).toBe(0); // too early to park a connection
    expect(holdDelayMs(Number.NaN, state, T - 600)).toBe(0);
    expect(holdDelayMs(Number.POSITIVE_INFINITY, state, T - 600)).toBe(0);
    expect(holdDelayMs(T, { current: null, next: null }, T - 600)).toBe(0);
  });

  it("only the new-battle boundary is holdable — not combat end or the results screen", () => {
    expect(holdDelayMs(1_035_500, state, 1_035_000)).toBe(0);
    expect(holdDelayMs(1_036_700, state, 1_036_000)).toBe(0);
  });
});

const base: PollInput = { state, now: 1_020_000, ok: true, failures: 0, overdueStreak: 0, rttMs: 100, heldFor: null };
const plan = (over: Partial<PollInput>) => planNextPoll({ ...base, ...over });

describe("poll planner — no polling gap at the boundary", () => {
  it("idles at 5 s while nothing is about to change", () => {
    expect(plan({ now: 1_006_000 })).toMatchObject({ delayMs: 5000, holdUntil: null });
  });

  it("times ONE held request to land just before the slot ends, so the next eight arrive the moment it does", () => {
    const p = plan({ now: T - 3000 }); // results screen, 3 s left
    expect(p.holdUntil).toBe(T);
    expect(p.delayMs).toBe(3000 - holdLeadMs(100));
    expect(T - (T - 3000 + p.delayMs)).toBe(holdLeadMs(100)); // fires `lead` before the boundary
  });

  it("fires immediately (still held) when it is already inside the lead window", () => {
    const p = plan({ now: T - 300 });
    expect(p.holdUntil).toBe(T);
    expect(p.delayMs).toBeLessThanOrEqual(25);
  });

  it("starts earlier on a slow connection (lead grows with round-trip time, capped)", () => {
    expect(holdLeadMs(100)).toBe(550);
    expect(holdLeadMs(1000)).toBe(1000);
    expect(holdLeadMs(60_000)).toBe(1400);
    expect(plan({ now: T - 3000, rttMs: 1000 }).delayMs).toBe(2000);
  });

  it("never asks to be held twice for the same boundary; it wakes just after instead", () => {
    const p = plan({ now: T - 200, heldFor: T });
    expect(p.holdUntil).toBeNull();
    expect(p.delayMs).toBe(230);
  });

  it("never falls back to the 5 s idle cadence once the slot has ended: it retries within 1.5 s", () => {
    const overdue = { now: T + 100 };
    const delays = [0, 1, 2, 3, 4, 5, 20].map((overdueStreak) => plan({ ...overdue, overdueStreak }).delayMs);
    expect(delays).toEqual([250, 400, 650, 1000, 1500, 1500, 1500]);
    expect(Math.max(...delays)).toBeLessThan(5000);
  });

  it("backs off exponentially on errors and keeps gathering polls under 3 s", () => {
    expect(plan({ ok: false, failures: 1 }).delayMs).toBe(3000);
    expect(plan({ ok: false, failures: 5 }).delayMs).toBe(15000);
    expect(plan({ state: { current: null, next: null }, now: 5 }).delayMs).toBe(3000);
  });

  it("re-reads after combat ends so the results rows (XP/Gold) show up", () => {
    expect(plan({ now: 1_034_000 }).delayMs).toBe(1_035_500 - 1_034_000 + 250);
  });

  it("starts the held request earlier when the server is slow to build a snapshot (lead grows with its own build time)", () => {
    expect(holdLeadMs(100, 0)).toBe(550);
    expect(holdLeadMs(100, 400)).toBe(900); // rtt/2 + 1.5 × 400 + 250
    expect(holdLeadMs(100, 5000)).toBe(1400); // capped: the server never holds longer than MAX_HOLD_MS
    expect(plan({ now: T - 3000, serverMs: 400 }).delayMs).toBe(3000 - 900);
  });

  describe("settlement is a read the viewer repeats, not something the server makes it wait for", () => {
    const settling = { current: { ...state.current, status: "SIMULATED" as const }, next: state.next };
    const settled = { current: { ...state.current, status: "SETTLED" as const }, next: state.next };

    it("looks again every 500 ms while combat is over but the settlement has not been written", () => {
      expect(plan({ state: settling, now: 1_036_000 })).toMatchObject({ delayMs: 500, holdUntil: null });
      expect(plan({ state: settling, now: 1_040_000 })).toMatchObject({ delayMs: 500 });
    });

    it("does not poll for it once it is written, while combat is still running, or after the slot has ended", () => {
      expect(plan({ state: settled, now: 1_036_000 }).delayMs).toBe(5000);
      expect(plan({ state: settling, now: 1_020_000 }).delayMs).toBe(5000);
      expect(plan({ state: settling, now: T + 100 }).delayMs).toBe(250); // overdue backoff, not the settlement poll
    });

    it("never delays the boundary request: near the end of the slot the held request wins", () => {
      const p = plan({ state: settling, now: T - 600 });
      expect(p.holdUntil).toBe(T);
      expect(p.delayMs).toBeLessThanOrEqual(50);
    });
  });
});

describe("what the results screen says about the next battle", () => {
  it("counts down in whole seconds, rounding up", () => {
    expect(nextBattleLabel(T, T - 4200)).toEqual({ kind: "countdown", seconds: 5 });
    expect(nextBattleLabel(T, T - 1)).toEqual({ kind: "countdown", seconds: 1 });
  });

  it("never sits on '0': at zero it says 'starting', and only says 'preparing' when the backend is genuinely late", () => {
    expect(nextBattleLabel(T, T)).toEqual({ kind: "starting" });
    expect(nextBattleLabel(T, T + PREPARING_AFTER_MS)).toEqual({ kind: "starting" });
    expect(nextBattleLabel(T, T + PREPARING_AFTER_MS + 1)).toEqual({ kind: "preparing" });
  });
});

describe("server/client clock offset", () => {
  /** Simulates a client whose clock is `skew` ms ahead of the server, with the given one-way delays. */
  function measure(skew: number, up: number, down: number, serverNow = 5_000_000) {
    const sentAt = serverNow - up + skew; // client clock when sent
    const serverStamp = serverNow; // server stamps the response when it answers
    const receivedAt = serverNow + down + skew; // client clock when received
    return clockSample(serverStamp, sentAt, receivedAt);
  }

  it("recovers a large skew to within half the round trip", () => {
    for (const skew of [-90_000, -7_000, 0, 3_500, 86_400_000]) {
      const s = measure(skew, 40, 40);
      expect(s.rtt).toBe(80);
      expect(Math.abs(s.offset + skew)).toBeLessThanOrEqual(s.rtt / 2);
    }
  });

  it("trusts the lowest-latency sample, so one slow response cannot throw the clock off", () => {
    const samples = [measure(7_000, 400, 900), measure(7_000, 20, 25), measure(7_000, 150, 600)];
    expect(Math.abs(bestOffset(samples) + 7_000)).toBeLessThanOrEqual(25);
  });

  it("the planner works on SERVER time: a skewed client still wakes at the right server instant", () => {
    const skew = 7_000; // client clock is 7 s ahead
    const offset = bestOffset([measure(skew, 30, 30)]);
    const clientNow = T - 3000 + skew; // 3 s before the boundary, as the server sees it
    const serverNow = clientNow + offset;
    expect(Math.abs(serverNow - (T - 3000))).toBeLessThanOrEqual(30);
    const p = planNextPoll({ ...base, state, now: serverNow, rttMs: 60 });
    expect(p.holdUntil).toBe(T); // the hold target is a SERVER timestamp, immune to client skew
    const wakesAtServerTime = serverNow + p.delayMs;
    expect(Math.abs(wakesAtServerTime - (T - holdLeadMs(60)))).toBeLessThanOrEqual(35);
  });
});
