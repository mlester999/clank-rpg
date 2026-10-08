import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { GlobalFonts, createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";

import { drawHero, IDLE_POSE, type HeroLook } from "@/components/hero/drawHero";
import { getHeroSheet, type CanvasFactory, type SpriteSource } from "@/components/sprites/compositor";
import { drawHeroSprite, playbackFor } from "@/components/sprites/draw";
import { drawRarityAura, drawRarityGround, drawRarityMark, drawRarityParticles } from "@/components/arena/rarityFx";
import { CARD_NAME_MAX, CARD_STATS, CLANK_PURPLE, cardText, formatPower, type HeroCardModel } from "@/domain/hero/card";
import { HERO_CARD_BACKGROUND_DIR, heroArenaLayout, heroCardBackgroundFile } from "@/domain/hero/cardBackground";
import { rarityVisual, type RarityVisual } from "@/domain/hero/rarityVisuals";
import { parseManifest } from "@/domain/sprites/spec";
import { mix } from "@/domain/util/color";

/**
 * The downloadable / shareable hero card as a 1200 × 1200 PNG.
 *
 * It is drawn from the canonical, public-safe HeroCardModel ONLY — never from a database row — with trusted project assets: the arena's own
 * sprite set read from this project's `public/sprites/<set>` (through the same compositor the browser uses) and a bundled font. Text is
 * painted with canvas calls, never as markup, so a hero name can inject nothing; and nothing is fetched from anywhere else.
 * It is deterministic: the same card always produces the same bytes (the looping aura is pinned to a frame, and the rarity particles to a fixed instant).
 *
 * RARITY: the card is dressed from the shared RARITY_VISUALS table (the same one the web card, the portraits and the Arena read) — the frame's layers
 * and corner ornaments, the glow, the badge icon — and the hero stands in the rarity's ARENA image: the very file the web card shows
 * (the file in `public/` that domain/hero/cardBackground.ts names for the rarity), fitted with "cover" and with the hero sized and placed by the
 * same `heroArenaLayout`. If that file cannot be read the neutral rarity backdrop is drawn instead. PWR is one of the biggest things on the card; the
 * rarity's PWR band is a game rule and is never printed on it.
 */
export const CARD_SIZE = 1200;

const FONT_FAMILY = "ClankCard";
let fontReady: boolean | undefined;

/** The bundled UI font (Geist, shipped inside Next.js for its own image generation). If it cannot be found, system fonts are used. */
function ensureFont(): void {
  if (fontReady !== undefined) return;
  fontReady = false;
  const candidates = [
    path.join(process.cwd(), "node_modules", "next", "dist", "compiled", "@vercel", "og", "Geist-Regular.ttf"),
    path.join(process.cwd(), "public", "fonts", "Geist-Regular.ttf"),
  ];
  for (const file of candidates) {
    try {
      if (GlobalFonts.registerFromPath(file, FONT_FAMILY)) {
        fontReady = true;
        return;
      }
    } catch {
      // try the next location
    }
  }
}

/** A server-side sprite set: the source the compositor reads, and `load` — the atlases a hero needs, read from disk on demand. */
interface ServerSprites {
  src: SpriteSource;
  load: (keys: readonly string[]) => Promise<void>;
}

const sources = new Map<string, Promise<ServerSprites | null>>();

/**
 * At most this many skeleton PAGES of a packed set stay decoded in one server process (least recently used first out): a card needs one
 * skeleton's page, and a long-lived process rendering every class must not hold all eighteen.
 */
const SERVER_PAGES = 6;

async function loadSpriteSource(setId: string): Promise<ServerSprites | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(setId)) return null; // a set id becomes a directory name: never anything else
  let hit = sources.get(setId);
  if (!hit) {
    hit = (async () => {
      try {
        const dir = path.join(process.cwd(), "public", "sprites", setId);
        const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
        const images: SpriteSource["images"] = {};
        const read = async (key: string) => (await loadImage(await readFile(path.join(dir, path.basename(manifest.images[key] as string))))) as unknown as CanvasImageSource;
        // a packed set (one page per skeleton) is read page by page as cards need them; a block-layout set all at once
        const lazy = (manifest.rigs?.length ?? 0) > 0;
        const eager = lazy ? [...new Set(Object.values(manifest.layers).flatMap((l) => (l.image !== undefined && !l.cells ? [l.image] : [])))] : Object.keys(manifest.images);
        for (const key of eager) images[key] = await read(key);
        const factory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement;
        const src: SpriteSource = { manifest, images, factory };
        const recent: string[] = [];
        const failed = new Set<string>();
        const load = async (keys: readonly string[]) => {
          for (const key of keys) {
            if (images[key]) {
              if (recent.includes(key)) recent.push(...recent.splice(recent.indexOf(key), 1));
              continue;
            }
            if (failed.has(key) || !manifest.images[key]) continue;
            try {
              images[key] = await read(key);
              recent.push(key);
              while (recent.length > SERVER_PAGES) delete images[recent.shift() as string];
            } catch {
              failed.add(key);
            }
          }
        };
        if (lazy) src.ensure = (keys) => (keys.some((k) => failed.has(k) || !manifest.images[k]) ? "failed" : keys.every((k) => images[k]) ? "ready" : "loading");
        return { src, load } satisfies ServerSprites;
      } catch (e) {
        console.warn(`[hero-card] sprite set ${setId} could not be loaded — drawing the vector hero instead:`, e instanceof Error ? e.message : e);
        return null;
      }
    })();
    sources.set(setId, hit);
  }
  return hit;
}

type ArenaImage = Awaited<ReturnType<typeof loadImage>>;
const arenaImages = new Map<string, Promise<ArenaImage | null>>();

/** The arena image of a rarity, read ONCE from this project's `public/` (the same file the browser is served), or null → the neutral backdrop. */
function loadArenaImage(rarity: unknown, dir: string): Promise<ArenaImage | null> {
  const file = heroCardBackgroundFile(rarity);
  if (!file) return Promise.resolve(null);
  const key = `${dir}\0${file}`;
  let hit = arenaImages.get(key);
  if (!hit) {
    hit = readFile(path.join(dir, file))
      .then((bytes) => loadImage(bytes))
      .catch((e: unknown) => {
        // not cached: a transient failure must not leave this instance on the neutral backdrop until it restarts
        arenaImages.delete(key);
        console.warn(`[hero-card] arena image ${file} could not be read — drawing the neutral backdrop instead:`, e instanceof Error ? e.message : e);
        return null;
      });
    arenaImages.set(key, hit);
  }
  return hit;
}

const defaultArenaDir = () => path.join(process.cwd(), "public", HERO_CARD_BACKGROUND_DIR.replace(/^\/+/, ""));

/** Test hook: forget loaded art / font state. */
export function resetCardImageState(): void {
  sources.clear();
  arenaImages.clear();
  fontReady = undefined;
}

// Characters the bundled font can draw: Basic Latin, Latin-1, Latin Extended-A/B, general punctuation and currency. Anything else (emoji, CJK, …) is
// dropped from the IMAGE only — the web page always shows the real name. A name with nothing drawable left reads "Clank Hero".
const DRAWABLE = /[^ -~ -ɏ‐-‧₠-₿]/gu;
export function imageName(name: string): string {
  const cleaned = cardText(name, CARD_NAME_MAX).replace(DRAWABLE, "").replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(cleaned) ? cleaned : "Clank Hero";
}

const font = (px: number, weight: "400" | "700" = "700") => `${weight} ${px}px "${FONT_FAMILY}", "Helvetica Neue", Arial, sans-serif`;

function fitText(ctx: SKRSContext2D, text: string, maxWidth: number, startPx: number, minPx: number, weight: "400" | "700" = "700"): { text: string; px: number } {
  let px = startPx;
  ctx.font = font(px, weight);
  while (ctx.measureText(text).width > maxWidth && px > minPx) {
    px -= 2;
    ctx.font = font(px, weight);
  }
  if (ctx.measureText(text).width <= maxWidth) return { text, px };
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}…`, px };
}

/** A rectangle with chamfered (cut) corners — the Clank RPG plate shape. */
function chamfer(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, c: number): void {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w - c, y);
  ctx.lineTo(x + w, y + c);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x + c, y + h);
  ctx.lineTo(x, y + h - c);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function diamond(ctx: SKRSContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

/** Letter-spaced text (canvas has no portable letterSpacing). */
function spaced(ctx: SKRSContext2D, text: string, x: number, y: number, spacing: number, align: "left" | "center" | "right" = "left"): void {
  const widths = Array.from(text).map((ch) => ctx.measureText(ch).width + spacing);
  const total = widths.reduce((a, b) => a + b, 0) - spacing;
  let cx = align === "left" ? x : align === "center" ? x - total / 2 : x - total;
  ctx.textAlign = "left";
  Array.from(text).forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] as number;
  });
}

/** The pinned instant the rarity particles are drawn at (the PNG is a still, and must be byte-stable). */
const STILL_NOW = 1_234;

/** The plate border as concentric layers (outermost first): richer with the tier. */
function frameLayers(v: RarityVisual): Array<{ inset: number; width: number; color: string }> {
  const c = v.colors;
  switch (v.frame.style) {
    case "plain": return [{ inset: 0, width: 8, color: mix(c.base, CLANK_PURPLE.ink, 0.3) }];
    case "bevel": return [{ inset: 0, width: 12, color: c.base }, { inset: 11, width: 3, color: c.light }];
    case "double": return [{ inset: 0, width: 12, color: c.base }, { inset: 15, width: 4, color: "#0b0818" }, { inset: 21, width: 4, color: c.dark }];
    case "ornate": return [{ inset: 0, width: 14, color: c.light }, { inset: 12, width: 8, color: c.base }, { inset: 23, width: 4, color: c.dark }, { inset: 31, width: 2, color: c.light }];
  }
}

/** Corner ornaments of the art panel — notch · gem · crown — and, for Legendary, a crown on the top edge of the plate. */
function drawCorners(ctx: SKRSContext2D, v: RarityVisual, art: { x: number; y: number; w: number; h: number }): void {
  const kind = v.frame.corners;
  if (kind === "none") return;
  const size = kind === "crown" ? 62 : kind === "gem" ? 50 : 38;
  const corners: Array<[number, number, number, number]> = [
    [art.x, art.y, 1, 1],
    [art.x + art.w, art.y, -1, 1],
    [art.x, art.y + art.h, 1, -1],
    [art.x + art.w, art.y + art.h, -1, -1],
  ];
  for (const [x, y, sx, sy] of corners) {
    ctx.fillStyle = v.colors.base;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + sx * size, y);
    ctx.lineTo(x, y + sy * size);
    ctx.closePath();
    ctx.fill();
    if (kind !== "notch") {
      ctx.fillStyle = v.colors.light;
      ctx.strokeStyle = v.colors.dark;
      ctx.lineWidth = 2;
      diamond(ctx, x + sx * size * 0.34, y + sy * size * 0.34, kind === "crown" ? 11 : 9);
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** The tier badge: the icon SHAPE (dot · diamond · star · crown) and the rarity's name, on a plate in the rarity colour. */
function drawBadge(ctx: SKRSContext2D, v: RarityVisual, right: number, y: number, h: number, labelPx: number): void {
  const label = v.label.toUpperCase();
  ctx.font = font(labelPx);
  const text = Array.from(label).reduce((a, ch) => a + ctx.measureText(ch).width + 5, 0) - 5;
  const iconR = h * 0.3;
  const pad = 22;
  const w = pad + iconR * 2 + 14 + text + pad;
  const x = right - w;
  if (v.tier === 0) {
    ctx.fillStyle = "rgba(154,164,178,0.16)";
    chamfer(ctx, x, y, w, h, 14);
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = v.colors.dark;
    chamfer(ctx, x, y, w, h, 14);
    ctx.stroke();
  } else {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, v.colors.light);
    g.addColorStop(0.65, v.colors.base);
    ctx.fillStyle = g;
    chamfer(ctx, x, y, w, h, 14);
    ctx.fill();
  }
  // the icon is dark ink on a solid badge, rarity-coloured on the quiet Common one
  drawRarityMark(ctx as unknown as CanvasRenderingContext2D, v.id, x + pad + iconR, y + h / 2, iconR, v.tier > 0 ? v.colors.ink : undefined);
  ctx.fillStyle = v.tier === 0 ? v.colors.light : v.colors.ink;
  ctx.font = font(labelPx);
  ctx.textBaseline = "alphabetic";
  spaced(ctx, label, x + pad + iconR * 2 + 14, y + h / 2 + labelPx * 0.35, 5, "left");
}

function drawArt(ctx: SKRSContext2D, model: HeroCardModel, src: SpriteSource | null, box: { x: number; y: number; w: number; h: number }, v: RarityVisual, arena: ArenaImage | null): void {
  // The hero is a small figure standing in the arena: its size and its feet come from the same layout the web card uses.
  const layout = heroArenaLayout({ w: box.w, h: box.h });
  const cx = box.x + layout.hero.feetX;
  const floor = box.y + layout.hero.feetY;
  const heroH = layout.hero.height;
  const k = heroH / 104; // the hero is ≈ 104 local units tall: the Arena's effect geometry scales with it

  if (arena) {
    // the arena image already carries the rarity (and its own ground): only a contact shadow, then the hero
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.beginPath();
    ctx.ellipse(cx, floor + 3, heroH * 0.34, heroH * 0.075, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    // neutral fallback: the ground rings and a floor shadow (the same effects the Arena draws under a hero of this rarity)
    ctx.save();
    ctx.translate(cx, floor);
    ctx.scale(k, k);
    drawRarityGround(ctx as unknown as CanvasRenderingContext2D, v.id, STILL_NOW, 0, 1, true);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.beginPath();
    ctx.ellipse(cx, floor + 4, 25 * k, 7 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  const look: HeroLook = { rarity: model.rarity, parts: model.look.parts, sprite: model.look.sprite, colors: model.look.colors, weapon: model.look.weapon, headgear: model.look.headgear, body: model.look.body };
  const sheet = src ? getHeroSheet(src, look.sprite, look.colors, look.rarity) : null;
  ctx.save();
  ctx.translate(cx, floor);
  ctx.save();
  ctx.scale(k, k);
  drawRarityAura(ctx as unknown as CanvasRenderingContext2D, v.id, STILL_NOW, 0, 1, true);
  ctx.restore();
  if (src && sheet && !sheet.needsFallback) {
    const playback = playbackFor(sheet, src, { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 });
    drawHeroSprite(ctx as unknown as CanvasRenderingContext2D, src, sheet, { playback: { ...playback, frame: 0 }, direction: "right", auraFrame: 0 }, heroH);
  } else {
    ctx.scale(k, k);
    drawHero(ctx as unknown as CanvasRenderingContext2D, look, { ...IDLE_POSE, t: 0.4 });
  }
  ctx.restore();
  if (!arena) {
    // sparks / embers, frozen at a pinned instant (Epic and Legendary) — the arena images carry their own
    ctx.save();
    ctx.translate(cx, floor);
    ctx.scale(k * 1.2, k * 1.2);
    drawRarityParticles(ctx as unknown as CanvasRenderingContext2D, v.id, STILL_NOW, 0, 1, false);
    ctx.restore();
  }
}

/** Renders a hero card. Never throws for a valid model: missing art falls back to the vector hero, a missing font to a system one. */
export async function renderHeroCardPng(model: HeroCardModel, opts: { spriteSet?: string; backgroundDir?: string } = {}): Promise<Buffer> {
  ensureFont();
  const sprites = await loadSpriteSource(opts.spriteSet ?? "clank-dev-v2");
  const arena = await loadArenaImage(model.rarity, opts.backgroundDir ?? defaultArenaDir());
  const src = sprites?.src ?? null;
  // the hero's own skeleton page — read last, right before the synchronous drawing below (no other card can evict it in between)
  if (sprites) await sprites.load(getHeroSheet(sprites.src, model.look.sprite, model.look.colors, model.rarity).images);
  const S = CARD_SIZE;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const v = rarityVisual(model.rarity);
  const accent = v.colors.base;

  // — background + plate —
  ctx.fillStyle = CLANK_PURPLE.ink;
  ctx.fillRect(0, 0, S, S);
  const bg = ctx.createLinearGradient(0, 0, 0, S);
  bg.addColorStop(0, mix(v.surface.from, CLANK_PURPLE.dark, 0.3));
  bg.addColorStop(0.55, mix("#120c24", v.surface.from, 0.35));
  bg.addColorStop(1, mix(v.surface.to, CLANK_PURPLE.ink, 0.25));
  ctx.fillStyle = bg;
  chamfer(ctx, 36, 36, S - 72, S - 72, 56);
  ctx.fill();
  if (v.tier >= 2) {
    // the higher tiers glow around the plate
    ctx.save();
    ctx.shadowColor = v.colors.glow;
    ctx.shadowBlur = v.frame.glowBlur * 1.6;
    ctx.lineWidth = 6;
    ctx.strokeStyle = accent;
    chamfer(ctx, 36, 36, S - 72, S - 72, 56);
    ctx.stroke();
    ctx.restore();
  }
  for (const layer of frameLayers(v)) {
    ctx.lineWidth = layer.width;
    ctx.strokeStyle = layer.color;
    const inset = 36 + layer.inset + layer.width / 2;
    chamfer(ctx, inset, inset, S - inset * 2, S - inset * 2, Math.max(14, 56 - layer.inset));
    ctx.stroke();
  }
  if (v.tier <= 1) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = mix(CLANK_PURPLE.light, CLANK_PURPLE.dark, 0.45);
    chamfer(ctx, 62, 62, S - 124, S - 124, 40);
    ctx.stroke();
  }

  // — header: brand + rarity badge —
  ctx.fillStyle = CLANK_PURPLE.light;
  ctx.font = font(34);
  ctx.textBaseline = "alphabetic";
  spaced(ctx, "CLANK RPG", 112, 124, 6, "left");
  drawBadge(ctx, v, S - 112, 82, 58, 28);

  // — art panel —
  const art = { x: 110, y: 156, w: S - 220, h: 560 };
  ctx.save();
  chamfer(ctx, art.x, art.y, art.w, art.h, 30);
  ctx.clip();
  const panel = ctx.createLinearGradient(0, art.y, 0, art.y + art.h);
  panel.addColorStop(0, mix(v.surface.from, "#000000", 0.15));
  panel.addColorStop(1, mix(v.surface.to, "#000000", 0.3));
  ctx.fillStyle = panel;
  ctx.fillRect(art.x, art.y, art.w, art.h);
  if (arena) {
    // the arena image, "cover"-fitted (filled and cropped, never stretched) exactly like the web card; the neutral panel shows through its transparent corners
    const { image } = heroArenaLayout({ w: art.w, h: art.h });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(arena, art.x + image.x, art.y + image.y, image.size, image.size);
  }
  if (!arena && v.tier >= 2) {
    // woven pattern in the backdrop of the two top tiers
    ctx.strokeStyle = v.surface.accent;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.5;
    const step = v.tier === 3 ? 26 : 34;
    ctx.beginPath();
    for (let d = -art.h; d < art.w + art.h; d += step) {
      ctx.moveTo(art.x + d, art.y);
      ctx.lineTo(art.x + d + art.h, art.y + art.h);
      if (v.tier === 3) {
        ctx.moveTo(art.x + d + art.h, art.y);
        ctx.lineTo(art.x + d, art.y + art.h);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  if (!arena) {
    const glow = ctx.createRadialGradient(S / 2, art.y + art.h * 0.58, 20, S / 2, art.y + art.h * 0.58, art.w * 0.5);
    glow.addColorStop(0, v.colors.glow);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(art.x, art.y, art.w, art.h);
  }
  drawArt(ctx, model, src, art, v, arena);
  ctx.restore();
  ctx.lineWidth = v.frame.width + 2;
  ctx.strokeStyle = v.tier === 0 ? mix(accent, CLANK_PURPLE.ink, 0.4) : accent;
  chamfer(ctx, art.x, art.y, art.w, art.h, 30);
  ctx.stroke();
  if (v.frame.innerRule) {
    ctx.lineWidth = 2;
    ctx.strokeStyle = v.colors.light;
    chamfer(ctx, art.x + 10, art.y + 10, art.w - 20, art.h - 20, 22);
    ctx.stroke();
  }
  drawCorners(ctx, v, art);
  if (v.frame.corners === "crown") {
    // a crown on the top edge of the plate, centred
    ctx.fillStyle = v.colors.base;
    ctx.strokeStyle = v.colors.dark;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(S / 2 - 52, 70);
    ctx.lineTo(S / 2 - 56, 18);
    ctx.lineTo(S / 2 - 26, 42);
    ctx.lineTo(S / 2, 8);
    ctx.lineTo(S / 2 + 26, 42);
    ctx.lineTo(S / 2 + 56, 18);
    ctx.lineTo(S / 2 + 52, 70);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = v.colors.light;
    ctx.beginPath();
    ctx.arc(S / 2, 44, 8, 0, Math.PI * 2);
    ctx.fill();
  }

  // — name, rarity + class, a BIG PWR —
  ctx.textAlign = "center";
  ctx.fillStyle = "#f4efff";
  const name = fitText(ctx, imageName(model.name), S - 260, 70, 36);
  ctx.font = font(name.px);
  ctx.fillText(name.text, S / 2, 792);
  ctx.font = font(38);
  const cls = imageName(model.className).toUpperCase();
  const classW = Array.from(cls).reduce((a, ch) => a + ctx.measureText(ch).width + 5, 0) - 5;
  const iconR = 15;
  const lineW = iconR * 2 + 16 + classW;
  drawRarityMark(ctx as unknown as CanvasRenderingContext2D, v.id, S / 2 - lineW / 2 + iconR, 832, iconR);
  ctx.fillStyle = v.colors.light;
  spaced(ctx, cls, S / 2 - lineW / 2 + iconR * 2 + 16, 844, 5, "left");

  // PWR: caption, then one of the largest numbers on the card
  ctx.textAlign = "center";
  ctx.fillStyle = CLANK_PURPLE.light;
  ctx.font = font(28);
  spaced(ctx, "PWR", S / 2, 886, 10, "center");
  ctx.save();
  if (v.tier >= 2) {
    ctx.shadowColor = v.colors.glow;
    ctx.shadowBlur = 26;
  }
  ctx.fillStyle = v.tier === 0 ? "#f1f5fb" : v.colors.light;
  ctx.font = font(128);
  ctx.textAlign = "center";
  ctx.fillText(formatPower(model.power), S / 2, 1000);
  ctx.restore();

  // — the seven stats —
  const sx = 110;
  const sw = (S - 220) / CARD_STATS.length;
  CARD_STATS.forEach((stat, i) => {
    const x = sx + i * sw;
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    chamfer(ctx, x + 5, 1030, sw - 10, 86, 12);
    ctx.fill();
    ctx.textAlign = "center";
    ctx.fillStyle = mix(CLANK_PURPLE.light, "#ffffff", 0.15);
    ctx.font = font(22);
    ctx.fillText(stat.label, x + sw / 2, 1060);
    ctx.fillStyle = "#ffffff";
    ctx.font = font(42);
    ctx.fillText(String(Math.round(model.stats[stat.key])), x + sw / 2, 1104);
  });

  return canvas.toBuffer("image/png");
}
