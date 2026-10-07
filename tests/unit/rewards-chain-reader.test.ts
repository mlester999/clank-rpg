import { custom, encodeAbiParameters, pad, toHex } from "viem";
import { describe, expect, it } from "vitest";

import { verifyManualTransfer, type ClaimRow } from "@/server/rewards/claims";
import { ChainReadError, createRpcChainReader, createSimulatedChainReader, TokenMetadataError, type RewardChainReader, type TransferFacts } from "@/server/rewards/chain";

const TOKEN = "0x52908400098527886e0f7030069857d2e4169ee7";
const OTHER_TOKEN = "0x00000000000000000000000000000000000c1a4c";
const ME = "0x8617e340b3d01fa5f11f306f4090fd50e238070d";
const PAYER = "0xde709f2102306220921060314715629080e2fb77";
const E18 = 10n ** 18n;
const CHAIN = 4663;
const HASH = `0x${"ab".repeat(32)}`;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Node {
  decimals: number;
  symbol: string;
  /** The bytecode at the token address ("0x" = no contract there). */
  code: string;
  /** decimals() / symbol() revert (not an ERC-20, or a bytes32 symbol). */
  decimalsFails?: boolean;
  symbolFails?: boolean;
  chainId: number;
  head: bigint;
  balances: Record<string, bigint>;
  tx?: { hash: string; status: "0x1" | "0x0"; block: bigint; logs: Array<{ address: string; from: string; to: string; value: bigint }>; chainId?: number };
  down?: boolean;
  calls: string[];
}
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const strWord = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

/** A tiny JSON-RPC node: just what the read-only reader asks for. */
function node(over: Partial<Node> = {}) {
  const n: Node = { decimals: 18, symbol: "CLANKRPG", code: "0x6080604052", chainId: CHAIN, head: 1000n, balances: {}, calls: [], ...over };
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      n.calls.push(method);
      if (n.down) throw new Error("connection refused");
      const p = (params ?? []) as Array<unknown>;
      switch (method) {
        case "eth_chainId": return toHex(n.chainId);
        case "eth_blockNumber": return toHex(n.head);
        case "eth_getCode": return n.code;
        case "eth_call": {
          const data = String((p[0] as { data: string }).data);
          if (data.startsWith("0x313ce567")) { if (n.decimalsFails) throw new Error("execution reverted"); return word(BigInt(n.decimals)); }
          if (data.startsWith("0x95d89b41")) { if (n.symbolFails) throw new Error("execution reverted"); return strWord(n.symbol); }
          if (data.startsWith("0x70a08231")) return word(n.balances[`0x${data.slice(-40)}`] ?? 0n);
          throw new Error(`unexpected call ${data.slice(0, 10)}`);
        }
        case "eth_getTransactionByHash": {
          if (!n.tx || p[0] !== n.tx.hash) return null;
          return { hash: n.tx.hash, nonce: "0x1", blockHash: `0x${"cd".repeat(32)}`, blockNumber: toHex(n.tx.block), transactionIndex: "0x0", from: PAYER, to: TOKEN, value: "0x0", gas: "0x5208", gasPrice: "0x1", input: "0x", type: "0x0", v: "0x1b", r: `0x${"11".repeat(32)}`, s: `0x${"22".repeat(32)}`, chainId: n.tx.chainId === undefined ? toHex(CHAIN) : toHex(n.tx.chainId) };
        }
        case "eth_getTransactionReceipt": {
          if (!n.tx || p[0] !== n.tx.hash) return null;
          return {
            transactionHash: n.tx.hash, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, blockNumber: toHex(n.tx.block), from: PAYER, to: TOKEN, cumulativeGasUsed: "0x5208", gasUsed: "0x5208", contractAddress: null, logsBloom: `0x${"00".repeat(256)}`, status: n.tx.status, effectiveGasPrice: "0x1", type: "0x0",
            logs: n.tx.logs.map((l, i) => ({ address: l.address, topics: [TRANSFER_TOPIC, pad(l.from as `0x${string}`), pad(l.to as `0x${string}`)], data: word(l.value), blockNumber: toHex(n.tx!.block), transactionHash: n.tx!.hash, transactionIndex: "0x0", blockHash: `0x${"cd".repeat(32)}`, logIndex: toHex(i), removed: false })),
          };
        }
        default: throw new Error(`unsupported ${method}`);
      }
    },
  });
  return { n, transport };
}
/** NOTHING about the token is configured except its address and the chain: decimals() and symbol() come from the contract. */
const reader = (over: Partial<Node> = {}, cfg: { now?: () => number } = {}) => {
  const { n, transport } = node(over);
  return { n, r: createRpcChainReader({ tokenAddress: TOKEN, chainId: CHAIN, rpcUrl: "https://rpc.example.org", transport, ...(cfg.now ? { now: cfg.now } : {}) }) };
};

describe("the READ-ONLY chain reader", () => {
  it("has no way to send, sign or hold a key (the interface is read methods only) — and no configured decimals", () => {
    const { r } = reader();
    expect(Object.keys(r).sort()).toEqual(["adapter", "balanceOf", "chainId", "checkHealth", "getTransfer", "metadata", "tokenAddress"]);
    for (const k of Object.keys(r)) expect(k).not.toMatch(/send|sign|key|broadcast|approve|write/i);
  });

  it("reads ERC-20 balanceOf on the official token, after verifying the CONTRACT (chain id, bytecode, decimals(), symbol())", async () => {
    const { n, r } = reader({ balances: { [ME]: 1_284_500n * E18 } });
    expect(await r.balanceOf(ME)).toBe(1_284_500n * E18);
    for (const m of ["eth_chainId", "eth_getCode"]) expect(n.calls).toContain(m);
    expect(await r.metadata()).toEqual({ decimals: 18, symbol: "CLANKRPG" });
  });

  it("the CONTRACT is authoritative for decimals: any 0–36 value it reports is used as-is (6, 9, 18 …), nothing is compared with a setting", async () => {
    for (const decimals of [0, 6, 9, 18, 36]) {
      const { r } = reader({ decimals, balances: { [ME]: 5n } });
      expect(await r.metadata()).toEqual({ decimals, symbol: "CLANKRPG" });
      expect(await r.balanceOf(ME)).toBe(5n);
    }
  });

  it("FAILS CLOSED when the contract cannot be verified: no bytecode, unreadable decimals(), absurd decimals(), unreadable or empty symbol()", async () => {
    await expect(reader({ code: "0x" }).r.metadata()).rejects.toThrow(/No contract is deployed/);
    await expect(reader({ code: "0x" }).r.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
    await expect(reader({ decimalsFails: true }).r.metadata()).rejects.toBeInstanceOf(ChainReadError);
    await expect(reader({ decimals: 77 }).r.metadata()).rejects.toThrow(/outside 0–36/);
    await expect(reader({ symbolFails: true }).r.metadata()).rejects.toThrow(/no readable symbol/);
    await expect(reader({ symbol: "" }).r.metadata()).rejects.toThrow(/symbol\(\) is empty or unusable/);
    await expect(reader({ symbol: "  " }).r.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
  });

  it("verifies the metadata once and reuses it (the chain is not asked twice per balance); a failure is remembered briefly, then re-checked; a good answer is refreshed hourly", async () => {
    let t = 1_000_000;
    const { n, r } = reader({ balances: { [ME]: 1n } }, { now: () => t });
    await r.balanceOf(ME);
    const callsAfterFirst = n.calls.filter((m) => m === "eth_call").length;
    await r.balanceOf(ME);
    // only the balanceOf eth_call was added the second time (decimals/symbol are cached)
    expect(n.calls.filter((m) => m === "eth_call").length).toBe(callsAfterFirst + 1);
    // after an hour the contract is asked again — and whatever it now says is what counts (no stale decimals forever)
    t += 61 * 60_000;
    n.decimals = 8;
    expect(await r.metadata()).toEqual({ decimals: 8, symbol: "CLANKRPG" });
    // the contract goes away (no bytecode): fails closed, is remembered for 5 minutes (no new chain calls), then re-checked and recovered
    t += 61 * 60_000;
    n.code = "0x";
    await expect(r.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
    const before = n.calls.length;
    await expect(r.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
    expect(n.calls.length).toBe(before);
    t += 6 * 60_000;
    n.code = "0x6080604052";
    n.decimals = 18;
    expect(await r.balanceOf(ME)).toBe(1n);
  });

  it("refuses an endpoint on a different chain and reports an outage as a ChainReadError — never a guessed balance", async () => {
    const wrongChain = reader({ chainId: 1 });
    await expect(wrongChain.r.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
    const down = reader({ down: true });
    await expect(down.r.balanceOf(ME)).rejects.toBeInstanceOf(ChainReadError);
    expect(await down.r.checkHealth()).toMatchObject({ rpcAvailable: false, metadataStatus: "UNVERIFIED" });
  });

  it("checkHealth reports the contract's own symbol and decimals for the admin status panel (nothing typed in anywhere)", async () => {
    const { r } = reader({ decimals: 9 });
    expect(await r.checkHealth()).toEqual({ rpcAvailable: true, chainIdMatches: true, hasCode: true, onChainDecimals: 9, onChainSymbol: "CLANKRPG", metadataStatus: "VERIFIED", error: null });
    expect(await reader({ chainId: 7 }).r.checkHealth()).toMatchObject({ rpcAvailable: true, chainIdMatches: false });
    expect(await reader({ code: "0x" }).r.checkHealth()).toMatchObject({ rpcAvailable: true, hasCode: false, metadataStatus: "FAILED" });
    expect(await reader({ symbolFails: true }).r.checkHealth()).toMatchObject({ metadataStatus: "FAILED", onChainDecimals: null });
  });

  it("returns the mined facts of a transaction: status, confirmations, chain, and every ERC-20 Transfer in the receipt", async () => {
    const { r } = reader({ head: 1004n, tx: { hash: HASH, status: "0x1", block: 1000n, logs: [{ address: TOKEN, from: PAYER, to: ME, value: 42n * E18 }] } });
    const f = (await r.getTransfer(HASH))!;
    expect(f).toMatchObject({ hash: HASH, status: "success", confirmations: 5, chainId: CHAIN });
    expect(f.transfers).toEqual([{ token: TOKEN, from: PAYER, to: ME, value: 42n * E18 }]);
  });

  it("an unknown transaction is null (not mined / never sent); an outage while asking is an error, not 'unknown'", async () => {
    expect(await reader().r.getTransfer(HASH)).toBeNull();
    await expect(reader({ down: true }).r.getTransfer(HASH)).rejects.toBeInstanceOf(ChainReadError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Verifying a manual payout against the claim's FROZEN amount and destination
// ---------------------------------------------------------------------------------------------------------------------
const claim = { destination_address: ME, token_address: TOKEN, chain_id: CHAIN, amount_raw: (25_000n * E18).toString() } as Pick<ClaimRow, "destination_address" | "token_address" | "chain_id" | "amount_raw">;
const facts = (over: Partial<TransferFacts> = {}): TransferFacts => ({ hash: HASH, status: "success", blockNumber: 1000n, confirmations: 5, chainId: CHAIN, from: PAYER, to: TOKEN, input: "0x", transfers: [{ token: TOKEN, from: PAYER, to: ME, value: 25_000n * E18 }], ...over });

describe("manual payout verification: the chain must show EXACTLY this claim being paid", () => {
  it("a successful Transfer of the official token, to the claim's destination, for the claim's amount, is accepted", () => {
    const r = verifyManualTransfer(facts(), claim, 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.details).toMatchObject({ to: ME, token: TOKEN, value: (25_000n * E18).toString(), confirmations: 5 });
  });
  it("who SENT it does not matter (an admin may pay from a multisig or any wallet) — what it paid does", () => {
    expect(verifyManualTransfer(facts({ from: "0x00000000000000000000000000000000000000aa", transfers: [{ token: TOKEN, from: "0x00000000000000000000000000000000000000aa", to: ME, value: 25_000n * E18 }] }), claim, 2).ok).toBe(true);
  });
  it("a failed (reverted) transaction is rejected", () => {
    expect(verifyManualTransfer(facts({ status: "reverted", transfers: [] }), claim, 2)).toMatchObject({ ok: false, problem: "REVERTED" });
  });
  it("the wrong chain is rejected", () => {
    expect(verifyManualTransfer(facts({ chainId: 1 }), claim, 2)).toMatchObject({ ok: false, problem: "WRONG_CHAIN" });
  });
  it("the wrong TOKEN contract is rejected (a Transfer of some other coin proves nothing)", () => {
    expect(verifyManualTransfer(facts({ transfers: [{ token: OTHER_TOKEN, from: PAYER, to: ME, value: 25_000n * E18 }] }), claim, 2)).toMatchObject({ ok: false, problem: "WRONG_TOKEN" });
    expect(verifyManualTransfer(facts({ transfers: [] }), claim, 2)).toMatchObject({ ok: false, problem: "WRONG_TOKEN" });
  });
  it("the wrong RECIPIENT is rejected", () => {
    expect(verifyManualTransfer(facts({ transfers: [{ token: TOKEN, from: PAYER, to: PAYER, value: 25_000n * E18 }] }), claim, 2)).toMatchObject({ ok: false, problem: "WRONG_RECIPIENT" });
  });
  it("the wrong AMOUNT is rejected — one base unit off is still wrong (no 'close enough')", () => {
    for (const value of [25_000n * E18 - 1n, 25_000n * E18 + 1n, 1n]) expect(verifyManualTransfer(facts({ transfers: [{ token: TOKEN, from: PAYER, to: ME, value }] }), claim, 2)).toMatchObject({ ok: false, problem: "WRONG_AMOUNT" });
  });
  it("a batch payment is fine when ONE of its Transfers matches this claim exactly", () => {
    const batch = facts({ transfers: [{ token: TOKEN, from: PAYER, to: PAYER, value: 1n }, { token: TOKEN, from: PAYER, to: ME, value: 25_000n * E18 }, { token: OTHER_TOKEN, from: PAYER, to: ME, value: 25_000n * E18 }] });
    expect(verifyManualTransfer(batch, claim, 2).ok).toBe(true);
  });
  it("too few confirmations is NOT_CONFIRMED (the claim stays PENDING and the admin can retry shortly)", () => {
    expect(verifyManualTransfer(facts({ confirmations: 1 }), claim, 2)).toMatchObject({ ok: false, problem: "NOT_CONFIRMED" });
    expect(verifyManualTransfer(facts({ confirmations: 2 }), claim, 2).ok).toBe(true);
  });
});

describe("the simulated chain (dev / QA / tests only)", () => {
  const sim = (): ReturnType<typeof createSimulatedChainReader> => createSimulatedChainReader({ tokenAddress: TOKEN, decimals: 18, chainId: CHAIN });
  it("simulates an admin's manual payout, wrong-token / reverted / unmined variants, and an unverifiable contract", async () => {
    const s: RewardChainReader & ReturnType<typeof sim> = sim();
    const ok = s.sendTransfer({ to: ME, amountRaw: 5n });
    expect(verifyManualTransfer((await s.getTransfer(ok.hash))!, { ...claim, amount_raw: "5" }, 1).ok).toBe(true);
    const wrongToken = s.sendTransfer({ to: ME, amountRaw: 5n, token: OTHER_TOKEN });
    expect(verifyManualTransfer((await s.getTransfer(wrongToken.hash))!, { ...claim, amount_raw: "5" }, 1)).toMatchObject({ ok: false, problem: "WRONG_TOKEN" });
    const reverted = s.sendTransfer({ to: ME, amountRaw: 5n, status: "reverted" });
    expect(verifyManualTransfer((await s.getTransfer(reverted.hash))!, { ...claim, amount_raw: "5" }, 1)).toMatchObject({ ok: false, problem: "REVERTED" });
    const unmined = s.sendTransfer({ to: ME, amountRaw: 5n, mined: false });
    expect(await s.getTransfer(unmined.hash)).toBeNull();
    s.mine(unmined.hash);
    expect(await s.getTransfer(unmined.hash)).not.toBeNull();
    // the simulated CONTRACT can report other decimals (the app follows it) or become unverifiable (everything token-dependent fails closed)
    s.setMetadata({ decimals: 6 });
    expect(await s.metadata()).toEqual({ decimals: 6, symbol: "CLANKRPG" });
    s.setMetadata(null);
    await expect(s.balanceOf(ME)).rejects.toBeInstanceOf(TokenMetadataError);
    await expect(s.metadata()).rejects.toBeInstanceOf(TokenMetadataError);
    expect(await s.checkHealth()).toMatchObject({ metadataStatus: "FAILED" });
  });
});
