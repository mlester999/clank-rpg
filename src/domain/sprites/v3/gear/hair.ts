import { mixRgb } from "../color";
import { GROUP } from "../body";
import { TAG } from "../gbuffer";
import { part, shell, type Build } from "../kit";
import { material } from "../materials";
import { add, mul, norm, type V3 } from "../vec";
import { fp } from "../view";

/**
 * HERO RENDERER v3 — HAIR and FACIAL HAIR, built on the head's own coordinates (head radii; x = the face direction, y = up, z = right).
 *
 * Hair is a shell over the cranium cut along a HAIRLINE: high over the forehead (always above the brow line — bangs never reach the eyes),
 * down to the temples above the ears, and low at the nape. Styles add volumes on that scalp (spikes, a crest, a bun, curls, a swoop, long hair
 * that hangs with gravity and sways). Facial hair is a shell over the jaw cut below the nose; the mouth is still stamped on top of it.
 */

/** The hairline: the lowest head-local height (in head radii) hair may reach at forward position x (head radii). */
export function hairline(x: number): number {
  if (x > 0.3) return 0.3;
  if (x > -0.3) return 0.3 - ((0.3 - x) / 0.6) * 0.2; // temples: 0.3 → 0.1
  return Math.max(-0.78, 0.1 - ((-0.3 - x) / 0.5) * 0.88); // the back of the head down to the nape
}

/**
 * Under a HOOD only what shows through its face opening: a fringe over the forehead (every style), a long lock falling out of the hood on the
 * near side (Long), a swept bang (Swoop), a few spikes (Spiky), a curl (Curly) — so the stored hair style still reads on a hooded hero.
 */
function drawFringe(b: Build, style: number): number {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const hp = part(b, "hair", b.pal.hair, GROUP.HAIR, TAG.HAIR);
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  // the fringe: the scalp inside the hood, seen only where the opening leaves the forehead bare (above the hairline, below the hood's rim)
  shell(b, h, [-0.04 * R, 0, 0], [1.02 * R, 1.04 * R, 0.96 * R], hp, (x, y) => y / R >= hairline(x / R) - (style === 6 ? 0.06 : 0), { zBias: 0.2 });
  switch (style) {
    case 1: // spiky: three short points out from under the rim
      for (const z of [-0.3, 0, 0.3]) b.pt.capsule(at(0.72, 0.42, z), at(0.98, 0.24, z * 1.1), 0.16 * R, 0.05 * R, hp, { zBias: 0.3 });
      break;
    case 2: // long: a lock out of the hood, down the near side of the neck to the collarbone (behind the cheek, never over the eye)
      b.pt.capsule(at(-0.15, -0.2, 0.86), at(-0.05 - b.pose.sway * 0.05, -1.55, 0.92), 0.26 * R, 0.2 * R, hp, { zBias: 0.45 });
      break;
    case 5: // curly: one curl at the temple
      b.pt.sphere(at(0.55, 0.38, 0.62), 0.24 * R, hp, { zBias: 0.4 });
      break;
    case 6: // swoop: the bang swept across the forehead
      b.pt.blob(h, [0.86 * R, 0.4 * R, 0.1 * R], 0.2 * R, 0.13 * R, 0.62 * R, hp, { zBias: 0.4 });
      break;
    default:
      break;
  }
  return hp;
}

/** The 8 stored styles: 0 Crop · 1 Spiky · 2 Long · 3 Mohawk · 4 Bun · 5 Curly · 6 Swoop · (7 bald: no layer). */
export function drawHair(b: Build, opts: { backOnly?: boolean; fringe?: boolean } = {}): number | null {
  const style = b.g.hairStyle;
  if (style === null || style < 0 || style > 6) return null;
  if (opts.fringe) return drawFringe(b, style);
  // under a helm only hair that hangs below its rim shows (long hair down the back) — never a bun or curls through the steel
  if (opts.backOnly && style !== 2) return null;
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const hp = part(b, "hair", b.pal.hair, GROUP.HAIR, TAG.HAIR);
  const scalp = (k: number, extra = 0) => {
    if (opts.backOnly) return;
    shell(b, h, [-0.04 * R, 0, 0], [0.95 * R * k + extra, 1.0 * R * k + extra, 0.9 * R * k + extra], hp, (x, y) => y / R >= hairline(x / R), { zBias: 0.15 });
  };
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const sway = b.pose.sway;
  switch (style) {
    case 0: // Crop: a close cap
      scalp(1.06);
      break;
    case 1: {
      // Spiky: a cap and five spikes swept up and back
      scalp(1.06);
      if (opts.backOnly) break;
      const spikes: Array<[V3, V3]> = [
        [[0.35, 0.82, 0.1], [0.55, 1.42, 0.15]],
        [[-0.05, 0.95, -0.2], [-0.05, 1.55, -0.35]],
        [[-0.45, 0.8, 0.2], [-0.8, 1.32, 0.35]],
        [[-0.7, 0.45, -0.25], [-1.3, 0.75, -0.4]],
        [[0.1, 0.9, 0.45], [0.15, 1.38, 0.75]],
      ];
      for (const [r, t] of spikes) b.pt.capsule(at(...r), at(...t), 0.33 * R, 0.08 * R, hp, { zBias: 0.2 });
      break;
    }
    case 2: {
      // Long: a cap and a mass of hair hanging down the back (gravity, not the head's tilt), swaying
      scalp(1.08);
      const root = at(-0.55, 0.2, 0);
      const tip = add(root, [-0.25 * R - sway * 0.5, -2.1 * R, 0]);
      b.pt.capsule(root, tip, 0.78 * R, 0.5 * R, hp, { zBias: -0.2 });
      break;
    }
    case 3: {
      // Mohawk: a tall crest along the midline, front to back
      if (opts.backOnly) break;
      shell(b, h, [-0.04 * R, 0, 0], [0.95 * R * 1.02, 1.0 * R * 1.02, 0.9 * R * 1.02], part(b, "stubble", material(mixRgb(b.pal.skin.ramp[2], b.pal.hair.ramp[1], 0.4), "skin"), GROUP.HAIR, TAG.HAIR), (x, y) => y / R >= hairline(x / R) + 0.15, { zBias: 0.1 });
      const crest: Array<[number, number, number]> = [[0.5, 0.95, 0.28], [0.1, 1.22, 0.36], [-0.35, 1.18, 0.34], [-0.72, 0.85, 0.3]];
      for (const [x, y, r] of crest) b.pt.blob(h, [x * R, y * R, 0], r * R * 1.1, r * R * 1.25, 0.24 * R, hp, { zBias: 0.25 });
      break;
    }
    case 4: {
      // Bun: a cap and a knot at the back of the crown
      scalp(1.07);
      b.pt.sphere(at(-0.7, 0.62, 0), 0.42 * R, hp, { zBias: 0.1 });
      break;
    }
    case 5: {
      // Curly: a cap of curls (a bumpy silhouette)
      scalp(1.04);
      if (opts.backOnly) break;
      const curls: V3[] = [[0.45, 0.85, 0.3], [0.45, 0.85, -0.3], [0, 1.0, 0.45], [0, 1.02, -0.4], [-0.45, 0.9, 0.42], [-0.45, 0.9, -0.42], [-0.85, 0.45, 0.3], [-0.85, 0.45, -0.3], [0.1, 0.98, 0], [-0.4, 0.98, 0], [-0.75, 0.0, 0.5], [-0.75, 0.0, -0.5]];
      for (const c of curls) b.pt.sphere(at(...c), 0.36 * R, hp, { zBias: 0.18, clip: undefined });
      break;
    }
    case 6: {
      // Swoop: a cap and a fringe swept up and forward over the brow
      scalp(1.08);
      if (opts.backOnly) break;
      const f = h;
      const c = fp(f, 0.38 * R, 0.78 * R, 0.1 * R);
      const ax = norm(add(f.x, mul(f.y, 0.35)));
      b.pt.ellipsoid(c, mul(ax, 0.72 * R), mul(norm(add(f.y, mul(f.x, -0.3))), 0.4 * R), mul(f.z, 0.72 * R), hp, { zBias: 0.25 });
      break;
    }
  }
  return hp;
}

/** Facial hair (genome `beard`), drawn on the jaw below the nose. Returns its part (the mouth may be stamped on it), or null. */
export function drawBeard(b: Build): number | null {
  const kind = b.g.beard;
  if (kind === "none") return null;
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const jaw = { c: [0.2 * R, -0.45 * R, 0] as V3, r: [0.76 * R, 0.62 * R, 0.78 * R] as V3 };
  const hairMat = kind === "stubble" ? material(mixRgb(b.pal.skin.ramp[1], b.pal.hair.ramp[1], 0.45), "skin") : b.pal.hair;
  const bp = part(b, "beard", hairMat, GROUP.HEAD, TAG.HAIR);
  const below = (yMax: number) => (_x: number, y: number) => y / R < yMax;
  switch (kind) {
    case "stubble":
      shell(b, h, jaw.c, [jaw.r[0] * 1.03, jaw.r[1] * 1.03, jaw.r[2] * 1.03], bp, (x, y) => y + jaw.c[1] < -0.62 * R && x + jaw.c[0] > -0.1 * R, { zBias: 0.1 });
      break;
    case "short":
      shell(b, h, jaw.c, [jaw.r[0] * 1.07, jaw.r[1] * 1.08, jaw.r[2] * 1.07], bp, (x, y) => y + jaw.c[1] < -0.5 * R && x + jaw.c[0] > -0.35 * R, { zBias: 0.15 });
      break;
    case "full":
      shell(b, h, [jaw.c[0], jaw.c[1] - 0.1 * R, 0], [jaw.r[0] * 1.12, jaw.r[1] * 1.22, jaw.r[2] * 1.1], bp, (x, y) => y + jaw.c[1] - 0.1 * R < -0.38 * R && x + jaw.c[0] > -0.45 * R, { zBias: 0.15 });
      break;
    case "goatee":
      b.pt.blob(h, [0.62 * R, -0.98 * R, 0], 0.3 * R, 0.36 * R, 0.3 * R, bp, { zBias: 0.2 });
      b.pt.blob(h, [0.86 * R, -0.5 * R, 0], 0.16 * R, 0.1 * R, 0.32 * R, bp, { zBias: 0.25 });
      break;
    case "moustache":
      b.pt.blob(h, [0.88 * R, -0.5 * R, 0], 0.17 * R, 0.11 * R, 0.36 * R, bp, { zBias: 0.25 });
      break;
    case "long": {
      shell(b, h, [jaw.c[0], jaw.c[1] - 0.1 * R, 0], [jaw.r[0] * 1.1, jaw.r[1] * 1.2, jaw.r[2] * 1.08], bp, (x, y) => y + jaw.c[1] - 0.1 * R < -0.4 * R && x + jaw.c[0] > -0.4 * R, { zBias: 0.15 });
      const root = fp(h, 0.55 * R, -0.95 * R, 0);
      const tip = add(root, [0.15 * R - b.pose.sway * 0.3, -1.25 * R, 0]);
      b.pt.capsule(root, tip, 0.48 * R, 0.16 * R, bp, { zBias: 0.3 });
      break;
    }
  }
  void below;
  return bp;
}
