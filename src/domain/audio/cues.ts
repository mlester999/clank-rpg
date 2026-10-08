import { EV, EV_FLAG, STATUS_CODE, type EventTuple } from "../combat/types";

import type { SoundId } from "./sounds";

/**
 * ARENA AUDIO — what the Arena SAYS, as sound. A cue is born from something the server recorded (a replay event) or from the authoritative clock
 * (3 · 2 · 1, the bell, the winner) — never from anything the browser guesses. This module is pure: it turns events into cues and nothing else;
 * the audio engine (components/arena/audio) decides whether, and how, each cue is actually heard.
 *
 * Identity: every cue has a stable `key` (battle + tick + kind + who), so a sound can be presented at most once however many times the same event
 * is delivered (a remounted renderer, a re-fetched replay, a request retried, a tab restored from cache).
 */

export interface SoundCue {
  id: SoundId;
  /** Stable identity of what caused it. */
  key: string;
  /** The battle it belongs to (a cue of a battle that is no longer on stage is dropped). */
  battle: string;
  /** Combat cues are refused before the bell; phase cues are the clock's own. */
  kind: "phase" | "combat";
  /** −1 (left) … 1 (right): where the source stands on the floor. */
  pan: number;
  /** 0..1 multiplier on top of the sound's own level. */
  gain: number;
  /** Start this long after now (a cast's release). */
  delayMs: number;
  /** How long ago the thing happened, when the cue was made: a stale cue (a tab that was asleep) is dropped, not played late. */
  lateMs: number;
}

/** What the cue mapper needs to know about one fighter (from the class's visual identity and the battle's start). */
export interface CueUnit {
  classId: string;
  weapon: string;
  body: string;
  /** The class's basic-attack style: slash · stab · arrow · orb · bolt. */
  style: string;
  /** World x (−R … R), for stereo placement. */
  x: number;
}

export interface CueContext {
  battleId: string;
  tickMs: number;
  /** ms since the bell right now. */
  combatMs: number;
  /** The arena radius (world units) — stereo placement is x / R. */
  radius: number;
  unit: (slot: number) => CueUnit | undefined;
  skill: (index: number) => { id: string; fx: string } | undefined;
  /** ms between a SKILL event and its release (a cast time); 0 for an instant skill. */
  releaseMs: (slot: number, tick: number) => number;
  /** How many fighters are still standing AFTER the elimination of `victim` at `tick` (and how many there were at the start). */
  aliveAfter: (tick: number, victim: number) => { alive: number; start: number } | undefined;
}

const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));

export const LATE_MAX_MS = { combat: 260, phase: 450 } as const;

/** The stereo position of a fighter: gentle (never hard-panned — eight sources would fight for the edges). */
export function panOf(u: CueUnit | undefined, radius: number): number {
  return u ? clamp(u.x / Math.max(1, radius), -1, 1) * 0.55 : 0;
}

type Style = "heavy" | "stab" | "slash" | "arrow" | "orb" | "bolt";
function styleOf(u: CueUnit | undefined): Style {
  if (!u) return "slash";
  if (u.style === "arrow" || u.style === "orb" || u.style === "bolt" || u.style === "stab") return u.style;
  if (u.weapon === "mace" || u.body === "heavy") return "heavy";
  return "slash";
}

const BASIC_ATTACK: Record<Style, SoundId> = {
  heavy: "mace_swing", stab: "dagger_swing", slash: "sword_swing", arrow: "bow_release", orb: "orb_cast", bolt: "bolt_cast",
};
const BASIC_HIT: Record<Style, SoundId> = {
  heavy: "mace_hit", stab: "dagger_hit", slash: "sword_hit", arrow: "arrow_hit", orb: "magic_hit", bolt: "holy_hit",
};

/** Named abilities by skill id; anything else falls back to the skill's visual kind (`fx`). `null`: the skill is voiced by its own effect events. */
const SKILL_BY_ID: Record<string, SoundId | null> = {
  cleave: "skill_cleave", charge: "skill_charge", guard: null, ground_slam: "skill_slam", shadowstep: "skill_shadowstep", evasion: "skill_buff",
  volley: "skill_volley", snare_shot: "skill_snare", arcane_burst: "skill_burst", frost_nova: "skill_nova", smite: "skill_smite", sanctuary: "skill_sanctuary",
};
const SKILL_BY_FX: Record<string, SoundId | null> = {
  cleave: "skill_cleave", dash: "skill_charge", shield: null, taunt: "skill_slam", buff: "skill_buff", volley: "skill_volley", snare: "skill_snare",
  burst: "skill_burst", nova: "skill_nova", smite: "skill_smite", heal: "skill_sanctuary",
};

export function skillSound(id: string, fx: string): SoundId | null {
  if (Object.hasOwn(SKILL_BY_ID, id)) return SKILL_BY_ID[id] as SoundId | null;
  return Object.hasOwn(SKILL_BY_FX, fx) ? (SKILL_BY_FX[fx] as SoundId | null) : "skill_buff";
}

/**
 * The cues of the events that became due in ONE frame, in the order they happened. Events of one tick are voiced together: a sweep that hits five
 * heroes is ONE impact, a nova that slows five is ONE crackle, a heal that comes with its own cast is part of the cast's sound.
 */
export function cuesForEvents(events: readonly EventTuple[], c: CueContext): SoundCue[] {
  const out: SoundCue[] = [];
  const mk = (id: SoundId, key: string, slot: number, extra: Partial<Pick<SoundCue, "gain" | "delayMs">> = {}, tick = 0): SoundCue => ({
    id, key: `${c.battleId}:${key}`, battle: c.battleId, kind: "combat", pan: panOf(c.unit(slot), c.radius), gain: extra.gain ?? 1, delayMs: extra.delayMs ?? 0,
    lateMs: Math.max(0, c.combatMs - tick * c.tickMs),
  });

  // casters whose own ability sound already carries their heal / shield / self-buff this tick
  const voiced = new Set<string>();
  for (const e of events) {
    if (e[1] !== EV.SKILL) continue;
    const sk = c.skill(e[4]);
    if (sk && skillSound(sk.id, sk.fx) && ["heal", "buff", "dash"].includes(sk.fx)) voiced.add(`${e[0]}:${e[2]}`);
  }
  const aoe = new Map<string, { count: number; first: EventTuple }>();
  const statuses = new Map<string, { count: number; first: EventTuple }>();

  for (const e of events) {
    const [tick, kind, a, b, v, flags] = e;
    const tag = `${tick}:${kind}:${a}:${b}:${v}`;
    switch (kind) {
      case EV.ATTACK: {
        const style = styleOf(c.unit(a));
        out.push(mk(BASIC_ATTACK[style], tag, a, {}, tick));
        break;
      }
      case EV.HIT: {
        if (a < 0) break;
        const aoeHit = (flags & EV_FLAG.AOE) !== 0;
        if (aoeHit) {
          const k = `${tick}:${a}`;
          const g = aoe.get(k);
          if (g) g.count++;
          else aoe.set(k, { count: 1, first: e });
        } else {
          out.push(mk(BASIC_HIT[styleOf(c.unit(a))], tag, b, {}, tick));
        }
        if ((flags & EV_FLAG.CRIT) !== 0) out.push(mk("crit_ping", `${tag}:crit`, b, { gain: 0.9 }, tick));
        break;
      }
      case EV.MISS:
        out.push(mk("miss_whiff", tag, b, { gain: 0.7 }, tick));
        break;
      case EV.SKILL: {
        const sk = c.skill(v);
        if (!sk) break;
        const sound = skillSound(sk.id, sk.fx);
        if (!sound) break;
        const release = c.releaseMs(a, tick);
        if (release >= 150) {
          const style = styleOf(c.unit(a));
          if (style === "orb") out.push(mk("cast_arcane", `${tag}:cast`, a, { gain: 0.9 }, tick));
          else if (style === "bolt") out.push(mk("cast_holy", `${tag}:cast`, a, { gain: 0.9 }, tick));
        }
        out.push(mk(sound, tag, a, { delayMs: release >= 150 ? release : 0 }, tick));
        break;
      }
      case EV.HEAL:
        if ((flags & EV_FLAG.LIFESTEAL) === 0 && !voiced.has(`${tick}:${a}`)) out.push(mk("heal_pulse", tag, b, { gain: 0.9 }, tick));
        break;
      case EV.SHIELD:
        if (!voiced.has(`${tick}:${a}`)) out.push(mk("shield_up", tag, a, {}, tick));
        break;
      case EV.STATUS: {
        if (v === STATUS_CODE.STUN || v === STATUS_CODE.SLOW || v === STATUS_CODE.TAUNT) {
          const k = `${tick}:${v}`;
          const g = statuses.get(k);
          if (g) g.count++;
          else statuses.set(k, { count: 1, first: e });
        } else if (!voiced.has(`${tick}:${a}`)) {
          out.push(mk(v === STATUS_CODE.EMPOWER ? "empower_rise" : "skill_buff", tag, a, { gain: 0.8 }, tick));
        }
        break;
      }
      case EV.ELIM: {
        const after = c.aliveAfter(tick, a);
        const last = after !== undefined && after.alive <= 1;
        out.push(mk(last ? "ko_final" : "ko", tag, a, {}, tick));
        if (after && after.alive === 2 && after.start > 2) out.push(mk("final_duel", "final2", 0, { delayMs: 420 }, tick));
        break;
      }
      case EV.HAZARD:
        out.push(mk("hazard_tick", tag, a, { gain: 0.8 }, tick));
        break;
      default:
        break;
    }
  }

  for (const [k, g] of aoe) out.push(mk("aoe_hit", `aoe:${k}`, g.first[3], { gain: clamp(0.65 + g.count * 0.1, 0.7, 1.15) }, g.first[0]));
  for (const [k, g] of statuses) {
    const code = g.first[4];
    const id: SoundId = code === STATUS_CODE.STUN ? "stun_hit" : code === STATUS_CODE.SLOW ? "slow_frost" : "taunt_horn";
    out.push(mk(id, `st:${k}`, g.first[2], { gain: clamp(0.7 + g.count * 0.08, 0.7, 1) }, g.first[0]));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the clock's own cues

export interface PhaseCueInput {
  battleId: string | null;
  phase: "IDLE" | "INTRO" | "COUNTDOWN" | "COMBAT" | "VICTORY" | "RESULTS" | "DONE";
  /** 3 · 2 · 1 while the phase is COUNTDOWN. */
  countdown: number | null;
  /** The synced server clock (ms). */
  now: number;
  startsAt: number | null;
  combatStartsAt: number | null;
  combatEndsAt: number | null;
  resultsStartAt: number | null;
  countdownMs: number;
  /** The authoritative winner is known (the verified replay's ranking is in hand and the fight is over). */
  winnerKnown: boolean;
}

/**
 * The 3 · 2 · 1, the bell, the winner, the results and the next round — from the AUTHORITATIVE timeline, once each. Fed every animation frame, it
 * answers with the cues that became due in that frame (usually none).
 *
 * Each cue fires only while it is still fresh: a viewer who joins during the 2 hears the 2 (it just changed), a tab restored half-way through the
 * results hears nothing of the earlier phases — a late phase is never replayed. Nothing here can fire before its instant: the bell's cue needs
 * `now ≥ combatStartsAt`, the winner's needs the fight to be over AND the winner known.
 */
export class PhaseCueTracker {
  private battle: string | null = null;
  private done = new Set<string>();

  update(i: PhaseCueInput): SoundCue[] {
    if (!i.battleId) {
      this.battle = null;
      this.done.clear();
      return [];
    }
    if (i.battleId !== this.battle) {
      this.battle = i.battleId;
      this.done.clear();
    }
    const out: SoundCue[] = [];
    const fire = (name: string, id: SoundId, dueAt: number | null, lateMax: number = LATE_MAX_MS.phase): void => {
      if (this.done.has(name) || dueAt === null) return;
      this.done.add(name);
      const late = i.now - dueAt;
      if (late < 0 || late > lateMax) return;
      out.push({ id, key: `${i.battleId}:${name}`, battle: i.battleId as string, kind: "phase", pan: 0, gain: 1, delayMs: 0, lateMs: late });
    };
    const digitMs = i.countdownMs / 3;
    switch (i.phase) {
      case "INTRO":
        fire("ready", "round_ready", i.startsAt, 1200);
        break;
      case "COUNTDOWN":
        if (i.countdown !== null && i.combatStartsAt !== null && i.countdown >= 1 && i.countdown <= 3) {
          fire(`cd${i.countdown}`, `cd_${i.countdown}` as SoundId, i.combatStartsAt - i.countdown * digitMs);
        }
        break;
      case "COMBAT":
        fire("fight", "fight", i.combatStartsAt);
        break;
      case "VICTORY":
        if (i.winnerKnown) fire("victory", "victory", i.combatEndsAt, 800);
        break;
      case "RESULTS":
        fire("results", "results", i.resultsStartAt, 800);
        break;
      default:
        break;
    }
    return out;
  }
}
