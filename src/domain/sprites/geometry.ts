import type { ClipDef, ClipKey, Direction, LayerDef, SpriteManifest } from "./spec";

/**
 * Where every cell of every layer lives. Layer block layout (identical for ALL layers, which is
 * what makes layers interchangeable):
 *
 *   x → frame 0 … frame (cols-1)
 *   y → [direction 0: clip rows 0…rows-1] [direction 1: clip rows…] …
 */

export interface Rect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export function gridCols(m: SpriteManifest): number {
  return Math.max(1, ...Object.values(m.clips).map((c) => c?.frames ?? 1));
}

export function gridRows(m: SpriteManifest): number {
  return 1 + Math.max(0, ...Object.values(m.clips).map((c) => c?.row ?? 0));
}

/** Number of authored (vertically stacked) direction blocks. */
export function directionBlocks(m: SpriteManifest): number {
  let max = 0;
  for (const d of Object.values(m.directions)) if (d && "index" in d) max = Math.max(max, d.index);
  return max + 1;
}

/** Pixel size of one layer block (what a layer occupies inside its atlas image). */
export function blockSize(m: SpriteManifest): { w: number; h: number } {
  return { w: gridCols(m) * m.frame.w, h: gridRows(m) * directionBlocks(m) * m.frame.h };
}

export interface ResolvedDirection {
  /** Which authored direction block to read. */
  index: number;
  /** Draw horizontally flipped. */
  mirror: boolean;
}

/**
 * Maps a requested direction onto authored art. `left` mirrors `right` unless a set authors it;
 * a direction a set does not provide at all falls back to `right` so a hero is never invisible.
 */
export function resolveDirection(m: SpriteManifest, dir: Direction): ResolvedDirection {
  const d = m.directions[dir];
  if (d && "index" in d) return { index: d.index, mirror: false };
  if (d && "mirror" in d) {
    const target = m.directions[d.mirror];
    if (target && "index" in target) return { index: target.index, mirror: true };
  }
  const right = m.directions.right;
  return { index: right && "index" in right ? right.index : 0, mirror: dir === "left" };
}

export function clipDef(m: SpriteManifest, key: ClipKey): ClipDef | undefined {
  return m.clips[key];
}

export function clipDurationMs(clip: ClipDef): number {
  return (clip.frames / clip.fps) * 1000;
}

/** Source rectangle (inside the layer's atlas image) of one frame of one clip. */
export function cellRect(m: SpriteManifest, layer: LayerDef, clip: ClipDef, frame: number, dirIndex: number): Rect {
  const f = Math.min(Math.max(0, Math.floor(frame)), clip.frames - 1);
  return {
    sx: layer.x + f * m.frame.w,
    sy: layer.y + (dirIndex * gridRows(m) + clip.row) * m.frame.h,
    sw: m.frame.w,
    sh: m.frame.h,
  };
}

/** Source rectangle of a looping layer's frame (auras): one row of frames. */
export function loopCellRect(m: SpriteManifest, layer: LayerDef, frame: number): Rect {
  const frames = layer.loop?.frames ?? 1;
  const f = ((Math.floor(frame) % frames) + frames) % frames;
  return { sx: layer.x + f * m.frame.w, sy: layer.y, sw: m.frame.w, sh: m.frame.h };
}
