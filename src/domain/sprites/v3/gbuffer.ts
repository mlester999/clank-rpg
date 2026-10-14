import type { Ramp, RGB } from "./color";
import type { V2, V3 } from "./vec";

/**
 * HERO RENDERER v3 — the G-BUFFER and its primitives.
 *
 * A hero frame is rasterised ONCE at its final pixel resolution (no supersampling, no down-scaling, no posterising): every primitive is a real
 * 3-D shape in view space (ellipsoid, swept sphere, box, flat plate, thin line) intersected with the orthographic ray through each PIXEL CENTRE.
 * The nearest surface wins (a z-buffer), so what covers what is decided by where things are — the near arm in front of the chest, the far
 * arm behind it, a sword in front of or behind the body as the swing carries it — never by a fixed layer order.
 *
 * Each covered pixel stores the part it belongs to (material, outline group, tone bias), its depth and its surface normal; `post.ts` turns that
 * into pixel art (quantised material ramps, selective interior lines, one silhouette outline, clean-up). Face features and other tiny details
 * are pixel STAMPS written onto an existing surface (they never float: a stamp pixel lands only on the part it is meant for).
 */

export type MaterialKind = "matte" | "skin" | "cloth" | "hair" | "metal" | "gem" | "glow" | "leather" | "wood" | "flat";

export interface Material {
  ramp: Ramp;
  kind: MaterialKind;
  outline: RGB;
}

/** Semantic tags the validators read back from a rendered frame (which pixels are the head, the eyes, a hand …). */
export const TAG = {
  NONE: 0,
  HEAD: 1,
  FACE: 2, // eyes, brows, mouth, nose (stamps)
  HAIR: 3,
  HELM: 4,
  TORSO: 5,
  ARM_N: 6, // the near arm (+Z side in the authored view)
  ARM_F: 7,
  HAND_N: 8,
  HAND_F: 9,
  LEG_N: 10,
  LEG_F: 11,
  FOOT: 12,
  WEAPON: 13,
  SHIELD: 14,
  CLOTH: 15, // capes, robes, sashes
  GEAR: 16,
  EYE: 17,
  FX: 18,
} as const;
export type Tag = (typeof TAG)[keyof typeof TAG];

export interface PartDef {
  /** Debug / validation name: "head", "armN.upper", "weapon.blade" … */
  name: string;
  mat: Material;
  /** Outline group: no interior line is drawn between two parts of one group (an upper arm and its forearm read as one limb). */
  group: number;
  /** Tone offset (−1: a far limb one step darker — the classic depth cue). */
  bias: number;
  tag: Tag;
}

export class GBuffer {
  readonly depth: Float32Array;
  readonly part: Int16Array;
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly nz: Float32Array;
  /** −1: shade from the normal; 0..4: a forced tone of the part's ramp. */
  readonly tone: Int8Array;
  /** −1: none; otherwise an exact colour (a stamp). */
  readonly color: Int32Array;
  readonly parts: PartDef[] = [];
  /** Optional global clip (the floor): return false to reject a surface point (view space). */
  floor: ((x: number, y: number, z: number) => boolean) | null = null;

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.depth = new Float32Array(n).fill(-Infinity);
    this.part = new Int16Array(n).fill(-1);
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.nz = new Float32Array(n);
    this.tone = new Int8Array(n).fill(-1);
    this.color = new Int32Array(n).fill(-1);
  }

  addPart(def: PartDef): number {
    this.parts.push(def);
    return this.parts.length - 1;
  }

  /** Depth-tested write of one pixel. Returns true when it won. */
  write(x: number, y: number, z: number, part: number, nx: number, ny: number, nz: number, tone = -1): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const i = y * this.w + x;
    if (!(z > (this.depth[i] as number))) return false;
    this.depth[i] = z;
    this.part[i] = part;
    this.nx[i] = nx;
    this.ny[i] = ny;
    this.nz[i] = nz;
    this.tone[i] = tone;
    this.color[i] = -1;
    return true;
  }

  partAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return this.part[y * this.w + x] as number;
  }
}

// =======================================================================================
// Primitives (all coordinates in VIEW space: x right, y down, z toward the camera, frame pixels)
// =======================================================================================

export interface PrimOpts {
  /** Added to the depth test only (not the stored normal): an armour shell wins against the body it wraps. */
  zBias?: number;
  /** Forced tone (0..4) instead of lighting. */
  tone?: number;
  /** Only write where the pixel currently belongs to one of these parts (clip a shape to a surface). */
  onlyOn?: ReadonlySet<number>;
  /** Clip: return false to reject a surface point (view-space hit point). */
  clip?: (x: number, y: number, z: number) => boolean;
}

const pxRange = (lo: number, hi: number, max: number): [number, number] => [Math.max(0, Math.floor(lo)), Math.min(max - 1, Math.ceil(hi))];

function writeOpt(g: GBuffer, x: number, y: number, z: number, part: number, n0: number, n1: number, n2: number, o: PrimOpts | undefined): void {
  if (o?.onlyOn && !o.onlyOn.has(g.partAt(x, y))) return;
  if (o?.clip && !o.clip(x + 0.5, y + 0.5, z)) return;
  if (g.floor && !g.floor(x + 0.5, y + 0.5, z)) return;
  g.write(x, y, z + (o?.zBias ?? 0), part, n0, n1, n2, o?.tone ?? -1);
}

function inv3(m: readonly number[]): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-9) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/**
 * An ELLIPSOID: centre + three (scaled) axis vectors. Exact ray intersection; the normal is the ellipsoid's own (so a head, a pauldron, a
 * belly are lit as round volumes).
 */
export function ellipsoid(g: GBuffer, c: V3, a1: V3, a2: V3, a3: V3, part: number, o?: PrimOpts): void {
  // M = [a1 a2 a3] (columns), row-major
  const M = [a1[0], a2[0], a3[0], a1[1], a2[1], a3[1], a1[2], a2[2], a3[2]];
  const Mi = inv3(M);
  if (!Mi) return;
  const ex = Math.hypot(a1[0], a2[0], a3[0]);
  const ey = Math.hypot(a1[1], a2[1], a3[1]);
  const [x0, x1] = pxRange(c[0] - ex - 0.5, c[0] + ex, g.w);
  const [y0, y1] = pxRange(c[1] - ey - 0.5, c[1] + ey, g.h);
  // d = Mi · e_z (third column)
  const d0 = Mi[2] as number;
  const d1 = Mi[5] as number;
  const d2 = Mi[8] as number;
  const dd = d0 * d0 + d1 * d1 + d2 * d2;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5 - c[1];
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - c[0];
      const q0 = (Mi[0] as number) * px + (Mi[1] as number) * py;
      const q1 = (Mi[3] as number) * px + (Mi[4] as number) * py;
      const q2 = (Mi[6] as number) * px + (Mi[7] as number) * py;
      const qd = q0 * d0 + q1 * d1 + q2 * d2;
      const qq = q0 * q0 + q1 * q1 + q2 * q2;
      const disc = qd * qd - dd * (qq - 1);
      if (disc < 0) continue;
      const s = (-qd + Math.sqrt(disc)) / dd;
      const h0 = q0 + s * d0;
      const h1 = q1 + s * d1;
      const h2 = q2 + s * d2;
      // normal = Mi^T h
      let n0 = (Mi[0] as number) * h0 + (Mi[3] as number) * h1 + (Mi[6] as number) * h2;
      let n1 = (Mi[1] as number) * h0 + (Mi[4] as number) * h1 + (Mi[7] as number) * h2;
      let n2 = (Mi[2] as number) * h0 + (Mi[5] as number) * h1 + (Mi[8] as number) * h2;
      const nl = Math.hypot(n0, n1, n2) || 1;
      n0 /= nl;
      n1 /= nl;
      n2 /= nl;
      writeOpt(g, x, y, c[2] + s, part, n0, n1, n2, o);
    }
  }
}

/** A sphere (an ellipsoid with three equal axes). */
export function sphere(g: GBuffer, c: V3, r: number, part: number, o?: PrimOpts): void {
  ellipsoid(g, c, [r, 0, 0], [0, r, 0], [0, 0, r], part, o);
}

/**
 * A SWEPT SPHERE from `a` (radius ra) to `b` (radius rb): a tapered limb, a neck, a staff. For each pixel the nearest surface over the sweep is
 * found by sampling the axis (limbs are a few pixels long, so a sample every ~0.6 px is exact at pixel scale).
 */
export function capsule(g: GBuffer, a: V3, b: V3, ra: number, rb: number, part: number, o?: PrimOpts): void {
  const rmax = Math.max(ra, rb);
  const [x0, x1] = pxRange(Math.min(a[0], b[0]) - rmax - 0.5, Math.max(a[0], b[0]) + rmax, g.w);
  const [y0, y1] = pxRange(Math.min(a[1], b[1]) - rmax - 0.5, Math.max(a[1], b[1]) + rmax, g.h);
  const L2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const N = Math.max(2, Math.ceil(L2 / 0.6) + 1);
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      let best = -Infinity;
      let bn0 = 0;
      let bn1 = 0;
      let bn2 = 1;
      for (let k = 0; k <= N; k++) {
        const t = k / N;
        const cx = a[0] + (b[0] - a[0]) * t;
        const cy = a[1] + (b[1] - a[1]) * t;
        const cz = a[2] + (b[2] - a[2]) * t;
        const r = ra + (rb - ra) * t;
        const dx = px - cx;
        const dy = py - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r) continue;
        const hz = Math.sqrt(r * r - d2);
        const z = cz + hz;
        if (z > best) {
          best = z;
          bn0 = dx / r;
          bn1 = dy / r;
          bn2 = hz / r;
        }
      }
      if (best > -Infinity) writeOpt(g, x, y, best, part, bn0, bn1, bn2, o);
    }
  }
}

/** An oriented BOX: centre, three unit axes and half-sizes. Exact slab intersection; the normal is the face hit. */
export function box(g: GBuffer, c: V3, u: readonly [V3, V3, V3], h: V3, part: number, o?: PrimOpts): void {
  const ex = Math.abs(u[0][0]) * h[0] + Math.abs(u[1][0]) * h[1] + Math.abs(u[2][0]) * h[2];
  const ey = Math.abs(u[0][1]) * h[0] + Math.abs(u[1][1]) * h[1] + Math.abs(u[2][1]) * h[2];
  const ez = Math.abs(u[0][2]) * h[0] + Math.abs(u[1][2]) * h[1] + Math.abs(u[2][2]) * h[2];
  const [x0, x1] = pxRange(c[0] - ex - 0.5, c[0] + ex, g.w);
  const [y0, y1] = pxRange(c[1] - ey - 0.5, c[1] + ey, g.h);
  const oz = c[2] + ez + 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - c[0];
      const py = y + 0.5 - c[1];
      const pz = oz - c[2];
      let tmin = -Infinity;
      let tmax = Infinity;
      let axis = 0;
      let sign = 1;
      let ok = true;
      for (let k = 0; k < 3; k++) {
        const ax = u[k] as V3;
        const ol = px * ax[0] + py * ax[1] + pz * ax[2];
        const dl = -ax[2];
        const hk = h[k] as number;
        if (Math.abs(dl) < 1e-9) {
          if (ol < -hk || ol > hk) {
            ok = false;
            break;
          }
          continue;
        }
        let t1 = (-hk - ol) / dl;
        let t2 = (hk - ol) / dl;
        let s = -1;
        if (t1 > t2) {
          const tt = t1;
          t1 = t2;
          t2 = tt;
          s = 1;
        }
        if (t1 > tmin) {
          tmin = t1;
          axis = k;
          sign = s;
        }
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) {
          ok = false;
          break;
        }
      }
      if (!ok || tmin === -Infinity) continue;
      const ax = u[axis] as V3;
      // the entry face's outward normal: −sign·ax relative to the ray direction (0,0,−1)
      let n0 = ax[0] * -sign;
      let n1 = ax[1] * -sign;
      let n2 = ax[2] * -sign;
      if (n2 < 0) {
        n0 = -n0;
        n1 = -n1;
        n2 = -n2;
      }
      writeOpt(g, x, y, oz - tmin, part, n0, n1, n2, o);
    }
  }
}

/**
 * A flat PLATE: a planar polygon (3-D points, any winding), filled where its projection covers a pixel centre; depth from its plane. Seen
 * edge-on it still covers at least its projected outline (a shield turned sideways is a sliver, not nothing). `normal` is the plate's face
 * normal (flipped toward the camera); `bulge` rounds the lighting toward the edges (a slightly convex shield / cloth panel).
 */
export function plate(g: GBuffer, pts: readonly V3[], normal: V3, part: number, o?: PrimOpts & { bulge?: number }): void {
  if (pts.length < 3) return;
  let nx = normal[0];
  let ny = normal[1];
  let nz = normal[2];
  if (nz < 0) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of pts) {
    minX = Math.min(minX, p[0]);
    maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]);
    maxY = Math.max(maxY, p[1]);
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  cx /= pts.length;
  cy /= pts.length;
  cz /= pts.length;
  const span = Math.max(1, Math.hypot(maxX - minX, maxY - minY) / 2);
  const [x0, x1] = pxRange(minX - 0.5, maxX, g.w);
  const [y0, y1] = pxRange(minY - 0.5, maxY, g.h);
  const flat = Math.abs(nz) < 0.2;
  const bulge = o?.bulge ?? 0;
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const pi = pts[i] as V3;
        const pj = pts[j] as V3;
        if (pi[1] > py !== pj[1] > py && px < ((pj[0] - pi[0]) * (py - pi[1])) / (pj[1] - pi[1] + 1e-12) + pi[0]) inside = !inside;
      }
      if (!inside) continue;
      const z = flat ? cz : cz - (nx * (px - cx) + ny * (py - cy)) / nz;
      let n0 = nx;
      let n1 = ny;
      let n2 = nz;
      if (bulge > 0) {
        n0 += ((px - cx) / span) * bulge;
        n1 += ((py - cy) / span) * bulge;
        const l = Math.hypot(n0, n1, n2) || 1;
        n0 /= l;
        n1 /= l;
        n2 /= l;
      }
      writeOpt(g, x, y, z, part, n0, n1, n2, o);
    }
  }
  if (flat) {
    // edge-on: make sure the sliver is at least a 1-px line along its long axis
    let a = pts[0] as V3;
    let b = pts[0] as V3;
    let best = 0;
    for (const p of pts) for (const q of pts) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d > best) {
        best = d;
        a = p;
        b = q;
      }
    }
    line(g, a, b, 1, part, [nx, ny, nz], o);
  }
}

/**
 * A THIN LINE — a blade, a shaft, a bow-string, an arrow. Pixel-art lines are not thin shapes sampled at pixel centres (that breaks them up at
 * shallow angles): this steps one pixel per major-axis step (Bresenham-style) between the rounded end points, so a 1-px line is unbroken and
 * never doubled, and a wider line is that same spine with parallel copies. Depth is interpolated along it.
 */
export function line(g: GBuffer, a: V3, b: V3, width: number, part: number, normal: V3 = [0, 0, 1], o?: PrimOpts & { side?: V2; tones?: readonly number[] }): void {
  let x = Math.floor(a[0]);
  let y = Math.floor(a[1]);
  const xe = Math.floor(b[0]);
  const ye = Math.floor(b[1]);
  const dx = Math.abs(xe - x);
  const dy = -Math.abs(ye - y);
  const sx = x < xe ? 1 : -1;
  const sy = y < ye ? 1 : -1;
  let err = dx + dy;
  const steps = Math.max(dx, -dy);
  // offsets for the extra width: perpendicular to the MAJOR axis, toward `side` (default: up for a flat line, the lit side)
  const major = dx >= -dy ? "x" : "y";
  const side = o?.side ?? (major === "x" ? [0, -1] : [1, 0]);
  const offs: Array<[number, number]> = [[0, 0]];
  for (let k = 1; k < width; k++) {
    const m = Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1);
    offs.push(major === "x" ? [0, m * (side[1] >= 0 ? 1 : -1)] : [m * (side[0] >= 0 ? 1 : -1), 0]);
  }
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const z = a[2] + (b[2] - a[2]) * t;
    for (let k = 0; k < offs.length; k++) {
      const [ox, oy] = offs[k] as [number, number];
      const t = o?.tones?.[k];
      writeOpt(g, x + ox, y + oy, z, part, normal[0], normal[1], normal[2], t === undefined ? o : { ...o, tone: t });
    }
    if (x === xe && y === ye) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * A pixel STAMP: `rows` of characters, each mapped to a colour by `pal` (`.` and space = skip), with its origin at (x, y). Stamps write exact
 * colours on top of a surface — and ONLY where the pixel already belongs to one of `on` (an eye can never land outside the head, a buckle
 * outside its belt). Returns how many pixels were written.
 */
export function stamp(g: GBuffer, x: number, y: number, rows: readonly string[], pal: Readonly<Record<string, RGB | number>>, part: number, on: ReadonlySet<number>, zLift = 0.05, tone = false): number {
  let n = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] as string;
    for (let c = 0; c < row.length; c++) {
      const ch = row[c] as string;
      if (ch === "." || ch === " ") continue;
      const v = pal[ch];
      if (v === undefined) continue;
      const px = x + c;
      const py = y + r;
      if (px < 0 || py < 0 || px >= g.w || py >= g.h) continue;
      const i = py * g.w + px;
      const cur = g.part[i] as number;
      if (!on.has(cur)) continue;
      g.depth[i] = (g.depth[i] as number) + zLift;
      g.part[i] = part;
      if (tone) {
        g.tone[i] = v as number;
        g.color[i] = -1;
      } else {
        g.color[i] = v as number;
        g.tone[i] = -1;
      }
      n++;
    }
  }
  return n;
}
