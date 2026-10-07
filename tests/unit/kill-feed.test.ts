import { describe, expect, it } from "vitest";

import { EliminationLog, EventCursor } from "@/components/arena/eventCursor";
import { simulateBattle } from "@/domain/combat/engine";
import { EV } from "@/domain/combat/types";

import { makeLineup, ruleset, settings } from "../support/fixtures";

type Ev = [number, number, number, number, number, number];
const TICK = 100;
const elim = (tick: number, victim: number, killer: number): Ev => [tick, EV.ELIM, victim, killer, 0, 0];

/** What the arena does per frame: ask the cursor for the due events and feed every ELIM through the log. */
function playFeed(events: Ev[], clockMs: number[], battleId = "b1"): string[] {
  const cursor = new EventCursor();
  const log = new EliminationLog();
  const lines: string[] = [];
  for (const t of clockMs) {
    for (const ev of cursor.take(events, TICK, t)) {
      if (ev[1] !== EV.ELIM) continue;
      const id = log.first(battleId, ev[2]);
      if (id !== null) lines.push(id);
    }
  }
  return lines;
}

describe("the kill feed shows each elimination exactly once", () => {
  const events: Ev[] = [elim(30, 2, 0), elim(31, 5, 0), elim(80, 3, 1), elim(81, 4, 1)];

  it("plays each event once on a normal forward clock", () => {
    const clock = Array.from({ length: 600 }, (_, i) => i * 16);
    const lines = playFeed(events, clock);
    expect(lines).toEqual(["b1:2", "b1:5", "b1:3", "b1:4"]);
  });

  it("does not repeat anything when the estimated server clock steps BACKWARD between frames", () => {
    // The offset estimate is refined by every poll, so combat time can dip a few ms — even after eliminations were shown.
    const forward = Array.from({ length: 600 }, (_, i) => i * 16);
    const jittery = forward.flatMap((t, i) => (i > 0 && i % 7 === 0 ? [t, t - 5, t - 40] : [t]));
    const cursor = new EventCursor();
    const shown: number[] = [];
    for (const t of jittery) for (const ev of cursor.take(events, TICK, t)) shown.push(ev[2]);
    expect(shown).toEqual([2, 5, 3, 4]);
    // …and the log would have caught a repeat even if the cursor had re-delivered it.
    expect(playFeed(events, jittery)).toEqual(["b1:2", "b1:5", "b1:3", "b1:4"]);
  });

  it("does not repeat when a replay is re-delivered to the same log (refresh of the data, remounted renderer)", () => {
    const log = new EliminationLog();
    const seen: string[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const cursor = new EventCursor(); // a fresh cursor starts at 0 and re-emits everything…
      for (const ev of cursor.take(events, TICK, 9_000, { gapMs: 1e9 })) {
        const id = log.first("b1", ev[2]);
        if (id) seen.push(id);
      }
    }
    expect(seen).toEqual(["b1:2", "b1:5", "b1:3", "b1:4"]); // …and the log still shows each once
  });

  it("keeps distinct eliminations separate, even when the heroes share a name or die in the same tick", () => {
    const same: Ev[] = [elim(10, 1, 0), elim(10, 2, 0), elim(10, 3, 0)];
    expect(playFeed(same, [0, 16, 32, 1000])).toEqual(["b1:1", "b1:2", "b1:3"]);
    // the same slot in a DIFFERENT battle is a different elimination
    const log = new EliminationLog();
    expect(log.first("b1", 1)).toBe("b1:1");
    expect(log.first("b2", 1)).toBe("b2:1");
    expect(log.first("b1", 1)).toBeNull();
  });

  it("skips (not replays) events from a long sleep, and still never repeats afterwards", () => {
    const cursor = new EventCursor();
    expect(cursor.take(events, TICK, 100).map((e) => e[2])).toEqual([]);
    // the tab slept until 9 s: the two early eliminations are older than the stale window and are skipped
    expect(cursor.take(events, TICK, 9_000).map((e) => e[2])).toEqual([]);
    expect(cursor.take(events, TICK, 9_016)).toEqual([]);
  });

  it("real simulated battles yield one feed line per fallen hero", () => {
    for (const seed of ["kill-feed-1", "kill-feed-2", "kill-feed-3"]) {
      const out = simulateBattle({ seed, ruleset, units: makeLineup("u"), maxCombatMs: settings.arena.maxCombatMs });
      const fallen = out.participants.filter((p) => !p.alive).length;
      const evs = out.events as unknown as Ev[];
      const clock = Array.from({ length: Math.ceil((out.ticks * TICK) / 16) + 30 }, (_, i) => i * 16);
      const jittery = clock.flatMap((t, i) => (i % 11 === 0 && i > 0 ? [t, t - 3] : [t]));
      const lines = playFeed(evs, jittery);
      expect(lines).toHaveLength(fallen);
      expect(new Set(lines).size).toBe(lines.length);
    }
  });
});
