import type { Key } from "../anim";
import { at, GRIP, pose, type PoseLibrary } from "../clips";
import type { HandTarget, Pose } from "../rig";

import { koForward, koKneel } from "./common";

/**
 * MAGE and CLERIC pose languages — kept apart on purpose.
 *
 *   MAGE    gathers power INTO the staff and the free palm (a clear wind-up: drawn back, the crystal brightening), then THRUSTS it out: the bolt
 *           leaves the crystal. The cast is a channel that lifts the caster off the floor and blasts forward with both hands.
 *   CLERIC  upright and open: the smite POINTS the scepter at the foe after raising it to the sky; the cast is a BLESSING — hands together,
 *           then the arms opening into a V, face lifted, light pouring down. Falls forward, kneeling.
 */

interface CasterOpts {
  stance: Pose;
  alt: Pose;
  /** The staff / scepter drawn back (wind-up), and thrust / pointed (release). */
  gather: Partial<Pose>;
  release: Partial<Pose>;
  freeHand: HandTarget;
  walk: { drop: number; lean: number; width: number; lift: number };
}

function mageLib(o: CasterOpts): PoseLibrary {
  const s = o.stance;
  const attack: Key[] = [
    { t: 0, ...s },
    { t: 0.2, ...o.gather, glow: 0.5, lean: s.lean - 6, x: -0.8, twist: -14, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    { t: 0.375, ...o.release, glow: 1, lean: s.lean + 10, x: 1.6, twist: 16, footF: { ...s.footF, x: s.footF.x + 1.8 }, eyes: "fierce", mouth: "shout", sway: -2.4, ease: "snap" },
    { t: 0.6, ...o.release, glow: 0.6, lean: s.lean + 8, x: 1.6, twist: 14, footF: { ...s.footF, x: s.footF.x + 1.8 }, mouth: "open", ease: "out" },
    { t: 0.82, glow: 0.2, lean: s.lean + 2, x: 0.6, twist: 4, eyes: "focus", mouth: "rest", ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  const skill: Key[] = [
    { t: 0, ...s },
    // gather low
    { t: 0.18, drop: s.drop + 2.0, lean: s.lean + 8, ...o.gather, handF: at(4.0, -5.0, -1.4), glow: 0.4, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    // rise: staff and palm up, lifted off the floor
    { t: 0.34, drop: -1.8, lean: s.lean - 8, handN: at(3.0, 5.6, 3.6), weapon: { angle: -2 }, handF: at(4.0, 6.4, -1.6), footN: { ...s.footN, lift: 1.2, pitch: -20 }, footF: { ...s.footF, lift: 1.6, pitch: -20 }, glow: 0.8, headPitch: -12, sway: 2, ease: "out" },
    // IMPACT: both hands thrust forward — the blast
    { t: 0.44, drop: s.drop + 0.6, lean: s.lean + 12, x: 1.4, ...o.release, handF: at(9.4, 1.4, -0.6), glow: 1, mouth: "shout", eyes: "fierce", headPitch: 2, sway: -3, ease: "snap" },
    { t: 0.66, drop: s.drop + 0.6, lean: s.lean + 10, x: 1.4, ...o.release, handF: at(9.0, 1.0, -0.6), glow: 0.6, mouth: "open", ease: "out" },
    { t: 0.88, ...s, glow: 0.2, eyes: "open", mouth: "rest", ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  return {
    stance: s,
    stance2: o.alt,
    carry: (kind, sN, sF) => ({
      handN: s.handN, weapon: { ...s.weapon, angle: s.weapon.angle + (kind === "run" ? 16 : 3 + sN * 2) },
      handF: "grip" in s.handF ? GRIP : at(sF * (kind === "run" ? 3.6 : 2.4), -6.8, -4.6), glow: 0.1,
      eyes: "open", mouth: "rest",
    }),
    walk: { stance: 0.62, lift: o.walk.lift, bob: 0.5, lean: o.walk.lean, hipYaw: 6, counter: 0.6, armSwing: 2.4, width: o.walk.width, drop: o.walk.drop },
    run: { stance: 0.4, lift: o.walk.lift + 1.6, bob: 1.2, lean: o.walk.lean + 10, hipYaw: 10, counter: 0.7, armSwing: 3.6, width: o.walk.width - 0.2, drop: o.walk.drop + 1.0 },
    attack,
    skill,
    hit: [
      { t: 0, ...s },
      { t: 0.25, lean: s.lean - 16, x: -2.4, drop: s.drop + 1.0, headPitch: -16, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, glow: 0, ease: "snap" },
      { t: 0.6, lean: s.lean - 6, x: -1.2, drop: s.drop + 0.6, headPitch: -6, eyes: "hurt", mouth: "grit", ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    block: [
      { t: 0, ...s },
      // a ward: the free palm (or the staff) thrown up before the body, light flaring
      { t: 0.3, handF: "grip" in s.handF ? GRIP : at(8.4, 1.2, -0.8), handN: "grip" in s.handF ? at(6.0, 0.0, 2.8) : s.handN, weapon: "grip" in s.handF ? { angle: 10 } : s.weapon, lean: s.lean - 6, x: -0.8, drop: s.drop + 0.8, glow: 0.9, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
      { t: 0.6, lean: s.lean - 4, x: -0.6, glow: 0.6, ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    ko: koKneel(s),
    victory: [
      // the staff lifted high in one fist beside the head (a two-hander lets go with the other hand — a level staff overhead would cross the
      // face: the arms are too short to lift it clear), the free hand raised
      // (a short staff held in its middle is brandished forward-up at chest height instead: its lower half would cross the face if lifted)
      { t: 0, ...s, ...("grip" in s.handF ? { handN: at(7.4, 1.0, 3.6), weapon: { angle: 36 } } : { handN: at(-2.2, 8.0, 7.2, [-0.6, 0.1, 1]), weapon: { angle: -10 } }), handF: at(3.0, 6.0, -4.4), glow: 0.8, lean: -4, headPitch: -12, eyes: "cheer", mouth: "smile", drop: 0.4 },
      { t: 0.5, ...("grip" in s.handF ? { handN: at(7.6, 1.6, 3.6), weapon: { angle: 32 } } : { handN: at(-2.0, 8.6, 7.2, [-0.6, 0.1, 1]) }), handF: at(3.2, 6.6, -4.4), glow: 1, lean: -6, headPitch: -15, mouth: "open", drop: -0.2, ease: "inOut" },
    ],
  };
}

function clericLib(o: CasterOpts & { koFwd?: boolean }): PoseLibrary {
  const s = o.stance;
  const attack: Key[] = [
    { t: 0, ...s },
    // the scepter raised to the sky, eyes up
    { t: 0.2, ...o.gather, glow: 0.6, lean: s.lean - 6, headPitch: -12, eyes: "focus", mouth: "rest", brow: 0.4, ease: "out" },
    // SMITE: pointed at the foe, upright (no lunge)
    { t: 0.375, ...o.release, glow: 1, lean: s.lean + 6, x: 1.0, headPitch: 2, eyes: "fierce", mouth: "open", sway: -1.6, ease: "snap" },
    { t: 0.6, ...o.release, glow: 0.7, lean: s.lean + 5, x: 1.0, mouth: "rest", ease: "out" },
    { t: 0.82, glow: 0.2, lean: s.lean + 1, x: 0.4, eyes: "open", ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  const skill: Key[] = [
    { t: 0, ...s },
    // head bowed, hands together before the chest
    { t: 0.2, handN: at(5.6, -1.2, 2.4), weapon: { angle: 24 }, handF: at(5.4, -0.4, -0.2), headPitch: 16, lean: s.lean + 4, glow: 0.4, eyes: "closed", mouth: "rest", ease: "out" },
    // the arms open, rising
    { t: 0.34, handN: at(3.4, 4.6, 4.8), weapon: { angle: 0 }, handF: at(3.6, 4.8, -4.2), headPitch: -4, lean: s.lean - 2, drop: s.drop - 0.6, glow: 0.7, eyes: "closed", ease: "inOut" },
    // IMPACT: arms raised in a V, face lifted to the light
    { t: 0.44, handN: at(-2.4, 8.8, 7.6, [-0.6, 0.1, 1]), weapon: { angle: 28 }, handF: at(0.6, 9.4, -6.6), headPitch: -16, lean: s.lean - 6, drop: s.drop - 1.2, glow: 1, eyes: "cheer", mouth: "open", sway: 1.6, ease: "snap" },
    { t: 0.68, handN: at(-2.2, 8.4, 7.6, [-0.6, 0.1, 1]), weapon: { angle: 26 }, handF: at(0.8, 9.0, -6.6), headPitch: -14, lean: s.lean - 5, drop: s.drop - 1.0, glow: 0.8, ease: "out" },
    { t: 0.9, ...s, glow: 0.2, eyes: "open", mouth: "rest", ease: "inOut" },
    { t: 1, ...s, ease: "inOut" },
  ];
  return {
    stance: s,
    stance2: o.alt,
    carry: (kind, sN, sF) => ({
      handN: s.handN, weapon: { ...s.weapon, angle: s.weapon.angle + (kind === "run" ? 10 : sN * 2) },
      handF: o.freeHand === s.handF ? s.handF : at(sF * (kind === "run" ? 3.4 : 2.2), -6.8, -4.6), glow: 0.1,
      eyes: "open", mouth: "rest",
    }),
    walk: { stance: 0.62, lift: o.walk.lift, bob: 0.5, lean: o.walk.lean, hipYaw: 6, counter: 0.6, armSwing: 2.2, width: o.walk.width, drop: o.walk.drop },
    run: { stance: 0.4, lift: o.walk.lift + 1.6, bob: 1.2, lean: o.walk.lean + 9, hipYaw: 10, counter: 0.7, armSwing: 3.4, width: o.walk.width - 0.2, drop: o.walk.drop + 1.0 },
    attack,
    skill,
    hit: [
      { t: 0, ...s },
      { t: 0.25, lean: s.lean - 14, x: -2.2, drop: s.drop + 1.0, headPitch: -14, eyes: "hurt", mouth: "hurt", brow: 0.8, sway: 3, glow: 0, ease: "snap" },
      { t: 0.6, lean: s.lean - 5, x: -1.0, drop: s.drop + 0.6, headPitch: -5, eyes: "hurt", mouth: "rest", ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    block: [
      { t: 0, ...s },
      // a ward of light: the free hand raised palm-out, the weapon held upright before the body
      { t: 0.3, handF: at(7.6, 2.0, -0.8), handN: at(5.4, -1.0, 2.8), weapon: { angle: 4 }, lean: s.lean - 6, x: -0.8, drop: s.drop + 0.6, glow: 0.9, eyes: "focus", mouth: "rest", brow: -0.6, ease: "snap" },
      { t: 0.6, lean: s.lean - 4, x: -0.6, glow: 0.6, ease: "out" },
      { t: 1, ...s, ease: "inOut" },
    ],
    ko: o.koFwd ? koForward(s) : koKneel(s),
    victory: [
      { t: 0, ...s, handN: at(-2.4, 8.4, 7.4, [-0.6, 0.1, 1]), weapon: { angle: -10 }, handF: at(3.2, 5.0, -4.6), glow: 0.9, lean: -4, headPitch: -12, eyes: "cheer", mouth: "smile", drop: 0.4 },
      { t: 0.5, handN: at(-2.2, 9.0, 7.4, [-0.6, 0.1, 1]), handF: at(3.4, 5.8, -4.6), glow: 1, lean: -6, headPitch: -15, mouth: "open", drop: -0.2, ease: "inOut" },
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------------- mage

export const SCHOLAR = mageLib({
  stance: pose({
    footF: { x: 2.4, z: -2.2 }, footN: { x: -2.2, z: 2.4 }, drop: 0.4, lean: -1, twist: -4, headYaw: 4,
    // the staff planted beside him, the free palm before the chest, gathering light
    handN: at(8.6, -2.2, 3.4), weapon: { angle: 14 }, handF: at(5.6, -3.0, -1.2), glow: 0.25, sway: 0.8,
  }),
  alt: pose({
    footF: { x: 3.0, z: -2.2 }, footN: { x: -2.6, z: 2.4 }, drop: 0.8, lean: 3, twist: -2,
    handN: at(7.4, -2.8, 3.2), weapon: { angle: 36 }, handF: at(6.6, 2.2, -1.2), glow: 0.4, eyes: "focus", sway: 0.8,
  }),
  gather: { handN: at(1.6, 0.4, 4.2), weapon: { angle: -12 }, handF: at(2.4, -1.6, -2.6) },
  release: { handN: at(8.4, 2.4, 2.6), weapon: { angle: 34 }, handF: at(8.8, 0.4, -0.8) },
  freeHand: at(5.2, -2.6, -1.4),
  walk: { drop: 0.4, lean: 3, width: 1.9, lift: 1.8 },
});

export const BATTLEMAGE = mageLib({
  stance: pose({
    footF: { x: 4.0, z: -2.8 }, footN: { x: -3.8, z: 3.0, pitch: -6 }, drop: 1.8, lean: 7, twist: -10, hipYaw: -8, headYaw: 4,
    // a short staff held across the body in both hands
    handN: at(5.6, -4.0, 3.4), handF: GRIP, weapon: { angle: 66 }, glow: 0.2, sway: 0.7, brow: -0.4,
  }),
  alt: pose({
    footF: { x: 3.6, z: -2.8 }, footN: { x: -3.4, z: 3.0 }, drop: 1.4, lean: 4, twist: -6,
    handN: at(6.6, -3.0, 3.2), handF: GRIP, weapon: { angle: 44 }, glow: 0.3, sway: 0.7,
  }),
  gather: { handN: at(1.4, 0.0, 4.4), handF: GRIP, weapon: { angle: -52 } },
  release: { handN: at(9.2, 0.0, 2.6), handF: GRIP, weapon: { angle: 80 } },
  freeHand: GRIP,
  walk: { drop: 1.2, lean: 6, width: 2.4, lift: 2.0 },
});

export const SAGE = mageLib({
  stance: pose({
    footF: { x: 2.6, z: -2.2 }, footN: { x: -2.2, z: 2.4, pitch: -4 }, drop: 1.0, lean: 4, twist: -4, headYaw: 4, headPitch: -4,
    // hunched over a tall crook staff, the other hand behind the back
    handN: at(8.4, -3.0, 3.0), weapon: { angle: 12 }, handF: at(-3.6, -6.0, -2.6, [0.2, 0, -1]), glow: 0.15, sway: 0.6,
  }),
  alt: pose({
    footF: { x: 2.8, z: -2.2 }, footN: { x: -2.4, z: 2.4 }, drop: 1.0, lean: 4,
    handN: at(8.6, -2.8, 3.0), weapon: { angle: 13 }, handF: at(6.6, 0.6, -1.2), glow: 0.35, eyes: "focus", sway: 0.6,
  }),
  gather: { handN: at(2.4, 1.6, 3.6), weapon: { angle: -16 }, handF: at(3.0, 0.0, -2.2) },
  release: { handN: at(7.8, 1.6, 2.6), weapon: { angle: 30 }, handF: at(8.6, 0.6, -0.8) },
  freeHand: at(-3.6, -6.0, -2.6),
  walk: { drop: 1.2, lean: 6, width: 1.9, lift: 1.4 },
});

// ------------------------------------------------------------------------------------------------------------------------- cleric

export const PRIEST = clericLib({
  stance: pose({
    footF: { x: 2.6, z: -2.2 }, footN: { x: -2.4, z: 2.4 }, drop: 0.4, lean: -2, twist: -2, headYaw: 4,
    // the scepter upright before the chest, the tome open on the other hand
    handN: at(6.4, -4.4, 2.8), weapon: { angle: 10 }, handF: at(4.8, -4.8, -1.6), glow: 0.15, sway: 0.6,
  }),
  alt: pose({
    footF: { x: 2.6, z: -2.2 }, footN: { x: -2.4, z: 2.4 }, drop: 0.4, lean: -3, headPitch: -6,
    // a blessing: the scepter lowered, the free hand raised high, palm out
    handN: at(2.4, -7.6, 4.8), weapon: { angle: 150 }, handF: at(4.8, 6.6, -2.8), glow: 0.35, sway: 0.6,
  }),
  gather: { handN: at(2.0, 7.0, 3.6), weapon: { angle: -6 } },
  release: { handN: at(9.0, 1.2, 2.4), weapon: { angle: 74 } },
  freeHand: at(4.8, -4.6, -1.6),
  walk: { drop: 0.4, lean: 2, width: 2.0, lift: 1.8 },
});

export const TEMPLAR = clericLib({
  stance: pose({
    footF: { x: 3.8, z: -2.8 }, footN: { x: -3.6, z: 3.0, pitch: -4 }, drop: 1.2, lean: 2, twist: -4, headYaw: 4,
    // the holy mace on the shoulder, the free hand open before the chest
    handN: at(3.0, 0.6, 4.6), weapon: { angle: -48 }, handF: at(4.6, -3.2, -1.8), glow: 0.1, sway: 0.6,
  }),
  alt: pose({
    footF: { x: 3.0, z: -2.8 }, footN: { x: -3.0, z: 3.0 }, drop: 0.8, lean: 0,
    handN: at(4.2, -6.4, 4.0), weapon: { angle: 172 }, handF: at(4.4, 5.6, -2.6), glow: 0.3, sway: 0.6,
  }),
  gather: { handN: at(-0.8, 7.2, 4.6), weapon: { angle: -30 } },
  release: { handN: at(8.6, -2.0, 2.4), weapon: { angle: 122 } },
  freeHand: at(4.6, -3.2, -1.8),
  walk: { drop: 1.0, lean: 4, width: 2.6, lift: 2.0 },
  koFwd: true,
});

export const MONK = clericLib({
  stance: pose({
    footF: { x: 2.6, z: -2.2 }, footN: { x: -2.4, z: 2.4 }, drop: 0.4, lean: -1, twist: -4, headYaw: 4,
    // the tall sun-staff grounded, the other hand raised before the chest in prayer
    handN: at(8.6, -1.8, 3.4), weapon: { angle: 14 }, handF: at(5.8, -0.6, -0.8), glow: 0.2, sway: 0.6,
  }),
  alt: pose({
    footF: { x: 2.6, z: -2.2 }, footN: { x: -2.4, z: 2.4 }, drop: 0.4, lean: -2, headPitch: -6,
    handN: at(8.6, -1.8, 3.4), weapon: { angle: 14 }, handF: at(4.6, 6.8, -2.6), glow: 0.35, sway: 0.6,
  }),
  gather: { handN: at(3.0, 4.0, 4.0), weapon: { angle: -10 } },
  release: { handN: at(7.8, 2.0, 2.8), weapon: { angle: 32 }, handF: at(8.4, 0.8, -0.8) },
  freeHand: at(5.6, 0.2, -0.8),
  walk: { drop: 0.4, lean: 2, width: 2.0, lift: 1.8 },
});
