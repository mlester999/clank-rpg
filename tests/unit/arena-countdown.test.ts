import { describe, expect, it } from "vitest";

import { ArenaPlayback, stageAt, type spawnState, type StageTiming } from "@/components/arena/playback";
import { simulateBattle } from "@/domain/combat/engine";
import { EV, FRAME_FLAG, FRAME_STRIDE, type BattleOutcome, type CombatUnitInput, type Tactic } from "@/domain/combat/types";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { createRng } from "@/domain/util/rng";
import type { BattleDto, FighterDto, ReplayDto } from "@/lib/dto";

import { classIds, makeUnit, ruleset } from "../support/fixtures";

/**
 * THE 3 · 2 · 1 IS A REAL PRE-FIGHT STATE — what a viewer can see.
 *
 *   8 heroes appear → all idle → 3 → 2 → 1 → FIGHT → combat
 *
 * During the countdown every hero is exactly as it spawned: its authoritative start position, FULL HP, alive, no status — and NOTHING of the fight
 * is shown: 0 attacks, 0 damage, 0 heals, 0 status ticks, 0 movement. The combat clock begins at `combatStartsAt`; the first event can only be at
 * or after it (tick 1). This holds whatever the browser saw before: a replay that arrived early, a battle whose timeline moved, a clock estimate
 * that stepped back across the bell, a viewer who reconnects mid-countdown, a second viewer on a slightly different clock.
 */
const ARENA = DEFAULT_SETTINGS.arena;
const TIMING: StageTiming = { countdownMs: ARENA.countdownMs, maxCombatMs: ARENA.maxCombatMs };
const T0 = Date.UTC(2026, 9, 7, 12, 0, 0);

interface Built {
  out: BattleOutcome;
  battle: BattleDto;
  replay: ReplayDto;
  units: CombatUnitInput[];
}

function build(units: CombatUnitInput[], seed: string, startsAt = T0): Built {
  const out = simulateBattle({ seed, ruleset, units, maxCombatMs: ARENA.maxCombatMs, recordFrames: true });
  const combatStartsAt = startsAt + ARENA.introMs + ARENA.countdownMs;
  const combatEndsAt = combatStartsAt + out.durationMs;
  const fighters: FighterDto[] = units.map((u) => {
    const slot = out.slotOf[u.characterId] as number;
    const p = out.participants[slot]!;
    return {
      characterId: u.characterId, slot, publicId: u.characterId, name: u.name, classId: u.classId, title: null, isDemo: false, claimed: false, power: null,
      appearance: { rarity: "COMMON", parts: {} } as never, avatarUrl: null, maxHp: p.maxHp, startPosition: out.startPositions[slot] as [number, number],
    } as FighterDto;
  });
  const battle: BattleDto = {
    id: `battle-${seed}`, sequence: 1, number: 1, status: "SIMULATED", startsAt, combatStartsAt, combatEndsAt, resultsStartAt: combatEndsAt + ARENA.victoryHoldMs,
    slotEndsAt: combatEndsAt + ARENA.victoryHoldMs + ARENA.resultsMs, durationMs: out.durationMs, endedBy: out.endedBy, tickMs: out.tickMs, fighters, results: null,
    eventsHash: out.eventsHash, rulesVersion: out.rulesVersion, hasReplay: true,
  };
  const replay: ReplayDto = {
    skillFx: {}, combat: { arenaRadius: ruleset.combat.arenaRadius, startRadius: ruleset.combat.startRadius, unitRadius: ruleset.combat.unitRadius },
    battleId: battle.id, tickMs: out.tickMs, ticks: out.ticks, stride: FRAME_STRIDE, frames: out.frames ?? [], events: out.events, skillIds: out.skillIds,
    startPositions: out.startPositions, slotOf: out.slotOf, eventsHash: out.eventsHash, rulesVersion: out.rulesVersion, ranking: out.ranking,
  };
  return { out, battle, replay, units };
}

/** All six classes, ranged and melee, in one fight (8 fighters). */
const mixed = (prefix: string, tactic: Tactic = "BALANCED"): CombatUnitInput[] =>
  ["warrior", "mage", "rogue", "ranger", "tank", "cleric", "ranger", "warrior"].map((c, i) => makeUnit(`${prefix}${i}`, c, tactic));

const countdownInstants = (b: BattleDto) => {
  const bell = b.combatStartsAt!;
  return {
    "3 (start)": bell - 3000, "3 (late)": bell - 2001, "2 (start)": bell - 2000, "2 (late)": bell - 1001, "1 (start)": bell - 1000,
    "1 (late)": bell - 100, "immediately before FIGHT": bell - 1,
  } as const;
};
const expected: Record<string, number> = { "3 (start)": 3, "3 (late)": 3, "2 (start)": 2, "2 (late)": 2, "1 (start)": 1, "1 (late)": 1, "immediately before FIGHT": 1 };

function expectSpawnState(b: Built, units: ReturnType<typeof spawnState>, label: string): void {
  expect(units, label).toHaveLength(b.units.length);
  for (const u of units) {
    const start = b.out.startPositions[u.slot]!;
    expect([u.x, u.y], `${label}: slot ${u.slot} moved before the fight`).toEqual(start);
    expect(u.hp, `${label}: slot ${u.slot} HP below full before the fight`).toBe(b.out.participants[u.slot]!.maxHp);
    expect(u.hp).toBe(u.maxHp);
    expect(u.alive).toBe(true);
    expect(u.flags, `${label}: a status before the fight`).toBe(FRAME_FLAG.ALIVE);
  }
}

describe("the engine: no combat event can exist before the bell", () => {
  it("across 300 battles (every class, every tactic, ranged and melee): every event is at tick ≥ 1, and tick 0 is the exact spawn state at full HP", () => {
    const tactics: Tactic[] = ["AGGRESSIVE", "BALANCED", "DEFENSIVE"];
    let firstTicks = 0;
    for (let i = 0; i < 300; i++) {
      const rng = createRng(`cd-${i}`);
      const units = i % 3 === 0 ? mixed(`m${i}-`, tactics[i % 3]!) : Array.from({ length: 2 + (i % 7) }, (_, k) => makeUnit(`u${i}-${k}`, rng.pick(classIds), rng.pick(tactics)));
      const { out } = build(units, `cd-${i}`);
      for (const e of out.events) expect(e[0], `battle ${i}: an event before the first tick`).toBeGreaterThanOrEqual(1);
      const n = out.participants.length;
      // Tick 1 (the first tick after the bell): the fighters are already moving.
      for (let slot = 0; slot < n; slot++) {
        const o = (n + slot) * FRAME_STRIDE;
        if (out.frames![o]! / 10 !== out.startPositions[slot]![0] || out.frames![o + 1]! / 10 !== out.startPositions[slot]![1]) firstTicks++;
      }
      for (let slot = 0; slot < n; slot++) {
        const o = slot * FRAME_STRIDE;
        expect([out.frames![o]! / 10, out.frames![o + 1]! / 10]).toEqual(out.startPositions[slot]);
        expect(out.frames![o + 2]).toBe(out.participants[slot]!.maxHp);
        expect(out.frames![o + 3]).toBe(FRAME_FLAG.ALIVE);
      }
    }
    expect(firstTicks).toBeGreaterThan(0); // and combat really does begin right at the bell
  });
});

describe("what a viewer sees: 8 heroes → idle → 3 → 2 → 1 → FIGHT → combat", () => {
  const b = build(mixed("v"), "viewer");

  it.each(Object.keys(expected))("at countdown %s: 8 heroes, movement 0, attacks 0, damage 0, every HP full — even with the replay already in hand", (label) => {
    const t = countdownInstants(b.battle)[label as keyof ReturnType<typeof countdownInstants>];
    for (const replay of [null, b.replay]) {
      const s = stageAt(b.battle, replay, t, TIMING);
      expect(s.clock.phase).toBe("COUNTDOWN");
      expect(s.clock.countdown).toBe(expected[label]);
      expect(s.clock.combatMs).toBe(0);
      expect(s.eventsHappened).toBe(0);
      expectSpawnState(b, s.units, `countdown ${label}`);
    }
  });

  it("the intro (heroes appear) is the same idle spawn state", () => {
    for (const t of [b.battle.startsAt, b.battle.startsAt + 1200, b.battle.combatStartsAt! - 3001]) {
      const s = stageAt(b.battle, b.replay, t, TIMING);
      expect(s.clock.phase).toBe("INTRO");
      expect(s.eventsHappened).toBe(0);
      expectSpawnState(b, s.units, "intro");
    }
  });

  it("FIGHT START: the combat clock begins at 0 with nothing applied; the first legal events come right after", () => {
    const bell = stageAt(b.battle, b.replay, b.battle.combatStartsAt!, TIMING);
    expect(bell.clock.phase).toBe("COMBAT");
    expect(bell.clock.combatMs).toBe(0);
    expect(bell.eventsHappened).toBe(0);
    expectSpawnState(b, bell.units, "the bell");
    const firstEventMs = b.out.events[0]![0] * b.out.tickMs;
    expect(firstEventMs).toBeGreaterThanOrEqual(b.out.tickMs);
    const after = stageAt(b.battle, b.replay, b.battle.combatStartsAt! + firstEventMs, TIMING);
    expect(after.eventsHappened).toBeGreaterThan(0);
    // …and the first HP loss is at or after the first legal damage event
    const firstHit = b.out.events.find((e) => e[1] === EV.HIT)!;
    const justBefore = stageAt(b.battle, b.replay, b.battle.combatStartsAt! + firstHit[0] * b.out.tickMs - 1, TIMING);
    for (const u of justBefore.units) expect(u.hp).toBe(u.maxHp);
  });

  it("the playback presents 0 events before FIGHT (each once after), frame by frame at 60 fps through the whole opening", () => {
    const pb = new ArenaPlayback();
    const presentedBefore: number[] = [];
    let presentedAfter = 0;
    for (let t = b.battle.startsAt; t < b.battle.combatStartsAt! + 4000; t += 1000 / 60) {
      const f = pb.frame(b.battle, b.replay, t, TIMING)!;
      if (t < b.battle.combatStartsAt!) {
        presentedBefore.push(f.fresh.length);
        expectSpawnState(b, f.units, `t=${Math.round(t - b.battle.combatStartsAt!)} ms`);
        for (const st of f.stats.values()) expect(st).toEqual({ damage: 0, kills: 0 });
      } else presentedAfter += f.fresh.length;
    }
    expect(presentedBefore.reduce((a, x) => a + x, 0)).toBe(0);
    expect(presentedAfter).toBeGreaterThan(0);
  });
});

describe("all six classes, ranged and melee, one by one", () => {
  it.each(classIds)("%s duelling every class: frozen through 3 · 2 · 1, first action only after FIGHT", (cls) => {
    for (const other of classIds) {
      const b = build([makeUnit(`a-${cls}`, cls), makeUnit(`b-${other}`, other)], `duel-${cls}-${other}`);
      for (const t of Object.values(countdownInstants(b.battle))) {
        const s = stageAt(b.battle, b.replay, t, TIMING);
        expect(s.clock.phase).toBe("COUNTDOWN");
        expect(s.eventsHappened).toBe(0);
        expectSpawnState(b, s.units, `${cls} vs ${other}`);
      }
      expect(b.out.events.every((e) => e[0] >= 1)).toBe(true);
    }
  });
});

describe("robust against everything that could leak the fight into the countdown", () => {
  const b = build(mixed("r"), "robust");

  it("a battle whose timeline MOVES after the viewer watched it fight: everything is dropped, and the new countdown shows the spawn state", () => {
    const pb = new ArenaPlayback();
    const mid = b.battle.combatStartsAt! + Math.floor(b.out.durationMs / 2);
    for (let t = b.battle.combatStartsAt!; t <= mid; t += 50) pb.frame(b.battle, b.replay, t, TIMING);
    const hurt = pb.frame(b.battle, b.replay, mid, TIMING)!;
    expect(hurt.units.some((u) => u.hp < u.maxHp || !u.alive)).toBe(true); // the viewer saw a real fight
    const shift = 90_000;
    const moved: BattleDto = { ...b.battle, startsAt: b.battle.startsAt + shift, combatStartsAt: b.battle.combatStartsAt! + shift, combatEndsAt: b.battle.combatEndsAt! + shift };
    const cd = pb.frame(moved, b.replay, moved.combatStartsAt! - 1500, TIMING)!;
    expect(cd.reset).toBe(true);
    expect(cd.clock.phase).toBe("COUNTDOWN");
    expect(cd.fresh).toEqual([]);
    expectSpawnState(b, cd.units, "the moved battle's countdown");
    for (const st of cd.stats.values()) expect(st).toEqual({ damage: 0, kills: 0 });
  });

  it("a clock estimate that steps BACK across the bell resets to the spawn state (never a hurt hero under the countdown)", () => {
    const pb = new ArenaPlayback();
    for (let t = b.battle.combatStartsAt!; t <= b.battle.combatStartsAt! + 6000; t += 40) pb.frame(b.battle, b.replay, t, TIMING);
    const back = pb.frame(b.battle, b.replay, b.battle.combatStartsAt! - 300, TIMING)!;
    expect(back.reset).toBe(true);
    expect(back.fresh).toEqual([]);
    expectSpawnState(b, back.units, "after the clock stepped back");
  });

  it("RECONNECT during the countdown: a fresh viewer reconstructs the exact countdown and spawn state", () => {
    const watching = new ArenaPlayback();
    for (let t = b.battle.startsAt; t < b.battle.combatStartsAt! - 1500; t += 16) watching.frame(b.battle, b.replay, t, TIMING);
    const t = b.battle.combatStartsAt! - 1500;
    const before = watching.frame(b.battle, b.replay, t, TIMING)!;
    const reconnected = new ArenaPlayback().frame(b.battle, null, t, TIMING)!; // the replay is not even fetched yet after a reconnect
    expect(reconnected.clock.phase).toBe("COUNTDOWN");
    expect(reconnected.clock.countdown).toBe(2);
    expect(reconnected.clock.countdown).toBe(before.clock.countdown);
    expect(reconnected.units).toEqual(before.units);
    expect(reconnected.fresh).toEqual([]);
  });

  it("TWO CLIENTS on slightly different clocks and frame rates see the same state at the same server instant — and neither fights during the other's countdown", () => {
    const a = new ArenaPlayback();
    const c = new ArenaPlayback();
    const bell = b.battle.combatStartsAt!;
    for (let t = b.battle.startsAt; t < bell + 3000; t += 1) {
      const fa = t % 16 === 0 ? a.frame(b.battle, b.replay, t, TIMING) : null; // 60 fps
      const fc = t % 33 === 0 ? c.frame(b.battle, b.replay, t, TIMING) : null; // 30 fps
      for (const f of [fa, fc]) {
        if (!f) continue;
        if (t < bell) {
          expect(f.clock.phase).not.toBe("COMBAT");
          expect(f.fresh).toEqual([]);
          expectSpawnState(b, f.units, `client at ${t - bell} ms`);
        }
      }
      if (fa && fc) expect(fa.units).toEqual(fc.units);
    }
    // A viewer whose clock estimate is 120 ms off (network drift) is never in COMBAT while the server says COUNTDOWN: the state is a pure function
    // of the instant, so at the server's countdown instants both agree exactly.
    for (const t of Object.values(countdownInstants(b.battle))) expect(stageAt(b.battle, b.replay, t, TIMING)).toEqual(stageAt(b.battle, null, t, TIMING));
  });
});
