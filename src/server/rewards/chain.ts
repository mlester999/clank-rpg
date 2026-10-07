import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http, parseEventLogs, type PublicClient, type Transport } from "viem";

/**
 * The READ-ONLY chain seam for $CLANKRPG. It can read balances, token metadata and transactions — and nothing else: there is no
 * send, no sign, no key. Payouts are made by hand by an admin; this only lets the server (a) verify a holder's balance and
 * (b) check that a transaction an admin names really paid a claim.
 *
 * Trust model: the chain is the only authority, and the CONTRACT is the only authority for the token's metadata. Nothing about the
 * token is configured except its address: `decimals()` and `symbol()` are read from the contract (after checking the chain id and
 * that bytecode exists at that address). A read that cannot be answered throws — a guessed or cached-forever value is never
 * returned — so when the metadata cannot be verified, holder verification and payout verification fail CLOSED.
 */
export class ChainReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChainReadError";
  }
}
/** Kept as the name balance reads have always thrown. */
export { ChainReadError as HolderReadError };

/** The token cannot be verified as the official contract (wrong chain, no contract at the address, unreadable decimals()/symbol()): every token-dependent feature is closed until it can. */
export class TokenMetadataError extends ChainReadError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TokenMetadataError";
  }
}
/** Kept as the name a wrong chain / wrong contract has always thrown. */
export { TokenMetadataError as TokenConfigMismatchError };

/** What the CONTRACT says about itself — verified, never configured. */
export interface TokenMetadata {
  /** `decimals()`: an integer 0–36. The only authority for converting a logical reward amount to raw units. */
  decimals: number;
  /** `symbol()`: a non-empty string. */
  symbol: string;
}

export interface TransferFacts {
  hash: string;
  status: "success" | "reverted";
  blockNumber: bigint;
  /** Blocks on top of (and including) the one that mined it. */
  confirmations: number;
  /** Chain id embedded in the signed transaction (null for a legacy, pre-EIP-155 one). */
  chainId: number | null;
  from: string;
  to: string | null;
  input: string;
  /** ERC-20 Transfer events in the receipt, emitted by any contract. */
  transfers: Array<{ token: string; from: string; to: string; value: bigint }>;
}

export interface TokenHealth {
  rpcAvailable: boolean;
  /** The endpoint's chain id equals the configured one (null when unreachable). */
  chainIdMatches: boolean | null;
  /** Bytecode exists at the token address (null when it could not be asked). */
  hasCode: boolean | null;
  onChainDecimals: number | null;
  onChainSymbol: string | null;
  /** VERIFIED = chain id, bytecode, decimals() and symbol() all check out. FAILED = the contract answered but is not a usable token. UNVERIFIED = it could not be asked. */
  metadataStatus: "VERIFIED" | "FAILED" | "UNVERIFIED";
  error: string | null;
}

export interface RewardChainReader {
  readonly adapter: "rpc" | "simulated";
  readonly tokenAddress: string;
  readonly chainId: number;
  /** The contract's VERIFIED metadata (cached: an hour when good, five minutes when bad). Throws TokenMetadataError / ChainReadError — never a guess. */
  metadata(): Promise<TokenMetadata>;
  /** ERC-20 balanceOf(address) in the token's raw units, after the metadata check. Throws ChainReadError — never a guessed value. */
  balanceOf(address: string): Promise<bigint>;
  /** Fresh health + metadata check for the admin status (bypasses the metadata cache and refreshes it). */
  checkHealth(): Promise<TokenHealth>;
  /** The mined facts of a transaction, or null when the network does not know it (yet). Throws ChainReadError when it cannot be asked. */
  getTransfer(txHash: string): Promise<TransferFacts | null>;
}

const META_OK_MS = 60 * 60_000;
const META_BAD_MS = 5 * 60_000;
const notFound = (error: unknown, names: string[]): boolean => {
  let cur: unknown = error;
  for (let i = 0; i < 8 && cur && typeof cur === "object"; i++) {
    const n = (cur as { name?: string }).name;
    if (n !== undefined && names.includes(n)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
};

export function createRpcChainReader(cfg: { tokenAddress: string; chainId: number; rpcUrl: string; transport?: Transport; now?: () => number }): RewardChainReader {
  const chain = defineChain({ id: cfg.chainId, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [cfg.rpcUrl] } } });
  const client: PublicClient = createPublicClient({ chain, transport: cfg.transport ?? http(cfg.rpcUrl, { batch: false, timeout: 10_000, retryCount: 1 }) });
  const token = cfg.tokenAddress as `0x${string}`;
  const now = cfg.now ?? Date.now;
  let cache: { at: number; ok: boolean; meta?: TokenMetadata; reason?: string } | null = null;

  const read = async <T,>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ChainReadError) throw e;
      throw new ChainReadError(`${what} could not be read`, { cause: e });
    }
  };
  const assertChain = async (): Promise<void> => {
    if ((await read("The chain id", () => client.getChainId())) !== cfg.chainId) throw new TokenMetadataError("The endpoint reports an unexpected chain id");
  };
  /** Chain id → bytecode at the address → decimals() → symbol(). Any step failing means this is not (yet) a verifiable token. */
  const fetchMetadata = async (): Promise<TokenMetadata> => {
    const code = await read("The contract code", () => client.getCode({ address: token }));
    if (!code || code === "0x") throw new TokenMetadataError("No contract is deployed at the official token address on this chain");
    const decimals = Number(await read("The token decimals", () => client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })));
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new TokenMetadataError("The token reports decimals() outside 0–36");
    let symbol: unknown;
    try {
      symbol = await client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" });
    } catch (e) {
      throw new TokenMetadataError("The token has no readable symbol()", { cause: e });
    }
    if (typeof symbol !== "string" || symbol.trim().length === 0 || symbol.length > 40) throw new TokenMetadataError("The token's symbol() is empty or unusable");
    return { decimals, symbol: symbol.trim() };
  };
  /** Verified once per hour (a failure is remembered for 5 minutes): every balance read asks, the chain is hit rarely. */
  const verified = async (): Promise<TokenMetadata> => {
    const t = now();
    if (cache && cache.ok && t - cache.at < META_OK_MS) return cache.meta as TokenMetadata;
    if (cache && !cache.ok && t - cache.at < META_BAD_MS) throw new TokenMetadataError(cache.reason ?? "The token metadata could not be verified");
    await assertChain();
    try {
      const meta = await fetchMetadata();
      cache = { at: t, ok: true, meta };
      return meta;
    } catch (e) {
      // A contract that answered "no" is remembered briefly; an unreachable endpoint is NOT cached (the next read just tries again).
      if (e instanceof TokenMetadataError) cache = { at: t, ok: false, reason: e.message };
      throw e;
    }
  };

  return {
    adapter: "rpc",
    tokenAddress: cfg.tokenAddress,
    chainId: cfg.chainId,
    metadata: verified,
    async balanceOf(address) {
      await verified();
      return read("The balance", () => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [address as `0x${string}`] }));
    },
    async checkHealth() {
      const out: TokenHealth = { rpcAvailable: false, chainIdMatches: null, hasCode: null, onChainDecimals: null, onChainSymbol: null, metadataStatus: "UNVERIFIED", error: null };
      try {
        out.chainIdMatches = (await client.getChainId()) === cfg.chainId;
        out.rpcAvailable = true;
        if (!out.chainIdMatches) {
          out.error = "The RPC endpoint reports a different chain id than ROBINHOOD_CHAIN_ID.";
          return out;
        }
        try {
          const meta = await fetchMetadata();
          out.hasCode = true;
          out.onChainDecimals = meta.decimals;
          out.onChainSymbol = meta.symbol;
          out.metadataStatus = "VERIFIED";
          cache = { at: now(), ok: true, meta };
        } catch (e) {
          if (e instanceof TokenMetadataError) {
            out.metadataStatus = "FAILED";
            out.hasCode = /no contract is deployed/i.test(e.message) ? false : true;
            out.error = e.message;
            cache = { at: now(), ok: false, reason: e.message };
          } else throw e;
        }
      } catch (e) {
        out.error = e instanceof Error ? e.message.slice(0, 160) : "The chain could not be read";
      }
      return out;
    },
    async getTransfer(txHash) {
      const hash = txHash as `0x${string}`;
      await assertChain();
      let tx;
      try {
        tx = await client.getTransaction({ hash });
      } catch (e) {
        if (notFound(e, ["TransactionNotFoundError"])) return null;
        throw new ChainReadError("The transaction could not be read", { cause: e });
      }
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash });
      } catch (e) {
        if (notFound(e, ["TransactionReceiptNotFoundError"])) return null;
        throw new ChainReadError("The receipt could not be read", { cause: e });
      }
      const head = await read("The block number", () => client.getBlockNumber());
      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs }).map((l) => ({ token: l.address.toLowerCase(), from: l.args.from.toLowerCase(), to: l.args.to.toLowerCase(), value: l.args.value }));
      return {
        hash: tx.hash,
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        confirmations: head >= receipt.blockNumber ? Number(head - receipt.blockNumber) + 1 : 0,
        chainId: typeof tx.chainId === "number" ? tx.chainId : null,
        from: tx.from.toLowerCase(),
        to: tx.to ? tx.to.toLowerCase() : null,
        input: tx.input,
        transfers,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulated chain: an in-memory token for local development, QA and tests. Deterministic; refused in production by config.ts.
// ---------------------------------------------------------------------------------------------------------------------
export interface SimulatedTransferInput {
  to: string;
  amountRaw: bigint;
  from?: string;
  status?: "success" | "reverted";
  /** Which token contract emitted the Transfer (default: the configured token). Use another address to simulate a wrong-token payment. */
  token?: string;
  /** The chain id the transaction reports (default: the configured one). */
  chainId?: number;
  /** Mine it into a block already (default true). A not-yet-mined transfer is unknown to getTransfer. */
  mined?: boolean;
}

/** What the simulated CONTRACT reports about itself (tests / dev QA choose it; it is never read from the environment). */
export const SIMULATED_CONTRACT_DECIMALS = 18;
export const SIMULATED_CONTRACT_SYMBOL = "CLANKRPG";

export interface SimulatedChainReader extends RewardChainReader {
  readonly balances: Map<string, bigint>;
  setBalance(address: string, raw: bigint): void;
  /** The next balance read throws (an RPC outage). */
  failNext(): void;
  /** Every read throws until `false` (a longer outage). */
  setOutage(down: boolean): void;
  readonly reads: number;
  /** Change what the "contract" reports; `null` = the contract cannot be verified at all (no code / unreadable decimals()). */
  setMetadata(meta: Partial<TokenMetadata> | null): void;
  /** Creates a transfer as if an admin had paid it by hand; returns its (fake) hash. */
  sendTransfer(input: SimulatedTransferInput): { hash: string };
  /** Mines a not-yet-mined transfer. */
  mine(hash: string): void;
  /** Adds blocks on top of the chain head (confirmations grow). */
  advance(blocks?: number): void;
  readonly transferLookups: number;
}

export function createSimulatedChainReader(meta: { tokenAddress: string; chainId: number; decimals?: number; symbol?: string }, balances: Map<string, bigint> = new Map()): SimulatedChainReader {
  let failOnce = false;
  let outage = false;
  let reads = 0;
  let lookups = 0;
  let head = 1000n;
  let seq = 0;
  let metadata: TokenMetadata | null = { decimals: meta.decimals ?? SIMULATED_CONTRACT_DECIMALS, symbol: meta.symbol ?? SIMULATED_CONTRACT_SYMBOL };
  const txs = new Map<string, TransferFacts & { mined: boolean }>();

  const down = (): never => {
    throw new ChainReadError("simulated outage");
  };
  const verified = (): TokenMetadata => {
    if (outage) down();
    if (!metadata) throw new TokenMetadataError("simulated: the token contract cannot be verified");
    return metadata;
  };
  return {
    adapter: "simulated",
    tokenAddress: meta.tokenAddress,
    chainId: meta.chainId,
    balances,
    setBalance: (a, raw) => void balances.set(a.toLowerCase(), raw),
    failNext: () => void (failOnce = true),
    setOutage: (v) => void (outage = v),
    get reads() {
      return reads;
    },
    get transferLookups() {
      return lookups;
    },
    setMetadata: (m) => void (metadata = m === null ? null : { ...(metadata ?? { decimals: SIMULATED_CONTRACT_DECIMALS, symbol: SIMULATED_CONTRACT_SYMBOL }), ...m }),
    advance: (blocks = 1) => void (head += BigInt(blocks)),
    mine(hash) {
      const t = txs.get(hash);
      if (t && !t.mined) {
        head += 1n;
        t.mined = true;
        t.blockNumber = head;
      }
    },
    sendTransfer(input) {
      seq += 1;
      const hash = `0x${seq.toString(16).padStart(64, "0")}`;
      const token = (input.token ?? meta.tokenAddress).toLowerCase();
      const to = input.to.toLowerCase();
      const from = (input.from ?? "0x00000000000000000000000000000000007ea5e1").toLowerCase();
      const status = input.status ?? "success";
      const mined = input.mined ?? true;
      if (mined) head += 1n;
      if (status === "success" && token === meta.tokenAddress.toLowerCase()) {
        balances.set(from, (balances.get(from) ?? 0n) - input.amountRaw);
        balances.set(to, (balances.get(to) ?? 0n) + input.amountRaw);
      }
      txs.set(hash, {
        hash,
        status,
        blockNumber: head,
        confirmations: 0,
        chainId: input.chainId ?? meta.chainId,
        from,
        to: token,
        input: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, input.amountRaw] }),
        transfers: status === "success" ? [{ token, from, to, value: input.amountRaw }] : [],
        mined,
      });
      return { hash };
    },
    async balanceOf(address) {
      reads++;
      if (outage) down();
      if (failOnce) {
        failOnce = false;
        down();
      }
      verified();
      return balances.get(address.toLowerCase()) ?? 0n;
    },
    async metadata() {
      return verified();
    },
    async checkHealth() {
      if (outage) return { rpcAvailable: false, chainIdMatches: null, hasCode: null, onChainDecimals: null, onChainSymbol: null, metadataStatus: "UNVERIFIED", error: "simulated outage" };
      if (!metadata) return { rpcAvailable: true, chainIdMatches: true, hasCode: false, onChainDecimals: null, onChainSymbol: null, metadataStatus: "FAILED", error: "simulated: the token contract cannot be verified" };
      return { rpcAvailable: true, chainIdMatches: true, hasCode: true, onChainDecimals: metadata.decimals, onChainSymbol: metadata.symbol, metadataStatus: "VERIFIED", error: null };
    },
    async getTransfer(hash) {
      lookups++;
      if (outage) down();
      const t = txs.get(hash);
      if (!t || !t.mined) return null;
      return { ...t, confirmations: Number(head - t.blockNumber) + 1 };
    },
  };
}
