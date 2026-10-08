import { axisAngle, cord, ellipse, gem, inWeaponSpace, line, lit, local, M, OL, poly, rrect, sparkle, sub, torso, weaponPoint, weaponScale, type Ctx, type Joints, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — BOWS and QUIVERS. A bow is carried UPRIGHT at the side at rest (its string never slashes across the body) and raised along
 * the arm to shoot; the string runs from both tips to the drawing hand, and an arrow is nocked while drawn (`draw` of the pose). Shapes carry the
 * tier: a plain flatbow or recurve at Common, a longbow and a horn composite at Rare, a great bow and a reflex bow with ears at Epic, an elven
 * leaf bow, a sun bow or a dragon-bone bow at Legendary.
 */

export type BowShape = "recurve" | "long" | "flat" | "composite" | "elven" | "great" | "reflex";

export interface BowSpec {
  shape: BowShape;
  mat: Ramp;
  grip?: Ramp;
  /** Tip caps / nocks. */
  tips?: Ramp;
  string?: string;
  deco?: "none" | "feathers" | "leaves" | "gems" | "runes" | "fins" | "wrap";
  decoMat?: Ramp;
  /** Fletching colour and arrowhead of the nocked arrow. */
  fletch?: string;
  head?: Ramp;
  size?: number;
}

/** How far a resting bow is turned upright from the weapon axis (0 while drawn or raised). */
export const bowCarry = (p: Pose): number => (p.draw === 0 && p.weaponAngle < 2.95 ? -(Math.PI - 0.06 - p.weaponAngle) : 0);

/** Limb centre line (sub-path) and the two string tips. */
function limbPath(s: BowSpec): { build: (g: Ctx) => void; tips: [Pt, Pt]; width: number } {
  const k = s.size ?? 1;
  switch (s.shape) {
    case "long":
      return {
        build: (g) => {
          g.moveTo(-1.6, -19.4 * k);
          g.quadraticCurveTo(10.4 * k, 0, -1.6, 19.4 * k);
        },
        tips: [[-1.6, -19.4 * k], [-1.6, 19.4 * k]],
        width: 1.9,
      };
    case "great":
      return {
        build: (g) => {
          g.moveTo(-2.4, -20.4 * k);
          g.quadraticCurveTo(1.6, -16 * k, 3, -10 * k);
          g.quadraticCurveTo(8.6 * k, 0, 3, 10 * k);
          g.quadraticCurveTo(1.6, 16 * k, -2.4, 20.4 * k);
        },
        tips: [[-2.4, -20.4 * k], [-2.4, 20.4 * k]],
        width: 2.5,
      };
    case "flat":
      return {
        build: (g) => {
          g.moveTo(-1.6, -15.4 * k);
          g.quadraticCurveTo(4.6 * k, -9 * k, 3.4, 0);
          g.quadraticCurveTo(4.6 * k, 9 * k, -1.6, 15.4 * k);
        },
        tips: [[-1.6, -15.4 * k], [-1.6, 15.4 * k]],
        width: 2.4,
      };
    case "composite":
    case "reflex":
      return {
        build: (g) => {
          const ear = s.shape === "reflex" ? 3.6 : 2.4;
          g.moveTo(-ear, -17.4 * k);
          g.lineTo(-0.6, -15.4 * k);
          g.quadraticCurveTo(2.6, -12 * k, 3, -7.6 * k);
          g.quadraticCurveTo(6.4 * k, 0, 3, 7.6 * k);
          g.quadraticCurveTo(2.6, 12 * k, -0.6, 15.4 * k);
          g.lineTo(-ear, 17.4 * k);
        },
        tips: [[-(s.shape === "reflex" ? 3.6 : 2.4), -17.4 * k], [-(s.shape === "reflex" ? 3.6 : 2.4), 17.4 * k]],
        width: 2.1,
      };
    case "elven":
      return {
        build: (g) => {
          g.moveTo(-0.4, -19 * k);
          g.bezierCurveTo(-3, -14 * k, 6.6 * k, -9 * k, 3.4, 0);
          g.bezierCurveTo(6.6 * k, 9 * k, -3, 14 * k, -0.4, 19 * k);
        },
        tips: [[-0.4, -19 * k], [-0.4, 19 * k]],
        width: 1.8,
      };
    default:
      return {
        build: (g) => {
          g.moveTo(-1.6, -17.4 * k);
          g.quadraticCurveTo(1.4, -15.4 * k, 2, -11 * k);
          g.quadraticCurveTo(7.4 * k, 0, 2, 11 * k);
          g.quadraticCurveTo(1.4, 15.4 * k, -1.6, 17.4 * k);
        },
        tips: [[-1.6, -17.4 * k], [-1.6, 17.4 * k]],
        width: 2,
      };
  }
}

function decoDraw(g: Ctx, s: BowSpec, tips: [Pt, Pt]): void {
  const d = s.decoMat ?? M.gold;
  switch (s.deco) {
    case "feathers":
      for (const [x, y] of tips) for (const dy of [2.4, 4.4]) poly(g, [[x + 0.6, y + Math.sign(-y) * dy], [x - 3.4, y + Math.sign(-y) * (dy + 1.6)], [x - 0.6, y + Math.sign(-y) * (dy - 0.4)]], d.base, 0.6);
      break;
    case "leaves":
      for (const [x, y] of tips) {
        ellipse(g, x - 1.6, y + Math.sign(-y) * 2.6, 2.4, 1, d.base, 0.6, OL, Math.sign(-y) * 0.8);
        ellipse(g, x - 0.6, y + Math.sign(-y) * 5.4, 2, 0.9, d.lo, 0.6, OL, Math.sign(-y) * 0.5);
      }
      break;
    case "gems":
      gem(g, 4.4, -6.6, 1.2, d);
      gem(g, 4.4, 6.6, 1.2, d);
      break;
    case "runes":
      for (const y of [-12, -8, 8, 12]) poly(g, [[2.6, y - 1], [3.6, y], [2.6, y + 1], [1.8, y]], d.base, 0.5);
      break;
    case "fins":
      for (const [x, y] of tips) poly(g, [[x, y], [x - 3.6, y + Math.sign(-y) * 1.6], [x - 0.6, y + Math.sign(-y) * 4.4]], d.base, 0.7);
      break;
    case "wrap":
      for (const y of [-10, -6, 6, 10]) line(g, [1.6, y], [4.2, y + 0.8], 0.8, d.base);
      break;
    default:
      break;
  }
}

/** The bow, its string and (while drawn) the nocked arrow. */
function bowDraw(g: Ctx, p: Pose, j: Joints, s0: BowSpec): void {
  // the archetype's bow: a warden's longbow is nearly as tall as the hero, a skirmisher's shortbow a forearm's length
  const s: BowSpec = weaponScale(j).len === 1 ? s0 : { ...s0, size: (s0.size ?? 1) * weaponScale(j).len };
  const carry = bowCarry(p);
  const lp = limbPath(s);
  // a long bow carried at the side is gripped low (its lower tip clears the ground); raised to shoot, the hand is at its grip
  const lift = carry !== 0 ? Math.max(0, Math.abs(lp.tips[1][1]) - 15) : 0;
  inWeaponSpace(g, j.handF, j, () => {
    g.translate(0, -lift);
    cord(g, () => {
      g.beginPath();
      lp.build(g);
    }, lp.width, s.mat.base, 1.6);
    g.save();
    g.beginPath();
    lp.build(g);
    g.translate(0.7, 0);
    g.strokeStyle = s.mat.hi;
    g.lineWidth = 0.6;
    g.stroke();
    g.restore();
    if (s.tips) for (const [x, y] of lp.tips) ellipse(g, x, y, 1.1, 1.1, s.tips.base, 0.6);
    decoDraw(g, s, lp.tips);
    rrect(g, 1.2, -2.6, 3.4, 5.2, 0.8, (s.grip ?? M.leather).base, 0.7);
  }, carry);
  const th = axisAngle(j) + carry;
  const toWorld = (x: number, y0: number): Pt => {
    const y = y0 - lift;
    return [j.handF[0] + x * Math.cos(th) - y * Math.sin(th), j.handF[1] + x * Math.sin(th) + y * Math.cos(th)];
  };
  const tipT = toWorld(lp.tips[0][0], lp.tips[0][1]);
  const tipB = toWorld(lp.tips[1][0], lp.tips[1][1]);
  const rest = toWorld(-0.6, lift);
  const nock: Pt = [rest[0] + (j.handB[0] - rest[0]) * p.draw, rest[1] + (j.handB[1] - rest[1]) * p.draw];
  g.strokeStyle = s.string ?? "#ece6d4";
  g.lineWidth = 0.8;
  g.beginPath();
  g.moveTo(tipT[0], tipT[1]);
  g.lineTo(nock[0], nock[1]);
  g.lineTo(tipB[0], tipB[1]);
  g.stroke();
  if (p.draw > 0.25) {
    // the arrow runs from the nock THROUGH the bow hand (aligned with the bow however it is held), its head just past the grip
    const ax = j.handF[0] - nock[0];
    const ay = j.handF[1] - nock[1];
    const al = Math.hypot(ax, ay) || 1;
    const tip: Pt = [j.handF[0] + (ax / al) * 4, j.handF[1] + (ay / al) * 4];
    line(g, nock, tip, 1.3, OL);
    line(g, nock, tip, 0.8, "#e9dcb8");
    const ux = ax / al;
    const uy = ay / al;
    poly(g, [[tip[0] + uy * 1.7, tip[1] - ux * 1.7], [tip[0] + ux * 3.4, tip[1] + uy * 3.4], [tip[0] - uy * 1.7, tip[1] + ux * 1.7]], (s.head ?? M.steel).base, 0.7);
    const f = s.fletch ?? "#e0455a";
    for (const side of [-1, 1]) poly(g, [nock, [nock[0] - ux * 2.6 - uy * 1.6 * side, nock[1] - uy * 2.6 + ux * 1.6 * side], [nock[0] - ux * 1.2, nock[1] - uy * 1.2]], f, 0.5);
  }
}

export function bow(s: BowSpec): Piece[] {
  return [piece(70, s.mat, (g, p, j) => bowDraw(g, p, j, s))];
}

/** Where the arrow leaves on the release frame (frame px). */
export const bowMuzzle = (j: Joints): Pt => weaponPoint(j, 3, 0);

// ------------------------------------------------------------------------------ quivers (z 6: on the back; z 23: at the hip)

export type QuiverStyle = "back" | "hip" | "fur" | "ornate" | "bundle";

export function quiver(style: QuiverStyle, mat: Mat, opts: { fletch?: readonly string[]; trim?: Ramp } = {}): Piece[] {
  const fl = opts.fletch ?? ["#e0455a", "#f4f4f8", "#e0455a"];
  const arrows = (g: Ctx, n = 3) => {
    for (let i = 0; i < n; i++) {
      const x = -1.6 + i * (3.2 / Math.max(1, n - 1));
      line(g, [x, -6], [x, -10.6], 0.8, "#e9dcb8");
      poly(g, [[x - 1.1, -10.6], [x, -13.2], [x + 1.1, -10.6]], fl[i % fl.length] as string, 0.6);
    }
  };
  if (style === "hip") {
    return [piece(23, mat, (g, _p, j, r) => torso(g, j, () => local(g, [-6.8, -1.4], 0.35, () => {
      arrows(g, 3);
      rrect(g, -2.6, -7, 5.2, 11.4, 1.2, r.base, 1);
      rrect(g, -2.6, -7, 5.2, 1.8, 0.6, r.hi, 0.7);
    })))];
  }
  const out: Piece[] = [piece(6, mat, (g, _p, j, r) => torso(g, j, () => local(g, [-4.6, -9], style === "bundle" ? -0.2 : -0.42, () => {
    if (style === "bundle") {
      // a bundle of arrows tied with a cord, no case
      for (let i = 0; i < 5; i++) {
        const x = -2.4 + i * 1.2;
        line(g, [x, 8], [x, -10.6], 0.8, "#c9b48a");
        poly(g, [[x - 0.9, -10.6], [x, -12.8], [x + 0.9, -10.6]], fl[i % fl.length] as string, 0.5);
      }
      rrect(g, -3.2, -2, 6.4, 1.6, 0.5, r.base, 0.7);
      rrect(g, -3.2, 4, 6.4, 1.6, 0.5, r.base, 0.7);
      return;
    }
    arrows(g, style === "ornate" ? 4 : 3);
    lit(g, () => sub(g, [[-3, -7], [3, -7], [3.2, 8.2], [-3.2, 8.4]]), r, { shadow: [1, -0.4] });
    rrect(g, -3.2, -7.4, 6.4, 2, 0.8, r.hi, 0.8);
    line(g, [-1.4, -4.6], [-1.4, 7], 0.7, r.lo);
  })))];
  if (style === "fur") out.push(piece(6, M.fur, (g, _p, j, r) => torso(g, j, () => local(g, [-4.6, -9], -0.42, () => {
    for (let i = 0; i < 4; i++) ellipse(g, -2.4 + i * 1.6, -6.6, 1.4, 1.2, i % 2 ? r.lo : r.base, 0.6);
  }))));
  if (style === "ornate") out.push(piece(6, opts.trim ?? M.gold, (g, _p, j, r) => torso(g, j, () => local(g, [-4.6, -9], -0.42, () => {
    rrect(g, -3.4, -7.6, 6.8, 1.4, 0.5, r.base, 0.7);
    rrect(g, -3.4, 6.6, 6.8, 1.4, 0.5, r.base, 0.7);
    gem(g, 0, 0.4, 1.3, M.emerald);
    sparkle(g, 2, -3, 1.2, r.hi);
  }))));
  return out;
}
