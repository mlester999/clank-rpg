/**
 * Read-only live check of the two external data sources the holdings system depends on.
 * Makes only GET / eth_call requests; writes nothing; prints what is actually reachable.
 *
 *   pnpm chain:probe
 */
import { ClankTradeClient, isBondedObserved } from "../src/server/chain/clankTrade";
import { createRobinhoodReader } from "../src/server/chain/robinhood";
import { getEnv } from "../src/server/env";

import { loadLocalEnv } from "./lib/context";

loadLocalEnv();
const env = getEnv();
const results: Array<[string, boolean, string]> = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, e instanceof Error ? e.message : String(e)]);
  }
};

await check("Robinhood RPC chain id", async () => {
  const res = await fetch(env.ROBINHOOD_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const id = parseInt(((await res.json()) as { result: string }).result, 16);
  if (id !== env.ROBINHOOD_CHAIN_ID) throw new Error(`chain id ${id} ≠ configured ${env.ROBINHOOD_CHAIN_ID}`);
  return `${id} (${env.ROBINHOOD_RPC_URL})`;
});

const client = new ClankTradeClient({ baseUrl: env.CLANK_TRADE_API_URL, chainId: env.ROBINHOOD_CHAIN_ID });
let bondedAddr: string | null = null;
await check("Clank.trade catalog", async () => {
  let cursor: string | undefined;
  let seen = 0;
  let bonded = 0;
  for (let p = 0; p < 40; p++) {
    const page = await client.listCoins(cursor);
    seen += page.coins.length;
    for (const c of page.coins) if (isBondedObserved(c)) { bonded++; bondedAddr ??= c.address; }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return `${seen} coins, ${bonded} observed as bonded (state 3 / progress 100)`;
});

if (bondedAddr) {
  const addr = bondedAddr as string;
  await check("Clank.trade coin detail", async () => {
    const d = await client.getCoinDetail(addr);
    return d ? `${d.symbol}: supply ${d.totalSupply}, price ${d.priceQuote} ${d.quoteSymbol}` : "not found";
  });
  await check("Clank.trade trades (trader field)", async () => {
    const t = await client.getTrades(addr);
    return `${t.trades.length} trades, ${t.trades.filter((x) => x.trader).length} with a trader address`;
  });
  await check("ERC-20 totalSupply via RPC == API supply", async () => {
    const reader = createRobinhoodReader({ rpcUrl: env.ROBINHOOD_RPC_URL, chainId: env.ROBINHOOD_CHAIN_ID });
    const onchain = (await reader.getTotalSupplies([{ address: addr, decimals: 18 }])).get(addr);
    const api = (await client.getCoinDetail(addr))?.totalSupply;
    if (String(onchain) !== api) throw new Error(`mismatch: chain ${onchain} vs api ${api}`);
    return `${onchain} (matches)`;
  });
  await check("ERC-20 decimals + balanceOf(zero address)", async () => {
    const reader = createRobinhoodReader({ rpcUrl: env.ROBINHOOD_RPC_URL, chainId: env.ROBINHOOD_CHAIN_ID });
    const d = await reader.getDecimals(addr);
    const b = (await reader.getBalances("0x0000000000000000000000000000000000000000", [{ address: addr, decimals: d }])).get(addr);
    return `decimals ${d}, balanceOf(0x0) = ${b}`;
  });
}

for (const [name, ok, detail] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
process.exitCode = results.every((r) => r[1]) ? 0 : 1;
