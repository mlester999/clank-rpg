import type { Key } from "../anim";
import { at, GRIP, pose, type PoseLibrary } from "../clips";
import type { Pose } from "../rig";

import { koBack } from "./common";

/**
 * WARRIOR pose languages (character space: x forward, y up, z the hero's right; hands in the chest frame; angles in degrees).
 *
 *   vanguard  planted guard, sword up before the body, a rotating overhead cut that steps in and follows through
 *   brute     a greatsword in both hands, carried at the hip / on the shoulder; a huge diagonal cleave with the whole body behind it
 *   duelist   side-on en garde, the slim blade forward and the buckler up; a long lunge
 */

// ---------------------------------------------------------------------------------------------------------------- vanguard

const vGuard: Pose = pose({
  footF: { x: 4.6, z: -2.2 }, footN: { x: -4.2, z: 2.9, pitch: -6 },
  drop: 1.5, lean: 6, twist: -14, hipYaw: -12, headPitch: -2, headYaw: 6,
  handN: at(4.6, -5.4, 3.2), weapon: { angle: 38, roll: 0 },
  handF: at(4.2, -3.6, -1.4),
  sway: 0.6, brow: -0.2,
});

const vLow: Pose = pose({
  footF: { x: 3.4, z: -2.6 }, footN: { x: -3.2, z: 3.0 },
  drop: 1.0, lean: 2, twist: -6, hipYaw: -6,
  handN: at(4.4, -7.4, 3.0), weapon: { angle: 125, roll: 0 },
  handF: at(-0.6, -7.2, -5.6, [0.2, 0.2, 1]),
  sway: 0.5,
});

const vAttack: Key[] = [
  { t: 0, ...vGuard },
  // anticipation: the sword comes up and back over the near shoulder, weight onto the back foot, the chest turns away
  { t: 0.2, handN: at(-1.4, 6.0, 5.0), weapon: { angle: -55 }, twist: -38, lean: -8, x: -1.2, drop: 1.8, hipYaw: -18, footF: { x: 4.2, z: -2.2, lift: 0.6, pitch: 10 }, eyes: "fierce", mouth: "grit", brow: -1, headPitch: -6, ease: "out" },
  // the cut: over the top and down, stepping in, the chest turning through — IMPACT
  { t: 0.375, handN: at(8.2, -2.8, 1.6), weapon: { angle: 122 }, twist: 30, lean: 20, x: 3.4, drop: 2.8, hipYaw: 14, footF: { x: 7.4, z: -2.0 }, footN: { x: -3.6, z: 2.9, pitch: -18 }, handF: at(-1.5, -4.5, -5.5), eyes: "fierce", mouth: "shout", headPitch: 6, sway: -2.6, ease: "snap" },
  // follow-through: the blade carries on low across the body
  { t: 0.55, handN: at(6.6, -6.8, 0.6), weapon: { angle: 158 }, twist: 38, lean: 22, x: 3.6, drop: 3.0, hipYaw: 16, footF: { x: 7.4, z: -2.0 }, footN: { x: -3.6, z: 2.9, pitch: -18 }, handF: at(-1.0, -5.5, -5.4), mouth: "open", sway: -1.6, ease: "out" },
  // recovery back to guard
  { t: 0.78, handN: at(5.4, -5.6, 2.4), weapon: { angle: 80 }, twist: 6, lean: 12, x: 1.4, drop: 2.0, hipYaw: 0, footF: { x: 5.8, z: -2.1 }, eyes: "focus", mouth: "rest", ease: "inOut" },
  { t: 1, ...vGuard, ease: "inOut" },
];

const vSkill: Key[] = [
  { t: 0, ...vGuard },
  // crouch and gather, both hands to the hilt
  { t: 0.18, drop: 5.0, lean: 14, handN: at(3.0, -6.0, 2.0), handF: GRIP, weapon: { angle: 150 }, twist: -10, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
  // the leap: rising, the blade swung up overhead in both hands
  { t: 0.33, drop: -3.0, lean: -10, handN: at(1.6, 8.0, 3.4), handF: GRIP, weapon: { angle: 12 }, twist: -20, x: 1.5, footN: { x: -2.5, z: 2.6, lift: 3.5, pitch: -20 }, footF: { x: 3.5, z: -2.2, lift: 4.5, pitch: -10 }, mouth: "shout", headPitch: -10, sway: 2, ease: "out" },
  // IMPACT: the slam — landing deep, blade driven down in front
  { t: 0.44, drop: 4.6, lean: 26, handN: at(8.4, -4.0, 1.4), handF: GRIP, weapon: { angle: 150 }, twist: 18, x: 4.4, footF: { x: 8.0, z: -2.2 }, footN: { x: -3.0, z: 2.8, pitch: -20 }, mouth: "shout", eyes: "fierce", headPitch: 8, sway: -3, glow: 1, ease: "snap" },
  { t: 0.62, drop: 4.0, lean: 22, handN: at(8.0, -4.6, 1.6), handF: GRIP, weapon: { angle: 152 }, twist: 16, x: 4.4, footF: { x: 8.0, z: -2.2 }, footN: { x: -3.0, z: 2.8, pitch: -20 }, mouth: "open", glow: 0.6, ease: "out" },
  { t: 0.82, drop: 2.2, lean: 12, handN: at(5.4, -5.4, 2.6), weapon: { angle: 85 }, twist: 0, x: 1.8, footF: { x: 6.0, z: -2.2 }, glow: 0.1, eyes: "focus", mouth: "rest", ease: "inOut" },
  { t: 1, ...vGuard, ease: "inOut" },
];

const vHit: Key[] = [
  { t: 0, ...vGuard },
  { t: 0.25, lean: -16, x: -2.4, drop: 2.2, headPitch: -16, twist: -24, handN: at(2.0, -2.0, 3.6), weapon: { angle: 10 }, handF: at(0.5, -2.0, -4.0), eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3.2, footF: { x: 4.0, z: -2.2, lift: 0.8, pitch: 14 }, ease: "snap" },
  { t: 0.6, lean: -6, x: -1.4, drop: 1.8, headPitch: -6, twist: -18, handN: at(3.6, -4.4, 3.4), weapon: { angle: 28 }, eyes: "hurt", mouth: "grit", sway: 1.6, ease: "out" },
  { t: 1, ...vGuard, ease: "inOut" },
];

const vBlock: Key[] = [
  { t: 0, ...vGuard },
  // a parry: the blade swept up across the front, the free hand bracing behind the flat
  { t: 0.3, handN: at(7.0, -1.2, 2.2), weapon: { angle: 35, roll: 0 }, handF: at(5.2, -2.8, -0.6), lean: -2, x: -0.8, twist: 6, drop: 2.0, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
  { t: 0.6, handN: at(6.8, -1.6, 2.2), weapon: { angle: 40 }, handF: at(5.0, -3.0, -0.8), lean: 0, x: -0.6, twist: 4, drop: 1.9, ease: "out" },
  { t: 1, ...vGuard, ease: "inOut" },
];

const vVictory: Key[] = [
  { t: 0, ...vGuard, handN: at(-2.6, 8.8, 7.6, [-0.6, 0.1, 1]), weapon: { angle: -6 }, handF: at(3.0, -4.0, -2.4), lean: -4, headPitch: -10, eyes: "cheer", mouth: "smile", drop: 0.6, twist: -4 },
  { t: 0.5, handN: at(-2.4, 9.4, 7.6, [-0.6, 0.1, 1]), weapon: { angle: -10 }, handF: at(3.4, -1.2, -2.6), lean: -6, headPitch: -14, eyes: "cheer", mouth: "open", drop: -0.2, ease: "inOut" },
];

export const VANGUARD: PoseLibrary = {
  stance: vGuard,
  stance2: vLow,
  carry: (kind, sN, sF) => ({
    handN: at(4.4 + sN * 0.8, -5.6 + (kind === "run" ? 0.6 : 0), 3.2),
    weapon: { angle: kind === "run" ? 62 : 48 + sN * 4 },
    handF: at(sF * (kind === "run" ? 4.6 : 3.4), -7.4 + Math.abs(sF) * 0.8, -4.8),
    eyes: "open", mouth: "rest", brow: -0.2, headPitch: kind === "run" ? -4 : -1,
  }),
  walk: { stance: 0.62, lift: 2.2, bob: 0.9, lean: 5, hipYaw: 10, counter: 0.7, armSwing: 3.4, width: 2.3, drop: 0.6 },
  run: { stance: 0.38, lift: 4.2, bob: 1.8, lean: 13, hipYaw: 16, counter: 0.8, armSwing: 4.6, width: 2.0, drop: 1.4 },
  attack: vAttack,
  skill: vSkill,
  hit: vHit,
  block: vBlock,
  ko: koBack(vGuard),
  victory: vVictory,
};

// ---------------------------------------------------------------------------------------------------------------- brute

const bGuard: Pose = pose({
  footF: { x: 5.2, z: -2.8 }, footN: { x: -4.6, z: 3.4, pitch: -6 },
  drop: 2.0, lean: 8, twist: -22, hipYaw: -16, headYaw: 8,
  // the greatsword held low at the near hip, point forward and up (a "tail guard" turned toward the foe)
  handN: at(3.6, -6.6, 3.0), handF: GRIP, weapon: { angle: 62 },
  sway: 0.6, brow: -0.4,
});

const bShoulder: Pose = pose({
  footF: { x: 4.0, z: -3.0 }, footN: { x: -4.0, z: 3.4 },
  drop: 1.4, lean: 4, twist: -10, hipYaw: -8,
  // the blade resting on the near shoulder, both hands on the long grip before the chest
  handN: at(4.0, -1.6, 2.4), handF: GRIP, weapon: { angle: -42 },
  sway: 0.5,
});

const bAttack: Key[] = [
  { t: 0, ...bGuard },
  { t: 0.22, handN: at(-1.0, 5.0, 3.0), handF: GRIP, weapon: { angle: -70 }, twist: -44, lean: -10, x: -1.6, drop: 2.6, hipYaw: -20, footF: { x: 4.6, z: -2.8, lift: 0.8, pitch: 10 }, eyes: "fierce", mouth: "grit", brow: -1, headPitch: -6, ease: "out" },
  { t: 0.375, handN: at(8.4, -3.4, 2.4), handF: GRIP, weapon: { angle: 128 }, twist: 30, lean: 24, x: 4.0, drop: 3.6, hipYaw: 16, footF: { x: 8.4, z: -2.6 }, footN: { x: -4.0, z: 3.2, pitch: -20 }, eyes: "fierce", mouth: "shout", headPitch: 8, sway: -3, ease: "snap" },
  { t: 0.56, handN: at(7.0, -6.6, 2.6), handF: GRIP, weapon: { angle: 160 }, twist: 36, lean: 26, x: 4.2, drop: 3.8, hipYaw: 18, footF: { x: 8.4, z: -2.6 }, footN: { x: -4.0, z: 3.2, pitch: -20 }, mouth: "open", sway: -2, ease: "out" },
  { t: 0.8, handN: at(4.2, -6.4, 2.6), handF: GRIP, weapon: { angle: 92 }, twist: 0, lean: 14, x: 1.8, drop: 2.6, hipYaw: -4, footF: { x: 6.4, z: -2.8 }, eyes: "focus", mouth: "rest", ease: "inOut" },
  { t: 1, ...bGuard, ease: "inOut" },
];

const bSkill: Key[] = [
  { t: 0, ...bGuard },
  // a spinning cleave: wind far back, then the blade sweeps round level at waist height
  { t: 0.2, handN: at(-3.0, -1.0, 4.4), handF: GRIP, weapon: { angle: -100, out: 20 }, twist: -60, lean: 6, x: -1.0, drop: 3.0, hipYaw: -28, eyes: "fierce", mouth: "grit", brow: -1, ease: "out" },
  { t: 0.44, handN: at(7.6, -2.2, -1.0), handF: GRIP, weapon: { angle: 95, out: -30 }, twist: 55, lean: 14, x: 2.4, drop: 3.4, hipYaw: 26, footF: { x: 7.0, z: -2.8 }, footN: { x: -4.4, z: 3.4, pitch: -20 }, mouth: "shout", glow: 1, sway: -3.4, ease: "snap" },
  { t: 0.64, handN: at(3.0, -3.0, -4.6), handF: GRIP, weapon: { angle: 120, out: -55 }, twist: 70, lean: 12, x: 2.4, drop: 3.2, hipYaw: 30, footF: { x: 7.0, z: -2.8 }, mouth: "open", glow: 0.5, ease: "out" },
  { t: 0.84, handN: at(4.0, -6.2, 2.2), handF: GRIP, weapon: { angle: 80 }, twist: 0, lean: 10, x: 1.0, drop: 2.4, hipYaw: -6, eyes: "focus", mouth: "rest", glow: 0.1, ease: "inOut" },
  { t: 1, ...bGuard, ease: "inOut" },
];

export const BRUTE: PoseLibrary = {
  stance: bGuard,
  stance2: bShoulder,
  carry: (kind, sN) => ({
    handN: at(3.4 + sN * 0.5, -5.4 + (kind === "run" ? 0.8 : 0), 3.0), handF: GRIP, weapon: { angle: kind === "run" ? 40 : 55 + sN * 3 },
    eyes: "open", mouth: "rest", brow: -0.4,
  }),
  walk: { stance: 0.64, lift: 2.0, bob: 1.0, lean: 7, hipYaw: 8, counter: 0.5, armSwing: 1, width: 2.8, drop: 1.0 },
  run: { stance: 0.4, lift: 3.6, bob: 1.8, lean: 14, hipYaw: 12, counter: 0.5, armSwing: 1, width: 2.6, drop: 1.8 },
  attack: bAttack,
  skill: bSkill,
  hit: [
    { t: 0, ...bGuard },
    { t: 0.25, lean: -12, x: -1.8, drop: 2.6, headPitch: -14, twist: -30, handN: at(2.4, -3.0, 3.4), handF: GRIP, weapon: { angle: 30 }, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 2.6, ease: "snap" },
    { t: 0.6, lean: -4, x: -1.0, drop: 2.2, headPitch: -4, twist: -26, weapon: { angle: 48 }, eyes: "hurt", mouth: "grit", ease: "out" },
    { t: 1, ...bGuard, ease: "inOut" },
  ],
  block: [
    { t: 0, ...bGuard },
    // the flat of the greatsword raised across the front as a wall
    { t: 0.3, handN: at(6.0, -1.0, 2.6), handF: GRIP, weapon: { angle: 20 }, lean: -2, x: -0.8, twist: 0, drop: 2.4, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
    { t: 0.6, handN: at(5.8, -1.4, 2.6), handF: GRIP, weapon: { angle: 24 }, lean: 0, x: -0.6, drop: 2.3, ease: "out" },
    { t: 1, ...bGuard, ease: "inOut" },
  ],
  ko: koBack(bGuard),
  victory: [
    // the greatsword planted point-down, both hands on the pommel, chest out
    { t: 0, ...bGuard, handN: at(6.2, -3.6, 1.6), handF: GRIP, weapon: { angle: 180 }, twist: 0, hipYaw: 0, lean: -4, headPitch: -10, eyes: "cheer", mouth: "smile", drop: 0.6, footF: { x: 3.0, z: -3.2 }, footN: { x: -3.0, z: 3.4 } },
    { t: 0.5, handN: at(6.2, -3.2, 1.6), handF: GRIP, weapon: { angle: 180 }, lean: -7, headPitch: -16, mouth: "open", drop: 0.2, ease: "inOut" },
  ],
};

// ---------------------------------------------------------------------------------------------------------------- duelist

const dGuard: Pose = pose({
  footF: { x: 6.0, z: -1.2 }, footN: { x: -4.8, z: 2.2, pitch: -4 },
  drop: 2.4, lean: 2, twist: 18, hipYaw: 22, headYaw: -4,
  // en garde: the blade arm forward, point at the foe's eyes; the buckler held up before the chest
  handN: at(7.4, -1.6, 2.6), weapon: { angle: 74 },
  handF: at(6.6, -1.4, -0.8), weapon2: { angle: 80 },
  sway: 0.5, brow: -0.2,
});

const dHigh: Pose = pose({
  footF: { x: 4.8, z: -1.6 }, footN: { x: -4.2, z: 2.4 },
  drop: 1.6, lean: 0, twist: 10, hipYaw: 14,
  handN: at(4.0, 2.4, 3.6), weapon: { angle: 48 },
  handF: at(-1.4, -6.6, -5.4, [0, 0, 1]), weapon2: { angle: 160 },
  sway: 0.5,
});

const dAttack: Key[] = [
  { t: 0, ...dGuard },
  // coil: the blade drawn back, the weight sinking onto the back leg
  { t: 0.2, handN: at(2.6, -1.0, 3.4), weapon: { angle: 82 }, x: -1.4, drop: 3.0, lean: -2, twist: 8, footF: { x: 5.6, z: -1.2, lift: 0.8, pitch: 12 }, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
  // the LUNGE: front foot thrown forward, back leg straight, arm and blade in one line — IMPACT at the point
  { t: 0.375, handN: at(10.6, -1.2, 1.4), weapon: { angle: 88 }, x: 4.6, drop: 4.4, lean: 12, twist: 26, hipYaw: 26, footF: { x: 11.2, z: -1.0, pitch: 6 }, footN: { x: -5.0, z: 2.2, pitch: -14 }, handF: at(-2.0, -1.0, -4.8), eyes: "fierce", mouth: "shout", sway: -2.4, ease: "snap" },
  { t: 0.55, handN: at(10.2, -1.6, 1.4), weapon: { angle: 90 }, x: 4.6, drop: 4.4, lean: 12, twist: 26, hipYaw: 26, footF: { x: 11.2, z: -1.0, pitch: 6 }, footN: { x: -5.0, z: 2.2, pitch: -14 }, handF: at(-2.0, -1.4, -4.8), mouth: "open", ease: "out" },
  { t: 0.8, handN: at(7.8, -1.8, 2.4), weapon: { angle: 78 }, x: 1.6, drop: 3.0, lean: 4, twist: 20, footF: { x: 7.6, z: -1.2 }, eyes: "focus", mouth: "rest", ease: "inOut" },
  { t: 1, ...dGuard, ease: "inOut" },
];

export const DUELIST: PoseLibrary = {
  stance: dGuard,
  stance2: dHigh,
  carry: (kind, sN, sF) => ({
    handN: at(6.0 + sN * 0.6, -3.0 + (kind === "run" ? -1.4 : 0), 3.0), weapon: { angle: kind === "run" ? 100 : 80 },
    handF: at(5.4 + sF * 0.6, -2.4, -1.0), weapon2: { angle: 80 },
    eyes: "open", mouth: "rest", brow: -0.2, twist: 8,
  }),
  walk: { stance: 0.6, lift: 2.0, bob: 0.8, lean: 3, hipYaw: 8, counter: 0.6, armSwing: 1.5, width: 1.9, drop: 1.4 },
  run: { stance: 0.36, lift: 4.4, bob: 1.8, lean: 12, hipYaw: 14, counter: 0.7, armSwing: 2, width: 1.7, drop: 1.8 },
  attack: dAttack,
  skill: [
    { t: 0, ...dGuard },
    // a flurry: three quick thrusts, the last the hardest
    { t: 0.12, handN: at(3.0, -1.0, 3.4), weapon: { angle: 84 }, x: -0.6, drop: 3.0, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    { t: 0.24, handN: at(10.0, 0.6, 1.4), weapon: { angle: 80 }, x: 2.4, drop: 3.2, lean: 6, twist: 24, footF: { x: 8.2, z: -1.0 }, ease: "snap" },
    { t: 0.33, handN: at(4.0, -2.0, 3.0), weapon: { angle: 86 }, x: 1.6, drop: 3.0, ease: "out" },
    { t: 0.44, handN: at(11.0, -1.6, 1.4), weapon: { angle: 92 }, x: 5.0, drop: 4.6, lean: 12, twist: 28, hipYaw: 28, footF: { x: 11.6, z: -1.0, pitch: 6 }, footN: { x: -5.0, z: 2.2, pitch: -14 }, mouth: "shout", eyes: "fierce", glow: 1, sway: -2.6, ease: "snap" },
    { t: 0.66, handN: at(10.4, -1.8, 1.4), weapon: { angle: 92 }, x: 5.0, drop: 4.6, lean: 12, twist: 28, hipYaw: 28, footF: { x: 11.6, z: -1.0, pitch: 6 }, footN: { x: -5.0, z: 2.2, pitch: -14 }, mouth: "open", glow: 0.4, ease: "out" },
    { t: 0.86, handN: at(7.6, -1.8, 2.4), weapon: { angle: 78 }, x: 1.4, drop: 2.8, twist: 20, footF: { x: 7.4, z: -1.2 }, eyes: "focus", mouth: "rest", glow: 0, ease: "inOut" },
    { t: 1, ...dGuard, ease: "inOut" },
  ],
  hit: [
    { t: 0, ...dGuard },
    { t: 0.25, lean: -14, x: -2.6, drop: 2.6, headPitch: -14, twist: 6, handN: at(5.0, 1.0, 3.4), weapon: { angle: 40 }, handF: at(2.0, 0.0, -3.4), eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, ease: "snap" },
    { t: 0.6, lean: -4, x: -1.4, drop: 2.4, headPitch: -4, twist: 14, weapon: { angle: 62 }, eyes: "hurt", mouth: "grit", ease: "out" },
    { t: 1, ...dGuard, ease: "inOut" },
  ],
  block: [
    { t: 0, ...dGuard },
    // the buckler punched out to meet the blow
    { t: 0.3, handF: at(8.2, -0.6, -0.4), weapon2: { angle: 85 }, handN: at(4.8, -0.6, 3.2), weapon: { angle: 50 }, x: -0.6, lean: 2, twist: -6, drop: 2.6, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
    { t: 0.6, handF: at(7.8, -0.8, -0.6), weapon2: { angle: 85 }, x: -0.5, twist: -4, ease: "out" },
    { t: 1, ...dGuard, ease: "inOut" },
  ],
  ko: koBack(dGuard),
  victory: [
    // a salute: the blade raised before the face, then swept down to the side
    // the salute's end: the blade swept down to the side, point to the floor, chin up
    { t: 0, ...dGuard, handN: at(3.0, -5.6, 5.4), weapon: { angle: 152 }, handF: at(-1.0, -6.0, -5.4, [0, 0, 1]), x: 0, drop: 0.8, lean: -2, twist: 0, hipYaw: 4, footF: { x: 3.4, z: -1.8 }, footN: { x: -3.0, z: 2.4 }, eyes: "cheer", mouth: "smile", headPitch: -6 },
    { t: 0.5, handN: at(3.2, -5.2, 5.4), weapon: { angle: 148 }, lean: -4, headPitch: -10, mouth: "open", drop: 0.4, ease: "inOut" },
  ],
};
