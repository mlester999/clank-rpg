import { rollRarityFx, type AppearanceParts } from "../character/appearance";
import { computePower } from "../character/stats";
import type { ClassDef } from "../rules";
import type { CharacterSettings } from "../settings";
import { CATALOG_VERSION } from "../sprites/catalog";
import { deriveSpriteConfig, sanitizeSpriteConfig, type SpriteConfig } from "../sprites/config";
import type { StatBlock } from "../stats";
import { createRng } from "../util/rng";

import { buildHeroVersionState, HERO_GENERATOR_VERSION, isLegacyGenerator, type HeroVersionState } from "./heroVersion";
import { buildTierStats, standingPosition } from "./statBudget";

/**
 * SYSTEM REBALANCE — how a hero that was made by the first generator moves onto the rarity power system (hero generator 2), WITHOUT being
 * re-rolled. A pure, deterministic function of the hero's current (legacy) version and the class definition:
 *
 *   KEPT      identity: the hero, its owner, its public URL, its class, its RARITY, its seed, its face / hair / colours.
 *   CHANGED   stats / PWR — the class shape is rescaled to the rarity's stat budget and fitted INSIDE the rarity's PWR band. Where in the
 *             band the hero lands follows its old STANDING among class peers (how far its old stats sat above or below the plain class
 *             baseline), plus a little of its own seed, so a hero that was strong for its class stays strong for its rarity. Its own stat
 *             shape — the small bounded variation it was rolled with — is carried over as the shape of the new stats.
 *   ADDED     the rarity visual layers (trim, shoulders, crest, weapon fx), chosen by the same seed-and-rarity rule hero generator 2 uses
 *             for new heroes. Everything the hero already wore stays.
 *
 * Nothing here draws a random number that is not derived from the stored seed, so running it twice — here, in a scratch copy, or live —
 * gives byte-identical output, and the output is the same whoever runs it. The historical version is not touched: the result is appended
 * as a new version (action SYSTEM_REBALANCE), exactly like a reroll or a rollback would be.
 */
export function rebalanceHeroState(input: { previous: HeroVersionState; classDef: ClassDef; settings: CharacterSettings }): HeroVersionState {
  const { previous, classDef, settings } = input;
  if (previous.classId !== classDef.id) throw new Error(`rebalance: class ${classDef.id} does not match the hero's class ${previous.classId}`);
  if (!isLegacyGenerator(previous.generatorVersion)) throw new Error(`rebalance: a ${previous.generatorVersion} version is already on the rarity power system`);
  const look = classDef.look;

  // Position inside the rarity's band: the old standing among class peers (measured with the OLD stat weights) + a little of the hero's own seed.
  const master = createRng(previous.generationSeed);
  const seedUnit = master.fork("tier").next();
  const legacyPower = computePower(previous.stats, settings);
  const legacyBasePower = computePower(classDef.base as StatBlock, settings);
  const position = standingPosition(legacyPower, legacyBasePower, seedUnit);

  const tier = buildTierStats({ classDef, rarity: previous.rarity, position, shape: previous.variation });

  // The look: identity untouched, rarity layers added by the same rule new heroes use (same seed fork as generateCharacter's appearance stream).
  const fx = rollRarityFx(master.fork("appearance").fork("rarity-fx"), previous.rarity);
  const appearance: AppearanceParts = { ...previous.appearance, fx };
  const derived = deriveSpriteConfig(appearance, look, previous.rarity);
  let sprite: SpriteConfig = derived;
  if (previous.sprite) {
    // Keep every slot the hero already has (it may carry choices the parts alone cannot reproduce); only the new enhancement slots are added.
    const slots = { ...previous.sprite.slots };
    for (const slot of ["trim", "shoulder", "crest", "weaponfx"] as const) {
      const id = derived.slots[slot];
      if (id) slots[slot] = id;
      else delete slots[slot];
    }
    sprite = sanitizeSpriteConfig({ ...previous.sprite, catalog: CATALOG_VERSION, slots }, look) ?? derived;
  }

  return buildHeroVersionState({
    generationSeed: previous.generationSeed,
    appearanceSeed: previous.appearanceSeed,
    classDef,
    rarity: previous.rarity,
    variation: tier.variation,
    telegramBonus: {},
    appearance,
    sprite,
    spriteSet: previous.render.spriteSet,
    settings,
    generatorVersion: HERO_GENERATOR_VERSION,
  });
}
