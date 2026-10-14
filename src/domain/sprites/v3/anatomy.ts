/**
 * HERO RENDERER v3 — ANATOMY: one coherent body plan per archetype.
 *
 * Every measurement a body needs is here, in frame pixels (1 unit = 1 sprite pixel), and everything else derives from it: the skeleton's rest
 * pose (rig.ts), the volumes the body is built from (body.ts), where armour sits (it wraps these volumes), where the face is (head-local
 * anchors scale with `headR`), how far an arm can reach (IK) and where a weapon is gripped. Nothing is placed by an absolute screen offset.
 *
 * The eighteen archetypes of renderer v2 are kept (same ids, same per-hero choice — see genome.ts), each a real build: the brute is a short,
 * wide two-hander, the duelist long-legged and lean, the juggernaut squat and massive, the sage hunched, the brawler short with a big head …
 * Heights differ (41–49 px), so a squad of one class does not share one silhouette.
 */

export type ClassRig = "warrior" | "tank" | "rogue" | "ranger" | "mage" | "cleric";
export type ArchetypeId =
  | ClassRig
  | "warrior-brute" | "warrior-duelist"
  | "tank-juggernaut" | "tank-sentinel"
  | "rogue-assassin" | "rogue-brawler"
  | "ranger-warden" | "ranger-skirmisher"
  | "mage-battle" | "mage-sage"
  | "cleric-templar" | "cleric-monk";

export const CLASS_RIG_IDS: readonly ClassRig[] = ["warrior", "tank", "rogue", "ranger", "mage", "cleric"];
/** The archetypes of each class, in renderer v2's order (the per-hero pick indexes into this list — keep the order). */
export const CLASS_ARCHETYPES: Record<ClassRig, readonly ArchetypeId[]> = {
  warrior: ["warrior", "warrior-brute", "warrior-duelist"],
  tank: ["tank", "tank-juggernaut", "tank-sentinel"],
  rogue: ["rogue", "rogue-assassin", "rogue-brawler"],
  ranger: ["ranger", "ranger-warden", "ranger-skirmisher"],
  mage: ["mage", "mage-battle", "mage-sage"],
  cleric: ["cleric", "cleric-templar", "cleric-monk"],
};
export const ARCHETYPE_IDS: readonly ArchetypeId[] = CLASS_RIG_IDS.flatMap((c) => CLASS_ARCHETYPES[c]);
export const ARCHETYPE_CLASS = Object.fromEntries(CLASS_RIG_IDS.flatMap((c) => CLASS_ARCHETYPES[c].map((a) => [a, c]))) as Record<ArchetypeId, ClassRig>;

export interface BodyPlan {
  id: ArchetypeId;
  cls: ClassRig;
  /** Ankle joint height above the floor. */
  ankle: number;
  thigh: number;
  shin: number;
  /** Pelvis centre above the hip joints. */
  pelvisUp: number;
  /** Spine: pelvis centre → chest centre → neck base. */
  chestUp: number;
  neckUp: number;
  /** Neck length (neck base → head pivot) and the cranium radius (faces, hair and headgear scale with it). */
  neck: number;
  headR: number;
  /** Half-widths (lateral, Z) and half-depths (X). */
  shoulderHalf: number;
  hipHalf: number;
  chest: { w: number; d: number; h: number };
  waist: { w: number; d: number };
  pelvis: { w: number; d: number; h: number };
  /** A belly (juggernaut, sage): extra forward depth of the abdomen. */
  belly: number;
  upperArm: number;
  forearm: number;
  /** Limb radii: shoulder → elbow → wrist, hip → knee → ankle. */
  armR: readonly [number, number, number];
  legR: readonly [number, number, number];
  handR: number;
  foot: { heel: number; toe: number; h: number; w: number };
  neckR: number;
  /** Resting forward bend of the upper spine (radians) — the sage's hunch. */
  hunch: number;
  /** Half the lateral distance between the feet at rest. */
  stance: number;
  /** Weapon proportions of the archetype: length and width multipliers. */
  weapon: { len: number; w: number };
}

const BASE: Omit<BodyPlan, "id" | "cls"> = {
  ankle: 1.6,
  thigh: 8.4,
  shin: 8.2,
  pelvisUp: 1.2,
  chestUp: 8.2,
  neckUp: 12.4,
  neck: 2.1,
  headR: 6.2,
  shoulderHalf: 5.0,
  hipHalf: 2.4,
  chest: { w: 4.6, d: 3.2, h: 4.2 },
  waist: { w: 3.6, d: 2.8 },
  pelvis: { w: 3.9, d: 2.9, h: 2.4 },
  belly: 0,
  upperArm: 6.6,
  forearm: 6.0,
  armR: [1.8, 1.5, 1.25],
  legR: [2.5, 1.9, 1.45],
  handR: 1.45,
  foot: { heel: 1.4, toe: 3.9, h: 1.05, w: 1.4 },
  neckR: 1.55,
  hunch: 0,
  stance: 2.6,
  weapon: { len: 1, w: 1 },
};

type Over = Partial<Omit<BodyPlan, "id" | "cls">> & { limbs?: number };

function plan(id: ArchetypeId, cls: ClassRig, o: Over): BodyPlan {
  const k = o.limbs ?? 1;
  const p: BodyPlan = { ...BASE, id, cls, ...o };
  // heroic proportions: a little more leg, a little less head than the first draft (≈ 3.6 heads tall)
  p.thigh *= 1.06;
  p.shin *= 1.06;
  p.headR *= 0.955 * 1.07;
  p.neckUp -= 0.35;
  // mass: a battler reads by its bulk — chest, waist and hips broader, limbs, hands and feet a size up
  p.chest = { w: p.chest.w * 1.1, d: p.chest.d * 1.06, h: p.chest.h };
  p.waist = { w: p.waist.w * 1.08, d: p.waist.d * 1.04 };
  p.pelvis = { w: p.pelvis.w * 1.08, d: p.pelvis.d * 1.04, h: p.pelvis.h };
  p.shoulderHalf *= 1.06;
  p.armR = [p.armR[0] * 1.1, p.armR[1] * 1.1, p.armR[2] * 1.08];
  p.legR = [p.legR[0] * 1.08, p.legR[1] * 1.08, p.legR[2] * 1.06];
  p.handR *= 1.08;
  p.foot = { ...p.foot, w: p.foot.w * 1.06, h: p.foot.h * 1.06 };
  if (o.limbs !== undefined) {
    if (!o.armR) p.armR = [BASE.armR[0] * k, BASE.armR[1] * k, BASE.armR[2] * k];
    if (!o.legR) p.legR = [BASE.legR[0] * k, BASE.legR[1] * k, BASE.legR[2] * k];
    if (!o.handR) p.handR = BASE.handR * Math.sqrt(k);
    if (!o.neckR) p.neckR = BASE.neckR * k;
    if (!o.foot) p.foot = { ...BASE.foot, w: BASE.foot.w * Math.sqrt(k), h: BASE.foot.h * Math.sqrt(k) };
  }
  return p;
}

export const BODY_PLANS: Record<ArchetypeId, BodyPlan> = {
  // ---------------------------------------------------------------- Warrior
  warrior: plan("warrior", "warrior", { shoulderHalf: 5.4, chest: { w: 5.0, d: 3.4, h: 4.3 }, waist: { w: 3.8, d: 2.9 }, limbs: 1.1, stance: 2.8 }),
  "warrior-brute": plan("warrior-brute", "warrior", {
    thigh: 7.6, shin: 7.2, chestUp: 8.4, neckUp: 12.6, neck: 1.6, headR: 5.8, shoulderHalf: 6.6, hipHalf: 2.9,
    chest: { w: 6.0, d: 4.0, h: 4.7 }, waist: { w: 4.6, d: 3.4 }, pelvis: { w: 4.5, d: 3.3, h: 2.6 }, limbs: 1.38, stance: 3.4,
    upperArm: 6.8, forearm: 6.2, weapon: { len: 1.4, w: 1.3 },
  }),
  "warrior-duelist": plan("warrior-duelist", "warrior", {
    thigh: 9.3, shin: 9.1, chestUp: 8.4, neckUp: 12.8, headR: 5.9, shoulderHalf: 4.5, chest: { w: 4.1, d: 2.9, h: 4.2 },
    waist: { w: 3.1, d: 2.5 }, pelvis: { w: 3.5, d: 2.6, h: 2.3 }, limbs: 0.9, upperArm: 7.0, forearm: 6.5, stance: 2.6, weapon: { len: 1.08, w: 0.82 },
  }),
  // ---------------------------------------------------------------- Tank
  tank: plan("tank", "tank", {
    thigh: 7.8, shin: 7.5, headR: 6.0, shoulderHalf: 6.0, hipHalf: 2.8, chest: { w: 5.7, d: 3.9, h: 4.6 }, waist: { w: 4.6, d: 3.4 },
    pelvis: { w: 4.4, d: 3.2, h: 2.6 }, limbs: 1.3, stance: 3.2,
  }),
  "tank-juggernaut": plan("tank-juggernaut", "tank", {
    thigh: 7.0, shin: 6.6, chestUp: 8.0, neckUp: 12.2, neck: 1.4, headR: 5.6, shoulderHalf: 7.0, hipHalf: 3.2,
    chest: { w: 6.6, d: 4.5, h: 5.0 }, waist: { w: 5.6, d: 4.4 }, pelvis: { w: 5.0, d: 3.8, h: 2.8 }, belly: 1.2, limbs: 1.5, stance: 3.6,
    upperArm: 6.2, forearm: 5.8, weapon: { len: 1.12, w: 1.25 },
  }),
  "tank-sentinel": plan("tank-sentinel", "tank", {
    thigh: 9.1, shin: 8.9, chestUp: 8.6, neckUp: 13.0, headR: 5.8, shoulderHalf: 5.7, hipHalf: 2.7, chest: { w: 5.3, d: 3.6, h: 4.6 },
    waist: { w: 4.1, d: 3.1 }, limbs: 1.2, upperArm: 7.0, forearm: 6.5, stance: 3.0, weapon: { len: 1.4, w: 1.05 },
  }),
  // ---------------------------------------------------------------- Rogue
  rogue: plan("rogue", "rogue", {
    thigh: 8.7, shin: 8.5, headR: 6.1, shoulderHalf: 4.5, chest: { w: 4.1, d: 2.9, h: 4.0 }, waist: { w: 3.1, d: 2.5 },
    pelvis: { w: 3.5, d: 2.6, h: 2.3 }, limbs: 0.92, stance: 3.0,
  }),
  "rogue-assassin": plan("rogue-assassin", "rogue", {
    thigh: 9.7, shin: 9.5, chestUp: 8.6, neckUp: 13.0, headR: 5.7, shoulderHalf: 4.2, hipHalf: 2.1, chest: { w: 3.8, d: 2.7, h: 4.1 },
    waist: { w: 2.8, d: 2.3 }, pelvis: { w: 3.2, d: 2.4, h: 2.2 }, limbs: 0.8, upperArm: 7.2, forearm: 6.8, stance: 2.6, weapon: { len: 1.35, w: 0.9 },
  }),
  "rogue-brawler": plan("rogue-brawler", "rogue", {
    thigh: 6.8, shin: 6.4, chestUp: 7.4, neckUp: 11.2, neck: 1.6, headR: 6.6, shoulderHalf: 5.8, hipHalf: 2.8,
    chest: { w: 5.4, d: 3.7, h: 4.2 }, waist: { w: 4.3, d: 3.2 }, pelvis: { w: 4.2, d: 3.1, h: 2.5 }, limbs: 1.3, upperArm: 5.8, forearm: 5.4,
    stance: 3.2, weapon: { len: 0.95, w: 1.4 },
  }),
  // ---------------------------------------------------------------- Ranger
  ranger: plan("ranger", "ranger", {
    thigh: 8.6, shin: 8.4, headR: 6.1, shoulderHalf: 4.8, chest: { w: 4.4, d: 3.0, h: 4.1 }, waist: { w: 3.3, d: 2.6 }, limbs: 0.98, stance: 2.8,
  }),
  "ranger-warden": plan("ranger-warden", "ranger", {
    thigh: 9.1, shin: 8.9, chestUp: 8.6, neckUp: 12.9, headR: 5.9, shoulderHalf: 5.5, hipHalf: 2.6, chest: { w: 5.1, d: 3.4, h: 4.4 },
    waist: { w: 3.9, d: 2.9 }, limbs: 1.15, upperArm: 7.0, forearm: 6.4, stance: 3.2, weapon: { len: 1.38, w: 1.1 },
  }),
  "ranger-skirmisher": plan("ranger-skirmisher", "ranger", {
    thigh: 7.1, shin: 6.9, chestUp: 7.6, neckUp: 11.4, neck: 1.8, headR: 6.4, shoulderHalf: 4.5, chest: { w: 4.1, d: 2.9, h: 3.9 },
    waist: { w: 3.1, d: 2.5 }, pelvis: { w: 3.5, d: 2.6, h: 2.3 }, limbs: 0.92, upperArm: 5.9, forearm: 5.5, stance: 3.0, weapon: { len: 0.76, w: 1 },
  }),
  // ---------------------------------------------------------------- Mage
  mage: plan("mage", "mage", {
    thigh: 8.6, shin: 8.4, headR: 6.1, shoulderHalf: 4.5, chest: { w: 4.1, d: 2.9, h: 4.1 }, waist: { w: 3.2, d: 2.6 }, limbs: 0.88, stance: 2.2,
  }),
  "mage-battle": plan("mage-battle", "mage", {
    thigh: 8.3, shin: 8.1, headR: 6.0, shoulderHalf: 5.7, hipHalf: 2.7, chest: { w: 5.3, d: 3.6, h: 4.4 }, waist: { w: 4.0, d: 3.0 },
    limbs: 1.18, stance: 2.8, weapon: { len: 0.86, w: 1.1 },
  }),
  "mage-sage": plan("mage-sage", "mage", {
    thigh: 7.2, shin: 6.9, chestUp: 7.6, neckUp: 11.4, headR: 6.3, shoulderHalf: 4.4, chest: { w: 4.3, d: 3.2, h: 4.0 },
    waist: { w: 3.6, d: 3.2 }, belly: 0.6, limbs: 0.86, upperArm: 6.0, forearm: 5.7, hunch: 0.34, stance: 2.3, weapon: { len: 1.16, w: 1 },
  }),
  // ---------------------------------------------------------------- Cleric
  cleric: plan("cleric", "cleric", {
    thigh: 8.3, shin: 8.1, headR: 6.1, shoulderHalf: 4.9, chest: { w: 4.5, d: 3.1, h: 4.2 }, waist: { w: 3.5, d: 2.8 }, limbs: 1.0, stance: 2.4,
  }),
  "cleric-templar": plan("cleric-templar", "cleric", {
    thigh: 8.1, shin: 7.9, headR: 5.9, shoulderHalf: 6.1, hipHalf: 2.8, chest: { w: 5.7, d: 3.8, h: 4.6 }, waist: { w: 4.4, d: 3.3 },
    pelvis: { w: 4.3, d: 3.1, h: 2.5 }, limbs: 1.3, stance: 3.0, weapon: { len: 1.28, w: 1.25 },
  }),
  "cleric-monk": plan("cleric-monk", "cleric", {
    thigh: 8.9, shin: 8.7, chestUp: 8.4, neckUp: 12.7, headR: 5.9, shoulderHalf: 4.4, chest: { w: 4.0, d: 2.8, h: 4.0 },
    waist: { w: 3.0, d: 2.5 }, pelvis: { w: 3.4, d: 2.5, h: 2.3 }, limbs: 0.86, upperArm: 6.8, forearm: 6.3, stance: 2.4, weapon: { len: 1.45, w: 1.05 },
  }),
};

/** Standing hip-joint height (legs a touch soft, never locked straight). */
export const hipHeight = (b: BodyPlan): number => b.ankle + (b.thigh + b.shin) * 0.985;
/** Height of the top of the head standing upright (for tests and the nominal-height check). */
export const standingHeight = (b: BodyPlan): number => hipHeight(b) + b.pelvisUp + b.neckUp + b.neck + b.headR * 0.92 + b.headR;
