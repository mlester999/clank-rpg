import { randomBytes } from "node:crypto";

import { checkRewardAddress } from "@/domain/rewards/address";
import { failureBackoffMs, isVerificationStale, nextCheckDelayMs } from "@/domain/rewards/holderSchedule";
import type { BonusStatusDto, HolderCardDto } from "@/domain/rewards/holderDto";
import { bonusPercentLabel, bonusTierTable, buildBonusTiers, liveBonus, tierForBalance, tierName, type BonusTier, type LiveBonus, type Observation, type PeriodTerms } from "@/domain/rewards/holderBonus";
import { periodWindow, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { recoverSigner } from "../auth/wallet";
import type { Db, Queryable } from "../db/types";

import type { RewardChainReader } from "./chain";
import { getRewardEligibility } from "./eligibility";
import { getRewardAccount, lockRewardAccount } from "./ledger";
import { shortAddress } from "./format";

/**
 * HOLDER VERIFICATION — the OPTIONAL benefit. Holding $CLANKRPG changes exactly one thing: a BONUS (a percentage) on a Daily or
 * Weekly leaderboard prize the member already earned. It never changes picks, scored picks, Points, accuracy, rank, tie-breaks,
 * POWER or any combat stat. Wallet connection is not part of the gameplay path: a member with no wallet is a FREE member.
 *
 * Verification NEVER depends on the browser. Four server-side paths, all authoritative (the server reads ERC-20 `balanceOf` on the
 * one configured token; nothing the browser says about a wallet or a balance is believed). Each successful read is appended to
 * `arena_holder_observations` — the immutable EVIDENCE a bonus is later decided from:
 *   A. CONNECT    — the member signs a server-issued challenge; the server recovers the signer, links the wallet and reads the balance.
 *   B. MANUAL     — "Refresh holdings": another server-side read, rate-limited per member (default one per 5 minutes).
 *   C. BACKGROUND — each wallet has a `next_check_at` (~30 min, ± jitter); the 1-minute tick processes a bounded batch of the due ones.
 *   D. CLOSE      — at leaderboard close, every prize winner with a verified wallet gets a fresh read BEFORE the bonus is decided.
 *
 * Honest limits: tokens are not locked in a contract, so "verified holding continuity" means every authoritative check we made
 * saw the wallet at/above the threshold with no unverified gap longer than `holderMaxAgeHours` — never "provably every second".
 * A holding that is not verified (no wallet, stale, failed reads) earns no bonus; it never affects a base prize.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Ownership challenge → verified wallet
// ---------------------------------------------------------------------------------------------------------------------
const CHALLENGE_TTL_MS = 10 * 60_000;

export function buildHolderMessage(i: { heroName: string; address: string; chainId: number; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    "Clank RPG — verify your $CLANKRPG holder wallet",
    "",
    "Signing proves you control this wallet. It costs no gas and gives Clank RPG no access to your funds.",
    "",
    `Hero: ${i.heroName}`,
    `Wallet: ${i.address}`,
    `Chain ID: ${i.chainId}`,
    `Nonce: ${i.nonce}`,
    `Issued: ${i.issuedAt.toISOString()}`,
    `Expires: ${i.expiresAt.toISOString()}`,
  ].join("\n");
}

export type ChallengeResult = { ok: true; nonce: string; message: string; expiresAt: number } | { ok: false; reason: "INVALID_WALLET" | "NOT_ELIGIBLE" | "HOLDERS_UNAVAILABLE" };

export async function createHolderChallenge(db: Db, ctx: { now: () => Date }, input: { userId: number; address: string; chainId: number; forbidden: string[] }): Promise<ChallengeResult> {
  const checked = checkRewardAddress(input.address);
  if (!checked.ok || input.forbidden.includes(checked.address)) return { ok: false, reason: "INVALID_WALLET" };
  const [hero] = await db.query<{ name: string }>("select coalesce(name_override, name) as name from public.characters where telegram_user_id = $1", [input.userId]);
  if (!hero) return { ok: false, reason: "NOT_ELIGIBLE" };
  const nonce = randomBytes(24).toString("hex");
  const issuedAt = ctx.now();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const message = buildHolderMessage({ heroName: hero.name, address: checked.address, chainId: input.chainId, nonce, issuedAt, expiresAt });
  await db.query("insert into public.arena_wallet_challenges (nonce, telegram_user_id, address, chain_id, message, expires_at) values ($1, $2, $3, $4, $5, $6::timestamptz)", [nonce, input.userId, checked.address, input.chainId, message, expiresAt.toISOString()]);
  return { ok: true, nonce, message, expiresAt: expiresAt.getTime() };
}

export type VerifyWalletResult =
  | { ok: true; wallet: string; changed: boolean; status: HolderRefreshResult["status"] }
  | { ok: false; reason: "INVALID_CHALLENGE" | "BAD_SIGNATURE" | "NOT_ELIGIBLE" | "INVALID_WALLET" | "WALLET_IN_USE" | "FRESH_AUTH_REQUIRED" };

/**
 * Verifies the signed challenge and makes the signer the member's VERIFIED HOLDER wallet, then — in the same request — reads
 * the balance and logs the first observation (verification path A, CONNECT). Adding a first wallet needs nothing more;
 * switching from an existing wallet is a security-sensitive change (fresh Telegram sign-in) and resets the holder qualification (the new wallet must prove its own continuity). A wallet
 * already linked to another account is refused ("This wallet is already linked to another Clank RPG account."). The holder
 * wallet is not a payout destination — every claim names its own.
 */
export async function verifyHolderWallet(
  db: Db,
  ctx: { now: () => Date; allowDemo: boolean },
  input: { userId: number; nonce: string; signature: string; sessionIssuedAtMs: number; settings: GameSettings; forbidden: string[]; reader: RewardChainReader | null },
): Promise<VerifyWalletResult> {
  const [challenge] = await db.query<{ address: string; message: string; expires_at: Date; consumed_at: Date | null }>(
    "select address, message, expires_at, consumed_at from public.arena_wallet_challenges where nonce = $1 and telegram_user_id = $2",
    [input.nonce, input.userId],
  );
  if (!challenge || challenge.consumed_at || new Date(challenge.expires_at).getTime() <= ctx.now().getTime()) return { ok: false, reason: "INVALID_CHALLENGE" };
  // The server rebuilds nothing from the browser: the message is the one it stored, and the recovered signer must be the address.
  const signer = await recoverSigner(challenge.message, input.signature);
  if (signer === null || signer !== challenge.address) return { ok: false, reason: "BAD_SIGNATURE" };
  const consumed = await db.query("update public.arena_wallet_challenges set consumed_at = $2::timestamptz where nonce = $1 and consumed_at is null returning nonce", [input.nonce, ctx.now().toISOString()]);
  if (consumed.length === 0) return { ok: false, reason: "INVALID_CHALLENGE" }; // single-use: a replay finds it consumed

  const result = await setVerifiedHolderWallet(db, { now: ctx.now, allowDemo: ctx.allowDemo }, {
    userId: input.userId,
    address: challenge.address,
    sessionIssuedAtMs: input.sessionIssuedAtMs,
    settings: input.settings,
    forbidden: input.forbidden,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const refreshed = input.reader ? await refreshHolder(db, ctx, { userId: input.userId, reader: input.reader, settings: input.settings, source: "CONNECT" }) : { status: "UNAVAILABLE" as const };
  return { ok: true, wallet: challenge.address, changed: result.changed, status: refreshed.status };
}

// ---------------------------------------------------------------------------------------------------------------------
// The verified HOLDER wallet (a signature, not a pasted address)
// ---------------------------------------------------------------------------------------------------------------------
export type SetHolderWalletResult = { ok: true; address: string; changed: boolean } | { ok: false; reason: "FRESH_AUTH_REQUIRED" | "NOT_ELIGIBLE" | "INVALID_WALLET" | "WALLET_IN_USE" };

/**
 * Links a wallet whose ownership the member just PROVED (the caller verified the signature). Switching from an existing holder
 * wallet needs a FRESH Telegram sign-in (checked here against the session's issue time) and resets the holder qualification — the new
 * wallet must qualify again, from zero. A wallet already used by another account is refused (and the attempt logged for admin review)
 * unless an admin approved an exception for THIS account. Every binding or change is appended to the wallet history.
 */
export async function setVerifiedHolderWallet(
  db: Db,
  ctx: { now: () => Date; allowDemo: boolean },
  input: { userId: number; address: string; sessionIssuedAtMs: number; settings: GameSettings; forbidden: string[] },
): Promise<SetHolderWalletResult> {
  return db.transaction(async (tx): Promise<SetHolderWalletResult> => {
    const account = await lockRewardAccount(tx, input.userId);
    const eligibility = await getRewardEligibility(tx, input.userId, { threshold: input.settings.telegram.qualifyingThreshold, allowDemo: ctx.allowDemo });
    if (!eligibility.eligible) return { ok: false, reason: "NOT_ELIGIBLE" };
    const checked = checkRewardAddress(input.address);
    if (!checked.ok || input.forbidden.includes(checked.address)) return { ok: false, reason: "INVALID_WALLET" };
    if (account.holderWallet === checked.address) {
      await tx.query("update public.arena_reward_accounts set wallet_verified_at = coalesce(wallet_verified_at, $2::timestamptz) where telegram_user_id = $1", [input.userId, ctx.now().toISOString()]);
      return { ok: true, address: checked.address, changed: false };
    }
    if (account.holderWallet !== null) {
      const freshMs = input.settings.arena_picks.walletChangeFreshMinutes * 60_000;
      if (ctx.now().getTime() - input.sessionIssuedAtMs > freshMs) return { ok: false, reason: "FRESH_AUTH_REQUIRED" };
    }
    if (!account.walletException) {
      const [other] = await tx.query<{ telegram_user_id: number }>("select telegram_user_id from public.arena_reward_accounts where holder_wallet_address = $1 and telegram_user_id <> $2 limit 1", [checked.address, input.userId]);
      if (other) {
        await tx.query("insert into public.arena_reward_wallet_attempts (telegram_user_id, attempted_address, conflicting_user_id) values ($1, $2, $3)", [input.userId, checked.address, other.telegram_user_id]);
        return { ok: false, reason: "WALLET_IN_USE" };
      }
    }
    await tx.query("update public.arena_reward_accounts set holder_wallet_address = $2, wallet_verified_at = $3::timestamptz where telegram_user_id = $1", [input.userId, checked.address, ctx.now().toISOString()]);
    await tx.query("insert into public.arena_reward_wallet_history (telegram_user_id, old_address, new_address, actor, reason) values ($1, $2, $3, 'player', 'signed ownership challenge')", [input.userId, account.holderWallet, checked.address]);
    return { ok: true, address: checked.address, changed: true };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh: read the balance, log the observation, schedule the next check
// ---------------------------------------------------------------------------------------------------------------------
export type ObservationSource = "CONNECT" | "MANUAL" | "BACKGROUND" | "CLOSE";

export type HolderRefreshResult = { status: "NO_VERIFIED_WALLET" | "THROTTLED" | "UNAVAILABLE" } | { status: "OK"; balanceRaw: bigint; tierIndex: number };

interface HolderRow {
  wallet_address: string;
  verified_balance_raw: string;
  balance_verified_at: Date | null;
  last_check_at: Date | null;
  next_check_at: Date | null;
  check_failures: number;
  last_error: string | null;
}
const HOLDER_COLS = "wallet_address, verified_balance_raw::text, balance_verified_at, last_check_at, next_check_at, check_failures, last_error";

interface RefreshCtx {
  now: () => Date;
  /** Test seam for the schedule's jitter ([0, 1)). */
  random?: () => number;
}

/**
 * One authoritative verification of a member's connected wallet (any of the four paths). The member's own "Refresh holdings"
 * (`source: "MANUAL"`) is rate-limited per member. A SUCCESSFUL read is appended to the observation log (the continuity evidence);
 * a failed one is only counted and backed off — it is never evidence of anything.
 */
export async function refreshHolder(db: Db, ctx: RefreshCtx, input: { userId: number; reader: RewardChainReader; settings: GameSettings; source?: ObservationSource; manual?: boolean }): Promise<HolderRefreshResult> {
  const source: ObservationSource = input.source ?? (input.manual ? "MANUAL" : "BACKGROUND");
  const cfg = input.settings.arena_picks;
  const account = await getRewardAccount(db, input.userId);
  if (!account.holderWallet || !account.walletVerifiedAt) return { status: "NO_VERIFIED_WALLET" };
  const nowMs = ctx.now().getTime();
  const nowIso = ctx.now().toISOString();
  const random = ctx.random ?? Math.random;

  if (source === "MANUAL") {
    // Atomically take the manual slot: only one refresh per `holderManualRefreshSeconds`, whatever races. (The status row is
    // created on demand so the very first click is not special.)
    await db.query(
      `insert into public.arena_holder_status (telegram_user_id, wallet_address, next_check_at) values ($1, $2, $3::timestamptz) on conflict (telegram_user_id) do nothing`,
      [input.userId, account.holderWallet, nowIso],
    );
    const taken = await db.query(
      `update public.arena_holder_status set last_manual_refresh_at = $2::timestamptz
        where telegram_user_id = $1 and (last_manual_refresh_at is null or last_manual_refresh_at <= $3::timestamptz) returning telegram_user_id`,
      [input.userId, nowIso, new Date(nowMs - cfg.holderManualRefreshSeconds * 1000).toISOString()],
    );
    if (taken.length === 0) return { status: "THROTTLED" };
  }

  // The chain read happens OUTSIDE any transaction (a network call must never hold row locks). The CONTRACT's own decimals() (verified
  // metadata) is the only scale a balance can be compared in — nothing about it is configured.
  let balance: bigint;
  let contractDecimals: number;
  try {
    contractDecimals = (await input.reader.metadata()).decimals;
    balance = await input.reader.balanceOf(account.holderWallet);
  } catch (error) {
    // Cannot verify: record NO observation (so the gap shows in the evidence), COUNT the failure and back off so a broken endpoint is not hammered.
    const [row] = await db.query<{ check_failures: number }>("select check_failures from public.arena_holder_status where telegram_user_id = $1", [input.userId]);
    const failures = Number(row?.check_failures ?? 0) + 1;
    await db.query(
      `insert into public.arena_holder_status (telegram_user_id, wallet_address, last_check_at, last_error, check_failures, next_check_at)
       values ($1, $2, $3::timestamptz, $4, $5, $6::timestamptz)
       on conflict (telegram_user_id) do update set last_check_at = excluded.last_check_at, last_error = excluded.last_error, check_failures = excluded.check_failures, next_check_at = excluded.next_check_at, updated_at = now()`,
      [input.userId, account.holderWallet, nowIso, (error instanceof Error ? error.message : "read failed").slice(0, 200), failures, new Date(nowMs + failureBackoffMs(failures, cfg.holderRefreshMinutes)).toISOString()],
    );
    return { status: "UNAVAILABLE" };
  }

  const tiers = buildBonusTiers(cfg, contractDecimals);
  const nextAtIso = new Date(nowMs + nextCheckDelayMs(cfg.holderRefreshMinutes, cfg.holderRefreshJitterPct, random())).toISOString();
  return db.transaction(async (tx): Promise<HolderRefreshResult> => {
    await tx.query("select 1 from public.arena_reward_accounts where telegram_user_id = $1 for update", [input.userId]);
    const [fresh] = await tx.query<{ holder_wallet_address: string | null; wallet_verified_at: Date | null }>("select holder_wallet_address, wallet_verified_at from public.arena_reward_accounts where telegram_user_id = $1", [input.userId]);
    // The wallet changed while we were reading the chain: this balance is for the OLD wallet — discard it (the database refuses it too).
    if (!fresh || fresh.holder_wallet_address !== account.holderWallet || !fresh.wallet_verified_at) return { status: "NO_VERIFIED_WALLET" };
    await tx.query("insert into public.arena_holder_observations (telegram_user_id, wallet_address, balance_raw, observed_at, source) values ($1, $2, $3::numeric, $4::timestamptz, $5)", [input.userId, account.holderWallet, balance.toString(), nowIso, source]);
    await tx.query(
      `insert into public.arena_holder_status (telegram_user_id, wallet_address, verified_balance_raw, balance_verified_at, last_check_at, last_error, next_check_at, check_failures)
       values ($1, $2, $3::numeric, $4::timestamptz, $4::timestamptz, null, $5::timestamptz, 0)
       on conflict (telegram_user_id) do update set
         wallet_address = excluded.wallet_address, verified_balance_raw = excluded.verified_balance_raw, balance_verified_at = excluded.balance_verified_at,
         last_check_at = excluded.last_check_at, last_error = null, next_check_at = excluded.next_check_at, check_failures = 0, updated_at = now()`,
      [input.userId, account.holderWallet, balance.toString(), nowIso, nextAtIso],
    );
    return { status: "OK", balanceRaw: balance, tierIndex: tierForBalance(tiers, balance).index };
  });
}

/** The final authoritative verification of a prize winner at leaderboard close (path D). Never rate-limited; it is evidence, not a request. */
export const verifyForClose = (db: Db, ctx: RefreshCtx, input: { userId: number; reader: RewardChainReader; settings: GameSettings }): Promise<HolderRefreshResult> =>
  refreshHolder(db, ctx, { ...input, source: "CLOSE" });

export interface DueHoldersResult {
  /** Wallets that were due (and attempted) this pass — at most the batch size. */
  due: number;
  refreshed: number;
  failed: number;
}

/**
 * BACKGROUND verification (path C), run by the existing 1-minute tick / worker. Processes AT MOST `holderCheckBatchSize` wallets
 * whose `next_check_at` is due — never every wallet every minute. Never throws into the caller; a no-op before the migration.
 */
export async function refreshDueHolders(db: Db, ctx: RefreshCtx, reader: RewardChainReader | null, settings: GameSettings, limit?: number): Promise<DueHoldersResult> {
  const out: DueHoldersResult = { due: 0, refreshed: 0, failed: 0 };
  if (!reader) return out;
  const batch = Math.max(1, limit ?? settings.arena_picks.holderCheckBatchSize);
  let due: Array<{ telegram_user_id: number }>;
  try {
    due = await db.query<{ telegram_user_id: number }>(
      `select ra.telegram_user_id from public.arena_reward_accounts ra left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id
        where ra.wallet_verified_at is not null and (hs.telegram_user_id is null or hs.next_check_at <= $1::timestamptz)
        order by hs.next_check_at nulls first, ra.telegram_user_id limit $2`,
      [ctx.now().toISOString(), batch],
    );
  } catch (error) {
    if (/does not exist/i.test(error instanceof Error ? error.message : String(error))) return out; // migration not applied yet
    throw error;
  }
  out.due = due.length;
  for (const d of due) {
    const r = await refreshHolder(db, ctx, { userId: Number(d.telegram_user_id), reader, settings, source: "BACKGROUND" }).catch(() => ({ status: "UNAVAILABLE" as const }));
    if (r.status === "OK") out.refreshed++;
    else if (r.status === "UNAVAILABLE") out.failed++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The evidence: a member's observations of their CURRENT holder wallet
// ---------------------------------------------------------------------------------------------------------------------
/**
 * The member's authoritative balance reads of their CURRENT verified wallet, oldest first. Reads of any earlier wallet, and reads
 * from before the current wallet was bound, are NOT included — changing the holder wallet starts continuity from zero and a
 * wallet's history never follows it to another account (observations belong to the account that was bound at the time).
 */
export async function loadObservations(q: Queryable, userId: number, opts: { sinceMs?: number } = {}): Promise<Observation[]> {
  const rows = await q.query<{ observed_at: Date; balance_raw: string }>(
    `select o.observed_at, o.balance_raw::text from public.arena_holder_observations o
       join public.arena_reward_accounts a on a.telegram_user_id = o.telegram_user_id and a.holder_wallet_address = o.wallet_address and o.observed_at >= a.wallet_verified_at
      where o.telegram_user_id = $1 and ($2::timestamptz is null or o.observed_at >= $2::timestamptz)
      order by o.observed_at, o.id`,
    [userId, opts.sinceMs === undefined ? null : new Date(opts.sinceMs).toISOString()],
  );
  return rows.map((r) => ({ atMs: new Date(r.observed_at).getTime(), balanceRaw: BigInt(r.balance_raw) }));
}

async function loadHolder(q: Queryable, userId: number): Promise<HolderRow | undefined> {
  return (await q.query<HolderRow>(`select ${HOLDER_COLS} from public.arena_holder_status where telegram_user_id = $1`, [userId]))[0];
}

const HOUR = 3_600_000;
/** Extra history loaded for DISPLAY only (the true start of a long unbroken run); decisions use the minimal window. */
export const EVIDENCE_DISPLAY_EXTRA_MS = 14 * 24 * HOUR;
const qualifyHours = (settings: GameSettings, kind: PeriodKind): number => (kind === "DAILY" ? settings.arena_picks.holderDailyQualifyHours : settings.arena_picks.holderWeeklyQualifyHours);

/** The terms of the period running at `nowMs` for the live card (the period end is not used while it runs). */
export function liveTerms(settings: GameSettings, kind: PeriodKind, nowMs: number): PeriodTerms {
  const w = periodWindow(kind, nowMs);
  return { startsAtMs: w.startsAt, endsAtMs: w.endsAt, requiredMs: qualifyHours(settings, kind) * HOUR, maxGapMs: settings.arena_picks.holderMaxAgeHours * HOUR };
}

export interface HolderLive {
  observed: BonusTier;
  lastObservedAt: number | null;
  observations: number;
  daily: LiveBonus;
  weekly: LiveBonus;
}

/** Where a member stands for the Daily and the Weekly period that are running — from the same evidence finalization uses. */
export async function computeHolderLive(q: Queryable, userId: number, settings: GameSettings, tokenDecimals: number | null, nowMs: number): Promise<HolderLive> {
  // Tier thresholds are compared with CHAIN balances, so they need the contract's decimals; unknown (not launched / not verified yet) = no evidence to read.
  const tiers = buildBonusTiers(settings.arena_picks, tokenDecimals ?? LOGICAL_DECIMALS);
  const dTerms = liveTerms(settings, "DAILY", nowMs);
  const wTerms = liveTerms(settings, "WEEKLY", nowMs);
  // The decision itself needs only the window up to (period start − required − one freshness gap); the extra look-back lets the card show the
  // TRUE start of the unbroken run ("held since …") instead of the start of that window.
  const sinceMs = Math.min(dTerms.startsAtMs - dTerms.requiredMs, wTerms.startsAtMs - wTerms.requiredMs) - wTerms.maxGapMs - EVIDENCE_DISPLAY_EXTRA_MS;
  const observations = tokenDecimals === null ? [] : await loadObservations(q, userId, { sinceMs });
  const last = observations[observations.length - 1];
  return {
    observed: last ? tierForBalance(tiers, last.balanceRaw) : (tiers[0] as BonusTier),
    lastObservedAt: last?.atMs ?? null,
    observations: observations.length,
    daily: liveBonus({ tiers, observations, kind: "DAILY", terms: dTerms, nowMs }),
    weekly: liveBonus({ tiers, observations, kind: "WEEKLY", terms: wTerms, nowMs }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the member sees (Profile → Arena Picks → HOLDER REWARD BONUS)
// ---------------------------------------------------------------------------------------------------------------------
export type { BonusStatusDto, HolderCardDto };

function statusDto(live: LiveBonus, tiers: readonly BonusTier[], kind: PeriodKind, nowMs: number): BonusStatusDto {
  const w = periodWindow(kind, nowMs);
  const tier = (i: number): BonusTier | null => tiers[i] ?? null;
  const paying = live.status === "QUALIFIED" ? tier(live.tierIndex) : null;
  const up = live.upgradingToIndex !== null ? tier(live.upgradingToIndex) : null;
  return {
    status: live.status,
    payingBonus: paying ? bonusPercentLabel(paying.bonusBps) : null,
    payingTier: paying ? paying.label : null,
    upgradingTo: up ? { tier: up.label, bonus: bonusPercentLabel(up.bonusBps), eligibleFrom: live.eligibleFromMs } : null,
    tier: live.tierIndex > 0 ? (tier(live.tierIndex)?.label ?? null) : null,
    heldMs: live.heldMs,
    requiredMs: live.requiredMs,
    eligibleFrom: live.status === "QUALIFYING" ? live.eligibleFromMs : null,
    brokenAt: live.brokenAtMs,
    periodStartsAt: w.startsAt,
    periodEndsAt: w.endsAt,
  };
}

/**
 * `token.decimals` is the contract's own decimals() (null until the token has launched AND been verified); `token.launched` says whether an
 * official address is configured at all. Before launch the card carries no balance and no tier: just the planned ladder and 0 %.
 */
export async function getHolderCard(q: Queryable, userId: number, settings: GameSettings, token: { launched: boolean; decimals: number | null }, nowMs: number, available: boolean): Promise<HolderCardDto> {
  const cfg = settings.arena_picks;
  const decimals = token.decimals ?? LOGICAL_DECIMALS;
  const tiers = buildBonusTiers(cfg, decimals);
  const [row, account, live] = await Promise.all([loadHolder(q, userId), getRewardAccount(q, userId), computeHolderLive(q, userId, settings, token.decimals, nowMs)]);
  const walletConnected = Boolean(account.walletVerifiedAt && account.holderWallet);
  const verifiedMs = row?.balance_verified_at ? new Date(row.balance_verified_at).getTime() : null;
  // The tier shown is the tier of the last VERIFIED balance; a wallet that was never read is FREE.
  const observed = walletConnected && row && token.decimals !== null ? tierForBalance(tiers, BigInt(row.verified_balance_raw)) : (tiers[0] as BonusTier);
  const next = tiers[observed.index + 1] ?? null;
  return {
    launched: token.launched,
    available,
    walletConnected,
    wallet: { short: walletConnected ? shortAddress(account.holderWallet) : null },
    tier: { index: observed.index, name: tierName(observed), label: observed.label, bonusBps: observed.bonusBps, bonus: bonusPercentLabel(observed.bonusBps) },
    verificationNeeded: walletConnected && isVerificationStale(verifiedMs, nowMs, cfg.holderMaxAgeHours),
    balance: walletConnected && row && token.decimals !== null ? formatTokenAmount(BigInt(row.verified_balance_raw), decimals) : null,
    balanceVerifiedAt: verifiedMs,
    nextTier: next ? { name: tierName(next), label: next.label, minimum: formatTokenAmount(next.minimumRaw, decimals), bonus: bonusPercentLabel(next.bonusBps) } : null,
    daily: statusDto(live.daily, tiers, "DAILY", nowMs),
    weekly: statusDto(live.weekly, tiers, "WEEKLY", nowMs),
    tiers: bonusTierTable(tiers).map((t) => ({ ...t, minimum: formatTokenAmount(tiers[t.index]?.minimumRaw ?? 0n, decimals) })),
    maxBonus: bonusPercentLabel(tiers.reduce((m, t) => Math.max(m, t.bonusBps), 0)),
    symbol: "$CLANKRPG",
  };
}
