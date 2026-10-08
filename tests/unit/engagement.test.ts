import { describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { EV, EV_FLAG, FRAME_FLAG, FRAME_STRIDE, type BattleOutcome, type CombatUnitInput } from "@/domain/combat/types";
import { createRng } from "@/domain/util/rng";

import { classIds, makeUnit, ruleset } from "../support/fixtures";
import { rules300Ruleset } from "../support/rules300";

/**
 * RULES 3.1.0 — ENGAGEMENT. Fighters commit to their actions and ranged spacing is a discipline, not free damage:
 *   · a ranged fighter never shoots on the run: it plants to aim (WINDUP) and to recover (RECOVER), and moves only when pushed by a body;
 *   · backing away spends retreat stamina — no fighter backs away for longer than `retreatMaxMs` in one go;
 *   · a fighter taunted by a living Tank never backs away from it;
 *   · ranged vs melee duels end (no endless kiting), melee wins most of them and ranged still wins a real share;
 *   · bodies keep their spacing.
 * Rules 3.0.0 (a ruleset without `engagement`) keeps the old behaviour exactly — its frames carry none of the new flags.
 */
const RANGED = ["ranger", "mage", "cleric"];
const MELEE = ["warrior", "rogue", "tank"];
const COMMIT_FLAGS = FRAME_FLAG.WINDUP | FRAME_FLAG.RECOVER | FRAME_FLAG.RETREAT;

interface Run {
  out: BattleOutcome;
  units: CombatUnitInput[];
}

const frameOf = (out: BattleOutcome) => {
  const n = out.participants.length;
  const F = out.frames!;
  const o = (t: number, s: number) => (t * n + s) * FRAME_STRIDE;
  return {
    n,
    x: (t: number, s: number) => F[o(t, s)]!,
    y: (t: number, s: number) => F[o(t, s) + 1]!,
    flags: (t: number, s: number) => F[o(t, s) + 3]!,
    dist: (t: number, a: number, b: number) => Math.hypot(F[o(t, a)]! - F[o(t, b)]!, F[o(t, a) + 1]! - F[o(t, b) + 1]!) / 10,
  };
};

/** 120 free-for-alls (8 random classes) and 120 ranged-vs-melee duels, under the given rules. */
function battles(rs: typeof ruleset): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < 240; i++) {
    const rng = createRng(`eng-${i}`);
    const units = i % 2 === 0
      ? Array.from({ length: 8 }, (_, k) => makeUnit(`f${i}-${k}`, rng.pick(classIds)))
      : [makeUnit(`r${i}`, RANGED[i % 3]!), makeUnit(`m${i}`, MELEE[Math.floor(i / 3) % 3]!)];
    runs.push({ out: simulateBattle({ seed: `eng-${i}`, ruleset: rs, units, maxCombatMs: 60_000, recordFrames: true }), units });
  }
  return runs;
}

const now = battles(ruleset);
const before = battles(rules300Ruleset(ruleset));
const SEP = ruleset.combat.unitRadius * ruleset.combat.engagement!.separation;

describe("a ranged fighter never shoots on the run", () => {
  /** Ranged releases whose shooter had nobody within reach of a body push on the aim and release ticks. */
  const isolatedShots = (runs: Run[]) => {
    let shots = 0;
    let moved = 0;
    for (const { out } of runs) {
      const f = frameOf(out);
      const alone = (t: number, s: number) => {
        for (let o = 0; o < f.n; o++) if (o !== s && f.flags(t, o) & FRAME_FLAG.ALIVE && f.dist(t, s, o) < SEP + 8) return false;
        return true;
      };
      for (const [t, kind, a, , , flags] of out.events) {
        if (kind !== EV.ATTACK || !(flags & EV_FLAG.PROJECTILE) || t < 2) continue;
        if (!alone(t - 2, a) || !alone(t - 1, a) || !alone(t, a)) continue;
        shots++;
        // the aim tick (t-1) and the release tick (t): not a unit of own movement
        if (f.x(t - 1, a) !== f.x(t - 2, a) || f.y(t - 1, a) !== f.y(t - 2, a) || f.x(t, a) !== f.x(t - 1, a) || f.y(t, a) !== f.y(t - 1, a)) moved++;
      }
    }
    return { shots, moved };
  };

  it("rules 3.1.0: every shot is aimed and released standing still (thousands of shots, nobody pushing the shooter)", () => {
    const r = isolatedShots(now);
    expect(r.shots).toBeGreaterThan(1500);
    expect(r.moved).toBe(0);
  });

  it("…which is a real change: under rules 3.0.0 a large share of the same kind of shots were taken while moving", () => {
    const r = isolatedShots(before);
    expect(r.moved / r.shots).toBeGreaterThan(0.1);
  });

  it("the commitment is visible in the replay: the shooter is flagged WINDUP on the tick before every ranged release, RECOVER on the release tick", () => {
    let releases = 0;
    let windup = 0;
    let recover = 0;
    let survivedRelease = 0;
    for (const { out } of now) {
      const f = frameOf(out);
      for (const [t, kind, a, , , flags] of out.events) {
        if (kind !== EV.ATTACK || !(flags & EV_FLAG.PROJECTILE) || t < 1) continue;
        releases++;
        if (f.flags(t - 1, a) & FRAME_FLAG.WINDUP) windup++;
        if (!(f.flags(t, a) & FRAME_FLAG.ALIVE)) survivedRelease--; // shot, then killed on the same tick: a fallen hero carries no state
        else if (f.flags(t, a) & FRAME_FLAG.RECOVER) recover++;
      }
    }
    expect(releases).toBeGreaterThan(2000);
    expect(windup).toBe(releases);
    expect(recover).toBe(releases + survivedRelease);
    expect(-survivedRelease).toBeLessThan(releases * 0.01);
  });

  it("move → stop → aim → shoot → recover → move: EVERY ranged shot (crowded or not) is aimed for ≥ 2 ticks and recovered from standing still — 0 shots on the run", () => {
    const engaged = ruleset.combat.engagement!;
    const step = (out: BattleOutcome, units: CombatUnitInput[], slot: number) => {
      const u = units.find((x) => x.characterId === out.participants[slot]!.characterId)!;
      return ((ruleset.classes[u.classId]!.moveSpeed + u.stats.agi * ruleset.combat.derive.moveSpeedPerAgi) / ruleset.combat.pace.move) * (ruleset.combat.tickMs / 1000);
    };
    let shots = 0;
    let running = 0; // moved ≥ half a walking step in any committed tick
    let nudged = 0; // moved at all (only possible when two committed fighters overlap, or a skill knocks the shooter back)
    for (const { out, units } of now) {
      const f = frameOf(out);
      for (const [t, kind, a, , , flags] of out.events) {
        if (kind !== EV.ATTACK || !(flags & EV_FLAG.PROJECTILE) || !(flags & EV_FLAG.BASIC) || t < 3) continue;
        shots++;
        expect(f.flags(t - 1, a) & FRAME_FLAG.WINDUP).toBeTruthy();
        expect(f.flags(t - 2, a) & FRAME_FLAG.WINDUP).toBeTruthy(); // aimed for at least two ticks
        const committed = [t - 1, t - 2];
        for (let r = t; r <= out.ticks && (r === t || f.flags(r, a) & FRAME_FLAG.RECOVER); r++) committed.push(r);
        let worst = 0;
        for (const k of committed) worst = Math.max(worst, Math.hypot(f.x(k, a) - f.x(k - 1, a), f.y(k, a) - f.y(k - 1, a)) / 10);
        if (worst >= 0.5 * step(out, units, a)) running++;
        else if (worst > 0) nudged++;
      }
    }
    expect(engaged.windupMove.ranged).toBe(0);
    expect(engaged.recoveryMove.ranged).toBe(0);
    expect(shots).toBeGreaterThan(5000);
    expect(running).toBe(0);
    expect(nudged / shots).toBeLessThan(0.01);
  });

  it("a PLANTED fighter holds its ground: a melee fighter walking into an archer that is aiming moves itself, not the archer", () => {
    let contacts = 0;
    for (let i = 0; i < 60; i++) {
      const units = [makeUnit(`r${i}`, RANGED[i % 3]!), makeUnit(`m${i}`, MELEE[i % 3]!)];
      const out = simulateBattle({ seed: `anchor-${i}`, ruleset, units, maxCombatMs: 60_000, recordFrames: true });
      const f = frameOf(out);
      const r = out.slotOf[`r${i}`]!;
      const m = out.slotOf[`m${i}`]!;
      for (let t = 1; t <= out.ticks; t++) {
        const aiming = f.flags(t, r) & FRAME_FLAG.WINDUP && f.flags(t - 1, r) & FRAME_FLAG.WINDUP;
        const meleeMoving = !(f.flags(t, m) & (FRAME_FLAG.WINDUP | FRAME_FLAG.RECOVER | FRAME_FLAG.CASTING | FRAME_FLAG.STUNNED));
        if (!aiming || !meleeMoving || !(f.flags(t, m) & FRAME_FLAG.ALIVE) || f.dist(t, r, m) > SEP + 1) continue;
        contacts++;
        expect([f.x(t, r), f.y(t, r)], `duel ${i} tick ${t}`).toEqual([f.x(t - 1, r), f.y(t - 1, r)]);
      }
    }
    expect(contacts).toBeGreaterThan(50);
  });

  it("rules 3.0.0 replays carry none of the new flags (its frames are exactly as before)", () => {
    for (const { out } of before) {
      const f = frameOf(out);
      for (let t = 0; t <= out.ticks; t++) for (let s = 0; s < f.n; s++) expect(f.flags(t, s) & COMMIT_FLAGS).toBe(0);
    }
  });
});

describe("spacing is a discipline, not free damage", () => {
  it("nobody backs away for longer than the retreat stamina allows in one go (retreatMaxMs × pace)", () => {
    const cap = Math.ceil((ruleset.combat.engagement!.retreatMaxMs * ruleset.combat.pace.time) / ruleset.combat.tickMs);
    let longest = 0;
    let retreatTicks = 0;
    for (const { out } of now) {
      const f = frameOf(out);
      for (let s = 0; s < f.n; s++) {
        let run = 0;
        for (let t = 0; t <= out.ticks; t++) {
          if (f.flags(t, s) & FRAME_FLAG.RETREAT) {
            run++;
            retreatTicks++;
            longest = Math.max(longest, run);
          } else run = 0;
        }
      }
    }
    expect(retreatTicks).toBeGreaterThan(1000); // fighters really do back away…
    expect(longest).toBeLessThanOrEqual(cap); // …but never for longer than their stamina
  });

  it("a fighter taunted by a living Tank never backs away from it", () => {
    let taunted = 0;
    for (let i = 0; i < 90; i++) {
      const units = [makeUnit(`t${i}`, "tank"), makeUnit(`r${i}`, RANGED[i % 3]!)];
      const out = simulateBattle({ seed: `taunt-${i}`, ruleset, units, maxCombatMs: 60_000, recordFrames: true });
      const f = frameOf(out);
      const tank = out.slotOf[`t${i}`]!;
      const other = out.slotOf[`r${i}`]!;
      for (let t = 1; t <= out.ticks; t++) {
        const alive = f.flags(t - 1, tank) & FRAME_FLAG.ALIVE && f.flags(t, tank) & FRAME_FLAG.ALIVE;
        if (!alive || !(f.flags(t - 1, other) & FRAME_FLAG.TAUNTED) || !(f.flags(t, other) & FRAME_FLAG.TAUNTED)) continue;
        taunted++;
        expect(f.flags(t, other) & FRAME_FLAG.RETREAT, `tick ${t}`).toBe(0);
      }
    }
    expect(taunted).toBeGreaterThan(1000);
  });

  it("ranged vs melee duels END (no endless kiting): no timeouts; melee wins most, ranged still wins a real share", () => {
    const duels = now.filter((r) => r.units.length === 2);
    const rangedWins = duels.filter(({ out, units }) => out.ranking[0] === out.slotOf[units[0]!.characterId]).length;
    expect(duels.filter(({ out }) => out.endedBy === "TIME_LIMIT")).toHaveLength(0);
    expect(rangedWins / duels.length).toBeGreaterThan(0.08);
    expect(rangedWins / duels.length).toBeLessThan(0.5);
  });

  it("bodies keep their spacing: living fighters are almost never closer than a body width", () => {
    let pairs = 0;
    let stacked = 0;
    for (const { out } of now) {
      const f = frameOf(out);
      for (let t = 1; t <= out.ticks; t += 2) {
        for (let a = 0; a < f.n; a++) {
          for (let b = a + 1; b < f.n; b++) {
            if (!(f.flags(t, a) & FRAME_FLAG.ALIVE) || !(f.flags(t, b) & FRAME_FLAG.ALIVE)) continue;
            pairs++;
            if (f.dist(t, a, b) < ruleset.combat.unitRadius * 1.2) stacked++;
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(100_000);
    expect(stacked / pairs).toBeLessThan(0.002);
  });
});

describe("matchup fairness mechanics (rules 3.1.0)", () => {
  const duelRuns = (rs: typeof ruleset, a: string, b: string, n: number, salt: string) =>
    Array.from({ length: n }, (_, i) => {
      const units = [makeUnit(`a${i}`, a), makeUnit(`b${i}`, b)];
      return { out: simulateBattle({ seed: `${salt}-${i}`, ruleset: rs, units, maxCombatMs: 60_000, recordFrames: true }), units };
    });

  it("a gap-closer fires at an archer / caster only from INSIDE half its reach — under 3.0.0 it leapt from beyond the archer's whole reach", () => {
    const reachOf = (rs: typeof ruleset, cls: string) => rs.classes[cls]!.attack.range;
    const openerDistances = (rs: typeof ruleset) => {
      const ds: number[] = [];
      for (const [melee, ranged] of [["warrior", "ranger"], ["warrior", "mage"], ["rogue", "cleric"], ["rogue", "ranger"]] as const) {
        for (const { out, units } of duelRuns(rs, melee, ranged, 40, `opener-${melee}-${ranged}`)) {
          const f = frameOf(out);
          const m = out.slotOf[units[0]!.characterId]!;
          const r = out.slotOf[units[1]!.characterId]!;
          for (const e of out.events) {
            if (e[1] !== EV.DASH || e[2] !== m) continue;
            const skillTick = [...out.events].reverse().find((x) => x[1] === EV.SKILL && x[2] === m && x[0] <= e[0])![0];
            ds.push(f.dist(skillTick - 1, m, r) / reachOf(rs, ranged)); // decided on the positions at the start of the tick
          }
        }
      }
      return ds;
    };
    const now = openerDistances(ruleset);
    expect(now.length).toBeGreaterThan(100);
    expect(Math.max(...now)).toBeLessThanOrEqual(ruleset.combat.engagement!.openerReach + 0.02);
    const before = openerDistances(rules300Ruleset(ruleset));
    expect(before.filter((d) => d > 0.9).length).toBeGreaterThan(before.length * 0.3); // 3.0.0: most charges came from the archer's full reach
  });

  it("an AIMED shot is half as easy to dodge: a Rogue slips about half as many arrows as it would without the rule", () => {
    const missRate = (rs: typeof ruleset) => {
      let shots = 0;
      let misses = 0;
      for (const { out, units } of duelRuns(rs, "ranger", "rogue", 120, "aimed")) {
        const ra = out.slotOf[units[0]!.characterId]!;
        for (const e of out.events) {
          if (e[2] !== ra || !(e[5] & EV_FLAG.BASIC)) continue;
          if (e[1] === EV.HIT) shots++;
          if (e[1] === EV.MISS) {
            shots++;
            misses++;
          }
        }
      }
      return misses / shots;
    };
    const withRule = missRate(ruleset);
    const without = missRate({ ...ruleset, combat: { ...ruleset.combat, engagement: { ...ruleset.combat.engagement!, aimedDodge: 1 } } });
    expect(without).toBeGreaterThan(0.1);
    expect(withRule).toBeLessThan(without * 0.7);
    expect(withRule).toBeGreaterThan(without * 0.3);
  });

  it("healing fades in overtime: after 20 s of overtime nobody heals (spells, lifesteal, regeneration) — without the rule they kept healing", () => {
    const cut = ruleset.combat.overtime.startMs + 1000 / ruleset.combat.engagement!.overtimeHealCut;
    const lateHeals = (rs: typeof ruleset) => {
      let heals = 0;
      let regen = 0;
      for (const { out } of [...duelRuns(rs, "tank", "cleric", 40, "otheal"), ...duelRuns(rs, "cleric", "cleric", 40, "otheal2")]) {
        const f = frameOf(out);
        for (const e of out.events) if (e[1] === EV.HEAL && e[0] * out.tickMs >= cut + out.tickMs) heals++;
        // regeneration has no event: any HP rise between two ticks without a heal event
        for (let t = Math.ceil(cut / out.tickMs) + 1; t <= out.ticks; t++) {
          for (let s = 0; s < f.n; s++) {
            const o0 = ((t - 1) * f.n + s) * FRAME_STRIDE + 2;
            const o1 = (t * f.n + s) * FRAME_STRIDE + 2;
            if (out.frames![o1]! > out.frames![o0]! && !out.events.some((e) => e[0] === t && e[1] === EV.HEAL && e[3] === s)) regen++;
          }
        }
      }
      return { heals, regen };
    };
    expect(ruleset.combat.engagement!.overtimeHealCut).toBeGreaterThan(0);
    expect(lateHeals(ruleset)).toEqual({ heals: 0, regen: 0 });
    const without = lateHeals({ ...ruleset, combat: { ...ruleset.combat, engagement: { ...ruleset.combat.engagement!, overtimeHealCut: 0 } } });
    expect(without.heals + without.regen).toBeGreaterThan(0);
  });
});
