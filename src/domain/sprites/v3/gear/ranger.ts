import { GROUP, type Dress } from "../body";
import { TAG } from "../gbuffer";
import type { Build } from "../kit";
import { material, MAT } from "../materials";
import { add, mul } from "../vec";

import { backCase, belt, beltItem, cape, pauldrons, ring, skirt } from "./garments";
import { drawCap, type HeadCover } from "./headgear";
import { baseDress, trousers, type Loadout, type LoadoutCtx } from "./loadout";
import { drawBow, type BowSpec, type WeaponResult } from "./weapons";

/**
 * RANGER loadouts — leathers under a short hooded mantle, a forester's cap with a feather, a quiver across the back, a BOW held in the far
 * (left) hand. The near hand is solved onto the string: at rest it hangs free; drawing, it pulls the string back to the jaw line — the arrow
 * leaves from the bow (the muzzle) on the release frame.
 *
 *   scout        a recurve
 *   warden       a longbow almost as tall as the hero
 *   skirmisher   a short bow held level
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const boots = (d: Dress, top = 0.75): Dress => ({ ...d, boot: { mat: MAT.leather, top, cuff: MAT.paleLeather }, foot: MAT.darkLeather });

/** The ranger's short mantle: a cloth collar over the shoulders, longer at the back. */
function mantle(b: Build, mat: typeof MAT.cloth, len: number): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = b.pt.part("mantle", mat, GROUP.BODY, TAG.CLOTH);
  const top = { c: add(sk.neckBase, mul(sk.chest.y, -0.4)), rx: pl.chest.d * 0.7 + 0.4, rz: pl.chest.w * 0.6 + 0.4 };
  const bot = { c: add(sk.neckBase, add(mul(sk.chest.y, -len), mul(sk.chest.x, -0.8 - Math.max(0, b.pose.sway) * 0.3))), rx: pl.chest.d + 1.1, rz: pl.shoulderHalf + 1.2 };
  ring(b, top, bot, p, { n: 12, flare: 0.5, zBias: 0.7 });
}

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "leathers & mantle",
      dress: (c, d) => boots({ ...d, chest: MAT.leather, waist: MAT.leather, pelvis: trousers(c.pal, 3), upperArm: c.pal.primary, forearm: MAT.paleLeather, glove: { mat: MAT.leather, top: 0.45 }, thigh: trousers(c.pal, 3), shin: trousers(c.pal, 3) }),
      draw: (b, c) => {
        skirt(b, MAT.leather, { len: 4.5, flare: 0.8, split: "sides", name: "jerkinTails" });
        belt(b, MAT.darkLeather, MAT.bronze);
        mantle(b, c.pal.primary, 5.2);
      },
    },
    {
      name: "forester's tunic",
      dress: (c, d) => boots({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: trousers(c.pal, 1), upperArm: c.pal.primary, forearm: MAT.leather, glove: { mat: MAT.leather, top: 0.6 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1) }),
      draw: (b, c) => {
        skirt(b, c.pal.primary, { len: 6.5, flare: 1.0, split: "sides", name: "tunicTails" });
        belt(b, MAT.leather, MAT.bronze);
        beltItem(b, MAT.leather, [-0.6, -0.3, -b.sk.plan.pelvis.w - 0.3], [1.2, 1.2, 0.7]);
        // never a tan mantle over the chest: at arena size a skin-like collar reads as a bare chest
        mantle(b, c.pal.primaryDark, 4.2);
      },
    },
  ],
  1: [
    {
      name: "hunter's coat",
      // a brown leather coat with the class's green sleeves (a pale-leather coat merged with light skin into one tan figure)
      dress: (c, d) => boots({ ...d, chest: MAT.leather, waist: MAT.leather, pelvis: trousers(c.pal, 1), upperArm: c.pal.primary, forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.6 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1) }, 0.85),
      draw: (b, c) => {
        skirt(b, MAT.leather, { len: 7, flare: 1.1, split: "front", name: "coatTails" });
        belt(b, c.pal.secondary, MAT.bronze, { w: 1.6 });
        mantle(b, c.pal.primary, 5.6);
      },
    },
  ],
  2: [
    {
      name: "warden's leathers",
      dress: (c, d) => boots({ ...d, chest: MAT.darkLeather, waist: MAT.darkLeather, pelvis: c.pal.accent, upperArm: c.pal.primary, forearm: MAT.darkLeather, glove: { mat: MAT.darkLeather, top: 0.7 }, thigh: c.pal.accent, shin: c.pal.accent }, 0.85),
      draw: (b, c) => {
        skirt(b, c.pal.primary, { len: 7, flare: 1.1, split: "sides", name: "tails" });
        belt(b, MAT.darkLeather, MAT.gold, { w: 1.6 });
        mantle(b, c.pal.primaryDark, 6);
        pauldrons(b, MAT.darkLeather, { size: 0.75, layers: 2, trim: MAT.gold });
      },
    },
  ],
  3: [
    {
      name: "sylvan regalia",
      dress: (c, d) => boots({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: c.pal.accent, upperArm: c.pal.primary, forearm: MAT.paleLeather, glove: { mat: MAT.paleLeather, top: 0.7 }, thigh: c.pal.accent, shin: c.pal.accent }, 0.9),
      draw: (b, c) => {
        skirt(b, MAT.gold, { len: 7.8, flare: 1.2, split: "sides", name: "hem", zBias: 0.45 });
        skirt(b, c.pal.primary, { len: 7.2, flare: 1.15, split: "sides", name: "tails", zBias: 0.55 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.6 });
        mantle(b, c.pal.primaryDark, 6.2);
        pauldrons(b, MAT.gold, { size: 0.8, layers: 2, trim: c.pal.primaryDark });
      },
    },
  ],
};

type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };
const CAPS: Record<number, HeadDesign[]> = {
  0: [
    { name: "forester cap", draw: (b, c) => drawCap(b, { mat: c.pal.primary, feather: MAT.redFeather, band: null, point: 0.5 }) },
    { name: "plain cap", draw: (b, c) => drawCap(b, { mat: c.pal.primaryDark, feather: MAT.feather, band: null, point: 0.2 }) },
  ],
  1: [{ name: "banded cap", draw: (b, c) => drawCap(b, { mat: c.pal.primary, feather: MAT.redFeather, band: c.pal.secondary, point: 0.7 }) }],
  2: [{ name: "plumed cap", draw: (b, c) => drawCap(b, { mat: c.pal.primaryDark, feather: material("#b366ff", "cloth"), band: MAT.gold, point: 0.9 }) }],
  3: [{ name: "gilded cap", draw: (b, c) => drawCap(b, { mat: c.pal.primary, feather: MAT.paleGold, band: MAT.gold, point: 1.0 }) }],
};

function bows(c: LoadoutCtx): Array<{ name: string; spec: BowSpec }> {
  const k = c.g.plan.weapon.len;
  const warden = c.arch === "ranger-warden";
  const half = 9.5 * k;
  const bend = warden ? 1.6 : 2.6;
  const recurve = warden ? 0 : 0.9;
  const base = { half, bend, recurve, string: MAT.string, arrow: MAT.wood, fletch: MAT.feather, limbW: warden ? 2 : 2, tipMat: null };
  switch (c.tier) {
    case 0:
      return [{ name: warden ? "yew longbow" : "recurve", spec: { ...base, limb: MAT.wood, grip: MAT.leather } }];
    case 1:
      return [{ name: warden ? "horn longbow" : "horn recurve", spec: { ...base, limb: MAT.darkWood, grip: c.pal.secondary, tipMat: MAT.bone } }];
    case 2:
      return [{ name: warden ? "elven greatbow" : "elven bow", spec: { ...base, limb: MAT.paleWood, grip: MAT.darkLeather, tipMat: c.pal.gem, fletch: material("#b366ff", "cloth") } }];
    default:
      return [{ name: warden ? "sun greatbow" : "sun bow", spec: { ...base, limb: MAT.gold, grip: c.pal.primaryDark, tipMat: MAT.emerald, fletch: MAT.paleGold, arrow: MAT.paleWood } }];
  }
}

export function rangerLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const caps = CAPS[c.tier] ?? CAPS[0]!;
  const cap = caps[c.pick("helm", caps.length)] as HeadDesign;
  const pool = bows(c);
  const w = pool[c.pick("weapon", pool.length)] as { name: string; spec: BowSpec };
  const drawLen = (c.arch === "ranger-warden" ? 8.2 : c.arch === "ranger-skirmisher" ? 5.6 : 7) * c.g.plan.weapon.len ** 0.3;
  const headgear = c.g.headgear;
  return {
    hold: { main: "F", grip2: null, second: false, bow: { brace: 2.2, draw: drawLen }, shield: false },
    dress: armor.dress(c, baseDress(c.pal)),
    garments: (b) => {
      armor.draw(b, c);
      backCase(b, MAT.leather, { len: 8, r: 1.3, tilt: 0.45, contents: w.spec.fletch, trim: c.tier >= 2 ? MAT.gold : MAT.darkLeather });
      if (c.g.cape) cape(b, c.pal.accent, { len: 19, width: 0.95, collar: c.tier >= 3 ? MAT.gold : null });
    },
    head: (b) => (headgear === "cap" ? cap.draw(b, c) : null),
    weapon: (b): WeaponResult | null => {
      const sk = b.sk;
      if (!sk.weapon) return null;
      // the string meets the drawing hand (the near hand, solved onto it by the rig)
      const nock = b.pose.draw > 0.04 ? sk.handN : null;
      return drawBow(b, sk.weapon, w.spec, Math.min(1, b.pose.draw), nock);
    },
    attack: "attack_shoot",
    span: { up: w.spec.half, down: w.spec.half },
    names: [armor.name, headgear === "cap" ? cap.name : headgear ?? "bare", w.name],
  };
}
