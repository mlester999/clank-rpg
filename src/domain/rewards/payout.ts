import type { PeriodKind } from "./time";

/**
 * ADMIN PAYOUT SUMMARY of ONE finalized Daily / Weekly board — pure types and formatters, shared by the server (which computes the
 * exact amounts in BigInt) and the Admin UI. Payouts are MANUAL, so an operator must never need a calculator: the base prizes, the
 * qualified holder bonuses and the exact total to send are all computed here, from the frozen result rows.
 *
 * Nothing in this file is player-facing, and nothing in it carries anti-fraud internals (no review reasons, no continuity evidence,
 * no balances). A wallet is the one the player themselves gave (their holder wallet or the destination of their own claim).
 */

/** Where a prize stands in the manual payout flow. HELD / FORFEITED are review outcomes (nothing to send until released / ever). */
export type PayoutClaimStatus = "UNCLAIMED" | "PENDING" | "SENT" | "DENIED" | "HELD" | "FORFEITED";
export const PAYOUT_CLAIM_STATUSES: readonly PayoutClaimStatus[] = ["UNCLAIMED", "PENDING", "SENT", "DENIED", "HELD", "FORFEITED"];

export interface PayoutRowDto {
  rank: number;
  /** More than one member shares exactly this rank (same correct picks and accuracy) — their prize positions were combined and split. */
  tied: boolean;
  /** Admin-only identity: the immutable Telegram id, and the hero name. */
  telegramUserId: number;
  hero: string;
  correctPicks: number;
  picks: number;
  /** Percent correct, one decimal. */
  accuracy: number;
  points: number;
  /** Display amounts ("30,000") and the same amounts as plain decimals ("30000") for copying and CSV. */
  basePrize: string;
  basePrizePlain: string;
  /** The tier label that qualified the bonus ("10M"), its percent ("+25%") and amount — null / "0" when there is no bonus. */
  holderTier: string | null;
  bonusPercent: string | null;
  holderBonus: string;
  holderBonusPlain: string;
  /** EXACT amount to send for this winner: base + the qualified bonus (0 for a forfeited prize). */
  totalReward: string;
  totalRewardPlain: string;
  baseStatus: "CREDITED" | "HELD" | "FORFEITED";
  bonusStatus: "NONE" | "PENDING_VERIFICATION" | "CREDITED" | "HELD" | "FORFEITED" | "EXPIRED";
  claimStatus: PayoutClaimStatus;
  /** Where to send it: the destination of the claim that covers this prize, else the player's verified holder wallet (null if neither exists yet). */
  wallet: string | null;
  walletSource: "CLAIM" | "HOLDER_WALLET" | null;
  /** The transaction that paid the covering claim (SENT only). */
  txHash: string | null;
}

export interface PayoutSummaryDto {
  kind: PeriodKind;
  /** The period identifier: the UTC date the period starts on (a Monday for WEEKLY). */
  start: string;
  finalizedAt: number;
  symbol: string;
  /** The FIXED base pool of this board, and what the ladder actually awarded of it (an unfilled position or a tie remainder returns to the reserve). */
  basePool: string;
  baseAwarded: string;
  returnedToReserve: string;
  /** The largest holder bonus the board's frozen tiers allow ("+25%"). */
  maxBonusPercent: string;
  /** Qualified holder bonuses on prizes that stand (credited, or held together with their prize). */
  holderBonuses: string;
  /** EXACT TOTAL TO SEND = base prizes that stand + qualified holder bonuses. */
  totalPayout: string;
  totalPayoutPlain: string;
  /** Of the total: held for an admin's review (send only after the prize is released). */
  heldForReview: string;
  /** Prizes that were forfeited after review — returned to the reserve, NOT part of the total. */
  forfeited: string;
  /** Winners whose holder bonus is still PENDING VERIFICATION: not in the total yet. At most this much more could be added (every one at the top tier). */
  bonusesPending: number;
  bonusesPendingMaximum: string;
  prizeWinners: number;
  /** The total split by where each winner stands in the payout flow (display amounts). */
  byStatus: Record<PayoutClaimStatus, string>;
}

export interface PayoutDto {
  summary: PayoutSummaryDto;
  rows: PayoutRowDto[];
}

const title = (kind: PeriodKind) => (kind === "DAILY" ? "DAILY" : "WEEKLY");

/** The text an operator copies: the summary block, then one line per winner. */
export function payoutSummaryText(p: PayoutDto): string {
  const s = p.summary;
  const lines = [
    `${title(s.kind)} PAYOUT SUMMARY — ${s.kind === "DAILY" ? s.start : `week of ${s.start}`} (UTC)`,
    "",
    `Base Prize Pool        ${s.basePool} ${s.symbol}`,
    `Base prizes awarded    ${s.baseAwarded} ${s.symbol}`,
    `Holder Bonuses         ${s.holderBonuses} ${s.symbol}`,
    `TOTAL PAYOUT           ${s.totalPayout} ${s.symbol}`,
  ];
  if (s.heldForReview !== "0") lines.push(`  of which held for review (send only after release): ${s.heldForReview}`);
  if (s.bonusesPending > 0) lines.push(`  ${s.bonusesPending} holder bonus(es) still pending verification — not included (up to ${s.bonusesPendingMaximum} more)`);
  lines.push("");
  for (const r of p.rows) {
    const bonus = r.holderTier && r.holderBonus !== "0" ? ` + ${r.holderBonus} (${r.holderTier} ${r.bonusPercent ?? ""})`.replace(/ +\)/, ")") : "";
    lines.push(`#${r.rank}${r.tied ? " (tie)" : ""}  ${r.hero} (tg ${r.telegramUserId})  ${r.basePrize}${bonus} = ${r.totalReward}  [${r.claimStatus}]${r.wallet ? `  → ${r.wallet}` : ""}${r.txHash ? `  tx ${r.txHash}` : ""}`);
  }
  return lines.join("\n");
}

export const PAYOUT_CSV_COLUMNS = [
  "period_type", "period_start", "rank", "telegram_id", "hero", "wallet", "base_prize", "holder_tier", "holder_bonus_percent", "holder_bonus", "total_reward", "claim_status", "tx_hash",
] as const;

/**
 * One CSV cell. A value a spreadsheet would run as a formula (`= + - @`, tab, CR) is neutralised with a leading apostrophe — hero names
 * are player-controlled — except a plain number, which is written as is. Quotes, commas and line breaks are escaped per RFC 4180.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (!/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The payout table as CSV (header + one line per winner), amounts as plain decimals. */
export function payoutCsv(p: PayoutDto): string {
  const s = p.summary;
  const out = [PAYOUT_CSV_COLUMNS.join(",")];
  for (const r of p.rows) {
    // The percent is exported as a plain number ("25", not "+25%"): a leading "+" would read as a formula to a spreadsheet.
    const percent = r.bonusPercent ? r.bonusPercent.replace(/[^\d.]/g, "") : null;
    out.push([s.kind, s.start, r.rank, r.telegramUserId, r.hero, r.wallet, r.basePrizePlain, r.holderTier, percent, r.holderBonusPlain, r.totalRewardPlain, r.claimStatus, r.txHash].map(csvCell).join(","));
  }
  return `${out.join("\r\n")}\r\n`;
}
