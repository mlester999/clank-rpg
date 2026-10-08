import { circle, floorLen, gem, line, lit, M, poly, rrect, sub, torso, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";
import { topY } from "./garments";

/**
 * HERO RENDERER v2 — CAPES and cloaks (behind everything, z 5; a collar / clasp in front, z 23). A cape moves: it streams back on the run, flares
 * on a swing and settles in the idle (`capeSway`), and folds when the hero falls (`capeFold`). Cuts: a long cape, a half cape thrown over
 * one shoulder, a tattered war cloak, a split cape, a short mantle cloak, a hooded traveller's cloak, a royal cape with an ermine collar.
 */

export type CapeCut = "long" | "half" | "tattered" | "split" | "short" | "hooded" | "royal" | "feathered" | "scalloped";

export interface CapeSpec {
  cut: CapeCut;
  mat: Mat;
  /** Lining / inner face material (seen as the cape flares). */
  lining?: Mat;
  /** Collar (fur, ermine) and clasp material. */
  collar?: Mat;
  clasp?: Ramp;
  /** An emblem on the cape's back (shown on the trailing edge). */
  emblem?: Mat;
  len?: number;
}

function outline(cut: CapeCut, p: Pose, len: number): Pt[] {
  const sw = p.capeSway;
  const k = 1 - p.capeFold * 0.55;
  const L = len * k;
  switch (cut) {
    case "half":
      return [[-3.6, -15.4], [2.6, -15.4], [-0.6 + sw * 0.5, -2], [-3 + sw, L * 0.8], [(-10.4 + sw * 1.1) * k, L * 0.72], [(-8 + sw) * k, -1]];
    case "tattered":
      return [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 4 * k], [-3.4 + sw, L], [-5.6 + sw, L - 2.6], [-7.4 + sw * 1.1, L + 0.4], [-9 + sw * 1.1, L - 2.2], [(-11.6 + sw * 1.2) * k, L - 0.6], [(-10.4 + sw) * k, 0]];
    case "split":
      return [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 4 * k], [-3.4 + sw, L], [-6.4 + sw, L - 4.6], [(-9 + sw * 1.15) * k, L - 0.4], [(-12.8 + sw * 1.2) * k, L - 1.4], [(-10 + sw) * k, 0]];
    case "short":
      return [[-5.4, -15.6], [3.4, -15.6], [1 + sw * 0.4, -6], [-4 + sw * 0.8, -1.4 * k], [(-10.4 + sw) * k, -2.6 * k], [(-8.4 + sw * 0.6) * k, -10]];
    case "hooded":
      return [[-4.6, -15.4], [3, -15.4], [-1 + sw * 0.6, 4 * k], [-3.4 + sw, L], [(-13 + sw * 1.2) * k, L - 1], [(-10 + sw) * k, 0], [-8, -12]];
    case "feathered": {
      const pts: Pt[] = [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 4 * k]];
      for (let i = 0; i <= 5; i++) {
        const t = i / 5;
        const x = -2.6 - t * 10.4 + sw * (1 + t * 0.2);
        pts.push([x * (i ? k : 1), L - (i % 2 ? 3 : 0) - t * 1.4]);
      }
      pts.push([(-10.6 + sw) * k, 0]);
      return pts;
    }
    case "scalloped": {
      const pts: Pt[] = [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 4 * k]];
      for (let i = 0; i <= 4; i++) pts.push([(-2.6 - i * 2.6 + sw * 1.05) * (i ? k : 1), L - (i % 2) * 1.6]);
      pts.push([(-13 + sw * 1.2) * k, L - 1.4], [(-10 + sw) * k, 0]);
      return pts;
    }
    case "royal":
      return [[-5.4, -15.6], [3.4, -15.6], [-0.6 + sw * 0.6, 5 * k], [-3 + sw, L + 1], [(-14.4 + sw * 1.3) * k, L], [(-11 + sw) * k, 0]];
    default:
      return [[-4.6, -15], [3, -15], [-1 + sw * 0.6, 5 * k], [-4.6 + sw, L], [(-13 + sw * 1.2) * k, L - 1.8], [(-10 + sw) * k, 0]];
  }
}

export function cape(spec: CapeSpec): Piece[] {
  const full = spec.len ?? 14.4;
  const out: Piece[] = [
    piece(5, spec.mat, (g, p, j, r) => torso(g, j, () => {
      const len = Math.min(full, floorLen(j, 2) + 1);
      const pts = outline(spec.cut, p, len);
      lit(g, () => sub(g, pts), r, { shadow: [2.4, 0.6] });
      // folds: a few shadow lines fanning to the hem
      const sw = p.capeSway;
      const k = 1 - p.capeFold * 0.55;
      for (const [x0, x1] of [[-2.6, -5 + sw], [-5, -9.6 + sw * 1.1]] as const) line(g, [x0, -10], [x1 * k, len * k - 2], 0.6, r.lo);
      if (spec.cut === "hooded") {
        // the hood thrown back over the shoulders
        lit(g, () => {
          g.ellipse(-5.6, -16.4, 5, 3.4, -0.2, 0, Math.PI * 2);
        }, r, { shadow: [1, -1] });
      }
    })),
  ];
  if (spec.lining) {
    out.push(piece(5, spec.lining, (g, p, j, r) => torso(g, j, () => {
      const len = Math.min(full, floorLen(j, 2) + 1);
      // the lining shows on the inner (trailing) side as the cape blows back
      const sw = p.capeSway;
      const k = 1 - p.capeFold * 0.55;
      if (sw > -0.6) return;
      poly(g, [[-6, -6], [(-10 + sw) * k, 0], [(-13 + sw * 1.2) * k, len * k - 1.8], [(-9.4 + sw) * k, len * k - 3]], r.base, 0.8);
    })));
  }
  if (spec.emblem) {
    out.push(piece(5, spec.emblem, (g, p, j, r) => torso(g, j, () => {
      const len = Math.min(full, floorLen(j, 2) + 1);
      const sw = p.capeSway;
      const k = 1 - p.capeFold * 0.55;
      const x = (-7.2 + sw * 0.9) * k;
      const y = len * 0.45 * k;
      poly(g, [[x, y - 2.6], [x + 2.2, y], [x, y + 2.6], [x - 2.2, y]], r.base, 0.7);
      circle(g, x, y, 0.8, r.hi, 0);
    })));
  }
  if (spec.collar) {
    out.push(piece(23, spec.collar, (g, _p, j, r) => torso(g, j, () => {
      const top = topY(j);
      const c = j.b.chest;
      if (spec.cut === "royal") {
        // an ermine collar: white fur with black tail spots
        lit(g, () => sub(g, [[-9 * c, top - 1.6], [8 * c, top - 1.6], [8.6 * c, top + 2.6], [4 * c, top + 3.4], [0, top + 2.6], [-4 * c, top + 3.6], [-9.6 * c, top + 2.4]]), r, { shadow: [1, -1] });
        for (const [x, y] of [[-6, 0.8], [-2, 1.4], [2.4, 1], [6, 0.6]] as const) rrect(g, x * c - 0.4, top + y, 0.9, 1.6, 0.3, "#20202a", 0);
      } else {
        rrect(g, -8 * c, top - 1.2, 16 * c, 2.4, 1, r.base, 0.9);
      }
    })));
  }
  if (spec.clasp) {
    const cl = spec.clasp;
    out.push(piece(23, cl, (g, _p, j) => torso(g, j, () => {
      const top = topY(j);
      gem(g, 4.6 * j.b.chest, top + 1.4, 1.5, M.ruby);
      circle(g, -4.6 * j.b.chest, top + 1.4, 1.3, cl.base, 0.7);
    })));
  }
  return out;
}
