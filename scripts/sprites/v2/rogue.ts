import { bladePair, type BladeSpec } from "./blades";
import { cape, type CapeSpec } from "./capes";
import { knifeBandolier, pouch, satchel, vials } from "./gear";
import { belt, boots, bodyGarment, bracers, collar, emblem, gloves, skirt, sleeves, straps, trousers } from "./garments";
import { hat, hood, type HoodSpec } from "./hats";
import { circle, lit, M, poly, RARITY_RAMP, sub, torso, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, piece, type DesignLayer, type Mat, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";

/**
 * HERO RENDERER v2 — the ROGUE's design library (skeleton `rogue`: slim, long-legged, a low crouch). A Rogue reads as LIGHT and HIDDEN: a hood
 * and a mask, a narrow dark body, two short blades, something trailing (a sash, a tattered hem). Masks and hoods are the class's faces.
 *
 *   COMMON     a deep hood, a cowl, a bandana or a head-wrap with a cloth mask; a laced jerkin, a vest over a shirt, a wrapped tunic, a short
 *              leather coat; curved daggers, straight daggers, kukris, stilettos
 *   RARE       a liripipe hood, a half mask, a chaperon, a tattered mantle; a studded vest, a long coat, a strap harness, a padded jack;
 *              parrying daggers, krises, long knives, hooked blades
 *   EPIC       a horned hood, a fur-mantled hood, glowing eyes in the shadow; an assassin's long coat, dark scale, a bandolier vest; black
 *              blades with a violet edge, serrated fangs, twin dark kukris; a cape
 *   LEGENDARY  a shadow hood with burning eyes, a gilded horned hood, a crowned cowl; a night-silk coat with a gold eye, dragonhide, a
 *              jewelled harness; gold krises, frost needles, shadow fangs, jewelled stilettos
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.rogue;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

/** Hoods (masked) — and two HATS that leave the face in the open: a low wide brim over the eyes, a cocked tricorne. */
const HOODS: Array<[string, Tier, HoodSpec | Piece[]]> = [
  ["deep", 0, { shape: "deep", mat: "primary", mask: "lower", maskMat: "accent", shade: true }],
  ["cowl", 0, { shape: "cowl", mat: "cloth", mask: "nose", maskMat: "primary", shade: true }],
  ["bandana", 0, { shape: "bandana", mat: "primary", mask: "lower", maskMat: "primary" }],
  ["wrap", 0, { shape: "wrap", mat: "cloth", mask: "nose", maskMat: "cloth" }],
  ["pointed", 0, { shape: "pointed", mat: "primary", shade: true, mantle: "plain" }],
  ["brimmed", 0, hat({ crown: "brimmed", mat: "accent", brim: "wide", band: M.darkLeather, height: 0.8 })],
  ["liripipe", 1, { shape: "liripipe", mat: "primary", mask: "lower", maskMat: "accent", shade: true }],
  ["halfmask", 1, { shape: "deep", mat: "accent", mask: "half", maskMat: M.darkLeather, shade: true }],
  ["chaperon", 1, { shape: "chaperon", mat: "primary", mask: "nose", maskMat: "accent", shade: true }],
  ["tattered", 1, { shape: "pointed", mat: "primary", mask: "lower", maskMat: "accent", mantle: "tattered", shade: true }],
  ["trimmed", 1, { shape: "cowl", mat: "accent", mask: "nose", maskMat: "primary", trim: "secondary", shade: true }],
  ["tricorne", 1, hat({ crown: "tricorne", mat: "primary", brim: "turned", band: M.darkLeather, deco: [{ kind: "feather", mat: "cloth" }] })],
  ["horned", 2, { shape: "horned", mat: "primary", mask: "lower", maskMat: M.dark, shade: true, deco: [{ kind: "horns", mat: M.dark }, { kind: "eyes", mat: EPIC }] }],
  ["furmantle", 2, { shape: "deep", mat: "accent", mask: "nose", maskMat: "primary", mantle: "fur", mantleMat: M.darkFur, shade: true }],
  ["violet", 2, { shape: "liripipe", mat: "primary", mask: "half", maskMat: M.dark, trim: EPIC, shade: true }],
  ["brooch", 2, { shape: "pointed", mat: "accent", mask: "lower", maskMat: M.darkLeather, mantle: "tattered", shade: true, deco: [{ kind: "brooch", mat: EPIC }] }],
  ["runewrap", 2, { shape: "wrap", mat: M.dark, mask: "half", maskMat: "primary", deco: [{ kind: "rune", mat: EPIC }] }],
  ["shadow", 3, { shape: "deep", mat: M.dark, mask: "lower", maskMat: "primary", shade: true, deco: [{ kind: "eyes", mat: LEGEND }] }],
  ["gildedhorns", 3, { shape: "horned", mat: "primary", mask: "lower", maskMat: M.dark, shade: true, deco: [{ kind: "horns", mat: M.gold }, { kind: "eyes", mat: LEGEND }] }],
  ["crowned", 3, { shape: "cowl", mat: M.dark, mask: "nose", maskMat: "primary", shade: true, deco: [{ kind: "circlet", mat: M.gold }] }],
  ["nightveil", 3, { shape: "liripipe", mat: "accent", mask: "lower", maskMat: M.dark, mantle: "tattered", mantleMat: M.dark, shade: true, deco: [{ kind: "pin", mat: M.gold }] }],
  ["serpent", 3, { shape: "pointed", mat: M.dark, mask: "half", maskMat: "primary", mantle: "leaf", mantleMat: "primary", shade: true, deco: [{ kind: "brooch", mat: M.emerald }] }],
];

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["jerkin", 0, [bodyGarment(20, "primary", { len: 3, sh: 6.6, wa: 5.6, hem: 6.4 }), straps(M.darkLeather, { w: 1.2 }), belt(M.darkLeather, { buckle: M.iron, w: 6.4, h: 2.2 })]],
  ["vest", 0, [bodyGarment(20, "cloth", { len: 2, sh: 6.4, wa: 5.4, hem: 6 }), bodyGarment(21, M.darkLeather, { len: 1, sh: 5.6, wa: 4.8, hem: 5.4 }), belt("primary", { w: 6.2, h: 2.6, sash: true })]],
  ["tunic", 0, [bodyGarment(20, "primary", { len: 6, split: 3, sh: 6.4, wa: 5.4, hem: 7 }), belt("accent", { w: 6.2, h: 2.8, sash: true })]],
  ["shortcoat", 0, [bodyGarment(20, M.leather, { len: 5, split: 2, sh: 6.8, wa: 5.6, hem: 7 }), collar(M.leather, "high"), belt(M.darkLeather, { buckle: M.iron, w: 6.4 })]],
  ["studded", 1, [bodyGarment(20, "primary", { texture: "studs", len: 3, sh: 6.8, wa: 5.6, hem: 6.6 }), belt(M.darkLeather, { buckle: M.steel, w: 6.4, pouch: M.leather })]],
  ["longcoat", 1, [bodyGarment(20, "primary", { len: 11, split: 7, flow: 1.1, sh: 6.6, wa: 5.4, hem: 8.6 }), collar("primary", "high"), belt(M.darkLeather, { buckle: M.steel, w: 6.2 })]],
  ["harness", 1, [bodyGarment(20, "cloth", { len: 4, sh: 6.4, wa: 5.4, hem: 6.4 }), straps(M.darkLeather, { cross: true, w: 1.4, studs: M.steel }), belt(M.darkLeather, { buckle: M.steel, w: 6.4, h: 2.4 })]],
  ["jack", 1, [bodyGarment(20, "primary", { texture: "quilt", len: 5, split: 2, sh: 6.8, wa: 5.8, hem: 7 }), belt("accent", { w: 6.4, h: 2.6, sash: true })]],
  ["assassin", 2, [bodyGarment(20, M.dark, { len: 12, split: 8, flow: 1.2, sh: 6.8, wa: 5.4, hem: 9 }), straps("primary", { w: 1.6 }), collar(M.dark, "high"), belt(M.darkLeather, { buckle: M.steel, w: 6.2 })]],
  ["darkscale", 2, [bodyGarment(20, M.dark, { texture: "scales", len: 4, sh: 6.8, wa: 5.6, hem: 6.8 }), belt("primary", { w: 6.4, h: 2.8, sash: true })]],
  ["bandolier", 2, [bodyGarment(20, "primary", { len: 4, sh: 6.6, wa: 5.6, hem: 6.6 }), straps(M.darkLeather, { cross: true, w: 1.8, studs: M.steel }), belt(M.darkLeather, { buckle: M.steel, w: 6.4, pouch: M.darkLeather })]],
  ["wraps", 2, [bodyGarment(20, "accent", { len: 7, split: 4, sh: 6.6, wa: 5.4, hem: 7.6, flow: 0.8 }), bodyGarment(21, "primary", { len: 1, sh: 5.8, wa: 5, hem: 5.4 }), belt("primary", { w: 6.2, h: 3, sash: true })]],
  ["nightsilk", 3, [bodyGarment(20, "primary", { len: 12, split: 8, flow: 1.2, sh: 6.8, wa: 5.4, hem: 9 }), collar(M.dark, "high"), emblem(LEGEND, "eye", { y: -10.4 }), belt(M.dark, { w: 6.2, h: 2, jewel: M.emerald })]],
  ["dragonhide", 3, [bodyGarment(20, M.dark, { texture: "scales", len: 5, split: 2, sh: 7, wa: 5.8, hem: 7.2 }), straps(M.gold, { w: 1.2 }), belt("primary", { w: 6.4, h: 2.8, sash: true })]],
  ["jewelled", 3, [bodyGarment(20, "accent", { len: 4, sh: 6.6, wa: 5.6, hem: 6.6 }), straps(M.darkLeather, { cross: true, w: 1.4, studs: M.gold }), emblem(M.ruby, "disc", { y: -9.6, s: 0.6 }), belt(M.darkLeather, { w: 6.4, h: 2.2, jewel: M.ruby })]],
  ["shadowcoat", 3, [bodyGarment(20, M.dark, { len: 10, split: 6, flow: 1.2, sh: 6.8, wa: 5.4, hem: 8.6 }), skirt(LEGEND, { strips: 5, len: 4, w: 5.6, hem: 6, z: 21 }), collar(M.gold, "high"), belt(M.dark, { w: 6.2, buckle: M.gold })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["cloth", 0, [...sleeves("primary", { to: 0.7, w1: 3.8, w2: 3.2 }), ...bracers(M.leather, { w: 3.4 })]],
  ["wraps", 0, [...sleeves("cloth", { to: 0.3, w1: 3.6, w2: 3 }), ...bracers("cloth", { w: 3.2, from: 0.2, to: 0.9 })]],
  ["fingerless", 0, [...sleeves("accent", { to: 0.8, w1: 3.8, w2: 3.2 }), ...gloves(M.darkLeather)]],
  ["leather", 1, [...sleeves("primary", { to: 0.5, w1: 3.8, w2: 3.2 }), ...bracers(M.darkLeather, { w: 3.6, from: 0.15 }), ...gloves(M.darkLeather)]],
  ["studded", 1, [...sleeves("accent", { to: 0.6, w1: 3.8, w2: 3.2 }), ...bracers(M.leather, { w: 3.6, plate: true }), ...gloves(M.leather)]],
  ["dark", 2, [...sleeves(M.dark, { to: 0.6, w1: 3.8, w2: 3.2 }), ...bracers(M.dark, { w: 3.8, plate: true, from: 0.1 }), ...gloves(M.darkLeather)]],
  ["silk", 2, [...sleeves("primary", { to: 0.9, w1: 4, w2: 3.4 }), ...gloves(M.dark)]],
  ["gold", 3, [...sleeves(M.dark, { to: 0.6, w1: 3.8, w2: 3.2 }), ...bracers(M.gold, { w: 3.6, plate: true, from: 0.15 }), ...gloves(M.dark)]],
  ["night", 3, [...sleeves("primary", { to: 0.9, w1: 4, w2: 3.4 }), ...bracers(M.dark, { w: 3.8, from: 0.4 }), ...gloves(M.gold)]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["soft", 0, [trousers("cloth", { w1: 4.6, w2: 3.8 }), boots(M.darkLeather, "boot")]],
  ["wrapped", 0, [trousers("primary", { w1: 4.6, w2: 3.8 }), boots(M.leather, "wrap")]],
  ["dark", 0, [trousers("accent", { w1: 4.6, w2: 3.8 }), boots(M.leather, "boot")]],
  ["tall", 1, [trousers("primary", { w1: 4.6, w2: 3.8 }), boots(M.darkLeather, "tall")]],
  ["strapped", 1, [trousers("cloth", { w1: 4.6, w2: 3.8, texture: "wrap" }), boots(M.darkLeather, "tall")]],
  ["shadow", 2, [trousers(M.dark, { w1: 4.6, w2: 3.8 }), boots(M.darkLeather, "tall")]],
  ["violet", 2, [trousers("primary", { w1: 4.6, w2: 3.8 }), boots(M.dark, "tall", EPIC)]],
  ["gold", 3, [trousers(M.dark, { w1: 4.6, w2: 3.8 }), boots(M.dark, "tall", M.gold)]],
  ["night", 3, [trousers("primary", { w1: 4.6, w2: 3.8, texture: "wrap" }), boots(M.dark, "wrap", LEGEND)]],
];

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["pad", 0, { kind: "pad", mat: M.darkLeather, size: 0.85 }],
  ["leather", 1, { kind: "lames", mat: M.leather, size: 0.85 }],
  ["scale", 1, { kind: "scale", mat: M.dark, size: 0.85 }],
  ["spiked", 2, { kind: "spiked", mat: M.dark, size: 0.8 }],
  ["fur", 2, { kind: "fur", mat: M.darkFur, size: 0.85 }],
  ["gold", 3, { kind: "lames", mat: M.dark, trim: M.gold, size: 0.9 }],
  ["dragon", 3, { kind: "dragon", mat: M.dark, trim: M.gold, size: 0.85 }],
];

const DAGGERS: Array<[string, Tier, BladeSpec]> = [
  ["curved", 0, { len: 11, w: 1.5, shape: "sabre", blade: M.steel, guard: "cross", guardMat: M.iron, grip: 3.4, gripMat: M.leather, pommel: "ball", pommelMat: M.iron }],
  ["straight", 0, { len: 11, w: 1.4, shape: "straight", blade: M.iron, guard: "cross", guardMat: M.iron, grip: 3.4, pommel: "disc" }],
  ["kukri", 0, { len: 11, w: 1.5, shape: "kukri", blade: M.steel, guard: "disc", guardMat: M.bronze, grip: 3.6, gripMat: M.wood, pommel: "none" }],
  ["stiletto", 0, { len: 12, w: 1, shape: "needle", blade: M.steel, guard: "cross", guardMat: M.dark, grip: 3.4, gripMat: M.darkLeather, pommel: "ball", pommelMat: M.dark }],
  ["parrying", 1, { len: 12, w: 1.4, shape: "straight", blade: M.steel, guard: "swept", guardMat: M.bronze, grip: 3.6, pommel: "ball", pommelMat: M.bronze }],
  ["kris", 1, { len: 12, w: 1.5, shape: "kris", blade: M.steel, guard: "block", guardMat: M.bronze, grip: 3.6, gripMat: M.darkWood, pommel: "disc", pommelMat: M.bronze }],
  ["longknife", 1, { len: 13, w: 1.6, shape: "clip", blade: M.steel, guard: "s", guardMat: M.steel, grip: 3.8, gripMat: M.darkLeather, pommel: "disc" }],
  ["hooked", 1, { len: 11, w: 1.5, shape: "khopesh", blade: M.steel, guard: "ring", guardMat: M.steel, grip: 3.6, gripMat: M.leather, pommel: "none" }],
  ["violet", 2, { len: 12, w: 1.5, shape: "sabre", blade: M.dark, edgeGlow: EPIC, guard: "cross", guardMat: M.dark, grip: 3.6, gripMat: M.darkLeather, pommel: "gem", pommelMat: M.dark, jewel: M.amethyst }],
  ["serrated", 2, { len: 12, w: 1.6, shape: "wavy", blade: M.steel, guard: "swept", guardMat: M.dark, grip: 3.6, gripMat: M.darkLeather, pommel: "claw", pommelMat: M.dark, jewel: EPIC }],
  ["darkkukri", 2, { len: 12, w: 1.6, shape: "kukri", blade: M.dark, edgeGlow: EPIC, guard: "disc", guardMat: M.dark, grip: 3.6, gripMat: M.darkWood, pommel: "ring", pommelMat: M.dark }],
  ["fang", 2, { len: 13, w: 1.2, shape: "leaf", blade: M.bone, guard: "block", guardMat: M.dark, grip: 3.6, gripMat: M.darkLeather, pommel: "ball", pommelMat: M.dark, runes: EPIC }],
  ["goldkris", 3, { len: 13, w: 1.7, shape: "kris", blade: M.white, guard: "block", guardMat: M.gold, grip: 3.8, gripMat: M.darkLeather, pommel: "gem", pommelMat: M.gold, jewel: M.ruby }],
  ["frost", 3, { len: 13, w: 1.2, shape: "needle", blade: M.frost, guard: "wings", guardMat: M.white, grip: 3.6, gripMat: M.darkLeather, pommel: "gem", pommelMat: M.white, jewel: M.sapphire }],
  ["shadowfang", 3, { len: 13, w: 1.8, shape: "sabre", blade: M.dark, edgeGlow: LEGEND, guard: "cross", guardMat: M.gold, grip: 3.6, gripMat: M.darkLeather, pommel: "claw", pommelMat: M.gold, jewel: M.emerald }],
  ["jewelled", 3, { len: 12, w: 1.3, shape: "tapered", blade: M.white, guard: "sun", guardMat: M.gold, grip: 3.6, gripMat: M.darkLeather, pommel: "gem", pommelMat: M.gold, jewel: M.amethyst, runes: LEGEND }],
];

/** A knotted waist sash whose two tails stream out behind (the Rogue's motion line). */
function sash(mat: Mat): Piece {
  return piece(9, mat, (g, p, j, r) => torso(g, j, () => {
    const sw = p.capeSway * 0.7;
    poly(g, [[-5.4, -2.6], [-4.6, -0.2], [-10 + sw * 0.8, 8.6 + sw * 0.2], [-12 + sw * 0.8, 7.4 + sw * 0.2]], r.base, 1);
    poly(g, [[-5.4, -3.6], [-4, -1], [-12.6 + sw, 4.6 + sw * 0.25], [-14.2 + sw, 2.6 + sw * 0.25]], r.hi, 1);
    lit(g, () => sub(g, [[-6.6, -3.8], [-4.2, -3.8], [-4.2, -1.4], [-6.6, -1.4]]), r);
    circle(g, -5.4, -2.6, 0.6, r.lo, 0);
  }));
}

const GEAR: Array<[string, Piece[], number]> = [
  ["sash", [sash("accent")], 3],
  ["redsash", [sash("secondary")], 2],
  ["knives", [knifeBandolier()], 2],
  ["vials", [vials()], 2],
  ["pouch", [pouch(M.darkLeather)], 1],
  ["satchel", [satchel(M.darkLeather)], 1],
];

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["tattered", 2, { cut: "tattered", mat: "accent", len: 12 }],
  ["hooded", 2, { cut: "hooded", mat: "primary" }],
  ["split", 2, { cut: "split", mat: M.dark, lining: EPIC }],
  ["shadow", 3, { cut: "tattered", mat: M.dark, lining: LEGEND, clasp: M.gold, len: 14 }],
  ["feathered", 3, { cut: "feathered", mat: "accent", clasp: M.gold }],
  ["scalloped", 3, { cut: "scalloped", mat: "primary", lining: LEGEND, clasp: M.gold }],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] => list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.r${tier}-${name}`, tier, rigs: R, pieces }));

export const ROGUE = {
  hood: HOODS.flatMap(([name, tier, spec]) =>
    Array.isArray(spec)
      ? design({ id: `headgear.hood.r${tier}-${name}`, tier, rigs: R, hides: [], pieces: spec })
      : design({ id: `headgear.hood.r${tier}-${name}`, tier, rigs: R, hides: spec.shape === "bandana" ? [] : ["hair"], pieces: hood(spec) }),
  ),
  armour: named("outfit.light", TORSOS),
  arms: named("outfit.light.arms", ARMS),
  legs: named("outfit.light.legs", LEGS),
  shoulders: PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.light.shoulders.r${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) })),
  weapon: DAGGERS.flatMap(([name, tier, spec]) => design({ id: `weapon.daggers.r${tier}-${name}`, tier, rigs: R, rig: "rogue", attack: "attack_thrust", pieces: bladePair(spec) })),
  gear: GEAR.flatMap(([name, pieces, weight]) => design({ id: `weapon.daggers.gear.r-${name}`, tier: 0, rigs: R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined }))),
  cape: CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.r${tier}-${name}`, tier, rigs: R, pieces: cape(spec) })),
} satisfies Record<string, DesignLayer[]>;
