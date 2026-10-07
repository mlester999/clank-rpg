import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { custom, encodeAbiParameters } from "viem";

import { isBondedObserved, ClankTradeClient } from "@/server/chain/clankTrade";
import { createRobinhoodReader } from "@/server/chain/robinhood";
import { ProviderUnavailableError, type BalanceReader, type CatalogCoin, type CatalogCoinDetail, type CatalogProvider, type TradeProvider } from "@/server/chain/types";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { claimCharacter } from "@/server/services/identity";
import { syncCharacterHoldings } from "@/server/services/holdings";
import { scanCatalog, setTokenStatus } from "@/server/services/tokens";
import { indexTokenTrades } from "@/server/services/trading";

import { count, createTestDb, resetDb, seedHeroes } from "../support/db";

const E18 = 10n ** 18n;
const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const DAY = 86_400_000;
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN_A = "0xfa31d04462746aaa24bc7e5626403e09e4b106ec";
const TOKEN_B = "0x0fe97b2d477014d78a61829a3c41866912d469ea";

class FakeReader implements BalanceReader {
  balances = new Map<string, bigint>();
  fail = false;
  calls = 0;
  async getBalances(_w: string, tokens: readonly { address: string }[]) {
    this.calls++;
    if (this.fail) throw new ProviderUnavailableError("rpc down");
    return new Map(tokens.map((t) => [t.address, this.balances.get(t.address) ?? 0n]));
  }
  async getTotalSupplies() { return new Map<string, bigint>(); }
  async getDecimals() { return 18; }
}

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function setup(opts: { tokens?: Array<{ addr: string; status?: string; price?: string; quote?: string }> } = {}) {
  const [hero] = await seedHeroes(db, 1);
  const tid = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [hero]))[0]!.telegram_user_id;
  await claimCharacter(db, tid, new Date(T0));
  await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, 4663)", [hero, WALLET]);
  const tokenIds: Record<string, string> = {};
  for (const t of opts.tokens ?? [{ addr: TOKEN_A }]) {
    const [row] = await db.query<{ id: string }>(
      `insert into public.eligible_tokens (chain_id, address, symbol, name, status, bonded_observed, total_supply, price_quote, quote_currency, approved_at)
       values (4663, $1, 'TKN', 'Token', $2, true, $3::numeric, $4::numeric, $5, now()) returning id`,
      [t.addr, t.status ?? "ELIGIBLE", (1_000_000_000n * E18).toString(), t.price ?? "0.0000002", t.quote ?? "0x0000000000000000000000000000000000000000"],
    );
    tokenIds[t.addr] = row!.id;
  }
  return { hero: hero!, tokenIds, settings: await loadSettings(db), classes: await loadClasses(db) };
}

const sync = (hero: string, s: Awaited<ReturnType<typeof setup>>, reader: BalanceReader | null, atMs: number) =>
  syncCharacterHoldings(db, hero, { reader, settings: s.settings, classes: s.classes, now: new Date(atMs), force: true });

describe("holdings sync (bonded coins only)", () => {
  it("$CLANKRPG is never a holdings-bonus coin, even if it is registered as an eligible coin: its balance gives no score and no POWER", async () => {
    const REWARD_TOKEN = "0x2222222222222222222222222222222222222222";
    const saved = process.env.CLANKRPG_TOKEN_ADDRESS;
    process.env.CLANKRPG_TOKEN_ADDRESS = REWARD_TOKEN.toUpperCase().replace("0X", "0x"); // mixed case on purpose: the comparison is case-insensitive
    resetEnvCache();
    try {
      const s = await setup({ tokens: [{ addr: REWARD_TOKEN }] });
      const reader = new FakeReader();
      reader.balances.set(REWARD_TOKEN, 10_000_000n * E18); // a 10M holder
      const r = await sync(s.hero, s, reader, T0);
      expect(r).toMatchObject({ status: "OK", eligibleTokens: 0, holdingScore: 0 });
      expect(await count(db, "token_holdings")).toBe(0);
      // Control: with the reward token NOT configured, the very same hero / coin / balance does count — so the zero above is
      // the $CLANKRPG exclusion working, not a broken fixture.
      delete process.env.CLANKRPG_TOKEN_ADDRESS;
      resetEnvCache();
      const r2 = await sync(s.hero, s, reader, T0 + 1000);
      expect(r2).toMatchObject({ status: "OK", eligibleTokens: 1 });
      expect((r2 as { holdingScore: number }).holdingScore).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env.CLANKRPG_TOKEN_ADDRESS;
      else process.env.CLANKRPG_TOKEN_ADDRESS = saved;
      resetEnvCache();
    }
  });

  it("counts only ELIGIBLE coins; candidates, rejected and delisted coins give nothing", async () => {
    const s = await setup({ tokens: [{ addr: TOKEN_A, status: "CANDIDATE" }, { addr: TOKEN_B, status: "REJECTED" }] });
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 10_000_000n * E18);
    reader.balances.set(TOKEN_B, 10_000_000n * E18);
    const r = await sync(s.hero, s, reader, T0);
    expect(r).toMatchObject({ status: "OK", eligibleTokens: 0, holdingScore: 0 });
    expect(await count(db, "token_holdings")).toBe(0);
    // Promote one: now it counts.
    await db.transaction((tx) => setTokenStatus(tx, s.tokenIds[TOKEN_A]!, "ELIGIBLE", "admin"));
    const r2 = await sync(s.hero, s, reader, T0 + 1000);
    expect(r2).toMatchObject({ status: "OK", eligibleTokens: 1 });
    expect((r2 as { holdingScore: number }).holdingScore).toBeGreaterThan(0);
  });

  it("raises hero stats modestly and persists the verified snapshot with exact supply math", async () => {
    const s = await setup();
    const power = async () => (await db.query<{ power: number }>("select power from public.characters where id = $1", [s.hero]))[0]!.power;
    const holdingsBonus = async () => {
      const [r] = await db.query<{ b: Record<string, number> }>("select holdings_bonus as b from public.character_stats where character_id = $1", [s.hero]);
      return Object.values(r!.b).reduce((a, x) => a + Number(x), 0);
    };
    const before = await power();
    expect(await holdingsBonus()).toBe(0);
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 5_000_000n * E18); // 0.5% of a 1B supply
    await sync(s.hero, s, reader, T0);
    const [h] = await db.query<{ balance: string; supply_fraction: string; value_quote: string }>("select balance, supply_fraction, value_quote from public.token_holdings where character_id = $1", [s.hero]);
    expect(h!.balance).toBe((5_000_000n * E18).toString());
    expect(Number(h!.supply_fraction)).toBeCloseTo(0.005, 9);
    expect(Number(h!.value_quote)).toBeCloseTo(5_000_000 * 0.0000002, 9);
    // Holdings raise the hero's wallet-derived combat bonus (modestly) — but PWR, the power of the GENERATED stats, never moves: token
    // holdings never affect hero power, so a hero can never leave its rarity band because of a wallet.
    expect(await holdingsBonus()).toBeGreaterThan(0);
    expect(await power()).toBe(before);
  });

  it("whales are advantaged but strongly capped (100× holdings ≠ 100× power)", async () => {
    const s = await setup();
    const reader = new FakeReader();
    const bonus = async (balance: bigint) => {
      reader.balances.set(TOKEN_A, balance);
      await sync(s.hero, s, reader, T0);
      return (await db.query<{ holding_power: number }>("select holding_power from public.character_stats where character_id = $1", [s.hero]))[0]!.holding_power;
    };
    const small = await bonus(1_000_000n * E18); //   0.1 % of supply
    const mid = await bonus(20_000_000n * E18); //    2 %
    const big = await bonus(100_000_000n * E18); //   10 %
    const whale = await bonus(900_000_000n * E18); // 90 %
    expect(mid).toBeGreaterThan(small);
    expect(big).toBeGreaterThan(mid);
    expect(whale).toBeGreaterThanOrEqual(big);
    expect(big / small).toBeLessThan(10);    // 100× the holdings buys well under 10× the score ...
    expect(big).toBeLessThan(1);             // ... and the score is bounded below 1
    expect(whale).toBeLessThan(1);
    const power = (await db.query<{ power: number }>("select power from public.characters where id = $1", [s.hero]))[0]!.power;
    expect(power).toBeLessThan(400); // a maxed whale at level 1 is still in the same league as peers (~140)
  });

  it("non-native quote tokens contribute supply/count but no value term", async () => {
    const s = await setup({ tokens: [{ addr: TOKEN_A, quote: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea" }] });
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 5_000_000n * E18);
    await sync(s.hero, s, reader, T0);
    expect((await db.query<{ value_quote: string | null }>("select value_quote from public.token_holdings"))[0]!.value_quote).toBeNull();
  });
});

describe("Diamond Hands lifecycle", () => {
  it("builds milestones over verified time; reducing holdings resets the streak; gaps restart it", async () => {
    const s = await setup();
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 10_000_000n * E18);

    await sync(s.hero, s, reader, T0);
    const streak = async () => db.query<{ id: string; started_at: Date; ended_at: Date | null; end_reason: string | null }>("select id, started_at, ended_at, end_reason from public.holding_streaks order by started_at");
    expect((await streak())).toHaveLength(1);
    expect(await count(db, "holding_milestones")).toBe(0);
    expect((await streak())[0]!.started_at.getTime()).toBe(T0); // measured from OUR first observation, not backdated

    await sync(s.hero, s, reader, T0 + 1 * DAY - 3_600_000); // not yet a full day
    expect(await count(db, "holding_milestones")).toBe(0);
    await sync(s.hero, s, reader, T0 + 1 * DAY + 1000);
    expect((await db.query<{ days: number }>("select days from public.holding_milestones order by days")).map((m) => m.days)).toEqual([1]);
    for (let d = 2; d <= 8; d++) await sync(s.hero, s, reader, T0 + d * DAY);
    expect((await db.query<{ days: number }>("select days from public.holding_milestones order by days")).map((m) => m.days)).toEqual([1, 7]);

    // loyalty bonus is defensive-only and capped
    const lb = (await db.query<{ loyalty_bonus: Record<string, number> }>("select loyalty_bonus from public.character_stats where character_id = $1", [s.hero]))[0]!.loyalty_bonus;
    expect(Object.keys(lb).filter((k) => lb[k]! > 0).sort()).toEqual(["def", "hp"]);

    // Selling 50% breaks the streak; the remainder begins a NEW one from now.
    reader.balances.set(TOKEN_A, 5_000_000n * E18);
    await sync(s.hero, s, reader, T0 + 9 * DAY);
    const all = await streak();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ end_reason: "SOLD_DOWN" });
    expect(all[1]!.started_at.getTime()).toBe(T0 + 9 * DAY);
    expect(all[1]!.ended_at).toBeNull();

    // A long gap without any verification cannot be vouched for.
    await sync(s.hero, s, reader, T0 + 9 * DAY + 5 * DAY);
    expect((await streak()).filter((x) => x.ended_at === null)[0]!.started_at.getTime()).toBe(T0 + 14 * DAY);

    // Selling everything ends it for good.
    reader.balances.set(TOKEN_A, 0n);
    await sync(s.hero, s, reader, T0 + 14 * DAY + 3_600_000);
    expect((await streak()).filter((x) => x.ended_at === null)).toHaveLength(0);
  });

  it("an unreachable provider changes NOTHING (no fake zero, no silent decay)", async () => {
    const s = await setup();
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 10_000_000n * E18);
    await sync(s.hero, s, reader, T0);
    const snapshot = JSON.stringify(await db.query("select * from public.token_holdings"));
    const streaks = JSON.stringify(await db.query("select * from public.holding_streaks"));
    const stats = JSON.stringify(await db.query("select holdings_bonus, loyalty_bonus, holding_power from public.character_stats"));
    reader.fail = true;
    expect(await sync(s.hero, s, reader, T0 + 5 * DAY)).toMatchObject({ status: "UNAVAILABLE" });
    expect(await sync(s.hero, s, null, T0 + 5 * DAY)).toMatchObject({ status: "UNAVAILABLE" });
    expect(JSON.stringify(await db.query("select * from public.token_holdings"))).toBe(snapshot);
    expect(JSON.stringify(await db.query("select * from public.holding_streaks"))).toBe(streaks);
    expect(JSON.stringify(await db.query("select holdings_bonus, loyalty_bonus, holding_power from public.character_stats"))).toBe(stats);
  });

  it("is throttled per hero unless forced, and needs a linked wallet", async () => {
    const s = await setup();
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 10_000_000n * E18);
    const deps = { reader, settings: s.settings, classes: s.classes };
    expect((await syncCharacterHoldings(db, s.hero, { ...deps, now: new Date(T0) })).status).toBe("OK");
    expect((await syncCharacterHoldings(db, s.hero, { ...deps, now: new Date(T0 + 1000) })).status).toBe("THROTTLED");
    expect(reader.calls).toBe(1);
    await db.query("update public.wallet_links set unlinked_at = now()");
    expect((await syncCharacterHoldings(db, s.hero, { ...deps, now: new Date(T0 + 99_999_999), force: true })).status).toBe("NO_WALLET");
  });

  it("holdings bonuses unlock the 'bonded collector' / diamond achievements", async () => {
    const s = await setup({ tokens: [{ addr: TOKEN_A }, { addr: TOKEN_B }] });
    const reader = new FakeReader();
    reader.balances.set(TOKEN_A, 10_000_000n * E18);
    reader.balances.set(TOKEN_B, 10_000_000n * E18);
    await sync(s.hero, s, reader, T0);
    await sync(s.hero, s, reader, T0 + 2 * DAY);
    const ids = (await db.query<{ achievement_id: string }>("select achievement_id from public.character_achievements")).map((a) => a.achievement_id);
    expect(ids).toContain("diamond_1d");
    expect(ids).not.toContain("diamond_7d");
    expect(ids).not.toContain("bonded_collector"); // only 2 coins held
  });
});

describe("catalog scan + boss drafts", () => {
  const coin = (address: string, state: number, progress: number): CatalogCoin => ({
    chainId: 4663, address, name: `Coin ${address.slice(2, 6)}`, symbol: "CN", imageUrl: null, quoteCurrency: "0x0000000000000000000000000000000000000000", quoteSymbol: "ETH", state, progress,
  });
  const detail = (c: CatalogCoin): CatalogCoinDetail => ({ ...c, totalSupply: (1_000_000_000n * E18).toString(), priceQuote: 2e-7 });
  const catalog = (pages: CatalogCoin[][]): CatalogProvider => ({
    async listCoins(cursor) {
      const i = cursor ? Number(cursor) : 0;
      return { coins: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
    },
    async getCoinDetail(a) {
      const all = pages.flat().find((c) => c.address === a);
      return all ? detail(all) : null;
    },
  });
  const pages = [[coin(TOKEN_A, 3, 100), coin("0x2222222222222222222222222222222222222222", 0, 40)], [coin(TOKEN_B, 3, 100), coin("0x3333333333333333333333333333333333333333", 0, 99.9)]];

  it("stores only bonded coins; they await admin approval unless auto-approve is on", async () => {
    const r = await scanCatalog(db, catalog(pages), { chainId: 4663, maxPages: 5, autoApprove: false });
    expect(r).toMatchObject({ pagesRead: 2, coinsSeen: 4, bondedFound: 2, inserted: 2, autoApproved: 0, complete: true });
    expect((await db.query<{ status: string }>("select distinct status from public.eligible_tokens")).map((t) => t.status)).toEqual(["CANDIDATE"]);
    expect(await count(db, "boss_drafts")).toBe(0); // no drafts until a coin is approved
  });

  it("a rescan refreshes facts but never overrides an admin decision", async () => {
    await scanCatalog(db, catalog(pages), { chainId: 4663, maxPages: 5, autoApprove: false });
    const id = (await db.query<{ id: string }>("select id from public.eligible_tokens where address = $1", [TOKEN_A]))[0]!.id;
    await db.transaction((tx) => setTokenStatus(tx, id, "REJECTED", "admin"));
    const again = await scanCatalog(db, catalog(pages), { chainId: 4663, maxPages: 5, autoApprove: true });
    expect(again).toMatchObject({ inserted: 0, updated: 2 });
    expect((await db.query<{ status: string }>("select status from public.eligible_tokens where id = $1", [id]))[0]!.status).toBe("REJECTED");
  });

  it("approved coins get a DRAFT boss; drafts can never go live without an admin approver", async () => {
    await scanCatalog(db, catalog(pages), { chainId: 4663, maxPages: 5, autoApprove: true });
    expect(await count(db, "boss_drafts", "status = 'DRAFT'")).toBe(2);
    const draft = (await db.query<{ id: string; token_id: string }>("select id, token_id from public.boss_drafts limit 1"))[0]!;
    await expect(db.query("update public.boss_drafts set status = 'LIVE' where id = $1", [draft.id])).rejects.toThrow();
    await expect(db.query("update public.boss_drafts set status = 'APPROVED', approved_by = 'SYSTEM', approved_at = now() where id = $1", [draft.id])).rejects.toThrow(/explicit admin approval/);
    await expect(db.query("insert into public.boss_drafts (token_id, status, approved_by, approved_at) values ($1, 'LIVE', 'x', now())", [draft.token_id])).rejects.toThrow();
    await db.query("update public.boss_drafts set status = 'APPROVED', approved_by = 'admin', approved_at = now() where id = $1", [draft.id]);
    expect((await db.query<{ status: string }>("select status from public.boss_drafts where id = $1", [draft.id]))[0]!.status).toBe("APPROVED");
  });

  it("the bonded inference is explicit: state 3 + progress 100 only", () => {
    expect(isBondedObserved({ state: 3, progress: 100 })).toBe(true);
    expect(isBondedObserved({ state: 0, progress: 100 })).toBe(false);
    expect(isBondedObserved({ state: 3, progress: 99.9 })).toBe(false);
    expect(isBondedObserved({ state: null, progress: null })).toBe(false);
  });
});

describe("trading activity indexer", () => {
  const trade = (id: string, trader: string | null, quote: bigint, day = 0) => ({ id, trader, side: "buy" as const, baseAmount: "1", quoteAmount: quote.toString(), timestampSec: Math.floor((T0 + day * DAY) / 1000) });
  const provider = (pages: ReturnType<typeof trade>[][]): TradeProvider => ({
    async getTrades(_a, cursor) {
      const i = cursor ? Number(cursor) : 0;
      return { trades: pages[i] ?? [], nextCursor: i + 1 < pages.length ? String(i + 1) : null };
    },
  });
  const token = async () => {
    const s = await setup();
    return { s, ref: { id: s.tokenIds[TOKEN_A]!, address: TOKEN_A, quoteCurrency: "0x0000000000000000000000000000000000000000" } };
  };

  it("1000 same-day wash trades = ONE trading day; dust and trader-less rows are ignored; events are idempotent", async () => {
    const { ref } = await token();
    const wash = Array.from({ length: 1000 }, (_, i) => trade(`e${i}`, WALLET, E18 / 100n));
    const noise = [trade("dust", WALLET, 10n), trade("anon", null, E18)];
    const idx = (p: TradeProvider) => indexTokenTrades(db, p, ref, { maxPages: 3, minTradeQuote: 0.0005 });
    const r = await idx(provider([[...wash, ...noise]]));
    expect(r).toMatchObject({ counted: 1000, skippedSmall: 1, skippedNoTrader: 1 });
    expect(await count(db, "trade_activity_days")).toBe(1);
    const again = await idx(provider([[...wash, ...noise]]));
    expect(again.counted).toBe(0); // already seen
    expect((await db.query<{ trade_count: number }>("select trade_count from public.trade_stats"))[0]!.trade_count).toBe(1000);
  });

  it("native-ETH-quoted coins only", async () => {
    const { s } = await token();
    const r = await indexTokenTrades(db, provider([[trade("x", WALLET, E18)]]), { id: s.tokenIds[TOKEN_A]!, address: TOKEN_A, quoteCurrency: "0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea" }, { maxPages: 1, minTradeQuote: 0 });
    expect(r.skippedNonNativeQuote).toBe(1);
    expect(await count(db, "trade_stats")).toBe(0);
  });

  it("feeds a small, capped trading bonus into the hero when wallet holdings sync", async () => {
    const { s, ref } = await token();
    const trades = Array.from({ length: 30 }, (_, d) => trade(`d${d}`, WALLET, E18 / 10n, d));
    await indexTokenTrades(db, provider([trades]), ref, { maxPages: 1, minTradeQuote: 0.0005 });
    const reader = new FakeReader();
    await sync(s.hero, s, reader, T0 + 40 * DAY);
    const tb = (await db.query<{ trading_bonus: Record<string, number> }>("select trading_bonus from public.character_stats where character_id = $1", [s.hero]))[0]!.trading_bonus;
    const points = (tb.luck ?? 0) + (tb.agi ?? 0);
    expect(points).toBeGreaterThan(0);
    expect(points).toBeLessThanOrEqual(s.settings.trading.maxPoints + 0.02);
  });
});

describe("Clank.trade client (observed public-app interface)", () => {
  const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
  // Shapes copied from live responses captured on 2026-10-04.
  const liveCoin = { id: "market:4663:0xFa31", address: "0xfa31d04462746aaa24bc7e5626403e09e4b106ec", name: "Artificial Girlfriend Intelligence", symbol: "AGI", image: "ipfs://x", creator: "0xe96be7b1fadedd2c4b6e151605423f5785ec66ba", website: null, twitter: null, createdAt: "1789534468", marketCap: 206.05, quoteSymbol: "ETH", quoteImage: "/a.svg", quoteCurrency: "0x0000000000000000000000000000000000000000", state: 3, progress: 100 };
  const mk = (handler: (url: URL) => Response) => new ClankTradeClient({ fetcher: (async (u: URL | string) => handler(new URL(String(u)))) as typeof fetch });

  it("parses catalog pages, lowercases addresses and keeps unknown fields from breaking us", async () => {
    const c = mk(() => json({ coins: [{ ...liveCoin, futureField: { a: 1 } }], nextCursor: "abc" }));
    const page = await c.listCoins();
    expect(page.nextCursor).toBe("abc");
    expect(page.coins[0]).toMatchObject({ symbol: "AGI", state: 3, progress: 100, chainId: 4663, address: liveCoin.address });
  });

  it("parses coin detail (supply, price) via the tRPC envelope, and 404 → null", async () => {
    const c = mk((url) => {
      expect(url.pathname).toBe("/v1/trpc/coins.detail");
      return json({ result: { data: { ...liveCoin, totalSupply: "1000000000000000000000000000", price: 2.06e-7 } } });
    });
    expect(await c.getCoinDetail(liveCoin.address)).toMatchObject({ totalSupply: "1000000000000000000000000000", priceQuote: 2.06e-7 });
    const missing = mk(() => json({ error: { data: { httpStatus: 404 } } }));
    expect(await missing.getCoinDetail(liveCoin.address)).toBeNull();
  });

  it("parses trades with traders", async () => {
    const c = mk(() => json({ result: { data: { trades: [{ id: "t1", trader: "0xCA7DED7E4F4BA8AB3B10009236AE6D1B95094589", side: "buy", baseAmount: "5", quoteAmount: "7", timestamp: "1791112949", transactionHash: "0x" + "a".repeat(64), cursor: "c" }], nextCursor: "n" } } }));
    const page = await c.getTrades(liveCoin.address);
    expect(page.trades[0]).toMatchObject({ trader: "0xca7ded7e4f4ba8ab3b10009236ae6d1b95094589", timestampSec: 1791112949 });
  });

  it("treats schema drift, HTTP errors, non-JSON and oversize bodies as UNAVAILABLE (never as zero)", async () => {
    const bad = [
      mk(() => json({ coins: [{ address: "nope" }] })),
      mk(() => json({ unexpected: true })),
      mk(() => new Response("oops", { status: 500 })),
      mk(() => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })),
      new ClankTradeClient({ maxResponseBytes: 10, fetcher: (async () => json({ coins: [liveCoin] })) as typeof fetch }),
      new ClankTradeClient({ fetcher: (async () => { throw new Error("network"); }) as typeof fetch }),
    ];
    for (const c of bad) await expect(c.listCoins()).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("refuses non-https base URLs", () => {
    expect(() => new ClankTradeClient({ baseUrl: "http://example.com" })).toThrow();
  });
});

describe("Robinhood Chain ERC-20 reader (mocked JSON-RPC transport)", () => {
  const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
  function transport(handler: (selector: string, to: string) => `0x${string}`, fail = false) {
    return custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (fail) throw new Error("connection refused");
        if (method === "eth_chainId") return "0x1237";
        if (method === "eth_call") {
          const call = (params as [{ data: string; to: string }])[0];
          return handler(call.data.slice(0, 10), call.to);
        }
        throw new Error(`unexpected ${method}`);
      },
    });
  }

  it("decodes balanceOf / totalSupply / decimals", async () => {
    const reader = createRobinhoodReader({
      rpcUrl: "http://unused.invalid", chainId: 4663,
      transport: transport((sel) => (sel === "0x70a08231" ? word(123n * E18) : sel === "0x18160ddd" ? word(1_000_000_000n * E18) : word(18n))),
    });
    const tok = [{ address: TOKEN_A, decimals: 18 }];
    expect((await reader.getBalances(WALLET, tok)).get(TOKEN_A)).toBe(123n * E18);
    expect((await reader.getTotalSupplies(tok)).get(TOKEN_A)).toBe(1_000_000_000n * E18);
    expect(await reader.getDecimals(TOKEN_A)).toBe(18);
  });

  it("surfaces RPC failures as ProviderUnavailableError", async () => {
    const reader = createRobinhoodReader({ rpcUrl: "http://unused.invalid", chainId: 4663, transport: transport(() => word(0n), true) });
    await expect(reader.getBalances(WALLET, [{ address: TOKEN_A, decimals: 18 }])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
