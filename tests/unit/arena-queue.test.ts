import { describe, expect, it } from "vitest";

import { planCycle } from "@/domain/arena/queue";
import { layoutBattle, phaseAt } from "@/domain/arena/timeline";
import { createRng } from "@/domain/util/rng";

import { settings } from "../support/fixtures";

const ids = (n: number, prefix = "h") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const A = settings.arena;

describe("queue / cycle planning fairness", () => {
  it("every eligible hero appears exactly once per cycle; groups are full and duplicate-free", () => {
    for (const n of [8, 9, 15, 16, 17, 23, 24, 100, 257]) {
      const plan = planCycle(ids(n), [], 8, createRng(`cycle-${n}`));
      expect(plan.order).toHaveLength(n);
      expect(new Set(plan.order).size).toBe(n);
      expect(plan.groups.every((g) => g.length === 8 && new Set(g).size === 8)).toBe(true);
      expect(plan.groups.flat().length + plan.carryOut.length).toBe(n);
      expect(plan.carryOut.length).toBe(n % 8);
      const placed = [...plan.groups.flat(), ...plan.carryOut];
      expect(new Set(placed).size).toBe(n);
    }
  });

  it("shuffles securely-seeded: same seed same order, different seed different order", () => {
    const a = planCycle(ids(64), [], 8, createRng("s1")).order;
    expect(planCycle(ids(64), [], 8, createRng("s1")).order).toEqual(a);
    expect(planCycle(ids(64), [], 8, createRng("s2")).order).not.toEqual(a);
    expect(a).not.toEqual(ids(64)); // actually shuffled
  });

  it("never pads an incomplete final group with duplicates: the remainder is carried forward", () => {
    const plan = planCycle(ids(13), [], 8, createRng("x"));
    expect(plan.groups).toHaveLength(1);
    expect(plan.carryOut).toHaveLength(5);
    expect(plan.groups.flat().some((id) => plan.carryOut.includes(id))).toBe(false);
  });

  it("carried heroes open the next cycle and cannot be carried twice in a row", () => {
    let carried: string[] = [];
    const everFought = new Map<string, number>();
    const eligible = ids(13);
    for (let cycle = 0; cycle < 12; cycle++) {
      const plan = planCycle(eligible, carried, 8, createRng(`rolling-${cycle}`));
      // carried heroes occupy the very first slots of the new queue ...
      expect(plan.order.slice(0, carried.length)).toEqual(carried);
      // ... so they fight in the first battle and can never be carried out again.
      for (const id of carried) expect(plan.carryOut).not.toContain(id);
      for (const id of plan.groups.flat()) everFought.set(id, (everFought.get(id) ?? 0) + 1);
      carried = plan.carryOut;
    }
    // Nobody starves: every hero got battles, and the spread stays tight.
    const counts = eligible.map((id) => everFought.get(id) ?? 0);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3);
  });

  it("drops carried heroes that are no longer eligible and ignores duplicates in the carry list", () => {
    const plan = planCycle(ids(16), ["h3", "gone", "h3", "h5"], 8, createRng("c"));
    expect(plan.carriedIn).toEqual(["h3", "h5"]);
    expect(plan.order.slice(0, 2)).toEqual(["h3", "h5"]);
    expect(new Set(plan.order).size).toBe(16);
  });

  it("handles fewer heroes than a group (no battles, all carried) and rejects duplicate ids", () => {
    const plan = planCycle(ids(5), [], 8, createRng("few"));
    expect(plan.groups).toEqual([]);
    expect(plan.carryOut).toHaveLength(5);
    expect(() => planCycle(["a", "a"], [], 8, createRng("dup"))).toThrow();
  });
});

describe("battle timeline", () => {
  const start = 1_000_000;
  const t = layoutBattle(start, 20_000, A);

  it("lays out intro → countdown → combat → victory → 5 s results", () => {
    expect(t.combatStartsAtMs).toBe(start + A.introMs + A.countdownMs);
    expect(t.combatEndsAtMs).toBe(t.combatStartsAtMs + 20_000);
    expect(t.slotEndsAtMs - t.resultsStartAtMs).toBe(5000);
    expect(A.resultsMs).toBe(5000);
    expect(A.maxCombatMs).toBe(60_000);
  });

  it("combat starts IMMEDIATELY when the countdown ends (no extra pre-fight timer)", () => {
    expect(phaseAt(t.combatStartsAtMs - 1, t, A).phase).toBe("COUNTDOWN");
    expect(phaseAt(t.combatStartsAtMs, t, A).phase).toBe("COMBAT");
  });

  it("shows 3, 2, 1 across the countdown and heroes are visible (INTRO) before it", () => {
    expect(phaseAt(start, t, A).phase).toBe("INTRO");
    const cdStart = start + A.introMs;
    expect(phaseAt(cdStart, t, A)).toMatchObject({ phase: "COUNTDOWN", countdown: 3 });
    expect(phaseAt(cdStart + 1000, t, A)).toMatchObject({ phase: "COUNTDOWN", countdown: 2 });
    expect(phaseAt(cdStart + 2000, t, A)).toMatchObject({ phase: "COUNTDOWN", countdown: 1 });
    expect(phaseAt(cdStart + 2999, t, A)).toMatchObject({ phase: "COUNTDOWN", countdown: 1 });
  });

  it("caps combat at the 60 s maximum even if asked for longer", () => {
    const long = layoutBattle(start, 90_000, A);
    expect(long.combatEndsAtMs - long.combatStartsAtMs).toBe(60_000);
  });

  it("results then done", () => {
    expect(phaseAt(t.resultsStartAtMs, t, A).phase).toBe("RESULTS");
    expect(phaseAt(t.slotEndsAtMs, t, A).phase).toBe("DONE");
    expect(phaseAt(t.combatEndsAtMs + 1, t, A).phase).toBe("VICTORY");
  });
});
