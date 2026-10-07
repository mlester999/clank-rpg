import type { TradeProvider } from "../chain/types";
import type { Db } from "../db/types";
import { isNativeQuote } from "./tokens";

export interface TradeIndexSummary {
  pages: number;
  seen: number;
  counted: number;
  skippedSmall: number;
  skippedNoTrader: number;
  skippedNonNativeQuote: number;
}

/**
 * Indexes recent public trades into per-trader rollups (independent of RPG accounts). Only
 * native-ETH-quoted coins are counted (so volumes are comparable), dust trades are ignored, and
 * each event is recorded once. Scoring later uses distinct trading DAYS, not trade counts.
 */
export async function indexTokenTrades(
  db: Db,
  provider: TradeProvider,
  token: { id: string; address: string; quoteCurrency: string | null },
  opts: { maxPages: number; minTradeQuote: number },
): Promise<TradeIndexSummary> {
  const out: TradeIndexSummary = { pages: 0, seen: 0, counted: 0, skippedSmall: 0, skippedNoTrader: 0, skippedNonNativeQuote: 0 };
  if (!isNativeQuote(token.quoteCurrency)) {
    out.skippedNonNativeQuote = 1;
    return out;
  }
  let cursor: string | undefined;
  for (let page = 0; page < opts.maxPages; page++) {
    const result = await provider.getTrades(token.address, cursor);
    out.pages++;
    let newInPage = 0;
    await db.transaction(async (tx) => {
      for (const t of result.trades) {
        out.seen++;
        const fresh = await tx.query("insert into public.trade_events_seen (token_id, event_id) values ($1, $2) on conflict do nothing returning event_id", [token.id, t.id]);
        if (fresh.length === 0) continue;
        newInPage++;
        if (!t.trader) { out.skippedNoTrader++; continue; }
        const quote = BigInt(t.quoteAmount);
        if (Number(quote) / 1e18 < opts.minTradeQuote) { out.skippedSmall++; continue; }
        const at = new Date(t.timestampSec * 1000);
        await tx.query(
          `insert into public.trade_stats (token_id, trader_address, trade_count, volume_quote, first_trade_at, last_trade_at)
           values ($1, $2, 1, $3::numeric, $4::timestamptz, $4::timestamptz)
           on conflict (token_id, trader_address) do update set trade_count = public.trade_stats.trade_count + 1,
             volume_quote = public.trade_stats.volume_quote + excluded.volume_quote,
             first_trade_at = least(public.trade_stats.first_trade_at, excluded.first_trade_at),
             last_trade_at = greatest(public.trade_stats.last_trade_at, excluded.last_trade_at)`,
          [token.id, t.trader, quote.toString(), at.toISOString()],
        );
        await tx.query("insert into public.trade_activity_days (token_id, trader_address, day) values ($1, $2, $3::date) on conflict do nothing", [token.id, t.trader, at.toISOString().slice(0, 10)]);
        out.counted++;
      }
    });
    if (!result.nextCursor || newInPage === 0) break; // caught up with what we've already indexed
    cursor = result.nextCursor;
  }
  return out;
}
