import { darken, lighten, shiftHue } from "../../util/color";
import type { SpriteConfig } from "../config";

import { adjust, hex, toLch } from "./color";
import type { Material } from "./gbuffer";
import type { Genome } from "./genome";
import { material, MAT } from "./materials";

/**
 * HERO RENDERER v3 — one hero's PALETTE: every material it is drawn with, all built the same way (hue-shifted OKLCH ramps), so the figure is
 * one coherent palette. Class colours are the hero's class colours with its stored hue shift and its v2 tone (deeper … paler) — the same
 * shade it wore in renderer v2.
 */

export interface HeroPalette {
  skin: Material;
  hair: Material;
  /** Class colour (tabards, robes, hoods, cloaks). */
  primary: Material;
  primaryDark: Material;
  /** Secondary class colour (trims, sashes, linings). */
  secondary: Material;
  /** The class's dark accent (capes, undershirts). */
  accent: Material;
  /** The hero's second cloth colour (v2 `cloth`). */
  cloth: Material;
  /** Armour metal (v2 `metal`: steel, iron, bronze, blackened iron, silver). */
  metal: Material;
  /** Mail: the armour metal, darker and flatter (rings read as a dull sheen). */
  mail: Material;
  /** Trim metal: brass at Common/Rare, gold at Epic/Legendary. */
  trim: Material;
  leather: Material;
  darkLeather: Material;
  wood: Material;
  /** The rarity colour as a gem / an enamel. */
  gem: Material;
  /** The class's magic light (arcane, holy, poison-green, wind…). */
  glow: Material;
  /** Lips / mouth line and brow colour. */
  lip: number;
  brow: number;
}

const toned = (h: string, t: number): string => (t < 0 ? darken(h, -t) : t > 0 ? lighten(h, t) : h);

/**
 * A readability floor for large cloth areas: a near-black class colour (the Rogue's accent) is lifted just enough that its shadow tone and the
 * black silhouette outline stay apart on the dark arena floor. Hue and chroma are kept.
 */
const floorL = (c: number, min = 0.3): number => {
  const l = toLch(c);
  return l.L >= min ? c : adjust(c, min - l.L, 1);
};

const GLOW: Record<string, string> = { warrior: "#ffb15c", tank: "#ffd27a", rogue: "#7fe8d0", ranger: "#b8f06a", mage: "#a88bff", cleric: "#ffe28a" };

export function heroPalette(g: Genome, config: Pick<SpriteConfig, "hue">): HeroPalette {
  const hue = config.hue;
  const primary = toned(shiftHue(g.colors.primary, hue), g.tone);
  const secondary = shiftHue(g.colors.secondary, hue);
  const accent = toned(shiftHue(g.colors.accent, hue), g.tone * 0.5);
  const skin = material(g.skin, "skin");
  const hairBase = hex(g.hairColor);
  const hair = material(hairBase, "hair");
  const metalBase = hex(g.colors.metal);
  return {
    skin,
    hair,
    primary: material(floorL(hex(primary), 0.34), "cloth"),
    primaryDark: material(floorL(adjust(hex(primary), -0.1, 0.95), 0.3), "cloth"),
    secondary: material(secondary, "cloth"),
    accent: material(floorL(hex(accent)), "cloth"),
    cloth: material(g.colors.cloth, "cloth"),
    // plate: the armour metal a step darker at its base (the lit side still reaches the metal's own colour) — a silver suit is shaded, not white
    metal: material(adjust(metalBase, toLch(metalBase).L > 0.75 ? -0.09 : -0.03, 1), "metal"),
    mail: material(adjust(metalBase, -0.06, 0.75), "cloth", { dark: 0.1, light: 0.1 }),
    trim: g.tier >= 2 ? MAT.gold : MAT.bronze,
    leather: MAT.leather,
    darkLeather: MAT.darkLeather,
    wood: MAT.wood,
    gem: material(g.colors.rarity, "gem"),
    glow: material(GLOW[g.cls] ?? "#ffe28a", "glow"),
    lip: adjust(skin.ramp[0], 0.02, 1.1, -8),
    brow: adjust(hair.ramp[0], -0.04, 1),
  };
}
