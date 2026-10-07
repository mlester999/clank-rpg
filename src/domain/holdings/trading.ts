import type { TradingSettings } from "../settings";
import type { StatBlock } from "../stats";
import { round2, saturate } from "../util/math";
import { distributePoints } from "../character/stats";

export interface TradingAggregate {
  /** Distinct (token, UTC day) pairs with a qualifying trade. */
  tradeDays: number;
  /** Σ quote-currency volume of qualifying trades (ETH-equivalent). */
  volumeQuote: number;
  /** Distinct eligible tokens traded. */
  tokens: number;
}

/**
 * Trading is a SMALL, conservative component. It scores distinct trading DAYS, a saturating
 * volume term and token breadth — never raw trade counts — so wash-trading thousands of tiny
 * swaps in one day gains almost nothing. The ceiling (maxPoints) is ~1% of a hero's power.
 */
export function computeTradingScore(a: TradingAggregate, s: TradingSettings): number {
  if (!s.enabled) return 0;
  const w = s.weights;
  const total = w.tradeDays + w.volume + w.tokens || 1;
  return (
    (w.tradeDays * saturate(a.tradeDays, s.saturation.tradeDays) +
      w.volume * saturate(a.volumeQuote, s.saturation.volumeQuote) +
      w.tokens * saturate(a.tokens, s.saturation.tokens)) /
    total
  );
}

export function tradingStatBonus(score: number, s: TradingSettings, hpPerPoint = 3): StatBlock {
  return distributePoints(round2(s.maxPoints * score), { luck: s.distribution.luck, agi: s.distribution.agi }, hpPerPoint);
}
