import { resolvePalette, spriteKey, type HeroPalette, type SpriteConfig } from "@/domain/sprites/config";
import { cellRect, clipDef, loopCellRect, packedRow, resolveDirection } from "@/domain/sprites/geometry";
import { planImages, planLayers, type SpritePlan } from "@/domain/sprites/plan";
import type { ClipKey, Direction, PackedCell, SpriteManifest } from "@/domain/sprites/spec";
import type { ProceduralHero, ProceduralSet } from "@/domain/sprites/v3/set";

/**
 * Turns a hero's layer config into drawable strips.
 *
 *  · Source layers are grayscale/real-colour atlases; tinted layers are blended onto their palette
 *    colour with `hard-light` (mid-grey = the colour exactly, lighter/darker = highlight/shadow)
 *    and cut back to the layer's own alpha.
 *  · Layers are composited ONCE per (hero, clip) into a single strip, so drawing a hero in the
 *    arena is one drawImage per frame regardless of how many layers it wears.
 *  · Strips are built lazily the first time a clip is needed, and whole heroes sit in a small LRU. A procedural set (v3) goes further: a
 *    strip is filled one frame at a time, the first time that frame is drawn or warmed.
 *
 * Nothing here touches the DOM directly: callers inject a canvas factory (browser, tests, the
 * Node preview script all use the same code).
 */

export type CanvasFactory = (w: number, h: number) => HTMLCanvasElement;

/**
 * Generation cost of procedural strips (hero renderer v3): how many clip strips were started, how many frames this page generated, the total time
 * and the longest single frame. Read by QA tooling (`globalThis.__clankSpriteStats` in a browser); costs a few additions per frame.
 */
export const spriteStats = { strips: 0, frames: 0, ms: 0, maxFrameMs: 0 };
/** What generating one procedural frame costs on THIS device (a running average, ms) — warming plans with it instead of guessing. */
let frameCost = 1.5;
if (typeof globalThis !== "undefined") (globalThis as unknown as { __clankSpriteStats?: typeof spriteStats }).__clankSpriteStats = spriteStats;

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
  /**
   * A PROCEDURAL set (hero renderer v3): no atlases — each hero's strips are generated from its own look the first time a clip is needed, then
   * cached like a composed strip. `images` stays empty.
   */
  procedural?: ProceduralSet;
}

/** A procedural clip strip and which of its frames have been generated. */
interface LazyStrip {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  ready: boolean[];
  /** Frames still to generate. */
  left: number;
}

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** One frame-sized ImageData shared by every procedural strip (a frame is copied through it into its strip, then it is free again). */
let frameScratch: ImageData | null = null;
function scratchFor(ctx: CanvasRenderingContext2D, w: number, h: number): ImageData {
  if (!frameScratch || frameScratch.width !== w || frameScratch.height !== h) frameScratch = ctx.createImageData(w, h);
  return frameScratch;
}

export class HeroSheet {
  readonly plan: SpritePlan;
  readonly palette: HeroPalette;
  private strips = new Map<string, HTMLCanvasElement>();
  /** Procedural strips, filled ONE FRAME AT A TIME (a frame is generated the first time it is drawn or warmed). */
  private lazy = new Map<string, LazyStrip>();
  private auraStrip: HTMLCanvasElement | null | undefined;

  /** The generated hero (procedural sets only). */
  private readonly proc: ProceduralHero | null;

  constructor(
    private readonly src: SpriteSource,
    readonly config: SpriteConfig,
    colors: readonly [string, string, string],
    readonly rarity: string,
  ) {
    this.palette = resolvePalette(config, colors, rarity, { tones: src.manifest.paletteTones === true });
    if (src.procedural) {
      const p = src.procedural.hero(config, colors, rarity);
      this.proc = p;
      const aura = p.aura ? { id: p.aura.id, slot: "aura" as const, tint: null, def: { z: -5, loop: { frames: p.aura.frames, fps: p.aura.fps } } } : null;
      this.plan = {
        layers: [], aura, missing: [], fallback: false, attackClip: p.attackClip, rig: p.rig, idleClip: p.idleClip,
        get muzzle() {
          return p.muzzle; // measured on first use (a shot), not when the hero appears
        },
      };
      this.images = [];
      return;
    }
    this.proc = null;
    this.plan = planLayers(config, src.manifest, rarity);
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

  /** Has the strip of this clip (and direction block) been composed yet — every frame of it? (The arena warms a hero's clips before the fight.) */
  isComposed(clip: ClipKey, dirIndex = 0): boolean {
    const key = `${clip}:${dirIndex}`;
    if (this.proc) return (this.lazy.get(key)?.left ?? -1) === 0;
    return this.strips.has(key);
  }

  /**
   * Composes ahead of need, within a time budget (`until`, a performance.now() deadline): a procedural clip is generated frame by frame while the
   * next frame is expected to fit before the deadline (this device's measured cost per frame) — `force` makes the first frame go ahead anyway;
   * a composed set's strip is built whole. Returns true when there is time left for more.
   */
  warm(clip: ClipKey, until: number, force = false): boolean {
    if (!this.proc) {
      this.strip(clip);
      return false; // one composed strip per call, as before
    }
    const def = clipDef(this.src.manifest, clip);
    if (!def) return true;
    const ls = this.lazyStrip(`${clip}:0`, def.frames);
    if (!ls) return true;
    for (let f = 0; f < def.frames; f++) {
      if (ls.ready[f]) continue;
      if (!force && now() + frameCost > until) return false;
      force = false;
      this.generateFrame(ls, clip, f);
    }
    return now() + frameCost <= until;
  }

  /**
   * Composited strip for a clip in an authored direction block. A procedural set generates only the frame asked for (`frame`) — or, without one,
   * every frame of the clip — and the rest of the strip stays empty until they are needed.
   */
  strip(clip: ClipKey, dirIndex = 0, frame?: number): HTMLCanvasElement | null {
    const m = this.src.manifest;
    const def = clipDef(m, clip);
    if (!def) return null;
    const key = `${clip}:${dirIndex}`;
    if (this.proc) {
      const ls = this.lazyStrip(key, def.frames);
      if (!ls) return null;
      if (ls.left > 0) {
        if (frame === undefined) for (let f = 0; f < def.frames; f++) this.generateFrame(ls, clip, f);
        else this.generateFrame(ls, clip, Math.max(0, Math.min(def.frames - 1, frame)));
      }
      return ls.canvas;
    }
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

  /** A procedural clip's strip (frames laid out left → right, the outline part of the generated art), allocated empty on first use. */
  private lazyStrip(key: string, frames: number): LazyStrip | null {
    const hit = this.lazy.get(key);
    if (hit) return hit;
    const m = this.src.manifest;
    const canvas = this.src.factory(frames * m.frame.w, m.frame.h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const ls: LazyStrip = { canvas, ctx, ready: new Array<boolean>(frames).fill(false), left: frames };
    this.lazy.set(key, ls);
    spriteStats.strips++;
    return ls;
  }

  /** Generates one frame of a procedural clip into its strip (≈ 1 ms on a desktop; a slow phone pays it a frame at a time, never a clip at once). */
  private generateFrame(ls: LazyStrip, clip: ClipKey, f: number): void {
    if (ls.ready[f]) return;
    const t0 = now();
    const m = this.src.manifest;
    const rgba = (this.proc as ProceduralHero).frame(clip, f);
    if (f === 0 && clip === this.plan.idleClip && this.top === undefined) {
      for (let i = 3; i < rgba.length; i += 4) {
        if ((rgba[i] as number) > 24) {
          this.top = Math.floor((i >> 2) / m.frame.w);
          break;
        }
      }
    }
    const img = scratchFor(ls.ctx, m.frame.w, m.frame.h);
    img.data.set(rgba);
    ls.ctx.putImageData(img, f * m.frame.w, 0);
    ls.ready[f] = true;
    ls.left--;
    const ms = now() - t0;
    frameCost = frameCost * 0.85 + Math.min(ms, 50) * 0.15;
    spriteStats.frames++;
    spriteStats.ms += ms;
    if (ms > spriteStats.maxFrameMs) spriteStats.maxFrameMs = ms;
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
  silhouette(clip: ClipKey, dirIndex = 0, color = "#ffffff", frame?: number): HTMLCanvasElement | null {
    const key = `${clip}:${dirIndex}:${color}`;
    if (this.proc && frame !== undefined) return this.lazySilhouette(key, clip, dirIndex, color, frame);
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

  private lazySilhouettes = new Map<string, { canvas: HTMLCanvasElement; ready: boolean[] }>();
  /** A procedural clip's silhouette, made frame by frame like its strip (only the frames a flash or a tint actually covers). */
  private lazySilhouette(key: string, clip: ClipKey, dirIndex: number, color: string, frame: number): HTMLCanvasElement | null {
    const strip = this.strip(clip, dirIndex, frame);
    if (!strip) return null;
    const w = this.src.manifest.frame.w;
    let sil = this.lazySilhouettes.get(key);
    if (!sil) this.lazySilhouettes.set(key, (sil = { canvas: this.src.factory(strip.width, strip.height), ready: [] }));
    if (!sil.ready[frame]) {
      const o = sil.canvas.getContext("2d");
      if (!o) return null;
      const x = frame * w;
      o.save();
      o.beginPath();
      o.rect(x, 0, w, strip.height);
      o.clip();
      o.drawImage(strip, x, 0, w, strip.height, x, 0, w, strip.height);
      o.globalCompositeOperation = "source-in";
      o.fillStyle = color;
      o.fillRect(x, 0, w, strip.height);
      o.restore();
      sil.ready[frame] = true;
    }
    return sil.canvas;
  }

  private top: number | undefined;
  /**
   * The highest opaque row of this hero standing idle (frame px from the top of the frame) — a tall hat or a crest included. The arena hangs the
   * name plate just above it, so a plate never covers a hero's silhouette. Measured once per hero.
   */
  topPx(): number {
    if (this.top !== undefined) return this.top;
    const m = this.src.manifest;
    if (this.proc) {
      // measured on the hero's first idle frame as it is generated (generateFrame), from its own pixels — no canvas read-back
      this.strip(this.plan.idleClip, 0, 0);
      return (this.top ??= m.anchor.y - m.nominalHeightPx * 1.2);
    }
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
    if (this.proc) {
      // a procedural hero's aura: its particle frames, generated once
      const a = this.proc.aura;
      if (!a) return (this.auraStrip = null);
      const m = this.src.manifest;
      const strip = this.src.factory(a.frames * m.frame.w, m.frame.h);
      const sctx = strip.getContext("2d");
      if (!sctx) return (this.auraStrip = null);
      const img = sctx.createImageData(m.frame.w, m.frame.h);
      a.render().forEach((rgba, f) => {
        img.data.set(rgba);
        sctx.putImageData(img, f * m.frame.w, 0);
      });
      return (this.auraStrip = strip);
    }
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
