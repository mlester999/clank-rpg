import type { Key } from "../anim";
import { at, pose, STRING, type PoseLibrary } from "../clips";
import type { HandTarget, Pose, WeaponAim } from "../rig";

/**
 * The bow hand is placed in the PELVIS frame (it does not turn with the chest's twist): the bow arm points at the target, wherever the
 * shoulders turn while drawing.
 */
const pel = (x: number, y: number, z: number): HandTarget => ({ at: [x, y, z], space: "pelvis" });

import { koBack } from "./common";

/**
 * RANGER pose languages: an archer's posture — side-on at full draw (the chest turns so the drawing hand comes back to the near shoulder, never
 * across the face), the bow arm straight at the target, a visible draw → aim (still) → release (the string snaps forward, the drawing hand
 * flies back) → follow-through → lower. The release is the clip's impact frame: the arrow leaves on it.
 *
 *   scout        a recurve carried upright at the side
 *   warden       a longbow nearly as tall as the hero, a deep slow draw
 *   skirmisher   small and quick: a short bow canted level, a snap shot from a crouch
 */

function rangerLib(o: { stance: Pose; alt: Pose; aim: WeaponAim; raise: [number, number, number]; drawTwist: number; walkDrop: number }): PoseLibrary {
  const s = o.stance;
  const [rx, ry, rz] = o.raise;
  const aimAt = { handF: pel(rx, ry, rz), weapon: o.aim };
  const attack: Key[] = [
    { t: 0, ...s },
    // raise the bow to the target, the hand to the string
    { t: 0.14, ...aimAt, handN: STRING, draw: 0.12, twist: o.drawTwist * 0.6, lean: 1, eyes: "focus", ease: "out" },
    // draw — the chest turning side-on
    { t: 0.3, ...aimAt, handN: STRING, draw: 0.75, twist: o.drawTwist * 0.9, lean: 0, brow: -1, ease: "inOut" },
    // full draw: AIM (still)
    { t: 0.44, ...aimAt, handN: STRING, draw: 1.0, twist: o.drawTwist, lean: -1, brow: -1, mouth: "grit", ease: "out" },
    // RELEASE: the string snaps forward, the drawing hand flies back past the shoulder, a small recoil
    { t: 0.5, ...aimAt, handN: at(-2.4, 3.4, 4.8), draw: 0, twist: o.drawTwist, lean: -3, x: -0.6, mouth: "o", sway: 1.6, ease: "snap" },
    { t: 0.64, ...aimAt, handN: at(-2.6, 3.0, 4.8), draw: 0, twist: o.drawTwist * 0.9, lean: -2, x: -0.5, eyes: "open", mouth: "rest", ease: "out" },
    { t: 0.84, handF: pel(rx - 2.4, ry - 5.0, rz - 1.0), weapon: { angle: (o.aim.angle + s.weapon.angle) / 2, out: o.aim.out ?? 0 }, handN: s.handN, twist: o.drawTwist * 0.3, lean: 1, x: -0.2, ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  const skill: Key[] = [
    { t: 0, ...s },
    // a volley skyward: the bow tilted back, a full draw, the release high
    { t: 0.18, handF: pel(rx - 1.6, ry + 2.6, rz), weapon: { angle: -36, out: o.aim.out ?? 0 }, handN: STRING, draw: 0.3, twist: o.drawTwist * 0.7, lean: -8, headPitch: -14, eyes: "focus", ease: "out" },
    { t: 0.38, handF: pel(rx - 1.6, ry + 2.8, rz), weapon: { angle: -38, out: o.aim.out ?? 0 }, handN: STRING, draw: 1.0, twist: o.drawTwist, lean: -12, headPitch: -18, brow: -1, mouth: "grit", glow: 0.6, ease: "inOut" },
    { t: 0.44, handF: pel(rx - 1.6, ry + 2.8, rz), weapon: { angle: -38, out: o.aim.out ?? 0 }, handN: at(-3.0, 4.6, 4.8), draw: 0, twist: o.drawTwist, lean: -13, headPitch: -18, mouth: "shout", glow: 1, sway: 2, ease: "snap" },
    { t: 0.66, handF: pel(rx - 1.8, ry + 2.4, rz), weapon: { angle: -34, out: o.aim.out ?? 0 }, handN: at(-3.0, 4.2, 4.8), draw: 0, twist: o.drawTwist * 0.9, lean: -10, headPitch: -14, mouth: "open", glow: 0.4, ease: "out" },
    { t: 0.88, ...s, glow: 0, eyes: "open", mouth: "rest", ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  return {
    stance: s,
    stance2: o.alt,
    carry: (kind, sN) => ({
      handF: kind === "run" ? pel(3.6, 3.2, -3.6) : s.handF, weapon: kind === "run" ? { angle: 30, out: s.weapon.out ?? 0 } : s.weapon,
      handN: at(sN * (kind === "run" ? 4.4 : 3.0), -7.2 + Math.abs(sN) * 0.8, 4.8), draw: 0,
      eyes: "open", mouth: "rest",
    }),
    walk: { stance: 0.6, lift: 2.4, bob: 0.9, lean: 4, hipYaw: 9, counter: 0.7, armSwing: 3, width: 2.3, drop: o.walkDrop },
    run: { stance: 0.36, lift: 4.4, bob: 1.8, lean: 14, hipYaw: 15, counter: 0.8, armSwing: 4.4, width: 2.0, drop: o.walkDrop + 1.2 },
    attack,
    skill,
    hit: [
      { t: 0, ...s },
      { t: 0.25, lean: -16, x: -2.6, drop: s.drop + 1.2, headPitch: -16, handN: at(1.0, -2.0, 4.8), eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, footF: { ...s.footF, lift: 1.0, pitch: 14 }, ease: "snap" },
      { t: 0.6, lean: -6, x: -1.4, drop: s.drop + 0.6, headPitch: -6, eyes: "hurt", mouth: "grit", ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    block: [
      { t: 0, ...s },
      // a quick step back out of the line, the bow raised across the body
      { t: 0.3, lean: -14, x: -2.8, drop: s.drop + 1.0, twist: -16, handF: pel(5.4, 8.6, -1.0), weapon: { angle: 28, out: s.weapon.out ?? 0 }, eyes: "focus", mouth: "grit", brow: -1, footF: { ...s.footF, x: s.footF.x - 1.6 }, ease: "snap" },
      { t: 0.6, lean: -8, x: -2.0, twist: -10, ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    ko: koBack(s),
    victory: [
      { t: 0, ...s, handF: pel(0.6, 17.6, -5.4), weapon: { angle: 2 }, handN: at(3.4, 0.4, 4.6), lean: -4, headPitch: -10, eyes: "cheer", mouth: "smile", drop: 0.6 },
      { t: 0.5, handF: pel(0.8, 18.1, -5.4), handN: at(3.6, 1.4, 4.6), lean: -6, headPitch: -14, mouth: "open", drop: 0.2, ease: "inOut" },
    ],
  };
}

export const SCOUT = rangerLib({
  stance: pose({
    footF: { x: 3.4, z: -2.4 }, footN: { x: -3.0, z: 2.8 }, drop: 1.0, lean: 3, twist: -4, headYaw: 4,
    handF: pel(3.0, 1.6, -3.8), weapon: { angle: 4 }, handN: at(0.6, -7.6, 5.0), sway: 0.7,
  }),
  alt: pose({
    footF: { x: 4.0, z: -2.4 }, footN: { x: -3.6, z: 2.8 }, drop: 1.4, lean: 6, twist: -20,
    handF: pel(7.6, 5.4, -1.2), weapon: { angle: 26 }, handN: STRING, draw: 0.22, eyes: "focus", sway: 0.7,
  }),
  aim: { angle: 2 },
  raise: [12.2, 11.0, -1.2],
  drawTwist: -38,
  walkDrop: 0.8,
});

export const WARDEN = rangerLib({
  stance: pose({
    footF: { x: 3.8, z: -2.8 }, footN: { x: -3.6, z: 3.2 }, drop: 1.2, lean: 3, twist: -4, headYaw: 4,
    handF: pel(3.6, 4.2, -3.8), weapon: { angle: 2 }, handN: at(0.6, -7.8, 5.2), sway: 0.7,
  }),
  alt: pose({
    footF: { x: 4.6, z: -2.8 }, footN: { x: -4.2, z: 3.2 }, drop: 1.6, lean: 5, twist: -22,
    handF: pel(7.8, 7.0, -1.2), weapon: { angle: 12 }, handN: STRING, draw: 0.24, eyes: "focus", sway: 0.7,
  }),
  aim: { angle: 2 },
  raise: [12.8, 11.6, -1.4],
  drawTwist: -42,
  walkDrop: 1.0,
});

export const SKIRMISHER = rangerLib({
  stance: pose({
    footF: { x: 4.4, z: -2.8 }, footN: { x: -4.0, z: 3.0, pitch: -10 }, drop: 3.2, lean: 12, twist: -10, headYaw: 4, headPitch: -6,
    // the short bow canted level before the body
    handF: pel(6.8, 4.6, -1.2), weapon: { angle: 0, out: -78 }, handN: at(3.0, -4.4, 3.6), sway: 0.8,
  }),
  alt: pose({
    footF: { x: 4.4, z: -2.8 }, footN: { x: -4.0, z: 3.0, pitch: -10 }, drop: 3.0, lean: 10, twist: -18,
    handF: pel(7.4, 5.4, -1.0), weapon: { angle: 0, out: -78 }, handN: STRING, draw: 0.3, eyes: "focus", sway: 0.8,
  }),
  aim: { angle: 0, out: -72 },
  raise: [11.6, 7.4, -1.0],
  drawTwist: -30,
  walkDrop: 2.4,
});
