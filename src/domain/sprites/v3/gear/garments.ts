import { GROUP } from "../body";
import { TAG, type Material, type PrimOpts } from "../gbuffer";
import { boneFrame, localClip, part, shell, type Build } from "../kit";
import { add, clamp, lerp, lerp3, mul, norm, sub, type Frame, type V3 } from "../vec";
import { fp } from "../view";

/**
 * HERO RENDERER v3 — GARMENT builders. Everything is defined on the body's own volumes and frames, so it wraps the body in every pose:
 *
 *   shells   the torso's pelvis / waist / chest ellipsoids inflated and cut by rules in their own coordinates (a breastplate's front and back,
 *            a tabard's panels with the mail showing at the sides, a belt band)
 *   rings    a skirt, a robe, a coat's tails: a ring of flat panels from a top ellipse to a hem ellipse (faceted panels read as cloth folds); the
 *            hem follows the legs (it widens and shifts as they stride, so a leg never pokes through a robe) and swings with the cloth sway
 *   domes    pauldrons in the upper arm's frame — they move with the arm and sit ON the shoulder joint
 */

/** A ring of panels between two horizontal ellipses (character space). `keep(a)` selects which panels exist (a = 0 forward, π/2 right). */
export function ring(b: Build, top: { c: V3; rx: number; rz: number }, bot: { c: V3; rx: number; rz: number }, prt: number, o: { n?: number; keep?: (a: number) => boolean; flare?: number; zBias?: number; clip?: PrimOpts["clip"] } = {}): void {
  const n = o.n ?? 12;
  const pt = (e: { c: V3; rx: number; rz: number }, a: number): V3 => add(e.c, [Math.cos(a) * e.rx, 0, Math.sin(a) * e.rz]);
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    if (o.keep && !o.keep(((am % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2))) continue;
    const quad = [pt(top, a0), pt(top, a1), pt(bot, a1), pt(bot, a0)];
    const normal = norm([Math.cos(am), o.flare ?? 0.25, Math.sin(am)]);
    b.pt.plate(quad, normal, prt, { zBias: o.zBias ?? 0, bulge: 0.15, clip: o.clip });
  }
}

/** The world point between the two hips at a height (the waist ring centre follows the pelvis). */
const pelvisAt = (b: Build, dy: number): V3 => add(b.sk.pelvis.o, mul(b.sk.pelvis.y, dy));

/**
 * A SKIRT (tabard tails, a gambeson's skirt, faulds, a robe): from the waist ring down to `len` px below the hips, flaring; the hem follows the
 * knees (or the feet, for a floor-length robe) and swings back with the cloth sway. `split` removes the side panels (a tabard: the legs show at
 * the sides).
 */
export function skirt(b: Build, mat: Material, o: { len: number; flare: number; split?: "sides" | "front" | null; top?: number; zBias?: number; floor?: boolean; name?: string; group?: number }): number {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, o.name ?? "skirt", mat, o.group ?? GROUP.BODY, TAG.CLOTH);
  const topY = o.top ?? 1.2;
  const top = { c: pelvisAt(b, topY), rx: pl.pelvis.d * 1.12 + 0.2, rz: pl.pelvis.w * 1.1 + 0.2 };
  // the hem: centred between the knees (or ankles), wide enough to cover both legs, pushed back by the sway
  const lo = o.floor ? [sk.ankleN, sk.ankleF] : [lerp3(sk.kneeN, sk.ankleN, 0.15), lerp3(sk.kneeF, sk.ankleF, 0.15)];
  const legMidX = ((lo[0] as V3)[0] + (lo[1] as V3)[0]) / 2;
  const spread = Math.abs((lo[0] as V3)[0] - (lo[1] as V3)[0]) / 2;
  const hipY = sk.pelvis.o[1] - pl.pelvisUp;
  const hemY = o.floor ? Math.max(0.6, 0.4) : Math.max(0.8, hipY - o.len);
  const t = clamp((hipY - hemY) / Math.max(1, hipY - (lo[0] as V3)[1]), 0, 1);
  const hemX = lerp(sk.pelvis.o[0], legMidX, t) - b.pose.sway * 0.12 * t;
  const rx = Math.max(top.rx + o.flare, spread + pl.legR[1] + 1.0 * t);
  const bot = { c: [hemX, hemY, 0] as V3, rx, rz: top.rz + o.flare * 0.9 };
  const keep = o.split === "sides" ? (a: number) => Math.abs(Math.sin(a)) < 0.62 : o.split === "front" ? (a: number) => Math.cos(a) < 0.55 : undefined;
  ring(b, top, bot, p, { n: 14, keep, flare: 0.18, zBias: o.zBias ?? 0.25 });
  return p;
}

/** A shell over the chest (and optionally the waist / pelvis), inflated by `inflate` px, cut by a rule in the chest frame. */
export function torsoShell(b: Build, mat: Material, o: { inflate: number; chest?: boolean; waist?: boolean; pelvis?: boolean; keep?: (x: number, y: number, z: number, w: number) => boolean; name?: string; zBias?: number; group?: number; tag?: number }): number {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, o.name ?? "shell", mat, o.group ?? GROUP.BODY, (o.tag as never) ?? TAG.TORSO);
  const i = o.inflate;
  const zb = o.zBias ?? 0.3;
  const tb = b.dress.torsoBulk ?? 1;
  if (o.chest !== false) shell(b, sk.chest, [0.1, 0.3, 0], [pl.chest.d * tb + i, pl.chest.h + i, pl.chest.w * tb + i], p, o.keep ? (x, y, z) => (o.keep as NonNullable<typeof o.keep>)(x, y + 0.3, z, pl.chest.w * tb) : null, { zBias: zb });
  if (o.waist) {
    const wc = lerp3(sk.pelvis.o, sk.chest.o, 0.5);
    const f: Frame = { ...sk.chest, o: wc };
    shell(b, f, [pl.belly * 0.5, 0, 0], [(pl.waist.d + pl.belly * 0.6) * tb + i, pl.chestUp * 0.36 + i * 0.5, pl.waist.w * tb + i], p, o.keep ? (x, y, z) => (o.keep as NonNullable<typeof o.keep>)(x, y - pl.chestUp * 0.5, z, pl.waist.w * tb) : null, { zBias: zb });
  }
  if (o.pelvis) shell(b, sk.pelvis, [0, 0, 0], [pl.pelvis.d * tb + i, pl.pelvis.h + i * 0.6, pl.pelvis.w * tb + i], p, o.keep ? (x, y, z) => (o.keep as NonNullable<typeof o.keep>)(x, y - pl.chestUp, z, pl.pelvis.w * tb) : null, { zBias: zb });
  return p;
}

/** A belt: a band around the waist (pelvis top), with a buckle in front. */
export function belt(b: Build, mat: Material, buckle: Material | null, o: { y?: number; w?: number; name?: string } = {}): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, o.name ?? "belt", mat, GROUP.BODY, TAG.GEAR);
  const y = o.y ?? pl.pelvis.h * 0.62;
  const half = (o.w ?? 1.5) / 2;
  const tb = b.dress.torsoBulk ?? 1;
  shell(b, sk.pelvis, [pl.belly * 0.3, y, 0], [pl.pelvis.d * tb + 0.75 + pl.belly * 0.3, half + 0.6, pl.pelvis.w * tb + 0.7], p, (_x, yy) => Math.abs(yy) < half, { zBias: 0.55 });
  if (buckle) {
    const bp = part(b, `${o.name ?? "belt"}Buckle`, buckle, GROUP.BODY, TAG.GEAR);
    b.pt.blob(sk.pelvis, [pl.pelvis.d * tb + 0.6 + pl.belly * 0.5, y, 0], 0.5, half + 0.35, 0.8, bp, { zBias: 0.7 });
  }
}

/** A sash: a cloth band at the waist with two tails hanging at the hip, swaying. */
export function sash(b: Build, mat: Material, o: { tails: number }): void {
  const sk = b.sk;
  const pl = sk.plan;
  belt(b, mat, null, { w: 1.8, name: "sash" });
  if (o.tails <= 0) return;
  const p = part(b, "sashTail", mat, GROUP.BODY, TAG.CLOTH);
  const root = fp(sk.pelvis, -pl.pelvis.d * 0.4, pl.pelvis.h * 0.5, pl.pelvis.w * 0.95);
  const tip = add(root, [-1.2 - b.pose.sway * 0.45, -o.tails, 0.3]);
  b.pt.capsule(root, tip, 0.9, 0.55, p, { zBias: 0.4 });
  b.pt.capsule(add(root, [0.3, 0, -0.5]), add(tip, [0.8, 1.2, -0.6]), 0.7, 0.45, p, { zBias: 0.35 });
}

/**
 * PAULDRONS: stacked domes on each shoulder in the upper arm's frame (they rise and swing with the arm), sitting on the shoulder joint.
 * `layers` lames (1–3), `size` scale, a rim of `trim`, and optional spikes / a crest.
 */
export function pauldrons(b: Build, mat: Material, o: { size: number; layers: number; trim: Material | null; spikes?: Material | null; flare?: number }): void {
  const sk = b.sk;
  const pl = sk.plan;
  for (const side of ["N", "F"] as const) {
    const near = side === "N";
    const sh = near ? sk.shoulderN : sk.shoulderF;
    const el = near ? sk.elbowN : sk.elbowF;
    const out = near ? 1 : -1;
    const f0 = boneFrame(sh, el, [1, 0, 0]);
    // the bone frame's z must point OUTWARD from the body for this side
    const f: Frame = Math.sign(f0.z[2]) === out ? f0 : { ...f0, z: mul(f0.z, -1), x: mul(f0.x, -1) };
    const group = near ? GROUP.ARM_N : GROUP.ARM_F;
    const bias = near ? 0 : -1;
    const p = part(b, `pauldron${side}`, mat, group, TAG.ARM_N, bias);
    const s = o.size * Math.max(1, pl.armR[0] / 1.8);
    for (let k = 0; k < o.layers; k++) {
      const yk = -0.6 + k * 1.15 * s;
      const rk = (1 - k * 0.12) * s;
      shell(b, f, [0, yk, 0.55 * s], [2.5 * rk, 2.0 * rk, 2.5 * rk * (o.flare ?? 1)], p, (_x, y) => y < 0.9 * rk, { zBias: 0.6 + (o.layers - k) * 0.12 });
    }
    if (o.trim) {
      const tp = part(b, `pauldronTrim${side}`, o.trim, group, TAG.ARM_N, bias);
      const k = o.layers - 1;
      const yk = -0.6 + k * 1.15 * s;
      const rk = (1 - k * 0.12) * s;
      shell(b, f, [0, yk, 0.55 * s], [2.62 * rk, 2.1 * rk, 2.62 * rk * (o.flare ?? 1)], tp, (_x, y) => y > 0.15 * rk && y < 0.9 * rk, { zBias: 0.65 + 0.2 });
    }
    if (o.spikes) {
      const spp = part(b, `pauldronSpike${side}`, o.spikes, group, TAG.ARM_N, bias);
      const base = fp(f, -0.3, -1.4 * s, 1.4 * s);
      b.pt.capsule(base, add(base, add(mul(f.z, 1.6 * s), mul(sk.chest.y, 1.8 * s))), 0.55, 0.08, spp, { zBias: 0.9 });
    }
  }
}

/**
 * A CAPE from the shoulders down the back, swinging back with the sway and pooling at the floor — panels across the back half of a ring, so
 * it has folds and wraps the shoulders.
 */
export function cape(b: Build, mat: Material, o: { len: number; width: number; collar: Material | null }): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, "cape", mat, GROUP.CAPE, TAG.CLOTH, 0);
  const topC = add(sk.neckBase, mul(sk.chest.y, -1.2));
  const top = { c: add(topC, mul(sk.chest.x, -0.4)), rx: pl.chest.d + 0.6, rz: pl.shoulderHalf + 0.6 };
  const hemY = Math.max(0.7, topC[1] - o.len);
  const back = 1.6 + Math.max(0, b.pose.sway) * 0.9;
  const bot = { c: [topC[0] - back, hemY, 0] as V3, rx: pl.chest.d + 1.4 + Math.max(0, b.pose.sway) * 0.4, rz: (pl.shoulderHalf + 0.6) * o.width + 0.8 };
  ring(b, top, bot, p, { n: 12, keep: (a) => Math.cos(a) < -0.05, flare: 0.1, zBias: -0.3 });
  if (o.collar) {
    const cp = part(b, "capeClasp", o.collar, GROUP.BODY, TAG.GEAR);
    for (const s of [1, -1]) b.pt.sphere(fp(sk.chest, pl.chest.d * 0.6, pl.chest.h * 0.85, s * pl.chest.w * 0.62), 0.75, cp, { zBias: 0.8 });
  }
}

/** A collar / gorget ring at the base of the neck. */
export function gorget(b: Build, mat: Material, o: { h: number; r: number }): void {
  const sk = b.sk;
  const p = part(b, "gorget", mat, GROUP.BODY, TAG.TORSO);
  b.pt.capsule(sk.neckBase, add(sk.neckBase, mul(sk.chest.y, o.h)), sk.plan.neckR + o.r, sk.plan.neckR + o.r * 0.7, p, { zBias: 0.5 });
}

/** Studs / rivets on a torso shell: little bright dots at chest-local points. */
export function studs(b: Build, mat: Material, pts: readonly V3[], r = 0.45): void {
  const p = part(b, "studs", mat, GROUP.BODY, TAG.GEAR);
  for (const q of pts) b.pt.sphere(fp(b.sk.chest, q[0], q[1], q[2]), r, p, { zBias: 1.0 });
}

/** A quiver (or scabbard) strapped across the back: a box along a direction, with its contents poking out. */
export function backCase(b: Build, mat: Material, o: { len: number; r: number; tilt: number; contents: Material | null; trim: Material | null; side?: 1 | -1 }): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, "quiver", mat, GROUP.BODY, TAG.GEAR, 0);
  const s = o.side ?? -1;
  const c = fp(sk.chest, -pl.chest.d - o.r * 0.6, -0.5, s * pl.chest.w * 0.25);
  const dir = norm(add(mul(sk.chest.y, Math.cos(o.tilt)), mul(sk.chest.z, Math.sin(o.tilt) * -s)));
  const a = add(c, mul(dir, -o.len * 0.5));
  const bb = add(c, mul(dir, o.len * 0.5));
  b.pt.capsule(a, bb, o.r, o.r * 1.08, p, { zBias: -0.2 });
  if (o.trim) {
    const tp = part(b, "quiverTrim", o.trim, GROUP.BODY, TAG.GEAR);
    b.pt.capsule(sub(bb, mul(dir, 0.6)), bb, o.r * 1.12, o.r * 1.15, tp, { zBias: -0.1 });
  }
  if (o.contents) {
    const cp = part(b, "fletching", o.contents, GROUP.BODY, TAG.GEAR);
    for (const k of [-0.5, 0.5]) b.pt.capsule(add(bb, mul(sk.chest.x, k * 0.6)), add(add(bb, mul(dir, 2.2)), mul(sk.chest.x, k * 0.8)), 0.5, 0.35, cp, { zBias: -0.15 });
  }
}

/** A small pouch / book / bottle hanging from the belt at a pelvis-local point. */
export function beltItem(b: Build, mat: Material, at: V3, size: V3, name = "pouch"): void {
  const p = part(b, name, mat, GROUP.BODY, TAG.GEAR);
  b.pt.blob(b.sk.pelvis, at, size[0], size[1], size[2], p, { zBias: 0.6 });
}

export { localClip };
