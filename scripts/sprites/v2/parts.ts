import type { AttackClip, TintRole } from "../../../src/domain/sprites/spec";

import { circle, ellipse, G, line, local, OL, path, poly, rrect, tube, type Ctx, type Pt } from "../pen";
import { floorLen } from "./kit";
import { ANCHOR_X, FEET_Y, HEAD_R, type Joints, type Pose } from "./rig";

/**
 * HERO RENDERER v2 — every drawable layer of the `clank-dev-v2` set. Same layer ids as v1 (a hero's STORED look — its catalogue items, colours,
 * hair, headgear choice — is drawn by v2 exactly as it was chosen; only the art is better), drawn from the v2 skeleton (rig.ts).
 *
 * The class SILHOUETTE comes from what the class wears (the catalogue locks weapon + outfit to the class look):
 *   Tank     heavy plate (breastplate, faulds, greaves, both pauldrons) + a tall tower shield + a flanged mace — wide and planted
 *   Warrior  a tabard over mail + a broad sword + an open helm — aggressive, medium build
 *   Rogue    a slim leather jerkin + a deep hood with a face mask + twin daggers — light and narrow
 *   Ranger   leather + a feathered ranger hat + a long recurve bow + a QUIVER on the back
 *   Mage     a long robe with bell sleeves + a tall bent hat + a crystal staff
 *   Cleric   a long robe + a halo + a sun scepter, a tome at the hip and a sun pendant (the holy kit)
 * Tintable layers are authored in neutral grey (mid-grey = the tint colour), the rest in real colours.
 */

export interface LayerSpec {
  id: string;
  of?: string;
  family: "body" | "outfits" | "face" | "hair" | "headgear" | "extras" | "weapons" | "rarity";
  z: number;
  tint: TintRole | null;
  attack?: AttackClip;
  /** Weapons that shoot: where the arrow / spell leaves, in frame pixels, for the pose of the attack's impact frame (written to the manifest). */
  muzzle?: (j: Joints) => Pt;
  /** Alternative drawings of this item (ids of other layers of the set), chosen per hero — see `variantOf`. */
  variants?: string[];
  draw: (g: Ctx, p: Pose, j: Joints) => void;
}

export interface AuraSpec {
  id: string;
  draw: (g: Ctx, frame: number, frames: number) => void;
}

const DARK = "#1c1c26";
const WHITE = "#f4f4f8";
const STEEL = { hi: "#f2f6fb", base: "#b9c3d3", lo: "#7d8aa0", deep: "#525d70" };
const WOOD = { hi: "#b08a58", base: "#8a6a40", lo: "#5e4528" };
const GOLD = { hi: "#ffe8a0", base: "#e0a43a", lo: "#9a6a1c" };
const LEATHER = { hi: "#9c7650", base: "#76563a", lo: "#4f3a27" };
const ARCANE = { hi: "#e6dcff", base: "#a98bff", lo: "#5c43b8" };
const HOLY = { hi: "#fffbe0", base: "#ffe08a", lo: "#c99a2e" };

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Torso-local frame: origin at the hip, up = −y, forward = +x. */
export const torso = (g: Ctx, j: Joints, fn: () => void) => local(g, j.hip, j.torsoAngle, fn);
/** Head-local frame, authored at the v1 head size (radius 9.6) and scaled to v2's smaller head — face, hair and hats keep their design. */
export const HEAD_K = HEAD_R / 9.6;
export const head = (g: Ctx, j: Joints, fn: () => void) =>
  local(g, j.head, j.headAngle, () => {
    g.scale(HEAD_K, HEAD_K);
    fn();
  });

// ======================================================================================
// Body (tint: skin)
// ======================================================================================

/**
 * A LIMB: upper segment then lower segment, tapering (a thigh is thicker than a shin, an upper arm than a forearm), drawn as one outlined shape
 * (outline strokes first, fills after, so the joint has no seam) with a band of light along its upper-back edge.
 */
function limb(g: Ctx, a: Pt, b: Pt, c: Pt, w1: number, w2: number, fill: string, light: string | null): void {
  g.save();
  g.lineJoin = "round";
  g.lineCap = "round";
  const seg = (p: Pt, q: Pt, w: number, color: string) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(p[0], p[1]);
    g.lineTo(q[0], q[1]);
    g.stroke();
  };
  seg(a, b, w1 + 2, OL);
  seg(b, c, w2 + 2, OL);
  seg(a, b, w1, fill);
  seg(b, c, w2, fill);
  circle(g, b[0], b[1], (w1 + w2) / 4, fill, 0); // a rounded joint
  if (light) {
    g.translate(-w2 * 0.22, -w2 * 0.22);
    seg(a, lerp(a, b, 0.85), Math.max(0.9, w1 * 0.3), light);
    seg(lerp(b, c, 0.1), lerp(b, c, 0.85), Math.max(0.8, w2 * 0.3), light);
  }
  g.restore();
}

/** A HAND: a small mitten pointing along the forearm, with a thumb on top — not a ball on a stick. */
function hand(g: Ctx, elbow: Pt, at: Pt, fill: string): void {
  const dx = at[0] - elbow[0];
  const dy = at[1] - elbow[1];
  local(g, at, Math.atan2(dy, dx), () => {
    ellipse(g, 0.4, 0, 2.1, 1.65, fill, 1);
    ellipse(g, 0.2, -1.5, 0.9, 0.7, fill, 0.7); // thumb
  });
}

function bodyBase(g: Ctx, _p: Pose, j: Joints): void {
  // back limbs (in shadow), front leg, neck, head
  limb(g, j.shoulderB, j.elbowB, j.handB, 3.2, 2.7, G.lo, null);
  hand(g, j.elbowB, j.handB, G.lo);
  limb(g, j.hipB, j.kneeB, j.footB, 4.6, 3.6, G.lo, null);
  limb(g, j.hipF, j.kneeF, j.footF, 4.6, 3.6, G.base, G.hi);
  tube(g, [j.neck, lerp(j.neck, j.head, 0.4)], 3.4, G.lo);
  head(g, j, () => {
    // A ROUND HEAD, not a box: a big cranium and a soft cheek and jaw on the face side (three-quarter view). Drawn outline-first, so the two
    // shapes merge with one clean edge. Lit from above: the crown and the forehead catch the light; the jaw and the back of the head are in shadow.
    const shape = () => {
      g.beginPath();
      g.ellipse(-0.6, -1.4, 9.4, 9.2, 0, 0, Math.PI * 2);
      g.moveTo(9.8, 4);
      g.ellipse(3.2, 4, 6.6, 5.6, 0.1, 0, Math.PI * 2);
    };
    shape();
    g.strokeStyle = OL;
    g.lineWidth = 2;
    g.stroke();
    shape();
    g.fillStyle = G.base;
    g.fill();
    g.save();
    shape();
    g.clip();
    g.fillStyle = G.lo; // shadow: everything outside a circle shifted up and forward
    g.beginPath();
    g.rect(-12, -12, 24, 24);
    g.arc(1.8, -1.8, 9.6, 0, Math.PI * 2, true);
    g.fill("evenodd");
    g.fillStyle = G.hi; // light on the crown and the forehead, a touch on the cheek
    g.beginPath();
    g.ellipse(2.2, -5.8, 4.6, 2.4, -0.25, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.6;
    g.beginPath();
    g.ellipse(6.8, 4, 1.7, 1.1, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
    ellipse(g, -4.4, 2.2, 1.7, 2.3, G.base, 0.8); // the ear (three-quarter view: on the side of the head, mostly under the hair)
    circle(g, -4.2, 2.4, 0.7, G.lo, 0);
    poly(g, [[9.9, 1.4], [11.2, 3.4], [9.7, 4]], G.base, 0.8); // nose
  });
}

function bodyArm(g: Ctx, _p: Pose, j: Joints): void {
  limb(g, j.shoulderF, j.elbowF, j.handF, 3.3, 2.8, G.base, G.hi);
  hand(g, j.elbowF, j.handF, G.base);
}

// ======================================================================================
// Outfits — main (primary), trim (secondary), front sleeve (primary)
// ======================================================================================

type OutfitStyle = "medium" | "robe" | "light" | "heavy";

/** Trousers / leg armour over the skin legs: tapered like the legs, ending above the boot. */
function legWear(g: Ctx, j: Joints, w1: number, w2: number, back: string, front: string): void {
  limb(g, j.hipB, j.kneeB, lerp(j.kneeB, j.footB, 0.62), w1, w2, back, null);
  limb(g, j.hipF, j.kneeF, lerp(j.kneeF, j.footF, 0.62), w1, w2, front, G.base);
}

/** A BOOT with a heel, an instep and a toe pointing the way the hero faces (and a cuff), per outfit. */
function boot(g: Ctx, knee: Pt, foot: Pt, style: OutfitStyle, front: boolean): void {
  const c = front ? G.lo : G.deep;
  const [fx, fy] = foot;
  if (style === "robe") {
    // only the toe of a soft shoe shows under the robe
    poly(g, [[fx - 1.8, fy - 1.6], [fx + 2.4, fy - 1.8], [fx + 4.4, fy - 0.2], [fx + 4.2, fy + 0.6], [fx - 2, fy + 0.6]], c, 1);
    return;
  }
  const top = lerp(knee, foot, style === "light" ? 0.42 : 0.5);
  const shin = style === "heavy" ? 5.2 : style === "light" ? 3.8 : 4.4;
  tube(g, [top, [fx, fy - 1.6]], shin, c);
  // the foot: heel at the back, a sloped instep, a rounded toe forward, a flat sole
  const toe = style === "heavy" ? 5.4 : style === "light" ? 4.6 : 5;
  poly(g, [[fx - 2.6, fy - 2.6], [fx + 1.2, fy - 2.4], [fx + toe - 0.6, fy - 1.2], [fx + toe, fy + 0.2], [fx + toe - 0.4, fy + 0.8], [fx - 2.8, fy + 0.8]], c, 1);
  line(g, [fx - 2.4, fy + 0.2], [fx + toe - 0.6, fy + 0.2], 0.7, front ? G.deep : OL); // the sole
  if (style === "heavy") {
    // sabaton lames and a knee cop above
    line(g, [fx - 0.4, fy - 2.2], [fx + 1.6, fy - 0.2], 0.7, front ? G.base : G.lo);
    line(g, [fx + 1.6, fy - 1.8], [fx + 3.2, fy - 0.2], 0.7, front ? G.base : G.lo);
  } else {
    // the cuff
    local(g, top, Math.atan2(fy - top[1], fx - top[0]) - Math.PI / 2, () => rrect(g, -shin / 2 - 0.5, -0.6, shin + 1, 1.8, 0.6, front ? G.base : G.lo, 0.8));
  }
}

/** Torso-local V-taper: shoulders wider than the waist, the waist a little narrower than the hips. */
function vTorso(sh: number, wa: number, hi: number, top = -15.8, waist = -4.2, bottom = 0.6): Pt[] {
  return [[-sh, top], [sh, top], [wa, waist], [hi, bottom], [-hi, bottom], [-wa, waist]];
}

function outfitMain(style: OutfitStyle) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    if (style === "heavy") legWear(g, j, 5.8, 5, G.deep, G.lo);
    else if (style === "medium") legWear(g, j, 5.2, 4.4, G.deep, G.lo);
    else if (style === "light") legWear(g, j, 4.8, 4, G.deep, G.lo);
    torso(g, j, () => {
      const sw = p.capeSway * 0.35;
      if (style === "robe") {
        // a long wrap robe to the ankles: fitted at the chest, flaring below the sash, the front panel crossing over (a diagonal edge)
        const hem = Math.min(12.6, floorLen(j, 1.6, 11)); // (the generic robe: worn on any skeleton — it stops at the floor)
        const robe: Pt[] = [[-6.4, -15.8], [6.4, -15.8], [5.6, -6], [11 + sw, hem], [-11 + sw * 0.6, hem], [-5.6, -6]];
        poly(g, robe, G.base, 1);
        poly(g, [[2.4, -15.6], [6.4, -15.8], [5.6, -6], [11 + sw, hem], [4.6 + sw * 0.5, hem], [3, -4]], G.lo, 0); // the shaded side
        poly(g, [[-5.8, -15.4], [-1.6, -15.6], [3.6, -6.4], [1.6, -6.2]], G.lo, 0); // the crossing front panel's shadow
        line(g, [-5.6, -15.4], [2.2, -6.2], 0.9, G.hi); // the panel's lit edge
        // cloth folds: each a shadow line with a light edge beside it, fanning out toward the hem
        for (const [x0, x1] of [[-3.6, -7.2], [0.4, 1.2], [3.4, 7]] as const) {
          line(g, [x0, -3.6], [x1 + sw * 0.5, hem - 0.8], 0.7, G.lo);
          line(g, [x0 - 0.8, -3.6], [x1 - 1 + sw * 0.5, hem - 1], 0.5, G.hi);
        }
        path(g, robe);
        g.strokeStyle = OL;
        g.lineWidth = 1;
        g.stroke();
      } else if (style === "heavy") {
        // breastplate + abdomen lames + three-plate faulds: wide, layered, planted
        const faulds: Array<[number, number]> = [[-10.6, -3.6], [-3.8, 3.8], [3.6, 10.6]];
        for (const [a, b] of faulds) poly(g, [[a + 0.4, 0.2], [b - 0.4, 0.2], [b + 0.4, 7], [a - 0.4, 7]], G.lo, 1);
        poly(g, vTorso(10.2, 8.6, 9.8, -16.6, -5, 1), G.lo, 1); // the plate's edge
        poly(g, vTorso(8.6, 7, 8, -15.4, -5.4, -3.8), G.base, 1); // the breastplate
        poly(g, [[-1.2, -15.2], [3.6, -15.2], [2.6, -5.6], [0.4, -5.4]], G.hi, 0); // a vertical band of light down the ridge
        line(g, [0.2, -15], [0.2, -5.6], 0.8, G.lo); // ridge
        for (const y of [-3.6, -1.6]) rrect(g, -8.8, y, 17.6, 1.9, 0.6, G.base, 0.7); // abdomen lames
      } else if (style === "light") {
        // a fitted jerkin laced up the front, a split leather skirt
        poly(g, [[-6, 0.6], [-0.6, 0.6], [-1.2, 6.2], [-5.4, 5.6]], G.lo, 1);
        poly(g, [[0.6, 0.6], [6, 0.6], [5.4, 5.6], [1.2, 6.2]], G.lo, 1);
        poly(g, vTorso(7, 5.4, 6.2, -15.6, -4.4, 1.2), G.base, 1);
        poly(g, [[3.4, -15.2], [7, -15.6], [5.4, -4.4], [6.2, 1.2], [3.8, 1.2]], G.lo, 0); // the shaded side
        poly(g, [[-2.4, -15.6], [2.4, -15.6], [0, -12.2]], G.deep, 0); // collar notch
        for (let k = 0; k < 4; k++) {
          const y = -11.4 + k * 2.4; // cross lacing
          line(g, [-1.2, y], [1.2, y + 1.6], 0.6, G.hi);
          line(g, [1.2, y], [-1.2, y + 1.6], 0.6, G.hi);
        }
      } else {
        // medium: the TABARD in the class colour, worn over the steel mail (its own untinted part, underneath) — split at the hem
        poly(g, [[-5.4, -15.8], [5.4, -15.8], [5.2, -4], [6, 8.6], [0.6, 8.6], [0, 5.4], [-0.6, 8.6], [-6, 8.6], [-5.2, -4]], G.base, 1);
        poly(g, [[1.8, -15.6], [5.4, -15.8], [5.2, -4], [6, 8.6], [2.6, 8.6]], G.lo, 0);
        poly(g, [[-7.6, -15.6], [-4.8, -15.6], [-4.8, -12], [-7.8, -12.4]], G.base, 0.9); // shoulder strap (back)
      }
    });
    if (style === "heavy") {
      // the back pauldron: two lames
      ellipse(g, j.shoulderB[0] - 0.8, j.shoulderB[1] - 0.2, 5.6, 4.6, G.lo, 1);
      ellipse(g, j.shoulderB[0] - 0.4, j.shoulderB[1] + 3, 5, 2.2, G.deep, 1);
    }
  };
}

function outfitTrim(style: OutfitStyle) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    boot(g, j.kneeB, j.footB, style, false);
    boot(g, j.kneeF, j.footF, style, true);
    torso(g, j, () => {
      const sw = p.capeSway * 0.35;
      if (style === "robe") {
        const hem = Math.min(12.6, floorLen(j, 1.6, 11));
        poly(g, [[-11, hem - 2.2], [11, hem - 2.2], [11 + sw, hem], [-11 + sw * 0.6, hem]], G.hi, 1); // hem band
        rrect(g, -6.4, -6.6, 12.8, 2.8, 1, G.hi, 1); // sash
        rrect(g, -1.4, -7, 2.8, 3.6, 0.8, G.base, 0.8); // the sash knot
        poly(g, [[-0.6, -4], [1.2, -4], [0.6 + sw, 3.6], [-1.6 + sw, 3.2]], G.hi, 0.9); // sash tails
        poly(g, [[0.8, -4], [2.4, -4], [3 + sw, 2.4], [1.4 + sw, 2.8]], G.base, 0.8);
        poly(g, [[-6.4, -15.8], [6.4, -15.8], [5, -13], [-5, -13]], G.hi, 1); // collar
      } else if (style === "heavy") {
        rrect(g, -10, -17.6, 20, 2.2, 0.8, G.hi, 1); // gorget rim
        rrect(g, -9.6, -5.2, 19.2, 2.6, 0.8, G.hi, 1); // belt
        rrect(g, -1.8, -5.6, 3.6, 3.4, 0.6, G.base, 0.8); // buckle
        for (const x of [-7.6, 7.6]) circle(g, x, -13, 0.9, G.hi, 0.6); // rivets
        for (const x of [-7.2, 0, 7.2]) circle(g, x, 6, 0.7, G.hi, 0.5); // fauld rivets
      } else if (style === "light") {
        poly(g, [[-6.2, -14.6], [-2.4, -15.2], [6, -2.6], [2.6, -1.8]], G.hi, 1); // the baldric strap
        rrect(g, -6.4, -3.6, 12.8, 2.4, 1, G.lo, 1); // belt
        rrect(g, -1.2, -4, 2.4, 3.2, 0.6, G.hi, 0.8); // buckle
        rrect(g, 3, -2, 3.6, 4.2, 1, G.hi, 1); // pouch
        rrect(g, -6.4, -1.8, 3, 3.6, 1, G.hi, 1); // pouch
      } else {
        // the tabard's hemmed edges, a belt and its buckle (the tabard itself is the main layer, in the class colour)
        line(g, [-5.4, -15.2], [-5.9, 8.2], 0.9, G.hi);
        line(g, [5.4, -15.2], [5.9, 8.2], 0.9, G.hi);
        line(g, [-6, 8.6], [-0.6, 8.6], 0.9, G.hi);
        line(g, [0.6, 8.6], [6, 8.6], 0.9, G.hi);
        rrect(g, -7.6, -4.6, 15.2, 2.6, 1, G.lo, 1); // belt
        rrect(g, -1.6, -5.1, 3.2, 3.6, 0.6, G.hi, 0.8); // buckle
        // the house mark on the chest: a chevron
        poly(g, [[-3, -12.6], [0, -9.6], [3, -12.6], [3, -10.8], [0, -7.8], [-3, -10.8]], G.hi, 0.7);
      }
    });
  };
}

function outfitFront(style: OutfitStyle) {
  return (g: Ctx, _p: Pose, j: Joints): void => {
    if (style === "robe") {
      // a bell sleeve that opens toward the hand
      const mid = lerp(j.elbowF, j.handF, 0.55);
      tube(g, [j.shoulderF, j.elbowF], 5.4, G.base);
      poly(g, [[j.elbowF[0] - 3, j.elbowF[1] - 1.6], [j.elbowF[0] + 3, j.elbowF[1] - 1.6], [mid[0] + 3.8, mid[1] + 1.4], [mid[0] - 3.8, mid[1] + 1.4]], G.base, 1);
      line(g, [j.elbowF[0] - 2.2, j.elbowF[1] - 0.6], [mid[0] - 2.6, mid[1] + 0.8], 0.6, G.lo); // a fold down the sleeve
      circle(g, mid[0], mid[1] + 0.6, 2.6, G.hi, 0.8);
      return;
    }
    const w1 = style === "heavy" ? 5.2 : style === "light" ? 4.2 : 4.6;
    limb(g, j.shoulderF, j.elbowF, lerp(j.elbowF, j.handF, 0.2), w1, w1 - 0.6, G.base, G.hi);
    if (style === "heavy") {
      // a big front pauldron (two plates) and a vambrace — it sits ON the shoulder, below the jaw: the Tank's face stays visible over it
      ellipse(g, j.shoulderF[0] + 0.4, j.shoulderF[1] + 0.6, 5.6, 4.2, G.base, 1);
      ellipse(g, j.shoulderF[0] - 1.2, j.shoulderF[1] - 0.6, 2.4, 1.4, G.hi, 0);
      ellipse(g, j.shoulderF[0] + 0.6, j.shoulderF[1] + 3.4, 4.8, 2.2, G.lo, 1);
      tube(g, [lerp(j.elbowF, j.handF, 0.2), lerp(j.elbowF, j.handF, 0.8)], 4.4, G.lo);
      circle(g, j.elbowF[0], j.elbowF[1], 2.2, G.hi, 0.8); // the couter
    } else {
      // a bracer / glove at the forearm
      tube(g, [lerp(j.elbowF, j.handF, 0.35), lerp(j.elbowF, j.handF, 0.85)], style === "light" ? 3.6 : 4, G.lo);
      line(g, lerp(j.elbowF, j.handF, 0.4), lerp(j.elbowF, j.handF, 0.8), 0.6, G.base); // the bracer's lacing / seam
    }
  };
}

/** The Warrior's MAIL (part of the medium outfit, untinted steel, under the tabard): a mail shirt with sleeves and a mail skirt. */
function mediumMail(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    poly(g, [[-8.4, 0.6], [8.4, 0.6], [9.4, 7.2], [-9.4, 7.2]], STEEL.lo, 1); // mail skirt
    poly(g, vTorso(8, 6.6, 7.4, -16, -4.2, 1), STEEL.base, 1);
    for (const y of [-12.4, -9.6, -6.8, -4, -1.2]) line(g, [-6.6, y], [6.6, y], 0.6, STEEL.lo); // mail rows
    for (const y of [2.6, 4.8]) line(g, [-8.6, y], [8.6, y], 0.6, STEEL.deep);
  });
  limb(g, j.shoulderB, j.elbowB, lerp(j.elbowB, j.handB, 0.3), 4.4, 3.8, STEEL.lo, null); // mail sleeve (back arm)
}

// ======================================================================================
// Face (real colours), head-local
// ======================================================================================

const EYE: Pt[] = [[-1.6, 1.8], [4.7, 1.8]];

function eyes(style: number) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    head(g, j, () => {
      g.lineCap = "round";
      g.lineJoin = "round";
      for (const [x, y] of EYE) {
        g.strokeStyle = DARK;
        g.fillStyle = DARK;
        g.lineWidth = 1.1;
        if (p.eyes === "dead") {
          g.beginPath();
          g.moveTo(x - 1.6, y - 1.6); g.lineTo(x + 1.6, y + 1.6);
          g.moveTo(x + 1.6, y - 1.6); g.lineTo(x - 1.6, y + 1.6);
          g.stroke();
        } else if (p.eyes === "hurt") {
          g.beginPath();
          g.moveTo(x - 1.7, y - 1.5); g.lineTo(x + 0.2, y + 0.2); g.lineTo(x - 1.7, y + 1.7);
          g.stroke();
        } else if (p.eyes === "cheer") {
          g.beginPath();
          g.arc(x, y + 1.2, 1.8, Math.PI * 1.1, Math.PI * 1.9);
          g.stroke();
        } else if (p.eyes === "focus") {
          // narrowed, determined (a brow line over a slit)
          g.beginPath();
          g.moveTo(x - 1.9, y - 0.4); g.lineTo(x + 1.9, y + 0.3);
          g.stroke();
          line(g, [x - 2, y - 2.6], [x + 1.8, y - 1.6], 1, DARK);
        } else if (style === 0) {
          g.beginPath();
          g.ellipse(x, y, 1.25, 1.85, 0, 0, Math.PI * 2);
          g.fill();
          circle(g, x + 0.4, y - 0.7, 0.45, WHITE, 0);
          line(g, [x - 1.7, y - 3.1], [x + 1.6, y - 3.4], 0.9, DARK); // brow: level, calm
        } else if (style === 1) {
          ellipse(g, x, y, 1.45, 1.95, WHITE, 0.7, DARK);
          circle(g, x + 0.45, y + 0.35, 1, DARK, 0);
          line(g, [x - 1.6, y - 3.4], [x + 1.4, y - 3.9], 0.9, DARK); // brow: raised, alert
        } else if (style === 2) {
          g.beginPath();
          g.arc(x, y - 0.8, 1.9, Math.PI * 0.15, Math.PI * 0.85);
          g.stroke();
        } else {
          g.beginPath();
          g.moveTo(x - 1.9, y - 1); g.lineTo(x + 1.9, y + 0.4);
          g.stroke();
          g.beginPath();
          g.arc(x + 0.5, y + 0.9, 0.85, 0, Math.PI * 2);
          g.fill();
          line(g, [x - 1.8, y - 3.6], [x + 1.6, y - 2.6], 1, DARK); // brow: low, stern
        }
      }
    });
  };
}

function mouth(style: number) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    head(g, j, () => {
      g.strokeStyle = DARK;
      g.fillStyle = DARK;
      g.lineWidth = 1.05;
      g.lineCap = "round";
      const x = 1.8;
      const y = 6.2;
      if (p.mouth === "shout") ellipse(g, x, y + 0.3, 1.9, 2.1, DARK, 0.5, DARK);
      else if (p.mouth === "open") ellipse(g, x, y + 0.3, 1.7, 1.9, DARK, 0.6, DARK);
      else if (p.mouth === "hurt") ellipse(g, x, y + 0.5, 1.1, 1.5, DARK, 0.5, DARK);
      else if (style === 0) {
        g.beginPath();
        g.arc(x, y - 1.6, 2.6, Math.PI * 0.2, Math.PI * 0.8);
        g.stroke();
      } else if (style === 1) {
        g.beginPath();
        g.moveTo(x - 1.8, y + 0.4); g.lineTo(x + 1.8, y + 0.4);
        g.stroke();
      } else {
        rrect(g, x - 2.2, y - 0.6, 4.4, 2.2, 1, WHITE, 0.8, DARK);
      }
    });
  };
}

// ======================================================================================
// Hair (tint: hair) — head-local (v1 design, scaled with the head)
// ======================================================================================

function hairShape(g: Ctx, style: number, sway: number): void {
  g.lineJoin = "round";
  const done = () => {
    g.fillStyle = G.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
  };
  const sheen = (x: number, y: number, r: number) => {
    g.strokeStyle = G.hi;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(x, y, r, Math.PI * 1.15, Math.PI * 1.55);
    g.stroke();
  };
  switch (style) {
    case 0:
      g.beginPath();
      g.arc(0, 0, 10.7, Math.PI * 1.02, Math.PI * 1.98);
      g.bezierCurveTo(8.4, -4.2, 3.4, -3.6, 0.4, -5);
      g.bezierCurveTo(-3.4, -6.4, -8, -3.2, -10.5, -0.6);
      g.closePath();
      done();
      sheen(0, 0, 8.6);
      break;
    case 1:
      path(g, [[-10.4, 0], [-10, -6.8], [-6.4, -4.4], [-5.6, -12.4], [-2, -7.2], [1.4, -14.2], [3.2, -7.6], [7.4, -12], [7.4, -5.6], [10.4, -7.2], [10.4, 0], [6, -4.4], [0, -5.6], [-6, -4.4]]);
      done();
      break;
    case 2:
      g.beginPath();
      g.arc(0, 0, 10.8, Math.PI * 1.0, Math.PI * 2.0);
      g.bezierCurveTo(8.6, -4.6, 3, -3.4, -0.4, -5.2);
      g.bezierCurveTo(-4, -6.4, -8.4, -3.4, -10.8, 0);
      g.closePath();
      done();
      sheen(0, 0, 8.8);
      break;
    case 3:
      path(g, [[-3, -7.8], [-3.6, -14], [-0.2, -11.4], [2.4, -15.6], [3.4, -8.4], [3.6, -4], [-3, -4]]);
      done();
      break;
    case 4:
      g.beginPath();
      g.arc(0, 0, 10.6, Math.PI * 1.04, Math.PI * 1.96);
      g.bezierCurveTo(7.6, -3.8, 3, -3.4, 0, -4.6);
      g.bezierCurveTo(-3, -5.6, -7, -3.2, -10.2, -1);
      g.closePath();
      done();
      circle(g, -1, -13, 3.9, G.base, 1);
      sheen(-1, -13, 2.6);
      break;
    case 5:
      g.beginPath();
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.02 + (i / 6) * 0.96);
        g.moveTo(Math.cos(a) * 9.2 + 3.7, Math.sin(a) * 9.2);
        g.arc(Math.cos(a) * 9.2, Math.sin(a) * 9.2, 3.7, 0, Math.PI * 2);
      }
      g.fillStyle = G.base;
      g.fill();
      g.strokeStyle = OL;
      g.lineWidth = 1;
      g.stroke();
      circle(g, 0, -4.2, 5.4, G.base, 0);
      break;
    case 6:
      g.beginPath();
      g.arc(0, 0, 10.7, Math.PI * 1.02, Math.PI * 1.9);
      g.bezierCurveTo(12.4, -6.6, 11.2 + sway * 0.1, -2.4, 8.6, -1.6);
      g.bezierCurveTo(5, -6.2, -2, -6.4, -8.8, -2.8);
      g.bezierCurveTo(-10, -2, -10.4, -1, -10.5, -0.6);
      g.closePath();
      done();
      sheen(0, 0, 8.4);
      break;
    default:
      break;
  }
}

const hair = (style: number) => (g: Ctx, p: Pose, j: Joints): void => head(g, j, () => hairShape(g, style, p.capeSway));

function hairBackLong(g: Ctx, p: Pose, j: Joints): void {
  head(g, j, () => {
    const sw = p.capeSway * 0.3;
    poly(g, [[-9.8, -3], [-3, -8], [3, -8], [8, -3], [9.4 + sw * 0.5, 9], [4 + sw, 17], [-4 + sw, 17.4], [-10 + sw * 0.8, 10]], G.lo, 1);
  });
}

// ======================================================================================
// Headgear — head-local
// ======================================================================================

function helm(g: Ctx, _p: Pose, j: Joints): void {
  // Open-faced bascinet in real STEEL (not the class colour — a fighter's helm must read as metal, and a tinted dome melted into the skin): a
  // dome lit from the top-left, a brass brow band, a nasal guard between the eyes, a back cheek plate and a plume socket (Warrior and Tank).
  head(g, j, () => {
    g.beginPath();
    g.arc(0, 0.4, 11.4, Math.PI * 1.02, Math.PI * 1.98);
    g.lineTo(11.6, 3.4);
    g.lineTo(-11.6, 3.4);
    g.closePath();
    g.fillStyle = STEEL.base;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = STEEL.lo;
    g.beginPath();
    g.rect(-13, -13, 26, 18);
    g.arc(-2.6, -2.2, 11.2, 0, Math.PI * 2, true);
    g.fill("evenodd");
    g.restore();
    g.beginPath();
    g.arc(0, 0.4, 11.4, Math.PI * 1.02, Math.PI * 1.98);
    g.lineTo(11.6, 3.4);
    g.lineTo(-11.6, 3.4);
    g.closePath();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    // face opening: the whole face shows (eyes, nose, mouth — the face layers are underneath); the helm frames it
    g.save();
    g.globalCompositeOperation = "destination-out";
    rrect(g, -4.6, -2.2, 17, 8, 2.2, "#000", 0);
    g.restore();
    rrect(g, -11.6, -3.6, 23.2, 2.4, 1, GOLD.base, 0.9); // brass brow band
    rrect(g, 0.6, -3.4, 1.9, 6.2, 0.8, STEEL.lo, 0.8); // nasal guard — BETWEEN the eyes
    poly(g, [[-11.4, 3.4], [-6.4, 3.4], [-6, 9.4], [-10.4, 8]], STEEL.lo, 0.9); // cheek plate (back of the head)
    rrect(g, -1.4, -15.2, 2.8, 4.2, 1, GOLD.base, 0.9); // plume socket
    g.strokeStyle = STEEL.hi;
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(0, 0.4, 9.2, Math.PI * 1.15, Math.PI * 1.45);
    g.stroke();
  });
}

function hat(g: Ctx, _p: Pose, j: Joints): void {
  // A tall, bent wizard's hat with a wide brim and a band.
  head(g, j, () => {
    poly(g, [[-8.4, -6.8], [-4.4, -15.2], [-1.6, -21.2], [7.6, -23.4], [3.4, -18.6], [4.4, -13.4], [8.8, -6.8]], G.base, 1);
    poly(g, [[2.2, -14], [4.4, -13.4], [8.8, -6.8], [5.2, -6.8]], G.lo, 0);
    poly(g, [[-8.8, -7.4], [9, -7.4], [9, -4.8], [-8.8, -4.8]], G.deep, 1); // band
    ellipse(g, 0, -5.4, 15.4, 3.2, G.base, 1); // brim
    g.strokeStyle = G.hi;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-5, -9.6);
    g.lineTo(-1.6, -17.4);
    g.stroke();
  });
}

function hood(g: Ctx, _p: Pose, j: Joints): void {
  // A deep hood that shades the face, with a cloth mask over the mouth — the rogue's silhouette.
  head(g, j, () => {
    g.beginPath();
    g.arc(-0.8, -0.6, 12.4, 0, Math.PI * 2);
    g.arc(3, 2.2, 8.4, 0, Math.PI * 2, true);
    g.fillStyle = G.base;
    g.fill("evenodd");
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(-0.8, -0.6, 12.4, 0, Math.PI * 2);
    g.stroke();
    // the face in shadow under the cowl
    g.save();
    g.globalAlpha = 0.45;
    g.beginPath();
    g.arc(3, 2.2, 8.4, Math.PI * 1.05, Math.PI * 1.95);
    g.lineTo(11, 0.4);
    g.lineTo(-5, 0.4);
    g.closePath();
    g.fillStyle = "#121018";
    g.fill();
    g.restore();
    poly(g, [[-7, -11.6], [-1.6, -16.6], [2.6, -12]], G.base, 1); // peak
    // the mask: covers the lower face
    poly(g, [[-3.6, 3.6], [10.6, 3], [10, 8.8], [3, 10.6], [-3.4, 9]], G.lo, 1);
    line(g, [-2.6, 5.6], [9.6, 5.2], 0.7, G.deep);
    ellipse(g, -1.4, 11.4, 9.6, 3.2, G.lo, 1); // mantle
  });
}

function cap(g: Ctx, p: Pose, j: Joints): void {
  // The ranger's hat: a soft forester's cap — low at the brow, the crown sweeping BACK to a drooping point, the brim turned up at the front.
  // (Its feather is a part of its own, in real colours.)
  head(g, j, () => {
    const sw = p.capeSway * 0.3;
    const crown: Pt[] = [[11.6, -2], [10, -8.4], [3.6, -12.6], [-4.6, -13.2], [-11.4 + sw * 0.6, -10.8], [-14.6 + sw, -5.6], [-11.2, -6], [-11.2, -1.6]];
    poly(g, crown, G.base, 1);
    poly(g, [[-1.6, -12.8], [-4.6, -13.2], [-11.4 + sw * 0.6, -10.8], [-14.6 + sw, -5.6], [-11.2, -6], [-8.4, -9.6]], G.lo, 0); // the shaded back
    line(g, [7.6, -10.4], [-1.4, -12.4], 0.9, G.hi); // light on the crown
    poly(g, [[12.8, -0.8], [11.8, -5], [2.4, -4.2], [-11.4, -3.2], [-11.8, -0.4]], G.lo, 1); // the turned-up brim, deeper at the front
    line(g, [11.2, -4.2], [-10.6, -2.6], 0.6, G.hi);
  });
}

/** The cap's feather (real colours): a long red feather tucked in the band, sweeping up and back. */
function capFeather(g: Ctx, p: Pose, j: Joints): void {
  head(g, j, () => {
    local(g, [-3, -6], -1.0 + p.capeSway * 0.025, () => {
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-2.8, -8, 0.4, -15.6);
      g.quadraticCurveTo(2.8, -8, 0, 0);
      g.fillStyle = "#d24a3c";
      g.fill();
      g.strokeStyle = OL;
      g.lineWidth = 0.8;
      g.stroke();
      line(g, [0, -1], [0.3, -14.4], 0.5, "#f6d2b0"); // the quill
      line(g, [0.3, -6.4], [1.8, -8.6], 0.45, "#8e2a22");
      line(g, [0.2, -9.6], [1.4, -11.6], 0.45, "#8e2a22");
    });
  });
}

function halo(g: Ctx, _p: Pose, j: Joints): void {
  // A gold circlet and a hovering halo — the cleric's holy mark (no soft glow blob: a clean ring).
  head(g, j, () => {
    rrect(g, -10.4, -4.4, 20.8, 2.2, 1, GOLD.base, 0.9); // circlet
    circle(g, 6.4, -3.3, 1.2, "#e8f4ff", 0.6);
    g.strokeStyle = OL;
    g.lineWidth = 3.4;
    g.beginPath();
    g.ellipse(-0.4, -15.4, 8.8, 2.9, -0.08, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = GOLD.hi;
    g.lineWidth = 1.7;
    g.stroke();
  });
}

function crown(g: Ctx, _p: Pose, j: Joints): void {
  head(g, j, () => {
    poly(g, [[-8, -7.6], [-8.6, -16], [-4.2, -11.4], [0, -17.4], [4.2, -11.4], [8.6, -16], [8, -7.6]], GOLD.base, 1);
    poly(g, [[-8, -7.6], [8, -7.6], [7.8, -9.4], [-7.8, -9.4]], GOLD.hi, 1);
    circle(g, 0, -12, 1.1, "#e0455a", 0.6);
  });
}

// ======================================================================================
// Accessories
// ======================================================================================

function goggles(g: Ctx, _p: Pose, j: Joints): void {
  head(g, j, () => {
    g.strokeStyle = OL;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, 10.4, Math.PI * 1.08, Math.PI * 1.92);
    g.stroke();
    g.strokeStyle = "#5a4a3a";
    g.lineWidth = 1.5;
    g.stroke();
    circle(g, -1.4, -6, 3, "#8fd8ff", 1);
    circle(g, 5.2, -6, 3, "#8fd8ff", 1);
  });
}

function scarf(g: Ctx, p: Pose, j: Joints): void {
  torso(g, j, () => {
    const sw = p.capeSway * 0.5;
    poly(g, [[-6.8, -16.2], [6.8, -16.2], [6.2, -12.6], [-6.2, -12.6]], G.base, 1);
    poly(g, [[-5, -13.4], [-2, -13.4], [-8 + sw, -3.4], [-11 + sw, -4.8]], G.lo, 1);
  });
}

function cogPin(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? 2.2 : 3.2;
      g.lineTo(-3.4 + Math.cos(a) * r, -10 + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = GOLD.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 0.8;
    g.stroke();
    circle(g, -3.4, -10, 0.9, DARK, 0);
  });
}

function monocle(g: Ctx, _p: Pose, j: Joints): void {
  head(g, j, () => {
    g.strokeStyle = OL;
    g.lineWidth = 2.6;
    g.beginPath();
    g.arc(4.7, 1.8, 2.8, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1;
    g.stroke();
    line(g, [7.2, 3.4], [8.6, 10.4], 0.8, GOLD.hi);
  });
}

function headset(g: Ctx, _p: Pose, j: Joints): void {
  head(g, j, () => {
    g.strokeStyle = OL;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, 10.6, Math.PI * 1.02, Math.PI * 1.5);
    g.stroke();
    g.strokeStyle = "#4a5568";
    g.lineWidth = 1.5;
    g.stroke();
    ellipse(g, -8.6, 1.4, 2.4, 3.2, "#4a5568", 1);
    line(g, [-8.2, 4.4], [4, 8.6], 0.9, "#4a5568");
    circle(g, 4.4, 8.6, 1.1, "#e0455a", 0.6);
  });
}

// ======================================================================================
// Cape (tint: cape) — behind everything
// ======================================================================================

function cape(g: Ctx, p: Pose, j: Joints): void {
  torso(g, j, () => {
    const sw = p.capeSway;
    const k = 1 - p.capeFold * 0.55;
    poly(g, [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 5 * k], [-4.6 + sw, 14.4 * k], [(-13 + sw * 1.2) * k, 12.6 * k], [(-10 + sw) * k, 0]], G.base, 1);
    poly(g, [[-4.6, -15], [-8 * k, -4], [(-13 + sw * 1.2) * k, 12.6 * k], [(-10 + sw) * k, 0]], G.lo, 0);
  });
}

// ======================================================================================
// Weapons (real colours) — drawn from the front hand along the pose's weapon axis
// ======================================================================================

const axisAngle = (j: Joints): number => Math.atan2(j.weaponDir[0], -j.weaponDir[1]);
export const inWeaponSpace = (g: Ctx, at: Pt, j: Joints, fn: () => void, extra = 0) => local(g, at, axisAngle(j) + extra, fn);
/** A point given in weapon space (the front hand, along the weapon axis) → frame pixels. */
const weaponPoint = (j: Joints, x: number, y: number): Pt => {
  const th = axisAngle(j);
  return [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
};

function sword(g: Ctx, _p: Pose, j: Joints): void {
  // A broad arming sword: fullered blade, a wide crossguard, a wrapped grip and a pommel.
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1.1, -0.6, 2.2, 5, 0.8, LEATHER.lo, 0.8);
    circle(g, 0, 5.2, 1.6, GOLD.base, 0.8);
    poly(g, [[-2.1, -2], [2.1, -2], [2.1, -18.6], [0, -23.6], [-2.1, -18.6]], STEEL.base, 1);
    poly(g, [[0, -2], [2.1, -2], [2.1, -18.6], [0, -23.6]], STEEL.lo, 0);
    line(g, [-0.5, -3.4], [-0.5, -18], 0.8, STEEL.hi);
    rrect(g, -5.2, -3.2, 10.4, 2.4, 0.9, GOLD.base, 0.9);
    circle(g, -5, -2, 1, GOLD.lo, 0.6);
    circle(g, 5, -2, 1, GOLD.lo, 0.6);
  });
}

function mace(g: Ctx, _p: Pose, j: Joints): void {
  // A heavy flanged mace (the Tank's): a long haft and a six-flanged steel head.
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1.2, -14, 2.4, 19, 0.9, WOOD.base, 0.8);
    rrect(g, -1.4, -2, 2.8, 5, 0.8, LEATHER.lo, 0.7);
    for (const [x, y] of [[-5.4, -16.6], [5.4, -16.6], [-4.4, -20.8], [4.4, -20.8], [0, -23.4], [0, -13]] as const) poly(g, [[0, -17], [x, y], [x * 0.6, y + 2.2]], STEEL.lo, 0.8);
    circle(g, 0, -17.2, 4.4, STEEL.base, 1);
    circle(g, -1.4, -18.6, 1.3, STEEL.hi, 0);
    rrect(g, -3.2, -12.6, 6.4, 1.8, 0.6, GOLD.base, 0.7);
  });
}

/** How far below the crystal the mage holds the staff (weapon-space px; the shared rarity fx use the same offset). */
export const STAFF_GRIP = 4;

function staff(g: Ctx, p: Pose, j: Joints): void {
  // A tall gnarled staff with a wrapped grip and a floating crystal held by prongs. Gripped high on the shaft (STAFF_GRIP), so the crystal stays
  // inside the frame when the staff is thrust forward.
  inWeaponSpace(g, j.handF, j, () => {
    g.translate(0, STAFF_GRIP);
    rrect(g, -1.1, -19, 2.2, 28, 0.9, WOOD.base, 0.8);
    line(g, [-0.4, -18], [-0.4, 7], 0.6, WOOD.hi);
    for (const y of [-2.6, -0.6]) rrect(g, -1.6, y, 3.2, 1.2, 0.5, ARCANE.lo, 0.6);
    poly(g, [[-1.1, -19], [-3.6, -23.4], [-1.6, -21.4]], WOOD.lo, 0.8);
    poly(g, [[1.1, -19], [3.6, -23.4], [1.6, -21.4]], WOOD.lo, 0.8);
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.25 + p.glow * 0.35;
      circle(g, 0, -24, 3.6 + p.glow * 3, ARCANE.hi, 0);
      g.restore();
    }
    poly(g, [[0, -28.4], [2.6, -24], [0, -20.2], [-2.6, -24]], p.glow > 0.5 ? ARCANE.hi : ARCANE.base, 1);
    poly(g, [[0, -28.4], [2.6, -24], [0, -24]], ARCANE.hi, 0);
  });
}

/** The tome strapped at the hip and the sun pendant (both drawings of the Cleric's holy kit). */
function tomeAtHip(g: Ctx, j: Joints): void {
  torso(g, j, () => {
    rrect(g, 3.6, -3.8, 5.4, 6.8, 0.9, "#8a4b2a", 0.9); // tome at the hip
    rrect(g, 4.4, -3, 3.8, 5.2, 0.6, "#f0e4c4", 0.6);
    rrect(g, 3.6, -3.8, 1.2, 6.8, 0.4, GOLD.base, 0.5);
    line(g, [3.4, -4.6], [-2, -14], 0.8, LEATHER.lo); // strap
    circle(g, 1.2, -11.4, 1.9, GOLD.base, 0.8); // sun pendant
    circle(g, 1.2, -11.4, 0.8, GOLD.hi, 0);
  });
}

function tome(g: Ctx, p: Pose, j: Joints): void {
  // THE CLERIC'S HOLY KIT (the `tome` item): a sun scepter in the hand, the tome itself strapped at the hip, and a sun pendant on the chest.
  tomeAtHip(g, j);
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1, -15, 2, 19, 0.8, "#e9dcb8", 0.8);
    rrect(g, -1.3, -2, 2.6, 4.4, 0.6, GOLD.lo, 0.7);
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.22 + p.glow * 0.38;
      circle(g, 0, -18.4, 4.4 + p.glow * 3.2, HOLY.hi, 0);
      g.restore();
    }
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      line(g, [Math.cos(a) * 3, -18.4 + Math.sin(a) * 3], [Math.cos(a) * 5.4, -18.4 + Math.sin(a) * 5.4], 1.1, i % 2 ? GOLD.lo : GOLD.base);
    }
    circle(g, 0, -18.4, 3.2, p.glow > 0.5 ? HOLY.hi : HOLY.base, 1);
    circle(g, -0.8, -19.2, 0.9, WHITE, 0);
  });
}

function daggers(g: Ctx, _p: Pose, j: Joints): void {
  // Twin curved daggers; the back hand holds its blade reversed.
  const blade = (): void => {
    rrect(g, -0.9, -0.4, 1.8, 3.4, 0.5, LEATHER.lo, 0.6);
    g.beginPath();
    g.moveTo(-1.5, -1.2);
    g.quadraticCurveTo(-2.4, -7, 0.6, -12.4);
    g.quadraticCurveTo(2.2, -6.6, 1.5, -1.2);
    g.closePath();
    g.fillStyle = STEEL.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 0.9;
    g.stroke();
    line(g, [0.1, -2.4], [0.5, -10.6], 0.6, STEEL.hi);
    rrect(g, -2.8, -2, 5.6, 1.4, 0.5, STEEL.lo, 0.6);
  };
  inWeaponSpace(g, j.handB, j, blade, Math.PI - 0.4);
  inWeaponSpace(g, j.handF, j, blade);
}

/** How far a resting bow is turned upright from the weapon axis (radians; 0 while drawn or raised). Shared with the bow's rarity fx. */
export const bowCarry = (p: Pose): number => (p.draw === 0 && p.weaponAngle < 2.95 ? -(Math.PI - 0.06 - p.weaponAngle) : 0);

function bow(g: Ctx, p: Pose, j: Joints): void {
  // A long recurve bow; the string follows the drawing hand; an arrow is nocked while drawn. At rest (walking, standing) it is carried UPRIGHT at
  // the side, so its string never slashes across the body; raised to shoot, it follows the arm.
  bowWith(g, p, j, () => {
    g.strokeStyle = OL;
    g.lineWidth = 3.6;
    g.beginPath();
    g.moveTo(-1.6, -17.4);
    g.quadraticCurveTo(1.4, -15.4, 2, -11);
    g.quadraticCurveTo(7.4, 0, 2, 11);
    g.quadraticCurveTo(1.4, 15.4, -1.6, 17.4);
    g.stroke();
    g.strokeStyle = WOOD.base;
    g.lineWidth = 2;
    g.stroke();
    g.strokeStyle = WOOD.hi;
    g.lineWidth = 0.7;
    g.beginPath();
    g.moveTo(2.4, -9);
    g.quadraticCurveTo(6.4, 0, 2.4, 9);
    g.stroke();
    rrect(g, 1.2, -2.6, 3.2, 5.2, 0.8, LEATHER.lo, 0.7);
  });
}

/** A bow's limbs (drawn by `limbs`, string tips at (−1.6, ±17.4) in weapon space), then the string, the nocked arrow and the carry angle. */
function bowWith(g: Ctx, p: Pose, j: Joints, limbs: () => void): void {
  const carry = bowCarry(p);
  inWeaponSpace(g, j.handF, j, limbs, carry);
  const th = axisAngle(j) + carry;
  const toWorld = (x: number, y: number): Pt => [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
  const tipT = toWorld(-1.6, -17.4);
  const tipB = toWorld(-1.6, 17.4);
  const rest = toWorld(-0.6, 0);
  const nock: Pt = [rest[0] + (j.handB[0] - rest[0]) * p.draw, rest[1] + (j.handB[1] - rest[1]) * p.draw];
  g.strokeStyle = "#ece6d4";
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(tipT[0], tipT[1]);
  g.lineTo(nock[0], nock[1]);
  g.lineTo(tipB[0], tipB[1]);
  g.stroke();
  if (p.draw > 0.25) {
    const tip: Pt = [j.handF[0] + 7.5, j.handF[1] + (nock[1] - j.handF[1]) * 0.12];
    line(g, nock, tip, 1.3, OL);
    line(g, nock, tip, 0.8, "#e9dcb8");
    poly(g, [[tip[0], tip[1] - 1.7], [tip[0] + 3.4, tip[1]], [tip[0], tip[1] + 1.7]], STEEL.base, 0.7);
    poly(g, [[nock[0], nock[1]], [nock[0] - 2.6, nock[1] - 1.6], [nock[0] - 1.2, nock[1]]], "#e0455a", 0.5);
    poly(g, [[nock[0], nock[1]], [nock[0] - 2.6, nock[1] + 1.6], [nock[0] - 1.2, nock[1]]], "#e0455a", 0.5);
  }
}

/** The ranger's QUIVER (part of the bow, behind the body): a leather tube on the back with fletched arrows. */
function quiver(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    local(g, [-4.6, -9], -0.42, () => {
      for (const [x, c] of [[-1.6, "#e0455a"], [0, "#f4f4f8"], [1.6, "#e0455a"]] as const) {
        line(g, [x, -6], [x, -10.6], 0.8, "#e9dcb8");
        poly(g, [[x - 1.1, -10.6], [x, -13.2], [x + 1.1, -10.6]], c, 0.6);
      }
      rrect(g, -3, -7, 6, 15.4, 1.4, LEATHER.base, 1);
      rrect(g, -3, -7, 6, 2, 0.8, LEATHER.hi, 0.8);
      line(g, [-1.4, -4.6], [-1.4, 7], 0.7, LEATHER.lo);
    });
  });
}

function shield(g: Ctx, _p: Pose, j: Joints): void {
  // A tall tower shield on the back arm: rim, boss, a riveted cross — it covers most of the Tank, and that IS the Tank's silhouette.
  const c: Pt = [j.handB[0] + 4.2, j.handB[1] - 3];
  local(g, c, j.torsoAngle * 0.5, () => {
    path(g, [[-6.4, -11.4], [6.4, -11.4], [7, 6.6], [0, 12.6], [-7, 6.6]]);
    g.fillStyle = STEEL.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    path(g, [[1.4, -11.4], [6.4, -11.4], [7, 6.6], [0, 12.6], [1.4, 11.4]]);
    g.fillStyle = STEEL.lo;
    g.fill();
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1.1;
    path(g, [[-5.2, -10.2], [5.2, -10.2], [5.8, 5.9], [0, 11.2], [-5.8, 5.9]]);
    g.stroke();
    line(g, [0, -9.6], [0, 10], 1, GOLD.lo);
    line(g, [-5, -1.6], [5.4, -1.6], 1, GOLD.lo);
    circle(g, 0, -1.6, 2.6, GOLD.base, 0.9);
    circle(g, -0.7, -2.3, 0.8, GOLD.hi, 0);
    for (const [x, y] of [[-4.4, -8.6], [4.4, -8.6], [-4.6, 4.6], [4.6, 4.6]] as const) circle(g, x, y, 0.7, STEEL.hi, 0.4);
  });
}

// ======================================================================================
// Class kits — parts of the class's own weapon (so every hero of the class wears them, whatever its variant): small pieces of gear that make
// each class readable at a glance, beyond its outfit
// ======================================================================================

/** Warrior: the empty scabbard at the back hip, on a strap — a swordsman, not just a man with a sword. */
function swordScabbard(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    local(g, [-3.6, -3], 0.72, () => {
      rrect(g, -1.7, 0, 3.4, 12.6, 1.2, LEATHER.lo, 1);
      line(g, [-0.8, 2.4], [-0.8, 11], 0.6, LEATHER.hi);
      rrect(g, -2.1, -0.4, 4.2, 2.4, 0.6, GOLD.base, 0.8); // the locket
      poly(g, [[-1.7, 10.6], [1.7, 10.6], [1.2, 13.4], [0, 14.2], [-1.2, 13.4]], GOLD.base, 0.8); // the chape
    });
  });
}

/** Tank: a steel BEVOR over the jaw and a visor brim — a fortress, the face reduced to its eyes. */
function maceBevor(g: Ctx, _p: Pose, j: Joints): void {
  head(g, j, () => {
    poly(g, [[-5.8, 4], [11.8, 3], [11.4, 7.6], [6.6, 11.2], [-4.6, 11.6], [-6.6, 8.4]], STEEL.base, 1);
    poly(g, [[4, 3.4], [11.8, 3], [11.4, 7.6], [6.6, 11.2], [2.8, 11.4]], STEEL.lo, 0);
    line(g, [-4.6, 4.8], [11, 3.9], 0.8, STEEL.hi); // the lit top edge
    for (const x of [5.6, 7.8, 10]) circle(g, x, 6.4, 0.55, STEEL.deep, 0); // breaths
    poly(g, [[-2, -3.6], [13.2, -3.2], [12.4, -1], [-2, -1.6]], STEEL.lo, 0.9); // visor brim over the brow
  });
}

/** Rogue: a knotted waist sash whose two tails stream out behind — motion in the silhouette, and it reads as "light and quick". */
function daggerSash(g: Ctx, p: Pose, j: Joints): void {
  torso(g, j, () => {
    const sw = p.capeSway * 0.7;
    poly(g, [[-5.4, -2.6], [-4.6, -0.2], [-10 + sw * 0.8, 8.6 + sw * 0.2], [-12 + sw * 0.8, 7.4 + sw * 0.2]], G.base, 1);
    poly(g, [[-5.4, -3.6], [-4, -1], [-12.6 + sw, 4.6 + sw * 0.25], [-14.2 + sw, 2.6 + sw * 0.25]], G.hi, 1);
    circle(g, -5.4, -2.6, 1.8, G.hi, 0.9); // the knot
  });
}

/** Ranger: a short hooded MANTLE over the shoulders with a leaf-cut edge (the Rogue's jerkin has none). */
function bowMantle(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    poly(g, [[-8.8, -16.8], [7.4, -16.8], [8.6, -12.2], [6, -10.6], [4.6, -12], [2.2, -9.6], [0, -11.4], [-2.4, -9.2], [-4.6, -11], [-7, -9.4], [-9.6, -11.8]], G.lo, 1);
    line(g, [-8, -15.6], [6.6, -15.6], 0.8, G.base); // the lit top edge
    ellipse(g, -6.4, -17.4, 4.4, 2.8, G.deep, 1); // the hood, thrown back
  });
}

/** Mage: a tall flared COLLAR standing up behind the head — the sorcerer's line, which the Cleric's robe does not have. */
function staffCollar(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    poly(g, [[-2.4, -14.4], [-7.6, -16.4], [-13.6, -25.6], [-10.2, -24.8], [-9.6, -27.4], [-6.4, -21.4], [-3.2, -18.4]], G.base, 1); // the flare
    poly(g, [[-7.4, -17.4], [-12.4, -24.8], [-10.2, -24.8], [-6.4, -20.6]], G.lo, 0);
    line(g, [-8.8, -18.8], [-12.6, -24.6], 0.6, G.hi);
    rrect(g, -6.8, -17.2, 13, 2.6, 1, G.base, 1); // the band round the neck
    circle(g, 3.2, -15.9, 1.1, ARCANE.base, 0.6); // a clasp stone
  });
}

/** Cleric: a white AMICE (hooded collar) edged in gold over the shoulders — the vestment that makes the robe a priest's. */
function tomeAmice(g: Ctx, _p: Pose, j: Joints): void {
  torso(g, j, () => {
    poly(g, [[-9.4, -17], [8.2, -17], [9.4, -12.4], [4.6, -9.2], [0, -7.6], [-4.6, -9.2], [-10, -12.4]], WHITE, 1);
    poly(g, [[2.4, -16.8], [8.2, -17], [9.4, -12.4], [4.6, -9.2], [1.6, -8.4]], "#cfd3df", 0);
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1.2;
    path(g, [[8.8, -12.2], [4.4, -9.8], [0, -8.4], [-4.4, -9.8], [-9.4, -12.2]]);
    g.stroke();
    ellipse(g, -7.6, -17.6, 4, 2.6, "#e4e6ee", 1); // the hood, at the back of the neck
  });
}

// ======================================================================================
// VARIANTS — a second drawing of each class item (same size, same grip, same muzzle, same crest anchors), chosen per hero from its stored look
// (see `variantOf`): two Warriors no longer carry the identical sword under the identical helm
// ======================================================================================

function swordB(g: Ctx, _p: Pose, j: Joints): void {
  // a broadsword with a clipped point, down-swept iron quillons and a disc pommel
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1.1, -0.6, 2.2, 5, 0.8, LEATHER.base, 0.8);
    ellipse(g, 0, 5.4, 2, 1.4, STEEL.base, 0.8);
    poly(g, [[-2.4, -2], [2.4, -2], [2.8, -19.6], [0.4, -23.6], [-2.4, -21]], STEEL.base, 1);
    poly(g, [[0.2, -2], [2.4, -2], [2.8, -19.6], [0.4, -23.6]], STEEL.lo, 0);
    line(g, [-0.9, -3.4], [-0.9, -19.4], 0.8, STEEL.hi);
    poly(g, [[-6, 0], [-5, -3.4], [5, -3.4], [6, 0], [4.4, -1.6], [-4.4, -1.6]], STEEL.deep, 0.9);
    circle(g, 0, -2.6, 1.2, GOLD.base, 0.6);
  });
}

function maceB(g: Ctx, _p: Pose, j: Joints): void {
  // a morning star: a spiked iron ball on a dark haft
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1.2, -14, 2.4, 19, 0.9, WOOD.lo, 0.8);
    rrect(g, -1.4, -2, 2.8, 5, 0.8, LEATHER.lo, 0.7);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      poly(g, [[Math.cos(a - 0.42) * 3.4, -17.4 + Math.sin(a - 0.42) * 3.4], [Math.cos(a) * 6.6, -17.4 + Math.sin(a) * 6.6], [Math.cos(a + 0.42) * 3.4, -17.4 + Math.sin(a + 0.42) * 3.4]], STEEL.lo, 0.7);
    }
    circle(g, 0, -17.4, 4.2, STEEL.deep, 1);
    circle(g, -1.3, -18.8, 1.3, STEEL.base, 0);
    rrect(g, -2.4, -13.2, 4.8, 1.6, 0.5, STEEL.lo, 0.7);
  });
}

function staffB(g: Ctx, p: Pose, j: Joints): void {
  // a dark crook-staff whose curled head cradles an orb
  inWeaponSpace(g, j.handF, j, () => {
    g.translate(0, STAFF_GRIP);
    rrect(g, -1.1, -19, 2.2, 28, 0.9, WOOD.lo, 0.8);
    line(g, [-0.4, -18], [-0.4, 7], 0.6, WOOD.base);
    for (const y of [-2.6, -0.6]) rrect(g, -1.6, y, 3.2, 1.2, 0.5, GOLD.lo, 0.6);
    g.lineCap = "round";
    g.strokeStyle = OL;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, -24, 3.4, Math.PI * 0.62, Math.PI * 2.3);
    g.stroke();
    g.strokeStyle = WOOD.lo;
    g.lineWidth = 1.5;
    g.stroke();
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.25 + p.glow * 0.35;
      circle(g, 0, -24, 3.6 + p.glow * 3, ARCANE.hi, 0);
      g.restore();
    }
    circle(g, 0, -24, 2.3, p.glow > 0.5 ? ARCANE.hi : ARCANE.base, 1);
    circle(g, -0.8, -24.8, 0.8, ARCANE.hi, 0);
  });
}

function tomeB(g: Ctx, p: Pose, j: Joints): void {
  // the holy kit with a STAR scepter: a four-pointed star inside a gold ring
  tomeAtHip(g, j);
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1, -15, 2, 19, 0.8, "#e9dcb8", 0.8);
    rrect(g, -1.3, -2, 2.6, 4.4, 0.6, GOLD.lo, 0.7);
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.22 + p.glow * 0.38;
      circle(g, 0, -18.4, 4.4 + p.glow * 3.2, HOLY.hi, 0);
      g.restore();
    }
    g.strokeStyle = OL;
    g.lineWidth = 2.8;
    g.beginPath();
    g.arc(0, -18.4, 4.2, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1.3;
    g.stroke();
    poly(g, [[0, -24.6], [1.3, -19.7], [6, -18.4], [1.3, -17.1], [0, -12.4], [-1.3, -17.1], [-6, -18.4], [-1.3, -19.7]], p.glow > 0.5 ? HOLY.hi : HOLY.base, 0.8);
    circle(g, 0, -18.4, 1.1, WHITE, 0);
  });
}

function daggersB(g: Ctx, _p: Pose, j: Joints): void {
  // straight parrying daggers with a gilt crossguard
  const blade = (): void => {
    rrect(g, -0.9, -0.4, 1.8, 3.6, 0.5, LEATHER.base, 0.6);
    circle(g, 0, 3.6, 1, STEEL.lo, 0.5);
    poly(g, [[-1.3, -1.4], [1.3, -1.4], [0.9, -10.4], [0, -12.6], [-0.9, -10.4]], STEEL.base, 0.9);
    line(g, [-0.3, -2.4], [-0.2, -10.6], 0.6, STEEL.hi);
    rrect(g, -3.4, -2.2, 6.8, 1.4, 0.5, GOLD.lo, 0.6);
  };
  inWeaponSpace(g, j.handB, j, blade, Math.PI - 0.4);
  inWeaponSpace(g, j.handF, j, blade);
}

function bowB(g: Ctx, p: Pose, j: Joints): void {
  // a LONGBOW: one deep, even curve of pale yew with a wrapped grip
  bowWith(g, p, j, () => {
    g.strokeStyle = OL;
    g.lineWidth = 3.4;
    g.beginPath();
    g.moveTo(-1.6, -17.4);
    g.quadraticCurveTo(10.6, 0, -1.6, 17.4);
    g.stroke();
    g.strokeStyle = "#c8a46a";
    g.lineWidth = 1.8;
    g.stroke();
    g.strokeStyle = "#ead2a0";
    g.lineWidth = 0.6;
    g.beginPath();
    g.moveTo(1.6, -9);
    g.quadraticCurveTo(7.2, 0, 1.6, 9);
    g.stroke();
    rrect(g, 2.4, -2.6, 3.2, 5.2, 0.8, "#7a3a2a", 0.7);
  });
}

function helmB(g: Ctx, _p: Pose, j: Joints): void {
  // a KETTLE HAT over a mail coif: a round steel crown, a wide sloping brim, mail over the back of the head and the neck
  head(g, j, () => {
    poly(g, [[-10.8, -1.4], [-4.6, -1.4], [-4.4, 4.4], [-5.8, 10], [-10.8, 9.2], [-11.6, 3]], STEEL.lo, 1); // the coif
    for (const y of [1, 3.6, 6.2]) line(g, [-10.6, y], [-5, y], 0.55, STEEL.deep);
    g.beginPath();
    g.arc(0, -1.8, 9.6, Math.PI, Math.PI * 2);
    g.closePath();
    g.fillStyle = STEEL.base;
    g.fill();
    g.save();
    g.clip();
    g.fillStyle = STEEL.lo;
    g.beginPath();
    g.rect(-12, -14, 24, 14);
    g.arc(-2.6, -3.8, 9.4, 0, Math.PI * 2, true);
    g.fill("evenodd");
    g.restore();
    g.beginPath();
    g.arc(0, -1.8, 9.6, Math.PI, Math.PI * 2);
    g.closePath();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    g.strokeStyle = STEEL.hi;
    g.lineWidth = 1.1;
    g.beginPath();
    g.arc(0, -1.8, 7.6, Math.PI * 1.15, Math.PI * 1.45);
    g.stroke();
    poly(g, [[-14.6, -0.4], [-11, -4.4], [11.4, -4.4], [15, -0.4], [12.6, 0.2], [-12.4, 0.2]], STEEL.lo, 1); // the brim
    line(g, [-11, -3.6], [11.4, -3.6], 0.7, STEEL.hi);
    rrect(g, -9.4, -5.6, 18.8, 1.6, 0.6, GOLD.base, 0.8); // band
    rrect(g, -1.4, -12.6, 2.8, 2.4, 0.8, GOLD.base, 0.8); // the plume socket (the crest anchor)
  });
}

function hatB(g: Ctx, _p: Pose, j: Joints): void {
  // a straight tall cone with a crescent badge
  head(g, j, () => {
    poly(g, [[-8, -6.8], [-0.8, -23.2], [1.4, -22.8], [8.4, -6.8]], G.base, 1);
    poly(g, [[0.4, -23], [1.4, -22.8], [8.4, -6.8], [3.6, -6.8]], G.lo, 0);
    poly(g, [[-8.6, -7.6], [8.8, -7.6], [8.8, -4.8], [-8.6, -4.8]], G.deep, 1);
    ellipse(g, 0, -5.2, 13.8, 2.8, G.base, 1);
    line(g, [-4.6, -9.6], [-1.2, -18.6], 0.9, G.hi);
    circle(g, 2, -12.4, 2.3, G.hi, 0.8);
    circle(g, 3, -13, 1.8, G.base, 0);
  });
}

function hoodB(g: Ctx, _p: Pose, j: Joints): void {
  // a wrapped cowl with a long tail (liripipe) falling down the back, the mask drawn up to the nose
  head(g, j, () => {
    poly(g, [[-9.4, -6], [-13.6, 2], [-14.8, 12.6], [-11.2, 13.4], [-9.6, 4]], G.lo, 1); // the tail
    g.beginPath();
    g.arc(-0.6, -0.4, 12, 0, Math.PI * 2);
    g.arc(3, 2.2, 8.2, 0, Math.PI * 2, true);
    g.fillStyle = G.base;
    g.fill("evenodd");
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(-0.6, -0.4, 12, 0, Math.PI * 2);
    g.stroke();
    g.save();
    g.globalAlpha = 0.45;
    g.beginPath();
    g.arc(3, 2.2, 8.2, Math.PI * 1.05, Math.PI * 1.95);
    g.lineTo(11, 0.4);
    g.lineTo(-5, 0.4);
    g.closePath();
    g.fillStyle = "#121018";
    g.fill();
    g.restore();
    line(g, [-9, -6.4], [2.4, -11.2], 0.8, G.hi); // a fold of light across the crown
    poly(g, [[-3.6, 3], [10.8, 2.4], [10.4, 8.8], [3, 10.6], [-3.4, 9]], G.lo, 1); // the mask, up to the nose
    line(g, [-2.6, 4.6], [9.8, 4.2], 0.7, G.deep);
    line(g, [-2.6, 7.2], [9.4, 6.8], 0.6, G.deep);
    ellipse(g, -1.4, 11.4, 9.6, 3.2, G.lo, 1); // mantle
  });
}

function capB(g: Ctx, p: Pose, j: Joints): void {
  // a broad-brimmed traveller's hat, the brim tipped down at the front
  head(g, j, () => {
    const sw = p.capeSway * 0.2;
    g.beginPath();
    g.ellipse(-0.6, -6.8, 8.2, 6.6, 0, Math.PI, Math.PI * 2);
    g.closePath();
    g.fillStyle = G.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    poly(g, [[1.2, -13], [5.6, -11.4], [7.6, -6.8], [2.4, -6.8]], G.lo, 0);
    rrect(g, -8.6, -8.2, 16.4, 2.2, 0.8, G.deep, 0.9); // band
    poly(g, [[-15.4 + sw, -5.4], [-8, -7.2], [8, -7.2], [16, -3.2], [14.6, -1.8], [6.4, -4.6], [-8, -4.6], [-14.8 + sw, -3.6]], G.lo, 1); // the brim
    line(g, [-13.6, -5.2], [13.6, -4.4], 0.6, G.hi);
  });
}

function haloB(g: Ctx, _p: Pose, j: Joints): void {
  // a gold LAUREL at the brow and a smaller halo set higher
  head(g, j, () => {
    rrect(g, -10.4, -4.4, 20.8, 1.8, 0.8, GOLD.lo, 0.8);
    for (let i = 0; i < 6; i++) {
      const x = -9 + i * 3.2;
      poly(g, [[x, -3.6], [x + 1.2, -6.6], [x + 2.6, -4.2]], i % 2 ? GOLD.base : GOLD.hi, 0.6);
    }
    g.strokeStyle = OL;
    g.lineWidth = 3.2;
    g.beginPath();
    g.ellipse(-0.4, -16.6, 7, 2.4, -0.08, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = GOLD.hi;
    g.lineWidth = 1.6;
    g.stroke();
  });
}

// ======================================================================================
// Auras (tint: rarity) — SUBTLE: a few motes at the feet, never a ring around the body
// ======================================================================================

const AX = ANCHOR_X;
const AY = FEET_Y - 1;

export const AURAS: AuraSpec[] = [
  {
    // a few slow motes circling low at the feet (the shape of "Rare")
    id: "aura.ring",
    draw: (g, f, n) => {
      for (let i = 0; i < 3; i++) {
        const t = ((f / n + i / 3) % 1) * Math.PI * 2;
        const x = AX + Math.cos(t) * 12;
        const y = AY - 1 + Math.sin(t) * 2.4;
        if (Math.sin(t) < -0.4) continue; // behind the feet
        circle(g, x, y, 0.9, G.hi, 0);
      }
    },
  },
  {
    // tiny sparks lifting off the floor (the shape of "Epic")
    id: "aura.sparks",
    draw: (g, f, n) => {
      for (let i = 0; i < 4; i++) {
        const k = (f / n + i / 4) % 1;
        const x = AX - 9 + i * 6 + Math.sin((k + i) * 6) * 1.2;
        const y = AY - 1 - k * 9;
        if (k > 0.85) continue;
        poly(g, [[x, y - 1.4], [x + 0.9, y], [x, y + 1.4], [x - 0.9, y]], G.hi, 0);
      }
    },
  },
  {
    // a low lick of embers at the feet (the shape of "Legendary")
    id: "aura.flame",
    draw: (g, f, n) => {
      for (let i = 0; i < 5; i++) {
        const k = (f / n + i * 0.37) % 1;
        const x = AX - 8 + i * 4;
        const h = 2.4 + Math.sin((k + i) * Math.PI * 2) * 1.1;
        g.beginPath();
        g.moveTo(x - 1.2, AY);
        g.quadraticCurveTo(x, AY - h * 0.6, x + 0.3, AY - h);
        g.quadraticCurveTo(x + 0.8, AY - h * 0.5, x + 1.2, AY);
        g.closePath();
        g.fillStyle = i % 2 ? G.hi : G.base;
        g.fill();
      }
    },
  },
];

// ======================================================================================
// Registry — the same ids as v1, plus the quiver (a part of the bow)
// ======================================================================================

const outfitLayers = (style: OutfitStyle): LayerSpec[] => [
  { id: `outfit.${style}`, family: "outfits", z: 20, tint: "primary", draw: outfitMain(style) },
  { id: `outfit.${style}.trim`, of: `outfit.${style}`, family: "outfits", z: 22, tint: "secondary", draw: outfitTrim(style) },
  { id: `outfit.${style}.front`, of: `outfit.${style}`, family: "outfits", z: 66, tint: "primary", draw: outfitFront(style) },
];

export const LAYERS: LayerSpec[] = [
  { id: "body.base", family: "body", z: 10, tint: "skin", draw: bodyBase },
  { id: "body.arm", of: "body.base", family: "body", z: 64, tint: "skin", draw: bodyArm },
  ...(["medium", "robe", "light", "heavy"] as const).flatMap(outfitLayers),
  { id: "outfit.medium.mail", of: "outfit.medium", family: "outfits", z: 19, tint: null, draw: mediumMail },
  ...[0, 1, 2, 3].map((i): LayerSpec => ({ id: `eyes.${i}`, family: "face", z: 30, tint: null, draw: eyes(i) })),
  ...[0, 1, 2].map((i): LayerSpec => ({ id: `mouth.${i}`, family: "face", z: 31, tint: null, draw: mouth(i) })),
  ...[0, 1, 2, 3, 4, 5, 6].map((i): LayerSpec => ({ id: `hair.${i}`, family: "hair", z: 40, tint: "hair", draw: hair(i) })),
  { id: "hair.2.back", of: "hair.2", family: "hair", z: 8, tint: "hair", draw: hairBackLong },
  { id: "headgear.helm", family: "headgear", z: 60, tint: null, variants: ["headgear.helm.b"], draw: helm },
  { id: "headgear.hat", family: "headgear", z: 60, tint: "primary", variants: ["headgear.hat.b"], draw: hat },
  { id: "headgear.hood", family: "headgear", z: 60, tint: "primary", variants: ["headgear.hood.b"], draw: hood },
  { id: "headgear.cap", family: "headgear", z: 60, tint: "primary", variants: ["headgear.cap.b"], draw: cap },
  { id: "headgear.cap.feather", of: "headgear.cap", family: "headgear", z: 61, tint: null, draw: capFeather },
  { id: "headgear.halo", family: "headgear", z: 60, tint: null, variants: ["headgear.halo.b"], draw: halo },
  { id: "headgear.helm.b", family: "headgear", z: 60, tint: null, draw: helmB },
  { id: "headgear.hat.b", family: "headgear", z: 60, tint: "primary", draw: hatB },
  { id: "headgear.hood.b", family: "headgear", z: 60, tint: "primary", draw: hoodB },
  { id: "headgear.cap.b", family: "headgear", z: 60, tint: "primary", draw: capB },
  { id: "headgear.halo.b", family: "headgear", z: 60, tint: null, draw: haloB },
  { id: "headgear.crown", family: "headgear", z: 60, tint: null, draw: crown },
  { id: "accessory.goggles", family: "extras", z: 50, tint: null, draw: goggles },
  { id: "accessory.scarf", family: "extras", z: 24, tint: "accent", draw: scarf },
  { id: "accessory.cog-pin", family: "extras", z: 25, tint: null, draw: cogPin },
  { id: "accessory.monocle", family: "extras", z: 50, tint: null, draw: monocle },
  { id: "accessory.headset", family: "extras", z: 50, tint: null, draw: headset },
  // The cape wears the class's DARK accent (deep red, deep violet, deep teal …) — rarity shows on the gear, and a Legendary is not a sheet of gold.
  { id: "cape.default", family: "extras", z: 5, tint: "accent", draw: cape },
  { id: "offhand.shield", family: "extras", z: 65, tint: null, draw: shield },
  { id: "weapon.sword", family: "weapons", z: 70, tint: null, attack: "attack_slash", variants: ["weapon.sword.b"], draw: sword },
  { id: "weapon.mace", family: "weapons", z: 70, tint: null, attack: "attack_slash", variants: ["weapon.mace.b"], draw: mace },
  { id: "weapon.staff", family: "weapons", z: 70, tint: null, attack: "attack_thrust", muzzle: (j) => weaponPoint(j, 0, -24 + STAFF_GRIP), variants: ["weapon.staff.b"], draw: staff },
  { id: "weapon.tome", family: "weapons", z: 70, tint: null, attack: "attack_thrust", muzzle: (j) => weaponPoint(j, 0, -18.4), variants: ["weapon.tome.b"], draw: tome },
  { id: "weapon.daggers", family: "weapons", z: 70, tint: null, attack: "attack_thrust", variants: ["weapon.daggers.b"], draw: daggers },
  { id: "weapon.bow", family: "weapons", z: 70, tint: null, attack: "attack_shoot", muzzle: (j) => weaponPoint(j, 3, 0), variants: ["weapon.bow.b"], draw: bow },
  { id: "weapon.bow.quiver", of: "weapon.bow", family: "weapons", z: 6, tint: null, draw: quiver },
  // variants: same clip, same muzzle
  { id: "weapon.sword.b", family: "weapons", z: 70, tint: null, attack: "attack_slash", draw: swordB },
  { id: "weapon.mace.b", family: "weapons", z: 70, tint: null, attack: "attack_slash", draw: maceB },
  { id: "weapon.staff.b", family: "weapons", z: 70, tint: null, attack: "attack_thrust", muzzle: (j) => weaponPoint(j, 0, -24 + STAFF_GRIP), draw: staffB },
  { id: "weapon.tome.b", family: "weapons", z: 70, tint: null, attack: "attack_thrust", muzzle: (j) => weaponPoint(j, 0, -18.4), draw: tomeB },
  { id: "weapon.daggers.b", family: "weapons", z: 70, tint: null, attack: "attack_thrust", draw: daggersB },
  { id: "weapon.bow.b", family: "weapons", z: 70, tint: null, attack: "attack_shoot", muzzle: (j) => weaponPoint(j, 3, 0), draw: bowB },
  // class kits (parts of the class weapon: every variant wears them)
  { id: "weapon.sword.scabbard", of: "weapon.sword", family: "weapons", z: 7, tint: null, draw: swordScabbard },
  { id: "weapon.mace.bevor", of: "weapon.mace", family: "weapons", z: 61, tint: null, draw: maceBevor },
  { id: "weapon.daggers.sash", of: "weapon.daggers", family: "weapons", z: 9, tint: "accent", draw: daggerSash },
  { id: "weapon.bow.mantle", of: "weapon.bow", family: "weapons", z: 21, tint: "primary", draw: bowMantle },
  { id: "weapon.staff.collar", of: "weapon.staff", family: "weapons", z: 24, tint: "secondary", draw: staffCollar },
  { id: "weapon.tome.amice", of: "weapon.tome", family: "weapons", z: 24, tint: null, draw: tomeAmice },
];
