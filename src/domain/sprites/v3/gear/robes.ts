import { GROUP, type Dress } from "../body";
import { TAG, type Material } from "../gbuffer";
import { boneFrame, part, type Build } from "../kit";
import { lerp3 } from "../vec";

import { skirt, torsoShell } from "./garments";

/**
 * Robes (Mage, Cleric): a robe is the torso volumes in cloth + a FLOOR-LENGTH skirt whose hem follows the feet (it widens and shifts with a
 * stride, so a leg never pokes through) + bell sleeves that flare at the wrist. Shared by both caster classes; their designs differ in colour,
 * layering, trims, stoles and collars.
 */

export function robeDress(d: Dress, robe: Material, o: { sleeve?: Material; hands: Material; feet: Material }): Dress {
  return {
    ...d,
    chest: robe, waist: robe, pelvis: robe, upperArm: o.sleeve ?? robe, forearm: o.sleeve ?? robe, glove: null, hand: o.hands,
    thigh: robe, shin: robe, boot: { mat: o.feet, top: 0.25 }, foot: o.feet, armBulk: 1.18, torsoBulk: 1.06, legBulk: 1.0,
  };
}

/** The robe's skirt to the floor (and an optional second, longer layer in a trim colour peeking out at the hem). */
export function robeSkirt(b: Build, robe: Material, o: { trim?: Material | null; split?: Material | null; flare?: number } = {}): void {
  const flare = o.flare ?? 1.6;
  if (o.trim) skirt(b, o.trim, { len: 30, flare: flare + 0.2, floor: true, name: "robeHem", zBias: 0.2 });
  skirt(b, robe, { len: 30, flare, floor: true, name: "robe", zBias: 0.35 });
  // an under-robe showing through a front split (layered robes)
  if (o.split) skirt(b, o.split, { len: 30, flare: flare - 0.4, floor: true, name: "underRobe", zBias: 0.3 });
}

/** Bell sleeves: each forearm's cloth flares toward the wrist. */
export function bellSleeves(b: Build, mat: Material, flare = 1.0): void {
  const sk = b.sk;
  const pl = sk.plan;
  for (const side of ["N", "F"] as const) {
    const near = side === "N";
    const el = near ? sk.elbowN : sk.elbowF;
    const ha = near ? sk.handN : sk.handF;
    const p = part(b, `bell${side}`, mat, near ? GROUP.ARM_N : GROUP.ARM_F, near ? TAG.ARM_N : TAG.ARM_F, near ? 0 : -1);
    const wrist = lerp3(el, ha, 0.78);
    b.pt.capsule(lerp3(el, ha, 0.15), wrist, pl.armR[1] * 1.25, pl.armR[2] * 1.3 + flare, p, { zBias: 0.3 });
    void boneFrame;
  }
}

/** A stole / front band: a strip down the front of the chest and the skirt. */
export function stole(b: Build, mat: Material, w = 0.9): void {
  // a broad band over the shoulders and down the front: it reads from the side as well as from the front
  torsoShell(b, mat, { inflate: 0.55, waist: true, keep: (x, y, z) => (x > -0.6 && Math.abs(z) < w + 0.9) || y > 3.4, name: "stole" });
}

/** A high collar rising behind the head (the archmage's). */
export function highCollar(b: Build, mat: Material, h = 3.2): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, "collar", mat, GROUP.BODY, TAG.CLOTH);
  for (const s of [1, -1]) {
    const base = lerp3(sk.neckBase, sk.shoulderN, 0.35);
    const root = s > 0 ? base : lerp3(sk.neckBase, sk.shoulderF, 0.35);
    const top = [root[0] - 1.4, root[1] + h, root[2] * 1.05] as const;
    b.pt.capsule(root, top, 1.0, 0.5, p, { zBias: -0.2 });
  }
  void pl;
}
