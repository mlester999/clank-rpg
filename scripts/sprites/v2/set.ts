import { COSMETIC_ITEMS } from "../../../src/domain/sprites/catalog";
import type { AttackClip, TintRole } from "../../../src/domain/sprites/spec";

import { BODY_LAYERS } from "./body";
import { CLASS_RIGS, RIG_CLASS, RIG_IDS, type RigId } from "./rig";
import { designIds, type DesignLayer, type Draw } from "./library";
import { AURAS as LEGACY_AURAS, LAYERS as LEGACY } from "./parts";
import { CLERIC } from "./cleric";
import { MAGE } from "./mage";
import { RANGER } from "./ranger";
import { ROGUE } from "./rogue";
import { TANK } from "./tank";
import { WARRIOR } from "./warrior";

/**
 * HERO RENDERER v2 — the whole set: every catalogue item, its class designs (variants), the independent sub-slots (pauldrons, gear, head shape,
 * facial hair — kit parts with variants of their own) and the generic drawings that let any skeleton wear any item (an admin-made class).
 *
 *   · a catalogue item's OWN layer is its generic drawing, drawn only on the skeletons that have no designs for it (a class's heroes always wear
 *     one of their class's designs; plan.variantOf picks it by tier and look);
 *   · the rarity overlay slots of hero generator 2 (trim / shoulder / crest / weaponfx) draw nothing in v2: a hero's rarity is its EQUIPMENT TIER
 *     (the design pools), not a layer of ornaments on top of Common gear. The items stay in the catalogue and in every stored look, untouched.
 */

const ALL: readonly RigId[] = RIG_IDS;
const empty = (): void => undefined;

interface Item {
  id: string;
  z: number;
  tint: TintRole | null;
  /** The generic drawing (drawn on the skeletons without designs); null = the item has no drawing of its own. */
  generic: { draw: Draw; parts?: DesignLayer[]; muzzle?: DesignLayer["muzzle"] } | null;
  designs: DesignLayer[];
  rig?: RigId;
  attack?: AttackClip;
  /**
   * Kit parts: independent sub-slots drawn with every drawing of the item, each an empty base + its designs. `none`: "nothing" is one of the
   * choices (with `weight`, at `tiers`) — otherwise the empty base only stands in on skeletons that have no designs.
   */
  kits?: Array<{ id: string; z: number; tint: TintRole | null; designs: DesignLayer[]; none?: boolean; weight?: number; tiers?: DesignLayer["tiers"] }>;
}

const legacy = (id: string): DesignLayer => {
  const l = LEGACY.find((x) => x.id === id);
  if (!l) throw new Error(`no legacy drawing for ${id}`);
  return { id: l.id, ...(l.of ? { of: l.of } : {}), z: l.z, tint: l.tint, draw: l.draw as Draw, ...(l.attack ? { attack: l.attack } : {}), ...(l.muzzle ? { muzzle: l.muzzle } : {}) };
};
/** The legacy v2 drawing of an item and its parts (classes not redrawn yet), without its old variants. */
const legacyItem = (id: string): { draw: Draw; parts: DesignLayer[]; muzzle?: DesignLayer["muzzle"] } => ({
  draw: legacy(id).draw,
  parts: LEGACY.filter((l) => l.of === id).map((l) => legacy(l.id)),
  ...(legacy(id).muzzle ? { muzzle: legacy(id).muzzle } : {}),
});

/** Skeletons that have at least one design among `designs`. */
const rigsWith = (designs: readonly DesignLayer[]): Set<RigId> => new Set(designs.filter((d) => !d.of).flatMap((d) => d.rigs ?? ALL));

function itemLayers(it: Item): DesignLayer[] {
  const designed = rigsWith(it.designs);
  // a weapon is only ever held on its own class's skeletons (its archetypes); any other item may be worn on any skeleton
  const home: readonly RigId[] = it.rig ? CLASS_RIGS[RIG_CLASS[it.rig]] : ALL;
  const genericRigs = it.generic ? home.filter((r) => !designed.has(r)) : [];
  const variants = designIds(it.designs);
  const out: DesignLayer[] = [{
    id: it.id,
    z: it.z,
    tint: it.tint,
    rigs: genericRigs,
    draw: it.generic?.draw ?? empty,
    ...(it.generic?.muzzle ? { muzzle: it.generic.muzzle } : {}),
    ...(variants.length ? { variants } : {}),
    ...(it.rig ? { rig: it.rig, builds: CLASS_RIGS[RIG_CLASS[it.rig]] } : {}),
    ...(it.attack ? { attack: it.attack } : {}),
  }];
  // the generic drawing's own parts go only with the generic drawing (a class design brings its own)
  for (const p of it.generic?.parts ?? []) out.push({ ...p, of: it.id, rigs: genericRigs, kit: false });
  out.push(...it.designs);
  for (const k of it.kits ?? []) {
    const kd = rigsWith(k.designs);
    out.push({ id: k.id, of: it.id, z: k.z, tint: k.tint, empty: true, rigs: k.none ? home : home.filter((r) => !kd.has(r)), draw: empty, variants: designIds(k.designs), ...(k.weight ? { weight: k.weight } : {}), ...(k.tiers ? { tiers: k.tiers } : {}) });
    out.push(...k.designs);
  }
  return out;
}

const ITEMS: Item[] = [
  // ---------------------------------------------------------------- outfits: torso designs + arms / legs / pauldron sub-slots
  {
    id: "outfit.medium", z: 20, tint: "primary", generic: legacyItem("outfit.medium"), designs: WARRIOR.armour,
    kits: [
      { id: "outfit.medium.arms", z: 65, tint: null, designs: WARRIOR.arms },
      { id: "outfit.medium.legs", z: 18, tint: null, designs: WARRIOR.legs },
      { id: "outfit.medium.shoulders", z: 67, tint: null, designs: WARRIOR.shoulders, none: true, weight: 4, tiers: ["COMMON", "RARE"] },
    ],
  },
  {
    id: "outfit.heavy", z: 20, tint: "primary", generic: legacyItem("outfit.heavy"), designs: TANK.armour,
    kits: [
      { id: "outfit.heavy.arms", z: 65, tint: null, designs: TANK.arms },
      { id: "outfit.heavy.legs", z: 18, tint: null, designs: TANK.legs },
      { id: "outfit.heavy.shoulders", z: 67, tint: null, designs: TANK.shoulders },
    ],
  },
  {
    id: "outfit.light", z: 20, tint: "primary", generic: legacyItem("outfit.light"), designs: [...ROGUE.armour, ...RANGER.armour],
    kits: [
      { id: "outfit.light.arms", z: 65, tint: null, designs: [...ROGUE.arms, ...RANGER.arms] },
      { id: "outfit.light.legs", z: 18, tint: null, designs: [...ROGUE.legs, ...RANGER.legs] },
      { id: "outfit.light.shoulders", z: 67, tint: null, designs: [...ROGUE.shoulders, ...RANGER.shoulders], none: true, weight: 5 },
    ],
  },
  {
    id: "outfit.robe", z: 20, tint: "primary", generic: legacyItem("outfit.robe"), designs: [...MAGE.armour, ...CLERIC.armour],
    kits: [
      { id: "outfit.robe.arms", z: 65, tint: null, designs: [...MAGE.arms, ...CLERIC.arms] },
      { id: "outfit.robe.legs", z: 18, tint: null, designs: [...MAGE.legs, ...CLERIC.legs] },
      { id: "outfit.robe.shoulders", z: 67, tint: null, designs: [...MAGE.shoulders, ...CLERIC.shoulders], none: true, weight: 6 },
    ],
  },
  // ---------------------------------------------------------------- weapons (each on its own class skeleton) + the class gear sub-slots
  {
    id: "weapon.sword", z: 70, tint: null, generic: null, designs: WARRIOR.weapon, rig: "warrior", attack: "attack_slash",
    kits: [
      { id: "weapon.sword.gear", z: 7, tint: null, designs: WARRIOR.gear, none: true, weight: 2 },
      // the duelist's buckler: drawn on that skeleton only (the empty base stands in on the others)
      { id: "weapon.sword.buckler", z: 68, tint: null, designs: WARRIOR.buckler },
    ],
  },
  {
    id: "weapon.mace", z: 70, tint: null, generic: null, designs: TANK.weapon, rig: "tank", attack: "attack_slash",
    kits: [{ id: "weapon.mace.gear", z: 7, tint: null, designs: TANK.gear, none: true, weight: 3 }],
  },
  {
    id: "weapon.daggers", z: 70, tint: null, generic: null, designs: ROGUE.weapon, rig: "rogue", attack: "attack_thrust",
    kits: [{ id: "weapon.daggers.gear", z: 9, tint: null, designs: ROGUE.gear, none: true, weight: 1 }],
  },
  {
    id: "weapon.bow", z: 70, tint: null, generic: null, designs: RANGER.weapon, rig: "ranger", attack: "attack_shoot",
    kits: [
      { id: "weapon.bow.quiver", z: 6, tint: null, designs: RANGER.quiver },
      { id: "weapon.bow.gear", z: 6, tint: null, designs: RANGER.gear, none: true, weight: 4 },
    ],
  },
  {
    id: "weapon.staff", z: 70, tint: null, generic: null, designs: MAGE.weapon, rig: "mage", attack: "attack_thrust",
    kits: [{ id: "weapon.staff.gear", z: 23, tint: null, designs: MAGE.gear, none: true, weight: 2 }],
  },
  {
    id: "weapon.tome", z: 70, tint: null, generic: null, designs: CLERIC.weapon, rig: "cleric", attack: "attack_thrust",
    kits: [{ id: "weapon.tome.gear", z: 23, tint: null, designs: CLERIC.gear, none: true, weight: 1 }],
  },
  { id: "offhand.shield", z: 68, tint: null, generic: legacyItem("offhand.shield"), designs: TANK.shield },
  // ---------------------------------------------------------------- headgear
  { id: "headgear.helm", z: 60, tint: null, generic: legacyItem("headgear.helm"), designs: [...WARRIOR.helm, ...TANK.helm] },
  { id: "headgear.hat", z: 60, tint: "primary", generic: legacyItem("headgear.hat"), designs: MAGE.hat },
  { id: "headgear.hood", z: 60, tint: "primary", generic: legacyItem("headgear.hood"), designs: ROGUE.hood },
  { id: "headgear.cap", z: 60, tint: "primary", generic: legacyItem("headgear.cap"), designs: RANGER.cap },
  { id: "headgear.halo", z: 60, tint: null, generic: legacyItem("headgear.halo"), designs: CLERIC.halo },
  { id: "headgear.crown", z: 60, tint: null, generic: legacyItem("headgear.crown"), designs: [] },
  // ---------------------------------------------------------------- cape (Epic and Legendary heroes)
  { id: "cape.default", z: 5, tint: "accent", generic: legacyItem("cape.default"), designs: [...WARRIOR.cape, ...TANK.cape, ...ROGUE.cape, ...RANGER.cape, ...MAGE.cape, ...CLERIC.cape] },
];

/** The rarity overlay slots: present (every stored look keeps naming them), drawing nothing. */
const RARITY_OVERLAYS: DesignLayer[] = COSMETIC_ITEMS.filter((i) => ["trim", "shoulder", "crest", "weaponfx"].includes(i.slot)).map((i) => ({
  id: i.id, z: i.slot === "trim" ? 23 : i.slot === "shoulder" ? 67 : i.slot === "crest" ? 62 : 71, tint: null, empty: true, draw: empty,
}));

/** Every non-aura layer of the set. */
export function setLayers(): DesignLayer[] {
  return [...BODY_LAYERS, ...ITEMS.flatMap(itemLayers), ...RARITY_OVERLAYS];
}

export const AURAS = LEGACY_AURAS;
