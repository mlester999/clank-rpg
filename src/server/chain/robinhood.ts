import { createPublicClient, custom, defineChain, http, parseAbi, type PublicClient, type Transport } from "viem";

import { ProviderUnavailableError, type BalanceReader, type TokenRef } from "./types";

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

export interface RobinhoodReaderOptions {
  rpcUrl: string;
  chainId: number;
  /** Test seam: supply a viem transport instead of HTTP. */
  transport?: Transport;
}

/**
 * ERC-20 reader for Robinhood Chain over standard JSON-RPC (viem). Reads live chain state
 * only — there is no cache that could present stale balances as fresh. Any RPC failure raises
 * ProviderUnavailableError so callers can report "unavailable" instead of guessing.
 *
 * Production note: Robinhood's public RPC is rate-limited and documented as not recommended
 * for production; point ROBINHOOD_RPC_URL at a dedicated provider.
 */
export function createRobinhoodReader(opts: RobinhoodReaderOptions): BalanceReader {
  const chain = defineChain({
    id: opts.chainId,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [opts.rpcUrl] } },
  });
  const client: PublicClient = createPublicClient({
    chain,
    transport: opts.transport ?? http(opts.rpcUrl, { batch: true, timeout: 10_000, retryCount: 2 }),
  });

  const wrap = async <T,>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw new ProviderUnavailableError("Robinhood Chain RPC request failed", { cause: e });
    }
  };

  return {
    async getBalances(wallet, tokens) {
      const results = await wrap(() =>
        Promise.all(
          tokens.map((t) =>
            client.readContract({ address: t.address as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet as `0x${string}`] }),
          ),
        ),
      );
      return new Map(tokens.map((t, i) => [t.address.toLowerCase(), results[i] as bigint]));
    },
    async getTotalSupplies(tokens: readonly TokenRef[]) {
      const results = await wrap(() =>
        Promise.all(tokens.map((t) => client.readContract({ address: t.address as `0x${string}`, abi: ERC20_ABI, functionName: "totalSupply" }))),
      );
      return new Map(tokens.map((t, i) => [t.address.toLowerCase(), results[i] as bigint]));
    },
    async getDecimals(address) {
      return Number(await wrap(() => client.readContract({ address: address as `0x${string}`, abi: ERC20_ABI, functionName: "decimals" })));
    },
  };
}

export { custom };
