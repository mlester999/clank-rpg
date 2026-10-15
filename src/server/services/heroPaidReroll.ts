import { encodeFunctionData, erc20Abi } from "viem";

import type { FreeRerollResultDto } from "@/domain/hero/freeReroll";
import { BLOCK_MESSAGE, nextRerollAt, rerollDay } from "@/domain/hero/freeReroll";
import {
  chainIdHex,
  checkPayment,
  PAID_BLOCK_MESSAGE,
  PAID_MESSAGE,
  PAYMENT_PROBLEM_MESSAGE,
  paidMemberActor,
  type PaidRerollErrorCode,
  type PaidRerollOutcomeDto,
  type PaidRerollPaymentRequest,
  type PaidRerollStatusDto,
} from "@/domain/hero/paidReroll";
import { formatTokenAmount, LOGICAL_DECIMALS, parseTokenAmount } from "@/domain/rewards/tokens";

import { ChainReadError, type RewardChainReader } from "../rewards/chain";
import { verifiedTokenMetadata } from "../rewards/tokenMetadata";
import { type Db, type Queryable } from "../db/types";

import { audit } from "./auditLog";
import { buildRerollResult, constraintOf, freeRerollReady, HERO_SQL, rollNewHeroVersion, unavailableReason, type FreeRerollDeps, type MemberHero } from "./heroFreeReroll";
import { invalidateHeroCards } from "./heroCache";
import { assertNotInArena, heroCardFor, HeroVersionError } from "./heroVersions";
import { heroArenaLock } from "./heroVersionStore";

/**
 * THE PAID HERO REROLL (docs/HERO_PAID_REROLL.md). A member who has used today's free reroll pays $CLANKRPG for another. Server-authoritative end to end, and — like every
 * token feature here — READ-ONLY on the chain: the app holds no key and sends nothing. The member's own wallet signs an ordinary ERC-20 transfer to the reward treasury; this
 * module only asks the chain whether it happened.
 *
 *   · THE CHAIN IS CALLED OUTSIDE EVERY DATABASE TRANSACTION. The shared database handle has one connection in production, and an RPC call (seconds, with a retry) must never
 *     hold it — nor sit inside a transaction that holds a hero's row lock.
 *   · A VERIFIED PAYMENT IS RECORDED FIRST, AS A CREDIT (`hero_paid_rerolls`, status PAID, UNIQUE on the transaction hash), in a transaction of its own; the reroll is APPLIED in a
 *     second one. So a payment is never lost: if the hero is in a live Arena fight, the daily brake is reached or the answer to the browser is lost, the credit stays, the status
 *     says so, and the next attempt applies it — with no second payment.
 *   · ONE PAYMENT, ONE REROLL. The transaction hash is the key: a replay returns the reroll it bought, a hash recorded for another member is refused, and the database refuses a
 *     paid version that has no applied payment (migration 3000).
 *   · WHO PAID MATTERS. The payment must come from a wallet the member proved control of (the hero's linked wallet, or the reward-holder wallet) — a hash seen in a public
 *     mempool cannot be claimed by anyone else.
 *   · THE ROLL IS THE FREE REROLL'S, unchanged (`rollNewHeroVersion`): same generator, odds and validation; the old state stays in the version history.
 */

export class PaidRerollError extends Error {
  constructor(
    readonly code: PaidRerollErrorCode,
    readonly status: number,
    message?: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message ?? code);
  }
}

/** The chain side of the feature, resolved by the caller (routes read the environment; tests hand in a simulated chain). */
export interface PaidRerollChain {
  reader: RewardChainReader | null;
  /** Where the payment must go: the reward treasury. Null = not configured. */
  treasuryAddress: string | null;
  rpcUrl: string | null;
  explorerTxUrl: string | null;
  chainName?: string;
}

export interface PaidRerollDeps extends FreeRerollDeps {
  chain: PaidRerollChain;
}

const nowOf = (d: FreeRerollDeps): Date => (d.now ? d.now() : new Date());
const lower = (a: string): string => a.toLowerCase();

/** Has the migration been applied? (The code can ship before it.) */
export async function paidRerollReady(q: Queryable): Promise<boolean> {
  const [row] = await q.query<{ ready: boolean }>("select (to_regclass('public.hero_paid_rerolls') is not null) as ready");
  return Boolean(row?.ready);
}

/** The wallets this member has PROVED control of: their hero's linked wallet and the reward-holder wallet (both bound by a signed server challenge). Lower-case, distinct. */
export async function memberWalletAddresses(q: Queryable, memberId: number, characterId: string): Promise<string[]> {
  const linked = await q.query<{ address: string }>("select address from public.wallet_links where character_id = $1 and unlinked_at is null", [characterId]);
  const out = new Set(linked.map((r) => lower(r.address)));
  const [hasHolder] = await q.query<{ ok: boolean }>("select to_regclass('public.arena_reward_accounts') is not null as ok");
  if (hasHolder?.ok) {
    const holder = await q.query<{ a: string | null }>("select holder_wallet_address as a from public.arena_reward_accounts where telegram_user_id = $1 and holder_wallet_address is not null", [memberId]);
    for (const h of holder) if (h.a) out.add(lower(h.a));
  }
  return [...out];
}

interface PaymentRow {
  id: string;
  telegram_user_id: number;
  character_id: string;
  tx_hash: string;
  status: "PAID" | "APPLIED";
  amount_raw: string;
  price_tokens: string;
  paid_at: Date;
  request_id: string | null;
  hero_version_id: string | null;
  previous_version_id: string | null;
  applied_at: Date | null;
}
const PAYMENT_COLUMNS = "id, telegram_user_id, character_id, tx_hash, status, amount_raw::text as amount_raw, price_tokens, paid_at, request_id, hero_version_id, previous_version_id, applied_at";

const today = (d: FreeRerollDeps): string => rerollDay(nowOf(d).getTime());

async function usedToday(q: Queryable, memberId: number, day: string): Promise<number> {
  const [r] = await q.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls where telegram_user_id = $1 and utc_day = $2::date and status = 'APPLIED'", [memberId, day]);
  return Number(r?.n ?? 0);
}

const priceLabel = (whole: string): string => formatTokenAmount(parseTokenAmount(whole, LOGICAL_DECIMALS), LOGICAL_DECIMALS);

// ---------------------------------------------------------------------------------------------------------------------
// STATUS (read-only)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The member's paid-reroll status. `enabled` is the feature flag and `freeEnabled` the free reroll's (the caller reads both). A disabled feature answers DISABLED without
 * touching the hero tables, and a missing migration / unlaunched token answers UNAVAILABLE — the page never breaks because of this feature.
 */
export async function getPaidRerollStatus(q: Queryable, memberId: number, flags: { enabled: boolean; freeEnabled: boolean }, deps: PaidRerollDeps): Promise<PaidRerollStatusDto> {
  const now = nowOf(deps).getTime();
  const cfg = deps.settings.hero_reroll;
  const base: PaidRerollStatusDto = {
    state: "DISABLED",
    serverNow: now,
    message: PAID_MESSAGE.DISABLED,
    block: null,
    price: null,
    usedToday: 0,
    maxPerDay: cfg.paidMaxPerDay,
    wallet: { linked: false, address: null, addresses: [] },
    credit: null,
    payment: null,
    explorerTxUrl: deps.chain.explorerTxUrl,
    current: null,
  };
  if (!flags.enabled) return base;
  const unavailable = (message: string): PaidRerollStatusDto => ({ ...base, state: "UNAVAILABLE", message });
  if (!(await paidRerollReady(q))) return unavailable("Paid rerolls aren't ready on this server yet.");
  const reader = deps.chain.reader;
  const treasury = deps.chain.treasuryAddress;
  if (!reader || !treasury) return unavailable(PAID_MESSAGE.UNAVAILABLE);
  const meta = await verifiedTokenMetadata(q, reader);
  if (!meta) return unavailable(PAID_MESSAGE.UNAVAILABLE);

  const label = priceLabel(cfg.paidPrice);
  const withPrice: PaidRerollStatusDto = { ...base, price: { whole: cfg.paidPrice, label, symbol: `$${meta.symbol.replace(/^\$/, "")}` } };

  const [hero] = await q.query<MemberHero>(HERO_SQL, [memberId]);
  if (!hero || !hero.current_hero_version_id) return { ...withPrice, state: "BLOCKED", block: "NO_HERO", message: BLOCK_MESSAGE.NO_HERO };
  const current = await heroCardFor(q, hero.id, deps);
  const wallets = await memberWalletAddresses(q, memberId, hero.id);
  const wallet = { linked: wallets.length > 0, address: wallets[0] ?? null, addresses: wallets };
  const used = await usedToday(q, memberId, today(deps));
  const [credit] = await q.query<{ tx_hash: string; paid_at: Date }>("select tx_hash, paid_at from public.hero_paid_rerolls where telegram_user_id = $1 and status = 'PAID' order by paid_at limit 1", [memberId]);
  const shared = { ...withPrice, current, wallet, usedToday: used, credit: credit ? { txHash: credit.tx_hash, paidAt: new Date(credit.paid_at).getTime() } : null };

  const block = unavailableReason(hero, deps.allowDemo);
  if (block) return { ...shared, state: "BLOCKED", block, message: PAID_BLOCK_MESSAGE[block] };
  if (credit) {
    const inArena = (await heroArenaLock(q, hero.id)).locked;
    return { ...shared, state: "CREDIT_WAITING", block: inArena ? "HERO_IN_ARENA" : null, message: inArena ? PAID_MESSAGE.CREDIT_IN_ARENA : PAID_MESSAGE.CREDIT_READY };
  }
  if (used >= cfg.paidMaxPerDay) return { ...shared, state: "LIMIT_REACHED", message: PAID_MESSAGE.LIMIT_REACHED };
  if (flags.freeEnabled && (await freeRerollReady(q))) {
    const [freeUsed] = await q.query("select 1 from public.hero_free_rerolls where telegram_user_id = $1 and utc_day = $2::date", [memberId, today(deps)]);
    if (!freeUsed) return { ...shared, state: "FREE_FIRST", message: PAID_MESSAGE.FREE_FIRST };
  }
  if ((await heroArenaLock(q, hero.id)).locked) return { ...shared, state: "BLOCKED", block: "HERO_IN_ARENA", message: PAID_BLOCK_MESSAGE.HERO_IN_ARENA };

  const amountRaw = parseTokenAmount(cfg.paidPrice, meta.decimals);
  const payment: PaidRerollPaymentRequest = {
    chainId: reader.chainId,
    chainIdHex: chainIdHex(reader.chainId),
    chainName: deps.chain.chainName ?? "Robinhood Chain",
    rpcUrl: deps.chain.rpcUrl,
    to: reader.tokenAddress,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [treasury as `0x${string}`, amountRaw] }),
    recipient: treasury,
    amountRaw: amountRaw.toString(),
  };
  return { ...shared, state: "AVAILABLE", message: null, payment };
}

// ---------------------------------------------------------------------------------------------------------------------
// CONFIRM: verify the payment on-chain, record it as a credit, apply the reroll
// ---------------------------------------------------------------------------------------------------------------------

const paymentSummary = (row: Pick<PaymentRow, "tx_hash" | "amount_raw">, decimals: number, symbol: string) => ({
  txHash: row.tx_hash,
  amountLabel: formatTokenAmount(BigInt(row.amount_raw), decimals),
  symbol: `$${symbol.replace(/^\$/, "")}`,
});

/**
 * Turns a payment the member made into a reroll. `requestId` is the browser's idempotency key for this attempt (it becomes the new hero version's key); `txHash` is the transaction
 * their wallet returned. Idempotent on the hash: a retry returns the reroll the payment already bought and writes nothing.
 *
 * Returns PENDING while the payment is not confirmed on-chain yet (nothing is recorded or used); throws `PaidRerollError` for everything else — and when it throws AFTER the
 * payment was verified, the payment is already safe as a credit (the status says CREDIT_WAITING).
 */
export async function confirmPaidReroll(db: Db, memberId: number, input: { requestId: string; txHash: string }, deps: PaidRerollDeps): Promise<PaidRerollOutcomeDto> {
  const txHash = lower(input.txHash);
  const cfg = deps.settings.hero_reroll;
  const reader = deps.chain.reader;
  const treasury = deps.chain.treasuryAddress ? lower(deps.chain.treasuryAddress) : null;
  if (!reader || !treasury) throw new PaidRerollError("PAID_REROLL_UNAVAILABLE", 503, PAID_MESSAGE.UNAVAILABLE);
  if (!(await paidRerollReady(db))) throw new PaidRerollError("PAID_REROLL_UNAVAILABLE", 503, "Paid rerolls aren't ready on this server yet.");
  const meta = await verifiedTokenMetadata(db, reader);
  if (!meta) throw new PaidRerollError("PAID_REROLL_UNAVAILABLE", 503, PAID_MESSAGE.UNAVAILABLE);
  const decimals = meta.decimals;

  // 1. Who is asking, and is their hero one a reroll can touch? (a plain read — the locked re-check happens when the reroll is applied)
  const [hero] = await db.query<MemberHero>(HERO_SQL, [memberId]);
  if (!hero || !hero.current_hero_version_id) throw new PaidRerollError("NO_HERO", 404, PAID_BLOCK_MESSAGE.NO_HERO);
  const block = unavailableReason(hero, deps.allowDemo);
  if (block) throw new PaidRerollError(block, block === "NOT_CLAIMED" ? 403 : 409, PAID_BLOCK_MESSAGE[block]);

  // 2. Is this payment already known?
  const [known] = await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from public.hero_paid_rerolls where tx_hash = $1`, [txHash]);
  if (known && Number(known.telegram_user_id) !== memberId) throw new PaidRerollError("TX_ALREADY_USED", 409, PAID_MESSAGE.TX_ALREADY_USED);
  if (known?.status === "APPLIED") {
    const result = await buildApplied(db, known, deps, true);
    return { status: "APPLIED", result, payment: paymentSummary(known, decimals, meta.symbol) };
  }

  // 3. A payment we have not recorded yet: verify it on-chain (NO database transaction is open).
  if (!known) {
    const wallets = await memberWalletAddresses(db, memberId, hero.id);
    if (wallets.length === 0) throw new PaidRerollError("WALLET_NOT_LINKED", 409, PAID_MESSAGE.WALLET_NOT_LINKED);
    let facts;
    try {
      facts = await reader.getTransfer(txHash);
    } catch (error) {
      if (error instanceof ChainReadError) throw new PaidRerollError("PAYMENT_CHECK_UNAVAILABLE", 503, PAID_MESSAGE.PAYMENT_CHECK_UNAVAILABLE);
      throw error;
    }
    if (!facts) return { status: "PENDING", confirmations: 0, required: cfg.paymentConfirmations };
    const requiredRaw = parseTokenAmount(cfg.paidPrice, decimals);
    const check = checkPayment(facts, { token: lower(reader.tokenAddress), recipient: treasury, requiredRaw, payers: wallets, chainId: reader.chainId });
    if (!check.ok) throw new PaidRerollError("PAYMENT_INVALID", 422, PAYMENT_PROBLEM_MESSAGE[check.reason], { reason: check.reason });
    if (facts.confirmations < cfg.paymentConfirmations) return { status: "PENDING", confirmations: facts.confirmations, required: cfg.paymentConfirmations };

    // 4. Record the credit — a transaction of its own, so it survives whatever happens to the reroll.
    const inserted = await db.query<{ id: string }>(
      `insert into public.hero_paid_rerolls (telegram_user_id, character_id, tx_hash, payer_address, recipient_address, token_address, chain_id, amount_raw, price_tokens)
       values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9) on conflict (tx_hash) do nothing returning id`,
      [memberId, hero.id, txHash, check.payer, treasury, lower(reader.tokenAddress), reader.chainId, check.amountRaw.toString(), cfg.paidPrice],
    );
    const [row] = await db.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from public.hero_paid_rerolls where tx_hash = $1`, [txHash]);
    if (!row || Number(row.telegram_user_id) !== memberId) throw new PaidRerollError("TX_ALREADY_USED", 409, PAID_MESSAGE.TX_ALREADY_USED);
    if (inserted.length > 0) {
      await audit(db, `member:${memberId}`, "hero.paid_reroll.payment", "character", hero.id, { txHash, payer: check.payer, recipient: treasury, amountRaw: check.amountRaw.toString(), price: cfg.paidPrice, chainId: reader.chainId });
    }
  }

  // 5. Apply the reroll with that credit.
  return applyCredit(db, memberId, txHash, input.requestId, deps, meta);
}

async function buildApplied(q: Queryable, row: PaymentRow, deps: FreeRerollDeps, alreadyApplied: boolean): Promise<FreeRerollResultDto> {
  return buildRerollResult(q, { characterId: row.character_id, requestId: row.request_id as string, versionId: row.hero_version_id as string, previousVersionId: row.previous_version_id as string, at: row.applied_at as Date }, deps, alreadyApplied);
}

async function applyCredit(db: Db, memberId: number, txHash: string, requestId: string, deps: PaidRerollDeps, meta: { decimals: number; symbol: string }): Promise<PaidRerollOutcomeDto> {
  const now = nowOf(deps);
  const day = rerollDay(now.getTime());
  const cfg = deps.settings.hero_reroll;
  let publicId: string | null = null;
  try {
    const outcome = await db.transaction(async (tx): Promise<PaidRerollOutcomeDto> => {
      // The hero's row lock first — every request of this member queues here.
      const [hero] = await tx.query<MemberHero>(`${HERO_SQL} for update of c`, [memberId]);
      if (!hero || !hero.current_hero_version_id) throw new PaidRerollError("NO_HERO", 404, PAID_BLOCK_MESSAGE.NO_HERO);
      publicId = hero.public_id;
      const [row] = await tx.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from public.hero_paid_rerolls where tx_hash = $1 for update`, [txHash]);
      if (!row || Number(row.telegram_user_id) !== memberId) throw new PaidRerollError("TX_ALREADY_USED", 409, PAID_MESSAGE.TX_ALREADY_USED);
      // Applied meanwhile (a second tab, a retry): answer with what it did.
      if (row.status === "APPLIED") return { status: "APPLIED", result: await buildApplied(tx, row, deps, true), payment: paymentSummary(row, meta.decimals, meta.symbol) };

      // A key already spent on some hero version (the free reroll, an admin rollback, another member) is never reusable.
      const [taken] = await tx.query("select 1 from public.hero_versions where request_id = $1", [requestId]);
      if (taken) throw new PaidRerollError("REQUEST_CONFLICT", 409, "That request key was already used.");

      const unavailable = unavailableReason(hero, deps.allowDemo);
      if (unavailable) throw new PaidRerollError(unavailable, unavailable === "NOT_CLAIMED" ? 403 : 409, PAID_BLOCK_MESSAGE[unavailable]);
      if ((await usedToday(tx, memberId, day)) >= cfg.paidMaxPerDay) throw new PaidRerollError("DAILY_LIMIT", 409, `${PAID_MESSAGE.LIMIT_REACHED} Your payment is safe.`, { nextResetAt: nextRerollAt(now.getTime()) });
      try {
        await assertNotInArena(tx, hero.id);
      } catch (e) {
        if (e instanceof HeroVersionError && e.code === "HERO_IN_ARENA") throw new PaidRerollError("HERO_IN_ARENA", 409, PAID_MESSAGE.CREDIT_IN_ARENA);
        throw e;
      }

      const { row: version, previous } = await rollNewHeroVersion(tx, hero, requestId, paidMemberActor(memberId), deps);
      await tx.query(
        `update public.hero_paid_rerolls set status = 'APPLIED', request_id = $2, hero_version_id = $3, previous_version_id = $4,
                from_class_id = $5, from_rarity = $6, from_power = $7, to_class_id = $8, to_rarity = $9, to_power = $10, applied_at = $11::timestamptz, utc_day = $12::date
          where id = $1 and status = 'PAID'`,
        [row.id, requestId, version.id, previous.id, previous.class_id, previous.rarity, Number(previous.power), version.class_id, version.rarity, Number(version.power), now.toISOString(), day],
      );
      await audit(tx, paidMemberActor(memberId), "hero.paid_reroll", "character", hero.id, {
        heroId: hero.id,
        publicId: hero.public_id,
        utcDay: day,
        requestId,
        txHash,
        previousVersion: Number(previous.version_number),
        newVersion: Number(version.version_number),
        previousVersionId: previous.id,
        newVersionId: version.id,
        from: { classId: previous.class_id, rarity: previous.rarity, power: Number(previous.power) },
        to: { classId: version.class_id, rarity: version.rarity, power: Number(version.power) },
        generatorVersion: version.generator_version,
      });
      const [applied] = await tx.query<PaymentRow>(`select ${PAYMENT_COLUMNS} from public.hero_paid_rerolls where id = $1`, [row.id]);
      return { status: "APPLIED", result: await buildApplied(tx, applied as PaymentRow, deps, false), payment: paymentSummary(applied as PaymentRow, meta.decimals, meta.symbol) };
    });
    if (publicId) invalidateHeroCards(publicId);
    return outcome;
  } catch (error) {
    if (error instanceof PaidRerollError) throw error;
    // The database is the last line of defence: if two writers ever got past the application's checks, its constraints answer the same way.
    const constraint = constraintOf(error);
    if (constraint === "hero_paid_rerolls_request_id_key" || constraint === "hero_versions_request_key") throw new PaidRerollError("REQUEST_CONFLICT", 409, "That request key was already used.");
    if (constraint === "hero_paid_rerolls_tx_hash_key") throw new PaidRerollError("TX_ALREADY_USED", 409, PAID_MESSAGE.TX_ALREADY_USED);
    throw error;
  }
}
