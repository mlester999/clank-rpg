import type { Dress } from "../body";
import type { Build } from "../kit";
import { material, MAT } from "../materials";

import { belt, beltItem, cape, pauldrons, sash, skirt, studs, torsoShell } from "./garments";
import { drawHood, type HeadCover } from "./headgear";
import { baseDress, trousers, type Loadout, type LoadoutCtx } from "./loadout";
import { bladeSpan, drawBlade, type BladeSpec, type WeaponResult } from "./weapons";

/**
 * ROGUE loadouts — close-fitting leathers, a hood (masked at most tiers), a sash with streaming tails, a dagger in EACH hand. Light, dark and
 * compact: the silhouette is the hood's point, the low stance and two short blades.
 *
 *   cutthroat   twin daggers, one forward, one reversed along the forearm
 *   assassin    long knives held reversed, tall and thin
 *   brawler     short heavy blades (punch-knife width), a boxer's guard
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const wraps = (d: Dress): Dress => ({ ...d, boot: { mat: MAT.darkLeather, top: 0.7 }, foot: MAT.darkLeather });

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "leather jerkin",
      dress: (c, d) => wraps({ ...d, chest: MAT.leather, waist: MAT.leather, pelvis: trousers(c.pal, 0), upperArm: c.pal.primary, forearm: c.pal.primary, glove: { mat: MAT.darkLeather, top: 0.55 }, thigh: trousers(c.pal, 0), shin: trousers(c.pal, 0) }),
      draw: (b, c) => {
        skirt(b, MAT.leather, { len: 3.5, flare: 0.6, split: "front", name: "jerkinSkirt" });
        sash(b, c.pal.secondary, { tails: 6 });
      },
    },
    {
      name: "hooded tunic",
      dress: (c, d) => wraps({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: trousers(c.pal, 1), upperArm: c.pal.primary, forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.75 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1) }),
      draw: (b, c) => {
        skirt(b, c.pal.primary, { len: 5, flare: 0.8, split: "sides", name: "tunicTails" });
        belt(b, MAT.darkLeather, MAT.iron);
        beltItem(b, MAT.leather, [-1.0, -0.4, b.sk.plan.pelvis.w + 0.4], [1.2, 1.1, 0.7]);
        void c;
      },
    },
  ],
  1: [
    {
      name: "studded leather",
      dress: (c, d) => wraps({ ...d, chest: MAT.darkLeather, waist: MAT.darkLeather, pelvis: trousers(c.pal, 0), upperArm: c.pal.primary, forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.7 }, thigh: trousers(c.pal, 0), shin: trousers(c.pal, 0) }),
      draw: (b, c) => {
        const pl = b.sk.plan;
        studs(b, c.pal.metal, [[pl.chest.d * 0.95, 2.0, 1.5], [pl.chest.d, 0.0, 2.0], [pl.chest.d * 0.95, -1.8, 1.0]], 0.4);
        skirt(b, MAT.darkLeather, { len: 4, flare: 0.7, split: "front", name: "skirt" });
        sash(b, c.pal.secondary, { tails: 7 });
      },
    },
    {
      name: "padded vest",
      dress: (c, d) => wraps({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: trousers(c.pal, 1), upperArm: c.pal.accent, forearm: c.pal.accent, glove: { mat: MAT.darkLeather, top: 0.6 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1), torsoBulk: 1.06 }),
      draw: (b, c) => {
        torsoShell(b, MAT.leather, { inflate: 0.45, waist: true, keep: (x, _y, z, w) => !(x > 0 && Math.abs(z) < w * 0.25), name: "vest" });
        sash(b, c.pal.secondary, { tails: 7 });
      },
    },
  ],
  2: [
    {
      name: "shadow leathers",
      dress: (c, d) => wraps({ ...d, chest: c.pal.accent, waist: c.pal.accent, pelvis: c.pal.accent, upperArm: c.pal.accent, forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.75 }, thigh: c.pal.accent, shin: c.pal.accent }),
      draw: (b, c) => {
        torsoShell(b, c.pal.primary, { inflate: 0.4, waist: true, keep: (x, y, z) => x > 0 && Math.abs(z + y * 0.35) < 1.6, name: "crossStrap" });
        sash(b, c.pal.secondary, { tails: 8 });
        pauldrons(b, MAT.darkLeather, { size: 0.8, layers: 2, trim: c.pal.metal });
      },
    },
  ],
  3: [
    {
      name: "night silk",
      dress: (c, d) => wraps({ ...d, chest: material("#20232d", "cloth"), waist: material("#20232d", "cloth"), pelvis: c.pal.accent, upperArm: material("#20232d", "cloth"), forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.8 }, thigh: c.pal.accent, shin: c.pal.accent }),
      draw: (b, c) => {
        torsoShell(b, c.pal.primary, { inflate: 0.4, waist: true, keep: (x, y, z) => x > 0 && Math.abs(z + y * 0.35) < 1.4, name: "crossStrap" });
        torsoShell(b, MAT.gold, { inflate: 0.55, waist: true, keep: (x, y, z) => x > 0 && Math.abs(z + y * 0.35) < 0.5, name: "goldStrap", zBias: 0.4 });
        sash(b, c.pal.secondary, { tails: 9 });
        pauldrons(b, MAT.darkLeather, { size: 0.85, layers: 2, trim: MAT.gold });
      },
    },
  ],
};

type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };
const HOODS: Record<number, HeadDesign[]> = {
  0: [
    { name: "hood", draw: (b, c) => drawHood(b, { mat: c.pal.primary, inner: c.pal.accent, mask: null, point: 0.4, mantle: false }) },
    { name: "masked hood", draw: (b, c) => drawHood(b, { mat: c.pal.primary, inner: c.pal.accent, mask: c.pal.accent, point: 0.3, mantle: false }) },
  ],
  1: [
    { name: "masked hood", draw: (b, c) => drawHood(b, { mat: c.pal.primary, inner: c.pal.accent, mask: c.pal.accent, point: 0.6, mantle: false }) },
    { name: "cowl", draw: (b, c) => drawHood(b, { mat: c.pal.primaryDark, inner: c.pal.accent, mask: c.pal.secondary, point: 0.2, mantle: false }) },
  ],
  2: [{ name: "shadow hood", draw: (b, c) => drawHood(b, { mat: c.pal.accent, inner: c.pal.accent, mask: c.pal.primary, point: 0.9, mantle: false }) }],
  3: [{ name: "night hood", draw: (b, c) => drawHood(b, { mat: material("#20232d", "cloth"), inner: c.pal.accent, mask: c.pal.primary, point: 1.0, mantle: false }) }],
};

const blade = (o: Partial<BladeSpec> & Pick<BladeSpec, "blade">): BladeSpec => ({ len: 6, w: 2, grip: 2.2, guard: 1.3, guardDrop: 0, pommel: "disc", hilt: MAT.iron, wrap: MAT.darkLeather, gem: null, runes: null, curve: 0, belly: 0, ...o });

function daggers(c: LoadoutCtx): Array<{ name: string; spec: BladeSpec }> {
  const assassin = c.arch === "rogue-assassin";
  const brawler = c.arch === "rogue-brawler";
  const len = assassin ? 8.5 : brawler ? 5.2 : 6.2;
  const w = brawler ? 3 : 2;
  const base = { len, w, guard: brawler ? 1.6 : 1.3 };
  switch (c.tier) {
    case 0:
      return [{ name: "iron daggers", spec: blade({ ...base, blade: MAT.iron }) }, { name: "skinning knives", spec: blade({ ...base, blade: MAT.steel, curve: 0.6 }) }];
    case 1:
      return [{ name: "steel daggers", spec: blade({ ...base, blade: MAT.steel, hilt: MAT.bronze, pommel: "gem", gem: c.pal.gem }) }];
    case 2:
      return [{ name: "venom daggers", spec: blade({ ...base, blade: MAT.steel, hilt: MAT.blackIron, runes: MAT.fel, pommel: "gem", gem: c.pal.gem }) }];
    default:
      return [{ name: "golden kris", spec: blade({ ...base, blade: MAT.silver, hilt: MAT.gold, runes: material("#7fe8d0", "glow"), curve: 0.9, pommel: "gem", gem: MAT.emerald }) }];
  }
}

export function rogueLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const hoods = HOODS[c.tier] ?? HOODS[0]!;
  const hood = hoods[c.pick("helm", hoods.length)] as HeadDesign;
  const pool = daggers(c);
  const w = pool[c.pick("weapon", pool.length)] as { name: string; spec: BladeSpec };
  const headgear = c.g.headgear;
  return {
    hold: { main: "N", grip2: null, second: true, bow: null, shield: false },
    dress: armor.dress(c, baseDress(c.pal)),
    garments: (b) => {
      armor.draw(b, c);
      if (c.g.cape) cape(b, c.pal.accent, { len: 18, width: 0.9, collar: c.tier >= 3 ? MAT.gold : null });
    },
    head: (b) => (headgear === "hood" ? hood.draw(b, c) : null),
    weapon: (b): WeaponResult | null => {
      const sk = b.sk;
      if (!sk.weapon) return null;
      const r = drawBlade(b, sk.weapon, w.spec);
      if (sk.weapon2) drawBlade(b, sk.weapon2, w.spec, 8);
      return r;
    },
    attack: "attack_thrust",
    span: bladeSpan(w.spec),
    names: [armor.name, headgear === "hood" ? hood.name : headgear ?? "bare", w.name],
  };
}
