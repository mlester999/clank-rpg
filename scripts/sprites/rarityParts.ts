import type { Rarity } from "../../src/domain/character/appearance";

import { circle, ellipse, G, line, OL, poly, rrect, type Ctx, type Pt } from "./pen";
import type { LayerSpec } from "./parts";
import { head, inWeaponSpace, torso } from "./parts";
import type { Joints, Pose } from "./rig";

/**
 * Rarity enhancement layers for the DEV sprite set (hero generator 2). One small layer per rarity tier and class-look variant — outfit
 * trim, shoulders, a headgear crest, a weapon glint/glow — drawn from the same Pose + Joints as every other layer, so they animate
 * frame-for-frame with the hero. They are authored in neutral grey and tinted with the hero's RARITY colour by the compositor
 * (mid-grey = the colour; highlights and shadows carry through), and they only ever ADD to the class silhouette: no layer here redraws
 * the outfit, the weapon or the head — each sits on top of what the class already wears.
 *
 *   level 1  RARE       thin accents: piping, a pad, a glint
 *   level 2  EPIC       richer: belt + cuffs, spiked pad / mantle, gem crest, glowing edge
 *   level 3  LEGENDARY  ornate: studs and jewels, a tall crest, a radiant weapon with a trailing ornament
 */

export type Level = 1 | 2 | 3;
const LEVEL_OF: Record<Exclude<Rarity, "COMMON">, Level> = { RARE: 1, EPIC: 2, LEGENDARY: 3 };
export const ENHANCED_RARITIES = ["RARE", "EPIC", "LEGENDARY"] as const;
const BODIES = ["heavy", "robe", "light", "medium"] as const;
const WEAPONS = ["sword", "staff", "daggers", "bow", "mace", "tome"] as const;
const HEADGEAR = ["helm", "hat", "hood", "cap", "halo", "crown"] as const;

const stroke = (g: Ctx, w: number, color: string): void => {
  g.lineJoin = "round";
  g.lineCap = "round";
  g.strokeStyle = OL;
  g.lineWidth = w + 1.4;
  g.stroke();
  g.strokeStyle = color;
  g.lineWidth = w;
  g.stroke();
};

/** A four-point sparkle, the recurring rarity motif. */
function sparkle(g: Ctx, x: number, y: number, r: number, color: string = G.hi): void {
  g.beginPath();
  g.moveTo(x, y - r);
  g.quadraticCurveTo(x + r * 0.18, y - r * 0.18, x + r, y);
  g.quadraticCurveTo(x + r * 0.18, y + r * 0.18, x, y + r);
  g.quadraticCurveTo(x - r * 0.18, y + r * 0.18, x - r, y);
  g.quadraticCurveTo(x - r * 0.18, y - r * 0.18, x, y - r);
  g.closePath();
  g.fillStyle = color;
  g.fill();
}

const gem = (g: Ctx, x: number, y: number, r: number): void => {
  poly(g, [[x, y - r], [x + r * 0.9, y], [x, y + r], [x - r * 0.9, y]], G.hi, 0.7);
  poly(g, [[x, y - r * 0.5], [x + r * 0.45, y], [x, y + r * 0.5], [x - r * 0.45, y]], G.base, 0);
};

// ======================================================================================
// Trim — torso-local, on top of the class outfit (z 23: above the outfit, below the face)
// ======================================================================================

function trim(style: (typeof BODIES)[number], level: Level) {
  return (g: Ctx, _p: Pose, j: Joints): void => {
    torso(g, j, () => {
      if (style === "robe") {
        rrect(g, -10.6, 7.8, 21.2, 1.6, 0.6, G.hi, 0.7); // hem band
        rrect(g, -6.6, -15.6, 13.2, 1.5, 0.6, G.hi, 0.7); // collar
        if (level >= 2) {
          rrect(g, -7.6, -5.2, 15.2, 2, 0.8, G.base, 0.8); // sash
          line(g, [-5.4, -14.2], [-1.2, -4.4], 0.9, G.hi); // front opening piping
          line(g, [5.4, -14.2], [1.2, -4.4], 0.9, G.hi);
        }
        if (level >= 3) {
          gem(g, 0, -4.2, 1.8);
          for (const x of [-7.6, -3.8, 0, 3.8, 7.6]) circle(g, x, 8.6, 0.8, G.hi, 0);
        }
      } else if (style === "heavy") {
        rrect(g, -9.2, -15.8, 18.4, 1.6, 0.6, G.hi, 0.7); // gorget rim
        rrect(g, -9.2, -3.2, 18.4, 2.4, 0.8, G.hi, 0.7); // belt
        if (level >= 2) {
          line(g, [-6.4, -13.8], [6.4, -13.8], 0.9, G.hi); // chest plate edge + spine
          line(g, [0, -13.8], [0, -4], 0.9, G.base);
        }
        if (level >= 3) {
          gem(g, 0, -8.6, 2.1);
          for (const x of [-7.4, -3.7, 3.7, 7.4]) circle(g, x, -2, 0.9, G.hi, 0.4);
        }
      } else if (style === "light") {
        line(g, [-6, -14.6], [6.2, -1.6], 1.2, G.hi); // cross strap piping
        rrect(g, -6.4, -3.6, 12.8, 1.6, 0.6, G.hi, 0.7); // belt
        if (level >= 2) {
          rrect(g, -6, 0.8, 12, 1.2, 0.5, G.base, 0.6); // tabard hem
          line(g, [-4.4, 5.6], [4.4, 5.6], 0.9, G.hi);
        }
        if (level >= 3) {
          gem(g, 0, -2.8, 1.9);
          for (const x of [-4.2, -1.4, 1.4, 4.2]) circle(g, x, 3.4, 0.7, G.hi, 0);
        }
      } else {
        rrect(g, -7.4, -15.6, 14.8, 1.5, 0.6, G.hi, 0.7); // collar
        rrect(g, -7.4, -3.6, 14.8, 2, 0.8, G.hi, 0.7); // belt
        if (level >= 2) {
          rrect(g, -7.4, 0.2, 14.8, 1.4, 0.6, G.base, 0.6);
          line(g, [-6.8, -12.4], [-6.8, 1.2], 0.9, G.hi);
          line(g, [6.8, -12.4], [6.8, 1.2], 0.9, G.hi);
        }
        if (level >= 3) {
          gem(g, 0, -2.6, 1.8);
          for (const x of [-5.6, -2.8, 2.8, 5.6]) circle(g, x, -9.4, 0.7, G.hi, 0);
        }
      }
    });
    // cuffs
    if (level >= 2) for (const hand of [j.handF, j.handB]) ellipse(g, hand[0], hand[1], 2.5, 1.3, G.hi, 0.5);
  };
}

// ======================================================================================
// Shoulders — front pad over the front shoulder, back pad behind (own part layer)
// ======================================================================================

function shoulderAt(g: Ctx, at: Pt, style: (typeof BODIES)[number], level: Level): void {
  const [x, y] = at;
  if (style === "robe") {
    // a mantle: a rounded, trimmed half-collar draped over the shoulder
    ellipse(g, x + 0.6, y + 0.8, 6.2, 4.4, G.base, 1);
    g.beginPath();
    g.ellipse(x + 0.6, y + 0.8, 5.2, 3.5, 0, Math.PI * 0.1, Math.PI * 0.9);
    g.strokeStyle = G.hi;
    g.lineWidth = 1;
    g.stroke();
    if (level >= 2) sparkle(g, x + 3.6, y - 1.4, 1.5);
    if (level >= 3) {
      gem(g, x + 0.6, y + 0.6, 1.6);
      for (const dx of [-3.6, 4.8]) circle(g, x + dx, y + 2.6, 0.7, G.hi, 0);
    }
    return;
  }
  const r = style === "heavy" ? 5.1 : 4.2;
  // a pad: a domed cap with a bright rim, spikes at higher tiers
  ellipse(g, x, y - 0.4, r, r * 0.82, G.base, 1);
  g.beginPath();
  g.arc(x, y - 0.4, r - 0.8, Math.PI * 1.1, Math.PI * 1.9);
  g.strokeStyle = G.hi;
  g.lineWidth = 0.9;
  g.stroke();
  if (level >= 2) {
    const spikes: Array<[number, number, number, number, number, number]> = [
      [x - 2.6, y - r * 0.6, x - 1.2, y - r - 3, x + 0.4, y - r * 0.7],
      [x + 0.6, y - r * 0.7, x + 2, y - r - 3.8, x + 3.4, y - r * 0.5],
    ];
    for (const s of spikes) poly(g, [[s[0], s[1]], [s[2], s[3]], [s[4], s[5]]], G.hi, 0.7);
  }
  if (level >= 3) {
    gem(g, x, y - 0.4, 1.7);
    rrect(g, x - r, y + r * 0.45, r * 2, 1.3, 0.5, G.hi, 0.6);
  }
}

/** One pad on the FRONT shoulder (an asymmetric pauldron / a draped mantle): half the art of a pair, and the side that is always in view. */
function shoulder(style: (typeof BODIES)[number], level: Level) {
  return (g: Ctx, _p: Pose, j: Joints): void => shoulderAt(g, j.shoulderF, style, level);
}

// ======================================================================================
// Crest — head-local, on top of the class headgear (z 62)
// ======================================================================================

function crest(kind: (typeof HEADGEAR)[number], level: Level) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    head(g, j, () => {
      const sw = p.capeSway * 0.25;
      switch (kind) {
        case "helm": {
          // a plume rising from the helm crest
          const h = level === 1 ? 3.5 : level === 2 ? 5 : 6.5;
          poly(g, [[-2.2, -11.6], [-3.4 + sw * 0.5, -11.6 - h * 0.55], [-1 + sw, -11.6 - h], [2.4 + sw * 1.2, -11.6 - h * 0.7], [2.2, -11.6]], G.base, 1);
          if (level >= 2) line(g, [-0.6, -12], [0.4 + sw, -11.6 - h * 0.85], 0.9, G.hi);
          if (level >= 3) {
            poly(g, [[-10.8, -2.6], [-14.4 + sw, -6], [-12, -0.6]], G.hi, 0.8); // wing
            poly(g, [[10.4, -3.2], [13.4 + sw, -7], [11.2, -0.8]], G.hi, 0.8);
            gem(g, 0, -4.6, 1.7);
          }
          break;
        }
        case "hat": {
          gem(g, 0.4, -5.6, level === 1 ? 1.2 : 1.7); // band gem
          if (level >= 2) sparkle(g, 9.6, -14.4, 1.5);
          if (level >= 3) {
            g.beginPath();
            g.ellipse(0, -5.6, 13.4, 2.8, 0, Math.PI * 1.05, Math.PI * 1.95);
            stroke(g, 0.9, G.hi);
            poly(g, [[-6, -8.2], [-2, -13.6], [-1.2, -8.4]], G.hi, 0.6);
          }
          break;
        }
        case "hood": {
          circle(g, 2.6, -8.6, level === 1 ? 1.1 : 1.6, G.hi, 0.6); // brooch
          if (level >= 2) {
            g.beginPath();
            g.arc(-0.6, -0.4, 12.6, Math.PI * 1.05, Math.PI * 1.7);
            stroke(g, 1, G.hi);
          }
          if (level >= 3) {
            gem(g, 2.6, -8.6, 2);
            poly(g, [[-6.4, -11.6], [-1, -16.6], [3.2, -12]], G.hi, 0.7);
            sparkle(g, -5.6, -14, 1.4);
          }
          break;
        }
        case "cap": {
          const k = level === 1 ? 0.6 : level === 2 ? 1 : 1.3;
          poly(g, [[-3, -10.4], [-7.4 - 0.4 * k, -14 - 2 * k], [-3.6, -13 - k], [-1, -10]], G.hi, 0.8); // a bigger feather
          if (level >= 2) poly(g, [[-1, -10.6], [-4 - 1.5 * k + sw, -15 - 1.5 * k], [0.4, -13], [1.4, -10.4]], G.base, 0.8);
          if (level >= 3) {
            gem(g, -1, -10.4, 1.6);
          }
          break;
        }
        case "halo": {
          g.beginPath();
          g.ellipse(0, -14, 7.8, level === 1 ? 3.1 : 3.5, 0, 0, Math.PI * 2);
          stroke(g, level === 1 ? 0.9 : 1.2, G.hi);
          if (level >= 2) for (const a of [-1, -0.4, 0.4, 1]) line(g, [Math.sin(a) * 7.2, -14 - Math.cos(a) * 3.1], [Math.sin(a) * 8.6, -14 - Math.cos(a) * 5.2], 1, G.hi);
          if (level >= 3) {
            g.beginPath();
            g.ellipse(0, -14, 8, 3.9, 0, 0, Math.PI * 2);
            stroke(g, 0.9, G.base);
            sparkle(g, 8.6, -18, 1.3);
          }
          break;
        }
        default: {
          // crown: extra jewels, then taller points
          for (const x of [-5.4, 0, 5.4]) circle(g, x, -8.6, level === 1 ? 0.9 : 1.2, G.hi, 0.5);
          if (level >= 2) for (const [x, y] of [[-8.6, -14.6], [0, -16], [8.6, -14.6]] as const) sparkle(g, x, y, 1.4);
          if (level >= 3) gem(g, 0, -12.4, 1.8);
        }
      }
    });
  };
}

// ======================================================================================
// Weapon fx — weapon-local, on top of the class weapon (z 71)
// ======================================================================================

function weaponFx(kind: (typeof WEAPONS)[number], level: Level) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    const glow = (x: number, y: number, r: number): void => {
      g.save();
      g.globalAlpha = level === 1 ? 0.22 : level === 2 ? 0.34 : 0.46;
      circle(g, x, y, r, G.hi, 0);
      g.restore();
    };
    switch (kind) {
      case "sword":
        inWeaponSpace(g, j.handF, j, () => {
          line(g, [0, -3], [0, -18.6], level === 1 ? 0.7 : 1, G.hi); // lit edge
          if (level >= 2) {
            glow(0, -11, 7);
            line(g, [-1.9, -4], [-1.9, -16], 0.7, G.hi);
            line(g, [1.9, -4], [1.9, -16], 0.7, G.hi);
          }
          sparkle(g, 0.6, -15 - level, 1.5 + level * 0.5);
          if (level >= 3) {
            gem(g, 0, 4.8, 1.5);
            for (const y of [-6, -9.4, -12.8]) line(g, [-0.9, y], [0.9, y + 1.2], 0.7, G.base); // runes
            sparkle(g, 2.4, -20.6, 2.2);
          }
        });
        break;
      case "mace":
        inWeaponSpace(g, j.handF, j, () => {
          sparkle(g, 2.6, -17.2, 1.4 + level * 0.4);
          if (level >= 2) {
            g.beginPath();
            g.arc(0, -14.6, 5.6, 0, Math.PI * 2);
            stroke(g, 0.9, G.hi);
            glow(0, -14.6, 7.4);
          }
          if (level >= 3) {
            for (let i = 0; i < 8; i++) {
              const a = (i / 8) * Math.PI * 2;
              line(g, [Math.cos(a) * 6.4, -14.6 + Math.sin(a) * 6.4], [Math.cos(a) * 9, -14.6 + Math.sin(a) * 9], 0.9, G.hi);
            }
            gem(g, 0, -9.4, 1.5);
          }
        });
        break;
      case "staff":
        inWeaponSpace(g, j.handF, j, () => {
          sparkle(g, 1.6, -21, 1 + level * 0.35);
          if (level >= 2) {
            g.beginPath();
            g.arc(0, -18.4, 3.9 + p.glow * 1.1, 0, Math.PI * 2);
            stroke(g, 0.8, G.hi);
            glow(0, -18.4, 5.6);
          }
          if (level >= 3) {
            sparkle(g, -4.6, -22, 1.4);
            sparkle(g, 4.4, -14.4, 1.2);
            gem(g, 0, -9, 1.4);
          }
        });
        break;
      case "tome":
        inWeaponSpace(g, j.handF, j, () => {
          sparkle(g, 3.6, -12, 1.2 + level * 0.5);
          if (level >= 2) {
            glow(0, -6, 8.6);
            rrect(g, -4.6, -11.4, 9.2, 1.1, 0.4, G.hi, 0.4);
          }
          if (level >= 3) {
            sparkle(g, -3.6, -15.6, 1.7);
            sparkle(g, 1.2, -18.2, 1.3);
            sparkle(g, 4.8, -15, 1.1);
          }
        });
        break;
      case "daggers": {
        const blade = (): void => {
          line(g, [0, -1.6], [0, -9.8], level === 1 ? 0.6 : 0.9, G.hi);
          sparkle(g, 0.5, -10.4, 1.1 + level * 0.4);
          if (level >= 2) glow(0, -5.4, 4.4);
          if (level >= 3) gem(g, 0, 2.4, 1);
        };
        inWeaponSpace(g, j.handB, j, blade, -0.55);
        inWeaponSpace(g, j.handF, j, blade);
        break;
      }
      default: {
        // bow: lit limbs, tip ornaments
        inWeaponSpace(g, j.handF, j, () => {
          g.beginPath();
          g.moveTo(0, -13);
          g.quadraticCurveTo(7.2, 0, 0, 13);
          stroke(g, level === 1 ? 0.7 : 1, G.hi);
          sparkle(g, 0, -14.6, 1.2 + level * 0.5);
          if (level >= 2) {
            sparkle(g, 0, 14.6, 1.2 + level * 0.3);
            glow(4, 0, 7);
          }
          if (level >= 3) {
            gem(g, 1.2, 0, 1.6);
            sparkle(g, 8.4, 0, 1.8);
          }
        });
      }
    }
  };
}

// ======================================================================================
// Registry
// ======================================================================================

export const RARITY_LAYERS: LayerSpec[] = ENHANCED_RARITIES.flatMap((rarity) => {
  const level = LEVEL_OF[rarity];
  const t = rarity.toLowerCase();
  return [
    ...BODIES.map((b): LayerSpec => ({ id: `trim.${t}.${b}`, family: "rarity", z: 23, tint: "rarity", draw: trim(b, level) })),
    ...(rarity === "RARE" ? [] : BODIES.map((b): LayerSpec => ({ id: `shoulder.${t}.${b}`, family: "rarity", z: 67, tint: "rarity", draw: shoulder(b, level) }))),
    ...(rarity === "RARE" ? [] : HEADGEAR.map((h): LayerSpec => ({ id: `crest.${t}.${h}`, family: "rarity", z: 62, tint: "rarity", draw: crest(h, level) }))),
    ...WEAPONS.map((w): LayerSpec => ({ id: `weaponfx.${t}.${w}`, family: "rarity", z: 71, tint: "rarity", draw: weaponFx(w, level) })),
  ];
});
