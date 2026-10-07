import { describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { EV, type CombatUnitInput } from "@/domain/combat/types";
import { COMBAT_RULES_VERSION, hashRuleset, validateRuleset } from "@/domain/rules";
import { combatSettingsSchema, DEFAULT_SETTINGS } from "@/domain/settings";

import { runBalanceSim } from "../../scripts/lib/balanceSim";
import { makeLineup, makeUnit, ruleset } from "../support/fixtures";
import { rules200Ruleset } from "../support/rules200";

/**
 * Rules 3.0.0: LONGER FIGHTS. Median 35–45 s, hard cap 60 s — reached by a global `combat.pace` plus a modest retune, NOT by
 * changing 30 → 60. These tests pin the outcome (duration distribution, timeouts, class balance), the exactness of the no-op
 * default that keeps every older ruleset replaying bit for bit, and the hard cap.
 */
const CAP = DEFAULT_SETTINGS.arena.maxCombatMs;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
/** Near-unkillable copy of a fighter: lets two of them run the clock to the cap. */
const sturdy = (u: CombatUnitInput): CombatUnitInput => ({ ...u, stats: { ...u.stats, hp: u.stats.hp * 400, def: u.stats.def * 40 } });

describe("rules 3.0.0 defaults", () => {
  it("ship the longer-fight tuning: version 3.0.0, 60 s hard cap, pace, no shrinking ring", () => {
    expect(COMBAT_RULES_VERSION).toBe("3.0.0");
    expect(ruleset.rulesVersion).toBe("3.0.0");
    expect(CAP).toBe(60_000);
    expect(DEFAULT_SETTINGS.combat.pace).toEqual({ time: 1.95, move: 1.1 });
    expect(DEFAULT_SETTINGS.combat).not.toHaveProperty("ring");
  });

  it("pace is validated: bounded, strict, and optional (an absent pace is the exact 1 / 1 no-op)", () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.combat)) as Record<string, unknown>;
    expect(combatSettingsSchema.safeParse({ ...base, pace: { time: 0.2, move: 1 } }).success).toBe(false);
    expect(combatSettingsSchema.safeParse({ ...base, pace: { time: 5, move: 1 } }).success).toBe(false);
    expect(combatSettingsSchema.safeParse({ ...base, pace: { time: 2, move: 1, extra: 1 } }).success).toBe(false);
    expect(combatSettingsSchema.safeParse({ ...base, pace: { time: 2, move: 1 } }).success).toBe(true);
    const { pace: _pace, ...withoutPace } = base;
    void _pace;
    expect(combatSettingsSchema.parse(withoutPace).pace).toEqual({ time: 1, move: 1 });
  });
});

describe("pace is an exact no-op at 1 / 1 and a real slow-motion above it", () => {
  const stored = rules200Ruleset(ruleset); // the 2.0.0 numbers, pace restored to its 1 / 1 default

  it("an explicit 1 / 1 pace and an absent pace are the same ruleset (same content hash) and the same fights", () => {
    const explicit = validateRuleset({ ...stored, combat: { ...stored.combat, pace: { time: 1, move: 1 } } });
    expect(hashRuleset(explicit)).toBe(hashRuleset(stored));
    for (let i = 0; i < 6; i++) {
      const units = makeLineup(`np${i}`);
      expect(simulateBattle({ seed: `np-${i}`, ruleset: explicit, units, maxCombatMs: 30_000 }).eventsHash).toBe(
        simulateBattle({ seed: `np-${i}`, ruleset: stored, units, maxCombatMs: 30_000 }).eventsHash,
      );
    }
  });

  it("pace.time stretches every fight: the same lineups last clearly longer with time 2 than with time 1", () => {
    const slow = validateRuleset({ ...stored, combat: { ...stored.combat, pace: { time: 2, move: 1 } } });
    const fast: number[] = [], long: number[] = [];
    for (let i = 0; i < 40; i++) {
      const units = makeLineup(`st${i}`);
      fast.push(simulateBattle({ seed: `st-${i}`, ruleset: stored, units, maxCombatMs: 120_000 }).durationMs);
      long.push(simulateBattle({ seed: `st-${i}`, ruleset: slow, units, maxCombatMs: 120_000 }).durationMs);
    }
    // not a clean 2×: the overtime damage ramp is wall-clock (deliberately not paced), so slower fights are cut short by it — the 3.0.0 defaults move overtime later for exactly that reason
    expect(median(long)).toBeGreaterThan(median(fast) * 1.2);
    expect(median(long)).toBeLessThan(median(fast) * 2.6);
  });
});

describe("the 3.0.0 fight-length distribution (1,000 seeded battles, random lineups, the shipped defaults)", () => {
  const sim = runBalanceSim({ battles: 1000, maxCombatMs: CAP, ruleset });

  it("median 35–45 s, p95 under the cap, nothing longer than 60 s, and no 10-second fights any more", () => {
    expect(sim.rulesVersion).toBe("3.0.0");
    expect(sim.duration.median).toBeGreaterThanOrEqual(35);
    expect(sim.duration.median).toBeLessThanOrEqual(42); // measured 37.4 at 20,000 battles
    expect(sim.duration.p95).toBeLessThan(58);
    expect(sim.duration.max).toBeLessThanOrEqual(60);
    expect(sim.duration.p10).toBeGreaterThanOrEqual(22); // measured 27.7: fast fights still happen organically, but not instant ones
  });

  it("most fights finish in the 25–55 s window, and few reach the 60 s cap (fewer than under 2.0.0's 6 % at 30 s)", () => {
    const inWindow = sim.histogram["25-35s"]! + sim.histogram["35-45s"]! + sim.histogram["45-55s"]!;
    expect(inWindow).toBeGreaterThanOrEqual(85); // measured 90.7 at 20,000
    expect(sim.timeoutPct).toBeLessThanOrEqual(5.5); // measured 3.1
    expect(sim.singleSurvivorPct).toBeGreaterThanOrEqual(94);
  });

  it("no class dominates and none is erased (win rate per class stays in a sane band; 6 classes, 8 per fight)", () => {
    const wins = Object.values(sim.classes).map((c) => c.winPct);
    expect(Math.min(...wins)).toBeGreaterThanOrEqual(6); // measured 8.9–16.3 at 20,000 (2.0.0: 9.0–17.1)
    expect(Math.max(...wins)).toBeLessThanOrEqual(21);
    // the historical ordering is preserved at the extremes: Tank and Rogue stay in the bottom half, Warrior/Mage in the top half
    const ranked = Object.entries(sim.classes).sort((a, b) => b[1].winPct - a[1].winPct).map(([c]) => c);
    expect(ranked.slice(0, 3)).toEqual(expect.arrayContaining(["warrior"]));
    expect(ranked.slice(3)).toEqual(expect.arrayContaining(["tank"]));
  });

  it("fights are not dead air: damage lands every few seconds and no fight goes quiet for long", () => {
    expect(sim.pacing.hitsPerSecondMedian).toBeGreaterThanOrEqual(2.5); // measured 3.0 (2.0.0: 5.1)
    expect(sim.pacing.longestQuietMedianS).toBeLessThanOrEqual(3); // measured 1.9
    expect(sim.pacing.longestQuietP95S).toBeLessThanOrEqual(12); // measured 8.9
  });
});

describe("hard cap and early finish", () => {
  it("two near-unkillable tanks run the clock to EXACTLY the 60 s cap and the deterministic time-limit rules decide", () => {
    const a = simulateBattle({ seed: "cap60", ruleset, units: [sturdy(makeUnit("a", "tank")), sturdy(makeUnit("b", "tank"))], maxCombatMs: CAP });
    expect(a.endedBy).toBe("TIME_LIMIT");
    expect(a.durationMs).toBe(60_000);
    const b = simulateBattle({ seed: "cap60", ruleset, units: [sturdy(makeUnit("a", "tank")), sturdy(makeUnit("b", "tank"))], maxCombatMs: CAP });
    expect(b.eventsHash).toBe(a.eventsHash); // deterministic result at the cap
    expect(a.ranking.length).toBe(2);
  });

  it("no battle ever runs past the cap, and a fight with one survivor ends at once (it is never padded to the cap)", () => {
    let early = 0;
    for (let i = 0; i < 120; i++) {
      const out = simulateBattle({ seed: `end-${i}`, ruleset, units: makeLineup(`e${i}`), maxCombatMs: CAP });
      expect(out.durationMs).toBeLessThanOrEqual(CAP);
      if (out.endedBy === "LAST_STANDING") {
        const lastKill = Math.max(...out.events.filter((e) => e[1] === EV.ELIM).map((e) => e[0]));
        expect(out.durationMs).toBeLessThanOrEqual((lastKill + 1) * out.tickMs); // ends on the tick of the final elimination
        if (out.durationMs < 40_000) early++;
      }
    }
    expect(early).toBeGreaterThan(20); // a decisive fight that ends at, say, 34 s really does end at 34 s
  });

  it("a battle stored under a 30 s cap keeps that cap (the cap travels with the battle, not with today's settings)", () => {
    const stored = rules200Ruleset(ruleset);
    const out = simulateBattle({ seed: "cap30-stored", ruleset: stored, units: [sturdy(makeUnit("a", "tank")), sturdy(makeUnit("b", "tank"))], maxCombatMs: 30_000 });
    expect(out.endedBy).toBe("TIME_LIMIT");
    expect(out.durationMs).toBe(30_000);
    expect(out.rulesVersion).toBe("2.0.0");
  });
});
