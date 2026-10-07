import type { BonusStatus } from "./holderBonus";

/**
 * The WIRE shape of the member's HOLDER REWARD BONUS card — shared by the server (which builds it) and the browser (which renders it).
 * Display strings and server times only: never a full wallet address, never another member's data.
 */
export interface BonusStatusDto {
  status: BonusStatus;
  /** The bonus that would PAY if this period closed now ("+15%"), when QUALIFIED. */
  payingBonus: string | null;
  payingTier: string | null;
  /** QUALIFIED while a higher tier is still accumulating continuity. */
  upgradingTo: { tier: string; bonus: string; eligibleFrom: number | null } | null;
  /** The tier this status is about (QUALIFYING / BROKEN / NEEDS VERIFICATION). */
  tier: string | null;
  /** How long the balance has been continuously verified at this tier, and how long this period requires. */
  heldMs: number;
  requiredMs: number;
  /** QUALIFYING: the first period (start, ms) this holding can count for. */
  eligibleFrom: number | null;
  brokenAt: number | null;
  /** The period this status is about. */
  periodStartsAt: number;
  periodEndsAt: number;
}

export interface HolderCardDto {
  /**
   * The official $CLANKRPG contract address has been configured (the token exists). FALSE = NOT LAUNCHED: holder bonuses cannot exist yet,
   * everyone is on the FREE tier (0 %), and the card says so instead of showing any tier or balance.
   */
  launched: boolean;
  /** Holder verification can run on this server (token launched, contract verified, chain readable). Otherwise everyone is FREE and Connect Wallet is not offered. */
  available: boolean;
  /** The member has a SIGNATURE-VERIFIED wallet. */
  walletConnected: boolean;
  wallet: { short: string | null };
  /** The tier of the last VERIFIED balance (FREE with no wallet). */
  tier: { index: number; name: string; label: string; bonusBps: number; bonus: string };
  /** The last verification is older than the freshness window: nothing is assumed until the next check. */
  verificationNeeded: boolean;
  balance: string | null;
  balanceVerifiedAt: number | null;
  nextTier: { name: string; label: string; minimum: string; bonus: string } | null;
  daily: BonusStatusDto;
  weekly: BonusStatusDto;
  tiers: Array<{ index: number; label: string; name: string; minimum: string; bonusBps: number; bonus: string }>;
  maxBonus: string;
  symbol: string;
}
