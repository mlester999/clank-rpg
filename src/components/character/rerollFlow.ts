import type { FreeRerollResultDto, FreeRerollStatusDto } from "@/domain/hero/freeReroll";

/**
 * THE REROLL FLOW as a pure state machine (the UI renders it; tests pin it). The rules it enforces:
 *
 *   · Clicking REROLL HERO only OPENS the confirmation — it never rerolls.
 *   · CONFIRM stays disabled until the member ticks the acknowledgement.
 *   · One submission per confirmation: while it is in flight (or being checked) every further SUBMIT / CANCEL / Escape is ignored — a double click,
 *     Enter held down or a second tap cannot send a second request.
 *   · If the answer is UNCERTAIN (network loss, timeout, a database blip) the flow does not offer another attempt: it asks the server what really
 *     happened (status read) and only then decides — the same idempotency key makes even a re-send harmless.
 *   · Only a server-confirmed result is ever shown as a result.
 */
export type RerollFlow =
  | { step: "closed" }
  | { step: "confirm"; requestId: string; acknowledged: boolean; error: RerollFlowError | null }
  | { step: "submitting"; requestId: string }
  /** The answer was lost: the server is being asked (or must be asked again) what happened. */
  | { step: "checking"; requestId: string; failedCheck: boolean }
  | { step: "result"; result: FreeRerollResultDto };

export interface RerollFlowError {
  code: string;
  message: string;
  /** True when sending the same confirmation again is sensible (nothing was used and nothing is blocking). */
  retryable: boolean;
}

export type RerollAction =
  | { type: "OPEN"; requestId: string }
  | { type: "TOGGLE_ACK" }
  | { type: "CANCEL" }
  | { type: "SUBMIT" }
  | { type: "SUCCEEDED"; result: FreeRerollResultDto }
  | { type: "REFUSED"; error: RerollFlowError }
  | { type: "UNCERTAIN" }
  | { type: "CHECKED"; status: FreeRerollStatusDto }
  | { type: "CHECK_FAILED" }
  | { type: "DISMISS_RESULT" };

export const initialRerollFlow: RerollFlow = { step: "closed" };

/** Failures after which another attempt makes sense (nothing consumed, nothing blocking). Everything else closes the door until the server says otherwise. */
const RETRYABLE = new Set(["INVALID_ROLL", "RATE_LIMITED"]);
export const isRetryable = (code: string): boolean => RETRYABLE.has(code);

/** An answer we cannot trust to mean "nothing happened": the request may or may not have committed. */
export const isUncertain = (code: string, status: number): boolean =>
  code === "NETWORK" || code === "TIMEOUT" || code === "DB_UNAVAILABLE" || status === 0 || (status >= 500 && code !== "INVALID_ROLL");

export function rerollFlowReducer(state: RerollFlow, action: RerollAction): RerollFlow {
  switch (action.type) {
    case "OPEN":
      return state.step === "closed" ? { step: "confirm", requestId: action.requestId, acknowledged: false, error: null } : state;
    case "TOGGLE_ACK":
      return state.step === "confirm" ? { ...state, acknowledged: !state.acknowledged } : state;
    case "CANCEL":
      // Escape / Cancel / the backdrop close the confirmation — but never a submission that is in flight, and never a result (that has its own button).
      return state.step === "confirm" ? initialRerollFlow : state;
    case "SUBMIT":
      return state.step === "confirm" && state.acknowledged && !(state.error && !state.error.retryable) ? { step: "submitting", requestId: state.requestId } : state;
    case "SUCCEEDED":
      return state.step === "submitting" || state.step === "checking" ? { step: "result", result: action.result } : state;
    case "REFUSED":
      // The acknowledgement is asked for again: every attempt is a fresh, explicit decision.
      return state.step === "submitting" ? { step: "confirm", requestId: state.requestId, acknowledged: false, error: action.error } : state;
    case "UNCERTAIN":
      return state.step === "submitting" ? { step: "checking", requestId: state.requestId, failedCheck: false } : state;
    case "CHECK_FAILED":
      return state.step === "checking" ? { ...state, failedCheck: true } : state;
    case "CHECKED": {
      if (state.step !== "checking") return state;
      const today = action.status.today;
      // The server says THIS request went through: show its result (the same pair a normal success would have shown).
      if (action.status.state === "USED" && today && today.requestId === state.requestId) return { step: "result", result: today };
      // Used by another tab / another request: the free reroll is spent — say so, no retry.
      if (action.status.state === "USED") return { step: "confirm", requestId: state.requestId, acknowledged: false, error: { code: "ALREADY_USED_TODAY", message: "You've already used today's free reroll.", retryable: false } };
      // Not used: the request did not commit. Nothing was consumed; the same key may be sent again.
      if (action.status.state === "AVAILABLE") return { step: "confirm", requestId: state.requestId, acknowledged: false, error: { code: "NOT_COMPLETED", message: "That didn't go through — nothing was used. You can try again.", retryable: true } };
      return { step: "confirm", requestId: state.requestId, acknowledged: false, error: { code: action.status.block ?? action.status.state, message: action.status.message ?? "Free rerolls aren't available right now.", retryable: false } };
    }
    case "DISMISS_RESULT":
      return state.step === "result" ? initialRerollFlow : state;
  }
}

/**
 * What identifies "the hero as it is now" for the page: when this changes between two status reads, the hero was rerolled somewhere else (another tab, another
 * browser, an uncertain answer that DID commit) and everything that shows the hero must be re-read. Pure; no hash needed — it is only compared with itself.
 */
export const heroStateKey = (card: { publicId: string; classId: string; rarity: string; power: number; name: string } | null | undefined): string | null =>
  card ? `${card.publicId}|${card.classId}|${card.rarity}|${card.power}|${card.name}` : null;
