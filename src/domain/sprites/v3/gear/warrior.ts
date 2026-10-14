import { GROUP, type Dress } from "../body";
import type { Material } from "../gbuffer";
import { material, MAT } from "../materials";
import type { Build } from "../kit";
import { fp } from "../view";

import { belt, cape, gorget, pauldrons, skirt, studs, torsoShell } from "./garments";
import { drawCrown, drawHelm, type HeadCover, type HelmSpec } from "./headgear";
import { baseDress, trousers, type Loadout, type LoadoutCtx } from "./loadout";
import { bladeSpan, drawBlade, drawShield, type BladeSpec, type WeaponResult } from "./weapons";

/**
 * WARRIOR loadouts — tabards, mail and plate; open-faced helms; swords. Three builds: the vanguard (one-handed sword, free fist), the brute (a
 * greatsword in both hands), the duelist (a slim blade and a buckler).
 *
 *   Common     gambeson · mail & tabard · leather jerkin       nasal helm · kettle hat · headband · mail coif        arming sword · falchion
 *   Rare       trimmed tabard · brigandine                      bascinet · sallet · trimmed nasal                     longsword (gem pommel)
 *   Epic       breastplate over mail · lamellar  + pauldrons    plumed · horned · crested helm                        runeblade
 *   Legendary  gilded plate · dragon plate  + great pauldrons   winged · crowned · finned helm                        sunblade
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const leatherBoots = (d: Dress, top = 0.55): Dress => ({ ...d, boot: { mat: MAT.leather, top, cuff: MAT.darkLeather }, foot: MAT.darkLeather });

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "gambeson",
      dress: (c, d) => leatherBoots({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: trousers(c.pal, 1), upperArm: c.pal.primary, forearm: c.pal.primary, glove: { mat: MAT.leather, top: 0.25 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1), armBulk: 1.12, torsoBulk: 1.08 }),
      draw: (b, c) => {
        skirt(b, c.pal.primary, { len: 6.5, flare: 1.0, split: "front" });
        belt(b, MAT.leather, MAT.bronze);
        gorget(b, c.pal.primaryDark, { h: 1.2, r: 0.7 });
      },
    },
    {
      name: "mail & tabard",
      dress: (c, d) => leatherBoots({ ...d, chest: c.pal.mail, waist: c.pal.mail, pelvis: c.pal.mail, upperArm: c.pal.mail, forearm: c.pal.mail, glove: { mat: MAT.leather, top: 0.3 }, thigh: trousers(c.pal, 2), shin: trousers(c.pal, 2), armBulk: 1.06 }),
      draw: (b, c) => {
        torsoShell(b, c.pal.primary, { inflate: 0.45, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.96, name: "tabard" });
        skirt(b, c.pal.mail, { len: 5, flare: 0.6, name: "mailSkirt" });
        skirt(b, c.pal.primary, { len: 7.5, flare: 0.9, split: "sides", name: "tabardTails", zBias: 0.5 });
        belt(b, MAT.leather, MAT.bronze);
      },
    },
    {
      name: "jerkin",
      dress: (c, d) => leatherBoots({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: trousers(c.pal, 0), upperArm: c.pal.primary, forearm: c.pal.skin, glove: { mat: MAT.leather, top: 0.45 }, thigh: trousers(c.pal, 0), shin: trousers(c.pal, 0) }),
      draw: (b) => {
        torsoShell(b, MAT.leather, { inflate: 0.5, waist: true, keep: (x, _y, z, w) => !(x > 0 && Math.abs(z) < w * 0.22), name: "jerkin" });
        skirt(b, MAT.leather, { len: 4.5, flare: 0.7, split: "front", name: "jerkinSkirt" });
        belt(b, MAT.darkLeather, MAT.iron);
      },
    },
  ],
  1: [
    {
      name: "trimmed tabard",
      dress: (c, d) => leatherBoots({ ...d, chest: c.pal.mail, waist: c.pal.mail, pelvis: c.pal.mail, upperArm: c.pal.mail, forearm: c.pal.mail, glove: { mat: c.pal.metal, top: 0.55 }, thigh: trousers(c.pal, 2), shin: trousers(c.pal, 2), armBulk: 1.06 }, 0.62),
      draw: (b, c) => {
        torsoShell(b, c.pal.secondary, { inflate: 0.55, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.72, name: "tabardTrim" });
        torsoShell(b, c.pal.primary, { inflate: 0.6, waist: true, keep: (_x, _y, z, w) => Math.abs(z) < w * 0.6, name: "tabard", zBias: 0.4 });
        skirt(b, c.pal.mail, { len: 5, flare: 0.6, name: "mailSkirt" });
        skirt(b, c.pal.secondary, { len: 8, flare: 1.0, split: "sides", name: "tabardHem", zBias: 0.45 });
        skirt(b, c.pal.primary, { len: 7.2, flare: 0.95, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, MAT.darkLeather, MAT.bronze);
        pauldrons(b, c.pal.metal, { size: 0.8, layers: 1, trim: null });
      },
    },
    {
      name: "brigandine",
      dress: (c, d) => leatherBoots({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: c.pal.mail, upperArm: c.pal.mail, forearm: c.pal.mail, glove: { mat: MAT.leather, top: 0.5 }, thigh: trousers(c.pal, 1), shin: trousers(c.pal, 1), torsoBulk: 1.1 }, 0.6),
      draw: (b, c) => {
        const pl = b.sk.plan;
        skirt(b, c.pal.mail, { len: 5.5, flare: 0.8, name: "mailSkirt" });
        belt(b, MAT.darkLeather, MAT.bronze);
        studs(b, MAT.bronze, [[pl.chest.d * 0.9, 2.2, 1.8], [pl.chest.d * 0.95, 0.2, 2.2], [pl.chest.d * 0.95, 2.0, -0.6], [pl.chest.d * 0.9, -1.5, 1.2]], 0.42);
        pauldrons(b, MAT.leather, { size: 0.85, layers: 2, trim: MAT.bronze });
      },
    },
  ],
  2: [
    {
      name: "breastplate",
      dress: (c, d) => ({ ...d, chest: c.pal.mail, waist: c.pal.mail, pelvis: c.pal.mail, upperArm: c.pal.mail, forearm: c.pal.metal, glove: { mat: c.pal.metal, top: 0.6 }, thigh: trousers(c.pal, 2), shin: c.pal.metal, boot: { mat: c.pal.metal, top: 0.9 }, foot: c.pal.metal, armBulk: 1.08, legBulk: 1.05 }),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 0.7, waist: true, name: "breastplate" });
        skirt(b, c.pal.mail, { len: 5, flare: 0.7, name: "mailSkirt" });
        skirt(b, c.pal.primary, { len: 8, flare: 1.1, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, MAT.darkLeather, MAT.gold);
        pauldrons(b, c.pal.metal, { size: 1.0, layers: 2, trim: MAT.gold });
      },
    },
    {
      name: "lamellar",
      dress: (c, d) => ({ ...d, chest: c.pal.primary, waist: c.pal.primary, pelvis: c.pal.mail, upperArm: c.pal.mail, forearm: c.pal.metal, glove: { mat: MAT.darkLeather, top: 0.55 }, thigh: trousers(c.pal, 0), shin: c.pal.metal, boot: { mat: MAT.darkLeather, top: 0.85, cuff: c.pal.metal }, foot: MAT.darkLeather, torsoBulk: 1.1 }),
      draw: (b, c) => {
        // bands of plates over the class cloth: alternating rows
        torsoShell(b, c.pal.metal, { inflate: 0.55, waist: true, keep: (_x, y) => ((Math.floor((y + 40) / 1.6) & 1) === 0), name: "lames" });
        skirt(b, c.pal.primary, { len: 7, flare: 1.0, name: "skirt" });
        belt(b, c.pal.secondary, MAT.gold, { w: 1.8 });
        pauldrons(b, c.pal.metal, { size: 1.05, layers: 3, trim: null });
      },
    },
  ],
  3: [
    {
      name: "gilded plate",
      dress: (c, d) => ({ ...d, chest: c.pal.metal, waist: c.pal.metal, pelvis: c.pal.mail, upperArm: c.pal.metal, forearm: c.pal.metal, glove: { mat: c.pal.metal, top: 0.65 }, thigh: c.pal.metal, shin: c.pal.metal, boot: { mat: c.pal.metal, top: 0.95, cuff: MAT.gold }, foot: c.pal.metal, armBulk: 1.12, legBulk: 1.1, torsoBulk: 1.05 }),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 0.75, waist: true, name: "cuirass" });
        torsoShell(b, MAT.gold, { inflate: 0.85, chest: true, keep: (x, y, z, w) => (x > 0 && Math.abs(z) < 0.6 && y > -1.5) || (y > 3.1 && Math.abs(z) < w), name: "gilt", zBias: 0.45 });
        skirt(b, MAT.gold, { len: 8.6, flare: 1.2, split: "sides", name: "tabardHem", zBias: 0.5 });
        skirt(b, c.pal.primary, { len: 8, flare: 1.15, split: "sides", name: "tabardTails", zBias: 0.6 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.6 });
        gorget(b, MAT.gold, { h: 1.3, r: 0.9 });
        pauldrons(b, c.pal.metal, { size: 1.18, layers: 3, trim: MAT.gold, flare: 1.1 });
      },
    },
    {
      name: "dragon plate",
      dress: (c, d) => ({ ...d, chest: c.pal.primaryDark, waist: c.pal.primaryDark, pelvis: c.pal.mail, upperArm: c.pal.primaryDark, forearm: c.pal.metal, glove: { mat: c.pal.metal, top: 0.65 }, thigh: c.pal.primaryDark, shin: c.pal.metal, boot: { mat: c.pal.metal, top: 0.92, cuff: MAT.gold }, foot: c.pal.metal, armBulk: 1.1, legBulk: 1.08, torsoBulk: 1.06 }),
      draw: (b, c) => {
        // scale rows in the class colour over a dark ground, a gold breast-boss
        torsoShell(b, c.pal.primary, { inflate: 0.6, waist: true, keep: (x, y, z) => ((Math.floor((y + 40) / 1.3) + Math.floor((z + x * 0.5 + 40) / 1.6)) & 1) === 0, name: "scales" });
        skirt(b, c.pal.primary, { len: 8, flare: 1.15, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.6 });
        gorget(b, MAT.gold, { h: 1.2, r: 0.85 });
        pauldrons(b, c.pal.metal, { size: 1.2, layers: 2, trim: MAT.gold, spikes: MAT.gold });
      },
    },
  ],
};

// ------------------------------------------------------------------------------------------------ helms

const helm = (o: Partial<HelmSpec> & Pick<HelmSpec, "mat">): HelmSpec => ({ dome: "round", trim: null, face: "open", coif: null, brim: 0, nasal: false, crest: null, crestMat: null, bevor: false, tail: false, ...o });

type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };

const HELMS: Record<number, HeadDesign[]> = {
  0: [
    { name: "nasal helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "cone", nasal: true })) },
    { name: "kettle hat", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, brim: 1.32, dome: "flat" })) },
    { name: "headband", draw: (b, c) => drawCrown(b, { mat: c.pal.primary, gem: null, points: 0, height: 0.4 }) },
    { name: "mail coif", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.mail, coif: c.pal.mail, face: "open", dome: "round" })) },
  ],
  1: [
    { name: "bascinet", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "tall", face: "cheeks", trim: MAT.bronze })) },
    { name: "sallet", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "round", tail: true, trim: MAT.bronze, brim: 1.18 })) },
    { name: "nasal helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "cone", nasal: true, trim: MAT.bronze, coif: c.pal.mail })) },
  ],
  2: [
    { name: "plumed helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, face: "cheeks", trim: MAT.gold, crest: "plume", crestMat: c.pal.primary })) },
    { name: "horned helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, face: "open", trim: MAT.gold, crest: "horns", crestMat: MAT.bone })) },
    { name: "crested helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "tall", face: "cheeks", trim: MAT.gold, crest: "ridge", crestMat: c.pal.primary })) },
  ],
  3: [
    { name: "winged helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, face: "cheeks", trim: MAT.gold, crest: "wings", crestMat: MAT.paleGold })) },
    { name: "crowned helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "round", face: "open", trim: MAT.gold, crest: "crown", crestMat: MAT.gold })) },
    { name: "finned helm", draw: (b, c) => drawHelm(b, helm({ mat: MAT.gold, dome: "tall", face: "cheeks", trim: c.pal.metal, crest: "fins", crestMat: c.pal.primary })) },
  ],
};

// ------------------------------------------------------------------------------------------------ blades

const blade = (o: Partial<BladeSpec> & Pick<BladeSpec, "blade">): BladeSpec => ({ len: 13, w: 3, grip: 3, guard: 2.6, guardDrop: 0, pommel: "disc", hilt: MAT.iron, wrap: MAT.leather, gem: null, runes: null, curve: 0, belly: 0, ...o });

const SWORDS = (c: LoadoutCtx): Array<{ name: string; spec: BladeSpec }> => {
  const steel = MAT.steel;
  switch (c.tier) {
    case 0:
      return [{ name: "arming sword", spec: blade({ blade: steel }) }, { name: "falchion", spec: blade({ blade: MAT.iron, len: 12, belly: 1, curve: 1.1, guard: 2.2 }) }];
    case 1:
      return [{ name: "longsword", spec: blade({ blade: steel, len: 14.5, guard: 3, guardDrop: 0.7, pommel: "gem", gem: c.pal.gem, hilt: MAT.bronze }) }, { name: "broadsword", spec: blade({ blade: steel, len: 13.5, w: 4, guard: 3.2, hilt: MAT.bronze, pommel: "ball" }) }];
    case 2:
      return [{ name: "runeblade", spec: blade({ blade: steel, len: 15, guard: 3.2, guardDrop: -0.6, pommel: "gem", gem: c.pal.gem, hilt: MAT.blackIron, wrap: MAT.darkLeather, runes: MAT.ember }) }];
    default:
      return [{ name: "sunblade", spec: blade({ blade: MAT.silver, len: 15.5, w: 4, guard: 3.8, guardDrop: -1.0, pommel: "gem", gem: MAT.ruby, hilt: MAT.gold, wrap: c.pal.primaryDark, runes: MAT.holy }) }];
  }
};

const GREATSWORDS = (c: LoadoutCtx): Array<{ name: string; spec: BladeSpec }> => {
  const s = (o: Partial<BladeSpec> & Pick<BladeSpec, "blade">) => blade({ len: 20, w: 4, grip: 5.6, guard: 4, guardDrop: 1.0, ...o });
  switch (c.tier) {
    case 0:
      return [{ name: "claymore", spec: s({ blade: MAT.steel }) }, { name: "great falchion", spec: s({ blade: MAT.iron, len: 18.5, belly: 1, curve: 1.6, guard: 3.2, guardDrop: 0 }) }];
    case 1:
      return [{ name: "zweihander", spec: s({ blade: MAT.steel, len: 21, guard: 4.6, guardDrop: 0.4, hilt: MAT.bronze, pommel: "gem", gem: c.pal.gem }) }];
    case 2:
      return [{ name: "executioner", spec: s({ blade: MAT.steel, len: 19.5, belly: 1, guard: 3.6, hilt: MAT.blackIron, wrap: MAT.darkLeather, runes: MAT.ember, pommel: "gem", gem: c.pal.gem }) }];
    default:
      return [{ name: "dawnbreaker", spec: s({ blade: MAT.silver, len: 21.5, guard: 5, guardDrop: -1.2, hilt: MAT.gold, wrap: c.pal.primaryDark, runes: MAT.holy, pommel: "gem", gem: MAT.ruby }) }];
  }
};

const DUELIST = (c: LoadoutCtx): Array<{ name: string; spec: BladeSpec }> => {
  const s = (o: Partial<BladeSpec> & Pick<BladeSpec, "blade">) => blade({ len: 15, w: 2, grip: 2.6, guard: 2.2, guardDrop: -0.6, ...o });
  switch (c.tier) {
    case 0:
      return [{ name: "sabre", spec: s({ blade: MAT.steel, curve: 1.4, w: 2, len: 13.5 }) }, { name: "rapier", spec: s({ blade: MAT.steel }) }];
    case 1:
      return [{ name: "rapier", spec: s({ blade: MAT.steel, hilt: MAT.bronze, pommel: "gem", gem: c.pal.gem, len: 16 }) }];
    case 2:
      return [{ name: "rune rapier", spec: s({ blade: MAT.steel, hilt: MAT.blackIron, runes: MAT.ember, pommel: "gem", gem: c.pal.gem, len: 16 }) }];
    default:
      return [{ name: "sun rapier", spec: s({ blade: MAT.silver, hilt: MAT.gold, runes: MAT.holy, pommel: "gem", gem: MAT.ruby, len: 16.5, guard: 2.8 }) }];
  }
};

const BUCKLER = (c: LoadoutCtx): { face: Material; rim: Material; boss: Material | null } => {
  switch (c.tier) {
    case 0:
      return { face: MAT.wood, rim: MAT.iron, boss: MAT.iron };
    case 1:
      return { face: c.pal.primary, rim: MAT.bronze, boss: MAT.bronze };
    case 2:
      return { face: c.pal.metal, rim: MAT.gold, boss: c.pal.gem };
    default:
      return { face: MAT.gold, rim: c.pal.metal, boss: MAT.ruby };
  }
};

export function warriorLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const helms = HELMS[c.tier] ?? HELMS[0]!;
  const helmD = helms[c.pick("helm", helms.length)] as HeadDesign;
  const dress = armor.dress(c, baseDress(c.pal));
  const brute = c.arch === "warrior-brute";
  const duelist = c.arch === "warrior-duelist";
  const pool = brute ? GREATSWORDS(c) : duelist ? DUELIST(c) : SWORDS(c);
  const w = pool[c.pick("weapon", pool.length)] as { name: string; spec: BladeSpec };
  const scale = c.g.plan.weapon;
  const spec: BladeSpec = { ...w.spec, len: w.spec.len * (brute ? 1 : scale.len) };
  const headgear = c.g.headgear;
  return {
    hold: { main: "N", grip2: brute ? -3.1 : null, second: duelist, bow: null, shield: false },
    dress,
    garments: (b) => {
      armor.draw(b, c);
      if (c.g.cape) cape(b, c.pal.accent, { len: 22, width: 1.0, collar: c.tier >= 3 ? MAT.gold : c.pal.trim });
      // the vanguard's scabbard at the far hip
      if (!brute && !duelist) {
        const sk = b.sk;
        const p = b.pt.part("scabbard", MAT.darkLeather, GROUP.BODY, 16, -1);
        const a = fp(sk.pelvis, -1.2, 0.6, -sk.plan.pelvis.w - 0.6);
        const e = fp(sk.pelvis, -6.5, -5.5, -sk.plan.pelvis.w - 0.9);
        b.pt.capsule(a, e, 0.85, 0.7, p, { zBias: -0.2 });
      }
    },
    head: (b) => (headgear === "helm" ? helmD.draw(b, c) : null),
    weapon: (b): WeaponResult | null => {
      const sk = b.sk;
      if (!sk.weapon) return null;
      const r = drawBlade(b, sk.weapon, spec);
      if (duelist && sk.weapon2) {
        const bk = BUCKLER(c);
        // the buckler is gripped in the far fist: its face looks along the off weapon's aim
        const f = sk.weapon2;
        drawShield(b, { o: fp(f, 0, 0.2, 0), x: f.y, y: f.x, z: f.z }, { shape: "buckler", w: 3.1, h: 3.1, face: bk.face, rim: bk.rim, boss: bk.boss, device: "none", deviceMat: null, studs: null });
      }
      return r;
    },
    attack: "attack_slash",
    span: bladeSpan(spec),
    names: [armor.name, headgear === "helm" ? helmD.name : headgear ?? "bare", w.name],
  };
}

export const WARRIOR_DESIGN_COUNTS = { armor: ARMOR, helms: HELMS };
export const leather = material("#7a563a", "leather");
