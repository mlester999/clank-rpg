import type { Aura, Rarity } from "../character/appearance";
import { RARITIES } from "../character/appearance";

/**
 * RARITY VISUALS — the one shared description of how each rarity LOOKS. Every surface reads this table and nothing else: the hero card,
 * the public profile, the Admin console, the hero directory, the upcoming-battle roster, the leaderboard rows, the portrait frames, the
 * Arena effects (ground ring, outline, particles, name plate), the downloadable PNG and the social (Open Graph) card. No component designs
 * its own rarity styling.
 *
 * Rarity is never told by COLOUR ALONE. Every tier also differs in SHAPE and INTENSITY, so it stays readable for colour-blind players and in
 * the Arena (where rarity text is deliberately not shown):
 *
 *            badge icon   frame            ground ring            outline / glow     particles
 *   COMMON   ●  dot       plain, 2 px      1 thin ring            none               none
 *   RARE     ◆  diamond   bevelled, notch 1 ring + inner arc      faint              none
 *   EPIC     ✦  star      double, gems     2 rings + 6 rune ticks medium             6 rising sparks
 *   LEGEND.  ♛  crown     ornate, crowned  3 rings + 10 rune ticks strong             12 rising embers
 *
 * Visual tiers only DRESS a hero; they are drawn from the hero's stored rarity and never feed combat (the Arena effects are drawn after, and
 * independently of, the deterministic simulation).
 */
export type BadgeIcon = "dot" | "diamond" | "star" | "crown";
export type FrameStyle = "plain" | "bevel" | "double" | "ornate";
export type FrameCorners = "none" | "notch" | "gem" | "crown";
export type ParticleKind = "none" | "spark" | "ember";

export interface RarityVisual {
  id: Rarity;
  label: string;
  /** 0–3, mirrors RARITY_RULES[...].visualTier. */
  tier: 0 | 1 | 2 | 3;
  colors: {
    /** The rarity's signature colour (badge fill, frame, ring). */
    base: string;
    light: string;
    dark: string;
    /** Readable text colour ON `base` (badge label). */
    ink: string;
    /** Soft glow colour (rgba). */
    glow: string;
  };
  /** Card / portrait backdrop gradient, top → bottom, plus the faint pattern colour. */
  surface: { from: string; to: string; accent: string };
  badge: { icon: BadgeIcon };
  frame: { style: FrameStyle; width: number; corners: FrameCorners; innerRule: boolean; glowBlur: number; glowAlpha: number };
  /** Arena effects (drawn on the canvas, visual only). Sizes are in hero-local units (the hero is ~HERO_HEIGHT tall, feet at the origin). */
  arena: {
    /** The sprite aura layer this tier wears (drawn by the sprite compositor). */
    aura: Aura;
    ground: { rings: 1 | 2 | 3; rx: number; ry: number; lineWidth: number; alpha: number; ticks: number };
    outline: { width: number; alpha: number };
    particles: { count: number; kind: ParticleKind; size: number; alpha: number; riseSpeed: number };
    /** Slow breathing of the ring (amplitude as a fraction of its radius; 0 = static). */
    pulse: { amplitude: number; periodMs: number };
    /** 0–1 overall prominence — only used to assert the ladder (each tier is more intense than the one below). */
    intensity: number;
  };
}

const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const visual = (v: Omit<RarityVisual, "colors" | "label"> & { label: string; colors: Omit<RarityVisual["colors"], "glow">; glowAlpha: number }): RarityVisual => {
  const { glowAlpha, colors, ...rest } = v;
  return Object.freeze({ ...rest, colors: Object.freeze({ ...colors, glow: rgba(colors.base, glowAlpha) }) });
};

export const RARITY_VISUALS: Readonly<Record<Rarity, RarityVisual>> = Object.freeze({
  COMMON: visual({
    id: "COMMON", label: "Common", tier: 0, glowAlpha: 0.2,
    colors: { base: "#9aa4b2", light: "#cfd6df", dark: "#5b6572", ink: "#0d1117" },
    surface: { from: "#1b2030", to: "#10131c", accent: "#2a3144" },
    badge: { icon: "dot" },
    frame: { style: "plain", width: 2, corners: "none", innerRule: false, glowBlur: 0, glowAlpha: 0 },
    arena: {
      aura: "none",
      ground: { rings: 1, rx: 27, ry: 7.6, lineWidth: 1.2, alpha: 0.32, ticks: 0 },
      outline: { width: 0, alpha: 0 },
      particles: { count: 0, kind: "none", size: 0, alpha: 0, riseSpeed: 0 },
      pulse: { amplitude: 0, periodMs: 0 },
      intensity: 0.1,
    },
  }),
  RARE: visual({
    id: "RARE", label: "Rare", tier: 1, glowAlpha: 0.34,
    colors: { base: "#4aa8ff", light: "#a6d4ff", dark: "#1f66b0", ink: "#04101c" },
    surface: { from: "#16284a", to: "#0e1526", accent: "#24407a" },
    badge: { icon: "diamond" },
    frame: { style: "bevel", width: 3, corners: "notch", innerRule: false, glowBlur: 10, glowAlpha: 0.32 },
    arena: {
      aura: "ring",
      ground: { rings: 1, rx: 29, ry: 8.2, lineWidth: 1.8, alpha: 0.55, ticks: 0 },
      outline: { width: 1, alpha: 0.3 },
      particles: { count: 0, kind: "none", size: 0, alpha: 0, riseSpeed: 0 },
      pulse: { amplitude: 0.025, periodMs: 2600 },
      intensity: 0.35,
    },
  }),
  EPIC: visual({
    id: "EPIC", label: "Epic", tier: 2, glowAlpha: 0.42,
    colors: { base: "#b366ff", light: "#e0bcff", dark: "#6a2bb5", ink: "#14061f" },
    surface: { from: "#2a1a52", to: "#140e26", accent: "#4a2d8a" },
    badge: { icon: "star" },
    frame: { style: "double", width: 3, corners: "gem", innerRule: true, glowBlur: 18, glowAlpha: 0.42 },
    arena: {
      aura: "sparks",
      ground: { rings: 2, rx: 31, ry: 8.8, lineWidth: 2.2, alpha: 0.7, ticks: 6 },
      outline: { width: 1.6, alpha: 0.5 },
      particles: { count: 6, kind: "spark", size: 1.7, alpha: 0.85, riseSpeed: 20 },
      pulse: { amplitude: 0.04, periodMs: 2200 },
      intensity: 0.65,
    },
  }),
  LEGENDARY: visual({
    id: "LEGENDARY", label: "Legendary", tier: 3, glowAlpha: 0.5,
    colors: { base: "#ffb020", light: "#ffe08a", dark: "#b36b00", ink: "#1a0f00" },
    surface: { from: "#4a3210", to: "#1a1030", accent: "#7a5418" },
    badge: { icon: "crown" },
    frame: { style: "ornate", width: 4, corners: "crown", innerRule: true, glowBlur: 28, glowAlpha: 0.55 },
    arena: {
      aura: "flame",
      ground: { rings: 3, rx: 34, ry: 9.6, lineWidth: 2.6, alpha: 0.85, ticks: 10 },
      outline: { width: 2.2, alpha: 0.7 },
      particles: { count: 12, kind: "ember", size: 2.1, alpha: 0.95, riseSpeed: 28 },
      pulse: { amplitude: 0.055, periodMs: 1900 },
      intensity: 1,
    },
  }),
});

/** Accepts any string (a look read from storage / the wire): an unknown rarity is dressed as Common, never as a crash. */
export const rarityVisual = (rarity: Rarity | string): RarityVisual => RARITY_VISUALS[rarity as Rarity] ?? RARITY_VISUALS.COMMON;

/** The same palette as plain `{rarity: hex}` — what older call sites (and the sprite tint) read. Derived, never independently defined. */
export const RARITY_BASE_COLOR: Readonly<Record<Rarity, string>> = Object.freeze(Object.fromEntries(RARITIES.map((r) => [r, RARITY_VISUALS[r].colors.base])) as Record<Rarity, string>);

/** CSS custom properties for a rarity: spread into a `style` prop and let the CSS classes read `var(--rarity)` etc. */
export function rarityCssVars(rarity: Rarity): Record<`--${string}`, string> {
  const v = rarityVisual(rarity);
  return {
    "--rarity": v.colors.base,
    "--rarity-light": v.colors.light,
    "--rarity-dark": v.colors.dark,
    "--rarity-ink": v.colors.ink,
    "--rarity-glow": v.colors.glow,
    "--rarity-from": v.surface.from,
    "--rarity-to": v.surface.to,
    "--rarity-accent": v.surface.accent,
    "--rarity-frame-width": `${v.frame.width}px`,
    "--rarity-glow-blur": `${v.frame.glowBlur}px`,
  };
}
