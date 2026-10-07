import { describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { EV, EV_FLAG, FRAME_STRIDE, type BattleOutcome, type CombatUnitInput } from "@/domain/combat/types";
import { COMBAT_RULES_VERSION, LEGACY_RING_RULES_VERSION, validateRuleset, type Ruleset } from "@/domain/rules";
import { combatSettingsSchema, DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";
import { createRng } from "@/domain/util/rng";

import { legacyRingRuleset } from "../support/legacyRing";
import { classIds, makeLineup, makeUnit, ruleset } from "../support/fixtures";

/**
 * The Arena has a STATIC boundary (rules 2.0.0). The shrinking storm ring — its zone, its damage, its forced movement toward
 * the centre — is gone from every new battle. These tests pin what replaced it, and that the old rules still replay.
 */
const cs = ruleset.combat;
/** The shipped hard cap (rules 3.0.0: 60 s). Legacy-ring fixtures below keep the 30 s cap their stored battles carried. */
const CAP = DEFAULT_SETTINGS.arena.maxCombatMs;
const maxReach = cs.arenaRadius - cs.unitRadius;

const posOf = (out: BattleOutcome, tick: number, slot: number): [number, number] => {
  const o = (tick * out.participants.length + slot) * FRAME_STRIDE;
  return [out.frames![o]! / 10, out.frames![o + 1]! / 10];
};
const radial = (p: [number, number]) => Math.hypot(p[0], p[1]);
/** Same fighter, near-unkillable: lets a fight run the full 30 s so positions can be studied. */
const sturdy = (u: CombatUnitInput): CombatUnitInput => ({ ...u, stats: { ...u.stats, hp: u.stats.hp * 400, def: u.stats.def * 40 } });

describe("rules 2.0.0+: a static arena", () => {
  it("is the current rules version (3.0.0 keeps the static arena), and the legacy ring is a different, older one", () => {
    expect(COMBAT_RULES_VERSION).toBe("3.0.0");
    expect(LEGACY_RING_RULES_VERSION).toBe("1.0.0");
    expect(ruleset.combat).not.toHaveProperty("ring");
    expect(DEFAULT_SETTINGS.combat).not.toHaveProperty("ring");
  });

  it("never emits a zone event or zone damage: no RING, no HAZARD — Σ dealt = Σ taken, across many lineups", () => {
    for (let i = 0; i < 40; i++) {
      const rng = createRng(`zone-${i}`);
      const units = Array.from({ length: 8 }, (_, k) => makeUnit(`z${k}`, rng.pick(classIds)));
      const out = simulateBattle({ seed: `zone-seed-${i}`, ruleset, units, maxCombatMs: 30_000 });
      expect(out.events.some((e) => e[1] === EV.RING || e[1] === EV.HAZARD)).toBe(false);
      const dealt = out.participants.reduce((s, p) => s + p.damageDealt, 0);
      const taken = out.participants.reduce((s, p) => s + p.damageTaken, 0);
      expect(taken).toBe(dealt);
    }
  });

  it("the playable radius never shrinks: fighters stay inside the SAME fixed boundary from the first tick to the last", () => {
    for (let i = 0; i < 40; i++) {
      const out = simulateBattle({ seed: `bounds-${i}`, ruleset, units: makeLineup(`b${i}-`), maxCombatMs: 30_000, recordFrames: true });
      let outermost = 0;
      for (let t = 0; t <= out.ticks; t++) {
        for (let s = 0; s < 8; s++) {
          const r = radial(posOf(out, t, s));
          outermost = Math.max(outermost, r);
          expect(r, `tick ${t} slot ${s}`).toBeLessThanOrEqual(maxReach + 0.2); // the wall — and nothing smaller than it
        }
      }
      expect(outermost).toBeGreaterThan(150); // the arena really is used
    }
  });

  it("a fighter can still stand and fight at the far edge of the FULL arena in the last seconds (nothing squeezes it inward)", () => {
    // Two ranged fighters that cannot die, 30 s: after the first moments they hold their spacing — no zone ever moves them.
    const out = simulateBattle({ seed: "hold-edge", ruleset, units: [sturdy(makeUnit("a", "ranger")), sturdy(makeUnit("b", "ranger"))], maxCombatMs: 30_000, recordFrames: true });
    expect(out.endedBy).toBe("TIME_LIMIT");
    expect(out.ticks).toBe(300);
    for (let s = 0; s < 2; s++) {
      let moved = 0;
      for (let t = 150; t < 300; t++) {
        const [x0, y0] = posOf(out, t, s);
        const [x1, y1] = posOf(out, t + 1, s);
        moved += Math.hypot(x1 - x0, y1 - y0);
      }
      expect(moved, `slot ${s} drifted ${moved.toFixed(1)} units in the last 15 s`).toBeLessThan(30);
    }
  });

  it("contrast: the legacy rules (1.0.0) DID shrink a zone during the fight — the behaviour that was removed", () => {
    const units = [sturdy(makeUnit("a", "ranger")), sturdy(makeUnit("b", "ranger"))];
    const legacy = simulateBattle({ seed: "hold-edge", ruleset: legacyRingRuleset(ruleset), units, maxCombatMs: 30_000, recordFrames: true });
    const rings = legacy.events.filter((e) => e[1] === EV.RING).map((e) => e[4] / 10);
    expect(rings.length).toBeGreaterThan(5);
    expect(Math.min(...rings)).toBeLessThan(cs.arenaRadius / 2); // it closed in far below the full arena
    expect(simulateBattle({ seed: "hold-edge", ruleset, units, maxCombatMs: 30_000 }).events.some((e) => e[1] === EV.RING)).toBe(false);
  });

  it("no forced movement toward the centre: a fighter that is not chasing or fleeing does not move", () => {
    // Everyone on a long-range class holds position once inside its preferred band; their radius never decays toward 0.
    const out = simulateBattle({ seed: "no-pull", ruleset, units: [sturdy(makeUnit("a", "mage")), sturdy(makeUnit("b", "mage")), sturdy(makeUnit("c", "cleric")), sturdy(makeUnit("d", "ranger"))], maxCombatMs: 30_000, recordFrames: true });
    const mean = (tick: number) => [0, 1, 2, 3].reduce((s, slot) => s + radial(posOf(out, tick, slot)), 0) / 4;
    expect(mean(299)).toBeGreaterThan(mean(150) - 25); // no steady collapse toward the middle
  });
});

describe("combat still works without the ring", () => {
  const duel = (a: string, b: string, seed: string, over: Partial<Ruleset> = {}) => simulateBattle({ seed, ruleset: { ...ruleset, ...over }, units: [makeUnit("a", a), makeUnit("b", b)], maxCombatMs: CAP, recordFrames: true });

  it("ranged attacks still land from a distance (against an opponent that cannot simply run them down)", () => {
    for (const [ranged, min] of [["ranger", 10], ["mage", 5]] as const) {
      let longRangeHits = 0;
      for (let i = 0; i < 12; i++) {
        const out = duel(ranged, "tank", `ranged-${ranged}-${i}`);
        const shooter = out.slotOf.a!;
        const victim = out.slotOf.b!;
        for (const [tick, kind, a, b, , flags] of out.events) {
          if (kind !== EV.HIT || a !== shooter || !(flags & EV_FLAG.BASIC)) continue;
          expect(b).toBe(victim);
          const d = Math.hypot(posOf(out, tick, shooter)[0] - posOf(out, tick, victim)[0], posOf(out, tick, shooter)[1] - posOf(out, tick, victim)[1]);
          if (d > 90) longRangeHits++; // well outside any melee reach
        }
      }
      expect(longRangeHits, `${ranged} hits from beyond 90 units`).toBeGreaterThan(min);
    }
  });

  it("melee can still reach ranged opponents: every ranged class gets caught and hit in melee range", () => {
    for (const ranged of ["mage", "ranger", "cleric"]) {
      let closeHits = 0;
      let warriorWins = 0;
      for (let i = 0; i < 20; i++) {
        const out = duel("warrior", ranged, `reach-${ranged}-${i}`);
        const warrior = out.slotOf.a!;
        const target = out.slotOf.b!;
        for (const [tick, kind, a, , , flags] of out.events) {
          if (kind !== EV.ATTACK || a !== warrior || (flags & EV_FLAG.PROJECTILE)) continue;
          const d = Math.hypot(posOf(out, tick, warrior)[0] - posOf(out, tick, target)[0], posOf(out, tick, warrior)[1] - posOf(out, tick, target)[1]);
          if (d <= ruleset.classes.warrior!.attack.range + 6) closeHits++;
        }
        if (out.participants[warrior]!.placement === 1) warriorWins++;
      }
      expect(closeHits, `${ranged}: melee strikes at striking range`).toBeGreaterThan(20);
      expect(warriorWins, `${ranged}: the warrior wins most duels`).toBeGreaterThanOrEqual(15);
    }
  });

  it("every slow melee class (tank) catches a ranged one against the finite wall — kiting cannot run forever", () => {
    for (const ranged of ["mage", "ranger", "cleric"]) {
      let endedByTime = 0;
      for (let i = 0; i < 20; i++) if (duel("tank", ranged, `wall-${ranged}-${i}`).endedBy === "TIME_LIMIT") endedByTime++;
      expect(endedByTime, `${ranged} kiting a tank to the ${CAP / 1000} s limit`).toBe(0);
    }
  });

  it("plant-to-fire: a ranged fighter does not move on the tick it shoots (kiting costs uptime)", () => {
    let shots = 0;
    for (let i = 0; i < 6; i++) {
      const out = duel("ranger", "warrior", `plant-${i}`);
      const ranger = out.slotOf.a!;
      for (const [tick, kind, a, , , flags] of out.events) {
        if (kind !== EV.ATTACK || a !== ranger || !(flags & EV_FLAG.PROJECTILE) || tick < 2) continue;
        const [x0, y0] = posOf(out, tick - 1, ranger);
        const [x1, y1] = posOf(out, tick, ranger);
        // The only thing that can move a planted shooter is being pushed off another fighter's body.
        if (Math.hypot(x1 - x0, y1 - y0) < 0.35) shots++;
      }
    }
    expect(shots).toBeGreaterThan(8);
  });

  it("is deterministic: same snapshot + seed → the same fight, with or without frames; and the hash changes with the rules version", () => {
    const a = simulateBattle({ seed: "static-det", ruleset, units: makeLineup("d"), maxCombatMs: CAP, recordFrames: true });
    const b = simulateBattle({ seed: "static-det", ruleset, units: makeLineup("d"), maxCombatMs: CAP });
    expect(b.eventsHash).toBe(a.eventsHash);
    expect(b.events).toEqual(a.events);
    expect(a.rulesVersion).toBe("3.0.0");
    expect(simulateBattle({ seed: "static-det", ruleset: { ...ruleset, rulesVersion: "3.0.1" }, units: makeLineup("d"), maxCombatMs: CAP }).eventsHash).not.toBe(a.eventsHash);
  });

  it("the hard maximum is the shipped 60 s cap (rules 3.0.0)", () => {
    const out = simulateBattle({ seed: "cap", ruleset, units: [sturdy(makeUnit("a", "tank")), sturdy(makeUnit("b", "tank"))], maxCombatMs: CAP });
    expect(out.endedBy).toBe("TIME_LIMIT");
    expect(out.durationMs).toBe(60_000);
  });
});

describe("legacy isolation: the retired ring cannot leak into new battles, and old battles still replay", () => {
  const units = () => makeLineup("l");
  const ring = legacyRingRuleset(ruleset).combat.ring!;

  it("a CURRENT-version ruleset that still carries a `ring` field (a stale settings row) ignores it completely", () => {
    const stale: Ruleset = { ...ruleset, combat: { ...ruleset.combat, ring } };
    const clean = simulateBattle({ seed: "iso", ruleset, units: units(), maxCombatMs: 30_000 });
    const withStale = simulateBattle({ seed: "iso", ruleset: stale, units: units(), maxCombatMs: 30_000 });
    expect(withStale.eventsHash).toBe(clean.eventsHash);
    expect(withStale.events.some((e) => e[1] === EV.RING || e[1] === EV.HAZARD)).toBe(false);
  });

  it("a ruleset stored under rules 1.0.0 (ring included) validates and still replays through the legacy path", () => {
    const stored = validateRuleset(JSON.parse(JSON.stringify(legacyRingRuleset(ruleset))));
    expect(stored.combat.ring).toBeDefined();
    const out = simulateBattle({ seed: "legacy-replay", ruleset: stored, units: units(), maxCombatMs: 30_000 });
    expect(out.rulesVersion).toBe("1.0.0");
    expect(out.events.some((e) => e[1] === EV.RING)).toBe(true);
  });

  it("stored or edited combat SETTINGS drop a retired ring, and gain the plant-to-fire default", () => {
    const old = { ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS.combat)) as Record<string, unknown>), ring };
    delete (old as { rangedPlantMs?: unknown }).rangedPlantMs;
    const parsed = parseSettings("combat", old);
    expect(parsed).not.toHaveProperty("ring");
    expect(parsed.rangedPlantMs).toBe(100);
    expect(combatSettingsSchema.parse(old)).not.toHaveProperty("ring");
  });
});

describe("balance guard (the full report is `pnpm balance:sim`)", () => {
  it("over 1,200 random lineups no class is dominant or hopeless, and fights still end by elimination", () => {
    const wins: Record<string, number> = {};
    const seen: Record<string, number> = {};
    let single = 0;
    const N = 1200;
    for (let b = 0; b < N; b++) {
      const rng = createRng(`guard-${b}`);
      const units = Array.from({ length: 8 }, (_, k) => makeUnit(`g${k}-${b}`, rng.pick(classIds), "BALANCED", `${b}-${k}`));
      const out = simulateBattle({ seed: `guard-seed-${b}`, ruleset, units, maxCombatMs: CAP });
      if (out.endedBy === "LAST_STANDING") single++;
      for (const p of out.participants) {
        const cls = units.find((u) => u.characterId === p.characterId)!.classId;
        seen[cls] = (seen[cls] ?? 0) + 1;
        if (p.placement === 1) wins[cls] = (wins[cls] ?? 0) + 1;
      }
    }
    expect(single / N).toBeGreaterThan(0.92); // measured 96.9 % at 60 s (2.0.0: 94 % at 30 s)
    for (const c of classIds) {
      const rate = ((wins[c] ?? 0) / (seen[c] ?? 1)) * 100; // a fair share is 12.5 %
      expect(rate, `${c} win rate ${rate.toFixed(1)} %`).toBeGreaterThan(6);
      expect(rate, `${c} win rate ${rate.toFixed(1)} %`).toBeLessThan(22);
    }
  });
});
