import { TAG, type Material } from "./gbuffer";
import type { Skeleton } from "./rig";
import { add, dist, lerp3, mul, norm, sub, type Frame, type V3 } from "./vec";
import { fp, type Painter } from "./view";

/**
 * HERO RENDERER v3 — the BODY: volumes built on the solved skeleton.
 *
 *   torso    pelvis, waist and chest are three ellipsoids in their own frames (the chest leans and twists with the spine), so a tabard or a
 *            breastplate wraps a real rounded torso instead of a flat panel; shoulder caps (deltoids) join the arms to the chest
 *   limbs    one swept sphere per segment, tapering (shoulder → elbow → wrist, hip → knee → ankle) — joints are round and seamless
 *   hands    a small fist at the wrist, drawn over whatever it holds (the grip passes THROUGH the fist)
 *   feet     a sole-flat boot from heel to toe along the foot frame (the floor cuts its underside flat)
 *   head     cranium + jaw + nose + ears in the head frame (face.ts adds the features)
 *
 * Outline groups: an upper arm, its forearm and its hand are one group (no seam at the elbow); the near arm and the torso are different groups
 * (an interior line where the arm crosses the chest).
 */

export const GROUP = { BODY: 1, HEAD: 2, ARM_N: 3, ARM_F: 4, LEG_N: 5, LEG_F: 6, WEAPON: 7, WEAPON2: 8, SHIELD: 9, HAIR: 10, HELM: 11, CAPE: 12, FX: 13, GEAR: 14 } as const;

/** What covers each body region (skin, cloth, leather, steel …) — the outfit decides, the body draws. */
export interface Dress {
  thigh: Material;
  shin: Material;
  foot: Material;
  /** Boot shaft: how far up the shin (0 = shoe only … 1 = to the knee) and its material. */
  boot: { mat: Material; top: number; cuff?: Material } | null;
  pelvis: Material;
  waist: Material;
  chest: Material;
  upperArm: Material;
  forearm: Material;
  /** Gloves / gauntlets cover the forearm from this fraction (from the wrist) and the hand. */
  glove: { mat: Material; top: number } | null;
  hand: Material;
  neck: Material;
  /** Limb thickness multipliers for clothing bulk (padded sleeves, plate legs). */
  armBulk?: number;
  legBulk?: number;
  torsoBulk?: number;
}

export interface BodyIds {
  head: number;
  jaw: number;
  nose: number;
  ears: number;
  neck: number;
  chest: number;
  waist: number;
  pelvis: number;
  handN: number;
  handF: number;
  /** Skin surfaces a face stamp may land on. */
  faceSkin: Set<number>;
}

export interface HeadShape {
  /** Cranium radii (fractions of headR): forward, up, lateral. */
  cr: V3;
  /** Jaw ellipsoid: centre and radii (fractions of headR). */
  jc: V3;
  jr: V3;
  /** Nose size multiplier. */
  nose: number;
}

export const HEAD_SHAPES: Record<"round" | "square" | "long" | "broad" | "sharp", HeadShape> = {
  round: { cr: [0.95, 1.0, 0.9], jc: [0.2, -0.42, 0], jr: [0.74, 0.6, 0.76], nose: 1 },
  square: { cr: [0.95, 0.98, 0.92], jc: [0.18, -0.45, 0], jr: [0.8, 0.6, 0.84], nose: 1.1 },
  long: { cr: [0.92, 1.02, 0.86], jc: [0.2, -0.52, 0], jr: [0.7, 0.66, 0.7], nose: 1.15 },
  broad: { cr: [0.98, 0.96, 0.98], jc: [0.16, -0.4, 0], jr: [0.82, 0.58, 0.9], nose: 1.2 },
  sharp: { cr: [0.94, 1.0, 0.86], jc: [0.3, -0.46, 0], jr: [0.66, 0.6, 0.62], nose: 0.9 },
};

/** A limb segment as a tapered swept sphere. */
function seg(pt: Painter, a: V3, b: V3, ra: number, rb: number, part: number, zBias = 0): void {
  pt.capsule(a, b, ra, rb, part, zBias ? { zBias } : undefined);
}

/** Draws the legs (thighs, shins, boots, feet). */
export function drawLegs(pt: Painter, sk: Skeleton, d: Dress): void {
  const b = sk.plan;
  const bulk = d.legBulk ?? 1;
  for (const side of ["N", "F"] as const) {
    const near = side === "N";
    const hip = near ? sk.hipN : sk.hipF;
    const knee = near ? sk.kneeN : sk.kneeF;
    const ankle = near ? sk.ankleN : sk.ankleF;
    const foot = near ? sk.footN : sk.footF;
    const group = near ? GROUP.LEG_N : GROUP.LEG_F;
    const bias = near ? 0 : -1;
    const tagL = near ? TAG.LEG_N : TAG.LEG_F;
    const thigh = pt.part(`thigh${side}`, d.thigh, group, tagL, bias);
    const shin = pt.part(`shin${side}`, d.shin, group, tagL, bias);
    seg(pt, hip, knee, b.legR[0] * bulk, b.legR[1] * bulk, thigh);
    seg(pt, knee, ankle, b.legR[1] * bulk, b.legR[2] * bulk, shin);
    if (d.boot && d.boot.top > 0) {
      const boot = pt.part(`boot${side}`, d.boot.mat, group, TAG.FOOT, bias);
      const top = lerp3(ankle, knee, Math.min(0.95, d.boot.top));
      seg(pt, top, ankle, b.legR[2] * bulk * 1.18 + 0.15, b.legR[2] * bulk * 1.12 + 0.1, boot, 0.2);
      if (d.boot.cuff) {
        const cuff = pt.part(`cuff${side}`, d.boot.cuff, group, TAG.FOOT, bias);
        const c2 = lerp3(top, ankle, 0.22);
        seg(pt, top, c2, b.legR[2] * bulk * 1.38 + 0.25, b.legR[2] * bulk * 1.3 + 0.2, cuff, 0.4);
      }
    }
    const fm = pt.part(`foot${side}`, d.foot, group, TAG.FOOT, bias);
    drawFoot(pt, foot, b.foot, fm);
  }
}

/** A boot: a rounded block from heel to toe, its underside cut flat by the floor. */
function drawFoot(pt: Painter, f: Frame, m: { heel: number; toe: number; h: number; w: number }, part: number): void {
  const mid = (m.toe - m.heel) / 2;
  // the toe cap and the heel as two overlapping ellipsoids → a boot profile (higher instep, lower toe)
  pt.blob(f, [mid + 0.2, -0.75, 0], (m.toe + m.heel) / 2 + 0.2, m.h + 0.7, m.w, part, { zBias: 0.1 });
  pt.blob(f, [-0.1, -0.3, 0], m.heel + 0.5, m.h + 0.9, m.w * 0.95, part, { zBias: 0.1 });
}

/** Draws pelvis, waist, chest, shoulder caps and neck. */
export function drawTorso(pt: Painter, sk: Skeleton, d: Dress, ids: Partial<BodyIds>): void {
  const b = sk.plan;
  const tb = d.torsoBulk ?? 1;
  const pelvis = pt.part("pelvis", d.pelvis, GROUP.BODY, TAG.TORSO);
  const waist = pt.part("waist", d.waist, GROUP.BODY, TAG.TORSO);
  const chest = pt.part("chest", d.chest, GROUP.BODY, TAG.TORSO);
  const neck = pt.part("neck", d.neck, GROUP.BODY, TAG.TORSO);
  ids.pelvis = pelvis;
  ids.waist = waist;
  ids.chest = chest;
  ids.neck = neck;
  pt.blob(sk.pelvis, [0, 0, 0], b.pelvis.d * tb, b.pelvis.h, b.pelvis.w * tb, pelvis);
  // the waist sits between pelvis and chest, in the chest's lean
  const wc = lerp3(sk.pelvis.o, sk.chest.o, 0.5);
  pt.blob({ ...sk.chest, o: wc }, [b.belly * 0.5, 0, 0], (b.waist.d + b.belly * 0.6) * tb, (b.chestUp * 0.36), b.waist.w * tb, waist);
  pt.blob(sk.chest, [0.1, 0.3, 0], b.chest.d * tb, b.chest.h, b.chest.w * tb, chest);
  // deltoids: round the shoulder line into the arms
  for (const sh of [sk.shoulderN, sk.shoulderF]) pt.sphere(sh, b.armR[0] * (d.armBulk ?? 1) * 1.12, chest);
  seg(pt, sk.neckBase, sk.headPivot, b.neckR * 1.05, b.neckR * 0.95, neck);
}

/** Draws one arm (upper arm, forearm, glove, hand). The hand is drawn in front of whatever it grips. */
export function drawArm(pt: Painter, sk: Skeleton, d: Dress, side: "N" | "F", ids: Partial<BodyIds>, gripping: boolean): void {
  const b = sk.plan;
  const near = side === "N";
  const group = near ? GROUP.ARM_N : GROUP.ARM_F;
  const bias = near ? 0 : -1;
  const sh = near ? sk.shoulderN : sk.shoulderF;
  const el = near ? sk.elbowN : sk.elbowF;
  const ha = near ? sk.handN : sk.handF;
  const bulk = d.armBulk ?? 1;
  const tagA = near ? TAG.ARM_N : TAG.ARM_F;
  const up = pt.part(`upper${side}`, d.upperArm, group, tagA, bias);
  const fo = pt.part(`fore${side}`, d.forearm, group, tagA, bias);
  seg(pt, sh, el, b.armR[0] * bulk, b.armR[1] * bulk, up);
  // the forearm stops short of the hand (the fist covers the wrist); a glove's cuff ends at the wrist, never over the fist
  const wrist = lerp3(el, ha, 0.74);
  seg(pt, el, wrist, b.armR[1] * bulk, b.armR[2] * bulk, fo);
  if (d.glove) {
    const gl = pt.part(`glove${side}`, d.glove.mat, group, tagA, bias);
    seg(pt, lerp3(wrist, el, Math.min(0.9, d.glove.top)), wrist, b.armR[2] * bulk * 1.18 + 0.15, b.armR[2] * bulk * 1.12 + 0.1, gl, 0.25);
  }
  const hand = pt.part(`hand${side}`, d.glove?.mat ?? d.hand, group, near ? TAG.HAND_N : TAG.HAND_F, bias);
  if (near) ids.handN = hand;
  else ids.handF = hand;
  // the fist: always a little wider than the wrist (a hand reads as a hand), drawn over its cuff and over whatever it grips
  const r = Math.max(b.handR * (d.glove ? 1.1 : 1), b.armR[2] * bulk * 1.2 + 0.25);
  const along = norm(sub(ha, el));
  pt.ellipsoid(add(ha, mul(along, 0.1)), mul(along, r * 1.05), [0, r * 0.95, 0], [0, 0, r * 0.95], hand, { zBias: gripping ? 2.2 : 0.6 });
}

/** Draws the head volumes (cranium, jaw, nose, ears). */
export function drawHead(pt: Painter, sk: Skeleton, skin: Material, shape: HeadShape, ids: Partial<BodyIds>, opts: { ears: boolean }): void {
  const R = sk.plan.headR;
  const h = sk.head;
  const head = pt.part("head", skin, GROUP.HEAD, TAG.HEAD);
  const jaw = pt.part("jaw", skin, GROUP.HEAD, TAG.HEAD);
  const nose = pt.part("nose", skin, GROUP.HEAD, TAG.HEAD);
  const ears = pt.part("ears", skin, GROUP.HEAD, TAG.HEAD);
  ids.head = head;
  ids.jaw = jaw;
  ids.nose = nose;
  ids.ears = ears;
  ids.faceSkin = new Set([head, jaw, nose]);
  pt.blob(h, [-0.04 * R, 0, 0], shape.cr[0] * R, shape.cr[1] * R, shape.cr[2] * R, head);
  pt.blob(h, [shape.jc[0] * R, shape.jc[1] * R, shape.jc[2] * R], shape.jr[0] * R, shape.jr[1] * R, shape.jr[2] * R, jaw);
  const nk = shape.nose;
  pt.blob(h, [0.9 * R, -0.3 * R, 0], 0.26 * R * nk, 0.2 * R * nk, 0.17 * R * nk, nose, { zBias: 0.05 });
  if (opts.ears) for (const s of [1, -1]) pt.blob(h, [-0.12 * R, -0.16 * R, s * 0.9 * R], 0.19 * R, 0.29 * R, 0.17 * R, ears, { zBias: 0.1 });
}

/** The point on the head where a face feature sits (head-local, in head radii). */
export const headPoint = (sk: Skeleton, x: number, y: number, z: number): V3 => fp(sk.head, x * sk.plan.headR, y * sk.plan.headR, z * sk.plan.headR);

export { dist };
