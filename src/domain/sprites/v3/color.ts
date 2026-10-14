/**
 * HERO RENDERER v3 — colour: hue-shifted material RAMPS built in OKLab/OKLCH (perceptually even steps), packed RGB integers.
 *
 * A pixel artist's ramp is not "the colour, darker and lighter": shadows drift toward a cool hue and gain a little saturation, highlights drift
 * toward a warm hue and lose some. Every material of a hero (skin, hair, cloth in the class colour, steel, leather, gold…) is one 5-tone ramp
 * built the same way, so a figure reads as one palette instead of a collage of unrelated colours.
 *
 *   0 deep   the core shadow / interior line tone
 *   1 lo     shadow side
 *   2 base   the material's own colour (the hero's class colour exactly, for cloth)
 *   3 hi     the lit side
 *   4 spec   a glint (metal, gems, wet eyes) — used sparingly
 */

export type RGB = number; // 0xRRGGBB

export const rgb = (r: number, g: number, b: number): RGB => ((clamp8(r) << 16) | (clamp8(g) << 8) | clamp8(b)) >>> 0;
const clamp8 = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
export const R = (c: RGB): number => (c >>> 16) & 255;
export const G = (c: RGB): number => (c >>> 8) & 255;
export const B = (c: RGB): number => c & 255;

export function hex(h: string): RGB {
  const s = h.replace("#", "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return Number.isFinite(n) ? n >>> 0 : 0x808080;
}
export const toHex = (c: RGB): string => `#${c.toString(16).padStart(6, "0")}`;

// --------------------------------------------------------------------------------------- OKLab
const srgbToLin = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const linToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return c * 255;
};

export interface LCH {
  L: number;
  C: number;
  h: number; // degrees
}

export function toLch(c: RGB): LCH {
  const r = srgbToLin(R(c));
  const g = srgbToLin(G(c));
  const b = srgbToLin(B(c));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, Bb), h: ((Math.atan2(Bb, A) * 180) / Math.PI + 360) % 360 };
}

export function fromLch({ L, C, h }: LCH): RGB {
  // keep the chroma inside sRGB by shrinking it until the colour fits (a ramp never clips to a different hue)
  let c = Math.max(0, C);
  for (let i = 0; i < 12; i++) {
    const out = lchToRgbRaw(L, c, h);
    if (out) return out;
    c *= 0.85;
  }
  return lchToRgbRaw(L, 0, h) ?? 0;
}

function lchToRgbRaw(L: number, C: number, h: number): RGB | null {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const r = linToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const g = linToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const bb = linToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  const tol = 1.5;
  if (r < -tol || r > 255 + tol || g < -tol || g > 255 + tol || bb < -tol || bb > 255 + tol) return null;
  return rgb(r, g, bb);
}

/** Moves hue `h` toward `target` by up to `deg` degrees (the short way round). */
function hueToward(h: number, target: number, deg: number): number {
  let d = ((target - h + 540) % 360) - 180;
  if (Math.abs(d) > deg) d = Math.sign(d) * deg;
  return (h + d + 360) % 360;
}

export type Ramp = readonly [RGB, RGB, RGB, RGB, RGB];

export interface RampOpts {
  /** Lightness steps (OKLab L) below / above the base, per tone. */
  dark?: number;
  light?: number;
  /** Degrees the shadows drift toward a cool hue and the highlights toward a warm one. */
  shift?: number;
  /** Chroma multipliers for shadow / highlight tones. */
  shadowChroma?: number;
  lightChroma?: number;
  /** How bright the spec tone is above `hi`. */
  spec?: number;
}

const COOL = 280; // shadows lean violet-blue
const WARM = 85; // highlights lean yellow

/**
 * A 5-tone ramp around `base`. Near-grey colours (steel, bone) stay near-grey: the hue shift is scaled by chroma so a grey never turns purple.
 */
export function ramp(base: RGB, o: RampOpts = {}): Ramp {
  const b = toLch(base);
  const dark = o.dark ?? 0.13;
  const light = o.light ?? 0.1;
  const shiftK = Math.min(1, b.C / 0.05);
  const shift = (o.shift ?? 14) * shiftK;
  const sc = o.shadowChroma ?? 1.08;
  const lc = o.lightChroma ?? 0.86;
  const tone = (dL: number, hTarget: number, hDeg: number, cK: number): RGB => fromLch({ L: Math.min(0.985, Math.max(0.06, b.L + dL)), C: b.C * cK, h: hueToward(b.h, hTarget, hDeg) });
  // a very dark base still needs a readable shadow, a very light one a readable highlight: steps shrink toward the ends of the range
  const lo = tone(-dark * (b.L < 0.3 ? 0.6 : 1), COOL, shift * 0.6, sc);
  const deep = tone(-dark * (b.L < 0.3 ? 1.1 : 2.05), COOL, shift, sc * 0.95);
  const hi = tone(light * (b.L > 0.85 ? 0.45 : 1), WARM, shift * 0.7, lc);
  const spec = tone(light * (b.L > 0.85 ? 0.7 : 1) + (o.spec ?? 0.1), WARM, shift, lc * 0.55);
  return [deep, lo, base, hi, spec] as const;
}

/** Mixes two colours in sRGB (t = 0 → a). */
export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return rgb(R(a) + (R(b) - R(a)) * t, G(a) + (G(b) - G(a)) * t, B(a) + (B(b) - B(a)) * t);
}

/** The outline colour for a material: its deep tone pushed most of the way to a cool near-black (a dark line that still carries the colour). */
export function outlineOf(r: Ramp, k = 0.62): RGB {
  return mixRgb(r[0], 0x140f1c, k);
}

/** Adjusts lightness / chroma / hue of a colour in OKLCH. */
export function adjust(c: RGB, dL = 0, cK = 1, dH = 0): RGB {
  const l = toLch(c);
  return fromLch({ L: Math.min(0.985, Math.max(0.03, l.L + dL)), C: l.C * cK, h: (l.h + dH + 360) % 360 });
}
