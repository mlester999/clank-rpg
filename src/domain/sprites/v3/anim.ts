import type { BodyPlan } from "./anatomy";
import type { FootTarget, HandTarget, Pose, WeaponAim } from "./rig";
import { clamp, ease, lerp, type EaseName, type V3 } from "./vec";

/**
 * HERO RENDERER v3 — ANIMATION: clips are a few KEY POSES with timing and easing; every frame in between is a real pose solved by the rig
 * (not a blend of pictures), so a swing is an arc, a step is a step, and the frame count can be whatever reads best.
 *
 *   · numbers ease between keys with the DESTINATION key's easing (`snap` into a strike, `coil` into an anticipation, `inOut` for settling);
 *   · hands move on ARCS: hand targets are interpolated in polar coordinates around the shoulder (a sword swung over the head travels over the
 *     head, never through the chest);
 *   · weapon aims interpolate their angles (keys may wind past ±180° to choose the direction of a swing);
 *   · faces (eyes, mouth) switch at the key they belong to.
 *
 * Locomotion is generated, not keyed: `gait()` plants each foot on the floor for the stance part of the cycle and moves it back by exactly the
 * ground the body covers — the arena advances the cycle by the distance the hero really travels (stride-locked), so feet do not slide.
 */

export interface Key extends Partial<Pose> {
  /** Normalised time 0..1 in the clip (loops: the cycle; one-shots: first → last frame). */
  t: number;
  /** Easing INTO this key from the previous one. */
  ease?: EaseName;
}

export interface ClipPlan {
  frames: number;
  fps: number;
  loop: boolean;
  impact?: number;
  /** Locomotion: sprite pixels covered per cycle (the arena turns it into world units). */
  stride?: number;
  keys: Key[];
}

const NUM_KEYS = ["x", "drop", "lean", "side", "twist", "hipYaw", "headPitch", "headYaw", "shieldYaw", "shieldPitch", "draw", "glow", "brow", "sway", "breath", "fall", "fallX", "dropWeapon"] as const;

function lerpFoot(a: FootTarget, b: FootTarget, t: number): FootTarget {
  return {
    x: lerp(a.x, b.x, t),
    ...(a.z !== undefined || b.z !== undefined ? { z: lerp(a.z ?? b.z ?? 0, b.z ?? a.z ?? 0, t) } : {}),
    lift: lerp(a.lift ?? 0, b.lift ?? 0, t),
    pitch: lerp(a.pitch ?? 0, b.pitch ?? 0, t),
  };
}

function lerpAim(a: WeaponAim, b: WeaponAim, t: number): WeaponAim {
  return { angle: lerp(a.angle, b.angle, t), out: lerp(a.out ?? 0, b.out ?? 0, t), roll: lerp(a.roll ?? 0, b.roll ?? 0, t) };
}

/** Hand targets on arcs about the shoulder (chest frame). */
function lerpHand(a: HandTarget, b: HandTarget, t: number, sh: V3): HandTarget {
  if (!("at" in a) || !("at" in b) || (a.space ?? "chest") !== (b.space ?? "chest")) return t < 0.5 ? a : b;
  const elbow = a.elbow && b.elbow ? ([lerp(a.elbow[0], b.elbow[0], t), lerp(a.elbow[1], b.elbow[1], t), lerp(a.elbow[2], b.elbow[2], t)] as V3) : (t < 0.5 ? a.elbow : b.elbow);
  if ((a.space ?? "chest") !== "chest") {
    const p: V3 = [lerp(a.at[0], b.at[0], t), lerp(a.at[1], b.at[1], t), lerp(a.at[2], b.at[2], t)];
    return { at: p, space: a.space, ...(elbow ? { elbow } : {}) };
  }
  const s: V3 = [sh[0], sh[1], Math.sign(a.at[2] || b.at[2] || 1) * Math.abs(sh[2])];
  const pa = [a.at[0] - s[0], a.at[1] - s[1]];
  const pb = [b.at[0] - s[0], b.at[1] - s[1]];
  const ra = Math.hypot(pa[0] as number, pa[1] as number);
  const rb = Math.hypot(pb[0] as number, pb[1] as number);
  const aa = Math.atan2(pa[1] as number, pa[0] as number);
  let ab = Math.atan2(pb[1] as number, pb[0] as number);
  // the short way round (a swing that should go the long way is keyed through an intermediate pose)
  while (ab - aa > Math.PI) ab -= Math.PI * 2;
  while (aa - ab > Math.PI) ab += Math.PI * 2;
  const ang = lerp(aa, ab, t);
  const r = lerp(ra, rb, t);
  return { at: [s[0] + Math.cos(ang) * r, s[1] + Math.sin(ang) * r, lerp(a.at[2], b.at[2], t)], ...(elbow ? { elbow } : {}) };
}

function blend(a: Pose, b: Pose, t: number, sh: V3): Pose {
  const out: Pose = { ...a };
  for (const k of NUM_KEYS) (out as unknown as Record<string, number>)[k] = lerp(a[k] as number, b[k] as number, t);
  out.footN = lerpFoot(a.footN, b.footN, t);
  out.footF = lerpFoot(a.footF, b.footF, t);
  out.handN = lerpHand(a.handN, b.handN, t, sh);
  out.handF = lerpHand(a.handF, b.handF, t, sh);
  out.weapon = lerpAim(a.weapon, b.weapon, t);
  out.weapon2 = lerpAim(a.weapon2, b.weapon2, t);
  out.eyes = t < 0.5 ? a.eyes : b.eyes;
  out.mouth = t < 0.5 ? a.mouth : b.mouth;
  return out;
}

/** The shoulder rest point in the chest frame (hands arc around it). */
export const shoulderInChest = (b: BodyPlan): V3 => [-0.2, b.neckUp - b.chestUp - 1.2, b.shoulderHalf];

/** Samples a clip's pose at frame `f` (keys are merged over `base`). */
export function sampleClip(clip: ClipPlan, f: number, base: Pose, plan: BodyPlan): Pose {
  const keys = clip.keys.map((k) => ({ ...k, pose: { ...base, ...k } as Pose }));
  if (keys.length === 0) return base;
  const t = clip.loop ? (f / clip.frames) % 1 : clip.frames <= 1 ? 0 : clamp(f / (clip.frames - 1), 0, 1);
  const sh = shoulderInChest(plan);
  if (keys.length === 1) return (keys[0] as { pose: Pose }).pose;
  // find the segment
  let i = keys.length - 1;
  for (let k = 0; k < keys.length; k++) if ((keys[k] as Key).t > t) {
    i = k - 1;
    break;
  }
  if (i < 0) {
    if (!clip.loop) return (keys[0] as { pose: Pose }).pose;
    // a loop: wrap from the last key to the first
    const a = keys[keys.length - 1] as Key & { pose: Pose };
    const b = keys[0] as Key & { pose: Pose };
    const span = 1 - a.t + b.t;
    const u = (t + 1 - a.t) / (span || 1);
    return blend(a.pose, b.pose, ease[b.ease ?? "inOut"](clamp(u, 0, 1)), sh);
  }
  const a = keys[i] as Key & { pose: Pose };
  const b = keys[i + 1] as (Key & { pose: Pose }) | undefined;
  if (!b) {
    if (!clip.loop) return a.pose;
    const first = keys[0] as Key & { pose: Pose };
    const span = 1 - a.t + first.t;
    const u = (t - a.t) / (span || 1);
    return blend(a.pose, first.pose, ease[first.ease ?? "inOut"](clamp(u, 0, 1)), sh);
  }
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  return blend(a.pose, b.pose, ease[b.ease ?? "inOut"](clamp(u, 0, 1)), sh);
}

// --------------------------------------------------------------------------------------------- locomotion

export interface GaitOpts {
  kind: "walk" | "run";
  /** Sprite px per full cycle (two steps). */
  stride: number;
  /** Fraction of the cycle each foot is planted (walk > 0.5: double support; run < 0.5: flight). */
  stance: number;
  /** Swing-foot lift (px), body bob (px), forward lean (deg). */
  lift: number;
  bob: number;
  lean: number;
  /** Pelvis yaw amplitude (deg) — the chest counter-twists by `counter` of it. */
  hipYaw: number;
  counter: number;
  /** Arm swing (px) of a FREE hand along the forward axis. */
  armSwing: number;
  /** Lateral foot placement (half distance between feet). */
  width: number;
  /** Extra crouch (a stalking rogue, a heavy tank). */
  drop?: number;
}

export interface GaitPose {
  footN: FootTarget;
  footF: FootTarget;
  drop: number;
  lean: number;
  hipYaw: number;
  twist: number;
  /** −1..1: how far forward a free near / far hand swings this frame. */
  swingN: number;
  swingF: number;
  sway: number;
}

/**
 * One frame of a stride at cycle phase `p` (0..1; 0 = the near foot's heel strike). The planted foot moves back linearly by exactly the
 * stride's share of the ground; the swinging foot lifts and comes through on an eased arc, heel first.
 */
export function gait(p: number, o: GaitOpts): GaitPose {
  const foot = (ph: number, z: number): FootTarget => {
    const q = ((ph % 1) + 1) % 1;
    const exc = o.stride * o.stance; // relative excursion of a planted foot over its stance
    if (q < o.stance) {
      const u = q / o.stance;
      // planted: from +exc/2 to −exc/2, heel strike → flat → push-off
      const pitch = u < 0.15 ? 14 * (1 - u / 0.15) : u > 0.75 ? -22 * ((u - 0.75) / 0.25) : 0;
      return { x: exc / 2 - exc * u, z, lift: 0, pitch };
    }
    const u = (q - o.stance) / (1 - o.stance);
    const e = ease.inOut(u);
    const lift = Math.sin(Math.PI * u) * o.lift * (o.kind === "run" ? 1 : 1);
    const pitch = u < 0.3 ? -22 * (1 - u / 0.3) : u > 0.8 ? 14 * ((u - 0.8) / 0.2) : 0;
    return { x: -exc / 2 + exc * e, z, lift, pitch };
  };
  const two = Math.cos(p * Math.PI * 4); // twice per cycle: +1 at each contact
  // walk: lowest at contact (double support), highest at mid-stance; run: lowest at mid-stance (compression), up in flight
  const bob = o.kind === "walk" ? o.bob * (0.5 + 0.5 * two) : o.bob * (0.5 - 0.5 * Math.cos((p - 0.12) * Math.PI * 4));
  const s = Math.sin(p * Math.PI * 2);
  return {
    footN: foot(p, o.width),
    footF: foot(p + 0.5, -o.width),
    drop: (o.drop ?? 0.6) + bob,
    lean: o.lean,
    hipYaw: o.hipYaw * Math.cos(p * Math.PI * 2),
    twist: -o.hipYaw * o.counter * Math.cos(p * Math.PI * 2),
    swingN: -Math.cos(p * Math.PI * 2),
    swingF: Math.cos(p * Math.PI * 2),
    sway: (o.kind === "run" ? 2.6 : 1.4) + s * 0.5,
  };
}
