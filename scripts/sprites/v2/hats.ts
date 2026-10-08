import { circle, cord, ellipse, gem, head, line, lit, M, OL, poly, rrect, sparkle, sub, type Ctx, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — SOFT HEADGEAR (head-local, radius 9.6 design space; +x = the face side): hats (a bent wizard's hat, a witch's wide brim,
 * a tall cone, a turban, a mitre, a ranger's feathered cap, a broad-brimmed hat, a tricorne …), hoods (deep and masked, a cowl with a tail, a
 * horned hood, a leaf-edged ranger hood, a draped veil, a bandana) and holy marks (halo, circlet, laurel, diadem). Built from a crown, a brim and
 * decorations so one builder gives each caster and scout class its own vocabulary.
 */

// ======================================================================================
// Hats
// ======================================================================================

export type Crown = "bent" | "cone" | "tall" | "floppy" | "witch" | "cap" | "tricorne" | "brimmed" | "beret" | "mitre" | "turban" | "pillbox" | "forester" | "stepped";
export type HatBrim = "none" | "narrow" | "wide" | "witch" | "front" | "turned" | "flat";
export type HatDeco = "feather" | "star" | "moon" | "gem" | "rune" | "buckle" | "stars" | "ribbon" | "plume" | "cross" | "sun" | "eye" | "bells";

export interface HatSpec {
  crown: Crown;
  mat: Mat;
  /** Crown height / tip lean multipliers. */
  height?: number;
  lean?: number;
  brim?: HatBrim;
  band?: Mat;
  deco?: Array<{ kind: HatDeco; mat: Mat; z?: number }>;
}

function crownPath(g: Ctx, c: Crown, h: number, lean: number, sw: number): void {
  switch (c) {
    case "bent":
      sub(g, [[-8.4, -6.8], [-4.4, -15.2 * h], [-1.6 + lean * 0.2, -21.2 * h], [7.6 * lean + sw, -23.4 * h], [3.4, -18.6 * h], [4.4, -13.4 * h], [8.8, -6.8]]);
      break;
    case "cone":
      sub(g, [[-8, -6.8], [-0.8 + lean, -23.2 * h], [1.4 + lean, -22.8 * h], [8.4, -6.8]]);
      break;
    case "tall":
      // a tall straight-sided hat with a flat top (an arcanist's)
      sub(g, [[-7.4, -6.8], [-6.6, -19 * h], [-5.6, -20.4 * h], [6, -20.4 * h], [7, -19 * h], [7.8, -6.8]]);
      break;
    case "floppy":
      g.moveTo(-8.4, -6.8);
      g.bezierCurveTo(-8, -16 * h, 2, -21 * h, 6 + sw, -17 * h);
      g.bezierCurveTo(10 + sw, -14 * h, 12 + sw, -10, 14 + sw, -8.6);
      g.lineTo(10.4, -8.6);
      g.lineTo(8.8, -6.8);
      g.closePath();
      break;
    case "witch":
      sub(g, [[-7.6, -6.6], [-2.4, -16 * h], [-0.6 + lean * 0.5, -22 * h], [-6 * lean + sw, -26 * h], [1.8, -21 * h], [3.6, -15 * h], [8.4, -6.6]]);
      break;
    case "cap":
    case "forester":
      sub(g, [[11.6, -2], [10, -8.4], [3.6, -12.6], [-4.6, -13.2], [-11.4 + sw * 0.6, -10.8], [-14.6 + sw, -5.6 * (c === "forester" ? 1 : 0.6)], [-11.2, -6], [-11.2, -1.6]]);
      break;
    case "brimmed":
      g.moveTo(-8.4, -6.4);
      g.ellipse(-0.6, -6.8, 8.4, 7 * h, 0, Math.PI, Math.PI * 2);
      g.closePath();
      break;
    case "tricorne":
      g.moveTo(-9, -5);
      g.ellipse(-0.4, -6, 9, 6.4 * h, 0, Math.PI, Math.PI * 2);
      g.closePath();
      break;
    case "beret":
      g.moveTo(-10, -3.6);
      g.bezierCurveTo(-11, -12 * h, 6, -13 * h, 11.4, -7);
      g.lineTo(9.6, -4.6);
      g.closePath();
      break;
    case "mitre":
      sub(g, [[-7.4, -5.4], [-6, -16 * h], [-0.6, -22.4 * h], [5.4, -16 * h], [7.4, -5.4]]);
      break;
    case "turban":
      g.moveTo(-10.6, -1.6);
      g.bezierCurveTo(-12.4, -12 * h, -3, -15 * h, 0, -15 * h);
      g.bezierCurveTo(5, -15 * h, 12, -12 * h, 10.8, -2);
      g.closePath();
      break;
    case "pillbox":
      sub(g, [[-9, -4.4], [-8.6, -11.6 * h], [8.6, -11.6 * h], [9, -4.4]]);
      break;
    case "stepped":
      sub(g, [[-8.6, -6], [-7.6, -12 * h], [-5.6, -12 * h], [-5, -18 * h], [-2.4, -18 * h], [-1.6, -24 * h], [1.6, -24 * h], [2.4, -18 * h], [5, -18 * h], [5.6, -12 * h], [7.6, -12 * h], [8.6, -6]]);
      break;
  }
}

function brimDraw(g: Ctx, b: HatBrim, r: Ramp, sw: number): void {
  switch (b) {
    case "narrow":
      lit(g, () => g.ellipse(0, -5.6, 11.6, 2.4, 0, 0, Math.PI * 2), r, { shadow: [0.4, -0.8] });
      break;
    case "wide":
      lit(g, () => g.ellipse(0, -5.4, 15.4, 3.2, 0, 0, Math.PI * 2), r, { shadow: [0.4, -0.8] });
      break;
    case "witch":
      lit(g, () => sub(g, [[-17.6 + sw * 0.3, -3.6], [-10, -7.6], [10, -7.6], [18.4, -4], [12, -2.4], [-11, -2.2]]), r, { shadow: [0.4, -0.8] });
      break;
    case "front":
      lit(g, () => sub(g, [[-15.4 + sw, -5.4], [-8, -7.2], [8, -7.2], [16, -3.2], [14.6, -1.8], [6.4, -4.6], [-8, -4.6], [-14.8 + sw, -3.6]]), r, { shadow: [0.4, -0.8] });
      break;
    case "turned":
      lit(g, () => sub(g, [[12.8, -0.8], [11.8, -5], [2.4, -4.2], [-11.4, -3.2], [-11.8, -0.4]]), r, { shadow: [0.4, -0.8] });
      break;
    case "flat":
      lit(g, () => sub(g, [[-16, -4.6], [-9, -6.6], [9.4, -6.6], [16.6, -4.6], [9, -3.4], [-9, -3.4]]), r, { shadow: [0.4, -0.8] });
      break;
    default:
      break;
  }
}

function decoDraw(g: Ctx, kind: HatDeco, r: Ramp, s: HatSpec, sw: number): void {
  const h = s.height ?? 1;
  switch (kind) {
    case "feather":
      g.save();
      g.translate(-3, -6);
      g.rotate(-1 + sw * 0.025);
      g.beginPath();
      g.moveTo(0, 0);
      g.quadraticCurveTo(-2.8, -8, 0.4, -15.6);
      g.quadraticCurveTo(2.8, -8, 0, 0);
      g.fillStyle = r.base;
      g.fill();
      g.strokeStyle = OL;
      g.lineWidth = 0.8;
      g.stroke();
      line(g, [0, -1], [0.3, -14.4], 0.5, r.hi);
      g.restore();
      break;
    case "plume":
      for (const [dx, dy] of [[-12, -8], [-14, -4], [-9, -11]] as const) cord(g, () => {
        g.beginPath();
        g.moveTo(-2, -8);
        g.quadraticCurveTo(-3 + dx * 0.3, -14, dx + sw, -8 + dy);
      }, 2, r.base);
      break;
    case "star":
      sparkle(g, s.crown === "bent" ? 6.6 : 0.4, s.crown === "bent" ? -22.2 * h : -22.6 * h, 2.2, r.hi);
      break;
    case "stars":
      for (const [x, y] of [[-3.6, -11], [0.4, -15.4], [3, -10.4], [-1, -18.4]] as const) sparkle(g, x, y * h, 1.2, r.hi);
      break;
    case "moon":
      g.save();
      g.beginPath();
      g.arc(2, -12.4 * h, 2.6, 0, Math.PI * 2);
      g.arc(3.1, -13.2 * h, 2.1, 0, Math.PI * 2, true);
      g.fillStyle = r.base;
      g.fill("evenodd");
      g.restore();
      break;
    case "gem":
      gem(g, 0.6, -6.1, 1.8, r);
      break;
    case "rune":
      for (const [x, y] of [[-3, -10], [0.6, -13], [2.6, -9]] as const) poly(g, [[x, y * h - 1.2], [x + 1, y * h], [x, y * h + 1.2], [x - 1, y * h]], r.base, 0.5);
      break;
    case "buckle":
      rrect(g, -0.6, -7.8, 3.4, 3, 0.4, r.base, 0.7);
      rrect(g, 0.2, -7, 1.8, 1.4, 0.2, r.lo, 0);
      break;
    case "ribbon":
      cord(g, () => {
        g.beginPath();
        g.moveTo(-8, -6.4);
        g.quadraticCurveTo(-12 + sw, -4, -14 + sw * 1.4, 0);
      }, 1.4, r.base);
      break;
    case "cross":
      poly(g, [[-0.8, -17 * h], [0.8, -17 * h], [0.8, -14.4 * h], [3, -14.4 * h], [3, -12.8 * h], [0.8, -12.8 * h], [0.8, -9 * h], [-0.8, -9 * h], [-0.8, -12.8 * h], [-3, -12.8 * h], [-3, -14.4 * h], [-0.8, -14.4 * h]], r.base, 0.6);
      break;
    case "sun":
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        line(g, [Math.cos(a) * 1.6, -12 * h + Math.sin(a) * 1.6], [Math.cos(a) * 3.4, -12 * h + Math.sin(a) * 3.4], 0.8, r.base);
      }
      circle(g, 0, -12 * h, 1.5, r.hi, 0.6);
      break;
    case "eye":
      ellipse(g, 0.6, -12 * h, 2.6, 1.5, r.base, 0.6);
      circle(g, 0.8, -12 * h, 0.8, "#1c1c26", 0);
      break;
    case "bells":
      for (const [x, y] of [[-6 * sw * 0 + 6.6, -22.6], [13.4, -8.4]] as const) circle(g, x, y * (y < -10 ? h : 1), 1.3, r.base, 0.6);
      break;
  }
}

export function hat(spec: HatSpec): Piece[] {
  const out: Piece[] = [
    piece(60, spec.mat, (g, p, j, r) => head(g, j, () => {
      const sw = p.capeSway * 0.3;
      const h = spec.height ?? 1;
      const lean = spec.lean ?? 1;
      lit(g, () => crownPath(g, spec.crown, h, lean, sw), r, { shadow: [-2, 0.6], hi: () => g.ellipse(-3.6, -12 * h, 1.4, 4 * h, -0.3, 0, Math.PI * 2) });
      if (spec.crown === "tricorne") {
        lit(g, () => sub(g, [[-14, -6], [-6, -9.6], [0, -5], [8, -9.4], [15, -6], [10, -2.4], [0, -3.4], [-10, -2.4]]), r, { shadow: [0.4, -0.8] });
      }
      if (spec.crown === "turban") for (const y of [-12, -8.6, -5.2]) line(g, [-10, y], [10, y + 1.4], 0.7, r.lo);
      if (spec.crown === "mitre") line(g, [-0.6, -22 * h], [-0.6, -5.4], 0.7, r.lo);
      if (spec.brim && spec.brim !== "none") brimDraw(g, spec.brim, r, sw);
    })),
  ];
  if (spec.band) {
    out.push(piece(60, spec.band, (g, _p, j, r) => head(g, j, () => {
      const y = spec.crown === "cap" || spec.crown === "forester" ? -4 : spec.crown === "turban" ? -6 : -7.6;
      const w = spec.crown === "witch" ? 8.4 : spec.crown === "tall" ? 7.8 : 9;
      rrect(g, -w, y, w * 2, 2.4, 0.8, r.base, 0.9);
      line(g, [-w + 0.6, y + 0.6], [w - 0.6, y + 0.6], 0.5, r.hi);
    })));
  }
  for (const d of spec.deco ?? []) out.push(piece(d.z ?? 61, d.mat, (g, p, j, r) => head(g, j, () => decoDraw(g, d.kind, r, spec, p.capeSway * 0.3))));
  return out;
}

// ======================================================================================
// Hoods
// ======================================================================================

export type HoodShape = "deep" | "cowl" | "pointed" | "liripipe" | "horned" | "leaf" | "draped" | "bandana" | "wrap" | "veil" | "chaperon";

export interface HoodSpec {
  shape: HoodShape;
  mat: Mat;
  /** A cloth mask over the lower face (rogues). */
  mask?: "none" | "lower" | "nose" | "half";
  maskMat?: Mat;
  /** A short cape over the shoulders, attached to the hood. */
  mantle?: "none" | "plain" | "leaf" | "fur" | "tattered";
  mantleMat?: Mat;
  trim?: Mat;
  /** Shade the face under the hood. */
  shade?: boolean;
  deco?: Array<{ kind: "brooch" | "horns" | "circlet" | "pin" | "eyes" | "rune"; mat: Mat }>;
}

function hoodOuter(g: Ctx, s: HoodShape, sw: number): void {
  switch (s) {
    case "pointed":
      g.moveTo(-12.6, 4);
      g.bezierCurveTo(-14, -8, -8, -14, -2 + sw * 0.2, -19.4);
      g.bezierCurveTo(4, -14, 11.4, -9, 11.4, 0);
      g.lineTo(11, 6);
      g.lineTo(-12, 8);
      g.closePath();
      break;
    case "liripipe":
      g.moveTo(-9.4, -6);
      g.lineTo(-13.6 + sw * 0.4, 2);
      g.lineTo(-14.8 + sw, 12.6);
      g.lineTo(-11.2 + sw * 0.8, 13.4);
      g.lineTo(-9.6, 4);
      g.closePath();
      g.moveTo(11.4, -0.4);
      g.arc(-0.6, -0.4, 12, 0, Math.PI * 2);
      break;
    case "horned":
    case "deep":
    case "leaf":
    case "chaperon":
      g.moveTo(11.6, -0.6);
      g.arc(-0.8, -0.6, 12.4, 0, Math.PI * 2);
      break;
    case "cowl":
      g.moveTo(11, 2);
      g.bezierCurveTo(12, -10, 4, -13.6, -2, -13.4);
      g.bezierCurveTo(-10, -13, -13.6, -6, -13, 4);
      g.lineTo(-11, 11);
      g.lineTo(9, 11);
      g.closePath();
      break;
    case "draped":
    case "veil":
      // cloth laid over the crown (it follows the head) and falling down the back to the shoulders
      g.moveTo(10.4, 0.6);
      g.arc(-0.4, -0.6, 11, -0.1, -Math.PI * 1.02, true);
      g.lineTo(-12.8 + sw * 0.6, 8);
      g.lineTo(-13.2 + sw, 15.4);
      g.lineTo(-5.4 + sw * 0.6, 15.8);
      g.lineTo(-5.6, 7);
      g.lineTo(-3.4, 3);
      g.closePath();
      break;
    case "bandana":
      g.moveTo(-10.8, -1);
      g.arc(-0.2, -1.4, 10.8, Math.PI * 1.02, Math.PI * 1.96);
      g.lineTo(10.6, -3.2);
      g.lineTo(-10.6, 0.4);
      g.closePath();
      break;
    case "wrap":
      g.moveTo(-11.4, 2);
      g.arc(-0.4, -0.6, 11.2, Math.PI * 0.95, Math.PI * 2.02);
      g.lineTo(11, 1);
      g.closePath();
      break;
  }
}

export function hood(spec: HoodSpec): Piece[] {
  const out: Piece[] = [];
  const opening = spec.shape === "bandana" || spec.shape === "wrap" ? null : spec.shape === "cowl" ? { x: 4.4, y: 3.4, rx: 7.6, ry: 7.2 } : { x: 3.4, y: 2.4, rx: 8.4, ry: 8.2 };
  out.push(piece(60, spec.mat, (g, p, j, r) => head(g, j, () => {
    const sw = p.capeSway * 0.3;
    // the mantle under the hood (shoulder cape)
    if (spec.mantle && spec.mantle !== "none" && (spec.mantleMat === undefined || spec.mantleMat === spec.mat)) mantle(g, spec.mantle, r, sw);
    lit(g, () => hoodOuter(g, spec.shape, sw), r, { shadow: [-1.8, 1], hi: () => g.ellipse(-4, -9, 4, 2, -0.3, 0, Math.PI * 2) });
    if (opening) {
      g.save();
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.ellipse(opening.x, opening.y, opening.rx, opening.ry, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
      // the inner rim of the opening, in shadow
      g.beginPath();
      g.ellipse(opening.x, opening.y, opening.rx, opening.ry, 0, Math.PI * 0.9, Math.PI * 1.9);
      g.strokeStyle = r.deep;
      g.lineWidth = 1.2;
      g.stroke();
      if (spec.shade) {
        g.save();
        g.globalAlpha = 0.55;
        g.beginPath();
        // the shadow of the hood's brim over the forehead — it stops above the eyes, which always read
        g.ellipse(opening.x, opening.y, opening.rx, opening.ry, 0, Math.PI * 1.02, Math.PI * 1.98);
        g.lineTo(opening.x + opening.rx, -0.6);
        g.lineTo(opening.x - opening.rx, -0.6);
        g.closePath();
        g.fillStyle = "#121018";
        g.fill();
        g.restore();
      }
    }
    if (spec.shape === "leaf") for (const [x, y] of [[-11, 4], [-12.6, -2], [-11.4, -8], [-7, -12.6]] as const) poly(g, [[x, y], [x - 2.6, y + 1], [x - 0.4, y + 2.8]], r.base, 0.7);
    if (spec.shape === "chaperon") lit(g, () => sub(g, [[-6, -11], [-14 + sw, -15], [-16 + sw, -9], [-10, -6]]), r, { shadow: [0.6, -0.6] });
    if (spec.shape === "bandana") {
      cord(g, () => {
        g.beginPath();
        g.moveTo(-10.4, -0.4);
        g.quadraticCurveTo(-13 + sw, 2, -15 + sw * 1.4, 5.4);
      }, 1.8, r.base);
      cord(g, () => {
        g.beginPath();
        g.moveTo(-10.4, -0.4);
        g.quadraticCurveTo(-14 + sw, -1, -16.4 + sw * 1.4, 1.6);
      }, 1.6, r.lo);
    }
    if (spec.shape === "wrap") for (const y of [-8, -4.4]) line(g, [-10, y], [10, y + 1], 0.7, r.lo);
  })));
  if (spec.mantle && spec.mantle !== "none" && spec.mantleMat !== undefined && spec.mantleMat !== spec.mat) {
    const kind = spec.mantle;
    out.push(piece(60, spec.mantleMat, (g, p, j, r) => head(g, j, () => mantle(g, kind, r, p.capeSway * 0.3))));
  }
  if (spec.mask && spec.mask !== "none") {
    const kind = spec.mask;
    out.push(piece(60, spec.maskMat ?? spec.mat, (g, _p, j, r) => head(g, j, () => {
      const top = kind === "nose" ? 2.4 : kind === "half" ? -0.6 : 3.6;
      lit(g, () => sub(g, [[-3.6, top], [11, top - 0.6], [10.4, 8.8], [3, 10.6], [-3.4, 9]]), r, { shadow: [0.6, -0.6] });
      line(g, [-2.6, top + 2], [9.8, top + 1.6], 0.7, r.lo);
      if (kind === "half") {
        // eye holes in a half mask
        g.save();
        g.globalCompositeOperation = "destination-out";
        g.beginPath();
        g.ellipse(-1.6, 1.8, 1.8, 1.2, 0, 0, Math.PI * 2);
        g.ellipse(4.7, 1.8, 1.8, 1.2, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    })));
  }
  if (spec.trim) {
    const shape = spec.shape;
    out.push(piece(61, spec.trim, (g, _p, j, r) => head(g, j, () => {
      if (!opening) return;
      // a trimmed brow: a thin band along the top of the opening (not a ring around the face)
      g.beginPath();
      g.ellipse(opening.x, opening.y, opening.rx + 0.5, opening.ry + 0.5, 0, Math.PI * (shape === "cowl" ? 1.05 : 1.1), Math.PI * 1.85);
      g.strokeStyle = r.base;
      g.lineWidth = 1.1;
      g.stroke();
    })));
  }
  for (const d of spec.deco ?? []) {
    out.push(piece(61, d.mat, (g, _p, j, r) => head(g, j, () => {
      switch (d.kind) {
        case "brooch":
          gem(g, 3.4, -9.4, 1.7, r);
          break;
        case "horns":
          for (const [x0, x1, y1] of [[-6, -12, -18], [2, 6, -19]] as const) lit(g, () => sub(g, [[x0 - 1.6, -9], [x1, y1], [x0 + 1.6, -10]]), r, { shadow: [0.4, -0.4] });
          break;
        case "circlet":
          rrect(g, -10.6, -4.6, 21, 1.8, 0.8, r.base, 0.8);
          gem(g, 7, -3.7, 1.2, M.sapphire);
          break;
        case "pin":
          line(g, [-6, -8], [-1, -12.6], 0.9, r.base);
          circle(g, -1, -12.6, 1.1, r.hi, 0.5);
          break;
        case "eyes":
          for (const x of [-1.6, 4.7]) ellipse(g, x, 1.8, 1.2, 0.6, r.hi, 0);
          break;
        case "rune":
          poly(g, [[-3, -11], [-1.6, -9], [-3, -7], [-4.4, -9]], r.base, 0.6);
          break;
      }
    })));
  }
  return out;
}

function mantle(g: Ctx, kind: NonNullable<HoodSpec["mantle"]>, r: Ramp, sw: number): void {
  const pts: Pt[] = [[-12.6, 6], [-1, 9.4], [10.4, 7.6], [11.4, 11.6]];
  if (kind === "leaf") pts.push([8, 12.8], [6.4, 15.4], [3.6, 13.2], [1, 16], [-1.6, 13.4], [-4.6, 16.2], [-7, 13.4], [-10.4 + sw * 0.4, 15.6], [-13 + sw * 0.6, 12]);
  else if (kind === "tattered") pts.push([8, 13.6], [5, 12], [2, 15.8], [-1.4, 12.6], [-5, 16.4], [-8, 12.8], [-12 + sw * 0.6, 15.4], [-14 + sw * 0.6, 11]);
  else pts.push([6, 14.4], [-4, 15.4], [-13.4 + sw * 0.6, 13]);
  lit(g, () => sub(g, pts), r, { shadow: [0.8, -1] });
  if (kind === "fur") for (let i = 0; i < 7; i++) ellipse(g, -11 + i * 3.4, 13.4 + (i % 2) * 0.8, 2, 1.3, i % 2 ? r.lo : r.base, 0.6);
}

// ======================================================================================
// Holy marks (head-local): halo, circlet, laurel, diadem, sun crown
// ======================================================================================

export type HolyKind = "halo" | "circlet" | "laurel" | "diadem" | "suncrown" | "rays" | "stars";

export function holy(kind: HolyKind, mat: Mat, opts: { y?: number; size?: number; gem?: Ramp; z?: number } = {}): Piece {
  return piece(opts.z ?? 61, mat, (g, _p, j, r) => head(g, j, () => {
    const k = opts.size ?? 1;
    switch (kind) {
      case "halo": {
        const y = opts.y ?? -15.4;
        g.strokeStyle = OL;
        g.lineWidth = 3.4;
        g.beginPath();
        g.ellipse(-0.4, y, 8.8 * k, 2.9 * k, -0.08, 0, Math.PI * 2);
        g.stroke();
        g.strokeStyle = r.hi;
        g.lineWidth = 1.7;
        g.stroke();
        break;
      }
      case "rays": {
        const y = opts.y ?? -15.4;
        for (let i = 0; i < 9; i++) {
          const a = Math.PI * (1.08 + (i / 8) * 0.84);
          line(g, [-0.4 + Math.cos(a) * 9 * k, y + 6 + Math.sin(a) * 9 * k], [-0.4 + Math.cos(a) * 13.6 * k, y + 6 + Math.sin(a) * 13.6 * k], 1.1, i % 2 ? r.base : r.hi);
        }
        break;
      }
      case "circlet":
        rrect(g, -10.4, -4.4, 20.8, 2.2, 1, r.base, 0.9);
        if (opts.gem) gem(g, 6.4, -3.3, 1.4, opts.gem);
        break;
      case "laurel":
        rrect(g, -10.4, -4.4, 20.8, 1.8, 0.8, r.lo, 0.8);
        for (let i = 0; i < 6; i++) {
          const x = -9 + i * 3.2;
          poly(g, [[x, -3.6], [x + 1.2, -6.6], [x + 2.6, -4.2]], i % 2 ? r.base : r.hi, 0.6);
        }
        break;
      case "diadem":
        g.beginPath();
        sub(g, [[-10.4, -2.6], [-10, -4.8], [-3, -5.6], [0.6, -9.6], [4, -5.6], [10.6, -4.6], [10.6, -2.4]]);
        g.fillStyle = r.base;
        g.fill();
        g.strokeStyle = OL;
        g.lineWidth = 0.9;
        g.stroke();
        gem(g, 0.6, -6, 1.5, opts.gem ?? M.sapphire);
        break;
      case "suncrown":
        for (let i = 0; i < 9; i++) {
          const x = -9 + i * 2.25;
          const h = i % 2 ? 5 : 8;
          poly(g, [[x - 1, -4.4], [x, -4.4 - h * k], [x + 1, -4.4]], i % 2 ? r.base : r.hi, 0.6);
        }
        rrect(g, -10.4, -4.8, 20.8, 2.2, 1, r.base, 0.9);
        gem(g, 0, -3.7, 1.3, opts.gem ?? M.ruby);
        break;
      case "stars":
        for (const [x, y] of [[-6, -14], [0, -17], [6, -14]] as const) sparkle(g, x, (opts.y ?? 0) + y, 2.2 * k, r.hi);
        break;
    }
  }));
}
