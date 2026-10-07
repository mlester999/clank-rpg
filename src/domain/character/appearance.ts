import type { ClassDef } from "../rules";
import type { Rng } from "../util/rng";

export type Rarity = "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
export const RARITIES: readonly Rarity[] = ["COMMON", "RARE", "EPIC", "LEGENDARY"];
export type Aura = "none" | "ring" | "sparks" | "flame";

/**
 * hero-gen/2 rarity visual layers: which of the rarity-specific outfit/weapon/headgear enhancements this hero wears. They are rolled
 * from the hero seed + rarity (see rollRarityFx) and mapped class-aware onto catalogue items by deriveSpriteConfig, so a Legendary
 * Ranger is still unmistakably a Ranger. Absent on heroes made by the first generator.
 */
export interface RarityFx {
  /** Rarity-coloured piping / ornament on the outfit. */
  trim: boolean;
  /** Pauldrons (or a mantle for robes). */
  shoulder: boolean;
  /** An ornament crowning the headgear. */
  crest: boolean;
  /** A glint / glow / ornament on the weapon. */
  weapon: boolean;
}

/** Modular, procedural appearance. All values are indices into fixed catalogues. */
export interface AppearanceParts {
  skin: number;
  hairStyle: number;
  hairColor: number;
  eyes: number;
  mouth: number;
  accessory: number;
  cape: boolean;
  aura: Aura;
  /** 0..359 hue rotation applied to the class outfit colours. */
  outfitHue: number;
  /** hero-gen/2 and later. */
  fx?: RarityFx;
}

export const SKIN_TONES = ["#f6d9bd", "#ecc19a", "#d39a6e", "#b27851", "#865a3d", "#573a2a"] as const;
export const HAIR_COLORS = [
  "#1b1a1f", "#4a2f1d", "#7b4a26", "#c28a3a", "#e7cf7a", "#b8402f", "#6a5acd", "#2fb5a1", "#d96fa8", "#e8eef5",
] as const;
export const HAIR_STYLE_COUNT = 8;
export const EYE_STYLE_COUNT = 4;
export const MOUTH_STYLE_COUNT = 3;
export const ACCESSORIES = ["none", "goggles", "scarf", "cog-pin", "monocle", "headset"] as const;

/**
 * Rarity is rolled with the production weights (settings.character.rarityWeights) and nothing else — no admin boost, no pity, no
 * secret rates. Rarity is a real strength tier: it fixes the PWR band and stat budget the hero is generated with (see
 * hero/rarity.ts) as well as its visual prestige (hero/rarityVisuals.ts).
 */
export function rollRarity(rng: Rng, weights: Record<Rarity, number>): Rarity {
  return rng.weighted(RARITIES, (r) => weights[r]);
}

/** The first generator's look (hero-gen/1). Kept exactly as it was so every version it drew stays reproducible. */
export function rollAppearanceV1(rng: Rng, _classDef: ClassDef, rarity: Rarity): AppearanceParts {
  const parts: AppearanceParts = {
    skin: rng.int(SKIN_TONES.length),
    hairStyle: rng.int(HAIR_STYLE_COUNT),
    hairColor: rng.int(HAIR_COLORS.length),
    eyes: rng.int(EYE_STYLE_COUNT),
    mouth: rng.int(MOUTH_STYLE_COUNT),
    accessory: rng.int(3),
    cape: false,
    aura: "none",
    outfitHue: rng.int(360),
  };
  switch (rarity) {
    case "RARE":
      parts.aura = "ring";
      parts.accessory = Math.max(1, parts.accessory);
      break;
    case "EPIC":
      parts.aura = "sparks";
      parts.cape = true;
      parts.accessory = Math.max(1, parts.accessory);
      break;
    case "LEGENDARY":
      parts.aura = "flame";
      parts.cape = true;
      parts.accessory = 3 + rng.int(3);
      break;
    default:
      break;
  }
  return parts;
}

/**
 * How likely each rarity-specific enhancement is, per rarity (1 = always, 0 = never). A tiny table on purpose: the visible ladder is
 *   COMMON     clean, nothing added
 *   RARE       trim + weapon glint
 *   EPIC       trim + shoulders + weapon glow (often a crest)
 *   LEGENDARY  everything
 * Each higher rarity ONLY adds, so a hero's silhouette and class stay readable at every tier.
 */
export const RARITY_FX_CHANCE: Readonly<Record<Rarity, Readonly<Record<keyof RarityFx, number>>>> = Object.freeze({
  COMMON: Object.freeze({ trim: 0, shoulder: 0, crest: 0, weapon: 0 }),
  RARE: Object.freeze({ trim: 1, shoulder: 0, crest: 0, weapon: 1 }),
  EPIC: Object.freeze({ trim: 1, shoulder: 1, crest: 0.5, weapon: 1 }),
  LEGENDARY: Object.freeze({ trim: 1, shoulder: 1, crest: 1, weapon: 1 }),
});

/** Deterministic: the same (seed stream, rarity) always yields the same enhancements — a rollback or a rebalance reproduces them exactly. */
export function rollRarityFx(rng: Rng, rarity: Rarity): RarityFx {
  const chance = RARITY_FX_CHANCE[rarity];
  // One draw per enhancement in a fixed order, always consumed, so a change of one rarity's chance never shifts another's stream.
  const roll = { trim: rng.next(), shoulder: rng.next(), crest: rng.next(), weapon: rng.next() };
  return {
    trim: roll.trim < chance.trim,
    shoulder: roll.shoulder < chance.shoulder,
    crest: roll.crest < chance.crest,
    weapon: roll.weapon < chance.weapon,
  };
}

/** hero-gen/2 look: the same identity parts a first-generator roll of the same stream gives, plus the rarity enhancements. */
export function rollAppearance(rng: Rng, classDef: ClassDef, rarity: Rarity): AppearanceParts {
  const parts = rollAppearanceV1(rng, classDef, rarity);
  return { ...parts, fx: rollRarityFx(rng.fork("rarity-fx"), rarity) };
}
