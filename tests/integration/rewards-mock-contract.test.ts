import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buyUrl } from "@/domain/rewards/buyLink";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { reconcileRewards } from "@/server/rewards/admin";
import { markClaimSent, requestClaim, type MarkSentResult } from "@/server/rewards/claims";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import { getTokenStatus, setChainReaderForTests } from "@/server/rewards/context";
import { reconcileBonus } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import { getClaimTarget } from "@/server/rewards/target";
import { cachedTokenMetadata, currentTokenMetadata, resetTokenMetadataMemo, verifiedTokenMetadata } from "@/server/rewards/tokenMetadata";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { balanceOf, bindWallet, chainTokens, credit, finalize, HOUR, newChain, observeSteady, resultOf, seedScores, TOKEN, tokens, utc, walletFor, WALLET_A } from "../support/rewards";

/**
 * A MOCK CONTRACT (the simulated chain adapter): the token exists, and its own decimals() and symbol() are the ONLY source of scale.
 * The same logical prizes, bonuses and claim amounts must come out identically whatever the contract's decimals are.
 */
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  setChainReaderForTests(undefined);
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  resetTokenMetadataMemo();
});

const DAY = "2026-10-07";
const CLOSE = utc(2026, 10, 8, 0, 0, 5);
const useContract = (opts: { decimals: number; symbol?: string }): SimulatedChainReader => {
  const chain = opts.symbol ? (() => { const c = newChain({ decimals: opts.decimals }); c.setMetadata({ symbol: opts.symbol }); return c; })() : newChain({ decimals: opts.decimals });
  setChainReaderForTests(chain);
  return chain;
};
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: new Date() })).toEqual([]);
};
const field = () => seedScores(db, Array.from({ length: 3 }, (_, i) => ({ user: 9001 + i, day: DAY, picks: 20, correct: 20 - i })));

describe("the BUY link follows the configured contract automatically", () => {
  it("no address → https://clank.trade/ ; an official address → https://clank.trade/<address> (the same function, no code change)", () => {
    setChainReaderForTests(undefined);
    expect(buyUrl(getTokenStatus().publicAddress)).toMatch(/^https:\/\/clank\.trade\/(0x[0-9a-f]{40})?$/);
    useContract({ decimals: 18 });
    expect(getTokenStatus()).toMatchObject({ launched: true, available: true, tokenAddress: TOKEN });
    expect(buyUrl(getTokenStatus().publicAddress)).toBe(`https://clank.trade/${TOKEN}`);
  });
});

describe.each([2, 6, 9, 18])("a contract with %i decimals", (decimals) => {
  it("symbol and decimals are AUTO-DETECTED from the contract (nothing is configured) and cached with the time they were verified", async () => {
    const chain = useContract({ decimals, symbol: "CLANKRPG" });
    expect(await cachedTokenMetadata(db, getTokenStatus())).toBeNull(); // nothing cached yet
    expect(await verifiedTokenMetadata(db, chain, Date.now())).toEqual({ decimals, symbol: "CLANKRPG" });
    expect(await cachedTokenMetadata(db, getTokenStatus())).toMatchObject({ tokenAddress: TOKEN, symbol: "CLANKRPG", decimals });
    expect((await currentTokenMetadata(db)).meta).toEqual({ decimals, symbol: "CLANKRPG" });
    expect(await getClaimTarget(db)).toMatchObject({ enabled: true, reason: null, tokenAddress: TOKEN, tokenDecimals: decimals });
  });

  it("a 10M holder qualifies for +25 % of the SAME logical prize: the balance is compared at the contract's decimals, the bonus is logical (7,500 either way)", async () => {
    const chain = useContract({ decimals });
    await field();
    const wallet = await bindWallet(db, 9001, { wallet: walletFor(9001), verifiedAtMs: utc(2026, 10, 5) });
    const balance = chainTokens(10_250_000, decimals);
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 22, 0), balance, 4 * HOUR);
    chain.setBalance(wallet, balance);
    await finalize(db, "DAILY", DAY, CLOSE, { reader: chain });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_prize_micro: tokens(30_000).toString(), bonus_status: "CREDITED", bonus_bps: 2500, bonus_micro: tokens(7_500).toString(), bonus_label: "10M" });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(37_500));
    await healthy();
  });

  it("the SAME raw balance means different holdings on different contracts: tiers are read at the contract's own decimals, never guessed (10,250,000 raw units = 102,500 tokens at 2 decimals, dust at 6+)", async () => {
    const chain = useContract({ decimals });
    await field();
    const wallet = await bindWallet(db, 9001, { wallet: walletFor(9001), verifiedAtMs: utc(2026, 10, 5) });
    const raw = 10_250_000n; // a bare 10,250,000 base units
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 22, 0), raw, 4 * HOUR);
    chain.setBalance(wallet, raw);
    await finalize(db, "DAILY", DAY, CLOSE, { reader: chain });
    const row = (await resultOf(db, "DAILY", DAY, 9001))!;
    if (decimals === 2) expect(row).toMatchObject({ bonus_status: "CREDITED", bonus_label: "100K", bonus_bps: 500 }); // 102,500 tokens
    else expect(row).toMatchObject({ bonus_status: "NONE", bonus_bps: 0 }); // 10.25 tokens at 6 decimals, a hair at 9 and 18
  });

  it("a claim converts logical → raw at the contract's decimals and MARK SENT verifies the exact raw amount (right amount → SENT; the same figure in another scale → WRONG_AMOUNT)", async () => {
    const chain = useContract({ decimals });
    const u = await seedEligibleMember(db);
    await credit(db, u, tokens(30_000));
    const target = await getClaimTarget(db);
    const r = await requestClaim(db, { now: () => new Date(), allowDemo: true }, { userId: u, idempotencyKey: `claim-key-${decimals}`, destination: { kind: "CUSTOM", address: WALLET_A }, settings: DEFAULT_SETTINGS, target });
    if (!r.ok) throw new Error(`claim refused: ${r.reason}`);
    const expectedRaw = chainTokens(30_000, decimals);
    expect(r.claim).toMatchObject({ amount: "30,000", amountRaw: expectedRaw.toString() });
    const mark = (hash: string): Promise<MarkSentResult> => markClaimSent(db, { now: () => new Date() }, chain, DEFAULT_SETTINGS, { claimId: r.claim.id, txHash: hash, actor: "admin" });
    // 30,000 whole tokens expressed in a DIFFERENT scale is the wrong amount
    const wrongRaw = decimals === 18 ? chainTokens(30_000, 6) : chainTokens(30_000, 18);
    const wrong = chain.sendTransfer({ to: WALLET_A, amountRaw: wrongRaw });
    chain.advance(2);
    expect(await mark(wrong.hash)).toMatchObject({ ok: false, reason: "WRONG_AMOUNT" });
    const right = chain.sendTransfer({ to: WALLET_A, amountRaw: expectedRaw });
    chain.advance(2);
    expect(await mark(right.hash)).toMatchObject({ ok: true, claim: { status: "SENT" } });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: 0n, reserved: 0n, claimed: tokens(30_000) });
    await healthy();
  });
});

describe("a contract that cannot be verified closes holder verification and payout verification — and nothing else", () => {
  it("the boards finalize and base prizes are credited; a long-history holder's bonus WAITS (pending) and is credited once the contract verifies again", async () => {
    const chain = useContract({ decimals: 18 });
    await field();
    const wallet = await bindWallet(db, 9001, { wallet: walletFor(9001), verifiedAtMs: utc(2026, 10, 5) });
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 22, 0), chainTokens(10_250_000), 4 * HOUR);
    chain.setBalance(wallet, chainTokens(10_250_000));
    chain.setMetadata(null); // decimals() / symbol() cannot be verified
    expect((await finalize(db, "DAILY", DAY, CLOSE, { reader: chain })).status).toBe("FINALIZED");
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ rank: 1, base_status: "CREDITED", base_prize_micro: tokens(30_000).toString(), bonus_status: "PENDING_VERIFICATION", bonus_micro: "0" });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(30_000)); // the base prize never waits
    expect((await getClaimTarget(db))).toMatchObject({ enabled: false, reason: "UNVERIFIED", tokenDecimals: null });
    // the contract becomes verifiable: the bonus is decided from the evidence and credited
    chain.setMetadata({ decimals: 18 });
    await observeSteady(db, 9001, utc(2026, 10, 8, 0, 0), utc(2026, 10, 8, 0, 0, 1), chainTokens(10_250_000), 1000);
    const out = await reconcileBonus(db, { now: () => new Date(CLOSE + HOUR), settings: DEFAULT_SETTINGS, reader: chain }, "DAILY", DAY, 9001);
    expect(out).toBe("CREDITED");
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ bonus_status: "CREDITED", bonus_bps: 2500, bonus_micro: tokens(7_500).toString() });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(37_500));
    await healthy();
  });

  it("claims cannot be verified while the contract is unverifiable: the claim stays PENDING (never SENT blindly)", async () => {
    const chain = useContract({ decimals: 18 });
    const u = await seedEligibleMember(db);
    await credit(db, u, tokens(30_000));
    const r = await requestClaim(db, { now: () => new Date(), allowDemo: true }, { userId: u, idempotencyKey: "claim-key-unverifiable", destination: { kind: "CUSTOM", address: WALLET_A }, settings: DEFAULT_SETTINGS, target: await getClaimTarget(db) });
    if (!r.ok) throw new Error(`claim refused: ${r.reason}`);
    const sent = chain.sendTransfer({ to: WALLET_A, amountRaw: BigInt(r.claim.amountRaw) });
    chain.advance(2);
    chain.setMetadata(null);
    expect(await markClaimSent(db, { now: () => new Date() }, chain, DEFAULT_SETTINGS, { claimId: r.claim.id, txHash: sent.hash, actor: "admin" })).toMatchObject({ ok: false, reason: "NEEDS_CHAIN" });
    chain.setMetadata({ decimals: 18 });
    expect(await markClaimSent(db, { now: () => new Date() }, chain, DEFAULT_SETTINGS, { claimId: r.claim.id, txHash: sent.hash, actor: "admin" })).toMatchObject({ ok: true });
  });
});
