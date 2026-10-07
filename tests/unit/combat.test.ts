import { describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { compareStanding, rankStandings, type Standing } from "@/domain/combat/ranking";
import { EV, FRAME_FLAG, FRAME_STRIDE, type BattleInput } from "@/domain/combat/types";
import { COMBAT_RULES_VERSION, validateRuleset, type Ruleset } from "@/domain/rules";
import { createRng } from "@/domain/util/rng";

import { classIds, makeLineup, makeUnit, ruleset, settings } from "../support/fixtures";

const base = (seed: string, over: Partial<BattleInput> = {}): BattleInput => ({
  seed,
  ruleset,
  units: makeLineup("u"),
  maxCombatMs: settings.arena.maxCombatMs,
  ...over,
});

describe("deterministic, replayable combat", () => {
  it("same snapshot + seed + rules version → byte-identical outcome", () => {
    const a = simulateBattle(base("seed-A", { recordFrames: true }));
    const b = simulateBattle(base("seed-A", { recordFrames: true }));
    expect(b.eventsHash).toBe(a.eventsHash);
    expect(b.events).toEqual(a.events);
    expect(b.frames).toEqual(a.frames);
    expect(b.ranking).toEqual(a.ranking);
    expect(b.participants).toEqual(a.participants);
  });

  it("frames do not influence the simulation (recording is observation only)", () => {
    expect(simulateBattle(base("seed-B", { recordFrames: true })).eventsHash).toBe(simulateBattle(base("seed-B")).eventsHash);
  });

  it("different seeds give different fights; different rules versions change the hash", () => {
    expect(simulateBattle(base("seed-1")).eventsHash).not.toBe(simulateBattle(base("seed-2")).eventsHash);
    const bumped: Ruleset = { ...ruleset, rulesVersion: "9.9.9" };
    expect(simulateBattle(base("seed-1", { ruleset: bumped })).eventsHash).not.toBe(simulateBattle(base("seed-1")).eventsHash);
    expect(simulateBattle(base("seed-1")).rulesVersion).toBe(COMBAT_RULES_VERSION);
  });

  it("reproduces across 40 random lineups (stability regression)", () => {
    for (let i = 0; i < 40; i++) {
      const rng = createRng(`lineup-${i}`);
      const units = Array.from({ length: 8 }, (_, k) => makeUnit(`r${k}`, rng.pick(classIds)));
      const first = simulateBattle({ seed: `s-${i}`, ruleset, units, maxCombatMs: 30_000 });
      const second = simulateBattle({ seed: `s-${i}`, ruleset, units, maxCombatMs: 30_000 });
      expect(second.eventsHash).toBe(first.eventsHash);
    }
  });

  it("POWER (and any extra fields) never influences combat — only stats, class and tactics do", () => {
    const units = makeLineup("p");
    const tainted = units.map((u) => ({ ...u, power: 999_999, rarity: "LEGENDARY" })) as typeof units;
    expect(simulateBattle(base("pw", { units: tainted })).eventsHash).toBe(simulateBattle(base("pw", { units })).eventsHash);
  });

  it("tactics change behaviour", () => {
    const aggressive = makeLineup("t").map((u) => ({ ...u, tactic: "AGGRESSIVE" as const }));
    const defensive = makeLineup("t").map((u) => ({ ...u, tactic: "DEFENSIVE" as const }));
    expect(simulateBattle(base("tac", { units: aggressive })).eventsHash).not.toBe(simulateBattle(base("tac", { units: defensive })).eventsHash);
  });

  it("slots are assigned by the seed, start positions are inside the arena and distinct", () => {
    const out = simulateBattle(base("slots"));
    expect(new Set(out.participants.map((p) => p.slot)).size).toBe(8);
    for (const [x, y] of out.startPositions) expect(Math.sqrt(x * x + y * y)).toBeLessThanOrEqual(settings.combat.arenaRadius);
    expect(new Set(out.startPositions.map(([x, y]) => `${x},${y}`)).size).toBe(8);
    const slotsA = Object.entries(simulateBattle(base("slots-1")).slotOf).map(([id, s]) => `${id}:${s}`).join();
    const slotsB = Object.entries(simulateBattle(base("slots-2")).slotOf).map(([id, s]) => `${id}:${s}`).join();
    expect(slotsA).not.toBe(slotsB);
  });
});

describe("60-second hard maximum (rules 3.0.0) and elimination pressure", () => {
  const CAP = settings.arena.maxCombatMs;
  it("never exceeds the 60 s cap across many battles; normally one hero survives", () => {
    expect(CAP).toBe(60_000);
    let single = 0;
    const N = 120;
    for (let i = 0; i < N; i++) {
      const rng = createRng(`cap-${i}`);
      const units = Array.from({ length: 8 }, (_, k) => makeUnit(`c${k}`, rng.pick(classIds)));
      const out = simulateBattle({ seed: `cap-${i}`, ruleset, units, maxCombatMs: CAP });
      expect(out.durationMs).toBeLessThanOrEqual(CAP);
      expect(out.ticks).toBeLessThanOrEqual(600);
      if (out.participants.filter((p) => p.alive).length === 1) single++;
    }
    expect(single / N).toBeGreaterThan(0.9);
  });

  it("when fighters can't hurt each other, time expires at exactly the 60 s cap", () => {
    const frozen: Ruleset = validateRuleset({
      ...ruleset,
      combat: {
        ...ruleset.combat,
        overtime: { startMs: 0, damageRampPerSec: 0 },
        derive: { ...ruleset.combat.derive, atkPerStr: 0.0001, atkPerInt: 0.0001 },
      },
    });
    const out = simulateBattle(base("timeout", { ruleset: frozen }));
    expect(out.endedBy).toBe("TIME_LIMIT");
    expect(out.durationMs).toBe(CAP);
    expect(out.participants.filter((p) => p.alive).length).toBeGreaterThan(1);
    expect([...out.ranking].sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("respects a shorter configured cap", () => {
    expect(simulateBattle(base("short", { maxCombatMs: 5000 })).durationMs).toBeLessThanOrEqual(5000);
  });
});

describe("tie-breakers are deterministic and centrally defined", () => {
  const s = (over: Partial<Standing>): Standing => ({ slot: 0, alive: true, hp: 100, maxHp: 100, eliminatedAtTick: null, eliminations: 0, damageDealt: 0, damageTaken: 0, ...over });

  it("1. alive beats eliminated", () => {
    expect(compareStanding(s({ slot: 1, hp: 1 }), s({ slot: 0, alive: false, hp: 0, eliminatedAtTick: 299, eliminations: 5 }))).toBeLessThan(0);
  });
  it("2a. among survivors, higher remaining HP percentage wins (exact, not raw HP)", () => {
    const small = s({ slot: 0, hp: 50, maxHp: 100 }); // 50 %
    const big = s({ slot: 1, hp: 60, maxHp: 200 }); //   30 % but more raw HP
    expect(compareStanding(small, big)).toBeLessThan(0);
  });
  it("2b. among eliminated, surviving longer wins", () => {
    expect(compareStanding(s({ slot: 1, alive: false, hp: 0, eliminatedAtTick: 200 }), s({ slot: 0, alive: false, hp: 0, eliminatedAtTick: 100 }))).toBeLessThan(0);
  });
  it("3. then more eliminations, 4. more damage dealt, 5. less damage taken", () => {
    expect(compareStanding(s({ slot: 1, eliminations: 2 }), s({ slot: 0, eliminations: 1 }))).toBeLessThan(0);
    expect(compareStanding(s({ slot: 1, damageDealt: 90 }), s({ slot: 0, damageDealt: 80 }))).toBeLessThan(0);
    expect(compareStanding(s({ slot: 1, damageTaken: 10 }), s({ slot: 0, damageTaken: 20 }))).toBeLessThan(0);
  });
  it("6. a total tie falls back to the seed-assigned starting slot (never random)", () => {
    expect(compareStanding(s({ slot: 3 }), s({ slot: 5 }))).toBeLessThan(0);
    expect(rankStandings([s({ slot: 5 }), s({ slot: 3 }), s({ slot: 4 })])).toEqual([3, 4, 5]);
  });
  it("is a consistent total order (antisymmetric) and stable under input permutation", () => {
    const rng = createRng("order");
    const standings: Standing[] = Array.from({ length: 8 }, (_, slot) => s({
      slot, alive: rng.chance(0.4), hp: rng.range(1, 100), maxHp: 100, eliminatedAtTick: rng.range(10, 290), eliminations: rng.range(0, 3), damageDealt: rng.range(0, 5) * 10, damageTaken: rng.range(0, 5) * 10,
    }));
    for (const a of standings) for (const b of standings) if (a !== b) expect(Math.sign(compareStanding(a, b))).toBe(-Math.sign(compareStanding(b, a)));
    const expected = rankStandings(standings);
    for (let i = 0; i < 20; i++) expect(rankStandings(rng.shuffle(standings))).toEqual(expected);
  });
  it("the engine's placements follow the central ordering", () => {
    const out = simulateBattle(base("rank-check"));
    const standings: Standing[] = out.participants.map((p) => ({ slot: p.slot, alive: p.alive, hp: p.finalHp, maxHp: p.maxHp, eliminatedAtTick: p.eliminatedAtTick, eliminations: p.eliminations, damageDealt: p.damageDealt, damageTaken: p.damageTaken }));
    expect(out.ranking).toEqual(rankStandings(standings));
    out.ranking.forEach((slot, idx) => expect(out.participants[slot]!.placement).toBe(idx + 1));
  });
});

describe("battle integrity & event log", () => {
  const out = simulateBattle(base("integrity", { recordFrames: true }));
  it("records a complete, ordered event log with an ELIM for each fallen hero and a final END", () => {
    const ticks = out.events.map((e) => e[0]);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    const dead = out.participants.filter((p) => !p.alive).length;
    expect(out.events.filter((e) => e[1] === EV.ELIM)).toHaveLength(dead);
    expect(out.events[out.events.length - 1]![1]).toBe(EV.END);
    expect(out.events.some((e) => e[1] === EV.HIT)).toBe(true);
    expect(out.events.some((e) => e[1] === EV.SKILL)).toBe(true);
  });
  it("damage accounting adds up exactly: Σ damage dealt = Σ damage taken (the only damage is one fighter hurting another — there is no zone)", () => {
    const dealt = out.participants.reduce((s, p) => s + p.damageDealt, 0);
    const taken = out.participants.reduce((s, p) => s + p.damageTaken, 0);
    expect(out.events.some((e) => e[1] === EV.HAZARD || e[1] === EV.RING)).toBe(false);
    expect(taken).toBe(dealt);
  });
  it("frames cover every tick for every unit; eliminated units are flagged dead", () => {
    expect(out.frames!.length).toBe((out.ticks + 1) * 8 * FRAME_STRIDE);
    const last = out.ticks * 8 * FRAME_STRIDE;
    out.participants.forEach((p) => {
      const flags = out.frames![last + p.slot * FRAME_STRIDE + 3]!;
      expect(Boolean(flags & FRAME_FLAG.ALIVE)).toBe(p.alive);
    });
  });
  it("placements are a permutation of 1..8 and eliminations equal credited kills", () => {
    expect(out.participants.map((p) => p.placement).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const kills = out.participants.reduce((s, p) => s + p.eliminations, 0);
    expect(kills).toBe(out.events.filter((e) => e[1] === EV.ELIM && e[3] >= 0).length);
  });
  it("rejects invalid lineups", () => {
    expect(() => simulateBattle(base("x", { units: [makeUnit("only", "mage")] }))).toThrow();
    const bogus = { ...makeUnit("a", "mage"), classId: "nonexistent-class" };
    expect(() => simulateBattle(base("x", { units: [bogus, makeUnit("b", "mage")] }))).toThrow(/unknown class/);
  });
});

describe("class combat identities", () => {
  function avgNearestDistance(classId: string, vs: string): number {
    let total = 0;
    let samples = 0;
    for (let i = 0; i < 12; i++) {
      const out = simulateBattle({ seed: `dist-${classId}-${i}`, ruleset, units: [makeUnit("a", classId), makeUnit("b", vs)], maxCombatMs: 12_000, recordFrames: true });
      const slotA = out.slotOf.a!;
      const slotB = out.slotOf.b!;
      for (let t = 20; t < Math.min(out.ticks, 60); t++) {
        const o = t * 2 * FRAME_STRIDE;
        const ax = out.frames![o + slotA * FRAME_STRIDE]!;
        const ay = out.frames![o + slotA * FRAME_STRIDE + 1]!;
        const bx = out.frames![o + slotB * FRAME_STRIDE]!;
        const by = out.frames![o + slotB * FRAME_STRIDE + 1]!;
        total += Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2) / 10;
        samples++;
      }
    }
    return total / samples;
  }

  it("Ranger keeps its distance while a Warrior closes in", () => {
    // Ranged units hold a standoff range (and back away when pressed); melee mirrors hug each other. Plant-to-fire makes
    // every shot cost a moment of standing still, so the margin is real but not enormous (≈ +15 over a melee mirror).
    expect(avgNearestDistance("ranger", "warrior")).toBeGreaterThan(avgNearestDistance("warrior", "warrior") + 10);
  });

  function skillsUsed(classId: string, lineup = classIds): Record<string, number> {
    const used: Record<string, number> = {};
    for (let i = 0; i < 25; i++) {
      const units = lineup.map((c, k) => makeUnit(`k${k}`, c));
      const out = simulateBattle({ seed: `skills-${i}`, ruleset, units: [...units, makeUnit("extra1", classId), makeUnit("extra2", classId)], maxCombatMs: 30_000 });
      for (const e of out.events) {
        if (e[1] !== EV.SKILL) continue;
        const actor = out.participants[e[2]]!;
        const unitClass = [...units, makeUnit("extra1", classId), makeUnit("extra2", classId)].find((u) => u.characterId === actor.characterId)!.classId;
        if (unitClass === classId) used[out.skillIds[e[4]]!] = (used[out.skillIds[e[4]]!] ?? 0) + 1;
      }
    }
    return used;
  }

  it.each(Object.keys(ruleset.classes))("%s actually uses its class abilities", (classId) => {
    const used = skillsUsed(classId);
    const expected = ruleset.classes[classId]!.skills;
    expect(Object.keys(used).length).toBeGreaterThan(0);
    // The signature skill (first listed) must fire regularly.
    expect(used[expected[0]!] ?? 0).toBeGreaterThan(10);
  });

  it("defensive classes use defensive skills when hurt (Tank guard, Cleric sanctuary)", () => {
    expect(skillsUsed("tank").guard ?? 0).toBeGreaterThan(5);
    expect(skillsUsed("cleric").sanctuary ?? 0).toBeGreaterThan(5);
  });
});

describe("balance guard-rails (not exact — wide bands that catch regressions)", () => {
  it("L1 mixed lineups: fights hit the longer-fight target (rules 3.0.0) and no class is degenerate", () => {
    const N = 300;
    const wins: Record<string, number> = {};
    const seen: Record<string, number> = {};
    const durations: number[] = [];
    for (let b = 0; b < N; b++) {
      const rng = createRng(`bal-${b}`);
      const units = Array.from({ length: 8 }, (_, i) => makeUnit(`b${i}`, rng.pick(classIds), "BALANCED", `${b}-${i}`));
      const out = simulateBattle({ seed: `bal-seed-${b}`, ruleset, units, maxCombatMs: settings.arena.maxCombatMs });
      durations.push(out.durationMs);
      for (const p of out.participants) {
        const cls = units.find((u) => u.characterId === p.characterId)!.classId;
        seen[cls] = (seen[cls] ?? 0) + 1;
        if (p.placement === 1) wins[cls] = (wins[cls] ?? 0) + 1;
      }
    }
    durations.sort((a, b) => a - b);
    expect(durations[Math.floor(N / 2)]!).toBeGreaterThan(33_000); // target median 35–45 s (measured 37.4 s at 20,000 battles)
    expect(durations[Math.floor(N / 2)]!).toBeLessThan(45_000);
    expect(durations[Math.floor(N * 0.95)]!).toBeLessThanOrEqual(60_000);
    for (const c of classIds) {
      const rate = (wins[c] ?? 0) / seen[c]!;
      expect(rate, `${c} win rate ${rate.toFixed(3)}`).toBeGreaterThan(0.04);
      expect(rate, `${c} win rate ${rate.toFixed(3)}`).toBeLessThan(0.25);
    }
  });
});
