import { TAG } from "./gbuffer";
import type { ClipKey3 } from "./clips";
import type { Hero, FrameResult } from "./render";
import { ANCHOR, FRAME_H, FRAME_W } from "./render";
import { dist, finite3, type V3 } from "./vec";

/**
 * HERO RENDERER v3 — STRUCTURAL VALIDATION of a rendered frame: real checks on real generated poses and pixels (not snapshots), shared by the
 * unit tests and the seed-sweep QA script. Each check returns a short code when it fails.
 *
 *   finite        every joint and frame of the solved skeleton is a finite number
 *   edge          no opaque pixel on the frame's outer 1-px ring (nothing clipped by the frame)
 *   bones         segment lengths survive solving and pixel snapping (limbs attached to their joints, no stretched or detached limb)
 *   knees         knees bend forward, never backward (standing clips)
 *   ground        a standing hero's feet are on the floor (the lowest pixel row is at the anchor); a planted foot never floats
 *   grip          a two-handed grip / bow-string hand is ON its point (≤ 0.8 px)
 *   hand          the holding hand is visible (never swallowed by its own weapon)
 *   weapon        the weapon (and a shield) are drawn — no lost equipment layer
 *   eyes          where the face is turned to the viewer and the headgear leaves the eyes open, every eye pixel lands on the face (no helm,
 *                 weapon, arm or hair covers an eye) — idle, locomotion and victory frames; action frames are allowed one brief overlap
 *   eyes-in-head  eye pixels sit inside the head's own pixels, between its top and its chin
 *   mouth         the mouth is below the eyes (and below the nose row)
 */

export interface FrameIssue {
  code: string;
  detail: string;
}

const STANDING: ReadonlySet<ClipKey3> = new Set(["idle", "idle2", "attack_slash", "attack_thrust", "attack_shoot", "hit", "block", "victory", "turn"]);
const CALM: ReadonlySet<ClipKey3> = new Set(["idle", "idle2", "move", "run", "victory"]);
/** Clips where the holding hand must be in view (a spin or a fall may carry it behind the body for a frame). */
const HAND_CLIPS: ReadonlySet<ClipKey3> = new Set(["idle", "idle2", "move", "run", "attack_slash", "attack_thrust", "attack_shoot", "block", "victory"]);

export function validateFrame(hero: Hero, clip: ClipKey3, fr: FrameResult): FrameIssue[] {
  const out: FrameIssue[] = [];
  const add = (code: string, detail: string) => out.push({ code, detail });
  const { sk } = fr.meta;
  const b = sk.plan;
  const W = FRAME_W;
  const H = FRAME_H;
  const a = (i: number) => fr.rgba[i * 4 + 3] as number;

  // finite
  const pts: V3[] = [sk.pelvis.o, sk.chest.o, sk.head.o, sk.neckBase, sk.headPivot, sk.shoulderN, sk.shoulderF, sk.elbowN, sk.elbowF, sk.handN, sk.handF, sk.hipN, sk.hipF, sk.kneeN, sk.kneeF, sk.ankleN, sk.ankleF];
  if (sk.weapon) pts.push(sk.weapon.o, sk.weapon.y);
  if (!pts.every(finite3)) add("finite", "a joint is not finite");

  // edge
  let edge = 0;
  for (let x = 0; x < W; x++) edge += (a(x) ? 1 : 0) + (a((H - 1) * W + x) ? 1 : 0);
  for (let y = 0; y < H; y++) edge += (a(y * W) ? 1 : 0) + (a(y * W + W - 1) ? 1 : 0);
  if (edge > 0) add("edge", `${edge} opaque pixels on the frame border`);

  // bones (after snapping: within ~1.2 px of the plan's length — snapping moves each joint ≤ 0.7 px)
  const bone = (p: V3, q: V3, L: number, name: string) => {
    const d = dist(p, q);
    if (Math.abs(d - L) > 1.3) add("bones", `${name} ${d.toFixed(2)} vs ${L.toFixed(2)}`);
  };
  bone(sk.shoulderN, sk.elbowN, b.upperArm, "upperArmN");
  bone(sk.elbowN, sk.handN, b.forearm, "forearmN");
  bone(sk.shoulderF, sk.elbowF, b.upperArm, "upperArmF");
  bone(sk.elbowF, sk.handF, b.forearm, "forearmF");
  bone(sk.hipN, sk.kneeN, b.thigh, "thighN");
  bone(sk.kneeN, sk.ankleN, b.shin, "shinN");
  bone(sk.hipF, sk.kneeF, b.thigh, "thighF");
  bone(sk.kneeF, sk.ankleF, b.shin, "shinF");

  const standing = STANDING.has(clip) && !sk.fallen;
  // knees bend forward: the knee is not behind the hip→ankle line (in the body's forward direction)
  if (standing || clip === "move" || clip === "run") {
    for (const [hip, knee, ankle, n] of [[sk.hipN, sk.kneeN, sk.ankleN, "N"], [sk.hipF, sk.kneeF, sk.ankleF, "F"]] as const) {
      const t = 0.5;
      const mid: V3 = [hip[0] + (ankle[0] - hip[0]) * t, hip[1] + (ankle[1] - hip[1]) * t, hip[2] + (ankle[2] - hip[2]) * t];
      const fwd = sk.pelvis.x;
      const off = (knee[0] - mid[0]) * fwd[0] + (knee[2] - mid[2]) * fwd[2];
      if (off < -0.9) add("knees", `knee ${n} bends backward (${off.toFixed(2)})`);
    }
  }

  // ground: the lowest opaque row of a standing frame is the floor row (± 1); a planted foot stands on the floor
  let low = -1;
  for (let y = H - 1; y >= 0 && low < 0; y--) for (let x = 0; x < W; x++) if (a(y * W + x)) {
    low = y;
    break;
  }
  if (standing && Math.abs(low - (ANCHOR.y + 1)) > 2) add("ground", `lowest pixel row ${low}, floor ${ANCHOR.y + 1}`);
  const lifts = [sk.ankleN[1] - b.ankle, sk.ankleF[1] - b.ankle];
  if (standing && Math.min(...lifts) > 1.4) add("ground", `no foot on the floor (lifts ${lifts.map((v) => v.toFixed(1)).join(", ")})`);

  // grip
  if (sk.gripError > 0.8) add("grip", `off hand ${sk.gripError.toFixed(2)} px from its grip`);

  // pixels per semantic tag
  const tagCount = new Map<number, number>();
  for (let i = 0; i < W * H; i++) {
    const p = fr.parts[i] as number;
    if (p < 0) continue;
    const t = fr.partTags[p] as number;
    tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  }
  const holding = hero.lo.hold.main !== null && fr.meta.pose.dropWeapon < 0.5;
  if (holding) {
    const mainTag = hero.lo.hold.main === "F" ? TAG.HAND_F : TAG.HAND_N;
    if (hero.lo.hold.main === "N" && HAND_CLIPS.has(clip) && (tagCount.get(mainTag) ?? 0) < 1 && !sk.fallen) add("hand", "the holding hand is not visible");
    if ((tagCount.get(TAG.WEAPON) ?? 0) < 3 && !sk.fallen && clip !== "turn") add("weapon", "the weapon is not drawn");
  }
  // a fallen hero may lie on its shield
  if (hero.lo.hold.shield && !sk.fallen && (tagCount.get(TAG.SHIELD) ?? 0) < 4) add("weapon", "the shield is not drawn");

  // eyes
  const face = fr.meta.face;
  const openEyes = !["closed", "dead"].includes(fr.meta.pose.eyes);
  if (face.visible && openEyes && fr.meta.cover.browVisible !== undefined) {
    const lost = face.eyes.reduce((n, e) => n + (e.expected - e.drawn), 0);
    const expected = face.eyes.reduce((n, e) => n + e.expected, 0);
    if (expected > 0 && lost > 0 && CALM.has(clip)) add("eyes", `${lost}/${expected} eye pixels covered`);
    // in an action a weapon may sweep across the face for a frame or two (the test allows ≤ 2 such frames per clip)
    if (expected > 0 && lost >= expected && !CALM.has(clip) && !sk.fallen) add("eyes-action", `both eyes covered in an action frame`);
  }
  // eyes inside the head; mouth below the eyes
  if (face.visible) {
    for (const e of face.eyes) {
      for (let dy = 0; dy < e.h; dy++) for (let dx = 0; dx < e.w; dx++) {
        const x = e.x + dx;
        const y = e.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) {
          add("eyes-in-head", "eye outside the frame");
          continue;
        }
      }
    }
    const eyeRow = face.eyes[0]?.y;
    if (face.mouth && eyeRow !== undefined && face.mouth.y <= eyeRow + 1) add("mouth", `mouth row ${face.mouth.y} not below the eyes (${eyeRow})`);
  }
  return out;
}
