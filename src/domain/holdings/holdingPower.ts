import type { ClassDef } from "../rules";
import type { HoldingsSettings } from "../settings";
import type { StatBlock } from "../stats";
import { round2, saturate } from "../util/math";
import { distributePoints } from "../character/stats";

export interface HoldingInput {
  tokenId: string;
  /** Fraction of total supply held, 0..1. */
  supplyFraction: number;
  /** Value in the token's quote currency (comparable only when the quote is ETH). Null = unknown. */
  valueQuote: number | null;
}

export interface HoldingScore {
  /** 0..1, strictly below 1: strong diminishing returns. */
  score: number;
  parts: { value: number; supply: number; count: number };
  eligibleTokens: number;
}

/**
 * Hybrid Holding Power from only BONDED / eligible coins:
 *   value held        → saturate(Σ value, k_value)
 *   % of supply owned → 1 − Π(1 − saturate(fraction_i, k_supply))   (per-token, combined as probabilistic OR)
 *   number of coins   → saturate(count, k_count)
 * Every term is concave and bounded, so whales are rewarded but with sharply falling marginal
 * returns — they can never become unbeatable.
 */
export function computeHoldingScore(holdings: readonly HoldingInput[], s: HoldingsSettings): HoldingScore {
  const held = holdings.filter((h) => h.supplyFraction > s.dustSupplyFraction);
  if (!s.enabled || held.length === 0) {
    return { score: 0, parts: { value: 0, supply: 0, count: 0 }, eligibleTokens: 0 };
  }
  const totalValue = held.reduce((sum, h) => sum + (h.valueQuote ?? 0), 0);
  const value = saturate(totalValue, s.saturation.valueQuote);
  const supply = 1 - held.reduce((product, h) => product * (1 - saturate(h.supplyFraction, s.saturation.supplyFraction)), 1);
  const count = saturate(held.length, s.saturation.count);
  const w = s.weights;
  const totalWeight = w.value + w.supply + w.count || 1;
  const score = (w.value * value + w.supply * supply + w.count * count) / totalWeight;
  return { score, parts: { value, supply, count }, eligibleTokens: held.length };
}

export function holdingStatBonus(score: number, classDef: ClassDef, s: HoldingsSettings): StatBlock {
  const d = s.distribution;
  const weights: Partial<StatBlock> = { hp: d.hp, def: d.def, luck: d.luck };
  weights[classDef.primaryStat] = (weights[classDef.primaryStat] ?? 0) + d.primary;
  return distributePoints(round2(s.maxBonusPoints * score), weights, s.hpPerPoint);
}
