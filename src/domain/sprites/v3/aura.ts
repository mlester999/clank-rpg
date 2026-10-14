import { B, G, R, ramp, hex, type RGB } from "./color";
import { ANCHOR, FRAME_H, FRAME_W } from "./render";

/**
 * HERO RENDERER v3 — the RARITY AURA (a stored trait: `aura.ring` · `aura.sparks` · `aura.flame`), drawn as pixel PARTICLES at the feet on
 * a loop of its own clock — never a ring around the body. Each particle is a hand-placed pixel cluster in the rarity colour's ramp:
 *
 *   ring    (Rare)       three motes circling low around the feet
 *   sparks  (Epic)       four diamond sparks lifting off the floor and fading
 *   flame   (Legendary)  a low flicker of ember tongues at the feet, a spark leaving now and then
 */

export const AURA_FRAMES = 8;
export const AURA_FPS = 8;

const put = (out: Uint8ClampedArray, x: number, y: number, c: RGB, a = 255): void => {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 1 || yi < 1 || xi >= FRAME_W - 1 || yi >= FRAME_H - 1) return;
  const i = (yi * FRAME_W + xi) * 4;
  // keep the brighter of two particles that overlap
  if ((out[i + 3] as number) > 0 && R(c) + G(c) + B(c) < (out[i] as number) + (out[i + 1] as number) + (out[i + 2] as number)) return;
  out[i] = R(c);
  out[i + 1] = G(c);
  out[i + 2] = B(c);
  out[i + 3] = a;
};

export function renderAura(kind: string, rarityColor: string, f: number, frames = AURA_FRAMES): Uint8ClampedArray {
  const out = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  const r = ramp(hex(rarityColor), { light: 0.14, spec: 0.14 });
  const [, lo, base, hi, spec] = r;
  const ax = ANCHOR.x + 0.5;
  const ay = ANCHOR.y + 0.5;
  const ph = f / frames;
  switch (kind) {
    case "ring": {
      for (let i = 0; i < 3; i++) {
        const t = ((ph + i / 3) % 1) * Math.PI * 2;
        const x = ax + Math.cos(t) * 12;
        const y = ay - 0.5 + Math.sin(t) * 2.6;
        const front = Math.sin(t) > -0.2;
        // a 2×2 mote with a lit corner (dimmer behind the feet)
        put(out, x, y, front ? hi : base);
        put(out, x + 1, y, front ? base : lo);
        put(out, x, y + 1, front ? base : lo);
        if (front) put(out, x + 1, y + 1, lo);
      }
      break;
    }
    case "sparks": {
      for (let i = 0; i < 4; i++) {
        const k = (ph + i / 4) % 1;
        if (k > 0.86) continue;
        const x = ax - 9 + i * 6 + Math.round(Math.sin((k + i) * 6) * 1.2);
        const y = ay - 1 - k * 11;
        const c = k < 0.5 ? spec : hi;
        // a diamond: centre + four arms (arms drop off as it fades)
        put(out, x, y, c);
        if (k < 0.65) {
          put(out, x - 1, y, base);
          put(out, x + 1, y, base);
          put(out, x, y - 1, base);
          put(out, x, y + 1, base);
        }
      }
      break;
    }
    case "flame": {
      for (let i = 0; i < 5; i++) {
        const k = (ph + i * 0.37) % 1;
        const x = Math.round(ax - 8 + i * 4);
        const h = Math.round(3 + Math.sin((k + i) * Math.PI * 2) * 1.4);
        // an ember tongue: bright core low, darker tip
        for (let y = 0; y < h; y++) {
          const c = y === 0 ? spec : y < h - 1 ? hi : base;
          put(out, x, ay - 1 - y, c);
          if (y < h - 2) put(out, x + 1, ay - 1 - y, y === 0 ? hi : base);
        }
        // now and then a spark leaves the tongue
        const sk = (ph * 2 + i * 0.23) % 1;
        if (sk < 0.5) put(out, x + (i % 2 ? 1 : 0), ay - h - 2 - sk * 10, sk < 0.25 ? spec : hi);
      }
      break;
    }
    default:
      break;
  }
  return out;
}
