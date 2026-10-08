import { ARCHETYPE_POSES } from "./archetypes";
import { at, breath, CLIP_ORDER, CLIPS, E, koBack, koForward, M, NEUTRAL, P, type ClipName, type ClipSpec, type Pose, type Pt } from "./poseKit";

/**
 * HERO RENDERER v2 — the SKELETONS of the `clank-dev-v2` sprite set: THREE ARCHETYPES PER CLASS.
 *
 * Every hero of a class used to be the same body in the same stance holding the same-sized weapon — twenty Warriors were one figure in
 * twenty helmets. Each class now has three ARCHETYPES, each its own skeleton: its own BUILD (height, shoulders, limb weight, head size), its
 * own WEAPON SCALE and GRIP, and its own POSE LANGUAGE (stances, stride, swing, cast, hit, KO). A hero's archetype is chosen from its
 * never-rerolled look (plan.rigOf — the weapon item lists its class's skeletons in `builds`), like every other design choice:
 *
 *   warrior           the vanguard — broad, a one-handed sword up in a planted guard, a rotating swing (the original Warrior)
 *   warrior-brute     a heavy two-hander — the widest Warrior, a GREATSWORD on the shoulder or planted point-down, both hands on the hilt
 *   warrior-duelist   tall and lean — a fencer's stance side-on, sword forward and a BUCKLER raised, a long lunge
 *   tank              the bulwark — stocky, shield forward at the waist, mace on the shoulder (the original Tank)
 *   tank-juggernaut   the biggest body in the arena — squat and massive, the shield held HIGH, a heavy mace low behind it, a rising smash
 *   tank-sentinel     a tall knight — the shield grounded at the side, a long-hafted mace raised upright, an overhead chop
 *   rogue             the cutthroat — slim, a low crouch, twin daggers (the original Rogue)
 *   rogue-assassin    tall and whip-thin — upright and still, long knives held reversed, a gliding stalk and a lunging stab
 *   rogue-brawler     short and stocky — a boxer's guard with the knives up at the face, bouncing on the feet, quick jabs
 *   ranger            the scout — upright, a recurve carried upright (the original Ranger)
 *   ranger-warden     tall and broad — a LONGBOW nearly as tall as the hero, a wide planted stance, a deep slow draw
 *   ranger-skirmisher small and quick — a crouch with a SHORTBOW held low and level, a snap shot from the hip
 *   mage              the scholar — tall and slight, staff planted, the free palm glowing (the original Mage)
 *   mage-battle       the battlemage — broad, a short staff held ACROSS the body in both hands, leaning into every cast
 *   mage-sage         the elder — HUNCHED, a tall staff leaned on, the other hand behind the back, a slow shuffle
 *   cleric            the priest — steady, scepter upright before the chest (the original Cleric)
 *   cleric-templar    the crusader — broad and upright, a heavy holy mace on the shoulder, an overhead smite
 *   cleric-monk       the pilgrim — slight, a tall sun-staff grounded beside, the other hand raised in prayer, a kneeling blessing
 *
 * Clip lengths, frame rates and impact frames are SHARED (poseKit.CLIPS): the combat timing the arena lines up with the server never depends on
 * the class or the archetype; only the poses differ. Every pose is GROUNDED: the lowest foot (or knee, when kneeling) stands on the floor line,
 * so a crouch lowers the hips instead of lifting the feet; `oy` is height above the floor (negative = airborne).
 */

export type ClassRig = "warrior" | "tank" | "rogue" | "ranger" | "mage" | "cleric";
export type RigId =
  | ClassRig
  | "warrior-brute" | "warrior-duelist"
  | "tank-juggernaut" | "tank-sentinel"
  | "rogue-assassin" | "rogue-brawler"
  | "ranger-warden" | "ranger-skirmisher"
  | "mage-battle" | "mage-sage"
  | "cleric-templar" | "cleric-monk";

export const CLASS_RIG_IDS: readonly ClassRig[] = ["warrior", "tank", "rogue", "ranger", "mage", "cleric"];
/** The skeletons of each class: the original first (the default), then its two archetypes. */
export const CLASS_RIGS: Record<ClassRig, readonly RigId[]> = {
  warrior: ["warrior", "warrior-brute", "warrior-duelist"],
  tank: ["tank", "tank-juggernaut", "tank-sentinel"],
  rogue: ["rogue", "rogue-assassin", "rogue-brawler"],
  ranger: ["ranger", "ranger-warden", "ranger-skirmisher"],
  mage: ["mage", "mage-battle", "mage-sage"],
  cleric: ["cleric", "cleric-templar", "cleric-monk"],
};
export const RIG_IDS: readonly RigId[] = CLASS_RIG_IDS.flatMap((c) => CLASS_RIGS[c]);
/** The class a skeleton belongs to. */
export const RIG_CLASS = Object.fromEntries(CLASS_RIG_IDS.flatMap((c) => CLASS_RIGS[c].map((r) => [r, c]))) as Record<RigId, ClassRig>;

// 96 × 80 frame (the archetype pass: room for a brute's greatsword overhead, a warden's longbow and a tall assassin); the feet stand at (40, 76)
export const FRAME = { w: 96, h: 80 } as const;
export const FEET_Y = 76;
export const ANCHOR_X = 40;
/** The reference head radius (head-local art is authored at 9.6 and scaled to each build's `head`). */
export const HEAD_R = 8.2;

/** An archetype's proportions. Widths are multipliers of the reference (warrior ≈ 1.1, tank ≈ 1.25, rogue ≈ 0.9). */
export interface Build {
  torso: number;
  /** Half-width between the shoulder joints. */
  shoulder: number;
  /** Half-width between the hip joints. */
  hip: number;
  upperArm: number;
  forearm: number;
  thigh: number;
  shin: number;
  /** Limb thickness multipliers. */
  arm: number;
  leg: number;
  /** Torso width multiplier (garments scale with it). */
  chest: number;
  /** Head radius (faces, hair and headgear scale with it: a small head on a tall body, a big one on a short one). */
  head: number;
  /**
   * The archetype's weapon: length and blade / head width multipliers (a brute's greatsword, a warden's longbow, a monk's tall staff); `grip` a
   * minimum grip length and `hold` how far (a fraction of the grip) the front hand slides toward the pommel — a two-hander, the back hand above it;
   * `below` (hafted weapons) a minimum shaft length below the hand — a pilgrim's staff that reaches the ground.
   */
  weapon: { len: number; w: number; grip?: number; hold?: number; below?: number };
}

const W1 = { len: 1, w: 1 };

export const BUILDS: Record<RigId, Build> = {
  warrior: { torso: 15.4, shoulder: 4.8, hip: 2.5, upperArm: 6.2, forearm: 5.9, thigh: 7.6, shin: 7.4, arm: 1.12, leg: 1.06, chest: 1.12, head: 8.2, weapon: W1 },
  "warrior-brute": { torso: 15.4, shoulder: 6.4, hip: 3.2, upperArm: 6.2, forearm: 5.9, thigh: 6.8, shin: 6.4, arm: 1.52, leg: 1.4, chest: 1.52, head: 7.4, weapon: { len: 1.42, w: 1.3, grip: 9, hold: 0.62 } },
  "warrior-duelist": { torso: 16.0, shoulder: 4.1, hip: 2.1, upperArm: 6.8, forearm: 6.5, thigh: 9.0, shin: 8.8, arm: 0.9, leg: 0.9, chest: 0.94, head: 7.5, weapon: { len: 1.06, w: 0.82 } },
  tank: { torso: 14.6, shoulder: 5.5, hip: 2.9, upperArm: 6.0, forearm: 5.7, thigh: 7.1, shin: 6.8, arm: 1.28, leg: 1.22, chest: 1.3, head: 8.2, weapon: W1 },
  "tank-juggernaut": { torso: 15.0, shoulder: 6.8, hip: 3.4, upperArm: 6.0, forearm: 5.6, thigh: 6.3, shin: 5.8, arm: 1.62, leg: 1.52, chest: 1.62, head: 7.4, weapon: { len: 1.15, w: 1.25 } },
  "tank-sentinel": { torso: 16.6, shoulder: 5.2, hip: 2.7, upperArm: 6.9, forearm: 6.5, thigh: 8.8, shin: 8.4, arm: 1.2, leg: 1.12, chest: 1.2, head: 7.6, weapon: { len: 1.45, w: 1.05 } },
  rogue: { torso: 15.0, shoulder: 3.9, hip: 2.1, upperArm: 6.1, forearm: 5.9, thigh: 8.0, shin: 7.8, arm: 0.9, leg: 0.92, chest: 0.9, head: 8.2, weapon: W1 },
  "rogue-assassin": { torso: 16.6, shoulder: 3.7, hip: 1.9, upperArm: 6.9, forearm: 6.7, thigh: 9.2, shin: 9.0, arm: 0.78, leg: 0.8, chest: 0.8, head: 7.3, weapon: { len: 1.35, w: 0.9 } },
  "rogue-brawler": { torso: 13.0, shoulder: 5.0, hip: 2.7, upperArm: 5.4, forearm: 5.2, thigh: 6.0, shin: 5.8, arm: 1.26, leg: 1.2, chest: 1.26, head: 9.2, weapon: { len: 0.95, w: 1.45 } },
  ranger: { torso: 15.4, shoulder: 4.3, hip: 2.3, upperArm: 6.3, forearm: 6.0, thigh: 7.8, shin: 7.6, arm: 0.98, leg: 0.98, chest: 0.98, head: 8.2, weapon: W1 },
  "ranger-warden": { torso: 16.6, shoulder: 5.2, hip: 2.7, upperArm: 6.9, forearm: 6.5, thigh: 8.7, shin: 8.5, arm: 1.16, leg: 1.1, chest: 1.18, head: 7.6, weapon: { len: 1.4, w: 1.1 } },
  "ranger-skirmisher": { torso: 13.4, shoulder: 4.0, hip: 2.2, upperArm: 5.6, forearm: 5.4, thigh: 6.6, shin: 6.4, arm: 0.92, leg: 0.94, chest: 0.92, head: 9.0, weapon: { len: 0.74, w: 1 } },
  mage: { torso: 15.8, shoulder: 4.0, hip: 2.2, upperArm: 6.1, forearm: 5.8, thigh: 7.5, shin: 7.4, arm: 0.88, leg: 0.9, chest: 0.92, head: 8.2, weapon: W1 },
  "mage-battle": { torso: 15.6, shoulder: 5.3, hip: 2.7, upperArm: 6.3, forearm: 6.0, thigh: 7.6, shin: 7.4, arm: 1.18, leg: 1.1, chest: 1.22, head: 7.9, weapon: { len: 0.86, w: 1.1 } },
  "mage-sage": { torso: 13.8, shoulder: 4.0, hip: 2.3, upperArm: 5.8, forearm: 5.6, thigh: 6.4, shin: 6.2, arm: 0.86, leg: 0.88, chest: 0.98, head: 9.0, weapon: { len: 1.16, w: 1 } },
  cleric: { torso: 15.2, shoulder: 4.4, hip: 2.4, upperArm: 6.0, forearm: 5.8, thigh: 7.4, shin: 7.2, arm: 1.0, leg: 1.0, chest: 1.04, head: 8.2, weapon: W1 },
  "cleric-templar": { torso: 15.8, shoulder: 5.6, hip: 2.9, upperArm: 6.3, forearm: 6.0, thigh: 7.4, shin: 7.2, arm: 1.32, leg: 1.24, chest: 1.34, head: 7.7, weapon: { len: 1.3, w: 1.25 } },
  "cleric-monk": { torso: 15.0, shoulder: 3.9, hip: 2.1, upperArm: 6.4, forearm: 6.1, thigh: 8.4, shin: 8.2, arm: 0.86, leg: 0.86, chest: 0.88, head: 7.8, weapon: { len: 1.45, w: 1.05, below: 21 } },
};

export { CLIP_ORDER, CLIPS, NEUTRAL };
export type { ClipName, ClipSpec, Pose };

/** The attack clip each skeleton plays (its class weapon's). */
export const RIG_ATTACK: Record<RigId, ClipName> = Object.fromEntries(
  RIG_IDS.map((r) => [r, ({ warrior: "attack_slash", tank: "attack_slash", rogue: "attack_thrust", ranger: "attack_shoot", mage: "attack_thrust", cleric: "attack_thrust" } as const)[RIG_CLASS[r]]]),
) as Record<RigId, ClipName>;

// ---------------------------------------------------------------------------------------
// The six CLASS pose languages (the first archetype of each class; the others are in archetypes.ts)
// ---------------------------------------------------------------------------------------

function warrior(clip: ClipName, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // A planted guard: feet wide, the sword held before the body at the waist, point up toward the foe (the face stays clear), the free fist ready.
      return P({ lean: 0.08, squash: k * 0.4, legF: 0.34, legB: -0.3, kneeF: 0.16, kneeB: 0.2, armF: 0.42 - k * 0.04, elbowF: 1.12, weaponAngle: 2.45 - k * 0.1, armB: -0.25 - k * 0.08, elbowB: 0.6, tilt: -k * 0.03, twist: 0.15, capeSway: k * 0.7 });
    case "idle2":
      // The second stance — a low guard: upright and square, feet wide, the blade held forward and DOWN, the free fist on the hip.
      return P({ lean: 0.0, squash: k * 0.4, legF: 0.42, legB: -0.38, kneeF: 0.12, kneeB: 0.14, armF: 0.3 - k * 0.03, elbowF: 0.75, weaponAngle: 1.25 + k * 0.05, armB: -0.55, elbowB: 2.0, capeSway: k * 0.7 });
    case "move": {
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ oy: -Math.abs(s) * 1.4, lean: 0.24, legF: s * 0.75, legB: -s * 0.75, kneeF: Math.max(0, -c) * 1.0 + 0.12, kneeB: Math.max(0, c) * 1.0 + 0.12, armF: 0.8 - s * 0.3, elbowF: 1.0, weaponAngle: 2.2 + s * 0.1, armB: -0.2 + s * 0.7, elbowB: 0.7, capeSway: -2.6 + s, squash: Math.abs(c) * 0.2 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 wind-up over the shoulder, weight back · 1 the swing turns the body · 2 IMPACT (lunge, blade low) · 3 heavy follow-through · 4-5 guard.
      return P({
        armF: at([2.95, 2.1, 1.15, 0.75, 0.85, 0.8], f), elbowF: at([0.5, 0.25, 0.12, 0.3, 0.7, 1.0], f), weaponAngle: at([4.05, 3.0, 1.25, 0.8, 1.5, 2.3], f),
        lean: at([-0.28, 0.12, 0.44, 0.4, 0.22, 0.1], f), tilt: at([-0.08, 0, 0.06, 0.04, 0, 0], f), twist: at([-0.65, 0.1, 0.75, 0.8, 0.4, 0.1], f), ox: at([-1.8, 0.8, 3.8, 3.6, 2.0, 0.6], f),
        armB: at([0.9, -0.3, -0.9, -0.7, -0.4, -0.25], f), elbowB: at([0.6, 0.5, 0.4, 0.5, 0.55, 0.6], f),
        legF: at([-0.12, 0.42, 0.75, 0.68, 0.45, 0.34], f), legB: at([0.32, -0.32, -0.62, -0.55, -0.38, -0.3], f),
        kneeF: at([0.25, 0.25, 0.5, 0.45, 0.25, 0.16], f), kneeB: at([0.45, 0.15, 0.12, 0.12, 0.18, 0.2], f),
        mouth: at(M("rest", "shout", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([1.8, -2.4, -4.4, -3.4, -1.4, 0], f), squash: at([0, 0, 0.3, 0.3, 0.1, 0], f),
      });
    case "skill":
      // A leaping overhead slam: crouch · spring up, both hands on the hilt · apex · IMPACT (landing, blade down) · hold · recover.
      return P({
        oy: at([0, -3, -4.5, 0, 0, 0], f), armF: at([1.3, 2.75, 2.85, 1.25, 1.0, 0.85], f), elbowF: at([0.8, 0.3, 0.2, 0.1, 0.5, 0.9], f),
        weaponAngle: at([1.9, 3.5, 3.75, 1.1, 1.4, 2.2], f), lean: at([0.15, -0.1, -0.18, 0.55, 0.35, 0.12], f),
        armB: at([-0.4, 2.5, 2.7, 0.9, 0.2, -0.2], f), elbowB: at([0.6, 0.4, 0.3, 0.3, 0.5, 0.6], f),
        legF: at([0.3, 0.5, 0.6, 0.75, 0.5, 0.34], f), legB: at([-0.3, -0.1, -0.4, -0.55, -0.4, -0.3], f),
        kneeF: at([0.7, 0.9, 1.0, 0.7, 0.4, 0.16], f), kneeB: at([0.8, 1.1, 1.2, 0.3, 0.3, 0.2], f), ox: at([-0.6, 0.6, 2.2, 4.0, 3.0, 1.0], f),
        mouth: at(M("rest", "open", "shout", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([0, 2, 3, -4, -2, 0], f), squash: at([0.4, 0, 0, 0.6, 0.3, 0], f), glow: at([0.1, 0.3, 0.6, 1, 0.5, 0.1], f),
      });
    case "hit":
      return at([
        P({ lean: -0.4, tilt: -0.15, ox: -2.6, armF: 0.3, elbowF: 0.6, weaponAngle: 1.7, armB: -0.6, legF: 0.4, legB: -0.2, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3.4, squash: 0.5 }),
        P({ lean: -0.28, tilt: -0.08, ox: -2.0, armF: 0.45, elbowF: 0.8, weaponAngle: 2.0, armB: -0.45, legF: 0.36, legB: -0.24, kneeB: 0.3, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ lean: -0.02, ox: -0.6, armF: 0.7, elbowF: 1.0, weaponAngle: 2.3, armB: -0.3, elbowB: 0.6, legF: 0.34, legB: -0.3, kneeF: 0.16, kneeB: 0.2, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      return P({
        oy: at([0, -0.8, -1.2, -0.5], f), armF: at([2.6, 2.8, 2.65, 2.5], f), elbowF: at([0.25, 0.15, 0.2, 0.25], f), weaponAngle: at([2.95, 3.1, 3.0, 2.9], f),
        armB: at([2.1, 2.4, 2.2, 2.0], f), elbowB: at([0.6, 0.4, 0.5, 0.6], f), legF: at([0.3, 0.42, 0.42, 0.3], f), legB: at([-0.3, -0.12, -0.12, -0.3], f),
        kneeF: at([0.1, 0.3, 0.3, 0.1], f), eyes: "cheer", mouth: "open", lean: at([0.02, -0.06, -0.08, -0.02], f), capeSway: at([0, 2, 3, 1], f),
      });
  }
}

function tank(clip: ClipName, f: number): Pose {
  const k = breath(f);
  // The shield arm forward at the waist (upper arm down, forearm level): the shield covers the body below the chin, so the face still reads;
  // the mace resting on the shoulder.
  const shield = { armB: 0.5, elbowB: 1.05 };
  // the mace held low and forward over the shield's rim, ready — clear of the face
  const shoulderMace = { armF: 0.3, elbowF: 0.85, weaponAngle: 2.15 };
  switch (clip) {
    case "idle":
      return P({ lean: 0.06, squash: k * 0.3, legF: 0.38, legB: -0.34, kneeF: 0.28, kneeB: 0.32, ...shield, ...shoulderMace, armF: 0.3 + k * 0.03, weaponAngle: 2.15 - k * 0.04, capeSway: k * 0.5 });
    case "idle2":
      // The second stance — the wall at rest: the shield set low before the legs, the mace hanging heavy at the side.
      return P({ lean: 0.02, squash: k * 0.3, legF: 0.36, legB: -0.36, kneeF: 0.22, kneeB: 0.26, armB: 0.3, elbowB: 0.9, armF: 0.2 + k * 0.02, elbowF: 0.55, weaponAngle: 1.2 + k * 0.03, capeSway: k * 0.5 });
    case "move": {
      // A heavy march: short strides, no airtime, a squash on every footfall and a rock from side to side.
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ lean: 0.12, tilt: s * 0.05, legF: s * 0.45, legB: -s * 0.45, kneeF: Math.max(0, -c) * 0.6 + 0.25, kneeB: Math.max(0, c) * 0.6 + 0.25, squash: Math.abs(c) * 0.6, ...shield, ...shoulderMace, elbowF: 0.85 + s * 0.08, capeSway: -1.5 + s * 0.6 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the mace raised high behind, shield tucked · 1 step in · 2 IMPACT: the overhead smash, the whole body behind it · 3 hold · 4-5 back to guard.
      return P({
        armF: at([2.9, 2.4, 1.35, 1.2, 0.7, 0.35], f), elbowF: at([0.5, 0.3, 0.1, 0.15, 0.6, 0.85], f), weaponAngle: at([3.9, 3.3, 1.45, 1.25, 1.8, 2.15], f),
        armB: at([0.45, 0.6, 0.55, 0.55, 0.5, 0.5], f), elbowB: at([1.4, 1.2, 1.1, 1.1, 1.05, 1.05], f),
        lean: at([-0.18, 0.1, 0.38, 0.36, 0.18, 0.06], f), ox: at([-1.0, 0.4, 1.8, 1.6, 0.9, 0.2], f), twist: at([-0.5, 0, 0.55, 0.55, 0.2, 0], f),
        legF: at([0.2, 0.55, 0.62, 0.6, 0.45, 0.38], f), legB: at([-0.3, -0.4, -0.5, -0.5, -0.38, -0.34], f),
        kneeF: at([0.3, 0.35, 0.55, 0.55, 0.35, 0.28], f), kneeB: at([0.4, 0.3, 0.25, 0.25, 0.3, 0.32], f), squash: at([0, 0, 0.7, 0.6, 0.2, 0], f),
        mouth: at(M("rest", "shout", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), capeSway: at([1, -1.5, -3, -2.4, -1, 0], f),
      });
    case "skill":
      // Shield bash: brace · crouch · charge · IMPACT (the shield arm driven straight out) · hold · recover.
      return P({
        armB: at([0.6, 0.5, 0.9, 1.55, 1.4, 1.05], f), elbowB: at([1.6, 1.7, 0.9, 0.1, 0.3, 1.05], f), armF: at([0.3, 0.2, 0.0, -0.3, 0.1, 0.3], f),
        elbowF: at([0.9, 1.0, 1.2, 1.4, 1.0, 0.85], f), weaponAngle: at([2.2, 2.4, 2.8, 3.1, 2.5, 2.15], f), lean: at([-0.12, 0.05, 0.32, 0.42, 0.25, 0.08], f),
        ox: at([-0.8, -1.2, 1.5, 5.0, 3.5, 1.0], f), legF: at([0.3, 0.2, 0.55, 0.8, 0.6, 0.38], f), legB: at([-0.3, -0.2, -0.55, -0.7, -0.5, -0.34], f),
        kneeF: at([0.4, 0.55, 0.4, 0.5, 0.35, 0.28], f), kneeB: at([0.45, 0.6, 0.3, 0.15, 0.25, 0.32], f), squash: at([0.3, 0.5, 0, 0.3, 0.1, 0], f),
        mouth: at(M("rest", "rest", "shout", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), capeSway: at([0.5, 1, -2, -4, -2, 0], f),
        glow: at([0.1, 0.4, 0.7, 1, 0.5, 0.1], f),
      });
    case "hit":
      // A wall: it barely gives.
      return at([
        P({ lean: -0.15, tilt: -0.06, ox: -1.1, legF: 0.38, legB: -0.34, kneeF: 0.32, kneeB: 0.4, ...shield, ...shoulderMace, eyes: "hurt", mouth: "hurt", squash: 0.5, capeSway: 1.5 }),
        P({ lean: -0.08, ox: -0.8, legF: 0.38, legB: -0.34, kneeF: 0.3, kneeB: 0.34, ...shield, ...shoulderMace, eyes: "hurt", mouth: "hurt", squash: 0.2, capeSway: 0.8 }),
        P({ lean: 0.04, ox: -0.2, legF: 0.38, legB: -0.34, kneeF: 0.28, kneeB: 0.32, ...shield, ...shoulderMace }),
      ], f);
    case "ko":
      return koForward(f);
    case "victory":
      return P({
        oy: at([0, -0.4, -0.6, -0.2], f), armF: at([2.6, 2.75, 2.6, 2.5], f), elbowF: at([0.3, 0.2, 0.25, 0.3], f), weaponAngle: at([3.0, 3.15, 3.05, 2.95], f),
        armB: at([1.9, 2.1, 2.0, 1.8], f), elbowB: at([0.5, 0.4, 0.45, 0.5], f), legF: 0.38, legB: -0.34, kneeF: at([0.28, 0.4, 0.4, 0.28], f), kneeB: 0.32,
        eyes: "cheer", mouth: "open", lean: at([0, -0.05, -0.06, 0], f), capeSway: at([0, 1, 1.5, 0.5], f),
      });
  }
}

function rogue(clip: ClipName, f: number): Pose {
  const k = breath(f);
  // A low crouch on the balls of the feet: the front dagger forward, the back one held reversed along the forearm.
  const crouch = { lean: 0.24, legF: 0.45, legB: -0.42, kneeF: 0.6, kneeB: 0.7, armF: 0.95, elbowF: 0.7, weaponAngle: 2.0, armB: 0.55, elbowB: 1.5, weaponB: 0.3 };
  switch (clip) {
    case "idle":
      return P({ ...crouch, kneeF: 0.6 + k * 0.1, kneeB: 0.7 + k * 0.1, tilt: -0.04, capeSway: k * 0.8, armF: 0.95 - k * 0.05 });
    case "idle2":
      // The second stance — upright and cocky: weight on the back leg, both blades held reversed along the forearms, low.
      return P({ lean: 0.06, tilt: 0.05, legF: 0.3, legB: -0.22, kneeF: 0.2 + k * 0.05, kneeB: 0.35 + k * 0.05, armF: 0.35 - k * 0.04, elbowF: 0.7, weaponAngle: 0.5, armB: 0.2, elbowB: 0.6, weaponB: 0.4, capeSway: k * 0.8 });
    case "move": {
      // A low sprint, blades trailing behind.
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ oy: -Math.abs(s) * 1.0, lean: 0.42, legF: s * 0.95, legB: -s * 0.95, kneeF: Math.max(0, -c) * 1.2 + 0.25, kneeB: Math.max(0, c) * 1.2 + 0.25, armF: -0.7 + s * 0.15, elbowF: 0.4, armB: -0.9 - s * 0.15, elbowB: 0.4, weaponAngle: -0.9, weaponB: -0.6, capeSway: -3 + s, squash: Math.abs(c) * 0.15 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 coil · 1 dash · 2 IMPACT: the front dagger, fully extended · 3 the back dagger follows · 4 hop back · 5 crouch.
      return P({
        armF: at([0.4, 0.8, 1.55, 0.7, 0.8, 0.95], f), elbowF: at([1.6, 1.0, 0.05, 1.2, 0.9, 0.7], f), weaponAngle: at([2.2, 1.9, 1.6, 1.9, 2.0, 2.0], f),
        armB: at([0.5, 0.4, 0.2, 1.5, 0.8, 0.55], f), elbowB: at([1.7, 1.6, 1.3, 0.05, 1.1, 1.5], f), weaponB: at([0.3, 0.3, 0.3, 1.6, 0.6, 0.3], f),
        lean: at([0.18, 0.38, 0.5, 0.48, 0.3, 0.24], f), ox: at([-1.0, 1.5, 5.0, 5.4, 2.5, 0.5], f), oy: at([0, -0.5, 0, 0, -1.2, 0], f), twist: at([-0.3, 0.3, 0.7, -0.5, 0, 0], f),
        legF: at([0.3, 0.6, 0.85, 0.8, 0.5, 0.45], f), legB: at([-0.5, -0.6, -0.75, -0.72, -0.5, -0.42], f),
        kneeF: at([0.8, 0.6, 0.6, 0.6, 0.6, 0.6], f), kneeB: at([0.9, 0.4, 0.2, 0.25, 0.6, 0.7], f),
        mouth: at(M("rest", "rest", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([1.5, -2, -4, -3.5, -1, 0], f), glow: at([0.2, 0.5, 1, 0.8, 0.3, 0.1], f),
      });
    case "skill":
      // Shadow step: crouch · leap · blades high · IMPACT: the cross-cut on landing · recover · crouch.
      return P({
        oy: at([0, -2.5, -3.5, 0, 0, 0], f), lean: at([0.35, 0.6, 0.55, 0.5, 0.35, 0.24], f), ox: at([-2.0, 1.0, 4.0, 6.5, 4.0, 1.0], f), tilt: at([0, -0.1, 0.1, 0, 0, 0], f),
        armF: at([0.2, -0.5, 2.2, 1.2, 0.9, 0.95], f), elbowF: at([1.8, 0.6, 0.4, 0.1, 0.7, 0.7], f), weaponAngle: at([2.4, -0.6, 3.4, 1.0, 1.8, 2.0], f),
        armB: at([0.2, -0.8, 2.0, 1.9, 0.7, 0.55], f), elbowB: at([1.8, 0.6, 0.5, 0.1, 1.2, 1.5], f), weaponB: at([0.3, -0.6, 3.0, 2.6, 0.5, 0.3], f),
        legF: at([0.5, 0.9, 0.6, 0.9, 0.5, 0.45], f), legB: at([-0.5, -0.3, -0.6, -0.8, -0.5, -0.42], f),
        kneeF: at([1.0, 1.3, 1.4, 0.7, 0.6, 0.6], f), kneeB: at([1.1, 1.4, 1.5, 0.3, 0.6, 0.7], f),
        mouth: at(M("rest", "rest", "open", "shout", "rest", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([1, -3, -2, -4.5, -2, 0], f), glow: at([0.2, 0.6, 0.9, 1, 0.4, 0.1], f),
      });
    case "hit":
      // A hop back, then the crouch again.
      return at([
        P({ ...crouch, lean: -0.2, ox: -3.2, oy: -1.2, kneeF: 0.9, kneeB: 1.0, armF: 0.5, elbowF: 1.0, eyes: "hurt", mouth: "hurt", capeSway: 3 }),
        P({ ...crouch, lean: -0.05, ox: -2.4, kneeF: 0.8, kneeB: 0.9, eyes: "hurt", mouth: "hurt", capeSway: 1.5 }),
        P({ ...crouch, ox: -0.8, capeSway: 0.6 }),
      ], f);
    case "ko":
      return koBack(f, { weaponB: 0.4 });
    case "victory":
      // A dagger flipped in the air and caught; the other fist on the hip.
      return P({
        ...crouch, kneeF: 0.3, kneeB: 0.35, lean: 0.02, armF: at([2.3, 2.55, 2.4, 2.3], f), elbowF: at([0.5, 0.35, 0.45, 0.5], f), weaponAngle: at([3.0, 4.6, 6.0, 3.1], f),
        armB: -0.35, elbowB: 2.0, weaponB: 0.2, eyes: "cheer", mouth: at(M("open", "rest", "open", "open"), f), oy: at([0, -0.5, -0.7, 0], f), capeSway: at([0, 1, 2, 1], f),
      });
  }
}

function ranger(clip: ClipName, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // Upright and alert, the bow carried upright at the side, the free hand by the quiver.
      return P({ lean: 0.04, legF: 0.28, legB: -0.26, kneeF: 0.1, kneeB: 0.14, armF: 0.42 - k * 0.03, elbowF: 0.35, weaponAngle: 2.6, armB: -0.1 - k * 0.04, elbowB: 0.5, squash: k * 0.3, capeSway: k * 0.7 });
    case "idle2":
      // The second stance — an arrow nocked: the bow held out low before the body, the string hand at the nock, watching.
      return P({ lean: 0.08, legF: 0.34, legB: -0.32, kneeF: 0.16, kneeB: 0.22, armF: 0.95 - k * 0.03, elbowF: 0.15, weaponAngle: Math.PI - 0.12, draw: 0.32, armB: 0.85, elbowB: 0.55, squash: k * 0.3, eyes: "focus", capeSway: k * 0.7 });
    case "move": {
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ oy: -Math.abs(s) * 1.3, lean: 0.2, legF: s * 0.7, legB: -s * 0.7, kneeF: Math.max(0, -c) * 0.95 + 0.1, kneeB: Math.max(0, c) * 0.95 + 0.1, armF: 0.6 - s * 0.3, elbowF: 0.5, weaponAngle: 2.45 + s * 0.1, armB: -0.15 + s * 0.6, elbowB: 0.6, capeSway: -2.4 + s, squash: Math.abs(c) * 0.2 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 raise the bow · 1 draw · 2 full draw — AIM (planted wide, still) · 3 IMPACT: release (the string snaps, a small recoil) · 4 follow-through · 5 lower.
      return P({
        armF: at([1.35, 1.5, 1.56, 1.56, 1.5, 1.1], f), elbowF: at([0.2, 0.05, 0, 0, 0.05, 0.4], f), weaponAngle: Math.PI,
        draw: at([0.1, 0.6, 1, 0, 0, 0], f), armB: at([1.2, 2.1, 2.5, 1.7, 1.2, 0.3], f), elbowB: at([-0.2, -1.3, -1.85, -0.6, -0.2, 0.25], f),
        lean: at([0.04, 0, -0.04, -0.12, -0.06, 0.02], f), ox: at([0, -0.4, -0.8, -1.6, -0.8, 0], f),
        legF: 0.38, legB: -0.36, kneeF: 0.18, kneeB: 0.24,
        eyes: at(E("open", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "rest", "open", "rest", "rest"), f),
        capeSway: at([0, 0, 0, 3, 1.5, 0.5], f),
      });
    case "skill":
      // The power shot from one knee: kneel · draw · full draw · IMPACT: release · follow-through · rise.
      return P({
        armF: at([1.0, 1.55, 1.62, 1.62, 1.5, 0.8], f), elbowF: at([0.4, 0.05, 0, 0, 0.05, 0.4], f), weaponAngle: Math.PI,
        draw: at([0.1, 0.6, 1, 0, 0, 0], f), armB: at([1.0, 2.1, 2.5, 1.7, 1.2, 0.4], f), elbowB: at([-0.2, -1.3, -1.85, -0.6, -0.2, 0.3], f),
        legF: at([0.9, 1.0, 1.0, 1.0, 0.95, 0.4], f), kneeF: at([0.9, 1.0, 1.0, 1.0, 0.9, 0.3], f), legB: at([0.5, 0.6, 0.6, 0.6, 0.55, -0.3], f),
        kneeB: at([2.0, 2.15, 2.15, 2.15, 2.0, 0.6], f), lean: at([0.06, -0.02, -0.06, -0.14, -0.06, 0.04], f), ox: at([0, -0.4, -0.8, -1.8, -1.0, 0], f),
        eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "rest", "shout", "open", "rest"), f),
        capeSway: at([0, 0, 0, 3.5, 2, 0.5], f), glow: at([0.2, 0.5, 0.9, 1, 0.5, 0.1], f),
      });
    case "hit":
      return at([
        P({ lean: -0.38, tilt: -0.15, ox: -2.4, armF: 0.2, armB: -0.6, elbowF: 0.3, weaponAngle: 2.2, legF: 0.35, legB: -0.25, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3.2, squash: 0.5 }),
        P({ lean: -0.26, tilt: -0.08, ox: -1.9, armF: 0.3, armB: -0.45, elbowF: 0.35, weaponAngle: 2.4, legF: 0.3, legB: -0.22, kneeB: 0.3, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ lean: 0, ox: -0.6, armF: 0.42, elbowF: 0.35, weaponAngle: 2.6, legF: 0.28, legB: -0.26, kneeF: 0.1, kneeB: 0.14, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      return P({
        oy: at([0, -0.7, -1.1, -0.5], f), armF: at([2.5, 2.7, 2.55, 2.4], f), elbowF: at([0.2, 0.1, 0.15, 0.2], f), weaponAngle: at([3.0, 3.1, 3.0, 2.98], f),
        armB: at([-0.2, -0.3, -0.25, -0.2], f), elbowB: 1.6, legF: at([0.28, 0.4, 0.4, 0.28], f), legB: at([-0.26, -0.1, -0.1, -0.26], f), kneeF: at([0.1, 0.3, 0.3, 0.1], f),
        eyes: "cheer", mouth: "open", lean: at([0.02, -0.05, -0.08, -0.02], f), capeSway: at([0, 2, 3, 1], f),
      });
  }
}

function mage(clip: ClipName, f: number): Pose {
  const k = breath(f);
  // Upright: the staff planted and held high on the shaft, the free hand at the chest, palm up, glowing.
  const stance = { lean: -0.02, legF: 0.14, legB: -0.14, kneeF: 0.04, kneeB: 0.06, armF: 0.42, elbowF: 1.15, weaponAngle: Math.PI - 0.04, armB: 0.45, elbowB: 1.75 };
  switch (clip) {
    case "idle":
      return P({ ...stance, armF: 0.42 - k * 0.02, elbowB: 1.75 + k * 0.08, glow: 0.08 + k * 0.1, squash: k * 0.3, capeSway: k * 0.8 });
    case "idle2":
      // The second stance — the staff angled forward like a pointer, the free palm raised before the face, a spell gathering in it.
      return P({ ...stance, lean: 0.04, armF: 0.75 - k * 0.03, elbowF: 0.7, weaponAngle: 2.55 - k * 0.04, armB: 1.35 + k * 0.05, elbowB: 1.1, glow: 0.2 + k * 0.15, squash: k * 0.3, capeSway: k * 0.8 });
    case "move": {
      // A gliding walk: short steps, little bob, the robe flowing, the staff carried upright.
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ ...stance, oy: -Math.abs(s) * 0.4, lean: 0.06, legF: s * 0.38, legB: -s * 0.38, kneeF: Math.max(0, -c) * 0.5 + 0.08, kneeB: Math.max(0, c) * 0.5 + 0.08, armF: 0.45 + s * 0.06, weaponAngle: Math.PI - 0.06 + s * 0.06, armB: 0.3 + s * 0.3, elbowB: 1.2, capeSway: -2 + s * 0.8, glow: 0.08 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the staff drawn back, the free hand gathering · 1 step · 2 IMPACT: the staff thrust level at the target, the free palm behind it · 3 hold · 4-5 upright.
      return P({
        armF: at([0.25, 0.7, 1.38, 1.34, 0.9, 0.45], f), elbowF: at([1.4, 1.2, 0.12, 0.14, 0.9, 1.15], f), weaponAngle: at([2.75, 2.4, 1.92, 1.95, 2.4, 3.08], f),
        armB: at([1.0, 1.5, 1.35, 1.3, 0.8, 0.45], f), elbowB: at([1.2, 0.6, 0.15, 0.2, 1.0, 1.7], f), lean: at([-0.12, 0.1, 0.28, 0.26, 0.12, 0], f), twist: at([-0.3, 0.1, 0.45, 0.4, 0.15, 0], f),
        ox: at([-0.8, 0.2, 1.4, 1.3, 0.6, 0.2], f), glow: at([0.3, 0.6, 1.0, 0.8, 0.4, 0.15], f),
        legF: at([0.05, 0.3, 0.5, 0.48, 0.3, 0.14], f), legB: at([-0.15, -0.3, -0.4, -0.4, -0.25, -0.14], f),
        kneeF: at([0.1, 0.25, 0.35, 0.3, 0.15, 0.04], f), kneeB: at([0.2, 0.15, 0.1, 0.1, 0.1, 0.06], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f),
        capeSway: at([1, -1, -3.6, -3, -1, 0], f),
      });
    case "skill":
      // Channel: gather low · rise, staff and palm up, LEVITATING · the channel at its peak · IMPACT: both hands thrust forward (the blast) · hold · settle.
      return P({
        armF: at([0.6, 1.5, 2.0, 1.5, 1.45, 0.6], f), elbowF: at([0.8, 0.6, 0.4, 0.14, 0.2, 1.0], f), weaponAngle: at([2.6, 2.5, 2.4, 2.0, 2.05, 2.9], f),
        armB: at([0.5, 1.8, 2.4, 1.55, 1.4, 0.6], f), elbowB: at([1.0, 0.6, 0.4, 0.1, 0.2, 1.4], f), lean: at([0.1, -0.1, -0.2, 0.3, 0.22, 0.05], f),
        oy: at([0, -0.8, -1.6, -0.4, 0, 0], f), ox: at([-0.4, -0.6, -0.8, 0.9, 0.6, 0.3], f), glow: at([0.2, 0.6, 0.9, 1.0, 0.6, 0.2], f),
        legF: at([0.1, 0.0, -0.05, 0.4, 0.3, 0.14], f), legB: at([-0.1, 0.05, 0.1, -0.35, -0.3, -0.14], f),
        kneeF: at([0.2, 0.3, 0.35, 0.3, 0.15, 0.04], f), kneeB: at([0.3, 0.4, 0.45, 0.1, 0.1, 0.06], f),
        mouth: at(M("rest", "rest", "open", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([0, 1.5, 3, -3, -1.5, 0], f),
      });
    case "hit":
      return at([
        P({ ...stance, lean: -0.36, tilt: -0.14, ox: -2.4, armF: 0.2, elbowF: 0.8, weaponAngle: 2.6, armB: -0.5, elbowB: 0.6, legF: 0.3, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3.2, squash: 0.5 }),
        P({ ...stance, lean: -0.24, tilt: -0.08, ox: -1.8, armF: 0.3, elbowF: 0.9, weaponAngle: 2.8, armB: -0.3, elbowB: 0.9, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ ...stance, ox: -0.5, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      return P({
        ...stance, oy: at([0, -1.0, -1.6, -0.8], f), armF: at([1.9, 2.05, 1.95, 1.85], f), elbowF: at([0.4, 0.3, 0.35, 0.4], f), weaponAngle: at([2.45, 2.5, 2.45, 2.4], f),
        armB: at([2.2, 2.45, 2.3, 2.1], f), elbowB: at([0.5, 0.35, 0.4, 0.5], f), glow: at([0.6, 1, 0.8, 0.6], f), eyes: "cheer", mouth: "open", capeSway: at([0, 2, 3, 1], f),
      });
  }
}

function cleric(clip: ClipName, f: number): Pose {
  const k = breath(f);
  // Steady and supportive: the scepter held upright before the chest, the other hand open at the waist.
  const stance = { lean: -0.03, legF: 0.18, legB: -0.16, kneeF: 0.05, kneeB: 0.08, armF: 0.3, elbowF: 1.45, weaponAngle: Math.PI - 0.08, armB: 0.75, elbowB: 0.5 };
  switch (clip) {
    case "idle":
      return P({ ...stance, armF: 0.3 - k * 0.02, armB: 0.75 + k * 0.05, glow: k * 0.15, squash: k * 0.3, capeSway: k * 0.6 });
    case "idle2":
      // The second stance — a blessing: the scepter lowered at the side, the free hand raised high, palm out, face lifted.
      return P({ ...stance, armF: 0.18, elbowF: 0.35, weaponAngle: 2.35, armB: 2.25 + k * 0.05, elbowB: 0.45, tilt: -0.08, glow: 0.15 + k * 0.15, squash: k * 0.3, capeSway: k * 0.6 });
    case "move": {
      const s = Math.sin((f / 6) * Math.PI * 2);
      const c = Math.cos((f / 6) * Math.PI * 2);
      return P({ ...stance, oy: -Math.abs(s) * 0.5, lean: 0.1, legF: s * 0.5, legB: -s * 0.5, kneeF: Math.max(0, -c) * 0.6 + 0.08, kneeB: Math.max(0, c) * 0.6 + 0.08, armB: 0.2 + s * 0.4, elbowB: 0.5, capeSway: -2 + s * 0.8 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // SMITE: 0 the scepter raised, eyes up · 1 it comes down · 2 IMPACT: pointed at the target, upright (no lunge) · 3 hold · 4-5 back upright.
      return P({
        armF: at([1.9, 1.8, 1.45, 1.4, 0.9, 0.32], f), elbowF: at([0.5, 0.4, 0.1, 0.12, 0.8, 1.45], f), weaponAngle: at([2.9, 2.5, 1.5, 1.5, 2.4, 3.06], f),
        armB: at([0.4, 0.5, 0.6, 0.6, 0.7, 0.75], f), elbowB: at([1.6, 1.5, 1.4, 1.4, 0.9, 0.5], f), lean: at([-0.15, -0.05, 0.14, 0.12, 0.04, -0.03], f),
        tilt: at([-0.12, 0, 0.05, 0.05, 0, 0], f), ox: at([-0.4, 0.2, 1.6, 1.4, 0.6, 0], f), glow: at([0.4, 0.7, 1.0, 0.8, 0.4, 0.1], f),
        legF: at([0.18, 0.3, 0.42, 0.4, 0.28, 0.18], f), legB: at([-0.16, -0.25, -0.32, -0.3, -0.2, -0.16], f),
        kneeF: at([0.05, 0.15, 0.2, 0.18, 0.1, 0.05], f), kneeB: at([0.08, 0.1, 0.1, 0.1, 0.08, 0.08], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f), capeSway: at([0.5, -1, -2.6, -2, -0.8, 0], f),
      });
    case "skill":
      // Blessing: head bowed, hands together · the arms open · rising · IMPACT: arms raised in a V, face up · hold · lower.
      return P({
        armF: at([0.45, 1.2, 1.8, 2.0, 1.95, 0.4], f), elbowF: at([1.7, 1.0, 0.55, 0.45, 0.5, 1.4], f), weaponAngle: at([3.0, 2.85, 2.75, 2.7, 2.75, 3.05], f),
        armB: at([0.45, 1.3, 2.3, 2.6, 2.4, 0.7], f), elbowB: at([1.7, 0.9, 0.4, 0.2, 0.3, 0.6], f), tilt: at([0.15, 0.05, -0.1, -0.18, -0.12, 0], f),
        lean: at([0.05, 0, -0.06, -0.1, -0.06, -0.03], f), oy: at([0, 0, -0.4, -0.8, -0.6, 0], f), glow: at([0.2, 0.5, 0.85, 1.0, 0.7, 0.2], f),
        legF: 0.18, legB: -0.16, kneeF: 0.05, kneeB: 0.08,
        eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "open", "open", "rest", "rest"), f), capeSway: at([0, 1, 2, 2.5, 1.5, 0], f),
      });
    case "hit":
      return at([
        P({ ...stance, lean: -0.34, tilt: -0.14, ox: -2.2, armF: 0.1, elbowF: 1.0, weaponAngle: 2.7, armB: -0.4, legF: 0.3, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3, squash: 0.5 }),
        P({ ...stance, lean: -0.22, tilt: -0.08, ox: -1.7, armF: 0.2, elbowF: 1.2, weaponAngle: 2.9, armB: 0.0, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ ...stance, ox: -0.5, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koForward(f);
    case "victory":
      return P({
        ...stance, oy: at([0, -0.6, -1.0, -0.4], f), armF: at([1.9, 2.0, 1.95, 1.85], f), elbowF: at([0.45, 0.4, 0.42, 0.45], f), weaponAngle: at([2.75, 2.8, 2.75, 2.7], f),
        armB: at([2.5, 2.7, 2.6, 2.4], f), elbowB: at([0.3, 0.2, 0.25, 0.3], f), glow: at([0.5, 0.9, 0.7, 0.5], f), tilt: -0.1, eyes: "cheer", mouth: "open", capeSway: at([0, 1.5, 2.5, 1], f),
      });
  }
}

const CLASS_POSES: Record<ClassRig, (clip: ClipName, f: number) => Pose> = { warrior, tank, rogue, ranger, mage, cleric };

export function poseFor(clip: ClipName, f: number, rig: RigId = "warrior"): Pose {
  const arch = ARCHETYPE_POSES[rig as keyof typeof ARCHETYPE_POSES];
  return arch ? arch(clip, f) : CLASS_POSES[rig as ClassRig](clip, f);
}

// ---------------------------------------------------------------------------------------
// Forward kinematics (+ IK for the back arm of a two-handed grip)
// ---------------------------------------------------------------------------------------

export interface Joints {
  rig: RigId;
  b: Build;
  hip: Pt;
  neck: Pt;
  head: Pt;
  shoulderF: Pt;
  shoulderB: Pt;
  elbowF: Pt;
  handF: Pt;
  elbowB: Pt;
  handB: Pt;
  hipF: Pt;
  hipB: Pt;
  kneeF: Pt;
  kneeB: Pt;
  footF: Pt;
  footB: Pt;
  torsoAngle: number;
  headAngle: number;
  weaponDir: Pt;
  /** The back hand's weapon axis (the rogue's second dagger). */
  weaponDirB: Pt;
}

const rot2 = (v: Pt, a: number): Pt => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a)];
const add = (a: Pt, b: Pt): Pt => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Pt, k: number): Pt => [a[0] * k, a[1] * k];
export const limbDir = (a: number): Pt => [Math.sin(a), Math.cos(a)];

/**
 * Two-bone IK: the elbow and hand of an arm from `s` reaching for `t` (upper arm `a`, forearm `b`). The elbow bends DOWN (the lower of the two
 * solutions) — a hand on a hilt, a fist on the hip. A target out of reach is approached with the arm straight.
 */
export function reach(s: Pt, t: Pt, a: number, b: number): { elbow: Pt; hand: Pt } {
  const dx = t[0] - s[0];
  const dy = t[1] - s[1];
  const d0 = Math.hypot(dx, dy) || 1e-6;
  const u: Pt = [dx / d0, dy / d0];
  const d = Math.min(Math.max(d0, Math.abs(a - b) + 0.05), a + b - 0.02);
  const A = Math.acos(Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d))));
  const e1 = add(s, mul(rot2(u, A), a));
  const e2 = add(s, mul(rot2(u, -A), a));
  return { elbow: e1[1] >= e2[1] ? e1 : e2, hand: add(s, mul(u, d)) };
}

export function joints(p: Pose, rig: RigId = "warrior"): Joints {
  const b = BUILDS[rig];
  const up = rot2([0, -1], p.lean);
  const right = rot2([1, 0], p.lean);
  const torsoLen = b.torso * (1 - p.squash * 0.04);
  const neckRel = mul(up, torsoLen);
  const headRel = add(neckRel, mul(rot2([0, -1], p.lean + p.tilt), b.head * 0.86));
  // the torso twist closes the shoulders in and swings them toward the side the chest turns to
  const tw = p.twist ?? 0;
  const spread = 1 - 0.65 * Math.abs(tw);
  const shift = tw * 1.8;
  const shFRel = add(add(neckRel, mul(up, -2.4)), mul(right, b.shoulder * spread + shift));
  const shBRel = add(add(neckRel, mul(up, -2.4)), mul(right, -b.shoulder * spread + shift));
  let elFRel = add(shFRel, mul(limbDir(p.armF), b.upperArm));
  let haFRel = add(elFRel, mul(limbDir(p.armF + p.elbowF), b.forearm));
  let elBRel = add(shBRel, mul(limbDir(p.armB), b.upperArm));
  let haBRel = add(elBRel, mul(limbDir(p.armB + p.elbowB), b.forearm));
  // the back hand on the weapon (a two-handed grip) or at a torso point — solved in hip space, before the whole figure is placed
  const wdirRel = limbDir(p.weaponAngle);
  let bTarget: Pt | null = p.handBAt ? add(mul(right, p.handBAt[0]), mul(up, -p.handBAt[1])) : null;
  if (p.gripB !== undefined) {
    // the weapon is one rigid thing in two hands: when the back hand cannot reach its place on the grip, the weapon comes in toward the body
    // (both hands together, the angle kept) until it can, and the front arm follows it
    const reachB = b.upperArm + b.forearm - 0.4;
    let grip = add(haFRel, mul(wdirRel, p.gripB));
    const gap = Math.hypot(grip[0] - shBRel[0], grip[1] - shBRel[1]);
    if (gap > reachB) {
      const pull = mul([(shBRel[0] - grip[0]) / gap, (shBRel[1] - grip[1]) / gap], gap - reachB);
      grip = add(grip, pull);
      const front = reach(shFRel, add(haFRel, pull), b.upperArm, b.forearm);
      elFRel = front.elbow;
      haFRel = front.hand;
    }
    bTarget = grip;
  }
  if (bTarget) {
    const r = reach(shBRel, bTarget, b.upperArm, b.forearm);
    elBRel = r.elbow;
    haBRel = r.hand;
  }
  const hFRel: Pt = [b.hip, 0];
  const hBRel: Pt = [-b.hip, 0];
  const knFRel = add(hFRel, mul(limbDir(p.legF), b.thigh));
  const knBRel = add(hBRel, mul(limbDir(p.legB), b.thigh));
  // The foot plants under the knee; a bent knee folds the shin back (and lifts the foot).
  const ftFRel = add(knFRel, mul(limbDir(p.legF - p.kneeF), b.shin));
  const ftBRel = add(knBRel, mul(limbDir(p.legB - p.kneeB), b.shin));
  // Grounding: the lowest foot (or knee, kneeling) stands on the floor; `oy` lifts the whole figure off it (a jump, a run's airtime).
  const standingHipY = FEET_Y - (b.thigh + b.shin) * 0.985;
  const r = (v: Pt): Pt => rot2(v, p.rot);
  let hipY = standingHipY + p.oy;
  if (!p.free) {
    const lowest = Math.max(...[ftFRel, ftBRel, knFRel, knBRel].map((v) => r(v)[1]));
    hipY = FEET_Y - lowest + p.oy;
  }
  const toWorld = (rel: Pt): Pt => {
    const q = r(rel);
    return [ANCHOR_X + q[0] + p.ox, hipY + q[1]];
  };
  return {
    rig,
    b,
    hip: toWorld([0, 0]),
    neck: toWorld(neckRel),
    head: toWorld(headRel),
    shoulderF: toWorld(shFRel),
    shoulderB: toWorld(shBRel),
    elbowF: toWorld(elFRel),
    handF: toWorld(haFRel),
    elbowB: toWorld(elBRel),
    handB: toWorld(haBRel),
    hipF: toWorld(hFRel),
    hipB: toWorld(hBRel),
    kneeF: toWorld(knFRel),
    kneeB: toWorld(knBRel),
    footF: toWorld(ftFRel),
    footB: toWorld(ftBRel),
    torsoAngle: p.lean + p.rot,
    headAngle: p.lean + p.tilt + p.rot,
    weaponDir: rot2(wdirRel, p.rot),
    weaponDirB: rot2(limbDir(p.weaponB ?? p.weaponAngle + Math.PI - 0.4), p.rot),
  };
}
