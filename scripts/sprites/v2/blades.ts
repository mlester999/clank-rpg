import { axisAngleB, circle, cord, gem, grip, inWeaponSpace, line, lit, local, M, OL, poly, pommel, rrect, sparkle, sub, weaponScale, type Ctx, type Joints, type Pose, type Pt, type Ramp } from "./kit";
import { piece, type Mat, type Piece } from "./library";

/**
 * HERO RENDERER v2 — BLADES (weapon space: the hand at the origin, the blade up −y). One builder for every sword and dagger: a blade SHAPE, a
 * GUARD, a grip and a POMMEL, each in its own material. Rarity shows in the construction (a longer, wider, stranger blade, a sculpted guard,
 * a jewel) and, at Epic and Legendary, in a restrained edge light or runes in the rarity colour — never a glow blob.
 */

export type BladeShape = "straight" | "leaf" | "falchion" | "sabre" | "wavy" | "khopesh" | "clip" | "broad" | "tapered" | "kris" | "kukri" | "cleaver" | "needle" | "great";
export type Guard = "cross" | "swept" | "disc" | "knuckle" | "shell" | "wings" | "sun" | "lugs" | "none" | "s" | "ring" | "dragon" | "block";
export type Pommel = "disc" | "ball" | "wheel" | "fishtail" | "ring" | "gem" | "none" | "claw";

export interface BladeSpec {
  len: number;
  /** Half-width of the blade at its base. */
  w: number;
  shape: BladeShape;
  blade: Ramp;
  fuller?: boolean;
  guard: Guard;
  guardMat?: Ramp;
  /** Grip length below the hand (a two-hander's long grip). */
  grip?: number;
  gripMat?: Ramp;
  pommel?: Pommel;
  pommelMat?: Ramp;
  jewel?: Ramp;
  /** Edge light / runes in this material (Epic+: the rarity colour). */
  runes?: Mat;
  /** A brighter edge line (the blade's own highlight is always drawn). */
  edgeGlow?: Mat;
  /** Scale of the whole weapon (daggers ≈ 0.55). */
  scale?: number;
}

/** The blade's outline (sub-path) from the guard (y = −2) to the tip (y = −2 − len). */
function bladePath(g: Ctx, s: BladeSpec): void {
  const L = s.len;
  const w = s.w;
  const y0 = -2;
  const tip = y0 - L;
  switch (s.shape) {
    case "leaf":
      g.moveTo(-w * 0.8, y0);
      g.quadraticCurveTo(-w * 1.5, y0 - L * 0.55, 0, tip);
      g.quadraticCurveTo(w * 1.5, y0 - L * 0.55, w * 0.8, y0);
      g.closePath();
      break;
    case "falchion":
      // a single edge that widens toward a clipped point (the back is straight)
      sub(g, [[-w, y0], [w, y0], [w * 1.9, y0 - L * 0.78], [w * 0.6, tip], [-w, y0 - L * 0.88]]);
      break;
    case "sabre":
      g.moveTo(-w, y0);
      g.quadraticCurveTo(-w * 0.6 + L * 0.14, y0 - L * 0.6, L * 0.2, tip);
      g.quadraticCurveTo(w + L * 0.12, y0 - L * 0.55, w, y0);
      g.closePath();
      break;
    case "wavy": {
      const n = 6;
      g.moveTo(-w, y0);
      for (let i = 1; i <= n; i++) {
        const y = y0 - (L * 0.86 * i) / n;
        g.lineTo(-w + (i % 2 ? -0.7 : 0.5) * (1 - i / (n + 2)), y);
      }
      g.lineTo(0, tip);
      for (let i = n; i >= 1; i--) {
        const y = y0 - (L * 0.86 * i) / n;
        g.lineTo(w + (i % 2 ? 0.7 : -0.5) * (1 - i / (n + 2)), y);
      }
      g.lineTo(w, y0);
      g.closePath();
      break;
    }
    case "khopesh":
      // straight, then a deep forward sickle
      g.moveTo(-w * 0.8, y0);
      g.lineTo(-w * 0.8, y0 - L * 0.45);
      g.bezierCurveTo(-w * 1.6, y0 - L * 0.95, L * 0.32, tip - 1, L * 0.42, y0 - L * 0.62);
      g.quadraticCurveTo(L * 0.1, y0 - L * 0.72, w * 0.8, y0 - L * 0.42);
      g.lineTo(w * 0.8, y0);
      g.closePath();
      break;
    case "clip":
      sub(g, [[-w, y0], [w, y0], [w, y0 - L * 0.74], [w * 0.2, tip], [-w, y0 - L * 0.82]]);
      break;
    case "broad":
      sub(g, [[-w, y0], [w, y0], [w * 1.05, y0 - L * 0.82], [0, tip], [-w * 1.05, y0 - L * 0.82]]);
      break;
    case "tapered":
    case "needle":
      sub(g, [[-w, y0], [w, y0], [w * 0.35, y0 - L * 0.92], [0, tip], [-w * 0.35, y0 - L * 0.92]]);
      break;
    case "great":
      // a ricasso, parrying lugs' notch, then a long wide blade
      sub(g, [[-w * 0.7, y0], [w * 0.7, y0], [w * 0.7, y0 - L * 0.16], [w * 1.1, y0 - L * 0.2], [w, y0 - L * 0.86], [0, tip], [-w, y0 - L * 0.86], [-w * 1.1, y0 - L * 0.2], [-w * 0.7, y0 - L * 0.16]]);
      break;
    case "kris": {
      const n = 5;
      g.moveTo(-w, y0);
      for (let i = 1; i <= n; i++) g.lineTo(-w * 0.7 + Math.sin((i / n) * Math.PI * 2.5) * w * 0.7, y0 - (L * 0.85 * i) / n);
      g.lineTo(0, tip);
      for (let i = n; i >= 1; i--) g.lineTo(w * 0.7 + Math.sin((i / n) * Math.PI * 2.5) * w * 0.7, y0 - (L * 0.85 * i) / n);
      g.lineTo(w, y0);
      g.closePath();
      break;
    }
    case "kukri":
      g.moveTo(-w * 0.7, y0);
      g.quadraticCurveTo(-w * 0.4, y0 - L * 0.5, L * 0.28, tip);
      g.quadraticCurveTo(w * 2.4, y0 - L * 0.5, w * 0.8, y0);
      g.closePath();
      break;
    case "cleaver":
      sub(g, [[-w * 0.6, y0], [w * 0.8, y0], [w * 2.2, y0 - L * 0.3], [w * 2.2, tip + 1], [-w * 0.6, tip], [-w * 0.6, y0 - L * 0.3]]);
      break;
    default:
      sub(g, [[-w, y0], [w, y0], [w, y0 - L * 0.84], [0, tip], [-w, y0 - L * 0.84]]);
  }
}

function guardDraw(g: Ctx, s: BladeSpec): void {
  const m = s.guardMat ?? M.iron;
  const w = Math.max(s.w, 1.6);
  switch (s.guard) {
    case "cross":
      rrect(g, -w - 3.4, -3.2, (w + 3.4) * 2, 2.2, 0.8, m.base, 0.9);
      line(g, [-w - 2.8, -2.8], [w + 2.8, -2.8], 0.5, m.hi);
      break;
    case "swept":
      cord(g, () => {
        g.beginPath();
        g.moveTo(-w - 4.4, -6);
        g.quadraticCurveTo(-w - 2.6, -1.8, 0, -2.2);
        g.quadraticCurveTo(w + 2.6, -1.8, w + 4.4, -6);
      }, 1.6, m.base);
      circle(g, -w - 4.4, -6, 0.9, m.hi, 0.6);
      circle(g, w + 4.4, -6, 0.9, m.hi, 0.6);
      break;
    case "disc":
      rrect(g, -w - 1.8, -3.4, (w + 1.8) * 2, 2.2, 1.1, m.base, 0.9);
      break;
    case "knuckle":
      rrect(g, -w - 2.6, -3, (w + 2.6) * 2, 1.8, 0.7, m.base, 0.8);
      cord(g, () => {
        g.beginPath();
        g.moveTo(w + 2.4, -2.6);
        g.quadraticCurveTo(w + 4.4, 2, 1.4, 5.4);
      }, 1.1, m.base);
      break;
    case "shell":
      lit(g, () => {
        g.moveTo(-w - 3.6, -2);
        g.quadraticCurveTo(0, -6.4, w + 3.6, -2);
        g.quadraticCurveTo(0, 0.8, -w - 3.6, -2);
        g.closePath();
      }, m, { shadow: [0.6, -0.6] });
      break;
    case "wings":
      for (const sg of [-1, 1]) {
        lit(g, () => sub(g, [[0, -2], [sg * (w + 1.6), -3.4], [sg * (w + 6.6), -7.6], [sg * (w + 5.4), -4.2], [sg * (w + 6.4), -3.4], [sg * (w + 2), -1]]), m, { shadow: [0.5, -0.5] });
      }
      break;
    case "sun":
      for (let i = 0; i < 9; i++) {
        const a = Math.PI * (1 + i / 8);
        line(g, [Math.cos(a) * 2, -2.6 + Math.sin(a) * 2], [Math.cos(a) * (w + 4.6), -2.6 + Math.sin(a) * (w + 3.4)], 1.2, i % 2 ? m.lo : m.base);
      }
      circle(g, 0, -2.6, 2.2, m.hi, 0.8);
      break;
    case "lugs":
      rrect(g, -w - 4, -3.2, (w + 4) * 2, 2, 0.8, m.base, 0.9);
      poly(g, [[-w - 0.6, -2 - s.len * 0.18], [-w - 2.4, -2 - s.len * 0.2], [-w - 0.6, -2 - s.len * 0.23]], m.base, 0.7);
      poly(g, [[w + 0.6, -2 - s.len * 0.18], [w + 2.4, -2 - s.len * 0.2], [w + 0.6, -2 - s.len * 0.23]], m.base, 0.7);
      break;
    case "s":
      cord(g, () => {
        g.beginPath();
        g.moveTo(-w - 3.6, 0.2);
        g.bezierCurveTo(-w - 2, -4.4, w + 2, -0.6, w + 3.6, -4.6);
      }, 1.4, m.base);
      break;
    case "ring":
      rrect(g, -w - 1.4, -3, (w + 1.4) * 2, 1.6, 0.6, m.base, 0.8);
      g.strokeStyle = OL;
      g.lineWidth = 2.2;
      g.beginPath();
      g.arc(-w - 2.4, -2.2, 1.4, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = m.base;
      g.lineWidth = 1;
      g.stroke();
      break;
    case "dragon":
      for (const sg of [-1, 1]) {
        lit(g, () => sub(g, [[0, -1.4], [sg * (w + 2.4), -4.2], [sg * (w + 7), -3.4], [sg * (w + 4.6), -1.8], [sg * (w + 6.6), 0.6], [sg * (w + 2.2), -0.2]]), m, { shadow: [0.5, -0.5] });
      }
      gem(g, 0, -2.6, 1.6, s.jewel ?? M.ruby);
      break;
    case "block":
      rrect(g, -w - 1.6, -4, (w + 1.6) * 2, 3, 0.6, m.base, 0.9);
      line(g, [-w - 1, -3.4], [w + 1, -3.4], 0.5, m.hi);
      break;
    default:
      break;
  }
}

function pommelDraw(g: Ctx, s: BladeSpec): void {
  const gl = s.grip ?? 5;
  const m = s.pommelMat ?? s.guardMat ?? M.iron;
  const y = gl + 0.6;
  switch (s.pommel ?? "disc") {
    case "ball":
      pommel(g, y + 0.4, 1.5, m);
      break;
    case "wheel":
      pommel(g, y + 0.6, 1.9, m);
      circle(g, 0, y + 0.6, 0.7, m.lo, 0);
      break;
    case "fishtail":
      poly(g, [[0, y - 0.6], [2.4, y + 2], [0, y + 1.2], [-2.4, y + 2]], m.base, 0.8);
      break;
    case "ring":
      g.strokeStyle = OL;
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(0, y + 1.4, 1.6, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = m.base;
      g.lineWidth = 1.1;
      g.stroke();
      break;
    case "gem":
      pommel(g, y + 0.6, 1.8, m, s.jewel ?? M.ruby);
      break;
    case "claw":
      poly(g, [[-1.6, y - 0.6], [1.6, y - 0.6], [2, y + 1.6], [0, y + 2.8], [-2, y + 1.6]], m.base, 0.8);
      gem(g, 0, y + 1, 1, s.jewel ?? M.ruby);
      break;
    case "none":
      break;
    default:
      ellipse2(g, y + 0.5, m);
  }
}

function ellipse2(g: Ctx, y: number, m: Ramp): void {
  g.beginPath();
  g.ellipse(0, y, 1.8, 1.3, 0, 0, Math.PI * 2);
  g.fillStyle = m.base;
  g.fill();
  g.strokeStyle = OL;
  g.lineWidth = 0.8;
  g.stroke();
}

/** Draws one blade in weapon space (no transform). */
export function drawBlade(g: Ctx, s: BladeSpec): void {
  const k = s.scale ?? 1;
  g.scale(k, k);
  const gl = s.grip ?? 5;
  grip(g, -0.8, gl, 2.2, s.gripMat ?? M.leather);
  pommelDraw(g, s);
  lit(g, () => bladePath(g, s), s.blade, {
    shadow: [-1.2, 0],
    hi: () => {
      g.rect(-s.w * 0.15, -3 - s.len * 0.82, s.w * 0.7, s.len * 0.8);
    },
  });
  if (s.fuller) line(g, [-0.2, -3.6], [-0.2, -2 - s.len * 0.72], 0.7, s.blade.lo);
  guardDraw(g, s);
}

/** Draws the rarity edge light / runes of a blade (its own material layer). */
function drawBladeRunes(g: Ctx, s: BladeSpec, r: Ramp, kind: "runes" | "edge"): void {
  const k = s.scale ?? 1;
  g.scale(k, k);
  if (kind === "edge") {
    // a lit line along the cutting edge, a glint at the tip
    line(g, [s.w * 0.75, -3], [s.w * 0.55, -2 - s.len * 0.82], 0.9, r.hi);
    sparkle(g, 0, -2 - s.len + 1.4, 2.2, r.hi);
    return;
  }
  for (let i = 0; i < 4; i++) {
    const y = -5 - i * (s.len * 0.18);
    poly(g, [[-0.8, y], [0.6, y - 1], [0, y - 2], [-0.6, y - 1.2]], r.base, 0.5);
  }
}

/**
 * A blade as the archetype carries it: a brute's design is a GREATSWORD (longer, wider, a two-hand grip), a duelist's a lighter blade, a long
 * knife in an assassin's hand — the same design, the archetype's proportions.
 */
export function sizedBlade(s: BladeSpec, j: Joints): BladeSpec {
  const k = weaponScale(j);
  if (k.len === 1 && k.w === 1 && !k.grip) return s;
  return { ...s, len: s.len * k.len, w: s.w * k.w, grip: Math.max(s.grip ?? 5, k.grip ?? 0) };
}

/** How far a two-handed grip slides the front hand toward the pommel (the back hand takes the grip above it). */
const holdShift = (s: BladeSpec, j: Joints): number => (weaponScale(j).hold ?? 0) * (s.grip ?? 5);

/** The pieces of a sword held in the FRONT hand (both hands, on a two-handed archetype: the back hand holds the grip above it). */
export function blade(s: BladeSpec): Piece[] {
  const held = (fn: (g: Ctx, t: BladeSpec) => void) => (g: Ctx, j: Joints) =>
    inWeaponSpace(g, j.handF, j, () => {
      const t = sizedBlade(s, j);
      g.translate(0, -holdShift(t, j));
      fn(g, t);
    });
  const out: Piece[] = [piece(70, s.blade, (g, _p, j) => held((c, t) => drawBlade(c, t))(g, j))];
  if (s.runes) out.push(piece(70, s.runes, (g, _p, j, r) => held((c, t) => drawBladeRunes(c, t, r, "runes"))(g, j)));
  if (s.edgeGlow) out.push(piece(70, s.edgeGlow, (g, _p, j, r) => held((c, t) => drawBladeRunes(c, t, r, "edge"))(g, j)));
  return out;
}

/** A PAIR of blades (the Rogue's): one in each hand, the back one held reversed along the forearm. */
export function bladePair(s: BladeSpec): Piece[] {
  const both = (fn: (g: Ctx, r: Ramp, t: BladeSpec) => void) => (g: Ctx, _p: Pose, j: Joints, r: Ramp) => {
    const t = sizedBlade(s, j);
    local(g, j.handB, axisAngleB(j), () => fn(g, r, t));
    inWeaponSpace(g, j.handF, j, () => fn(g, r, t));
  };
  const out: Piece[] = [piece(70, s.blade, both((g, _r, t) => drawBlade(g, t)))];
  if (s.runes) out.push(piece(70, s.runes, both((g, r, t) => drawBladeRunes(g, t, r, "runes"))));
  if (s.edgeGlow) out.push(piece(70, s.edgeGlow, both((g, r, t) => drawBladeRunes(g, t, r, "edge"))));
  return out;
}

/** The tip of a blade in weapon space (for tests / muzzles). */
export const bladeTip = (s: BladeSpec): Pt => [0, (-2 - s.len) * (s.scale ?? 1)];
