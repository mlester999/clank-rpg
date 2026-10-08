import type { Rarity } from "../../../src/domain/character/appearance";

import { circle, ellipse, G, line, OL, poly, rrect, type Ctx, type Pt } from "../pen";
import { bowCarry, head, inWeaponSpace, STAFF_GRIP, torso, type LayerSpec } from "./parts";
import type { Joints, Pose } from "./rig";

/**
 * HERO RENDERER v2 — rarity PRESTIGE layers (same ids as v1: trim / shoulder / crest / weapon fx per tier and class-look variant). Rarity is shown
 * by what the hero WEARS, never by a glow around the body:
 *
 *   RARE       clean accents: piped edges, a lit blade edge / a fletched tip
 *   EPIC       distinctive gear: a belt with cuffs, a spiked pauldron or a draped mantle, a gem crest, a rune-lit weapon
 *   LEGENDARY  high-detail: studs and jewels, wings on the helm, an ornamented weapon with a trailing ornament
 *
 * Authored in neutral grey and tinted with the RARITY colour (Rare cyan · Epic violet · Legendary gold) by the compositor. Coordinates follow the
 * v2 outfits (rig.ts / parts.ts): robes reach the ankles, heavy plate is wider, weapons are longer.
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

// ---------------------------------------------------------------------------------- trim (torso-local, z 23)
function trim(style: (typeof BODIES)[number], level: Level) {
  return (g: Ctx, _p: Pose, j: Joints): void => {
    torso(g, j, () => {
      if (style === "robe") {
        rrect(g, -11, 11.4, 22, 2, 0.6, G.hi, 0.8); // hem band, above the robe's own
        rrect(g, -6, -16.4, 12, 2, 0.6, G.hi, 0.8); // collar
        if (level === 2) {
          line(g, [-5.4, -14.6], [-2, -5], 1, G.hi); // front opening piping (a Legendary's stole replaces it — no stacked gold lines)
          line(g, [5.4, -14.6], [2, -5], 1, G.hi);
        }
        rrect(g, -6.6, -6.8, 13.2, 3, 1, G.base, 0.8); // a sash in the rarity colour (from Rare up: Rare reads at battle size)
        if (level >= 3) {
          // a gold stole hanging from the collar to the hem, its ends embroidered
          line(g, [-3.2, -14.8], [-4.4, 10.6], 1.2, G.hi);
          line(g, [3.2, -14.8], [4.4, 10.6], 1.2, G.hi);
          for (const x of [-4.4, 4.4]) poly(g, [[x - 1.6, 8.6], [x + 1.6, 8.6], [x, 11.2]], G.base, 0.6);
          gem(g, 0, -4.6, 1.9);
        }
      } else if (style === "heavy") {
        rrect(g, -9.8, -17.6, 19.6, 2, 0.6, G.hi, 0.8); // gorget rim
        line(g, [-9.6, 6.6], [9.6, 6.6], 1.2, G.hi); // fauld edge
        rrect(g, -9.8, -5.4, 19.6, 2.8, 0.8, G.base, 0.8); // the war belt, in the rarity colour
        rrect(g, -1.8, -5.8, 3.6, 3.6, 0.6, G.hi, 0.7);
        if (level >= 2) {
          line(g, [-7, -14.4], [7, -14.4], 1, G.hi); // plate edge
          line(g, [-9.4, 6.4], [9.4, 6.4], 1, G.hi); // fauld edge
        }
        if (level >= 3) {
          gem(g, 0, -9.6, 2.2);
          for (const x of [-7.6, -3.8, 3.8, 7.6]) circle(g, x, 0.6, 0.9, G.hi, 0.4);
          sparkle(g, 0, -9.6, 3.6);
        }
      } else if (style === "light") {
        line(g, [-6, -14.6], [6.2, -1.6], 1.5, G.hi);
        rrect(g, -6.6, -3.8, 13.2, 2.6, 0.8, G.base, 0.8); // belt in the rarity colour
        line(g, [-6, -2.6], [6, -2.6], 0.6, G.hi);
        if (level === 2) {
          rrect(g, -6, 1.2, 12, 1.2, 0.5, G.base, 0.6); // (a Legendary's gilded belt replaces these bands — no stack of gold stripes)
          line(g, [-4.4, 5], [4.4, 5], 0.9, G.hi);
        }
        if (level >= 3) {
          gem(g, 0, -2.6, 1.9); // a jewelled buckle on the strap — the light gear stays light (no harness of gold bands)
          rrect(g, -6.8, 6.4, 13.6, 1.8, 0.6, G.hi, 0.7); // a gilded belt
          poly(g, [[-6, -14.4], [-3.6, -15], [-3.2, -12.6], [-5.6, -12.2]], G.base, 0.6); // a gilded shoulder clasp
        }
      } else {
        // medium: the tabard's edge and its emblem
        line(g, [-5, -15.2], [-5.6, 7], 1.3, G.hi);
        line(g, [5, -15.2], [5.6, 7], 1.3, G.hi);
        rrect(g, -7.8, -4.8, 15.6, 2.8, 1, G.base, 0.8); // the sword belt, in the rarity colour
        rrect(g, -1.6, -5.2, 3.2, 3.6, 0.6, G.hi, 0.7);
        if (level >= 2) {
          poly(g, [[0, -12.6], [2.6, -9.4], [0, -6.2], [-2.6, -9.4]], G.base, 0.8); // emblem
          rrect(g, -7.8, -3.4, 15.6, 1.2, 0.5, G.hi, 0.6);
        }
        if (level >= 3) {
          rrect(g, -8, 5.8, 16, 1.8, 0.6, G.hi, 0.7); // a gold belt with a jewelled buckle
          gem(g, 0, 6.7, 1.4);
          line(g, [-5.6, 7.6], [-6.4, 12], 1, G.hi); // lit tabard tails
          line(g, [5.6, 7.6], [6.4, 12], 1, G.hi);
          gem(g, 0, -9.4, 1.6);
        }
      }
    });
    if (level >= 2) for (const hand of [j.handF, j.handB] as const) ellipse(g, hand[0] - 0.6, hand[1] - 0.6, 2.4, 1.3, G.hi, 0.5); // cuffs
  };
}

// ---------------------------------------------------------------------------------- shoulders (z 67)
function shoulderAt(g: Ctx, at: Pt, style: (typeof BODIES)[number], level: Level): void {
  // A pauldron SILHOUETTE: a dome capping the top of the shoulder (nothing below the shoulder line — the arm hangs across the chest in a side
  // view, so a full pad there reads as a blob), spikes rising from it at Epic, a jewel and a lit rim at Legendary.
  const [x, y] = at;
  const r = style === "heavy" ? 5.2 : style === "robe" ? 4.6 : 4;
  const h = style === "robe" ? r * 0.55 : r * 0.78;
  g.beginPath();
  g.ellipse(x, y + 0.6, r, h, 0, Math.PI, Math.PI * 2);
  g.closePath();
  g.fillStyle = G.base;
  g.fill();
  g.strokeStyle = OL;
  g.lineWidth = 1;
  g.stroke();
  line(g, [x - r + 0.6, y + 0.6], [x + r - 0.6, y + 0.6], 1.1, G.hi); // the rim
  if (style === "robe") {
    // a mantle drapes: two short tails over the arm
    poly(g, [[x - r + 0.4, y + 0.6], [x - r + 1.6, y + 3.2], [x - r + 2.8, y + 0.6]], G.base, 0.8);
    poly(g, [[x + r - 2.8, y + 0.6], [x + r - 1.6, y + 3.2], [x + r - 0.4, y + 0.6]], G.base, 0.8);
  } else if (level >= 2) {
    // spikes sweep BACK over the shoulder (pointing up at the face, they read as a bell under the chin)
    for (const s of [[x - 2.8, y - h * 0.4, x - 5.2, y - h - 1.6, x - 1.2, y - h * 0.85], [x - 0.6, y - h * 0.9, x - 2.8, y - h - 2.6, x + 0.8, y - h * 0.95]] as const)
      poly(g, [[s[0], s[1]], [s[2], s[3]], [s[4], s[5]]], G.hi, 0.7);
  }
  if (level >= 2 && style === "robe") sparkle(g, x - r + 0.6, y - h, 1.3);
  if (level >= 3) gem(g, x - 0.8, y - h * 0.3, 1.1);
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
// On the upper arm, a little below the shoulder joint: at the joint itself the pad sat right under the chin in this side view.
const shoulder = (style: (typeof BODIES)[number], level: Level) => (g: Ctx, _p: Pose, j: Joints): void => shoulderAt(g, lerp(j.shoulderF, j.elbowF, 0.22), style, level);

// ---------------------------------------------------------------------------------- crest (head-local, z 62)
function crest(kind: (typeof HEADGEAR)[number], level: Level) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    head(g, j, () => {
      const sw = p.capeSway * 0.25;
      switch (kind) {
        case "helm": {
          // a plume from the helm's socket — taller with the tier; Legendary adds wings
          const h = level === 2 ? 7 : 8.4;
          poly(g, [[-1.6, -15], [-4.4 + sw * 0.5, -15 - h * 0.55], [-2.4 + sw, -15 - h], [2.6 + sw * 1.2, -15 - h * 0.7], [1.6, -15]], G.base, 1);
          line(g, [-0.4, -15.4], [0.2 + sw, -15 - h * 0.85], 0.9, G.hi);
          if (level >= 3) {
            poly(g, [[-11.2, -2.6], [-15.4 + sw, -8], [-12.4, -0.6]], G.hi, 0.8);
            poly(g, [[10.8, -3.2], [14.4 + sw, -8.8], [11.6, -0.8]], G.hi, 0.8);
            gem(g, 0, -2.2, 1.7);
          }
          break;
        }
        case "hat": {
          gem(g, 0.4, -6.1, level === 2 ? 1.7 : 2);
          sparkle(g, 6.6, -22.2, 1.3 + level * 0.3); // at the (bent) tip
          if (level >= 3) {
            g.beginPath();
            g.ellipse(0, -5.4, 15, 3, 0, Math.PI * 1.05, Math.PI * 1.95);
            stroke(g, 0.9, G.hi);
            for (const [x, y] of [[-3.6, -12], [-1, -17.4], [3.2, -20.2]] as const) circle(g, x, y, 0.8, G.hi, 0); // stars on the cone
          }
          break;
        }
        case "hood": {
          circle(g, 3.2, -9.2, 1.6, G.hi, 0.6); // brooch
          g.beginPath();
          g.arc(-0.8, -0.6, 13, Math.PI * 1.05, Math.PI * 1.7);
          stroke(g, 1, G.hi);
          if (level >= 3) {
            g.beginPath();
            g.arc(-0.8, -0.6, 13, Math.PI * 1.7, Math.PI * 2.08); // the gold rim runs on round the front of the hood
            stroke(g, 1, G.hi);
            gem(g, 3.2, -9.2, 2.1);
            poly(g, [[-7.4, -11.8], [-2.2, -17.4], [2.2, -12.6]], G.hi, 0.7);
            sparkle(g, -6.4, -15, 1.5);
          }
          break;
        }
        case "cap": {
          poly(g, [[-4.6, -9.6], [-13.2 + sw, -18.6], [-9.4 + sw, -17.8], [-2.4, -11.4]], G.base, 0.8); // a second, longer plume
          if (level >= 3) {
            rrect(g, -8.6, -9.4, 15.6, 1.7, 0.6, G.hi, 0.6); // a gold band round the cap
            poly(g, [[-2.4, -11.4], [-7.6, -16.2], [-5.2, -15.8], [-1.2, -12.4]], G.hi, 0.6); // a second, gilded feather
            gem(g, -3.4, -10.4, 1.7);
            sparkle(g, -12.6 + sw, -19.4, 1.5);
          }
          break;
        }
        case "halo": {
          g.beginPath();
          g.ellipse(-0.4, -15.4, 9.6, 3.5, -0.08, 0, Math.PI * 2);
          stroke(g, 1, G.hi);
          for (const a of [-1, -0.4, 0.4, 1]) line(g, [Math.sin(a) * 8.4 - 0.4, -15.4 - Math.cos(a) * 3.1], [Math.sin(a) * 10.4 - 0.4, -15.4 - Math.cos(a) * 5.8], 1, G.hi);
          if (level >= 3) sparkle(g, 9.4, -20, 1.5);
          break;
        }
        default: {
          for (const x of [-5.4, 0, 5.4]) circle(g, x, -8.6, 1.2, G.hi, 0.5);
          for (const [x, y] of [[-8.6, -14.6], [0, -16], [8.6, -14.6]] as const) sparkle(g, x, y, 1.4);
          if (level >= 3) gem(g, 0, -12.4, 1.8);
        }
      }
    });
  };
}

// ---------------------------------------------------------------------------------- weapon fx (weapon-local, z 71)
/** Where the grip's tassel hangs from, per weapon (weapon space: the front hand at the origin, the weapon along −y). */
const TASSEL_AT: Record<(typeof WEAPONS)[number], Pt> = { sword: [0, 5.6], mace: [0, 4.6], staff: [0, 9.4], tome: [0, 4], daggers: [0, 3.2], bow: [3, 2.6] };

/** A cord and tassel hanging (by gravity, in frame space) from the grip: a NAMED weapon, readable at battle size; jewelled and longer at Legendary. */
function tassel(g: Ctx, p: Pose, j: Joints, kind: (typeof WEAPONS)[number], level: Level): void {
  const th = Math.atan2(j.weaponDir[0], -j.weaponDir[1]) + (kind === "bow" ? bowCarry(p) : 0);
  const [x, y] = TASSEL_AT[kind];
  const at: Pt = [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
  const sw = -p.capeSway * 0.25;
  const len = level === 1 ? 3.6 : level === 2 ? 4.6 : 5.8;
  const end: Pt = [at[0] + sw, at[1] + len];
  line(g, at, end, 0.8, G.base);
  const fringe = level === 3 ? 4.6 : 3.4;
  poly(g, [[end[0] - 1.2, end[1] + 0.6], [end[0] + 1.2, end[1] + 0.6], [end[0] + 1.6 + sw * 0.3, end[1] + fringe], [end[0] - 1.6 + sw * 0.3, end[1] + fringe]], G.base, 0.7);
  if (level === 3) gem(g, end[0], end[1], 1.6); // the Legendary's trailing ornament: a jewel on the cord
  else circle(g, end[0], end[1], 1.1, G.hi, 0.6);
}

function weaponFx(kind: (typeof WEAPONS)[number], level: Level) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    tassel(g, p, j, kind, level);
    const glow = (x: number, y: number, r: number): void => {
      g.save();
      g.globalAlpha = level === 1 ? 0.18 : level === 2 ? 0.28 : 0.36;
      circle(g, x, y, r, G.hi, 0);
      g.restore();
    };
    switch (kind) {
      case "sword":
        inWeaponSpace(g, j.handF, j, () => {
          line(g, [0.4, -3.2], [0.4, -21.6], level === 1 ? 0.8 : 1.1, G.hi); // lit edge
          if (level >= 2) for (const y of [-7, -11, -15]) line(g, [-1, y], [1, y + 1.2], 0.8, G.base); // runes
          sparkle(g, 0.6, -18 - level, 1.4 + level * 0.4);
          if (level >= 3) {
            glow(0, -13, 6);
            gem(g, 0, 5.2, 1.6);
            poly(g, [[-5.2, -2], [-7.6, -4.6], [-5, -3.6]], G.hi, 0.6); // swept guard
            poly(g, [[5.2, -2], [7.6, -4.6], [5, -3.6]], G.hi, 0.6);
          }
        });
        break;
      case "mace":
        inWeaponSpace(g, j.handF, j, () => {
          sparkle(g, 3, -20.4, 1.4 + level * 0.4);
          if (level >= 2) {
            g.beginPath();
            g.arc(0, -17.2, 5.2, 0, Math.PI * 2);
            stroke(g, 0.9, G.hi);
          }
          if (level >= 3) {
            glow(0, -17.2, 7);
            gem(g, 0, -11.8, 1.5);
          }
        });
        break;
      case "staff":
        inWeaponSpace(g, j.handF, j, () => {
          g.translate(0, STAFF_GRIP);
          sparkle(g, 2, -28, 1 + level * 0.4);
          if (level >= 2) {
            g.beginPath();
            g.arc(0, -24, 4.2 + p.glow * 1.1, 0, Math.PI * 2);
            stroke(g, 0.8, G.hi);
          }
          if (level >= 3) {
            glow(0, -24, 5.4);
            sparkle(g, -4.8, -27, 1.3);
            for (const y of [-14, -9]) rrect(g, -1.5, y, 3, 1, 0.4, G.hi, 0.4); // gold bands
          }
        });
        break;
      case "tome":
        inWeaponSpace(g, j.handF, j, () => {
          sparkle(g, 3.8, -21.6, 1.1 + level * 0.4);
          if (level >= 2) {
            g.beginPath();
            g.arc(0, -18.4, 5.6, 0, Math.PI * 2);
            stroke(g, 0.8, G.hi);
          }
          if (level >= 3) {
            glow(0, -18.4, 6.4);
            sparkle(g, -3.8, -22.4, 1.3);
          }
        });
        break;
      case "daggers": {
        const blade = (): void => {
          line(g, [0.2, -2.2], [0.6, -10.6], level === 1 ? 0.6 : 0.9, G.hi);
          sparkle(g, 0.6, -11.6, 1 + level * 0.4);
          if (level >= 3) gem(g, 0, 2.6, 1);
        };
        inWeaponSpace(g, j.handB, j, blade, Math.PI - 0.4);
        inWeaponSpace(g, j.handF, j, blade);
        break;
      }
      default: {
        // bow: lit limbs, tip ornaments
        inWeaponSpace(g, j.handF, j, () => {
          g.beginPath();
          g.moveTo(2.2, -10.6);
          g.quadraticCurveTo(6.8, 0, 2.2, 10.6);
          stroke(g, level === 1 ? 0.7 : 1, G.hi);
          sparkle(g, -1.4, -18.4, 1.2 + level * 0.45);
          if (level >= 2) sparkle(g, -1.4, 18.4, 1.2 + level * 0.3);
          if (level >= 3) {
            gem(g, 2.8, 0, 1.6);
            glow(4, 0, 6);
          }
        }, bowCarry(p));
      }
    }
  };
}

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
