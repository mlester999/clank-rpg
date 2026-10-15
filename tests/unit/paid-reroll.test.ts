import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialPaidFlow, paidFlowReducer, type PaidAction, type PaidFlow } from "@/components/character/paidRerollFlow";
import { connectAccount, ensureChain, linkWallet, sendPayment, WALLET_MESSAGE, WalletError, type Eip1193 } from "@/components/character/walletClient";
import { chainIdHex, checkPayment, PAID_BLOCK_MESSAGE, PAYMENT_PROBLEM_MESSAGE, paidMemberActor, TX_HASH, type PaymentExpectation, type PaymentFacts } from "@/domain/hero/paidReroll";

/**
 * THE PAID REROLL — the pure rules: what counts as a payment, the flow that never asks for a second one, and the wallet steps against a fake wallet.
 */
const TOKEN = "0x00000000000000000000000000000000000c1a4c";
const TREASURY = "0xde709f2102306220921060314715629080e2fb77";
const ME = "0x52908400098527886e0f7030069857d2e4169ee7";
const OTHER = "0x8617e340b3d01fa5f11f306f4090fd50e238070d";
const PRICE = 100_000n * 10n ** 18n;
const expectation = (over: Partial<PaymentExpectation> = {}): PaymentExpectation => ({ token: TOKEN, recipient: TREASURY, requiredRaw: PRICE, payers: [ME], chainId: 4663, ...over });
const facts = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({ status: "success", chainId: 4663, transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: PRICE }], ...over });

describe("checkPayment — only the chain's own facts decide", () => {
  it("accepts exactly the price, and more (an overpayment is one reroll), from a linked wallet, in the official token, to the treasury", () => {
    expect(checkPayment(facts(), expectation())).toEqual({ ok: true, payer: ME, amountRaw: PRICE });
    expect(checkPayment(facts({ transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: PRICE * 5n }] }), expectation())).toMatchObject({ ok: true, amountRaw: PRICE * 5n });
    expect(checkPayment(facts({ chainId: null }), expectation())).toMatchObject({ ok: true }); // a legacy transaction without an embedded chain id is judged on its transfers
  });

  it.each([
    ["REVERTED", facts({ status: "reverted" })],
    ["WRONG_CHAIN", facts({ chainId: 1 })],
    ["NOT_TO_TREASURY", facts({ transfers: [{ token: TOKEN, from: ME, to: OTHER, value: PRICE }] })],
    ["NOT_TO_TREASURY", facts({ transfers: [] })],
    ["WRONG_TOKEN", facts({ transfers: [{ token: "0x00000000000000000000000000000000deadbeef", from: ME, to: TREASURY, value: PRICE }] })],
    ["WRONG_PAYER", facts({ transfers: [{ token: TOKEN, from: OTHER, to: TREASURY, value: PRICE }] })],
    ["TOO_LITTLE", facts({ transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: PRICE - 1n }] })],
  ] as const)("%s", (reason, f) => {
    expect(checkPayment(f, expectation())).toEqual({ ok: false, reason });
    expect(PAYMENT_PROBLEM_MESSAGE[reason].length).toBeGreaterThan(10);
  });

  it("splits of one payment count together (two transfers in one transaction), but only from the SAME wallet — wallets do not pool", () => {
    const half = PRICE / 2n;
    expect(checkPayment(facts({ transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: half }, { token: TOKEN, from: ME, to: TREASURY, value: half }] }), expectation())).toMatchObject({ ok: true, payer: ME });
    expect(checkPayment(facts({ transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: half }, { token: TOKEN, from: OTHER, to: TREASURY, value: half }] }), expectation({ payers: [ME, OTHER] }))).toEqual({ ok: false, reason: "TOO_LITTLE" });
  });

  it("a stranger's payment in the same transaction does not make up for a short one of the member's own", () => {
    const f = facts({ transfers: [{ token: TOKEN, from: ME, to: TREASURY, value: PRICE / 2n }, { token: TOKEN, from: OTHER, to: TREASURY, value: PRICE }] });
    expect(checkPayment(f, expectation({ payers: [ME] }))).toEqual({ ok: false, reason: "TOO_LITTLE" });
  });

  it("every problem and every block has a message for the member", () => {
    for (const reason of ["REVERTED", "WRONG_CHAIN", "NOT_TO_TREASURY", "WRONG_TOKEN", "WRONG_PAYER", "TOO_LITTLE"] as const) expect(PAYMENT_PROBLEM_MESSAGE[reason]).toBeTruthy();
    for (const block of ["NOT_SIGNED_IN", "NO_HERO", "NOT_CLAIMED", "HERO_UNAVAILABLE", "HERO_IN_ARENA"] as const) expect(PAID_BLOCK_MESSAGE[block]).toBeTruthy();
  });
});

describe("small helpers", () => {
  it("the paid actor is NOT the free reroll's `member:` prefix (its database check looks for that one)", () => {
    expect(paidMemberActor(42)).toBe("member-paid:42");
    expect(paidMemberActor(42).startsWith("member:")).toBe(false);
  });
  it("transaction hashes are 0x + 64 hex; chain ids are hex for the wallet", () => {
    expect(TX_HASH.test(`0x${"a".repeat(64)}`)).toBe(true);
    for (const bad of ["0x123", `0x${"g".repeat(64)}`, `${"a".repeat(64)}`, `0x${"a".repeat(65)}`]) expect(TX_HASH.test(bad), bad).toBe(false);
    expect(chainIdHex(4663)).toBe("0x1237");
  });
});

describe("the flow: nothing is asked of the wallet until confirmed, and after payment there is never a second payment", () => {
  const run = (actions: PaidAction[], from: PaidFlow = initialPaidFlow): PaidFlow => actions.reduce(paidFlowReducer, from);
  const KEY = "11111111-1111-4111-8111-111111111111";
  const HASH = `0x${"ab".repeat(32)}`;

  it("OPEN only opens the confirmation; START needs the acknowledgement; a second START (a double click) does nothing", () => {
    const open = run([{ type: "OPEN", requestId: KEY }]);
    expect(open).toEqual({ step: "confirm", requestId: KEY, acknowledged: false, error: null });
    expect(run([{ type: "START" }], open)).toBe(open);
    const ack = run([{ type: "TOGGLE_ACK" }], open);
    const wallet = run([{ type: "START" }], ack);
    expect(wallet).toEqual({ step: "wallet", requestId: KEY, phase: "CONNECT" });
    expect(run([{ type: "START" }], wallet)).toBe(wallet);
    expect(run([{ type: "OPEN", requestId: "x" }], wallet)).toBe(wallet);
  });

  it("while the wallet is open or the payment is being verified, Cancel does nothing", () => {
    const wallet = run([{ type: "OPEN", requestId: KEY }, { type: "TOGGLE_ACK" }, { type: "START" }]);
    expect(run([{ type: "CANCEL" }], wallet)).toBe(wallet);
    const paid = run([{ type: "PAID", txHash: HASH }], wallet);
    expect(paid).toMatchObject({ step: "verifying", txHash: HASH, busy: true, problem: null });
    expect(run([{ type: "CANCEL" }], paid)).toBe(paid);
    expect(run([{ type: "CANCEL" }, { type: "OPEN", requestId: "again" }, { type: "START" }], paid)).toBe(paid);
  });

  it("a refusal BEFORE the payment goes back to the confirmation, acknowledgement cleared, retryable; a refusal AFTER it stays on the payment — never back to a new one", () => {
    const wallet = run([{ type: "OPEN", requestId: KEY }, { type: "TOGGLE_ACK" }, { type: "START" }]);
    const back = run([{ type: "REFUSED", problem: { code: "REJECTED", message: "cancelled", retryable: true } }], wallet);
    expect(back).toEqual({ step: "confirm", requestId: KEY, acknowledged: false, error: { code: "REJECTED", message: "cancelled", retryable: true } });
    expect(run([{ type: "START" }], back)).toBe(back); // the acknowledgement is asked for again
    expect(run([{ type: "TOGGLE_ACK" }, { type: "START" }], back).step).toBe("wallet");

    const paid = run([{ type: "PAID", txHash: HASH }], wallet);
    const safe = run([{ type: "REFUSED", problem: { code: "HERO_IN_ARENA", message: "safe", retryable: false } }], paid);
    expect(safe).toMatchObject({ step: "verifying", txHash: HASH, busy: false, problem: { code: "HERO_IN_ARENA" } });
    expect(run([{ type: "START" }], safe)).toBe(safe);
    expect(run([{ type: "CLOSE_PROBLEM" }], safe)).toBe(initialPaidFlow);
    expect(run([{ type: "CLOSE_PROBLEM" }], paid)).toBe(paid); // a payment still being verified cannot be closed away
  });

  it("PENDING shows the confirmation count, a lost answer offers 'check again' (not a new payment), and only a server-confirmed result becomes a result", () => {
    const paid = run([{ type: "OPEN", requestId: KEY }, { type: "TOGGLE_ACK" }, { type: "START" }, { type: "PAID", txHash: HASH }]);
    const pending = run([{ type: "PENDING", confirmations: 1, required: 2 }], paid);
    expect(pending).toMatchObject({ step: "verifying", confirmations: 1, required: 2, busy: false });
    const lost = run([{ type: "ASKING" }, { type: "CHECK_FAILED" }], pending);
    expect(lost).toMatchObject({ step: "verifying", busy: false, problem: { code: "CHECK_FAILED", retryable: true } });
    expect(run([{ type: "APPLIED", result: {} as never, payment: { txHash: HASH, amountLabel: "100,000", symbol: "$CLANKRPG" } }], run([{ type: "OPEN", requestId: KEY }])).step).toBe("confirm"); // not from here
    const done = run([{ type: "APPLIED", result: {} as never, payment: { txHash: HASH, amountLabel: "100,000", symbol: "$CLANKRPG" } }], lost);
    expect(done.step).toBe("result");
    expect(run([{ type: "DISMISS_RESULT" }], done)).toBe(initialPaidFlow);
  });

  it("a payment found after a reload resumes straight into verifying — and only when nothing else is open", () => {
    expect(run([{ type: "RESUME", requestId: KEY, txHash: HASH }])).toMatchObject({ step: "verifying", requestId: KEY, txHash: HASH });
    const open = run([{ type: "OPEN", requestId: KEY }]);
    expect(run([{ type: "RESUME", requestId: "z", txHash: HASH }], open)).toBe(open);
  });
});

// ------------------------------------------------------------------------------------------------ the wallet, against a fake provider
vi.mock("@/lib/api", () => ({ api: vi.fn() }));
import { api } from "@/lib/api";

class FakeWallet implements Eip1193 {
  calls: Array<{ method: string; params?: unknown }> = [];
  constructor(private readonly behaviour: Record<string, unknown | ((params: unknown) => unknown)> = {}) {}
  async request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> {
    this.calls.push(args);
    const b = this.behaviour[args.method];
    const v = typeof b === "function" ? (b as (p: unknown) => unknown)(args.params) : b;
    if (v instanceof Error) throw v;
    return v;
  }
  get methods() {
    return this.calls.map((c) => c.method);
  }
}
const rejectedError = Object.assign(new Error("User rejected the request."), { code: 4001 });
const unknownChain = Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
const payment = { chainIdHex: "0x1237", chainName: "Robinhood Chain", rpcUrl: "https://rpc.example", to: TOKEN, data: "0xa9059cbb00" };

describe("the wallet steps", () => {
  beforeEach(() => vi.mocked(api).mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("connectAccount opens the wallet's connect prompt and returns the account lower-cased; a decline or an empty answer is a plain refusal", async () => {
    const w = new FakeWallet({ eth_requestAccounts: [ME.toUpperCase().replace("0X", "0x")] });
    expect(await connectAccount(w)).toBe(ME);
    expect(w.methods).toEqual(["eth_requestAccounts"]);
    await expect(connectAccount(new FakeWallet({ eth_requestAccounts: rejectedError }))).rejects.toMatchObject({ code: "REJECTED", message: WALLET_MESSAGE.REJECTED });
    await expect(connectAccount(new FakeWallet({ eth_requestAccounts: [] }))).rejects.toMatchObject({ code: "NO_ACCOUNT" });
    await expect(connectAccount(new FakeWallet({ eth_requestAccounts: ["nope"] }))).rejects.toMatchObject({ code: "NO_ACCOUNT" });
  });

  it("ensureChain switches; adds the chain first when the wallet has never seen it (4902); a decline stops; a wallet that cannot be told the RPC cannot add", async () => {
    const ok = new FakeWallet({ wallet_switchEthereumChain: null });
    await ensureChain(ok, payment);
    expect(ok.calls).toEqual([{ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1237" }] }]);

    const adds = new FakeWallet({ wallet_switchEthereumChain: unknownChain, wallet_addEthereumChain: null });
    await ensureChain(adds, payment);
    expect(adds.methods).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain"]);
    expect(adds.calls[1]!.params).toEqual([{ chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.example"] }]);

    await expect(ensureChain(new FakeWallet({ wallet_switchEthereumChain: rejectedError }), payment)).rejects.toMatchObject({ code: "REJECTED" });
    await expect(ensureChain(new FakeWallet({ wallet_switchEthereumChain: unknownChain }), { ...payment, rpcUrl: null })).rejects.toMatchObject({ code: "NETWORK_FAILED" });
    await expect(ensureChain(new FakeWallet({ wallet_switchEthereumChain: unknownChain, wallet_addEthereumChain: rejectedError }), payment)).rejects.toMatchObject({ code: "REJECTED" });
    await expect(ensureChain(new FakeWallet({ wallet_switchEthereumChain: Object.assign(new Error("boom"), { code: 5000 }) }), payment)).rejects.toMatchObject({ code: "NETWORK_FAILED" });
  });

  it("sendPayment asks the wallet for ONE transaction — to the token contract, the server's calldata, no ETH value — and returns the hash lower-cased", async () => {
    const hash = `0x${"AB".repeat(32)}`;
    const w = new FakeWallet({ eth_sendTransaction: hash });
    expect(await sendPayment(w, ME, payment)).toBe(hash.toLowerCase());
    expect(w.calls).toEqual([{ method: "eth_sendTransaction", params: [{ from: ME, to: TOKEN, data: "0xa9059cbb00", value: "0x0" }] }]);
    await expect(sendPayment(new FakeWallet({ eth_sendTransaction: rejectedError }), ME, payment)).rejects.toMatchObject({ code: "REJECTED" });
    await expect(sendPayment(new FakeWallet({ eth_sendTransaction: new Error("insufficient funds for gas") }), ME, payment)).rejects.toMatchObject({ code: "SEND_FAILED" });
    await expect(sendPayment(new FakeWallet({ eth_sendTransaction: "not-a-hash" }), ME, payment)).rejects.toMatchObject({ code: "SEND_FAILED" });
  });

  it("linkWallet: a server challenge, a free personal_sign of exactly that message, then the server's verification — and each failure is named", async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ ok: true, data: { nonce: "n".repeat(20), message: "Clank RPG — link wallet to your hero\n…" } })
      .mockResolvedValueOnce({ ok: true, data: {} });
    const w = new FakeWallet({ personal_sign: "0xsigned" });
    await linkWallet(w, ME);
    expect(w.calls).toEqual([{ method: "personal_sign", params: ["Clank RPG — link wallet to your hero\n…", ME] }]);
    expect(vi.mocked(api).mock.calls.map((c) => c[0])).toEqual(["/api/me/wallet/challenge", "/api/me/wallet/verify"]);
    expect(vi.mocked(api).mock.calls[1]![1]).toMatchObject({ json: { nonce: "n".repeat(20), signature: "0xsigned" } });

    vi.mocked(api).mockReset().mockResolvedValueOnce({ ok: false, error: "UNAUTHENTICATED", status: 401 });
    await expect(linkWallet(new FakeWallet(), ME)).rejects.toMatchObject({ code: "LINK_FAILED" });
    vi.mocked(api).mockReset().mockResolvedValueOnce({ ok: true, data: { nonce: "n".repeat(20), message: "m" } });
    await expect(linkWallet(new FakeWallet({ personal_sign: rejectedError }), ME)).rejects.toMatchObject({ code: "REJECTED" });
    vi.mocked(api).mockReset().mockResolvedValueOnce({ ok: true, data: { nonce: "n".repeat(20), message: "m" } }).mockResolvedValueOnce({ ok: false, error: "ADDRESS_IN_USE", status: 409 });
    await expect(linkWallet(new FakeWallet({ personal_sign: "0xsigned" }), ME)).rejects.toMatchObject({ code: "LINK_FAILED", message: "That wallet is already linked to another hero." });
  });

  it("WalletError carries a code and a plain sentence for every failure", () => {
    for (const code of Object.keys(WALLET_MESSAGE) as Array<keyof typeof WALLET_MESSAGE>) {
      const e = new WalletError(code, WALLET_MESSAGE[code]);
      expect(e.code).toBe(code);
      expect(e.message.length).toBeGreaterThan(10);
      expect(e.message).toMatch(/nothing was paid|No wallet|Select the wallet|couldn't link/i);
    }
  });
});
