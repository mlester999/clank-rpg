import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { approveWalletException } from "@/server/rewards/admin";
import { createSimulatedChainReader, TokenMetadataError, type SimulatedChainReader } from "@/server/rewards/chain";
import { createHolderChallenge, getHolderCard, loadObservations, refreshDueHolders, refreshHolder, verifyForClose, verifyHolderWallet } from "@/server/rewards/holders";
import { requestClaim } from "@/server/rewards/claims";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { bindWallet, CHAIN_ID, credit, DECIMALS, newChain, observeSteady, targetFor, TOKEN, tokens, TREASURY, chainTokens } from "../support/rewards";

const H = 3_600_000;
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
] as const;
const acct = (i: number) => privateKeyToAccount(KEYS[i] as `0x${string}`);

let db: Db;
let reader: SimulatedChainReader;
let clock = Date.parse("2026-10-05T10:00:00Z");
const now = () => new Date(clock);
const FRESH = () => clock - 60_000;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  reader = createSimulatedChainReader({ tokenAddress: TOKEN, chainId: CHAIN_ID });
  clock = Date.parse("2026-10-05T10:00:00Z");
});

const challenge = (userId: number, address: string) => createHolderChallenge(db, { now }, { userId, address, chainId: CHAIN_ID, forbidden: [TOKEN, TREASURY] });
/** The full flow: server challenge → the wallet signs it → server verifies and reads the balance. */
async function connect(userId: number, keyIndex: number, over: { sessionIssuedAtMs?: number; signWith?: number } = {}) {
  const c = await challenge(userId, acct(keyIndex).address);
  if (!c.ok) return { challenge: c, result: null };
  const signature = await acct(over.signWith ?? keyIndex).signMessage({ message: c.message });
  const result = await verifyHolderWallet(db, { now, allowDemo: true }, { userId, nonce: c.nonce, signature, sessionIssuedAtMs: over.sessionIssuedAtMs ?? FRESH(), settings: DEFAULT_SETTINGS, forbidden: [TOKEN, TREASURY], reader });
  return { challenge: c, result };
}
const refresh = (userId: number, manual = false) => refreshHolder(db, { now }, { userId, reader, settings: DEFAULT_SETTINGS, manual });
/** Hourly background refreshes for `hours` hours (the continuous observation the 24 h rule relies on). */
async function hourly(userId: number, hours: number) {
  for (let i = 0; i < hours; i++) {
    clock += H;
    await refresh(userId);
  }
}
const holderRow = async (userId: number) => (await db.query<Record<string, unknown>>("select * from public.arena_holder_status where telegram_user_id = $1", [userId]))[0];
const observed = (userId: number) => loadObservations(db, userId);
const card = (userId: number) => getHolderCard(db, userId, DEFAULT_SETTINGS, { launched: true, decimals: DECIMALS }, clock, true);
const account = async (userId: number) => (await db.query<Record<string, unknown>>("select holder_wallet_address, wallet_verified_at from public.arena_reward_accounts where telegram_user_id = $1", [userId]))[0];

describe("wallet ownership: the server challenge and the signature", () => {
  it("a valid signature links the wallet as VERIFIED; the server reads the balance itself and LOGS the observation; a fresh 10M holder earns NO bonus yet (continuity starts now)", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    const { result } = await connect(u, 0);
    expect(result).toMatchObject({ ok: true, wallet: acct(0).address.toLowerCase(), changed: true, status: "OK" });
    expect(await account(u)).toMatchObject({ holder_wallet_address: acct(0).address.toLowerCase() });
    expect((await account(u))!.wallet_verified_at).not.toBeNull();
    expect(await holderRow(u)).toMatchObject({ verified_balance_raw: chainTokens(10_000_000).toString() });
    expect(await observed(u)).toEqual([{ atMs: clock, balanceRaw: chainTokens(10_000_000) }]);
    expect((await db.query<{ source: string }>("select source from public.arena_holder_observations where telegram_user_id = $1", [u]))[0]!.source).toBe("CONNECT");
    const c = await card(u);
    expect(c).toMatchObject({ walletConnected: true, tier: { name: "10M HOLDER", bonus: "+25%" }, balance: "10,000,000" });
    // Holding 10M NOW pays nothing now: the day / week in progress began before this wallet was ever verified.
    expect(c.daily).toMatchObject({ status: "QUALIFYING", tier: "10M", payingBonus: null });
    expect(c.weekly).toMatchObject({ status: "QUALIFYING", tier: "10M", payingBonus: null });
  });

  it("the message the member signs is built BY THE SERVER (address, chain, nonce, expiry) and the nonce is single-use", async () => {
    const u = await seedEligibleMember(db);
    const c = await challenge(u, acct(0).address);
    expect(c.ok && c.message).toContain(`Wallet: ${acct(0).address.toLowerCase()}`);
    expect(c.ok && c.message).toContain(`Chain ID: ${CHAIN_ID}`);
    expect(c.ok && c.nonce.length).toBeGreaterThanOrEqual(32);
    if (!c.ok) return;
    const sig = await acct(0).signMessage({ message: c.message });
    const input = { userId: u, nonce: c.nonce, signature: sig, sessionIssuedAtMs: FRESH(), settings: DEFAULT_SETTINGS, forbidden: [] as string[], reader };
    expect(await verifyHolderWallet(db, { now, allowDemo: true }, input)).toMatchObject({ ok: true });
    expect(await verifyHolderWallet(db, { now, allowDemo: true }, input)).toEqual({ ok: false, reason: "INVALID_CHALLENGE" }); // replay
  });

  it("an INVALID signature (signed by a different wallet, or garbage) links nothing", async () => {
    const u = await seedEligibleMember(db);
    const wrong = await connect(u, 0, { signWith: 1 }); // key 1 signs a challenge for key 0's address
    expect(wrong.result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    const c = await challenge(u, acct(0).address);
    if (c.ok) expect(await verifyHolderWallet(db, { now, allowDemo: true }, { userId: u, nonce: c.nonce, signature: `0x${"ab".repeat(65)}`, sessionIssuedAtMs: FRESH(), settings: DEFAULT_SETTINGS, forbidden: [], reader })).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(await account(u)).toBeUndefined();
    expect(await db.query("select 1 from public.arena_holder_status")).toHaveLength(0);
  });

  it("another member's challenge is useless: a member cannot verify (or hijack) a nonce issued to someone else", async () => {
    const a = await seedEligibleMember(db);
    const b = await seedEligibleMember(db);
    const c = await challenge(a, acct(0).address);
    if (!c.ok) throw new Error("no challenge");
    const sig = await acct(0).signMessage({ message: c.message });
    expect(await verifyHolderWallet(db, { now, allowDemo: true }, { userId: b, nonce: c.nonce, signature: sig, sessionIssuedAtMs: FRESH(), settings: DEFAULT_SETTINGS, forbidden: [], reader })).toEqual({ ok: false, reason: "INVALID_CHALLENGE" });
    expect(await account(b)).toBeUndefined();
  });

  it("an expired challenge is refused", async () => {
    const u = await seedEligibleMember(db);
    const c = await challenge(u, acct(0).address);
    if (!c.ok) throw new Error("no challenge");
    const sig = await acct(0).signMessage({ message: c.message });
    clock += 11 * 60_000;
    expect(await verifyHolderWallet(db, { now, allowDemo: true }, { userId: u, nonce: c.nonce, signature: sig, sessionIssuedAtMs: clock, settings: DEFAULT_SETTINGS, forbidden: [], reader })).toEqual({ ok: false, reason: "INVALID_CHALLENGE" });
  });

  it("ONE wallet ↔ ONE account: a wallet another account already uses cannot earn holder benefits for a second Telegram identity", async () => {
    const a = await seedEligibleMember(db);
    const b = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    expect((await connect(a, 0)).result).toMatchObject({ ok: true });
    const dup = await connect(b, 0); // the SAME key signs for a different Telegram account
    expect(dup.result).toEqual({ ok: false, reason: "WALLET_IN_USE" });
    expect(await holderRow(b)).toBeUndefined();
    expect(await db.query("select 1 from public.arena_reward_wallet_attempts where telegram_user_id = $1", [b])).toHaveLength(1); // logged for admin review
    // An admin-approved exception is the only way (audited).
    await approveWalletException(db, b, "household with a shared wallet (verified)", "admin");
    expect((await connect(b, 0)).result).toMatchObject({ ok: true });
  });

  it("refuses the token contract, the treasury, burn addresses and malformed input; non-eligible members get nothing", async () => {
    const u = await seedEligibleMember(db);
    for (const bad of [TOKEN, TREASURY, "0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dEaD", "0x123", "nope"]) {
      expect(await challenge(u, bad), bad).toEqual({ ok: false, reason: "INVALID_WALLET" });
    }
    const stranger = await seedEligibleMember(db, { hero: false });
    expect(await challenge(stranger, acct(0).address)).toEqual({ ok: false, reason: "NOT_ELIGIBLE" });
  });

  it("a CLAIM destination (typed for one payout) never creates a holder wallet or any holder evidence, however much that address holds", async () => {
    const u = await seedEligibleMember(db);
    await credit(db, u, tokens(20_000));
    const chain = newChain();
    const r = await requestClaim(db, { now, allowDemo: true }, { userId: u, idempotencyKey: "custom-destination-claim", destination: { kind: "CUSTOM", address: acct(2).address }, settings: DEFAULT_SETTINGS, target: targetFor(chain) });
    expect(r.ok).toBe(true);
    reader.setBalance(acct(2).address, chainTokens(10_000_000));
    expect(await refresh(u)).toEqual({ status: "NO_VERIFIED_WALLET" });
    expect(await observed(u)).toEqual([]); // no holder wallet → no evidence
    expect((await card(u)).tier.name).toBe("FREE");
    expect(await account(u)).toMatchObject({ holder_wallet_address: null, wallet_verified_at: null });
    // …and PROVING that same address later makes it the HOLDER wallet (a separate, signed step), without touching the claim.
    expect((await connect(u, 2)).result).toMatchObject({ ok: true, changed: true });
    expect((await account(u))!.wallet_verified_at).not.toBeNull();
    expect((await db.query<{ destination_address: string }>("select destination_address from public.arena_reward_claims where telegram_user_id = $1", [u]))[0]!.destination_address).toBe(acct(2).address.toLowerCase());
  });
});


const hourlyReads = async (userId: number, hours: number) => hourly(userId, hours);

describe("the observation log: the evidence a bonus is decided from", () => {
  it("every SUCCESSFUL authoritative read of the CURRENT holder wallet is appended, tagged with how it was triggered — a failed read leaves a visible GAP, never a fake observation", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(150_000));
    await connect(u, 0); // CONNECT
    clock += 31 * MIN;
    await refresh(u); // BACKGROUND
    clock += 6 * MIN;
    await refresh(u, true); // MANUAL
    clock += 31 * MIN;
    reader.failNext();
    expect(await refresh(u)).toEqual({ status: "UNAVAILABLE" });
    clock += 31 * MIN;
    await verifyForClose(db, { now }, { userId: u, reader, settings: DEFAULT_SETTINGS }); // CLOSE
    const rows = await db.query<{ source: string }>("select source from public.arena_holder_observations where telegram_user_id = $1 order by id", [u]);
    expect(rows.map((r) => r.source)).toEqual(["CONNECT", "BACKGROUND", "MANUAL", "CLOSE"]); // the failed read wrote nothing
  });

  it("the log is append-only: balances are never edited and rows are never deleted", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    await connect(u, 0);
    await expect(db.query("update public.arena_holder_observations set balance_raw = 0")).rejects.toThrow();
    await expect(db.query("delete from public.arena_holder_observations")).rejects.toThrow();
  });

  it("an observation can only be of the member's CURRENT verified wallet: the database refuses any other (a balance read for a replaced wallet is never evidence for the new one)", async () => {
    const u = await seedEligibleMember(db);
    await connect(u, 0);
    await expect(db.query("insert into public.arena_holder_observations (telegram_user_id, wallet_address, balance_raw, source) values ($1, $2, 1, 'BACKGROUND')", [u, acct(1).address.toLowerCase()])).rejects.toThrow(/current verified holder wallet/);
    const nobody = await seedEligibleMember(db);
    await expect(db.query("insert into public.arena_holder_observations (telegram_user_id, wallet_address, balance_raw, source) values ($1, $2, 1, 'BACKGROUND')", [nobody, acct(1).address.toLowerCase()])).rejects.toThrow();
  });

  it("changing the holder wallet starts continuity from ZERO: the old wallet's reads stop counting, the new wallet earns its own, and the switch needs a fresh sign-in", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    reader.setBalance(acct(1).address, chainTokens(10_000_000));
    await connect(u, 0);
    await hourlyReads(u, 30);
    expect((await observed(u)).length).toBe(31);
    expect((await connect(u, 1, { sessionIssuedAtMs: clock - 60 * MIN })).result).toEqual({ ok: false, reason: "FRESH_AUTH_REQUIRED" });
    expect((await observed(u)).length).toBe(31); // nothing changed on a refused switch
    clock += H;
    expect((await connect(u, 1)).result).toMatchObject({ ok: true, changed: true });
    expect(await observed(u)).toEqual([{ atMs: clock, balanceRaw: chainTokens(10_000_000) }]); // only the NEW wallet's first read
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.arena_holder_observations where telegram_user_id = $1", [u]))[0]!.n).toBe(32); // the old rows remain for audit, but are not evidence
    expect((await card(u)).daily).toMatchObject({ status: "QUALIFYING" });
  });

  it("TOKEN HOPPING: account A qualifies, then moves to another wallet; account B links A's old wallet — B inherits NOTHING (evidence belongs to the account that was bound)", async () => {
    const a = await seedEligibleMember(db);
    const b = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    reader.setBalance(acct(1).address, 0n);
    await connect(a, 0);
    await hourlyReads(a, 48);
    clock += H;
    await connect(a, 1); // A moves on; wallet 0 is free again
    expect((await connect(b, 0)).result).toMatchObject({ ok: true });
    expect(await observed(b)).toEqual([{ atMs: clock, balanceRaw: chainTokens(10_000_000) }]); // one fresh read, no history
    expect((await card(b)).daily.status).toBe("QUALIFYING");
    expect((await card(a)).tier.name).toBe("FREE");
  });
});

describe("the member's HOLDER REWARD BONUS card", () => {
  it("FREE with no wallet: 0% bonus, the ladder 100K +5% … 10M +25%, and holdings never affect score or rank", async () => {
    const u = await seedEligibleMember(db);
    const c = await card(u);
    expect(c).toMatchObject({ available: true, walletConnected: false, wallet: { short: null }, tier: { index: 0, name: "FREE", bonusBps: 0 }, balance: null, maxBonus: "+25%", nextTier: { label: "100K", bonus: "+5%" }, daily: { status: "NONE" }, weekly: { status: "NONE" } });
    expect(c.tiers.map((t) => `${t.label}:${t.bonus}`)).toEqual(["FREE:+0%", "100K:+5%", "500K:+10%", "1M:+15%", "5M:+20%", "10M:+25%"]);
    expect((await getHolderCard(db, u, DEFAULT_SETTINGS, { launched: true, decimals: DECIMALS }, clock, false)).available).toBe(false);
  });

  it("a 1M holder verified every 30 min for 5 d 7 h: Daily QUALIFIED (+15%), Weekly QUALIFYING with a progress clock and the week it becomes eligible — and only the SHORT wallet is ever shown", async () => {
    const u = await seedEligibleMember(db);
    const start = clock - (5 * 24 + 7) * H; // 2026-09-30 03:00Z; today is Monday 2026-10-05
    await bindWallet(db, u, { wallet: acct(0).address.toLowerCase(), verifiedAtMs: start });
    await observeSteady(db, u, start, clock - 5 * MIN, chainTokens(1_284_500));
    await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, verified_balance_raw, balance_verified_at, next_check_at) values ($1, $2, $3::numeric, $4::timestamptz, $4::timestamptz)", [u, acct(0).address.toLowerCase(), chainTokens(1_284_500).toString(), new Date(clock - 5 * MIN).toISOString()]);
    const c = await card(u);
    expect(c).toMatchObject({ walletConnected: true, tier: { name: "1M HOLDER", bonus: "+15%" }, balance: "1,284,500", nextTier: { label: "5M", minimum: "5,000,000", bonus: "+20%" } });
    expect(c.daily).toMatchObject({ status: "QUALIFIED", payingBonus: "+15%", payingTier: "1M" });
    expect(c.weekly).toMatchObject({ status: "QUALIFYING", tier: "1M", requiredMs: 7 * 24 * H, eligibleFrom: Date.parse("2026-10-12T00:00:00Z") });
    expect(Math.floor(c.weekly.heldMs / H)).toBe(5 * 24 + 7 - 0); // 5 D 7 H (the last read was 5 minutes ago)
    expect(c.wallet.short).toMatch(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
    expect(JSON.stringify(c)).not.toContain(acct(0).address.toLowerCase());
  });
});


// ---------------------------------------------------------------------------------------------------------------------
// THREE verification paths (plus the CLOSE read): immediate (connect), manual (Refresh holdings), background (bounded due batches)
// ---------------------------------------------------------------------------------------------------------------------
const MIN = 60_000;
const nextCheckMin = async (userId: number) => (new Date(String((await holderRow(userId))!.next_check_at)).getTime() - clock) / MIN;
const failures = async (userId: number) => Number((await holderRow(userId))!.check_failures);


describe("path A — IMMEDIATE verification when a wallet is connected", () => {
  it("connecting verifies the signature, reads the balance and logs the first observation in the SAME request", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(1_000_000));
    const readsBefore = reader.reads;
    const { result } = await connect(u, 0);
    expect(result).toMatchObject({ ok: true, status: "OK" });
    expect(reader.reads).toBe(readsBefore + 1); // exactly one authoritative read, by the server
    const row = (await holderRow(u))!;
    expect(row).toMatchObject({ verified_balance_raw: chainTokens(1_000_000).toString(), check_failures: 0 });
    expect(new Date(String(row.balance_verified_at)).getTime()).toBe(clock);
    expect(await observed(u)).toEqual([{ atMs: clock, balanceRaw: chainTokens(1_000_000) }]);
    expect(row).not.toHaveProperty("active_tier_index"); // the tier is never stored: derived from the balance and the evidence
  });

  it("schedules the NEXT background check ~30 minutes out (± jitter), not a minute out and not hours out", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(500));
    await connect(u, 0);
    const m = await nextCheckMin(u);
    expect(m).toBeGreaterThanOrEqual(24);
    expect(m).toBeLessThanOrEqual(36);
  });

  it("when the chain cannot answer at connect time the wallet is still linked, the failure is counted and a retry is scheduled", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    reader.failNext();
    const { result } = await connect(u, 0);
    expect(result).toMatchObject({ ok: true, status: "UNAVAILABLE" });
    expect((await account(u))!.wallet_verified_at).not.toBeNull();
    expect(await holderRow(u)).toMatchObject({ check_failures: 1, balance_verified_at: null });
    expect(await nextCheckMin(u)).toBeCloseTo(5, 0); // first retry in ~5 minutes
    expect(await observed(u)).toEqual([]); // a failed read is NOT evidence
    expect(await card(u)).toMatchObject({ walletConnected: true, verificationNeeded: true, tier: { name: "FREE" } });
  });
});

describe("path B — MANUAL 'Refresh holdings' (server-side, rate-limited, never trusting the browser)", () => {
  it("re-reads the balance on the server; the first click after connecting works, the next is throttled for 5 minutes", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(600_000));
    await connect(u, 0);
    reader.setBalance(acct(0).address, chainTokens(1_100_000));
    const reads = reader.reads;
    expect(await refresh(u, true)).toMatchObject({ status: "OK", balanceRaw: chainTokens(1_100_000) });
    expect(reader.reads).toBe(reads + 1);
    expect(await refresh(u, true)).toEqual({ status: "THROTTLED" });
    clock += 4 * MIN + 59_000;
    expect(await refresh(u, true)).toEqual({ status: "THROTTLED" });
    expect(reader.reads).toBe(reads + 1); // a throttled click never reaches the chain
    clock += 1_000;
    expect(await refresh(u, true)).toMatchObject({ status: "OK" });
    expect(reader.reads).toBe(reads + 2);
  });

  it("the throttle is per member, and background checks do NOT consume (or get blocked by) the member's manual refreshes", async () => {
    const a = await seedEligibleMember(db);
    const b = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(600_000));
    reader.setBalance(acct(1).address, chainTokens(600_000));
    await connect(a, 0);
    await connect(b, 1);
    expect(await refresh(a, true)).toMatchObject({ status: "OK" });
    expect(await refresh(b, true)).toMatchObject({ status: "OK" }); // A's click did not throttle B
    clock += 40 * MIN;
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toMatchObject({ refreshed: 2 }); // background ran for both
    expect(await refresh(a, true)).toMatchObject({ status: "OK" }); // 40 min since A's last manual click → allowed (background did not block it)
  });

  it("is a no-op without a verified wallet, and a failed read is reported UNAVAILABLE (and counted), never invented", async () => {
    const stranger = await seedEligibleMember(db);
    expect(await refresh(stranger, true)).toEqual({ status: "NO_VERIFIED_WALLET" });
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(600_000));
    await connect(u, 0);
    reader.failNext();
    expect(await refresh(u, true)).toEqual({ status: "UNAVAILABLE" });
    expect(await failures(u)).toBe(1);
  });
});

describe("path C — BACKGROUND verification: bounded batches of wallets whose next check is due", () => {
  it("nobody is due right after verification; ~30 minutes later they are", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(600_000));
    await connect(u, 0);
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toEqual({ due: 0, refreshed: 0, failed: 0 });
    clock += 23 * MIN;
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toMatchObject({ due: 0 }); // the earliest a 30 min ± 20% check can fall due is 24 min
    clock += 14 * MIN; // 37 min > the latest possible next check
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toEqual({ due: 1, refreshed: 1, failed: 0 });
  });

  it("processes at most `holderCheckBatchSize` wallets per tick (default 25), oldest-due first; the rest wait for the next tick", async () => {
    const users: number[] = [];
    for (let i = 0; i < 30; i++) {
      const u = await seedEligibleMember(db);
      users.push(u);
      await db.query("update public.arena_reward_accounts set holder_wallet_address = $2, wallet_verified_at = now() where telegram_user_id = $1", [u]).catch(() => undefined);
      await db.query("insert into public.arena_reward_accounts (telegram_user_id) values ($1) on conflict do nothing", [u]);
      await db.query("update public.arena_reward_accounts set holder_wallet_address = $2, wallet_verified_at = now() where telegram_user_id = $1", [u, `0x${(0x2000000 + u).toString(16).padStart(40, "0")}`]);
      await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, next_check_at) values ($1, $2, $3::timestamptz)", [u, `0x${(0x2000000 + u).toString(16).padStart(40, "0")}`, new Date(clock - (30 - i) * MIN).toISOString()]);
    }
    const first = await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS);
    expect(first).toEqual({ due: 25, refreshed: 25, failed: 0 });
    const second = await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS);
    expect(second).toEqual({ due: 5, refreshed: 5, failed: 0 });
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toEqual({ due: 0, refreshed: 0, failed: 0 });
    // the oldest-due wallets were served first
    const firstBatchUsers = users.slice(0, 25);
    const stillOld = await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.arena_holder_status where last_check_at is null");
    expect(stillOld).toEqual([]);
    expect(firstBatchUsers).toHaveLength(25);
    // the batch size is a setting
    for (const u of users) await db.query("update public.arena_holder_status set next_check_at = $2::timestamptz where telegram_user_id = $1", [u, new Date(clock - MIN).toISOString()]);
    expect(await refreshDueHolders(db, { now }, reader, { ...DEFAULT_SETTINGS, arena_picks: { ...DEFAULT_SETTINGS.arena_picks, holderCheckBatchSize: 7 } })).toMatchObject({ due: 7, refreshed: 7 });
  });

  it("holds the ~30 minute cadence: every wallet is re-verified every 24–36 minutes over a 3-hour run of 1-minute ticks, never in a thundering herd", async () => {
    const users: number[] = [];
    for (let i = 0; i < 12; i++) {
      const u = await seedEligibleMember(db);
      users.push(u);
      reader.setBalance(acct(i % 4).address, chainTokens(600_000));
    }
    // 12 members, each with their own (unique) verified wallet
    for (const [i, u] of users.entries()) {
      const w = `0x${(0x3000000 + i).toString(16).padStart(40, "0")}`;
      await db.query("insert into public.arena_reward_accounts (telegram_user_id) values ($1) on conflict do nothing", [u]);
      await db.query("update public.arena_reward_accounts set holder_wallet_address = $2, wallet_verified_at = now() where telegram_user_id = $1", [u, w]);
      reader.setBalance(w, chainTokens(600_000));
      await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, next_check_at) values ($1, $2, $3::timestamptz)", [u, w, new Date(clock).toISOString()]);
    }
    const perTick: number[] = [];
    const lastAt = new Map<number, number>();
    const gaps: number[] = [];
    for (let minute = 0; minute < 180; minute++) {
      const r = await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS);
      perTick.push(r.due);
      for (const u of users) {
        const at = new Date(String((await holderRow(u))!.last_check_at)).getTime();
        if (lastAt.get(u) !== at) {
          if (lastAt.has(u)) gaps.push((at - (lastAt.get(u) as number)) / MIN);
          lastAt.set(u, at);
        }
      }
      clock += MIN;
    }
    expect(Math.max(...perTick)).toBeLessThanOrEqual(25); // never more than a batch
    expect(gaps.length).toBeGreaterThan(12 * 4); // ~5 re-checks per wallet in 3 h
    for (const g of gaps) { expect(g).toBeGreaterThanOrEqual(24); expect(g).toBeLessThanOrEqual(37); }
    // jitter spreads them: not all 12 fall due in one minute after the first round
    expect(perTick.filter((n) => n > 0).length).toBeGreaterThan(10);
  }, 60_000);

  it("a read failure backs off 5 → 10 → 20 min (never past the normal interval), counts the failures, and one success resets them", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(600_000));
    await connect(u, 0);
    clock += 40 * MIN;
    reader.setOutage(true);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toMatchObject({ due: 1, failed: 1 });
      seen.push(Math.round(await nextCheckMin(u)));
      clock += (await nextCheckMin(u)) * MIN;
    }
    expect(seen).toEqual([5, 10, 20, 30, 30]);
    expect(await failures(u)).toBe(5);
    expect(await holderRow(u)).toMatchObject({ last_error: expect.stringContaining("simulated outage") });
    // the node recovers: the next check succeeds and clears the failure state
    reader.setOutage(false);
    expect(await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS)).toMatchObject({ refreshed: 1, failed: 0 });
    expect(await holderRow(u)).toMatchObject({ check_failures: 0, last_error: null });
    expect(await nextCheckMin(u)).toBeGreaterThanOrEqual(24);
  });

  it("is a quiet no-op with no chain reader configured, and before the migration exists", async () => {
    expect(await refreshDueHolders(db, { now }, null, DEFAULT_SETTINGS)).toEqual({ due: 0, refreshed: 0, failed: 0 });
  });
});

describe("verification FAILURE: stale beyond holderMaxAgeHours (6 h) → NEEDS VERIFICATION; nothing earned is removed, no bonus from stale data", () => {
  it("within 6 h of the last success the card still stands; past it the card says NEEDS VERIFICATION and nothing is assumed; the wallet and earned rewards are untouched; one success restores it", async () => {
    const u = await seedEligibleMember(db);
    const start = clock - 3 * 24 * H;
    await bindWallet(db, u, { wallet: acct(0).address.toLowerCase(), verifiedAtMs: start });
    await observeSteady(db, u, start, clock, chainTokens(10_000_000));
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    await credit(db, u, tokens(50_000));
    const walletBefore = await account(u);
    expect((await card(u)).daily).toMatchObject({ status: "QUALIFIED", payingBonus: "+25%" });

    reader.setOutage(true);
    clock += 5 * H + 59 * MIN;
    await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS);
    expect((await card(u)).daily.status).toBe("QUALIFIED"); // still inside the 6 h window
    clock += 2 * MIN; // > 6 h since the last SUCCESS
    await refreshDueHolders(db, { now }, reader, DEFAULT_SETTINGS);
    const stale = await card(u);
    expect(stale).toMatchObject({ verificationNeeded: true, walletConnected: true });
    expect(stale.daily.status).toBe("NEEDS_VERIFICATION");
    expect(stale.weekly.status).toBe("NEEDS_VERIFICATION");
    expect(await account(u)).toEqual(walletBefore); // nothing removed: same wallet…
    expect((await db.query<{ claimable: string }>("select claimable::text from public.arena_reward_accounts where telegram_user_id = $1", [u]))[0]!.claimable).toBe(tokens(50_000).toString()); // …same rewards

    reader.setOutage(false);
    expect(await refresh(u, true)).toMatchObject({ status: "OK" });
    // The 6 h of silence BROKE continuity (an unverified gap proves nothing): the clock restarts at this read.
    const after = await card(u);
    expect(after.verificationNeeded).toBe(false);
    // The member WAS qualified when today began; the unverified gap broke it during the day — for TODAY it is BROKEN (a future day can re-qualify from this read).
    expect(after.daily).toMatchObject({ status: "BROKEN", heldMs: 0 });
    expect(after.weekly.status).toBe("QUALIFYING"); // never qualified for this week (3 d of the 7 d required)
  });

  it("the freshness window is a setting (holderMaxAgeHours)", async () => {
    const u = await seedEligibleMember(db);
    await bindWallet(db, u, { wallet: acct(0).address.toLowerCase(), verifiedAtMs: clock - 24 * H });
    await observeSteady(db, u, clock - 24 * H, clock, chainTokens(1_000_000));
    await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, verified_balance_raw, balance_verified_at, next_check_at) values ($1, $2, $3::numeric, $4::timestamptz, $4::timestamptz)", [u, acct(0).address.toLowerCase(), chainTokens(1_000_000).toString(), new Date(clock).toISOString()]);
    const strict = { ...DEFAULT_SETTINGS, arena_picks: { ...DEFAULT_SETTINGS.arena_picks, holderMaxAgeHours: 1 } };
    clock += 61 * MIN;
    expect((await getHolderCard(db, u, strict, { launched: true, decimals: DECIMALS }, clock, true)).verificationNeeded).toBe(true);
    expect((await getHolderCard(db, u, DEFAULT_SETTINGS, { launched: true, decimals: DECIMALS }, clock, true)).verificationNeeded).toBe(false);
  });

  it("an outage longer than the freshness window means continuity cannot be proven: the run restarts at the first observation after the gap rather than trusting an unobserved balance", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(1_000_000));
    await connect(u, 0);
    for (let i = 0; i < 20; i++) {
      clock += 30 * MIN;
      await refresh(u);
    }
    clock += 7 * H; // nobody could observe the wallet for 7 hours (> holderMaxAgeHours)
    await refresh(u);
    const obs = await observed(u);
    expect(obs[obs.length - 1]!.atMs).toBe(clock);
    const c = await card(u);
    expect(c.daily.heldMs).toBe(0); // the unbroken run is just this one read
  });

  it("a token contract that cannot be VERIFIED (decimals()/symbol()/bytecode) FAILS CLOSED: nothing is verified, no observation is written, the failure is recorded", async () => {
    const u = await seedEligibleMember(db);
    reader.setBalance(acct(0).address, chainTokens(10_000_000));
    await connect(u, 0);
    const before = (await observed(u)).length;
    reader.setMetadata(null); // the contract is unreadable or wrong — the contract, not the configuration, is authoritative
    await expect(reader.balanceOf(acct(0).address)).rejects.toBeInstanceOf(TokenMetadataError);
    clock += 30 * MIN;
    expect(await refresh(u)).toEqual({ status: "UNAVAILABLE" });
    expect(await holderRow(u)).toMatchObject({ check_failures: 1, last_error: expect.stringMatching(/cannot be verified/) });
    expect((await observed(u)).length).toBe(before);
    // a brand-new connection cannot verify either: the wallet is linked but no balance or evidence appears
    const v = await seedEligibleMember(db);
    reader.setBalance(acct(1).address, chainTokens(5_000_000));
    const { result } = await connect(v, 1);
    expect(result).toMatchObject({ ok: true, status: "UNAVAILABLE" });
    expect((await holderRow(v))!.balance_verified_at).toBeNull();
    expect(await observed(v)).toEqual([]);
  });
});
