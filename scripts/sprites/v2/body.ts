import { circle, DARK, ellipse, G, head, limb, hand, lerp, line, M, OL, path, poly, rrect, torso, tube, WHITE, type Ctx, type Joints, type Pose, type Pt } from "./kit";
import type { DesignLayer } from "./library";
import { CLASS_RIGS, type ClassRig } from "./rig";

/**
 * HERO RENDERER v2 — the BODY and the hero's IDENTITY traits (drawn on every skeleton):
 *
 *   body.base          back limbs, front leg, neck (skin) — limb thickness follows the class build
 *   body.base.head     the head SHAPE — five faces (round · square jaw · long · broad · sharp), each with its own nose; chosen per hero from
 *                      the never-rerolled look, like every design choice (the eyes, mouth and hair are the hero's own stored traits)
 *   body.base.beard    facial hair (none · short · full · long · goatee · moustache · braided), hair-tinted, weighted per class
 *   body.arm           the front arm, in front of the outfit
 *   eyes.0–3 · mouth.0–2 · hair.0–6 (+ hair.2.back) · accessories — the stored identity, unchanged in meaning
 */

// ======================================================================================
// Body
// ======================================================================================

function bodyBase(g: Ctx, _p: Pose, j: Joints): void {
  const a = j.b.arm;
  const l = j.b.leg;
  limb(g, j.shoulderB, j.elbowB, j.handB, 3.2 * a, 2.7 * a, G.lo, null);
  hand(g, j.elbowB, j.handB, G.lo);
  limb(g, j.hipB, j.kneeB, j.footB, 4.6 * l, 3.6 * l, G.lo, null);
  limb(g, j.hipF, j.kneeF, j.footF, 4.6 * l, 3.6 * l, G.base, G.hi);
  tube(g, [j.neck, lerp(j.neck, j.head, 0.42)], 3.4 * Math.max(1, a * 0.95), G.lo);
}

function bodyArm(g: Ctx, _p: Pose, j: Joints): void {
  const a = j.b.arm;
  limb(g, j.shoulderF, j.elbowF, j.handF, 3.3 * a, 2.8 * a, G.base, G.hi);
  hand(g, j.elbowF, j.handF, G.base);
}

// ======================================================================================
// Head shapes (head-local, radius 9.6 design space; +x = the face side)
// ======================================================================================

type HeadShape = "round" | "square" | "long" | "broad" | "sharp";

/** The jaw / face outline of each shape (the cranium is shared, so hats and hair fit every head). Eyes sit at y≈1.8, the mouth at y≈6.2. */
function jaw(g: Ctx, s: HeadShape): void {
  switch (s) {
    case "square":
      g.moveTo(-3, 0.4);
      g.lineTo(9.4, -0.4);
      g.quadraticCurveTo(10.6, 5.6, 9.2, 8.4);
      g.quadraticCurveTo(7.2, 10.6, 2.6, 10.4);
      g.quadraticCurveTo(-1.6, 10.2, -3.2, 7.6);
      g.closePath();
      break;
    case "long":
      g.moveTo(-3, 0.4);
      g.lineTo(9, -0.2);
      g.quadraticCurveTo(10, 6.4, 7, 10);
      g.quadraticCurveTo(4.4, 12, 2.2, 11.2);
      g.quadraticCurveTo(-1.4, 9.6, -3, 6.6);
      g.closePath();
      break;
    case "broad":
      g.moveTo(-3.6, 0);
      g.lineTo(10, -0.6);
      g.quadraticCurveTo(11.6, 4.6, 10, 7.8);
      g.quadraticCurveTo(7.6, 10.4, 2.6, 10);
      g.quadraticCurveTo(-2.4, 9.6, -4, 6.4);
      g.closePath();
      break;
    case "sharp":
      g.moveTo(-3, 0.4);
      g.lineTo(9.6, -0.6);
      g.quadraticCurveTo(10.4, 4.4, 8.4, 7.4);
      g.lineTo(4.4, 10.8);
      g.quadraticCurveTo(0.4, 10, -2.8, 6.4);
      g.closePath();
      break;
    default:
      g.moveTo(9.8, 4);
      g.ellipse(3.2, 4, 6.6, 5.6, 0.1, 0, Math.PI * 2);
  }
}

function nose(g: Ctx, s: HeadShape): void {
  switch (s) {
    case "square":
      poly(g, [[9.4, 1], [11.4, 3.6], [11.2, 4.4], [9.4, 4.4]], G.base, 0.8);
      break;
    case "long":
      poly(g, [[9.2, 0.6], [11.8, 4.2], [9.4, 4.4]], G.base, 0.8);
      break;
    case "broad":
      poly(g, [[9.8, 1.6], [11.6, 3.4], [11.2, 4.6], [9.6, 4.6]], G.base, 0.8);
      circle(g, 10.2, 4, 0.6, G.lo, 0);
      break;
    case "sharp":
      poly(g, [[9.6, 0.4], [11.8, 3.2], [9.8, 3.6]], G.base, 0.8);
      break;
    default:
      poly(g, [[9.9, 1.4], [11.2, 3.4], [9.7, 4]], G.base, 0.8);
  }
}

function headOf(s: HeadShape) {
  return (g: Ctx, _p: Pose, j: Joints): void => {
    head(g, j, () => {
      // A ROUND cranium + the shape's jaw (three-quarter view), outline-first so the two merge into one clean edge. Lit from above and in front:
      // the crown and the forehead catch the light; the jaw and the back of the head are in shadow.
      const shape = () => {
        g.beginPath();
        g.ellipse(-0.6, -1.4, s === "broad" ? 9.8 : 9.4, s === "long" ? 9.6 : 9.2, 0, 0, Math.PI * 2);
        jaw(g, s);
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
      g.fillStyle = G.lo;
      g.beginPath();
      g.rect(-14, -14, 28, 28);
      g.arc(1.8, -1.8, 9.6, 0, Math.PI * 2, true);
      g.fill("evenodd");
      g.fillStyle = G.hi;
      g.beginPath();
      g.ellipse(2.2, -5.8, 4.6, 2.4, -0.25, 0, Math.PI * 2);
      g.fill();
      if (s === "square" || s === "broad") {
        // a heavier jaw line in shadow
        g.fillStyle = G.lo;
        g.beginPath();
        g.ellipse(4, 10.2, 6, 1.6, 0, 0, Math.PI * 2);
        g.fill();
      }
      if (s === "sharp") {
        // a lit cheekbone
        g.fillStyle = G.hi;
        g.globalAlpha = 0.7;
        g.beginPath();
        g.ellipse(7.2, 3.6, 1.6, 0.8, -0.5, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      ellipse(g, -4.4, 2.2, 1.7, 2.3, G.base, 0.8); // the ear
      circle(g, -4.2, 2.4, 0.7, G.lo, 0);
      nose(g, s);
    });
  };
}

// ======================================================================================
// Facial hair (tint: hair) — z 29, under the eyes and the mouth (an open mouth reads through it)
// ======================================================================================

type Beard = "short" | "full" | "long" | "goatee" | "moustache" | "braided";

function beardOf(kind: Beard) {
  return (g: Ctx, p: Pose, j: Joints): void => {
    head(g, j, () => {
      const sw = p.capeSway * 0.25;
      const mous = () => {
        // a moustache: two sweeps from under the nose, over the corners of the mouth
        poly(g, [[0.4, 5.6], [3, 4.4], [5.6, 4.6], [6.4, 5.6], [4.6, 5.4], [3, 5.6], [1.6, 6.4]], G.base, 0.8);
      };
      switch (kind) {
        case "moustache":
          mous();
          break;
        case "goatee":
          poly(g, [[0.4, 7.6], [3.4, 7.4], [3.8, 10.6], [2.2, 12.4], [0.6, 10.4]], G.base, 0.9);
          mous();
          break;
        case "short":
          // along the jaw from the ear to the chin, the mouth left open
          poly(g, [[-3.4, 2.6], [-2, 7.4], [1, 10.6], [4.6, 11], [8.4, 9.4], [9.8, 6.6], [7.6, 7.6], [5.4, 8.2], [1.8, 8.4], [-0.6, 6.4], [-1.4, 2.8]], G.base, 0.9);
          line(g, [0.4, 9.6], [5, 9.8], 0.6, G.lo);
          mous();
          break;
        case "full":
          poly(g, [[-3.6, 1.8], [-2.8, 8], [0.2, 12.6], [3.8, 14 + sw * 0.2], [7.8, 12.4], [10.2, 8.4], [10, 5.8], [7.6, 7.4], [5.4, 8], [1.8, 8.2], [-0.6, 6], [-1.6, 2.2]], G.base, 0.9);
          poly(g, [[0.4, 10.4], [3.6, 13.2 + sw * 0.2], [6.6, 11.6], [3.8, 11.2]], G.lo, 0);
          line(g, [-1.6, 4], [0.4, 9.8], 0.5, G.hi);
          mous();
          break;
        case "long":
          // a long pointed beard down the chest — it sways
          poly(g, [[-3.4, 2], [-2.4, 8.4], [0.6, 14], [2.6 + sw, 21.4], [4.2 + sw, 22.6], [6.2 + sw * 0.6, 16.6], [9.4, 10], [10, 6], [7.6, 7.4], [5.4, 8], [1.8, 8.2], [-0.6, 6], [-1.6, 2.2]], G.base, 0.9);
          line(g, [3 + sw * 0.4, 10.6], [3.4 + sw, 19.6], 0.6, G.lo);
          line(g, [0.6, 9.4], [1.8 + sw * 0.6, 16], 0.5, G.hi);
          mous();
          break;
        case "braided":
          poly(g, [[-3.6, 1.8], [-2.8, 8], [0.6, 11.8], [7.8, 11.6], [10.2, 8.2], [10, 5.8], [7.6, 7.4], [5.4, 8], [1.8, 8.2], [-0.6, 6], [-1.6, 2.2]], G.base, 0.9);
          for (const x of [1.4, 5.6]) {
            for (let k = 0; k < 3; k++) ellipse(g, x + sw * (0.2 + k * 0.15), 12.6 + k * 2.2, 1.4, 1.2, k % 2 ? G.lo : G.base, 0.7);
            rrect(g, x - 0.9 + sw * 0.6, 18.2, 1.8, 1.2, 0.4, M.gold.base, 0.6);
          }
          mous();
          break;
      }
    });
  };
}

// ======================================================================================
// Face (real colours), head-local — the stored eye / mouth styles
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
          g.beginPath();
          g.moveTo(x - 1.9, y - 0.4); g.lineTo(x + 1.9, y + 0.3);
          g.stroke();
          line(g, [x - 2, y - 2.6], [x + 1.8, y - 1.6], 1, DARK);
        } else if (style === 0) {
          g.beginPath();
          g.ellipse(x, y, 1.25, 1.85, 0, 0, Math.PI * 2);
          g.fill();
          circle(g, x + 0.4, y - 0.7, 0.45, WHITE, 0);
          line(g, [x - 1.7, y - 3.1], [x + 1.6, y - 3.4], 0.9, DARK);
        } else if (style === 1) {
          ellipse(g, x, y, 1.45, 1.95, WHITE, 0.7, DARK);
          circle(g, x + 0.45, y + 0.35, 1, DARK, 0);
          line(g, [x - 1.6, y - 3.4], [x + 1.4, y - 3.9], 0.9, DARK);
        } else if (style === 2) {
          g.beginPath();
          g.arc(x, y - 0.8, 1.9, Math.PI * 0.15, Math.PI * 0.85);
          g.stroke();
          line(g, [x - 1.6, y - 3.2], [x + 1.4, y - 3.2], 0.8, DARK);
        } else {
          g.beginPath();
          g.moveTo(x - 1.9, y - 1); g.lineTo(x + 1.9, y + 0.4);
          g.stroke();
          g.beginPath();
          g.arc(x + 0.5, y + 0.9, 0.85, 0, Math.PI * 2);
          g.fill();
          line(g, [x - 1.8, y - 3.6], [x + 1.6, y - 2.6], 1, DARK);
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
// Hair (tint: hair) — head-local, the stored styles
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
      path(g, [[-10.4, 0], [-10 + sway * 0.1, -6.8], [-6.4, -4.4], [-5.6 + sway * 0.1, -12.4], [-2, -7.2], [1.4, -14.2], [3.2, -7.6], [7.4, -12], [7.4, -5.6], [10.4, -7.2], [10.4, 0], [6, -4.4], [0, -5.6], [-6, -4.4]]);
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
      path(g, [[-3, -7.8], [-3.6 + sway * 0.15, -14], [-0.2, -11.4], [2.4 + sway * 0.1, -15.6], [3.4, -8.4], [3.6, -4], [-3, -4]]);
      done();
      break;
    case 4:
      g.beginPath();
      g.arc(0, 0, 10.6, Math.PI * 1.04, Math.PI * 1.96);
      g.bezierCurveTo(7.6, -3.8, 3, -3.4, 0, -4.6);
      g.bezierCurveTo(-3, -5.6, -7, -3.2, -10.2, -1);
      g.closePath();
      done();
      circle(g, -1 + sway * 0.05, -13, 3.9, G.base, 1);
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
    const sw = p.capeSway * 0.35;
    poly(g, [[-9.8, -3], [-3, -8], [3, -8], [8, -3], [9.4 + sw * 0.5, 9], [4 + sw, 17], [-4 + sw, 17.4], [-10 + sw * 0.8, 10]], G.lo, 1);
    line(g, [-6 + sw * 0.6, 4], [-4 + sw, 15.4], 0.6, G.base);
  });
}

// ======================================================================================
// Accessories (identity) — rig-agnostic
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
    g.fillStyle = M.gold.base;
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
    g.strokeStyle = M.gold.base;
    g.lineWidth = 1;
    g.stroke();
    line(g, [7.2, 3.4], [8.6, 10.4], 0.8, M.gold.hi);
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
// Registry
// ======================================================================================

const HEADS: HeadShape[] = ["square", "long", "broad", "sharp"];

/** Facial-hair pools: a variant drawn only on the listed classes' skeletons, so a class has its own odds (a Mage often has a long beard, a Rogue rarely). */
const BEARDS: Array<{ kind: Beard; rigs: readonly ClassRig[]; weight: number }> = [
  { kind: "short", rigs: ["warrior", "tank", "ranger", "cleric", "rogue"], weight: 3 },
  { kind: "full", rigs: ["warrior", "tank", "cleric"], weight: 3 },
  { kind: "braided", rigs: ["warrior", "tank"], weight: 2 },
  { kind: "long", rigs: ["mage", "cleric"], weight: 4 },
  { kind: "goatee", rigs: ["rogue", "mage", "ranger"], weight: 3 },
  { kind: "moustache", rigs: ["warrior", "rogue", "ranger", "mage", "tank"], weight: 2 },
];

export const BODY_LAYERS: DesignLayer[] = [
  { id: "body.base", z: 10, tint: "skin", draw: bodyBase },
  { id: "body.arm", of: "body.base", z: 64, tint: "skin", draw: bodyArm },
  // the head shape: the round head is the item's own drawing, four more are its variants
  { id: "body.base.head", of: "body.base", z: 11, tint: "skin", variants: HEADS.map((s) => `body.head.${s}`), draw: headOf("round") },
  ...HEADS.map((s): DesignLayer => ({ id: `body.head.${s}`, z: 11, tint: "skin", draw: headOf(s) })),
  // facial hair: the item draws nothing (clean-shaven is the most common look); its variants are the beards
  { id: "body.base.beard", of: "body.base", z: 29, tint: "hair", empty: true, weight: 8, variants: BEARDS.map((b) => `body.beard.${b.kind}`), draw: () => undefined },
  ...BEARDS.map((b): DesignLayer => ({ id: `body.beard.${b.kind}`, z: 29, tint: "hair", rigs: b.rigs.flatMap((c) => CLASS_RIGS[c]), weight: b.weight, draw: beardOf(b.kind) })),
  ...[0, 1, 2, 3].map((i): DesignLayer => ({ id: `eyes.${i}`, z: 30, tint: null, draw: eyes(i) })),
  ...[0, 1, 2].map((i): DesignLayer => ({ id: `mouth.${i}`, z: 31, tint: null, draw: mouth(i) })),
  ...[0, 1, 2, 3, 4, 5, 6].map((i): DesignLayer => ({ id: `hair.${i}`, z: 40, tint: "hair", draw: hair(i) })),
  { id: "hair.2.back", of: "hair.2", z: 8, tint: "hair", draw: hairBackLong },
  { id: "accessory.goggles", z: 50, tint: null, draw: goggles },
  { id: "accessory.scarf", z: 24, tint: "accent", draw: scarf },
  { id: "accessory.cog-pin", z: 25, tint: null, draw: cogPin },
  { id: "accessory.monocle", z: 50, tint: null, draw: monocle },
  { id: "accessory.headset", z: 50, tint: null, draw: headset },
];
