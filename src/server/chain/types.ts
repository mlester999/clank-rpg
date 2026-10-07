/**
 * Provider interfaces for everything that touches Clank.trade or Robinhood Chain. Services
 * depend on these, never on a concrete network client, so:
 *  - tests inject deterministic fakes (no network),
 *  - an unavailable source degrades to an explicit "unavailable" state — we never fabricate
 *    balances, prices, supply or holding history.
 */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface CatalogCoin {
  chainId: number;
  /** lowercase 0x address */
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  quoteCurrency: string;
  quoteSymbol: string | null;
  /** Raw bonding-curve state flag as reported by the source. */
  state: number | null;
  /** 0..100 bonding progress as reported by the source. */
  progress: number | null;
}

export interface CatalogCoinDetail extends CatalogCoin {
  /** Raw integer string (token base units). */
  totalSupply: string | null;
  /** Price in quote-currency units per 1 whole token. */
  priceQuote: number | null;
}

export interface CatalogPage {
  coins: CatalogCoin[];
  nextCursor: string | null;
}

export interface CatalogProvider {
  listCoins(cursor?: string): Promise<CatalogPage>;
  getCoinDetail(address: string): Promise<CatalogCoinDetail | null>;
}

export interface TradeRow {
  id: string;
  trader: string | null;
  side: "buy" | "sell";
  /** Raw integer strings. */
  baseAmount: string;
  quoteAmount: string;
  timestampSec: number;
}

export interface TradePage {
  trades: TradeRow[];
  nextCursor: string | null;
}

export interface TradeProvider {
  getTrades(address: string, cursor?: string): Promise<TradePage>;
}

export interface TokenRef {
  address: string;
  decimals: number;
}

export interface BalanceReader {
  /** Balances for one wallet across tokens, in base units. Throws if the chain is unreachable. */
  getBalances(wallet: string, tokens: readonly TokenRef[]): Promise<Map<string, bigint>>;
  getTotalSupplies(tokens: readonly TokenRef[]): Promise<Map<string, bigint>>;
  getDecimals(address: string): Promise<number>;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}
