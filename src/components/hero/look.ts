import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import { resolveSpriteConfig, type CosmeticOverrides } from "@/domain/sprites/config";
import type { ClassVisual } from "@/lib/dto";

import type { HeroLook } from "./drawHero";

const FALLBACK: ClassVisual = {
  name: "Hero",
  role: "",
  tagline: "",
  colors: ["#5d6b7a", "#c4cddb", "#2c343d"],
  weapon: "sword",
  headgear: "cap",
  body: "medium",
  attackStyle: "slash",
};

interface AppearanceInput {
  rarity: string;
  parts: unknown;
  sprite?: unknown;
  overrides?: unknown;
}

// Resolution validates with zod, and the arena re-renders often: memoise per appearance object.
const memo = new WeakMap<object, Map<string, HeroLook>>();

/**
 * One call turns a hero's persisted appearance + their class into everything a renderer needs.
 * The sprite layer config is resolved with the SAME pure domain code the server uses: stored
 * config (or a deterministic derivation for legacy rows) → player overrides → admin-disabled items.
 */
export function lookFor(appearance: AppearanceInput, visual: ClassVisual | undefined, disabled: readonly string[] = []): HeroLook {
  const v = visual ?? FALLBACK;
  const key = `${v.name}|${v.weapon}|${v.body}|${v.headgear}|${v.colors.join("")}|${disabled.join(",")}`;
  let byKey = memo.get(appearance);
  if (!byKey) memo.set(appearance, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit) return hit;
  const parts = appearance.parts as AppearanceParts;
  const look: HeroLook = {
    rarity: appearance.rarity,
    parts,
    sprite: resolveSpriteConfig({ stored: appearance.sprite, parts, look: v, overrides: appearance.overrides as CosmeticOverrides | null | undefined, disabled, rarity: appearance.rarity as Rarity }),
    colors: v.colors,
    weapon: v.weapon,
    headgear: v.headgear,
    body: v.body,
  };
  byKey.set(key, look);
  return look;
}
