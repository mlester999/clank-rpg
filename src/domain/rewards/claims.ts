/**
 * MANUAL CLAIM PROCESSING. The application never holds a signing key and never sends tokens: a claim is a REQUEST that reserves
 * the member's claimable balance, and an admin pays it by hand. The states are deliberately few:
 *
 *   PENDING ─► SENT     an admin transferred $CLANKRPG and named the transaction; the server verified it on-chain (read-only RPC)
 *           └► DENIED   an admin refused it (with a reason); the reservation returns to the member's claimable balance
 *
 * The amount and the destination are frozen on the claim at request time — neither the browser nor an admin can change them.
 */
export type ClaimStatus = "PENDING" | "SENT" | "DENIED";

/** A claim that holds a reservation. At most ONE per member (partial unique index), so the same units can never be reserved twice. */
export const ACTIVE_CLAIM_STATUSES: readonly ClaimStatus[] = ["PENDING"];
export const isActiveClaim = (s: ClaimStatus): boolean => ACTIVE_CLAIM_STATUSES.includes(s);
export const isTerminalClaim = (s: ClaimStatus): boolean => s === "SENT" || s === "DENIED";

const TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = { PENDING: ["SENT", "DENIED"], SENT: [], DENIED: [] };
export const canTransition = (from: ClaimStatus, to: ClaimStatus): boolean => TRANSITIONS[from].includes(to);

/** Where a payout goes: the member's signature-verified HOLDER wallet, or another address they typed for THIS claim only. */
export type DestinationKind = "HOLDER_WALLET" | "CUSTOM";

export type DenialReason = "INVALID_WALLET" | "SUSPICIOUS" | "NEEDS_REVIEW" | "OTHER";

export interface DenialInfo {
  /** The admin-facing label. */
  label: string;
  /** What the PLAYER is told. Never reveals anti-fraud reasoning. */
  publicLabel: string;
  publicMessage: string;
  /** Denying for this reason also puts the account into REVIEW (rewards stay recorded; further claims are held). */
  holdsAccount: boolean;
}

export const DENIAL_REASONS: Readonly<Record<DenialReason, DenialInfo>> = {
  INVALID_WALLET: {
    label: "Incorrect wallet",
    publicLabel: "Invalid wallet",
    publicMessage: "That wallet address couldn't be used. Your rewards are back in your claimable balance — submit a new claim with a correct address.",
    holdsAccount: false,
  },
  SUSPICIOUS: {
    label: "Duplicate / suspicious request",
    publicLabel: "Could not be processed",
    publicMessage: "We couldn't process this claim. Your rewards are safe in your account.",
    holdsAccount: true,
  },
  NEEDS_REVIEW: {
    label: "Needs account review",
    publicLabel: "Needs a quick review",
    publicMessage: "This claim needs a quick account review. Your rewards are safe in your account.",
    holdsAccount: true,
  },
  OTHER: {
    label: "Other",
    publicLabel: "Could not be processed",
    publicMessage: "This claim couldn't be processed. Your rewards are back in your claimable balance.",
    holdsAccount: false,
  },
};
export const DENIAL_REASON_CODES = Object.keys(DENIAL_REASONS) as DenialReason[];
