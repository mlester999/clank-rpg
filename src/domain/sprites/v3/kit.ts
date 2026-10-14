import type { BodyIds, Dress } from "./body";
import type { HeadCover } from "./gear/headgear";
import type { Material, PrimOpts, Tag } from "./gbuffer";
import type { Genome } from "./genome";
import type { HeroPalette } from "./palette";
import type { Pose, Skeleton } from "./rig";
import { add, dot, lerp3, mul, norm, sub, type Frame, type V3 } from "./vec";
import type { Painter } from "./view";

/**
 * HERO RENDERER v3 — the shared kit every gear builder uses: the build context, frame-local clipping (a garment is a body volume inflated and
 * CUT by a rule in the body part's own coordinates — "front panel only", "above the brow line", "below the belt"), and a few construction
 * helpers. Because every garment is defined on a body volume, it wraps that volume in every pose.
 */

export interface Build {
  pt: Painter;
  sk: Skeleton;
  pose: Pose;
  g: Genome;
  pal: HeroPalette;
  ids: BodyIds;
  dress: Dress;
  /** Head coverings decide what of the face and hair stays visible. */
  head: HeadCover;
  /** Muzzle (where a shot or a spell leaves), character space; set by the weapon builder. */
  muzzle: V3 | null;
  /** The weapon lies on the floor (a fall): a planted staff's foot is drawn at its real length, not to the floor. */
  dropped: boolean;
}

export type LocalClip = (x: number, y: number, z: number) => boolean;

/** A view-space clip from a rule in frame-local coordinates. */
export function localClip(pt: Painter, f: Frame, rule: LocalClip): PrimOpts["clip"] {
  return (x, y, z) => {
    const p = sub(pt.U([x, y, z]), f.o);
    return rule(dot(p, f.x), dot(p, f.y), dot(p, f.z));
  };
}

/** An ellipsoid SHELL in a frame (radii along its axes), cut by a frame-local rule. */
export function shell(b: Build, f: Frame, c: V3, r: V3, part: number, rule: LocalClip | null, o: PrimOpts = {}): void {
  b.pt.blob(f, c, r[0], r[1], r[2], part, rule ? { ...o, clip: localClip(b.pt, f, (x, y, z) => rule(x - c[0], y - c[1], z - c[2])) } : o);
}

export function part(b: Build, name: string, mat: Material, group: number, tag: Tag, bias = 0): number {
  return b.pt.part(name, mat, group, tag, bias);
}

/** A frame for a limb segment: origin at `a`, y from a toward b, x toward the hero's forward. */
export function boneFrame(a: V3, b: V3, fwd: V3 = [1, 0, 0]): Frame {
  const y = norm(sub(b, a));
  let x = sub(fwd, mul(y, dot(fwd, y)));
  const l = Math.hypot(x[0], x[1], x[2]);
  x = l > 1e-4 ? mul(x, 1 / l) : norm(sub([0, 0, 1], mul(y, y[2])));
  const z: V3 = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
  return { o: a, x, y, z };
}

/** Linear interpolation helpers re-exported for gear code. */
export { add, lerp3, mul, norm, sub };

/** A world-vertical frame at a point (hanging cloth: y up, x forward, z right). */
export const vertical = (o: V3): Frame => ({ o, x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });
