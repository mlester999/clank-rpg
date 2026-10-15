import type { HeroCardModel } from "./card";
import type { FreeRerollBlock, FreeRerollResultDto } from "./freeReroll";

/**
 * THE PAID HERO REROLL — the pure rules (docs/HERO_PAID_REROLL.md).
 *
 * A member who has used today's free reroll can pay $CLANKRPG for another. The reroll is exactly as random as a free one (same generator, same odds); what changes is
 * only how it is paid for: an ordinary ERC-20 transfer to the reward treasury, signed in the member's own wallet. The server never holds a key — it READS the chain, and
 * this module decides what counts as "the payment was made": a successful transaction on the right chain whose Transfer event moved at least the price of the OFFICIAL
 * token to the treasury from a wallet the member has proved they control. Anything else is not a payment, however it looks.
 */

/** The feature flag. A missing flag is OFF. */
export const PAID_REROLL_FLAG = "hero.paid_reroll";

/** The actor written on a paid-made version and in the audit log. (Not `member:<id>` — that prefix is the FREE reroll's, and its database check looks for it.) */
export const paidMemberActor = (telegramUserId: number): string => `member-paid:${telegramUserId}`;

/** A transaction hash as the chain reports it. */
export const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export type PaidRerollState =
  /** The feature flag is off — a truthful "not open yet", never a clickable button. */
  | "DISABLED"
  /** On, but it cannot run right now: the migration is not applied, the token is not launched / configured, or the contract cannot be verified. */
  | "UNAVAILABLE"
  /** Today's FREE reroll is still available: use it first, there is nothing to pay for yet. */
  | "FREE_FIRST"
  /** A paid reroll can be bought now. */
  | "AVAILABLE"
  /** A verified payment is recorded and waiting to be used (the hero was in a live fight when it arrived, or the answer was lost). */
  | "CREDIT_WAITING"
  /** The member has used all of today's paid rerolls. */
  | "LIMIT_REACHED"
  /** The member has no hero they can reroll right now (see `block`). */
  | "BLOCKED";

/** What the wallet must be asked to send. Everything in it is the SERVER's: the browser forwards it and adds nothing. */
export interface PaidRerollPaymentRequest {
  chainId: number;
  /** `0x…` — for `wallet_switchEthereumChain` / `wallet_addEthereumChain`. */
  chainIdHex: string;
  chainName: string;
  rpcUrl: string | null;
  /** The token contract the transaction is sent TO. */
  to: string;
  /** ERC-20 `transfer(treasury, price)` calldata. */
  data: string;
  /** For the confirmation screen only (the calldata is what is signed). */
  recipient: string;
  amountRaw: string;
}

export interface PaidRerollStatusDto {
  state: PaidRerollState;
  serverNow: number;
  message: string | null;
  block: FreeRerollBlock | null;
  /** The price in whole tokens and as displayed ("100,000"). Null while it cannot be known. */
  price: { whole: string; label: string; symbol: string } | null;
  usedToday: number;
  maxPerDay: number;
  /** The wallets the member has proved control of (display form: the first one is the one to pay from). */
  wallet: { linked: boolean; address: string | null; /** Every wallet the member has proved control of (lower-case): the payment must come from one of them. */ addresses: string[] };
  /** A verified payment that has not been used yet. */
  credit: { txHash: string; paidAt: number } | null;
  /** Present only while AVAILABLE. */
  payment: PaidRerollPaymentRequest | null;
  explorerTxUrl: string | null;
  /** The hero as it is NOW, so the confirmation can show what is about to be replaced. */
  current: HeroCardModel | null;
}

export interface PaidRerollPaymentSummary {
  txHash: string;
  /** What the transfer moved, as displayed ("100,000"). */
  amountLabel: string;
  symbol: string;
}

export type PaidRerollOutcomeDto =
  | { status: "APPLIED"; result: FreeRerollResultDto; payment: PaidRerollPaymentSummary }
  /** The payment is not confirmed on-chain yet: ask again in a few seconds. Nothing has been used. */
  | { status: "PENDING"; confirmations: number; required: number };

/** Machine codes the API returns (stable; the UI maps them to words). */
export type PaidRerollErrorCode =
  | "UNAUTHENTICATED"
  | "PAID_REROLL_DISABLED"
  | "PAID_REROLL_UNAVAILABLE"
  | "PAYMENT_CHECK_UNAVAILABLE"
  | "WALLET_NOT_LINKED"
  | "PAYMENT_INVALID"
  | "TX_ALREADY_USED"
  | "DAILY_LIMIT"
  | "REQUEST_CONFLICT"
  | "INVALID_ROLL"
  | FreeRerollBlock;

export const PAID_BLOCK_MESSAGE: Record<FreeRerollBlock, string> = {
  NOT_SIGNED_IN: "Sign in with Telegram to reroll your hero.",
  NO_HERO: "You don't have a hero yet.",
  NOT_CLAIMED: "Claim your hero to reroll it.",
  HERO_UNAVAILABLE: "Your hero can't be rerolled right now.",
  HERO_IN_ARENA: "Your hero is lined up for a live Arena fight. Try again once the upcoming fights have finished.",
};

export const PAID_MESSAGE = {
  DISABLED: "Paid rerolls aren't open yet.",
  UNAVAILABLE: "Paid rerolls open when $CLANKRPG is live on this server.",
  FREE_FIRST: "Your free reroll is still available today — use it first.",
  LIMIT_REACHED: "You've used all of today's paid rerolls. They reset at 00:00 UTC.",
  /** A payment is already recorded and the hero is in a live fight: the money is not lost, the reroll just has to wait. */
  CREDIT_IN_ARENA: "Your payment is confirmed and safe. Your hero is lined up for a live Arena fight — your reroll will be ready once the upcoming fights have finished.",
  CREDIT_READY: "Your payment is confirmed — your reroll is ready.",
  WALLET_NOT_LINKED: "Connect your wallet first — the payment must come from a wallet you've linked to your hero.",
  TX_ALREADY_USED: "That payment was already used.",
  PAYMENT_CHECK_UNAVAILABLE: "We couldn't reach the chain to verify your payment. Nothing is lost — try again in a moment.",
} as const;

/** Why a transaction does not count as the payment. Plain sentences: the member may have sent the wrong thing and deserves to know which. */
export type PaymentProblem = "REVERTED" | "WRONG_CHAIN" | "NOT_TO_TREASURY" | "WRONG_TOKEN" | "WRONG_PAYER" | "TOO_LITTLE";

export const PAYMENT_PROBLEM_MESSAGE: Record<PaymentProblem, string> = {
  REVERTED: "That transaction failed on-chain, so nothing was paid.",
  WRONG_CHAIN: "That transaction is on a different network.",
  NOT_TO_TREASURY: "That transaction didn't send $CLANKRPG to the reroll payment address.",
  WRONG_TOKEN: "That transaction paid a different token — only $CLANKRPG counts.",
  WRONG_PAYER: "That payment didn't come from a wallet linked to your hero.",
  TOO_LITTLE: "That payment was smaller than the reroll price.",
};

/** What the chain reported about a transaction (the read-only reader's `TransferFacts`, restated so this module has no server import). */
export interface PaymentFacts {
  status: "success" | "reverted";
  chainId: number | null;
  transfers: ReadonlyArray<{ token: string; from: string; to: string; value: bigint }>;
}

export interface PaymentExpectation {
  /** The official token (lower-case). */
  token: string;
  /** The reward treasury (lower-case). */
  recipient: string;
  /** The price in the token's raw units. */
  requiredRaw: bigint;
  /** Wallets the member has proved control of (lower-case). */
  payers: readonly string[];
  chainId: number;
}

export type PaymentCheck = { ok: true; payer: string; amountRaw: bigint } | { ok: false; reason: PaymentProblem };

/**
 * Did this transaction pay the price? Decided only from the chain's own facts, never from anything the browser claims:
 *   · it must have SUCCEEDED, on the configured chain;
 *   · it must contain Transfer events of the OFFICIAL token to the treasury (a transfer of another token to the treasury is named as such);
 *   · they must come from a wallet the member linked — someone else's payment cannot be claimed by watching the mempool for a hash;
 *   · together they must reach the price (an overpayment is accepted and buys exactly one reroll: the transaction hash is single-use).
 */
export function checkPayment(facts: PaymentFacts, expect: PaymentExpectation): PaymentCheck {
  if (facts.status !== "success") return { ok: false, reason: "REVERTED" };
  if (facts.chainId !== null && facts.chainId !== expect.chainId) return { ok: false, reason: "WRONG_CHAIN" };
  const toTreasury = facts.transfers.filter((t) => t.to === expect.recipient);
  if (toTreasury.length === 0) return { ok: false, reason: "NOT_TO_TREASURY" };
  const official = toTreasury.filter((t) => t.token === expect.token);
  if (official.length === 0) return { ok: false, reason: "WRONG_TOKEN" };
  const mine = official.filter((t) => expect.payers.includes(t.from));
  if (mine.length === 0) return { ok: false, reason: "WRONG_PAYER" };
  // all qualifying transfers must come from ONE of the member's wallets (the payer named on the record is that wallet)
  const byPayer = new Map<string, bigint>();
  for (const t of mine) byPayer.set(t.from, (byPayer.get(t.from) ?? 0n) + t.value);
  let best: { payer: string; amount: bigint } | null = null;
  for (const [payer, amount] of byPayer) if (!best || amount > best.amount) best = { payer, amount };
  if (!best || best.amount < expect.requiredRaw) return { ok: false, reason: "TOO_LITTLE" };
  return { ok: true, payer: best.payer, amountRaw: best.amount };
}

/** The chain id as the wallet wants it. */
export const chainIdHex = (chainId: number): string => `0x${chainId.toString(16)}`;

/** The UTC-day string of an instant, for the daily brake. */
export { rerollDay as paidRerollDay, nextRerollAt as paidNextResetAt } from "./freeReroll";
