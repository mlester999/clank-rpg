import { describe, expect, it } from "vitest";

import { castTicks } from "@/components/arena/actionClock";
import { phaseNow } from "@/components/arena/phase";
import { cuesForEvents, PhaseCueTracker, skillSound, type CueContext, type PhaseCueInput, type SoundCue } from "@/domain/audio/cues";
import { SOUND_IDS, type SoundId } from "@/domain/audio/sounds";
import { simulateBattle } from "@/domain/combat/engine";
import { EV, EV_FLAG, FRAME_STRIDE, STATUS_CODE, type BattleOutcome, type EventTuple } from "@/domain/combat/types";
import { DEFAULT_CLASSES } from "@/domain/content";
import type { BattleDto } from "@/lib/dto";

import { classIds, makeUnit, ruleset } from "../support/fixtures";

/**
 * EVENT → SOUND. The cue mapper is driven by REAL simulated battles (the engine's own events), so what is checked is what a player will hear:
 * a sound only for something the server recorded, the right sound for the right class, one KO cue per fall, one winner.
 */

const visuals = Object.fromEntries(DEFAULT_CLASSES.map((c) => [c.id, { weapon: c.look.weapon, body: c.look.body, style: c.attack.style }]));
const skillFx = Object.fromEntries(Object.values(ruleset.skills).map((s) => [s.id, s.fx ?? "buff"]));

function battle(seed: string, classes: string[] = classIds, size = 8) {
  const units = Array.from({ length: size }, (_, i) => makeUnit(`f${i}`, classes[i % classes.length]!));
  const out = simulateBattle({ seed, ruleset, units, maxCombatMs: 60_000, recordFrames: true });
  return { units, out };
}

function contextFor(units: ReturnType<typeof battle>["units"], out: BattleOutcome, combatMs: number): CueContext {
  const aliveAfter = new Map<string, number>();
  let left = units.length;
  for (const e of out.events) if (e[1] === EV.ELIM) aliveAfter.set(`${e[0]}:${e[2]}`, --left);
  const replay = { events: out.events, tickMs: out.tickMs, frames: out.frames, stride: FRAME_STRIDE, startPositions: out.startPositions, ticks: out.ticks };
  return {
    battleId: "b1",
    tickMs: out.tickMs,
    combatMs,
    radius: 300,
    unit: (slot) => {
      const u = units[slot];
      const v = u && visuals[u.classId];
      return u && v ? { classId: u.classId, weapon: v.weapon, body: v.body, style: v.style, x: out.startPositions[slot]?.[0] ?? 0 } : undefined;
    },
    skill: (i) => {
      const id = out.skillIds[i];
      return id === undefined ? undefined : { id, fx: skillFx[id] ?? "buff" };
    },
    releaseMs: (slot, tick) => castTicks(replay, slot, tick) * out.tickMs,
    aliveAfter: (tick, victim) => {
      const alive = aliveAfter.get(`${tick}:${victim}`);
      return alive === undefined ? undefined : { alive, start: units.length };
    },
  };
}

/** The cues of a whole battle, each event presented at its own instant (like a viewer who watched it from the bell). */
function cuesOf(units: ReturnType<typeof battle>["units"], out: BattleOutcome): SoundCue[] {
  const cues: SoundCue[] = [];
  const byTick = new Map<number, EventTuple[]>();
  for (const e of out.events) byTick.set(e[0], [...(byTick.get(e[0]) ?? []), e]);
  for (const [tick, evs] of byTick) cues.push(...cuesForEvents(evs, contextFor(units, out, tick * out.tickMs)));
  return cues;
}

describe("a real battle, as sound", () => {
  const { units, out } = battle("audio-1");
  const cues = cuesOf(units, out);

  it("every cue is a sound of the catalogue, with a stable unique key and a stereo position inside the room", () => {
    expect(cues.length).toBeGreaterThan(40);
    const keys = new Set<string>();
    for (const c of cues) {
      expect(SOUND_IDS).toContain(c.id);
      expect(keys.has(c.key), c.key).toBe(false);
      keys.add(c.key);
      expect(Math.abs(c.pan)).toBeLessThanOrEqual(0.55);
      expect(c.kind).toBe("combat");
      expect(c.lateMs).toBe(0); // presented at its own instant
      expect(c.gain).toBeGreaterThan(0);
      expect(c.gain).toBeLessThanOrEqual(1.2);
    }
  });

  it("is deterministic: the same battle always produces the same cues", () => {
    expect(cuesOf(units, out)).toEqual(cues);
  });

  it("a basic attack sounds like ITS class: sword · mace · daggers · bow · staff · scepter — and nothing else swings", () => {
    const expected: Record<string, SoundId> = { warrior: "sword_swing", tank: "mace_swing", rogue: "dagger_swing", ranger: "bow_release", mage: "orb_cast", cleric: "bolt_cast" };
    const swings = new Set<SoundId>(Object.values(expected));
    let seen = 0;
    for (const e of out.events) {
      if (e[1] !== EV.ATTACK) continue;
      const cls = units[e[2]]!.classId;
      const c = cuesForEvents([e], contextFor(units, out, e[0] * out.tickMs));
      expect(c.map((x) => x.id), `${cls} attack`).toEqual([expected[cls]]);
      seen++;
    }
    expect(seen).toBeGreaterThan(30);
    // …and every swing / release in the whole battle came from an ATTACK event of that class
    const attackCount = out.events.filter((e) => e[1] === EV.ATTACK).length;
    expect(cues.filter((c) => swings.has(c.id)).length).toBe(attackCount);
  });

  it("an impact sounds like the attacker's weapon, once per recorded hit (a sweep that hits several is ONE impact)", () => {
    const hits = out.events.filter((e) => e[1] === EV.HIT && e[2] >= 0);
    const single = hits.filter((e) => (e[5] & EV_FLAG.AOE) === 0).length;
    const impacts = cues.filter((c) => ["sword_hit", "mace_hit", "dagger_hit", "arrow_hit", "magic_hit", "holy_hit"].includes(c.id)).length;
    expect(impacts).toBe(single);
    const aoeGroups = new Set(hits.filter((e) => (e[5] & EV_FLAG.AOE) !== 0).map((e) => `${e[0]}:${e[2]}`)).size;
    expect(cues.filter((c) => c.id === "aoe_hit").length).toBe(aoeGroups);
  });

  it("no sound exists without its event: the crit ping needs a critical hit, a heal pulse a heal, a shield a shield, a stun a stun", () => {
    const has = (kind: number, test: (e: EventTuple) => boolean = () => true) => out.events.some((e) => e[1] === kind && test(e));
    const count = (id: SoundId) => cues.filter((c) => c.id === id).length;
    if (!has(EV.HIT, (e) => (e[5] & EV_FLAG.CRIT) !== 0)) expect(count("crit_ping")).toBe(0);
    if (!has(EV.HEAL, (e) => (e[5] & EV_FLAG.LIFESTEAL) === 0)) expect(count("heal_pulse")).toBe(0);
    if (!has(EV.SHIELD)) expect(count("shield_up")).toBe(0);
    if (!has(EV.STATUS, (e) => e[4] === STATUS_CODE.STUN)) expect(count("stun_hit")).toBe(0);
    if (!has(EV.HAZARD)) expect(count("hazard_tick")).toBe(0);
    // and the converse for the always-present ones
    expect(count("ko") + count("ko_final")).toBe(out.events.filter((e) => e[1] === EV.ELIM).length);
  });

  it("every fall is one KO cue; the LAST hero standing's opponent falls with the big one; one 'final duel' stinger when three or more started", () => {
    const elims = out.events.filter((e) => e[1] === EV.ELIM);
    expect(cues.filter((c) => c.id === "ko_final").length).toBe(out.endedBy === "LAST_STANDING" ? 1 : 0);
    expect(cues.filter((c) => c.id === "ko").length + cues.filter((c) => c.id === "ko_final").length).toBe(elims.length);
    expect(cues.filter((c) => c.id === "final_duel").length).toBe(elims.length >= units.length - 2 ? 1 : 0);
    const finalCue = cues.find((c) => c.id === "ko_final");
    if (finalCue) expect(finalCue.key).toBe(`b1:${elims[elims.length - 1]![0]}:${EV.ELIM}:${elims[elims.length - 1]![2]}:${elims[elims.length - 1]![3]}:${elims[elims.length - 1]![4]}`);
  });

  it("named abilities have their own sounds (cleave, charge, slam, shadowstep, evasion, volley, snare, burst, nova, smite, sanctuary); a guard is voiced by its shield", () => {
    expect(skillSound("cleave", "cleave")).toBe("skill_cleave");
    expect(skillSound("charge", "dash")).toBe("skill_charge");
    expect(skillSound("shadowstep", "dash")).toBe("skill_shadowstep");
    expect(skillSound("ground_slam", "taunt")).toBe("skill_slam");
    expect(skillSound("guard", "shield")).toBeNull();
    const ids = new Set(Object.keys(ruleset.skills).map((id) => skillSound(id, skillFx[id] ?? "buff")));
    expect(ids.size).toBeGreaterThanOrEqual(10); // distinct sounds, not one generic explosion
    expect(skillSound("some_new_admin_skill", "nova")).toBe("skill_nova"); // an unknown skill falls back to its visual kind
    expect(skillSound("some_new_admin_skill", "mystery")).toBe("skill_buff");
  });

  it("a cast with a cast time is heard twice: the casting sound now, the ability when it RESOLVES (delayed), and a class-appropriate cast sound", () => {
    let checked = 0;
    for (let n = 0; n < 6 && checked < 3; n++) {
      const b = battle(`audio-cast-${n}`, ["mage", "cleric", "ranger", "tank", "warrior", "rogue"]);
      for (const e of b.out.events) {
        if (e[1] !== EV.SKILL) continue;
        const ctx = contextFor(b.units, b.out, e[0] * b.out.tickMs);
        const release = ctx.releaseMs(e[2], e[0]);
        if (release < 150) continue;
        const c = cuesForEvents([e], ctx);
        const sk = ctx.skill(e[4])!;
        const main = c.find((x) => x.id === skillSound(sk.id, sk.fx));
        if (!main) continue;
        expect(main.delayMs, sk.id).toBe(release);
        const style = ctx.unit(e[2])!.style;
        if (style === "orb") expect(c.some((x) => x.id === "cast_arcane")).toBe(true);
        if (style === "bolt") expect(c.some((x) => x.id === "cast_holy")).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("hand-built events (the rules the mapper follows)", () => {
  const ctx = (over: Partial<CueContext> = {}): CueContext => ({
    battleId: "b",
    tickMs: 100,
    combatMs: 5000,
    radius: 300,
    unit: (s) => ({ classId: "warrior", weapon: "sword", body: "medium", style: "slash", x: s === 0 ? -150 : 150 }),
    skill: (i) => (i === 0 ? { id: "frost_nova", fx: "nova" } : i === 1 ? { id: "sanctuary", fx: "heal" } : undefined),
    releaseMs: () => 0,
    aliveAfter: () => undefined,
    ...over,
  });

  it("the stereo position follows the floor: a fighter on the left sounds left, on the right sounds right, never hard-panned", () => {
    const [l] = cuesForEvents([[50, EV.ATTACK, 0, 1, 0, 0]], ctx());
    const [r] = cuesForEvents([[50, EV.ATTACK, 1, 0, 0, 0]], ctx());
    expect(l!.pan).toBeLessThan(0);
    expect(r!.pan).toBeGreaterThan(0);
    expect(Math.abs(l!.pan)).toBeLessThan(0.6);
  });

  it("a nova that slows five heroes is ONE crackle; a sanctuary's heal and shield are part of its own chime", () => {
    const slows: EventTuple[] = [1, 2, 3, 4, 5].map((v) => [60, EV.STATUS, v, 0, STATUS_CODE.SLOW, 0]);
    expect(cuesForEvents(slows, ctx()).map((c) => c.id)).toEqual(["slow_frost"]);
    const sanctuary: EventTuple[] = [[70, EV.SKILL, 2, 2, 1, 0], [70, EV.HEAL, 2, 2, 12, 0], [70, EV.SHIELD, 2, 2, 8, 0]];
    expect(cuesForEvents(sanctuary, ctx()).map((c) => c.id)).toEqual(["skill_sanctuary"]);
  });

  it("a lifesteal heal is silent (the strike already sounded); a plain heal pulses at the one who is healed", () => {
    expect(cuesForEvents([[10, EV.HEAL, 0, 0, 5, EV_FLAG.LIFESTEAL]], ctx())).toEqual([]);
    const [h] = cuesForEvents([[10, EV.HEAL, 0, 1, 5, 0]], ctx());
    expect(h!.id).toBe("heal_pulse");
    expect(h!.pan).toBeGreaterThan(0); // slot 1 stands on the right
  });

  it("events the server records but that make no sound of their own (a dash, a ring step, the end) stay silent", () => {
    expect(cuesForEvents([[1, EV.DASH, 0, 1, 0, 0], [2, EV.RING, -1, -1, 2000, 0], [3, EV.END, -1, -1, 1, 0]], ctx())).toEqual([]);
  });

  it("a hazard (the shrinking ring) is a quiet tick at the one it burns; an unknown event kind is ignored, not guessed at", () => {
    expect(cuesForEvents([[5, EV.HAZARD, 1, -1, 4, 0]], ctx()).map((c) => c.id)).toEqual(["hazard_tick"]);
    expect(cuesForEvents([[5, 99, 1, 0, 0, 0]], ctx())).toEqual([]);
  });

  it("a cue is as old as its event: a tick that happened 600 ms ago says so (the engine drops it, it never plays late)", () => {
    const [c] = cuesForEvents([[44, EV.ATTACK, 0, 1, 0, 0]], ctx({ combatMs: 5000 }));
    expect(c!.lateMs).toBe(600);
  });
});

describe("the 3 · 2 · 1, the bell and the winner come from the authoritative timeline — once each, never early, never replayed", () => {
  const T = { countdownMs: 3000, maxCombatMs: 30000 };
  const b: BattleDto = { id: "bt", startsAt: 100_000, combatStartsAt: 105_500, combatEndsAt: 118_000, resultsStartAt: 119_200, slotEndsAt: 124_200 } as unknown as BattleDto;

  function walk(from: number, to: number, opts: { winner?: boolean; step?: number; tracker?: PhaseCueTracker } = {}): Array<{ at: number; cue: SoundCue }> {
    const tr = opts.tracker ?? new PhaseCueTracker();
    const out: Array<{ at: number; cue: SoundCue }> = [];
    for (let now = from; now <= to; now += opts.step ?? 16) {
      const ph = phaseNow(b, now, T.countdownMs, T.maxCombatMs);
      const input: PhaseCueInput = { battleId: b.id, phase: ph.phase, countdown: ph.countdown, now, startsAt: b.startsAt, combatStartsAt: b.combatStartsAt, combatEndsAt: b.combatEndsAt, resultsStartAt: b.resultsStartAt, countdownMs: T.countdownMs, winnerKnown: opts.winner ?? true };
      for (const cue of tr.update(input)) out.push({ at: now, cue });
    }
    return out;
  }

  it("a full battle watched from its first frame: ready · 3 · 2 · 1 · FIGHT · victory · results — each exactly once, at its own instant (± one frame)", () => {
    const cues = walk(100_000, 125_000);
    expect(cues.map((c) => c.cue.id)).toEqual(["round_ready", "cd_3", "cd_2", "cd_1", "fight", "victory", "results"]);
    const at = (id: string) => cues.find((c) => c.cue.id === id)!.at;
    expect(at("cd_3") - 102_500).toBeLessThan(17); // 3 starts when the countdown starts (combatStartsAt − 3000)
    expect(at("cd_2") - 103_500).toBeLessThan(17);
    expect(at("cd_1") - 104_500).toBeLessThan(17);
    expect(at("fight") - 105_500).toBeLessThan(17);
    expect(at("fight")).toBeGreaterThanOrEqual(105_500); // never before the bell
    expect(at("victory") - 118_000).toBeLessThan(17);
    expect(at("results") - 119_200).toBeLessThan(17);
    expect(cues.every((c) => c.cue.kind === "phase" && c.cue.lateMs < 17)).toBe(true);
  });

  it("no cue of the fight exists before the bell: not 'fight', not 'victory', not 'results' — at any frame rate", () => {
    for (const step of [1, 7, 16, 33, 100]) {
      const early = walk(100_000, 105_499, { step });
      expect(early.map((c) => c.cue.id).filter((id) => ["fight", "victory", "results", "ko", "ko_final"].includes(id))).toEqual([]);
    }
  });

  it("the winner's cue waits for the winner: the fight is over but the verified replay is not in hand → silence (no early fanfare)", () => {
    const cues = walk(100_000, 125_000, { winner: false });
    expect(cues.map((c) => c.cue.id)).not.toContain("victory");
  });

  it("rerenders, retried requests and a restored tab cannot replay a cue: feeding the SAME instants again produces nothing", () => {
    const tracker = new PhaseCueTracker();
    expect(walk(100_000, 125_000, { tracker }).length).toBe(7);
    expect(walk(100_000, 125_000, { tracker }).length).toBe(0);
    expect(walk(104_000, 106_000, { tracker }).length).toBe(0); // the clock stepping back across the bell does not ring it twice
  });

  it("a viewer who joins during the 2 hears the 2 (it is fresh) and then 1 and FIGHT — not the 3 they never saw", () => {
    const cues = walk(103_700, 106_000);
    expect(cues.map((c) => c.cue.id)).toEqual(["cd_2", "cd_1", "fight"]);
  });

  it("a tab that slept through the countdown and wakes up in the fight plays NOTHING of the past: no 3, no 2, no 1, no bell", () => {
    const tracker = new PhaseCueTracker();
    expect(walk(101_000, 101_100, { tracker }).map((c) => c.cue.id)).toEqual(["round_ready"]);
    const woke = walk(110_000, 110_100, { tracker }); // 9 s later, mid-fight
    expect(woke).toEqual([]);
    // and the end of the battle still sounds when it comes
    expect(walk(118_000, 119_400, { tracker }).map((c) => c.cue.id)).toEqual(["victory", "results"]);
  });

  it("the next battle starts clean: its own ready · 3 · 2 · 1 · FIGHT sound again", () => {
    const tracker = new PhaseCueTracker();
    expect(walk(100_000, 125_000, { tracker }).length).toBe(7);
    const next: BattleDto = { ...b, id: "bt2", startsAt: 124_200, combatStartsAt: 129_700, combatEndsAt: 142_000, resultsStartAt: 143_200, slotEndsAt: 148_200 } as unknown as BattleDto;
    const out: string[] = [];
    for (let now = 124_200; now <= 130_000; now += 16) {
      const ph = phaseNow(next, now, T.countdownMs, T.maxCombatMs);
      for (const c of tracker.update({ battleId: next.id, phase: ph.phase, countdown: ph.countdown, now, startsAt: next.startsAt, combatStartsAt: next.combatStartsAt, combatEndsAt: next.combatEndsAt, resultsStartAt: next.resultsStartAt, countdownMs: T.countdownMs, winnerKnown: true })) out.push(c.id);
    }
    expect(out).toEqual(["round_ready", "cd_3", "cd_2", "cd_1", "fight"]);
  });
});
