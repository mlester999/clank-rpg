import { createCanvas, ImageData, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

/**
 * Drawing toolkit for the DEV placeholder sprite generator.
 *
 * Everything is authored in sprite pixels on an 80×64 frame but rasterised at 4× and then
 * down-sampled with a hard alpha threshold and posterised colour, which yields crisp pixel-art
 * edges with consistent 1 px outlines (instead of blurry anti-aliasing). Layers are authored in
 * neutral GREY where they are meant to be tinted at runtime (mid-grey = the tint colour exactly,
 * lighter/darker = highlight/shadow), and in real colours where they are not.
 */

/** 80×64: wide enough that a lunging hero with a long weapon never clips the cell. */
export const FRAME_W = 80;
export const FRAME_H = 64;
export const SS = 4;

export type Ctx = SKRSContext2D;
export type Pt = readonly [number, number];

export const OL = "#15151a";
/** Grey ramp for tintable layers (128 = tint colour as-is). */
export const G = { hi: "#b4b4b4", base: "#808080", lo: "#585858", deep: "#3a3a3a" } as const;

export function newFrame(): { canvas: Canvas; g: Ctx } {
  const canvas = createCanvas(FRAME_W * SS, FRAME_H * SS);
  const g = canvas.getContext("2d");
  g.scale(SS, SS);
  g.lineJoin = "round";
  g.lineCap = "round";
  return { canvas, g };
}

/** Outlined thick polyline (arms, legs): outline stroke, then fill stroke. */
export function tube(g: Ctx, pts: readonly Pt[], w: number, fill: string, ol = 1, outline = OL): void {
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  g.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1])));
  g.strokeStyle = outline;
  g.lineWidth = w + ol * 2;
  g.stroke();
  g.strokeStyle = fill;
  g.lineWidth = w;
  g.stroke();
  g.restore();
}

export function path(g: Ctx, pts: readonly Pt[], close = true): void {
  g.beginPath();
  pts.forEach((p, i) => (i === 0 ? g.moveTo(p[0], p[1]) : g.lineTo(p[0], p[1])));
  if (close) g.closePath();
}

export function fillStroke(g: Ctx, fill: string, lw = 1, outline = OL): void {
  g.fillStyle = fill;
  g.fill();
  if (lw > 0) {
    g.strokeStyle = outline;
    g.lineWidth = lw;
    g.stroke();
  }
}

export function poly(g: Ctx, pts: readonly Pt[], fill: string, lw = 1, outline = OL): void {
  path(g, pts);
  fillStroke(g, fill, lw, outline);
}

export function circle(g: Ctx, x: number, y: number, r: number, fill: string, lw = 1, outline = OL): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  fillStroke(g, fill, lw, outline);
}

export function ellipse(g: Ctx, x: number, y: number, rx: number, ry: number, fill: string, lw = 1, outline = OL, rot = 0): void {
  g.beginPath();
  g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  fillStroke(g, fill, lw, outline);
}

export function rrect(g: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, lw = 1, outline = OL): void {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
  fillStroke(g, fill, lw, outline);
}

export function line(g: Ctx, a: Pt, b: Pt, w: number, color: string): void {
  g.save();
  g.beginPath();
  g.moveTo(a[0], a[1]);
  g.lineTo(b[0], b[1]);
  g.strokeStyle = color;
  g.lineWidth = w;
  g.lineCap = "round";
  g.stroke();
  g.restore();
}

/** Run `fn` in a local coordinate frame (origin at `at`, rotated by `angle`; local up is −y). */
export function local(g: Ctx, at: Pt, angle: number, fn: () => void): void {
  g.save();
  g.translate(at[0], at[1]);
  g.rotate(angle);
  fn();
  g.restore();
}

/** A circle with simple cel shading: lit upper-left, shadowed lower-right, both clipped to the disc. */
export function shadedDisc(g: Ctx, x: number, y: number, r: number, base: string, lo: string, hi: string): void {
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = base;
  g.fill();
  g.clip();
  g.fillStyle = lo;
  g.beginPath();
  g.rect(x - r - 1, y - r - 1, r * 2 + 2, r * 2 + 2);
  g.arc(x - r * 0.28, y - r * 0.3, r * 1.02, 0, Math.PI * 2, true);
  g.fill("evenodd");
  g.fillStyle = hi;
  g.beginPath();
  g.arc(x - r * 0.42, y - r * 0.45, r * 0.34, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.strokeStyle = OL;
  g.lineWidth = 1;
  g.stroke();
}

/**
 * Hard-edged down-sample of the 4× supersample canvas into one 64×64 cell:
 *  · a pixel is opaque when ≥ 50% of its 16 samples are covered, else fully transparent;
 *  · colour is the coverage-weighted average, posterised to `levels` steps per channel.
 */
export function pixelate(src: Canvas, levels = 7): Uint8ClampedArray {
  const w = src.width;
  const data = src.getContext("2d").getImageData(0, 0, w, src.height).data;
  const out = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  const q = (v: number) => Math.round((Math.round((v / 255) * (levels - 1)) / (levels - 1)) * 255);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      let a = 0;
      let r = 0;
      let gg = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * w + (x * SS + sx)) * 4;
          const al = data[i + 3] as number;
          a += al;
          r += (data[i] as number) * al;
          gg += (data[i + 1] as number) * al;
          b += (data[i + 2] as number) * al;
        }
      }
      const cover = a / (SS * SS * 255);
      const o = (y * FRAME_W + x) * 4;
      if (cover >= 0.5 && a > 0) {
        out[o] = q(r / a);
        out[o + 1] = q(gg / a);
        out[o + 2] = q(b / a);
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

export function imageDataOf(pixels: Uint8ClampedArray, w = FRAME_W, h = FRAME_H): ImageData {
  return new ImageData(pixels, w, h);
}
