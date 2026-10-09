import { RARITIES, type Rarity } from "../character/appearance";

import { rarityRank } from "./rarity";

/**
 * THE LONG-TERM MATHS of one free reroll a day (docs/HERO_FREE_REROLL.md §4) — exact, pure, and reproducible by `pnpm reroll:fairness`.
 *
 * A reroll is a fresh, independent draw from the hero generator: each draw is Common / Rare / Epic / Legendary with the production odds
 * (`character.rarityWeights`, 70 / 22 / 7 / 1 %). There is no pity, no boost and no memory — the previous roll does not change the next one.
 * What a free reroll CAN change is the member's CHOICE of when to stop: a member who keeps the roll they like and only rerolls while they do not
 * has a ratchet that no single draw has. These functions measure that ratchet; they describe a strategy, they do not implement one.
 */
export type RarityOdds = Record<Rarity, number>;

/** Normalises weights to probabilities that sum to 1. */
export function rarityOdds(weights: Readonly<Record<Rarity, number>>): RarityOdds {
  const total = RARITIES.reduce((sum, r) => sum + weights[r], 0);
  return Object.fromEntries(RARITIES.map((r) => [r, weights[r] / total])) as RarityOdds;
}

/** The chance one draw is `min` or better. */
export function chanceAtLeast(odds: RarityOdds, min: Rarity): number {
  return RARITIES.filter((r) => rarityRank(r) >= rarityRank(min)).reduce((sum, r) => sum + odds[r], 0);
}

/** P(a member who keeps rerolling until a hero of `target` or better has reached it within `rerolls` rerolls), counting the hero they started with as draw 0. */
export function chanceToReach(odds: RarityOdds, target: Rarity, rerolls: number): number {
  const q = chanceAtLeast(odds, target);
  return 1 - Math.pow(1 - q, rerolls + 1);
}

/** Expected number of REROLLS (after the starting hero) until `target` or better — 1/q − 1. */
export function expectedRerollsTo(odds: RarityOdds, target: Rarity): number {
  return 1 / chanceAtLeast(odds, target) - 1;
}

/** The number of rerolls by which half of such members have reached `target` (starting hero counted as draw 0). */
export function medianRerollsTo(odds: RarityOdds, target: Rarity): number {
  const q = chanceAtLeast(odds, target);
  return Math.max(0, Math.ceil(Math.log(0.5) / Math.log(1 - q)) - 1);
}

export type RerollStrategy = { kind: "NEVER" } | { kind: "ALWAYS" } | { kind: "STOP_AT"; target: Rarity };

/**
 * The rarity distribution of a population in which EVERY member follows `strategy` and has used `days` free rerolls (one a day, every day).
 *  NEVER        keeps the starting hero                                     → the production odds
 *  ALWAYS       rerolls every day, whatever it is                            → the production odds (each day is a fresh draw)
 *  STOP_AT(T)   rerolls every day until the hero is T or better, then stops  → mass piles up at T and above
 * Exact: P(final = r) for r < T is p_r·(1−q)^days (never reached T, and the last draw was r); for r ≥ T it is p_r/q · (1 − (1−q)^(days+1)).
 */
export function populationAfter(odds: RarityOdds, strategy: RerollStrategy, days: number): RarityOdds {
  if (strategy.kind !== "STOP_AT") return { ...odds };
  const q = chanceAtLeast(odds, strategy.target);
  const reached = 1 - Math.pow(1 - q, days + 1);
  return Object.fromEntries(
    RARITIES.map((r) => [r, rarityRank(r) >= rarityRank(strategy.target) ? (odds[r] / q) * reached : odds[r] * Math.pow(1 - q, days)]),
  ) as RarityOdds;
}

/** Mean PWR of a population: Σ odds · mean PWR of the rarity (the means come from the generator, see the script). */
export function meanPower(odds: RarityOdds, meanByRarity: Readonly<Record<Rarity, number>>): number {
  return RARITIES.reduce((sum, r) => sum + odds[r] * meanByRarity[r], 0);
}
