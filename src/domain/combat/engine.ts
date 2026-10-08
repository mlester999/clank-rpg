import { LEGACY_RING_RULES_VERSION, type ClassDef, type SkillDef, type SkillEffect } from "../rules";
import type { CombatSettings } from "../settings";
import { clamp } from "../util/math";
import { sha256Hex } from "../util/hash";
import { createRng, type Rng } from "../util/rng";

import { rankStandings, type Standing } from "./ranking";
import {
  EV,
  EV_FLAG,
  FRAME_FLAG,
  FRAME_STRIDE,
  STATUS_CODE,
  type BattleInput,
  type BattleOutcome,
  type CombatUnitInput,
  type EventTuple,
  type ParticipantOutcome,
} from "./types";

/**
 * Deterministic, server-authoritative battle simulation.
 *
 *   outcome = simulateBattle(snapshot, seed, ruleset)         (pure function)
 *
 * Determinism guarantees:
 *  - fixed 100 ms tick, integer-seeded RNG (sfc32), no trigonometry (only + − × ÷ √)
 *  - units iterate in slot order; per-tick effect resolution order is a seeded shuffle
 *  - all decisions in a tick read the state at the START of the tick, damage is applied
 *    simultaneously, and deaths are processed after all damage — so mutual kills are possible
 *    and slot order never decides who "got there first"
 *
 * The Arena has a STATIC boundary (rules 2.0.0): fighters move inside a fixed radius and the wall stops them. There is no
 * zone, no zone damage and no forced movement toward the centre, so ranged classes keep their spacing as part of their
 * identity — melee closes the distance, and the finite wall (not a shrinking ring) is what stops endless kiting.
 *
 * Pacing (rules 3.0.0): `combat.pace` stretches every class-defined duration by `time` and slows movement / projectiles by `move`,
 * so fights last roughly twice as long WITHOUT editing a single class or skill (median ≈ 37 s, hard cap 60 s; docs/COMBAT.md).
 *
 * Pressure toward eliminations (so 8 fighters usually become 1 well inside the cap):
 *  - overtime: all damage dealt ramps up after a configured time
 *
 * LEGACY: rules 1.0.0 had a closing "storm ring". Battles stored under it replay through the clearly marked `legacyRing`
 * paths below (and nowhere else), so their stored event hashes keep verifying. No new battle can reach them.
 *
 * Bump COMBAT_RULES_VERSION in rules.ts on ANY behavioural change here.
 */

const DIRS16: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [0.9238795325112867, 0.3826834323650898], [0.7071067811865476, 0.7071067811865476],
  [0.3826834323650898, 0.9238795325112867], [0, 1], [-0.3826834323650898, 0.9238795325112867],
  [-0.7071067811865476, 0.7071067811865476], [-0.9238795325112867, 0.3826834323650898], [-1, 0],
  [-0.9238795325112867, -0.3826834323650898], [-0.7071067811865476, -0.7071067811865476],
  [-0.3826834323650898, -0.9238795325112867], [0, -1], [0.3826834323650898, -0.9238795325112867],
  [0.7071067811865476, -0.7071067811865476], [0.9238795325112867, -0.3826834323650898],
];

interface StatusState {
  stunUntil: number;
  slowAmt: number;
  slowUntil: number;
  shield: number;
  shieldUntil: number;
  dodgeBuff: number;
  dodgeUntil: number;
  dmgBuff: number;
  dmgUntil: number;
  aspdBuff: number;
  aspdUntil: number;
  moveBuff: number;
  moveUntil: number;
  takenBuff: number;
  takenUntil: number;
  empowerMult: number;
  empowerUntil: number;
  tauntedBy: number;
  tauntUntil: number;
}

interface Unit {
  i: number;
  input: CombatUnitInput;
  cls: ClassDef;
  skills: SkillDef[];
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  atkStr: number;
  atkInt: number;
  dr: number;
  crit: number;
  dodge: number;
  aspdMult: number;
  moveSpeed: number;
  cdr: number;
  attackCd: number;
  skillCd: number[];
  cast: { skillIdx: number; endTick: number; target: number } | null;
  st: StatusState;
  target: number;
  lethalBy: number;
  regenAcc: number;
  moveX: number;
  moveY: number;
  /** Plant-to-fire: no movement before this tick (ranged fighters, rules 2.0.0+). */
  rootUntil: number;
  // ---- rules 3.1.0 ENGAGEMENT (untouched — and unread — by every earlier ruleset) ----
  /** Committed basic attack: 0 none · 1 WINDUP (released at `atkUntil`) · 2 RECOVER (free again at `atkUntil`). */
  atkPhase: 0 | 1 | 2;
  atkUntil: number;
  atkTarget: number;
  /**
   * Retreat STAMINA, in ticks of backing away: retreating drains 1 per tick; every other tick refills it (a full refill takes the reposition cooldown).
   * Empty → locked (stand and fight) until it is half full again. Quick hops stay possible; sustained kiting is not.
   */
  retreatBudget: number;
  retreatLocked: boolean;
  /** Position before this tick's movement (its last step is what a chaser predicts from). */
  lastX: number;
  lastY: number;
  /** Backing away from a threat THIS tick (frame flag RETREAT). */
  retreating: boolean;
  /** `retreating` as it was at the start of this tick (what a pursuer reads). */
  retreatedLastTick: boolean;
  /**
   * Committed and standing still THIS tick (aiming, releasing, recovering, casting, stunned). A planted fighter holds its ground: separation moves
   * whoever walked into it instead (rules 3.1.0) — an archer is never shoved across the floor while it aims.
   */
  planted: boolean;
  ranged: boolean;
  windupTicks: number;
  recoveryTicks: number;
  preferredRange: number;
  dangerRange: number;
  /** Basic-attack cadence multiplier (rules 3.1.0 class override; 1 otherwise). */
  intervalMult: number;
  /** Speed multiplier while chasing a target that is backing away (melee, rules 3.1.0). */
  chaseMult: number;
  // outcome counters
  eliminations: number;
  dealt: number;
  taken: number;
  healed: number;
  eliminatedAtTick: number | null;
  killedBy: number | null;
}

type Effect =
  | { kind: "basic"; from: number; to: number }
  | { kind: "skill"; from: number; to: number; skillIdx: number };

interface Projectile {
  arriveTick: number;
  from: number;
  to: number;
}

const newStatus = (): StatusState => ({
  stunUntil: 0, slowAmt: 0, slowUntil: 0, shield: 0, shieldUntil: 0, dodgeBuff: 0, dodgeUntil: 0,
  dmgBuff: 0, dmgUntil: 0, aspdBuff: 0, aspdUntil: 0, moveBuff: 0, moveUntil: 0, takenBuff: 0, takenUntil: 0,
  empowerMult: 1, empowerUntil: 0, tauntedBy: -1, tauntUntil: 0,
});

/** Deterministic starting position for a slot (also used by the UI before any simulation exists). */
export function startPositionFor(slot: number, fighters: number, startRadius: number): [number, number] {
  const dir = DIRS16[Math.floor((slot * 16) / fighters)] as readonly [number, number];
  return [Math.round(dir[0] * startRadius * 10) / 10, Math.round(dir[1] * startRadius * 10) / 10];
}

export function simulateBattle(input: BattleInput): BattleOutcome {
  const { ruleset } = input;
  const cs: CombatSettings = ruleset.combat;
  const d = cs.derive;
  const tickMs = cs.tickMs;
  const dt = tickMs / 1000;
  const toTicks = (ms: number) => Math.max(1, Math.ceil(ms / tickMs));
  // PACE (rules 3.0.0+): `T` stretches every class-defined duration, `M` slows movement and projectiles. At 1 / 1 each use below is an
  // exact no-op (x * 1 and x / 1 are exact in IEEE-754), so every earlier ruleset replays bit for bit.
  const T = cs.pace.time;
  const M = cs.pace.move;
  const toTicksT = (ms: number) => toTicks(ms * T);
  const maxTicks = Math.floor(Math.min(input.maxCombatMs, 120_000) / tickMs);
  /** Ticks a ranged fighter stands still after each basic attack (0 = free kiting). */
  const plantTicks = cs.rangedPlantMs > 0 ? toTicksT(cs.rangedPlantMs) : 0;
  /** Rules 3.1.0+ only (undefined for every earlier ruleset, which therefore takes exactly the code path it always took). */
  const eng = cs.engagement;
  const ticksT0 = (ms: number) => (ms > 0 ? toTicksT(ms) : 0);

  // Rules 1.0.0 ONLY: the retired shrinking storm ring (see the header). Null for every current ruleset.
  const legacyRing = ruleset.rulesVersion === LEGACY_RING_RULES_VERSION && cs.ring !== undefined ? cs.ring : null;

  const master = createRng(input.seed);
  const rng: Rng = master.fork("combat");
  const n = input.units.length;
  if (n < 2) throw new RangeError("a battle needs at least 2 fighters");
  if (n > 16) throw new RangeError("a battle supports at most 16 fighters");

  // --- slots: the seed (not input order) decides who starts where ------------------------
  const slotOrder = master.fork("slots").shuffle(input.units.map((_, idx) => idx));
  const skillIdList: string[] = [];
  const skillIndex = (id: string): number => {
    let idx = skillIdList.indexOf(id);
    if (idx < 0) {
      skillIdList.push(id);
      idx = skillIdList.length - 1;
    }
    return idx;
  };

  const units: Unit[] = slotOrder.map((inputIdx, slot) => {
    const u = input.units[inputIdx] as CombatUnitInput;
    const cls = ruleset.classes[u.classId];
    if (!cls) throw new Error(`unknown class ${u.classId}`);
    const skills = cls.skills.map((id) => {
      const s = ruleset.skills[id];
      if (!s) throw new Error(`class ${cls.id} references unknown skill ${id}`);
      return s;
    });
    const dir = DIRS16[Math.floor((slot * 16) / n)] as readonly [number, number];
    const stats = u.stats;
    const maxHp = Math.max(1, Math.round(stats.hp * cs.hpScale));
    let crit = clamp(stats.luck * d.critPerLuck, 0, d.maxCrit);
    for (const t of cls.traits) if (t.type === "crit_bonus") crit = clamp(crit + t.amount, 0, d.maxCrit);
    return {
      i: slot,
      input: u,
      cls,
      skills,
      x: dir[0] * cs.startRadius,
      y: dir[1] * cs.startRadius,
      hp: maxHp,
      maxHp,
      alive: true,
      atkStr: stats.str * d.atkPerStr,
      atkInt: stats.int * d.atkPerInt,
      dr: clamp(stats.def / (stats.def + d.defK), 0, d.maxDamageReduction),
      crit,
      dodge: clamp(stats.agi * d.dodgePerAgi + stats.luck * d.dodgePerLuck, 0, d.maxDodge),
      aspdMult: 1 + stats.agi * d.attackSpeedPerAgi,
      moveSpeed: (cls.moveSpeed + stats.agi * d.moveSpeedPerAgi) / M,
      cdr: clamp(stats.cha * d.cooldownReductionPerCha, 0, d.maxCooldownReduction),
      attackCd: 0,
      skillCd: skills.map(() => 0),
      cast: null,
      st: newStatus(),
      target: -1,
      lethalBy: -1,
      regenAcc: 0,
      moveX: 0,
      moveY: 0,
      rootUntil: 0,
      atkPhase: 0,
      atkUntil: 0,
      atkTarget: -1,
      retreatBudget: eng ? Math.max(1, ticksT0(eng.retreatMaxMs)) : 0,
      retreatLocked: false,
      lastX: dir[0] * cs.startRadius,
      lastY: dir[1] * cs.startRadius,
      retreating: false,
      planted: false,
      retreatedLastTick: false,
      ranged: cls.attack.projectileSpeed > 0,
      windupTicks: eng ? ticksT0(eng.classes[cls.id]?.windupMs ?? (cls.attack.projectileSpeed > 0 ? eng.windupMs.ranged : eng.windupMs.melee)) : 0,
      recoveryTicks: eng ? ticksT0(eng.classes[cls.id]?.recoveryMs ?? (cls.attack.projectileSpeed > 0 ? eng.recoveryMs.ranged : eng.recoveryMs.melee)) : 0,
      preferredRange: eng?.classes[cls.id]?.preferredRange ?? cls.ai.preferredRange,
      dangerRange: eng?.classes[cls.id]?.dangerRange ?? cls.ai.kiteBelow,
      intervalMult: eng?.classes[cls.id]?.intervalMult ?? 1,
      chaseMult: eng ? (eng.classes[cls.id]?.chaseMult ?? eng.chaseMult) : 1,
      eliminations: 0,
      dealt: 0,
      taken: 0,
      healed: 0,
      eliminatedAtTick: null,
      killedBy: null,
    };
  });
  const U = (i: number): Unit => units[i] as Unit;
  // Analysis tooling only (see BattleInput.scenario): a measured situation as the starting point. Never set by the Arena.
  if (input.scenario) {
    for (const u of units) {
      const st = input.scenario.start[input.units.indexOf(u.input)];
      if (!st) continue;
      u.x = u.lastX = st.x;
      u.y = u.lastY = st.y;
      if (st.hpFrac !== undefined) u.hp = Math.max(1, Math.min(u.maxHp, Math.round(u.maxHp * st.hpFrac)));
      if (st.skillReadyMs) st.skillReadyMs.forEach((ms, s) => { if (s < u.skillCd.length) u.skillCd[s] = Math.max(0, Math.ceil(ms / tickMs)); });
    }
  }

  const events: EventTuple[] = [];
  const emit = (tick: number, kind: number, a: number, b: number, value = 0, flags = 0) => {
    events.push([tick, kind, a, b, Math.round(value), flags]);
  };
  const frames: number[] | undefined = input.recordFrames ? [] : undefined;

  const dist = (a: Unit, b: Unit): number => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
  /** LEGACY (rules 1.0.0 only). The arena boundary itself never moves in any current ruleset. */
  const ringRadiusAt = (tick: number): number => {
    const t = tick * tickMs;
    const r = legacyRing;
    if (!r) return cs.arenaRadius;
    if (t <= r.startMs) return cs.arenaRadius;
    if (t >= r.endMs) return r.minRadius;
    return cs.arenaRadius + ((r.minRadius - cs.arenaRadius) * (t - r.startMs)) / (r.endMs - r.startMs);
  };
  const aliveEnemies = (u: Unit): Unit[] => units.filter((o) => o.alive && o.i !== u.i);
  const enemiesWithin = (u: Unit, radius: number): Unit[] => aliveEnemies(u).filter((o) => dist(u, o) <= radius);

  const recordFrame = (tick: number) => {
    if (!frames) return;
    for (const u of units) {
      let flags = 0;
      if (u.alive) flags |= FRAME_FLAG.ALIVE;
      if (u.st.stunUntil > tick) flags |= FRAME_FLAG.STUNNED;
      if (u.cast) flags |= FRAME_FLAG.CASTING;
      if (u.st.shield > 0 && u.st.shieldUntil > tick) flags |= FRAME_FLAG.SHIELDED;
      if (u.st.slowUntil > tick) flags |= FRAME_FLAG.SLOWED;
      if (u.st.dodgeUntil > tick || u.st.dmgUntil > tick || u.st.aspdUntil > tick || u.st.moveUntil > tick) flags |= FRAME_FLAG.BUFFED;
      if (u.st.empowerUntil > tick && u.st.empowerMult > 1) flags |= FRAME_FLAG.EMPOWERED;
      if (u.st.tauntUntil > tick) flags |= FRAME_FLAG.TAUNTED;
      if (u.alive && u.atkPhase === 1) flags |= FRAME_FLAG.WINDUP;
      if (u.alive && u.atkPhase === 2) flags |= FRAME_FLAG.RECOVER;
      if (u.alive && u.retreating) flags |= FRAME_FLAG.RETREAT;
      frames.push(Math.round(u.x * 10), Math.round(u.y * 10), Math.max(0, u.hp), flags, u.target + 1);
    }
  };

  const startPositions = units.map((u) => [Math.round(u.x * 10) / 10, Math.round(u.y * 10) / 10] as [number, number]);
  recordFrame(0);

  // --- damage ------------------------------------------------------------------------
  const globalDamageMult = (tick: number): number => {
    const t = tick * tickMs;
    return 1 + cs.overtime.damageRampPerSec * Math.max(0, (t - cs.overtime.startMs) / 1000);
  };

  /**
   * Rules 3.1.0: healing (spells, lifesteal, regeneration) fades during OVERTIME — overtime exists to end a fight, and sustain that outlasts the
   * damage ramp turned a long duel into a foregone conclusion (`overtimeHealCut` per second of overtime, down to nothing). 1 otherwise.
   */
  const healMult = (tick: number): number => {
    if (!eng || eng.overtimeHealCut <= 0) return 1;
    const otSec = (tick * tickMs - cs.overtime.startMs) / 1000;
    return otSec <= 0 ? 1 : Math.max(0, 1 - eng.overtimeHealCut * otSec);
  };
  const heal = (tick: number, healer: Unit, target: Unit, amount: number, flags = 0) => {
    if (eng) amount *= healMult(tick);
    if (!target.alive || amount <= 0) return;
    const applied = Math.min(Math.round(amount), target.maxHp - target.hp);
    if (applied <= 0) return;
    target.hp += applied;
    healer.healed += applied;
    emit(tick, EV.HEAL, healer.i, target.i, applied, flags);
  };

  const dealDamage = (
    tick: number,
    att: Unit,
    vic: Unit,
    scale: number,
    stat: "str" | "int",
    opts: { aoe: boolean; basic: boolean; lowHpBonus?: number; lifesteal?: number },
  ): number => {
    if (!vic.alive) return 0;
    if (!opts.aoe) {
      let dodge = clamp(vic.dodge + (vic.st.dodgeUntil > tick ? vic.st.dodgeBuff : 0), 0, 0.75);
      // Rules 3.1.0: a ranged basic attack is AIMED (the shooter stood still for it), and an aimed shot is harder to slip (`aimedDodge` × dodge).
      if (eng && opts.basic && att.ranged) dodge *= eng.aimedDodge;
      if (rng.next() < dodge) {
        emit(tick, EV.MISS, att.i, vic.i, 0, opts.basic ? EV_FLAG.BASIC : 0);
        return 0;
      }
    }
    let power = (stat === "str" ? att.atkStr : att.atkInt) * scale;
    let mult = globalDamageMult(tick);
    if (att.st.dmgUntil > tick) mult *= 1 + att.st.dmgBuff;
    for (const t of att.cls.traits) {
      if (t.type === "low_hp_damage" && att.hp / att.maxHp < t.below) mult *= 1 + t.bonus;
    }
    if (opts.lowHpBonus && vic.hp / vic.maxHp < 0.35) mult *= 1 + opts.lowHpBonus;
    if (opts.basic && att.st.empowerUntil > tick && att.st.empowerMult > 1) {
      mult *= att.st.empowerMult;
      att.st.empowerMult = 1;
      att.st.empowerUntil = 0;
    }
    const variance = 1 + (rng.next() * 2 - 1) * d.damageVariance;
    const isCrit = rng.next() < att.crit;
    const defEff = vic.input.stats.def * (stat === "int" ? 1 - d.magicPenetration : 1);
    const dr = clamp(defEff / (defEff + d.defK), 0, d.maxDamageReduction);
    let taken = 1;
    for (const t of vic.cls.traits) if (t.type === "damage_taken_mult") taken *= t.mult;
    if (vic.st.takenUntil > tick) taken *= 1 + vic.st.takenBuff;
    power *= mult * variance * (isCrit ? d.critMultiplier : 1) * (1 - dr) * taken;
    const dmg = Math.max(1, Math.round(power));

    let remaining = dmg;
    if (vic.st.shield > 0 && vic.st.shieldUntil > tick) {
      const absorbed = Math.min(vic.st.shield, remaining);
      vic.st.shield -= absorbed;
      remaining -= absorbed;
    }
    const wasAboveZero = vic.hp > 0;
    vic.hp -= remaining;
    att.dealt += dmg;
    vic.taken += dmg;
    let flags = 0;
    if (isCrit) flags |= EV_FLAG.CRIT;
    if (opts.aoe) flags |= EV_FLAG.AOE;
    if (opts.basic) flags |= EV_FLAG.BASIC;
    emit(tick, EV.HIT, att.i, vic.i, dmg, flags);
    if (wasAboveZero && vic.hp <= 0 && vic.lethalBy < 0) vic.lethalBy = att.i;
    if (opts.lifesteal) heal(tick, att, att, dmg * opts.lifesteal, EV_FLAG.LIFESTEAL);
    return dmg;
  };

  // --- skills ------------------------------------------------------------------------
  const applySlow = (tick: number, victim: Unit, source: Unit, amount: number, ms: number) => {
    if (!victim.alive) return;
    victim.st.slowAmt = Math.max(victim.st.slowUntil > tick ? victim.st.slowAmt : 0, amount);
    victim.st.slowUntil = Math.max(victim.st.slowUntil, tick + toTicksT(ms));
    emit(tick, EV.STATUS, victim.i, source.i, STATUS_CODE.SLOW);
  };
  const applyStun = (tick: number, victim: Unit, source: Unit, ms: number) => {
    if (!victim.alive) return;
    victim.st.stunUntil = Math.max(victim.st.stunUntil, tick + toTicksT(ms));
    if (victim.cast) victim.cast = null; // stun interrupts casting
    emit(tick, EV.STATUS, victim.i, source.i, STATUS_CODE.STUN);
  };

  const clampToArena = (u: Unit) => {
    const maxR = cs.arenaRadius - cs.unitRadius;
    const r = Math.sqrt(u.x * u.x + u.y * u.y);
    if (r > maxR) {
      u.x = (u.x / r) * maxR;
      u.y = (u.y / r) * maxR;
    }
  };

  const resolveSkillEffect = (tick: number, caster: Unit, target: Unit | null, skill: SkillDef, eff: SkillEffect) => {
    switch (eff.type) {
      case "damage": {
        let victims: Unit[] = [];
        const radius = eff.radius ?? skill.range;
        if (eff.shape === "target") victims = target && target.alive ? [target] : [];
        else if (eff.shape === "aoe_self") victims = enemiesWithin(caster, radius);
        else if (eff.shape === "aoe_target") {
          if (target && target.alive) victims = aliveEnemies(caster).filter((o) => Math.sqrt((o.x - target.x) ** 2 + (o.y - target.y) ** 2) <= radius);
        } else {
          victims = enemiesWithin(caster, radius)
            .sort((a, b) => dist(caster, a) - dist(caster, b) || a.i - b.i)
            .slice(0, eff.count ?? 3);
        }
        for (const v of victims) {
          const done = dealDamage(tick, caster, v, eff.scale, eff.stat, {
            aoe: eff.shape !== "target",
            basic: false,
            ...(eff.lowHpBonus !== undefined ? { lowHpBonus: eff.lowHpBonus } : {}),
            ...(eff.lifesteal !== undefined ? { lifesteal: eff.lifesteal } : {}),
          });
          if (done > 0) {
            if (eff.slow) applySlow(tick, v, caster, eff.slow.amount, eff.slow.ms);
            if (eff.stunMs) applyStun(tick, v, caster, eff.stunMs);
          }
        }
        break;
      }
      case "dash": {
        if (!target) break;
        const dx = target.x - caster.x;
        const dy = target.y - caster.y;
        const dd = Math.sqrt(dx * dx + dy * dy) || 1;
        let nx: number;
        let ny: number;
        if (eff.mode === "behind_target") {
          nx = target.x + (dx / dd) * cs.unitRadius * 1.8;
          ny = target.y + (dy / dd) * cs.unitRadius * 1.8;
        } else if (eff.mode === "away_from_target") {
          nx = caster.x - (dx / dd) * eff.distance;
          ny = caster.y - (dy / dd) * eff.distance;
        } else {
          const travel = Math.max(0, Math.min(eff.distance, dd - cs.unitRadius * 2));
          nx = caster.x + (dx / dd) * travel;
          ny = caster.y + (dy / dd) * travel;
        }
        caster.x = nx;
        caster.y = ny;
        clampToArena(caster);
        emit(tick, EV.DASH, caster.i, target.i, 0);
        break;
      }
      case "shield": {
        const amount = eff.flat + eff.perDef * caster.input.stats.def + eff.perInt * caster.input.stats.int + eff.perMaxHp * caster.maxHp;
        caster.st.shield = Math.max(caster.st.shieldUntil > tick ? caster.st.shield : 0, Math.round(amount));
        caster.st.shieldUntil = tick + toTicksT(eff.ms);
        emit(tick, EV.SHIELD, caster.i, caster.i, amount);
        break;
      }
      case "heal": {
        const amount = eff.flat + eff.perInt * caster.input.stats.int + eff.perCha * caster.input.stats.cha + eff.perMaxHp * caster.maxHp;
        heal(tick, caster, caster, amount);
        break;
      }
      case "buff": {
        const until = tick + toTicksT(eff.ms);
        if (eff.stat === "dodge") { caster.st.dodgeBuff = eff.amount; caster.st.dodgeUntil = until; }
        else if (eff.stat === "damage") { caster.st.dmgBuff = eff.amount; caster.st.dmgUntil = until; }
        else if (eff.stat === "attackSpeed") { caster.st.aspdBuff = eff.amount; caster.st.aspdUntil = until; }
        else if (eff.stat === "moveSpeed") { caster.st.moveBuff = eff.amount; caster.st.moveUntil = until; }
        else { caster.st.takenBuff = eff.amount; caster.st.takenUntil = until; }
        emit(tick, EV.STATUS, caster.i, caster.i, eff.stat === "dodge" ? STATUS_CODE.DODGE : STATUS_CODE.BUFF);
        break;
      }
      case "taunt": {
        for (const o of enemiesWithin(caster, eff.radius)) {
          o.st.tauntedBy = caster.i;
          o.st.tauntUntil = tick + toTicksT(eff.ms);
          emit(tick, EV.STATUS, o.i, caster.i, STATUS_CODE.TAUNT);
        }
        break;
      }
      case "empower": {
        caster.st.empowerMult = eff.multiplier;
        caster.st.empowerUntil = tick + toTicksT(eff.ms);
        emit(tick, EV.STATUS, caster.i, caster.i, STATUS_CODE.EMPOWER);
        break;
      }
    }
  };

  // --- AI -----------------------------------------------------------------------------
  const tacticOf = (u: Unit) => cs.tactics[u.input.tactic];

  const pickTarget = (u: Unit): number => {
    const tac = tacticOf(u);
    const w = u.cls.ai.targetWeights;
    let best = -1;
    let bestScore = -Infinity;
    for (const e of units) {
      if (!e.alive || e.i === u.i) continue;
      const distScore = 1 - clamp(dist(u, e) / (2 * cs.arenaRadius), 0, 1);
      const lowHpScore = 1 - e.hp / e.maxHp;
      const threat = e.target === u.i ? 1 : 0;
      const score =
        w.distance * distScore +
        (w.lowHp + tac.lowHpTargeting) * lowHpScore +
        w.threat * threat +
        (u.cls.ai.classBias[e.input.classId] ?? 0) +
        (e.i === u.target ? 0.3 : 0) +
        (rng.next() - 0.5) * 0.1;
      if (score > bestScore) {
        bestScore = score;
        best = e.i;
      }
    }
    return best;
  };

  const skillReady = (u: Unit, idx: number, tick: number): boolean => (u.skillCd[idx] as number) <= tick;

  const skillWantsToFire = (u: Unit, skill: SkillDef, target: Unit | null): boolean => {
    const tac = tacticOf(u);
    const hpFrac = u.hp / u.maxHp;
    const minEnemies = skill.ai.minEnemies ?? 1;
    const reach = skill.effects.reduce((r, e) => (e.type === "damage" && e.radius ? Math.max(r, e.radius) : r), skill.range);
    switch (skill.ai.when) {
      case "low_hp": {
        const threshold = clamp(((skill.ai.hpBelow ?? 0.5) * tac.defensiveSkillHp) / 0.5, 0, 1);
        return hpFrac < threshold && enemiesWithin(u, 260).length > 0;
      }
      case "crowded":
        return enemiesWithin(u, reach).length >= minEnemies;
      case "opener": {
        if (!target) return false;
        const dd = dist(u, target);
        // Rules 3.1.0: a gap-closer (Piston Charge, Shadowstep) is not a way to skip a ranged fighter's whole reach — it fires only once the
        // dasher has walked into that reach (`openerReach` × the target's attack range), so the archer / caster always gets its window first.
        if (eng && eng.openerReach > 0 && target.ranged && dd > target.cls.attack.range * eng.openerReach) return false;
        return dd > u.cls.attack.range * 1.4 && dd <= skill.range;
      }
      case "engage": {
        if (!target) return false;
        if (dist(u, target) > skill.range) return false;
        return enemiesWithin(u, skill.range).length >= minEnemies;
      }
    }
  };

  const decide = (u: Unit, tick: number, effects: Effect[], projectiles: Projectile[]) => {
    u.moveX = 0;
    u.moveY = 0;
    if (u.st.stunUntil > tick) return;

    if (u.cast) {
      if (u.cast.endTick <= tick) {
        effects.push({ kind: "skill", from: u.i, to: u.cast.target, skillIdx: u.cast.skillIdx });
        u.cast = null;
      }
      return;
    }

    // Targeting
    const taunter = u.st.tauntUntil > tick && u.st.tauntedBy >= 0 && U(u.st.tauntedBy).alive ? u.st.tauntedBy : -1;
    if (taunter >= 0) u.target = taunter;
    else if (u.target < 0 || !U(u.target).alive || (tick + u.i) % cs.retargetTicks === 0) u.target = pickTarget(u);
    if (u.target < 0) return;
    const target = U(u.target);
    const dd = dist(u, target);

    // Skills
    for (let s = 0; s < u.skills.length; s++) {
      const skill = u.skills[s] as SkillDef;
      if (!skillReady(u, s, tick)) continue;
      if (!skillWantsToFire(u, skill, target)) continue;
      u.skillCd[s] = tick + toTicks(skill.cooldownMs * T * (1 - u.cdr));
      emit(tick, EV.SKILL, u.i, target.i, skillIndex(skill.id));
      if (skill.castMs > 0) {
        u.cast = { skillIdx: s, endTick: tick + toTicksT(skill.castMs), target: target.i };
      } else {
        effects.push({ kind: "skill", from: u.i, to: target.i, skillIdx: s });
      }
      return;
    }

    // Basic attack
    const atk = u.cls.attack;
    if (dd <= atk.range && u.attackCd <= tick) {
      const aspd = u.aspdMult * (u.st.aspdUntil > tick ? 1 + u.st.aspdBuff : 1);
      u.attackCd = tick + toTicks((atk.intervalMs * T) / aspd);
      if (atk.projectileSpeed > 0) {
        const travel = Math.max(1, Math.ceil(dd / (atk.projectileSpeed / M) / dt));
        projectiles.push({ arriveTick: tick + travel, from: u.i, to: target.i });
        if (!legacyRing) u.rootUntil = tick + plantTicks;
        emit(tick, EV.ATTACK, u.i, target.i, travel, EV_FLAG.PROJECTILE | EV_FLAG.BASIC);
      } else {
        effects.push({ kind: "basic", from: u.i, to: target.i });
        emit(tick, EV.ATTACK, u.i, target.i, 0, EV_FLAG.BASIC);
      }
    }

    // Movement
    const tac = tacticOf(u);
    const centerDist = Math.sqrt(u.x * u.x + u.y * u.y);
    let dx = 0;
    let dy = 0;
    const away = (from: Unit): [number, number] => {
      const ax = u.x - from.x;
      const ay = u.y - from.y;
      const al = Math.sqrt(ax * ax + ay * ay) || 1;
      return [ax / al, ay / al];
    };
    const toward = (): [number, number] => {
      const tx = target.x - u.x;
      const ty = target.y - u.y;
      const tl = Math.sqrt(tx * tx + ty * ty) || 1;
      return [tx / tl, ty / tl];
    };

    if (legacyRing) {
      // ---- LEGACY (rules 1.0.0): ring-aware movement, kept byte-for-byte so stored battles still replay. ----
      const ringR = ringRadiusAt(tick);
      const inward = (): [number, number] => {
        const l = centerDist || 1;
        return [-u.x / l, -u.y / l];
      };
      if (centerDist > ringR - cs.unitRadius) {
        [dx, dy] = inward();
      } else if (u.hp / u.maxHp < tac.retreatHp) {
        const threats = enemiesWithin(u, 170);
        if (threats.length > 0) {
          const nearest = threats.reduce((a, b) => (dist(u, a) <= dist(u, b) ? a : b));
          const [ax, ay] = away(nearest);
          const [ix, iy] = inward();
          dx = ax + ix * (centerDist > ringR * 0.6 ? 0.9 : 0.2);
          dy = ay + iy * (centerDist > ringR * 0.6 ? 0.9 : 0.2);
        }
      } else {
        const ai = u.cls.ai;
        if (ai.preferredRange > 0) {
          const preferred = ai.preferredRange * (1 - tac.engageBonus * 0.3);
          if (ai.kiteBelow > 0 && dd < ai.kiteBelow) {
            const [ax, ay] = away(target);
            const [ix, iy] = inward();
            const wall = clamp((centerDist - ringR * 0.55) / (ringR * 0.45), 0, 1);
            dx = ax + ix * wall * 1.2;
            dy = ay + iy * wall * 1.2;
          } else if (dd > preferred) {
            [dx, dy] = toward();
          }
        } else if (dd > atk.range - 6) {
          [dx, dy] = toward();
        }
      }
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0) {
        const speed =
          u.moveSpeed *
          (u.st.slowUntil > tick ? 1 - u.st.slowAmt : 1) *
          (u.st.moveUntil > tick ? 1 + u.st.moveBuff : 1) *
          dt;
        let step = speed;
        if (!(centerDist > ringR - cs.unitRadius) && target.alive) {
          const stand = u.cls.ai.preferredRange > 0 ? 0 : Math.max(atk.range - 6, cs.unitRadius * 2);
          if (u.cls.ai.preferredRange === 0) step = Math.min(speed, Math.max(0, dd - stand));
        }
        u.moveX = (dx / len) * step;
        u.moveY = (dy / len) * step;
      }
      return;
    }

    // ---- Rules 2.0.0: a STATIC boundary. Nothing here knows about the wall except the clamp after movement. ----
    if (u.hp / u.maxHp < tac.retreatHp) {
      // Hurt: back away from the nearest threat (a unit with its back to the wall simply stays put — the wall is the limit).
      const threats = enemiesWithin(u, 170);
      if (threats.length > 0) {
        const nearest = threats.reduce((a, b) => (dist(u, a) <= dist(u, b) ? a : b));
        [dx, dy] = away(nearest);
      }
    } else {
      const ai = u.cls.ai;
      if (ai.preferredRange > 0) {
        // Ranged: hold the preferred spacing, step back when someone gets inside kiteBelow, otherwise close to range.
        const preferred = ai.preferredRange * (1 - tac.engageBonus * 0.3);
        if (ai.kiteBelow > 0 && dd < ai.kiteBelow) [dx, dy] = away(target);
        else if (dd > preferred) [dx, dy] = toward();
      } else if (dd > atk.range - 6) {
        // Melee: close the distance to striking range.
        [dx, dy] = toward();
      }
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0 && u.rootUntil <= tick) {
      const speed =
        u.moveSpeed *
        (u.st.slowUntil > tick ? 1 - u.st.slowAmt : 1) *
        (u.st.moveUntil > tick ? 1 + u.st.moveBuff : 1) *
        dt;
      let step = speed;
      // A melee fighter does not overshoot its target's striking distance.
      if (target.alive && u.cls.ai.preferredRange === 0) {
        const stand = Math.max(atk.range - 6, cs.unitRadius * 2);
        step = Math.min(speed, Math.max(0, dd - stand));
      }
      u.moveX = (dx / len) * step;
      u.moveY = (dy / len) * step;
    }
  };

  // --- AI, rules 3.1.0+: ENGAGEMENT ---------------------------------------------------------------------------------------------------------------
  // Fighters COMMIT: a basic attack is WINDUP → release → RECOVERY (ranged fighters plant for both — they never run and shoot at once), instant
  // skills telegraph, and a ranged fighter's retreat is a short burst with a cooldown, slower than walking forward, that slides along the wall
  // instead of into it. This whole function is reached only when the ruleset carries `combat.engagement`.
  const graceTicks = eng ? ticksT0(eng.skillGraceMs) : 0;
  const skillWindupTicks = eng ? ticksT0(eng.skillWindupMs) : 0;
  const retreatMaxTicks = eng ? Math.max(1, ticksT0(eng.retreatMaxMs)) : 0;
  const repositionTicks = eng ? ticksT0(eng.repositionCooldownMs) : 0;
  /** Stamina refilled per non-retreating tick: a full refill takes the reposition cooldown. */
  const retreatRefill = repositionTicks > 0 ? retreatMaxTicks / repositionTicks : retreatMaxTicks;

  /** Releases a committed basic attack at its target — or whiffs it if the target died or got clear while it wound up. */
  const releaseAttack = (u: Unit, tick: number, effects: Effect[], projectiles: Projectile[]): void => {
    const atk = u.cls.attack;
    const t = u.atkTarget >= 0 ? U(u.atkTarget) : null;
    const reach = u.ranged ? atk.range * 1.15 : atk.range * 1.25;
    if (!t || !t.alive || dist(u, t) > reach) {
      u.attackCd = tick + 1; // whiffed: ready to commit again straight away
      return;
    }
    const aspd = u.aspdMult * (u.st.aspdUntil > tick ? 1 + u.st.aspdBuff : 1);
    // Release-to-release cadence = the attack interval: the windup is taken OUT of the wait, never added to it.
    u.attackCd = tick + Math.max(1, toTicks((atk.intervalMs * T * u.intervalMult) / aspd) - u.windupTicks);
    if (u.ranged) {
      const travel = Math.max(1, Math.ceil(dist(u, t) / (atk.projectileSpeed / M) / dt));
      projectiles.push({ arriveTick: tick + travel, from: u.i, to: t.i });
      emit(tick, EV.ATTACK, u.i, t.i, travel, EV_FLAG.PROJECTILE | EV_FLAG.BASIC);
    } else {
      effects.push({ kind: "basic", from: u.i, to: t.i });
      emit(tick, EV.ATTACK, u.i, t.i, 0, EV_FLAG.BASIC);
    }
  };

  /** A retreat direction near the wall keeps only its component ALONG the wall (no grinding into it); null when cornered. */
  const slideAlongWall = (u: Unit, dx: number, dy: number, margin: number): [number, number] | null => {
    const cd = Math.sqrt(u.x * u.x + u.y * u.y);
    const maxR = cs.arenaRadius - cs.unitRadius;
    if (cd <= maxR - margin || cd < 1e-6) return [dx, dy];
    const nx = u.x / cd;
    const ny = u.y / cd;
    const out = dx * nx + dy * ny;
    if (out <= 0) return [dx, dy];
    const tx = dx - out * nx;
    const ty = dy - out * ny;
    const tl = Math.sqrt(tx * tx + ty * ty);
    return tl < 0.3 ? null : [tx / tl, ty / tl];
  };

  const decideEngaged = (u: Unit, tick: number, effects: Effect[], projectiles: Projectile[]) => {
    const e = eng as NonNullable<typeof eng>;
    u.moveX = 0;
    u.moveY = 0;
    u.retreating = false;
    u.planted = true; // every early return below is a commitment (stunned, casting, winding up, releasing, recovering) — except "no target"
    if (u.st.stunUntil > tick) {
      u.atkPhase = 0; // a stun breaks the commitment (the attack never lands)
      return;
    }
    if (u.cast) {
      if (u.cast.endTick <= tick) {
        effects.push({ kind: "skill", from: u.i, to: u.cast.target, skillIdx: u.cast.skillIdx });
        u.cast = null;
      }
      return; // casting (or telegraphing an instant skill): committed, no movement
    }

    // Targeting (as before)
    const taunter = u.st.tauntUntil > tick && u.st.tauntedBy >= 0 && U(u.st.tauntedBy).alive ? u.st.tauntedBy : -1;
    if (taunter >= 0) u.target = taunter;
    else if (u.atkPhase === 1 && u.atkTarget >= 0 && U(u.atkTarget).alive) u.target = u.atkTarget; // a wound-up attack keeps its target (and the hero keeps facing it)
    else if (u.target < 0 || !U(u.target).alive || (tick + u.i) % cs.retargetTicks === 0) u.target = pickTarget(u);
    if (u.target < 0) {
      u.planted = false;
      return;
    }
    const target = U(u.target);
    const dd = dist(u, target);
    const role: "melee" | "ranged" = u.ranged ? "ranged" : "melee";

    // A committed basic attack runs to its end.
    let moveMult = 1;
    if (u.atkPhase === 1) {
      if (tick < u.atkUntil) {
        moveMult = e.windupMove[role];
        if (moveMult <= 0) return;
      } else {
        releaseAttack(u, tick, effects, projectiles);
        if (u.recoveryTicks > 0) {
          u.atkPhase = 2;
          u.atkUntil = tick + u.recoveryTicks;
          moveMult = e.recoveryMove[role];
          if (moveMult <= 0) return;
        } else u.atkPhase = 0;
      }
    } else if (u.atkPhase === 2) {
      if (tick >= u.atkUntil) u.atkPhase = 0;
      else {
        moveMult = e.recoveryMove[role];
        if (moveMult <= 0) return;
      }
    }

    if (u.atkPhase === 0) {
      // Skills — never in the opening moments, and an instant skill telegraphs (the caster commits like a cast).
      if (tick >= graceTicks) {
        for (let s = 0; s < u.skills.length; s++) {
          const skill = u.skills[s] as SkillDef;
          if (!skillReady(u, s, tick)) continue;
          if (!skillWantsToFire(u, skill, target)) continue;
          u.skillCd[s] = tick + toTicks(skill.cooldownMs * T * (1 - u.cdr));
          emit(tick, EV.SKILL, u.i, target.i, skillIndex(skill.id));
          const castTicks = skill.castMs > 0 ? toTicksT(skill.castMs) : skillWindupTicks;
          if (castTicks > 0) u.cast = { skillIdx: s, endTick: tick + castTicks, target: target.i };
          else effects.push({ kind: "skill", from: u.i, to: target.i, skillIdx: s });
          return;
        }
      }
      // Basic attack: COMMIT (wind up). Ranged and melee alike stand still to wind up. A melee fighter does not start a swing at a RANGED target
      // that is backing away unless it is well inside reach (`runnerReach`) — it keeps closing and strikes when the archer / caster plants to shoot.
      // (Never tighter than the separation distance: fighters cannot get closer than that, so a stricter rule could never be met.)
      const runnerReachDist = Math.max(u.cls.attack.range * e.runnerReach, cs.unitRadius * e.separation + 2);
      const swingable = u.ranged || !(target.ranged && target.retreatedLastTick) || dd <= runnerReachDist;
      if (dd <= u.cls.attack.range && u.attackCd <= tick && swingable) {
        u.atkTarget = target.i;
        if (u.windupTicks > 0) {
          u.atkPhase = 1;
          u.atkUntil = tick + u.windupTicks;
          moveMult = e.windupMove[role];
          if (moveMult <= 0) return;
        } else {
          releaseAttack(u, tick, effects, projectiles);
          if (u.recoveryTicks > 0) {
            u.atkPhase = 2;
            u.atkUntil = tick + u.recoveryTicks;
            moveMult = e.recoveryMove[role];
            if (moveMult <= 0) return;
          }
        }
      }
    }

    // Movement.
    u.planted = false;
    const tac = tacticOf(u);
    const toward = (tx: number, ty: number): [number, number] => {
      const vx = tx - u.x;
      const vy = ty - u.y;
      const l = Math.sqrt(vx * vx + vy * vy) || 1;
      return [vx / l, vy / l];
    };
    const away = (from: Unit): [number, number] => {
      const ax = u.x - from.x;
      const ay = u.y - from.y;
      const al = Math.sqrt(ax * ax + ay * ay) || 1;
      return [ax / al, ay / al];
    };
    const hurt = u.hp / u.maxHp < tac.retreatHp;
    // TAUNTED: the taunter makes this fighter fight on its terms — no backing away while the taunt lasts (the Tank's answer to being kited).
    const taunted = taunter >= 0;
    let threat: Unit | null = null;
    if (taunted) threat = null;
    else if (hurt) {
      const threats = enemiesWithin(u, 170);
      if (threats.length > 0) threat = threats.reduce((a, b) => (dist(u, a) <= dist(u, b) ? a : b));
    } else if (u.ranged && u.dangerRange > 0 && dd < u.dangerRange) threat = target;

    let dx = 0;
    let dy = 0;
    let speedMult = moveMult;
    let stepCap = Infinity;
    if (threat && !u.retreatLocked && u.retreatBudget >= 1) {
      const dir = slideAlongWall(u, ...away(threat), e.wallMargin);
      if (dir) {
        [dx, dy] = dir;
        speedMult *= e.backpedal;
        u.retreating = true;
        u.retreatBudget -= 1;
        if (u.retreatBudget < 1) u.retreatLocked = true;
      }
    }
    // Not backing away — no threat, out of retreat stamina, or cornered: FIGHT. A ranged fighter holds or closes to its range; a melee fighter
    // closes in (a hurt fighter that cannot get away commits rather than standing still).
    if (!u.retreating) {
      if (u.ranged) {
        const preferred = u.preferredRange * (1 - tac.engageBonus * 0.3);
        if (dd > preferred) [dx, dy] = toward(target.x, target.y);
      } else {
        const stand = Math.max(u.cls.attack.range - 6, cs.unitRadius * 2);
        if (dd > u.cls.attack.range - 6) {
          // Gap-close: chase where the target is GOING (its last step, up to `leadTicks` ahead — no further than this chaser can cover), not
          // where it was: a backpedal or a slide along the wall is cut off instead of trailed forever.
          const lead = e.leadTicks > 0 ? Math.min(e.leadTicks, dd / Math.max(1e-6, u.moveSpeed * dt)) : 0;
          const tx = target.x + (target.x - target.lastX) * lead;
          const ty = target.y + (target.y - target.lastY) * lead;
          const pd = Math.sqrt((u.x - tx) ** 2 + (u.y - ty) ** 2) || 1;
          // Close to striking range — fanning out around a crowded target instead of stacking on the same side of it.
          let ax = (u.x - tx) / pd;
          let ay = (u.y - ty) / pd;
          if (e.flank > 0 && !target.retreatedLastTick && dd < stand * 3) {
            // Engage from a SIDE (left / right of the target, the way the fighters face), not from above or below it: blows read, and two
            // attackers on one target stand on OPPOSITE sides instead of stacking. Only on the final approach to a target that stands its ground
            // (a chase after a fleeing target stays a straight line). The side already held by a melee attacker that is closer to the
            // target than this one is left to it (the closer one never yields, so nobody swaps sides back and forth).
            let side = ax > 0 ? 1 : ax < 0 ? -1 : u.i % 2 === 0 ? 1 : -1;
            let held = 0;
            let free = true;
            for (const o of units) {
              if (!o.alive || o.i === u.i || o.i === target.i || o.ranged || o.target !== target.i) continue;
              const od = Math.sqrt((o.x - target.x) ** 2 + (o.y - target.y) ** 2);
              if (od > stand * 1.8) continue;
              if ((o.x - target.x) * side > 0) {
                if (od < dd) held++;
              } else free = false;
            }
            if (held > 0 && free) side = -side;
            ax += side * e.flank;
            const fl = Math.sqrt(ax * ax + ay * ay) || 1;
            ax /= fl;
            ay /= fl;
          }
          if (e.surround > 0) {
            for (const o of units) {
              if (!o.alive || o.i === u.i || o.i === target.i) continue;
              const od = Math.sqrt((o.x - target.x) ** 2 + (o.y - target.y) ** 2);
              if (od > stand * 1.8 || od < 1e-6) continue;
              const ox = (o.x - target.x) / od;
              const oy = (o.y - target.y) / od;
              const dot = ax * ox + ay * oy;
              if (dot <= 0.6) continue;
              let px = ax - dot * ox;
              let py = ay - dot * oy;
              const pl = Math.sqrt(px * px + py * py);
              if (pl < 1e-3) {
                px = u.i % 2 === 0 ? -oy : oy; // exactly behind another attacker: a deterministic side
                py = u.i % 2 === 0 ? ox : -ox;
              } else {
                px /= pl;
                py /= pl;
              }
              const k = e.surround * ((dot - 0.6) / 0.4);
              ax += px * k;
              ay += py * k;
              const al = Math.sqrt(ax * ax + ay * ay) || 1;
              ax /= al;
              ay /= al;
            }
          }
          const gx = tx + ax * stand;
          const gy = ty + ay * stand;
          [dx, dy] = toward(gx, gy);
          stepCap = Math.sqrt((gx - u.x) ** 2 + (gy - u.y) ** 2);
          // Pursuit: the target was backing away last tick — close the gap (only while it runs). Read from the start-of-tick snapshot, so slot order
          // never decides who gets it.
          if (target.retreatedLastTick) speedMult *= u.chaseMult;
        }
      }
    }
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0 && speedMult > 0) {
      const speed = u.moveSpeed * speedMult * (u.st.slowUntil > tick ? 1 - u.st.slowAmt : 1) * (u.st.moveUntil > tick ? 1 + u.st.moveBuff : 1) * dt;
      const step = Math.min(speed, stepCap);
      u.moveX = (dx / len) * step;
      u.moveY = (dy / len) * step;
    }
  };

  // --- main loop ----------------------------------------------------------------------
  let lastRingEmitted = Math.round(cs.arenaRadius); // LEGACY ring event bookkeeping (unused by current rules)
  let endedBy: "LAST_STANDING" | "TIME_LIMIT" = "TIME_LIMIT";
  let ticks = 0;
  const projectiles: Projectile[] = [];

  for (let tick = 1; tick <= maxTicks; tick++) {
    ticks = tick;
    const effects: Effect[] = [];

    // 1. decisions (read-only w.r.t. positions/hp)
    if (eng) {
      for (const u of units) u.retreatedLastTick = u.retreating;
      for (const u of units) if (u.alive) decideEngaged(u, tick, effects, projectiles);
      // Retreat stamina refills on every tick a fighter is NOT backing away (planted, casting, stunned, walking, fighting) — more and more slowly
      // once overtime begins (fatigue), so a late duel cannot be kited out to the clock.
      const otMs = tick * tickMs - cs.overtime.startMs;
      const fatigue = eng.fatigueMs > 0 && otMs > 0 ? Math.max(0.2, 1 - otMs / eng.fatigueMs) : 1;
      for (const u of units) {
        if (!u.alive || u.retreating) continue;
        // Late-fight pressure: in overtime, while an enemy that is CHASING this fighter (targeting it) is within reach, the legs do not recover —
        // a final duel cannot be kited out. (The opening brawl is untouched: escaping to open space still works there.)
        if (otMs > 0 && eng.safeRange > 0 && units.some((o) => o.alive && o.i !== u.i && o.target === u.i && dist(u, o) <= eng.safeRange)) continue;
        u.retreatBudget = Math.min(retreatMaxTicks, u.retreatBudget + retreatRefill * fatigue);
        if (u.retreatLocked && u.retreatBudget >= retreatMaxTicks * 0.5) u.retreatLocked = false;
      }
    } else for (const u of units) if (u.alive) decide(u, tick, effects, projectiles);

    // 2. movement + separation
    for (const u of units) {
      if (!u.alive) continue;
      u.lastX = u.x;
      u.lastY = u.y;
      u.x += u.moveX;
      u.y += u.moveY;
    }
    for (let a = 0; a < n; a++) {
      const ua = U(a);
      if (!ua.alive) continue;
      for (let b = a + 1; b < n; b++) {
        const ub = U(b);
        if (!ub.alive) continue;
        const sx = ub.x - ua.x;
        const sy = ub.y - ua.y;
        const sd = Math.sqrt(sx * sx + sy * sy);
        const minD = cs.unitRadius * (eng ? eng.separation : 1.9);
        if (sd < minD) {
          const nx = sd > 0.0001 ? sx / sd : 1;
          const ny = sd > 0.0001 ? sy / sd : 0;
          // Rules 3.1.0: a PLANTED fighter holds its ground — the one that walked (or dashed) into it takes the whole push. A fighter committed to an
          // attack (aiming, releasing, recovering) holds firmer than one that is casting or stunned; equals split the push, as before.
          const holdA = eng === undefined || !ua.planted ? 0 : ua.atkPhase !== 0 ? 2 : 1;
          const holdB = eng === undefined || !ub.planted ? 0 : ub.atkPhase !== 0 ? 2 : 1;
          const anchorA = holdA > holdB;
          const anchorB = holdB > holdA;
          const pushA = anchorA ? 0 : anchorB ? minD - sd : (minD - sd) / 2;
          const pushB = anchorB ? 0 : anchorA ? minD - sd : (minD - sd) / 2;
          ua.x -= nx * pushA;
          ua.y -= ny * pushA;
          ub.x += nx * pushB;
          ub.y += ny * pushB;
        }
      }
    }
    for (const u of units) if (u.alive) clampToArena(u);

    // 3. arrive projectiles
    for (let p = projectiles.length - 1; p >= 0; p--) {
      const pr = projectiles[p] as Projectile;
      if (pr.arriveTick <= tick) {
        // Projectiles already in flight still land even if the shooter was eliminated meanwhile.
        effects.push({ kind: "basic", from: pr.from, to: pr.to });
        projectiles.splice(p, 1);
      }
    }

    // 4. resolve effects in seeded order (simultaneous within the tick)
    const order = rng.shuffle(effects.map((_, idx) => idx));
    for (const idx of order) {
      const eff = effects[idx] as Effect;
      const from = U(eff.from);
      const to = U(eff.to);
      if (eff.kind === "basic") {
        if (!to.alive) continue;
        dealDamage(tick, from, to, 1, from.cls.attack.kind === "magic" ? "int" : "str", { aoe: false, basic: true });
      } else {
        const skill = from.skills[eff.skillIdx] as SkillDef;
        for (const e of skill.effects) resolveSkillEffect(tick, from, to, skill, e);
      }
    }

    // 5. regeneration (and, for rules 1.0.0 ONLY, the retired storm-ring hazard)
    const ringR = ringRadiusAt(tick);
    if (legacyRing && Math.abs(ringR - lastRingEmitted) >= 4) {
      lastRingEmitted = Math.round(ringR);
      emit(tick, EV.RING, -1, -1, ringR * 10);
    }
    const tSec = (tick * tickMs) / 1000;
    for (const u of units) {
      if (!u.alive) continue;
      if (legacyRing) {
        const r = Math.sqrt(u.x * u.x + u.y * u.y);
        if (r > ringR) {
          const pct = legacyRing.damagePctPerSec + legacyRing.damageRampPerSec * Math.max(0, tSec - legacyRing.startMs / 1000);
          const dmg = Math.max(1, Math.ceil(u.maxHp * pct * dt));
          u.hp -= dmg;
          u.taken += dmg;
          emit(tick, EV.HAZARD, u.i, -1, dmg);
        }
      }
      for (const t of u.cls.traits) {
        if (t.type === "regen_pct" && u.hp > 0) {
          u.regenAcc += u.maxHp * (t.perSec / T) * dt * (eng ? healMult(tick) : 1);
          if (u.regenAcc >= 1) {
            const whole = Math.floor(u.regenAcc);
            u.regenAcc -= whole;
            const applied = Math.min(whole, u.maxHp - u.hp);
            if (applied > 0) {
              u.hp += applied;
              u.healed += applied;
            }
          }
        }
      }
    }

    // 6. deaths (after ALL damage in the tick)
    let aliveCount = 0;
    for (const u of units) {
      if (!u.alive) continue;
      if (u.hp <= 0) {
        u.alive = false;
        u.hp = 0;
        u.eliminatedAtTick = tick;
        u.cast = null;
        const killer = u.lethalBy >= 0 ? u.lethalBy : -1;
        u.killedBy = killer >= 0 ? killer : null;
        if (killer >= 0) U(killer).eliminations += 1;
        emit(tick, EV.ELIM, u.i, killer);
      } else {
        aliveCount++;
      }
    }

    recordFrame(tick);

    if (aliveCount <= 1) {
      endedBy = "LAST_STANDING";
      break;
    }
  }

  emit(ticks, EV.END, -1, -1, endedBy === "LAST_STANDING" ? 1 : 0);

  // --- result assembly ----------------------------------------------------------------
  const standings: Standing[] = units.map((u) => ({
    slot: u.i,
    alive: u.alive,
    hp: u.hp,
    maxHp: u.maxHp,
    eliminatedAtTick: u.eliminatedAtTick,
    eliminations: u.eliminations,
    damageDealt: u.dealt,
    damageTaken: u.taken,
  }));
  const ranking = rankStandings(standings);
  const placementOf = new Map<number, number>();
  ranking.forEach((slot, idx) => placementOf.set(slot, idx + 1));
  const durationMs = ticks * tickMs;

  const participants: ParticipantOutcome[] = units.map((u) => ({
    slot: u.i,
    characterId: u.input.characterId,
    placement: placementOf.get(u.i) as number,
    alive: u.alive,
    finalHp: u.hp,
    maxHp: u.maxHp,
    eliminatedAtTick: u.eliminatedAtTick,
    survivedMs: u.eliminatedAtTick !== null ? u.eliminatedAtTick * tickMs : durationMs,
    eliminations: u.eliminations,
    damageDealt: u.dealt,
    damageTaken: u.taken,
    healingDone: u.healed,
    killedBySlot: u.killedBy,
  }));

  const eventsHash = sha256Hex(
    JSON.stringify({ v: ruleset.rulesVersion, e: events, r: ranking, p: participants.map((p) => [p.characterId, p.placement, p.finalHp]) }),
  );
  const slotOf: Record<string, number> = {};
  for (const u of units) slotOf[u.input.characterId] = u.i;

  return {
    rulesVersion: ruleset.rulesVersion,
    tickMs,
    ticks,
    durationMs,
    endedBy,
    skillIds: skillIdList,
    participants,
    ranking,
    events,
    eventsHash,
    ...(frames ? { frames } : {}),
    startPositions,
    slotOf,
  };
}

export { FRAME_STRIDE };
