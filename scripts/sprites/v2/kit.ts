import { RARITY_VISUALS } from "../../../src/domain/hero/rarityVisuals";

import { circle, ellipse, G, line, local, OL, path, poly, rrect, tube, type Ctx, type Pt } from "../pen";
import { FEET_Y, HEAD_R, type Build, type Joints, type Pose, type RigId } from "./rig";

/**
 * HERO RENDERER v2 — the shared drawing kit of the design library: body-space frames, materials and the few shading primitives every design
 * is built from (so ~400 drawings share one light direction, one outline weight and one set of material ramps — a family, not a collage).
 *
 *   light   from the top-front (upper-right in the authored, right-facing view): lit tops and front edges, shadowed backs and undersides
 *   outline 1 px dark line on every shape; tinted layers' inner lines turn into a dark shade of their own colour (buildPacked `innerOutline`)
 *   tints   tintable regions are authored in the neutral grey ramp `G` (mid-grey = the palette colour exactly); real materials in their own ramps
 */

export { circle, ellipse, G, line, local, OL, path, poly, rrect, tube };
export type { Ctx, Joints, Pose, Pt, RigId };

/** Equipment tier = the hero's rarity. 0 Common · 1 Rare · 2 Epic · 3 Legendary. */
export type Tier = 0 | 1 | 2 | 3;
export const TIER_RARITY = ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const;
export type TierRarity = (typeof TIER_RARITY)[number];

export interface Ramp {
  hi: string;
  base: string;
  lo: string;
  deep: string;
}

/** Real-colour materials (untinted layers). */
export const M = {
  steel: { hi: "#f2f6fb", base: "#b9c3d3", lo: "#7d8aa0", deep: "#525d70" },
  iron: { hi: "#c9ced8", base: "#8e96a4", lo: "#5e6573", deep: "#3c414c" },
  dark: { hi: "#8f97ab", base: "#4f5668", lo: "#333849", deep: "#20232f" },
  white: { hi: "#ffffff", base: "#e3e8f1", lo: "#aeb8c9", deep: "#7f8aa0" },
  gold: { hi: "#fff0b0", base: "#e6ac3c", lo: "#a8701e", deep: "#6e4510" },
  bronze: { hi: "#f0c08a", base: "#b97f45", lo: "#80522a", deep: "#55341a" },
  leather: { hi: "#a8805a", base: "#7a593c", lo: "#523b28", deep: "#36261a" },
  darkLeather: { hi: "#6e5643", base: "#4a3a2e", lo: "#33281f", deep: "#211a14" },
  wood: { hi: "#b99363", base: "#8f6c43", lo: "#614629", deep: "#3f2c19" },
  darkWood: { hi: "#7d5d44", base: "#56402f", lo: "#3a2b20", deep: "#251b14" },
  paleWood: { hi: "#f1dcae", base: "#cfae76", lo: "#99784a", deep: "#6b522f" },
  bone: { hi: "#fffbea", base: "#e8dcc0", lo: "#b5a684", deep: "#857857" },
  fur: { hi: "#f4ece0", base: "#d8c8b2", lo: "#a8957c", deep: "#776650" },
  darkFur: { hi: "#9a8470", base: "#6e5a48", lo: "#4b3d31", deep: "#2f2620" },
  paper: { hi: "#fffaf0", base: "#efe2c4", lo: "#c9b58c", deep: "#97835d" },
  cloth: { hi: "#f6f2e8", base: "#ddd5c2", lo: "#a99f8a", deep: "#7a7262" },
  arcane: { hi: "#efe6ff", base: "#a98bff", lo: "#5c43b8", deep: "#38277a" },
  frost: { hi: "#eefcff", base: "#8fe3ff", lo: "#3f9fd0", deep: "#22618a" },
  holy: { hi: "#fffbe0", base: "#ffe08a", lo: "#c99a2e", deep: "#8a6512" },
  fel: { hi: "#eaffd8", base: "#9ae66e", lo: "#4f9a35", deep: "#2c5e1c" },
  ember: { hi: "#fff1c0", base: "#ff9a3c", lo: "#c4501c", deep: "#7c2a10" },
  ruby: { hi: "#ffc2c8", base: "#e0455a", lo: "#9a1f33", deep: "#5e0f1d" },
  sapphire: { hi: "#cfe6ff", base: "#4a8cff", lo: "#1f4fae", deep: "#122d68" },
  emerald: { hi: "#d2ffe2", base: "#3fcf7c", lo: "#1d8a4b", deep: "#0e512b" },
  amethyst: { hi: "#f0d6ff", base: "#b366ff", lo: "#6a2bb5", deep: "#3d1470" },
  // heraldic paints (shields): a colour of their own, so a shield never melts into the class cloth behind it
  crimson: { hi: "#ec7a72", base: "#b8403a", lo: "#7c2420", deep: "#4c1210" },
  royal: { hi: "#7aa2ec", base: "#3c5cb8", lo: "#22347c", deep: "#121c4c" },
  sable: { hi: "#6c7080", base: "#363a46", lo: "#22242c", deep: "#14151a" },
  verdant: { hi: "#7ad89a", base: "#3c9a5c", lo: "#226a3c", deep: "#103e20" },
} as const satisfies Record<string, Ramp>;

/**
 * The rarity colours (hero/rarityVisuals) as ramps. A design belongs to ONE tier, so its rarity accents — an Epic plume, Legendary runes — are
 * baked in that tier's colour instead of a separately tinted layer (which would double the atlas area of every sweeping weapon).
 */
export const RARITY_RAMP: Record<Tier, Ramp> = Object.fromEntries(
  (["COMMON", "RARE", "EPIC", "LEGENDARY"] as const).map((r, i) => {
    const c = RARITY_VISUALS[r].colors;
    return [i, { hi: c.light, base: c.base, lo: c.dark, deep: c.ink }];
  }),
) as Record<Tier, Ramp>;

/** The grey ramp of tinted layers, as a Ramp. */
export const T: Ramp = { hi: G.hi, base: G.base, lo: G.lo, deep: G.deep };
export const WHITE = "#f4f4f8";
export const DARK = "#1c1c26";

export const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];

// ======================================================================================
// Body-space frames
// ======================================================================================

/** Torso-local frame: origin at the hip, up = −y, forward = +x. */
export const torso = (g: Ctx, j: Joints, fn: () => void): void => local(g, j.hip, j.torsoAngle, fn);
/**
 * Head-local frame, authored at a head radius of 9.6 and scaled to the build's head — every face, hair and hat shares one design space, and a
 * small head on a tall body or a big one on a short body carries the same drawings.
 */
export const HEAD_K = HEAD_R / 9.6;
export const head = (g: Ctx, j: Joints, fn: () => void): void =>
  local(g, j.head, j.headAngle, () => {
    const k = j.b.head / 9.6;
    g.scale(k, k);
    fn();
  });

/** The archetype's weapon proportions (a brute's greatsword, a warden's longbow, a monk's tall staff). */
export const weaponScale = (j: Joints): Build["weapon"] => j.b.weapon;

/** The weapon axis (angle of "up the blade") of the front hand. */
export const axisAngle = (j: Joints): number => Math.atan2(j.weaponDir[0], -j.weaponDir[1]);
export const axisAngleB = (j: Joints): number => Math.atan2(j.weaponDirB[0], -j.weaponDirB[1]);
/** Weapon space: origin at a hand, the weapon along −y. */
export const inWeaponSpace = (g: Ctx, at: Pt, j: Joints, fn: () => void, extra = 0): void => local(g, at, axisAngle(j) + extra, fn);
/** A weapon-space point of the front hand → frame pixels. */
export const weaponPoint = (j: Joints, x: number, y: number, extra = 0): Pt => {
  const th = axisAngle(j) + extra;
  return [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
};
/** Torso-local point → frame pixels. */
export const torsoPoint = (j: Joints, x: number, y: number): Pt => {
  const a = j.torsoAngle;
  return [j.hip[0] + x * Math.cos(a) - y * Math.sin(a), j.hip[1] + x * Math.sin(a) + y * Math.cos(a)];
};

/**
 * How far below the hip (torso space) a hanging hem can reach before it meets the floor: a robe, a skirt or a cape stops at the ground (it
 * pools) when the hero kneels or falls, instead of passing through it.
 */
export const floorLen = (j: Joints, margin = 1.6, halfWidth = 8): number =>
  (FEET_Y - margin - j.hip[1] - halfWidth * Math.abs(Math.sin(j.torsoAngle))) / Math.max(0.35, Math.cos(j.torsoAngle));

/** Cloth sway of a pose (cape, hair, scarf tails, robe hems): one number, + = blown backwards. */
export const sway = (p: Pose): number => p.capeSway;

// ======================================================================================
// Shading primitives
// ======================================================================================

/**
 * A LIT shape: filled with `base`; a shadow band on its back / under side (the shape minus a copy of itself shifted toward the light); an
 * optional highlight; one outline. `shape` APPENDS sub-paths (moveTo / lineTo / arc / ellipse …) and never calls beginPath, fill or stroke.
 */
export function lit(g: Ctx, shape: () => void, r: Ramp, opts: { shadow?: readonly [number, number]; hi?: () => void; lw?: number; outline?: string | null } = {}): void {
  const [sx, sy] = opts.shadow ?? [1.3, -1.3];
  g.save();
  g.beginPath();
  shape();
  g.fillStyle = r.base;
  g.fill();
  g.clip();
  g.beginPath();
  g.rect(-500, -500, 1000, 1000);
  g.save();
  g.translate(sx, sy);
  shape();
  g.restore();
  g.fillStyle = r.lo;
  g.fill("evenodd");
  if (opts.hi) {
    g.beginPath();
    opts.hi();
    g.fillStyle = r.hi;
    g.fill();
  }
  g.restore();
  if (opts.outline === null) return;
  g.beginPath();
  shape();
  g.strokeStyle = opts.outline ?? OL;
  g.lineWidth = opts.lw ?? 1;
  g.stroke();
}

/** Appends a polygon sub-path (for `lit` shapes). */
export function sub(g: Ctx, pts: readonly Pt[]): void {
  pts.forEach((p, i) => (i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1])));
  g.closePath();
}

/** A filled + outlined polygon lit by a darker band along the given (back) edge points and an optional highlight polygon. */
export function plate(g: Ctx, pts: readonly Pt[], r: Ramp, opts: { lo?: readonly Pt[]; hi?: readonly Pt[]; lw?: number } = {}): void {
  poly(g, pts, r.base, 0);
  if (opts.lo) poly(g, opts.lo, r.lo, 0);
  if (opts.hi) poly(g, opts.hi, r.hi, 0);
  path(g, pts);
  g.strokeStyle = OL;
  g.lineWidth = opts.lw ?? 1;
  g.stroke();
}

/** Rivets / studs in a row. */
export function studs(g: Ctx, pts: readonly Pt[], r = 0.6, color: string = M.steel.hi): void {
  for (const [x, y] of pts) circle(g, x, y, r, color, 0.4);
}

/** A cut gem: facet + glint. */
export function gem(g: Ctx, x: number, y: number, r: number, c: Ramp = M.ruby): void {
  poly(g, [[x, y - r], [x + r * 0.9, y], [x, y + r], [x - r * 0.9, y]], c.base, 0.7);
  poly(g, [[x, y - r], [x + r * 0.9, y], [x, y]], c.hi, 0);
  poly(g, [[x, y + r], [x - r * 0.9, y], [x, y]], c.lo, 0);
}

/** A four-pointed glint (a restrained sparkle: Epic/Legendary weapons, a holy symbol). */
export function sparkle(g: Ctx, x: number, y: number, r: number, color: string = WHITE): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  g.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  g.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  g.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

/** A soft glow disc (magic, a legendary blade) — drawn at low alpha so it reads as light, not as a sticker. */
export function glow(g: Ctx, x: number, y: number, r: number, color: string, alpha: number): void {
  if (alpha <= 0.01) return;
  g.save();
  g.globalAlpha = Math.min(1, alpha);
  circle(g, x, y, r, color, 0);
  g.restore();
}

/** A stroked curve with an outline: draws `build` (a path, no stroke) twice — dark and wide, then the colour. */
export function cord(g: Ctx, build: () => void, w: number, color: string, ol = 1.2): void {
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  build();
  g.strokeStyle = OL;
  g.lineWidth = w + ol;
  g.stroke();
  build();
  g.strokeStyle = color;
  g.lineWidth = w;
  g.stroke();
  g.restore();
}

// ======================================================================================
// Limbs, hands, feet
// ======================================================================================

/**
 * A LIMB: upper segment then lower segment, tapering, drawn as one outlined shape (outline strokes first, fills after, so the joint has no
 * seam) with a band of light along its upper-front edge.
 */
export function limb(g: Ctx, a: Pt, b: Pt, c: Pt, w1: number, w2: number, fill: string, light: string | null): void {
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  const seg = (p: Pt, q: Pt, w: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(p[0], p[1]);
    g.lineTo(q[0], q[1]);
    g.stroke();
  };
  seg(a, b, w1 + 2, OL);
  seg(b, c, w2 + 2, OL);
  seg(a, b, w1, fill);
  seg(b, c, w2, fill);
  circle(g, b[0], b[1], (w1 + w2) / 4, fill, 0);
  if (light) {
    g.translate(w2 * 0.2, -w2 * 0.24);
    seg(lerp(a, b, 0.1), lerp(a, b, 0.85), Math.max(0.9, w1 * 0.3), light);
    seg(lerp(b, c, 0.12), lerp(b, c, 0.85), Math.max(0.8, w2 * 0.3), light);
  }
  g.restore();
}

/** A HAND: a small mitten pointing along the forearm, with a thumb on top. `glove` draws it as a gauntlet / glove in another material. */
export function hand(g: Ctx, elbow: Pt, at: Pt, fill: string, size = 1): void {
  const dx = at[0] - elbow[0];
  const dy = at[1] - elbow[1];
  local(g, at, Math.atan2(dy, dx), () => {
    g.scale(size, size);
    ellipse(g, 0.4, 0, 2.1, 1.65, fill, 1);
    ellipse(g, 0.2, -1.5, 0.9, 0.7, fill, 0.7);
  });
}

/** The segment from `a` toward `b` at fractions t0..t1 (sleeves, bracers, greaves). */
export const span = (a: Pt, b: Pt, t0: number, t1: number): [Pt, Pt] => [lerp(a, b, t0), lerp(a, b, t1)];

/** Points on a limb: the joint chain shoulder→elbow→hand (or hip→knee→foot). */
export interface Chain {
  a: Pt;
  b: Pt;
  c: Pt;
}
export const armF = (j: Joints): Chain => ({ a: j.shoulderF, b: j.elbowF, c: j.handF });
export const armB = (j: Joints): Chain => ({ a: j.shoulderB, b: j.elbowB, c: j.handB });
export const legF = (j: Joints): Chain => ({ a: j.hipF, b: j.kneeF, c: j.footF });
export const legB = (j: Joints): Chain => ({ a: j.hipB, b: j.kneeB, c: j.footB });

/** A sleeve / leg covering a chain from its root to fraction `to` of the lower segment. */
export function sleeve(g: Ctx, ch: Chain, w1: number, w2: number, to: number, fill: string, light: string | null): void {
  limb(g, ch.a, ch.b, lerp(ch.b, ch.c, to), w1, w2, fill, light);
}

/** A band around a limb segment (cuff, bracer edge, greave strap) at fraction t of a→b. */
export function band(g: Ctx, a: Pt, b: Pt, t: number, w: number, thick: number, fill: string): void {
  const p = lerp(a, b, t);
  local(g, p, Math.atan2(b[1] - a[1], b[0] - a[0]), () => rrect(g, -thick / 2, -w / 2, thick, w, Math.min(thick, w) * 0.35, fill, 0.8));
}

export type BootStyle = "shoe" | "boot" | "tall" | "greave" | "sabaton" | "wrap" | "sandal";

/** A FOOT / boot: heel, instep and toe pointing the way the hero faces; a shaft up the shin for boots and greaves. */
export function boot(g: Ctx, knee: Pt, foot: Pt, style: BootStyle, r: Ramp, front: boolean, cuff: Ramp | null = null): void {
  const c = front ? r.base : r.lo;
  const [fx, fy] = foot;
  if (style === "shoe" || style === "sandal") {
    poly(g, [[fx - 2.2, fy - 1.8], [fx + 2.2, fy - 2], [fx + 4.4, fy - 0.4], [fx + 4.2, fy + 0.7], [fx - 2.4, fy + 0.7]], c, 1);
    if (style === "sandal") line(g, [fx - 1.6, fy - 1.6], [fx + 1.4, fy - 0.2], 0.6, front ? r.lo : r.deep);
    return;
  }
  const top = lerp(knee, foot, style === "tall" ? 0.12 : style === "greave" ? 0.05 : style === "wrap" ? 0.35 : 0.48);
  const shin = style === "greave" || style === "sabaton" ? 4.8 : style === "wrap" ? 3.6 : 4.2;
  tube(g, [top, [fx, fy - 1.6]], shin, c);
  const toe = style === "sabaton" ? 5.6 : 5;
  poly(g, [[fx - 2.6, fy - 2.6], [fx + 1.2, fy - 2.4], [fx + toe - 0.6, fy - 1.2], [fx + toe, fy + 0.2], [fx + toe - 0.4, fy + 0.8], [fx - 2.8, fy + 0.8]], c, 1);
  line(g, [fx - 2.4, fy + 0.2], [fx + toe - 0.6, fy + 0.2], 0.7, front ? r.deep : OL);
  const ang = Math.atan2(fy - top[1], fx - top[0]) - Math.PI / 2;
  if (style === "greave") {
    line(g, lerp(top, foot, 0.1), lerp(top, foot, 0.8), 0.8, front ? r.hi : r.base); // the greave's lit ridge
    circle(g, knee[0] + 0.4, knee[1], 2.3, front ? r.hi : r.base, 0.8); // knee cop
  }
  if (style === "sabaton") {
    line(g, [fx - 0.4, fy - 2.2], [fx + 1.6, fy - 0.2], 0.7, front ? r.hi : r.base);
    line(g, [fx + 1.6, fy - 1.8], [fx + 3.2, fy - 0.2], 0.7, front ? r.hi : r.base);
    circle(g, knee[0] + 0.4, knee[1], 2.4, front ? r.hi : r.base, 0.8);
  }
  if (style === "wrap") for (const t of [0.25, 0.55, 0.85]) band(g, top, [fx, fy - 1.6], t, shin + 0.6, 0.9, front ? r.lo : r.deep);
  if (cuff || style === "tall" || style === "boot") local(g, top, ang, () => rrect(g, -shin / 2 - 0.6, -0.8, shin + 1.2, 2, 0.6, (cuff ?? r) [front ? "hi" : "base"], 0.8));
}

// ======================================================================================
// Torso shapes
// ======================================================================================

/** Torso-local V-taper: shoulders wider than the waist, the waist narrower than the hips. */
export function vTorso(sh: number, wa: number, hi: number, top = -15.8, waist = -4.2, bottom = 0.6): Pt[] {
  return [[-sh, top], [sh, top], [wa, waist], [hi, bottom], [-hi, bottom], [-wa, waist]];
}

/** Scales a torso-space half-width by the rig's build (a Tank's chest is wider than a Mage's). */
export const chestW = (j: Joints, w: number): number => w * j.b.chest;

// ======================================================================================
// Weapon-space helpers
// ======================================================================================

/** A grip: a wrapped handle from y0 to y1 (weapon space, y up the blade is negative). */
export function grip(g: Ctx, y0: number, y1: number, w: number, r: Ramp = M.leather): void {
  rrect(g, -w / 2, Math.min(y0, y1), w, Math.abs(y1 - y0), w * 0.4, r.base, 0.8);
  for (let y = Math.min(y0, y1) + 1.2; y < Math.max(y0, y1) - 0.4; y += 1.4) line(g, [-w / 2 + 0.3, y], [w / 2 - 0.3, y + 0.7], 0.45, r.lo);
}

/** A disc / gem pommel at y. */
export function pommel(g: Ctx, y: number, r: number, mat: Ramp, jewel: Ramp | null = null): void {
  circle(g, 0, y, r, mat.base, 0.8);
  circle(g, -r * 0.3, y - r * 0.3, r * 0.35, mat.hi, 0);
  if (jewel) gem(g, 0, y, r * 0.6, jewel);
}
