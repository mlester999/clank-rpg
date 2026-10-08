/**
 * MATCHUP SIMULATION (pure domain code — no database, no argv, no console). Fair measurement of class-vs-class outcomes, with every number
 * reproducible from its seed:
 *
 *   · FRESH 1 v 1 — two heroes rolled the way hero generator 2 rolls them (`rollFighter`: realistic stats for their rarity), EQUAL rarity
 *     (the rarity rotates Common → Legendary, so equal PWR band), both start orders, from the standard 1 v 1 spawn (opposite sides) or from a
 *     random pair of the eight Arena spawn points (the distance two heroes actually start apart in an Arena battle).
 *   · TRACES — why a matchup goes the way it goes: when the melee side first reaches the ranged side, how many ranged attacks landed before,
 *     damage by source (basic / skill), healing, stun time, fight length.
 *   · FINAL DUELS — the last two survivors of real eight-hero battles, replayed from THEIR situation (positions, remaining HP, skill cooldowns:
 *     `BattleInput.scenario`) — once as it was, once with both at the same HP — so survivor HP and the matchup itself can be told apart.
 *
 * Win rates come with a Wilson 95 % interval.
 */
import { RARITIES, type Rarity } from "../../src/domain/character/appearance";
import { buildDefaultRuleset } from "../../src/domain/content";
import { simulateBattle, startPositionFor } from "../../src/domain/combat/engine";
import { EV, EV_FLAG, FRAME_FLAG, FRAME_STRIDE, type BattleOutcome, type CombatUnitInput, type ScenarioStart } from "../../src/domain/combat/types";
import type { Ruleset } from "../../src/domain/rules";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { createRng, type Rng } from "../../src/domain/util/rng";

import { rollFighter } from "./raritySim";

export const isRanged = (rs: Ruleset, classId: string): boolean => (rs.classes[classId]?.attack.projectileSpeed ?? 0) > 0;

export interface Rate {
  wins: number;
  n: number;
  pct: number;
  lo: number;
  hi: number;
}
/** Win share with a Wilson score 95 % interval (percent, one decimal). */
export function rate(wins: number, n: number): Rate {
  if (n === 0) return { wins, n, pct: 0, lo: 0, hi: 0 };
  const z = 1.96;
  const p = wins / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const r1 = (x: number) => Math.round(x * 1000) / 10;
  return { wins, n, pct: r1(p), lo: r1(Math.max(0, c - h)), hi: r1(Math.min(1, c + h)) };
}

export function realisticUnit(rs: Ruleset, rng: Rng, classId: string, rarity: Rarity, id: string): CombatUnitInput {
  const f = rollFighter(rng, rs.classes[classId]!, rarity);
  return { characterId: id, name: `${classId}-${id}`, classId, tactic: "BALANCED", stats: f.stats };
}

export interface DuelTrace {
  aWon: boolean;
  draw: boolean;
  durationMs: number;
  /** ms until the melee side first stood within its reach of the ranged side (null: never / not a ranged-vs-melee duel). */
  contactMs: number | null;
  /** Basic + skill hits the ranged side landed before contact. */
  hitsBeforeContact: number;
  damage: { a: { basic: number; skill: number }; b: { basic: number; skill: number } };
  healed: { a: number; b: number };
  stunnedMs: { a: number; b: number };
}

export type SpawnMode = "duel" | "arena";

/** One fresh 1 v 1 between A and B (input order A, B; the seed decides which slot each takes). */
export function freshDuel(rs: Ruleset, a: string, b: string, rarity: Rarity, seed: string, spawn: SpawnMode): { out: BattleOutcome; trace: DuelTrace; units: CombatUnitInput[] } {
  const rng = createRng(seed);
  const units = [realisticUnit(rs, rng.fork("a"), a, rarity, "A"), realisticUnit(rs, rng.fork("b"), b, rarity, "B")];
  let scenario: { start: ScenarioStart[] } | undefined;
  if (spawn === "arena") {
    // two different spawn points of an eight-hero Arena battle — the distances heroes really start apart (165 … 430)
    const order = rng.fork("spawn").shuffle([0, 1, 2, 3, 4, 5, 6, 7]);
    const pa = startPositionFor(order[0]!, 8, rs.combat.startRadius);
    const pb = startPositionFor(order[1]!, 8, rs.combat.startRadius);
    scenario = { start: [{ x: pa[0], y: pa[1] }, { x: pb[0], y: pb[1] }] };
  }
  const out = simulateBattle({ seed, ruleset: rs, units, maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs, recordFrames: true, ...(scenario ? { scenario } : {}) });
  return { out, units, trace: traceDuel(rs, out, units) };
}

export function traceDuel(rs: Ruleset, out: BattleOutcome, units: CombatUnitInput[]): DuelTrace {
  const sa = out.slotOf[units[0]!.characterId]!;
  const sb = out.slotOf[units[1]!.characterId]!;
  const pa = out.participants[sa]!;
  const pb = out.participants[sb]!;
  const n = out.participants.length;
  const f = out.frames ?? [];
  const pos = (t: number, s: number) => [(f[(t * n + s) * FRAME_STRIDE] ?? 0) / 10, (f[(t * n + s) * FRAME_STRIDE + 1] ?? 0) / 10] as const;
  const flags = (t: number, s: number) => f[(t * n + s) * FRAME_STRIDE + 3] ?? 0;
  const ca = units[0]!.classId;
  const cb = units[1]!.classId;
  const mixed = isRanged(rs, ca) !== isRanged(rs, cb);
  let contactTick: number | null = null;
  if (mixed && f.length) {
    const [rSlot, mSlot, mClass] = isRanged(rs, ca) ? [sa, sb, cb] : [sb, sa, ca];
    const reach = rs.classes[mClass]!.attack.range * 1.05;
    for (let t = 0; t <= out.ticks; t++) {
      const [rx, ry] = pos(t, rSlot);
      const [mx, my] = pos(t, mSlot);
      if (Math.hypot(rx - mx, ry - my) <= reach) {
        contactTick = t;
        break;
      }
    }
  }
  const dmg = { a: { basic: 0, skill: 0 }, b: { basic: 0, skill: 0 } };
  const healed = { a: 0, b: 0 };
  let hitsBeforeContact = 0;
  const rangedSlot = mixed ? (isRanged(rs, ca) ? sa : sb) : -1;
  for (const e of out.events) {
    if (e[1] === EV.HIT) {
      const side = e[2] === sa ? dmg.a : e[2] === sb ? dmg.b : null;
      if (side) side[(e[5] & EV_FLAG.BASIC) !== 0 ? "basic" : "skill"] += e[4];
      if (e[2] === rangedSlot && contactTick !== null && e[0] < contactTick) hitsBeforeContact++;
    } else if (e[1] === EV.HEAL) {
      if (e[3] === sa) healed.a += e[4];
      else if (e[3] === sb) healed.b += e[4];
    }
  }
  let stunA = 0;
  let stunB = 0;
  for (let t = 0; t <= out.ticks; t++) {
    if (flags(t, sa) & FRAME_FLAG.STUNNED) stunA++;
    if (flags(t, sb) & FRAME_FLAG.STUNNED) stunB++;
  }
  const aWon = pa.placement === 1 && pb.placement !== 1;
  return {
    aWon, draw: pa.placement === pb.placement, durationMs: out.durationMs,
    contactMs: contactTick === null ? null : contactTick * out.tickMs, hitsBeforeContact,
    damage: dmg, healed, stunnedMs: { a: stunA * out.tickMs, b: stunB * out.tickMs },
  };
}

export interface MatchupSummary {
  a: string;
  b: string;
  aWin: Rate;
  /** A's win rate split by which side spawned in slot 0 (start order). */
  bySlot: { aFirst: Rate; bFirst: Rate };
  medianDurationS: number;
  medianContactS: number | null;
  avgHitsBeforeContact: number;
  avgDamage: DuelTrace["damage"];
  avgHealed: DuelTrace["healed"];
  avgStunnedS: { a: number; b: number };
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] as number;
};
const r1 = (x: number) => Math.round(x * 10) / 10;

/** N fresh duels of A vs B: equal rarity (rotating through all four), seeds `${salt}-${a}-${b}-${i}`. */
export function matchup(rs: Ruleset, a: string, b: string, n: number, spawn: SpawnMode, salt = "mu"): MatchupSummary {
  let wins = 0;
  let aFirstN = 0;
  let aFirstW = 0;
  let bFirstN = 0;
  let bFirstW = 0;
  const durations: number[] = [];
  const contacts: number[] = [];
  let hitsBefore = 0;
  let mixedN = 0;
  const dmg = { a: { basic: 0, skill: 0 }, b: { basic: 0, skill: 0 } };
  const healed = { a: 0, b: 0 };
  const stun = { a: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    const rarity = RARITIES[i % RARITIES.length] as Rarity;
    const { out, trace, units } = freshDuel(rs, a, b, rarity, `${salt}-${a}-${b}-${i}`, spawn);
    const won = trace.aWon ? 1 : 0;
    wins += won;
    if (out.slotOf[units[0]!.characterId] === 0) {
      aFirstN++;
      aFirstW += won;
    } else {
      bFirstN++;
      bFirstW += won;
    }
    durations.push(trace.durationMs);
    if (trace.contactMs !== null) contacts.push(trace.contactMs);
    if (isRanged(rs, a) !== isRanged(rs, b)) {
      mixedN++;
      hitsBefore += trace.hitsBeforeContact;
    }
    for (const side of ["a", "b"] as const) {
      dmg[side].basic += trace.damage[side].basic;
      dmg[side].skill += trace.damage[side].skill;
      healed[side] += trace.healed[side];
      stun[side] += trace.stunnedMs[side];
    }
  }
  const avg = (x: number) => Math.round(x / Math.max(1, n));
  return {
    a, b, aWin: rate(wins, n), bySlot: { aFirst: rate(aFirstW, aFirstN), bFirst: rate(bFirstW, bFirstN) },
    medianDurationS: r1(median(durations) / 1000),
    medianContactS: contacts.length ? r1(median(contacts) / 1000) : null,
    avgHitsBeforeContact: mixedN ? r1(hitsBefore / mixedN) : 0,
    avgDamage: { a: { basic: avg(dmg.a.basic), skill: avg(dmg.a.skill) }, b: { basic: avg(dmg.b.basic), skill: avg(dmg.b.skill) } },
    avgHealed: { a: avg(healed.a), b: avg(healed.b) },
    avgStunnedS: { a: r1(stun.a / n / 1000), b: r1(stun.b / n / 1000) },
  };
}

// --------------------------------------------------------------------------------------- final duels
export interface FinalState {
  battle: number;
  units: [CombatUnitInput, CombatUnitInput];
  start: [ScenarioStart, ScenarioStart];
  /** Who actually won the free-for-all (input index 0 / 1). */
  actualWinner: 0 | 1;
}

/**
 * The last two survivors of `battles` realistic eight-hero battles (production rarity odds), with their exact situation at the first tick only
 * two are alive: position, HP fraction, and how long until each skill is ready again (from the battle's SKILL events).
 */
export function collectFinals(rs: Ruleset, battles: number, salt = "final", rangedVsMeleeOnly = true): FinalState[] {
  const ids = Object.keys(rs.classes);
  const finals: FinalState[] = [];
  const weights: Record<Rarity, number> = DEFAULT_SETTINGS.character.rarityWeights as Record<Rarity, number>;
  for (let b = 0; b < battles; b++) {
    const rng = createRng(`${salt}-${b}`);
    const units: CombatUnitInput[] = [];
    for (let i = 0; i < 8; i++) {
      const rarity = rng.weighted(RARITIES as unknown as Rarity[], (r) => weights[r] ?? 0);
      units.push(realisticUnit(rs, rng.fork(`u${i}`), rng.pick(ids), rarity, `u${i}`));
    }
    const out = simulateBattle({ seed: `${salt}-seed-${b}`, ruleset: rs, units, maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs, recordFrames: true });
    const n = out.participants.length;
    const f = out.frames!;
    const hp = (t: number, s: number) => f[(t * n + s) * FRAME_STRIDE + 2]!;
    let ft = -1;
    for (let t = 1; t <= out.ticks; t++) {
      if (out.participants.filter((p) => hp(t, p.slot) > 0).length === 2) {
        ft = t;
        break;
      }
    }
    if (ft < 0) continue;
    const two = out.participants.filter((p) => hp(ft, p.slot) > 0);
    const us = two.map((p) => units.find((u) => u.characterId === p.characterId)!);
    if (rangedVsMeleeOnly && isRanged(rs, us[0]!.classId) === isRanged(rs, us[1]!.classId)) continue;
    const start = two.map((p, k) => {
      const cls = rs.classes[us[k]!.classId]!;
      const readyMs = cls.skills.map((id) => {
        const idx = out.skillIds.indexOf(id);
        let last = -1;
        for (const e of out.events) if (e[0] <= ft && e[1] === EV.SKILL && e[2] === p.slot && e[4] === idx) last = e[0];
        if (last < 0) return 0;
        const cdr = Math.min(us[k]!.stats.cha * rs.combat.derive.cooldownReductionPerCha, rs.combat.derive.maxCooldownReduction);
        const cd = rs.skills[id]!.cooldownMs * rs.combat.pace.time * (1 - cdr);
        return Math.max(0, last * out.tickMs + cd - ft * out.tickMs);
      });
      return {
        x: f[(ft * n + p.slot) * FRAME_STRIDE]! / 10,
        y: f[(ft * n + p.slot) * FRAME_STRIDE + 1]! / 10,
        hpFrac: hp(ft, p.slot) / p.maxHp,
        skillReadyMs: readyMs,
      } satisfies ScenarioStart;
    }) as [ScenarioStart, ScenarioStart];
    finals.push({ battle: b, units: [us[0]!, us[1]!], start, actualWinner: two[0]!.placement === 1 ? 0 : 1 });
  }
  return finals;
}

export interface ReplayOptions {
  /** Override both HP fractions (input order). */
  hpFrac?: [number, number];
  /** Every skill ready (instead of the cooldowns the battle left). */
  freshCooldowns?: boolean;
  /** The standard 1 v 1 spawn (opposite sides) instead of where the two actually stood. */
  spawnPositions?: boolean;
}

/**
 * Replays a final duel as a controlled 1 v 1 from its situation — optionally removing one factor at a time (HP, cooldowns, positions), which is
 * how survivor HP, ability availability, positioning and WHO survived (the heroes themselves) are told apart. Returns the winner's input index.
 */
export function replayFinal(rs: Ruleset, fs: FinalState, seed: string, opts: ReplayOptions | [number, number] = {}): 0 | 1 | -1 {
  const o: ReplayOptions = Array.isArray(opts) ? { hpFrac: opts } : opts;
  const start = fs.start.map((s, k) => {
    const pos = o.spawnPositions ? startPositionFor(k === 0 ? 0 : 1, 2, rs.combat.startRadius) : null;
    return {
      ...s,
      ...(o.hpFrac ? { hpFrac: o.hpFrac[k] } : {}),
      ...(o.freshCooldowns ? { skillReadyMs: undefined } : {}),
      ...(pos ? { x: pos[0], y: pos[1] } : {}),
    };
  });
  const out = simulateBattle({ seed, ruleset: rs, units: [...fs.units], maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs, scenario: { start } });
  const p0 = out.participants[out.slotOf[fs.units[0].characterId]!]!;
  const p1 = out.participants[out.slotOf[fs.units[1].characterId]!]!;
  if (p0.placement === 1 && p1.placement !== 1) return 0;
  if (p1.placement === 1 && p0.placement !== 1) return 1;
  return -1;
}

export const defaultRuleset = buildDefaultRuleset;
