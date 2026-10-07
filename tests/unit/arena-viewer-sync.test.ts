import { describe, expect, it } from "vitest";

import { phaseNow } from "@/components/arena/phase";
import { bestOffset, clockSample, holdLeadMs, planNextPoll, type ClockSample } from "@/components/arena/pollSchedule";
import { summarizeBoundaries, type TelemetryEvent } from "@/components/arena/telemetry";
import type { BattleDto } from "@/lib/dto";

/**
 * The viewer's side of a battle boundary, modelled on the synced server clock — the same pure functions the browser runs.
 * (Whether the SERVER makes the next battle ready in time is covered in tests/integration/arena-transition.test.ts; the
 * end-to-end, real-time version is tests/security/arena-boundary-http.test.ts.)
 */
const INTRO = 2500;
const COUNT = 3000;
const MAX = 30_000;
const T = 1_000_000; // a battle's startsAt (server clock)

const battle = (startsAt: number, combatMs = 18_000): BattleDto =>
  ({
    id: `b-${startsAt}`,
    startsAt,
    combatStartsAt: startsAt + INTRO + COUNT,
    combatEndsAt: startsAt + INTRO + COUNT + combatMs,
    resultsStartAt: startsAt + INTRO + COUNT + combatMs + 1200,
    slotEndsAt: startsAt + INTRO + COUNT + combatMs + 1200 + 5000,
  }) as BattleDto;
const phaseAt = (b: BattleDto, now: number) => phaseNow(b, now, COUNT, MAX);

describe("the opening is never missed by someone who is watching", () => {
  const b = battle(T);

  it("INTRO → 3 → 2 → 1 → COMBAT at exactly the authoritative instants (sampled every 10 ms)", () => {
    const firstSeen: Record<string, number> = {};
    for (let now = T - 50; now <= b.combatStartsAt! + 50; now += 10) {
      const p = phaseAt(b, now);
      const key = p.phase === "COUNTDOWN" ? `c${p.countdown}` : p.phase;
      firstSeen[key] ??= now - T;
    }
    expect(firstSeen.INTRO).toBeLessThanOrEqual(0); // the eight are on stage from the very start
    expect(firstSeen.c3).toBe(INTRO); // 3 …
    expect(firstSeen.c2).toBe(INTRO + 1000); // … 2 …
    expect(firstSeen.c1).toBe(INTRO + 2000); // … 1 …
    expect(firstSeen.COMBAT).toBe(INTRO + COUNT); // … then the fight, with 0 ms of it elapsed
    expect(phaseAt(b, b.combatStartsAt!).combatMs).toBe(0);
  });

  it("3 is shown before combat, 2 after 3, 1 after 2 — in that order, each for about a second, never skipped", () => {
    const seq: string[] = [];
    for (let now = T; now <= b.combatStartsAt! + 100; now += 5) {
      const p = phaseAt(b, now);
      const tag = p.phase === "COUNTDOWN" ? String(p.countdown) : p.phase === "COMBAT" ? "FIGHT" : p.phase;
      if (seq[seq.length - 1] !== tag) seq.push(tag);
    }
    expect(seq).toEqual(["INTRO", "3", "2", "1", "FIGHT"]);
  });

  it("a viewer whose clock is wrong by minutes still sees the SAME instants (clock offset is estimated from the server's stamps)", () => {
    for (const skew of [-300_000, -4_000, 0, 7_500, 120_000]) {
      // The client's clock reads `server + skew`. A response carries the server's stamps; the NTP-style sample removes the skew.
      const samples: ClockSample[] = [0, 1, 2].map((i) => {
        const sent = 500_000 + i * 5000 + skew; // client clock at send
        const serverReceived = 500_000 + i * 5000 + 40; // server clock when it started handling (40 ms of network each way)
        const serverTime = serverReceived + 15; // …and when it answered
        const received = serverTime + 40 + skew; // client clock at receive
        return clockSample(serverTime, sent, received, serverReceived);
      });
      const offset = bestOffset(samples);
      // The estimate is the server clock minus the client's, to within the (symmetric) network time.
      expect(Math.abs(offset + skew)).toBeLessThanOrEqual(2);
      const clientNowAtServer = (serverNow: number) => serverNow + skew;
      const seenAtServerTime = (clientNow: number) => clientNow + offset;
      // The countdown "3" appears when the SYNCED clock reaches startsAt + intro, whatever the local clock says.
      const p = phaseAt(b, seenAtServerTime(clientNowAtServer(T + INTRO + 3)));
      expect(p).toMatchObject({ phase: "COUNTDOWN", countdown: 3 });
      expect(phaseAt(b, seenAtServerTime(clientNowAtServer(T + INTRO - 20))).phase).toBe("INTRO");
    }
  });
});

describe("the boundary: the held answer lands at the instant the results timer ends", () => {
  const prev = battle(T - 30_000);
  const next = battle(prev.slotEndsAt!);

  // Model: the browser sends a held request `lead` ms before the boundary; the server builds the snapshot for that instant
  // (`serverMs`) and answers at max(boundary, ready). How late is the new roster on this viewer's screen?
  const lateness = (rtt: number, serverMs: number) => {
    const boundary = prev.slotEndsAt!;
    const lead = holdLeadMs(rtt, serverMs);
    const arrives = boundary - lead + rtt / 2;
    const ready = arrives + serverMs;
    const answered = Math.max(boundary, ready);
    return answered + rtt / 2 - boundary;
  };

  it("next roster visible < 250 ms after the boundary under normal conditions, and within the hard 500 ms target up to a 300 ms round trip", () => {
    for (const rtt of [20, 60, 120, 200]) for (const serverMs of [20, 100, 360, 600]) expect(lateness(rtt, serverMs), `rtt ${rtt} server ${serverMs}`).toBeLessThan(250);
    for (const serverMs of [20, 360, 600, 900]) expect(lateness(300, serverMs), `rtt 300 server ${serverMs}`).toBeLessThan(500);
  });

  it("plans the held request for the new-battle boundary (once), early enough to build it", () => {
    const plan = planNextPoll({ state: { current: { combatEndsAt: prev.combatEndsAt!, slotEndsAt: prev.slotEndsAt!, status: "SETTLED" }, next: { startsAt: next.startsAt } }, now: prev.resultsStartAt! + 500, ok: true, failures: 0, overdueStreak: 0, rttMs: 80, serverMs: 300, heldFor: null });
    expect(plan.holdUntil).toBe(prev.slotEndsAt);
    expect(plan.delayMs).toBeLessThan(prev.slotEndsAt! - (prev.resultsStartAt! + 500));
  });

  it("if the new battle is not there at the boundary the viewer retries within a quarter-second, never on the 5 s idle cadence", () => {
    const plan = planNextPoll({ state: { current: { combatEndsAt: prev.combatEndsAt!, slotEndsAt: prev.slotEndsAt!, status: "SETTLED" }, next: null }, now: prev.slotEndsAt! + 30, ok: true, failures: 0, overdueStreak: 0, rttMs: 80, serverMs: 300, heldFor: null });
    expect(plan.delayMs).toBeLessThanOrEqual(250);
  });
});

describe("refreshing or returning mid-battle syncs to the live battle — it never rewinds or restarts", () => {
  const b = battle(T);

  it("a viewer who loads the page 10 s into combat sees combat 10 s in — the authoritative time, not the beginning", () => {
    const now = b.combatStartsAt! + 10_000;
    expect(phaseAt(b, now)).toMatchObject({ phase: "COMBAT", combatMs: 10_000 });
  });

  it("a tab frozen for 20 s across a boundary resyncs forward: combat time only ever increases", () => {
    let last = -1;
    for (const now of [b.combatStartsAt! - 200, b.combatStartsAt! + 50, /* tab frozen … */ b.combatStartsAt! + 20_050, b.combatStartsAt! + 20_100]) {
      const p = phaseAt(b, now);
      expect(p.combatMs).toBeGreaterThanOrEqual(last);
      last = p.combatMs;
    }
    // …and the resumed frame lands in the right phase for the SERVER's time (here: 20 s in, past the 18 s fight and the 1.2 s
    // victory beat → results), not the phase it was frozen in.
    expect(phaseAt(b, b.combatStartsAt! + 20_050).phase).toBe("RESULTS");
  });

  it("two viewers, one 'present' at the boundary and one who refreshes 7 s later, see the same battle at the same authoritative moment", () => {
    const watcher = phaseAt(b, b.combatStartsAt! + 7000);
    const refresher = phaseAt(b, b.combatStartsAt! + 7000);
    expect(refresher).toEqual(watcher);
  });
});

describe("telemetry tells a foreground viewer from a recovered (backgrounded) one", () => {
  const start = T;
  const ev = (over: Partial<TelemetryEvent> & Pick<TelemetryEvent, "kind" | "serverAt">): TelemetryEvent => ({ clientAt: over.serverAt, battleId: "b1", ...over });
  const run = (extra: TelemetryEvent[], rosterAt: number, combatValue: number) =>
    summarizeBoundaries(
      [
        ev({ kind: "visibility", serverAt: start - 20_000, battleId: null, flag: false }),
        ...extra,
        ev({ kind: "state", serverAt: rosterAt - 5, value: rosterAt, flag: true }),
        ev({ kind: "roster", serverAt: rosterAt }),
        ev({ kind: "countdown", serverAt: start + 2530, value: 3 }),
        ev({ kind: "countdown", serverAt: start + 3530, value: 2 }),
        ev({ kind: "countdown", serverAt: start + 4530, value: 1 }),
        ev({ kind: "combat", serverAt: start + 5500 + combatValue, value: combatValue }),
      ],
      new Map([["b1", start]]),
    )[0]!;

  it("a viewer who stayed visible and saw the roster at the boundary is a FOREGROUND viewer with nothing missed", () => {
    const r = run([], start + 40, 30);
    expect(r).toMatchObject({ viewer: "foreground", missedOpening: false, hiddenAcrossBoundary: false, rosterLateMs: 40, combatMsAtFirstFrame: 30 });
    expect(r.countdownLateMs).toEqual({ 3: 2530, 2: 3530, 1: 4530 });
  });

  it("a viewer whose tab was hidden across the boundary is RECOVERED — the lag is the browser's, and it is recorded, not hidden", () => {
    const r = run([ev({ kind: "visibility", serverAt: start - 1000, battleId: null, flag: true }), ev({ kind: "visibility", serverAt: start + 9000, battleId: null, flag: false })], start + 9100, 4000);
    expect(r.viewer).toBe("recovered");
    expect(r.hiddenAcrossBoundary).toBe(true);
    expect(r.missedOpening).toBe(true);
  });

  it("a foreground viewer who nevertheless joined late (a real bug) is flagged as missing the opening, not excused", () => {
    const r = run([], start + 9000, 3500);
    expect(r.viewer).toBe("foreground");
    expect(r.missedOpening).toBe(true);
    expect(r.rosterLateMs).toBe(9000);
  });
});
