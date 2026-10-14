import { box, capsule, ellipsoid, GBuffer, line, plate, sphere, type Material, type PrimOpts, type Tag } from "./gbuffer";
import { add, DEG, mul, type Frame, type V2, type V3 } from "./vec";

/**
 * HERO RENDERER v3 — the CAMERA and the PAINTER (primitives in character space, projected and depth-tested in view space).
 *
 * The camera is orthographic: the hero is turned `yaw` degrees toward the viewer (a three-quarter view — both eyes, the chest and the near
 * side of the body read) and seen from `pitch` degrees above (the top of the shoulders, a shield's rim, the crown of a helm). The anchor
 * (the point on the floor under the hero) maps to a fixed frame pixel, so every frame of every clip shares one foot position.
 */

export interface Camera {
  /** Turn toward the viewer, degrees (0 = pure profile, 90 = facing the viewer). */
  yaw: number;
  /**
   * Uniform zoom about the anchor (sprite pixels per body unit). Body, poses, stride and weapons all scale together, so proportions never
   * change — only how many pixels the hero spans (default 1).
   */
  zoom?: number;
  /** Camera elevation, degrees. */
  pitch: number;
  /** Anchor (floor point under the hero) in frame pixels. */
  ax: number;
  ay: number;
}

export class Painter {
  readonly g: GBuffer;
  private readonly cy: number;
  private readonly sy: number;
  private readonly cp: number;
  private readonly sp: number;
  /** Uniform zoom about the anchor. */
  readonly z: number;

  constructor(readonly cam: Camera, w: number, h: number) {
    this.z = cam.zoom ?? 1;
    this.g = new GBuffer(w, h);
    this.cy = Math.cos(cam.yaw * DEG);
    this.sy = Math.sin(cam.yaw * DEG);
    this.cp = Math.cos(cam.pitch * DEG);
    this.sp = Math.sin(cam.pitch * DEG);
    // the floor: nothing below the ground plane is drawn (a planted staff, a kneeling hem, a fallen body all stop at the floor)
    this.g.floor = (x, y, z) => this.worldY(x, y, z) >= -0.45;
  }

  /** Character space → view space (x right, y down, z toward the camera). */
  P(p: V3): V3 {
    const x1 = p[0] * this.cy - p[2] * this.sy;
    const z1 = p[0] * this.sy + p[2] * this.cy;
    const up = p[1] * this.cp - z1 * this.sp;
    const depth = z1 * this.cp + p[1] * this.sp;
    return [this.cam.ax + x1 * this.z, this.cam.ay - up * this.z, depth * this.z];
  }

  /** Character-space direction → view-space direction. */
  D(v: V3): V3 {
    const x1 = v[0] * this.cy - v[2] * this.sy;
    const z1 = v[0] * this.sy + v[2] * this.cy;
    return [x1, -(v[1] * this.cp - z1 * this.sp), z1 * this.cp + v[1] * this.sp];
  }

  /** View space → character space (inverse of P). */
  U(q: V3): V3 {
    const x1 = (q[0] - this.cam.ax) / this.z;
    const up = (this.cam.ay - q[1]) / this.z;
    const qz = q[2] / this.z;
    const z1 = qz * this.cp - up * this.sp;
    const Y = up * this.cp + qz * this.sp;
    const X = x1 * this.cy + z1 * this.sy;
    const Z = -x1 * this.sy + z1 * this.cy;
    return [X, Y, Z];
  }

  /** World height (character Y) of a view-space point. */
  worldY(x: number, y: number, z: number): number {
    return ((this.cam.ay - y) * this.cp + z * this.sp) / this.z;
  }

  /**
   * Snaps a joint so it projects onto a PIXEL CENTRE (its depth unchanged). Limbs between snapped joints rasterise identically whenever their
   * joints did not move, so a held pose does not shimmer and a 1-px move is a clean 1-px move.
   */
  snap(p: V3): V3 {
    const q = this.P(p);
    return this.U([Math.floor(q[0]) + 0.5, Math.floor(q[1]) + 0.5, q[2]]);
  }

  /** Screen position (pixel) of a character-space point. */
  px(p: V3): V2 {
    const q = this.P(p);
    return [Math.floor(q[0]), Math.floor(q[1])];
  }

  part(name: string, mat: Material, group: number, tag: Tag, bias = 0): number {
    return this.g.addPart({ name, mat, group, tag, bias });
  }

  sphere(c: V3, r: number, part: number, o?: PrimOpts): void {
    sphere(this.g, this.P(c), r * this.z, part, o);
  }

  /** Ellipsoid with axes given in character space (scaled by their radii). */
  ellipsoid(c: V3, a1: V3, a2: V3, a3: V3, part: number, o?: PrimOpts): void {
    const k = this.z;
    const S = (v: V3): V3 => {
      const d = this.D(v);
      return [d[0] * k, d[1] * k, d[2] * k];
    };
    ellipsoid(this.g, this.P(c), S(a1), S(a2), S(a3), part, o);
  }

  /** Ellipsoid aligned to a frame, radii along its x / y / z, centred at a frame-local point. */
  blob(f: Frame, local: V3, rx: number, ry: number, rz: number, part: number, o?: PrimOpts): void {
    const c = add(f.o, add(add(mul(f.x, local[0]), mul(f.y, local[1])), mul(f.z, local[2])));
    this.ellipsoid(c, mul(f.x, rx), mul(f.y, ry), mul(f.z, rz), part, o);
  }

  capsule(a: V3, b: V3, ra: number, rb: number, part: number, o?: PrimOpts): void {
    capsule(this.g, this.P(a), this.P(b), ra * this.z, rb * this.z, part, o);
  }

  box(c: V3, axes: readonly [V3, V3, V3], half: V3, part: number, o?: PrimOpts): void {
    box(this.g, this.P(c), [this.D(axes[0]), this.D(axes[1]), this.D(axes[2])], [half[0] * this.z, half[1] * this.z, half[2] * this.z], part, o);
  }

  /** A box aligned to a frame, centred at a frame-local point. */
  fbox(f: Frame, local: V3, half: V3, part: number, o?: PrimOpts): void {
    const c = add(f.o, add(add(mul(f.x, local[0]), mul(f.y, local[1])), mul(f.z, local[2])));
    this.box(c, [f.x, f.y, f.z], half, part, o);
  }

  plate(pts: readonly V3[], normal: V3, part: number, o?: PrimOpts & { bulge?: number }): void {
    plate(this.g, pts.map((p) => this.P(p)), this.D(normal), part, o);
  }

  line(a: V3, b: V3, width: number, part: number, normal: V3 = [0.3, 0.5, 0.8], o?: PrimOpts & { side?: V2; tones?: readonly number[] }): void {
    line(this.g, this.P(a), this.P(b), width, part, this.D(normal), o);
  }
}

/** A frame-local point → character space. */
export const fp = (f: Frame, x: number, y: number, z: number): V3 => add(f.o, add(add(mul(f.x, x), mul(f.y, y)), mul(f.z, z)));
