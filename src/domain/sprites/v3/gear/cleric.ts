import type { Dress } from "../body";
import type { Build } from "../kit";
import { material, MAT } from "../materials";
import { add, mul } from "../vec";

import { belt, beltItem, cape, gorget, pauldrons, sash, skirt, torsoShell } from "./garments";
import { drawCrown, drawHalo, type HeadCover } from "./headgear";
import { baseDress, type Loadout, type LoadoutCtx } from "./loadout";
import { bellSleeves, highCollar, robeDress, robeSkirt, stole } from "./robes";
import { drawHaft, drawTome, haftSpan, type HaftSpec, type WeaponResult } from "./weapons";

/**
 * CLERIC loadouts — cream and gold vestments (never the Mage's deep robe), a gold stole, a HALO; a sun scepter, a holy mace or a sun-staff,
 * and a tome. The light lives on the weapon's sun disc, which brightens through a blessing.
 *
 *   priest    the scepter before the chest, the tome held open in the other hand
 *   templar   broad, a holy mace on the shoulder, the tome at the hip
 *   monk      slight, a tall sun-staff grounded, a hand raised in prayer
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const cream = material("#efe6cf", "cloth");

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "cassock",
      dress: (c, d) => robeDress(d, c.pal.secondary, { hands: c.pal.skin, feet: MAT.leather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.secondary);
        bellSleeves(b, c.pal.secondary, 0.7);
        sash(b, c.pal.primary, { tails: 6 });
      },
    },
    {
      name: "pilgrim robe",
      dress: (c, d) => robeDress(d, cream, { hands: c.pal.skin, feet: MAT.leather }),
      draw: (b, c) => {
        robeSkirt(b, cream, { trim: c.pal.accent });
        bellSleeves(b, cream, 0.6);
        belt(b, MAT.leather, MAT.bronze, { w: 1.2 });
        beltItem(b, MAT.paper, [-0.2, -0.6, -b.sk.plan.pelvis.w - 0.6], [1.0, 1.3, 0.6], "scroll");
        void c;
      },
    },
    {
      // a friar's habit in the hero's own cloth colour, a gold stole over it
      name: "friar's habit",
      dress: (c, d) => robeDress(d, c.pal.cloth, { hands: c.pal.skin, feet: MAT.leather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.cloth);
        bellSleeves(b, c.pal.cloth, 0.7);
        stole(b, c.pal.primary, 0.8);
        belt(b, MAT.string, null, { w: 1.0, name: "cord" });
      },
    },
  ],
  1: [
    {
      // a white vestment under a tabard in the class gold
      name: "tabard vestment",
      dress: (c, d) => robeDress(d, MAT.white, { hands: c.pal.skin, feet: MAT.paleLeather }),
      draw: (b, c) => {
        robeSkirt(b, MAT.white, { trim: c.pal.accent });
        bellSleeves(b, MAT.white, 0.8);
        torsoShell(b, c.pal.primary, { inflate: 0.6, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.9, name: "tabard" });
        skirt(b, c.pal.primary, { len: 11, flare: 1.2, split: "sides", name: "tabardTails", zBias: 0.5 });
        belt(b, c.pal.accent, MAT.bronze, { w: 1.3 });
      },
    },
    {
      name: "cassock & stole",
      dress: (c, d) => robeDress(d, c.pal.secondary, { hands: c.pal.skin, feet: MAT.leather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.secondary, { trim: c.pal.primary });
        bellSleeves(b, c.pal.secondary, 0.8);
        stole(b, c.pal.primary, 0.9);
        belt(b, c.pal.accent, MAT.bronze, { w: 1.3 });
      },
    },
  ],
  2: [
    {
      name: "vestments & mantle",
      dress: (c, d) => robeDress(d, c.pal.secondary, { hands: c.pal.skin, feet: MAT.paleLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.secondary, { trim: MAT.gold });
        bellSleeves(b, c.pal.secondary, 1.0);
        stole(b, c.pal.primary, 1.0);
        belt(b, MAT.gold, c.pal.gem, { w: 1.4 });
        pauldrons(b, c.pal.primary, { size: 0.95, layers: 2, trim: MAT.gold });
      },
    },
    {
      // a dalmatic in the hero's cloth colour over a cream robe, gold-hemmed
      name: "dalmatic",
      dress: (c, d) => robeDress(d, c.pal.secondary, { sleeve: c.pal.cloth, hands: c.pal.skin, feet: MAT.paleLeather }),
      draw: (b, c) => {
        robeSkirt(b, c.pal.secondary, { trim: MAT.gold });
        bellSleeves(b, c.pal.cloth, 1.0);
        torsoShell(b, c.pal.cloth, { inflate: 0.6, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.95, name: "dalmatic" });
        skirt(b, MAT.gold, { len: 12.5, flare: 1.3, split: "sides", name: "dalmaticHem", zBias: 0.45 });
        skirt(b, c.pal.cloth, { len: 12, flare: 1.25, split: "sides", name: "dalmaticTails", zBias: 0.55 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.4 });
      },
    },
  ],
  3: [
    {
      name: "radiant vestments",
      dress: (c, d) => robeDress(d, cream, { hands: c.pal.skin, feet: MAT.paleLeather }),
      draw: (b, c) => {
        robeSkirt(b, cream, { trim: MAT.gold });
        bellSleeves(b, cream, 1.1);
        stole(b, MAT.gold, 1.0);
        belt(b, MAT.gold, c.pal.gem, { w: 1.5 });
        highCollar(b, MAT.gold, 2.6);
        gorget(b, MAT.gold, { h: 0.9, r: 0.8 });
        pauldrons(b, c.pal.primary, { size: 1.0, layers: 2, trim: MAT.gold });
      },
    },
    {
      // a white robe under a gold sun-tabard, a gold mantle
      name: "sun robe",
      dress: (c, d) => robeDress(d, MAT.white, { hands: c.pal.skin, feet: MAT.paleLeather }),
      draw: (b, c) => {
        robeSkirt(b, MAT.white, { trim: c.pal.primary });
        bellSleeves(b, MAT.white, 1.1);
        torsoShell(b, MAT.gold, { inflate: 0.6, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.9, name: "sunTabard" });
        skirt(b, MAT.gold, { len: 13, flare: 1.3, split: "sides", name: "sunTails", zBias: 0.5 });
        belt(b, c.pal.accent, c.pal.gem, { w: 1.4 });
        pauldrons(b, MAT.gold, { size: 1.0, layers: 2, trim: c.pal.primary });
      },
    },
  ],
};

type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };
const HALOS: Record<number, HeadDesign[]> = {
  0: [{ name: "halo", draw: (b) => drawHalo(b, { mat: MAT.holy, r: 0.85, lift: 0.5, rays: false }) }],
  1: [{ name: "halo & circlet", draw: (b, c) => {
    drawCrown(b, { mat: MAT.gold, gem: c.pal.gem, points: 0, height: 0.3 });
    return drawHalo(b, { mat: MAT.holy, r: 0.9, lift: 0.5, rays: false });
  } }],
  2: [{ name: "radiant halo", draw: (b) => drawHalo(b, { mat: MAT.holy, r: 1.05, lift: 0.55, rays: true }) }],
  3: [{ name: "sun crown", draw: (b, c) => {
    drawCrown(b, { mat: MAT.gold, gem: c.pal.gem, points: 5, height: 0.9 });
    return drawHalo(b, { mat: MAT.holy, r: 1.15, lift: 0.75, rays: true });
  } }],
};

const haft = (o: Partial<HaftSpec> & Pick<HaftSpec, "head" | "headMat">): HaftSpec => ({ up: 5, down: 2.6, shaft: MAT.paleWood, shaftW: 1, headSize: 1.6, gem: MAT.topaz, glow: MAT.holy, band: MAT.gold, ...o });

function weapons(c: LoadoutCtx): Array<{ name: string; spec: HaftSpec }> {
  const templar = c.arch === "cleric-templar";
  const monk = c.arch === "cleric-monk";
  const k = c.g.plan.weapon.len;
  const up = monk ? 12 * k : templar ? 7 * k : 5.5;
  const down = monk ? 30 : templar ? 2.8 : 2.4;
  const head = templar ? "flanged" : "sun";
  const size = templar ? 1.8 : 1.6;
  switch (c.tier) {
    case 0:
      return [{ name: templar ? "holy mace" : monk ? "sun staff" : "sun scepter", spec: haft({ up, down, head, headMat: templar ? MAT.iron : MAT.bronze, headSize: size, shaft: monk ? MAT.wood : MAT.paleWood, band: MAT.bronze }) }];
    case 1:
      return [{ name: templar ? "blessed mace" : monk ? "blessed staff" : "blessed scepter", spec: haft({ up, down, head, headMat: templar ? MAT.steel : MAT.gold, headSize: size, gem: c.pal.gem }) }];
    case 2:
      return [{ name: templar ? "dawn mace" : monk ? "dawn staff" : "dawn scepter", spec: haft({ up, down, head, headMat: MAT.gold, headSize: size * 1.08, gem: c.pal.gem, shaft: MAT.paleWood }) }];
    default:
      return [{ name: templar ? "sunforged mace" : monk ? "sunforged staff" : "sunforged scepter", spec: haft({ up, down, head, headMat: MAT.paleGold, headSize: size * 1.15, gem: MAT.ruby, shaft: MAT.gold }) }];
  }
}

export function clericLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const halos = HALOS[c.tier] ?? HALOS[0]!;
  const halo = halos[c.pick("helm", halos.length)] as HeadDesign;
  const pool = weapons(c);
  const w = pool[c.pick("weapon", pool.length)] as { name: string; spec: HaftSpec };
  const headgear = c.g.headgear;
  const priest = c.arch === "cleric";
  const cover = c.tier >= 2 ? MAT.gold : c.pal.primary;
  return {
    hold: { main: "N", grip2: null, second: false, bow: null, shield: false },
    dress: armor.dress(c, baseDress(c.pal)),
    garments: (b) => {
      armor.draw(b, c);
      if (c.g.cape) cape(b, c.pal.accent, { len: 23, width: 1.0, collar: c.tier >= 3 ? MAT.gold : c.pal.trim });
      // the tome: hung at the hip (templar, monk) — the priest holds it (drawn with the weapon)
      if (!priest) beltItem(b, cover, [0.4, -1.4, -b.sk.plan.pelvis.w - 0.9], [1.5, 1.9, 0.7], "tome");
    },
    head: (b) => (headgear === "halo" ? halo.draw(b, c) : null),
    weapon: (b): WeaponResult | null => {
      const sk = b.sk;
      if (priest) {
        // the open tome rests on the far hand, its cover toward the viewer
        const h = sk.handF;
        drawTome(b, { o: add(h, mul(sk.chest.y, 1.2)), x: sk.chest.z, y: sk.chest.y, z: sk.chest.x }, { cover, pages: MAT.paper, clasp: MAT.gold, size: 2.0 });
      }
      return sk.weapon ? drawHaft(b, sk.weapon, w.spec, b.pose.glow) : null;
    },
    attack: "attack_thrust",
    span: haftSpan(w.spec),
    names: [armor.name, headgear === "halo" ? halo.name : headgear ?? "bare", w.name],
  };
}
