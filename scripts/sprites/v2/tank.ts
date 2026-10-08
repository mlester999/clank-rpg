import { cape, type CapeSpec } from "./capes";
import { bedroll, horn, pouch, satchel } from "./gear";
import { belt, boots, bodyGarment, bracers, breastplate, collar, emblem, fauld, gloves, legPlates, skirt, sleeves, tabard, tassets, trousers } from "./garments";
import { haft, type HaftSpec } from "./hafts";
import { helm, helmHides, type HelmSpec } from "./helms";
import { M, RARITY_RAMP, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, type DesignLayer, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";
import { shield, type ShieldSpec } from "./shields";

/**
 * HERO RENDERER v2 — the TANK's design library (skeleton `tank`: the stockiest build, shield forward). A Tank reads as a WALL: heavy and
 * closed helms (bevors over the jaw, eye slits), wide plate, big pauldrons on every Tank, a shield in front and a heavy head on a haft.
 *
 *   COMMON     iron: a bucket helm, a kettle or round helm with a bevor, a skull cap over mail; studded, scaled or padded plate; a round wooden
 *              shield, a heater, a kite, an oval; a flanged mace, a studded club, an iron ball, a warhammer
 *   RARE       steel: a sallet with bevor, a great helm, a pig-faced visor, a barbute, a barred close helm; banded plate, a crusader's surcoat;
 *              a tower shield, a spiked round shield; a morning star, a flanged steel mace, a maul, a war pick
 *   EPIC       a fortress: a horned or crested great helm, an armet, a ram helm; fluted gothic plate, a bear-fur collar; a bastion shield, a pavise;
 *              a giant spiked mace, a banded maul, a skull mace; a cape
 *   LEGENDARY  a lion, dragon, crowned or winged guard helm; white-and-gold bastion plate, dragon plate, a paladin's tabard, a colossus
 *              cuirass; a lion aegis, a winged bulwark; a lion maul, a sun hammer, a dragon mace, a titan maul
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.tank;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

const HELMS: Array<[string, Tier, HelmSpec]> = [
  ["bucket", 0, { shell: "flat", mat: "metal", face: "slit", rivets: true }],
  ["kettlebevor", 0, { shell: "kettle", mat: "metal", brim: "kettle", face: "bevor", neck: "coif" }],
  ["roundbevor", 0, { shell: "round", mat: "metal", face: "bevor", rivets: true, band: M.leather }],
  ["skullcoif", 0, { shell: "skull", mat: "metal", neck: "coif", rivets: true }],
  ["barrel", 0, { shell: "tall", mat: "metal", face: "bars", ribs: 2 }],
  ["salletbevor", 1, { shell: "sallet", mat: "metal", face: "bevor", band: M.bronze }],
  ["great", 1, { shell: "flat", mat: "metal", face: "slit", band: M.bronze, crests: [{ kind: "socket", mat: M.bronze }] }],
  ["pigface", 1, { shell: "pointed", mat: "metal", face: "visor", neck: "aventail", band: M.bronze }],
  ["barbute", 1, { shell: "barbute", mat: "metal", face: "T", neck: "gorget", rivets: true }],
  ["close", 1, { shell: "round", mat: "metal", face: "bars", neck: "gorget", band: M.bronze, rivets: true }],
  ["horned", 2, { shell: "flat", mat: "metal", face: "slit", band: M.gold, crests: [{ kind: "horns", mat: M.bone, size: 1.1 }] }],
  ["crested", 2, { shell: "flat", mat: "metal", face: "slit", band: M.gold, crests: [{ kind: "comb", mat: "metal", size: 1.2 }, { kind: "tuft", mat: EPIC, size: 1.2 }] }],
  ["armet", 2, { shell: "tall", mat: "metal", face: "visor", neck: "gorget", band: M.gold, crests: [{ kind: "plume", mat: EPIC }] }],
  ["ram", 2, { shell: "round", mat: "metal", face: "bevor", band: M.gold, crests: [{ kind: "ramhorns", mat: M.bone, size: 1.2 }] }],
  ["finned", 2, { shell: "barbute", mat: "metal", face: "T", band: M.gold, crests: [{ kind: "fin", mat: "metal", size: 1.2 }] }],
  ["lion", 3, { shell: "round", mat: M.gold, face: "bevor", crests: [{ kind: "mane", mat: LEGEND, z: 59, size: 1.12 }] }],
  ["dragon", 3, { shell: "pointed", mat: M.dark, face: "bevor", neck: "lames", band: M.gold, crests: [{ kind: "dragon", mat: M.gold, size: 1.1 }] }],
  ["crowned", 3, { shell: "flat", mat: M.white, face: "slit", crests: [{ kind: "crown", mat: M.gold, size: 1.15 }] }],
  ["winged", 3, { shell: "flat", mat: M.white, face: "slit", band: M.gold, crests: [{ kind: "wings", mat: M.white, z: 59, size: 0.8 }, { kind: "wings", mat: M.white, size: 0.92 }] }],
  ["sun", 3, { shell: "tall", mat: M.white, face: "bars", neck: "gorget", neckMat: M.gold, band: M.gold, crests: [{ kind: "fin", mat: M.gold, size: 1.1 }] }],
];

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["iron", 0, [skirt("accent", { len: 7, w: 8.4, hem: 9.6 }), breastplate("metal", { sh: 8.8, wa: 7.6 }), fauld("metal", { rows: 2, w: 8.2 }), belt(M.leather, { buckle: M.iron, w: 8.4 })]],
  ["studded", 0, [skirt("metal", { len: 8, w: 8.4, hem: 9.4, texture: "mail" }), bodyGarment(21, "primary", { texture: "studs", len: 0, sh: 8.8, wa: 7.6 }), belt(M.darkLeather, { buckle: M.iron, w: 8.4, h: 3 })]],
  ["scaled", 0, [bodyGarment(20, "metal", { texture: "scales", len: 8, sh: 8.8, wa: 7.8, hem: 9.6, split: 4 }), belt("secondary", { w: 8.6, h: 3, sash: true })]],
  ["padded", 0, [bodyGarment(20, "secondary", { texture: "quilt", len: 8, sh: 9.2, wa: 8.2, hem: 9.8, split: 3 }), breastplate("metal", { sh: 8.2, wa: 7, bottom: -4 }), belt(M.leather, { w: 8.6, buckle: M.iron })]],
  ["plated", 1, [skirt("primary", { len: 8, w: 8.4, hem: 9.8, split: true }), breastplate("metal", { sh: 9, wa: 7.8 }), fauld("metal", { rows: 3, w: 8.4 }), tassets("metal", { len: 6, w: 5.2 }), belt(M.darkLeather, { buckle: M.bronze, w: 8.6, h: 1.8, y: -3 })]],
  ["banded", 1, [bodyGarment(20, "metal", { texture: "lames", len: 8, sh: 9, wa: 8, hem: 9.6 }), tabard("secondary", { w: 3.6, len: 10, split: false, sleeveless: true }), belt(M.leather, { w: 8.6, buckle: M.bronze })]],
  ["crusader", 1, [bodyGarment(20, "metal", { texture: "mail", len: 9, sh: 8.8, wa: 7.8, hem: 9.6, split: 5 }), tabard("primary", { w: 6.4, len: 10 }), emblem("secondary", "cross", { y: -9.6, s: 1.1 }), belt(M.leather, { w: 8.6, buckle: M.bronze })]],
  ["brigandine", 1, [skirt("metal", { len: 7, w: 8.4, hem: 9.6, texture: "mail" }), bodyGarment(21, "primary", { texture: "studs", len: 0, sh: 9, wa: 8 }), fauld("metal", { rows: 2, w: 8.4, y: -2 }), tassets("metal", { len: 6, w: 5.2 }), belt(M.darkLeather, { w: 8.6, buckle: M.steel })]],
  ["fortress", 2, [skirt("secondary", { len: 9, w: 8.8, hem: 10.4, split: true }), breastplate("metal", { sh: 9.6, wa: 8.4 }), fauld("metal", { rows: 3, w: 9 }), tassets("metal", { len: 8, w: 5.8, rows: 3 }), collar("metal", "gorget"), belt(M.darkLeather, { w: 9, buckle: M.gold, h: 1.8, y: -3 })]],
  ["gothic", 2, [skirt("primary", { len: 8, w: 8.6, hem: 10 }), bodyGarment(21, "metal", { texture: "lames", len: 0, sh: 9.2, wa: 7.6 }), breastplate("metal", { sh: 8.4, wa: 7, bottom: -5 }), tassets("metal", { len: 7, w: 5.6 }), belt(M.gold, { w: 8.6, h: 1.6, y: -3 })]],
  ["bear", 2, [skirt("accent", { len: 8, w: 8.6, hem: 10, split: true }), breastplate("metal", { sh: 9.2, wa: 8 }), fauld("metal", { rows: 2, w: 8.6 }), tassets("metal", { len: 6, w: 5.4 }), collar(M.darkFur, "fur"), belt(M.leather, { w: 8.8, buckle: M.gold })]],
  ["bulwark", 2, [bodyGarment(20, "metal", { texture: "scales", len: 9, sh: 9.2, wa: 8.2, hem: 10, split: 5 }), tabard("primary", { w: 4, len: 11, split: false, sleeveless: true }), collar("metal", "gorget"), belt(M.darkLeather, { w: 9, buckle: M.gold })]],
  ["bastion", 3, [skirt("primary", { len: 9, w: 8.8, hem: 10.4, split: true }), breastplate(M.white, { sh: 9.6, wa: 8.4 }), emblem(M.gold, "sun", { y: -9.6, s: 1.1 }), fauld(M.white, { rows: 3, w: 9 }), tassets(M.white, { len: 8, w: 5.8, rows: 3 }), collar(M.gold, "gorget"), belt(M.gold, { w: 9, h: 1.8, y: -3, jewel: M.ruby })]],
  ["dragonplate", 3, [bodyGarment(20, M.dark, { texture: "scales", len: 9, sh: 9.4, wa: 8.4, hem: 10.2, split: 5 }), emblem(M.gold, "disc", { y: -10, s: 1.2 }), collar(M.gold, "gorget"), belt("primary", { w: 9, h: 3, sash: true })]],
  ["paladin", 3, [skirt("metal", { len: 9, w: 8.6, hem: 10, texture: "mail" }), breastplate(M.white, { sh: 9.4, wa: 8.2 }), tabard("primary", { w: 4.6, len: 11, split: false }), emblem(M.gold, "cross", { y: -9.4, s: 1.2 }), collar(M.fur, "fur"), belt(M.gold, { w: 9, jewel: M.sapphire })]],
  ["colossus", 3, [skirt("primary", { strips: 8, len: 9, w: 8.6, hem: 10 }), breastplate(M.bronze, { sh: 9.8, wa: 8.6, ridge: false }), fauld(M.gold, { rows: 2, w: 9 }), emblem(M.gold, "sun", { y: -10.2, s: 1.2 }), belt(M.gold, { w: 9.2, h: 2, jewel: M.ruby })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["mail", 0, [...sleeves("metal", { texture: "mail", to: 0.7, w1: 5, w2: 4.4 }), ...gloves(M.leather, { size: 1.15 })]],
  ["bracer", 0, [...sleeves("primary", { to: 0.6, w1: 5, w2: 4.4 }), ...bracers("metal", { plate: true, w: 4.6 }), ...gloves(M.leather, { size: 1.15 })]],
  ["gauntlet", 0, [...sleeves("metal", { texture: "mail", to: 0.4, w1: 5, w2: 4.4 }), ...gloves("metal", { cuff: true, size: 1.2 })]],
  ["plate", 1, [...sleeves("metal", { texture: "mail", to: 0.3, w1: 5.2, w2: 4.6 }), ...bracers("metal", { plate: true, from: 0.1, to: 0.9, w: 4.8 }), ...gloves("metal", { cuff: true, size: 1.2 })]],
  ["padded", 1, [...sleeves("primary", { texture: "quilt", to: 0.5, w1: 5.4, w2: 4.8 }), ...bracers("metal", { plate: true, w: 4.8 }), ...gloves("metal", { cuff: true, size: 1.2 })]],
  ["heavy", 2, [...sleeves("metal", { texture: "mail", to: 0.25, w1: 5.4, w2: 4.8 }), ...bracers("metal", { plate: true, from: 0.05, to: 0.92, w: 5.2 }), ...gloves("metal", { cuff: true, size: 1.3 })]],
  ["dark", 2, [...sleeves("metal", { texture: "mail", to: 0.3, w1: 5.4, w2: 4.8 }), ...bracers(M.dark, { plate: true, from: 0.05, w: 5.2 }), ...gloves(M.dark, { cuff: true, size: 1.3 })]],
  ["white", 3, [...sleeves("metal", { texture: "mail", to: 0.25, w1: 5.4, w2: 4.8 }), ...bracers(M.white, { plate: true, from: 0.05, to: 0.92, w: 5.2 }), ...gloves(M.white, { cuff: true, size: 1.3 })]],
  ["gold", 3, [...sleeves("primary", { to: 0.5, w1: 5.4, w2: 4.8 }), ...bracers(M.gold, { plate: true, w: 5.2 }), ...gloves(M.gold, { cuff: true, size: 1.3 })]],
  ["darkgold", 3, [...sleeves("metal", { texture: "mail", to: 0.3, w1: 5.4, w2: 4.8 }), ...bracers(M.dark, { plate: true, from: 0.05, w: 5.2 }), ...gloves(M.gold, { cuff: true, size: 1.3 })]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["chausses", 0, [trousers("metal", { texture: "mail", w1: 6, w2: 5 }), boots(M.darkLeather, "boot")]],
  ["greaves", 0, [trousers("cloth", { w1: 6, w2: 5 }), legPlates("metal", { knee: 2.6 }), boots(M.leather, "tall")]],
  ["padded", 0, [trousers("primary", { w1: 6.2, w2: 5.2, texture: "quilt" }), boots(M.leather, "tall")]],
  ["plate", 1, [trousers("metal", { texture: "mail", w1: 6, w2: 5 }), legPlates("metal", { thigh: true, knee: 2.8 }), boots("metal", "sabaton")]],
  ["halfplate", 1, [trousers("primary", { w1: 6, w2: 5 }), legPlates("metal", { knee: 3 }), boots(M.darkLeather, "tall")]],
  ["heavy", 2, [trousers("metal", { texture: "mail", w1: 6.2, w2: 5.2 }), legPlates("metal", { thigh: true, knee: 3.2 }), boots("metal", "sabaton")]],
  ["dark", 2, [trousers("primary", { w1: 6, w2: 5 }), legPlates(M.dark, { thigh: true, knee: 3.2 }), boots(M.dark, "sabaton")]],
  ["white", 3, [trousers("primary", { to: 0.3, w1: 6, w2: 5 }), legPlates(M.white, { thigh: true, knee: 3.2 }), boots(M.white, "sabaton")]],
  ["gold", 3, [trousers("cloth", { w1: 6, w2: 5 }), legPlates(M.gold, { thigh: true, knee: 3.2 }), boots(M.gold, "sabaton")]],
  ["dark", 3, [trousers("primary", { w1: 6, w2: 5 }), legPlates(M.dark, { thigh: true, knee: 3.4 }), boots(M.dark, "sabaton")]],
];

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["round", 0, { kind: "round", mat: "metal", size: 1.2 }],
  ["lames", 0, { kind: "lames", mat: "metal", size: 1.2 }],
  ["pad", 0, { kind: "pad", mat: M.leather, size: 1.3 }],
  ["roundtrim", 1, { kind: "round", mat: "metal", trim: M.bronze, size: 1.3 }],
  ["haute", 1, { kind: "haute", mat: "metal", trim: M.bronze, size: 1.1 }],
  ["layered", 1, { kind: "lames", mat: "metal", trim: M.bronze, size: 1.35 }],
  ["haute", 2, { kind: "haute", mat: "metal", trim: M.gold, size: 1.3 }],
  ["spiked", 2, { kind: "spiked", mat: "metal", trim: M.gold, size: 1.3 }],
  ["fur", 2, { kind: "fur", mat: M.darkFur, trim: M.gold, size: 1.35 }],
  ["lion", 3, { kind: "lion", mat: M.gold, trim: M.gold, size: 1.3 }],
  ["sun", 3, { kind: "sun", mat: M.white, trim: M.gold, size: 1.3 }],
  ["dragon", 3, { kind: "dragon", mat: M.dark, trim: M.gold, size: 1.3 }],
  ["wing", 3, { kind: "wing", mat: M.white, trim: M.gold, size: 1.2 }],
];

const MACES: Array<[string, Tier, HaftSpec]> = [
  ["flanged", 0, { len: 14, shaft: M.wood, wrap: M.leather, head: "flanged", headMat: M.iron }],
  ["club", 0, { len: 12, w: 2.6, shaft: M.darkWood, wrap: M.leather, head: "club", headMat: M.wood, size: 1.1 }],
  ["ball", 0, { len: 13, shaft: M.wood, wrap: M.leather, head: "ball", headMat: M.iron }],
  ["hammer", 0, { len: 14, shaft: M.wood, wrap: M.leather, head: "hammer", headMat: M.iron, bands: M.iron }],
  ["morningstar", 1, { len: 14, shaft: M.darkWood, wrap: M.leather, head: "spiked", headMat: M.steel, bands: M.steel }],
  ["steelflanged", 1, { len: 15, shaft: M.steel, wrap: M.leather, head: "flanged", headMat: M.steel, trim: M.bronze, size: 1.1 }],
  ["maul", 1, { len: 15, w: 2.4, shaft: M.wood, wrap: M.leather, head: "maul", headMat: M.iron, bands: M.iron }],
  ["pick", 1, { len: 15, shaft: M.darkWood, wrap: M.leather, head: "pick", headMat: M.steel, bands: M.bronze }],
  ["giantstar", 2, { len: 15, shaft: M.dark, wrap: M.darkLeather, head: "spiked", headMat: M.dark, gem: EPIC, size: 1.1 }],
  ["bandedmaul", 2, { len: 16, w: 2.4, shaft: M.darkWood, wrap: M.leather, head: "maul", headMat: M.steel, bands: M.gold, trim: M.gold, size: 1.15 }],
  ["skull", 2, { len: 15, shaft: M.darkWood, wrap: M.darkLeather, head: "skull", headMat: M.bone, light: EPIC, size: 1.2 }],
  ["warhammer", 2, { len: 16, shaft: M.steel, wrap: M.darkLeather, head: "hammer", headMat: M.dark, bands: M.gold, gem: EPIC, size: 1.15 }],
  ["lionmaul", 3, { len: 16, w: 2.4, shaft: M.white, wrap: M.leather, head: "maul", headMat: M.gold, trim: M.white, gem: M.ruby, size: 1.15 }],
  ["sunhammer", 3, { len: 16, shaft: M.gold, wrap: M.darkLeather, head: "sun", headMat: M.gold, light: LEGEND, size: 1.2 }],
  ["dragonmace", 3, { len: 16, shaft: M.dark, wrap: M.darkLeather, head: "spiked", headMat: M.gold, gem: M.ruby, bands: M.gold, size: 1.05 }],
  ["titan", 3, { len: 17, w: 2.6, shaft: M.white, wrap: M.darkLeather, head: "hammer", headMat: M.white, bands: M.gold, gem: M.sapphire, size: 1.2 }],
];

const SHIELDS: Array<[string, Tier, ShieldSpec]> = [
  ["round", 0, { shape: "round", face: M.wood, rim: M.iron, mark: "boss" }],
  ["heater", 0, { shape: "heater", face: M.crimson, rim: M.iron, mark: "chevron", markMat: M.cloth }],
  ["kite", 0, { shape: "kite", face: M.royal, rim: M.iron, mark: "boss", markMat: M.bronze }],
  ["oval", 0, { shape: "oval", face: M.darkWood, rim: M.iron, mark: "bands" }],
  ["tower", 1, { shape: "tower", face: "secondary", rim: M.steel, mark: "bands", markMat: M.steel }],
  ["spiked", 1, { shape: "spiked", face: "metal", rim: M.steel, mark: "boss", markMat: M.steel }],
  ["kitestar", 1, { shape: "kite", face: M.sable, rim: M.bronze, mark: "star", markMat: M.gold, size: 1.08 }],
  ["heatercross", 1, { shape: "heater", face: M.cloth, rim: M.steel, mark: "cross", markMat: M.crimson, size: 1.08 }],
  ["bastion", 2, { shape: "bastion", face: M.crimson, rim: M.gold, mark: "skull", markMat: M.bone, size: 1.1 }],
  ["pavise", 2, { shape: "pavise", face: M.royal, rim: M.steel, mark: "cross", markMat: M.gold, size: 1.05 }],
  ["spikedtower", 2, { shape: "tower", face: "metal", rim: M.dark, mark: "rivets", markMat: M.gold, size: 1.12 }],
  ["sunkite", 2, { shape: "kite", face: M.sable, rim: M.gold, mark: "sun", markMat: M.gold, size: 1.12 }],
  ["aegis", 3, { shape: "aegis", face: M.crimson, rim: M.gold, mark: "lion", markMat: M.gold, size: 1.15 }],
  ["wing", 3, { shape: "wing", face: M.white, rim: M.gold, mark: "sun", markMat: M.gold, size: 1.1 }],
  ["whitebastion", 3, { shape: "bastion", face: M.white, rim: M.gold, mark: "cross", markMat: M.gold, size: 1.15 }],
  ["goldtower", 3, { shape: "tower", face: M.gold, rim: M.dark, mark: "star", markMat: M.ruby, size: 1.15 }],
];

const GEAR: Array<[string, Piece[], number]> = [
  ["pouch", [pouch()], 2],
  ["satchel", [satchel()], 2],
  ["horn", [horn()], 1],
  ["bedroll", bedroll("cloth"), 1],
];

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["long", 2, { cut: "long", mat: "accent" }],
  ["short", 2, { cut: "short", mat: "primary", clasp: M.iron }],
  ["tattered", 2, { cut: "tattered", mat: "cloth" }],
  ["royal", 3, { cut: "royal", mat: "primary", collar: M.fur, clasp: M.gold, len: 14 }],
  ["herald", 3, { cut: "long", mat: "accent", emblem: LEGEND, clasp: M.gold }],
  ["split", 3, { cut: "split", mat: "primary", lining: LEGEND, clasp: M.gold }],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] => list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.t${tier}-${name}`, tier, rigs: R, pieces }));

export const TANK = {
  helm: HELMS.flatMap(([name, tier, spec]) => design({ id: `headgear.helm.t${tier}-${name}`, tier, rigs: R, hides: helmHides(spec), pieces: helm(spec) })),
  armour: named("outfit.heavy", TORSOS),
  arms: named("outfit.heavy.arms", ARMS),
  legs: named("outfit.heavy.legs", LEGS),
  shoulders: PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.heavy.shoulders.t${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) })),
  weapon: MACES.flatMap(([name, tier, spec]) => design({ id: `weapon.mace.t${tier}-${name}`, tier, rigs: R, rig: "tank", attack: "attack_slash", pieces: haft(spec) })),
  shield: SHIELDS.flatMap(([name, tier, spec]) => design({ id: `offhand.shield.t${tier}-${name}`, tier, rigs: R, pieces: shield(spec) })),
  gear: GEAR.flatMap(([name, pieces, weight]) => design({ id: `weapon.mace.gear.t-${name}`, tier: 0, rigs: R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined }))),
  cape: CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.t${tier}-${name}`, tier, rigs: R, pieces: cape(spec) })),
} satisfies Record<string, DesignLayer[]>;
