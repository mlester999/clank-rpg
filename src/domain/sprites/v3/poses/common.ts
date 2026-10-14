import type { Key } from "../anim";
import { at } from "../clips";
import type { Pose } from "../rig";

/**
 * Shared KNOCK-OUTS (every fall stays inside the frame: the body slides by `fallX` so that, lying, it sits around the hero's spot).
 *
 *   koBack     a stagger, the knees go, a fall onto the back, a bounce, still (head to the left)
 *   koForward  sagging, tipping forward, face down (head to the right) — the heavy and the devout
 *   koKneel    sinking to both knees, then folding forward — the casters
 */

export const koBack = (from: Pose, o: { drop?: boolean } = {}): Key[] => [
  { t: 0, ...from },
  { t: 0.12, lean: -18, x: -1.6, drop: 2.6, headPitch: -18, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, ease: "snap" },
  { t: 0.3, lean: -4, x: -1.2, drop: 8.5, headPitch: -6, handN: at(3.0, -1.0, 4.4), handF: at(1.0, -1.0, -4.6), eyes: "hurt", fall: -10, fallX: 2, ease: "inOut" },
  { t: 0.5, fall: -62, fallX: 8, drop: 5.5, lean: -6, headPitch: -12, handN: at(1.0, 2.0, 5.4), handF: at(0.0, 2.0, -5.4), footN: { x: -1.6, z: 2.6 }, footF: { x: 1.4, z: -2.4 }, eyes: "closed", mouth: "o", dropWeapon: o.drop === false ? 0 : 1, ease: "in" },
  { t: 0.66, fall: -93, fallX: 13, drop: 3.0, lean: 0, headPitch: -6, handN: at(1.0, 1.0, 5.8), handF: at(-0.5, 1.0, -5.8), footN: { x: -0.8, z: 2.6, pitch: 30 }, footF: { x: 0.8, z: -2.6, pitch: 30 }, eyes: "closed", dropWeapon: 1, ease: "in" },
  { t: 0.78, fall: -86, fallX: 13, drop: 3.2, lean: 0, dropWeapon: 1, eyes: "closed", ease: "out" },
  { t: 1, fall: -91, fallX: 13, drop: 2.6, lean: 0, headPitch: -4, handN: at(1.5, 0.0, 6.0), handF: at(-0.8, 0.5, -6.0), footN: { x: -0.6, z: 2.8, pitch: 34 }, footF: { x: 1.0, z: -2.6, pitch: 30 }, eyes: "dead", mouth: "o", dropWeapon: 1, sway: 0, ease: "inOut" },
];

export const koForward = (from: Pose, o: { drop?: boolean } = {}): Key[] => [
  { t: 0, ...from },
  { t: 0.14, lean: 18, x: 0.6, drop: 3.0, headPitch: 14, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: -1, ease: "snap" },
  { t: 0.34, lean: 26, x: 0.8, drop: 7.5, headPitch: 18, handN: at(4.0, -4.0, 4.6), handF: at(4.0, -4.0, -4.6), eyes: "hurt", fall: 12, fallX: -1, ease: "inOut" },
  { t: 0.52, fall: 60, fallX: -5, drop: 5.0, lean: 10, headPitch: 6, handN: at(6.0, 1.0, 5.0), handF: at(6.0, 1.0, -5.0), eyes: "closed", mouth: "o", dropWeapon: o.drop === false ? 0 : 1, ease: "in" },
  { t: 0.66, fall: 92, fallX: -10, drop: 2.6, lean: 0, headPitch: -8, handN: at(5.0, 3.0, 5.6), handF: at(5.0, 3.0, -5.6), footN: { x: 0.6, z: 2.6, pitch: -30 }, footF: { x: -0.6, z: -2.6, pitch: -30 }, eyes: "closed", dropWeapon: 1, ease: "in" },
  { t: 0.78, fall: 86, fallX: -10, drop: 2.8, dropWeapon: 1, eyes: "closed", ease: "out" },
  { t: 1, fall: 90, fallX: -10, drop: 2.2, lean: 0, headPitch: -10, handN: at(4.0, 3.5, 6.0), handF: at(4.5, 3.0, -6.0), footN: { x: 0.4, z: 2.8, pitch: -34 }, footF: { x: -0.8, z: -2.6, pitch: -30 }, eyes: "dead", mouth: "o", dropWeapon: 1, sway: 0, ease: "inOut" },
];

export const koKneel = (from: Pose, o: { drop?: boolean } = {}): Key[] => [
  { t: 0, ...from },
  { t: 0.12, lean: -10, x: -1.0, drop: 2.6, headPitch: -12, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 2, ease: "snap" },
  // sinking to the knees: hips low, the body still upright, arms slack
  { t: 0.34, lean: 6, x: -0.6, drop: 10.5, headPitch: 10, handN: at(2.5, -6.0, 4.6), handF: at(2.5, -6.0, -4.6), footN: { x: -3.6, z: 2.6, pitch: -40 }, footF: { x: 2.0, z: -2.4 }, eyes: "closed", mouth: "o", ease: "inOut" },
  { t: 0.5, lean: 14, drop: 11.0, headPitch: 16, ease: "out" },
  // folding forward onto the floor
  { t: 0.7, fall: 80, fallX: -4, drop: 8.0, lean: 10, headPitch: 0, handN: at(6.0, 2.0, 5.0), handF: at(6.0, 2.0, -5.0), dropWeapon: o.drop === false ? 0 : 1, ease: "in" },
  { t: 0.82, fall: 86, fallX: -5, drop: 6.0, dropWeapon: 1, eyes: "closed", ease: "out" },
  { t: 1, fall: 88, fallX: -5, drop: 5.0, lean: 6, headPitch: -6, handN: at(5.5, 3.0, 5.6), handF: at(5.5, 2.5, -5.6), eyes: "dead", mouth: "o", dropWeapon: 1, sway: 0, ease: "inOut" },
];
