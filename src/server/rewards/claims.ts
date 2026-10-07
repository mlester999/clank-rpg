import { randomUUID } from "node:crypto";

import { checkRewardAddress } from "@/domain/rewards/address";
import { ACTIVE_CLAIM_STATUSES, DENIAL_REASONS, type ClaimStatus, type DenialReason, type DestinationKind } from "@/domain/rewards/claims";
import { formatTokenAmount, LOGICAL_DECIMALS, logicalToRaw } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { json, type Db, type Queryable } from "../db/types";

import { TokenMetadataError, type RewardChainReader, type TransferFacts } from "./chain";
import { getRewardEligibility } from "./eligibility";
import { lockRewardAccount, postRewardLedger } from "./ledger";
import { minimumClaimMicro } from "./pool";
import { verifiedTokenMetadata } from "./tokenMetadata";

/**
 * MANUAL CLAIMS. Nothing in this application sends tokens or holds a signing key.
 *
 * Amounts are LOGICAL ($CLANKRPG in micro-token units, domain/rewards/tokens.ts) everywhere the game accounts for them; the token's
 * own `decimals()` — read from the contract — is used only to turn a claim into the exact RAW amount an admin must send.
 *
 *   request  (one transaction)  authenticate → lock the account → check everything → choose the destination (the member's
 *            verified HOLDER wallet, or an address typed for THIS claim only) → create ONE PENDING claim → move the WHOLE
 *            claimable balance to reserved (ledger CLAIM_RESERVED). The amount comes from the ledger; the browser supplies none.
 *            A second click finds the reservation and the partial unique index "one pending claim per member". Claims exist only
 *            once the token has launched and its contract is verified; before that members simply keep their CLAIMABLE balance
 *            (NOTHING is denied or lost — the claim opens after launch).
 *   sent     an admin paid the tokens by hand and names the transaction. BEFORE marking it SENT the server reads the contract's
 *            decimals(), converts the claim's logical amount to raw units, and reads the chain (read-only RPC): the transaction
 *            succeeded on the right chain, emitted an ERC-20 Transfer from the official token contract to THIS claim's frozen
 *            destination for EXACTLY that raw amount. If the chain cannot confirm it the claim stays PENDING. A transaction hash
 *            can back one claim, ever (unique index).
 *   denied   an admin refused it, with a reason; the reservation returns to claimable (CLAIM_RELEASED). Reasons that suggest
 *            abuse also put the account under REVIEW: rewards stay recorded, further claims are held.
 *
 * Reward settlement and the arena never depend on any of this.
 */
export type ClaimRejection =
  | "TOKEN_NOT_LAUNCHED"
  | "CLAIMS_UNAVAILABLE"
  | "NOT_ELIGIBLE"
  | "CLAIMS_HELD"
  | "DESTINATION_REQUIRED"
  | "NO_HOLDER_WALLET"
  | "INVALID_WALLET"
  | "WALLET_IN_USE"
  | "BELOW_MINIMUM"
  | "NOTHING_TO_CLAIM"
  | "CLAIM_IN_PROGRESS";

export interface ClaimView {
  id: string;
  status: ClaimStatus;
  /** Display amount, e.g. "42,500". */
  amount: string;
  /** The logical amount (micro-token units) the ledger reserved. */
  amountMicro: string;
  /** The exact on-chain raw amount this claim must be paid with, at the contract's decimals when the claim was made. */
  amountRaw: string;
  destination: string;
  destinationKind: DestinationKind;
  txHash: string | null;
  requestedAt: number;
  sentAt: number | null;
  deniedAt: number | null;
  denialReason: DenialReason | null;
}

export interface ClaimRow {
  id: string;
  telegram_user_id: number;
  /** Logical amount reserved on the ledger (micro-token units). */
  amount_micro: string;
  /** The raw on-chain amount (= amount_micro converted at `token_decimals`; the database checks the conversion). */
  amount_raw: string;
  destination_address: string;
  destination_kind: DestinationKind;
  token_address: string;
  chain_id: number;
  token_decimals: number;
  status: ClaimStatus;
  tx_hash: string | null;
  sent_at: Date | null;
  sent_by: string | null;
  denied_at: Date | null;
  denied_by: string | null;
  denial_reason: DenialReason | null;
  denial_note: string | null;
  requested_at: Date;
  idempotency_key: string;
}

export const CLAIM_COLS =
  "id, telegram_user_id, amount_micro::text, amount_raw::text, destination_address, destination_kind, token_address, chain_id, token_decimals, status, tx_hash, sent_at, sent_by, denied_at, denied_by, denial_reason, denial_note, requested_at, idempotency_key";
const ACTIVE_SQL = ACTIVE_CLAIM_STATUSES.map((s) => `'${s}'`).join(", ");

export const claimView = (r: ClaimRow): ClaimView => ({
  id: r.id,
  status: r.status,
  amount: formatTokenAmount(BigInt(r.amount_micro), LOGICAL_DECIMALS),
  amountMicro: r.amount_micro,
  amountRaw: r.amount_raw,
  destination: r.destination_address,
  destinationKind: r.destination_kind,
  txHash: r.tx_hash,
  requestedAt: new Date(r.requested_at).getTime(),
  sentAt: r.sent_at ? new Date(r.sent_at).getTime() : null,
  deniedAt: r.denied_at ? new Date(r.denied_at).getTime() : null,
  denialReason: r.denial_reason,
});

/** What the claim endpoint needs to know about the token configuration (never a secret). */
export interface ClaimTarget {
  enabled: boolean;
  /** Why claims are closed: the token has not launched, or it is configured but its contract cannot be verified right now. */
  reason: "NOT_LAUNCHED" | "UNVERIFIED" | null;
  tokenAddress: string | null;
  chainId: number | null;
  /** The contract's own decimals(), verified (null while the token is unavailable). */
  tokenDecimals: number | null;
  /** Addresses a payout must never go to (the token contract and the treasury itself). */
  forbiddenRecipients: string[];
}

/** `HOLDER_WALLET` = the member's verified holder wallet; `CUSTOM` = an address for THIS payout only (never changes the holder wallet). */
export type ClaimDestinationInput = { kind: "HOLDER_WALLET" } | { kind: "CUSTOM"; address: string };

export type RequestClaimResult =
  | { ok: true; claim: ClaimView; replayed: boolean }
  | { ok: false; reason: ClaimRejection; claimableMicro?: string; minimumMicro?: string };

export async function requestClaim(
  db: Db,
  ctx: { now: () => Date; allowDemo: boolean },
  input: { userId: number; idempotencyKey: string; destination: ClaimDestinationInput; settings: GameSettings; target: ClaimTarget },
): Promise<RequestClaimResult> {
  return db.transaction(async (tx): Promise<RequestClaimResult> => {
    const account = await lockRewardAccount(tx, input.userId);

    // An exact replay of an accepted request returns the original claim — it is not "a second claim".
    const [replay] = await tx.query<ClaimRow>(`select ${CLAIM_COLS} from public.arena_reward_claims where telegram_user_id = $1 and idempotency_key = $2`, [input.userId, input.idempotencyKey]);
    if (replay) return { ok: true, claim: claimView(replay), replayed: true };

    const { target } = input;
    // Before the token exists nothing can be paid on-chain: the balance stays CLAIMABLE and the claim opens after launch (never a denial).
    if (target.reason === "NOT_LAUNCHED") return { ok: false, reason: "TOKEN_NOT_LAUNCHED" };
    if (!target.enabled || !target.tokenAddress || target.chainId === null || target.tokenDecimals === null) return { ok: false, reason: "CLAIMS_UNAVAILABLE" };

    const eligibility = await getRewardEligibility(tx, input.userId, { threshold: input.settings.telegram.qualifyingThreshold, allowDemo: ctx.allowDemo });
    if (!eligibility.eligible) return { ok: false, reason: "NOT_ELIGIBLE" };
    // REVIEW / SUSPENDED (or a Telegram FLAG): rewards stay recorded and safe, claims wait for an admin.
    if (account.reviewState !== "NORMAL" || eligibility.reviewState !== "NORMAL") return { ok: false, reason: "CLAIMS_HELD" };

    const [active] = await tx.query("select 1 from public.arena_reward_claims where telegram_user_id = $1 and status in (" + ACTIVE_SQL + ")", [input.userId]);
    if (active) return { ok: false, reason: "CLAIM_IN_PROGRESS" };

    const minimum = minimumClaimMicro(input.settings);
    if (account.claimable <= 0n) return { ok: false, reason: "NOTHING_TO_CLAIM" };
    if (account.claimable < minimum) return { ok: false, reason: "BELOW_MINIMUM", claimableMicro: account.claimable.toString(), minimumMicro: minimum.toString() };
    // The logical amount → the exact raw amount at the CONTRACT's decimals. A token with fewer than 6 decimals cannot express the last
    // few micro-units: that dust simply stays claimable (only the representable part is reserved), nothing is rounded away.
    const { raw: amountRaw, payable: amount } = logicalToRaw(account.claimable, target.tokenDecimals);
    if (amount <= 0n) return { ok: false, reason: "NOTHING_TO_CLAIM" };

    // The destination of THIS payout. The holder wallet is never changed or created here.
    let destination: string;
    let kind: DestinationKind;
    if (input.destination.kind === "HOLDER_WALLET") {
      if (!account.holderWallet || !account.walletVerifiedAt) return { ok: false, reason: "NO_HOLDER_WALLET" };
      destination = account.holderWallet;
      kind = "HOLDER_WALLET";
    } else {
      const checked = checkRewardAddress(input.destination.address);
      if (!checked.ok || target.forbiddenRecipients.includes(checked.address)) return { ok: false, reason: "INVALID_WALLET" };
      destination = checked.address;
      kind = account.holderWallet === checked.address ? "HOLDER_WALLET" : "CUSTOM";
      if (kind === "CUSTOM" && !account.walletException) {
        // Another account's SIGNATURE-VERIFIED holder wallet is not a destination for this account.
        const [owner] = await tx.query<{ telegram_user_id: number }>("select telegram_user_id from public.arena_reward_accounts where holder_wallet_address = $1 and telegram_user_id <> $2 limit 1", [destination, input.userId]);
        if (owner) {
          await tx.query("insert into public.arena_reward_wallet_attempts (telegram_user_id, attempted_address, conflicting_user_id) values ($1, $2, $3)", [input.userId, destination, owner.telegram_user_id]);
          return { ok: false, reason: "WALLET_IN_USE" };
        }
      }
    }

    const id = randomUUID();
    await tx.query(
      `insert into public.arena_reward_claims (id, telegram_user_id, amount_micro, amount_raw, destination_address, destination_kind, token_address, chain_id, token_decimals, idempotency_key, requested_at)
       values ($1, $2, $3::numeric, $4::numeric, $5, $6, $7, $8, $9, $10, $11::timestamptz)`,
      [id, input.userId, amount.toString(), amountRaw.toString(), destination, kind, target.tokenAddress, target.chainId, target.tokenDecimals, input.idempotencyKey, ctx.now().toISOString()],
    );
    // The whole claimable balance is reserved atomically; the payout amount comes from the ledger, never from the browser.
    await postRewardLedger(tx, { userId: input.userId, kind: "CLAIM_RESERVED", claimableDelta: -amount, reservedDelta: amount, claimId: id, meta: { destination, kind }, idempotencyKey: `claim:${id}:reserved` });
    const [claim] = await tx.query<ClaimRow>(`select ${CLAIM_COLS} from public.arena_reward_claims where id = $1`, [id]);
    return { ok: true, claim: claimView(claim as ClaimRow), replayed: false };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Verifying a manual payout (read-only chain)
// ---------------------------------------------------------------------------------------------------------------------
export type TransferProblem = "REVERTED" | "WRONG_CHAIN" | "WRONG_TOKEN" | "WRONG_RECIPIENT" | "WRONG_AMOUNT" | "NOT_CONFIRMED";

export type TransferCheck = { ok: true; details: Record<string, unknown> } | { ok: false; problem: TransferProblem; detail: string };

/**
 * The mined facts of a payout must match the claim EXACTLY: succeeded, right chain, emitted by the official token contract,
 * recipient = the claim's frozen destination, amount = the claim's frozen amount, with enough confirmations. Who SENT it does
 * not matter (an admin may pay from any wallet or multisig); what it paid does.
 */
export function verifyManualTransfer(facts: TransferFacts, claim: Pick<ClaimRow, "destination_address" | "token_address" | "chain_id" | "amount_raw">, minConfirmations: number): TransferCheck {
  const amount = BigInt(claim.amount_raw);
  if (facts.status !== "success") return { ok: false, problem: "REVERTED", detail: "the transaction did not succeed on-chain" };
  if (facts.chainId !== null && facts.chainId !== claim.chain_id) return { ok: false, problem: "WRONG_CHAIN", detail: "the transaction is on a different chain" };
  const fromToken = facts.transfers.filter((t) => t.token === claim.token_address);
  if (fromToken.length === 0) return { ok: false, problem: "WRONG_TOKEN", detail: "no Transfer event from the official $CLANKRPG token contract in this transaction" };
  const toDestination = fromToken.filter((t) => t.to === claim.destination_address);
  if (toDestination.length === 0) return { ok: false, problem: "WRONG_RECIPIENT", detail: "the $CLANKRPG transfer did not go to this claim's destination wallet" };
  const exact = toDestination.find((t) => t.value === amount);
  if (!exact) return { ok: false, problem: "WRONG_AMOUNT", detail: "the amount transferred to the destination is not this claim's amount" };
  if (facts.confirmations < minConfirmations) return { ok: false, problem: "NOT_CONFIRMED", detail: `the transaction has ${facts.confirmations} of ${minConfirmations} required confirmations — try again shortly` };
  return { ok: true, details: { blockNumber: facts.blockNumber.toString(), confirmations: facts.confirmations, from: exact.from, to: exact.to, token: exact.token, value: exact.value.toString() } };
}

export type MarkSentResult =
  | { ok: true; claim: ClaimView }
  | { ok: false; reason: "NOT_FOUND" | "WRONG_STATE" | "INVALID_HASH" | "NEEDS_CHAIN" | "TOKEN_CONFIG_CHANGED" | "TX_IN_USE" | "TX_NOT_FOUND" | "CHAIN_UNAVAILABLE" | TransferProblem; detail?: string };

const isUniqueViolation = (e: unknown, name: string): boolean => e instanceof Error && new RegExp(name, "i").test(e.message);

/**
 * PENDING → SENT, only after the chain confirms the payout. The admin supplies ONLY the transaction hash: the amount and the
 * destination are the claim's frozen ones. Idempotent per hash; a second SENT (or a hash already used by another claim) is
 * refused by the database as well.
 */
export async function markClaimSent(
  db: Db,
  ctx: { now: () => Date },
  reader: RewardChainReader | null,
  settings: GameSettings,
  input: { claimId: string; txHash: string; actor: string },
): Promise<MarkSentResult> {
  const hash = input.txHash.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "INVALID_HASH", detail: "a transaction hash is 0x followed by 64 hexadecimal characters" };
  const [claim] = await db.query<ClaimRow>(`select ${CLAIM_COLS} from public.arena_reward_claims where id = $1`, [input.claimId]);
  if (!claim) return { ok: false, reason: "NOT_FOUND" };
  if (claim.status !== "PENDING") return { ok: false, reason: "WRONG_STATE", detail: `this claim is already ${claim.status}` };
  const [used] = await db.query<{ id: string }>("select id from public.arena_reward_claims where tx_hash = $1", [hash]);
  if (used) return { ok: false, reason: "TX_IN_USE", detail: "that transaction is already recorded as the payout of another claim" };

  // No chain, no SENT: never mark a payout as done blindly.
  if (!reader) return { ok: false, reason: "NEEDS_CHAIN", detail: "the chain cannot be read right now (token not configured or the RPC is down) — the claim stays PENDING" };
  if (reader.chainId !== claim.chain_id || reader.tokenAddress !== claim.token_address) return { ok: false, reason: "TOKEN_CONFIG_CHANGED", detail: "the token configuration changed since this claim was requested" };
  // The CONTRACT decides the scale: read decimals() now, convert the claim's logical amount to raw units, and require it to be the very amount frozen on the claim.
  try {
    await reader.metadata(); // distinguishes "the RPC is down" from "the contract cannot be verified" (the reader caches, so this is free below)
  } catch (e) {
    if (e instanceof TokenMetadataError) return { ok: false, reason: "NEEDS_CHAIN", detail: "the token contract cannot be verified right now (chain, bytecode, decimals() and symbol()) — the claim stays PENDING" };
    return { ok: false, reason: "CHAIN_UNAVAILABLE", detail: `the chain could not be read (${e instanceof Error ? e.message : "error"}) — the claim stays PENDING` };
  }
  const meta = await verifiedTokenMetadata(db, reader);
  if (!meta) return { ok: false, reason: "NEEDS_CHAIN", detail: "the token contract cannot be verified right now (chain, bytecode, decimals() and symbol()) — the claim stays PENDING" };
  const expected = logicalToRaw(BigInt(claim.amount_micro), meta.decimals);
  if (meta.decimals !== Number(claim.token_decimals) || expected.dust !== 0n || expected.raw !== BigInt(claim.amount_raw)) return { ok: false, reason: "TOKEN_CONFIG_CHANGED", detail: "the token's decimals() no longer matches the amount frozen on this claim" };
  let facts: TransferFacts | null;
  try {
    facts = await reader.getTransfer(hash);
  } catch (e) {
    return { ok: false, reason: "CHAIN_UNAVAILABLE", detail: `the chain could not be read (${e instanceof Error ? e.message : "error"}) — the claim stays PENDING` };
  }
  if (!facts) return { ok: false, reason: "TX_NOT_FOUND", detail: "the network does not know that transaction (yet)" };
  const check = verifyManualTransfer(facts, { ...claim, amount_raw: expected.raw.toString() }, settings.arena_picks.minConfirmations);
  if (!check.ok) return { ok: false, reason: check.problem, detail: check.detail };

  try {
    return await db.transaction(async (tx): Promise<MarkSentResult> => {
      await lockRewardAccount(tx, Number(claim.telegram_user_id));
      const [done] = await tx.query<ClaimRow>(
        `update public.arena_reward_claims set status = 'SENT', tx_hash = $2, sent_at = $3::timestamptz, sent_by = $4, verification = $5::jsonb
          where id = $1 and status = 'PENDING' returning ${CLAIM_COLS}`,
        [claim.id, hash, ctx.now().toISOString(), input.actor, json(check.details)],
      );
      if (!done) return { ok: false, reason: "WRONG_STATE", detail: "this claim is no longer pending" };
      const amount = BigInt(claim.amount_micro);
      await postRewardLedger(tx, { userId: Number(claim.telegram_user_id), kind: "CLAIM_SENT", claimableDelta: 0n, reservedDelta: -amount, claimedDelta: amount, claimId: claim.id, meta: { txHash: hash, actor: input.actor }, idempotencyKey: `claim:${claim.id}:sent` });
      return { ok: true, claim: claimView(done) };
    });
  } catch (e) {
    if (isUniqueViolation(e, "arena_reward_claims_tx_hash")) return { ok: false, reason: "TX_IN_USE", detail: "that transaction is already recorded as the payout of another claim" };
    throw e;
  }
}

export type DenyResult = { ok: true; claim: ClaimView; accountHeld: boolean } | { ok: false; reason: "NOT_FOUND" | "WRONG_STATE" | "REASON_REQUIRED" };

/**
 * PENDING → DENIED with a reason. The reservation returns to claimable (nothing earned is ever destroyed). A reason that
 * suggests abuse also puts the account under REVIEW so it cannot simply claim again — the existing hold, with an audit trail.
 */
export async function denyClaim(db: Db, ctx: { now: () => Date }, input: { claimId: string; reason: DenialReason; note?: string; actor: string }): Promise<DenyResult> {
  if (!(input.reason in DENIAL_REASONS)) return { ok: false, reason: "REASON_REQUIRED" };
  const note = (input.note ?? "").trim().slice(0, 500);
  if (input.reason === "OTHER" && note.length < 3) return { ok: false, reason: "REASON_REQUIRED" };
  return db.transaction(async (tx): Promise<DenyResult> => {
    const [peek] = await tx.query<{ telegram_user_id: number }>("select telegram_user_id from public.arena_reward_claims where id = $1", [input.claimId]);
    if (!peek) return { ok: false, reason: "NOT_FOUND" };
    const account = await lockRewardAccount(tx, Number(peek.telegram_user_id));
    const [done] = await tx.query<ClaimRow>(
      `update public.arena_reward_claims set status = 'DENIED', denied_at = $2::timestamptz, denied_by = $3, denial_reason = $4, denial_note = $5
        where id = $1 and status = 'PENDING' returning ${CLAIM_COLS}`,
      [input.claimId, ctx.now().toISOString(), input.actor, input.reason, note || null],
    );
    if (!done) return { ok: false, reason: "WRONG_STATE" };
    const amount = BigInt(done.amount_micro);
    await postRewardLedger(tx, { userId: Number(done.telegram_user_id), kind: "CLAIM_RELEASED", claimableDelta: amount, reservedDelta: -amount, claimId: done.id, meta: { reason: input.reason, actor: input.actor }, idempotencyKey: `claim:${done.id}:released` });
    let held = false;
    if (DENIAL_REASONS[input.reason].holdsAccount && account.reviewState === "NORMAL") {
      await tx.query("update public.arena_reward_accounts set review_state = 'REVIEW', review_reason = $2, review_updated_at = now(), review_updated_by = $3 where telegram_user_id = $1", [done.telegram_user_id, `Claim denied: ${DENIAL_REASONS[input.reason].label}`.slice(0, 300), input.actor]);
      held = true;
    }
    return { ok: true, claim: claimView(done), accountHeld: held };
  });
}

/** Helper for read paths that only need to know whether the member has a claim waiting. */
export async function hasPendingClaim(q: Queryable, userId: number): Promise<boolean> {
  return (await q.query("select 1 from public.arena_reward_claims where telegram_user_id = $1 and status = 'PENDING'", [userId])).length > 0;
}
