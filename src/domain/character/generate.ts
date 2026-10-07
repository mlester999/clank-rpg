import type { ClassDef } from "../rules";
import type { GameSettings } from "../settings";
import { zeroStats, type StatBlock } from "../stats";
import { telegramBonusPoints } from "../telegram/activity";
import type { BehaviorCounters } from "../telegram/types";
import { hmacSha256Hex } from "../util/hash";
import { createRng } from "../util/rng";
import { deriveSpriteConfig, type SpriteConfig } from "../sprites/config";
import { HERO_GENERATOR_VERSION, LEGACY_HERO_GENERATOR_VERSION } from "../hero/heroVersion";
import { buildTierStats } from "../hero/statBudget";

import { rollAppearance, rollAppearanceV1, rollRarity, type AppearanceParts, type Rarity } from "./appearance";
import { sanitizeDisplayName } from "./identity";
import { rollClass } from "./classRoll";
import { computePower, rollVariation, telegramStatBonus } from "./stats";

export interface GenerateCharacterInput {
  telegramUserId: number;
  displayName: string;
  behavior: Partial<BehaviorCounters>;
  activityScore: number;
  classes: readonly ClassDef[];
  settings: GameSettings;
  /** Server-only secret: makes the roll unpredictable to members yet stable per member. */
  secret: string;
  /**
   * Admin REROLL only: a server-generated random nonce. With no salt the roll is the member's permanent INITIAL roll (stable per
   * member). With a salt the very same generator — same class odds, same rarity weights, same bounds — draws a different, fresh roll
   * that is reproducible from (secret, member, salt). Nothing about rarity or class is boosted.
   */
  seedSalt?: string;
  /** Which ruleset draws the hero. Defaults to the current one; the first generator stays available so its versions remain reproducible. */
  generatorVersion?: string;
}

export interface GeneratedCharacter {
  /** The full hero seed (internal — it is stored with the version, never sent to a browser). */
  generationSeed: string;
  /** The ruleset that drew this hero (stored with every version). */
  generatorVersion: string;
  classId: string;
  name: string;
  rarity: Rarity;
  appearance: AppearanceParts;
  /** Layered-sprite configuration derived from `appearance` + the class look; persisted with the hero. */
  sprite: SpriteConfig;
  appearanceSeed: string;
  /** hero-gen/2: the whole generated offset from the class baseline (rarity budget + the seed's shape). hero-gen/1: a small bounded roll. */
  variation: StatBlock;
  telegramPoints: number;
  /** hero-gen/1 only; empty from hero-gen/2 on. */
  telegramBonus: StatBlock;
  /** The generated stats (class base + variation + telegram bonus), as the version will store them. */
  stats: StatBlock;
  /** The authoritative PWR of `stats` (hero-gen/2: inside the rarity's band by construction). */
  power: number;
  /** hero-gen/2: where in the rarity's PWR band this hero sits (0…1). */
  tierPosition: number;
}

/**
 * Deterministic hero generation. The master stream is HMAC(secret, telegramId): the same
 * member always rolls the same hero (retries/idempotency), but without the secret nobody can
 * predict or farm a class. Class, stats and look use independent forks so changing one
 * never perturbs another.
 *
 * hero-gen/2 (current):  class → rarity (production weights, unchanged) → PWR position inside the rarity's band → stats fitted to that
 * PWR from the class's own shape (the stat budget) → look with the rarity's visual layers. Class, rarity and the identity parts of the
 * look are drawn from the same forks as hero-gen/1, so the same seed gives the same class, rarity, face and hair under both.
 */
export function generateCharacter(input: GenerateCharacterInput): GeneratedCharacter {
  const generatorVersion = input.generatorVersion ?? HERO_GENERATOR_VERSION;
  const seed = hmacSha256Hex(input.secret, input.seedSalt ? `hero:${input.telegramUserId}:reroll:${input.seedSalt}` : `hero:${input.telegramUserId}`);
  const master = createRng(seed);
  const classDef = rollClass(input.classes, input.behavior, input.settings.character, master.fork("class"));
  const rarity = rollRarity(master.fork("rarity"), input.settings.character.rarityWeights);
  const name = sanitizeDisplayName(input.displayName, input.settings.character.nameMaxLength, input.telegramUserId);
  const telegramPoints = telegramBonusPoints(input.activityScore, input.settings.character);

  if (generatorVersion === LEGACY_HERO_GENERATOR_VERSION) {
    const variation = rollVariation(master.fork("variation"), input.settings.character);
    const appearance = rollAppearanceV1(master.fork("appearance"), classDef, rarity);
    const telegramBonus = telegramStatBonus(telegramPoints, classDef, input.settings.character);
    const stats = zeroStats();
    for (const key of Object.keys(stats) as Array<keyof StatBlock>) stats[key] = Math.max(1, Math.round(classDef.base[key] + variation[key] + telegramBonus[key]));
    return {
      generationSeed: seed, generatorVersion, classId: classDef.id, name, rarity, appearance, sprite: deriveSpriteConfig(appearance, classDef.look), appearanceSeed: seed.slice(0, 16),
      variation, telegramPoints, telegramBonus, stats, power: computePower(stats, input.settings.character), tierPosition: 0,
    };
  }

  const appearance = rollAppearance(master.fork("appearance"), classDef, rarity);
  // Where in the band: mostly the seed, with a small, bounded lean towards the member's Telegram activity (the old activity bonus, kept as a
  // nudge inside the tier instead of extra stat points — it can never move a hero out of its band).
  const maxPoints = input.settings.character.telegramBonus.maxPoints;
  const activity = maxPoints > 0 ? Math.min(1, telegramPoints / maxPoints) : 0;
  const position = Math.min(0.999999, 0.8 * master.fork("tier").next() + 0.2 * activity);
  const tier = buildTierStats({ classDef, rarity, position, shape: rollVariation(master.fork("variation"), input.settings.character) });
  return {
    generationSeed: seed,
    generatorVersion,
    classId: classDef.id,
    name,
    rarity,
    appearance,
    sprite: deriveSpriteConfig(appearance, classDef.look, rarity),
    appearanceSeed: seed.slice(0, 16),
    variation: tier.variation,
    telegramPoints,
    telegramBonus: zeroStats(),
    stats: tier.stats,
    power: tier.power,
    tierPosition: tier.position,
  };
}
