import { selectPlayback, type AnimInput, type Playback } from "@/domain/sprites/animator";
import type { Direction } from "@/domain/sprites/spec";

import { directionBlock, type HeroSheet, type SpriteSource } from "./compositor";

export interface SpriteDraw {
  /** What the hero is doing (from selectPlayback). */
  playback: Playback;
  direction: Direction;
  /** 0..1 white damage flash. */
  flash?: number;
  /** Slowed/chilled tint. */
  chill?: boolean;
  /**
   * Shielded: 0..1 strength of a cool wash and a light band that sweeps across the hero's OWN silhouette — the shield reads on the hero, never as
   * a bubble or a ring around it. `shieldPhase` (0..1) places the band; the caller animates it (or pins it under reduced motion).
   */
  shield?: number;
  shieldPhase?: number;
  /** 0..1 overall opacity multiplier (fade-out after KO). */
  alpha?: number;
  /** Pin the looping aura to this frame (a still render — a card image — must be byte-for-byte reproducible). Default: follow the clock. */
  auraFrame?: number;
}

/**
 * Pixel-perfect placement for pixel art: when a sprite pixel would land on a NEARLY whole number of device pixels (within 12 % — e.g. 1.96 on a
 * desktop stage), the scale snaps to that whole number and the hero's feet to the device-pixel grid, so every sprite pixel is an exact square
 * (no uneven 1-px / 2-px columns from nearest-neighbour scaling). Farther from a whole number the size is kept (heroes never jump in size).
 * Only the drawn size of the art changes, by at most 12 %; nothing about positions or combat.
 */
export function snapPixelScale(ctx: CanvasRenderingContext2D, k: number): number {
  if (typeof ctx.getTransform !== "function") return k;
  const t = ctx.getTransform();
  const dev = Math.hypot(t.a, t.b) * k;
  const near = Math.round(dev);
  if (near < 1 || Math.abs(t.b) > 1e-6 || Math.abs(t.c) > 1e-6 || Math.abs(dev - near) / near > 0.12) return k;
  ctx.setTransform(t.a, t.b, t.c, t.d, Math.round(t.e), Math.round(t.f));
  return k * (near / dev);
}

/** Chooses the playback for a hero. Thin wrapper so the renderer imports from one place. */
export function playbackFor(sheet: HeroSheet, src: SpriteSource, input: AnimInput): Playback {
  return selectPlayback(input, src.manifest, sheet.plan.attackClip, sheet.plan.idleClip);
}

/**
 * Draws one hero frame with its FEET at the current transform origin, scaled so the sprite's
 * nominal hero height equals `heightUnits` in the current coordinate system. Pixel-art sets are drawn
 * without smoothing (crisp edges); sets that declare `pixelArt: false` are smoothed.
 */
export function drawHeroSprite(ctx: CanvasRenderingContext2D, src: SpriteSource, sheet: HeroSheet, d: SpriteDraw, heightUnits: number): boolean {
  const m = src.manifest;
  const dir = directionBlock(src, d.direction);
  const strip = sheet.strip(d.playback.clip, dir.index, d.playback.frame);
  if (!strip) return false;
  let k = heightUnits / m.nominalHeightPx;
  const sx = d.playback.frame * m.frame.w;
  ctx.save();
  ctx.imageSmoothingEnabled = m.pixelArt === false;
  ctx.imageSmoothingQuality = "high";
  if (d.alpha !== undefined) ctx.globalAlpha *= d.alpha;
  if (m.pixelArt !== false) k = snapPixelScale(ctx, k);
  ctx.scale(dir.mirror ? -k : k, k);
  const dx = -m.anchor.x;
  const dy = -m.anchor.y;

  const aura = sheet.aura();
  if (aura && sheet.plan.aura?.def.loop) {
    const loop = sheet.plan.aura.def.loop;
    const f = d.auraFrame !== undefined ? ((d.auraFrame % loop.frames) + loop.frames) % loop.frames : Math.floor((performance.now() / 1000) * loop.fps) % loop.frames;
    ctx.drawImage(aura, f * m.frame.w, 0, m.frame.w, m.frame.h, dx, dy, m.frame.w, m.frame.h);
  }

  ctx.drawImage(strip, sx, 0, m.frame.w, m.frame.h, dx, dy, m.frame.w, m.frame.h);

  // Overlays: the hero's cached white silhouette, drawn at low alpha OVER it — never a per-frame scratch composite (see HeroSheet.silhouette).
  // Tints stay light: the hero must still read as itself (its class colours, its rarity gear) under any status.
  const shield = d.shield ?? 0;
  const flash = d.flash ?? 0;
  if (flash > 0.01 || d.chill || shield > 0.01) {
    const white = sheet.silhouette(d.playback.clip, dir.index, "#ffffff", d.playback.frame);
    const cool = d.chill || shield > 0.01 ? sheet.silhouette(d.playback.clip, dir.index, "#8fe3ff", d.playback.frame) : null;
    if (white) {
      const base = ctx.globalAlpha;
      const over = (sil: HTMLCanvasElement | null, alpha: number, x = 0, w = m.frame.w) => {
        if (!sil || alpha <= 0.005 || w <= 0) return;
        ctx.globalAlpha = base * Math.min(1, alpha);
        ctx.drawImage(sil, sx + x, 0, w, m.frame.h, dx + x, dy, w, m.frame.h);
      };
      if (d.chill) over(cool, 0.16); // a cool cast for a slow (the frost at the feet says the rest)
      if (shield > 0.01) {
        over(cool, 0.1 * shield);
        // a thin band of light (≈ 6 px) sweeping across the figure, from behind the hero to in front of it
        const bandX = Math.round((-0.2 + 1.4 * (d.shieldPhase ?? 0.5)) * m.frame.w);
        const x0 = Math.max(0, bandX - 3);
        const x1 = Math.min(m.frame.w, bandX + 3);
        over(white, 0.42 * shield, x0, x1 - x0);
      }
      if (flash > 0.01) over(white, Math.min(0.7, flash * 0.7));
      ctx.globalAlpha = base;
    }
  }
  ctx.restore();
  return true;
}
