import { cape, type CapeSpec } from "./capes";
import { censer, hipBook, pouch, scrollCase } from "./gear";
import { belt, boots, bodyGarment, breastplate, bracers, collar, emblem, gloves, skirt, sleeves, straps, tabard, trousers } from "./garments";
import { haft, haftMuzzle, type HaftSpec } from "./hafts";
import { hat, holy, hood, type HatSpec, type HoodSpec } from "./hats";
import { helm, type HelmSpec } from "./helms";
import { M, RARITY_RAMP, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, type DesignLayer, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";

/**
 * HERO RENDERER v2 — the CLERIC's design library (skeleton `cleric`: steady, scepter upright). A Cleric reads as HOLY, and never as a Mage:
 * a HALO over every headpiece, pale vestments with a stole or a tabard and a holy sign on the chest, a short scepter crowned with a sun, a
 * star, an ankh or a cross (a Mage's staff is tall, a Cleric's scepter is short), a tome at the hip.
 *
 *   COMMON     a halo with a circlet or a laurel, a cowl, a veil; a plain robe, a robe with a tabard and a cross, a robe with an amice, a
 *              friar's habit; a sun, star, ankh or cross scepter
 *   RARE       a mitre, a diadem, a hood with a circlet, a jewelled veil; a chasuble, a war-priest's mail and tabard, a stole, a mantled
 *              robe; a lantern, a dove, a gilded sun, a jewelled cross
 *   EPIC       a crown of rays, a sun crown, a tall white mitre, a war-priest's helm under a halo; armoured vestments, a sun robe, a
 *              fur-collared robe, a templar's tabard; winged, great-sun, white-cross and holy-flame scepters; a cape
 *   LEGENDARY  a golden sun crown with rays, a diadem of light, a gilded veil, a golden mitre of stars; radiant vestments, a high priest's
 *              stole, a paladin's vestment, a seraph's robe; a radiant sun, golden wings, a golden ankh, a great star
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.cleric;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

type Head = { pieces: Piece[]; hides: Array<"hair"> };
const H = (pieces: Piece[], hides: Array<"hair"> = []): Head => ({ pieces, hides });
const halo = (y = -15.4, mat: Piece["mat"] = M.gold, size = 1) => holy("halo", mat, { y, size });
const hatH = (s: HatSpec) => hat(s);
const hoodH = (s: HoodSpec) => hood(s);
const WAR_HELM: HelmSpec = { shell: "round", mat: "metal", face: "open", band: M.gold, rivets: true };

const HEADS: Array<[string, Tier, Head]> = [
  ["circlet", 0, H([holy("circlet", M.gold, { gem: M.sapphire }), halo()])],
  ["laurel", 0, H([holy("laurel", M.gold), halo(-16.4, M.gold, 0.8)])],
  ["cowl", 0, H([...hoodH({ shape: "cowl", mat: "cloth", mantle: "plain" }), halo(-16)], ["hair"])],
  ["veil", 0, H([...hoodH({ shape: "veil", mat: M.cloth }), holy("circlet", M.bronze), halo(-16)], ["hair"])],
  ["cowlwhite", 0, H([...hoodH({ shape: "cowl", mat: "secondary", mantle: "plain", mantleMat: "primary" }), halo(-16.4)], ["hair"])],
  ["mitre", 1, H([...hatH({ crown: "mitre", mat: "secondary", band: M.gold, deco: [{ kind: "cross", mat: M.gold }] }), halo(-24, M.gold, 0.9)], ["hair"])],
  ["diadem", 1, H([holy("diadem", M.gold, { gem: M.sapphire }), halo()])],
  ["hoodcirclet", 1, H([...hoodH({ shape: "deep", mat: "primary", mantle: "plain", trim: M.gold }), holy("circlet", M.gold, { gem: M.ruby }), halo(-17)], ["hair"])],
  ["jewelveil", 1, H([...hoodH({ shape: "veil", mat: "primary", trim: M.gold }), holy("diadem", M.gold, { gem: M.ruby }), halo(-16.4)], ["hair"])],
  ["rays", 1, H([holy("circlet", M.gold), holy("rays", M.gold, { size: 0.8 })])],
  ["crownrays", 2, H([holy("circlet", M.gold, { gem: EPIC }), holy("rays", M.holy), halo(-15.4, M.holy)])],
  ["suncrown", 2, H([holy("suncrown", M.gold, { gem: EPIC }), halo(-17.6)])],
  ["whitemitre", 2, H([...hatH({ crown: "mitre", mat: M.white, height: 1.08, band: M.gold, deco: [{ kind: "cross", mat: EPIC }] }), halo(-25.4, M.gold, 0.9)], ["hair"])],
  ["warhelm", 2, H([...helm(WAR_HELM), halo(-17.4, M.holy)], ["hair"])],
  ["hooded", 2, H([...hoodH({ shape: "pointed", mat: M.white, mantle: "plain", mantleMat: "primary", trim: M.gold }), halo(-21.4, EPIC)], ["hair"])],
  ["goldensun", 3, H([holy("suncrown", M.gold, { gem: M.ruby, size: 1.2 }), holy("rays", LEGEND, { size: 1.1 }), halo(-17.6, LEGEND)])],
  ["lightdiadem", 3, H([holy("diadem", M.gold, { gem: M.sapphire }), holy("rays", M.holy, { size: 1.05 }), halo(-16, LEGEND, 1.1)])],
  ["gildedveil", 3, H([...hoodH({ shape: "veil", mat: M.white, trim: M.gold }), holy("suncrown", M.gold, { gem: M.ruby }), halo(-18, LEGEND)], ["hair"])],
  ["starmitre", 3, H([...hatH({ crown: "mitre", mat: M.gold, height: 1.1, band: M.white, deco: [{ kind: "stars", mat: LEGEND }, { kind: "cross", mat: M.white }] }), halo(-26, LEGEND, 0.95)], ["hair"])],
  ["seraph", 3, H([holy("laurel", M.gold), holy("stars", LEGEND, { size: 1 }), halo(-15.8, LEGEND, 1.1)])],
];

const ROBE = { len: 14.4, sh: 6.8, wa: 5.8, hem: 10, flow: 1, texture: "folds" as const };

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["plain", 0, [bodyGarment(20, "primary", ROBE), belt(M.leather, { w: 6.2, h: 1.8, sash: true })]],
  ["tabard", 0, [bodyGarment(20, "primary", ROBE), tabard("secondary", { w: 4, len: 13, split: false, flow: 1 }), emblem("accent", "cross", { y: -9.4 }), belt(M.leather, { w: 6.2, h: 2 })]],
  ["amice", 0, [bodyGarment(20, "primary", ROBE), collar(M.cloth, "amice"), belt("accent", { w: 6.2, h: 2.2, sash: true })]],
  ["habit", 0, [bodyGarment(20, M.leather, { ...ROBE, hem: 9.4 }), collar(M.leather, "cowl"), belt("primary", { w: 6, h: 1.6, sash: true })]],
  ["chasuble", 1, [bodyGarment(20, "primary", ROBE), tabard("secondary", { w: 6.8, len: 11, split: false, flow: 1 }), emblem(M.gold, "cross", { y: -9.6 }), belt(M.gold, { w: 6.2, h: 1.6 })]],
  ["warpriest", 1, [bodyGarment(20, "metal", { texture: "mail", len: 9, split: 5, sh: 7, wa: 6, hem: 8.6 }), tabard("primary", { w: 4.6, len: 11 }), emblem("secondary", "sun", { y: -9.6 }), belt(M.leather, { w: 6.4, buckle: M.bronze })]],
  ["stole", 1, [bodyGarment(20, "primary", ROBE), straps("secondary", { w: 1.6 }), collar(M.cloth, "amice"), belt("secondary", { w: 6.2, h: 2 })]],
  ["mantled", 1, [bodyGarment(20, "primary", ROBE), collar("secondary", "cowl"), emblem(M.gold, "sun", { y: -8.4, s: 0.8 }), belt(M.leather, { w: 6.2, buckle: M.gold })]],
  ["armoured", 2, [skirt("primary", { len: 14, w: 6.4, hem: 9.6, flow: 1, texture: "folds" }), breastplate("metal", { sh: 7.4, wa: 6.2 }), tabard("secondary", { w: 3.6, len: 12, split: false, sleeveless: true }), emblem(M.gold, "cross", { y: -10 }), belt(M.gold, { w: 6.4, h: 2 })]],
  ["sunrobe", 2, [bodyGarment(20, "primary", ROBE), emblem(EPIC, "sun", { y: -10, s: 1.15 }), collar(M.gold, "high"), belt(M.gold, { w: 6.2, h: 2, jewel: M.amethyst })]],
  ["fur", 2, [bodyGarment(20, "primary", ROBE), tabard("secondary", { w: 3.4, len: 13, split: false, sleeveless: true, flow: 1 }), collar(M.fur, "fur"), belt(M.gold, { w: 6.2, h: 2 })]],
  ["templar", 2, [bodyGarment(20, "metal", { texture: "mail", len: 12, split: 8, sh: 7.2, wa: 6.2, hem: 9.6, flow: 0.8 }), tabard(M.white, { w: 5.2, len: 12 }), emblem(EPIC, "cross", { y: -9.4, s: 1.2 }), belt(M.leather, { w: 6.4, buckle: M.gold })]],
  ["radiant", 3, [bodyGarment(20, M.white, ROBE), tabard("secondary", { w: 3.6, len: 13, split: false, sleeveless: true, flow: 1 }), emblem(M.gold, "sun", { y: -10, s: 1.2 }), collar(M.gold, "amice"), belt(M.gold, { w: 6.2, h: 2.2, jewel: M.ruby })]],
  ["highpriest", 3, [bodyGarment(20, "primary", ROBE), straps(M.gold, { cross: true, w: 1.8, studs: M.ruby }), collar(M.white, "amice"), emblem(LEGEND, "star", { y: -6, s: 0.8 }), belt(M.gold, { w: 6.2, h: 2 })]],
  ["paladin", 3, [skirt("primary", { len: 14, w: 6.4, hem: 9.6, flow: 1, texture: "folds" }), breastplate(M.white, { sh: 7.6, wa: 6.4 }), tabard("secondary", { w: 4, len: 12, split: false, sleeveless: true }), emblem(M.gold, "sun", { y: -10 }), collar(M.gold, "gorget"), belt(M.gold, { w: 6.4, jewel: M.sapphire })]],
  ["seraph", 3, [bodyGarment(20, M.white, ROBE), skirt(LEGEND, { strips: 7, len: 13, w: 6, hem: 9.8, z: 21, flow: 1 }), collar(M.white, "amice"), emblem(M.gold, "cross", { y: -9.8 }), belt(M.gold, { w: 6.2, h: 2 })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["bell", 0, [...sleeves("primary", { bell: 3.2, to: 0.75, w1: 4.4, w2: 3.8 })]],
  ["plain", 0, [...sleeves("primary", { to: 0.9, w1: 4.2, w2: 3.6 })]],
  ["cuffs", 0, [...sleeves("primary", { to: 0.75, w1: 4.2, w2: 3.6 }), ...bracers("secondary", { w: 3.8, from: 0.55 })]],
  ["mail", 1, [...sleeves("metal", { texture: "mail", to: 0.7, w1: 4.2, w2: 3.6 }), ...gloves(M.leather)]],
  ["gloved", 1, [...sleeves("primary", { bell: 3.6, to: 0.7, w1: 4.4, w2: 3.8 }), ...gloves(M.cloth)]],
  ["plated", 2, [...sleeves("primary", { to: 0.6, w1: 4.2, w2: 3.6 }), ...bracers("metal", { plate: true, w: 4 }), ...gloves("metal", { cuff: true })]],
  ["silk", 2, [...sleeves("secondary", { bell: 4, to: 0.8, w1: 4.4, w2: 3.8 }), ...gloves(M.white)]],
  ["gold", 3, [...sleeves(M.white, { bell: 4, to: 0.8, w1: 4.4, w2: 3.8 }), ...gloves(M.gold)]],
  ["paladin", 3, [...sleeves("primary", { to: 0.6, w1: 4.2, w2: 3.6 }), ...bracers(M.white, { plate: true, w: 4 }), ...gloves(M.gold, { cuff: true })]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["sandals", 0, [trousers("cloth", { w1: 4.4, w2: 3.6 }), boots(M.leather, "sandal")]],
  ["shoes", 0, [trousers("primary", { w1: 4.4, w2: 3.6 }), boots(M.darkLeather, "shoe")]],
  ["boots", 1, [trousers("cloth", { w1: 4.4, w2: 3.6 }), boots(M.leather, "boot")]],
  ["greaves", 2, [trousers("primary", { w1: 4.4, w2: 3.6 }), boots("metal", "greave")]],
  ["gold", 3, [trousers(M.white, { w1: 4.4, w2: 3.6 }), boots(M.gold, "shoe")]],
];

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["mantle", 1, { kind: "mantle", mat: "secondary" }],
  ["round", 2, { kind: "round", mat: "metal", trim: M.gold, size: 0.95 }],
  ["mantle", 2, { kind: "mantle", mat: M.white, trim: M.gold }],
  ["wing", 3, { kind: "wing", mat: M.white, trim: M.gold, size: 0.95 }],
  ["sun", 3, { kind: "sun", mat: M.white, trim: M.gold, size: 0.9 }],
];

const SCEPTER = { len: 13, below: 4, w: 2 };
const SCEPTERS: Array<[string, Tier, HaftSpec]> = [
  ["sun", 0, { ...SCEPTER, shaft: M.paleWood, wrap: M.leather, head: "sun", headMat: M.gold, light: M.holy }],
  ["star", 0, { ...SCEPTER, shaft: M.paleWood, wrap: M.leather, head: "star", headMat: M.bronze, light: M.holy, size: 0.85 }],
  ["ankh", 0, { ...SCEPTER, shaft: M.wood, wrap: M.leather, head: "ankh", headMat: M.bronze, light: M.holy }],
  ["cross", 0, { ...SCEPTER, shaft: M.wood, wrap: M.leather, head: "cross", headMat: M.iron, light: M.holy, gem: M.sapphire }],
  ["lantern", 1, { ...SCEPTER, shaft: M.darkWood, wrap: M.leather, head: "lantern", headMat: M.bronze, light: M.holy, bands: M.bronze }],
  ["dove", 1, { ...SCEPTER, shaft: M.paleWood, wrap: M.leather, head: "dove", headMat: M.white, light: M.holy, bands: M.gold }],
  ["goldsun", 1, { ...SCEPTER, shaft: M.white, wrap: M.leather, head: "sun", headMat: M.gold, light: M.holy, bands: M.gold, size: 1.1 }],
  ["jewelcross", 1, { ...SCEPTER, shaft: M.white, wrap: M.leather, head: "cross", headMat: M.gold, light: M.holy, gem: M.ruby }],
  ["wings", 2, { ...SCEPTER, shaft: M.white, wrap: M.darkLeather, head: "wings", headMat: M.gold, light: EPIC, bands: M.gold, size: 1.1 }],
  ["greatsun", 2, { ...SCEPTER, len: 14, shaft: M.gold, wrap: M.darkLeather, head: "sun", headMat: M.gold, light: EPIC, size: 1.25 }],
  ["whitecross", 2, { ...SCEPTER, shaft: M.white, wrap: M.darkLeather, head: "cross", headMat: M.white, light: EPIC, gem: M.amethyst, bands: M.gold, size: 1.1 }],
  ["holyflame", 2, { ...SCEPTER, shaft: M.gold, wrap: M.darkLeather, head: "flame", headMat: M.gold, light: M.holy, size: 1.15 }],
  ["radiant", 3, { ...SCEPTER, len: 14, shaft: M.gold, wrap: M.white, head: "sun", headMat: M.gold, light: LEGEND, gem: M.ruby, size: 1.35 }],
  ["goldwings", 3, { ...SCEPTER, len: 14, shaft: M.white, wrap: M.gold, head: "wings", headMat: M.white, light: LEGEND, bands: M.gold, size: 1.15 }],
  ["goldankh", 3, { ...SCEPTER, len: 14, shaft: M.gold, wrap: M.white, head: "ankh", headMat: M.gold, light: LEGEND, size: 1.3 }],
  ["greatstar", 3, { ...SCEPTER, len: 14, shaft: M.white, wrap: M.gold, head: "star", headMat: M.gold, light: LEGEND, gem: M.sapphire, size: 1.3 }],
];

const GEAR: Array<[string, Piece[], number]> = [
  ["tome", hipBook(M.ruby), 4],
  ["bluetome", hipBook(M.sapphire, M.white), 2],
  ["censer", censer(), 2],
  ["scrolls", [scrollCase(M.paper, M.gold)], 1],
  ["pouch", [pouch(M.leather, false)], 1],
];

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["long", 2, { cut: "long", mat: "secondary" }],
  ["hooded", 2, { cut: "hooded", mat: "primary" }],
  ["half", 2, { cut: "half", mat: "accent", clasp: M.gold }],
  ["royal", 3, { cut: "royal", mat: "secondary", collar: M.fur, clasp: M.gold, len: 14 }],
  ["radiant", 3, { cut: "long", mat: M.white, emblem: LEGEND, clasp: M.gold }],
  ["split", 3, { cut: "split", mat: "primary", lining: LEGEND, clasp: M.gold }],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] => list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.c${tier}-${name}`, tier, rigs: R, pieces }));

export const CLERIC = {
  halo: HEADS.flatMap(([name, tier, h]) => design({ id: `headgear.halo.c${tier}-${name}`, tier, rigs: R, hides: h.hides, pieces: h.pieces })),
  armour: named("outfit.robe", TORSOS),
  arms: named("outfit.robe.arms", ARMS),
  legs: named("outfit.robe.legs", LEGS),
  shoulders: PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.robe.shoulders.c${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) })),
  weapon: SCEPTERS.flatMap(([name, tier, spec]) => design({ id: `weapon.tome.c${tier}-${name}`, tier, rigs: R, rig: "cleric", attack: "attack_thrust", muzzle: haftMuzzle(spec), pieces: haft(spec) })),
  gear: GEAR.flatMap(([name, pieces, weight]) => design({ id: `weapon.tome.gear.c-${name}`, tier: 0, rigs: R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined }))),
  cape: CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.c${tier}-${name}`, tier, rigs: R, pieces: cape(spec) })),
} satisfies Record<string, DesignLayer[]>;
