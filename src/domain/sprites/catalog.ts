import type { Rarity } from "../character/appearance";
import { LOOK_BODIES, LOOK_HEADGEAR, LOOK_WEAPONS } from "../rules";

import type { SlotId } from "./spec";

/**
 * The cosmetic catalogue: every visual item a hero can wear. It is DATA, not code paths:
 *
 *  · `id` is also the manifest layer id, so adding art for an item is "add a layer + a row here";
 *  · `tier` is the rarity an item belongs to: it gates which items the procedural generator may hand
 *    out (the rarity enhancement layers — trim, shoulders, crest, weapon fx — are only given to heroes
 *    of that rarity or higher). The ITEM never feeds stats, class, or combat (asserted in tests:
 *    nothing in this file, or in the combat engine's inputs, references it) — a hero's strength comes
 *    from its generated stats (see hero/rarity.ts), never from what it wears;
 *  · `fits` restricts an item to heroes whose CLASS LOOK matches, so class identity stays
 *    readable (a Tank can never swap into a Mage's staff) while admin-added classes still work;
 *  · `source` records where the item comes from, so earned / boss-loot cosmetics slot in later
 *    without a schema change;
 *  · `enabled` is the catalogue-level kill switch (admins can also disable items at runtime via
 *    the `visuals.disabledCosmetics` setting).
 */

export const CATALOG_VERSION = 2;

export type CosmeticSource = "STARTER" | "PROCEDURAL" | "EARNED" | "BOSS_LOOT";

/** The slice of a class definition the visual system reads. */
export interface ClassLook {
  weapon: string;
  headgear: string;
  body: string;
  colors: readonly [string, string, string];
}

export interface CosmeticItem {
  id: string;
  slot: SlotId;
  name: string;
  tier: Rarity;
  source: CosmeticSource;
  /** Only heroes whose class look matches every given key may wear it. Omitted = anyone. */
  fits?: { weapon?: string; body?: string; headgear?: string };
  /** Slots this item covers completely (a full helm hides the hair). */
  hides?: SlotId[];
  enabled: boolean;
}

const EYES = ["Round", "Wide", "Calm", "Sly"];
const MOUTHS = ["Smile", "Flat", "Grin"];
const HAIR = ["Crop", "Spiky", "Long", "Mohawk", "Bun", "Curly", "Swoop"];
const ACCESSORIES: Array<[string, string, Rarity]> = [
  ["goggles", "Brass Goggles", "RARE"],
  ["scarf", "Foundry Scarf", "COMMON"],
  ["cog-pin", "Cog Pin", "COMMON"],
  ["monocle", "Monocle", "RARE"],
  ["headset", "Comms Headset", "RARE"],
];

const item = (id: string, slot: SlotId, name: string, tier: Rarity, extra: Partial<CosmeticItem> = {}): CosmeticItem => ({
  id, slot, name, tier, source: "PROCEDURAL", enabled: true, ...extra,
});

/** The tiers that have rarity enhancement art (Common is the clean base look). */
export const ENHANCEMENT_TIERS = ["RARE", "EPIC", "LEGENDARY"] as const satisfies readonly Rarity[];
const tierKey = (t: Rarity): string => t.toLowerCase();
const cap1 = (s: string): string => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/**
 * Rarity enhancement items (hero generator 2): outfit trim, shoulders, a headgear crest and a weapon glint/glow, one item per tier and per
 * class-look variant, so a Legendary Ranger's weapon ornament is a bow's and a Legendary Mage's shoulders are a robe's mantle. All are
 * source "PROCEDURAL": the generator hands them out by rarity, never a player choice.
 */
const RARITY_ENHANCEMENTS: CosmeticItem[] = ENHANCEMENT_TIERS.flatMap((tier) => [
  ...LOOK_BODIES.map((b) => item(`trim.${tierKey(tier)}.${b}`, "trim", `${cap1(tierKey(tier))} ${cap1(b)} Trim`, tier, { fits: { body: b } })),
  ...(tier === "RARE" ? [] : LOOK_BODIES.map((b) => item(`shoulder.${tierKey(tier)}.${b}`, "shoulder", `${cap1(tierKey(tier))} ${b === "robe" ? "Mantle" : "Pauldron"} (${cap1(b)})`, tier, { fits: { body: b } }))),
  ...(tier === "RARE" ? [] : LOOK_HEADGEAR.map((h) => item(`crest.${tierKey(tier)}.${h}`, "crest", `${cap1(tierKey(tier))} ${cap1(h)} Crest`, tier, { fits: { headgear: h } }))),
  ...LOOK_WEAPONS.map((w) => item(`weaponfx.${tierKey(tier)}.${w}`, "weaponfx", `${cap1(tierKey(tier))} ${cap1(w)} Fx`, tier, { fits: { weapon: w } })),
]);

export const COSMETIC_ITEMS: readonly CosmeticItem[] = [
  ...EYES.map((n, i) => item(`eyes.${i}`, "eyes", `${n} Eyes`, "COMMON", { source: "STARTER" })),
  ...MOUTHS.map((n, i) => item(`mouth.${i}`, "mouth", n, "COMMON", { source: "STARTER" })),
  ...HAIR.map((n, i) => item(`hair.${i}`, "hair", n, "COMMON", { source: "STARTER" })),
  ...LOOK_BODIES.map((b) => item(`outfit.${b}`, "outfit", `${b[0]!.toUpperCase()}${b.slice(1)} Kit`, "COMMON", { source: "STARTER", fits: { body: b } })),
  ...LOOK_WEAPONS.map((w) => item(`weapon.${w}`, "weapon", `${w[0]!.toUpperCase()}${w.slice(1)}`, "COMMON", { source: "STARTER", fits: { weapon: w } })),
  item("offhand.shield", "offhand", "Tower Shield", "COMMON", { source: "STARTER", fits: { body: "heavy" } }),
  ...LOOK_HEADGEAR.map((h) =>
    item(`headgear.${h}`, "headgear", `${h[0]!.toUpperCase()}${h.slice(1)}`, h === "crown" ? "LEGENDARY" : "COMMON", {
      source: h === "crown" ? "EARNED" : "STARTER",
      ...(h === "helm" ? { hides: ["hair" as const] } : {}),
    }),
  ),
  ...ACCESSORIES.map(([id, name, tier]) => item(`accessory.${id}`, "accessory", name, tier)),
  item("cape.default", "cape", "Hero's Cape", "EPIC"),
  item("aura.ring", "aura", "Ring Aura", "RARE"),
  item("aura.sparks", "aura", "Spark Aura", "EPIC"),
  item("aura.flame", "aura", "Flame Aura", "LEGENDARY"),
  ...RARITY_ENHANCEMENTS,
];

const BY_ID = new Map(COSMETIC_ITEMS.map((i) => [i.id, i]));

export function getCosmetic(id: string): CosmeticItem | undefined {
  return BY_ID.get(id);
}

export function cosmeticsForSlot(slot: SlotId): CosmeticItem[] {
  return COSMETIC_ITEMS.filter((i) => i.slot === slot);
}

/** Class-compatibility: does this hero's class look allow wearing the item? */
export function fitsClass(it: CosmeticItem, look: Pick<ClassLook, "weapon" | "body"> & Partial<Pick<ClassLook, "headgear">>): boolean {
  if (!it.fits) return true;
  if (it.fits.weapon !== undefined && it.fits.weapon !== look.weapon) return false;
  if (it.fits.body !== undefined && it.fits.body !== look.body) return false;
  if (it.fits.headgear !== undefined && it.fits.headgear !== look.headgear) return false;
  return true;
}

export interface UsableOptions {
  /** Item ids an admin switched off at runtime (`visuals.disabledCosmetics`). */
  disabled?: ReadonlySet<string> | readonly string[];
}

/** An item can be worn if it exists, is enabled, is not admin-disabled and fits the class. */
export function isUsable(id: string, look: Pick<ClassLook, "weapon" | "body"> & Partial<Pick<ClassLook, "headgear">>, opts: UsableOptions = {}): boolean {
  const it = BY_ID.get(id);
  if (!it || !it.enabled) return false;
  const off = opts.disabled instanceof Set ? opts.disabled : new Set(opts.disabled ?? []);
  if (off.has(id)) return false;
  return fitsClass(it, look);
}
