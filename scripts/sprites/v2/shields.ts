import { circle, gem, line, lit, local, M, OL, poly, rrect, sub, type Ctx, type Joints, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — SHIELDS (the Tank's off-hand, held forward on the back arm and drawn IN FRONT of the near arm and pauldron, z 68 — the shield is the Tank's silhouette; the weapon, z 70, still shows over it). A shield is its FACE
 * (painted in the class colour, or bare metal / wood), its RIM and BOSS (metal) and an EMBLEM. Shapes carry the tier: a round buckler and a
 * plain heater at Common, a kite and a tower at Rare, a spiked bastion and a pavise at Epic, a lion aegis and a winged bulwark at Legendary.
 */

export type ShieldShape = "round" | "heater" | "kite" | "tower" | "pavise" | "spiked" | "bastion" | "aegis" | "wing" | "oval";
export type ShieldMark = "none" | "boss" | "cross" | "chevron" | "lion" | "sun" | "bands" | "rivets" | "star" | "skull";

export interface ShieldSpec {
  shape: ShieldShape;
  face: Mat;
  rim: Ramp;
  mark?: ShieldMark;
  markMat?: Ramp;
  size?: number;
  /** `fist`: a BUCKLER gripped in the back fist (a duelist's) instead of a shield carried forward on the arm (a Tank's). */
  grip?: "arm" | "fist";
}

function outline(shape: ShieldShape, k: number): Pt[] | null {
  switch (shape) {
    case "heater":
      return [[-6.6 * k, -9 * k], [6.6 * k, -9 * k], [6.6 * k, 0], [0, 10 * k], [-6.6 * k, 0]];
    case "kite":
      return [[-6.4 * k, -9.6 * k], [6.4 * k, -9.6 * k], [6.8 * k, -3 * k], [0, 13 * k], [-6.8 * k, -3 * k]];
    case "tower":
      return [[-6.6 * k, -11.4 * k], [6.6 * k, -11.4 * k], [7 * k, 6.6 * k], [0, 12.6 * k], [-7 * k, 6.6 * k]];
    case "pavise":
      return [[-7 * k, -12 * k], [-2 * k, -13 * k], [2 * k, -13 * k], [7 * k, -12 * k], [7.4 * k, 11.6 * k], [-7.4 * k, 11.6 * k]];
    case "bastion":
      return [[-7.4 * k, -11 * k], [-4.4 * k, -13 * k], [4.4 * k, -13 * k], [7.4 * k, -11 * k], [7.8 * k, 5 * k], [3 * k, 12 * k], [-3 * k, 12 * k], [-7.8 * k, 5 * k]];
    case "aegis":
      return [[-7.6 * k, -10.4 * k], [0, -13.4 * k], [7.6 * k, -10.4 * k], [8 * k, 2 * k], [0, 13 * k], [-8 * k, 2 * k]];
    case "wing":
      return [[-7 * k, -11 * k], [-1 * k, -10 * k], [5 * k, -13.6 * k], [8.4 * k, -6 * k], [7 * k, 4 * k], [0, 13 * k], [-7 * k, 4 * k]];
    default:
      return null;
  }
}

function faceShape(g: Ctx, shape: ShieldShape, k: number): void {
  const pts = outline(shape, k);
  if (pts) sub(g, pts);
  else if (shape === "oval") g.ellipse(0, 0, 6.4 * k, 10.6 * k, 0, 0, Math.PI * 2);
  else g.ellipse(0, 0, 7.6 * k, 7.6 * k, 0, 0, Math.PI * 2);
}

/**
 * The shield's place: carried well FORWARD of the body on the back arm (clear of the near arm and pauldron), turned a little with the torso; a
 * buckler sits on the fist that grips it.
 */
function at(g: Ctx, j: Joints, fn: () => void, grip: ShieldSpec["grip"] = "arm"): void {
  const c: Pt = grip === "fist" ? [j.handB[0] + 1.4, j.handB[1] + 0.2] : [j.handB[0] + 6.2, j.handB[1] + 2.4];
  local(g, c, j.torsoAngle * 0.5, fn);
}

function markDraw(g: Ctx, mark: ShieldMark, r: Ramp, k: number, shape: ShieldShape): void {
  const cy = shape === "heater" || shape === "kite" ? -1.6 * k : 0;
  switch (mark) {
    case "boss":
      circle(g, 0, cy, 2.6 * k, r.base, 0.9);
      circle(g, -0.7, cy - 0.7, 0.9 * k, r.hi, 0);
      break;
    case "cross":
      line(g, [0, -9 * k], [0, 9 * k], 1.4 * k, r.base);
      line(g, [-6 * k, cy - 1], [6 * k, cy - 1], 1.4 * k, r.base);
      break;
    case "chevron":
      poly(g, [[-5.6 * k, cy + 1], [0, cy - 4.6 * k], [5.6 * k, cy + 1], [5.6 * k, cy + 3.6 * k], [0, cy - 2 * k], [-5.6 * k, cy + 3.6 * k]], r.base, 0.8);
      break;
    case "bands":
      for (const y of [-6, 0, 6]) rrect(g, -6.8 * k, y * k - 0.7, 13.6 * k, 1.4, 0.4, r.base, 0.6);
      break;
    case "rivets":
      for (const [x, y] of [[-4.6, -7], [4.6, -7], [-5, 3], [5, 3], [0, 9], [0, -1]] as const) circle(g, x * k, y * k, 0.8, r.hi, 0.4);
      break;
    case "lion": {
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        circle(g, Math.cos(a) * 3.6 * k, cy + Math.sin(a) * 3.6 * k, 1.5 * k, r.lo, 0.5);
      }
      circle(g, 0, cy, 3 * k, r.base, 0.8);
      poly(g, [[-0.4 * k, cy], [2 * k, cy + 0.6 * k], [0.8 * k, cy + 2 * k], [-1 * k, cy + 1.4 * k]], r.lo, 0.5);
      circle(g, 0.4 * k, cy - 0.8 * k, 0.5, "#1c1c26", 0);
      break;
    }
    case "sun":
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        line(g, [Math.cos(a) * 2.6 * k, cy + Math.sin(a) * 2.6 * k], [Math.cos(a) * 5.4 * k, cy + Math.sin(a) * 5.4 * k], 1, i % 2 ? r.lo : r.base);
      }
      circle(g, 0, cy, 2.4 * k, r.hi, 0.8);
      break;
    case "star":
      poly(g, [[0, cy - 5 * k], [1.2 * k, cy - 1.2 * k], [5 * k, cy], [1.2 * k, cy + 1.2 * k], [0, cy + 5 * k], [-1.2 * k, cy + 1.2 * k], [-5 * k, cy], [-1.2 * k, cy - 1.2 * k]], r.base, 0.7);
      break;
    case "skull":
      circle(g, 0, cy - 0.6 * k, 2.8 * k, r.base, 0.8);
      rrect(g, -1.6 * k, cy + 1.4 * k, 3.2 * k, 2 * k, 0.4, r.base, 0.6);
      circle(g, -1 * k, cy - 0.6 * k, 0.7 * k, "#1c1c26", 0);
      circle(g, 1 * k, cy - 0.6 * k, 0.7 * k, "#1c1c26", 0);
      break;
    default:
      break;
  }
}

export function shield(spec: ShieldSpec): Piece[] {
  const k = (spec.size ?? 1) * 1.1;
  const out: Piece[] = [
    // the face
    piece(68, spec.face, (g, _p: Pose, j, r) => at(g, j, () => {
      lit(g, () => faceShape(g, spec.shape, k), r, { shadow: [-2.2, 0.4], hi: () => g.rect(-1, -14 * k, 3.4 * k, 26 * k) });
    }, spec.grip)),
    // rim, spikes, boss, emblem (metal)
    piece(68, spec.rim, (g, _p: Pose, j, r) => at(g, j, () => {
      g.beginPath();
      faceShape(g, spec.shape, k);
      g.strokeStyle = OL;
      g.lineWidth = 2.6;
      g.stroke();
      g.beginPath();
      faceShape(g, spec.shape, k);
      g.strokeStyle = r.base;
      g.lineWidth = 1.3;
      g.stroke();
      if (spec.shape === "spiked" || spec.shape === "bastion") {
        for (const [x, y, dx, dy] of [[0, -8, 0, -4], [-6.4, 0, -4, 0], [6.4, 0, 4, 0], [0, 8, 0, 4]] as const) {
          if (spec.shape === "bastion" && dy === 0) continue;
          poly(g, [[x * k - (dy ? 1.2 : 0), y * k - (dx ? 1.2 : 0)], [(x + dx) * k, (y + dy) * k], [x * k + (dy ? 1.2 : 0), y * k + (dx ? 1.2 : 0)]], r.hi, 0.7);
        }
      }
      if (spec.shape === "wing") {
        for (let i = 0; i < 4; i++) line(g, [(-1 + i * 1.8) * k, (-9.6 - i * 0.6) * k], [(2 + i * 1.4) * k, (-4 - i * 0.4) * k], 0.7, r.lo);
      }
      if (spec.mark && spec.mark !== "none") markDraw(g, spec.mark, spec.markMat ?? r, k, spec.shape);
      if (spec.shape === "aegis") gem(g, 0, 8 * k, 1.4, M.ruby);
    }, spec.grip)),
  ];
  return out;
}
