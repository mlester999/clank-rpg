import type { SpriteConfig } from "../config";

import { drawArm, drawHead, drawLegs, drawTorso, HEAD_SHAPES, type BodyIds } from "./body";
import { sampleClip, type ClipPlan } from "./anim";
import { clipPlan, TIMING, VIEW_ZOOM, type ClipKey3 } from "./clips";
import { drawFace, type FaceResult } from "./face";
import { TAG } from "./gbuffer";
import { toLch } from "./color";
import { drawAccessory } from "./gear/accessory";
import { drawBeard, drawHair } from "./gear/hair";
import { loadoutOf, type Loadout } from "./gear/loadout";
import { genomeOf, type Genome, type GenomeInput } from "./genome";
import type { Build } from "./kit";
import { heroPalette, type HeroPalette } from "./palette";
import { libraryOf } from "./poses";
import { resolve } from "./post";
import { solve, type Pose, type Skeleton } from "./rig";
import { add, finite3, mul, type Frame, type V3 } from "./vec";
import { Painter, type Camera } from "./view";

/**
 * HERO RENDERER v3 — one FRAME, end to end: genome → loadout → pose (sampled from the archetype's clip) → solved skeleton → snapped to the
 * pixel grid → body, garments, headgear, hair, weapon, face → G-buffer → pixel art. Pure and deterministic: the same hero, clip and frame
 * give the same pixels on the server, in the browser and in tests.
 */

export const FRAME_W = 96;
export const FRAME_H = 80;
export const ANCHOR = { x: 44, y: 73 } as const;
export const NOMINAL_HEIGHT = 46;
export const CAMERA: Camera = { yaw: 24, pitch: 12, ax: ANCHOR.x + 0.5, ay: ANCHOR.y + 0.5, zoom: VIEW_ZOOM };
/** Heads turn this much further toward the viewer than the body (a readable face on a side-on body — a battler convention). */
export const HEAD_TURN = 16;

export interface Hero {
  g: Genome;
  pal: HeroPalette;
  lo: Loadout;
}

export function heroOf(input: GenomeInput): Hero {
  const g = genomeOf(input);
  const pal = heroPalette(g, input.config as Pick<SpriteConfig, "hue">);
  return { g, pal, lo: loadoutOf(g, pal) };
}

export interface FrameMeta {
  /** Frame pixels: the main grip (hand), the off hand, the second grip point, eyes, mouth, the muzzle. */
  handN: [number, number];
  handF: [number, number];
  grip: [number, number] | null;
  grip2: [number, number] | null;
  muzzle: [number, number] | null;
  tip: [number, number] | null;
  face: FaceResult;
  /** What the headgear leaves visible (eyes are expected unless a closed visor says otherwise). */
  cover: Build["head"];
  /** The solved pose (expression, draw, fall …). */
  pose: Pose;
  /** Skeleton (character space) for structural tests. */
  sk: Skeleton;
  /** Lowest foot point above the floor (character Y). */
  footLow: number;
}

export interface FrameResult {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  /** Part index per pixel (−1 background, −2 outline) and the parts table (tags for validation). */
  parts: Int16Array;
  partTags: number[];
  partNames: string[];
  meta: FrameMeta;
}

function snapFrame(pt: Painter, f: Frame | null): Frame | null {
  return f ? { ...f, o: pt.snap(f.o) } : null;
}

/** Every joint of a skeleton moved onto a pixel centre (so a held pose never shimmers and a move is a clean pixel move). */
export function snapSkeleton(pt: Painter, s: Skeleton): Skeleton {
  const S = (p: V3) => pt.snap(p);
  return {
    ...s,
    pelvis: snapFrame(pt, s.pelvis) as Frame, chest: snapFrame(pt, s.chest) as Frame, head: snapFrame(pt, s.head) as Frame,
    neckBase: S(s.neckBase), headPivot: S(s.headPivot), shoulderN: S(s.shoulderN), shoulderF: S(s.shoulderF), elbowN: S(s.elbowN), elbowF: S(s.elbowF),
    handN: S(s.handN), handF: S(s.handF), hipN: S(s.hipN), hipF: S(s.hipF), kneeN: S(s.kneeN), kneeF: S(s.kneeF), ankleN: S(s.ankleN), ankleF: S(s.ankleF),
    footN: snapFrame(pt, s.footN) as Frame, footF: snapFrame(pt, s.footF) as Frame,
    // a weapon is attached to its hand: snap its origin with the hand so the grip stays inside the fist
    weapon: s.weapon ? { ...s.weapon, o: s.hold === "F" ? S(s.handF) : S(s.handN) } : null,
    weapon2: s.weapon2 ? { ...s.weapon2, o: s.hold === "F" ? S(s.handN) : S(s.handF) } : null,
    shield: snapFrame(pt, s.shield),
  };
}

/**
 * A weapon released in a fall: it lies flat on the floor by the hand that held it, its long end pointing back ALONG the fallen body (toward the
 * hero's spot), so a long hammer or staff never sticks out past the hand — or out of the frame.
 */
function droppedWeapon(hand: V3, pelvisX: number, fall: number, span: { up: number; down: number }, k: number): Frame {
  // lying along the fallen body, its middle at the body's middle (by the hand that held it)
  const dir = fall >= 0 ? -1 : 1;
  const ox = pelvisX - dir * ((span.up - span.down) / 2) + 1.2 * k;
  // close to the body's mid-plane (the camera looks down: a weapon lying far toward the viewer would project below the floor line)
  const o: V3 = [ox, 0.6, Math.max(-4, Math.min(2.5, hand[2] * 0.5 + 0.8 * k))];
  return { o, y: [dir, 0, 0.05], x: [0, 1, 0], z: [0, 0, 1] };
}

export function renderPose(hero: Hero, pose0: Pose, cam: Camera = CAMERA, headTurn = HEAD_TURN): FrameResult {
  const { g, pal, lo } = hero;
  const pose: Pose = { ...pose0, headYaw: pose0.headYaw + headTurn };
  let sk0 = solve(g.plan, pose, lo.hold);
  if (pose.dropWeapon >= 0.5 && sk0.weapon) {
    const hand = lo.hold.main === "F" ? sk0.handF : sk0.handN;
    const px = sk0.pelvis.o[0];
    sk0 = { ...sk0, weapon: droppedWeapon(hand, px, pose.fall, lo.span, 1), weapon2: sk0.weapon2 ? droppedWeapon(lo.hold.main === "F" ? sk0.handN : sk0.handF, px, pose.fall, lo.span, -1) : null };
  }
  const pt = new Painter(cam, FRAME_W, FRAME_H);
  const sk = snapSkeleton(pt, sk0);
  const ids = {} as BodyIds;
  const b: Build = { pt, sk, pose, g, pal, ids, dress: lo.dress, head: { hairVisible: true, hairBack: true, browVisible: true, mouthVisible: true, ears: true, beard: true }, muzzle: null, dropped: pose.dropWeapon >= 0.5 };
  const gripF = lo.hold.main === "F" || (lo.hold.main === "N" && ("grip" in pose.handF || lo.hold.second));
  const gripN = lo.hold.main === "N" || (lo.hold.main === "F" && "string" in pose.handN && false);
  drawLegs(pt, sk, lo.dress);
  drawTorso(pt, sk, lo.dress, ids);
  drawArm(pt, sk, lo.dress, "F", ids, gripF);
  drawArm(pt, sk, lo.dress, "N", ids, gripN);
  // headgear first: it decides what of the hair and face shows
  const cover = lo.head(b);
  if (cover) b.head = cover;
  drawHead(pt, sk, pal.skin, HEAD_SHAPES[g.headShape], ids, { ears: b.head.ears });
  if (!cover || cover.hairVisible) drawHair(b);
  else if (cover.hairFringe) drawHair(b, { fringe: true });
  else if (cover.hairBack) drawHair(b, { backOnly: true });
  const beard = b.head.beard ? drawBeard(b) : null;
  lo.garments(b);
  drawAccessory(b);
  const wr = pose.dropWeapon >= 0.5 || sk.weapon ? lo.weapon(b) : null;
  if (beard !== null) ids.faceSkin.add(beard);
  const face = drawFace(pt, sk, pose, ids, { eyes: g.eyes, mouth: g.mouth, brow: g.browWeight, browColor: pal.brow, skinDeep: pal.skin.ramp[0], skinLo: pal.skin.ramp[1], lip: pal.lip, darkSkin: toLch(pal.skin.ramp[2]).L < 0.56 }, { browVisible: b.head.browVisible, mouthVisible: b.head.mouthVisible, ...(b.head.visor ? { visor: b.head.visor } : {}), ...(g.accessory === "monocle" ? { monocle: pal.trim.ramp[3] as number } : {}) });
  const post = resolve(pt.g);
  const px = (p: V3): [number, number] => {
    const q = pt.P(p);
    return [Math.floor(q[0]), Math.floor(q[1])];
  };
  const grip2 = sk.weapon && lo.hold.grip2 !== null ? px(add(sk.weapon.o, mul(sk.weapon.y, lo.hold.grip2))) : null;
  return {
    rgba: post.rgba,
    w: FRAME_W,
    h: FRAME_H,
    parts: post.parts,
    partTags: pt.g.parts.map((p) => p.tag),
    partNames: pt.g.parts.map((p) => p.name),
    meta: {
      handN: px(sk.handN), handF: px(sk.handF),
      grip: sk.weapon ? px(sk.weapon.o) : null,
      grip2,
      muzzle: wr?.muzzle && finite3(wr.muzzle) ? px(wr.muzzle) : null,
      tip: wr?.tip ? px(wr.tip) : null,
      face, sk, cover: b.head, pose,
      footLow: Math.min(sk.ankleN[1], sk.ankleF[1]) - g.plan.ankle,
    },
  };
}

/** The pose of `clip` frame `f` for a hero (the archetype's library, the hero's stance and tempo). */
export function poseAt(hero: Hero, clip: ClipKey3, f: number): Pose {
  const lib = libraryOf(hero.g.arch);
  const plan: ClipPlan = clipPlan(lib, clip, hero.g.plan, hero.g);
  // locomotion, attacks and reactions are authored from the main stance; the second stance only idles differently
  const base = clip === "idle2" ? lib.stance2 : lib.stance;
  return sampleClip(plan, f, base, hero.g.plan);
}

/**
 * The TURN clip: a facing change passes through a front view. Its frames are drawn in the NEW facing, with the camera swung round the hero —
 * from just past the front (still turning) to the three-quarter view — so the turn is a real rotation of the figure, never a squashed or
 * rotated picture.
 */
const TURN_YAW = [104, 74, 46] as const;
const TURN_HEAD = [0, 5, 11] as const;

export function renderClipFrame(hero: Hero, clip: ClipKey3, f: number, cam: Camera = CAMERA): FrameResult {
  if (clip === "turn") {
    const k = Math.min(TURN_YAW.length - 1, Math.max(0, f));
    const stance = poseAt(hero, hero.g.stance === 1 ? "idle2" : "idle", 0);
    return renderPose(hero, stance, { ...cam, yaw: TURN_YAW[k] as number }, TURN_HEAD[k] as number);
  }
  return renderPose(hero, poseAt(hero, clip, f), cam);
}

export { TIMING, TAG };
export type { ClipKey3 };
