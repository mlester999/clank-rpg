import { circle, ellipse, gem, lerp, line, lit, local, M, poly, rrect, sub, type Ctx, type Joints, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — SHOULDER armour (the near shoulder in front of the arm, z 67; its far twin behind the torso, z 17). A pauldron sits on the
 * upper arm just below the shoulder joint and follows the arm's swing, so it reads on every frame of an attack. Shapes, not ornaments: a
 * leather pad, layered steel lames, a round spaulder, a raised haute-piece, spikes, a fur mantle, a lion's head, a wing.
 */

export type PauldronKind = "pad" | "lames" | "round" | "haute" | "spiked" | "fur" | "lion" | "wing" | "sun" | "mantle" | "scale" | "dragon";

export interface PauldronSpec {
  kind: PauldronKind;
  mat: Mat;
  /** Trim / ornament material (gold rim, a jewel, a fur edge). */
  trim?: Mat;
  size?: number;
}

/** Where a pauldron sits and how it turns: on the upper arm, a little below the shoulder joint, aligned with the upper arm. */
function onArm(g: Ctx, sh: Pt, el: Pt, fn: () => void): void {
  const at = lerp(sh, el, 0.18);
  const a = Math.atan2(el[1] - sh[1], el[0] - sh[0]) - Math.PI / 2;
  local(g, at, a * 0.55, fn);
}

function shape(g: Ctx, kind: PauldronKind, r: Ramp, k: number, p: Pose, back: boolean): void {
  const s = k;
  switch (kind) {
    case "pad":
      lit(g, () => {
        g.ellipse(0, 0.6, 4.2 * s, 3 * s, 0, Math.PI, Math.PI * 2);
        g.lineTo(4 * s, 2.2 * s);
        g.lineTo(-4 * s, 2.2 * s);
        g.closePath();
      }, r, { shadow: [0.8, -0.8] });
      line(g, [-3.4 * s, 1.4 * s], [3.4 * s, 1.4 * s], 0.5, r.lo);
      break;
    case "lames":
      for (let i = 2; i >= 0; i--) {
        const y = -1.6 * s + i * 2 * s;
        const w = (4.2 + i * 0.5) * s;
        lit(g, () => {
          g.ellipse(0, y + 1.2 * s, w, 2 * s, 0, Math.PI, Math.PI * 2);
          g.lineTo(w, y + 2.2 * s);
          g.lineTo(-w, y + 2.2 * s);
          g.closePath();
        }, r, { shadow: [0.6, -0.6] });
      }
      break;
    case "round":
      lit(g, () => g.ellipse(0, 0.4 * s, 4.8 * s, 4 * s, 0, 0, Math.PI * 2), r, { shadow: [1, -1], hi: () => g.ellipse(1.2 * s, -1.4 * s, 1.8 * s, 1 * s, -0.4, 0, Math.PI * 2) });
      line(g, [-4 * s, 2 * s], [4 * s, 2 * s], 0.6, r.lo);
      break;
    case "haute":
      // a big layered pauldron with a raised guard standing up beside the neck
      lit(g, () => sub(g, [[-3 * s, -1.6 * s], [-2 * s, -6.6 * s], [2.6 * s, -5 * s], [2.6 * s, -1.4 * s]]), r, { shadow: [0.6, -0.6] });
      for (let i = 1; i >= 0; i--) {
        const y = i * 2.4 * s;
        lit(g, () => {
          g.ellipse(0, y, (5.4 + i * 0.6) * s, 3 * s, 0, Math.PI, Math.PI * 2);
          g.lineTo((5.4 + i * 0.6) * s, y + 1.6 * s);
          g.lineTo(-(5.4 + i * 0.6) * s, y + 1.6 * s);
          g.closePath();
        }, r, { shadow: [0.8, -0.8] });
      }
      break;
    case "spiked":
      for (const [x, h] of [[-2.6, 6.4], [0.4, 8.4], [3, 5.6]] as const) lit(g, () => sub(g, [[(x - 1.2) * s, -1 * s], [(x - 1.6) * s, -h * s], [(x + 1.2) * s, -1.4 * s]]), r, { shadow: [0.5, -0.5] });
      lit(g, () => {
        g.ellipse(0, 0.6 * s, 5 * s, 3.6 * s, 0, Math.PI, Math.PI * 2);
        g.lineTo(5 * s, 2.4 * s);
        g.lineTo(-5 * s, 2.4 * s);
        g.closePath();
      }, r, { shadow: [0.8, -0.8] });
      break;
    case "fur": {
      const pts: Pt[] = [];
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI * (1 + i / 8);
        const rr = (i % 2 ? 4.6 : 5.6) * s;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.8 + 0.8]);
      }
      pts.push([4.6 * s, 3 * s], [2 * s, 4 * s], [-2 * s, 3.6 * s], [-4.6 * s, 3 * s]);
      lit(g, () => sub(g, pts), r, { shadow: [0.8, -0.8] });
      break;
    }
    case "scale":
      lit(g, () => {
        g.ellipse(0, 0.6 * s, 4.8 * s, 4 * s, 0, Math.PI, Math.PI * 2);
        g.lineTo(4.8 * s, 3 * s);
        g.lineTo(-4.8 * s, 3 * s);
        g.closePath();
      }, r, { shadow: [0.8, -0.8] });
      for (let y = -1.6; y < 3; y += 1.8) for (let x = -3.6 + ((y * 10) % 2); x < 4; x += 2.2) {
        g.beginPath();
        g.arc(x * s, y * s, 1.1 * s, 0, Math.PI);
        g.strokeStyle = r.lo;
        g.lineWidth = 0.5;
        g.stroke();
      }
      break;
    case "lion": {
      // a lion's head pauldron: a maned disc with a muzzle
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        ellipse(g, Math.cos(a) * 4.2 * s, Math.sin(a) * 3.6 * s, 1.9 * s, 1.5 * s, r.lo, 0.7, undefined, a);
      }
      lit(g, () => g.ellipse(0, 0, 3.8 * s, 3.4 * s, 0, 0, Math.PI * 2), r, { shadow: [0.8, -0.8], hi: () => g.ellipse(0.6, -1.2, 1.6, 0.9, 0, 0, Math.PI * 2) });
      poly(g, [[-0.6 * s, 0], [2.4 * s, 0.6 * s], [1 * s, 2.2 * s], [-1 * s, 1.6 * s]], r.lo, 0.6); // muzzle
      circle(g, 0.6 * s, -0.8 * s, 0.5, "#1c1c26", 0);
      break;
    }
    case "wing": {
      const sw = back ? 0 : p.capeSway * 0.12;
      lit(g, () => sub(g, [[-4 * s, 1.6 * s], [-3.4 * s, -2 * s], [-7.4 * s + sw, -8.6 * s], [-4.4 * s + sw, -6.4 * s], [-5.4 * s + sw, -9.6 * s], [-1.8 * s, -5 * s], [-1.4 * s, -7.6 * s], [1.6 * s, -2.4 * s], [4.4 * s, 1.6 * s]]), r, { shadow: [0.8, -0.8] });
      line(g, [-3 * s, -1.2 * s], [-6 * s + sw, -7.6 * s], 0.5, r.hi);
      break;
    }
    case "sun":
      for (let i = 0; i < 7; i++) {
        const a = Math.PI * (1.05 + (i / 6) * 0.9);
        poly(g, [[Math.cos(a - 0.12) * 3.4 * s, Math.sin(a - 0.12) * 3 * s], [Math.cos(a) * 7 * s, Math.sin(a) * 6 * s], [Math.cos(a + 0.12) * 3.4 * s, Math.sin(a + 0.12) * 3 * s]], i % 2 ? r.lo : r.hi, 0.6);
      }
      lit(g, () => {
        g.ellipse(0, 0.6 * s, 4.6 * s, 3.6 * s, 0, Math.PI, Math.PI * 2);
        g.lineTo(4.6 * s, 2.4 * s);
        g.lineTo(-4.6 * s, 2.4 * s);
        g.closePath();
      }, r, { shadow: [0.8, -0.8] });
      break;
    case "dragon":
      for (const [x, h] of [[-3, 4.6], [-0.6, 6.4], [1.8, 4.8]] as const) lit(g, () => sub(g, [[(x + 1.4) * s, -0.6 * s], [(x - 2.2) * s, -h * s], [(x - 0.6) * s, -0.6 * s]]), r, { shadow: [0.5, -0.5] });
      for (let i = 2; i >= 0; i--) {
        const y = -1 * s + i * 1.8 * s;
        lit(g, () => {
          g.ellipse(0, y + 1, (4.4 + i * 0.4) * s, 1.8 * s, 0, Math.PI, Math.PI * 2);
          g.lineTo((4.4 + i * 0.4) * s, y + 2 * s);
          g.lineTo(-(4.4 + i * 0.4) * s, y + 2 * s);
          g.closePath();
        }, r, { shadow: [0.6, -0.6] });
      }
      break;
    case "mantle":
      // a short cloth mantle draped over the shoulder (robes)
      lit(g, () => sub(g, [[-4.6 * s, -1.6 * s], [4.4 * s, -1.6 * s], [5.4 * s, 3.4 * s], [2.6 * s, 2.4 * s], [0.4 * s, 4 * s], [-2 * s, 2.4 * s], [-4.8 * s, 3.4 * s]]), r, { shadow: [0.6, -0.8] });
      break;
  }
}

function trimShape(g: Ctx, kind: PauldronKind, r: Ramp, k: number): void {
  const s = k;
  switch (kind) {
    case "round":
    case "lames":
    case "spiked":
    case "scale":
    case "sun":
    case "dragon":
      g.beginPath();
      g.ellipse(0, 0.6 * s, 4.9 * s, 3.4 * s, 0, Math.PI * 1.05, Math.PI * 1.95);
      g.strokeStyle = "#15151a";
      g.lineWidth = 2;
      g.stroke();
      g.strokeStyle = r.base;
      g.lineWidth = 1;
      g.stroke();
      gem(g, 0.6 * s, -1 * s, 1.1, M.ruby);
      break;
    case "haute":
      rrect(g, -5.4 * s, 0.6 * s, 10.8 * s, 1.2, 0.5, r.base, 0.7);
      line(g, [-2.2 * s, -5.6 * s], [2.2 * s, -4.4 * s], 0.8, r.hi);
      break;
    case "lion":
      gem(g, 0, 2.6 * s, 1, M.ruby);
      break;
    case "fur":
    case "pad":
      rrect(g, -4.2 * s, 1.4 * s, 8.4 * s, 1.4, 0.5, r.base, 0.7);
      circle(g, 0, 2.1 * s, 0.9, r.hi, 0.5);
      break;
    case "wing":
      rrect(g, -4.2 * s, 0.6 * s, 8.6 * s, 1.6, 0.6, r.base, 0.7);
      gem(g, 0, 1.4 * s, 1, M.sapphire);
      break;
    default:
      break;
  }
}

/** The pieces of a pair of pauldrons: near one (z 67) over the arm, far one behind the torso (z 17), trim in its own material. */
export function pauldrons(spec: PauldronSpec): Piece[] {
  const k = spec.size ?? 1;
  const near = (fn: (g: Ctx, r: Ramp, p: Pose) => void) => (g: Ctx, p: Pose, j: Joints, r: Ramp) => onArm(g, j.shoulderF, j.elbowF, () => fn(g, r, p));
  const far = (fn: (g: Ctx, r: Ramp, p: Pose) => void) => (g: Ctx, p: Pose, j: Joints, r: Ramp) => onArm(g, j.shoulderB, j.elbowB, () => fn(g, r, p));
  const out: Piece[] = [
    piece(67, spec.mat, near((g, r, p) => shape(g, spec.kind, r, k, p, false))),
    piece(17, spec.mat, far((g, r, p) => shape(g, spec.kind, { ...r, base: r.lo, hi: r.base }, k * 0.92, p, true))),
  ];
  if (spec.trim) out.push(piece(67, spec.trim, near((g, r) => trimShape(g, spec.kind, r, k))));
  return out;
}
