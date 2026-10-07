import type { Rarity } from "../character/appearance";

/**
 * THE HERO CARD ARENA — the one place that says which background a rarity stands in, and how big the hero is inside it.
 *
 * The four arena images live in `public/hero-card-backgrounds/` and are used AS UPLOADED (never processed, cropped on disk or made transparent;
 * the files themselves carry transparency outside the arena ring, and a rarity-coloured backdrop sits under them anyway). They are square, so
 * every surface fits them with "cover": the image is scaled to fill the art frame and the overflow is cropped — never stretched.
 *
 *   COMMON    → common.webp     natural stone and foliage, no magic
 *   RARE      → rare.webp       blue / cyan runes
 *   EPIC      → epic.webp       purple crystals, gold trim
 *   LEGENDARY → legendary.webp  the most ornate: gold + purple
 *
 * Every hero-card surface resolves the image through `getHeroCardBackground` (web: the framed art area; server: the 1200 × 1200 PNG reads the very
 * same file from `public/`), and sizes the hero with `heroArenaLayout` — so the browser card and the downloadable card cannot drift apart.
 * A rarity that is missing or unknown resolves to `null`: the card keeps its neutral rarity backdrop (no broken image, no blank card).
 */
export const HERO_CARD_BACKGROUND_DIR = "/hero-card-backgrounds";

/** The authoritative rarity → file map (file names inside HERO_CARD_BACKGROUND_DIR). */
export const HERO_CARD_BACKGROUND_FILES: Readonly<Record<Rarity, string>> = Object.freeze({
  COMMON: "common.webp",
  RARE: "rare.webp",
  EPIC: "epic.webp",
  LEGENDARY: "legendary.webp",
});

/** The file name for a rarity, or null when the rarity is missing / not one of ours. */
export function heroCardBackgroundFile(rarity: unknown): string | null {
  return typeof rarity === "string" && Object.hasOwn(HERO_CARD_BACKGROUND_FILES, rarity) ? HERO_CARD_BACKGROUND_FILES[rarity as Rarity] : null;
}

/** The public URL path of a rarity's arena image (`/hero-card-backgrounds/rare.webp`), or null → use the neutral fallback backdrop. */
export function getHeroCardBackground(rarity: unknown): string | null {
  const file = heroCardBackgroundFile(rarity);
  return file ? `${HERO_CARD_BACKGROUND_DIR}/${file}` : null;
}

/**
 * How the hero stands in the arena. All fractions are of the arena image as it is drawn with "cover" (its side is the LONGER side of the art frame).
 * The hero is small — a figure standing in a little arena, centred, feet on the floor, well inside the rim — not a sprite filling the box.
 */
export const HERO_ARENA = Object.freeze({
  /** The web art frame is square, like the images. */
  aspect: 1,
  /** The visible hero's height, as a fraction of the drawn arena image's side. */
  heroHeight: 0.26,
  /** Where the hero's feet stand: fractions of the drawn image, from its top-left. */
  feet: Object.freeze({ x: 0.5, y: 0.62 }),
  /** Which part of the image stays in view when "cover" has to crop (0.5 = the middle). */
  focus: Object.freeze({ x: 0.5, y: 0.5 }),
  /**
   * The hero canvas (HeroPortrait frame="full") is a square; the sprite inside it stands ≈ 64% as tall as the canvas and its feet sit ≈ 92% of the
   * way down it (sprite frame 80 × 64, anchor y 58, drawn bottom-aligned into a square of the cropped 72 px width — see HeroPortrait).
   */
  canvas: Object.freeze({ heroOfCanvas: 0.64, feetInCanvas: 0.92 }),
});

export interface ArenaBox {
  w: number;
  h: number;
}

export interface HeroArenaLayout {
  /** The arena image as drawn by "cover" inside the box (x / y may be negative: the cropped overflow). */
  image: { x: number; y: number; size: number };
  hero: {
    /** Height of the visible hero. */
    height: number;
    /** Where its feet stand, in box coordinates. */
    feetX: number;
    feetY: number;
    /** The square hero canvas that draws it (HeroPortrait), and its top-left corner, in box coordinates. */
    canvas: number;
    canvasX: number;
    canvasY: number;
  };
}

/**
 * The shared layout maths: web card, directory tile, profile and the server-rendered PNG all call this with their own art box.
 * `heroScale` (default 1) enlarges the hero for small thumbnails (the directory tile) — the feet stay where they are.
 */
export function heroArenaLayout(box: ArenaBox, opts: { heroScale?: number } = {}): HeroArenaLayout {
  const size = Math.max(box.w, box.h); // "cover": the square image fills the box
  const image = { size, x: (box.w - size) * HERO_ARENA.focus.x, y: (box.h - size) * HERO_ARENA.focus.y };
  const height = size * HERO_ARENA.heroHeight * (opts.heroScale ?? 1);
  const feetX = image.x + size * HERO_ARENA.feet.x;
  const feetY = image.y + size * HERO_ARENA.feet.y;
  const canvas = height / HERO_ARENA.canvas.heroOfCanvas;
  return { image, hero: { height, feetX, feetY, canvas, canvasX: feetX - canvas / 2, canvasY: feetY - canvas * HERO_ARENA.canvas.feetInCanvas } };
}

/** CSS `background-position` for the "cover" crop (percentages), so the browser crops exactly where the server renderer does. */
export const HERO_ARENA_BACKGROUND_POSITION = `${HERO_ARENA.focus.x * 100}% ${HERO_ARENA.focus.y * 100}%`;
