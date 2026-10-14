import type { Key } from "../anim";
import { at, pose, type PoseLibrary } from "../clips";
import type { Pose } from "../rig";

import { koBack } from "./common";

/**
 * ROGUE pose languages: low centre of gravity, compact weapon handling, fast directed strikes, quick hops out of reach.
 *
 *   cutthroat   a low crouch: the front dagger forward, the back one reversed along the forearm; a dashing stab
 *   assassin    tall and still, long knives reversed; a stab driven down from above
 *   brawler     a boxer's guard (blades at chest height, forward of the face); quick jabs
 */

const flip = (o: Partial<Pose>): Partial<Pose> => o;

function rogueLib(o: { guard: Pose; alt: Pose; coil: Partial<Pose>; strike: Partial<Pose>; follow: Partial<Pose>; walkDrop: number; bounce?: number }): PoseLibrary {
  const g = o.guard;
  const attack: Key[] = [
    { t: 0, ...g },
    { t: 0.2, ...o.coil, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    { t: 0.375, ...o.strike, eyes: "fierce", mouth: "shout", sway: -2.6, glow: 1, ease: "snap" },
    { t: 0.55, ...o.follow, mouth: "open", glow: 0.6, ease: "out" },
    // a hop back out of reach
    { t: 0.78, x: 0.6, drop: g.drop + 0.6, lean: g.lean - 4, footF: { ...g.footF, lift: 1.2 }, footN: { ...g.footN, lift: 0.6 }, eyes: "focus", mouth: "rest", glow: 0.1, ease: "out" },
    { t: 1, ...g, ease: "inOut" },
  ];
  const skill: Key[] = [
    { t: 0, ...g },
    // shadow step: crouch, a leap with both blades high, the cross-cut on landing
    { t: 0.18, drop: g.drop + 2.4, lean: g.lean + 8, x: -1.6, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    { t: 0.32, drop: -3.5, lean: g.lean - 6, x: 2.4, handN: at(2.0, 6.0, 4.0), weapon: { angle: -30 }, handF: at(1.5, 6.0, -3.6), weapon2: { angle: -40 }, footN: { ...g.footN, x: g.footN.x + 1.5, lift: 4.0, pitch: -20 }, footF: { ...g.footF, lift: 4.6, pitch: -10 }, sway: 2, glow: 0.6, ease: "out" },
    { t: 0.44, drop: g.drop + 1.8, lean: g.lean + 12, x: 6.2, handN: at(8.6, -5.4, 2.0), weapon: { angle: 150 }, handF: at(7.6, -4.6, -1.2), weapon2: { angle: 140 }, footF: { ...g.footF, x: g.footF.x + 5.2 }, footN: { ...g.footN, x: g.footN.x + 3.4, pitch: -16 }, mouth: "shout", eyes: "fierce", glow: 1, sway: -3.6, ease: "snap" },
    { t: 0.64, drop: g.drop + 1.6, lean: g.lean + 10, x: 6.2, handN: at(8.2, -5.8, 2.2), weapon: { angle: 152 }, handF: at(7.2, -5.0, -1.2), weapon2: { angle: 142 }, footF: { ...g.footF, x: g.footF.x + 5.2 }, footN: { ...g.footN, x: g.footN.x + 3.4, pitch: -16 }, mouth: "open", glow: 0.5, ease: "out" },
    { t: 0.86, ...g, x: 2.0, eyes: "focus", mouth: "rest", glow: 0, ease: "inOut" },
    { t: 1, ...g, ease: "inOut" },
  ];
  return {
    stance: g,
    stance2: o.alt,
    carry: (kind, sN, sF) => (kind === "run"
      // a low sprint, blades trailing
      ? { handN: at(2.0 + sN * 2.6, -4.2, 4.8), weapon: { angle: 108 }, handF: at(1.4 + sF * 2.6, -4.6, -4.6), weapon2: { angle: 120 }, headPitch: -10, eyes: "focus", mouth: "rest" }
      : { handN: g.handN, weapon: g.weapon, handF: g.handF, weapon2: g.weapon2, eyes: "open", mouth: "rest" }),
    walk: { stance: 0.6, lift: 2.4, bob: 0.8, lean: g.lean * 0.6, hipYaw: 8, counter: 0.7, armSwing: 1, width: 2.4, drop: o.walkDrop },
    run: { stance: 0.34, lift: 4.6, bob: 1.6, lean: 24, hipYaw: 14, counter: 0.8, armSwing: 3, width: 2.0, drop: o.walkDrop + 1.6 },
    attack,
    skill,
    hit: [
      { t: 0, ...g },
      { t: 0.25, lean: g.lean - 22, x: -3.0, drop: g.drop + 1.0, headPitch: -16, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, footF: { ...g.footF, lift: 1.4, pitch: 12 }, ease: "snap" },
      { t: 0.6, lean: g.lean - 8, x: -1.8, drop: g.drop + 0.6, headPitch: -6, eyes: "hurt", mouth: "grit", ease: "out" },
      { t: 1, ...g, ease: "inOut" },
    ],
    block: [
      { t: 0, ...g },
      // a slip: the body sways back out of the line, the blades crossed before the chest
      { t: 0.3, lean: g.lean - 16, x: -2.6, twist: -18, drop: g.drop + 1.0, handN: at(5.4, -0.6, 2.2), weapon: { angle: 30 }, handF: at(5.4, -0.8, -0.6), weapon2: { angle: -30 }, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
      { t: 0.6, lean: g.lean - 10, x: -2.0, twist: -12, drop: g.drop + 0.8, ease: "out" },
      { t: 1, ...g, ease: "inOut" },
    ],
    ko: koBack(g),
    victory: [
      // a blade tossed and caught, the other hand on the hip
      // the toss happens out in front of the chest, below the face
      { t: 0, ...o.alt, handN: at(6.6, 0.0, 3.6), weapon: { angle: 20 }, handF: at(-1.2, -6.4, -5.4, [0, 0, 1]), eyes: "cheer", mouth: "smile", headPitch: -4, drop: 1.0 },
      { t: 0.25, handN: at(6.8, 1.0, 3.6), weapon: { angle: 160 }, mouth: "open", ease: "out" },
      { t: 0.5, handN: at(6.6, 1.6, 3.6), weapon: { angle: 320 }, headPitch: -6, ease: "linear" },
      { t: 0.75, handN: at(6.6, 0.6, 3.6), weapon: { angle: 380 }, mouth: "smile", ease: "in" },
    ],
  };
}

export const CUTTHROAT = rogueLib({
  guard: pose({
    footF: { x: 5.0, z: -2.6 }, footN: { x: -4.6, z: 3.0, pitch: -12 }, drop: 4.2, lean: 18, twist: 6, hipYaw: 4, headPitch: -8, headYaw: 4,
    handN: at(6.2, -3.4, 3.2), weapon: { angle: 82 }, handF: at(3.2, -4.4, -3.4), weapon2: { angle: 192 }, sway: 0.8, brow: -0.6,
  }),
  alt: pose({
    footF: { x: 3.4, z: -2.6 }, footN: { x: -3.0, z: 3.0 }, drop: 1.4, lean: 4, side: 3, twist: 4,
    handN: at(3.0, -6.6, 4.2), weapon: { angle: 168 }, handF: at(2.0, -6.4, -4.4), weapon2: { angle: 172 }, sway: 0.8,
  }),
  coil: { handN: at(1.6, -3.0, 3.8), weapon: { angle: 86 }, x: -1.2, drop: 5.0, lean: 14, twist: -10 },
  strike: { handN: at(10.6, -1.6, 2.0), weapon: { angle: 92 }, x: 5.0, drop: 5.4, lean: 26, twist: 24, hipYaw: 16, footF: { x: 9.6, z: -2.4 }, footN: { x: -4.2, z: 3.0, pitch: -24 } },
  follow: flip({ handN: at(5.0, -3.0, 3.6), handF: at(9.6, -2.4, -0.2), weapon2: { angle: 98 }, x: 5.2, drop: 5.2, lean: 24, twist: -16, footF: { x: 9.6, z: -2.4 }, footN: { x: -4.2, z: 3.0, pitch: -24 } }),
  walkDrop: 2.6,
});

export const ASSASSIN = rogueLib({
  guard: pose({
    footF: { x: 3.6, z: -2.0 }, footN: { x: -3.6, z: 2.4, pitch: -6 }, drop: 1.0, lean: 5, twist: 2, headYaw: 4,
    handN: at(3.2, -5.4, 4.0), weapon: { angle: 172 }, handF: at(2.2, -5.8, -4.0), weapon2: { angle: 176 }, sway: 0.6, brow: -0.8,
  }),
  alt: pose({
    footF: { x: 2.8, z: -2.2 }, footN: { x: -2.8, z: 2.4 }, drop: 0.6, lean: 2,
    handN: at(1.6, -6.4, 4.6), weapon: { angle: 176 }, handF: at(1.2, -6.4, -4.4), weapon2: { angle: 178 }, sway: 0.6,
  }),
  coil: { handN: at(1.4, 4.6, 4.2), weapon: { angle: 205 }, x: -0.6, drop: 1.8, lean: -4, twist: -16 },
  strike: { handN: at(9.4, -3.0, 2.2), weapon: { angle: 158 }, x: 4.4, drop: 3.6, lean: 22, twist: 22, hipYaw: 14, footF: { x: 8.4, z: -2.0 }, footN: { x: -3.6, z: 2.4, pitch: -22 } },
  follow: { handN: at(8.6, -5.0, 2.4), weapon: { angle: 172 }, x: 4.4, drop: 3.8, lean: 22, twist: 22, footF: { x: 8.4, z: -2.0 }, footN: { x: -3.6, z: 2.4, pitch: -22 } },
  walkDrop: 0.6,
});

export const BRAWLER = rogueLib({
  guard: pose({
    footF: { x: 4.4, z: -3.0 }, footN: { x: -4.0, z: 3.2, pitch: -10 }, drop: 2.6, lean: 12, twist: 10, hipYaw: 8, headPitch: -6, headYaw: 4,
    // a boxer's guard: blades up at chest height, forward of the face
    handN: at(6.6, 0.8, 2.8), weapon: { angle: 66 }, handF: at(5.2, 1.4, -1.6), weapon2: { angle: 58 }, sway: 0.6, brow: -0.8,
  }),
  alt: pose({
    footF: { x: 3.6, z: -3.0 }, footN: { x: -3.4, z: 3.2 }, drop: 1.8, lean: 6, twist: 4,
    handN: at(5.6, -1.6, 3.2), weapon: { angle: 80 }, handF: at(4.6, -1.0, -2.0), weapon2: { angle: 74 }, sway: 0.6,
  }),
  coil: { handN: at(4.0, 0.6, 3.4), weapon: { angle: 72 }, x: -0.8, drop: 3.2, lean: 10, twist: -8 },
  strike: { handN: at(11.2, 1.0, 1.8), weapon: { angle: 84 }, x: 3.6, drop: 3.2, lean: 18, twist: 28, hipYaw: 18, footF: { x: 7.4, z: -3.0 }, footN: { x: -4.0, z: 3.2, pitch: -20 } },
  follow: { handN: at(6.0, 0.6, 3.0), handF: at(10.6, 0.8, -0.2), weapon2: { angle: 80 }, x: 3.8, drop: 3.2, lean: 18, twist: -14, footF: { x: 7.4, z: -3.0 }, footN: { x: -4.0, z: 3.2, pitch: -20 } },
  walkDrop: 2.0,
});
