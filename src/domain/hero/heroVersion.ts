import { z } from "zod";

import { RARITIES, type AppearanceParts, type Rarity } from "../character/appearance";
import type { GeneratedCharacter } from "../character/generate";
import { computeEffectiveStats, computePower } from "../character/stats";
import type { ClassDef } from "../rules";
import type { CharacterSettings } from "../settings";
import { spriteConfigSchema, type SpriteConfig } from "../sprites/config";
import { addStats, STAT_KEYS, zeroStats, type StatBlock } from "../stats";

import { classPowerFactor, computeHeroPower, weightedStatSum } from "./power";
import { RARITY_RULES } from "./rarity";

/**
 * Hero VERSIONS (see supabase/migrations/20261005001800_hero_versions.sql).
 *
 * A hero is one permanent identity; its generated RPG state is an append-only history of versions:
 *   INITIAL           (v1) the hero as it was created — exactly the state stored today for heroes that predate versioning
 *   REROLL            an admin-approved candidate drawn by the SAME generator that creates new heroes
 *   ROLLBACK          an exact copy of an older version, appended (nothing is ever deleted or rewritten)
 *   SYSTEM_REBALANCE  the deterministic, system-made move of an existing hero onto the rarity power system (hero generator 2): same hero,
 *                     same owner, same rarity, same class, same identity — stats/PWR fitted into the rarity's band and the rarity visual layers
 *                     added. Never random: the same input version always yields the same rebalanced version (see hero/rebalance.ts).
 */
export type HeroVersionAction = "INITIAL" | "REROLL" | "ROLLBACK" | "SYSTEM_REBALANCE";
export const HERO_VERSION_ACTIONS: readonly HeroVersionAction[] = ["INITIAL", "REROLL", "ROLLBACK", "SYSTEM_REBALANCE"];

/**
 * Bump whenever generateCharacter's behaviour changes, so history says which generator drew a version.
 *   hero-gen/1  the first generator: class base + a small bounded variation + a Telegram activity bonus; rarity was a look only.
 *   hero-gen/2  "hero generator 2.0.0" — rarity is a strength tier: rarity fixes a PWR band and stat budget, the class spends it, the seed
 *               places the hero inside the band (hero/statBudget.ts); rarity visual layers; POWER formula 2.
 * Old versions keep the generator they were made with and are never re-interpreted under the new rules.
 */
export const HERO_GENERATOR_VERSION = "hero-gen/2";
export const LEGACY_HERO_GENERATOR_VERSION = "hero-gen/1";
/** Special (team/staff) characters are hand-authored, not generated: their stats are whatever an admin wrote, so no rarity band applies to them. */
export const AUTHORED_GENERATOR_VERSION = "authored/1";
export const HERO_GENERATOR_VERSIONS: readonly string[] = [LEGACY_HERO_GENERATOR_VERSION, HERO_GENERATOR_VERSION, AUTHORED_GENERATOR_VERSION];
export const isLegacyGenerator = (generatorVersion: string): boolean => generatorVersion === LEGACY_HERO_GENERATOR_VERSION;

/** The ruleset name players and admins see for a generator version. */
export function heroGeneratorLabel(generatorVersion: string): string {
  if (generatorVersion === "hero-gen/2") return "Hero generator 2.0.0";
  if (generatorVersion === "hero-gen/1") return "Hero generator 1.0.0 (pre-rarity-power)";
  if (generatorVersion === AUTHORED_GENERATOR_VERSION) return "Hand-authored";
  return generatorVersion;
}

/**
 * The PWR of a version's stats under the formula of the generator that made it: generator 1 versions keep the stat-weight POWER they
 * were stored with (so history never changes); generator 2 uses the authoritative class-calibrated formula (hero/power.ts).
 */
export function versionPower(generatorVersion: string, stats: StatBlock, classId: string, settings: CharacterSettings): number {
  return isLegacyGenerator(generatorVersion) ? computePower(stats, settings) : computeHeroPower(stats, classId);
}

/** Everything one version records about the generated RPG state (the application-side shape of a `hero_versions` row's state columns). */
export interface HeroVersionState {
  /** INTERNAL — never leaves the server. */
  generationSeed: string;
  generatorVersion: string;
  classId: string;
  rarity: Rarity;
  /** The generated components the stat formula reads (projected into character_stats; `{}` for hand-authored special characters). */
  variation: Partial<StatBlock>;
  telegramBonus: Partial<StatBlock>;
  /** class base + variation + Telegram bonus (or the authored fixed stats), rounded exactly like the engine's effective stats — wallet/gear parts excluded. */
  stats: StatBlock;
  /** POWER of `stats` under the settings in force when the version was made. */
  power: number;
  /** What character_appearances.seed holds. */
  appearanceSeed: string;
  appearance: AppearanceParts;
  /** NULL only for legacy heroes: the sprite is then derived from `appearance` when drawn. */
  sprite: SpriteConfig | null;
  render: { spriteSet: string };
}

export interface BuildStateInput {
  generationSeed: string;
  appearanceSeed: string;
  classDef: ClassDef;
  rarity: Rarity;
  variation: Partial<StatBlock>;
  telegramBonus: Partial<StatBlock>;
  /** Special characters: admin-authored stats replace everything. */
  fixedStats?: Partial<StatBlock> | null;
  appearance: AppearanceParts;
  sprite: SpriteConfig | null;
  spriteSet: string;
  settings: CharacterSettings;
  generatorVersion?: string;
}

/** The generated stat figures of a hero: the same arithmetic as the engine's effective stats, with no wallet or gear component. */
export function generatedStats(classDef: ClassDef, variation: Partial<StatBlock>, telegramBonus: Partial<StatBlock>, fixedStats?: Partial<StatBlock> | null): StatBlock {
  const z = zeroStats();
  return computeEffectiveStats({ classDef, variation: addStats(variation), telegram: addStats(telegramBonus), holdings: z, loyalty: z, trading: z, fixed: fixedStats ?? null }).total;
}

export function buildHeroVersionState(i: BuildStateInput): HeroVersionState {
  const stats = generatedStats(i.classDef, i.variation, i.telegramBonus, i.fixedStats);
  return {
    generationSeed: i.generationSeed,
    generatorVersion: i.generatorVersion ?? HERO_GENERATOR_VERSION,
    classId: i.classDef.id,
    rarity: i.rarity,
    variation: i.variation,
    telegramBonus: i.telegramBonus,
    stats,
    power: versionPower(i.generatorVersion ?? HERO_GENERATOR_VERSION, stats, i.classDef.id, i.settings),
    appearanceSeed: i.appearanceSeed,
    appearance: i.appearance,
    sprite: i.sprite,
    render: { spriteSet: i.spriteSet },
  };
}

/** A fresh roll from the authoritative generator → the version state it would become. */
export function versionStateFromGenerated(g: GeneratedCharacter, classDef: ClassDef, settings: CharacterSettings, spriteSet: string): HeroVersionState {
  const state = buildHeroVersionState({
    generationSeed: g.generationSeed,
    appearanceSeed: g.appearanceSeed,
    classDef,
    rarity: g.rarity,
    variation: g.variation,
    telegramBonus: g.telegramBonus,
    appearance: g.appearance,
    sprite: g.sprite,
    spriteSet,
    settings,
    generatorVersion: g.generatorVersion,
  });
  // The generator and the version arithmetic must agree on the figures — a mismatch would mean stats and PWR disagree.
  if (state.power !== g.power) throw new Error(`hero generator and version state disagree on PWR (${g.power} vs ${state.power})`);
  return state;
}

/**
 * Bounds every GENERATED stat must respect (asserted on every reroll in tests): the engine floors stats at 1.
 *  · generator 2: the stats are the class shape scaled to the rarity's PWR band, with the seed's shape variation and the few points the
 *    exact-PWR fit moves — so each stat lies within the band's scale of the class base, plus that wobble;
 *  · generator 1: class base ± variation ± the Telegram bonus cap.
 */
export function statBounds(classDef: ClassDef, settings: CharacterSettings, rarity?: Rarity, generatorVersion: string = HERO_GENERATOR_VERSION): { min: StatBlock; max: StatBlock } {
  const min = zeroStats();
  const max = zeroStats();
  if (isLegacyGenerator(generatorVersion) || !rarity) {
    for (const key of STAT_KEYS) {
      const reach = key === "hp" ? settings.variation.hp : settings.variation.stat;
      const bonusCap = key === "hp" ? settings.telegramBonus.maxPoints * settings.telegramBonus.hpPerPoint : settings.telegramBonus.maxPoints;
      min[key] = Math.max(1, Math.round(classDef.base[key] - reach));
      max[key] = Math.round(classDef.base[key] + reach + bonusCap);
    }
    return { min, max };
  }
  const shapeSum = weightedStatSum(classDef.base as StatBlock);
  const factor = classPowerFactor(classDef.id);
  const { powerMin, powerMax } = RARITY_RULES[rarity];
  const lo = powerMin / factor / shapeSum;
  const hi = (powerMax + 1) / factor / shapeSum;
  for (const key of STAT_KEYS) {
    const reach = key === "hp" ? settings.variation.hp : settings.variation.stat;
    min[key] = Math.max(1, Math.floor(classDef.base[key] * lo - reach * hi - 3));
    max[key] = Math.ceil(classDef.base[key] * hi + reach * hi + 3);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------
// Validation of a state read back from storage (a stored reroll candidate, a version row) before it is applied.
// ---------------------------------------------------------------------------------------

const statValue = z.number().finite();
const fullStats = z.strictObject({ hp: statValue, str: statValue, def: statValue, int: statValue, agi: statValue, cha: statValue, luck: statValue });
const partialStats = fullStats.partial();

export const heroVersionStateSchema = z.strictObject({
  generationSeed: z.string().min(1).max(128),
  generatorVersion: z.string().min(1).max(40),
  classId: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  rarity: z.enum(RARITIES as unknown as [Rarity, ...Rarity[]]),
  variation: partialStats,
  telegramBonus: partialStats,
  stats: fullStats,
  power: z.number().int().min(0),
  appearanceSeed: z.string().min(1).max(128),
  appearance: z.looseObject({}),
  sprite: spriteConfigSchema.nullable(),
  render: z.strictObject({ spriteSet: z.string().min(1).max(60) }),
});

/** Parses a stored candidate; throws if it is not exactly a hero version state. */
export function parseHeroVersionState(raw: unknown): HeroVersionState {
  return heroVersionStateSchema.parse(raw) as unknown as HeroVersionState;
}
