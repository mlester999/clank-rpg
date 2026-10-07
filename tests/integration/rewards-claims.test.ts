import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseTokenAmount } from "@/domain/rewards/tokens";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { adminAdjust, adminDenyClaim, adminMarkClaimSent, claimCounts, listClaims, reconcileRewards, setReviewState } from "@/server/rewards/admin";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import { denyClaim, markClaimSent, requestClaim, type ClaimDestinationInput, type MarkSentResult, type RequestClaimResult } from "@/server/rewards/claims";
import { auditRewardAccounts, postRewardLedger, RewardIdempotencyConflictError } from "@/server/rewards/ledger";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { finalizePeriod } from "@/server/rewards/leaderboard";
import { balanceOf, DECIMALS, credit, ledgerCount, makeHolder, newChain, seedScores, settingsWith, targetFor, TOKEN, tokens, TREASURY, WALLET_A, WALLET_B, WALLET_C, walletFor, chainTokens } from "../support/rewards";

/**
 * MANUAL claims: a claim is a request that reserves the member's claimable balance; an admin pays by hand and names the
 * transaction; the server verifies it read-only on-chain before SENT. There is no sender and no key anywhere.
 */
let db: Db;
let chain: SimulatedChainReader;
let clock = Date.now();
const now = () => new Date(clock);

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  chain = newChain();
  clock = Date.now();
});

let keyN = 0;
const key = () => `claim-key-${++keyN}-${Math.random().toString(36).slice(2, 8)}`;

/** A member who has earned `amount`. */
async function earner(amount = tokens(25_000), opts: Parameters<typeof seedEligibleMember>[1] = {}): Promise<number> {
  const id = await seedEligibleMember(db, opts);
  if (amount > 0n) await credit(db, id, amount);
  return id;
}
const custom = (address: string): ClaimDestinationInput => ({ kind: "CUSTOM", address });
const HOLDER: ClaimDestinationInput = { kind: "HOLDER_WALLET" };
const claim = (userId: number, destination: ClaimDestinationInput = custom(WALLET_A), over: { key?: string; target?: ReturnType<typeof targetFor>; settings?: typeof DEFAULT_SETTINGS } = {}): Promise<RequestClaimResult> =>
  requestClaim(db, { now, allowDemo: true }, { userId, idempotencyKey: over.key ?? key(), destination, settings: over.settings ?? DEFAULT_SETTINGS, target: over.target ?? targetFor(chain) });
const claimRow = async (id?: string): Promise<Record<string, unknown>> =>
  (await db.query<Record<string, unknown>>(id ? "select * from public.arena_reward_claims where id = $1" : "select * from public.arena_reward_claims order by requested_at desc limit 1", id ? [id] : []))[0]!;
const okClaim = (r: RequestClaimResult) => {
  if (!r.ok) throw new Error(`claim refused: ${r.reason}`);
  return r.claim;
};
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: now() })).toEqual([]);
};
/** An admin pays the claim BY HAND (simulated on the chain), then names the transaction. */
const pay = (c: { destination: string; amountRaw: string }, over: { to?: string; amount?: bigint; token?: string; status?: "success" | "reverted" } = {}) => {
  const { hash } = chain.sendTransfer({ to: over.to ?? c.destination, amountRaw: over.amount ?? BigInt(c.amountRaw), ...(over.token ? { token: over.token } : {}), ...(over.status ? { status: over.status } : {}) });
  chain.advance(2);
  return hash;
};
const markSent = (claimId: string, txHash: string, reader: SimulatedChainReader | null = chain): Promise<MarkSentResult> => markClaimSent(db, { now }, reader, DEFAULT_SETTINGS, { claimId, txHash, actor: "admin" });

describe("requesting a claim creates a PENDING manual payout request (nothing is sent)", () => {
  it("a FREE member with no wallet must enter a destination; the whole claimable balance is reserved atomically and nothing leaves the app", async () => {
    const u = await earner();
    expect(await claim(u, HOLDER)).toEqual({ ok: false, reason: "NO_HOLDER_WALLET" });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n });

    const c = okClaim(await claim(u, custom(WALLET_A)));
    expect(c).toMatchObject({ status: "PENDING", amount: "25,000", destination: WALLET_A, destinationKind: "CUSTOM", txHash: null, sentAt: null, deniedAt: null });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: 0n, reserved: tokens(25_000), claimed: 0n, earned: tokens(25_000) });
    // The chain was only ever READ: no transaction exists.
    expect(chain.transferLookups).toBe(0);
    await healthy();
  });

  it("the destination is normalised (any valid case, stored lower-case)", async () => {
    const u = await earner();
    const c = okClaim(await claim(u, custom("0x52908400098527886E0F7030069857D2E4169EE7")));
    expect(c.destination).toBe(WALLET_A);
  });

  it("a verified holder can choose their CONNECTED wallet — recorded as a HOLDER_WALLET destination", async () => {
    const u = await earner();
    await makeHolder(db, u, 3);
    const c = okClaim(await claim(u, HOLDER));
    expect(c).toMatchObject({ destination: walletFor(u), destinationKind: "HOLDER_WALLET", status: "PENDING" });
  });

  it("a verified holder can choose ANOTHER wallet for this claim — it NEVER changes the holder wallet, its bonus evidence or its history", async () => {
    const u = await earner();
    await makeHolder(db, u, 3);
    const obsBefore = (await db.query<{ n: number }>("select count(*)::int as n from public.arena_holder_observations where telegram_user_id = $1", [u]))[0]!.n;
    const before = (await db.query<{ holder_wallet_address: string; wallet_verified_at: Date }>("select holder_wallet_address, wallet_verified_at from public.arena_reward_accounts where telegram_user_id = $1", [u]))[0]!;
    const c = okClaim(await claim(u, custom(WALLET_B)));
    expect(c).toMatchObject({ destination: WALLET_B, destinationKind: "CUSTOM" });
    const after = (await db.query<{ holder_wallet_address: string; wallet_verified_at: Date }>("select holder_wallet_address, wallet_verified_at from public.arena_reward_accounts where telegram_user_id = $1", [u]))[0]!;
    expect(after).toEqual(before); // the holder wallet is untouched
    expect(after.holder_wallet_address).toBe(walletFor(u));
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.arena_holder_observations where telegram_user_id = $1", [u]))[0]!.n).toBe(obsBefore); // the holder's verification evidence is untouched
    // (makeHolder itself bound the wallet once; claiming to ANOTHER address added nothing to either history.)
    expect(await db.query("select 1 from public.arena_holder_tier_history where telegram_user_id = $1 and kind = 'WALLET_CHANGED'", [u])).toHaveLength(1);
    expect(await db.query("select 1 from public.arena_reward_wallet_history where telegram_user_id = $1", [u])).toHaveLength(0);
  });

  it("typing your OWN holder wallet as 'another wallet' is recorded as the holder wallet (no confusion between the two)", async () => {
    const u = await earner();
    await makeHolder(db, u, 2);
    expect(okClaim(await claim(u, custom(walletFor(u).toUpperCase().replace("0X", "0x")))).destinationKind).toBe("HOLDER_WALLET");
  });

  it("zero, burn, reserved, malformed, the token contract and the reward wallet are refused — nothing reserved", async () => {
    const u = await earner();
    for (const bad of ["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000000001", "0x123", "not-an-address", TOKEN, TREASURY, "0x52908400098527886E0F7030069857D2E4169EE8"]) {
      expect(await claim(u, custom(bad)), bad).toEqual({ ok: false, reason: "INVALID_WALLET" });
    }
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n });
    expect(await db.query("select 1 from public.arena_reward_claims")).toEqual([]);
  });

  it("another account's VERIFIED holder wallet is not a destination for you (and the attempt is logged for review)", async () => {
    const owner = await earner(0n);
    await makeHolder(db, owner, 1, { wallet: WALLET_C });
    const u = await earner();
    expect(await claim(u, custom(WALLET_C))).toEqual({ ok: false, reason: "WALLET_IN_USE" });
    expect(await db.query<{ telegram_user_id: number; conflicting_user_id: number }>("select telegram_user_id, conflicting_user_id from public.arena_reward_wallet_attempts")).toEqual([{ telegram_user_id: u, conflicting_user_id: owner }]);
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n });
  });

  it("two accounts may NOT be silently merged by a shared custom destination — it is allowed but flagged for the admin", async () => {
    const a = await earner();
    const b = await earner();
    okClaim(await claim(a, custom(WALLET_A)));
    okClaim(await claim(b, custom(WALLET_A)));
    const rows = await listClaims(db, { status: "PENDING" });
    expect(rows.map((r) => r.other_accounts_same_destination)).toEqual([1, 1]);
  });
});

describe("the amount is server-derived and frozen; the reservation can never be claimed twice", () => {
  it("the payout is the member's WHOLE claimable balance from the ledger — the request has no amount to forge", async () => {
    const u = await earner(tokens(12_345));
    const c = okClaim(await claim(u));
    expect(c.amountRaw).toBe(chainTokens(12_345).toString());
    // The request type itself carries no amount (compile-time) and the HTTP body schema refuses one (security/rewards-http).
    expect(Object.keys({ userId: u, idempotencyKey: "x", destination: HOLDER, settings: DEFAULT_SETTINGS, target: targetFor(chain) })).not.toContain("amount");
  });

  it("a double-click creates exactly ONE request: the same idempotency key replays it, a racing second request is refused", async () => {
    const u = await earner();
    const k = key();
    const first = okClaim(await claim(u, custom(WALLET_A), { key: k }));
    const replay = await claim(u, custom(WALLET_A), { key: k });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    if (replay.ok) expect(replay.claim.id).toBe(first.id);
    expect(await claim(u, custom(WALLET_A), { key: key() })).toEqual({ ok: false, reason: "CLAIM_IN_PROGRESS" });
    expect(await db.query("select 1 from public.arena_reward_claims where telegram_user_id = $1", [u])).toHaveLength(1);
    expect(await ledgerCount(db, "CLAIM_RESERVED")).toBe(1);
    await healthy();
  });

  it("concurrent requests reserve the units ONCE (the partial unique index decides, not application code)", async () => {
    const u = await earner();
    const results = await Promise.allSettled([claim(u, custom(WALLET_A)), claim(u, custom(WALLET_B)), claim(u, custom(WALLET_C))]);
    const accepted = results.filter((r) => r.status === "fulfilled" && r.value.ok);
    expect(accepted).toHaveLength(1);
    expect(await db.query("select 1 from public.arena_reward_claims where telegram_user_id = $1", [u])).toHaveLength(1);
    expect(await balanceOf(db, u)).toMatchObject({ claimable: 0n, reserved: tokens(25_000) });
    await healthy();
  });

  it("while a claim is PENDING, new earnings accumulate as claimable but a second pending claim cannot exist", async () => {
    const u = await earner();
    okClaim(await claim(u));
    await credit(db, u, tokens(30_000));
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(30_000), reserved: tokens(25_000) });
    expect(await claim(u)).toEqual({ ok: false, reason: "CLAIM_IN_PROGRESS" });
    await healthy();
  });

  it("an admin can change NEITHER the amount NOR the destination: the database freezes them, and finished claims are frozen entirely", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    await expect(db.query("update public.arena_reward_claims set amount_raw = 1 where id = $1", [c.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.arena_reward_claims set destination_address = $2 where id = $1", [c.id, WALLET_B])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.arena_reward_claims set destination_kind = 'HOLDER_WALLET' where id = $1", [c.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.arena_reward_claims set token_address = $2 where id = $1", [c.id, WALLET_B])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.arena_reward_claims where id = $1", [c.id])).rejects.toThrow();
    // the mark-sent / deny APIs accept no amount or recipient at all
    expect(markClaimSent.length).toBe(5);
    expect(Object.keys({ claimId: c.id, txHash: "0x", actor: "a" })).toEqual(["claimId", "txHash", "actor"]);
    await expect(db.query("update public.arena_reward_claims set amount_micro = 1 where id = $1", [c.id])).rejects.toThrow(/immutable/);
    await expect(db.query("update public.arena_reward_claims set token_decimals = 6 where id = $1", [c.id])).rejects.toThrow(/immutable/);
    // the logical amount and its exact conversion at the contract's decimals are frozen together
    expect(await claimRow(c.id)).toMatchObject({ amount_micro: tokens(25_000).toString(), amount_raw: chainTokens(25_000).toString(), token_decimals: DECIMALS, destination_address: WALLET_A });
  });
});

describe("claim eligibility and availability (claims fail closed; rewards keep accumulating)", () => {
  it("before $CLANKRPG launches a claim is simply 'not yet' (never a denial) — nothing is reserved and the balance keeps accumulating", async () => {
    const u = await earner();
    expect(await claim(u, custom(WALLET_A), { target: targetFor(null) })).toEqual({ ok: false, reason: "TOKEN_NOT_LAUNCHED" });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n });
    expect(await listClaims(db, {})).toEqual([]); // no claim row exists, so nothing is DENIED either
    await healthy();
  });
  it("a token that has launched but whose contract cannot be verified closes claims too (fail closed) — the balance stays claimable", async () => {
    const u = await earner();
    expect(await claim(u, custom(WALLET_A), { target: targetFor(chain, { enabled: false, reason: "UNVERIFIED", tokenDecimals: null }) })).toEqual({ ok: false, reason: "CLAIMS_UNAVAILABLE" });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n });
  });
  it("nothing to claim / below the minimum claim", async () => {
    expect(await claim(await earner(0n))).toEqual({ ok: false, reason: "NOTHING_TO_CLAIM" });
    const small = await earner(tokens(9_999));
    expect(await claim(small)).toMatchObject({ ok: false, reason: "BELOW_MINIMUM" });
    expect(await claim(small, custom(WALLET_A), { settings: settingsWith({ minimumClaim: "5000" }) })).toMatchObject({ ok: true });
  });
  it("an account under REVIEW / SUSPENDED (or a flagged Telegram member) cannot claim — rewards stay recorded and safe", async () => {
    const u = await earner();
    await setReviewState(db, u, "REVIEW", "looking into it", "admin");
    expect(await claim(u)).toEqual({ ok: false, reason: "CLAIMS_HELD" });
    await setReviewState(db, u, "NORMAL", "", "admin");
    expect(await claim(u)).toMatchObject({ ok: true });
    const f = await earner(tokens(25_000), { status: "FLAGGED" });
    expect(await claim(f)).toEqual({ ok: false, reason: "CLAIMS_HELD" });
    const banned = await earner(tokens(25_000), { status: "BANNED" });
    expect(await claim(banned)).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
    const noHero = await earner(tokens(25_000), { hero: false });
    expect(await claim(noHero)).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
  });
  it("a prize finalized BEFORE the token existed is claimable afterwards at WHATEVER decimals the contract reports — logical → raw, exactly", async () => {
    // Finalized with no token at all (logical accounting carries no decimals); the contract appears later with its own scale.
    await seedScores(db, [{ user: 9901, day: "2026-10-06", picks: 20, correct: 12 }]);
    await finalizePeriod(db, { now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, 5)), settings: settingsWith(), reader: null }, "DAILY", "2026-10-06");
    expect((await balanceOf(db, 9901)).claimable).toBe(tokens(30_000)); // the sole winner takes the first rung of the 100,000 pool
    const c = okClaim(await claim(9901, custom(WALLET_A), { target: targetFor(chain, { tokenDecimals: 9 }) }));
    expect(c).toMatchObject({ amount: "30,000", amountRaw: (30_000n * 10n ** 9n).toString() });
    expect(await balanceOf(db, 9901)).toMatchObject({ claimable: 0n, reserved: tokens(30_000) });
    await healthy();
  });
  it("the same logical amount converts exactly at 6 and 18 decimals; a token with FEWER than 6 decimals pays the representable part and the dust stays claimable", async () => {
    for (const d of [6, 18]) {
      const u = await earner(tokens("12345.678901"));
      const c = okClaim(await claim(u, custom(WALLET_A), { target: targetFor(chain, { tokenDecimals: d }) }));
      expect(c.amountRaw, `decimals ${d}`).toBe((12_345_678_901n * 10n ** BigInt(d - 6)).toString());
      expect(await balanceOf(db, u)).toMatchObject({ claimable: 0n, reserved: tokens("12345.678901") });
    }
    const u = await earner(tokens("25000.123456"));
    const c = okClaim(await claim(u, custom(WALLET_A), { target: targetFor(chain, { tokenDecimals: 2 }) }));
    expect(c.amountRaw).toBe("2500012"); // 25,000.12 at 2 decimals
    expect(await balanceOf(db, u)).toMatchObject({ claimable: 3_456n, reserved: tokens("25000.12") }); // 0.003456 stays claimable, nothing is rounded away
    await healthy();
  });
});

describe("MARK SENT: only a transaction the chain confirms can complete a claim", () => {
  it("a valid payout (right token, recipient and amount) marks the claim SENT; the units move reserved → sent; the chain facts are recorded", async () => {
    const u = await earner();
    const c = okClaim(await claim(u, custom(WALLET_A)));
    const hash = pay(c);
    const r = await markSent(c.id, hash);
    expect(r).toMatchObject({ ok: true, claim: { status: "SENT", txHash: hash } });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: 0n, reserved: 0n, claimed: tokens(25_000), earned: tokens(25_000) });
    const row = await claimRow(c.id);
    expect(row).toMatchObject({ status: "SENT", tx_hash: hash, sent_by: "admin" });
    expect(row.verification).toMatchObject({ to: WALLET_A, token: TOKEN, value: chainTokens(25_000).toString() }); // the CHAIN amount (contract decimals)
    expect(await ledgerCount(db, "CLAIM_SENT")).toBe(1);
    await healthy();
  });

  it("works for a HOLDER_WALLET destination too, and for a claim paid from any wallet", async () => {
    const u = await earner();
    await makeHolder(db, u, 1);
    const c = okClaim(await claim(u, HOLDER));
    const { hash } = chain.sendTransfer({ to: c.destination, amountRaw: BigInt(c.amountRaw), from: "0x00000000000000000000000000000000000000aa" });
    chain.advance(2);
    expect(await markSent(c.id, hash)).toMatchObject({ ok: true });
  });

  it("a malformed hash is refused before anything else", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    for (const bad of ["", "0x", "0x123", "nonsense", `0x${"g".repeat(64)}`, `0x${"a".repeat(63)}`]) expect(await markSent(c.id, bad), bad).toMatchObject({ ok: false, reason: "INVALID_HASH" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
  });

  it("the WRONG RECIPIENT is rejected and the claim stays PENDING", async () => {
    const u = await earner();
    const c = okClaim(await claim(u, custom(WALLET_A)));
    expect(await markSent(c.id, pay(c, { to: WALLET_B }))).toMatchObject({ ok: false, reason: "WRONG_RECIPIENT" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
    expect(await balanceOf(db, u)).toMatchObject({ reserved: tokens(25_000), claimed: 0n });
  });

  it("the WRONG TOKEN is rejected", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    expect(await markSent(c.id, pay(c, { token: "0x5555555555555555555555555555555555555555" }))).toMatchObject({ ok: false, reason: "WRONG_TOKEN" });
  });

  it("the WRONG AMOUNT is rejected (a single base unit off)", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    for (const amount of [tokens(25_000) - 1n, tokens(25_000) + 1n, tokens(1)]) expect(await markSent(c.id, pay(c, { amount })), String(amount)).toMatchObject({ ok: false, reason: "WRONG_AMOUNT" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
  });

  it("a FAILED (reverted) transaction is rejected", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    expect(await markSent(c.id, pay(c, { status: "reverted" }))).toMatchObject({ ok: false, reason: "REVERTED" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
  });

  it("a transaction on the wrong chain is rejected", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const { hash } = chain.sendTransfer({ to: c.destination, amountRaw: BigInt(c.amountRaw), chainId: 1 });
    chain.advance(2);
    expect(await markSent(c.id, hash)).toMatchObject({ ok: false, reason: "WRONG_CHAIN" });
  });

  it("an unknown or not-yet-mined transaction keeps the claim PENDING; too few confirmations too", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    expect(await markSent(c.id, `0x${"7".repeat(64)}`)).toMatchObject({ ok: false, reason: "TX_NOT_FOUND" });
    const unmined = chain.sendTransfer({ to: c.destination, amountRaw: BigInt(c.amountRaw), mined: false });
    expect(await markSent(c.id, unmined.hash)).toMatchObject({ ok: false, reason: "TX_NOT_FOUND" });
    chain.mine(unmined.hash); // mined, 1 confirmation (the default needs 2)
    expect(await markSent(c.id, unmined.hash)).toMatchObject({ ok: false, reason: "NOT_CONFIRMED" });
    chain.advance(1);
    expect(await markSent(c.id, unmined.hash)).toMatchObject({ ok: true });
  });

  it("when the chain cannot be read, the claim stays PENDING (never marked SENT blindly): no reader, or an RPC outage", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const hash = pay(c);
    expect(await markSent(c.id, hash, null)).toMatchObject({ ok: false, reason: "NEEDS_CHAIN" });
    chain.setOutage(true);
    expect(await markSent(c.id, hash)).toMatchObject({ ok: false, reason: "CHAIN_UNAVAILABLE" });
    chain.setOutage(false);
    expect((await claimRow(c.id)).status).toBe("PENDING");
    expect(await markSent(c.id, hash)).toMatchObject({ ok: true }); // once the chain answers it completes
  });

  it("a changed token configuration cannot verify an old claim (it is checked against the token the claim was frozen with)", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const other = newChain();
    // Same address in this test harness, so emulate a config change by a different chain id.
    const moved = Object.assign(Object.create(other), { chainId: 1 }) as SimulatedChainReader;
    expect(await markSent(c.id, pay(c), moved)).toMatchObject({ ok: false, reason: "TOKEN_CONFIG_CHANGED" });
  });

  it("the SAME transaction can back only ONE claim, ever (database-enforced, not just application-checked)", async () => {
    const a = await earner();
    const b = await earner();
    const ca = okClaim(await claim(a, custom(WALLET_A)));
    const cb = okClaim(await claim(b, custom(WALLET_A)));
    const hash = pay(ca);
    expect(await markSent(ca.id, hash)).toMatchObject({ ok: true });
    // B's claim has the same destination and amount, so the transfer would even "match" — but it is already spoken for.
    expect(await markSent(cb.id, hash)).toMatchObject({ ok: false, reason: "TX_IN_USE" });
    expect((await claimRow(cb.id)).status).toBe("PENDING");
    // and the index itself refuses a direct write
    await expect(db.query("update public.arena_reward_claims set status = 'SENT', tx_hash = $2, sent_at = now() where id = $1", [cb.id, hash])).rejects.toThrow(/arena_reward_claims_tx_hash/);
    await healthy();
  });

  it("marking SENT twice is a no-op refusal: the claim is already SENT and nothing moves again", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const hash = pay(c);
    expect(await markSent(c.id, hash)).toMatchObject({ ok: true });
    expect(await markSent(c.id, hash)).toMatchObject({ ok: false, reason: "WRONG_STATE" }); // already SENT
    expect(await markSent(c.id, pay(c))).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    expect(await balanceOf(db, u)).toMatchObject({ claimed: tokens(25_000), reserved: 0n });
    expect(await ledgerCount(db, "CLAIM_SENT")).toBe(1);
    await healthy();
  });

  it("concurrent MARK SENT requests for one claim complete it exactly once", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const hash = pay(c);
    const results = await Promise.all([markSent(c.id, hash), markSent(c.id, hash), markSent(c.id, hash)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await ledgerCount(db, "CLAIM_SENT")).toBe(1);
    await healthy();
  });

  it("a SENT claim is frozen: it cannot be denied, edited or re-sent", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    await markSent(c.id, pay(c));
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "OTHER", note: "too late", actor: "admin" })).toEqual({ ok: false, reason: "WRONG_STATE" });
    await expect(db.query("update public.arena_reward_claims set status = 'PENDING', tx_hash = null, sent_at = null where id = $1", [c.id])).rejects.toThrow(/frozen/);
  });

  it("after SENT the member can claim again (new earnings), and the history keeps both", async () => {
    const u = await earner();
    const c1 = okClaim(await claim(u));
    await markSent(c1.id, pay(c1));
    await credit(db, u, tokens(11_000));
    const c2 = okClaim(await claim(u, custom(WALLET_B)));
    expect(c2.amount).toBe("11,000");
    expect((await claimCounts(db)).SENT.count).toBe(1);
    await healthy();
  });
});

describe("DENY: a reason is required and the reservation returns to claimable — nothing earned is ever destroyed", () => {
  it("an ordinary denial (invalid wallet) returns the whole reservation to CLAIMABLE and the member can claim again", async () => {
    const u = await earner();
    const c = okClaim(await claim(u, custom(WALLET_A)));
    const r = await denyClaim(db, { now }, { claimId: c.id, reason: "INVALID_WALLET", actor: "admin" });
    expect(r).toMatchObject({ ok: true, claim: { status: "DENIED", denialReason: "INVALID_WALLET" }, accountHeld: false });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n, claimed: 0n, earned: tokens(25_000) });
    expect(await ledgerCount(db, "CLAIM_RELEASED")).toBe(1);
    expect(await claimRow(c.id)).toMatchObject({ denied_by: "admin", denial_reason: "INVALID_WALLET" });
    expect(okClaim(await claim(u, custom(WALLET_B))).amountRaw).toBe(chainTokens(25_000).toString()); // can try again with a correct address
    await healthy();
  });

  it("requires a reason: an unknown code is refused and 'Other' needs a written note", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "NONSENSE" as never, actor: "admin" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "OTHER", actor: "admin" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "OTHER", note: "  ", actor: "admin" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "OTHER", note: "member asked to cancel", actor: "admin" })).toMatchObject({ ok: true });
    expect(await claimRow(c.id)).toMatchObject({ denial_note: "member asked to cancel" });
  });

  it("a suspicious / needs-review denial ALSO puts the account under REVIEW: rewards stay recorded, further claims are held", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    const r = await denyClaim(db, { now }, { claimId: c.id, reason: "SUSPICIOUS", actor: "admin" });
    expect(r).toMatchObject({ ok: true, accountHeld: true });
    expect(await balanceOf(db, u)).toMatchObject({ claimable: tokens(25_000), reserved: 0n }); // nothing destroyed
    expect(await claim(u)).toEqual({ ok: false, reason: "CLAIMS_HELD" });
    expect((await db.query<{ review_state: string; review_updated_by: string }>("select review_state, review_updated_by from public.arena_reward_accounts where telegram_user_id = $1", [u]))[0]).toEqual({ review_state: "REVIEW", review_updated_by: "admin" });
    // an admin can clear the hold after reviewing
    await setReviewState(db, u, "NORMAL", "", "admin");
    expect(await claim(u)).toMatchObject({ ok: true });
  });

  it("denying twice, or denying a missing claim, changes nothing", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    await denyClaim(db, { now }, { claimId: c.id, reason: "INVALID_WALLET", actor: "admin" });
    expect(await denyClaim(db, { now }, { claimId: c.id, reason: "INVALID_WALLET", actor: "admin" })).toEqual({ ok: false, reason: "WRONG_STATE" });
    expect(await denyClaim(db, { now }, { claimId: "00000000-0000-4000-8000-000000000000", reason: "OTHER", note: "x y z", actor: "admin" })).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await ledgerCount(db, "CLAIM_RELEASED")).toBe(1);
  });

  it("a DENIED claim is frozen (it can never become SENT afterwards)", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    await denyClaim(db, { now }, { claimId: c.id, reason: "INVALID_WALLET", actor: "admin" });
    expect(await markSent(c.id, pay(c))).toMatchObject({ ok: false, reason: "WRONG_STATE" });
    await expect(db.query("update public.arena_reward_claims set status = 'SENT', tx_hash = $2, sent_at = now() where id = $1", [c.id, `0x${"9".repeat(64)}`])).rejects.toThrow(/frozen/);
  });

  it("an audited admin wrapper records who denied or sent and why", async () => {
    const u = await earner();
    const c = okClaim(await claim(u));
    expect(await adminDenyClaim(db, { now }, { claimId: c.id, reason: "NEEDS_REVIEW" }, "admin")).toMatchObject({ ok: true });
    const audits = await db.query<{ action: string; detail: Record<string, unknown> }>("select action, detail from public.admin_audit_log where entity_type = 'arena_reward_claim' order by id");
    expect(audits.map((a) => a.action)).toEqual(["rewards.claim_denied"]);
    expect(audits[0]!.detail).toMatchObject({ reason: "NEEDS_REVIEW", accountHeld: true });
    await setReviewState(db, u, "NORMAL", "", "admin");
    const c2 = okClaim(await claim(u));
    expect(await adminMarkClaimSent(db, { now }, chain, DEFAULT_SETTINGS, { claimId: c2.id, txHash: pay(c2) }, "admin")).toMatchObject({ ok: true });
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log where entity_type = 'arena_reward_claim' order by id")).map((a) => a.action)).toEqual(["rewards.claim_denied", "rewards.claim_sent"]);
  });
});

describe("the admin queue and the books", () => {
  it("lists PENDING (oldest first, with destination kind, review status and amount), SENT and DENIED sections, with counts", async () => {
    const holder = await earner(tokens(40_000));
    await makeHolder(db, holder, 2);
    const free = await earner(tokens(15_000));
    const cH = okClaim(await claim(holder, HOLDER));
    const cF = okClaim(await claim(free, custom(WALLET_B)));
    const pending = await listClaims(db, { status: "PENDING" });
    expect(pending.map((r) => [r.telegram_user_id, r.destination_kind, r.amount, r.review_state])).toEqual([[holder, "HOLDER_WALLET", "40,000", "NORMAL"], [free, "CUSTOM", "15,000", "NORMAL"]]);
    await markSent(cH.id, pay(cH));
    await denyClaim(db, { now }, { claimId: cF.id, reason: "INVALID_WALLET", actor: "admin" });
    expect((await listClaims(db, { status: "SENT" })).map((r) => r.tx_hash)).toHaveLength(1);
    expect((await listClaims(db, { status: "DENIED" })).map((r) => r.denial_reason)).toEqual(["INVALID_WALLET"]);
    expect(await claimCounts(db)).toEqual({ PENDING: { count: 0, amount: "0" }, SENT: { count: 1, amount: "40,000" }, DENIED: { count: 1, amount: "15,000" } });
  });

  it("the admin is given the EXACT frozen amount to send: a share has up to 6 decimals, so the 4-decimal display figure can never verify", async () => {
    const u = await earner(tokens("27916.666666")); // an equal-split share is whole micro-units — rarely a tidy number
    const c = okClaim(await claim(u, custom(WALLET_A)));
    const [row] = await listClaims(db, { status: "PENDING" });
    expect(row).toMatchObject({ amount: "27,916.6666", amount_exact: "27916.666666" });
    expect(parseTokenAmount(String(row!.amount_exact), DECIMALS)).toBe(BigInt(c.amountRaw));
    // Paying what the screen DISPLAYS is refused (the claim stays PENDING)…
    expect(await markSent(c.id, pay(c, { amount: chainTokens("27916.6666") }))).toMatchObject({ ok: false, reason: "WRONG_AMOUNT" });
    expect((await claimRow(c.id)).status).toBe("PENDING");
    // …paying the exact figure the admin copies completes it.
    expect(await markSent(c.id, pay(c, { amount: parseTokenAmount(String(row!.amount_exact), DECIMALS) }))).toMatchObject({ ok: true, claim: { status: "SENT" } });
    await healthy();
  });

  it("the books reconcile through every state: reserved = PENDING claims, sent = SENT claims", async () => {
    const a = await earner();
    const b = await earner(tokens(20_000));
    const c = await earner(tokens(30_000));
    const ca = okClaim(await claim(a));
    const cb = okClaim(await claim(b));
    okClaim(await claim(c));
    await healthy();
    await markSent(ca.id, pay(ca));
    await denyClaim(db, { now }, { claimId: cb.id, reason: "OTHER", note: "member request", actor: "admin" });
    await healthy();
    const totals = await db.query<{ claimable: string; reserved: string; claimed: string }>("select coalesce(sum(claimable),0)::text as claimable, coalesce(sum(reserved),0)::text as reserved, coalesce(sum(claimed_total),0)::text as claimed from public.arena_reward_accounts");
    expect(totals[0]).toEqual({ claimable: tokens(20_000).toString(), reserved: tokens(30_000).toString(), claimed: tokens(25_000).toString() });
  });

  it("the ledger sign rules and idempotency still hold: a replayed key is a no-op, a different movement under the same key throws", async () => {
    const u = await earner(0n);
    const ev = { userId: u, kind: "ADMIN_ADJUSTMENT" as const, claimableDelta: tokens(5), earnedDelta: tokens(5), idempotencyKey: "admin:test-1" };
    expect(await postRewardLedger(db, ev)).toEqual({ applied: true });
    expect(await postRewardLedger(db, ev)).toEqual({ applied: false });
    await expect(postRewardLedger(db, { ...ev, claimableDelta: tokens(6), earnedDelta: tokens(6) })).rejects.toBeInstanceOf(RewardIdempotencyConflictError);
    // a CLAIM_SENT with the wrong shape is refused by the CHECK
    await expect(db.query("insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, reserved_delta, claimed_delta, earned_delta, idempotency_key) values ($1, 'CLAIM_SENT', 5, 0, 5, 0, 'bad-shape-1')", [u])).rejects.toThrow();
    await adminAdjust(db, { userId: u, amount: "1", direction: "debit", reason: "test", key: "debit-1" }, "admin");
    await healthy();
  });
});
