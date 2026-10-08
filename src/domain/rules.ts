import { z } from "zod";

import { rulesetCombatSchema, type CombatSettings } from "./settings";
import { hashObject } from "./util/hash";
import { STAT_KEYS, type StatKey } from "./stats";

/**
 * Version of the combat ALGORITHM and its shipped tuning. Bump on any behavioural change to src/domain/combat or to the default
 * combat numbers (a battle stores the ruleset it was simulated with, so older battles keep replaying under their own version).
 *
 *   1.0.0  shrinking storm ring (legacy; replayed only through the engine's isolated legacy path)
 *   2.0.0  static arena, 30 s cap, no `combat.pace` (a stored 2.0.0 ruleset has none and replays with the 1 / 1 default, bit for bit)
 *   3.0.0  longer fights: global `combat.pace` (time × 1.95, movement × 1.1) + modest survivability / damage / overtime retune,
 *          60 s hard cap — measured median ≈ 37 s (see docs/COMBAT.md). Classes and skills are unchanged.
 *   3.1.0  ENGAGEMENT (`combat.engagement`): committed attacks (windup → release → recovery; ranged fighters plant for both and hold
 *          their ground; a wound-up attack keeps its target), ranged spacing discipline (retreat stamina with a reposition cooldown, sliding
 *          along the wall), melee pursuit and engaging from the target's side, telegraphed instant skills. Classes and skills are unchanged.
 */
export const COMBAT_RULES_VERSION = "3.1.0";
/** The rules a combat block describes: 3.1.0 only when it carries `engagement` (a database whose settings predate it keeps fighting — and labelling — 3.0.0). */
export const PRE_ENGAGEMENT_RULES_VERSION = "3.0.0";
export function rulesVersionFor(combat: CombatSettings): string {
  return combat.engagement ? COMBAT_RULES_VERSION : PRE_ENGAGEMENT_RULES_VERSION;
}
/**
 * Rules 1.0.0 had a shrinking storm ring (zone damage + forced movement toward the centre). 2.0.0 removed it for good: the
 * Arena has a STATIC boundary. Battles stored under 1.0.0 are replayed by the engine's isolated legacy path so their
 * stored event hashes keep verifying — it is reachable ONLY through a ruleset whose version is exactly this one.
 */
export const LEGACY_RING_RULES_VERSION = "1.0.0";

export const BEHAVIOR_FEATURES = [
  "replyRatio",
  "questionRatio",
  "exclaimRatio",
  "longRatio",
  "linkRatio",
  "mediaRatio",
  "nightRatio",
  "burstRatio",
] as const;
export type BehaviorFeature = (typeof BEHAVIOR_FEATURES)[number];

const statBlockSchema = z.strictObject(
  Object.fromEntries(STAT_KEYS.map((k) => [k, z.number().min(0).max(100000)])) as Record<StatKey, z.ZodNumber>,
);

const statWeightsSchema = statBlockSchema;

const traitSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("low_hp_damage"), below: z.number().min(0).max(1), bonus: z.number().min(0).max(5) }),
  z.strictObject({ type: z.literal("regen_pct"), perSec: z.number().min(0).max(0.2) }),
  z.strictObject({ type: z.literal("crit_bonus"), amount: z.number().min(0).max(1) }),
  z.strictObject({ type: z.literal("damage_taken_mult"), mult: z.number().min(0.1).max(3) }),
]);

export const LOOK_WEAPONS = ["sword", "staff", "daggers", "bow", "mace", "tome"] as const;
export const LOOK_HEADGEAR = ["helm", "hat", "hood", "cap", "halo", "crown"] as const;
export const LOOK_BODIES = ["heavy", "robe", "light", "medium"] as const;

export const classDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  name: z.string().min(1).max(40),
  tagline: z.string().max(120),
  role: z.string().max(40),
  primaryStat: z.enum(STAT_KEYS),
  base: statBlockSchema,
  /**
   * @deprecated Per-level growth was removed together with permanent levels and is never read.
   * Still accepted so class rows and ruleset snapshots stored before the removal keep validating
   * (old battles must stay replayable).
   */
  growth: statBlockSchema.optional(),
  attack: z.strictObject({
    kind: z.enum(["physical", "magic"]),
    range: z.number().min(10).max(400),
    intervalMs: z.number().int().min(200).max(5000),
    /** Units per second. 0 = instant (melee). */
    projectileSpeed: z.number().min(0).max(2000),
    style: z.enum(["slash", "stab", "arrow", "bolt", "orb"]),
  }),
  moveSpeed: z.number().min(10).max(300),
  skills: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/)).min(0).max(4),
  traits: z.array(traitSchema).max(6),
  ai: z.strictObject({
    /** Distance the unit tries to hold from its target (0 = melee range). */
    preferredRange: z.number().min(0).max(400),
    /** Ranged units back away when an enemy is closer than this (0 = never). */
    kiteBelow: z.number().min(0).max(300),
    targetWeights: z.strictObject({
      distance: z.number().min(-5).max(5),
      lowHp: z.number().min(-5).max(5),
      threat: z.number().min(-5).max(5),
    }),
    classBias: z.record(z.string(), z.number().min(-3).max(3)),
  }),
  /** Subtle class-probability nudges from Telegram behaviour (see character/classRoll). */
  affinity: z.partialRecord(z.enum(BEHAVIOR_FEATURES), z.number().min(-3).max(3)),
  telegramWeights: statWeightsSchema,
  look: z.strictObject({
    weapon: z.enum(LOOK_WEAPONS),
    headgear: z.enum(LOOK_HEADGEAR),
    body: z.enum(LOOK_BODIES),
    colors: z.tuple([z.string(), z.string(), z.string()]),
  }),
});
export type ClassDef = z.infer<typeof classDefSchema>;

const targetShape = z.enum(["target", "aoe_self", "aoe_target", "nearest_n"]);

const effectSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("damage"),
    scale: z.number().min(0).max(20),
    stat: z.enum(["str", "int"]),
    shape: targetShape,
    radius: z.number().min(0).max(400).optional(),
    count: z.number().int().min(1).max(8).optional(),
    stunMs: z.number().int().min(0).max(5000).optional(),
    slow: z.strictObject({ amount: z.number().min(0).max(0.9), ms: z.number().int().min(0).max(8000) }).optional(),
    lifesteal: z.number().min(0).max(1).optional(),
    lowHpBonus: z.number().min(0).max(3).optional(),
  }),
  z.strictObject({
    type: z.literal("dash"),
    mode: z.enum(["to_target", "behind_target", "away_from_target"]),
    distance: z.number().min(0).max(400),
  }),
  z.strictObject({
    type: z.literal("shield"),
    flat: z.number().min(0).max(5000),
    perDef: z.number().min(0).max(50),
    perInt: z.number().min(0).max(50),
    perMaxHp: z.number().min(0).max(1),
    ms: z.number().int().min(100).max(15000),
  }),
  z.strictObject({
    type: z.literal("heal"),
    flat: z.number().min(0).max(5000),
    perInt: z.number().min(0).max(50),
    perCha: z.number().min(0).max(50),
    perMaxHp: z.number().min(0).max(1),
  }),
  z.strictObject({
    type: z.literal("buff"),
    stat: z.enum(["attackSpeed", "dodge", "damage", "moveSpeed", "damageTaken"]),
    amount: z.number().min(-1).max(5),
    ms: z.number().int().min(100).max(15000),
  }),
  z.strictObject({ type: z.literal("taunt"), radius: z.number().min(0).max(400), ms: z.number().int().min(100).max(8000) }),
  z.strictObject({ type: z.literal("empower"), multiplier: z.number().min(1).max(5), ms: z.number().int().min(100).max(10000) }),
]);
export type SkillEffect = z.infer<typeof effectSchema>;

export const skillDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(60),
  description: z.string().max(240),
  cooldownMs: z.number().int().min(500).max(60000),
  castMs: z.number().int().min(0).max(3000),
  /** Max distance to the target to start the skill. 0 = self-cast. */
  range: z.number().min(0).max(500),
  effects: z.array(effectSchema).min(1).max(5),
  ai: z.strictObject({
    when: z.enum(["engage", "crowded", "low_hp", "opener"]),
    minEnemies: z.number().int().min(1).max(7).optional(),
    hpBelow: z.number().min(0).max(1).optional(),
  }),
  fx: z.enum(["cleave", "nova", "volley", "burst", "smite", "shield", "heal", "dash", "taunt", "buff", "snare"]),
});
export type SkillDef = z.infer<typeof skillDefSchema>;

export interface Ruleset {
  rulesVersion: string;
  combat: CombatSettings;
  classes: Record<string, ClassDef>;
  skills: Record<string, SkillDef>;
}

export function validateRuleset(input: unknown): Ruleset {
  const parsed = z
    .strictObject({
      rulesVersion: z.string().min(1),
      combat: rulesetCombatSchema,
      classes: z.record(z.string(), classDefSchema),
      skills: z.record(z.string(), skillDefSchema),
    })
    .parse(input);
  for (const cls of Object.values(parsed.classes)) {
    for (const skillId of cls.skills) {
      if (!parsed.skills[skillId]) throw new Error(`class ${cls.id} references unknown skill ${skillId}`);
    }
  }
  return parsed;
}

/** Content address of a ruleset: identical rules → identical hash. */
export function hashRuleset(ruleset: Ruleset): string {
  return hashObject(ruleset);
}
