/**
 * HERO RENDERER v2 — the POSE vocabulary shared by every skeleton (rig.ts) and every archetype (archetypes.ts): the pose record, the clip
 * table and the small helpers poses are written with. Pure data — no drawing.
 *
 * Conventions (sprite pixels, y down, hero faces +x): limb angles are measured from "straight down", positive = forward (+x); `lean` / `tilt` /
 * `rot` rotate clockwise on screen when positive; a KO topples backwards (negative `rot`) or forwards (positive).
 */

export type Pt = readonly [number, number];

export interface Pose {
  ox: number;
  oy: number;
  rot: number;
  lean: number;
  tilt: number;
  /** Thigh angles and knee bends (positive bend folds the shin backwards). */
  legF: number;
  legB: number;
  kneeF: number;
  kneeB: number;
  armF: number;
  armB: number;
  elbowF: number;
  elbowB: number;
  /** Absolute weapon axis (down-based, + forward); weapons draw from the front hand along it. */
  weaponAngle: number;
  /** Absolute axis of a second weapon in the BACK hand (the rogue's other dagger). Default: reversed from the front one. */
  weaponB?: number;
  /**
   * TWO-HANDED GRIP: the back hand holds the weapon this far from the front hand along its axis (negative = toward the pommel). The back arm is
   * then solved by IK (armB / elbowB are ignored) — a greatsword, a battle staff, a hammer held in both hands.
   */
  gripB?: number;
  /** The back hand placed at a torso-local point (a fist on the hip, a palm before the chest, a hand behind the back) — solved by IK. */
  handBAt?: Pt;
  /**
   * Torso TWIST (−1 … 1): + turns the chest toward the foe (the shoulders close in and swing forward — a swing's follow-through), − turns it
   * away (a wind-up). Only the arm roots move; the garment shapes stay.
   */
  twist?: number;
  /** Bow draw 0..1. */
  draw: number;
  /** Magic / holy charge 0..1. */
  glow: number;
  eyes: "open" | "hurt" | "dead" | "cheer" | "focus";
  mouth: "rest" | "open" | "shout" | "hurt";
  capeSway: number;
  capeFold: number;
  /** 0..1 squash of the torso (breath / landing). */
  squash: number;
  /** Skip grounding (the pose places itself with `oy` from the standing hip height: a KO). */
  free?: boolean;
}

export const NEUTRAL: Pose = {
  ox: 0, oy: 0, rot: 0, lean: 0.05, tilt: 0,
  legF: 0.2, legB: -0.2, kneeF: 0.08, kneeB: 0.1,
  armF: 0.55, armB: -0.15, elbowF: 0.6, elbowB: 0.25,
  weaponAngle: 2.6, draw: 0, glow: 0,
  eyes: "open", mouth: "rest", capeSway: 0, capeFold: 0, squash: 0,
};

export type ClipName = "idle" | "move" | "attack_slash" | "attack_thrust" | "attack_shoot" | "skill" | "hit" | "ko" | "victory" | "idle2";

export interface ClipSpec {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  /** The frame on which the blow lands / the shot leaves / the spell fires. The renderer lines this frame up with the server's event. */
  impact?: number;
}

/** Shared by every skeleton (combat timing never depends on the class or the archetype). */
export const CLIPS: Record<ClipName, ClipSpec> = {
  idle: { row: 0, frames: 6, fps: 7, loop: true },
  move: { row: 1, frames: 6, fps: 12, loop: true },
  attack_slash: { row: 2, frames: 6, fps: 14, loop: false, impact: 2 },
  attack_thrust: { row: 3, frames: 6, fps: 14, loop: false, impact: 2 },
  attack_shoot: { row: 4, frames: 6, fps: 12, loop: false, impact: 3 },
  skill: { row: 5, frames: 6, fps: 12, loop: false, impact: 3 },
  hit: { row: 6, frames: 3, fps: 12, loop: false },
  ko: { row: 7, frames: 6, fps: 9, loop: false },
  victory: { row: 8, frames: 4, fps: 8, loop: true },
  /** The second STANCE (each hero stands in `idle` or `idle2`, chosen from its never-rerolled look). */
  idle2: { row: 9, frames: 6, fps: 7, loop: true },
};

export const CLIP_ORDER = Object.keys(CLIPS) as ClipName[];

export const P = (over: Partial<Pose>): Pose => ({ ...NEUTRAL, ...over });
export const at = <T>(arr: readonly T[], f: number): T => arr[Math.min(f, arr.length - 1)] as T;
/** A breathing cycle over the six idle frames: 0 → 1 → 0. */
export const breath = (f: number): number => at([0, 0.5, 1, 1, 0.5, 0], f);
/** The phase of a 6-frame loop: sin and cos of f / 6 of a turn. */
export const cycle = (f: number, phase = 0): { s: number; c: number } => {
  const a = ((f + phase) / 6) * Math.PI * 2;
  return { s: Math.sin(a), c: Math.cos(a) };
};
export type Eyes = Pose["eyes"];
export type Mouth = Pose["mouth"];
export const E = (...e: Eyes[]): Eyes[] => e;
export const M = (...m: Mouth[]): Mouth[] => m;

/**
 * A stride (move cycle) of a given character: `stride` = thigh swing, `lift` = knee fold on the passing leg, `bob` = airtime (0: a march that
 * never leaves the ground), `base` = the knees' rest bend. Legs counter-swing; the returned values spread into a pose.
 */
export function stride(f: number, o: { stride: number; lift: number; bob: number; base?: number; squash?: number }): Partial<Pose> {
  const { s, c } = cycle(f);
  const base = o.base ?? 0.1;
  return {
    oy: -Math.abs(s) * o.bob,
    legF: s * o.stride,
    legB: -s * o.stride,
    kneeF: Math.max(0, -c) * o.lift + base,
    kneeB: Math.max(0, c) * o.lift + base,
    squash: Math.abs(c) * (o.squash ?? 0.2),
  };
}

// ---------------------------------------------------------------------------------------
// Shared KOs — the weapon falls FLAT with the body (it never sticks up out of a fallen hero)
// ---------------------------------------------------------------------------------------

/** Stagger back · knees buckle · falling backwards · hits the ground · a small bounce · lies still (head to the left). */
export function koBack(f: number, hold: Partial<Pose> = {}): Pose {
  return P({
    lean: at([-0.3, -0.1, 0, 0, 0, 0], f), rot: at([-0.22, -0.55, -1.05, -1.5, -1.42, -1.52], f), oy: at([-0.6, -0.8, -0.4, 0.2, -0.6, 0], f),
    ox: at([-0.6, 1.2, 8.4, 11.6, 12.4, 13], f), armF: at([0.2, 0.6, 0.9, 0.5, 0.6, 0.55], f), armB: at([-0.6, -0.2, 0.6, 0.5, 0.4, 0.5], f),
    elbowF: 0.25, elbowB: 0.15, legF: at([0.35, 0.9, 0.6, 0.15, 0.25, 0.1], f), legB: at([-0.15, 0.6, 0.3, 0.05, 0.1, 0], f),
    kneeF: at([0.2, 1.1, 0.6, 0.1, 0.2, 0.05], f), kneeB: at([0.2, 1.2, 0.5, 0.1, 0.1, 0.05], f),
    // absolute weapon direction = weaponAngle − rot: the blade is flung up as the hero topples, then lies along the ground (≈ π/2)
    weaponAngle: at([1.7, 1.4, 1.1, 0.2, 0.12, 0.08], f), weaponB: at([1.2, 1.0, 0.6, 0.1, 0.05, 0.05], f),
    eyes: at(E("hurt", "hurt", "dead", "dead", "dead", "dead"), f), mouth: "hurt", capeSway: at([2, 1, 0, 0, 0, 0], f),
    capeFold: at([0.1, 0.3, 0.6, 0.8, 0.8, 0.8], f), free: f > 0, ...hold,
  });
}

/** Sags to the knees · tips forward · face down · a small bounce · lies still (head to the right): the heavy and the devout fall forward. */
export function koForward(f: number, hold: Partial<Pose> = {}): Pose {
  return P({
    lean: at([0.18, 0.3, 0.2, 0, 0, 0], f), rot: at([0.05, 0.12, 0.7, 1.42, 1.36, 1.46], f), oy: at([0, 0, -0.6, -0.6, -1.2, -0.8], f),
    ox: at([-0.4, 0, -4.5, -10.5, -10.8, -11], f), legF: at([0.35, 0.95, 0.6, 0.15, 0.2, 0.1], f), legB: at([-0.2, 0.75, 0.45, 0.05, 0.1, 0.05], f),
    kneeF: at([0.4, 1.6, 1.1, 0.25, 0.3, 0.15], f), kneeB: at([0.5, 1.9, 1.3, 0.2, 0.2, 0.1], f),
    armF: at([0.5, 0.9, 1.5, 2.8, 2.75, 2.85], f), armB: at([0.7, 1.0, 1.6, 2.95, 2.9, 3.0], f), elbowF: at([0.6, 0.4, 0.3, 0.2, 0.2, 0.2], f),
    elbowB: at([0.6, 0.4, 0.3, 0.2, 0.2, 0.2], f), weaponAngle: at([1.8, 1.4, 2.2, 3.05, 3.0, 3.1], f),
    eyes: at(E("hurt", "hurt", "dead", "dead", "dead", "dead"), f), mouth: "hurt", capeSway: at([1, 0.5, -1, -2, -1.5, -2], f),
    capeFold: at([0, 0.2, 0.4, 0.6, 0.6, 0.6], f), free: f > 1, ...hold,
  });
}

/** Sinks to both knees and slumps sideways (a caster's collapse): kneel · sway · fold · lies curled (head to the right). */
export function koKneel(f: number, hold: Partial<Pose> = {}): Pose {
  return P({
    lean: at([0.1, 0.35, 0.55, 0, 0, 0], f), rot: at([0, 0.05, 0.4, 1.3, 1.24, 1.34], f), oy: at([0, 0, 0, -0.4, -1.0, -0.6], f),
    ox: at([-0.4, -0.6, -2.4, -9, -9.4, -9.8], f), legF: at([0.5, 1.2, 1.3, 0.9, 0.95, 0.9], f), legB: at([0.2, 0.9, 1.1, 0.7, 0.75, 0.7], f),
    kneeF: at([0.6, 2.2, 2.4, 1.8, 1.9, 1.8], f), kneeB: at([0.7, 2.3, 2.5, 1.9, 2.0, 1.9], f),
    armF: at([0.4, 0.6, 1.2, 2.4, 2.35, 2.45], f), armB: at([0.6, 0.8, 1.0, 2.6, 2.55, 2.65], f), elbowF: at([0.8, 0.6, 0.6, 0.6, 0.6, 0.6], f),
    elbowB: at([0.8, 0.6, 0.5, 0.4, 0.4, 0.4], f), weaponAngle: at([2.4, 2.0, 1.4, 2.9, 2.95, 3.0], f),
    eyes: at(E("hurt", "hurt", "dead", "dead", "dead", "dead"), f), mouth: "hurt", capeSway: at([1, 0, -1, -1.5, -1.2, -1.6], f),
    capeFold: at([0, 0.3, 0.5, 0.7, 0.7, 0.7], f), free: f > 2, ...hold,
  });
}
