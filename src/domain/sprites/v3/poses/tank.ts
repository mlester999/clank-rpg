import type { Key } from "../anim";
import { at, pose, type PoseLibrary } from "../clips";
import type { Pose } from "../rig";

import { koForward } from "./common";

/**
 * TANK pose languages: a heavy planted stance behind the shield, weight low; blows that the whole body follows; a shield bash; a wall that
 * barely gives when hit; a heavy march.
 *
 *   bulwark      shield forward at the waist, the mace resting over its rim
 *   juggernaut   the shield held high (below the eyes), the maul low behind it
 *   sentinel     the shield grounded at the side, the long hammer upright
 */

type Lib = (o: { guard: Pose; rest: Pose; smashFrom: Partial<Pose>; heavy: number }) => PoseLibrary;

const tankLib: Lib = ({ guard, rest, smashFrom, heavy }) => {
  const attack: Key[] = [
    { t: 0, ...guard },
    // the weapon hauled up and back, the shield tucked in, the weight back
    { t: 0.22, ...smashFrom, shieldYaw: 18, lean: -6, twist: -22, x: -1.0, drop: guard.drop + 0.4, hipYaw: -14, eyes: "fierce", mouth: "grit", brow: -1, headPitch: -4, ease: "out" },
    // IMPACT: the overhead smash, a step in, everything behind it
    { t: 0.375, handN: at(8.4, -2.4, 2.0), weapon: { angle: 128 }, handF: at(5.0, -4.6, -1.6), shieldYaw: 22, lean: 22, twist: 26, x: 2.8, drop: guard.drop + 1.6, hipYaw: 14, footF: { x: guard.footF.x + 2.4, z: guard.footF.z }, footN: { ...guard.footN, pitch: -18 }, eyes: "fierce", mouth: "shout", headPitch: 8, sway: -2.4, ease: "snap" },
    { t: 0.56, handN: at(7.4, -5.6, 1.8), weapon: { angle: 152 }, lean: 22, twist: 28, x: 2.8, drop: guard.drop + 1.8, hipYaw: 14, footF: { x: guard.footF.x + 2.4, z: guard.footF.z }, footN: { ...guard.footN, pitch: -18 }, mouth: "open", sway: -1.6, ease: "out" },
    { t: 0.8, handN: at(5.0, -3.6, 3.6), weapon: { angle: 90 }, lean: 14, twist: 6, x: 1.2, drop: guard.drop + 0.8, footF: { x: guard.footF.x + 1.2, z: guard.footF.z }, eyes: "focus", mouth: "rest", ease: "inOut" },
    { t: 1, ...guard, ease: "inOut" },
  ];
  const skill: Key[] = [
    { t: 0, ...guard },
    // shield bash: brace low, then drive the shield out with a step
    { t: 0.2, handF: at(4.0, -3.0, -1.4), shieldYaw: 30, lean: 4, drop: guard.drop + 1.6, x: -1.0, twist: -10, eyes: "focus", mouth: "grit", brow: -1, ease: "out" },
    { t: 0.44, handF: at(11.0, -1.6, 0.0), shieldYaw: 28, shieldPitch: 4, lean: 18, drop: guard.drop + 1.4, x: 4.6, twist: 16, hipYaw: 10, footF: { x: guard.footF.x + 4.0, z: guard.footF.z }, footN: { ...guard.footN, pitch: -20 }, mouth: "shout", eyes: "fierce", glow: 1, sway: -3, ease: "snap" },
    { t: 0.64, handF: at(10.6, -1.8, 0.0), shieldYaw: 30, lean: 16, x: 4.6, twist: 14, footF: { x: guard.footF.x + 4.0, z: guard.footF.z }, footN: { ...guard.footN, pitch: -20 }, mouth: "open", glow: 0.5, ease: "out" },
    { t: 0.86, handF: guard.handF, shieldYaw: guard.shieldYaw, lean: guard.lean + 4, x: 1.4, twist: 0, footF: { x: guard.footF.x + 1.4, z: guard.footF.z }, eyes: "focus", mouth: "rest", glow: 0, ease: "inOut" },
    { t: 1, ...guard, ease: "inOut" },
  ];
  return {
    stance: guard,
    stance2: rest,
    carry: (kind, sN) => ({
      handN: kind === "run" ? at(4.2 + sN * 0.6, -3.0, 4.4) : guard.handN, weapon: { angle: kind === "run" ? 50 : guard.weapon.angle + sN * 3 },
      handF: kind === "run" ? at(6.6, -6.4, -1.6) : at(8.0, -3.4, -0.4), shieldYaw: kind === "run" ? 40 : 46, shieldPitch: kind === "run" ? -6 : 3,
      eyes: "open", mouth: "rest", brow: -0.4,
    }),
    walk: { stance: 0.66, lift: 1.7, bob: 1.1 + heavy * 0.3, lean: 8, hipYaw: 6, counter: 0.5, armSwing: 1, width: 3.0, drop: 1.6 + heavy * 0.4 },
    run: { stance: 0.44, lift: 3.0, bob: 1.8 + heavy * 0.4, lean: 15, hipYaw: 10, counter: 0.5, armSwing: 1, width: 2.8, drop: 2.2 + heavy * 0.4 },
    attack,
    skill,
    hit: [
      { t: 0, ...guard },
      // a wall: it barely gives
      { t: 0.25, lean: guard.lean - 8, x: -1.2, drop: guard.drop + 0.8, headPitch: -8, twist: guard.twist - 8, shieldYaw: guard.shieldYaw + 8, eyes: "hurt", mouth: "grit", brow: 0.6, sway: 1.6, ease: "snap" },
      { t: 0.6, lean: guard.lean - 3, x: -0.6, drop: guard.drop + 0.4, headPitch: -2, eyes: "hurt", mouth: "grit", ease: "out" },
      { t: 1, ...guard, ease: "inOut" },
    ],
    block: [
      { t: 0, ...guard },
      // the shield snaps up to meet the blow, the body braced behind it
      { t: 0.3, handF: at(9.0, 0.2, -0.2), shieldYaw: 36, shieldPitch: 8, lean: guard.lean - 2, x: -0.6, drop: guard.drop + 1.2, eyes: "focus", mouth: "grit", brow: -1, ease: "snap" },
      { t: 0.6, handF: at(8.8, -0.2, -0.2), shieldYaw: 38, shieldPitch: 6, x: -0.5, drop: guard.drop + 1.1, ease: "out" },
      { t: 1, ...guard, ease: "inOut" },
    ],
    ko: koForward(guard),
    victory: [
      { t: 0, ...guard, handN: at(-2.8, 8.6, 8.0, [-0.6, 0.1, 1]), weapon: { angle: -8 }, handF: at(5.6, -6.0, -2.4), shieldYaw: 40, lean: -4, drop: 1.0, headPitch: -10, eyes: "cheer", mouth: "smile", twist: -10 },
      { t: 0.5, handN: at(-2.6, 9.2, 8.0, [-0.6, 0.1, 1]), weapon: { angle: -12 }, lean: -6, drop: 0.6, headPitch: -14, mouth: "open", ease: "inOut" },
    ],
  };
};

export const BULWARK = tankLib({
  heavy: 0,
  guard: pose({
    footF: { x: 4.4, z: -3.0 }, footN: { x: -4.4, z: 3.4, pitch: -6 }, drop: 2.4, lean: 9, twist: -8, hipYaw: -8, headYaw: 4,
    handF: at(8.6, -3.2, -0.4), shieldYaw: 48, shieldPitch: 3,
    handN: at(4.4, -3.8, 4.4), weapon: { angle: 76 }, sway: 0.6, brow: -0.4,
  }),
  rest: pose({
    footF: { x: 3.4, z: -3.2 }, footN: { x: -3.6, z: 3.4 }, drop: 1.6, lean: 4, twist: -4,
    handF: at(7.0, -6.8, -1.2), shieldYaw: 44, shieldPitch: -6,
    handN: at(0.8, -8.6, 5.6), weapon: { angle: 165 }, sway: 0.5,
  }),
  smashFrom: { handN: at(-0.2, 8.4, 5.4), weapon: { angle: -28 }, handF: at(5.0, -4.2, -1.4) },
});

export const JUGGERNAUT = tankLib({
  heavy: 1,
  guard: pose({
    footF: { x: 4.8, z: -3.4 }, footN: { x: -4.6, z: 3.8, pitch: -6 }, drop: 2.8, lean: 10, twist: -6, hipYaw: -6, headYaw: 4,
    // the shield held high — its rim stays below the eyes
    handF: at(8.4, -2.0, -0.2), shieldYaw: 46, shieldPitch: 2,
    handN: at(1.6, -6.8, 5.4), weapon: { angle: 120 }, sway: 0.6, brow: -0.6,
  }),
  rest: pose({
    footF: { x: 3.8, z: -3.6 }, footN: { x: -3.8, z: 3.8 }, drop: 2.0, lean: 5,
    handF: at(7.2, -6.2, -1.0), shieldYaw: 42, shieldPitch: -4,
    handN: at(3.0, 1.0, 5.0), weapon: { angle: -50 }, sway: 0.5,
  }),
  smashFrom: { handN: at(-1.2, 5.8, 4.6), weapon: { angle: -60 }, handF: at(5.4, -3.0, -1.0) },
});

export const SENTINEL = tankLib({
  heavy: 0,
  guard: pose({
    footF: { x: 3.8, z: -3.0 }, footN: { x: -3.8, z: 3.2, pitch: -4 }, drop: 1.6, lean: 4, twist: -6, hipYaw: -6, headYaw: 4,
    // the shield grounded at the side, the long hammer upright
    handF: at(5.6, -7.0, -2.0), shieldYaw: 52, shieldPitch: -3,
    handN: at(8.4, -3.2, 4.0), weapon: { angle: 18 }, sway: 0.5, brow: -0.2,
  }),
  rest: pose({
    footF: { x: 3.0, z: -3.0 }, footN: { x: -3.0, z: 3.2 }, drop: 1.0, lean: 2,
    handF: at(5.8, -6.4, -2.0), shieldYaw: 50, shieldPitch: -4,
    handN: at(4.4, -4.6, 4.2), weapon: { angle: 172 }, sway: 0.5,
  }),
  smashFrom: { handN: at(0.2, 6.6, 4.4), weapon: { angle: -24 }, handF: at(5.0, -4.6, -1.6) },
});
