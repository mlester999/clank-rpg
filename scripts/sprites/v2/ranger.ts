import { bow, bowMuzzle, quiver, type BowSpec, type QuiverStyle } from "./bows";
import { cape, type CapeSpec } from "./capes";
import { bedroll, horn, pouch, satchel } from "./gear";
import { belt, boots, bodyGarment, bracers, collar, emblem, gloves, skirt, sleeves, straps, trousers } from "./garments";
import { hat, holy, hood, type HatSpec, type HoodSpec } from "./hats";
import { M, RARITY_RAMP, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, type DesignLayer, type Mat, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";

/**
 * HERO RENDERER v2 — the RANGER's design library (skeleton `ranger`: upright and alert, a planted draw). A Ranger reads as a WOODLANDER: a
 * feathered cap or a broad hat or a leaf-cut hood, leathers and a hunting coat, a long bow and a QUIVER (every Ranger wears one, its style is
 * its own sub-slot).
 *
 *   COMMON     a forester's cap with a feather, a broad-brimmed hat, a leaf hood, a bandana; a leather jerkin, a tunic, a padded vest, a laced
 *              hunting shirt; a flatbow, a recurve, a short dark recurve, a pale longbow
 *   RARE       a tricorne, a trimmed hood, a double-feathered cap, a wide banded hat; studded leathers, a long hunter's coat, a scaled vest, a
 *              harness; a wrapped longbow, a horn composite, a feathered recurve, a finned flatbow
 *   EPIC       an antlered hood, an owl-feather hat, a plumed beret, a wide hat with a violet plume; dark leather brigandine, a fur-collared
 *              forest coat, a mail shirt under a tunic; a great bow, a bone reflex bow, a runed composite, an elven bow; a cape
 *   LEGENDARY  a stag-crowned hood, a golden leaf circlet, an eagle-feather hat, an elven cowl; elven leaf armour, a wildwood coat,
 *              dragonhide, a sun coat; a leaf bow, a sun bow, a dragon-bone bow, a runed great bow
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.ranger;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

type Head = { hat: HatSpec } | { hood: HoodSpec } | { laurel: true };
const RED_FEATHER: Mat = M.ruby;

const HEADS: Array<[string, Tier, Head]> = [
  ["cap", 0, { hat: { crown: "forester", mat: "primary", brim: "turned", deco: [{ kind: "feather", mat: RED_FEATHER }] } }],
  ["brimmed", 0, { hat: { crown: "brimmed", mat: M.leather, brim: "front", band: M.darkLeather } }],
  ["leafhood", 0, { hood: { shape: "leaf", mat: "primary", mantle: "leaf" } }],
  ["bandana", 0, { hood: { shape: "bandana", mat: "secondary" } }],
  ["capsimple", 0, { hat: { crown: "cap", mat: "cloth", brim: "turned", deco: [{ kind: "feather", mat: "secondary" }] } }],
  ["tricorne", 1, { hat: { crown: "tricorne", mat: M.darkLeather, band: "secondary", deco: [{ kind: "feather", mat: RED_FEATHER }] } }],
  ["trimhood", 1, { hood: { shape: "pointed", mat: "primary", mantle: "leaf", trim: "secondary" } }],
  ["twofeather", 1, { hat: { crown: "forester", mat: "primary", brim: "turned", band: "secondary", deco: [{ kind: "feather", mat: RED_FEATHER }, { kind: "plume", mat: M.white }] } }],
  ["widehat", 1, { hat: { crown: "brimmed", mat: "cloth", brim: "wide", band: M.leather, deco: [{ kind: "feather", mat: M.darkFur }] } }],
  ["chaperon", 1, { hood: { shape: "chaperon", mat: "primary", mantle: "plain" } }],
  ["antlers", 2, { hood: { shape: "deep", mat: "primary", mantle: "leaf", deco: [{ kind: "horns", mat: M.bone }] } }],
  ["owl", 2, { hat: { crown: "brimmed", mat: M.leather, brim: "front", band: EPIC, deco: [{ kind: "plume", mat: M.fur }] } }],
  ["beret", 2, { hat: { crown: "beret", mat: "primary", band: M.gold, deco: [{ kind: "plume", mat: EPIC }] } }],
  ["violetplume", 2, { hat: { crown: "brimmed", mat: "primary", brim: "wide", band: M.gold, deco: [{ kind: "plume", mat: EPIC }] } }],
  ["furhood", 2, { hood: { shape: "cowl", mat: "primary", mantle: "fur", mantleMat: M.darkFur, trim: M.gold } }],
  ["stag", 3, { hood: { shape: "deep", mat: "primary", mantle: "leaf", trim: M.gold, deco: [{ kind: "horns", mat: M.gold }] } }],
  ["leafcrown", 3, { laurel: true }],
  ["eagle", 3, { hat: { crown: "forester", mat: "primary", brim: "turned", band: M.gold, deco: [{ kind: "plume", mat: LEGEND }, { kind: "feather", mat: M.white }] } }],
  ["elvencowl", 3, { hood: { shape: "cowl", mat: "primary", mantle: "leaf", trim: M.gold, deco: [{ kind: "brooch", mat: M.emerald }] } }],
  ["sunhat", 3, { hat: { crown: "brimmed", mat: M.white, brim: "wide", band: M.gold, deco: [{ kind: "sun", mat: LEGEND }, { kind: "plume", mat: M.gold }] } }],
];

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["jerkin", 0, [bodyGarment(20, M.leather, { len: 4, sh: 7, wa: 5.8, hem: 6.8 }), belt(M.darkLeather, { buckle: M.bronze, w: 6.6, pouch: M.leather })]],
  ["tunic", 0, [bodyGarment(20, "primary", { len: 7, split: 4, sh: 6.8, wa: 5.8, hem: 7.6 }), belt(M.leather, { buckle: M.bronze, w: 6.4 })]],
  ["padded", 0, [bodyGarment(20, "cloth", { texture: "quilt", len: 4, sh: 7, wa: 6, hem: 7 }), belt(M.leather, { buckle: M.iron, w: 6.6 })]],
  ["laced", 0, [bodyGarment(20, "primary", { len: 3, sh: 6.8, wa: 5.6, hem: 6.6 }), collar(M.leather, "high"), straps(M.leather, { w: 1.6 }), belt(M.leather, { w: 6.4, buckle: M.bronze })]],
  ["studded", 1, [bodyGarment(20, M.leather, { texture: "studs", len: 5, split: 3, sh: 7, wa: 6, hem: 7.2 }), belt(M.darkLeather, { buckle: M.steel, w: 6.6 })]],
  ["huntercoat", 1, [bodyGarment(20, "primary", { len: 11, split: 7, flow: 1, sh: 7, wa: 5.8, hem: 9 }), collar(M.leather, "high"), belt(M.leather, { buckle: M.bronze, w: 6.4, pouch: M.leather })]],
  ["scalevest", 1, [bodyGarment(20, "primary", { len: 6, split: 3, sh: 6.8, wa: 5.8, hem: 7.4 }), bodyGarment(21, M.leather, { texture: "scales", len: 0, sh: 6.4, wa: 5.4 }), belt(M.darkLeather, { w: 6.4, buckle: M.bronze })]],
  ["harness", 1, [bodyGarment(20, "primary", { len: 5, sh: 6.8, wa: 5.8, hem: 7 }), straps(M.leather, { cross: true, w: 1.6, studs: M.bronze }), belt(M.leather, { buckle: M.bronze, w: 6.6 })]],
  ["brigandine", 2, [bodyGarment(20, M.darkLeather, { texture: "studs", len: 6, split: 3, sh: 7.2, wa: 6.2, hem: 7.6 }), belt("primary", { w: 6.6, h: 2.8, sash: true })]],
  ["forestcoat", 2, [bodyGarment(20, "primary", { len: 11, split: 7, flow: 1, sh: 7.2, wa: 6, hem: 9.2 }), collar(M.darkFur, "fur"), belt(M.leather, { buckle: M.gold, w: 6.4 })]],
  ["mailshirt", 2, [bodyGarment(20, "metal", { texture: "mail", len: 7, split: 4, sh: 7, wa: 6, hem: 7.8 }), bodyGarment(21, "primary", { len: 3, sh: 6.4, wa: 5.6, hem: 6.6 }), belt(M.leather, { w: 6.6, buckle: M.gold })]],
  ["warden", 2, [bodyGarment(20, M.leather, { len: 7, split: 4, sh: 7, wa: 6, hem: 7.8 }), straps("primary", { w: 2.4 }), emblem(EPIC, "tree", { y: -10, s: 0.8 }), belt(M.darkLeather, { w: 6.6, buckle: M.gold })]],
  ["leafarmour", 3, [bodyGarment(20, "primary", { texture: "scales", len: 7, split: 4, sh: 7.2, wa: 6, hem: 8 }), emblem(M.gold, "tree", { y: -10.2 }), collar(M.gold, "high"), belt(M.gold, { w: 6.6, h: 2, jewel: M.emerald })]],
  ["wildwood", 3, [bodyGarment(20, "primary", { len: 12, split: 8, flow: 1.1, sh: 7.2, wa: 6, hem: 9.6 }), collar(M.fur, "fur"), straps(M.gold, { w: 1.4 }), belt(M.leather, { w: 6.6, buckle: M.gold })]],
  ["dragonhide", 3, [bodyGarment(20, M.dark, { texture: "scales", len: 6, split: 3, sh: 7.2, wa: 6.2, hem: 7.6 }), emblem(M.gold, "disc", { y: -10, s: 0.8 }), belt("primary", { w: 6.6, h: 2.8, sash: true })]],
  ["suncoat", 3, [bodyGarment(20, M.white, { len: 10, split: 6, flow: 1, sh: 7, wa: 5.8, hem: 9 }), skirt("primary", { strips: 5, len: 5, w: 6, hem: 7, z: 21 }), emblem(M.gold, "sun", { y: -10 }), belt(M.gold, { w: 6.4, jewel: M.ruby })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["bracer", 0, [...sleeves("primary", { to: 0.6, w1: 4, w2: 3.4 }), ...bracers(M.leather, { w: 3.6 })]],
  ["shirt", 0, [...sleeves("cloth", { to: 0.85, w1: 4, w2: 3.4 }), ...gloves(M.leather)]],
  ["archer", 0, [...sleeves("primary", { to: 0.4, w1: 4, w2: 3.4 }), ...bracers(M.darkLeather, { w: 3.8, from: 0.1 })]],
  ["leather", 1, [...sleeves(M.leather, { to: 0.5, w1: 4, w2: 3.4 }), ...bracers(M.darkLeather, { w: 3.8, plate: true }), ...gloves(M.leather)]],
  ["studded", 1, [...sleeves("primary", { to: 0.7, w1: 4, w2: 3.4 }), ...bracers(M.leather, { w: 3.8, plate: true, from: 0.15 })]],
  ["mail", 2, [...sleeves("metal", { texture: "mail", to: 0.5, w1: 4, w2: 3.4 }), ...bracers(M.darkLeather, { w: 3.8, plate: true }), ...gloves(M.darkLeather)]],
  ["fur", 2, [...sleeves("primary", { to: 0.7, w1: 4.2, w2: 3.6 }), ...bracers(M.darkFur, { w: 4.2, from: 0.3 })]],
  ["gold", 3, [...sleeves("primary", { to: 0.6, w1: 4, w2: 3.4 }), ...bracers(M.gold, { w: 3.8, plate: true, from: 0.15 }), ...gloves(M.leather)]],
  ["elven", 3, [...sleeves(M.white, { to: 0.8, w1: 4, w2: 3.4 }), ...bracers("primary", { w: 3.8, plate: true }), ...gloves(M.gold)]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["boots", 0, [trousers("cloth", { w1: 4.8, w2: 4 }), boots(M.leather, "tall")]],
  ["wrapped", 0, [trousers("primary", { w1: 4.8, w2: 4 }), boots(M.leather, "wrap")]],
  ["leather", 0, [trousers(M.leather, { w1: 4.8, w2: 4 }), boots(M.darkLeather, "boot")]],
  ["hunter", 1, [trousers("primary", { w1: 4.8, w2: 4 }), boots(M.darkLeather, "tall", M.leather)]],
  ["strapped", 1, [trousers("cloth", { w1: 4.8, w2: 4, texture: "wrap" }), boots(M.leather, "tall")]],
  ["fur", 2, [trousers("primary", { w1: 4.8, w2: 4 }), boots(M.darkLeather, "tall", M.fur)]],
  ["greaves", 2, [trousers(M.leather, { w1: 4.8, w2: 4 }), boots(M.darkLeather, "greave")]],
  ["gold", 3, [trousers("primary", { w1: 4.8, w2: 4 }), boots(M.darkLeather, "tall", M.gold)]],
  ["elven", 3, [trousers(M.white, { w1: 4.8, w2: 4 }), boots("primary", "tall", M.gold)]],
];

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["pad", 0, { kind: "pad", mat: M.leather, size: 0.9 }],
  ["leather", 1, { kind: "lames", mat: M.leather, size: 0.9 }],
  ["fur", 1, { kind: "fur", mat: M.darkFur, size: 0.9 }],
  ["mantle", 2, { kind: "mantle", mat: "primary", size: 0.95 }],
  ["scale", 2, { kind: "scale", mat: M.leather, trim: M.gold, size: 0.9 }],
  ["leaf", 3, { kind: "wing", mat: "primary", trim: M.gold, size: 0.9 }],
  ["gold", 3, { kind: "round", mat: M.gold, trim: M.gold, size: 0.9 }],
];

const BOWS: Array<[string, Tier, BowSpec]> = [
  ["flat", 0, { shape: "flat", mat: M.wood, grip: M.leather }],
  ["recurve", 0, { shape: "recurve", mat: M.wood, grip: M.leather }],
  ["dark", 0, { shape: "recurve", mat: M.darkWood, grip: M.darkLeather, tips: M.iron }],
  ["long", 0, { shape: "long", mat: M.paleWood, grip: M.leather }],
  ["wrapped", 1, { shape: "long", mat: M.paleWood, grip: M.darkLeather, deco: "wrap", decoMat: M.leather, tips: M.bronze }],
  ["horn", 1, { shape: "composite", mat: M.bone, grip: M.leather, tips: M.darkWood }],
  ["feathered", 1, { shape: "recurve", mat: M.wood, grip: M.leather, deco: "feathers", decoMat: M.white, fletch: "#f4f4f8" }],
  ["finned", 1, { shape: "flat", mat: M.darkWood, grip: M.leather, deco: "fins", decoMat: M.steel, tips: M.steel }],
  ["great", 2, { shape: "great", mat: M.darkWood, grip: M.darkLeather, deco: "gems", decoMat: EPIC, tips: M.gold, fletch: "#b366ff" }],
  ["reflex", 2, { shape: "reflex", mat: M.bone, grip: M.darkLeather, tips: M.gold, deco: "wrap", decoMat: M.gold }],
  ["runed", 2, { shape: "composite", mat: M.dark, grip: M.leather, deco: "runes", decoMat: EPIC, tips: M.dark, fletch: "#b366ff" }],
  ["elven", 2, { shape: "elven", mat: M.paleWood, grip: M.leather, deco: "leaves", decoMat: M.emerald }],
  ["leafbow", 3, { shape: "elven", mat: M.white, grip: M.gold, deco: "leaves", decoMat: M.gold, tips: M.gold, string: "#ffe08a", fletch: "#ffb020" }],
  ["sunbow", 3, { shape: "great", mat: M.gold, grip: M.darkLeather, deco: "gems", decoMat: M.ruby, tips: M.white, string: "#ffe08a", fletch: "#ffb020" }],
  ["dragonbone", 3, { shape: "reflex", mat: M.bone, grip: M.dark, deco: "fins", decoMat: M.dark, tips: M.ruby, fletch: "#e0455a" }],
  ["stormbow", 3, { shape: "great", mat: M.dark, grip: M.gold, deco: "runes", decoMat: LEGEND, tips: M.gold, string: "#ffe08a", fletch: "#ffb020" }],
];

const QUIVERS: Array<[string, Tier, QuiverStyle, Mat, readonly string[]]> = [
  ["back", 0, "back", M.leather, ["#e0455a", "#f4f4f8", "#e0455a"]],
  ["hip", 0, "hip", M.leather, ["#f4f4f8", "#c9b48a", "#f4f4f8"]],
  ["bundle", 0, "bundle", M.darkLeather, ["#3f7d4e", "#f4f4f8", "#3f7d4e", "#f4f4f8", "#3f7d4e"]],
  ["dark", 1, "back", M.darkLeather, ["#f4f4f8", "#f4f4f8", "#f4f4f8"]],
  ["hipred", 1, "hip", M.darkLeather, ["#e0455a", "#e0455a", "#e0455a"]],
  ["fur", 2, "fur", M.leather, ["#b366ff", "#f4f4f8", "#b366ff"]],
  ["violet", 2, "back", M.dark, ["#b366ff", "#b366ff", "#f4f4f8"]],
  ["ornate", 3, "ornate", M.darkLeather, ["#ffb020", "#f4f4f8", "#ffb020", "#f4f4f8"]],
  ["gold", 3, "fur", M.darkLeather, ["#ffb020", "#ffb020", "#ffb020"]],
];

const GEAR: Array<[string, Piece[], number]> = [
  ["bedroll", bedroll("cloth"), 2],
  ["horn", [horn()], 2],
  ["pouch", [pouch()], 1],
  ["satchel", [satchel()], 1],
];

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["hooded", 2, { cut: "hooded", mat: "primary" }],
  ["long", 2, { cut: "long", mat: "accent" }],
  ["leafcloak", 2, { cut: "scalloped", mat: "primary", lining: EPIC }],
  ["feathered", 3, { cut: "feathered", mat: "primary", lining: LEGEND, clasp: M.gold }],
  ["hoodedgold", 3, { cut: "hooded", mat: "accent", clasp: M.gold }],
  ["royal", 3, { cut: "royal", mat: "primary", collar: M.fur, clasp: M.gold, len: 12 }],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] => list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.g${tier}-${name}`, tier, rigs: R, pieces }));

export const RANGER = {
  cap: HEADS.flatMap(([name, tier, h]) =>
    design({
      id: `headgear.cap.g${tier}-${name}`, tier, rigs: R,
      hides: "hood" in h && h.hood.shape !== "bandana" ? ["hair"] : [],
      // the elven laurel: bare-headed, the hero's own hair showing under a gold leaf circlet with a jewel
      pieces: "hat" in h ? hat(h.hat) : "hood" in h ? hood(h.hood) : [holy("laurel", M.gold), holy("diadem", M.gold, { gem: M.emerald, z: 62 })],
    }),
  ),
  armour: named("outfit.light", TORSOS),
  arms: named("outfit.light.arms", ARMS),
  legs: named("outfit.light.legs", LEGS),
  shoulders: PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.light.shoulders.g${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) })),
  weapon: BOWS.flatMap(([name, tier, spec]) => design({ id: `weapon.bow.g${tier}-${name}`, tier, rigs: R, rig: "ranger", attack: "attack_shoot", muzzle: bowMuzzle, pieces: bow(spec) })),
  quiver: QUIVERS.flatMap(([name, tier, style, mat, fletch]) => design({ id: `weapon.bow.quiver.g${tier}-${name}`, tier, rigs: R, pieces: quiver(style, mat, { fletch }) })),
  gear: GEAR.flatMap(([name, pieces, weight]) => design({ id: `weapon.bow.gear.g-${name}`, tier: 0, rigs: R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined }))),
  cape: CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.g${tier}-${name}`, tier, rigs: R, pieces: cape(spec) })),
} satisfies Record<string, DesignLayer[]>;
