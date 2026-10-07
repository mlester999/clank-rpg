import { selectPlayback, type AnimInput, type Playback } from "@/domain/sprites/animator";
import type { Direction } from "@/domain/sprites/spec";

import { directionBlock, type HeroSheet, type SpriteSource } from "./compositor";

/** Reused scratch canvases for flash/chill overlays (one per source, frame-sized). */
const scratch = new WeakMap<SpriteSource, HTMLCanvasElement>();
function scratchFor(src: SpriteSource): HTMLCanvasElement {
  let c = scratch.get(src);
  if (!c) scratch.set(src, (c = src.factory(src.manifest.frame.w, src.manifest.frame.h)));
  return c;
}

export interface SpriteDraw {
  /** What the hero is doing (from selectPlayback). */
  playback: Playback;
  direction: Direction;
  /** 0..1 white damage flash. */
  flash?: number;
  /** Slowed/chilled tint. */
  chill?: boolean;
  /** 0..1 overall opacity multiplier (fade-out after KO). */
  alpha?: number;
  /** Pin the looping aura to this frame (a still render — a card image — must be byte-for-byte reproducible). Default: follow the clock. */
  auraFrame?: number;
}

/** Chooses the playback for a hero. Thin wrapper so the renderer imports from one place. */
export function playbackFor(sheet: HeroSheet, src: SpriteSource, input: AnimInput): Playback {
  return selectPlayback(input, src.manifest, sheet.plan.attackClip);
}

/**
 * Draws one hero frame with its FEET at the current transform origin, scaled so the sprite's
 * nominal hero height equals `heightUnits` in the current coordinate system. Pixel-art sets are drawn
 * without smoothing (crisp edges); sets that declare `pixelArt: false` are smoothed.
 */
export function drawHeroSprite(ctx: CanvasRenderingContext2D, src: SpriteSource, sheet: HeroSheet, d: SpriteDraw, heightUnits: number): boolean {
  const m = src.manifest;
  const dir = directionBlock(src, d.direction);
  const strip = sheet.strip(d.playback.clip, dir.index);
  if (!strip) return false;
  const k = heightUnits / m.nominalHeightPx;
  const sx = d.playback.frame * m.frame.w;
  ctx.save();
  ctx.imageSmoothingEnabled = m.pixelArt === false;
  ctx.imageSmoothingQuality = "high";
  if (d.alpha !== undefined) ctx.globalAlpha *= d.alpha;
  ctx.scale(dir.mirror ? -k : k, k);
  const dx = -m.anchor.x;
  const dy = -m.anchor.y;

  const aura = sheet.aura();
  if (aura && sheet.plan.aura?.def.loop) {
    const loop = sheet.plan.aura.def.loop;
    const f = d.auraFrame !== undefined ? ((d.auraFrame % loop.frames) + loop.frames) % loop.frames : Math.floor((performance.now() / 1000) * loop.fps) % loop.frames;
    ctx.drawImage(aura, f * m.frame.w, 0, m.frame.w, m.frame.h, dx, dy, m.frame.w, m.frame.h);
  }

  if ((d.flash ?? 0) > 0.01 || d.chill) {
    const s = scratchFor(src);
    const sctx = s.getContext("2d");
    if (sctx) {
      sctx.globalCompositeOperation = "source-over";
      sctx.clearRect(0, 0, m.frame.w, m.frame.h);
      sctx.drawImage(strip, sx, 0, m.frame.w, m.frame.h, 0, 0, m.frame.w, m.frame.h);
      sctx.globalCompositeOperation = "source-atop";
      if (d.chill) {
        sctx.fillStyle = "rgba(143,227,255,0.3)";
        sctx.fillRect(0, 0, m.frame.w, m.frame.h);
      }
      if ((d.flash ?? 0) > 0.01) {
        sctx.fillStyle = `rgba(255,255,255,${Math.min(0.85, (d.flash ?? 0) * 0.85)})`;
        sctx.fillRect(0, 0, m.frame.w, m.frame.h);
      }
      sctx.globalCompositeOperation = "source-over";
      ctx.drawImage(s, 0, 0, m.frame.w, m.frame.h, dx, dy, m.frame.w, m.frame.h);
    }
  } else {
    ctx.drawImage(strip, sx, 0, m.frame.w, m.frame.h, dx, dy, m.frame.w, m.frame.h);
  }
  ctx.restore();
  return true;
}
