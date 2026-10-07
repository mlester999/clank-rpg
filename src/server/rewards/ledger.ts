import type { PeriodKind } from "@/domain/rewards/time";

import { json, type Queryable } from "../db/types";

/**
 * The append-only $CLANKRPG reward ledger (migrations 20261005001300 + 20261005001400). Every balance change is ONE row with a
 * unique idempotency key; the account balances are maintained only by database triggers on it. All quantities are `bigint` base
 * units here and `numeric` strings on the wire to Postgres — never a JavaScript number.
 *
 * What can be credited: a finalized Daily / Weekly leaderboard BASE prize, the holder BONUS on it (a separate row, so the two can
 * always be audited apart), or an audited admin adjustment. There is no per-battle credit kind — the database refuses one.
 */
export type RewardKind =
  | "DAILY_LEADERBOARD_BASE_REWARD"
  | "DAILY_LEADERBOARD_HOLDER_BONUS"
  | "WEEKLY_LEADERBOARD_BASE_REWARD"
  | "WEEKLY_LEADERBOARD_HOLDER_BONUS"
  | "CLAIM_RESERVED"
  | "CLAIM_SENT"
  | "CLAIM_RELEASED"
  | "ADMIN_ADJUSTMENT";

export const leaderboardKind = (period: PeriodKind, part: "BASE" | "BONUS"): RewardKind =>
  `${period}_LEADERBOARD_${part === "BASE" ? "BASE_REWARD" : "HOLDER_BONUS"}` as RewardKind;

export interface RewardLedgerInput {
  userId: number;
  kind: RewardKind;
  claimableDelta: bigint;
  reservedDelta?: bigint;
  claimedDelta?: bigint;
  earnedDelta?: bigint;
  claimId?: string;
  /** Leaderboard kinds: which board and the UTC date its period started on (a Monday for WEEKLY). */
  periodKind?: PeriodKind;
  periodStart?: string;
  meta?: Record<string, unknown>;
  idempotencyKey: string;
}

export class RewardIdempotencyConflictError extends Error {
  constructor(key: string) {
    super(`reward ledger key ${key} was already used for a different movement`);
    this.name = "RewardIdempotencyConflictError";
  }
}

export interface RewardAccount {
  userId: number;
  claimable: bigint;
  reserved: bigint;
  claimed: bigint;
  earned: bigint;
  /** The signature-verified HOLDER wallet (proves holdings → reward tier). Not a payout destination. */
  holderWallet: string | null;
  walletVerifiedAt: Date | null;
  walletException: boolean;
  reviewState: "NORMAL" | "REVIEW" | "SUSPENDED";
  reviewReason: string | null;
}

interface AccountRow {
  telegram_user_id: number;
  claimable: string;
  reserved: string;
  claimed_total: string;
  earned_total: string;
  holder_wallet_address: string | null;
  wallet_verified_at: Date | null;
  wallet_exception: boolean;
  review_state: "NORMAL" | "REVIEW" | "SUSPENDED";
  review_reason: string | null;
}

const ACCOUNT_COLS = "telegram_user_id, claimable::text, reserved::text, claimed_total::text, earned_total::text, holder_wallet_address, wallet_verified_at, wallet_exception, review_state, review_reason";

const toAccount = (r: AccountRow): RewardAccount => ({
  userId: Number(r.telegram_user_id),
  claimable: BigInt(r.claimable),
  reserved: BigInt(r.reserved),
  claimed: BigInt(r.claimed_total),
  earned: BigInt(r.earned_total),
  holderWallet: r.holder_wallet_address,
  walletVerifiedAt: r.wallet_verified_at,
  walletException: r.wallet_exception,
  reviewState: r.review_state,
  reviewReason: r.review_reason,
});

const EMPTY = (userId: number): RewardAccount => ({ userId, claimable: 0n, reserved: 0n, claimed: 0n, earned: 0n, holderWallet: null, walletVerifiedAt: null, walletException: false, reviewState: "NORMAL", reviewReason: null });

/** The member's account, or an all-zero one when they have never earned anything. */
export async function getRewardAccount(q: Queryable, userId: number): Promise<RewardAccount> {
  const [row] = await q.query<AccountRow>(`select ${ACCOUNT_COLS} from public.arena_reward_accounts where telegram_user_id = $1`, [userId]);
  return row ? toAccount(row) : EMPTY(userId);
}

/** Creates the account row if needed and takes its row lock — serialises every balance operation of one member. */
export async function lockRewardAccount(q: Queryable, userId: number): Promise<RewardAccount> {
  await q.query("insert into public.arena_reward_accounts (telegram_user_id) values ($1) on conflict (telegram_user_id) do nothing", [userId]);
  const [row] = await q.query<AccountRow>(`select ${ACCOUNT_COLS} from public.arena_reward_accounts where telegram_user_id = $1 for update`, [userId]);
  return toAccount(row as AccountRow);
}

/** Posts one ledger entry. A replay of the same key with the same movement is a no-op; the same key with a different movement throws. */
export async function postRewardLedger(q: Queryable, e: RewardLedgerInput): Promise<{ applied: boolean }> {
  const reserved = e.reservedDelta ?? 0n;
  const claimed = e.claimedDelta ?? 0n;
  const earned = e.earnedDelta ?? 0n;
  const inserted = await q.query<{ id: number }>(
    `insert into public.arena_reward_ledger
       (telegram_user_id, kind, claimable_delta, reserved_delta, claimed_delta, earned_delta, claim_id, period_kind, period_start, meta, idempotency_key)
     values ($1, $2, $3::numeric, $4::numeric, $5::numeric, $6::numeric, $7, $8, $9::date, $10::jsonb, $11)
     on conflict (idempotency_key) do nothing returning id`,
    [e.userId, e.kind, e.claimableDelta.toString(), reserved.toString(), claimed.toString(), earned.toString(), e.claimId ?? null, e.periodKind ?? null, e.periodStart ?? null, json(e.meta ?? {}), e.idempotencyKey],
  );
  if (inserted[0]) return { applied: true };
  const [existing] = await q.query<{ telegram_user_id: number; kind: string; claimable_delta: string; reserved_delta: string; claimed_delta: string }>(
    "select telegram_user_id, kind, claimable_delta::text, reserved_delta::text, claimed_delta::text from public.arena_reward_ledger where idempotency_key = $1",
    [e.idempotencyKey],
  );
  if (!existing || Number(existing.telegram_user_id) !== e.userId || existing.kind !== e.kind || BigInt(existing.claimable_delta) !== e.claimableDelta || BigInt(existing.reserved_delta) !== reserved || BigInt(existing.claimed_delta) !== claimed) {
    throw new RewardIdempotencyConflictError(e.idempotencyKey);
  }
  return { applied: false };
}

export interface RewardAuditRow {
  telegram_user_id: number;
  claimable: string;
  ledger_claimable: string;
}

/** Any row returned is an integrity violation (an account that is not the sum of its ledger). Always empty. */
export const auditRewardAccounts = (q: Queryable): Promise<RewardAuditRow[]> =>
  q.query<RewardAuditRow>("select telegram_user_id, claimable::text, ledger_claimable::text from public.audit_arena_reward_accounts()");

export interface RewardTotals {
  claimable: bigint;
  reserved: bigint;
  claimed: bigint;
  earned: bigint;
}

/** System-wide balances: what is owed (claimable + reserved) and what has been paid out. */
export async function rewardTotals(q: Queryable): Promise<RewardTotals> {
  const [r] = await q.query<{ c: string; r: string; k: string; e: string }>(
    "select coalesce(sum(claimable), 0)::text as c, coalesce(sum(reserved), 0)::text as r, coalesce(sum(claimed_total), 0)::text as k, coalesce(sum(earned_total), 0)::text as e from public.arena_reward_accounts",
  );
  return { claimable: BigInt(r?.c ?? "0"), reserved: BigInt(r?.r ?? "0"), claimed: BigInt(r?.k ?? "0"), earned: BigInt(r?.e ?? "0") };
}
