import { GROUP } from "../body";
import { TAG, type Material } from "../gbuffer";
import { part, shell, type Build, type LocalClip } from "../kit";
import { material, MAT } from "../materials";
import { add, mul, norm, type V3 } from "../vec";
import { fp } from "../view";

/**
 * HERO RENDERER v3 — HEADGEAR: helms, hats, hoods, caps, halos and crowns, all built in the head's coordinates (head radii).
 *
 * A helm is a shell over the cranium with a FACE OPENING cut by rule — never by a pixel offset: an open helm stops above the brow line and
 * clears the whole face; cheek guards cover the sides of the face but not the eyes; a T-visor leaves the eye band and the nose-mouth channel
 * open; a closed slit visor leaves the eye band. Because the opening is defined relative to the eye line, a helm can never cover the eyes by
 * accident, on any head, in any pose. Brims sit above the brow line (checked against the camera's pitch).
 */

export type FaceCut = "open" | "cheeks" | "T" | "slit" | "none";
export type Crest = "plume" | "wings" | "horns" | "crown" | "ridge" | "spike" | "fins" | null;

export interface HelmSpec {
  dome: "round" | "cone" | "tall" | "flat";
  mat: Material;
  trim: Material | null;
  face: FaceCut;
  coif: Material | null;
  brim: number;
  nasal: boolean;
  crest: Crest;
  crestMat: Material | null;
  bevor: boolean;
  tail: boolean;
}

/** What the face shows under a helm (the face builder reads it). */
export interface HeadCover {
  hairVisible: boolean;
  hairBack: boolean;
  browVisible: boolean;
  mouthVisible: boolean;
  ears: boolean;
  beard: boolean;
  /** A hood: the hair shows only through the face opening (a fringe, and a lock for long hair). */
  hairFringe?: boolean;
  /**
   * A CLOSED visor (great helm): the face builder stamps the visor's slit (and a T's nose-mouth slot) and two eye glints ON the helm at the
   * eye line — the eyes read as lights in the dark slit, by design. `part` is the helm's part (the stamps land only on it).
   */
  visor?: { kind: "slit" | "T"; part: number; glint: number };
}

/** The face opening rule for a cut: true = the helm is KEPT at this head-local point (head radii). */
function keepRule(cut: FaceCut): (x: number, y: number, z: number) => boolean {
  const az = (z: number) => Math.abs(z);
  switch (cut) {
    case "open":
      return (x, y, z) => !(x > -0.25 && y < 0.3) && y > -0.12 - (x < -0.3 ? 0.25 : 0) - (az(z) > 0.7 && x < 0.1 ? 0.1 : 0);
    case "cheeks":
      // cheek guards cover the sides of the face BELOW the eye line; the eye band stays open
      return (x, y, z) => {
        if (y < -0.62 - (x < -0.3 ? 0.3 : 0)) return false;
        if (x > -0.25 && y < 0.3) return az(z) > 0.6 && x < 0.55 && y > -0.62 && y < -0.32;
        return true;
      };
    case "T":
    case "slit":
      // closed: the visor slit is stamped on the helm at the eye line (face.ts), so it can never miss the eyes
      return (_x, y) => y > -0.95;
    default:
      return () => true;
  }
}

function coverOf(spec: HelmSpec, helmPart: number): HeadCover {
  const closed = spec.face === "T" || spec.face === "slit";
  return {
    ...(closed ? { visor: { kind: spec.face as "slit" | "T", part: helmPart, glint: spec.crest === "crown" || spec.crest === "plume" ? 0xffd27a : 0xd8e2f0 } } : {}),
    hairVisible: false,
    hairBack: spec.face === "open" && !spec.coif,
    browVisible: !closed && !spec.coif && spec.face !== "cheeks",
    mouthVisible: spec.face !== "slit" && !spec.bevor,
    ears: false,
    beard: !closed && !spec.bevor,
  };
}

export function drawHelm(b: Build, spec: HelmSpec): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const keep = keepRule(spec.face);
  const hp = part(b, "helm", spec.mat, GROUP.HELM, TAG.HELM);
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const rule = (k: (x: number, y: number, z: number) => boolean): LocalClip => (x, y, z) => k(x / R, y / R, z / R);
  // the mail coif first (under the helm): head, cheeks and neck, face open
  if (spec.coif) {
    const cp = part(b, "coif", spec.coif, GROUP.HELM, TAG.HELM);
    shell(b, h, [-0.06 * R, -0.12 * R, 0], [1.06 * R, 1.1 * R, 1.02 * R], cp, rule((x, y, z) => !(x > -0.2 && y < 0.34 && y > -0.95 && Math.abs(z) < 0.84) && y > -1.2), { zBias: 0.2 });
    // the coif's drape over the neck and shoulders
    b.pt.capsule(at(-0.2, -0.95, 0), at(-0.35, -1.5, 0), 0.7 * R, 0.78 * R, cp, { zBias: -0.1, clip: undefined });
  }
  const dome: V3 = spec.dome === "tall" ? [1.1, 1.2, 1.05] : spec.dome === "flat" ? [1.12, 1.02, 1.08] : [1.1, 1.1, 1.05];
  const c: V3 = [-0.04 * R, spec.dome === "tall" ? 0.1 * R : 0.04 * R, 0];
  shell(b, h, c, [dome[0] * R, dome[1] * R, dome[2] * R], hp, rule((x, y, z) => keep(x + c[0] / R, y + c[1] / R, z)), { zBias: 0.35 });
  if (spec.dome === "cone") b.pt.capsule(at(-0.06, 0.62, 0), at(-0.16, 1.42, 0), 0.62 * R, 0.1 * R, hp, { zBias: 0.4 });
  if (spec.tail) shell(b, h, [-0.55 * R, -0.25 * R, 0], [0.75 * R, 0.6 * R, 0.95 * R], hp, rule((x, y) => x < -0.1 && y > -0.75), { zBias: 0.3 });
  // a trim band at the rim (brass / gold) — the line where the helm meets the brow
  if (spec.trim) {
    const tp = part(b, "helmTrim", spec.trim, GROUP.HELM, TAG.HELM);
    shell(b, h, c, [dome[0] * R * 1.04, dome[1] * R * 1.04, dome[2] * R * 1.04], tp, rule((x, y, z) => keep(x, y, z) && y > 0.28 && y < 0.48), { zBias: 0.45 });
  }
  if (spec.brim > 0) {
    const bp = part(b, "brim", spec.mat, GROUP.HELM, TAG.HELM);
    // the brim sits above the brow line (its front edge, seen from above, must still clear the eyes)
    b.pt.blob(h, [-0.05 * R, 0.5 * R, 0], spec.brim * R, 0.12 * R, spec.brim * R * 0.98, bp, { zBias: 0.5 });
  }
  if (spec.nasal) {
    const np = part(b, "nasal", spec.trim ?? spec.mat, GROUP.HELM, TAG.HELM);
    b.pt.line(at(1.02, 0.36, 0), at(1.06, -0.3, 0), 1, np, [0.5, 0.4, 0.75], { zBias: 0.6 });
  }
  if (spec.bevor) {
    // a plate guarding chin and throat, up to just under the nose
    const bp = part(b, "bevor", spec.mat, GROUP.HELM, TAG.HELM);
    shell(b, h, [0.15 * R, -0.62 * R, 0], [0.98 * R, 0.62 * R, 0.98 * R], bp, rule((x, y) => y < -0.42 && x > -0.5), { zBias: 0.55 });
    b.pt.capsule(at(0.05, -0.95, 0), at(-0.05, -1.45, 0), 0.75 * R, 0.85 * R, bp, { zBias: 0.1 });
  }
  if (spec.crest) drawCrest(b, spec.crest, spec.crestMat ?? spec.trim ?? MAT.gold, spec);
  return coverOf(spec, hp);
}

function drawCrest(b: Build, crest: Exclude<Crest, null>, mat: Material, spec: HelmSpec): void {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const cp = part(b, "crest", mat, GROUP.HELM, TAG.HELM);
  const top = spec.dome === "tall" ? 1.28 : 1.12;
  const sway = b.pose.sway;
  switch (crest) {
    case "plume": {
      // a feather plume rising from the crown and arching back, swaying
      const pts: V3[] = [[0.15, top, 0], [-0.2, top + 0.42, 0], [-0.7, top + 0.38, 0], [-1.1 - sway * 0.04, top + 0.05, 0], [-1.3 - sway * 0.06, top - 0.38, 0]];
      for (let i = 0; i < pts.length - 1; i++) b.pt.capsule(at(...(pts[i] as V3)), at(...(pts[i + 1] as V3)), (0.3 - i * 0.04) * R, (0.27 - i * 0.04) * R, cp, { zBias: 0.4 });
      break;
    }
    case "ridge":
      b.pt.blob(h, [-0.1 * R, top * R - 0.1 * R, 0], 0.95 * R, 0.32 * R, 0.13 * R, cp, { zBias: 0.4 });
      break;
    case "spike":
      b.pt.capsule(at(-0.05, top - 0.1, 0), at(-0.1, top + 0.55, 0), 0.22 * R, 0.04 * R, cp, { zBias: 0.4 });
      break;
    case "horns":
      for (const s of [1, -1]) {
        b.pt.capsule(at(0.0, 0.45, s * 0.95), at(0.05, 0.85, s * 1.45), 0.26 * R, 0.17 * R, cp, { zBias: 0.4 });
        b.pt.capsule(at(0.05, 0.85, s * 1.45), at(0.3, 1.42, s * 1.55), 0.17 * R, 0.04 * R, cp, { zBias: 0.4 });
      }
      break;
    case "wings":
      for (const s of [1, -1]) {
        const base = at(-0.1, 0.4, s * 1.0);
        const pts: V3[] = [base, at(-0.15, 1.45, s * 1.12), at(-0.75, 1.15, s * 1.1), at(-1.05, 0.55, s * 1.02), at(-0.55, 0.3, s * 1.0)];
        b.pt.plate(pts, norm(mul(h.z, s)), cp, { zBias: 0.4, bulge: 0.35 });
      }
      break;
    case "fins":
      b.pt.plate([at(0.35, top - 0.05, 0), at(-0.2, top + 0.55, 0), at(-0.95, top + 0.35, 0), at(-1.05, top - 0.25, 0)], h.z, cp, { zBias: 0.45, bulge: 0.2 });
      break;
    case "crown": {
      const band = part(b, "crownBand", mat, GROUP.HELM, TAG.HELM);
      shell(b, h, [-0.04 * R, 0.04 * R, 0], [1.14 * R, 1.14 * R, 1.09 * R], band, (x, y) => y / R > 0.3 && y / R < 0.56, { zBias: 0.5 });
      for (const a of [-0.9, -0.3, 0.3, 0.9, 1.5, 2.1, 2.7, 3.3]) {
        const x = Math.cos(a) * 1.0;
        const z = Math.sin(a) * 0.98;
        b.pt.capsule(at(x, 0.5, z), at(x * 0.97, 0.95, z * 0.97), 0.16 * R, 0.05 * R, band, { zBias: 0.5 });
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------- hats, hoods, caps

/** A wizard's hat: a brim above the brow line and a tall cone that bends back; a band in the secondary colour. */
export function drawWizardHat(b: Build, o: { mat: Material; band: Material; height: number; bend: number; brim: number; emblem: Material | null }): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const hp = part(b, "hat", o.mat, GROUP.HELM, TAG.HELM);
  const bp = part(b, "hatBand", o.band, GROUP.HELM, TAG.HELM);
  // crown of the hat hugging the skull above the brows
  shell(b, h, [-0.04 * R, 0.05 * R, 0], [1.08 * R, 1.08 * R, 1.04 * R], hp, (_x, y) => y / R > 0.3, { zBias: 0.35 });
  b.pt.blob(h, [0.02 * R, 0.5 * R, 0], o.brim * R, 0.14 * R, o.brim * R * 0.96, hp, { zBias: 0.45 });
  shell(b, h, [-0.04 * R, 0.05 * R, 0], [1.11 * R, 1.11 * R, 1.07 * R], bp, (_x, y) => y / R > 0.5 && y / R < 0.78, { zBias: 0.5 });
  const sway = b.pose.sway * 0.05;
  const base = at(-0.06, 0.7, 0);
  const mid = at(-0.25 - o.bend * 0.5 - sway, 0.7 + o.height * 0.55, 0);
  const tip = at(-0.5 - o.bend - sway * 2, 0.7 + o.height * 0.95, 0);
  b.pt.capsule(base, mid, 0.86 * R, 0.42 * R, hp, { zBias: 0.4 });
  b.pt.capsule(mid, tip, 0.42 * R, 0.07 * R, hp, { zBias: 0.4 });
  if (o.emblem) b.pt.sphere(at(0.72, 0.95, 0.35), 0.2 * R, part(b, "emblem", o.emblem, GROUP.HELM, TAG.HELM), { zBias: 0.6 });
  return { hairVisible: true, hairBack: true, browVisible: true, mouthVisible: true, ears: true, beard: true };
}

/** A hood with its face opening (the face reads; a cloth mask over mouth and nose when `mask`). */
export function drawHood(b: Build, o: { mat: Material; inner: Material; mask: Material | null; point: number; mantle: boolean }): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const hp = part(b, "hood", o.mat, GROUP.HELM, TAG.HELM);
  shell(b, h, [-0.08 * R, 0.02 * R, 0], [1.12 * R, 1.13 * R, 1.08 * R], hp, (x, y, z) => {
    const X = x / R - 0.1;
    const Y = y / R;
    const Z = Math.abs(z / R);
    if (X > 0.0 && Y < 0.42 && Y > -1.05 && Z < 0.82) return false;
    return Y > -1.4;
  }, { zBias: 0.35 });
  // the cowl falling to the shoulders, and the hood's point
  b.pt.capsule(at(-0.4, -0.75, 0), at(-0.6, -1.55, 0), 0.78 * R, 0.86 * R, hp, { zBias: -0.15 });
  if (o.point > 0) b.pt.capsule(at(-0.75, 0.55, 0), at(-1.1 - o.point * 0.5 - b.pose.sway * 0.05, 0.2 - o.point * 0.4, 0), 0.5 * R, 0.08 * R, hp, { zBias: 0.3 });
  if (o.mask) {
    const mp = part(b, "mask", o.mask, GROUP.HELM, TAG.HELM);
    shell(b, h, [0.2 * R, -0.45 * R, 0], [0.82 * R, 0.66 * R, 0.84 * R], mp, (x, y) => y / R - 0.45 < -0.62 && x / R > -0.5, { zBias: 0.4 });
  }
  return { hairVisible: false, hairBack: false, hairFringe: true, browVisible: true, mouthVisible: !o.mask, ears: false, beard: !o.mask };
}

/** A forester's cap: a peak over the brow (above the brow line), a point sweeping back, a feather. */
export function drawCap(b: Build, o: { mat: Material; feather: Material | null; band: Material | null; point: number }): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const cp = part(b, "cap", o.mat, GROUP.HELM, TAG.HELM);
  shell(b, h, [-0.05 * R, 0.08 * R, 0], [1.1 * R, 1.08 * R, 1.05 * R], cp, (x, y) => y / R > 0.34 - (x / R < -0.3 ? 0.18 : 0), { zBias: 0.35 });
  b.pt.blob(h, [0.75 * R, 0.5 * R, 0], 0.6 * R, 0.12 * R, 0.82 * R, cp, { zBias: 0.45 });
  b.pt.capsule(at(-0.45, 0.82, 0), at(-1.1 - o.point * 0.4 - b.pose.sway * 0.05, 0.5 + o.point * 0.1, 0), 0.5 * R, 0.08 * R, cp, { zBias: 0.4 });
  if (o.band) shell(b, h, [-0.05 * R, 0.08 * R, 0], [1.13 * R, 1.11 * R, 1.08 * R], part(b, "capBand", o.band, GROUP.HELM, TAG.HELM), (_x, y) => y / R > 0.36 && y / R < 0.56, { zBias: 0.5 });
  if (o.feather) {
    const fpart = part(b, "feather", o.feather, GROUP.HELM, TAG.HELM);
    b.pt.capsule(at(-0.35, 0.7, -0.75), at(-1.0, 1.7, -0.95), 0.22 * R, 0.06 * R, fpart, { zBias: 0.3 });
  }
  return { hairVisible: true, hairBack: true, browVisible: true, mouthVisible: true, ears: true, beard: true };
}

/** A halo: a ring of light above and behind the head (hair, brows, face all visible). */
export function drawHalo(b: Build, o: { mat: Material; r: number; lift: number; rays: boolean }): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const hp = part(b, "halo", o.mat, GROUP.FX, TAG.FX);
  const c = fp(h, -0.35 * R, (1.0 + o.lift) * R, 0);
  const N = 18;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    const p0 = add(c, [Math.cos(a0) * o.r * R * 0.85, Math.sin(a0) * o.r * R * 0.22, Math.sin(a0 + 0.3) * o.r * R]);
    const p1 = add(c, [Math.cos(a1) * o.r * R * 0.85, Math.sin(a1) * o.r * R * 0.22, Math.sin(a1 + 0.3) * o.r * R]);
    b.pt.line(p0, p1, 1, hp, [0, -1, 0.3]);
  }
  if (o.rays) for (const a of [0.6, 1.57, 2.5]) b.pt.line(add(c, [Math.cos(a) * 0.4 * R, Math.sin(a) * 1.0 * R, 0]), add(c, [Math.cos(a) * 0.6 * R, Math.sin(a) * 1.5 * R, 0]), 1, hp, [0, -1, 0.3]);
  return { hairVisible: true, hairBack: true, browVisible: true, mouthVisible: true, ears: true, beard: true };
}

/** A circlet / crown worn on bare hair. */
export function drawCrown(b: Build, o: { mat: Material; gem: Material | null; points: number; height: number }): HeadCover {
  const R = b.sk.plan.headR;
  const h = b.sk.head;
  const at = (x: number, y: number, z: number): V3 => fp(h, x * R, y * R, z * R);
  const cp = part(b, "crown", o.mat, GROUP.HELM, TAG.HELM);
  shell(b, h, [-0.04 * R, 0.0, 0], [1.08 * R, 1.06 * R, 1.03 * R], cp, (_x, y) => y / R > 0.34 && y / R < 0.34 + 0.2 + o.height * 0.1, { zBias: 0.5 });
  for (let i = 0; i < o.points; i++) {
    const a = -0.6 + (i / Math.max(1, o.points - 1)) * 1.6;
    const x = Math.cos(a);
    const z = Math.sin(a);
    b.pt.capsule(at(x * 1.02, 0.5, z * 1.0), at(x * 1.0, 0.62 + o.height * 0.4, z * 0.98), 0.14 * R, 0.04 * R, cp, { zBias: 0.55 });
  }
  if (o.gem) b.pt.sphere(at(1.04, 0.44, 0), 0.16 * R, part(b, "crownGem", o.gem, GROUP.HELM, TAG.HELM), { zBias: 0.7 });
  return { hairVisible: true, hairBack: true, browVisible: true, mouthVisible: true, ears: true, beard: true };
}

export const clothMat = (hexCol: string) => material(hexCol, "cloth");
