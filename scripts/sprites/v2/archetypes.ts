import { at, breath, cycle, E, koBack, koForward, koKneel, M, P, stride, type ClipName, type Pose } from "./poseKit";

/**
 * HERO RENDERER v2 — the ARCHETYPE pose languages: two more skeletons per class beside the class's original one (rig.ts). Each is a different
 * PERSON — its own build, stance, grip and rhythm — so twenty heroes of one class are three kinds of fighter before any equipment is chosen:
 * a brute shoulders a greatsword while a duelist stands side-on behind a buckler; a juggernaut peers over a raised shield while a sentinel
 * grounds his; an assassin waits upright while a brawler bounces behind his knives; a warden plants a longbow while a skirmisher crouches over
 * a shortbow; a battlemage holds a staff across his body while a sage leans on his; a templar shoulders a holy mace while a monk prays beside
 * his staff.
 *
 * Shared contract (poseKit): six-frame loops, the class's attack clip with its impact frame (2 for melee, 3 for a shot / cast), three hit
 * frames, a six-frame KO and a four-frame victory — so the timing the arena lines up with the server is identical for every archetype.
 */

type Clip = ClipName;

// =============================================================================== WARRIOR
// BRUTE — a greatsword in both hands (the back hand holds the long grip above the front one; the torso turns to bring both arms forward).

// on the march the blade rests on the shoulder, level and pointing far out behind at chest height — under the chin, the face clear
const bruteCarry = { armF: 0.2, elbowF: 1.85, weaponAngle: 4.72, gripB: 4, twist: 0.85 } as const;
// at rest the greatsword is held LOW, both hands at the hip, its point trailing behind the heels (the tail guard) — the brute's silhouette
const bruteTail = { armF: 0.05, elbowF: 0.55, weaponAngle: 5.0, gripB: 4, twist: 0.85 } as const;

function warriorBrute(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the tail guard: both hands on the grip at the hip, the long blade trailing low behind, feet wide and knees bent — coiled and huge
      return P({ ...bruteTail, lean: 0.12, squash: k * 0.5, legF: 0.46, legB: -0.44, kneeF: 0.3, kneeB: 0.34, weaponAngle: 5.0 + k * 0.04, tilt: -k * 0.03, capeSway: k * 0.6 });
    case "idle2":
      // leaning on it: the point grounded before the feet, both hands on the pommel at the chest, chin up
      return P({ lean: -0.04, squash: k * 0.5, legF: 0.34, legB: -0.36, kneeF: 0.1, kneeB: 0.14, armF: 1.3, elbowF: 0.9, weaponAngle: 0.72, gripB: 3, twist: 0.9, tilt: -0.06 + k * 0.02, capeSway: k * 0.6 });
    case "move": {
      // a heavy, rolling stride with the blade on the shoulder: short airtime, a squash on each footfall, the shoulders rocking
      const { s } = cycle(f);
      return P({ ...bruteCarry, ...stride(f, { stride: 0.62, lift: 0.85, bob: 0.9, base: 0.16, squash: 0.45 }), lean: 0.18, tilt: s * 0.04, weaponAngle: 4.72 + s * 0.06, armF: 0.22 - s * 0.06, capeSway: -2.2 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the blade hauled up behind the head, body coiled away · 1 the turn begins · 2 IMPACT: a huge diagonal cleave, the body fully turned into
      // it, weight on the front foot · 3 the blade carries down past the legs · 4 hauled back up · 5 back on the shoulder
      return P({
        armF: at([2.55, 2.2, 1.0, 0.55, 0.4, 0.1], f), elbowF: at([0.55, 0.3, 0.35, 0.4, 0.8, 0.6], f), weaponAngle: at([4.0, 3.4, 1.15, 0.9, 5.6, 5.05], f),
        gripB: 4, twist: at([-0.2, 0.5, 0.95, 1.0, 0.85, 0.8], f),
        lean: at([-0.3, 0.05, 0.5, 0.55, 0.3, 0.06], f), tilt: at([-0.1, 0, 0.08, 0.1, 0.02, 0], f), ox: at([-2.0, 0.4, 3.2, 3.4, 2.2, 0.8], f),
        legF: at([-0.05, 0.4, 0.8, 0.8, 0.55, 0.42], f), legB: at([0.3, -0.3, -0.62, -0.62, -0.45, -0.4], f),
        kneeF: at([0.3, 0.3, 0.6, 0.65, 0.35, 0.18], f), kneeB: at([0.5, 0.2, 0.12, 0.12, 0.2, 0.22], f), squash: at([0, 0, 0.5, 0.6, 0.2, 0], f),
        mouth: at(M("rest", "shout", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([2, -2, -4.6, -4, -2, 0], f),
      });
    case "skill":
      // a spinning cleave: the blade swung flat around the body — wind · behind · IMPACT (the blade sweeping forward, level) · around · settle
      return P({
        armF: at([0.4, 1.6, 1.62, 1.55, 0.9, 0.1], f), elbowF: at([0.8, 0.2, 0.1, 0.15, 0.9, 0.6], f), weaponAngle: at([5.2, -1.3, 1.62, 1.75, 2.8, 5.05], f),
        gripB: 4, twist: at([-0.6, -1.0, 0.95, 1.0, 0.7, 0.8], f), lean: at([0.1, 0.3, 0.38, 0.32, 0.15, 0.05], f), ox: at([-1.0, 0.5, 1.6, 2.0, 1.2, 0.6], f),
        legF: at([0.3, 0.55, 0.7, 0.62, 0.48, 0.42], f), legB: at([-0.3, -0.5, -0.6, -0.55, -0.45, -0.4], f),
        kneeF: at([0.6, 0.5, 0.45, 0.4, 0.3, 0.18], f), kneeB: at([0.7, 0.4, 0.2, 0.2, 0.22, 0.22], f), squash: at([0.5, 0.2, 0.3, 0.2, 0.1, 0], f),
        mouth: at(M("rest", "open", "shout", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([1, 3.4, -4.4, -3.6, -1.6, 0], f), glow: at([0.2, 0.5, 1, 0.8, 0.4, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...bruteTail, lean: -0.16, tilt: -0.1, ox: -1.8, legF: 0.46, legB: -0.36, kneeF: 0.3, kneeB: 0.5, weaponAngle: 5.2, eyes: "hurt", mouth: "hurt", squash: 0.5, capeSway: 2.6 }),
        P({ ...bruteTail, lean: -0.04, ox: -1.3, legF: 0.46, legB: -0.4, kneeF: 0.3, kneeB: 0.4, weaponAngle: 5.1, eyes: "hurt", mouth: "hurt", capeSway: 1.6 }),
        P({ ...bruteTail, lean: 0.1, ox: -0.4, legF: 0.46, legB: -0.44, kneeF: 0.3, kneeB: 0.34, capeSway: 0.6 }),
      ], f);
    case "ko":
      // the greatsword falls BACK along the body (flung forward it would run off the frame)
      return koForward(f, { weaponAngle: at([2.4, 0.9, 0.5, -0.15, -0.12, -0.16], f) });
    case "victory":
      // the greatsword planted point-down before him, one hand on its pommel, the other fist punched at the sky
      return P({
        armF: 1.3, elbowF: 0.9, weaponAngle: 0.72, armB: at([2.7, 2.95, 2.85, 2.75], f), elbowB: at([0.4, 0.15, 0.25, 0.35], f), twist: 0.3,
        oy: at([0, -0.4, -0.6, -0.2], f), lean: at([-0.06, -0.12, -0.14, -0.08], f), legF: 0.34, legB: -0.36, kneeF: 0.1, kneeB: 0.14,
        eyes: "cheer", mouth: "open", capeSway: at([0, 2, 3, 1], f),
      });
  }
}

// DUELIST — side-on, light on the feet, the sword point toward the foe and the buckler (back hand) raised before the chest.

const duelGuard = { armF: 1.15, elbowF: 0.3, weaponAngle: 2.05, handBAt: [5.2, -9.4] as const, twist: 0.35 };

function warriorDuelist(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the en-garde: feet long and in line, knees bent, the sword extended toward the foe, the buckler up
      return P({ ...duelGuard, lean: -0.02, squash: k * 0.3, legF: 0.62, legB: -0.5, kneeF: 0.42, kneeB: 0.32, armF: 1.15 - k * 0.05, weaponAngle: 2.05 + k * 0.08, tilt: -0.04, capeSway: k * 0.7 });
    case "idle2":
      // at ease: upright, the blade held down and forward at the side, the buckler hanging from the back hand at the hip, chin raised
      return P({ lean: -0.04, squash: k * 0.3, legF: 0.24, legB: -0.22, kneeF: 0.06, kneeB: 0.1, armF: 0.25, elbowF: 0.4, weaponAngle: 1.05 + k * 0.05, handBAt: [-2.6, -4.6], tilt: -0.08, capeSway: k * 0.7 });
    case "move": {
      // quick, light steps on the balls of the feet, the guard kept up
      const { s } = cycle(f);
      return P({ ...duelGuard, ...stride(f, { stride: 0.68, lift: 1.0, bob: 1.5, base: 0.16, squash: 0.15 }), lean: 0.2, armF: 1.05 - s * 0.08, weaponAngle: 2.0 + s * 0.12, capeSway: -2.6 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the blade drawn back beside the head · 1 the long step · 2 IMPACT: a full LUNGE, arm and blade in one straight line, back leg straight ·
      // 3 hold · 4 recover onto the back foot · 5 en-garde
      return P({
        armF: at([1.9, 1.5, 1.55, 1.5, 1.3, 1.15], f), elbowF: at([1.4, 0.4, 0.02, 0.05, 0.25, 0.3], f), weaponAngle: at([3.6, 2.4, 1.6, 1.62, 1.85, 2.05], f),
        handBAt: [at([4, 2, -1.5, -1, 2, 5.2], f), at([-9.4, -8.6, -7.6, -7.8, -9, -9.4], f)], twist: at([0, 0.5, 0.75, 0.7, 0.45, 0.35], f),
        lean: at([-0.14, 0.2, 0.42, 0.4, 0.2, -0.02], f), ox: at([-1.4, 1.5, 5.2, 4.9, 2.6, 0.6], f),
        legF: at([0.5, 0.85, 1.05, 1.0, 0.75, 0.62], f), legB: at([-0.45, -0.65, -0.8, -0.78, -0.6, -0.5], f),
        kneeF: at([0.45, 0.6, 0.95, 0.9, 0.6, 0.42], f), kneeB: at([0.35, 0.12, 0.02, 0.04, 0.2, 0.32], f),
        mouth: at(M("rest", "rest", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([1.4, -2, -4.2, -3.6, -1.4, 0], f),
      });
    case "skill":
      // the riposte: buckler punch · blade cocked · IMPACT: a rising cut through the guard · the follow-through high · back · en-garde
      return P({
        armF: at([1.0, 0.6, 2.2, 2.6, 1.6, 1.15], f), elbowF: at([0.6, 1.6, 0.3, 0.2, 0.4, 0.3], f), weaponAngle: at([2.0, 0.7, 2.6, 3.1, 2.3, 2.05], f),
        handBAt: [at([10, 6, 3, 2, 4, 5.2], f), at([-9.8, -9.4, -8.6, -8.8, -9.2, -9.4], f)], twist: at([0.8, 0.3, 0.7, 0.8, 0.5, 0.35], f),
        lean: at([0.32, 0.18, 0.3, 0.12, 0.05, -0.02], f), ox: at([2.4, 1.2, 4.2, 4.6, 2.4, 0.6], f), oy: at([0, 0, -1.2, -1.6, -0.4, 0], f),
        legF: at([0.75, 0.6, 0.85, 0.8, 0.7, 0.62], f), legB: at([-0.6, -0.5, -0.65, -0.6, -0.55, -0.5], f),
        kneeF: at([0.6, 0.55, 0.5, 0.4, 0.45, 0.42], f), kneeB: at([0.2, 0.3, 0.2, 0.2, 0.28, 0.32], f),
        mouth: at(M("open", "rest", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([-2, 0, -3.4, -3, -1, 0], f), glow: at([0.3, 0.4, 1, 0.7, 0.3, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...duelGuard, lean: -0.32, tilt: -0.14, ox: -2.8, oy: -0.6, legF: 0.55, legB: -0.48, kneeF: 0.3, kneeB: 0.5, armF: 0.8, weaponAngle: 2.4, handBAt: [7, -11], eyes: "hurt", mouth: "hurt", capeSway: 3.2, squash: 0.4 }),
        P({ ...duelGuard, lean: -0.18, ox: -2.0, legF: 0.58, legB: -0.5, kneeF: 0.36, kneeB: 0.4, armF: 0.95, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ ...duelGuard, lean: -0.04, ox: -0.6, legF: 0.62, legB: -0.5, kneeF: 0.42, kneeB: 0.32, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f, { handBAt: undefined });
    case "victory":
      // the salute: the hilt before the face, blade straight up, then a flourish
      return P({
        armF: at([1.3, 1.25, 2.5, 1.3], f), elbowF: at([1.7, 1.75, 0.4, 1.7], f), weaponAngle: at([3.1, 3.12, 3.5, 3.08], f), handBAt: [-2.6, -4.6],
        legF: 0.22, legB: -0.22, kneeF: 0.04, kneeB: 0.06, lean: -0.05, tilt: at([-0.1, -0.12, -0.15, -0.1], f), oy: at([0, -0.3, -0.6, 0], f),
        eyes: "cheer", mouth: at(M("rest", "open", "open", "rest"), f), capeSway: at([0, 1, 2.4, 1], f),
      });
  }
}

// =============================================================================== TANK
// JUGGERNAUT — the shield held HIGH (its rim under the eyes), the mace low behind it; slow, crushing weight.

const juggShield = { armB: 0.72, elbowB: 1.18 };
const juggMace = { armF: -0.15, elbowF: 0.6, weaponAngle: 2.6 };

function tankJuggernaut(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      return P({ ...juggShield, ...juggMace, lean: 0.1, squash: k * 0.4, legF: 0.46, legB: -0.42, kneeF: 0.42, kneeB: 0.46, armF: -0.15 + k * 0.04, weaponAngle: 2.6 - k * 0.05, capeSway: k * 0.4 });
    case "idle2":
      // the shield rested on the ground at the front foot, leaning on it with both forearms; the mace hanging from the fist
      return P({ lean: 0.2, squash: k * 0.4, legF: 0.4, legB: -0.44, kneeF: 0.32, kneeB: 0.4, armB: 0.85, elbowB: 0.55, armF: 0.6, elbowF: 0.5, weaponAngle: 1.05 + k * 0.04, capeSway: k * 0.4 });
    case "move": {
      // a crushing march: no airtime at all, a deep squash on every footfall, the whole body rolling side to side
      const { s } = cycle(f);
      return P({ ...juggShield, ...juggMace, ...stride(f, { stride: 0.38, lift: 0.5, bob: 0, base: 0.36, squash: 0.8 }), lean: 0.16, tilt: s * 0.07, armF: -0.15 + s * 0.12, capeSway: -1.2 + s * 0.5 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // a rising smash from under the shield: 0 the mace swung far back and low · 1 the step · 2 IMPACT: an uppercut over the shield's rim ·
      // 3 the mace high, the body extended · 4-5 back behind the shield
      return P({
        ...juggShield,
        armF: at([-0.9, -0.2, 1.6, 2.2, 1.0, -0.1], f), elbowF: at([0.3, 0.6, 0.6, 0.4, 0.6, 0.6], f), weaponAngle: at([0.0, 1.2, 2.7, 3.3, 2.9, 2.6], f),
        twist: at([-0.6, -0.2, 0.6, 0.7, 0.3, 0], f), lean: at([0.0, 0.18, 0.3, 0.2, 0.15, 0.1], f), ox: at([-1.2, 0.2, 2.2, 2.4, 1.2, 0.2], f),
        legF: at([0.4, 0.55, 0.6, 0.58, 0.5, 0.46], f), legB: at([-0.42, -0.45, -0.5, -0.48, -0.44, -0.42], f),
        kneeF: at([0.5, 0.55, 0.5, 0.45, 0.45, 0.42], f), kneeB: at([0.5, 0.45, 0.3, 0.32, 0.4, 0.46], f), squash: at([0.4, 0.2, 0.6, 0.4, 0.2, 0], f),
        mouth: at(M("rest", "shout", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), capeSway: at([1, -1, -2.6, -2.2, -1, 0], f),
      });
    case "skill":
      // the earthshaker: the shield raised overhead · IMPACT: slammed down into the ground before the feet, the body dropping onto it
      return P({
        armB: at([1.2, 2.4, 2.6, 0.95, 0.9, 1.05], f), elbowB: at([1.2, 0.6, 0.4, 0.5, 0.8, 1.2], f), ...juggMace, armF: at([-0.2, 0.2, 0.3, -0.4, -0.3, -0.15], f),
        lean: at([0.1, -0.1, -0.16, 0.42, 0.3, 0.1], f), oy: at([0, -1.2, -2.2, 0, 0, 0], f), ox: at([-0.4, -0.2, 0.6, 2.6, 2.0, 0.4], f),
        legF: at([0.46, 0.4, 0.42, 0.66, 0.55, 0.46], f), legB: at([-0.42, -0.3, -0.3, -0.5, -0.45, -0.42], f),
        kneeF: at([0.5, 0.4, 0.5, 0.9, 0.6, 0.42], f), kneeB: at([0.5, 0.4, 0.5, 0.8, 0.6, 0.46], f), squash: at([0.5, 0, 0, 0.9, 0.5, 0.2], f),
        mouth: at(M("rest", "open", "shout", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), capeSway: at([0, 1.5, 2.2, -2.4, -1, 0], f),
        glow: at([0.1, 0.4, 0.7, 1, 0.5, 0.1], f),
      });
    case "hit":
      // an anvil: it barely sways
      return at([
        P({ ...juggShield, ...juggMace, lean: 0.02, ox: -0.7, legF: 0.46, legB: -0.42, kneeF: 0.48, kneeB: 0.52, eyes: "hurt", mouth: "hurt", squash: 0.7, capeSway: 1 }),
        P({ ...juggShield, ...juggMace, lean: 0.06, ox: -0.4, legF: 0.46, legB: -0.42, kneeF: 0.45, kneeB: 0.48, eyes: "hurt", mouth: "hurt", squash: 0.3, capeSway: 0.5 }),
        P({ ...juggShield, ...juggMace, lean: 0.1, ox: -0.1, legF: 0.46, legB: -0.42, kneeF: 0.42, kneeB: 0.46 }),
      ], f);
    case "ko":
      return koForward(f);
    case "victory":
      // the mace and the shield beaten together over the head
      return P({
        armF: at([2.4, 2.6, 2.4, 2.5], f), elbowF: at([0.5, 0.3, 0.5, 0.4], f), weaponAngle: at([3.3, 3.5, 3.3, 3.4], f), armB: at([2.2, 2.0, 2.2, 2.1], f), elbowB: at([0.6, 0.8, 0.6, 0.7], f),
        legF: 0.46, legB: -0.42, kneeF: at([0.4, 0.5, 0.4, 0.45], f), kneeB: 0.46, lean: 0, oy: at([0, -0.4, 0, -0.2], f), eyes: "cheer", mouth: "open", capeSway: at([0, 1, 0.5, 1], f),
      });
  }
}

// SENTINEL — tall and upright, the shield GROUNDED at the side (its foot on the floor), a long-hafted mace raised upright.

const sentShield = { armB: 0.35, elbowB: 0.45 };
const sentMace = { armF: 0.55, elbowF: 1.35, weaponAngle: 3.0 };

function tankSentinel(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      return P({ ...sentShield, ...sentMace, lean: -0.04, squash: k * 0.3, legF: 0.22, legB: -0.2, kneeF: 0.06, kneeB: 0.08, armF: 0.55 - k * 0.03, weaponAngle: 3.0 + k * 0.04, tilt: -0.06, capeSway: k * 0.5 });
    case "idle2":
      // on guard: the shield lifted to the hip, the mace levelled over its rim like a lance
      return P({ armB: 0.75, elbowB: 1.0, armF: 0.95, elbowF: 0.6, weaponAngle: 2.05 + k * 0.04, lean: 0.06, squash: k * 0.3, legF: 0.4, legB: -0.36, kneeF: 0.24, kneeB: 0.28, twist: 0.2, capeSway: k * 0.5 });
    case "move": {
      // a long, measured knight's stride: upright, the mace carried vertical
      const { s } = cycle(f);
      return P({ ...sentShield, ...sentMace, ...stride(f, { stride: 0.6, lift: 0.75, bob: 0.6, base: 0.1, squash: 0.25 }), lean: 0.08, armB: 0.35 - s * 0.15, weaponAngle: 3.0 + s * 0.06, capeSway: -1.8 + s * 0.7 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // the overhead chop with the long haft: 0 raised high and back · 1 the step · 2 IMPACT: brought straight down at arm's length · 3 hold ·
      // 4-5 raised upright again
      return P({
        ...sentShield, armB: at([0.5, 0.6, 0.7, 0.65, 0.5, 0.35], f),
        armF: at([2.2, 2.1, 1.25, 1.15, 1.0, 0.55], f), elbowF: at([0.6, 0.4, 0.05, 0.1, 0.8, 1.35], f), weaponAngle: at([4.25, 3.7, 0.95, 0.9, 2.4, 3.0], f),
        twist: at([-0.4, 0, 0.5, 0.5, 0.2, 0], f), lean: at([-0.2, 0.05, 0.32, 0.3, 0.12, -0.04], f), ox: at([-1.0, 0.6, 1.0, 0.9, 0.6, 0.2], f),
        legF: at([0.2, 0.45, 0.6, 0.58, 0.4, 0.22], f), legB: at([-0.24, -0.36, -0.46, -0.44, -0.3, -0.2], f),
        kneeF: at([0.1, 0.2, 0.36, 0.34, 0.2, 0.06], f), kneeB: at([0.12, 0.1, 0.08, 0.08, 0.1, 0.08], f), squash: at([0, 0, 0.4, 0.3, 0.1, 0], f),
        mouth: at(M("rest", "shout", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), capeSway: at([1.4, -1, -3.2, -2.6, -1, 0], f),
      });
    case "skill":
      // the shield charge: the shield swung up before the body · the lowered shoulder · IMPACT: driven forward at a run · recover
      return P({
        armB: at([0.8, 1.4, 1.55, 1.6, 1.1, 0.35], f), elbowB: at([1.4, 0.6, 0.2, 0.15, 0.6, 0.45], f), ...sentMace, armF: at([0.3, 0.1, -0.2, -0.3, 0.2, 0.55], f),
        weaponAngle: at([2.8, 2.6, 2.4, 2.4, 2.7, 3.0], f), lean: at([0.0, 0.3, 0.45, 0.48, 0.25, -0.04], f), ox: at([-0.8, 0.8, 4.4, 6.0, 3.2, 0.4], f), twist: at([0.2, 0.5, 0.6, 0.6, 0.3, 0], f),
        legF: at([0.3, 0.6, 0.85, 0.9, 0.5, 0.22], f), legB: at([-0.3, -0.6, -0.8, -0.85, -0.45, -0.2], f),
        kneeF: at([0.3, 0.5, 0.5, 0.45, 0.3, 0.06], f), kneeB: at([0.3, 0.3, 0.15, 0.1, 0.2, 0.08], f), squash: at([0.3, 0.2, 0, 0.3, 0.2, 0], f),
        mouth: at(M("rest", "rest", "shout", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), capeSway: at([0.5, -1.4, -3.6, -4.4, -2, 0], f),
        glow: at([0.1, 0.4, 0.7, 1, 0.5, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...sentShield, ...sentMace, lean: -0.22, tilt: -0.1, ox: -1.8, legF: 0.26, legB: -0.2, kneeF: 0.1, kneeB: 0.3, weaponAngle: 3.3, eyes: "hurt", mouth: "hurt", squash: 0.4, capeSway: 2 }),
        P({ ...sentShield, ...sentMace, lean: -0.12, ox: -1.2, legF: 0.24, legB: -0.2, kneeF: 0.08, kneeB: 0.2, weaponAngle: 3.15, eyes: "hurt", mouth: "hurt", capeSway: 1.2 }),
        P({ ...sentShield, ...sentMace, lean: -0.04, ox: -0.3, legF: 0.22, legB: -0.2, kneeF: 0.06, kneeB: 0.08, capeSway: 0.5 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      return P({
        ...sentShield, armF: at([2.3, 2.45, 2.35, 2.25], f), elbowF: at([0.2, 0.1, 0.15, 0.2], f), weaponAngle: at([2.5, 2.6, 2.55, 2.5], f),
        legF: 0.22, legB: -0.2, kneeF: 0.06, kneeB: 0.08, lean: -0.06, tilt: -0.1, oy: at([0, -0.5, -0.8, -0.3], f), eyes: "cheer", mouth: "open", capeSway: at([0, 1.2, 2, 0.8], f),
      });
  }
}

// =============================================================================== ROGUE
// ASSASSIN — tall and still: upright, both long knives held reversed (blades along the forearms), a predator's glide.

const assassinRest = { armF: 0.2, elbowF: 0.45, weaponAngle: 0.35, armB: -0.1, elbowB: 0.35, weaponB: 0.2 };

function rogueAssassin(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // waiting: upright, weight on the back foot, the long knives reversed and low, the head tilted, perfectly still but for the breath
      return P({ ...assassinRest, lean: -0.02, tilt: 0.08, squash: k * 0.2, legF: 0.16, legB: -0.14, kneeF: 0.12, kneeB: 0.04, armF: 0.2 + k * 0.03, capeSway: k * 0.9 });
    case "idle2":
      // the blade raised: the front knife held point-forward at the shoulder, the other reversed behind the back
      return P({ lean: 0.1, tilt: 0.04, squash: k * 0.2, legF: 0.36, legB: -0.3, kneeF: 0.32, kneeB: 0.26, armF: 1.0, elbowF: 1.1, weaponAngle: 1.75 + k * 0.05, armB: -0.55, elbowB: 0.9, weaponB: -0.6, capeSway: k * 0.9 });
    case "move": {
      // the stalk: long, low, gliding strides — the head level, the knives trailing
      const { s } = cycle(f);
      return P({ ...stride(f, { stride: 0.85, lift: 1.05, bob: 0.4, base: 0.3, squash: 0.08 }), lean: 0.32, tilt: -0.06, armF: -0.5 + s * 0.1, elbowF: 0.6, weaponAngle: -0.4, armB: -0.75 - s * 0.1, elbowB: 0.5, weaponB: -0.5, capeSway: -3.4 + s * 0.8 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 drawn back and low · 1 the glide in · 2 IMPACT: a long lunge, the knife driven forward at full reach · 3 the reversed blade follows ·
      // 4 a step back · 5 upright again
      return P({
        armF: at([-0.4, 0.7, 1.58, 1.0, 0.6, 0.2], f), elbowF: at([1.2, 0.8, 0.02, 0.9, 0.7, 0.45], f), weaponAngle: at([0.8, 1.6, 1.58, 1.0, 0.6, 0.35], f),
        armB: at([0.3, 0.2, -0.4, 1.4, 0.4, -0.1], f), elbowB: at([1.2, 1.0, 0.8, 0.2, 0.6, 0.35], f), weaponB: at([0.3, 0.2, -0.3, 1.6, 0.4, 0.2], f),
        twist: at([-0.4, 0.2, 0.6, -0.4, 0, 0], f), lean: at([0.1, 0.32, 0.55, 0.45, 0.2, 0], f), ox: at([-1.4, 2.0, 7.0, 6.4, 3.0, 0.4], f),
        legF: at([0.3, 0.7, 1.05, 0.95, 0.5, 0.16], f), legB: at([-0.3, -0.6, -0.85, -0.8, -0.45, -0.14], f),
        kneeF: at([0.5, 0.6, 0.85, 0.8, 0.4, 0.12], f), kneeB: at([0.4, 0.2, 0.05, 0.08, 0.2, 0.04], f),
        mouth: at(M("rest", "rest", "open", "rest", "rest", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([1, -2.4, -4.6, -4, -1.4, 0], f), glow: at([0.1, 0.5, 1, 0.7, 0.3, 0.1], f),
      });
    case "skill":
      // the vanishing strike: a deep crouch · gone (a long leap, tucked) · IMPACT: both knives driven DOWN on landing · rise · step · upright
      return P({
        oy: at([0, -4.5, -3, 0, 0, 0], f), lean: at([0.45, 0.5, 0.3, 0.6, 0.3, 0], f), ox: at([-1.5, 3.0, 6.0, 7.5, 4.0, 0.6], f),
        armF: at([-0.3, 2.4, 2.8, 1.2, 0.6, 0.2], f), elbowF: at([1.0, 0.8, 0.4, 0.2, 0.5, 0.45], f), weaponAngle: at([0.4, 3.4, 3.6, 0.6, 0.5, 0.35], f),
        armB: at([-0.5, 2.2, 2.6, 1.0, 0.3, -0.1], f), elbowB: at([1.0, 0.9, 0.5, 0.3, 0.5, 0.35], f), weaponB: at([0.3, 3.2, 3.4, 0.4, 0.3, 0.2], f),
        legF: at([0.6, 1.0, 0.7, 0.9, 0.5, 0.16], f), legB: at([-0.4, 0.2, -0.3, -0.7, -0.4, -0.14], f),
        kneeF: at([1.4, 1.8, 1.0, 1.3, 0.6, 0.12], f), kneeB: at([1.5, 1.9, 1.2, 0.5, 0.4, 0.04], f),
        mouth: at(M("rest", "rest", "open", "shout", "rest", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([1, -4, -2, -4.6, -2, 0], f), glow: at([0.2, 0.7, 0.9, 1, 0.4, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...assassinRest, lean: -0.3, tilt: -0.12, ox: -2.6, oy: -0.8, legF: 0.3, legB: -0.1, kneeF: 0.3, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3.4 }),
        P({ ...assassinRest, lean: -0.15, ox: -1.8, legF: 0.22, legB: -0.14, kneeF: 0.2, kneeB: 0.2, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ ...assassinRest, lean: -0.04, ox: -0.5, legF: 0.16, legB: -0.14, kneeF: 0.12, kneeB: 0.04, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f, { weaponB: 0.4 });
    case "victory":
      // the knives sheathed in one smooth motion, arms folded, a slight bow of the head
      return P({
        armF: at([1.0, 0.9, 0.85, 0.85], f), elbowF: at([1.8, 2.0, 2.1, 2.1], f), weaponAngle: at([0.4, 0.2, 0.1, 0.1], f), armB: at([0.9, 0.95, 1.0, 1.0], f), elbowB: at([1.9, 2.0, 2.1, 2.1], f), weaponB: 0.1,
        legF: 0.16, legB: -0.14, kneeF: 0.1, kneeB: 0.04, lean: -0.02, tilt: at([0.0, 0.1, 0.16, 0.12], f), eyes: at(E("open", "cheer", "cheer", "cheer"), f), mouth: "rest", capeSway: at([1.5, 1, 0.5, 0.8], f),
      });
  }
}

// BRAWLER — short and stocky, a boxer's guard with both knives up before the face, bouncing.

const brawlGuard = { armF: 0.85, elbowF: 1.75, weaponAngle: 2.6, armB: 0.7, elbowB: 1.9, weaponB: 2.4, twist: 0.45 };

function rogueBrawler(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle": {
      // bouncing on the toes behind the guard: the bounce is twice the breath (a fighter's rhythm)
      const b = Math.abs(Math.sin((f / 6) * Math.PI * 2));
      return P({ ...brawlGuard, lean: 0.2, oy: -b * 1.0, squash: (1 - b) * 0.4, legF: 0.4, legB: -0.38, kneeF: 0.45 + (1 - b) * 0.15, kneeB: 0.5 + (1 - b) * 0.15, armF: 0.85 - b * 0.06, armB: 0.7 + b * 0.06, capeSway: k * 0.7 });
    }
    case "idle2":
      // a low, wide crouch, one knife forward point-out, the other cocked at the ear
      return P({ lean: 0.34, squash: k * 0.4, legF: 0.55, legB: -0.5, kneeF: 0.75, kneeB: 0.8, armF: 1.25, elbowF: 0.35, weaponAngle: 1.7 + k * 0.05, armB: 1.6, elbowB: 1.4, weaponB: 3.3, twist: 0.2, capeSway: k * 0.7 });
    case "move": {
      // a scrappy, bouncing run with short quick strides, the guard up
      const { s } = cycle(f);
      return P({ ...brawlGuard, ...stride(f, { stride: 0.7, lift: 1.1, bob: 1.6, base: 0.3, squash: 0.3 }), lean: 0.34, armF: 0.85 + s * 0.15, armB: 0.7 - s * 0.15, capeSway: -2.4 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // the one-two: 0 dip · 1 the front jab · 2 IMPACT: the BACK hand's hook across, the body turning through it · 3 the front again ·
      // 4-5 back behind the guard
      return P({
        armF: at([0.7, 1.5, 0.9, 1.55, 1.1, 0.85], f), elbowF: at([1.9, 0.15, 1.6, 0.1, 1.2, 1.75], f), weaponAngle: at([2.6, 1.6, 2.4, 1.58, 2.2, 2.6], f),
        armB: at([0.5, 0.6, 1.55, 0.8, 0.6, 0.7], f), elbowB: at([2.0, 1.9, 0.3, 1.8, 1.9, 1.9], f), weaponB: at([2.4, 2.4, 1.7, 2.4, 2.4, 2.4], f),
        twist: at([0.2, -0.2, 1.0, 0.0, 0.3, 0.45], f), lean: at([0.3, 0.38, 0.45, 0.4, 0.3, 0.2], f), ox: at([-0.6, 2.4, 4.6, 5.2, 2.4, 0.4], f), oy: at([0, -0.6, 0, -0.6, -0.3, 0], f),
        legF: at([0.4, 0.62, 0.72, 0.7, 0.5, 0.4], f), legB: at([-0.42, -0.55, -0.62, -0.6, -0.45, -0.38], f),
        kneeF: at([0.6, 0.55, 0.6, 0.58, 0.5, 0.45], f), kneeB: at([0.6, 0.4, 0.3, 0.32, 0.45, 0.5], f), squash: at([0.4, 0, 0.3, 0.1, 0.1, 0], f),
        mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f), eyes: at(E("focus", "focus", "open", "open", "open", "open"), f),
        capeSway: at([0.6, -1.6, -3.2, -2.8, -1, 0], f), glow: at([0.1, 0.4, 1, 0.6, 0.2, 0.1], f),
      });
    case "skill":
      // the whirl: a spin with both knives out wide · IMPACT on the second half-turn · land
      return P({
        armF: at([0.6, 1.6, 1.6, 1.62, 1.3, 0.85], f), elbowF: at([1.6, 0.1, 0.1, 0.1, 0.8, 1.75], f), weaponAngle: at([2.4, 1.6, 1.4, 1.62, 2.0, 2.6], f),
        armB: at([0.5, -1.4, 1.6, 1.62, 1.0, 0.7], f), elbowB: at([1.8, 0.1, 0.1, 0.1, 1.0, 1.9], f), weaponB: at([2.4, -1.4, 1.5, 1.7, 2.0, 2.4], f),
        twist: at([0, -1, 1, -0.6, 0.2, 0.45], f), oy: at([0, -2.4, -3.0, 0, 0, 0], f), lean: at([0.3, 0.1, 0.15, 0.35, 0.3, 0.2], f), ox: at([-0.6, 1.0, 3.0, 4.4, 2.4, 0.4], f),
        legF: at([0.45, 0.3, 0.5, 0.7, 0.5, 0.4], f), legB: at([-0.4, -0.2, -0.4, -0.6, -0.45, -0.38], f),
        kneeF: at([0.8, 1.2, 1.0, 0.7, 0.5, 0.45], f), kneeB: at([0.85, 1.3, 1.1, 0.5, 0.5, 0.5], f),
        mouth: at(M("rest", "open", "shout", "shout", "rest", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([1, 3, -3, -4, -1.6, 0], f), glow: at([0.2, 0.6, 0.9, 1, 0.4, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...brawlGuard, lean: -0.1, tilt: -0.18, ox: -2.4, oy: -0.4, legF: 0.4, legB: -0.3, kneeF: 0.5, kneeB: 0.6, eyes: "hurt", mouth: "hurt", squash: 0.5, capeSway: 2.6 }),
        P({ ...brawlGuard, lean: 0.06, tilt: -0.06, ox: -1.6, legF: 0.4, legB: -0.36, kneeF: 0.5, kneeB: 0.55, eyes: "hurt", mouth: "hurt", capeSway: 1.6 }),
        P({ ...brawlGuard, lean: 0.18, ox: -0.5, legF: 0.4, legB: -0.38, kneeF: 0.45, kneeB: 0.5, capeSway: 0.6 }),
      ], f);
    case "ko":
      return koForward(f, { weaponB: 3.0 });
    case "victory":
      // both fists (and knives) pumped in the air, hopping
      return P({
        armF: at([2.7, 2.9, 2.7, 2.8], f), elbowF: at([0.4, 0.2, 0.4, 0.3], f), weaponAngle: at([3.1, 3.3, 3.1, 3.2], f), armB: at([2.6, 2.8, 2.6, 2.7], f), elbowB: at([0.4, 0.2, 0.4, 0.3], f), weaponB: at([3.0, 3.2, 3.0, 3.1], f),
        legF: 0.3, legB: -0.3, kneeF: at([0.3, 0.1, 0.3, 0.2], f), kneeB: at([0.3, 0.1, 0.3, 0.2], f), oy: at([0, -2.2, 0, -1.2], f), lean: 0.02, eyes: "cheer", mouth: "open", capeSway: at([0, 2, 1, 2], f),
      });
  }
}

// =============================================================================== RANGER
// WARDEN — tall, a longbow nearly his height; a wide planted stance and a DEEP, slow draw that leans back.

function rangerWarden(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the longbow grounded beside the front foot like a staff, the hand at its grip, the other thumb in the belt
      return P({ lean: -0.02, legF: 0.3, legB: -0.3, kneeF: 0.08, kneeB: 0.12, armF: 0.55 - k * 0.03, elbowF: 0.35, weaponAngle: 2.95, handBAt: [-3.4, -3.2], squash: k * 0.3, tilt: -0.04, capeSway: k * 0.7 });
    case "idle2":
      // an arrow on the string, the bow held low across the body, watching the field
      return P({ lean: 0.04, legF: 0.42, legB: -0.4, kneeF: 0.18, kneeB: 0.22, armF: 0.75 - k * 0.03, elbowF: 0.3, weaponAngle: Math.PI - 0.3, draw: 0.3, armB: 0.7, elbowB: 0.6, squash: k * 0.3, eyes: "focus", capeSway: k * 0.7 });
    case "move": {
      const { s } = cycle(f);
      return P({ ...stride(f, { stride: 0.72, lift: 0.9, bob: 1.0, base: 0.1, squash: 0.2 }), lean: 0.14, armF: 0.6 - s * 0.2, elbowF: 0.35, weaponAngle: 2.85 + s * 0.06, armB: -0.2 + s * 0.55, elbowB: 0.5, capeSway: -2.2 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the bow raised · 1 the long draw begins · 2 FULL draw, leaning back, still — aiming high · 3 IMPACT: release · 4 the string arm flies
      // back · 5 lower
      return P({
        armF: at([1.5, 1.68, 1.75, 1.75, 1.7, 1.2], f), elbowF: at([0.15, 0.02, 0, 0, 0.05, 0.35], f), weaponAngle: Math.PI + 0.06,
        draw: at([0.1, 0.55, 1, 0, 0, 0], f), armB: at([1.4, 2.2, 2.6, 1.6, 0.9, 0.4], f), elbowB: at([-0.3, -1.4, -2.0, -0.4, 0.1, 0.4], f),
        lean: at([0.0, -0.08, -0.16, -0.2, -0.12, -0.02], f), ox: at([0, -0.4, -1.0, -1.8, -1.2, -0.2], f), twist: at([0.1, -0.2, -0.4, -0.3, -0.1, 0], f),
        legF: 0.48, legB: -0.46, kneeF: 0.22, kneeB: 0.3,
        eyes: at(E("open", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "rest", "open", "rest", "rest"), f),
        capeSway: at([0, 0, 0, 3.4, 2, 0.5], f),
      });
    case "skill":
      // the sky volley: the bow tilted up high · drawn · IMPACT: released skyward · follow-through · lower
      return P({
        armF: at([1.9, 2.3, 2.35, 2.35, 2.2, 1.2], f), elbowF: at([0.2, 0.05, 0, 0, 0.1, 0.35], f), weaponAngle: at([3.6, 3.85, 3.9, 3.9, 3.7, 3.2], f),
        draw: at([0.1, 0.6, 1, 0, 0, 0], f), armB: at([1.8, 2.5, 2.9, 2.1, 1.3, 0.4], f), elbowB: at([-0.3, -1.3, -1.9, -0.5, 0, 0.4], f),
        lean: at([-0.1, -0.22, -0.3, -0.3, -0.2, -0.04], f), ox: at([0, -0.6, -1.2, -1.6, -1.0, 0], f), tilt: at([-0.15, -0.25, -0.3, -0.3, -0.2, -0.05], f),
        legF: 0.5, legB: -0.48, kneeF: at([0.2, 0.28, 0.32, 0.32, 0.25, 0.2], f), kneeB: 0.32,
        eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "rest", "shout", "open", "rest"), f),
        capeSway: at([0, 0, 0, 3.6, 2, 0.5], f), glow: at([0.2, 0.5, 0.9, 1, 0.5, 0.1], f),
      });
    case "hit":
      return at([
        P({ lean: -0.34, tilt: -0.14, ox: -2.2, armF: 0.3, elbowF: 0.4, weaponAngle: 2.6, armB: -0.6, legF: 0.38, legB: -0.28, kneeB: 0.4, eyes: "hurt", mouth: "hurt", capeSway: 3.2, squash: 0.5 }),
        P({ lean: -0.22, tilt: -0.08, ox: -1.6, armF: 0.42, elbowF: 0.38, weaponAngle: 2.8, armB: -0.4, legF: 0.34, legB: -0.3, kneeB: 0.3, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ lean: -0.02, ox: -0.5, armF: 0.55, elbowF: 0.35, weaponAngle: 2.95, handBAt: [-3.4, -3.2], legF: 0.3, legB: -0.3, kneeF: 0.08, kneeB: 0.12, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      // the longbow held up high in one hand, the other fist on the hip
      return P({
        armF: at([2.5, 2.7, 2.6, 2.5], f), elbowF: at([0.2, 0.1, 0.15, 0.2], f), weaponAngle: at([3.1, 3.2, 3.15, 3.1], f), handBAt: [-3.4, -3.2],
        legF: 0.3, legB: -0.3, kneeF: 0.08, kneeB: 0.12, lean: -0.04, oy: at([0, -0.6, -0.9, -0.3], f), eyes: "cheer", mouth: "open", capeSway: at([0, 2, 3, 1], f),
      });
  }
}

// SKIRMISHER — small and quick, crouched, a shortbow held low and LEVEL across the body; snap shots from the hip.

const skirmCrouch = { lean: 0.3, legF: 0.48, legB: -0.42, kneeF: 0.75, kneeB: 0.8 };

function rangerSkirmisher(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // crouched low, the shortbow held level before the belly with an arrow on the string, eyes on the field
      return P({ ...skirmCrouch, kneeF: 0.75 + k * 0.08, kneeB: 0.8 + k * 0.08, armF: 0.75, elbowF: 0.5, weaponAngle: 1.75, draw: 0.3, armB: 0.6, elbowB: 0.8, eyes: "focus", capeSway: k * 0.8 });
    case "idle2":
      // up on the toes, the bow over the shoulder, a hand shading the eyes
      return P({ lean: 0.06, legF: 0.24, legB: -0.22, kneeF: 0.1, kneeB: 0.14, armF: -0.1, elbowF: 2.2, weaponAngle: 3.9, armB: 2.0, elbowB: 1.6, tilt: -0.1, squash: k * 0.2, capeSway: k * 0.8 });
    case "move": {
      // a low, fast scramble
      const { s } = cycle(f);
      return P({ ...stride(f, { stride: 0.9, lift: 1.2, bob: 1.2, base: 0.4, squash: 0.15 }), lean: 0.44, armF: 0.6 + s * 0.15, elbowF: 0.6, weaponAngle: 1.8, armB: -0.6 - s * 0.4, elbowB: 0.6, capeSway: -3 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // the snap shot from a crouch: 0 bow up level · 1 draw · 2 drawn (still) · 3 IMPACT: release · 4 a hop back · 5 crouch
      return P({
        ...skirmCrouch,
        armF: at([1.25, 1.4, 1.42, 1.42, 1.2, 0.8], f), elbowF: at([0.2, 0.05, 0, 0, 0.2, 0.5], f), weaponAngle: at([1.95, 1.75, 1.72, 1.72, 1.85, 1.8], f),
        draw: at([0.2, 0.7, 1, 0, 0, 0.2], f), armB: at([1.3, 1.9, 2.15, 1.5, 1.0, 0.7], f), elbowB: at([-0.3, -1.2, -1.7, -0.5, 0.3, 0.8], f),
        lean: at([0.32, 0.28, 0.26, 0.2, 0.1, 0.3], f), ox: at([0, -0.4, -0.6, -1.4, -2.6, -0.6], f), oy: at([0, 0, 0, 0, -1.4, 0], f),
        eyes: at(E("focus", "focus", "focus", "open", "open", "focus"), f), mouth: at(M("rest", "rest", "rest", "open", "rest", "rest"), f),
        capeSway: at([0, 0, 0, 3, 2.4, 0.5], f),
      });
    case "skill":
      // the leaping shot: crouch · LEAP · drawn in the air · IMPACT: release at the top · fall · land in a crouch
      return P({
        armF: at([0.9, 1.5, 1.55, 1.55, 1.2, 0.75], f), elbowF: at([0.4, 0.05, 0, 0, 0.3, 0.5], f), weaponAngle: at([1.8, 1.6, 1.45, 1.45, 1.7, 1.75], f),
        draw: at([0.2, 0.7, 1, 0, 0, 0.3], f), armB: at([0.6, 1.9, 2.2, 1.4, 0.6, 0.6], f), elbowB: at([0.8, -1.2, -1.8, -0.4, 0.4, 0.8], f),
        oy: at([0, -4.0, -6.0, -6.0, -2.4, 0], f), lean: at([0.4, 0.1, -0.05, -0.1, 0.15, 0.3], f), ox: at([0, 0.6, 1.0, 0.6, 0.2, 0], f),
        legF: at([0.5, 0.8, 0.9, 0.9, 0.6, 0.48], f), legB: at([-0.42, 0.3, 0.2, 0.2, -0.2, -0.42], f), kneeF: at([0.9, 1.4, 1.5, 1.5, 0.9, 0.75], f), kneeB: at([0.9, 1.6, 1.7, 1.7, 1.0, 0.8], f),
        eyes: at(E("focus", "focus", "focus", "open", "open", "focus"), f), mouth: at(M("rest", "rest", "rest", "shout", "open", "rest"), f),
        capeSway: at([0, 2, 1, 3, 1, 0.5], f), glow: at([0.2, 0.5, 0.9, 1, 0.5, 0.1], f),
      });
    case "hit":
      return at([
        P({ ...skirmCrouch, lean: -0.1, tilt: -0.16, ox: -2.8, oy: -0.8, armF: 0.5, elbowF: 0.6, weaponAngle: 2.0, armB: -0.4, eyes: "hurt", mouth: "hurt", capeSway: 3 }),
        P({ ...skirmCrouch, lean: 0.12, ox: -2.0, armF: 0.6, elbowF: 0.5, weaponAngle: 1.85, armB: 0.2, eyes: "hurt", mouth: "hurt", capeSway: 1.8 }),
        P({ ...skirmCrouch, ox: -0.6, armF: 0.75, elbowF: 0.5, weaponAngle: 1.75, armB: 0.6, elbowB: 0.8, capeSway: 0.6 }),
      ], f);
    case "ko":
      return koBack(f);
    case "victory":
      return P({
        armF: at([2.6, 2.8, 2.6, 2.7], f), elbowF: at([0.3, 0.1, 0.3, 0.2], f), weaponAngle: at([3.0, 3.2, 3.0, 3.1], f), armB: at([-0.4, -0.3, -0.4, -0.3], f), elbowB: 1.4,
        legF: 0.28, legB: -0.26, kneeF: at([0.2, 0.05, 0.2, 0.1], f), kneeB: at([0.2, 0.05, 0.2, 0.1], f), oy: at([0, -2.4, 0, -1.4], f), eyes: "cheer", mouth: "open", capeSway: at([0, 2, 1, 2], f),
      });
  }
}

// =============================================================================== MAGE
// BATTLEMAGE — the staff held ACROSS the body in both hands like a quarterstaff, leaning into every cast.

const battleGuard = { armF: 0.75, elbowF: 0.9, weaponAngle: 2.45, gripB: 7, twist: 0.7 };

function mageBattle(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the staff angled across the chest in both hands, the head forward and up, the feet set
      return P({ ...battleGuard, lean: 0.1, squash: k * 0.3, legF: 0.4, legB: -0.36, kneeF: 0.24, kneeB: 0.28, weaponAngle: 2.45 - k * 0.05, glow: 0.15 + k * 0.15, capeSway: k * 0.8 });
    case "idle2":
      // the low guard: the staff held level at the waist in both hands like a quarterstaff, its head toward the foe, knees bent
      return P({ lean: 0.14, squash: k * 0.3, legF: 0.46, legB: -0.42, kneeF: 0.36, kneeB: 0.4, armF: 0.55, elbowF: 0.75, weaponAngle: 1.72 + k * 0.04, gripB: 7, twist: 0.75, glow: 0.12 + k * 0.12, capeSway: k * 0.8 });
    case "move": {
      const { s } = cycle(f);
      return P({ ...battleGuard, ...stride(f, { stride: 0.62, lift: 0.85, bob: 1.0, base: 0.14, squash: 0.25 }), lean: 0.2, weaponAngle: 2.45 + s * 0.08, glow: 0.12, capeSway: -2.4 + s });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the staff drawn back at the hip · 1 the step · 2 IMPACT: the staff head DRIVEN at the target in both hands, the body behind it · 3 hold ·
      // 4-5 back to guard
      return P({
        armF: at([0.2, 0.8, 1.45, 1.4, 1.0, 0.75], f), elbowF: at([1.2, 0.8, 0.12, 0.15, 0.6, 0.9], f), weaponAngle: at([2.3, 2.0, 1.7, 1.72, 2.1, 2.45], f),
        gripB: at([7, 6, 5, 5, 6, 7], f), twist: at([0.2, 0.6, 0.95, 0.9, 0.75, 0.7], f),
        lean: at([-0.06, 0.18, 0.42, 0.4, 0.22, 0.1], f), ox: at([-1.2, 0.8, 3.6, 3.4, 1.6, 0.2], f), glow: at([0.3, 0.6, 1, 0.8, 0.4, 0.15], f),
        legF: at([0.3, 0.55, 0.75, 0.72, 0.5, 0.4], f), legB: at([-0.3, -0.45, -0.6, -0.58, -0.42, -0.36], f),
        kneeF: at([0.24, 0.3, 0.5, 0.48, 0.3, 0.24], f), kneeB: at([0.28, 0.2, 0.1, 0.1, 0.2, 0.28], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f),
        capeSway: at([1, -1.4, -4, -3.4, -1.4, 0], f),
      });
    case "skill":
      // the staff swung up overhead in both hands · held, charging · IMPACT: slammed down, the head into the ground before the feet · settle
      return P({
        armF: at([1.0, 2.6, 2.7, 1.4, 1.2, 0.75], f), elbowF: at([0.8, 0.4, 0.3, 0.2, 0.4, 0.9], f), weaponAngle: at([2.6, 3.5, 3.6, 1.2, 1.3, 2.45], f),
        gripB: at([7, 6, 6, 5, 5.5, 7], f), twist: at([0.6, 0.7, 0.7, 0.95, 0.9, 0.7], f),
        lean: at([0.0, -0.18, -0.24, 0.5, 0.4, 0.1], f), oy: at([0, -1.2, -1.8, 0, 0, 0], f), ox: at([-0.4, -0.6, -0.8, 2.6, 2.0, 0.2], f),
        legF: at([0.4, 0.3, 0.3, 0.7, 0.55, 0.4], f), legB: at([-0.36, -0.28, -0.28, -0.55, -0.45, -0.36], f),
        kneeF: at([0.3, 0.2, 0.2, 0.7, 0.5, 0.24], f), kneeB: at([0.3, 0.2, 0.2, 0.6, 0.45, 0.28], f), squash: at([0.2, 0, 0, 0.7, 0.4, 0], f),
        mouth: at(M("rest", "open", "open", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([0, 1.6, 2.6, -3.6, -2, 0], f), glow: at([0.3, 0.7, 0.95, 1, 0.6, 0.2], f),
      });
    case "hit":
      return at([
        P({ ...battleGuard, lean: -0.3, tilt: -0.14, ox: -2.4, legF: 0.4, legB: -0.3, kneeF: 0.2, kneeB: 0.44, eyes: "hurt", mouth: "hurt", capeSway: 3.2, squash: 0.5 }),
        P({ ...battleGuard, lean: -0.16, ox: -1.7, legF: 0.4, legB: -0.34, kneeF: 0.22, kneeB: 0.34, eyes: "hurt", mouth: "hurt", capeSway: 2 }),
        P({ ...battleGuard, lean: 0.04, ox: -0.5, legF: 0.4, legB: -0.36, kneeF: 0.24, kneeB: 0.28, capeSway: 0.8 }),
      ], f);
    case "ko":
      return koKneel(f, { gripB: undefined });
    case "victory":
      // the staff thrust high overhead in both hands, the head blazing
      return P({
        armF: at([2.6, 2.8, 2.7, 2.6], f), elbowF: at([0.3, 0.15, 0.2, 0.3], f), weaponAngle: at([3.3, 3.4, 3.35, 3.3], f), gripB: 6, twist: 0.7,
        legF: 0.36, legB: -0.34, kneeF: 0.12, kneeB: 0.16, oy: at([0, -0.8, -1.2, -0.5], f), lean: -0.04, glow: at([0.6, 1, 0.8, 0.6], f), eyes: "cheer", mouth: "open", capeSway: at([0, 2, 3, 1], f),
      });
  }
}

// SAGE — the elder: HUNCHED, leaning on a tall staff planted ahead, the other hand behind the back; slow and deliberate.

const sageBend = { lean: 0.52, tilt: -0.62, legF: 0.26, legB: -0.22, kneeF: 0.38, kneeB: 0.42 };
const sageStaff = { armF: 0.8, elbowF: 0.9, weaponAngle: 3.04, handBAt: [-5.6, -5.0] as const };

function mageSage(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // bent over the staff, the chin thrust forward, the free hand resting at the small of the back
      return P({ ...sageBend, ...sageStaff, squash: k * 0.3, tilt: -0.42 - k * 0.04, glow: 0.1 + k * 0.1, capeSway: k * 0.5 });
    case "idle2":
      // peering up from under the hat, the free hand raised with a spark dancing over the palm
      return P({ ...sageBend, ...sageStaff, handBAt: undefined, armB: 1.5, elbowB: 1.2, squash: k * 0.3, glow: 0.3 + k * 0.2, capeSway: k * 0.5 });
    case "move": {
      // the shuffle: tiny steps, the staff swinging ahead with every other step, almost no bob
      const { s } = cycle(f);
      return P({ ...sageBend, ...sageStaff, ...stride(f, { stride: 0.3, lift: 0.4, bob: 0.2, base: 0.38, squash: 0.15 }), lean: 0.56, armF: 0.8 + s * 0.15, weaponAngle: 3.04 - s * 0.08, glow: 0.1, capeSway: -1.4 + s * 0.5 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the staff lifted off the ground · 1 drawn back · 2 IMPACT: thrust out at arm's length, the head flaring · 3 hold · 4-5 planted again
      return P({
        ...sageBend,
        armF: at([1.2, 0.8, 1.6, 1.55, 1.2, 1.0], f), elbowF: at([0.9, 1.3, 0.1, 0.15, 0.7, 0.95], f), weaponAngle: at([3.0, 2.7, 1.9, 1.95, 2.6, 3.06], f),
        handBAt: [-5.6, -5.0], lean: at([0.5, 0.42, 0.6, 0.58, 0.54, 0.52], f), tilt: at([-0.6, -0.55, -0.7, -0.68, -0.64, -0.62], f), ox: at([-0.2, -0.6, 0.6, 0.5, 0.2, 0], f),
        glow: at([0.3, 0.6, 1.0, 0.8, 0.4, 0.15], f), legF: at([0.26, 0.28, 0.4, 0.38, 0.3, 0.26], f), legB: at([-0.22, -0.24, -0.3, -0.3, -0.25, -0.22], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f),
        capeSway: at([0.6, 0.4, -2.6, -2.2, -1, 0], f),
      });
    case "skill":
      // the old power: the back STRAIGHTENS, both arms up, rising off the ground · IMPACT: the staff brought down, the body hunching again
      return P({
        armF: at([1.2, 2.2, 2.5, 1.4, 1.2, 1.0], f), elbowF: at([0.8, 0.5, 0.35, 0.2, 0.6, 0.95], f), weaponAngle: at([3.0, 3.3, 3.4, 2.0, 2.6, 3.06], f),
        armB: at([0.6, 2.2, 2.5, 1.2, 0.6, 0.4], f), elbowB: at([1.2, 0.5, 0.3, 0.6, 1.0, 1.4], f),
        lean: at([0.5, -0.05, -0.12, 0.55, 0.54, 0.52], f), tilt: at([-0.62, -0.2, -0.15, -0.6, -0.64, -0.62], f), oy: at([0, -1.8, -2.8, -0.6, 0, 0], f),
        legF: at([0.22, 0.05, 0.0, 0.3, 0.24, 0.22], f), legB: at([-0.2, 0.05, 0.08, -0.25, -0.22, -0.2], f), kneeF: at([0.28, 0.3, 0.35, 0.3, 0.28, 0.28], f), kneeB: at([0.32, 0.4, 0.45, 0.3, 0.32, 0.32], f),
        glow: at([0.3, 0.7, 0.95, 1, 0.6, 0.2], f), mouth: at(M("rest", "open", "open", "shout", "open", "rest"), f), eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f),
        capeSway: at([0, 1.4, 2.4, -2.6, -1.2, 0], f),
      });
    case "hit":
      return at([
        P({ ...sageBend, ...sageStaff, lean: 0.1, tilt: -0.6, ox: -2.0, kneeF: 0.4, kneeB: 0.5, eyes: "hurt", mouth: "hurt", capeSway: 2.4, squash: 0.4 }),
        P({ ...sageBend, ...sageStaff, lean: 0.22, tilt: -0.5, ox: -1.4, eyes: "hurt", mouth: "hurt", capeSway: 1.4 }),
        P({ ...sageBend, ...sageStaff, ox: -0.4, capeSway: 0.5 }),
      ], f);
    case "ko":
      return koKneel(f, { handBAt: undefined });
    case "victory":
      // a satisfied nod, the staff tapped on the ground, a spark over the head
      return P({ ...sageBend, ...sageStaff, tilt: at([-0.62, -0.35, -0.62, -0.5], f), weaponAngle: at([3.04, 3.0, 3.04, 3.02], f), oy: at([0, -0.6, 0, -0.3], f), glow: at([0.5, 1, 0.6, 0.8], f), eyes: "cheer", mouth: "open", capeSway: at([0, 0.8, 0.3, 0.6], f) });
  }
}

// =============================================================================== CLERIC
// TEMPLAR — the crusader: broad and upright, a heavy holy mace carried on the shoulder, an overhead SMITE.

// the mace rests on the shoulder BEHIND the head (the face and the halo stay clear)
const templarRest = { armF: 0.25, elbowF: 1.75, weaponAngle: 4.25, armB: 0.2, elbowB: 0.5 };

function clericTemplar(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the holy mace on the shoulder, the other fist closed at the side, chest out
      return P({ ...templarRest, lean: -0.04, squash: k * 0.4, legF: 0.3, legB: -0.28, kneeF: 0.08, kneeB: 0.12, weaponAngle: 4.25 + k * 0.04, glow: 0.1 + k * 0.1, capeSway: k * 0.6 });
    case "idle2":
      // the mace head grounded before the feet, both hands folded on its pommel — a vigil
      return P({ lean: 0.0, squash: k * 0.4, legF: 0.26, legB: -0.26, kneeF: 0.06, kneeB: 0.08, armF: 0.85, elbowF: 0.55, weaponAngle: 0.62, gripB: -2.2, twist: 0.6, tilt: 0.12, glow: 0.15 + k * 0.12, capeSway: k * 0.6 });
    case "move": {
      const { s } = cycle(f);
      return P({ ...templarRest, ...stride(f, { stride: 0.55, lift: 0.7, bob: 0.5, base: 0.1, squash: 0.35 }), lean: 0.1, armB: 0.2 + s * 0.4, weaponAngle: 4.25 + s * 0.05, capeSway: -1.8 + s * 0.7 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // SMITE: 0 the mace raised high, the eyes up · 1 the step · 2 IMPACT: brought down hard at the target, light bursting · 3 hold · 4-5 back
      return P({
        armF: at([2.7, 2.4, 1.35, 1.3, 0.8, 0.25], f), elbowF: at([0.5, 0.35, 0.1, 0.12, 0.9, 1.75], f), weaponAngle: at([4.2, 3.3, 0.9, 0.86, 2.6, 4.25], f),
        armB: at([0.4, 0.6, 0.9, 0.85, 0.5, 0.2], f), elbowB: at([1.4, 1.2, 0.8, 0.8, 0.8, 0.5], f), twist: at([-0.3, 0.1, 0.55, 0.5, 0.2, 0], f),
        lean: at([-0.18, 0.05, 0.36, 0.34, 0.14, -0.04], f), tilt: at([-0.14, 0, 0.06, 0.05, 0, 0], f), ox: at([-0.8, 0.6, 0.9, 0.8, 0.6, 0.2], f), glow: at([0.4, 0.7, 1, 0.8, 0.4, 0.1], f),
        legF: at([0.24, 0.45, 0.6, 0.58, 0.4, 0.3], f), legB: at([-0.26, -0.36, -0.44, -0.42, -0.32, -0.28], f),
        kneeF: at([0.08, 0.2, 0.36, 0.34, 0.2, 0.08], f), kneeB: at([0.12, 0.1, 0.08, 0.08, 0.1, 0.12], f), squash: at([0, 0, 0.4, 0.3, 0.1, 0], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f), capeSway: at([1, -1, -3, -2.4, -1, 0], f),
      });
    case "skill":
      // the consecration: the mace held up by the head like a holy sign · lifted · IMPACT: planted, a wave of light · hold · back
      return P({
        armF: at([1.2, 2.0, 2.4, 1.0, 0.9, 0.25], f), elbowF: at([1.2, 0.8, 0.5, 0.5, 0.8, 1.75], f), weaponAngle: at([2.8, 2.75, 2.7, 0.62, 0.66, 4.25], f),
        armB: at([0.8, 1.8, 2.3, 1.6, 1.2, 0.2], f), elbowB: at([1.2, 0.6, 0.4, 0.4, 0.6, 0.5], f), tilt: at([0.1, -0.1, -0.2, 0.15, 0.1, 0], f),
        lean: at([0.0, -0.06, -0.1, 0.3, 0.2, -0.04], f), oy: at([0, -0.4, -0.8, 0, 0, 0], f), ox: at([0, 0, 0, 1.4, 1.0, 0.2], f), glow: at([0.3, 0.6, 0.85, 1, 0.7, 0.2], f),
        legF: at([0.3, 0.3, 0.3, 0.55, 0.45, 0.3], f), legB: at([-0.28, -0.28, -0.28, -0.4, -0.34, -0.28], f), kneeF: at([0.08, 0.08, 0.08, 0.5, 0.3, 0.08], f), kneeB: at([0.12, 0.12, 0.12, 0.4, 0.25, 0.12], f),
        eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "open", "shout", "open", "rest"), f), capeSway: at([0, 1, 2, -2.4, -1.2, 0], f),
      });
    case "hit":
      return at([
        P({ ...templarRest, lean: -0.24, tilt: -0.1, ox: -1.8, legF: 0.3, legB: -0.24, kneeF: 0.1, kneeB: 0.34, weaponAngle: 4.4, eyes: "hurt", mouth: "hurt", squash: 0.5, capeSway: 2.4 }),
        P({ ...templarRest, lean: -0.14, ox: -1.3, legF: 0.3, legB: -0.26, kneeF: 0.08, kneeB: 0.24, eyes: "hurt", mouth: "hurt", capeSway: 1.4 }),
        P({ ...templarRest, lean: -0.04, ox: -0.3, legF: 0.3, legB: -0.28, kneeF: 0.08, kneeB: 0.12, capeSway: 0.5 }),
      ], f);
    case "ko":
      return koForward(f, { weaponAngle: at([1.8, 0.9, 1.6, 3.05, 3.0, 3.1], f) });
    case "victory":
      return P({
        armF: at([2.3, 2.45, 2.35, 2.25], f), elbowF: at([0.2, 0.1, 0.15, 0.2], f), weaponAngle: at([2.55, 2.65, 2.6, 2.55], f), armB: at([1.6, 1.8, 1.7, 1.6], f), elbowB: 0.6,
        legF: 0.3, legB: -0.28, kneeF: 0.08, kneeB: 0.12, lean: -0.06, tilt: -0.12, oy: at([0, -0.5, -0.8, -0.3], f), glow: at([0.6, 1, 0.8, 0.6], f), eyes: "cheer", mouth: "open", capeSway: at([0, 1.5, 2.5, 1], f),
      });
  }
}

// MONK — the pilgrim: slight, a tall sun-staff grounded at the side, the other hand raised in prayer; a kneeling blessing.

const monkRest = { armF: 0.55, elbowF: 1.1, weaponAngle: 3.12, handBAt: [3.4, -10.6] as const };

function clericMonk(clip: Clip, f: number): Pose {
  const k = breath(f);
  switch (clip) {
    case "idle":
      // the tall staff grounded beside the front foot, the free hand raised before the chest in prayer, the head bowed a little
      return P({ ...monkRest, lean: 0.02, tilt: 0.1 + k * 0.03, squash: k * 0.3, legF: 0.14, legB: -0.14, kneeF: 0.04, kneeB: 0.06, glow: 0.1 + k * 0.12, capeSway: k * 0.6 });
    case "idle2":
      // the staff held out at arm's length, its sun lifted high, the face raised to it
      return P({ armF: 1.4, elbowF: 0.5, weaponAngle: 2.9, handBAt: [3.4, -10.6], lean: -0.06, tilt: -0.16, squash: k * 0.3, legF: 0.2, legB: -0.2, kneeF: 0.05, kneeB: 0.08, glow: 0.2 + k * 0.15, capeSway: k * 0.6 });
    case "move": {
      // the pilgrim's walk: a steady stride, the staff planted with each step
      const { s } = cycle(f);
      return P({ ...monkRest, ...stride(f, { stride: 0.5, lift: 0.6, bob: 0.5, base: 0.08, squash: 0.2 }), lean: 0.08, armF: 0.45 + s * 0.2, weaponAngle: 3.1 - s * 0.12, capeSway: -1.6 + s * 0.6 });
    }
    case "attack_slash":
    case "attack_thrust":
    case "attack_shoot":
      // 0 the staff swung back · 1 brought round · 2 IMPACT: the sun-head pointed at the target, a beam · 3 hold · 4-5 grounded again
      return P({
        armF: at([0.1, 0.9, 1.5, 1.45, 0.9, 0.35], f), elbowF: at([1.2, 0.8, 0.1, 0.12, 0.6, 0.75], f), weaponAngle: at([3.5, 2.6, 1.75, 1.78, 2.6, 3.1], f),
        handBAt: [3.4, -10.6], twist: at([-0.3, 0.2, 0.5, 0.45, 0.2, 0], f), lean: at([-0.1, 0.1, 0.24, 0.22, 0.1, 0.02], f), ox: at([-0.6, 0.4, 1.0, 0.9, 0.4, 0], f),
        glow: at([0.3, 0.6, 1, 0.8, 0.4, 0.1], f), legF: at([0.14, 0.3, 0.45, 0.42, 0.28, 0.14], f), legB: at([-0.14, -0.24, -0.34, -0.32, -0.22, -0.14], f),
        kneeF: at([0.04, 0.12, 0.22, 0.2, 0.1, 0.04], f), kneeB: at([0.06, 0.06, 0.06, 0.06, 0.06, 0.06], f),
        eyes: at(E("focus", "focus", "open", "open", "open", "open"), f), mouth: at(M("rest", "open", "shout", "open", "rest", "rest"), f), capeSway: at([0.6, -0.8, -2.4, -2, -0.8, 0], f),
      });
    case "skill":
      // the blessing: down on one knee, both hands on the staff · head bowed · IMPACT: the face lifts, the light rises · hold · stand
      return P({
        armF: at([0.6, 0.9, 0.95, 1.2, 1.1, 0.35], f), elbowF: at([0.9, 0.7, 0.7, 0.5, 0.6, 0.75], f), weaponAngle: at([3.1, 3.12, 3.12, 3.0, 3.05, 3.1], f),
        handBAt: [at([3.4, 6, 6, 4, 4, 3.4], f), at([-10.6, -9, -9, -12, -11, -10.6], f)], tilt: at([0.1, 0.3, 0.32, -0.2, -0.1, 0.1], f),
        legF: at([0.2, 1.1, 1.15, 1.15, 1.0, 0.14], f), kneeF: at([0.1, 1.25, 1.3, 1.3, 1.1, 0.04], f), legB: at([-0.2, 0.55, 0.6, 0.6, 0.5, -0.14], f), kneeB: at([0.1, 2.1, 2.2, 2.2, 1.9, 0.06], f),
        lean: at([0.02, 0.1, 0.12, -0.04, 0, 0.02], f), glow: at([0.2, 0.5, 0.8, 1, 0.7, 0.2], f),
        eyes: at(E("focus", "focus", "focus", "open", "open", "open"), f), mouth: at(M("rest", "rest", "rest", "open", "open", "rest"), f), capeSway: at([0, 0.5, 1, 2, 1.2, 0], f),
      });
    case "hit":
      return at([
        P({ ...monkRest, lean: -0.3, tilt: -0.12, ox: -2.0, legF: 0.2, legB: -0.1, kneeB: 0.3, weaponAngle: 3.3, eyes: "hurt", mouth: "hurt", capeSway: 2.6, squash: 0.4 }),
        P({ ...monkRest, lean: -0.18, ox: -1.4, legF: 0.16, legB: -0.12, kneeB: 0.2, weaponAngle: 3.2, eyes: "hurt", mouth: "hurt", capeSway: 1.6 }),
        P({ ...monkRest, lean: -0.02, ox: -0.4, legF: 0.14, legB: -0.14, kneeF: 0.04, kneeB: 0.06, capeSway: 0.6 }),
      ], f);
    case "ko":
      return koKneel(f, { handBAt: undefined });
    case "victory":
      return P({
        armF: at([2.1, 2.3, 2.2, 2.1], f), elbowF: at([0.4, 0.3, 0.35, 0.4], f), weaponAngle: at([2.75, 2.85, 2.8, 2.75], f), handBAt: [3.4, -10.6],
        legF: 0.14, legB: -0.14, kneeF: 0.04, kneeB: 0.06, tilt: -0.14, oy: at([0, -0.5, -0.8, -0.3], f), glow: at([0.6, 1, 0.8, 0.6], f), eyes: "cheer", mouth: "open", capeSway: at([0, 1, 1.8, 0.8], f),
      });
  }
}

export const ARCHETYPE_POSES = {
  "warrior-brute": warriorBrute,
  "warrior-duelist": warriorDuelist,
  "tank-juggernaut": tankJuggernaut,
  "tank-sentinel": tankSentinel,
  "rogue-assassin": rogueAssassin,
  "rogue-brawler": rogueBrawler,
  "ranger-warden": rangerWarden,
  "ranger-skirmisher": rangerSkirmisher,
  "mage-battle": mageBattle,
  "mage-sage": mageSage,
  "cleric-templar": clericTemplar,
  "cleric-monk": clericMonk,
} as const satisfies Record<string, (clip: Clip, f: number) => Pose>;
