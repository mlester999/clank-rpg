import { stamp, TAG } from "./gbuffer";
import type { RGB } from "./color";
import { GROUP, headPoint, type BodyIds } from "./body";
import type { Eyes, Mouth, Pose, Skeleton } from "./rig";
import { MAT } from "./materials";
import { sub, type V3 } from "./vec";
import type { Painter } from "./view";

/**
 * HERO RENDERER v3 — the FACE: pixel features on a head-local coordinate system.
 *
 * At battle size a face is a dozen pixels across; drawn as tiny vector shapes it becomes noise. Here every feature is a hand-designed pixel
 * STAMP (an eye is 1×2 or 2×2 pixels, a mouth two or three) placed at an ANCHOR on the head — a point on the face surface in head-local
 * coordinates (eye line, mouth line, nose tip), projected through the same camera as the body. So the features turn and tilt with the head,
 * keep their spacing, and can never land outside it: a stamp pixel is written only where the head's own skin already is (an eye cannot float
 * off the head, and a hand or weapon in front of the face simply covers it). Spacing rules keep the two eyes apart by a skin pixel and
 * keep the mouth below the nose.
 */

export interface FaceStyle {
  /** Stored identity traits: eyes.0–3, mouth.0–2. */
  eyes: number;
  mouth: number;
  /** Brow thickness: 0 thin … 1 heavy. */
  brow: number;
  browColor: RGB;
  skinDeep: RGB;
  skinLo: RGB;
  lip: RGB;
  darkSkin: boolean;
}

export interface FaceResult {
  /** Screen pixels of the eye stamps (for validation): where, and how many of the stamp's pixels actually landed on the face. */
  eyes: Array<{ x: number; y: number; w: number; h: number; drawn: number; expected: number }>;
  /** Eyes the face meant to show (2, or 1 when the far eye is turned away). */
  eyesWanted: number;
  mouth: { x: number; y: number; w: number; h: number } | null;
  /** Head-facing visible at all (a fallen hero face-down shows none). */
  visible: boolean;
}

const PUPIL = 0x1c1826;

type Stamp = readonly string[];

/**
 * Eye stamps for the authored three-quarter view (hero facing right): [near eye, far eye]. `p` pupil, `w` white of the eye, `l` lid (skin
 * deep). On dark skin the near eye always shows its white (a dark pupil on dark skin disappears at battle size).
 */
function eyeStamps(style: number, expr: Eyes, darkSkin: boolean): [Stamp, Stamp] {
  switch (expr) {
    case "hurt":
      return [["p.", ".p"], ["p"]];
    case "closed":
      return [["ll"], ["l"]];
    case "dead":
      return [["p.p", ".p."], ["p"]];
    case "cheer":
      return [[".p", "p."], ["p"]];
    case "wide":
      return [["wp", "wp"], ["p", "p"]];
    case "focus":
    case "fierce":
      return [darkSkin ? ["wp"] : ["pp"], ["p"]];
    default:
      break;
  }
  switch (style % 4) {
    case 1: // Wide: the white of the eye behind the pupil
      return [["wp", "wp"], ["p", "p"]];
    case 2: // Calm: heavy lids over the pupils
      return [darkSkin ? ["lw", "wp"] : ["ll", "pp"], ["l", "p"]];
    case 3: // Sly: narrowed
      return [darkSkin ? ["wp"] : ["pp"], ["p"]];
    default: // Round
      return [darkSkin ? ["wp", ".p"] : ["p", "p"], ["p", "p"]];
  }
}

/** Mouth stamps (3/4 view): `m` mouth line (deep skin), `d` dark interior, `r` tongue. */
function mouthStamp(style: number, expr: Mouth): Stamp {
  switch (expr) {
    case "open":
      return ["dd"];
    case "shout":
      return ["dd", "dd"];
    case "grit":
      return ["mmm"];
    case "hurt":
      return [".m.", "m.m"];
    case "o":
      return ["d"];
    case "smile":
      return ["m..", ".mm"];
    default:
      break;
  }
  switch (style % 3) {
    case 0: // Smile: the back corner raised
      return ["m.", ".m"];
    case 2: // Grin: wide
      return ["mmm"];
    default: // Flat
      return ["mm"];
  }
}

/** Visible when the face side of the head looks toward the camera. */
function facing(pt: Painter, sk: Skeleton): number {
  return pt.D(sk.head.x)[2];
}

export function drawFace(pt: Painter, sk: Skeleton, pose: Pose, ids: BodyIds, st: FaceStyle, opts: { browVisible: boolean; mouthVisible: boolean; visor?: { kind: "slit" | "T"; part: number; glint: number }; monocle?: RGB }): FaceResult {
  const res: FaceResult = { eyes: [], eyesWanted: 0, mouth: null, visible: false };
  if (facing(pt, sk) < 0.12) return res;
  res.visible = true;
  const face = pt.part("face", MAT.shadow, GROUP.HEAD, TAG.FACE);
  const eyePart = pt.part("eyes", MAT.shadow, GROUP.HEAD, TAG.EYE);
  const visor = opts.visor;
  // under a closed visor the "face" the features land on is the helm itself
  const on = visor ? new Set([visor.part]) : ids.faceSkin;
  const g = pt.g;
  const P = (p: V3) => pt.P(p);

  // ---- eyes: anchors on the eye line, then pixel rules — a skin pixel between the eyes, and EVERY pupil pixel on the face's own skin
  const eN = P(headPoint(sk, 0.82, -0.1, 0.33));
  const eF = P(headPoint(sk, 0.82, -0.1, -0.33));
  const [sN, sF] = visor ? ([["g"], ["g"]] as [Stamp, Stamp]) : eyeStamps(st.eyes, pose.eyes, st.darkSkin);
  const wN = Math.max(...sN.map((r) => r.length));
  const wF = Math.max(...sF.map((r) => r.length));
  const row = Math.round((eN[1] + eF[1]) / 2 - 0.5 - (sN.length > 1 ? 0.5 : 0));
  let xN = Math.round(eN[0] - wN / 2);
  let xF = Math.round(eF[0] - wF / 2);
  const leftToRight = xN <= xF; // the near eye is left of the far eye in the right-facing view
  if (leftToRight && xF < xN + wN + 1) xN = xF - wN - 1;
  if (!leftToRight && xN < xF + wF + 1) xF = xN - wF - 1;
  const isSkin = (x: number, y: number) => on.has(g.partAt(x, y));
  const fits = (x: number, st0: Stamp) => st0.every((r, dy) => [...r].every((ch, dx) => ch === "." || ch === " " || isSkin(x + dx, row + dy)));
  // shift the pair as one (toward the middle of the face) until both stamps sit on skin; else keep the near eye alone (a near-profile head)
  const inward = leftToRight ? -1 : 1;
  let farVisible = true;
  let placed = false;
  for (let k = 0; k <= 2 && !placed; k++) {
    if (fits(xN + inward * k, sN) && fits(xF + inward * k, sF)) {
      xN += inward * k;
      xF += inward * k;
      placed = true;
    }
  }
  if (!placed) {
    farVisible = false;
    for (let k = 0; k <= 2; k++) if (fits(xN + inward * k, sN)) {
      xN += inward * k;
      break;
    }
  }
  // keep the far eye one pixel off the face edge when there is room (the nose bump takes that pixel)
  if (farVisible && leftToRight && !isSkin(xF + wF, row + sF.length - 1) && xF - 1 > xN + wN && fits(xF - 1, sF)) xF -= 1;
  const pal: Record<string, RGB> = { p: PUPIL, w: MAT.eyeWhite.ramp[2], l: st.skinDeep, h: 0xffffff, g: visor?.glint ?? 0xffffff };
  if (visor) {
    // the slit: a dark band across both eyes (one pixel past each), a T's slot down to the mouth line; the glints go on top of it
    const x0 = Math.min(xN, xF) - 1;
    const x1 = Math.max(xN + wN, xF + wF);
    stamp(g, x0, row, ["v".repeat(x1 - x0 + 1)], { v: PUPIL }, face, on, 0.04);
    if (visor.kind === "T") {
      const mid = leftToRight ? xN + wN : xF + wF;
      stamp(g, mid, row + 1, ["v", "v", "v"], { v: PUPIL }, face, on, 0.04);
    }
  }
  const count = (st0: Stamp) => st0.join("").replace(/[. ]/g, "").length;
  const glintOn = visor ? new Set([visor.part, face]) : on;
  const nN = stamp(g, xN, row, sN, pal, eyePart, visor ? glintOn : on, 0.06);
  res.eyes.push({ x: xN, y: row, w: wN, h: sN.length, drawn: nN, expected: count(sN) });
  res.eyesWanted = farVisible ? 2 : 1;
  if (farVisible) {
    const nF = stamp(g, xF, row, sF, pal, eyePart, visor ? glintOn : on, 0.06);
    res.eyes.push({ x: xF, y: row, w: wF, h: sF.length, drawn: nF, expected: count(sF) });
  }

  if (visor) return res;
  // ---- the monocle (stored accessory): a ring of trim metal AROUND the near eye — on the skin beside it, never over the eye itself
  if (opts.monocle !== undefined) {
    const inner = ".".repeat(wN);
    const rows = [`.${"m".repeat(wN)}.`, ...sN.map(() => `m${inner}m`), `.${"m".repeat(wN)}.`];
    stamp(g, xN - 1, row - 1, rows, { m: opts.monocle }, pt.part("monocle", MAT.shadow, GROUP.HEAD, TAG.FACE), on, 0.07);
  }
  // ---- brows: one row above the eyes (two for raised), in the hair's dark tone; knit brows slant down toward the nose
  if (opts.browVisible) {
    const by = row - 2 + (pose.brow > 0.5 ? -1 : 0);
    const knit = pose.brow < -0.3 || pose.eyes === "fierce" || pose.eyes === "focus";
    const bc: Record<string, RGB> = { b: st.browColor };
    const nearBrow: Stamp = knit ? ["b.", ".b"] : st.brow > 0.5 ? ["bb"] : ["bb"];
    const farBrow: Stamp = knit ? ["b"] : ["b"];
    stamp(g, xN - (knit ? 0 : 0), knit ? by : by + (pose.brow > 0.5 ? 0 : 0), nearBrow, bc, face, on, 0.05);
    if (farVisible) stamp(g, xF, by, farBrow, bc, face, on, 0.05);
  }

  // ---- mouth: anchored on the mouth line, never above the row under the nose
  if (opts.mouthVisible) {
    const m = P(headPoint(sk, 0.86, -0.6, 0));
    const ms = mouthStamp(st.mouth, pose.mouth);
    const mw = Math.max(...ms.map((r) => r.length));
    let my = Math.round(m[1] - 0.5);
    const minRow = row + Math.max(sN.length, 2) + 1;
    if (my < minRow) my = minRow;
    const mx = Math.round(m[0] - mw / 2 - 0.5 + (leftToRight ? 0.5 : -0.5));
    const mp: Record<string, RGB> = { m: st.lip, d: 0x3a1822, t: 0xf3efe6, r: 0xc85a5a };
    const n = stamp(g, mx, my, ms, mp, face, on, 0.05);
    if (n) res.mouth = { x: mx, y: my, w: mw, h: ms.length };
  }

  // ---- nose: one shade pixel under the nose tip (the volume itself makes the bump on the profile)
  const nz = P(headPoint(sk, 0.98, -0.38, 0));
  const nx = Math.round(nz[0] - 0.5);
  const ny = Math.round(nz[1] - 0.5);
  stamp(g, nx - 1, ny, ["n"], { n: st.skinLo }, face, new Set([ids.nose, ids.jaw, ids.head]), 0.02);
  void sub;
  return res;
}
