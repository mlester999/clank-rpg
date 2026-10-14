/**
 * HERO RENDERER v3 — small 3-D vector kit. Pure numbers, no allocation tricks: a hero frame touches a few hundred vectors.
 *
 * Character space (the body is built and posed here): X = forward (the way the hero faces), Y = up (0 = the floor), Z = the hero's RIGHT side.
 * View space (what the rasteriser sees): x = screen right, y = screen DOWN, z = toward the camera (bigger = nearer), in frame pixels.
 */

export type V3 = readonly [number, number, number];
export type V2 = readonly [number, number];

export const v3 = (x: number, y: number, z: number): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const finite3 = (a: V3): boolean => Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
export const DEG = Math.PI / 180;

/** Rotation about the X axis (forward) by `a` radians: +a rolls the top toward +Z. */
export const rotX = (p: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
};
/** Rotation about the Y axis (up): +a turns +X toward −Z (a yaw to the hero's left). */
export const rotY = (p: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
};
/** Rotation about the Z axis (lateral): +a tips +Y toward +X (a forward lean). */
export const rotZ = (p: V3, a: number): V3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c + p[1] * s, -p[0] * s + p[1] * c, p[2]];
};

/** An orthonormal frame: origin + three axes (columns). Points are mapped `o + x·ax + y·ay + z·az`. */
export interface Frame {
  o: V3;
  x: V3;
  y: V3;
  z: V3;
}

export const IDENTITY: Frame = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

export const at = (f: Frame, x: number, y: number, z: number): V3 => [
  f.o[0] + f.x[0] * x + f.y[0] * y + f.z[0] * z,
  f.o[1] + f.x[1] * x + f.y[1] * y + f.z[1] * z,
  f.o[2] + f.x[2] * x + f.y[2] * y + f.z[2] * z,
];
/** A direction in frame `f` (no translation). */
export const dir = (f: Frame, x: number, y: number, z: number): V3 => [
  f.x[0] * x + f.y[0] * y + f.z[0] * z,
  f.x[1] * x + f.y[1] * y + f.z[1] * z,
  f.x[2] * x + f.y[2] * y + f.z[2] * z,
];

/**
 * A frame whose Y axis points along `up`, with X as close as possible to `fwdHint` (Gram–Schmidt). Used for bones (Y along the bone) and for
 * weapons (Y up the blade, X the edge's facing).
 */
export function frameAlong(o: V3, up: V3, fwdHint: V3): Frame {
  const y = norm(up);
  let x = sub(fwdHint, mul(y, dot(fwdHint, y)));
  if (len(x) < 1e-6) x = Math.abs(y[0]) < 0.9 ? sub([1, 0, 0], mul(y, y[0])) : sub([0, 0, 1], mul(y, y[2]));
  const xn = norm(x);
  return { o, x: xn, y, z: cross(xn, y) };
}

/** Rotates a frame's axes about its own Y axis by `a` (a twist). */
export function twistFrame(f: Frame, a: number): Frame {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { o: f.o, x: add(mul(f.x, c), mul(f.z, -s)), y: f.y, z: add(mul(f.x, s), mul(f.z, c)) };
}

/** Smoothstep-style easings for keyframe interpolation. */
export const ease = {
  linear: (t: number) => t,
  in: (t: number) => t * t,
  out: (t: number) => 1 - (1 - t) * (1 - t),
  inOut: (t: number) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  /** Snappy: most of the motion early (a strike). */
  snap: (t: number) => 1 - Math.pow(1 - t, 3),
  /** Slow start, fast finish (an anticipation that releases). */
  coil: (t: number) => t * t * t,
} as const;
export type EaseName = keyof typeof ease;
