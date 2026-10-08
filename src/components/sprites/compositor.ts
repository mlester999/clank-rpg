import { resolvePalette, spriteKey, type HeroPalette, type SpriteConfig } from "@/domain/sprites/config";
import { cellRect, clipDef, loopCellRect, packedRow, resolveDirection } from "@/domain/sprites/geometry";
import { planImages, planLayers, type SpritePlan } from "@/domain/sprites/plan";
import type { ClipKey, Direction, PackedCell, SpriteManifest } from "@/domain/sprites/spec";

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

/** Where the atlases a hero needs are: all arrived, some still on the way, or one that could not be loaded for good. */
export type AtlasStatus = "ready" | "loading" | "failed";

export interface SpriteSource {
  manifest: SpriteManifest;
  /** Decoded atlas images by manifest.images key. A missing key means that atlas failed to load (or, in a lazy set, has not arrived yet). */
  images: Record<string, CanvasImageSource | undefined>;
  factory: CanvasFactory;
  /**
   * LAZY sets (a packed set keeps one atlas page per skeleton, and a hero needs only its own): asks for the atlases a hero draws from, starting
   * any that are not loading yet. Absent: every atlas is already loaded (a missing key = failed, its layers are skipped).
   */
  ensure?: (keys: readonly string[]) => AtlasStatus;
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
    this.plan = planLayers(config, src.manifest, rarity);
    this.palette = resolvePalette(config, colors, rarity, { tones: src.manifest.paletteTones === true });
    this.images = planImages(this.plan);
  }

  /** The atlases this hero is drawn from (its skeleton's pages and its aura). */
  readonly images: readonly string[];

  /** Have this hero's atlases arrived? (Always "ready" for a set that loads everything up front.) */
  atlasStatus(): AtlasStatus {
    return this.src.ensure ? this.src.ensure(this.images) : "ready";
  }

  /** Its atlases are still on their way (draw nothing yet — not the vector fallback, which would flash in for a moment). */
  get pending(): boolean {
    return this.atlasStatus() === "loading";
  }

  /** True when this set cannot draw the hero credibly (use the procedural vector hero instead) — or its own atlas page could not be loaded. */
  get needsFallback(): boolean {
    return this.plan.fallback || this.atlasStatus() === "failed";
  }

  /** Has the strip of this clip (and direction block) been composed yet? (The arena warms a hero's clips before the fight.) */
  isComposed(clip: ClipKey, dirIndex = 0): boolean {
    return this.strips.has(`${clip}:${dirIndex}`);
  }

  /** Composited strip for a clip in an authored direction block. */
  strip(clip: ClipKey, dirIndex = 0): HTMLCanvasElement | null {
    const m = this.src.manifest;
    const def = clipDef(m, clip);
    if (!def) return null;
    const key = `${clip}:${dirIndex}`;
    const hit = this.strips.get(key);
    if (hit) return hit;
    // a lazy set composes a hero only once its pages are here (a strip composed without them would be cached incomplete)
    if (this.atlasStatus() !== "ready") return null;
    const w = def.frames * m.frame.w;
    const strip = this.src.factory(w, m.frame.h);
    const sctx = strip.getContext("2d");
    if (!sctx) return null;
    let scratch: HTMLCanvasElement | null = null;
    let cellScratch: HTMLCanvasElement | null = null;
    for (const layer of this.plan.layers) {
      if (layer.def.cells) {
        // packed: the clip's row on this hero's skeleton, one trimmed cell per frame placed back into its frame
        const row = packedRow(layer.def, this.plan.rig, def);
        const img = row ? this.src.images[row.image] : undefined;
        if (!row || !img) continue;
        const color = layer.tint === null ? null : this.palette[layer.tint as keyof HeroPalette];
        // a tinted cell is coloured on a FRAME-sized scratch canvas (the composite passes only ever touch one frame's worth of pixels, not the
        // whole strip — the mask pass is unbounded), then copied into its frame
        if (color) cellScratch ??= this.src.factory(m.frame.w, m.frame.h);
        const c = cellScratch?.getContext("2d") ?? null;
        for (let f = 0; f < def.frames && f < row.cells.length; f++) {
          const [x, y, cw, ch, ox, oy] = row.cells[f] as PackedCell;
          if (cw <= 0 || ch <= 0) continue;
          if (!color || !c) {
            sctx.drawImage(img, x, y, cw, ch, f * m.frame.w + ox, oy, cw, ch);
            continue;
          }
          c.globalCompositeOperation = "source-over";
          c.clearRect(0, 0, cw, ch);
          c.fillStyle = color;
          c.fillRect(0, 0, cw, ch);
          c.globalCompositeOperation = "hard-light";
          c.drawImage(img, x, y, cw, ch, 0, 0, cw, ch);
          c.globalCompositeOperation = "destination-in";
          c.drawImage(img, x, y, cw, ch, 0, 0, cw, ch);
          c.globalCompositeOperation = "source-over";
          sctx.drawImage(cellScratch as HTMLCanvasElement, 0, 0, cw, ch, f * m.frame.w + ox, oy, cw, ch);
        }
        continue;
      }
      scratch ??= this.src.factory(w, m.frame.h);
      const img = layer.def.image !== undefined ? this.src.images[layer.def.image] : undefined;
      if (!img) continue;
      const r = cellRect(m, layer.def, def, 0, dirIndex);
      const sc = scratch;
      this.blit(sctx, sc, w, m.frame.h, layer.tint, (c) => c.drawImage(img, r.sx, r.sy, w, m.frame.h, 0, 0, w, m.frame.h));
    }
    const out = m.outline ? this.outlined(strip, w, m.frame.h, m.outline) : strip;
    this.strips.set(key, out);
    return out;
  }

  /**
   * One 1 px outline around the composed silhouette: the figure dilated by one pixel (4-neighbourhood), filled with the outline colour, with the
   * figure drawn back on top. Done once per (hero, clip) — never per frame. Frames never touch their cell border (a validated rule), so the
   * dilation never bleeds into the neighbouring frame.
   */
  private outlined(strip: HTMLCanvasElement, w: number, h: number, color: string): HTMLCanvasElement {
    const out = this.src.factory(w, h);
    const o = out.getContext("2d");
    if (!o) return strip;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) o.drawImage(strip, dx, dy);
    o.globalCompositeOperation = "source-in";
    o.fillStyle = color;
    o.fillRect(0, 0, w, h);
    o.globalCompositeOperation = "source-over";
    o.drawImage(strip, 0, 0);
    return out;
  }

  private silhouettes = new Map<string, HTMLCanvasElement>();
  /**
   * The hero's composed strip as a flat silhouette in one colour (same frames, same alpha) — built once per (clip, direction, colour), cached. Status and
   * hit overlays draw it at low alpha over the hero (a flash, a cool tint, a shimmer band) instead of compositing a scratch canvas every frame:
   * a reused scratch canvas could be cleared before the browser had rasterised the previous draw from it, which left heroes see-through.
   */
  silhouette(clip: ClipKey, dirIndex = 0, color = "#ffffff"): HTMLCanvasElement | null {
    const key = `${clip}:${dirIndex}:${color}`;
    const hit = this.silhouettes.get(key);
    if (hit) return hit;
    const strip = this.strip(clip, dirIndex);
    if (!strip) return null;
    const out = this.src.factory(strip.width, strip.height);
    const o = out.getContext("2d");
    if (!o) return null;
    o.drawImage(strip, 0, 0);
    o.globalCompositeOperation = "source-in";
    o.fillStyle = color;
    o.fillRect(0, 0, strip.width, strip.height);
    o.globalCompositeOperation = "source-over";
    this.silhouettes.set(key, out);
    return out;
  }

  private top: number | undefined;
  /**
   * The highest opaque row of this hero standing idle (frame px from the top of the frame) — a tall hat or a crest included. The arena hangs the
   * name plate just above it, so a plate never covers a hero's silhouette. Measured once per hero.
   */
  topPx(): number {
    if (this.top !== undefined) return this.top;
    const m = this.src.manifest;
    const strip = this.strip(this.plan.idleClip);
    if (!strip) return m.anchor.y - m.nominalHeightPx * 1.2; // not composed yet (its atlases are loading): measured once they arrive
    let top = -1;
    try {
      const d = strip?.getContext("2d")?.getImageData(0, 0, strip.width, strip.height).data;
      if (strip && d) {
        for (let y = 0; y < strip.height && top < 0; y++) {
          for (let x = 0; x < strip.width; x++) {
            if ((d[(y * strip.width + x) * 4 + 3] as number) > 24) {
              top = y;
              break;
            }
          }
        }
      }
    } catch {
      top = -1; // unreadable: use the nominal height
    }
    return (this.top = top >= 0 ? top : m.anchor.y - m.nominalHeightPx * 1.2);
  }

  /** Looping aura strip (all frames in a row), tinted by rarity; null when the hero has none. */
  aura(): HTMLCanvasElement | null {
    if (this.auraStrip !== undefined) return this.auraStrip;
    if (this.atlasStatus() === "loading") return null; // not cached: drawn once its page arrives
    const layer = this.plan.aura;
    const img = layer && layer.def.image !== undefined ? this.src.images[layer.def.image] : undefined;
    if (!layer || !layer.def.loop || !img) return (this.auraStrip = null);
    const m = this.src.manifest;
    const w = layer.def.loop.frames * m.frame.w;
    const strip = this.src.factory(w, m.frame.h);
    const sctx = strip.getContext("2d");
    if (!sctx) return (this.auraStrip = null);
    const r = loopCellRect(m, layer.def, 0);
    this.blit(sctx, this.src.factory(w, m.frame.h), w, m.frame.h, layer.tint, (c) => c.drawImage(img, r.sx, r.sy, w, m.frame.h, 0, 0, w, m.frame.h));
    return (this.auraStrip = strip);
  }

  /**
   * Draws one layer's pixels (`paint` puts them at their place in a `w × h` strip) onto `dst`: as authored, or — for a tinted layer — blended onto
   * its palette colour with hard-light (mid-grey = the colour exactly) and cut back to the layer's own alpha.
   */
  private blit(dst: CanvasRenderingContext2D, scratch: HTMLCanvasElement, w: number, h: number, tint: string | null, paint: (c: CanvasRenderingContext2D) => void): void {
    if (tint === null || tint === undefined) {
      paint(dst);
      return;
    }
    const color = this.palette[tint as keyof HeroPalette];
    const s = scratch.getContext("2d");
    if (!s || !color) {
      paint(dst);
      return;
    }
    s.globalCompositeOperation = "source-over";
    s.clearRect(0, 0, w, h);
    s.fillStyle = color;
    s.fillRect(0, 0, w, h);
    s.globalCompositeOperation = "hard-light";
    paint(s);
    s.globalCompositeOperation = "destination-in";
    paint(s);
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
