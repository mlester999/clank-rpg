import { resolvePalette, spriteKey, type HeroPalette, type SpriteConfig } from "@/domain/sprites/config";
import { cellRect, clipDef, loopCellRect, resolveDirection } from "@/domain/sprites/geometry";
import { planLayers, type SpritePlan } from "@/domain/sprites/plan";
import type { ClipKey, Direction, SpriteManifest } from "@/domain/sprites/spec";

/**
 * Turns a hero's layer config into drawable strips.
 *
 *  · Source layers are grayscale/real-colour atlases; tinted layers are blended onto their palette
 *    colour with `hard-light` (mid-grey = the colour exactly, lighter/darker = highlight/shadow)
 *    and cut back to the layer's own alpha.
 *  · Layers are composited ONCE per (hero, clip) into a single strip, so drawing a hero in the
 *    arena is one drawImage per frame regardless of how many layers it wears.
 *  · Strips are built lazily the first time a clip is needed, and whole heroes sit in a small LRU.
 *
 * Nothing here touches the DOM directly: callers inject a canvas factory (browser, tests, the
 * Node preview script all use the same code).
 */

export type CanvasFactory = (w: number, h: number) => HTMLCanvasElement;

export interface SpriteSource {
  manifest: SpriteManifest;
  /** Decoded atlas images by manifest.images key. A missing key means that atlas failed to load. */
  images: Record<string, CanvasImageSource | undefined>;
  factory: CanvasFactory;
}

export class HeroSheet {
  readonly plan: SpritePlan;
  readonly palette: HeroPalette;
  private strips = new Map<string, HTMLCanvasElement>();
  private auraStrip: HTMLCanvasElement | null | undefined;

  constructor(
    private readonly src: SpriteSource,
    readonly config: SpriteConfig,
    colors: readonly [string, string, string],
    readonly rarity: string,
  ) {
    this.plan = planLayers(config, src.manifest);
    this.palette = resolvePalette(config, colors, rarity);
  }

  /** True when this set cannot draw the hero credibly (use the procedural vector hero instead). */
  get needsFallback(): boolean {
    return this.plan.fallback;
  }

  /** Composited strip for a clip in an authored direction block. */
  strip(clip: ClipKey, dirIndex = 0): HTMLCanvasElement | null {
    const m = this.src.manifest;
    const def = clipDef(m, clip);
    if (!def) return null;
    const key = `${clip}:${dirIndex}`;
    const hit = this.strips.get(key);
    if (hit) return hit;
    const w = def.frames * m.frame.w;
    const strip = this.src.factory(w, m.frame.h);
    const sctx = strip.getContext("2d");
    if (!sctx) return null;
    const scratch = this.src.factory(w, m.frame.h);
    for (const layer of this.plan.layers) {
      const img = this.src.images[layer.def.image];
      if (!img) continue;
      const r = cellRect(m, layer.def, def, 0, dirIndex);
      this.blit(sctx, scratch, img, r.sx, r.sy, w, m.frame.h, layer.tint);
    }
    this.strips.set(key, strip);
    return strip;
  }

  /** Looping aura strip (all frames in a row), tinted by rarity; null when the hero has none. */
  aura(): HTMLCanvasElement | null {
    if (this.auraStrip !== undefined) return this.auraStrip;
    const layer = this.plan.aura;
    const img = layer ? this.src.images[layer.def.image] : undefined;
    if (!layer || !layer.def.loop || !img) return (this.auraStrip = null);
    const m = this.src.manifest;
    const w = layer.def.loop.frames * m.frame.w;
    const strip = this.src.factory(w, m.frame.h);
    const sctx = strip.getContext("2d");
    if (!sctx) return (this.auraStrip = null);
    const r = loopCellRect(m, layer.def, 0);
    this.blit(sctx, this.src.factory(w, m.frame.h), img, r.sx, r.sy, w, m.frame.h, layer.tint);
    return (this.auraStrip = strip);
  }

  private blit(dst: CanvasRenderingContext2D, scratch: HTMLCanvasElement, img: CanvasImageSource, sx: number, sy: number, w: number, h: number, tint: string | null): void {
    if (tint === null || tint === undefined) {
      dst.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      return;
    }
    const color = this.palette[tint as keyof HeroPalette];
    const s = scratch.getContext("2d");
    if (!s || !color) {
      dst.drawImage(img, sx, sy, w, h, 0, 0, w, h);
      return;
    }
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, w, h);
    s.fillStyle = color;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = "hard-light";
    s.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    s.globalCompositeOperation = "destination-in";
    s.drawImage(img, sx, sy, w, h, 0, 0, w, h);
    s.globalCompositeOperation = "source-over";
    dst.drawImage(scratch, 0, 0);
  }
}

// ---------------------------------------------------------------------------------------
// LRU of composed heroes
// ---------------------------------------------------------------------------------------

const MAX_HEROES = 48;
const caches = new WeakMap<SpriteSource, Map<string, HeroSheet>>();

/** Cached composed hero for (config, class colours, rarity). Identical visuals share one sheet. */
export function getHeroSheet(src: SpriteSource, config: SpriteConfig, colors: readonly [string, string, string], rarity: string): HeroSheet {
  let cache = caches.get(src);
  if (!cache) caches.set(src, (cache = new Map()));
  const key = spriteKey(config, colors, rarity);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // refresh recency
    return hit;
  }
  const sheet = new HeroSheet(src, config, colors, rarity);
  cache.set(key, sheet);
  if (cache.size > MAX_HEROES) cache.delete(cache.keys().next().value as string);
  return sheet;
}

export function directionBlock(src: SpriteSource, dir: Direction): { index: number; mirror: boolean } {
  return resolveDirection(src.manifest, dir);
}
