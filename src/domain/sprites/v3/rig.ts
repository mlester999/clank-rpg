import { hipHeight, type BodyPlan } from "./anatomy";
import { add, clamp, cross, DEG, dist, dot, frameAlong, len, mul, norm, rotY, rotZ, sub, type Frame, type V3 } from "./vec";

/**
 * HERO RENDERER v3 — the RIG: a pose (a handful of intentions: where the feet stand, where the hands go, how the spine leans and twists, which
 * way the weapon points) is SOLVED into a skeleton in character space.
 *
 *   · Feet are PLANTED targets on the floor; the legs reach them with two-bone IK (knees bend forward). If a pose asks for the hips higher
 *     than the legs can reach, the hips come down — a foot never floats and a leg never over-stretches.
 *   · Hands are targets in the chest's frame (or the world's); arms reach them with two-bone IK (elbows bend back and out), clamped to the
 *     arm's real length.
 *   · A weapon is attached to the hand that HOLDS it: its grip is the hand. A two-handed weapon's second grip is a point on the weapon; the other
 *     hand reaches for it, and if it cannot, the weapon (and the first hand) come in toward the body until it can — both hands are always on
 *     the grip. A bow's string hand is placed on the string at the pose's draw; a shield is strapped to its forearm.
 *   · A fall (knock-out) rotates the solved body rigidly and rests its lowest point on the floor.
 *
 * Conventions: X forward, Y up (0 = floor), Z the hero's right side. "N" (near) is the right side — nearest the camera in the authored,
 * right-facing view; "F" (far) is the left. Angles in poses are DEGREES (readable keyframes).
 */

export interface FootTarget {
  /** Forward position of the ankle's ground point (px from the anchor). */
  x: number;
  /** Lateral position; default ±stance. */
  z?: number;
  /** Height of the ankle above its standing height (a lifted foot in a stride). */
  lift?: number;
  /** Foot pitch in degrees: + toes up (heel strike), − toes down (push-off). */
  pitch?: number;
}

export type HandTarget =
  /** A point (the hand's centre) in the chest frame (x forward, y up, z right) — or the pelvis / world frame. */
  | { at: V3; space?: "chest" | "pelvis" | "world"; elbow?: V3 }
  /** Hold the main weapon's second grip (a two-hander, a staff across the body). */
  | { grip: true; elbow?: V3 }
  /** On the bow-string, drawn by the pose's `draw`. */
  | { string: true; elbow?: V3 };

export interface WeaponAim {
  /** Angle of the weapon's axis (up the blade / shaft) in the sagittal plane: 0 = up, 90 = forward, 180 = down, −90 = back. */
  angle: number;
  /** Tilt of the axis toward the hero's right (+) / left (−), degrees. */
  out?: number;
  /** Roll of the blade about its own axis, degrees (which way the edge / the bow's face looks). */
  roll?: number;
}

export type Eyes = "open" | "focus" | "wide" | "hurt" | "closed" | "dead" | "cheer" | "fierce";
export type Mouth = "rest" | "open" | "shout" | "grit" | "hurt" | "smile" | "o";

export interface Pose {
  /** Pelvis forward offset and how far it is lowered (+ = lower) from standing. */
  x: number;
  drop: number;
  /** Upper body lean forward (+) / back (−) at the pelvis, degrees; `side` leans toward the hero's right. */
  lean: number;
  side: number;
  /** Chest twist about the spine, degrees: + turns the near (right) shoulder forward. */
  twist: number;
  /** Pelvis yaw, degrees (+ turns the near hip forward). */
  hipYaw: number;
  /** Head pitch (+ looks down) and yaw (+ toward the hero's right), degrees, relative to the chest. */
  headPitch: number;
  headYaw: number;
  footN: FootTarget;
  footF: FootTarget;
  handN: HandTarget;
  handF: HandTarget;
  weapon: WeaponAim;
  /** The second weapon (a rogue's other dagger), held in the other hand. */
  weapon2: WeaponAim;
  /** Shield facing: yaw of its face (0 = straight forward, + toward the camera side), and pitch (+ tips its top forward). */
  shieldYaw: number;
  shieldPitch: number;
  /** Bow draw 0..1; magic glow 0..1. */
  draw: number;
  glow: number;
  eyes: Eyes;
  mouth: Mouth;
  /** Brow: −1 knit (angry / focused) … 0 … +1 raised. */
  brow: number;
  /** Cloth sway (+ = blown back) and breath (0..1 chest swell). */
  sway: number;
  breath: number;
  /** Rigid fall (knock-out), degrees: + falls forward, − backward. */
  fall: number;
  /** Fall slide along the floor (px, + forward). */
  fallX: number;
  /** Weapon dropped / released (KO): the weapon falls free instead of staying in the hand. */
  dropWeapon: number;
}

export const REST_POSE: Pose = {
  x: 0, drop: 0.4, lean: 4, side: 0, twist: 0, hipYaw: 0, headPitch: 0, headYaw: 0,
  footN: { x: 1.5 }, footF: { x: -1.5 },
  handN: { at: [1, -9, 4] }, handF: { at: [-1, -9, -4] },
  weapon: { angle: 60 }, weapon2: { angle: 60 },
  shieldYaw: 30, shieldPitch: 0, draw: 0, glow: 0,
  eyes: "open", mouth: "rest", brow: 0, sway: 0, breath: 0, fall: 0, fallX: 0, dropWeapon: 0,
};

/** How the hero holds its gear (from the weapon build). */
export interface HoldSpec {
  /** The hand that holds the main weapon (null: none). */
  main: "N" | "F" | null;
  /** Two-handed: the second grip's offset along the weapon axis (px, − = toward the pommel), held by the other hand when its target is `grip`. */
  grip2: number | null;
  /** A second weapon in the other hand. */
  second: boolean;
  /** Bow: distance from the grip back to the string at rest, and the full draw length. */
  bow: { brace: number; draw: number } | null;
  /** A shield strapped to the far forearm. */
  shield: boolean;
}

export interface Skeleton {
  plan: BodyPlan;
  pelvis: Frame;
  chest: Frame;
  /** Head frame: origin at the cranium centre, x = the face direction, y = up through the crown, z = the hero's right. */
  head: Frame;
  neckBase: V3;
  headPivot: V3;
  shoulderN: V3;
  shoulderF: V3;
  elbowN: V3;
  elbowF: V3;
  handN: V3;
  handF: V3;
  hipN: V3;
  hipF: V3;
  kneeN: V3;
  kneeF: V3;
  ankleN: V3;
  ankleF: V3;
  /** Foot frames: origin at the ankle, x along the foot (toward the toe), y up. */
  footN: Frame;
  footF: Frame;
  /** The main weapon's frame: origin at its grip (the holding hand), y up the blade / shaft, x the edge (forward-facing side), z the flat. */
  weapon: Frame | null;
  weapon2: Frame | null;
  /** Shield frame: origin at its centre, x = its face normal (outward), y = up along its face. */
  shield: Frame | null;
  /** Distance between the off hand and the point it was meant to hold (two-handed grip / bow-string), after solving. */
  gripError: number;
  /** World-space lowest point after a fall (for tests). */
  fallen: boolean;
  /** Which hand holds the main weapon. */
  hold: "N" | "F";
}

/**
 * Two-bone IK in 3-D: from root `s` toward target `t` with segment lengths a, b; `pole` hints where the middle joint goes. A target beyond
 * reach is approached with the limb straight (never stretched); one too close is pushed out to the minimum fold.
 */
export function ik(s: V3, t: V3, a: number, b: number, pole: V3): { mid: V3; end: V3 } {
  const d0 = dist(s, t);
  const u = d0 > 1e-6 ? mul(sub(t, s), 1 / d0) : ([0, -1, 0] as V3);
  const d = clamp(d0, Math.abs(a - b) + 0.15, a + b - 0.02);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  // the bend direction: the pole's component perpendicular to the limb axis
  let p = sub(pole, mul(u, dot(pole, u)));
  if (len(p) < 1e-6) p = Math.abs(u[1]) < 0.9 ? sub([0, 1, 0], mul(u, u[1])) : sub([1, 0, 0], mul(u, u[0]));
  const pn = norm(p);
  const mid = add(s, add(mul(u, a * cosA), mul(pn, a * sinA)));
  return { mid, end: add(s, mul(u, d)) };
}

/** The axis direction of a weapon aim, in character space. */
export function aimDir(w: WeaponAim, mirrorZ = 1): V3 {
  const a = w.angle * DEG;
  const o = (w.out ?? 0) * DEG * mirrorZ;
  return norm([Math.sin(a) * Math.cos(o), Math.cos(a) * Math.cos(o), Math.sin(o)]);
}

/** A weapon frame at `grip` along `axis`; the edge faces forward-ish (in the sagittal plane), rolled by `roll`. */
export function weaponFrame(grip: V3, axis: V3, roll: number): Frame {
  // forward hint perpendicular to the axis in the sagittal plane: rotate the axis by −90° about Z (up → forward)
  const hint: V3 = [axis[1], -axis[0], 0];
  const f = frameAlong(grip, axis, len(hint) > 1e-3 ? hint : [1, 0, 0]);
  if (!roll) return f;
  const c = Math.cos(roll * DEG);
  const s = Math.sin(roll * DEG);
  return { o: f.o, y: f.y, x: add(mul(f.x, c), mul(f.z, -s)), z: add(mul(f.x, s), mul(f.z, c)) };
}

const at = (f: Frame, p: V3): V3 => add(f.o, add(add(mul(f.x, p[0]), mul(f.y, p[1])), mul(f.z, p[2])));

/** Rotates a frame's axes by a function (a rigid rotation of a whole body). */
const rotFrame = (f: Frame, r: (v: V3) => V3, rp: (v: V3) => V3): Frame => ({ o: rp(f.o), x: r(f.x), y: r(f.y), z: r(f.z) });

export function solve(b: BodyPlan, pose: Pose, hold: HoldSpec): Skeleton {
  const hipY0 = hipHeight(b);
  const yaw = pose.hipYaw * DEG;
  // ---- legs first: where the hips can be
  const footTarget = (f: FootTarget, side: 1 | -1): V3 => [f.x, b.ankle + (f.lift ?? 0), f.z ?? side * b.stance];
  const ankleN0 = footTarget(pose.footN, 1);
  const ankleF0 = footTarget(pose.footF, -1);
  const hipOffset = (side: 1 | -1): V3 => rotY([0, -b.pelvisUp, side * b.hipHalf], yaw);
  const legLen = (b.thigh + b.shin) * 0.992;
  let pelvisY = hipY0 + b.pelvisUp - pose.drop;
  for (const [ankle, side] of [[ankleN0, 1], [ankleF0, -1]] as const) {
    const ho = hipOffset(side);
    const dx = pose.x + ho[0] - ankle[0];
    const dz = ho[2] - ankle[2];
    const h2 = legLen * legLen - dx * dx - dz * dz;
    const maxY = ankle[1] + (h2 > 0 ? Math.sqrt(h2) : 0) - ho[1];
    if (pelvisY > maxY) pelvisY = maxY;
  }
  const pelvisO: V3 = [pose.x, pelvisY, 0];
  const lean = pose.lean * DEG;
  const side = pose.side * DEG;
  const pelvisRot = (v: V3): V3 => rotY(v, yaw);
  const pelvis: Frame = { o: pelvisO, x: pelvisRot([1, 0, 0]), y: pelvisRot([0, 1, 0]), z: pelvisRot([0, 0, 1]) };

  // ---- spine: lean (+ hunch for the upper spine), side lean, twist
  const tw = pose.twist * DEG;
  const chestRot = (v: V3): V3 => rotZ(rotX2(rotY(v, tw + yaw * 0.5), side), lean + b.hunch * 0.55);
  const upperRot = (v: V3): V3 => rotZ(rotX2(rotY(v, tw + yaw * 0.5), side), lean + b.hunch);
  const breathK = 1 + pose.breath * 0.035;
  const chestO = add(pelvisO, chestRot([0, b.chestUp * (1 - b.hunch * 0.15), 0]));
  const chest: Frame = { o: chestO, x: chestRot([1, 0, 0]), y: chestRot([0, 1, 0]), z: chestRot([0, 0, 1]) };
  const neckBase = add(pelvisO, add(chestRot([0, b.chestUp, 0]), upperRot([0, (b.neckUp - b.chestUp) * breathK, 0])));
  const up: Frame = { o: neckBase, x: upperRot([1, 0, 0]), y: upperRot([0, 1, 0]), z: upperRot([0, 0, 1]) };
  const shoulderN = at(up, [-0.2, -1.2, b.shoulderHalf]);
  const shoulderF = at(up, [-0.2, -1.2, -b.shoulderHalf]);

  // ---- head: keeps itself fairly upright against the lean (people look at their foe, not the floor)
  const headPivot = at(up, [0.5, b.neck, 0]);
  const hp = (pose.headPitch - (pose.lean + b.hunch / DEG) * 0.55) * DEG;
  const hy = pose.headYaw * DEG;
  // + headYaw turns the face toward the hero's right (the camera side in the authored view): rotY(−a)
  const headRot = (v: V3): V3 => rotZ(rotY(rotX2(v, side * -0.5), -hy + tw * 0.25 + yaw * 0.5), lean + b.hunch + hp);
  const headO = add(headPivot, headRot([0.2, b.headR * 0.92, 0]));
  const head: Frame = { o: headO, x: headRot([1, 0, 0]), y: headRot([0, 1, 0]), z: headRot([0, 0, 1]) };

  // ---- arms
  const handPoint = (t: HandTarget): V3 | null => {
    if (!("at" in t)) return null;
    if (t.space === "world") return t.at;
    if (t.space === "pelvis") return at(pelvis, t.at);
    return at(chest, t.at);
  };
  const elbowPole = (sideZ: 1 | -1, t: HandTarget): V3 => (t.elbow ? [t.elbow[0], t.elbow[1], t.elbow[2] * sideZ] : add(mul(chest.x, -0.9), add(mul(chest.y, -0.55), mul(chest.z, 0.5 * sideZ))));
  const armSolve = (sh: V3, target: V3, sideZ: 1 | -1, t: HandTarget) => ik(sh, target, b.upperArm, b.forearm, elbowPole(sideZ, t));

  const mainIsN = hold.main === "N";
  const mainT = hold.main === null ? null : mainIsN ? pose.handN : pose.handF;
  const offT = hold.main === null ? null : mainIsN ? pose.handF : pose.handN;
  const mainSh = mainIsN ? shoulderN : shoulderF;
  const offSh = mainIsN ? shoulderF : shoulderN;
  const mainSide: 1 | -1 = mainIsN ? 1 : -1;

  let elbowN: V3;
  let elbowF: V3;
  let handN: V3;
  let handF: V3;
  let weapon: Frame | null = null;
  let weapon2: Frame | null = null;
  let gripError = 0;

  const axis = aimDir(pose.weapon);
  const solveFree = (sh: V3, t: HandTarget, sideZ: 1 | -1) => {
    const p = handPoint(t) ?? at(chest, [0, -8, 3 * sideZ]);
    return armSolve(sh, p, sideZ, t);
  };

  if (hold.main !== null && mainT) {
    let target = handPoint(mainT) ?? at(chest, [3, -4, 2 * mainSide]);
    let main = armSolve(mainSh, target, mainSide, mainT);
    let wf = weaponFrame(main.end, axis, pose.weapon.roll ?? 0);
    let off: { mid: V3; end: V3 } | null = null;
    if (offT && ("grip" in offT || "string" in offT)) {
      const offPoint = (f: Frame): V3 => {
        if ("grip" in offT) return at(f, [0, hold.grip2 ?? -2.6, 0]);
        // bow string: behind the grip along −x (the arrow flies along +x of the bow frame), at the pose's draw
        const bow = hold.bow ?? { brace: 2, draw: 7 };
        return at(f, [-(bow.brace + bow.draw * clamp(pose.draw, 0, 1.2)), 0, 0]);
      };
      // iterate: if the off hand cannot reach its place, bring the weapon (and the main hand) toward the off shoulder
      for (let k = 0; k < 6; k++) {
        const want = offPoint(wf);
        off = armSolve(offSh, want, (-mainSide) as 1 | -1, offT);
        const err = dist(off.end, want);
        if (err < 0.25) break;
        const pull = mul(norm(sub(offSh, want)), err + 0.1);
        target = add(target, pull);
        main = armSolve(mainSh, target, mainSide, mainT);
        wf = weaponFrame(main.end, axis, pose.weapon.roll ?? 0);
      }
      const want = offPoint(wf);
      off = armSolve(offSh, want, (-mainSide) as 1 | -1, offT);
      gripError = dist(off.end, want);
    } else if (offT) {
      off = solveFree(offSh, offT, (-mainSide) as 1 | -1);
    }
    weapon = wf;
    if (mainIsN) {
      elbowN = main.mid;
      handN = main.end;
      elbowF = off?.mid ?? shoulderF;
      handF = off?.end ?? shoulderF;
    } else {
      elbowF = main.mid;
      handF = main.end;
      elbowN = off?.mid ?? shoulderN;
      handN = off?.end ?? shoulderN;
    }
    if (hold.second) {
      const offHand = mainIsN ? handF : handN;
      weapon2 = weaponFrame(offHand, aimDir(pose.weapon2), pose.weapon2.roll ?? 0);
    }
  } else {
    const n = solveFree(shoulderN, pose.handN, 1);
    const f = solveFree(shoulderF, pose.handF, -1);
    elbowN = n.mid;
    handN = n.end;
    elbowF = f.mid;
    handF = f.end;
  }

  // ---- shield on the far forearm: centred a little past mid-forearm, pushed outward along its face
  let shield: Frame | null = null;
  if (hold.shield) {
    const sy = pose.shieldYaw * DEG;
    const sp = pose.shieldPitch * DEG;
    const face = norm(rotZ(rotY([1, 0, 0], -sy), -sp));
    // strapped along the forearm, centred near the hand (the fist holds the grip behind it), standing off the arm along its face
    const mid: V3 = add(elbowF, mul(sub(handF, elbowF), 0.78));
    const f0 = frameAlong(add(mid, mul(face, 2.0)), rotZ([0, 1, 0], -sp), face);
    // frameAlong puts y along "up"; make x the face normal exactly
    const x = face;
    const z = norm(cross(x, f0.y));
    shield = { o: f0.o, x, y: norm(cross(z, x)), z };
  }

  // ---- legs: IK to the planted feet from the final hips
  const hipN = add(pelvisO, hipOffset(1));
  const hipF = add(pelvisO, hipOffset(-1));
  const kneePole = (s: 1 | -1): V3 => [1, 0.15, 0.22 * s];
  const legN = ik(hipN, ankleN0, b.thigh, b.shin, kneePole(1));
  const legF = ik(hipF, ankleF0, b.thigh, b.shin, kneePole(-1));
  const footFrame = (ankle: V3, f: FootTarget): Frame => {
    const p = (f.pitch ?? 0) * DEG;
    return { o: ankle, x: [Math.cos(p), Math.sin(p), 0], y: [-Math.sin(p), Math.cos(p), 0], z: [0, 0, 1] };
  };

  let sk: Skeleton = {
    plan: b, pelvis, chest, head, neckBase, headPivot, shoulderN, shoulderF, elbowN, elbowF, handN, handF,
    hipN, hipF, kneeN: legN.mid, kneeF: legF.mid, ankleN: legN.end, ankleF: legF.end,
    footN: footFrame(legN.end, pose.footN), footF: footFrame(legF.end, pose.footF),
    weapon, weapon2, shield, gripError, fallen: false, hold: hold.main === "F" ? "F" : "N",
  };
  if (pose.fall !== 0 || pose.fallX !== 0) sk = fallBody(sk, pose);
  return sk;
}

/** Roll about the forward (X) axis — the side lean. */
function rotX2(v: V3, a: number): V3 {
  if (!a) return v;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/** The points whose height decides where a fallen body rests (joints + the head's crown and the feet's toes). */
function restPoints(s: Skeleton): V3[] {
  const r = s.plan.headR;
  const pts = [s.pelvis.o, s.chest.o, s.neckBase, s.shoulderN, s.shoulderF, s.elbowN, s.elbowF, s.handN, s.handF, s.kneeN, s.kneeF, s.ankleN, s.ankleF];
  pts.push(add(s.head.o, mul(s.head.y, r)), add(s.head.o, mul(s.head.y, -r)), add(s.head.o, mul(s.head.x, r)), add(s.head.o, mul(s.head.x, -r)));
  pts.push(add(s.chest.o, mul(s.chest.x, -s.plan.chest.d)), add(s.chest.o, mul(s.chest.x, s.plan.chest.d)));
  return pts;
}

/**
 * A rigid fall: the whole solved body rotates about the foot it pivots on (the back foot for a fall backward, the front for a fall forward),
 * slides by `fallX`, and its lowest point rests on the floor.
 */
function fallBody(s: Skeleton, pose: Pose): Skeleton {
  const a = -pose.fall * DEG; // rotZ(+) tips up toward +X (forward): a forward fall is a positive rotation of the body's up toward +X
  const pivot = pose.fall >= 0 ? s.ankleN : s.ankleF;
  const piv: V3 = [pivot[0], 0, 0];
  const R = (v: V3): V3 => rotZ(v, -a);
  const P = (v: V3): V3 => add(add(piv, R(sub(v, piv))), [pose.fallX, 0, 0]);
  const F = (f: Frame | null): Frame | null => (f ? rotFrame(f, R, P) : null);
  const out: Skeleton = {
    ...s,
    pelvis: F(s.pelvis) as Frame, chest: F(s.chest) as Frame, head: F(s.head) as Frame,
    neckBase: P(s.neckBase), headPivot: P(s.headPivot), shoulderN: P(s.shoulderN), shoulderF: P(s.shoulderF),
    elbowN: P(s.elbowN), elbowF: P(s.elbowF), handN: P(s.handN), handF: P(s.handF), hipN: P(s.hipN), hipF: P(s.hipF),
    kneeN: P(s.kneeN), kneeF: P(s.kneeF), ankleN: P(s.ankleN), ankleF: P(s.ankleF),
    footN: F(s.footN) as Frame, footF: F(s.footF) as Frame, weapon: F(s.weapon), weapon2: F(s.weapon2), shield: F(s.shield), fallen: true,
  };
  // rest on the floor: the lowest body point (minus its volume) sits at y = 0.9 (a body's thickness)
  const low = Math.min(...restPoints(out).map((p) => p[1]));
  const lift = -low + Math.min(1.6, 0.5 + Math.abs(pose.fall) / 90);
  if (Math.abs(lift) > 1e-3) {
    const T = (v: V3): V3 => [v[0], v[1] + lift, v[2]];
    const TF = (f: Frame | null): Frame | null => (f ? { ...f, o: T(f.o) } : null);
    return {
      ...out,
      pelvis: TF(out.pelvis) as Frame, chest: TF(out.chest) as Frame, head: TF(out.head) as Frame,
      neckBase: T(out.neckBase), headPivot: T(out.headPivot), shoulderN: T(out.shoulderN), shoulderF: T(out.shoulderF),
      elbowN: T(out.elbowN), elbowF: T(out.elbowF), handN: T(out.handN), handF: T(out.handF), hipN: T(out.hipN), hipF: T(out.hipF),
      kneeN: T(out.kneeN), kneeF: T(out.kneeF), ankleN: T(out.ankleN), ankleF: T(out.ankleF),
      footN: TF(out.footN) as Frame, footF: TF(out.footF) as Frame, weapon: TF(out.weapon), weapon2: TF(out.weapon2), shield: TF(out.shield),
    };
  }
  return out;
}
