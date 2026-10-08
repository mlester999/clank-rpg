import {
  armB, armF, band, boot, circle, ellipse, floorLen, gem, hand, legB, legF, lerp, limb, line, lit, OL, path, poly, rrect, sub, torso, type BootStyle, type Chain, type Ctx, type Joints, type Pose, type Pt, type Ramp,
} from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — GARMENT pieces: the vocabulary every outfit design is assembled from. Each function returns Pieces (a depth, a material
 * and a drawing); a design lists the pieces it wears and `design()` turns them into layers.
 *
 * Depths:  18 legs + back sleeve · 19 boots, greaves, back glove · 20 the torso garment · 21 armour / panels over it · 22 belts, trim, details
 *          65 the near sleeve · 66 the near arm's armour / glove · (67 the pauldron sub-slot, 70 the weapon)
 *
 * Torso-local frame (origin at the hip, −y up, +x the way the hero faces); the light comes from the top-front: fronts and tops are lit, backs
 * and undersides fall into shadow.
 */

export const Z = { legs: 18, boots: 19, torso: 20, over: 21, detail: 22, sleeveF: 65, armourF: 66 } as const;

/** Top of the torso garment for a skeleton (just above the neck point). */
export const topY = (j: Joints): number => -j.b.torso - 0.4;
/** The shoulder line in torso space. */
export const shoulderY = (j: Joints): number => -j.b.torso + 2.4;

// ======================================================================================
// Legs and feet
// ======================================================================================

export interface LegOpts {
  w1?: number;
  w2?: number;
  /** How far down the shin (0..1). */
  to?: number;
  texture?: "none" | "mail" | "quilt" | "wrap";
}

function legWear(g: Ctx, ch: Chain, w1: number, w2: number, to: number, fill: string, light: string | null): void {
  limb(g, ch.a, ch.b, lerp(ch.b, ch.c, to), w1, w2, fill, light);
}

/** Trousers / chausses / hose on both legs. */
export function trousers(mat: Mat, o: LegOpts = {}): Piece {
  return piece(Z.legs, mat, (g, _p, j, r) => {
    const w1 = (o.w1 ?? 5.2) * j.b.leg;
    const w2 = (o.w2 ?? 4.4) * j.b.leg;
    const to = o.to ?? 0.62;
    for (const [ch, front] of [[legB(j), false], [legF(j), true]] as const) {
      legWear(g, ch, w1, w2, to, front ? r.base : r.lo, front ? r.hi : null);
      if (o.texture === "mail") {
        for (const t of [0.25, 0.5, 0.75]) band(g, ch.a, ch.b, t, w1 - 0.6, 0.5, front ? r.lo : r.deep);
        for (const t of [0.3, 0.6]) band(g, ch.b, ch.c, t * to, w2 - 0.6, 0.5, front ? r.lo : r.deep);
      } else if (o.texture === "quilt") {
        line(g, lerp(ch.a, ch.b, 0.1), lerp(ch.b, ch.c, to * 0.8), 0.6, front ? r.lo : r.deep);
      } else if (o.texture === "wrap") {
        for (const t of [0.2, 0.5, 0.8]) band(g, ch.b, ch.c, t * to, w2 + 0.4, 0.8, front ? r.lo : r.deep);
      }
    }
  });
}

/** Plate greaves + knee cops over the shins (both legs), and cuisses on the thighs when `thigh`. */
export function legPlates(mat: Mat, o: { thigh?: boolean; knee?: number } = {}): Piece {
  return piece(Z.boots, mat, (g, _p, j, r) => {
    for (const [ch, front] of [[legB(j), false], [legF(j), true]] as const) {
      const w = 4.6 * j.b.leg;
      if (o.thigh) limb(g, lerp(ch.a, ch.b, 0.25), ch.b, ch.b, w, w, front ? r.base : r.lo, front ? r.hi : null);
      limb(g, ch.b, lerp(ch.b, ch.c, 0.5), lerp(ch.b, ch.c, 0.82), w - 0.2, w - 0.6, front ? r.base : r.lo, front ? r.hi : null);
      const k = o.knee ?? 2.4;
      ellipse(g, ch.b[0] + 0.3, ch.b[1], k, k * 0.9, front ? r.hi : r.base, 0.8);
      circle(g, ch.b[0] + 0.6, ch.b[1] - 0.2, k * 0.35, front ? r.base : r.lo, 0);
    }
  });
}

/** Footwear on both feet. */
export function boots(mat: Mat, style: BootStyle, cuff: Ramp | null = null): Piece {
  return piece(Z.boots, mat, (g, _p, j, r) => {
    boot(g, j.kneeB, j.footB, style, r, false, cuff);
    boot(g, j.kneeF, j.footF, style, r, true, cuff);
  });
}

// ======================================================================================
// Sleeves, arms, hands
// ======================================================================================

export interface SleeveOpts {
  w1?: number;
  w2?: number;
  /** How far down the forearm (0..1). */
  to?: number;
  /** A bell sleeve opening toward the hand. */
  bell?: number;
  texture?: "none" | "mail" | "quilt";
}

function sleeveDraw(g: Ctx, ch: Chain, o: SleeveOpts, r: Ramp, front: boolean, j: Joints): void {
  const k = j.b.arm;
  const w1 = (o.w1 ?? 4.4) * k;
  const w2 = (o.w2 ?? 3.8) * k;
  const to = o.to ?? 0.75;
  if (o.bell) {
    const mid = lerp(ch.b, ch.c, to);
    limb(g, ch.a, ch.b, lerp(ch.b, ch.c, 0.15), w1, w2, front ? r.base : r.lo, front ? r.hi : null);
    const dx = mid[0] - ch.b[0];
    const dy = mid[1] - ch.b[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const b = o.bell;
    poly(g, [[ch.b[0] + nx * w2 * 0.5, ch.b[1] + ny * w2 * 0.5], [ch.b[0] - nx * w2 * 0.5, ch.b[1] - ny * w2 * 0.5], [mid[0] - nx * b, mid[1] - ny * b], [mid[0] + nx * b, mid[1] + ny * b]], front ? r.base : r.lo, 1);
    line(g, lerp(ch.b, mid, 0.2), [mid[0] + nx * b * 0.4, mid[1] + ny * b * 0.4], 0.6, front ? r.lo : r.deep);
    return;
  }
  limb(g, ch.a, ch.b, lerp(ch.b, ch.c, to), w1, w2, front ? r.base : r.lo, front ? r.hi : null);
  if (o.texture === "mail") for (const t of [0.35, 0.7]) band(g, ch.a, ch.b, t, w1 - 0.6, 0.5, front ? r.lo : r.deep);
  if (o.texture === "quilt") for (const t of [0.4, 0.8]) band(g, ch.a, ch.b, t, w1, 0.6, front ? r.lo : r.deep);
}

/** The back arm's sleeve (behind the torso). */
export function sleeveBack(mat: Mat, o: SleeveOpts = {}): Piece {
  return piece(Z.legs, mat, (g, _p, j, r) => sleeveDraw(g, armB(j), o, r, false, j));
}
/** The near arm's sleeve (in front of the torso). */
export function sleeveFront(mat: Mat, o: SleeveOpts = {}): Piece {
  return piece(Z.sleeveF, mat, (g, _p, j, r) => sleeveDraw(g, armF(j), o, r, true, j));
}
/** Both sleeves. */
export const sleeves = (mat: Mat, o: SleeveOpts = {}): Piece[] => [sleeveBack(mat, o), sleeveFront(mat, o)];

/** Bracers / vambraces on the forearms (back one behind the body, front one in front), with a couter at the elbow for plate. */
export function bracers(mat: Mat, o: { plate?: boolean; from?: number; to?: number; w?: number } = {}): Piece[] {
  const draw = (back: boolean) => (g: Ctx, _p: Pose, j: Joints, r: Ramp) => {
    const ch = back ? armB(j) : armF(j);
    const w = (o.w ?? (o.plate ? 4.2 : 3.8)) * j.b.arm;
    limb(g, lerp(ch.b, ch.c, o.from ?? 0.25), lerp(ch.b, ch.c, ((o.from ?? 0.25) + (o.to ?? 0.85)) / 2), lerp(ch.b, ch.c, o.to ?? 0.85), w, w - 0.4, back ? r.lo : r.base, back ? null : r.hi);
    if (o.plate) circle(g, ch.b[0], ch.b[1], 2.1 * j.b.arm, back ? r.base : r.hi, 0.8);
    else band(g, ch.b, ch.c, o.to ?? 0.85, w + 0.6, 0.9, back ? r.deep : r.lo);
  };
  return [piece(Z.boots, mat, draw(true)), piece(Z.armourF, mat, draw(false))];
}

/** Gloves / gauntlets over both hands. */
export function gloves(mat: Mat, o: { cuff?: boolean; size?: number } = {}): Piece[] {
  const draw = (back: boolean) => (g: Ctx, _p: Pose, j: Joints, r: Ramp) => {
    const ch = back ? armB(j) : armF(j);
    if (o.cuff) limb(g, lerp(ch.b, ch.c, 0.62), lerp(ch.b, ch.c, 0.8), lerp(ch.b, ch.c, 0.92), 4 * j.b.arm, 4.4 * j.b.arm, back ? r.lo : r.base, null);
    hand(g, ch.b, ch.c, back ? r.lo : r.base, o.size ?? 1.08);
  };
  return [piece(Z.boots, mat, draw(true)), piece(Z.armourF, mat, draw(false))];
}

// ======================================================================================
// Torso garments
// ======================================================================================

export interface BodyOpts {
  /** Half-widths: shoulders, waist, hem (bottom of the skirt). */
  sh?: number;
  wa?: number;
  hem?: number;
  /** Bottom of the garment (torso-local y; 0 = the hip joints, +7 mid-thigh, +12 the knee, +15 the ankle). */
  len?: number;
  /** Split skirt: a slit up the front of the hem to this y. */
  split?: number;
  /** Cloth sway of the hem (robes, long coats). */
  flow?: number;
  /** Surface pattern. */
  texture?: "none" | "quilt" | "studs" | "scales" | "lames" | "mail" | "lamellar" | "folds";
  /** A darker band down the back (shading) — default on. */
  shade?: boolean;
}

/** The silhouette of a garment worn on the torso, down to `len`, with an optional slit; a long hem sways with the pose. */
export function bodyShape(g: Ctx, j: Joints, p: Pose, o: BodyOpts): Pt[] {
  const top = topY(j);
  const c = j.b.chest;
  const sh = (o.sh ?? 7.4) * c;
  const wa = (o.wa ?? 6.2) * c;
  const hem = (o.hem ?? 7.4) * c;
  const len = Math.min(o.len ?? 1, floorLen(j, 1.6, hem));
  const sw = (o.flow ?? 0) * p.capeSway * 0.35;
  const pts: Pt[] = [[-sh, top], [sh, top], [wa, -4.2]];
  if (len > 1) {
    pts.push([wa + 0.4, 0], [hem + sw * 0.5, len]);
    if (o.split !== undefined) pts.push([1 + sw * 0.3, len], [0.4, o.split], [-0.6 + sw * 0.3, len]);
    pts.push([-hem + sw, len], [-wa - 0.4, 0]);
  } else {
    pts.push([hem * 0.95, len], [-hem * 0.95, len]);
  }
  pts.push([-wa, -4.2]);
  return pts;
}

/** Surface patterns, clipped to a garment outline. */
function texture(g: Ctx, kind: BodyOpts["texture"], pts: readonly Pt[], r: Ramp, top: number, bottom: number): void {
  if (!kind || kind === "none") return;
  g.save();
  path(g, pts);
  g.clip();
  const xs = pts.map((q) => q[0]);
  const x0 = Math.min(...xs) - 1;
  const x1 = Math.max(...xs) + 1;
  switch (kind) {
    case "quilt":
      for (let x = x0 + 2.4; x < x1; x += 2.8) line(g, [x, top + 1], [x + 0.3, bottom], 0.7, r.lo);
      for (let y = top + 4; y < bottom; y += 5) line(g, [x0, y], [x1, y], 0.5, r.lo);
      break;
    case "studs":
      for (let y = top + 2.2; y < bottom - 0.6; y += 2.6) for (let x = x0 + 2; x < x1 - 1; x += 2.6) circle(g, x + ((y / 2.6) % 2) * 0.6, y, 0.5, r.hi, 0);
      break;
    case "scales":
      for (let y = top + 1.6, row = 0; y < bottom + 1; y += 2.2, row++) {
        for (let x = x0 + (row % 2) * 1.4; x < x1; x += 2.8) {
          g.beginPath();
          g.arc(x, y, 1.5, 0, Math.PI);
          g.strokeStyle = r.lo;
          g.lineWidth = 0.6;
          g.stroke();
        }
      }
      break;
    case "lames":
      for (let y = top + 3.2; y < bottom; y += 2.4) {
        line(g, [x0, y], [x1, y], 0.7, r.lo);
        line(g, [x0, y + 0.7], [x1, y + 0.7], 0.5, r.hi);
      }
      break;
    case "mail":
      for (let y = top + 1.8; y < bottom; y += 1.8) line(g, [x0, y], [x1, y], 0.55, r.lo);
      break;
    case "lamellar":
      for (let y = top + 2; y < bottom; y += 2.6) {
        line(g, [x0, y], [x1, y], 0.6, r.lo);
        for (let x = x0 + 1.2 + (Math.round(y) % 2); x < x1; x += 2) line(g, [x, y], [x, y + 2.6], 0.4, r.lo);
      }
      break;
    case "folds":
      for (const fx of [-3.8, 0.2, 3.6]) {
        line(g, [fx, -3.4], [fx * 1.7, bottom - 0.6], 0.7, r.lo);
        line(g, [fx - 0.7, -3.4], [fx * 1.7 - 0.9, bottom - 0.8], 0.5, r.hi);
      }
      break;
  }
  g.restore();
}

/** A torso garment: shirt, gambeson, jerkin, hauberk, coat, robe — its silhouette from BodyOpts, lit from the front, with a surface pattern. */
export function bodyGarment(z: number, mat: Mat, o: BodyOpts = {}): Piece {
  return piece(z, mat, (g, p, j, r) => {
    torso(g, j, () => {
      const pts = bodyShape(g, j, p, o);
      const top = topY(j);
      lit(g, () => sub(g, pts), r, { shadow: [2.6, -0.6], hi: () => sub(g, [[pts[1]![0] - 2.6, top + 0.6], [pts[1]![0] - 0.6, top + 0.6], [pts[2]![0] - 0.8, -4.6], [pts[2]![0] - 2.4, -4.6]]) });
      texture(g, o.texture, pts, r, top, Math.min(o.len ?? 1, floorLen(j, 1.6, (o.hem ?? 7.4) * j.b.chest)));
      path(g, pts);
      g.strokeStyle = OL;
      g.lineWidth = 1;
      g.stroke();
    });
  });
}

/** A TABARD / surcoat panel hanging over the chest (+ a back flap), split at the hem. */
export function tabard(mat: Mat, o: { w?: number; len?: number; split?: boolean; flow?: number; z?: number; sleeveless?: boolean } = {}): Piece {
  return piece(o.z ?? Z.over, mat, (g, p, j, r) => {
    torso(g, j, () => {
      const top = topY(j);
      const w = (o.w ?? 5.4) * j.b.chest;
      const len = Math.min(o.len ?? 8.6, floorLen(j, 1.6, w + 1));
      const sw = (o.flow ?? 0.6) * p.capeSway * 0.35;
      const pts: Pt[] = o.split === false
        ? [[-w, top], [w, top], [w - 0.2, -4], [w + 0.6 + sw * 0.4, len], [-w - 0.6 + sw, len], [-w + 0.2, -4]]
        : [[-w, top], [w, top], [w - 0.2, -4], [w + 0.6 + sw * 0.4, len], [0.7 + sw * 0.3, len], [0, len - 3.2], [-0.7 + sw * 0.5, len], [-w - 0.6 + sw, len], [-w + 0.2, -4]];
      lit(g, () => sub(g, pts), r, { shadow: [2.4, -0.4] });
      if (!o.sleeveless) poly(g, [[-w - 2.2, top + 0.2], [-w + 0.6, top + 0.2], [-w + 0.6, top + 3.6], [-w - 2.4, top + 3.2]], r.lo, 0.9); // the back shoulder strap
    });
  });
}

/** A PLATE: breastplate (+ backplate edge), with a lit ridge — over the torso. */
export function breastplate(mat: Mat, o: { sh?: number; wa?: number; bottom?: number; ridge?: boolean; z?: number } = {}): Piece {
  return piece(o.z ?? Z.over, mat, (g, _p, j, r) => {
    torso(g, j, () => {
      const top = topY(j) + 0.6;
      const c = j.b.chest;
      const sh = (o.sh ?? 7.8) * c;
      const wa = (o.wa ?? 6.6) * c;
      const bottom = o.bottom ?? -3.2;
      const pts: Pt[] = [[-sh, top], [sh, top + 0.4], [sh + 0.4, top + 4], [wa, bottom - 1.6], [wa - 1, bottom], [-wa + 1, bottom], [-wa, bottom - 1.6], [-sh - 0.2, top + 4]];
      lit(g, () => sub(g, pts), r, { shadow: [2.8, -0.8], hi: () => sub(g, [[0.6, top + 1], [3.4, top + 1.2], [2.8, bottom - 1.8], [1, bottom - 1.8]]) });
      if (o.ridge !== false) line(g, [1.6, top + 1], [1.6, bottom - 0.8], 0.8, r.lo);
      line(g, [-sh + 1, top + 0.8], [sh - 1, top + 1.2], 0.7, r.hi); // the rolled neck edge
    });
  });
}

/** Overlapping plate LAMES below the waist (a fauld), `rows` deep. */
export function fauld(mat: Mat, o: { rows?: number; w?: number; y?: number; z?: number } = {}): Piece {
  return piece(o.z ?? Z.over, mat, (g, _p, j, r) => {
    torso(g, j, () => {
      const c = j.b.chest;
      const w = (o.w ?? 7) * c;
      const y0 = o.y ?? -3.6;
      for (let i = (o.rows ?? 2) - 1; i >= 0; i--) {
        const y = y0 + i * 2.2;
        const ww = w + i * 0.5;
        rrect(g, -ww, y, ww * 2, 2.6, 0.8, i % 2 ? r.lo : r.base, 0.9);
        line(g, [-ww + 0.8, y + 0.6], [ww - 0.8, y + 0.6], 0.5, r.hi);
      }
    });
  });
}

/** TASSETS: plates hanging over the front of the thighs. */
export function tassets(mat: Mat, o: { len?: number; w?: number; z?: number; rows?: number } = {}): Piece {
  return piece(o.z ?? Z.over, mat, (g, p, j, r) => {
    torso(g, j, () => {
      const w = (o.w ?? 4.6) * j.b.chest;
      const len = Math.min(o.len ?? 6, floorLen(j, 1.6, w * 1.6));
      const sw = p.capeSway * 0.1;
      for (const [x, front] of [[-w * 0.95, false], [w * 0.55, true]] as const) {
        const pts: Pt[] = [[x - w * 0.55, -1.2], [x + w * 0.55, -1.2], [x + w * 0.62 + sw, len], [x - w * 0.5 + sw, len + 0.6]];
        poly(g, pts, front ? r.base : r.lo, 1);
        for (let k = 1; k < (o.rows ?? 2) + 1; k++) {
          const y = -1.2 + (len / ((o.rows ?? 2) + 1)) * k;
          line(g, [x - w * 0.52, y], [x + w * 0.58, y], 0.6, front ? r.lo : r.deep);
        }
        line(g, [x + w * 0.4, -0.6], [x + w * 0.46 + sw, len - 0.6], 0.6, front ? r.hi : r.base);
      }
    });
  });
}

/** A SKIRT (cloth or mail) hanging from the waist: straight, flared or cut into strips (pteruges). */
export function skirt(mat: Mat, o: { len?: number; w?: number; hem?: number; strips?: number; split?: boolean; z?: number; flow?: number; texture?: BodyOpts["texture"] } = {}): Piece {
  return piece(o.z ?? Z.torso, mat, (g, p, j, r) => {
    torso(g, j, () => {
      const c = j.b.chest;
      const w = (o.w ?? 6.8) * c;
      const hem = (o.hem ?? 8) * c;
      const len = Math.min(o.len ?? 7, floorLen(j, 1.6, hem));
      const sw = (o.flow ?? 0.5) * p.capeSway * 0.35;
      if (o.strips) {
        const n = o.strips;
        for (let i = 0; i < n; i++) {
          const t0 = i / n;
          const t1 = (i + 0.86) / n;
          const xa = -w + 2 * w * t0;
          const xb = -w + 2 * w * t1;
          const ha = -hem + 2 * hem * t0 + sw;
          const hb = -hem + 2 * hem * t1 + sw;
          poly(g, [[xa, -2.6], [xb, -2.6], [hb, len - (i % 2) * 0.8], [ha, len - (i % 2) * 0.8]], t0 > 0.5 ? r.base : r.lo, 0.9);
        }
        return;
      }
      const pts: Pt[] = o.split
        ? [[-w, -3], [w, -3], [hem + sw * 0.4, len], [0.8 + sw * 0.4, len], [0.2, len - 3.4], [-0.6 + sw * 0.6, len], [-hem + sw, len]]
        : [[-w, -3], [w, -3], [hem + sw * 0.4, len], [-hem + sw, len]];
      lit(g, () => sub(g, pts), r, { shadow: [2.2, -0.4] });
      texture(g, o.texture, pts, r, -3, len);
      path(g, pts);
      g.strokeStyle = OL;
      g.lineWidth = 1;
      g.stroke();
    });
  });
}

/** A BELT at the waist: strap, buckle and optional pouch / second strap. */
export function belt(mat: Mat, o: { y?: number; w?: number; h?: number; buckle?: Ramp | null; pouch?: Ramp | null; jewel?: Ramp | null; z?: number; sash?: boolean } = {}): Piece {
  return piece(o.z ?? Z.detail, mat, (g, p, j, r) => {
    torso(g, j, () => {
      const c = j.b.chest;
      const w = (o.w ?? 7.2) * c;
      const y = o.y ?? -4.6;
      const h = o.h ?? 2.4;
      rrect(g, -w, y, w * 2, h, 0.8, r.base, 1);
      line(g, [-w + 0.6, y + 0.5], [w - 0.6, y + 0.5], 0.5, r.hi);
      if (o.sash) {
        const sw = p.capeSway * 0.3;
        poly(g, [[-w + 0.4, y + 0.6], [-w + 2.4, y + 0.6], [-w + 0.6 + sw, y + 7.4], [-w - 1.4 + sw, y + 6.8]], r.lo, 0.9);
      }
      if (o.buckle) {
        rrect(g, 0.6, y - 0.4, 3, h + 0.8, 0.6, o.buckle.base, 0.8);
        rrect(g, 1.3, y + 0.3, 1.6, h - 0.6, 0.3, o.buckle.lo, 0);
      }
      if (o.jewel) gem(g, 2.1, y + h / 2, 1.3, o.jewel);
      if (o.pouch) rrect(g, -w + 0.6, y + h - 0.4, 3.4, 3.6, 0.9, o.pouch.base, 0.9);
    });
  });
}

/** A COLLAR: a raised plate gorget, a fur mantle, a mail coif collar, a high quilted collar. */
export function collar(mat: Mat, kind: "gorget" | "fur" | "mail" | "high" | "cowl" | "flare" | "amice", z: number = Z.detail): Piece {
  return piece(z, mat, (g, _p, j, r) => {
    torso(g, j, () => {
      const top = topY(j);
      const c = j.b.chest;
      switch (kind) {
        case "gorget":
          rrect(g, -6.4 * c, top - 1.4, 12.8 * c, 3.4, 1.2, r.base, 1);
          line(g, [-5.6 * c, top - 0.6], [5.6 * c, top - 0.6], 0.6, r.hi);
          break;
        case "fur": {
          const pts: Pt[] = [];
          const n = 9;
          for (let i = 0; i <= n; i++) {
            const t = i / n;
            const x = (-9.4 + 18.8 * t) * c;
            pts.push([x, top - 2.2 + Math.sin(t * Math.PI) * -0.6]);
          }
          for (let i = n; i >= 0; i--) {
            const t = i / n;
            const x = (-9 + 18 * t) * c;
            pts.push([x + (i % 2 ? 0.6 : -0.6), top + 3.6 + (i % 2) * 1.2 + Math.sin(t * Math.PI) * 0.8]);
          }
          lit(g, () => sub(g, pts), r, { shadow: [1.6, -1] });
          for (let i = 1; i < n; i += 2) line(g, [(-9 + 18 * (i / n)) * c, top - 1], [(-9 + 18 * (i / n)) * c + 0.4, top + 3], 0.5, r.lo);
          break;
        }
        case "mail":
          poly(g, [[-7.6 * c, top - 1.6], [7.6 * c, top - 1.6], [8.2 * c, top + 3.2], [-8.2 * c, top + 3.2]], r.base, 1);
          for (const dy of [0.2, 1.8]) line(g, [-7.4 * c, top + dy], [7.4 * c, top + dy], 0.5, r.lo);
          break;
        case "high":
          poly(g, [[-6 * c, top - 2.6], [5.2 * c, top - 2.2], [6.4 * c, top + 1.4], [-6.6 * c, top + 1.4]], r.base, 1);
          line(g, [-5.6 * c, top - 1.6], [4.8 * c, top - 1.2], 0.5, r.hi);
          break;
        case "cowl":
          poly(g, [[-7.4 * c, top - 1.4], [6.8 * c, top - 1.4], [7.6 * c, top + 2.6], [2 * c, top + 5.6], [-3 * c, top + 5], [-8 * c, top + 2.4]], r.base, 1);
          line(g, [-6 * c, top + 1.8], [1.6 * c, top + 4.4], 0.6, r.lo);
          break;
        case "flare": {
          // a tall flared collar standing up behind the head: the sorcerer's line
          const t = top + 1.4;
          lit(g, () => sub(g, [[-2.4, t + 1.4], [-7.6, t - 0.6], [-13.6, t - 9.8], [-10.2, t - 9], [-9.6, t - 11.6], [-6.4, t - 5.6], [-3.2, t - 2.6]]), r, { shadow: [0.8, -0.8] });
          line(g, [-8.8, t - 3], [-12.6, t - 8.8], 0.6, r.hi);
          rrect(g, -6.8, t - 1.4, 13, 2.6, 1, r.base, 1);
          break;
        }
        case "amice":
          // a hooded collar over the shoulders (vestments)
          lit(g, () => sub(g, [[-9.4 * c, top - 1.2], [8.2 * c, top - 1.2], [9.4 * c, top + 3.4], [4.6 * c, top + 6.6], [0, top + 8.2], [-4.6 * c, top + 6.6], [-10 * c, top + 3.4]]), r, { shadow: [1.2, -1] });
          ellipse(g, -7.6 * c, top - 1.8, 4, 2.6, r.lo, 1);
          break;
      }
    });
  });
}

/** An emblem on the chest (a chevron, a sun, a cross, a lion's head disc …) — drawn on whatever the chest wears. */
export function emblem(mat: Mat, kind: "chevron" | "sun" | "cross" | "disc" | "star" | "tree" | "eye", o: { x?: number; y?: number; s?: number; z?: number } = {}): Piece {
  return piece(o.z ?? Z.detail, mat, (g, _p, j, r) => {
    torso(g, j, () => {
      const x = o.x ?? 0.6;
      const y = o.y ?? -10.4;
      const s = o.s ?? 1;
      g.translate(x, y);
      g.scale(s, s);
      switch (kind) {
        case "chevron":
          poly(g, [[-3, -2.2], [0, 0.8], [3, -2.2], [3, -0.4], [0, 2.6], [-3, -0.4]], r.base, 0.7);
          break;
        case "sun":
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            line(g, [Math.cos(a) * 1.6, Math.sin(a) * 1.6], [Math.cos(a) * 3.4, Math.sin(a) * 3.4], 0.9, i % 2 ? r.lo : r.base);
          }
          circle(g, 0, 0, 1.8, r.hi, 0.7);
          break;
        case "cross":
          poly(g, [[-0.8, -3], [0.8, -3], [0.8, -0.8], [2.8, -0.8], [2.8, 0.8], [0.8, 0.8], [0.8, 3.4], [-0.8, 3.4], [-0.8, 0.8], [-2.8, 0.8], [-2.8, -0.8], [-0.8, -0.8]], r.base, 0.7);
          break;
        case "disc":
          circle(g, 0, 0, 2.8, r.base, 0.8);
          circle(g, -0.6, -0.6, 1.1, r.hi, 0);
          break;
        case "star":
          poly(g, [[0, -3.4], [0.9, -0.9], [3.4, 0], [0.9, 0.9], [0, 3.4], [-0.9, 0.9], [-3.4, 0], [-0.9, -0.9]], r.base, 0.7);
          break;
        case "tree":
          poly(g, [[0, -3.2], [2.6, 0.6], [0.6, 0.6], [0.6, 2.8], [-0.6, 2.8], [-0.6, 0.6], [-2.6, 0.6]], r.base, 0.7);
          break;
        case "eye":
          ellipse(g, 0, 0, 2.8, 1.5, r.base, 0.7);
          circle(g, 0.2, 0, 0.9, r.lo, 0);
          break;
      }
    });
  });
}

/** Straps crossing the chest (a baldric, a harness, bandoliers) — `cross` adds the mirrored one. */
export function straps(mat: Mat, o: { cross?: boolean; w?: number; z?: number; studs?: Ramp | null } = {}): Piece {
  return piece(o.z ?? Z.detail, mat, (g, _p, j, r) => {
    torso(g, j, () => {
      const top = topY(j);
      const c = j.b.chest;
      const w = o.w ?? 1.8;
      const one = (a: Pt, b: Pt) => {
        const d = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        g.save();
        g.translate(a[0], a[1]);
        g.rotate(d);
        rrect(g, 0, -w / 2, len, w, w * 0.4, r.base, 0.9);
        line(g, [0.4, -w / 2 + 0.4], [len - 0.4, -w / 2 + 0.4], 0.45, r.hi);
        if (o.studs) for (let t = 2; t < len - 1; t += 2.6) circle(g, t, 0, 0.45, o.studs.hi, 0);
        g.restore();
      };
      one([-5.8 * c, top + 0.6], [6.2 * c, -3.4]);
      if (o.cross) one([5.4 * c, top + 0.6], [-6.4 * c, -3.2]);
    });
  });
}
