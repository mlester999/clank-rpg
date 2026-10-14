import { GROUP } from "../body";
import { TAG, type Material } from "../gbuffer";
import { part, shell, type Build } from "../kit";
import { material, MAT } from "../materials";
import { add, mul, type V3 } from "../vec";
import { fp } from "../view";

import { ring } from "./garments";

/**
 * HERO RENDERER v3 — the stored ACCESSORY (an identity trait like the eyes or the hair: `accessory.goggles`, `scarf`, `cog-pin`, `headset`;
 * the monocle is a face stamp, see face.ts). Drawn on every hero that has one, over its armour and headgear, in the head's or the chest's own
 * coordinates — so it turns and leans with the body like everything else. Nothing here may cover the eyes: the goggles are pushed up above
 * the brow line and the headset's boom stops at the cheek.
 */

const LENS = material("#8fd8e8", "glow");
const COPPER = material("#c8743a", "metal");
/** Scarf cloths: the one furthest from the hero's own outfit and skin is worn (a scarf in the tunic's colour would not read at all). */
const SCARVES = ["#d9a33a", "#3f8fb0", "#c8483a", "#e9e3d3", "#7a9a3a", "#8a4fb8"].map((h) => material(h, "cloth"));

const rgbDist = (a: number, b: number): number => Math.hypot(((a >> 16) & 255) - ((b >> 16) & 255), ((a >> 8) & 255) - ((b >> 8) & 255), (a & 255) - (b & 255));
function scarfCloth(b: Build): Material {
  const avoid = [b.pal.primary, b.pal.secondary, b.pal.accent, b.pal.cloth, b.pal.skin, b.pal.metal].map((m) => m.ramp[2] as number);
  let best = SCARVES[0] as Material;
  let bestD = -1;
  for (const m of SCARVES) {
    const d = Math.min(...avoid.map((c) => rgbDist(m.ramp[2] as number, c)));
    if (d > bestD) [best, bestD] = [m, d];
  }
  return best;
}

export function drawAccessory(b: Build): void {
  switch (b.g.accessory) {
    case "goggles":
      return goggles(b);
    case "scarf":
      return scarf(b);
    case "cog-pin":
      return cogPin(b);
    case "headset":
      return headset(b);
    default:
      return;
  }
}

/** Brass goggles pushed up on the forehead (over a helm's brow, a hood or a cap alike): a strap around the head, two rimmed lenses in front. */
function goggles(b: Build): void {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const strap = part(b, "goggleStrap", MAT.darkLeather, GROUP.HELM, TAG.HELM);
  shell(b, h, [-0.05 * R, 0.08 * R, 0], [1.2 * R, 1.16 * R, 1.14 * R], strap, (_x, y) => y / R > 0.36 && y / R < 0.56, { zBias: 0.7 });
  const rim = part(b, "goggleRim", b.pal.trim, GROUP.HELM, TAG.HELM);
  const lens = part(b, "goggleLens", LENS, GROUP.HELM, TAG.HELM);
  for (const z of [0.36, -0.36]) {
    b.pt.blob(h, [0.98 * R, 0.5 * R, z * R], 0.17 * R, 0.24 * R, 0.24 * R, rim, { zBias: 0.8 });
    b.pt.blob(h, [1.08 * R, 0.5 * R, z * R], 0.1 * R, 0.15 * R, 0.15 * R, lens, { zBias: 0.9 });
  }
}

/** A foundry scarf: a thick wrap over the collar line (outside the chest's top, where the neck meets it), one end hanging down the chest on the near side. */
function scarf(b: Build): void {
  const sk = b.sk;
  const pl = sk.plan;
  const p = part(b, "scarf", scarfCloth(b), GROUP.BODY, TAG.CLOTH);
  const top = { c: add(sk.neckBase, mul(sk.chest.y, 0.7)), rx: pl.neckR + 1.3, rz: pl.neckR + 1.5 };
  const bot = { c: add(sk.neckBase, mul(sk.chest.y, -1.0)), rx: pl.chest.d * 0.78 + 0.7, rz: pl.chest.w * 0.62 + 0.7 };
  ring(b, top, bot, p, { n: 14, flare: 0.45, zBias: 0.5 });
  const sway = b.pose.sway * 0.35;
  const from: V3 = add(sk.neckBase, add(mul(sk.chest.x, pl.chest.d * 0.85), add(mul(sk.chest.z, pl.chest.w * 0.32), mul(sk.chest.y, -0.6))));
  const to: V3 = add(from, add(mul(sk.chest.y, -4.8), add(mul(sk.chest.x, 0.6 - sway), mul(sk.chest.z, 0.2))));
  b.pt.capsule(from, to, 1.0, 0.8, p, { zBias: 0.6 });
}

/** A cog pin on the chest, near side: a copper badge (3 px across) with a dark hub — it reads as a gear at battle size, even on gilded armour. */
function cogPin(b: Build): void {
  const sk = b.sk;
  const pl = sk.plan;
  const c = sk.chest;
  const pin = part(b, "cogPin", COPPER, GROUP.FX, TAG.GEAR);
  const at = fp(c, pl.chest.d * 1.1, 2.1, pl.chest.w * 0.5);
  b.pt.sphere(at, 1.35, pin, { zBias: 1.6 });
  const hub = part(b, "cogHub", MAT.blackIron, GROUP.FX, TAG.GEAR);
  b.pt.sphere(add(at, mul(c.x, 0.9)), 0.75, hub, { zBias: 1.9 });
}

/** A comms headset: a cup over the near ear, the band over the crown (under any headgear it rides on top), a short boom toward the cheek. */
function headset(b: Build): void {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const dark = part(b, "headset", MAT.blackIron, GROUP.HELM, TAG.GEAR);
  b.pt.blob(h, [-0.08 * R, -0.12 * R, 1.08 * R], 0.3 * R, 0.34 * R, 0.16 * R, dark, { zBias: 0.9 });
  b.pt.blob(h, [-0.08 * R, -0.12 * R, -1.08 * R], 0.3 * R, 0.34 * R, 0.16 * R, dark, { zBias: 0.6 });
  shell(b, h, [-0.1 * R, 0.05 * R, 0], [0.22 * R, 1.24 * R, 1.16 * R], dark, (_x, y) => y / R > 0.1, { zBias: 0.7 });
  const boom = part(b, "headsetBoom", b.pal.trim, GROUP.HELM, TAG.GEAR);
  b.pt.line(fp(h, 0.05 * R, -0.3 * R, 1.12 * R), fp(h, 0.62 * R, -0.62 * R, 0.86 * R), 1, boom, [0.3, 0.2, 0.9], { zBias: 1.0 });
}
