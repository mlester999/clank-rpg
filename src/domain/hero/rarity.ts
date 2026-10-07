import { RARITIES, type Rarity } from "../character/appearance";

import { POWER_BASELINE } from "./power";

/**
 * RARITY RULES — the one authoritative description of what rarity MEANS in the game. Everything that needs a rarity's PWR range,
 * stat budget or prestige level (the hero generator, the rebalance of existing heroes, the audits, the hero card, the Admin console,
 * the public docs) reads this table; no number below is repeated anywhere else.
 *
 * HIGHER RARITY = HIGHER POWER POTENTIAL. Rarity is a real strength tier as well as a visual prestige tier:
 *
 *  · `powerMin`–`powerMax`  the PWR band every hero of the rarity is generated inside. The bands are contiguous and NEVER overlap
 *                           (the highest Common is below the lowest Rare, and so on) so the ladder reads at a glance.
 *  · `statBudget`           the same band expressed as a multiple of a class's balanced baseline stats (budget 1.0 = PWR POWER_BASELINE).
 *                           Rarity sets the TOTAL budget; the hero's CLASS decides how it is spent (a Warrior's goes to STR/HP, a Mage's
 *                           to INT …); the hero's own seed picks the exact spot inside the band and the fine shape of the stats.
 *  · `visualTier`           prestige level 0–3: how much visual treatment the rarity gets (see rarityVisuals.ts).
 *
 * The bands were chosen from an audit of the real generator and tuned with thousands of simulated Arena battles (docs/RARITY_POWER.md):
 * higher rarity wins clearly more often (a Legendary takes roughly four of every ten production-mix battles it enters), but never
 * automatically — class matchups, positioning and the deterministic combat rules still decide each fight, and a Common keeps a real
 * chance (it out-places a Legendary in roughly one battle in four when they meet).
 *
 * Rarity does NOT touch anything outside the hero: Arena Pick points, leaderboard scores/ranks/tie-breakers, prize pools, holder
 * bonus, claims and wallets all ignore it (asserted in tests).
 */
export interface RarityRule {
  id: Rarity;
  /** Name shown to players. */
  label: string;
  /** 1 = Common … 4 = Legendary (ordering, sorting, "at least this rare"). */
  rank: 1 | 2 | 3 | 4;
  powerMin: number;
  powerMax: number;
  /** The PWR band as a multiple of a class's balanced baseline stats (derived from the band; asserted in tests). */
  statBudget: { min: number; max: number };
  /** Prestige level 0–3. */
  visualTier: 0 | 1 | 2 | 3;
}

const budget = (powerMin: number, powerMax: number): { min: number; max: number } => ({
  min: Math.round((powerMin / POWER_BASELINE) * 1000) / 1000,
  max: Math.round((powerMax / POWER_BASELINE) * 1000) / 1000,
});

const rule = (id: Rarity, label: string, rank: RarityRule["rank"], powerMin: number, powerMax: number, visualTier: RarityRule["visualTier"]): RarityRule =>
  Object.freeze({ id, label, rank, powerMin, powerMax, statBudget: Object.freeze(budget(powerMin, powerMax)), visualTier });

export const RARITY_RULES: Readonly<Record<Rarity, RarityRule>> = Object.freeze({
  COMMON: rule("COMMON", "Common", 1, 130, 149, 0),
  RARE: rule("RARE", "Rare", 2, 150, 169, 1),
  EPIC: rule("EPIC", "Epic", 3, 170, 189, 2),
  LEGENDARY: rule("LEGENDARY", "Legendary", 4, 190, 209, 3),
});

/** Lowest rarity first. */
export const RARITY_LADDER: readonly RarityRule[] = RARITIES.map((r) => RARITY_RULES[r]);

export const rarityLabel = (rarity: Rarity): string => RARITY_RULES[rarity].label;
export const rarityRank = (rarity: Rarity): number => RARITY_RULES[rarity].rank;

/** The rarity whose band contains `power`, or null when it falls outside every band. */
export function rarityOfPower(power: number): Rarity | null {
  for (const r of RARITY_LADDER) if (power >= r.powerMin && power <= r.powerMax) return r.id;
  return null;
}

export const isPowerInBand = (rarity: Rarity, power: number): boolean => power >= RARITY_RULES[rarity].powerMin && power <= RARITY_RULES[rarity].powerMax;

/** Where a PWR sits inside its rarity's band, 0 (lowest) … 1 (highest); null when it is outside the band (a hero not yet on the rarity power system). */
export function positionInBand(rarity: Rarity, power: number): number | null {
  const { powerMin, powerMax } = RARITY_RULES[rarity];
  if (power < powerMin || power > powerMax) return null;
  return powerMax > powerMin ? (power - powerMin) / (powerMax - powerMin) : 0;
}

/** "150–169" */
export const bandLabel = (rarity: Rarity): string => `${RARITY_RULES[rarity].powerMin}–${RARITY_RULES[rarity].powerMax}`;

/** The whole range PWR can take for a standard hero. */
export const POWER_RANGE = Object.freeze({ min: RARITY_RULES.COMMON.powerMin, max: RARITY_RULES.LEGENDARY.powerMax });

/**
 * Where inside the rarity's band a hero sits: `position` ∈ [0, 1) → an integer PWR in [powerMin, powerMax]. Uniform in the position,
 * so every PWR of the band is equally likely for a uniform position.
 */
export function powerAtPosition(rarity: Rarity, position: number): number {
  const { powerMin, powerMax } = RARITY_RULES[rarity];
  const span = powerMax - powerMin + 1;
  const p = Number.isFinite(position) ? Math.min(0.999999999, Math.max(0, position)) : 0;
  return powerMin + Math.floor(p * span);
}

/** Structural self-check used by tests (and the release audit): contiguous, non-overlapping, ordered bands. */
export function validateRarityRules(rules: Readonly<Record<Rarity, RarityRule>> = RARITY_RULES): string[] {
  const problems: string[] = [];
  const ladder = RARITIES.map((r) => rules[r]);
  ladder.forEach((r, i) => {
    if (r.powerMin > r.powerMax) problems.push(`${r.id}: powerMin > powerMax`);
    if (r.rank !== i + 1) problems.push(`${r.id}: rank ${r.rank} is out of order`);
    if (r.visualTier !== i) problems.push(`${r.id}: visualTier ${r.visualTier} is out of order`);
    const prev = ladder[i - 1];
    if (prev && prev.powerMax >= r.powerMin) problems.push(`${prev.id} (max ${prev.powerMax}) overlaps ${r.id} (min ${r.powerMin})`);
    if (prev && r.powerMin !== prev.powerMax + 1) problems.push(`${prev.id} and ${r.id} are not contiguous`);
  });
  return problems;
}
