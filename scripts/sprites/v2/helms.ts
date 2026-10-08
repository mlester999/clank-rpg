import { circle, cord, ellipse, gem, head, line, lit, M, OL, rrect, sub, type Ctx, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — HELMETS (head-local, radius 9.6 design space; +x = the face side, −y up). A helmet is a SHELL (its silhouette) + a FACE
 * opening + a NECK guard + an optional BRIM + CRESTS, each in its own material, so one builder covers a nasal helm, a kettle hat, a bascinet
 * with its aventail, a sallet, a barbute, a morion, a bucket helm and a winged, crowned or lion-maned prestige helm.
 *
 * The face reads: open shells leave eyes, nose and mouth visible (the opening is cut out of the shell); a bevor covers the mouth; only a
 * slit (a closed great helm) hides the eyes.
 */

export type Shell = "round" | "pointed" | "cone" | "tall" | "flat" | "skull" | "sallet" | "kettle" | "barbute" | "morion" | "bowl";
export type Face = "open" | "nasal" | "cheeks" | "T" | "slit" | "bars" | "visor" | "bevor";
export type Neck = "none" | "aventail" | "cheekplates" | "gorget" | "coif" | "flare" | "lames";
export type Brim = "none" | "kettle" | "morion" | "peak" | "wide";
export type Crest = "comb" | "plume" | "fan" | "horns" | "ramhorns" | "wings" | "spike" | "crown" | "mane" | "dragon" | "socket" | "fin" | "tuft" | "halo";

export interface HelmSpec {
  shell: Shell;
  mat: Mat;
  face?: Face;
  neck?: Neck;
  /** The neck guard's material (default: the shell's). */
  neckMat?: Mat;
  brim?: Brim;
  /** Brow band / edge trim in another material (gold, brass, leather). */
  band?: Mat;
  /** Fluting lines up the dome. */
  ribs?: number;
  rivets?: boolean;
  crests?: Array<{ kind: Crest; mat: Mat; z?: number; size?: number }>;
}

// ------------------------------------------------------------------------------ shells (sub-paths)

function shellPath(g: Ctx, s: Shell): void {
  switch (s) {
    case "pointed":
      g.moveTo(-11.6, 3.4);
      g.quadraticCurveTo(-12.4, -8.6, -2.4, -16.6);
      g.quadraticCurveTo(9, -10.6, 11.6, 3.4);
      g.closePath();
      break;
    case "cone":
      sub(g, [[-11.4, 3.2], [-10.8, -5.6], [-1.4, -17.2], [9.8, -6], [11.6, 3.2]]);
      break;
    case "tall":
      g.moveTo(-11.6, 3.6);
      g.bezierCurveTo(-12.4, -12, -6, -15.8, 0, -15.8);
      g.bezierCurveTo(6.4, -15.8, 12.2, -12, 11.8, 3.6);
      g.closePath();
      break;
    case "flat":
      // a great helm: slightly tapering sides, a rounded flat top
      g.moveTo(-10.8, 10.2);
      g.lineTo(-11.2, -7.6);
      g.quadraticCurveTo(-11, -11.4, -6.4, -11.4);
      g.lineTo(6.8, -11.4);
      g.quadraticCurveTo(11.6, -11.4, 11.8, -7.6);
      g.lineTo(12, 10.4);
      g.closePath();
      break;
    case "skull":
      g.moveTo(-10.6, -2.6);
      g.arc(0, -0.4, 10.8, Math.PI * 1.06, Math.PI * 1.94);
      g.lineTo(10.4, -2.4);
      g.closePath();
      break;
    case "sallet":
      g.moveTo(11.8, 3);
      g.lineTo(11.6, -2);
      g.bezierCurveTo(11, -11.8, 1, -14.4, -4.6, -12.4);
      g.bezierCurveTo(-10.6, -10.4, -12.6, -5, -13.4, 0.6);
      g.lineTo(-18.6, 6.8);
      g.lineTo(-15.6, 7.8);
      g.lineTo(-9.6, 4.6);
      g.lineTo(-4, 3.4);
      g.closePath();
      break;
    case "kettle":
    case "bowl":
      g.moveTo(-10, -0.6);
      g.arc(0, -1.6, 10, Math.PI, Math.PI * 2);
      g.closePath();
      break;
    case "barbute":
      g.moveTo(-11.4, 9.8);
      g.bezierCurveTo(-12.6, -11, -6, -14.6, 0, -14.6);
      g.bezierCurveTo(7, -14.6, 12.6, -10, 12.2, -1);
      g.lineTo(12, 10.2);
      g.lineTo(4, 11.4);
      g.closePath();
      break;
    case "morion":
      g.moveTo(-9.6, -1.4);
      g.bezierCurveTo(-10, -9.8, -4, -11.6, 0, -11.6);
      g.bezierCurveTo(5, -11.6, 10, -9.4, 9.8, -1.4);
      g.closePath();
      break;
    default:
      g.moveTo(-11.6, 3.4);
      g.arc(0, 0.4, 11.4, Math.PI * 1.02, Math.PI * 1.98);
      g.lineTo(11.6, 3.4);
      g.closePath();
  }
}

/** Where the brow band sits on each shell (y of its top edge) and how wide it is. */
const BROW: Record<Shell, { y: number; x0: number; x1: number } | null> = {
  round: { y: -3.8, x0: -11.6, x1: 11.6 },
  pointed: { y: -3.8, x0: -11.8, x1: 11.4 },
  cone: { y: -3.8, x0: -11.2, x1: 11.2 },
  tall: { y: -3.8, x0: -11.8, x1: 11.8 },
  flat: { y: -4.2, x0: -11.8, x1: 12.4 },
  skull: { y: -4.4, x0: -10.6, x1: 10.4 },
  sallet: { y: -3.6, x0: -12.4, x1: 11.6 },
  kettle: { y: -2.6, x0: -10, x1: 10 },
  bowl: { y: -2.6, x0: -10, x1: 10 },
  barbute: { y: -4.4, x0: -12, x1: 12.2 },
  morion: { y: -3, x0: -9.6, x1: 9.8 },
};

function cutFace(g: Ctx, face: Face, shell: Shell): void {
  g.save();
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "#000";
  g.beginPath();
  const deep = shell === "flat" || shell === "barbute";
  switch (face) {
    case "T":
      sub(g, [[-2.8, -1.8], [12.8, -1.8], [12.8, 3.6], [5.6, 3.6], [5.6, 11], [-0.8, 11], [-0.8, 3.6], [-2.8, 3.6]]);
      break;
    case "slit":
      break;
    case "bevor":
      g.rect(-4.6, -2.2, 17.2, deep ? 7 : 8);
      break;
    default:
      if (deep) sub(g, [[-3.2, -2.2], [12.8, -2.2], [12.8, 9.2], [6, 11.4], [-1.4, 10.6], [-3.6, 6]]);
      else g.rect(-4.6, -2.2, 17.4, 8.4);
  }
  g.fill();
  g.restore();
}

function shellDraw(spec: HelmSpec) {
  return (g: Ctx, _p: Pose, _j: unknown, r: Ramp): void => {
    const s = spec.shell;
    lit(g, () => shellPath(g, s), r, {
      shadow: [1.8, -1.6],
      hi: () => {
        g.ellipse(2.6, s === "flat" ? -8.6 : s === "pointed" || s === "cone" ? -9 : -7.4, 4.4, 2, -0.35, 0, Math.PI * 2);
      },
    });
    // fluting / banding up the dome
    if (spec.ribs) {
      g.save();
      g.beginPath();
      shellPath(g, s);
      g.clip();
      for (let i = 0; i < spec.ribs; i++) {
        const x = -7 + (14 / Math.max(1, spec.ribs - 1)) * i;
        line(g, [x * 0.9, 3], [x * 0.25 - 1, -16], 0.7, r.lo);
        line(g, [x * 0.9 + 0.7, 3], [x * 0.25 - 0.3, -16], 0.5, r.hi);
      }
      g.restore();
    }
    if (s === "flat") {
      // a bucket helm: a vertical ridge down the face plate, breaths below the slit
      line(g, [5.6, -11], [5.6, 10], 0.8, r.hi);
      for (const [x, y] of [[8, 5.6], [10, 5.6], [8, 7.6], [10, 7.6], [9, 9.4]] as const) circle(g, x, y, 0.55, r.deep, 0);
    }
    if (s === "barbute") line(g, [-11, 9.2], [12, 9.6], 0.7, r.lo);
    if (spec.rivets) for (const x of [-9, -5, 5, 9]) circle(g, x, -2.6, 0.6, r.hi, 0.4);
    // the face
    const face = spec.face ?? "open";
    if (s !== "skull" && s !== "kettle" && s !== "morion" && s !== "bowl") cutFace(g, face, s);
    if (face === "slit") {
      rrect(g, -2.4, 0.4, 15.6, 2.4, 0.8, M.dark.deep, 0.7);
      rrect(g, -2.4, 0.4, 15.6, 0.8, 0.4, "#0a0a10", 0);
    }
  };
}

// ------------------------------------------------------------------------------ face fittings

function faceFittings(spec: HelmSpec, g: Ctx, r: Ramp): void {
  switch (spec.face) {
    case "nasal":
      rrect(g, 0.6, -3.4, 2, 6.8, 0.8, r.base, 0.8);
      line(g, [1.2, -3], [1.2, 2.8], 0.5, r.hi);
      break;
    case "bars":
      for (const x of [2.8, 6, 9.2]) rrect(g, x - 0.6, -2.4, 1.2, 9, 0.5, r.base, 0.7);
      rrect(g, -1, 2.4, 13.6, 1.1, 0.4, r.lo, 0.6);
      break;
    case "visor":
      // a raised visor: a pointed plate tipped up over the brow
      lit(g, () => sub(g, [[-1.4, -4.6], [6, -11.4], [14.6, -8.6], [15.4, -5.4], [12, -3], [-0.6, -2.6]]), r, { shadow: [1.2, -1.4] });
      line(g, [4, -7.6], [13.4, -6], 0.7, r.deep);
      circle(g, -0.6, -3.4, 1, r.hi, 0.6);
      break;
    case "bevor":
      lit(g, () => sub(g, [[-5.8, 4], [12, 3], [11.6, 7.8], [6.8, 11.4], [-4.6, 11.8], [-6.6, 8.4]]), r, { shadow: [1.2, -1.2] });
      line(g, [-4.6, 4.8], [11.2, 3.9], 0.8, r.hi);
      for (const x of [5.6, 7.8, 10]) circle(g, x, 6.6, 0.55, r.deep, 0);
      break;
    case "cheeks":
      lit(g, () => sub(g, [[-6.4, 2.8], [-0.6, 3.2], [0.2, 8], [-1.6, 10.8], [-5.4, 10.6], [-7, 7]]), r, { shadow: [1, -1] });
      circle(g, -3.4, 4.4, 0.6, r.hi, 0);
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------ neck guards

function neckDraw(kind: Neck, g: Ctx, r: Ramp, p: Pose): void {
  const sw = p.capeSway * 0.2;
  switch (kind) {
    case "aventail": {
      const pts: Pt[] = [[-11.8, 1.6], [-13 + sw * 0.5, 11.2], [-9, 12.6], [-4, 13], [1, 12.8], [6, 12.2], [9.6, 10.2], [10.4, 8.4], [4, 9.6], [-2, 9.2], [-6.4, 5.6], [-6.8, 1.6]];
      lit(g, () => sub(g, pts), r, { shadow: [1, -1.4] });
      for (const y of [4.6, 7.4, 10.2]) line(g, [-12, y], [-6 + (y - 4) * 1.6, y + 0.4], 0.5, r.lo);
      line(g, [-1, 11.2], [9, 10.2], 0.5, r.lo);
      break;
    }
    case "cheekplates":
      lit(g, () => sub(g, [[-11.4, 2.6], [-5.6, 2.6], [-4.8, 9.8], [-7.6, 10.6], [-11, 8.6]]), r, { shadow: [1, -1] });
      break;
    case "gorget":
      lit(g, () => sub(g, [[-9, 7.4], [8.4, 8.6], [9, 12.6], [-9.6, 12.2]]), r, { shadow: [1, -1.2] });
      line(g, [-8.6, 9.6], [8.6, 10.6], 0.6, r.lo);
      break;
    case "coif": {
      // a mail hood under the shell: round about the face, down over the neck
      g.save();
      lit(g, () => {
        g.moveTo(-12.4, 11.6);
        g.lineTo(-12.6, -1);
        g.arc(-0.6, -0.6, 12, Math.PI, Math.PI * 2);
        g.lineTo(11.6, 10.4);
        g.lineTo(-2, 12.6);
        g.closePath();
      }, r, { shadow: [1.4, -1.2] });
      g.globalCompositeOperation = "destination-out";
      g.beginPath();
      g.ellipse(4.8, 3.2, 8.2, 7, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
      g.beginPath();
      g.ellipse(4.8, 3.2, 8.2, 7, 0, Math.PI * 0.6, Math.PI * 1.55);
      g.strokeStyle = r.lo;
      g.lineWidth = 0.8;
      g.stroke();
      for (const y of [-6, -2.4, 7.4, 10.2]) line(g, [-11.4, y], [-6.4, y + 0.3], 0.5, r.lo);
      break;
    }
    case "flare":
      lit(g, () => sub(g, [[-10.6, 0.4], [-17.4 + sw, 7], [-15.4 + sw, 9], [-8.6, 6.4], [-6.4, 3]]), r, { shadow: [1, -1] });
      line(g, [-11, 2.4], [-15.6 + sw, 7.6], 0.6, r.lo);
      break;
    case "lames":
      for (let i = 2; i >= 0; i--) lit(g, () => sub(g, [[-11.6 + i * 0.4, 2 + i * 2.4], [-6, 2 + i * 2.6], [-5.6, 4.6 + i * 2.6], [-12.4 + i * 0.2, 4.4 + i * 2.4]]), r, { shadow: [0.8, -0.8] });
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------ brims

function brimDraw(kind: Brim, g: Ctx, r: Ramp): void {
  switch (kind) {
    case "kettle":
      lit(g, () => sub(g, [[-15.6, 0.2], [-11, -3.4], [11.4, -3.4], [15.8, 0.2], [12.8, 1.2], [-12.6, 1.2]]), r, { shadow: [0.8, -1] });
      line(g, [-11, -2.8], [11.4, -2.8], 0.7, r.hi);
      break;
    case "wide":
      lit(g, () => sub(g, [[-17.6, 1.6], [-12, -3.2], [12.4, -3.2], [18, 1.2], [15, 2.4], [-14.6, 2.6]]), r, { shadow: [0.8, -1] });
      line(g, [-12, -2.6], [12.4, -2.6], 0.7, r.hi);
      break;
    case "morion":
      lit(g, () => sub(g, [[-16.4, -6.4], [-11.6, -2], [0, -1.8], [11.2, -2], [16.4, -6.8], [14.4, -0.2], [0, 1.2], [-14.4, 0]]), r, { shadow: [0.8, -1] });
      line(g, [-12, -1.4], [12, -1.4], 0.6, r.hi);
      break;
    case "peak":
      lit(g, () => sub(g, [[5.4, -4], [15.2, -2.8], [14.4, -0.8], [5.6, -1.6]]), r, { shadow: [0.6, -0.8] });
      break;
    default:
      break;
  }
}

// ------------------------------------------------------------------------------ crests

function crestDraw(kind: Crest, g: Ctx, r: Ramp, p: Pose, size: number, shell: Shell): void {
  const sw = p.capeSway * 0.25;
  const topY = shell === "pointed" ? -16 : shell === "cone" ? -16.6 : shell === "tall" ? -15.4 : shell === "flat" ? -11.4 : shell === "barbute" ? -14.2 : shell === "skull" ? -11 : shell === "kettle" || shell === "bowl" ? -11.4 : shell === "morion" ? -11.4 : -10.8;
  const k = size;
  switch (kind) {
    case "socket":
      rrect(g, -1.4, topY - 3.6, 2.8, 4, 1, r.base, 0.9);
      break;
    case "comb":
      lit(g, () => sub(g, [[-8.4, topY + 3.6], [-6.4, topY - 2.6 * k], [0, topY - 5.4 * k], [6.4, topY - 2.8 * k], [8.8, topY + 3], [0, topY + 1.2]]), r, { shadow: [0.8, -1] });
      line(g, [-6, topY - 1.6 * k], [6, topY - 2 * k], 0.6, r.hi);
      break;
    case "fin":
      lit(g, () => sub(g, [[-10, topY + 4], [-7.4, topY - 4 * k], [2.4, topY - 6.4 * k], [8.6, topY - 1], [6, topY + 2.6], [0, topY + 0.6]]), r, { shadow: [0.8, -1] });
      line(g, [-6.6, topY - 3.4 * k], [2.4, topY - 5.6 * k], 0.6, r.hi);
      break;
    case "plume": {
      // three feathers from a socket at the crown, sweeping back with the motion
      const base: Pt = [-0.6, topY + 0.8];
      for (const [dx, dy, w] of [[-10, -9.6, 2.4], [-13.6, -5.2, 2.2], [-6, -11.4, 2.2]] as const) {
        cord(g, () => {
          g.beginPath();
          g.moveTo(base[0], base[1]);
          g.quadraticCurveTo(base[0] + dx * 0.25 * k, base[1] + dy * 1.0 * k, base[0] + dx * k + sw, base[1] + dy * 0.75 * k + Math.abs(sw) * 0.2);
        }, w, r.base);
      }
      cord(g, () => {
        g.beginPath();
        g.moveTo(base[0], base[1]);
        g.quadraticCurveTo(base[0] - 1.6 * k, base[1] - 10 * k, base[0] - 6 * k + sw, base[1] - 8.6 * k);
      }, 0.7, r.hi, 0);
      rrect(g, -1.6, topY - 0.6, 2.4, 2.4, 0.8, M.gold.base, 0.7);
      break;
    }
    case "fan": {
      // a horsehair crest running front to back over the crown (a galea): a thick arc of bristles
      cord(g, () => {
        g.beginPath();
        g.moveTo(7.6, topY + 3.4);
        g.bezierCurveTo(6, topY - 8 * k, -6 + sw, topY - 9.6 * k, -13.6 + sw * 1.6, topY + 2 + sw * 0.3);
      }, 4.2 * k, r.base, 1.4);
      cord(g, () => {
        g.beginPath();
        g.moveTo(6.4, topY + 1.6);
        g.bezierCurveTo(4.6, topY - 6.4 * k, -5 + sw, topY - 7.8 * k, -11.6 + sw * 1.6, topY + 1.6);
      }, 1.2, r.hi, 0);
      for (let i = 0; i < 6; i++) {
        const t = i / 5;
        const x = 6 - t * 18 + sw * t;
        line(g, [x, topY - 6 * k * Math.sin(Math.PI * (0.2 + t * 0.7)) + 1], [x - 1, topY - 6 * k * Math.sin(Math.PI * (0.2 + t * 0.7)) + 3.4], 0.5, r.lo);
      }
      break;
    }
    case "horns": {
      // two horns curving out and up: the far one behind (darker), the near one in front
      const hornPath = (x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, w: number) => () => {
        g.moveTo(x0 - w, y0);
        g.quadraticCurveTo(cx - w * 0.4, cy, x1, y1);
        g.quadraticCurveTo(cx + w * 0.4, cy + w * 0.6, x0 + w, y0 + 0.6);
        g.closePath();
      };
      lit(g, hornPath(-6.4, -6, -14.4 * k, topY - 9 * k, -14.6 * k, -9, 2.4), r, { shadow: [-1, -1] });
      lit(g, hornPath(4.4, -7, 12.6 * k, topY - 10 * k, 13.6 * k, -9.4, 2.6), r, { shadow: [1, -1] });
      line(g, [-9, -9], [-12.6 * k, topY - 6 * k], 0.5, r.lo);
      line(g, [7.6, -10], [11.4 * k, topY - 7 * k], 0.5, r.lo);
      break;
    }
    case "ramhorns":
      // a ram's horn sweeping from the crown BACK over the ear and curling down behind the jaw (a full loop read as an earmuff over the face)
      cord(g, () => {
        g.beginPath();
        g.arc(-7, -3.2, 5.6 * k, Math.PI * 1.62, Math.PI * 0.62, true);
      }, 2.8, r.base, 1.2);
      cord(g, () => {
        g.beginPath();
        g.arc(-7, -3.2, 5.6 * k, Math.PI * 1.5, Math.PI * 1.0, true);
      }, 0.9, r.hi, 0);
      cord(g, () => {
        g.beginPath();
        g.arc(-6.2, 0.6, 2.2 * k, Math.PI * 0.62, Math.PI * 1.7);
      }, 1.8, r.lo, 1);
      break;
    case "wings": {
      // a swept-back feathered wing rising from the side of the helm (the far wing is a second crest at a lower depth)
      const wing = () => {
        g.moveTo(-3.6, -3.6);
        g.bezierCurveTo(-6, -12 * k, -12 * k + sw, -20 * k, -19 * k + sw, -22 * k);
        g.lineTo(-16.8 * k + sw, -17.4 * k);
        g.lineTo(-19.4 * k + sw, -16.2 * k);
        g.lineTo(-15.6 * k + sw * 0.8, -12.4 * k);
        g.lineTo(-17.6 * k + sw * 0.6, -10.6 * k);
        g.lineTo(-13 * k + sw * 0.5, -7.4 * k);
        g.lineTo(-13.6 * k + sw * 0.3, -5.2 * k);
        g.lineTo(-8.6, -3);
        g.closePath();
      };
      lit(g, wing, r, { shadow: [1.2, -1.2] });
      line(g, [-5, -6], [-15 * k + sw, -19.4 * k], 0.6, r.hi);
      line(g, [-7, -5.4], [-14 * k + sw * 0.8, -12.6 * k], 0.5, r.lo);
      break;
    }
    case "spike":
      lit(g, () => sub(g, [[-1.6, topY + 1.6], [1.6, topY + 1.6], [0.5, topY - 7 * k], [-0.5, topY - 7 * k]]), r, { shadow: [0.6, -0.6] });
      circle(g, 0, topY + 0.4, 1.7, r.base, 0.8);
      break;
    case "tuft":
      cord(g, () => {
        g.beginPath();
        g.moveTo(0, topY + 1);
        g.quadraticCurveTo(-1 + sw, topY - 5 * k, -5 * k + sw * 1.4, topY - 6 * k);
      }, 2.6, r.base, 1.2);
      break;
    case "crown": {
      // a crown about the helm at the brow: five points, a jewel at the front
      const y = BROW[shell]?.y ?? -3.8;
      const pts: Pt[] = [[-10.4, y + 2.4], [-10.4, y - 3], [-7.6, y - 0.8], [-4.4, y - 5.6 * k], [-1.2, y - 1], [2.2, y - 6.2 * k], [5.4, y - 1], [8.4, y - 5.4 * k], [10.6, y - 0.6], [10.8, y + 2.4]];
      lit(g, () => sub(g, pts), r, { shadow: [0.6, -0.8] });
      for (const [x, yy] of [[-4.4, y - 5.6 * k], [2.2, y - 6.2 * k], [8.4, y - 5.4 * k]] as const) circle(g, x, yy, 0.9, r.hi, 0.5);
      gem(g, 2.2, y, 1.4, M.ruby);
      break;
    }
    case "mane": {
      // a lion's mane: a shaggy fall from the back of the crown down the nape (a ring of tufts all round read as a sun)
      const n = 6;
      for (let i = 0; i < n; i++) {
        const a = Math.PI * (0.72 + (i / (n - 1)) * 0.62);
        const x = Math.cos(a) * 11.4 * k - 2.4;
        const y = Math.sin(a) * 11.4 * k + 1.2 + i * 0.4;
        ellipse(g, x + sw * 0.35, y, 4.2 * k, 2.6 * k, i % 2 ? r.lo : r.base, 0.9, OL, a);
      }
      ellipse(g, -9.6 * k + sw * 0.5, 9 * k, 3.6 * k, 2.4 * k, r.lo, 0.9, OL, 1.9);
      break;
    }
    case "dragon": {
      // spines along the crown and two swept-back horns
      for (let i = 0; i < 4; i++) {
        const x = 5 - i * 4.4;
        const y = topY + 1.4 + i * 1.2 + (i === 3 ? 2 : 0);
        lit(g, () => sub(g, [[x + 1.8, y + 1], [x - 0.6, y - 4.6 * k], [x - 2.4, y + 1.2]]), r, { shadow: [0.6, -0.6] });
      }
      lit(g, () => sub(g, [[-6, -4.2], [-17.4 * k, -10.6 * k], [-15 * k, -8 * k], [-8.4, -1.4]]), r, { shadow: [0.6, -0.8] });
      lit(g, () => sub(g, [[-3, -6.6], [-13.6 * k, -15.4 * k], [-12.4 * k, -11.6 * k], [-5, -4]]), r, { shadow: [0.6, -0.8] });
      break;
    }
    case "halo":
      g.strokeStyle = OL;
      g.lineWidth = 3.2;
      g.beginPath();
      g.ellipse(-0.4, topY - 4.6, 8.4 * k, 2.6 * k, -0.08, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = r.hi;
      g.lineWidth = 1.6;
      g.stroke();
      break;
  }
}

// ------------------------------------------------------------------------------ the helmet

/** All the pieces of one helmet. The shell (+ face fittings, brim, band) is z 60; crests z 61 unless given (a far wing sits behind, z 59). */
export function helm(spec: HelmSpec): Piece[] {
  const out: Piece[] = [];
  const neck = spec.neck ?? "none";
  const neckMat = spec.neckMat ?? spec.mat;
  // a coif is worn UNDER the shell; the other neck guards hang from it
  if (neck === "coif") out.push(piece(60, neckMat, (g, p, j, r) => head(g, j, () => neckDraw(neck, g, r, p))));
  out.push(piece(60, spec.mat, (g, p, j, r) => head(g, j, () => {
    if (neck !== "none" && neck !== "coif" && neckMat === spec.mat) neckDraw(neck, g, r, p);
    shellDraw(spec)(g, p, j, r);
    if (spec.brim && spec.brim !== "none") brimDraw(spec.brim, g, r);
    faceFittings(spec, g, r);
  })));
  if (neck !== "none" && neck !== "coif" && neckMat !== spec.mat) out.push(piece(60, neckMat, (g, p, j, r) => head(g, j, () => neckDraw(neck, g, r, p))));
  if (spec.band) {
    const b = BROW[spec.shell];
    if (b) out.push(piece(61, spec.band, (g, _p, j, r) => head(g, j, () => {
      rrect(g, b.x0, b.y, b.x1 - b.x0, 2.2, 1, r.base, 0.9);
      line(g, [b.x0 + 0.8, b.y + 0.5], [b.x1 - 0.8, b.y + 0.5], 0.5, r.hi);
    })));
  }
  for (const c of spec.crests ?? []) out.push(piece(c.z ?? 61, c.mat, (g, p, j, r) => head(g, j, () => crestDraw(c.kind, g, r, p, c.size ?? 1, spec.shell))));
  return out;
}

/** What a helmet hides: the hair always (except an open skull cap or a brimmed hat that shows it), the face behind a closed slit. */
export function helmHides(spec: HelmSpec): Array<"hair" | "eyes" | "mouth"> {
  const out: Array<"hair" | "eyes" | "mouth"> = [];
  if (spec.shell !== "skull") out.push("hair");
  if (spec.face === "slit") out.push("eyes", "mouth");
  if (spec.face === "bevor") out.push("mouth");
  return out;
}
