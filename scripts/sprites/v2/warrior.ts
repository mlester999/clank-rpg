import { blade, type BladeSpec } from "./blades";
import { cape, type CapeSpec } from "./capes";
import { backShield, bedroll, handAxe, horn, pouch, scabbard } from "./gear";
import { belt, boots, bodyGarment, bracers, breastplate, collar, emblem, fauld, gloves, legPlates, skirt, sleeves, straps, tabard, tassets, trousers } from "./garments";
import { helm, helmHides, type HelmSpec } from "./helms";
import { cord, gem, head, lit, M, RARITY_RAMP, sub, type Ramp, type RigId, type Tier } from "./kit";
import { CLASS_RIGS } from "./rig";
import { design, piece, type DesignLayer, type Piece } from "./library";
import { pauldrons, type PauldronSpec } from "./pauldrons";
import { shield, type ShieldSpec } from "./shields";

/**
 * HERO RENDERER v2 — the WARRIOR's design library (skeleton `warrior`). Every slot has four designs per equipment tier, so two Common Warriors
 * differ in helm, armour, pauldrons, sword and gear, and a Legendary Warrior is a different construction — not a Common one in gold:
 *
 *   COMMON     practical kit: a nasal helm, a kettle hat, a mail coif, a bare head with a headband; a gambeson, a tabard over mail, a leather
 *              jerkin, a mail hauberk; an arming sword, a falchion, a gladius, a messer
 *   RARE       better made: a bascinet with an aventail, a sallet, a barbute, a crested morion; a brigandine, a breastplate over a gambeson, a long
 *              surcoat, lamellar; steel pauldrons; a longsword, a sabre, a broadsword, a khopesh
 *   EPIC       distinctive: a horned helm, a closed great helm with a plume, a horsehair-crested galea, an armet with its visor raised; full plate,
 *              a coat of plates with a fur collar, scale, a warlord's surcoat; spiked or raised pauldrons; a bastard sword, a flamberge, a
 *              greatsword, a runeblade; a cape
 *   LEGENDARY  exceptional: a winged helm, a dragon helm, a crowned helm, a lion helm; gilded white plate, dragonscale, a royal surcoat over
 *              plate, a champion's cuirass; lion / wing / sun / dragon pauldrons; a sunblade, a dragon greatsword, a frostblade, a claymore
 */

/** Every design of the class is drawn on all three of its skeletons (the archetypes): equipment and archetype are independent choices. */
const R: readonly RigId[] = CLASS_RIGS.warrior;
const EPIC = RARITY_RAMP[2];
const LEGEND = RARITY_RAMP[3];

// ------------------------------------------------------------------------------ helms (headgear.helm)

/** A leather / cloth headband over bare hair (an open Common look: the hair is part of the hero). */
function headband(): Piece[] {
  return [piece(60, "cloth", (g, p, j, r) => head(g, j, () => {
    const sw = p.capeSway * 0.3;
    lit(g, () => {
      g.moveTo(-11, -2.4);
      g.quadraticCurveTo(0, -6.2, 10.8, -3.2);
      g.lineTo(10.6, -0.8);
      g.quadraticCurveTo(0, -3.8, -10.8, 0);
      g.closePath();
    }, r, { shadow: [0.6, -0.8] });
    cord(g, () => {
      g.beginPath();
      g.moveTo(-10.6, -1.2);
      g.quadraticCurveTo(-13 + sw, 1, -15.4 + sw * 1.4, 4.4);
    }, 1.4, r.base);
    cord(g, () => {
      g.beginPath();
      g.moveTo(-10.6, -1.2);
      g.quadraticCurveTo(-14 + sw, -1.4, -16.6 + sw * 1.4, 0.6);
    }, 1.2, r.lo);
  }))];
}

/** A bare head (the hero's own hair and face ARE the look) — drawn as nothing; the hair shows. */
function bare(): Piece[] {
  return [piece(60, M.leather, () => undefined)];
}

/** A metal brow band (Rare) or a jewelled gold circlet (Legendary — a champion who needs no helm) over the hair. */
function circlet(mat: Ramp, jewel: Ramp | null, points: number): Piece[] {
  return [piece(60, mat, (g, _p, j, r) => head(g, j, () => {
    lit(g, () => {
      g.moveTo(-10.8, -2.2);
      g.quadraticCurveTo(0, -6.6, 10.6, -3.4);
      g.lineTo(10.4, -1.4);
      g.quadraticCurveTo(0, -4.4, -10.6, -0.4);
      g.closePath();
    }, r, { shadow: [0.4, -0.6] });
    for (let i = 0; i < points; i++) {
      const x = -2 + i * 3.6;
      const y = -5.6 + Math.abs(i - (points - 1) / 2) * 0.5;
      lit(g, () => sub(g, [[x - 1.3, y + 0.6], [x, y - 3.2], [x + 1.3, y + 0.6]]), r, { shadow: [0.4, -0.4] });
    }
    if (jewel) gem(g, 6.4, -3.6, 1.4, jewel);
  }))];
}

const HELMS: Array<[string, Tier, HelmSpec | "headband" | Piece[]]> = [
  ["bare", 0, bare()],
  ["nasal", 0, { shell: "cone", mat: "metal", face: "nasal", ribs: 2, band: M.leather }],
  ["kettle", 0, { shell: "kettle", mat: "metal", brim: "kettle", neck: "coif" }],
  ["coif", 0, { shell: "skull", mat: M.leather, neck: "coif", neckMat: "metal", rivets: true }],
  ["band", 0, "headband"],
  ["skullcap", 0, { shell: "skull", mat: "metal", band: M.leather, rivets: true }],
  ["bascinet", 1, { shell: "pointed", mat: "metal", face: "open", neck: "aventail", band: M.bronze, rivets: true }],
  ["sallet", 1, { shell: "sallet", mat: "metal", face: "open", band: M.bronze, crests: [{ kind: "socket", mat: M.bronze }] }],
  ["barbute", 1, { shell: "barbute", mat: "metal", face: "T", ribs: 1, rivets: true }],
  ["morion", 1, { shell: "morion", mat: "metal", brim: "morion", neck: "cheekplates", band: M.bronze, crests: [{ kind: "comb", mat: "metal" }] }],
  ["spangen", 1, { shell: "cone", mat: "metal", face: "nasal", neck: "aventail", ribs: 4, band: M.bronze, crests: [{ kind: "spike", mat: M.bronze, size: 0.5 }] }],
  ["browband", 1, circlet(M.bronze, null, 0)],
  ["horned", 2, { shell: "round", mat: "metal", face: "nasal", neck: "aventail", band: M.gold, crests: [{ kind: "horns", mat: M.bone }] }],
  ["great", 2, { shell: "flat", mat: "metal", face: "slit", band: M.gold, crests: [{ kind: "plume", mat: EPIC }] }],
  ["galea", 2, { shell: "round", mat: "metal", face: "cheeks", band: M.gold, crests: [{ kind: "fan", mat: EPIC }] }],
  ["armet", 2, { shell: "tall", mat: "metal", face: "visor", neck: "gorget", band: M.gold, crests: [{ kind: "spike", mat: M.gold }] }],
  ["visored", 2, { shell: "sallet", mat: "metal", face: "visor", band: M.gold, crests: [{ kind: "plume", mat: EPIC, size: 0.85 }] }],
  ["winged", 3, { shell: "round", mat: "metal", face: "nasal", neck: "aventail", band: M.gold, crests: [{ kind: "wings", mat: M.white, z: 59, size: 0.82 }, { kind: "wings", mat: M.white, size: 0.95 }] }],
  ["dragon", 3, { shell: "pointed", mat: M.dark, face: "open", neck: "lames", band: M.gold, crests: [{ kind: "dragon", mat: M.gold }] }],
  ["crowned", 3, { shell: "tall", mat: M.white, face: "T", neck: "gorget", crests: [{ kind: "crown", mat: M.gold, size: 1.1 }, { kind: "tuft", mat: LEGEND, size: 1.3 }] }],
  ["lion", 3, { shell: "round", mat: M.gold, face: "open", neck: "aventail", neckMat: M.steel, crests: [{ kind: "mane", mat: LEGEND, z: 59, size: 1.05 }] }],
  ["ram", 3, { shell: "pointed", mat: "metal", face: "nasal", neck: "lames", band: M.gold, crests: [{ kind: "ramhorns", mat: M.gold, size: 1.15 }] }],
  ["circlet", 3, circlet(M.gold, M.ruby, 3)],
];

const helmLayers = HELMS.flatMap(([name, tier, spec]) =>
  spec === "headband" || Array.isArray(spec)
    ? design({ id: `headgear.helm.w${tier}-${name}`, tier, rigs: R, hides: [], pieces: spec === "headband" ? headband() : spec })
    : design({ id: `headgear.helm.w${tier}-${name}`, tier, rigs: R, hides: name === "coif" ? ["hair"] : helmHides(spec), pieces: helm(spec) }),
);

// ------------------------------------------------------------------------------ armour: torso (outfit.medium), arms and legs (its sub-slots)

const TORSOS: Array<[string, Tier, Piece[]]> = [
  ["tabard", 0, [bodyGarment(20, "metal", { texture: "mail", len: 7, sh: 7.6, wa: 6.4, hem: 8 }), tabard("primary", { len: 8.6 }), belt(M.leather, { buckle: M.bronze })]],
  ["gambeson", 0, [bodyGarment(20, "primary", { texture: "quilt", len: 7, sh: 7.8, wa: 7, hem: 8.4, split: 3 }), collar("primary", "high", 22), belt(M.leather, { pouch: M.leather, buckle: M.iron })]],
  ["jerkin", 0, [bodyGarment(20, M.leather, { len: 3.4, sh: 7, wa: 6.2, hem: 6.8 }), straps(M.darkLeather, { cross: true, w: 1.4 }), belt(M.darkLeather, { buckle: M.iron, w: 7.4, h: 3 })]],
  ["hauberk", 0, [bodyGarment(20, "metal", { texture: "mail", len: 10, split: 6, sh: 7.8, wa: 6.8, hem: 8.8 }), belt("primary", { sash: true, h: 2.8 })]],
  ["brigandine", 1, [skirt("metal", { len: 8, texture: "mail" }), bodyGarment(21, "primary", { texture: "studs", len: 0, sh: 7.6, wa: 6.6 }), belt(M.darkLeather, { buckle: M.steel })]],
  ["cuirass", 1, [bodyGarment(20, "primary", { texture: "quilt", len: 8, split: 4 }), breastplate("metal", { bottom: -2 }), fauld("metal", { rows: 1, y: -2.4 }), belt(M.leather, { buckle: M.bronze, pouch: M.leather, y: -2.8 })]],
  ["surcoat", 1, [bodyGarment(20, "primary", { len: 11, split: 6, flow: 0.8, sh: 7.4, wa: 6.4, hem: 9.4 }), straps("secondary", { w: 2.8 }), belt(M.leather, { buckle: M.gold })]],
  ["lamellar", 1, [bodyGarment(20, "metal", { texture: "lamellar", len: 6, sh: 7.8, wa: 7, hem: 8.4 }), belt("primary", { h: 2.6, buckle: M.bronze })]],
  ["plate", 2, [skirt("primary", { len: 8, split: true }), breastplate("metal", { bottom: -2 }), fauld("metal", { rows: 2, y: -2.6 }), tassets("metal", { len: 6 }), belt(M.darkLeather, { buckle: M.gold, h: 1.8, y: -3 })]],
  ["coat", 2, [bodyGarment(20, "primary", { texture: "studs", len: 7, split: 3, sh: 8, wa: 7, hem: 8.6 }), collar(M.darkFur, "fur"), belt(M.darkLeather, { buckle: M.gold, pouch: M.leather })]],
  ["scale", 2, [bodyGarment(20, "metal", { texture: "scales", len: 9, split: 5, sh: 8, wa: 7, hem: 9 }), tabard("primary", { w: 3, len: 11, sleeveless: true, split: false }), belt(M.leather, { buckle: M.gold })]],
  ["warlord", 2, [bodyGarment(20, "primary", { len: 11, split: 8, flow: 0.8, sh: 7.6, wa: 6.6, hem: 9.4 }), breastplate("metal"), collar(M.darkFur, "fur"), belt(M.leather, { buckle: M.gold, h: 3, y: -3.6 })]],
  ["gilded", 3, [skirt("primary", { len: 9, split: true }), breastplate(M.white, { bottom: -2 }), emblem(M.gold, "sun", { y: -10 }), fauld(M.white, { rows: 2 }), tassets(M.white, { len: 7 }), belt(M.gold, { h: 1.8, y: -3, jewel: M.ruby })]],
  ["dragonscale", 3, [bodyGarment(20, M.dark, { texture: "scales", len: 9, split: 5, sh: 8.2, wa: 7.2, hem: 9.4 }), emblem(M.gold, "disc", { y: -10.4 }), belt("primary", { h: 3, sash: true }), collar(M.gold, "gorget")]],
  ["royal", 3, [bodyGarment(20, "primary", { len: 12, split: 8, flow: 1, sh: 7.6, wa: 6.6, hem: 9.8 }), breastplate(M.white), emblem(M.gold, "star"), collar(M.fur, "fur"), belt(M.gold, { jewel: M.sapphire })]],
  ["champion", 3, [skirt("primary", { strips: 7, len: 8 }), breastplate(M.bronze, { sh: 8.2, ridge: false }), emblem(M.gold, "sun"), belt(M.gold, { h: 2, jewel: M.ruby })]],
];

const ARMS: Array<[string, Tier, Piece[]]> = [
  ["mail", 0, [...sleeves("metal", { texture: "mail", to: 0.6 }), ...gloves(M.leather)]],
  ["cloth", 0, [...sleeves("primary", { to: 0.85 }), ...bracers(M.leather)]],
  ["quilt", 0, [...sleeves("primary", { texture: "quilt", to: 0.9, w1: 4.8, w2: 4.2 })]],
  ["shirt", 0, [...sleeves("cloth", { to: 0.8 }), ...bracers(M.darkLeather)]],
  ["mailplate", 1, [...sleeves("metal", { texture: "mail", to: 0.9 }), ...bracers("metal", { plate: true })]],
  ["vambrace", 1, [...sleeves("primary", { to: 0.6 }), ...bracers("metal", { plate: true, from: 0.1 }), ...gloves(M.leather, { cuff: true })]],
  ["gauntlet", 1, [...sleeves("metal", { texture: "mail", to: 0.5 }), ...gloves("metal", { cuff: true })]],
  ["plate", 2, [...sleeves("metal", { texture: "mail", to: 0.3 }), ...bracers("metal", { plate: true, from: 0.1, to: 0.9 }), ...gloves("metal", { cuff: true })]],
  ["clothplate", 2, [...sleeves("primary", { to: 0.8 }), ...bracers("metal", { plate: true }), ...gloves(M.darkLeather, { cuff: true })]],
  ["dark", 2, [...sleeves("metal", { texture: "mail", to: 0.4 }), ...bracers(M.dark, { plate: true, from: 0.05 }), ...gloves(M.dark, { cuff: true })]],
  ["white", 3, [...sleeves("metal", { texture: "mail", to: 0.3 }), ...bracers(M.white, { plate: true, from: 0.05 }), ...gloves(M.white, { cuff: true })]],
  ["steelgold", 3, [...sleeves("primary", { to: 0.4 }), ...bracers("metal", { plate: true, from: 0.05 }), ...gloves(M.gold, { cuff: true })]],
  ["gold", 3, [...sleeves("primary", { to: 0.6 }), ...bracers(M.gold, { plate: true }), ...gloves(M.leather, { cuff: true })]],
  ["darkgold", 3, [...sleeves("metal", { texture: "mail", to: 0.4 }), ...bracers(M.dark, { plate: true, from: 0.05 }), ...gloves(M.gold, { cuff: true })]],
];

const LEGS: Array<[string, Tier, Piece[]]> = [
  ["trousers", 0, [trousers("cloth"), boots(M.leather, "boot")]],
  ["tallboots", 0, [trousers("secondary"), boots(M.leather, "tall")]],
  ["wraps", 0, [trousers("primary"), boots(M.leather, "wrap")]],
  ["chausses", 0, [trousers("metal", { texture: "mail" }), boots(M.darkLeather, "boot")]],
  ["greaves", 1, [trousers("cloth"), legPlates("metal"), boots(M.darkLeather, "tall")]],
  ["mailed", 1, [trousers("metal", { texture: "mail" }), boots(M.leather, "tall")]],
  ["kneecops", 1, [trousers("primary"), legPlates("metal", { knee: 2.8 }), boots(M.leather, "boot")]],
  ["plate", 2, [trousers("primary", { to: 0.4 }), legPlates("metal", { thigh: true }), boots("metal", "sabaton")]],
  ["greaves", 2, [trousers("cloth"), legPlates("metal"), boots(M.darkLeather, "tall")]],
  ["darkplate", 2, [trousers("primary"), legPlates(M.dark, { thigh: true }), boots(M.dark, "sabaton")]],
  ["white", 3, [trousers("primary", { to: 0.3 }), legPlates(M.white, { thigh: true }), boots(M.white, "sabaton")]],
  ["gold", 3, [trousers("cloth"), legPlates(M.gold), boots(M.leather, "tall")]],
  ["dark", 3, [trousers("primary"), legPlates(M.dark, { thigh: true }), boots(M.dark, "sabaton")]],
  ["steel", 3, [trousers("primary", { to: 0.35 }), legPlates("metal", { thigh: true }), boots("metal", "sabaton", M.gold)]],
];

const named = (slot: string, list: Array<[string, Tier, Piece[]]>): DesignLayer[] =>
  list.flatMap(([name, tier, pieces]) => design({ id: `${slot}.w${tier}-${name}`, tier, rigs: R, pieces }));

const armourLayers = named("outfit.medium", TORSOS);
const armLayers = named("outfit.medium.arms", ARMS);
const legLayers = named("outfit.medium.legs", LEGS);

// ------------------------------------------------------------------------------ pauldrons (outfit.medium.shoulders — a kit part of the outfit)

const PAULDRONS: Array<[string, Tier, PauldronSpec]> = [
  ["pad", 0, { kind: "pad", mat: M.leather }],
  ["lames", 0, { kind: "lames", mat: "metal" }],
  ["fur", 0, { kind: "fur", mat: M.darkFur }],
  ["round", 1, { kind: "round", mat: "metal", trim: M.bronze }],
  ["layered", 1, { kind: "lames", mat: "metal", trim: M.bronze, size: 1.1 }],
  ["haute", 2, { kind: "haute", mat: "metal", trim: M.gold }],
  ["spiked", 2, { kind: "spiked", mat: "metal", trim: M.gold }],
  ["furplate", 2, { kind: "fur", mat: M.darkFur, trim: M.gold, size: 1.2 }],
  ["lion", 3, { kind: "lion", mat: M.gold, trim: M.gold, size: 1.1 }],
  ["wing", 3, { kind: "wing", mat: M.white, trim: M.gold, size: 1.05 }],
  ["sun", 3, { kind: "sun", mat: M.white, trim: M.gold }],
  ["dragon", 3, { kind: "dragon", mat: M.dark, trim: M.gold, size: 1.1 }],
];

const pauldronLayers = PAULDRONS.flatMap(([name, tier, spec]) => design({ id: `outfit.medium.shoulders.w${tier}-${name}`, tier, rigs: R, pieces: pauldrons(spec) }));

// ------------------------------------------------------------------------------ swords (weapon.sword)

const SWORDS: Array<[string, Tier, BladeSpec]> = [
  ["arming", 0, { len: 20, w: 2, shape: "straight", blade: M.steel, fuller: true, guard: "cross", guardMat: M.iron, grip: 5, pommel: "wheel", pommelMat: M.iron }],
  ["falchion", 0, { len: 17, w: 2, shape: "falchion", blade: M.steel, guard: "cross", guardMat: M.iron, grip: 4.6, pommel: "disc" }],
  ["gladius", 0, { len: 15, w: 2.4, shape: "leaf", blade: M.steel, guard: "disc", guardMat: M.wood, grip: 4.6, pommel: "ball", pommelMat: M.wood }],
  ["messer", 0, { len: 18, w: 1.9, shape: "clip", blade: M.iron, guard: "s", guardMat: M.iron, grip: 5, pommel: "disc", gripMat: M.wood }],
  ["longsword", 1, { len: 23, w: 1.9, shape: "tapered", fuller: true, blade: M.steel, guard: "swept", guardMat: M.steel, grip: 7, pommel: "fishtail", pommelMat: M.steel }],
  ["sabre", 1, { len: 20, w: 1.8, shape: "sabre", blade: M.steel, guard: "knuckle", guardMat: M.bronze, grip: 5, pommel: "ball", pommelMat: M.bronze }],
  ["broadsword", 1, { len: 21, w: 2.8, shape: "broad", fuller: true, blade: M.steel, guard: "shell", guardMat: M.bronze, grip: 5, pommel: "wheel", pommelMat: M.bronze }],
  ["khopesh", 1, { len: 18, w: 1.8, shape: "khopesh", blade: M.bronze, guard: "block", guardMat: M.bronze, grip: 5, pommel: "disc", pommelMat: M.bronze, gripMat: M.darkWood }],
  ["bastard", 2, { len: 24, w: 2.3, shape: "straight", fuller: true, blade: M.steel, guard: "swept", guardMat: M.gold, grip: 7, pommel: "gem", pommelMat: M.gold, jewel: M.amethyst, runes: EPIC }],
  ["flamberge", 2, { len: 22.5, w: 2.2, shape: "wavy", blade: M.steel, guard: "lugs", guardMat: M.iron, grip: 7.4, pommel: "wheel", edgeGlow: EPIC }],
  ["greatsword", 2, { len: 22.5, w: 3, shape: "great", fuller: true, blade: M.steel, guard: "cross", guardMat: M.dark, grip: 7.6, pommel: "ball", pommelMat: M.dark, edgeGlow: EPIC }],
  ["runeblade", 2, { len: 21, w: 3.2, shape: "broad", blade: M.dark, runes: EPIC, guard: "block", guardMat: M.dark, grip: 5.6, pommel: "claw", pommelMat: M.dark, jewel: M.amethyst }],
  ["sunblade", 3, { len: 24, w: 2.6, shape: "broad", blade: M.white, fuller: true, guard: "sun", guardMat: M.gold, grip: 6, pommel: "gem", pommelMat: M.gold, jewel: M.ruby, edgeGlow: LEGEND }],
  ["dragonblade", 3, { len: 23, w: 3, shape: "great", blade: M.steel, guard: "dragon", guardMat: M.gold, jewel: M.ruby, grip: 7, pommel: "claw", pommelMat: M.gold, runes: LEGEND }],
  ["frostblade", 3, { len: 23, w: 2.4, shape: "tapered", blade: M.frost, guard: "wings", guardMat: M.white, grip: 6, pommel: "gem", pommelMat: M.white, jewel: M.sapphire, edgeGlow: LEGEND }],
  ["claymore", 3, { len: 23, w: 2.4, shape: "straight", blade: M.white, fuller: true, guard: "wings", guardMat: M.gold, grip: 8, pommel: "gem", pommelMat: M.gold, jewel: M.emerald, runes: LEGEND }],
];

const swordLayers = SWORDS.flatMap(([name, tier, spec]) => design({ id: `weapon.sword.w${tier}-${name}`, tier, rigs: R, rig: "warrior", attack: "attack_slash", pieces: blade(spec) }));

// ------------------------------------------------------------------------------ gear (weapon.sword.gear — the class accessory sub-slot)

const GEAR: Array<[string, Piece[], number]> = [
  ["scabbard", [scabbard()], 3],
  ["shield", backShield("primary", "metal"), 2],
  ["horn", [horn()], 1],
  ["pouch", [pouch()], 1],
  ["axe", [handAxe()], 1],
  ["bedroll", bedroll("cloth"), 1],
];

// a duelist carries a buckler in the back fist, never a second shield on the back
const gearLayers = GEAR.flatMap(([name, pieces, weight]) =>
  design({ id: `weapon.sword.gear.w-${name}`, tier: 0, rigs: name === "shield" ? R.filter((r) => r !== "warrior-duelist") : R, weight, pieces }).map((l) => (l.of ? l : { ...l, tiers: undefined })),
);

// ------------------------------------------------------------------------------ bucklers (weapon.sword.buckler — the DUELIST's off-hand, a kit drawn on that skeleton only)

const BUCKLERS: Array<[string, Tier, ShieldSpec]> = [
  ["wood", 0, { shape: "round", face: M.wood, rim: M.iron, mark: "boss", size: 0.64, grip: "fist" }],
  ["iron", 0, { shape: "round", face: "metal", rim: M.iron, mark: "boss", markMat: M.leather, size: 0.62, grip: "fist" }],
  ["leather", 0, { shape: "round", face: M.leather, rim: M.darkLeather, mark: "rivets", markMat: M.iron, size: 0.66, grip: "fist" }],
  ["steel", 1, { shape: "round", face: "metal", rim: M.bronze, mark: "star", markMat: M.bronze, size: 0.66, grip: "fist" }],
  ["painted", 1, { shape: "round", face: "primary", rim: M.steel, mark: "boss", markMat: M.steel, size: 0.68, grip: "fist" }],
  ["heater", 1, { shape: "heater", face: M.royal, rim: M.steel, mark: "chevron", markMat: M.cloth, size: 0.64, grip: "fist" }],
  ["spiked", 2, { shape: "spiked", face: M.dark, rim: M.gold, mark: "boss", markMat: M.gold, size: 0.64, grip: "fist" }],
  ["sunburst", 2, { shape: "round", face: M.crimson, rim: M.gold, mark: "sun", markMat: M.gold, size: 0.7, grip: "fist" }],
  ["skull", 2, { shape: "round", face: M.sable, rim: M.steel, mark: "skull", markMat: M.bone, size: 0.69, grip: "fist" }],
  ["lion", 3, { shape: "aegis", face: M.white, rim: M.gold, mark: "lion", markMat: M.gold, size: 0.64, grip: "fist" }],
  ["solar", 3, { shape: "round", face: M.gold, rim: M.white, mark: "sun", markMat: M.white, size: 0.72, grip: "fist" }],
  ["wing", 3, { shape: "wing", face: M.white, rim: M.gold, mark: "star", markMat: M.gold, size: 0.62, grip: "fist" }],
];

const bucklerLayers = BUCKLERS.flatMap(([name, tier, spec]) => design({ id: `weapon.sword.buckler.w${tier}-${name}`, tier, rigs: ["warrior-duelist"], pieces: shield(spec) }));

// ------------------------------------------------------------------------------ capes (cape.default — Epic and Legendary heroes)

const CAPES: Array<[string, Tier, CapeSpec]> = [
  ["long", 2, { cut: "long", mat: "accent" }],
  ["half", 2, { cut: "half", mat: "primary", clasp: M.bronze }],
  ["tattered", 2, { cut: "tattered", mat: "cloth" }],
  ["royal", 3, { cut: "royal", mat: "primary", collar: M.fur, clasp: M.gold, len: 14 }],
  ["split", 3, { cut: "split", mat: "accent", lining: LEGEND, clasp: M.gold }],
  ["herald", 3, { cut: "long", mat: "primary", emblem: LEGEND, clasp: M.gold }],
];

const capeLayers = CAPES.flatMap(([name, tier, spec]) => design({ id: `cape.default.w${tier}-${name}`, tier, rigs: R, pieces: cape(spec) }));

export const WARRIOR: Record<"helm" | "armour" | "arms" | "legs" | "shoulders" | "weapon" | "gear" | "buckler" | "cape", DesignLayer[]> = {
  helm: helmLayers,
  armour: armourLayers,
  arms: armLayers,
  legs: legLayers,
  shoulders: pauldronLayers,
  weapon: swordLayers,
  gear: gearLayers,
  buckler: bucklerLayers,
  cape: capeLayers,
};

