import type { Pt } from "./pen";

/**
 * The shared skeleton. Every layer of a hero (body, outfit, weapon, hair…) is drawn from the SAME
 * `Pose` and the SAME joint positions, which is exactly what guarantees that any combination of
 * compatible layers lines up frame for frame.
 *
 * Conventions (sprite pixels, y down, hero faces +x):
 *  · limb angles are measured from "straight down", positive = swinging FORWARD (+x):
 *      0 = hanging, π/2 = horizontal forward, π = straight up;
 *  · `lean`/`tilt`/`rot` rotate clockwise on screen when positive (tops move forward / the hero
 *    falls forward); a KO topples backwards, so `rot` is negative there.
 */

export const HIP: Pt = [34, 47];
export const FEET_Y = 58;

export interface Pose {
  /** Whole-body offset (bob, lunge, hop). */
  ox: number;
  oy: number;
  /** Whole-body rotation about the hip (KO topple). */
  rot: number;
  /** Torso lean about the hip, and extra head tilt on top of it. */
  lean: number;
  tilt: number;
  legF: number;
  legB: number;
  armF: number;
  armB: number;
  /** Forearm bend relative to the upper arm. */
  elbowF: number;
  elbowB: number;
  /** Absolute weapon axis (down-based, +forward); weapons draw from the front hand along it. */
  weaponAngle: number;
  /** Bow draw 0..1. */
  draw: number;
  /** Magic glow 0..1 (staff orb, tome). */
  glow: number;
  eyes: "open" | "hurt" | "dead" | "cheer";
  mouth: "rest" | "open" | "shout" | "hurt";
  capeSway: number;
  /** 0..1: the cape gathers up (it crumples when the hero lies down). */
  capeFold: number;
}

export const NEUTRAL: Pose = {
  ox: 0, oy: 0, rot: 0, lean: 0.04, tilt: 0,
  legF: 0.1, legB: -0.1,
  armF: 0.5, armB: -0.12, elbowF: 0.55, elbowB: 0.2,
  weaponAngle: 2.55, draw: 0, glow: 0,
  eyes: "open", mouth: "rest", capeSway: 0, capeFold: 0,
};

export type ClipName = "idle" | "move" | "attack_slash" | "attack_thrust" | "attack_shoot" | "skill" | "hit" | "ko" | "victory";

export interface ClipSpec {
  row: number;
  frames: number;
  fps: number;
  loop: boolean;
  impact?: number;
}

/** Row order = row index in every layer block. */
export const CLIPS: Record<ClipName, ClipSpec> = {
  idle: { row: 0, frames: 4, fps: 6, loop: true },
  move: { row: 1, frames: 6, fps: 12, loop: true },
  attack_slash: { row: 2, frames: 5, fps: 16, loop: false, impact: 1 },
  attack_thrust: { row: 3, frames: 5, fps: 16, loop: false, impact: 1 },
  attack_shoot: { row: 4, frames: 5, fps: 14, loop: false, impact: 3 },
  skill: { row: 5, frames: 6, fps: 12, loop: false, impact: 3 },
  hit: { row: 6, frames: 2, fps: 10, loop: false },
  ko: { row: 7, frames: 4, fps: 7, loop: false },
  victory: { row: 8, frames: 4, fps: 8, loop: true },
};

export const CLIP_ORDER = Object.keys(CLIPS) as ClipName[];

const P = (over: Partial<Pose>): Pose => ({ ...NEUTRAL, ...over });
const at = <T>(arr: readonly T[], f: number): T => arr[Math.min(f, arr.length - 1)] as T;

export function poseFor(clip: ClipName, f: number): Pose {
  switch (clip) {
    case "idle": {
      const k = at([0, 1, 2, 1], f);
      return P({ oy: -k * 0.55, armF: 0.5 + k * 0.04, armB: -0.12 - k * 0.03, capeSway: k * 0.6 });
    }
    case "move": {
      const ph = (f / 6) * Math.PI * 2;
      const s = Math.sin(ph);
      return P({
        oy: -Math.abs(Math.sin(ph)) * 1.7, lean: 0.15, legF: s * 0.85, legB: -s * 0.85,
        armF: 0.5 - s * 0.3, armB: -0.1 + s * 0.6, weaponAngle: 2.45 + s * 0.12, capeSway: -2 + s,
      });
    }
    case "attack_slash":
      return P({
        armF: at([2.55, 1.7, 1.15, 0.8, 0.5], f), elbowF: at([0.3, 0.2, 0.25, 0.4, 0.55], f),
        lean: at([-0.16, 0.24, 0.3, 0.2, 0.08], f), ox: at([-1.2, 2, 3, 2.5, 1], f),
        weaponAngle: at([3.7, 1.9, 1.15, 0.9, 2.3], f), armB: at([0.6, -0.5, -0.7, -0.4, -0.15], f),
        legF: at([-0.15, 0.5, 0.55, 0.4, 0.2], f), legB: at([0.2, -0.45, -0.5, -0.3, -0.15], f),
        oy: at([0, 0, 0.5, 0.3, 0], f), mouth: at(["rest", "shout", "shout", "rest", "rest"] as const, f),
        capeSway: at([1, -3, -4, -2, 0], f),
      });
    case "attack_thrust":
      return P({
        armF: at([1.0, 1.3, 1.3, 1.3, 0.9], f), elbowF: at([1.2, 0.35, 0.3, 0.35, 0.9], f),
        lean: at([-0.12, 0.2, 0.24, 0.2, 0.1], f), ox: at([-1.5, 2, 3, 2.5, 1], f),
        weaponAngle: at([2.1, 1.9, 1.85, 1.9, 2.3], f), glow: at([0.2, 0.7, 1, 0.7, 0.2], f),
        armB: at([0.4, -0.6, -0.7, -0.5, -0.2], f), legF: at([-0.1, 0.45, 0.5, 0.4, 0.2], f), legB: at([0.15, -0.4, -0.45, -0.3, -0.15], f),
        mouth: at(["rest", "shout", "shout", "rest", "rest"] as const, f), capeSway: at([1, -3, -4, -2, 0], f),
      });
    case "attack_shoot":
      return P({
        armF: at([1.45, 1.55, 1.55, 1.5, 1.2], f), elbowF: at([0.05, 0, 0, 0.05, 0.3], f),
        weaponAngle: Math.PI, draw: at([0.35, 0.75, 1, 0, 0], f),
        armB: at([1.5, 2.2, 2.47, 2.0, 0.4], f), elbowB: at([-0.4, -1.4, -1.8, -1.0, 0.2], f),
        lean: at([0.05, 0.02, 0, -0.1, 0.02], f), ox: at([0, -0.5, -1, 0, 0], f),
        legF: 0.25, legB: -0.25, mouth: at(["rest", "rest", "rest", "open", "rest"] as const, f), capeSway: at([0, 0, 0, 3, 1], f),
      });
    case "skill":
      return P({
        armF: at([0.9, 1.5, 2.0, 2.25, 1.9, 1.2], f), armB: at([0.5, 1.3, 1.9, 2.1, 1.8, 0.6], f),
        elbowF: at([0.4, 0.3, 0.15, 0.05, 0.2, 0.5], f), elbowB: at([0.4, 0.3, 0.15, 0.05, 0.2, 0.4], f),
        lean: at([0, -0.05, -0.1, -0.12, -0.05, 0.05], f), oy: at([0, -0.5, -1.2, -1.6, -0.8, 0], f),
        glow: at([0, 0.25, 0.6, 1, 0.6, 0.2], f), weaponAngle: at([2.4, 2.35, 2.2, 2.1, 2.3, 2.5], f),
        legF: 0.15, legB: -0.15, mouth: at(["rest", "rest", "open", "open", "rest", "rest"] as const, f), capeSway: at([0, 1, 2, 3, 2, 0], f),
      });
    case "hit":
      return f === 0
        ? P({ lean: -0.45, tilt: -0.15, ox: -3.2, oy: 0.8, armF: 0.1, armB: -0.6, elbowF: 0.3, weaponAngle: 2.0, legF: 0.35, legB: -0.2, eyes: "hurt", mouth: "hurt", capeSway: 3 })
        : P({ lean: -0.25, tilt: -0.08, ox: -1.6, oy: 0.4, armF: 0.25, armB: -0.35, elbowF: 0.4, weaponAngle: 2.2, legF: 0.2, legB: -0.15, eyes: "hurt", mouth: "hurt", capeSway: 1.5 });
    case "ko":
      return P({
        lean: 0, rot: at([-0.45, -0.95, -1.4, -1.55], f), oy: at([0.6, 1.6, 2.2, 2.4], f), ox: at([-0.5, 4, 9, 11], f),
        armF: at([0.3, 0.3, 0.4, 0.5], f), armB: at([-0.4, -0.2, 0.2, 0.5], f), elbowF: 0.2, elbowB: 0.1,
        legF: at([0.3, 0.5, 0.3, 0.1], f), legB: at([-0.1, 0.2, 0.1, 0], f), weaponAngle: at([1.6, 1.0, 0.8, 0.7], f),
        eyes: "dead", mouth: "hurt", capeSway: at([1, 0, 0, 0], f), capeFold: at([0.2, 0.7, 0.8, 0.8], f),
      });
    case "victory":
      return P({
        oy: at([0, -1.2, -2.2, -1], f), armF: at([2.5, 2.7, 2.5, 2.3], f), armB: at([2.2, 2.5, 2.2, 2.0], f), elbowF: at([0.1, 0.05, 0.1, 0.15], f), elbowB: at([0.1, 0.05, 0.1, 0.15], f),
        weaponAngle: at([2.3, 2.5, 2.3, 2.1], f), legF: at([0.15, 0.4, 0.4, 0.15], f), legB: at([-0.15, 0.1, 0.1, -0.15], f),
        eyes: "cheer", mouth: "open", lean: at([0.02, -0.05, -0.08, -0.02], f), capeSway: at([0, 2, 3, 1], f),
      });
  }
}

// ---------------------------------------------------------------------------------------
// Forward kinematics
// ---------------------------------------------------------------------------------------

export interface Joints {
  hip: Pt;
  neck: Pt;
  head: Pt;
  shoulderF: Pt;
  shoulderB: Pt;
  elbowF: Pt;
  handF: Pt;
  elbowB: Pt;
  handB: Pt;
  hipF: Pt;
  hipB: Pt;
  footF: Pt;
  footB: Pt;
  /** Local-frame rotations for torso-/head-local drawing. */
  torsoAngle: number;
  headAngle: number;
  /** World-space weapon axis (unit vector pointing from the grip towards the tip). */
  weaponDir: Pt;
}

export const LIMB = 5.2;
export const LEG = 11;

const rot2 = (v: Pt, a: number): Pt => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
/** Down-based limb direction: 0 = down, +forward. */
export const limbDir = (a: number): Pt => [Math.sin(a), Math.cos(a)];

export function joints(p: Pose): Joints {
  const up = rot2([0, -1], p.lean);
  const right = rot2([1, 0], p.lean);
  const toWorld = (rel: Pt): Pt => {
    const r = rot2(rel, p.rot);
    return [HIP[0] + r[0] + p.ox, HIP[1] + r[1] + p.oy];
  };
  const neckRel = mul(up, 15);
  const headRel = add(neckRel, mul(rot2([0, -1], p.lean + p.tilt), 8.4));
  const shFRel = add(add(neckRel, mul(up, -3.2)), mul(right, 5.5));
  const shBRel = add(add(neckRel, mul(up, -3.2)), mul(right, -5.5));
  const elFRel = add(shFRel, mul(limbDir(p.armF), LIMB));
  const haFRel = add(elFRel, mul(limbDir(p.armF + p.elbowF), LIMB));
  const elBRel = add(shBRel, mul(limbDir(p.armB), LIMB));
  const haBRel = add(elBRel, mul(limbDir(p.armB + p.elbowB), LIMB));
  const hFRel: Pt = [2.6, 0];
  const hBRel: Pt = [-2.6, 0];
  const ftFRel = add(hFRel, mul(limbDir(p.legF), LEG));
  const ftBRel = add(hBRel, mul(limbDir(p.legB), LEG));
  return {
    hip: toWorld([0, 0]),
    neck: toWorld(neckRel),
    head: toWorld(headRel),
    shoulderF: toWorld(shFRel),
    shoulderB: toWorld(shBRel),
    elbowF: toWorld(elFRel),
    handF: toWorld(haFRel),
    elbowB: toWorld(elBRel),
    handB: toWorld(haBRel),
    hipF: toWorld(hFRel),
    hipB: toWorld(hBRel),
    footF: toWorld(ftFRel),
    footB: toWorld(ftBRel),
    torsoAngle: p.lean + p.rot,
    headAngle: p.lean + p.tilt + p.rot,
    weaponDir: rot2(limbDir(p.weaponAngle), p.rot),
  };
}
