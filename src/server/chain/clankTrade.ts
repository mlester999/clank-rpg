import { z } from "zod";

import { ProviderUnavailableError, type CatalogCoin, type CatalogCoinDetail, type CatalogPage, type CatalogProvider, type TradePage, type TradeProvider } from "./types";

/**
 * Adapter for the structured JSON that the official Clank.trade web app itself uses.
 *
 * IMPORTANT — what this is and isn't:
 *  - It is NOT a published or versioned developer API. Endpoints were observed on 2026-10-04
 *    (GET /v1/coins, tRPC coins.detail / coins.trades). They can change without notice.
 *  - Every response is validated with Zod and bounded in size and time. Schema drift or any
 *    failure raises ProviderUnavailableError; callers treat that as "unavailable", never as zero.
 *  - "Bonded" is INFERRED from observation: bonded coins reported `state: 3` together with
 *    `progress: 100`; all others reported `state: 0`. This inference is configurable below and
 *    must be confirmed with the Clank.trade team before relying on it for payouts.
 */
export const OBSERVED_BONDED_STATES: ReadonlySet<number> = new Set([3]);

export function isBondedObserved(coin: Pick<CatalogCoin, "state" | "progress">, bondedStates: ReadonlySet<number> = OBSERVED_BONDED_STATES): boolean {
  return coin.state !== null && bondedStates.has(coin.state) && (coin.progress ?? 0) >= 100;
}

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const raw = z.string().regex(/^(?:0|[1-9]\d{0,77})$/);

const coinSchema = z.looseObject({
  address: addr,
  name: z.string().max(400),
  symbol: z.string().max(80),
  image: z.string().max(2048).nullable().optional(),
  quoteCurrency: addr,
  quoteSymbol: z.string().max(40).optional(),
  state: z.number().int().nonnegative().optional(),
  progress: z.number().finite().min(0).max(100).optional(),
});
const coinPageSchema = z.looseObject({ coins: z.array(coinSchema), nextCursor: z.string().max(4096).nullable().optional() });
const detailSchema = coinSchema.extend({ totalSupply: raw.optional(), price: z.number().finite().nonnegative().optional() });
const tradeSchema = z.looseObject({
  id: z.string().min(1).max(512),
  trader: addr.optional(),
  side: z.enum(["buy", "sell"]),
  baseAmount: raw,
  quoteAmount: raw,
  timestamp: z.string().regex(/^\d{1,12}$/),
});
const tradePageSchema = z.looseObject({ trades: z.array(tradeSchema), nextCursor: z.string().max(4096).nullable().optional() });
const envelopeSchema = z.looseObject({
  result: z.looseObject({ data: z.unknown() }).optional(),
  error: z.looseObject({ data: z.looseObject({ httpStatus: z.number().optional() }).optional() }).optional(),
});

export interface ClankTradeClientOptions {
  baseUrl?: string;
  chainId?: number;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class ClankTradeClient implements CatalogProvider, TradeProvider {
  private readonly base: URL;
  private readonly chainId: number;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(opts: ClankTradeClientOptions = {}) {
    this.base = new URL(opts.baseUrl ?? "https://clank.trade");
    if (this.base.protocol !== "https:" && this.base.hostname !== "localhost") throw new TypeError("Clank.trade base URL must be https");
    this.chainId = opts.chainId ?? 4663;
    this.fetcher = opts.fetcher ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.maxBytes = opts.maxResponseBytes ?? 2_000_000;
  }

  private toCoin(c: z.infer<typeof coinSchema>): CatalogCoin {
    return {
      chainId: this.chainId,
      address: c.address.toLowerCase(),
      name: c.name,
      symbol: c.symbol,
      imageUrl: c.image ?? null,
      quoteCurrency: c.quoteCurrency.toLowerCase(),
      quoteSymbol: c.quoteSymbol ?? null,
      state: c.state ?? null,
      progress: c.progress ?? null,
    };
  }

  async listCoins(cursor?: string): Promise<CatalogPage> {
    const url = new URL("/v1/coins", this.base);
    if (cursor) url.searchParams.set("cursor", cursor);
    const parsed = coinPageSchema.safeParse(await this.getJson(url));
    if (!parsed.success) throw new ProviderUnavailableError("Clank.trade coin list failed validation");
    return { coins: parsed.data.coins.map((c) => this.toCoin(c)), nextCursor: parsed.data.nextCursor ?? null };
  }

  async getCoinDetail(address: string): Promise<CatalogCoinDetail | null> {
    const data = await this.trpc("coins.detail", { address: addr.parse(address) });
    if (data === null) return null;
    const parsed = detailSchema.safeParse(data);
    if (!parsed.success || parsed.data.address.toLowerCase() !== address.toLowerCase()) throw new ProviderUnavailableError("Clank.trade coin detail failed validation");
    return { ...this.toCoin(parsed.data), totalSupply: parsed.data.totalSupply ?? null, priceQuote: parsed.data.price ?? null };
  }

  async getTrades(address: string, cursor?: string): Promise<TradePage> {
    const input: Record<string, string> = { address: addr.parse(address) };
    if (cursor) input.cursor = cursor;
    const parsed = tradePageSchema.safeParse(await this.trpc("coins.trades", input));
    if (!parsed.success) throw new ProviderUnavailableError("Clank.trade trades failed validation");
    return {
      trades: parsed.data.trades.map((t) => ({
        id: t.id,
        trader: t.trader ? t.trader.toLowerCase() : null,
        side: t.side,
        baseAmount: t.baseAmount,
        quoteAmount: t.quoteAmount,
        timestampSec: Number(t.timestamp),
      })),
      nextCursor: parsed.data.nextCursor ?? null,
    };
  }

  private async trpc(procedure: string, input: Record<string, string>): Promise<unknown> {
    const url = new URL(`/v1/trpc/${procedure}`, this.base);
    url.searchParams.set("input", JSON.stringify(input));
    const env = envelopeSchema.safeParse(await this.getJson(url));
    if (!env.success) throw new ProviderUnavailableError(`Clank.trade ${procedure} envelope invalid`);
    if (env.data.error) {
      if (env.data.error.data?.httpStatus === 404) return null;
      throw new ProviderUnavailableError(`Clank.trade ${procedure} returned an error`);
    }
    if (!env.data.result || !("data" in env.data.result)) throw new ProviderUnavailableError(`Clank.trade ${procedure} returned no data`);
    return env.data.result.data;
  }

  private async getJson(url: URL): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetcher(url, { method: "GET", headers: { accept: "application/json" }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new ProviderUnavailableError("Clank.trade request failed", { cause: e });
    }
    if (!res.ok) throw new ProviderUnavailableError(`Clank.trade responded ${res.status}`);
    if (!(res.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new ProviderUnavailableError("Clank.trade response was not JSON");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > this.maxBytes) throw new ProviderUnavailableError("Clank.trade response too large");
    const text = await res.text();
    if (text.length > this.maxBytes) throw new ProviderUnavailableError("Clank.trade response too large");
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new ProviderUnavailableError("Clank.trade response was not valid JSON", { cause: e });
    }
  }
}
