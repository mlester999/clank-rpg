import { cape, type CapeSpec } from "./capes";
import { hipBook, pouch, scrollCase, vials } from "./gear";
import { belt, boots, bodyGarment, bracers, collar, emblem, gloves, skirt, sleeves, straps, tabard, trousers } from "./garments";
import { haft, haftMuzzle, type HaftSpec } from "./hafts";
import { hat, hood, type HatSpec, type HoodSpec } from "./hats";
import { M, RARITY_RAMP, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, type DesignLayer, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";

/**
 * HERO RENDERER v2 — the MAGE's design library (skeleton `mage`: tall and slight, staff planted). A Mage reads as a CASTER: a tall or
 * wide-brimmed hat, a robe to the ankles with a flaring hem, wide sleeves, a staff whose head is the class's light.
 *
 *   COMMON     a bent wizard's hat, a straight cone, a witch's wide brim, a floppy hat, a scholar's cowl; a wrap robe, an apprentice's robe,
 *              a robe with a front panel, a traveller's robe; a crystal staff, an orb crook, a living branch, a plain rod with a shard
 *   RARE       a tall arcanist's hat with a gem, a starry hat, a buckled witch hat, a turban, a moon cone; a layered robe, a flared high collar,
 *              a trimmed robe, a mantled robe; a staff of rings, a banded crystal, a moon staff, an eye staff
 *   EPIC       a stepped hat with runes, a moon-crowned hat, a plumed witch hat, a hat with an eye, a shadowed hood with glowing eyes; a rune
 *              robe, a star robe, a fur-collared robe, an arcane coat; a skull staff, a shard cluster, a gilded cage, a great crystal; a cape
 *   LEGENDARY  an astral cone, a sun-crowned tall hat, a gilded witch hat, a plumed turban, a gold-mooned hat; an astral robe, an archmage's
 *              white robe, a sorcerer's robe, a void robe; astral rings, a flame staff, a crystal of light, a golden branch
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.mage;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

type Head = { hat: HatSpec } | { hood: HoodSpec };

const HEADS: Array<[string, Tier, Head]> = [
  ["bent", 0, { hat: { crown: "bent", mat: "primary", brim: "wide", band: "accent" } }],
  ["cone", 0, { hat: { crown: "cone", mat: "primary", brim: "narrow", band: "accent" } }],
  ["witch", 0, { hat: { crown: "witch", mat: "accent", brim: "witch", band: "primary" } }],
  ["floppy", 0, { hat: { crown: "floppy", mat: "primary", brim: "narrow" } }],
  ["cowl", 0, { hood: { shape: "cowl", mat: "primary", mantle: "plain" } }],
  ["tall", 1, { hat: { crown: "tall", mat: "primary", brim: "narrow", band: "secondary", deco: [{ kind: "gem", mat: M.sapphire }] } }],
  ["starry", 1, { hat: { crown: "bent", mat: "accent", brim: "wide", band: "secondary", deco: [{ kind: "stars", mat: M.white }] } }],
  ["buckled", 1, { hat: { crown: "witch", mat: "primary", brim: "witch", band: M.darkLeather, deco: [{ kind: "buckle", mat: M.bronze }] } }],
  ["turban", 1, { hat: { crown: "turban", mat: "secondary", deco: [{ kind: "gem", mat: M.ruby }] } }],
  ["mooncone", 1, { hat: { crown: "cone", mat: "primary", brim: "wide", band: "accent", deco: [{ kind: "moon", mat: M.paper }] } }],
  ["stepped", 2, { hat: { crown: "stepped", mat: "primary", brim: "narrow", band: M.gold, deco: [{ kind: "rune", mat: EPIC }] } }],
  ["moonbent", 2, { hat: { crown: "bent", mat: "primary", height: 1.08, brim: "wide", band: M.gold, deco: [{ kind: "moon", mat: EPIC }, { kind: "star", mat: EPIC }] } }],
  ["plumed", 2, { hat: { crown: "witch", mat: "accent", brim: "witch", band: M.gold, deco: [{ kind: "plume", mat: EPIC }] } }],
  ["eye", 2, { hat: { crown: "tall", mat: "accent", brim: "narrow", band: M.gold, deco: [{ kind: "eye", mat: EPIC }] } }],
  ["shadowhood", 2, { hood: { shape: "pointed", mat: "primary", shade: true, mantle: "plain", trim: M.gold, deco: [{ kind: "eyes", mat: EPIC }] } }],
  ["astral", 3, { hat: { crown: "cone", mat: "accent", height: 1.08, brim: "wide", band: M.gold, deco: [{ kind: "stars", mat: LEGEND }, { kind: "gem", mat: M.sapphire }, { kind: "star", mat: LEGEND }] } }],
  ["suncrown", 3, { hat: { crown: "tall", mat: M.white, brim: "narrow", band: M.gold, deco: [{ kind: "sun", mat: LEGEND }] } }],
  ["gildedwitch", 3, { hat: { crown: "witch", mat: "primary", height: 1.06, brim: "witch", band: M.gold, deco: [{ kind: "stars", mat: LEGEND }, { kind: "buckle", mat: M.gold }] } }],
  ["plumedturban", 3, { hat: { crown: "turban", mat: M.white, deco: [{ kind: "plume", mat: LEGEND }, { kind: "gem", mat: M.emerald }] } }],
  ["goldmoon", 3, { hat: { crown: "bent", mat: "primary", height: 1.1, brim: "wide", band: M.gold, deco: [{ kind: "moon", mat: M.gold }, { kind: "star", mat: LEGEND }] } }],
];

const ROBE = { len: 14.4, sh: 6.6, wa: 5.6, hem: 10.6, flow: 1.2, texture: "folds" as const };

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["wrap", 0, [bodyGarment(20, "primary", ROBE), belt("cloth", { w: 6.2, h: 2.6, sash: true })]],
  ["apprentice", 0, [bodyGarment(20, "primary", { ...ROBE, hem: 9.4 }), collar("primary", "cowl"), belt(M.leather, { w: 6, buckle: M.bronze })]],
  ["panel", 0, [bodyGarment(20, "primary", ROBE), tabard("secondary", { w: 3, len: 14, split: false, sleeveless: true, flow: 1 }), belt("accent", { w: 6.2, h: 2.4 })]],
  ["traveller", 0, [bodyGarment(20, "cloth", { ...ROBE, hem: 9.8 }), belt("primary", { w: 6.2, h: 2.8, sash: true }), straps(M.leather, { w: 1.2 })]],
  ["layered", 1, [bodyGarment(20, "accent", ROBE), bodyGarment(21, "primary", { len: 12, split: 0.5, sh: 6.4, wa: 5.4, hem: 9.4, flow: 1.2 }), belt("secondary", { w: 6, h: 2.2 })]],
  ["flared", 1, [bodyGarment(20, "primary", ROBE), collar("secondary", "flare"), belt("secondary", { w: 6.2, h: 2.4, buckle: M.bronze })]],
  ["trimmed", 1, [bodyGarment(20, "primary", ROBE), straps("secondary", { cross: true, w: 1.4 }), belt("secondary", { w: 6.2, h: 2.4, sash: true })]],
  ["mantled", 1, [bodyGarment(20, "primary", ROBE), collar("accent", "cowl"), belt(M.leather, { w: 6.2, buckle: M.gold })]],
  ["rune", 2, [bodyGarment(20, "primary", ROBE), collar("accent", "flare"), emblem(EPIC, "eye", { y: -10.2 }), belt(M.gold, { w: 6.2, h: 2 })]],
  ["star", 2, [bodyGarment(20, "accent", ROBE), skirt("primary", { strips: 6, len: 13, w: 5.8, hem: 10, z: 21, flow: 1.2 }), emblem(EPIC, "star", { y: -10 }), belt(M.gold, { w: 6.2, h: 2 })]],
  ["furcollar", 2, [bodyGarment(20, "primary", ROBE), collar(M.darkFur, "fur"), belt(M.gold, { w: 6.2, h: 2.2, jewel: M.amethyst })]],
  ["arcanecoat", 2, [bodyGarment(20, "accent", { ...ROBE, len: 14, split: 9 }), bodyGarment(21, "primary", { len: 2, sh: 6, wa: 5, hem: 5.6 }), collar("primary", "flare"), belt(M.gold, { w: 6, h: 2 })]],
  ["astralrobe", 3, [bodyGarment(20, M.dark, ROBE), skirt("primary", { strips: 6, len: 13, w: 5.8, hem: 10, z: 21, flow: 1.2 }), collar(M.gold, "flare"), emblem(LEGEND, "star", { y: -10 }), belt(M.gold, { w: 6.2, h: 2, jewel: M.sapphire })]],
  ["archmage", 3, [bodyGarment(20, M.white, ROBE), tabard("primary", { w: 3.4, len: 14, split: false, sleeveless: true, flow: 1 }), emblem(M.gold, "sun", { y: -10 }), collar(M.gold, "high"), belt(M.gold, { w: 6.2, h: 2.2, jewel: M.ruby })]],
  ["sorcerer", 3, [bodyGarment(20, "primary", ROBE), straps(M.gold, { cross: true, w: 1.4, studs: M.gold }), collar("accent", "flare"), emblem(M.amethyst, "disc", { y: -9.6, s: 0.7 }), belt(M.gold, { w: 6.2, h: 2 })]],
  ["void", 3, [bodyGarment(20, "accent", ROBE), tabard(M.dark, { w: 3.2, len: 14, split: false, sleeveless: true, flow: 1 }), emblem(LEGEND, "eye", { y: -10.2 }), collar(M.dark, "flare"), belt(M.dark, { w: 6.2, h: 2.4, buckle: M.gold })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["bell", 0, [...sleeves("primary", { bell: 3.6, to: 0.75, w1: 4.4, w2: 3.8 })]],
  ["narrow", 0, [...sleeves("primary", { to: 0.9, w1: 4, w2: 3.4 }), ...bracers("cloth", { w: 3.6, from: 0.6 })]],
  ["cuffed", 0, [...sleeves("accent", { bell: 3, to: 0.7, w1: 4.2, w2: 3.6 })]],
  ["widebell", 1, [...sleeves("primary", { bell: 4.4, to: 0.8, w1: 4.6, w2: 4 })]],
  ["bracer", 1, [...sleeves("accent", { to: 0.6, w1: 4, w2: 3.4 }), ...bracers(M.leather, { w: 3.6, plate: true })]],
  ["silk", 2, [...sleeves("primary", { bell: 4, to: 0.8, w1: 4.4, w2: 3.8 }), ...gloves(M.dark)]],
  ["runed", 2, [...sleeves("accent", { to: 0.7, w1: 4, w2: 3.4 }), ...bracers(M.dark, { w: 3.8, plate: true }), ...gloves(M.dark)]],
  ["gold", 3, [...sleeves("primary", { bell: 4.4, to: 0.8, w1: 4.6, w2: 4 }), ...gloves(M.white)]],
  ["astral", 3, [...sleeves(M.dark, { bell: 4, to: 0.8, w1: 4.4, w2: 3.8 }), ...bracers(M.gold, { w: 3.6, from: 0.6 })]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["shoes", 0, [trousers("cloth", { w1: 4.2, w2: 3.6 }), boots(M.leather, "shoe")]],
  ["slippers", 0, [trousers("accent", { w1: 4.2, w2: 3.6 }), boots("primary", "shoe")]],
  ["boots", 1, [trousers("cloth", { w1: 4.2, w2: 3.6 }), boots(M.darkLeather, "boot")]],
  ["dark", 2, [trousers(M.dark, { w1: 4.2, w2: 3.6 }), boots(M.dark, "shoe")]],
  ["gold", 3, [trousers(M.dark, { w1: 4.2, w2: 3.6 }), boots(M.gold, "shoe")]],
];

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["mantle", 1, { kind: "mantle", mat: "accent" }],
  ["mantle", 2, { kind: "mantle", mat: "primary", trim: M.gold }],
  ["fur", 2, { kind: "fur", mat: M.darkFur }],
  ["gold", 3, { kind: "mantle", mat: M.gold, trim: M.gold }],
  ["star", 3, { kind: "sun", mat: M.dark, trim: M.gold, size: 0.85 }],
];

const STAFF = { len: 17, below: 11.6, w: 2.1 };
const STAFFS: Array<[string, Tier, HaftSpec]> = [
  ["crystal", 0, { ...STAFF, shaft: M.wood, wrap: M.leather, head: "crystal", headMat: M.wood, light: M.arcane, trim: M.wood }],
  ["orb", 0, { ...STAFF, shaft: M.darkWood, wrap: M.leather, head: "orb", headMat: M.darkWood, light: M.frost }],
  ["branch", 0, { ...STAFF, shaft: M.wood, head: "branch", headMat: M.wood, light: M.fel, trim: M.emerald }],
  ["rod", 0, { ...STAFF, shaft: M.paleWood, wrap: M.darkLeather, bands: M.iron, head: "shard", headMat: M.iron, light: M.arcane, size: 0.8 }],
  ["rings", 1, { ...STAFF, shaft: M.darkWood, wrap: M.leather, head: "rings", headMat: M.bronze, light: M.sapphire, bands: M.bronze }],
  ["banded", 1, { ...STAFF, shaft: M.wood, wrap: M.darkLeather, bands: M.steel, head: "crystal", headMat: M.steel, light: M.frost, trim: M.steel, size: 1.1 }],
  ["moon", 1, { ...STAFF, shaft: M.darkWood, wrap: M.leather, head: "moon", headMat: M.steel, light: M.frost }],
  ["eye", 1, { ...STAFF, shaft: M.darkWood, wrap: M.leather, head: "eye", headMat: M.bronze, light: M.ember }],
  ["skull", 2, { ...STAFF, shaft: M.dark, wrap: M.darkLeather, head: "skull", headMat: M.bone, light: EPIC, bands: M.dark, size: 1.1 }],
  ["shards", 2, { ...STAFF, shaft: M.darkWood, wrap: M.darkLeather, head: "shard", headMat: M.dark, light: EPIC, size: 1.15 }],
  ["cage", 2, { ...STAFF, shaft: M.darkWood, wrap: M.leather, head: "cage", headMat: M.gold, light: EPIC, bands: M.gold }],
  ["greatcrystal", 2, { ...STAFF, shaft: M.dark, wrap: M.darkLeather, head: "crystal", headMat: M.dark, light: EPIC, trim: M.gold, size: 1.3 }],
  ["astralrings", 3, { ...STAFF, shaft: M.white, wrap: M.gold, head: "rings", headMat: M.gold, light: LEGEND, bands: M.gold, size: 1.25 }],
  ["flame", 3, { ...STAFF, shaft: M.dark, wrap: M.darkLeather, head: "flame", headMat: M.gold, light: M.ember, bands: M.gold, size: 1.1 }],
  ["lightcrystal", 3, { ...STAFF, shaft: M.gold, wrap: M.darkLeather, head: "crystal", headMat: M.gold, light: LEGEND, trim: M.gold, size: 1.15 }],
  ["goldmoon", 3, { ...STAFF, shaft: M.white, wrap: M.gold, bands: M.gold, head: "moon", headMat: M.gold, light: LEGEND, size: 1.15 }],
];

const GEAR: Array<[string, Piece[], number]> = [
  ["book", hipBook("primary"), 3],
  ["vials", [vials()], 2],
  ["scrolls", [scrollCase()], 2],
  ["pouch", [pouch()], 1],
];

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["long", 2, { cut: "long", mat: "accent" }],
  ["hooded", 2, { cut: "hooded", mat: "primary" }],
  ["scalloped", 2, { cut: "scalloped", mat: "accent", lining: EPIC }],
  ["royal", 3, { cut: "royal", mat: "primary", collar: M.fur, clasp: M.gold, len: 14 }],
  ["feathered", 3, { cut: "feathered", mat: "accent", lining: LEGEND, clasp: M.gold }],
  ["starry", 3, { cut: "split", mat: M.dark, lining: LEGEND, emblem: LEGEND, clasp: M.gold }],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] => list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.m${tier}-${name}`, tier, rigs: R, pieces }));

export const MAGE = {
  hat: HEADS.flatMap(([name, tier, h]) => design({ id: `headgear.hat.m${tier}-${name}`, tier, rigs: R, hides: "hood" in h ? ["hair"] : [], pieces: "hat" in h ? hat(h.hat) : hood(h.hood) })),
  armour: named("outfit.robe", TORSOS),
  arms: named("outfit.robe.arms", ARMS),
  legs: named("outfit.robe.legs", LEGS),
  shoulders: PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.robe.shoulders.m${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) })),
  weapon: STAFFS.flatMap(([name, tier, spec]) => design({ id: `weapon.staff.m${tier}-${name}`, tier, rigs: R, rig: "mage", attack: "attack_thrust", muzzle: haftMuzzle(spec), pieces: haft(spec) })),
  gear: GEAR.flatMap(([name, pieces, weight]) => design({ id: `weapon.staff.gear.m-${name}`, tier: 0, rigs: R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined }))),
  cape: CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.m${tier}-${name}`, tier, rigs: R, pieces: cape(spec) })),
} satisfies Record<string, DesignLayer[]>;
