import type { Dress } from "../body";
import type { Build } from "../kit";
import { material, MAT } from "../materials";

import { belt, beltItem, cape, pauldrons, sash } from "./garments";
import { drawHood, drawWizardHat, type HeadCover } from "./headgear";
import { baseDress, type Loadout, type LoadoutCtx } from "./loadout";
import { bellSleeves, highCollar, robeDress, robeSkirt } from "./robes";
import { drawHaft, haftSpan, type HaftSpec, type WeaponResult } from "./weapons";

/**
 * MAGE loadouts — floor-length robes in the class purple, a tall pointed hat (or a cowl), a staff crowned by a crystal that LIGHTS UP as a
 * spell gathers (the pose's `glow`), the bolt leaving from the crystal (the muzzle).
 *
 *   scholar      a tall staff planted beside him, the free palm gathering light
 *   battlemage   a short staff held across the body in both hands
 *   sage         hunched over a tall crook staff
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "plain robe",
      dress: (c, d) => robeDress(d, c.pal.primary, { hands: c.pal.skin, feet: MAT.darkLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.primary);
        bellSleeves(b, c.pal.primary, 0.8);
        belt(b, MAT.leather, MAT.bronze, { w: 1.2 });
        beltItem(b, MAT.paper, [-0.2, -0.6, -b.sk.plan.pelvis.w - 0.6], [1.0, 1.3, 0.6], "scroll");
      },
    },
    {
      name: "traveler's robe",
      dress: (c, d) => robeDress(d, c.pal.primaryDark, { hands: c.pal.skin, feet: MAT.leather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.primaryDark);
        bellSleeves(b, c.pal.primaryDark, 0.7);
        sash(b, c.pal.secondary, { tails: 5 });
      },
    },
  ],
  1: [
    {
      name: "trimmed robe",
      dress: (c, d) => robeDress(d, c.pal.primary, { hands: c.pal.skin, feet: MAT.darkLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.primary, { trim: c.pal.secondary });
        bellSleeves(b, c.pal.secondary, 1.0);
        sash(b, c.pal.secondary, { tails: 6 });
      },
    },
  ],
  2: [
    {
      name: "layered robe",
      dress: (c, d) => robeDress(d, c.pal.primary, { sleeve: c.pal.accent, hands: c.pal.skin, feet: MAT.darkLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.primary, { trim: c.pal.accent });
        bellSleeves(b, c.pal.primary, 1.1);
        belt(b, c.pal.accent, c.pal.gem, { w: 1.6 });
        pauldrons(b, c.pal.primaryDark, { size: 0.95, layers: 2, trim: MAT.gold });
      },
    },
  ],
  3: [
    {
      name: "archmage robe",
      dress: (c, d) => robeDress(d, c.pal.primary, { sleeve: c.pal.primary, hands: c.pal.skin, feet: MAT.darkLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.primary, { trim: MAT.gold });
        bellSleeves(b, c.pal.primary, 1.2);
        belt(b, MAT.gold, c.pal.gem, { w: 1.6 });
        highCollar(b, c.pal.secondary, 3.4);
        pauldrons(b, c.pal.accent, { size: 1.0, layers: 2, trim: MAT.gold });
      },
    },
  ],
};

type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };
const HATS: Record<number, HeadDesign[]> = {
  0: [
    { name: "pointed hat", draw: (b, c) => drawWizardHat(b, { mat: c.pal.primary, band: c.pal.accent, height: 1.9, bend: 0.5, brim: 1.55, emblem: null }) },
    { name: "cowl", draw: (b, c) => drawHood(b, { mat: c.pal.primaryDark, inner: c.pal.accent, mask: null, point: 0.6, mantle: false }) },
  ],
  1: [{ name: "banded hat", draw: (b, c) => drawWizardHat(b, { mat: c.pal.primary, band: c.pal.secondary, height: 2.1, bend: 0.7, brim: 1.6, emblem: MAT.paleGold }) }],
  2: [{ name: "star hat", draw: (b, c) => drawWizardHat(b, { mat: c.pal.primaryDark, band: MAT.gold, height: 2.35, bend: 0.95, brim: 1.65, emblem: material("#9fe8ff", "gem") }) }],
  3: [{ name: "archmage hat", draw: (b, c) => drawWizardHat(b, { mat: c.pal.primary, band: MAT.gold, height: 2.5, bend: 1.1, brim: 1.72, emblem: c.pal.gem }) }],
};

const staff = (o: Partial<HaftSpec> & Pick<HaftSpec, "head" | "headMat">): HaftSpec => ({ up: 9, down: 14, shaft: MAT.wood, shaftW: 1, headSize: 1.5, gem: MAT.arcane, glow: MAT.arcane, band: null, ...o });

function staffs(c: LoadoutCtx): Array<{ name: string; spec: HaftSpec }> {
  const battle = c.arch === "mage-battle";
  const sage = c.arch === "mage-sage";
  const k = c.g.plan.weapon.len;
  const up = battle ? 9.5 : sage ? 9 : 9.5 * k;
  const down = battle ? 8.5 : 30; // a planted staff reaches the floor (the floor clips it)
  const head = sage ? "crook" : null;
  switch (c.tier) {
    case 0:
      return [{ name: "gnarled staff", spec: staff({ up, down, head: head ?? "orb", headMat: MAT.wood, shaft: MAT.wood }) }, { name: "claw staff", spec: staff({ up, down, head: head ?? "claw", headMat: MAT.darkWood, shaft: MAT.darkWood }) }];
    case 1:
      return [{ name: "banded staff", spec: staff({ up, down, head: head ?? "claw", headMat: MAT.bronze, band: MAT.bronze, shaft: MAT.darkWood, gem: MAT.sapphire, glow: MAT.frost }) }];
    case 2:
      return [{ name: "void staff", spec: staff({ up, down, head: head ?? "claw", headMat: MAT.blackIron, band: MAT.gold, shaft: MAT.blackIron, gem: MAT.amethyst, glow: MAT.arcane, headSize: 1.6 }) }];
    default:
      return [{ name: "astral staff", spec: staff({ up, down, head: head ?? "claw", headMat: MAT.gold, band: MAT.gold, shaft: MAT.paleWood, gem: c.pal.gem, glow: MAT.holy, headSize: 1.7 }) }];
  }
}

export function mageLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const hats = HATS[c.tier] ?? HATS[0]!;
  const hat = hats[c.pick("helm", hats.length)] as HeadDesign;
  const pool = staffs(c);
  const w = pool[c.pick("weapon", pool.length)] as { name: string; spec: HaftSpec };
  const headgear = c.g.headgear;
  const battle = c.arch === "mage-battle";
  return {
    hold: { main: "N", grip2: battle ? -6.0 : null, second: false, bow: null, shield: false },
    dress: armor.dress(c, baseDress(c.pal)),
    garments: (b) => {
      armor.draw(b, c);
      if (c.g.cape) cape(b, c.pal.accent, { len: 24, width: 1.0, collar: c.tier >= 3 ? MAT.gold : c.pal.trim });
    },
    head: (b) => (headgear === "hat" ? hat.draw(b, c) : null),
    weapon: (b): WeaponResult | null => (b.sk.weapon ? drawHaft(b, b.sk.weapon, w.spec, b.pose.glow) : null),
    attack: "attack_thrust",
    span: haftSpan(w.spec),
    names: [armor.name, headgear === "hat" ? hat.name : headgear ?? "bare", w.name],
  };
}
