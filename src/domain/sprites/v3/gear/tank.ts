import type { Dress } from "../body";
import type { Material } from "../gbuffer";
import type { Build } from "../kit";
import { MAT } from "../materials";

import { belt, cape, gorget, pauldrons, skirt, studs, torsoShell } from "./garments";
import { drawHelm, type HeadCover, type HelmSpec } from "./headgear";
import { baseDress, trousers, type Loadout, type LoadoutCtx } from "./loadout";
import { drawHaft, drawShield, haftSpan, type HaftSpec, type ShieldSpec, type WeaponResult } from "./weapons";

/**
 * TANK loadouts — plate, a shield strapped to the far forearm, a mace / maul / hammer. The shield is part of the arm: it moves with the forearm
 * and covers the body below the chin (the face reads over its rim), turned toward the viewer so its face — and its device — read.
 *
 *   bulwark      tower or heater shield forward at the waist, a flanged mace
 *   juggernaut   the biggest body: the shield held high, a two-fisted maul head on a short haft
 *   sentinel     a tall knight: the shield grounded, a long-hafted war hammer
 */

interface ArmorDesign {
  name: string;
  dress: (c: LoadoutCtx, d: Dress) => Dress;
  draw: (b: Build, c: LoadoutCtx) => void;
}

const plateDress = (c: LoadoutCtx, d: Dress, o: { chest?: Material; arms?: Material; legs?: Material } = {}): Dress => ({
  ...d,
  chest: o.chest ?? c.pal.metal, waist: o.chest ?? c.pal.metal, pelvis: c.pal.mail,
  upperArm: o.arms ?? c.pal.metal, forearm: c.pal.metal, glove: { mat: c.pal.metal, top: 0.62 },
  thigh: o.legs ?? c.pal.metal, shin: c.pal.metal, boot: { mat: c.pal.metal, top: 0.95 }, foot: c.pal.metal,
  armBulk: 1.12, legBulk: 1.1, torsoBulk: 1.06,
});

const ARMOR: Record<number, ArmorDesign[]> = {
  0: [
    {
      name: "plate & surcoat",
      dress: (c, d) => plateDress(c, d, { legs: trousers(c.pal, 2) }),
      draw: (b, c) => {
        torsoShell(b, c.pal.primary, { inflate: 0.75, waist: true, keep: (_x, y, z, w) => Math.abs(z) < w * 0.95 && y < 3.2, name: "surcoat" });
        skirt(b, c.pal.mail, { len: 5, flare: 0.7, name: "mailSkirt" });
        skirt(b, c.pal.primary, { len: 8, flare: 1.1, split: "sides", name: "surcoatTails", zBias: 0.5 });
        belt(b, MAT.darkLeather, MAT.iron);
        pauldrons(b, c.pal.metal, { size: 1.05, layers: 2, trim: null });
      },
    },
    {
      name: "scale coat",
      dress: (c, d) => plateDress(c, d, { chest: MAT.leather, arms: c.pal.mail, legs: trousers(c.pal, 1) }),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 0.5, waist: true, keep: (x, y, z) => ((Math.floor((y + 40) / 1.3) + Math.floor((z + x * 0.4 + 40) / 1.7)) & 1) === 0, name: "scales" });
        skirt(b, c.pal.metal, { len: 6.5, flare: 1.0, name: "scaleSkirt" });
        belt(b, MAT.darkLeather, MAT.bronze, { w: 1.8 });
        pauldrons(b, c.pal.metal, { size: 1.0, layers: 2, trim: MAT.bronze });
      },
    },
  ],
  1: [
    {
      name: "full plate",
      dress: (c, d) => plateDress(c, d),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 0.8, waist: true, name: "cuirass" });
        skirt(b, c.pal.metal, { len: 5.5, flare: 1.0, name: "faulds" });
        skirt(b, c.pal.primary, { len: 8.4, flare: 1.2, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, c.pal.primaryDark, MAT.bronze, { w: 1.6 });
        gorget(b, c.pal.metal, { h: 1.2, r: 0.9 });
        pauldrons(b, c.pal.metal, { size: 1.12, layers: 3, trim: MAT.bronze });
      },
    },
    {
      name: "heavy brigandine",
      dress: (c, d) => plateDress(c, d, { chest: c.pal.primary, arms: c.pal.mail }),
      draw: (b, c) => {
        const pl = b.sk.plan;
        skirt(b, c.pal.primary, { len: 7, flare: 1.1, name: "skirt" });
        belt(b, MAT.darkLeather, MAT.bronze, { w: 1.8 });
        studs(b, MAT.bronze, [[pl.chest.d * 0.95, 2.4, 2.0], [pl.chest.d * 1.0, 0.4, 2.5], [pl.chest.d * 1.0, 2.2, -0.4], [pl.chest.d * 0.95, -1.6, 1.4], [pl.chest.d * 0.9, -1.4, -1.2]], 0.45);
        gorget(b, c.pal.metal, { h: 1.2, r: 0.9 });
        pauldrons(b, c.pal.metal, { size: 1.15, layers: 2, trim: MAT.bronze });
      },
    },
  ],
  2: [
    {
      name: "great plate",
      dress: (c, d) => plateDress(c, d),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 0.95, waist: true, name: "cuirass" });
        torsoShell(b, MAT.gold, { inflate: 1.05, chest: true, keep: (x, y) => x > 0 && y > 3.6, name: "gilt", zBias: 0.4 });
        skirt(b, c.pal.metal, { len: 6, flare: 1.2, name: "faulds" });
        skirt(b, c.pal.primary, { len: 9, flare: 1.3, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, MAT.darkLeather, MAT.gold, { w: 1.8 });
        gorget(b, MAT.gold, { h: 1.3, r: 1.0 });
        pauldrons(b, c.pal.metal, { size: 1.3, layers: 3, trim: MAT.gold, flare: 1.1 });
      },
    },
    {
      name: "spiked plate",
      dress: (c, d) => plateDress(c, d, { chest: MAT.blackIron, arms: MAT.blackIron }),
      draw: (b, c) => {
        torsoShell(b, MAT.blackIron, { inflate: 0.9, waist: true, name: "cuirass" });
        skirt(b, MAT.blackIron, { len: 6, flare: 1.2, name: "faulds" });
        skirt(b, c.pal.primary, { len: 8.6, flare: 1.25, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, c.pal.primaryDark, MAT.gold, { w: 1.8 });
        pauldrons(b, MAT.blackIron, { size: 1.3, layers: 2, trim: MAT.gold, spikes: c.pal.metal });
      },
    },
  ],
  3: [
    {
      name: "golden bastion",
      dress: (c, d) => plateDress(c, d),
      draw: (b, c) => {
        torsoShell(b, c.pal.metal, { inflate: 1.0, waist: true, name: "cuirass" });
        torsoShell(b, MAT.gold, { inflate: 1.1, chest: true, keep: (x, y, z) => (x > 0 && Math.abs(z) < 0.7) || y > 3.4, name: "gilt", zBias: 0.4 });
        skirt(b, MAT.gold, { len: 9.6, flare: 1.4, split: "sides", name: "tabardHem", zBias: 0.5 });
        skirt(b, c.pal.primary, { len: 9, flare: 1.35, split: "sides", name: "tabardTails", zBias: 0.6 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.8 });
        gorget(b, MAT.gold, { h: 1.4, r: 1.1 });
        pauldrons(b, MAT.gold, { size: 1.42, layers: 3, trim: c.pal.metal, flare: 1.15 });
      },
    },
    {
      name: "dragon bastion",
      dress: (c, d) => plateDress(c, d, { chest: c.pal.primaryDark, arms: c.pal.metal }),
      draw: (b, c) => {
        torsoShell(b, c.pal.primary, { inflate: 0.8, waist: true, keep: (x, y, z) => ((Math.floor((y + 40) / 1.3) + Math.floor((z + x * 0.5 + 40) / 1.6)) & 1) === 0, name: "scales" });
        skirt(b, c.pal.metal, { len: 6, flare: 1.2, name: "faulds" });
        skirt(b, c.pal.primary, { len: 9, flare: 1.3, split: "sides", name: "tabardTails", zBias: 0.55 });
        belt(b, MAT.gold, c.pal.gem, { w: 1.8 });
        gorget(b, MAT.gold, { h: 1.3, r: 1.0 });
        pauldrons(b, c.pal.metal, { size: 1.42, layers: 2, trim: MAT.gold, spikes: MAT.gold });
      },
    },
  ],
};

const helm = (o: Partial<HelmSpec> & Pick<HelmSpec, "mat">): HelmSpec => ({ dome: "round", trim: null, face: "open", coif: null, brim: 0, nasal: false, crest: null, crestMat: null, bevor: false, tail: false, ...o });
type HeadDesign = { name: string; draw: (b: Build, c: LoadoutCtx) => HeadCover | null };

const HELMS: Record<number, HeadDesign[]> = {
  0: [
    { name: "kettle & bevor", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, brim: 1.3, dome: "flat", bevor: true })) },
    { name: "bascinet & bevor", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "tall", face: "cheeks", bevor: true })) },
  ],
  1: [
    { name: "sallet & bevor", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "round", tail: true, brim: 1.15, bevor: true, trim: MAT.bronze })) },
    { name: "T-visor helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "flat", face: "T", trim: MAT.bronze })) },
  ],
  2: [
    { name: "great helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "flat", face: "T", trim: MAT.gold, crest: "ridge", crestMat: c.pal.primary })) },
    { name: "horned great helm", draw: (b) => drawHelm(b, helm({ mat: MAT.blackIron, dome: "flat", face: "T", trim: MAT.gold, crest: "horns", crestMat: MAT.bone })) },
  ],
  3: [
    { name: "crowned great helm", draw: (b, c) => drawHelm(b, helm({ mat: c.pal.metal, dome: "flat", face: "slit", trim: MAT.gold, crest: "crown", crestMat: MAT.gold })) },
    { name: "plumed great helm", draw: (b, c) => drawHelm(b, helm({ mat: MAT.gold, dome: "tall", face: "T", trim: c.pal.metal, crest: "plume", crestMat: c.pal.primary })) },
  ],
};

const haft = (o: Partial<HaftSpec> & Pick<HaftSpec, "head" | "headMat">): HaftSpec => ({ up: 7, down: 2.6, shaft: MAT.wood, shaftW: 1, headSize: 1.7, gem: null, glow: null, band: MAT.iron, ...o });

function weaponPool(c: LoadoutCtx): Array<{ name: string; spec: HaftSpec }> {
  const jug = c.arch === "tank-juggernaut";
  const sen = c.arch === "tank-sentinel";
  const k = c.g.plan.weapon;
  const up = (sen ? 13 : jug ? 6 : 7.5) * (sen ? 1 : k.len);
  const down = sen ? 4.5 : 2.6;
  const head = jug ? "maul" : sen ? "hammer" : null;
  const size = (sen ? 1.5 : jug ? 2.1 : 1.75) * k.w;
  const mk = (h: HaftSpec["head"], mat: Material, extra: Partial<HaftSpec> = {}) => haft({ up, down, head: head ?? h, headMat: mat, headSize: size, shaftW: jug || sen ? 2 : 1, ...extra });
  switch (c.tier) {
    case 0:
      return [{ name: jug ? "maul" : sen ? "war hammer" : "flanged mace", spec: mk("flanged", MAT.iron) }, { name: jug ? "maul" : sen ? "war hammer" : "morning star", spec: mk("star", MAT.iron, { shaft: MAT.darkWood }) }];
    case 1:
      return [{ name: jug ? "steel maul" : sen ? "steel hammer" : "steel mace", spec: mk("flanged", MAT.steel, { band: MAT.bronze, shaft: MAT.darkWood }) }];
    case 2:
      return [{ name: jug ? "rune maul" : sen ? "rune hammer" : "rune mace", spec: mk("star", MAT.blackIron, { band: MAT.gold, shaft: MAT.blackIron, gem: c.pal.gem }) }];
    default:
      return [{ name: jug ? "sun maul" : sen ? "sun hammer" : "sun mace", spec: mk("flanged", MAT.gold, { band: MAT.gold, shaft: MAT.darkWood, gem: MAT.ruby }) }];
  }
}

function shieldPool(c: LoadoutCtx): Array<{ name: string; spec: ShieldSpec }> {
  const jug = c.arch === "tank-juggernaut";
  const sen = c.arch === "tank-sentinel";
  const s = (o: Partial<ShieldSpec> & Pick<ShieldSpec, "shape" | "face" | "rim">): ShieldSpec => ({
    w: jug ? 5.2 : sen ? 4.6 : 4.6, h: jug ? 7.4 : sen ? 8.4 : 7.6, boss: null, device: "none", deviceMat: null, studs: null, ...o,
  });
  switch (c.tier) {
    case 0:
      return [
        { name: "wooden tower", spec: s({ shape: "tower", face: MAT.wood, rim: MAT.iron, studs: MAT.iron }) },
        { name: "heater", spec: s({ shape: "heater", face: c.pal.primary, rim: MAT.iron, device: "stripe", deviceMat: c.pal.secondary }) },
      ];
    case 1:
      return [
        { name: "painted heater", spec: s({ shape: "heater", face: c.pal.primary, rim: MAT.bronze, device: "chevron", deviceMat: c.pal.secondary }) },
        { name: "banded tower", spec: s({ shape: "tower", face: c.pal.primary, rim: c.pal.metal, device: "cross", deviceMat: c.pal.secondary, boss: MAT.bronze }) },
      ];
    case 2:
      return [{ name: "steel kite", spec: s({ shape: "kite", face: c.pal.metal, rim: MAT.gold, device: "quarter", deviceMat: c.pal.primary, boss: c.pal.gem }) }];
    default:
      return [{ name: "sun aegis", spec: s({ shape: "tower", face: c.pal.primary, rim: MAT.gold, device: "sun", deviceMat: MAT.gold, boss: MAT.ruby, studs: MAT.gold }) }];
  }
}

export function tankLoadout(c: LoadoutCtx): Loadout {
  const armors = ARMOR[c.tier] ?? ARMOR[0]!;
  const armor = armors[c.pick("armor", armors.length)] as ArmorDesign;
  const helms = HELMS[c.tier] ?? HELMS[0]!;
  const helmD = helms[c.pick("helm", helms.length)] as HeadDesign;
  const wp = weaponPool(c);
  const w = wp[c.pick("weapon", wp.length)] as { name: string; spec: HaftSpec };
  const sp = shieldPool(c);
  const sh = sp[c.pick("offhand", sp.length)] as { name: string; spec: ShieldSpec };
  const headgear = c.g.headgear;
  return {
    hold: { main: "N", grip2: null, second: false, bow: null, shield: c.g.shield },
    dress: armor.dress(c, baseDress(c.pal)),
    garments: (b) => {
      armor.draw(b, c);
      if (c.g.cape) cape(b, c.pal.accent, { len: 22, width: 1.1, collar: c.tier >= 3 ? MAT.gold : c.pal.trim });
    },
    head: (b) => (headgear === "helm" ? helmD.draw(b, c) : null),
    weapon: (b): WeaponResult | null => {
      const sk = b.sk;
      if (sk.shield) drawShield(b, sk.shield, sh.spec);
      return sk.weapon ? drawHaft(b, sk.weapon, w.spec) : null;
    },
    attack: "attack_slash",
    span: haftSpan(w.spec),
    names: [armor.name, headgear === "helm" ? helmD.name : headgear ?? "bare", w.name, sh.name],
  };
}
