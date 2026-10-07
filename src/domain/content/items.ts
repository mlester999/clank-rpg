import type { StatKey } from "../stats";

export type ItemSlot = "WEAPON" | "ARMOR" | "TRINKET";
export type ItemRarity = "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY";
export const ITEM_RARITIES: readonly ItemRarity[] = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
export const ITEM_SLOTS: readonly ItemSlot[] = ["WEAPON", "ARMOR", "TRINKET"];

export interface ItemTemplate {
  id: string;
  name: string;
  description: string;
  slot: ItemSlot;
  rarity: ItemRarity;
  classRestriction: string[] | null;
  statMods: Partial<Record<StatKey, number>>;
  look: { tint?: string; weapon?: string };
  sourceTag: string;
}

/** Total flat stat points an item grants (HP counts as 3 HP per point). Deliberately small. */
export const RARITY_BUDGET: Record<ItemRarity, number> = { COMMON: 1, UNCOMMON: 2, RARE: 3.5, EPIC: 5, LEGENDARY: 7 };
export const RARITY_TINT: Record<ItemRarity, string> = {
  COMMON: "#9aa4b2",
  UNCOMMON: "#5fd38d",
  RARE: "#4aa8ff",
  EPIC: "#b366ff",
  LEGENDARY: "#ffb020",
};

const PREFIX: Record<ItemRarity, string> = {
  COMMON: "Rusty",
  UNCOMMON: "Tempered",
  RARE: "Brassbound",
  EPIC: "Overclocked",
  LEGENDARY: "Foundry-Crowned",
};

const WEAPONS: Record<string, { noun: string; main: StatKey; second: StatKey }> = {
  warrior: { noun: "Gearblade", main: "str", second: "hp" },
  mage: { noun: "Coil Staff", main: "int", second: "cha" },
  rogue: { noun: "Cog Daggers", main: "agi", second: "luck" },
  ranger: { noun: "Spring Bow", main: "str", second: "agi" },
  tank: { noun: "Piston Mace", main: "def", second: "hp" },
  cleric: { noun: "Beacon Tome", main: "int", second: "cha" },
};

const ARMORS: Array<{ id: string; noun: string; classes: string[]; main: StatKey; second: StatKey }> = [
  { id: "plate", noun: "Plating", classes: ["warrior", "tank"], main: "def", second: "hp" },
  { id: "leather", noun: "Leathers", classes: ["rogue", "ranger"], main: "agi", second: "def" },
  { id: "robe", noun: "Vestments", classes: ["mage", "cleric"], main: "int", second: "def" },
];

const TRINKETS: Array<{ id: string; noun: string; main: StatKey; second: StatKey }> = [
  { id: "lucky_cog", noun: "Lucky Cog", main: "luck", second: "agi" },
  { id: "pressure_valve", noun: "Pressure Valve", main: "hp", second: "def" },
  { id: "resonance_coil", noun: "Resonance Coil", main: "cha", second: "int" },
  { id: "torque_wrench", noun: "Torque Wrench", main: "str", second: "hp" },
];

function mods(budget: number, main: StatKey, second: StatKey): Partial<Record<StatKey, number>> {
  const points = (key: StatKey, share: number) => {
    const raw = budget * share;
    return key === "hp" ? Math.round(raw * 3) : Math.max(1, Math.round(raw * 10) / 10);
  };
  const out: Partial<Record<StatKey, number>> = {};
  out[main] = points(main, 0.65);
  out[second] = (out[second] ?? 0) + points(second, 0.35);
  return out;
}

/** Generates the default catalogue (seeded once; admins can add/edit templates afterwards). */
export function generateDefaultItems(): ItemTemplate[] {
  const items: ItemTemplate[] = [];
  for (const rarity of ITEM_RARITIES) {
    const budget = RARITY_BUDGET[rarity];
    const tint = RARITY_TINT[rarity];
    for (const [classId, w] of Object.entries(WEAPONS)) {
      items.push({
        id: `${classId}_weapon_${rarity.toLowerCase()}`,
        name: `${PREFIX[rarity]} ${w.noun}`,
        description: `A ${rarity.toLowerCase()} ${w.noun.toLowerCase()} built for the ${classId}.`,
        slot: "WEAPON",
        rarity,
        classRestriction: [classId],
        statMods: mods(budget, w.main, w.second),
        look: { tint },
        sourceTag: "ARENA_DROP",
      });
    }
    for (const a of ARMORS) {
      items.push({
        id: `${a.id}_armor_${rarity.toLowerCase()}`,
        name: `${PREFIX[rarity]} ${a.noun}`,
        description: `${rarity[0]}${rarity.slice(1).toLowerCase()} ${a.noun.toLowerCase()} stitched with arena scrap.`,
        slot: "ARMOR",
        rarity,
        classRestriction: a.classes,
        statMods: mods(budget, a.main, a.second),
        look: { tint },
        sourceTag: "ARENA_DROP",
      });
    }
    for (const t of TRINKETS) {
      items.push({
        id: `${t.id}_${rarity.toLowerCase()}`,
        name: `${PREFIX[rarity]} ${t.noun}`,
        description: `A ${rarity.toLowerCase()} trinket humming with stored energy.`,
        slot: "TRINKET",
        rarity,
        classRestriction: null,
        statMods: mods(budget, t.main, t.second),
        look: { tint },
        sourceTag: "ARENA_DROP",
      });
    }
  }
  return items;
}
