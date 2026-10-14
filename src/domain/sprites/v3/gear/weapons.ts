import { GROUP } from "../body";
import { TAG, type Material } from "../gbuffer";
import { part, type Build } from "../kit";
import { MAT } from "../materials";
import { add, clamp, cross, mul, norm, type Frame, type V3 } from "../vec";
import { fp } from "../view";

/**
 * HERO RENDERER v3 — WEAPONS, each built in its own GRIP FRAME: origin at the holding hand's centre, y up the blade / shaft, x the edge (the
 * side that faces forward), z the flat. The hand IS the grip: a sword's handle runs through the fist (the fist is drawn over it), a two-hander's
 * second grip is a point on the same handle that the other hand reaches for (rig.ts), a bow's string meets the drawing hand.
 *
 * Blades, shafts and strings are drawn with the pixel LINE primitive (unbroken, never doubled, a lit edge and a shadow edge), heads and pommels
 * as small volumes. Each design is a few numbers — length, width, guard, pommel, head, materials — chosen per class and tier.
 */

export interface WeaponResult {
  /** Where a shot / spell leaves (character space), when the weapon shoots. */
  muzzle: V3 | null;
  /** The far end of the weapon (blade tip, haft top) — for tests. */
  tip: V3;
}

// ------------------------------------------------------------------------------------------------ blades

export interface BladeSpec {
  len: number;
  /** Blade width in pixels (1–3). */
  w: number;
  grip: number;
  guard: number;
  guardDrop: number;
  pommel: "disc" | "ball" | "gem" | "ring";
  blade: Material;
  hilt: Material;
  wrap: Material;
  gem: Material | null;
  /** A glowing fuller (runes) along this fraction of the blade. */
  runes: Material | null;
  /** Curved edge (falchion / sabre): the tip sweeps toward the back edge by this many px. */
  curve: number;
  /** A wider section near the tip (a cleaver / falchion). */
  belly: number;
}

/** A sword / knife / greatsword in grip frame `w`. */
export function drawBlade(b: Build, w: Frame, s: BladeSpec, group: number = GROUP.WEAPON): WeaponResult {
  const P = (x: number, y: number, z = 0): V3 => fp(w, x, y, z);
  const grip = part(b, "grip", s.wrap, group, TAG.WEAPON);
  const hilt = part(b, "hilt", s.hilt, group, TAG.WEAPON);
  const blade = part(b, "blade", s.blade, group, TAG.WEAPON);
  const gTop = s.grip * 0.5;
  const gBot = -s.grip * 0.5 - 0.3;
  b.pt.line(P(0, gBot), P(0, gTop), 1, grip, w.z);
  // pommel
  const py = gBot - 0.8;
  if (s.pommel === "gem" && s.gem) b.pt.sphere(P(0, py - 0.2), 0.95, part(b, "pommelGem", s.gem, group, TAG.WEAPON));
  else if (s.pommel === "ring") b.pt.line(P(-0.7, py - 0.6), P(0.7, py - 0.6), 1, hilt, w.z);
  else b.pt.sphere(P(0, py), s.pommel === "ball" ? 0.95 : 0.8, hilt);
  // guard (quillons), drooping toward the blade or swept
  const gy = gTop + 0.6;
  if (s.guard > 0) {
    b.pt.line(P(-s.guard, gy + s.guardDrop), P(0, gy), 1, hilt, [0.2, 0.5, 0.85]);
    b.pt.line(P(0, gy), P(s.guard, gy + s.guardDrop), 1, hilt, [0.2, 0.5, 0.85]);
  }
  // blade: a lit edge + a shadow edge (a 2-px blade), a 3-px one adds a mid tone; the tip narrows to 1 px
  const y0 = gy + 0.7;
  const y1 = gy + s.len;
  const tipLen = Math.min(2.2, s.len * 0.18);
  const tones = s.w >= 4 ? [3, 3, 2, 1] : s.w === 3 ? [3, 2, 1] : s.w === 2 ? [3, 1] : [3];
  const side = tipSide(b, w);
  const segs = 3;
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs;
    const t1 = (k + 1) / segs;
    const ya = y0 + (y1 - tipLen - y0) * t0;
    const yb = y0 + (y1 - tipLen - y0) * t1;
    const xa = -s.curve * t0 * t0;
    const xb = -s.curve * t1 * t1;
    const wa = s.w + (s.belly > 0 && t0 > 0.45 ? 1 : 0);
    b.pt.line(P(xa, ya), P(xb, yb), wa, blade, w.z, { side, tones: wa > s.w ? [3, 3, 2, 1].slice(0, wa) : tones });
  }
  // the tip tapers: one pixel narrower per step to a point
  if (s.w >= 3) b.pt.line(P(-s.curve, y1 - tipLen), P(-s.curve * 1.03, y1 - tipLen * 0.45), s.w - 1, blade, w.z, { side, tones: [3, 2, 1].slice(0, s.w - 1) });
  b.pt.line(P(-s.curve, y1 - tipLen), P(-s.curve * 1.05, y1), 1, blade, w.z, { tone: 3 });
  if (s.runes) {
    const rp = part(b, "runes", s.runes, group, TAG.WEAPON);
    b.pt.line(P(-s.curve * 0.1, y0 + 1.2), P(-s.curve * 0.5, y0 + (y1 - y0) * 0.62), 1, rp, w.z, { zBias: 0.05 });
  }
  return { muzzle: null, tip: P(-s.curve, y1) };
}

/** Which side of a blade line gets the extra (lit) column: the side toward the light (screen up / right). */
function tipSide(b: Build, w: Frame): readonly [number, number] {
  const ax = b.pt.D(w.x);
  return [ax[0] >= 0 ? 1 : -1, ax[1] <= 0 ? -1 : 1];
}

// ------------------------------------------------------------------------------------------------ hafted weapons

/** A planted staff reaches the floor (its foot is clipped there); lying on the floor it is this long below the grip. */
export const DROPPED_FOOT = 15;

/** A haft's reach along its axis (for laying it down). */
export const haftSpan = (s: HaftSpec): { up: number; down: number } => ({ up: s.up + s.headSize * 2.6, down: Math.min(s.down, DROPPED_FOOT) });
/** A blade's reach along its axis. */
export const bladeSpan = (s: BladeSpec): { up: number; down: number } => ({ up: s.grip / 2 + 1.3 + s.len, down: s.grip / 2 + 1.6 });

export interface HaftSpec {
  /** Shaft length above the hand, and below it. */
  up: number;
  down: number;
  shaft: Material;
  shaftW: number;
  head: "flanged" | "star" | "hammer" | "maul" | "sun" | "orb" | "crook" | "claw" | "spear" | "none";
  headMat: Material;
  headSize: number;
  gem: Material | null;
  glow: Material | null;
  /** Bands / ferrules on the shaft. */
  band: Material | null;
}

export function drawHaft(b: Build, w: Frame, s: HaftSpec, glow = 0, group: number = GROUP.WEAPON): WeaponResult {
  const P = (x: number, y: number, z = 0): V3 => fp(w, x, y, z);
  const shaft = part(b, "shaft", s.shaft, group, TAG.WEAPON);
  const top = s.up;
  const down = b.dropped ? Math.min(s.down, DROPPED_FOOT) : s.down;
  b.pt.line(P(0, -down), P(0, top), s.shaftW, shaft, w.z, { side: tipSide(b, w), tones: s.shaftW >= 2 ? [2, 1] : undefined });
  if (s.band) {
    const bp = part(b, "band", s.band, group, TAG.WEAPON);
    b.pt.line(P(-0.6, top - 1.2), P(0.6, top - 1.2), 1, bp, w.z, { zBias: 0.1 });
    if (down > 3) b.pt.sphere(P(0, -down), 0.7, bp);
  }
  const hp = part(b, "weaponHead", s.headMat, group, TAG.WEAPON);
  const hs = s.headSize;
  let muzzle: V3 | null = null;
  let tip = P(0, top);
  switch (s.head) {
    case "flanged": {
      b.pt.blob(w, [0, top + hs * 0.9, 0], hs * 0.85, hs * 1.15, hs * 0.85, hp);
      for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) b.pt.line(P(0, top + hs * 0.25), P(x * hs * 1.25, top + hs * 0.9, z * hs * 1.25), 1, hp, w.z);
      tip = P(0, top + hs * 2);
      break;
    }
    case "star": {
      b.pt.sphere(P(0, top + hs), hs, hp);
      for (const [x, y, z] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0.7, 0.7, 0], [-0.7, 0.7, 0], [0, 0, 1], [0, 0, -1]] as const) b.pt.line(P(x * hs, top + hs + y * hs, z * hs), P(x * hs * 1.75, top + hs + y * hs * 1.75, z * hs * 1.75), 1, hp, w.z);
      tip = P(0, top + hs * 2.7);
      break;
    }
    case "hammer": {
      b.pt.fbox(w, [0, top + hs * 0.6, 0], [hs * 1.5, hs * 0.75, hs * 0.85], hp);
      b.pt.line(P(-hs * 1.5, top + hs * 0.6), P(-hs * 2.4, top + hs * 0.2), 1, hp, w.z);
      tip = P(0, top + hs * 1.4);
      break;
    }
    case "maul": {
      b.pt.fbox(w, [0, top + hs * 0.9, 0], [hs * 1.35, hs * 1.05, hs * 1.15], hp);
      tip = P(0, top + hs * 2);
      break;
    }
    case "spear":
      b.pt.line(P(0, top), P(0, top + hs * 3), 2, hp, w.z, { side: tipSide(b, w), tones: [3, 1] });
      tip = P(0, top + hs * 3.4);
      break;
    case "sun": {
      // a sun disc on the scepter's head: a gold ring with rays, a gem at its heart
      const c = P(0, top + hs * 1.1);
      const n = norm(cross(w.y, w.x));
      const N = 10;
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        const d = add(mul(w.x, Math.cos(a)), mul(w.y, Math.sin(a)));
        b.pt.line(add(c, mul(d, hs * 0.6)), add(c, mul(d, hs * (i % 2 ? 1.25 : 1.55))), 1, hp, n);
      }
      b.pt.sphere(c, hs * 0.62, hp);
      if (s.gem) b.pt.sphere(c, hs * 0.38, part(b, "headGem", s.gem, group, TAG.WEAPON), { zBias: 0.2 });
      muzzle = c;
      tip = P(0, top + hs * 2.6);
      break;
    }
    case "orb":
    case "crook":
    case "claw": {
      // a staff head holding a crystal orb: a claw of three prongs, or a crook curling over it
      const c = P(s.head === "crook" ? -hs * 0.9 : 0, top + hs * 1.3);
      if (s.head === "crook") {
        const pts: V3[] = [P(0, top), P(0, top + hs * 1.8), P(-hs * 0.6, top + hs * 2.6), P(-hs * 1.6, top + hs * 2.5), P(-hs * 1.9, top + hs * 1.8)];
        for (let i = 0; i < pts.length - 1; i++) b.pt.line(pts[i] as V3, pts[i + 1] as V3, s.shaftW, shaft, w.z);
      } else if (s.head === "claw") {
        for (const x of [-1, 1]) b.pt.line(P(0, top - 0.2), P(x * hs * 1.1, top + hs * 1.6), 1, hp, w.z);
        b.pt.line(P(0, top), P(0, top + hs * 0.4), 1, hp, w.z);
      } else {
        b.pt.blob(w, [0, top + hs * 0.25, 0], hs * 0.7, hs * 0.5, hs * 0.7, hp);
      }
      const orb = part(b, "orb", s.gem ?? MAT.arcane, group, TAG.WEAPON);
      b.pt.sphere(c, hs * 0.95, orb, { zBias: 0.1 });
      if (s.glow && glow > 0.05) {
        const gp = part(b, "glow", s.glow, GROUP.FX, TAG.FX);
        b.pt.sphere(c, hs * (0.95 + glow * 0.9), gp, { zBias: -0.6, clip: (x, y) => ((Math.floor(x) + Math.floor(y)) & 1) === 0 || glow > 0.6 });
      }
      muzzle = c;
      tip = P(0, top + hs * 2.4);
      break;
    }
    default:
      break;
  }
  return { muzzle, tip };
}

// ------------------------------------------------------------------------------------------------ bows

export interface BowSpec {
  /** Half-length of the bow (grip to tip, along its axis). */
  half: number;
  /** How far the limbs bow forward at rest (px), and recurve tips. */
  bend: number;
  recurve: number;
  limb: Material;
  grip: Material;
  string: Material;
  tipMat: Material | null;
  arrow: Material;
  fletch: Material;
  limbW: number;
}

/**
 * A bow in its grip frame (y along the bow, x = the arrow's flight direction): two curved limbs, a string from tip to tip through the
 * drawing hand's nock point (drawn back by `draw`), and the nocked arrow while drawn.
 */
export function drawBow(b: Build, w: Frame, s: BowSpec, draw: number, nock: V3 | null, group: number = GROUP.WEAPON): WeaponResult {
  const P = (x: number, y: number, z = 0): V3 => fp(w, x, y, z);
  const limb = part(b, "limb", s.limb, group, TAG.WEAPON);
  const grip = part(b, "bowGrip", s.grip, group, TAG.WEAPON);
  const str = part(b, "string", s.string, group, TAG.WEAPON);
  const bendK = s.bend * (1 + draw * 0.55);
  const halfK = s.half * (1 - draw * 0.06);
  const limbPts = (dir: 1 | -1): V3[] => {
    const pts: V3[] = [];
    const N = 4;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      // the limb bows forward (+x) through its middle and recurves back near the tip
      const x = bendK * Math.sin(t * Math.PI * 0.9) * 0.9 - s.recurve * Math.max(0, t - 0.75) * 4;
      pts.push(P(x * 0.5 + (t < 0.15 ? 0 : 0), dir * (0.9 + t * (halfK - 0.9))));
    }
    return pts;
  };
  const up = limbPts(1);
  const dn = limbPts(-1);
  for (const pts of [up, dn]) for (let i = 0; i < pts.length - 1; i++) b.pt.line(pts[i] as V3, pts[i + 1] as V3, s.limbW, limb, w.z, { side: tipSide(b, w), tones: s.limbW >= 2 ? [2, 1] : undefined });
  b.pt.line(P(0, -1.2), P(0, 1.2), 2, grip, w.z);
  const topTip = up[up.length - 1] as V3;
  const botTip = dn[dn.length - 1] as V3;
  if (s.tipMat) {
    const tp = part(b, "bowTips", s.tipMat, group, TAG.WEAPON);
    b.pt.sphere(topTip, 0.6, tp);
    b.pt.sphere(botTip, 0.6, tp);
  }
  // the string: straight between the tips at rest, to the nock point while drawn
  const n = nock && draw > 0.04 ? nock : null;
  if (n) {
    b.pt.line(topTip, n, 1, str, w.z, { tone: 3 });
    b.pt.line(n, botTip, 1, str, w.z, { tone: 3 });
    // the arrow: from the nock past the grip
    const ap = part(b, "arrow", s.arrow, group, TAG.WEAPON);
    const fl = part(b, "fletch", s.fletch, group, TAG.WEAPON);
    const head = P(5.0, 0.2);
    b.pt.line(n, head, 1, ap, w.z, { zBias: 0.4 });
    b.pt.line(add(n, mul(norm([head[0] - n[0], head[1] - n[1], head[2] - n[2]]), 0.6)), add(n, mul(norm([head[0] - n[0], head[1] - n[1], head[2] - n[2]]), 2.2)), 2, fl, w.z, { zBias: 0.45 });
    b.pt.sphere(head, 0.55, part(b, "arrowhead", MAT.steel, group, TAG.WEAPON), { zBias: 0.5 });
    return { muzzle: head, tip: topTip };
  }
  b.pt.line(topTip, botTip, 1, str, w.z, { tone: 3 });
  return { muzzle: P(2.5, 0.2), tip: topTip };
}

// ------------------------------------------------------------------------------------------------ shields

export interface ShieldSpec {
  shape: "tower" | "kite" | "heater" | "round" | "buckler";
  /** Half-width and half-height (px). */
  w: number;
  h: number;
  face: Material;
  rim: Material;
  boss: Material | null;
  device: "none" | "stripe" | "cross" | "chevron" | "quarter" | "sun" | "lion";
  deviceMat: Material | null;
  studs: Material | null;
}

function shieldOutline(s: ShieldSpec, k = 1): Array<[number, number]> {
  const W = s.w * k;
  const H = s.h * k;
  const pts: Array<[number, number]> = [];
  const N = 20;
  switch (s.shape) {
    case "round":
    case "buckler":
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pts.push([Math.cos(a) * W, Math.sin(a) * H]);
      }
      return pts;
    case "kite":
      // point down (y is up in the shield frame: −H is the bottom)
      return [[0, -H], [W * 0.92, -H * 0.15], [W, H * 0.45], [W * 0.75, H * 0.85], [W * 0.3, H], [-W * 0.3, H], [-W * 0.75, H * 0.85], [-W, H * 0.45], [-W * 0.92, -H * 0.15]];
    case "heater":
      return [[0, -H], [W * 0.6, -H * 0.62], [W * 0.92, -H * 0.15], [W, H * 0.4], [W, H], [-W, H], [-W, H * 0.4], [-W * 0.92, -H * 0.15], [-W * 0.6, -H * 0.62]];
    default: // tower: a tall slab with a curved top
      return [[-W, -H], [W, -H], [W, H * 0.8], [W * 0.6, H * 0.97], [0, H], [-W * 0.6, H * 0.97], [-W, H * 0.8]];
  }
}

/** A shield in its frame (x = face normal outward, y = up, z = across): rim, face, device, boss. */
export function drawShield(b: Build, f: Frame, s: ShieldSpec, group: number = GROUP.SHIELD): void {
  const rim = part(b, "shieldRim", s.rim, group, TAG.SHIELD);
  const face = part(b, "shieldFace", s.face, group, TAG.SHIELD);
  const to3 = (p: [number, number], lift = 0): V3 => fp(f, lift, p[1], p[0]);
  const outer = shieldOutline(s, 1).map((p) => to3(p, 0));
  const inner = shieldOutline(s, s.shape === "buckler" ? 0.7 : 0.82).map((p) => to3(p, 0.25));
  b.pt.plate(outer, f.x, rim, { bulge: 0.55 });
  b.pt.plate(inner, f.x, face, { bulge: 0.5, zBias: 0.15 });
  if (s.device !== "none" && s.deviceMat) {
    const dp = part(b, "device", s.deviceMat, group, TAG.SHIELD);
    const W = s.w * 0.82;
    const H = s.h * 0.82;
    const quad = (x0: number, y0: number, x1: number, y1: number) => [to3([x0, y0], 0.4), to3([x1, y0], 0.4), to3([x1, y1], 0.4), to3([x0, y1], 0.4)];
    const insideFace = (q: V3[]) => q;
    switch (s.device) {
      case "stripe":
        b.pt.plate(insideFace(quad(-W * 0.22, -H * 0.95, W * 0.22, H * 0.95)), f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        break;
      case "cross":
        b.pt.plate(quad(-W * 0.2, -H * 0.95, W * 0.2, H * 0.95), f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        b.pt.plate(quad(-W * 0.95, -H * 0.35, W * 0.95, H * 0.02), f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        break;
      case "chevron":
        b.pt.plate([to3([-W, H * 0.1], 0.4), to3([0, -H * 0.45], 0.4), to3([W, H * 0.1], 0.4), to3([W, H * 0.45], 0.4), to3([0, -H * 0.1], 0.4), to3([-W, H * 0.45], 0.4)], f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        break;
      case "quarter":
        b.pt.plate(quad(0, -H, W, 0), f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        b.pt.plate(quad(-W, 0, 0, H), f.x, dp, { bulge: 0.5, zBias: 0.3, onlyOn: new Set([face]) });
        break;
      case "sun":
      case "lion": {
        const c = fp(f, 0.6, -H * 0.05, 0);
        b.pt.sphere(c, Math.min(W, H) * 0.42, dp, { zBias: 0.3, onlyOn: new Set([face]) });
        break;
      }
    }
  }
  if (s.boss) b.pt.sphere(fp(f, 0.5, 0, 0), Math.min(s.w, s.h) * 0.24, part(b, "boss", s.boss, group, TAG.SHIELD), { zBias: 0.5 });
  if (s.studs) {
    const sp = part(b, "studs", s.studs, group, TAG.SHIELD);
    for (const p of shieldOutline(s, 0.9).filter((_, i) => i % 3 === 0)) b.pt.sphere(to3(p, 0.45), 0.42, sp, { zBias: 0.4 });
  }
}

// ------------------------------------------------------------------------------------------------ books

/** A book (the cleric's tome): a closed volume with a clasp, at a frame. */
export function drawTome(b: Build, f: Frame, o: { cover: Material; pages: Material; clasp: Material; size: number }): void {
  const cp = part(b, "tome", o.cover, GROUP.GEAR, TAG.GEAR);
  const pp = part(b, "pages", o.pages, GROUP.GEAR, TAG.GEAR);
  const s = o.size;
  b.pt.fbox(f, [0, 0, 0], [s * 0.4, s * 1.1, s * 0.85], cp);
  b.pt.fbox(f, [0.15, 0, 0.1], [s * 0.32, s * 0.98, s * 0.8], pp, { zBias: 0.05 });
  b.pt.sphere(fp(f, s * 0.45, 0, s * 0.3), 0.5, part(b, "clasp", o.clasp, GROUP.GEAR, TAG.GEAR), { zBias: 0.2 });
}

export { clamp };
