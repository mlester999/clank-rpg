import { B, G, R, type RGB } from "./color";
import type { GBuffer, PartDef } from "./gbuffer";

/**
 * HERO RENDERER v3 — from G-buffer to PIXEL ART.
 *
 *   1. tone    every pixel picks one of its material's 5 ramp tones from its surface normal and ONE light (top-front of the hero), with
 *              material-specific bands: skin and cloth soft, metal a mirror of sky and ground with a single glint, gems and glows bright.
 *              A far limb is one tone darker (the classic depth cue). No dithering, no gradients: flat clusters.
 *   2. lines   selective interior lines: where a part passes IN FRONT of another outline group (a near arm over the chest, a hand over a
 *              shield), the pixel just behind it takes that back part's deepest tone — a contour in the local colour, never a black seam.
 *   3. clean   orphan pixels (a lone tone inside a flat cluster) join their neighbours; a one-pixel "hole" of background inside the figure is
 *              filled.
 *   4. outline one 1-px silhouette outline around the whole figure, in a near-black that carries the adjacent material's hue.
 */

/** The light, in view space (x right, y DOWN, z toward the camera): from above, in front of the hero and a little toward the viewer. */
export const LIGHT: readonly [number, number, number] = (() => {
  const l = [0.38, -0.78, 0.5];
  const n = Math.hypot(l[0] as number, l[1] as number, l[2] as number);
  return [(l[0] as number) / n, (l[1] as number) / n, (l[2] as number) / n] as const;
})();
const HALF = (() => {
  const h = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const n = Math.hypot(h[0] as number, h[1] as number, h[2] as number);
  return [(h[0] as number) / n, (h[1] as number) / n, (h[2] as number) / n] as const;
})();

export interface PostOptions {
  /** Depth jump (px) between different outline groups that draws an interior line. */
  lineDepth?: number;
  /** Depth jump inside ONE group that still draws a line (a hand in front of its own forearm …). */
  lineDepthSameGroup?: number;
  /** Silhouette outline on (default true). */
  outline?: boolean;
}

export interface PostResult {
  rgba: Uint8ClampedArray;
  /** The part index of every pixel after post (−1 background, −2 silhouette outline). */
  parts: Int16Array;
}

function toneOf(def: PartDef, nx: number, ny: number, nz: number): number {
  const lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
  let t: number;
  switch (def.mat.kind) {
    case "skin":
      t = lam > 0.62 ? 3 : lam > -0.12 ? 2 : lam > -0.6 ? 1 : 0;
      break;
    case "cloth":
    case "leather":
      t = lam > 0.66 ? 3 : lam > -0.02 ? 2 : lam > -0.55 ? 1 : 0;
      break;
    case "hair":
      t = lam > 0.55 ? 3 : lam > -0.05 ? 2 : lam > -0.5 ? 1 : 0;
      break;
    case "wood":
      t = lam > 0.6 ? 3 : lam > -0.1 ? 2 : 1;
      break;
    case "metal": {
      // clean bands at sprite scale: lit / mid / shadow by the light, a dark band where the surface faces the floor, one glint
      const spec = nx * HALF[0] + ny * HALF[1] + nz * HALF[2];
      if (spec > 0.968) t = 4;
      else if (lam > 0.5) t = 3;
      else if (ny > 0.62) t = 1;
      else if (lam > -0.05) t = 2;
      else if (lam > -0.55) t = 1;
      else t = 0;
      break;
    }
    case "gem": {
      const spec = nx * HALF[0] + ny * HALF[1] + nz * HALF[2];
      t = spec > 0.9 ? 4 : lam > 0.2 ? 3 : lam > -0.4 ? 2 : 1;
      break;
    }
    case "glow":
      t = lam > 0.2 ? 4 : 3;
      break;
    case "flat":
      t = 2;
      break;
    default:
      t = lam > 0.6 ? 3 : lam > -0.08 ? 2 : lam > -0.55 ? 1 : 0;
  }
  if (def.bias !== 0 && t < 4) t = Math.max(0, Math.min(3, t + def.bias));
  return t;
}

/** Packs a colour into an RGBA buffer. */
const put = (out: Uint8ClampedArray, i: number, c: RGB): void => {
  out[i * 4] = R(c);
  out[i * 4 + 1] = G(c);
  out[i * 4 + 2] = B(c);
  out[i * 4 + 3] = 255;
};

export function resolve(g: GBuffer, o: PostOptions = {}): PostResult {
  const { w, h } = g;
  const n = w * h;
  const tone = new Int8Array(n).fill(-1);
  const exact = new Int32Array(n).fill(-1);
  const parts = new Int16Array(n);
  parts.set(g.part);

  // 1 — tones
  for (let i = 0; i < n; i++) {
    const p = g.part[i] as number;
    if (p < 0) continue;
    if ((g.color[i] as number) >= 0) {
      exact[i] = g.color[i] as number;
      continue;
    }
    const forced = g.tone[i] as number;
    tone[i] = forced >= 0 ? forced : toneOf(g.parts[p] as PartDef, g.nx[i] as number, g.ny[i] as number, g.nz[i] as number);
  }

  // 3a — clean-up: a pixel whose tone disagrees with at least three of its four neighbours of the SAME part, while those agree with each
  // other, joins them (two passes): no lone specks of highlight or shadow inside a flat cluster. Glints (tone 4) and stamps are kept.
  for (let pass = 0; pass < 2; pass++) {
    const t2 = new Int8Array(tone);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const p = parts[i] as number;
        if (p < 0 || (exact[i] as number) >= 0 || (g.tone[i] as number) >= 0) continue;
        const me = tone[i] as number;
        if (me === 4) continue;
        const votes = new Map<number, number>();
        let same = 0;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (parts[j] !== p || (exact[j] as number) >= 0) continue;
          same++;
          const tj = tone[j] as number;
          if (tj !== me) votes.set(tj, (votes.get(tj) ?? 0) + 1);
        }
        for (const [tv, n] of votes) if (n >= 3 || (n >= 2 && same === 2)) t2[i] = tv;
      }
    }
    tone.set(t2);
  }

  // 2 — selective interior lines (on the BACK part, along the front part's edge)
  const lineD = o.lineDepth ?? 0.9;
  const lineSame = o.lineDepthSameGroup ?? 3.2;
  /** 1 = a seam in the deepest tone, 2 = a soft seam (two pieces of one material: plate on plate, cloth on cloth). */
  const line = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const p = parts[i] as number;
      if (p < 0) continue;
      const dp = g.parts[p] as PartDef;
      if (dp.tag === 2 || dp.tag === 17) continue; // face stamps never take a line
      const zi = g.depth[i] as number;
      let soft = true;
      const check = (j: number): boolean => {
        const q = parts[j] as number;
        if (q < 0 || q === p) return false;
        const dq = g.parts[q] as PartDef;
        const dz = (g.depth[j] as number) - zi;
        const hit = dq.group === dp.group ? dz > lineSame : dz > lineD;
        if (hit && dq.mat.ramp !== dp.mat.ramp) soft = false;
        return hit;
      };
      const l = x > 0 && check(i - 1);
      const r2 = x < w - 1 && check(i + 1);
      const u = y > 0 && check(i - w);
      const d = y < h - 1 && check(i + w);
      if (l || r2 || u || d) line[i] = soft ? 2 : 1;
    }
  }

  // 3b — a one-pixel background hole enclosed by the figure (4 opaque neighbours) is filled with its upper neighbour
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (parts[i] !== -1) continue;
      if ((parts[i - 1] as number) >= 0 && (parts[i + 1] as number) >= 0 && (parts[i - w] as number) >= 0 && (parts[i + w] as number) >= 0) {
        const j = i - w;
        parts[i] = parts[j] as number;
        tone[i] = Math.max(0, (tone[j] as number) - 1);
        exact[i] = exact[j] as number;
        g.depth[i] = g.depth[j] as number;
      }
    }
  }

  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = parts[i] as number;
    if (p < 0) continue;
    const def = g.parts[p] as PartDef;
    if ((exact[i] as number) >= 0) {
      put(out, i, exact[i] as number);
      continue;
    }
    const t = line[i] === 1 ? 0 : line[i] === 2 ? Math.min(1, tone[i] as number) : (tone[i] as number);
    put(out, i, def.mat.ramp[Math.max(0, Math.min(4, t))] as RGB);
  }

  // 4 — the silhouette outline (4-neighbourhood: clean single-pixel steps on diagonals)
  if (o.outline !== false) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (parts[i] !== -1) continue;
        let best = -1;
        let bestZ = -Infinity;
        for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]] as const) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          const q = parts[j] as number;
          if (q < 0) continue;
          const z = g.depth[j] as number;
          if (z > bestZ) {
            bestZ = z;
            best = q;
          }
        }
        if (best >= 0) {
          put(out, i, (g.parts[best] as PartDef).mat.outline);
          parts[i] = -2;
        }
      }
    }
  }
  return { rgba: out, parts };
}
