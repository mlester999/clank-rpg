import type { AttackClip, TintRole } from "../../src/domain/sprites/spec";

import { circle, ellipse, G, line, local, OL, path, poly, rrect, shadedDisc, tube, type Ctx, type Pt } from "./pen";
import type { Joints, Pose } from "./rig";

/**
 * Every drawable layer of the DEV sprite set. Each draws from the shared Pose + Joints (see
 * rig.ts), so they all line up frame for frame. Tintable layers are authored in neutral grey
 * (mid-grey = the tint colour); the rest use real colours.
 */

export interface LayerSpec {
  id: string;
  /** Marks this layer as a part of another catalogue item (rendered with it). */
  of?: string;
  family: "body" | "outfits" | "face" | "hair" | "headgear" | "extras" | "weapons" | "rarity";
  z: number;
  tint: TintRole | null;
  attack?: AttackClip;
  draw: (g: Ctx, p: Pose, j: Joints) => void;
}

export interface AuraSpec {
  id: string;
  draw: (g: Ctx, frame: number, frames: number) => void;
}

const DARK = "#1c1c26";
const WHITE = "#f4f4f8";
const STEEL = { hi: "#eef3fa", base: "#b9c3d3", lo: "#7d8aa0" };
const WOOD = { base: "#8a6a40", lo: "#5e4528" };
const GOLD = { hi: "#ffe08a", base: "#e0a43a", lo: "#9a6a1c" };

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const torso = (g: Ctx, j: Joints, fn: () => void) => local(g, j.hip, j.torsoAngle, fn);
export const head = (g: Ctx, j: Joints, fn: () => void) => local(g, j.head, j.headAngle, fn);

// ======================================================================================
// Body (tint: skin)
// ======================================================================================

function bodyBase(g: Ctx, p: Pose, j: Joints): void {
  tube(g, [j.shoulderB, j.elbowB, j.handB], 3.2, G.lo);
  circle(g, j.handB[0], j.handB[1], 1.9, G.lo);
  tube(g, [j.hipB, j.footB], 4, G.lo);
  tube(g, [j.hipF, j.footF], 4, G.base);
  torso(g, j, () => {
    poly(g, [[-2.6, -17.5], [2.6, -17.5], [3, -12], [-3, -12]], G.base, 1);
  });
  head(g, j, () => {
    circle(g, 9.2, 3.2, 1.3, G.base, 0.8); // nose
    circle(g, -8.4, 1.8, 2.1, G.lo, 0.9); // ear
    shadedDisc(g, 0, 0, 9.6, G.base, G.lo, G.hi);
  });
  void p;
}

function bodyArm(g: Ctx, p: Pose, j: Joints): void {
  tube(g, [j.shoulderF, j.elbowF, j.handF], 3.2, G.base);
  circle(g, j.handF[0], j.handF[1], 1.9, G.base);
  void p;
}

// ======================================================================================
// Outfits (tint: primary main + front sleeve, secondary trim)
// ======================================================================================

type OutfitStyle = "medium" | "robe" | "light" | "heavy";

function boot(g: Ctx, foot: Pt, big: boolean): void {
  const w = big ? 4.4 : 3.6;
  ellipse(g, foot[0] + 1.1, foot[1] - 1.1, w, big ? 2.9 : 2.4, G.base, 1);
}

function outfitMain(style: OutfitStyle) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    const legW = style === "heavy" ? 5.6 : style === "light" ? 4.2 : 4.8;
    if (style !== "robe") {
      tube(g, [j.hipB, lerp(j.hipB, j.footB, 0.66)], legW, G.deep);
      tube(g, [j.hipF, lerp(j.hipF, j.footF, 0.66)], legW, G.lo);
    }
    torso(g, j, () => {
      if (style === "robe") {
        const sw = p.capeSway * 0.35;
        poly(g, [[-6.6, -15.4], [6.6, -15.4], [7.6, -5], [10.6 + sw, 9.5], [-10.6 + sw * 0.6, 9.5], [-7.6, -5]], G.base, 1);
        poly(g, [[3, -15], [6.6, -15.4], [7.6, -5], [10.6 + sw, 9.5], [4 + sw * 0.4, 9.5]], G.lo, 0);
        path(g, [[-6.6, -15.4], [6.6, -15.4], [7.6, -5], [10.6 + sw, 9.5], [-10.6 + sw * 0.6, 9.5], [-7.6, -5]]);
        g.strokeStyle = OL;
        g.lineWidth = 1;
        g.stroke();
      } else if (style === "heavy") {
        rrect(g, -9, -15.6, 18, 17.4, 3.5, G.lo, 1);
        rrect(g, -6.8, -14.2, 13.6, 10.5, 2.4, G.hi, 1); // chest plate
        g.strokeStyle = G.base;
        g.lineWidth = 0.9;
        g.beginPath();
        g.moveTo(0, -14);
        g.lineTo(0, -4);
        g.stroke();
        poly(g, [[-3, -15.6], [3, -15.6], [0, -12.6]], G.deep, 0);
      } else if (style === "light") {
        rrect(g, -6.2, -15.2, 12.4, 16.2, 2.6, G.base, 1);
        poly(g, [[-6, 1], [6, 1], [4.4, 6], [-4.4, 6]], G.lo, 1); // tabard flap
        poly(g, [[-2.6, -15.2], [2.6, -15.2], [0, -12]], G.deep, 0);
      } else {
        rrect(g, -7.2, -15.4, 14.4, 17, 2.6, G.base, 1);
        rrect(g, 3.6, -15, 3.4, 16, 1.2, G.lo, 0);
        poly(g, [[-2.8, -15.4], [2.8, -15.4], [0, -11.8]], G.deep, 0);
      }
    });
    if (style === "heavy") {
      circle(g, j.shoulderB[0], j.shoulderB[1] - 0.6, 4.3, G.lo, 1); // back pauldron
    }
  };
}

function outfitTrim(style: OutfitStyle) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    void p;
    if (style !== "robe") {
      boot(g, j.footB, style === "heavy");
      boot(g, j.footF, style === "heavy");
    } else {
      ellipse(g, j.footB[0] + 1, j.footB[1] - 1, 3, 2, G.base, 1);
      ellipse(g, j.footF[0] + 1, j.footF[1] - 1, 3, 2, G.base, 1);
    }
    torso(g, j, () => {
      if (style === "robe") {
        poly(g, [[-10.8, 6.8], [10.8, 6.8], [10.6, 9.6], [-10.6, 9.6]], G.hi, 1); // hem band
        rrect(g, -7.4, -5.4, 14.8, 2.8, 1, G.hi, 1); // sash
        poly(g, [[-6.6, -15.4], [6.6, -15.4], [5.4, -13.2], [-5.4, -13.2]], G.hi, 1); // collar
      } else if (style === "heavy") {
        rrect(g, -9.2, -3.8, 18.4, 3, 1, G.hi, 1);
        rect(g, -1.6, -4.4, 3.2, 4.2);
      } else if (style === "light") {
        poly(g, [[-6, -14.6], [-2, -15.2], [6.2, -2], [2.6, -1.2]], G.hi, 1); // cross strap
        rrect(g, -6.6, -3.4, 13.2, 2.4, 1, G.lo, 1);
        rrect(g, 3.4, -2.2, 3.6, 4.2, 1, G.hi, 1); // pouch
      } else {
        rrect(g, -7.4, -4.2, 14.8, 2.8, 1, G.hi, 1);
        rect(g, -1.4, -4.6, 2.8, 3.6);
      }
    });
    if (style === "heavy") {
      circle(g, lerp(j.hipF, j.footF, 0.55)[0], lerp(j.hipF, j.footF, 0.55)[1], 2.6, G.hi, 1); // knee plates
      circle(g, lerp(j.hipB, j.footB, 0.55)[0], lerp(j.hipB, j.footB, 0.55)[1], 2.6, G.base, 1);
    }

    function rect(gg: Ctx, x: number, y: number, w: number, h: number): void {
      rrect(gg, x, y, w, h, 0.6, G.base, 0.8);
    }
  };
}

function outfitFront(style: OutfitStyle) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    void p;
    const w = style === "robe" ? 5.8 : style === "heavy" ? 4.8 : 4.5;
    tube(g, [j.shoulderF, lerp(j.elbowF, j.handF, style === "robe" ? 0.45 : 0.15)], w, G.base);
    if (style === "heavy") circle(g, j.shoulderF[0], j.shoulderF[1] - 0.6, 4.6, G.base, 1); // front pauldron
    if (style !== "heavy") {
      const c = lerp(j.elbowF, j.handF, style === "robe" ? 0.45 : 0.15);
      circle(g, c[0], c[1], style === "robe" ? 3 : 2.4, G.hi, 1); // cuff
    }
  };
}

// ======================================================================================
// Face (real colours): eyes + mouth, in head-local space
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
        g.lineWidth = 1;
        if (p.eyes === "dead") {
          g.beginPath();
          g.moveTo(x - 1.5, y - 1.5); g.lineTo(x + 1.5, y + 1.5);
          g.moveTo(x + 1.5, y - 1.5); g.lineTo(x - 1.5, y + 1.5);
          g.stroke();
        } else if (p.eyes === "hurt") {
          g.beginPath();
          g.moveTo(x - 1.6, y - 1.4); g.lineTo(x + 0.2, y + 0.2); g.lineTo(x - 1.6, y + 1.6);
          g.stroke();
        } else if (p.eyes === "cheer") {
          g.beginPath();
          g.arc(x, y + 1.2, 1.7, Math.PI * 1.1, Math.PI * 1.9);
          g.stroke();
        } else if (style === 0) {
          g.beginPath();
          g.ellipse(x, y, 1.15, 1.75, 0, 0, Math.PI * 2);
          g.fill();
        } else if (style === 1) {
          ellipse(g, x, y, 1.75, 2.2, WHITE, 0.8, DARK);
          circle(g, x + 0.5, y + 0.4, 1, DARK, 0);
        } else if (style === 2) {
          g.beginPath();
          g.arc(x, y - 0.8, 1.8, Math.PI * 0.15, Math.PI * 0.85);
          g.stroke();
        } else {
          g.beginPath();
          g.moveTo(x - 1.8, y - 0.9); g.lineTo(x + 1.8, y + 0.4);
          g.stroke();
          g.beginPath();
          g.arc(x + 0.5, y + 0.9, 0.8, 0, Math.PI * 2);
          g.fill();
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
      g.lineWidth = 1;
      g.lineCap = "round";
      const x = 1.8;
      const y = 6.2;
      if (p.mouth === "shout") ellipse(g, x, y + 0.3, 1.8, 1.9, DARK, 0.5, DARK);
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
// Hair (tint: hair) — head-local
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
    g.lineWidth = 0.9;
    g.beginPath();
    g.arc(x, y, r, Math.PI * 1.15, Math.PI * 1.55);
    g.stroke();
  };
  switch (style) {
    case 0: // crop
      g.beginPath();
      g.arc(0, 0, 10.7, Math.PI * 1.02, Math.PI * 1.98);
      g.bezierCurveTo(8.4, -4.2, 3.4, -3.6, 0.4, -5);
      g.bezierCurveTo(-3.4, -6.4, -8, -3.2, -10.5, -0.6);
      g.closePath();
      done();
      sheen(0, 0, 8.6);
      break;
    case 1: // spiky
      path(g, [[-10.4, 0], [-10, -6.8], [-6.4, -4.4], [-5.6, -12.4], [-2, -7.2], [1.4, -14.2], [3.2, -7.6], [7.4, -12], [7.4, -5.6], [10.4, -7.2], [10.4, 0], [6, -4.4], [0, -5.6], [-6, -4.4]]);
      done();
      break;
    case 2: // long (front part; the back part is its own layer)
      g.beginPath();
      g.arc(0, 0, 10.8, Math.PI * 1.0, Math.PI * 2.0);
      g.bezierCurveTo(8.6, -4.6, 3, -3.4, -0.4, -5.2);
      g.bezierCurveTo(-4, -6.4, -8.4, -3.4, -10.8, 0);
      g.closePath();
      done();
      sheen(0, 0, 8.8);
      break;
    case 3: // mohawk
      path(g, [[-3, -7.8], [-3.6, -14], [-0.2, -11.4], [2.4, -15.6], [3.4, -8.4], [3.6, -4], [-3, -4]]);
      done();
      break;
    case 4: // bun
      g.beginPath();
      g.arc(0, 0, 10.6, Math.PI * 1.04, Math.PI * 1.96);
      g.bezierCurveTo(7.6, -3.8, 3, -3.4, 0, -4.6);
      g.bezierCurveTo(-3, -5.6, -7, -3.2, -10.2, -1);
      g.closePath();
      done();
      circle(g, -1, -13, 3.9, G.base, 1);
      sheen(-1, -13, 2.6);
      break;
    case 5: // curly
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
    case 6: // swoop
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

function hair(style: number) {
  return (g: Ctx, p: Pose, j: Joints): void => head(g, j, () => hairShape(g, style, p.capeSway));
}

/** Long hair hanging behind the head and shoulders (own layer so it sits behind the body). */
function hairBackLong(g: Ctx, p: Pose, j: Joints): void {
  head(g, j, () => {
    const sw = p.capeSway * 0.3;
    poly(g, [[-9.8, -3], [-3, -8], [3, -8], [8, -3], [9.4 + sw * 0.5, 9], [4 + sw, 16], [-4 + sw, 16.4], [-10 + sw * 0.8, 10]], G.lo, 1);
  });
}

// ======================================================================================
// Headgear — head-local
// ======================================================================================

function helm(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    g.beginPath();
    g.arc(0, 0.6, 11.4, Math.PI, Math.PI * 2);
    g.lineTo(11.4, 1.6);
    g.lineTo(-11.4, 1.6);
    g.closePath();
    g.fillStyle = G.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    rrect(g, -9, -3.2, 18, 2.6, 1, G.deep, 0.8); // visor slit
    poly(g, [[-1.8, -11.8], [0, -17.4], [1.8, -11.8]], G.hi, 1); // crest
    g.strokeStyle = G.hi;
    g.lineWidth = 0.9;
    g.beginPath();
    g.arc(0, 0.6, 9.2, Math.PI * 1.15, Math.PI * 1.45);
    g.stroke();
    rrect(g, 8.4, -1, 3.2, 9, 1.2, G.lo, 1); // cheek guard
  });
}

function hat(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    poly(g, [[-8.4, -6.6], [-2.4, -16.6], [4.6, -19.6], [2.6, -12.4], [8.6, -6.6]], G.base, 1); // cone
    poly(g, [[-8.6, -7], [8.8, -7], [8.8, -4.6], [-8.6, -4.6]], G.deep, 1); // band
    ellipse(g, 0, -5.6, 13.6, 3, G.base, 1); // brim
    g.strokeStyle = G.hi;
    g.lineWidth = 0.9;
    g.beginPath();
    g.moveTo(-5, -9);
    g.lineTo(0.6, -15);
    g.stroke();
  });
}

function hood(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    g.beginPath();
    g.arc(-0.6, -0.4, 12, 0, Math.PI * 2);
    g.arc(2.8, 2, 8.6, 0, Math.PI * 2, true);
    g.fillStyle = G.base;
    g.fill("evenodd");
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.beginPath();
    g.arc(-0.6, -0.4, 12, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(2.8, 2, 8.6, Math.PI * 0.55, Math.PI * 1.75);
    g.stroke();
    poly(g, [[-6, -11], [-1, -15.4], [3, -11.4]], G.base, 1); // peak
    ellipse(g, -1, 10.6, 9, 3, G.lo, 1); // mantle
  });
}

function cap(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    g.beginPath();
    g.arc(0, 0.2, 10.8, Math.PI * 1.02, Math.PI * 1.98);
    g.lineTo(10.4, -3.4);
    g.quadraticCurveTo(0, -5.6, -10.4, -3.4);
    g.closePath();
    g.fillStyle = G.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    poly(g, [[6, -6.4], [15.4, -4.2], [14.8, -2.2], [5.4, -3.6]], G.lo, 1); // brim
    poly(g, [[-3, -10.4], [-8.4, -16], [-3.6, -14.4], [-1, -10]], G.hi, 1); // feather
  });
}

function halo(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    g.save();
    g.globalAlpha = 0.35;
    ellipse(g, 0, -14, 9.6, 3.4, "#fff2b0", 0);
    g.restore();
    g.strokeStyle = OL;
    g.lineWidth = 3.2;
    g.beginPath();
    g.ellipse(0, -14, 8.4, 2.9, 0, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = GOLD.hi;
    g.lineWidth = 1.5;
    g.stroke();
  });
}

function crown(g: Ctx, p: Pose, j: Joints): void {
  void p;
  head(g, j, () => {
    poly(g, [[-8, -7.6], [-8.6, -16], [-4.2, -11.4], [0, -17.4], [4.2, -11.4], [8.6, -16], [8, -7.6]], GOLD.base, 1);
    poly(g, [[-8, -7.6], [8, -7.6], [7.8, -9.4], [-7.8, -9.4]], GOLD.hi, 1);
    circle(g, 0, -12, 1, "#e0455a", 0.6);
  });
}

// ======================================================================================
// Accessories
// ======================================================================================

function goggles(g: Ctx, p: Pose, j: Joints): void {
  void p;
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
    g.strokeStyle = GOLD.base;
    g.lineWidth = 0.9;
    g.beginPath();
    g.arc(-1.4, -6, 3, 0, Math.PI * 2);
    g.arc(5.2, -6, 3, 0, Math.PI * 2);
    g.stroke();
  });
}

function scarf(g: Ctx, p: Pose, j: Joints): void {
  torso(g, j, () => {
    const sw = p.capeSway * 0.5;
    poly(g, [[-6.8, -15.8], [6.8, -15.8], [6.2, -12.2], [-6.2, -12.2]], G.base, 1);
    poly(g, [[-5, -13], [-2, -13], [-8 + sw, -3], [-11 + sw, -4.4]], G.lo, 1);
  });
}

function cogPin(g: Ctx, p: Pose, j: Joints): void {
  void p;
  torso(g, j, () => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 ? 2.2 : 3.2;
      g.lineTo(-3.4 + Math.cos(a) * r, -9.4 + Math.sin(a) * r);
    }
    g.closePath();
    g.fillStyle = GOLD.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 0.8;
    g.stroke();
    circle(g, -3.4, -9.4, 0.9, DARK, 0);
  });
}

function monocle(g: Ctx, p: Pose, j: Joints): void {
  void p;
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

function headset(g: Ctx, p: Pose, j: Joints): void {
  void p;
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
    const k = 1 - p.capeFold * 0.55; // a fallen hero's cape crumples instead of hanging out of frame
    poly(g, [[-5, -14.4], [3, -14.4], [-1 + sw * 0.6, 4 * k], [-4.6 + sw, 12.4 * k], [(-13 + sw * 1.2) * k, 11 * k], [(-10 + sw) * k, 0]], G.base, 1);
    poly(g, [[-5, -14.4], [-8 * k, -4], [(-13 + sw * 1.2) * k, 11 * k], [(-10 + sw) * k, 0]], G.lo, 0);
  });
}

// ======================================================================================
// Weapons (real colours) — drawn from the front hand along the pose's weapon axis
// ======================================================================================

const axisAngle = (j: Joints): number => Math.atan2(j.weaponDir[0], -j.weaponDir[1]);
export const inWeaponSpace = (g: Ctx, at: Pt, j: Joints, fn: () => void, extra = 0) => local(g, at, axisAngle(j) + extra, fn);

function sword(g: Ctx, p: Pose, j: Joints): void {
  void p;
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1, -0.6, 2, 4.6, 0.8, "#6b4a2b", 0.8);
    circle(g, 0, 4.8, 1.3, GOLD.base, 0.8);
    poly(g, [[-1.7, -1.8], [1.7, -1.8], [1.7, -16.2], [0, -20.2], [-1.7, -16.2]], STEEL.base, 1);
    g.strokeStyle = STEEL.hi;
    g.lineWidth = 0.8;
    g.beginPath();
    g.moveTo(0, -3);
    g.lineTo(0, -16);
    g.stroke();
    rrect(g, -4.4, -2.8, 8.8, 2, 0.8, GOLD.base, 0.9);
  });
}

function mace(g: Ctx, p: Pose, j: Joints): void {
  void p;
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1, -13, 2, 17, 0.8, WOOD.base, 0.8);
    circle(g, 0, -14.6, 4.2, STEEL.base, 1);
    for (const [x, y] of [[0, -19.4], [4.8, -14.6], [-4.8, -14.6], [0, -9.8]] as const) circle(g, x, y, 1.1, STEEL.lo, 0.6);
    circle(g, -1.2, -15.8, 1.2, STEEL.hi, 0);
    rrect(g, -3, -9.4, 6, 1.6, 0.6, GOLD.base, 0.7);
  });
}

function staff(g: Ctx, p: Pose, j: Joints): void {
  inWeaponSpace(g, j.handF, j, () => {
    rrect(g, -1, -15, 2, 22, 0.8, WOOD.base, 0.8);
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.28 + p.glow * 0.3;
      circle(g, 0, -18.4, 4.4 + p.glow * 2.4, "#b9a0ff", 0);
      g.restore();
    }
    g.strokeStyle = OL;
    g.lineWidth = 3.2;
    g.beginPath();
    g.arc(0, -18.4, 3.2, Math.PI * 0.75, Math.PI * 2.25);
    g.stroke();
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1.4;
    g.stroke();
    circle(g, 0, -18.4, 2.1, p.glow > 0.5 ? "#d9c8ff" : "#9d7bff", 0.8);
  });
}

function tome(g: Ctx, p: Pose, j: Joints): void {
  inWeaponSpace(g, j.handF, j, () => {
    if (p.glow > 0.05) {
      g.save();
      g.globalAlpha = 0.25 + p.glow * 0.35;
      circle(g, 0, -6, 7 + p.glow * 4, "#fff0a8", 0);
      g.restore();
    }
    rrect(g, -4.6, -11.4, 9.2, 12, 1.2, "#8a4b2a", 1);
    rrect(g, -3.6, -10.4, 7.2, 10, 0.8, "#f0e4c4", 0.7);
    g.strokeStyle = "#b8802e";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, -9);
    g.lineTo(0, -2);
    g.moveTo(-2.2, -6.2);
    g.lineTo(2.2, -6.2);
    g.stroke();
    rrect(g, -4.6, -11.4, 1.6, 12, 0.6, GOLD.base, 0.6);
  });
}

function daggers(g: Ctx, p: Pose, j: Joints): void {
  void p;
  const blade = (): void => {
    rrect(g, -0.9, -0.4, 1.8, 3.2, 0.5, "#6b4a2b", 0.6);
    poly(g, [[-1.4, -1.2], [1.4, -1.2], [1.2, -8.6], [0, -11.2], [-1.2, -8.6]], STEEL.base, 0.9);
    rrect(g, -2.6, -1.9, 5.2, 1.4, 0.5, GOLD.base, 0.6);
  };
  inWeaponSpace(g, j.handB, j, blade, -0.55);
  inWeaponSpace(g, j.handF, j, blade);
}

function bow(g: Ctx, p: Pose, j: Joints): void {
  inWeaponSpace(g, j.handF, j, () => {
    // bow body bulges forward (+x in its own frame = away from the archer)
    g.strokeStyle = OL;
    g.lineWidth = 3.4;
    g.beginPath();
    g.moveTo(0, -14);
    g.quadraticCurveTo(8.4, 0, 0, 14);
    g.stroke();
    g.strokeStyle = WOOD.base;
    g.lineWidth = 1.8;
    g.stroke();
    rrect(g, -0.2, -2.4, 3, 4.8, 0.8, "#6b4a2b", 0.7); // grip
  });
  // string and arrow in world space (the nock follows the drawing hand)
  const th = axisAngle(j);
  const toWorld = (x: number, y: number): Pt => [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
  const tipT = toWorld(0, -14);
  const tipB = toWorld(0, 14);
  const rest = toWorld(-0.4, 0);
  const nock: Pt = [rest[0] + (j.handB[0] - rest[0]) * p.draw, rest[1] + (j.handB[1] - rest[1]) * p.draw];
  g.strokeStyle = "#e9e2d0";
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(tipT[0], tipT[1]);
  g.lineTo(nock[0], nock[1]);
  g.lineTo(tipB[0], tipB[1]);
  g.stroke();
  if (p.draw > 0.25) {
    const head2: Pt = [j.handF[0] + 6, j.handF[1] + (nock[1] - j.handF[1]) * 0.15];
    line(g, nock, head2, 1.2, OL);
    line(g, nock, head2, 0.7, "#e9dcb8");
    poly(g, [[head2[0], head2[1] - 1.6], [head2[0] + 3.2, head2[1]], [head2[0], head2[1] + 1.6]], STEEL.base, 0.7);
    line(g, nock, [nock[0] + 2, nock[1] - 1.4], 0.9, "#e0455a");
  }
}

function shield(g: Ctx, p: Pose, j: Joints): void {
  void p;
  const c: Pt = [j.handB[0] + 3.4, j.handB[1] - 1.2];
  local(g, c, j.torsoAngle * 0.6, () => {
    path(g, [[-5.6, -8.4], [5.6, -8.4], [5.6, 2], [0, 9.6], [-5.6, 2]]);
    g.fillStyle = STEEL.base;
    g.fill();
    g.strokeStyle = OL;
    g.lineWidth = 1;
    g.stroke();
    g.strokeStyle = GOLD.base;
    g.lineWidth = 1;
    path(g, [[-4.4, -7.2], [4.4, -7.2], [4.4, 1.6], [0, 7.8], [-4.4, 1.6]]);
    g.stroke();
    circle(g, 0, -1.4, 2.3, GOLD.base, 0.8);
    circle(g, -0.6, -2, 0.7, GOLD.hi, 0);
  });
}

// ======================================================================================
// Auras (tint: rarity) — loop on their own clock, centred on the feet
// ======================================================================================

const AX = 34;
const AY = 57;

export const AURAS: AuraSpec[] = [
  {
    id: "aura.ring",
    draw: (g, f, n) => {
      const t = (f / n) * Math.PI * 2;
      g.save();
      g.globalAlpha = 0.35;
      ellipse(g, AX, AY, 19 + Math.sin(t) * 1.4, 5.2, G.base, 0);
      g.restore();
      g.strokeStyle = G.hi;
      g.lineWidth = 1.6;
      g.beginPath();
      g.ellipse(AX, AY, 19 + Math.sin(t) * 1.4, 5.2, 0, 0, Math.PI * 2);
      g.stroke();
    },
  },
  {
    id: "aura.sparks",
    draw: (g, f, n) => {
      const t = (f / n) * Math.PI * 2;
      g.strokeStyle = G.base;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(AX, AY, 17, 4.6, 0, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < 6; i++) {
        const a = t + (i * Math.PI * 2) / 6;
        const rise = ((f / n + i / 6) % 1) * 22;
        circle(g, AX + Math.cos(a) * 19, AY - 6 - rise + Math.sin(a * 1.3) * 3, 1.2, G.hi, 0);
      }
    },
  },
  {
    id: "aura.flame",
    draw: (g, f, n) => {
      const t = (f / n) * Math.PI * 2;
      g.strokeStyle = G.base;
      g.lineWidth = 1.4;
      g.beginPath();
      g.ellipse(AX, AY, 20, 5.4, 0, 0, Math.PI * 2);
      g.stroke();
      for (let i = 0; i < 9; i++) {
        const x = AX - 18 + i * 4.5;
        const h = 9 + Math.sin(t * 2 + i * 1.9) * 3.2 + (i % 3) * 2.4;
        const bend = Math.sin(t + i) * 1.6;
        g.beginPath();
        g.moveTo(x - 2, AY - 0.5);
        g.quadraticCurveTo(x + bend, AY - h * 0.6, x + bend * 1.4, AY - h);
        g.quadraticCurveTo(x + 1 + bend, AY - h * 0.5, x + 2, AY - 0.5);
        g.closePath();
        g.fillStyle = i % 2 ? G.hi : G.base;
        g.fill();
      }
    },
  },
];

// ======================================================================================
// Registry
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
  ...[0, 1, 2, 3].map((i): LayerSpec => ({ id: `eyes.${i}`, family: "face", z: 30, tint: null, draw: eyes(i) })),
  ...[0, 1, 2].map((i): LayerSpec => ({ id: `mouth.${i}`, family: "face", z: 31, tint: null, draw: mouth(i) })),
  ...[0, 1, 2, 3, 4, 5, 6].map((i): LayerSpec => ({ id: `hair.${i}`, family: "hair", z: 40, tint: "hair", draw: hair(i) })),
  { id: "hair.2.back", of: "hair.2", family: "hair", z: 8, tint: "hair", draw: hairBackLong },
  { id: "headgear.helm", family: "headgear", z: 60, tint: "secondary", draw: helm },
  { id: "headgear.hat", family: "headgear", z: 60, tint: "primary", draw: hat },
  { id: "headgear.hood", family: "headgear", z: 60, tint: "primary", draw: hood },
  { id: "headgear.cap", family: "headgear", z: 60, tint: "primary", draw: cap },
  { id: "headgear.halo", family: "headgear", z: 60, tint: null, draw: halo },
  { id: "headgear.crown", family: "headgear", z: 60, tint: null, draw: crown },
  { id: "accessory.goggles", family: "extras", z: 50, tint: null, draw: goggles },
  { id: "accessory.scarf", family: "extras", z: 24, tint: "accent", draw: scarf },
  { id: "accessory.cog-pin", family: "extras", z: 25, tint: null, draw: cogPin },
  { id: "accessory.monocle", family: "extras", z: 50, tint: null, draw: monocle },
  { id: "accessory.headset", family: "extras", z: 50, tint: null, draw: headset },
  { id: "cape.default", family: "extras", z: 5, tint: "cape", draw: cape },
  { id: "offhand.shield", family: "extras", z: 65, tint: null, draw: shield },
  { id: "weapon.sword", family: "weapons", z: 70, tint: null, attack: "attack_slash", draw: sword },
  { id: "weapon.mace", family: "weapons", z: 70, tint: null, attack: "attack_slash", draw: mace },
  { id: "weapon.staff", family: "weapons", z: 70, tint: null, attack: "attack_thrust", draw: staff },
  { id: "weapon.tome", family: "weapons", z: 70, tint: null, attack: "attack_thrust", draw: tome },
  { id: "weapon.daggers", family: "weapons", z: 70, tint: null, attack: "attack_thrust", draw: daggers },
  { id: "weapon.bow", family: "weapons", z: 70, tint: null, attack: "attack_shoot", draw: bow },
];

