import type { FreeRerollResultDto } from "@/domain/hero/freeReroll";
import type { PaidRerollPaymentSummary } from "@/domain/hero/paidReroll";

/**
 * THE PAID REROLL FLOW as a pure state machine (the UI renders it; tests pin it). The rules it enforces:
 *
 *   · Clicking "Pay … & reroll" only OPENS the confirmation — it never opens a wallet by itself.
 *   · CONFIRM stays disabled until the member ticks the acknowledgement; the wallet prompts start only on that click, once (a double click cannot start two payments).
 *   · While the wallet is open or the payment is being verified, Cancel / Escape are ignored: the flow is never abandoned in the middle of a payment.
 *   · BEFORE the wallet has returned a transaction hash, a refusal (rejected prompt, no wallet, wrong account…) goes back to the confirmation with nothing paid — trying again is safe.
 *   · AFTER the hash exists the member has PAID. From then on the flow never offers a second payment: it asks the server what happened, again and again if it must,
 *     and a refusal that leaves the payment safe as a credit (the hero is in a live fight, the daily limit) ends in a message that says exactly that.
 *   · Only a server-confirmed result is ever shown as a result.
 */
export type WalletPhase = "CONNECT" | "LINK" | "NETWORK" | "PAY";

export interface PaidFlowProblem {
  code: string;
  message: string;
  /** True when sending the same payment-less attempt again makes sense (nothing was paid). */
  retryable: boolean;
}

export type PaidFlow =
  | { step: "closed" }
  | { step: "confirm"; requestId: string; acknowledged: boolean; error: PaidFlowProblem | null }
  /** The wallet is open (connect / sign / network / payment prompt). Nothing has been paid yet. */
  | { step: "wallet"; requestId: string; phase: WalletPhase }
  /** The payment was sent: the server is verifying it on-chain. `problem` is set when the payment is safe but cannot be used just now. */
  | { step: "verifying"; requestId: string; txHash: string; confirmations: number | null; required: number | null; busy: boolean; problem: PaidFlowProblem | null }
  | { step: "result"; result: FreeRerollResultDto; payment: PaidRerollPaymentSummary };

export type PaidAction =
  | { type: "OPEN"; requestId: string }
  | { type: "TOGGLE_ACK" }
  | { type: "CANCEL" }
  | { type: "START" }
  | { type: "PHASE"; phase: WalletPhase }
  /** The wallet returned a transaction hash: the member has paid. */
  | { type: "PAID"; txHash: string }
  /** Resume after a reload: a payment was sent earlier and is still unresolved. */
  | { type: "RESUME"; requestId: string; txHash: string }
  | { type: "ASKING" }
  | { type: "PENDING"; confirmations: number; required: number }
  | { type: "APPLIED"; result: FreeRerollResultDto; payment: PaidRerollPaymentSummary }
  | { type: "REFUSED"; problem: PaidFlowProblem }
  | { type: "CHECK_FAILED" }
  /** The member has read a "your payment is safe" message that cannot be retried: close the dialog. */
  | { type: "CLOSE_PROBLEM" }
  | { type: "DISMISS_RESULT" };

export const initialPaidFlow: PaidFlow = { step: "closed" };

export function paidFlowReducer(state: PaidFlow, action: PaidAction): PaidFlow {
  switch (action.type) {
    case "OPEN":
      return state.step === "closed" ? { step: "confirm", requestId: action.requestId, acknowledged: false, error: null } : state;
    case "TOGGLE_ACK":
      return state.step === "confirm" ? { ...state, acknowledged: !state.acknowledged } : state;
    case "CANCEL":
      return state.step === "confirm" ? initialPaidFlow : state;
    case "START":
      return state.step === "confirm" && state.acknowledged && !(state.error && !state.error.retryable) ? { step: "wallet", requestId: state.requestId, phase: "CONNECT" } : state;
    case "PHASE":
      return state.step === "wallet" ? { ...state, phase: action.phase } : state;
    case "PAID":
      return state.step === "wallet" ? { step: "verifying", requestId: state.requestId, txHash: action.txHash, confirmations: null, required: null, busy: true, problem: null } : state;
    case "RESUME":
      return state.step === "closed" ? { step: "verifying", requestId: action.requestId, txHash: action.txHash, confirmations: null, required: null, busy: true, problem: null } : state;
    case "ASKING":
      return state.step === "verifying" ? { ...state, busy: true } : state;
    case "PENDING":
      return state.step === "verifying" ? { ...state, busy: false, confirmations: action.confirmations, required: action.required, problem: null } : state;
    case "APPLIED":
      return state.step === "verifying" ? { step: "result", result: action.result, payment: action.payment } : state;
    case "REFUSED":
      // Before the wallet returned a hash: back to the confirmation (a fresh, explicit decision each time). After it: the payment is made — never a second one.
      if (state.step === "wallet") return { step: "confirm", requestId: state.requestId, acknowledged: false, error: action.problem };
      if (state.step === "verifying") return { ...state, busy: false, problem: action.problem };
      return state;
    case "CHECK_FAILED":
      return state.step === "verifying" ? { ...state, busy: false, problem: { code: "CHECK_FAILED", message: "We couldn't reach the server to confirm your payment. It is safe — check again in a moment.", retryable: true } } : state;
    case "CLOSE_PROBLEM":
      return state.step === "verifying" && state.problem && !state.problem.retryable ? initialPaidFlow : state;
    case "DISMISS_RESULT":
      return state.step === "result" ? initialPaidFlow : state;
  }
}

/** A refusal that leaves the payment safe as a recorded credit: the member is told to come back, and never asked to pay again. */
export const CREDIT_KEPT_CODES: ReadonlySet<string> = new Set(["HERO_IN_ARENA", "DAILY_LIMIT", "REQUEST_CONFLICT", "INVALID_ROLL"]);

/** A refusal that means the payment itself does not count (nothing was recorded): the dialog ends and says why. */
export const PAYMENT_REJECTED_CODES: ReadonlySet<string> = new Set(["PAYMENT_INVALID", "TX_ALREADY_USED", "NOT_CLAIMED", "HERO_UNAVAILABLE", "NO_HERO", "PAID_REROLL_DISABLED"]);

// ------------------------------------------------------------------------------------------------ remembering an unresolved payment
const KEY = "clank-paid-reroll-pending";

export interface PendingPayment {
  requestId: string;
  txHash: string;
}

/** Remembers a payment that was sent but not yet turned into a reroll, so a reload, a closed tab or a crashed phone browser can finish it (the server is idempotent on the hash). */
export function savePending(p: PendingPayment): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* private mode / blocked storage: the server-side credit is the real safety net */
  }
}
export function loadPending(): PendingPayment | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingPayment>;
    return typeof p.requestId === "string" && typeof p.txHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(p.txHash) ? { requestId: p.requestId, txHash: p.txHash } : null;
  } catch {
    return null;
  }
}
export function clearPending(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
