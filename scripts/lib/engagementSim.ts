/**
 * ENGAGEMENT SIMULATION (pure domain code — no database, no argv, no console): measures what rules 3.1.0 changes, with ONE definition of every
 * metric applied to every ruleset, so "before" (3.0.0) and "after" (3.1.0) compare the same seeded fights.
 *
 *   · free-for-all battles (8 random classes): pacing quantiles, timeouts, class win rates, and the FINAL DUEL — the moment exactly two fighters are
 *     left, one ranged and one melee — with who wins it and how;
 *   · 1v1 duels for every class pair, and a large ranged-vs-melee duel set with the kiting / commitment metrics.
 *
 * Metrics come from the replay frames (positions every 100 ms) and the event stream — the same data a viewer's renderer plays:
 *   running shot     a ranged basic attack released while its shooter covered ≥ 60 % of its full walking distance over the two ticks before
 *                    the release (it was running while it shot; separation nudges are far smaller than that)
 *   retreat tick     a fighter moved ≥ 40 % of a walking step AWAY from an enemy within 100 units
 *   kite lock        ≥ 8 s in which a melee fighter stays within 120 units of the ranged one, lands NOTHING on it, while the ranged one keeps hitting —
 *                    the "infinite kiting" pattern
 *   boundary stall   ≥ 4 s pinned against the wall (≤ 2 units from it) with no hit dealt or taken
 *   committed-window violation   (rules 3.1.0+, which flag WINDUP / RECOVER in the frames) a ranged basic attack whose shooter moved ≥ 50 % of a
 *                    walking step in ANY tick of its aim → release → recovery window — i.e. it attacked while running. Strictly: any movement at
 *                    all in that window is counted too (`committedNudges`: only possible when two committed fighters overlap)
 *   infinite kite    a kite lock that is still running when the fight hits the time limit (the melee never lands a hit again and nobody wins
 *                    by elimination)
 */
import { computeEffectiveStats, rollVariation } from "../../src/domain/character/stats";
import { buildDefaultRuleset } from "../../src/domain/content";
import { simulateBattle } from "../../src/domain/combat/engine";
import { EV, EV_FLAG, FRAME_FLAG, FRAME_STRIDE, type BattleOutcome, type CombatUnitInput, type Tactic } from "../../src/domain/combat/types";
import type { Ruleset } from "../../src/domain/rules";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { zeroStats } from "../../src/domain/stats";
import { createRng, type Rng } from "../../src/domain/util/rng";

export const RANGED = (rs: Ruleset, classId: string): boolean => (rs.classes[classId]?.attack.projectileSpeed ?? 0) > 0;

export function rollUnit(rs: Ruleset, rng: Rng, classId: string, id: string, tactic: Tactic = "BALANCED"): CombatUnitInput {
  const stats = computeEffectiveStats({ classDef: rs.classes[classId]!, variation: rollVariation(rng, DEFAULT_SETTINGS.character), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() }).total;
  return { characterId: id, name: `${classId}-${id}`, classId, tactic, stats };
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

interface Frames {
  out: BattleOutcome;
  n: number;
  pos: (tick: number, slot: number) => [number, number];
  hp: (tick: number, slot: number) => number;
  flags: (tick: number, slot: number) => number;
}

/** Why a kite lock happened (diagnostics): who was backing away, and whether the chaser was slowed / stunned / itself fleeing. */
export interface LockSample {
  ranged: string;
  melee: string;
  rangedRetreatShare: number;
  meleeRetreatShare: number;
  meleeSlowedShare: number;
  meleeStunnedShare: number;
  avgDistance: number;
  meleeHpFracAtStart: number;
  startS: number;
}
export const lockSamples: LockSample[] = [];
const framesOf = (out: BattleOutcome): Frames => {
  const n = out.participants.length;
  const f = out.frames ?? [];
  return {
    out, n,
    pos: (t, s) => {
      const o = (t * n + s) * FRAME_STRIDE;
      return [(f[o] ?? 0) / 10, (f[o + 1] ?? 0) / 10];
    },
    hp: (t, s) => f[(t * n + s) * FRAME_STRIDE + 2] ?? 0,
    flags: (t, s) => f[(t * n + s) * FRAME_STRIDE + 3] ?? 0,
  };
};

/**
 * The largest single-tick movement of `slot` over the committed window of the attack it released at `tick`: every WINDUP tick before the release,
 * the release tick and every RECOVER tick after it. Null under rules that do not flag the window (before 3.1.0).
 */
function committedMove(F: Frames, slot: number, tick: number, lastTick: number): number | null {
  if (tick < 2 || !(F.flags(tick - 1, slot) & FRAME_FLAG.WINDUP)) return null;
  let worst = 0;
  const step = (k: number) => {
    const [x0, y0] = F.pos(k - 1, slot);
    const [x1, y1] = F.pos(k, slot);
    worst = Math.max(worst, Math.hypot(x1 - x0, y1 - y0));
  };
  for (let k = tick - 1; k >= 1 && F.flags(k, slot) & FRAME_FLAG.WINDUP; k--) step(k);
  for (let k = tick; k <= lastTick && (k === tick || F.flags(k, slot) & FRAME_FLAG.RECOVER); k++) step(k);
  return worst;
}

export interface DuelMetrics {
  fights: number;
  rangedWins: number;
  meleeWins: number;
  draws: number;
  timeouts: number;
  overtimeFinishes: number;
  durationsMs: number[];
  avgDistance: number[];
  retreatShare: number[];
  rangedShots: number;
  runningShots: number;
  kiteLocks: number;
  /** TERMINAL kiting: a kite lock after which the melee never lands a hit again until the fight ends (it dies, or the clock runs out). */
  terminalKites: number;
  /** INFINITE kiting: a terminal kite that reaches the time limit (the fight is never decided by the chase). */
  infiniteKites: number;
  boundaryStalls: number;
  /** Ranged releases whose shooter moved ≥ 50 % of a step in some tick of its committed (aim → release → recovery) window: shots on the run. */
  committedViolations: number;
  /** …and releases with ANY movement in that window (a body push between two committed fighters). */
  committedNudges: number;
}
export const emptyDuel = (): DuelMetrics => ({ fights: 0, rangedWins: 0, meleeWins: 0, draws: 0, timeouts: 0, overtimeFinishes: 0, durationsMs: [], avgDistance: [], retreatShare: [], rangedShots: 0, runningShots: 0, kiteLocks: 0, terminalKites: 0, infiniteKites: 0, boundaryStalls: 0, committedViolations: 0, committedNudges: 0 });

/** Analyses the stretch [fromTick, toTick] of a battle between ranged slot `ra` and melee slot `me` (the whole duel, or a free-for-all's final duel). */
export function analyseDuel(rs: Ruleset, out: BattleOutcome, units: CombatUnitInput[], ra: number, me: number, fromTick: number, m: DuelMetrics): void {
  const F = framesOf(out);
  const cs = rs.combat;
  const tickMs = out.tickMs;
  const toTick = out.ticks;
  const classOf = (slot: number) => units.find((u) => u.characterId === out.participants[slot]!.characterId)!.classId;
  const stepOf = (slot: number) => {
    const u = units.find((x) => x.characterId === out.participants[slot]!.characterId)!;
    return ((rs.classes[u.classId]!.moveSpeed + u.stats.agi * cs.derive.moveSpeedPerAgi) / cs.pace.move) * (tickMs / 1000);
  };
  void classOf;
  const span = Math.max(1, toTick - fromTick);
  m.fights++;
  const pa = out.participants[ra]!;
  const pm = out.participants[me]!;
  if (out.endedBy === "TIME_LIMIT") m.timeouts++;
  if (out.durationMs > cs.overtime.startMs) m.overtimeFinishes++;
  if (pa.placement === 1 && pm.placement !== 1) m.rangedWins++;
  else if (pm.placement === 1) m.meleeWins++;
  else m.draws++;
  m.durationsMs.push((toTick - fromTick) * tickMs);
  // distance + retreat ticks
  let dsum = 0;
  let retreats = 0;
  const stepR = stepOf(ra);
  for (let t = fromTick + 1; t <= toTick; t++) {
    const [ax, ay] = F.pos(t, ra);
    const [bx, by] = F.pos(t, me);
    const d = Math.hypot(ax - bx, ay - by);
    dsum += d;
    const [px, py] = F.pos(t - 1, ra);
    const d0 = Math.hypot(px - bx, py - by);
    if (d0 < 100 && d - d0 >= 0.4 * stepR && F.hp(t, ra) > 0) retreats++;
  }
  m.avgDistance.push(dsum / span);
  m.retreatShare.push(retreats / span);
  // running shots + kite locks + boundary stalls, from the events in the stretch
  const involved = new Map<number, Set<number>>(); // slot → ticks it dealt or took a hit
  const meleeOnRanged = new Set<number>();
  const rangedOnMelee = new Set<number>();
  const mark = (slot: number, t: number) => (involved.get(slot) ?? involved.set(slot, new Set()).get(slot)!).add(t);
  for (const e of out.events) {
    if (e[0] <= fromTick) continue;
    if (e[1] === EV.HIT) {
      mark(e[2], e[0]);
      mark(e[3], e[0]);
      if (e[2] === me && e[3] === ra) meleeOnRanged.add(e[0]);
      if (e[2] === ra && e[3] === me) rangedOnMelee.add(e[0]);
    }
    if (e[1] === EV.ATTACK && e[2] === ra && (e[5] & EV_FLAG.PROJECTILE) !== 0 && e[0] >= 2) {
      // Was it moving at ≥ 60 % of its walking speed in the 100 ms right before it released (no stop to aim)?
      m.rangedShots++;
      const [x2, y2] = F.pos(e[0] - 2, ra);
      const [x1, y1] = F.pos(e[0] - 1, ra);
      if (Math.hypot(x1 - x2, y1 - y2) >= 0.6 * stepR) m.runningShots++;
      const worst = committedMove(F, ra, e[0], toTick);
      if (worst !== null && worst >= 0.5 * stepR) m.committedViolations++;
      else if (worst !== null && worst > 0) m.committedNudges++;
    }
  }
  const lockTicks = Math.round(8000 / tickMs);
  let lockStart = -1;
  let rangedHitsInWindow = 0;
  let locked = false;
  for (let t = fromTick + 1; t <= toTick && !locked; t++) {
    const [ax, ay] = F.pos(t, ra);
    const [bx, by] = F.pos(t, me);
    const close = Math.hypot(ax - bx, ay - by) <= 120 && F.hp(t, ra) > 0 && F.hp(t, me) > 0;
    if (!close || meleeOnRanged.has(t)) {
      lockStart = -1;
      rangedHitsInWindow = 0;
      continue;
    }
    if (lockStart < 0) lockStart = t;
    if (rangedOnMelee.has(t)) rangedHitsInWindow++;
    if (t - lockStart >= lockTicks && rangedHitsInWindow > 0) {
      // Kiting means the RANGED one backs away while the melee one CHASES. A hurt melee fighter that is itself fleeing (backing away most of the
      // window) is not being kited — it is retreating — so that window does not count.
      // (Measured from movement, the same way for every ruleset: the melee's own step points AWAY from the ranged one.)
      let meleeBacking = 0;
      const stepM = stepOf(me);
      for (let k = Math.max(lockStart, 1); k <= t; k++) {
        const [mx0, my0] = F.pos(k - 1, me);
        const [mx1, my1] = F.pos(k, me);
        const [rx, ry] = F.pos(k - 1, ra);
        const vx = mx1 - mx0;
        const vy = my1 - my0;
        const sp = Math.hypot(vx, vy);
        if (sp < 0.4 * stepM) continue;
        if (vx * (rx - mx0) + vy * (ry - my0) < 0) meleeBacking++;
      }
      if (meleeBacking / (t - lockStart + 1) > 0.3) {
        lockStart = t;
        rangedHitsInWindow = 0;
        continue;
      }
      locked = true;
      // diagnostics over the lock window
      let rr = 0, mr = 0, ms = 0, mst = 0, ds = 0;
      const span = t - lockStart + 1;
      for (let k = lockStart; k <= t; k++) {
        const fr = F.flags(k, ra);
        const fm = F.flags(k, me);
        if (fr & 1024) rr++;
        if (fm & 1024) mr++;
        if (fm & 16) ms++;
        if (fm & 2) mst++;
        const [ax2, ay2] = F.pos(k, ra);
        const [bx2, by2] = F.pos(k, me);
        ds += Math.hypot(ax2 - bx2, ay2 - by2);
      }
      const ucls = (slot: number) => units.find((x) => x.characterId === out.participants[slot]!.characterId)!.classId;
      lockSamples.push({ ranged: ucls(ra), melee: ucls(me), rangedRetreatShare: rr / span, meleeRetreatShare: mr / span, meleeSlowedShare: ms / span, meleeStunnedShare: mst / span, avgDistance: ds / span, meleeHpFracAtStart: F.hp(lockStart, me) / out.participants[me]!.maxHp, startS: (lockStart * tickMs) / 1000 });
    }
  }
  if (locked) {
    m.kiteLocks++;
    // …and is it TERMINAL: no melee hit on the ranged one from the lock's start to the end of the fight?
    let brokeLater = false;
    for (const t of meleeOnRanged) if (t >= lockStart) brokeLater = true;
    if (!brokeLater) {
      m.terminalKites++;
      if (out.endedBy === "TIME_LIMIT" && pa.alive && pm.alive) m.infiniteKites++;
    }
  }
  const maxR = cs.arenaRadius - cs.unitRadius;
  const stallTicks = Math.round(4000 / tickMs);
  for (const slot of [ra, me]) {
    let start = -1;
    for (let t = fromTick + 1; t <= toTick; t++) {
      const [x, y] = F.pos(t, slot);
      const atWall = Math.hypot(x, y) >= maxR - 2 && F.hp(t, slot) > 0;
      const exchanged = involved.get(slot)?.has(t) ?? false;
      if (!atWall || exchanged) {
        start = -1;
        continue;
      }
      if (start < 0) start = t;
      if (t - start >= stallTicks) {
        m.boundaryStalls++;
        break;
      }
    }
  }
}

export function summariseDuel(m: DuelMetrics) {
  return {
    fights: m.fights,
    rangedWinPct: pct(m.rangedWins, m.fights),
    meleeWinPct: pct(m.meleeWins, m.fights),
    drawPct: pct(m.draws, m.fights),
    timeoutPct: pct(m.timeouts, m.fights),
    overtimeFinishPct: pct(m.overtimeFinishes, m.fights),
    medianDurationS: r1(q(m.durationsMs, 0.5) / 1000),
    avgDistance: r1(m.avgDistance.reduce((a, x) => a + x, 0) / Math.max(1, m.avgDistance.length)),
    retreatTimePct: r1((m.retreatShare.reduce((a, x) => a + x, 0) / Math.max(1, m.retreatShare.length)) * 100),
    rangedShots: m.rangedShots,
    runningShots: m.runningShots,
    runningShotPct: pct(m.runningShots, m.rangedShots),
    kiteLocks: m.kiteLocks,
    terminalKites: m.terminalKites,
    infiniteKites: m.infiniteKites,
    boundaryStalls: m.boundaryStalls,
    committedViolations: m.committedViolations,
    committedNudges: m.committedNudges,
  };
}

/** 1v1 duels between two classes from the standard opposite spawn points (the seed decides who stands where). */
export function duel(rs: Ruleset, a: string, b: string, n: number, salt = "duel"): { aWins: number; bWins: number; draws: number; m: DuelMetrics | null } {
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  const mixed = RANGED(rs, a) !== RANGED(rs, b);
  const m = mixed ? emptyDuel() : null;
  for (let i = 0; i < n; i++) {
    const rng = createRng(`${salt}-${a}-${b}-${i}`);
    const units = [rollUnit(rs, rng, a, "A"), rollUnit(rs, rng, b, "B")];
    const out = simulateBattle({ seed: `${salt}-${a}-${b}-${i}`, ruleset: rs, units, maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs, recordFrames: mixed });
    const sa = out.slotOf.A as number;
    const sb = out.slotOf.B as number;
    const pa = out.participants[sa]!;
    const pb = out.participants[sb]!;
    if (pa.placement === 1 && pb.placement !== 1) aWins++;
    else if (pb.placement === 1) bWins++;
    else draws++;
    if (m) analyseDuel(rs, out, units, RANGED(rs, a) ? sa : sb, RANGED(rs, a) ? sb : sa, 0, m);
  }
  return { aWins, bWins, draws, m };
}

export interface FfaSummary {
  battles: number;
  duration: { median: number; p75: number; p90: number; p95: number; p99: number };
  timeoutPct: number;
  classWinPct: Record<string, number>;
  finalDuel: ReturnType<typeof summariseDuel> & { rangedVsMeleeFinals: number };
  /** Of all fighters still alive when a battle hits its cap. */
  overtimeFinishPct: number;
  /** EVERY ranged basic attack in every battle (not just finals): shots released on the run (≥ ½ step in the committed window) and with any nudge. */
  commitment: { rangedShots: number; violations: number; nudges: number };
  /** Mean nearest-neighbour distance between living fighters, and how often two of them are closer than 24 units (a visual "stack"). */
  spacing: { meanNearest: number; stackedPct: number };
  aliveAtCap: Record<string, number>;
  wallClockMs: number;
}

/** Free-for-all battles (the Arena), common random numbers: battle `b` uses the same lineup and seed under every ruleset. */
export function ffa(rs: Ruleset, battles: number): FfaSummary {
  const classIds = Object.keys(rs.classes);
  const wins: Record<string, number> = {};
  const apps: Record<string, number> = {};
  const durations: number[] = [];
  let timeouts = 0;
  let overtime = 0;
  const aliveAtCap: Record<string, number> = {};
  const final = emptyDuel();
  let nearestSum = 0;
  let nearestN = 0;
  let stacked = 0;
  const commitment = { rangedShots: 0, violations: 0, nudges: 0 };
  const t0 = performance.now();
  for (let b = 0; b < battles; b++) {
    const rng = createRng(`balance-${b}`);
    const units: CombatUnitInput[] = [];
    for (let i = 0; i < 8; i++) units.push(rollUnit(rs, rng, rng.pick(classIds), `c${i}`));
    const out = simulateBattle({ seed: `seed-${b}`, ruleset: rs, units, maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs, recordFrames: true });
    durations.push(out.durationMs);
    if (out.endedBy === "TIME_LIMIT") {
      timeouts++;
      for (const p of out.participants) if (p.alive) {
        const cls = units.find((u) => u.characterId === p.characterId)!.classId;
        aliveAtCap[cls] = (aliveAtCap[cls] ?? 0) + 1;
      }
    }
    if (out.durationMs > rs.combat.overtime.startMs) overtime++;
    for (const p of out.participants) {
      const cls = units.find((u) => u.characterId === p.characterId)!.classId;
      apps[cls] = (apps[cls] ?? 0) + 1;
      if (p.placement === 1) wins[cls] = (wins[cls] ?? 0) + 1;
    }
    const F = framesOf(out);
    for (const e of out.events) {
      if (e[1] !== EV.ATTACK || !(e[5] & EV_FLAG.PROJECTILE) || !(e[5] & EV_FLAG.BASIC)) continue;
      const u = units.find((x) => x.characterId === out.participants[e[2]]!.characterId)!;
      const step = ((rs.classes[u.classId]!.moveSpeed + u.stats.agi * rs.combat.derive.moveSpeedPerAgi) / rs.combat.pace.move) * (out.tickMs / 1000);
      commitment.rangedShots++;
      const worst = committedMove(F, e[2], e[0], out.ticks);
      if (worst !== null && worst >= 0.5 * step) commitment.violations++;
      else if (worst !== null && worst > 0) commitment.nudges++;
    }
    // spacing (every 5th tick)
    for (let t = 5; t <= out.ticks; t += 5) {
      const alive = out.participants.map((p) => p.slot).filter((s) => F.hp(t, s) > 0);
      for (const s of alive) {
        const [x, y] = F.pos(t, s);
        let best = Infinity;
        for (const o of alive) if (o !== s) best = Math.min(best, Math.hypot(x - F.pos(t, o)[0], y - F.pos(t, o)[1]));
        if (best < Infinity) {
          nearestSum += best;
          nearestN++;
          if (best < 24) stacked++;
        }
      }
    }
    // the final duel: the first tick with exactly two alive
    let finalTick = -1;
    for (let t = 1; t <= out.ticks; t++) {
      if (out.participants.filter((p) => F.hp(t, p.slot) > 0).length === 2) {
        finalTick = t;
        break;
      }
    }
    if (finalTick > 0) {
      const two = out.participants.filter((p) => F.hp(finalTick, p.slot) > 0);
      const cls = two.map((p) => units.find((u) => u.characterId === p.characterId)!.classId);
      const r = cls.map((c) => RANGED(rs, c));
      if (r[0] !== r[1]) analyseDuel(rs, out, units, two[r[0] ? 0 : 1]!.slot, two[r[0] ? 1 : 0]!.slot, finalTick, final);
    }
  }
  return {
    battles,
    duration: { median: r1(q(durations, 0.5) / 1000), p75: r1(q(durations, 0.75) / 1000), p90: r1(q(durations, 0.9) / 1000), p95: r1(q(durations, 0.95) / 1000), p99: r1(q(durations, 0.99) / 1000) },
    timeoutPct: pct(timeouts, battles),
    classWinPct: Object.fromEntries(classIds.map((c) => [c, pct(wins[c] ?? 0, apps[c] ?? 0)])),
    finalDuel: { ...summariseDuel(final), rangedVsMeleeFinals: final.fights },
    overtimeFinishPct: pct(overtime, battles),
    commitment,
    spacing: { meanNearest: r1(nearestSum / Math.max(1, nearestN)), stackedPct: pct(stacked, nearestN) },
    aliveAtCap,
    wallClockMs: Math.round(performance.now() - t0),
  };
}

export const defaultRuleset = buildDefaultRuleset;
