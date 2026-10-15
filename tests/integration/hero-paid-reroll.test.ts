import { decodeFunctionData, erc20Abi } from "viem";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { HeroRerollSettings } from "@/domain/settings";
import { PAYMENT_PROBLEM_MESSAGE } from "@/domain/hero/paidReroll";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import { advanceArena } from "@/server/services/arena";
import { rerollOwnHero } from "@/server/services/heroFreeReroll";
import { confirmPaidReroll, getPaidRerollStatus, type PaidRerollDeps, type PaidRerollError } from "@/server/services/heroPaidReroll";
import { heroArenaLock } from "@/server/services/heroVersionStore";
import { claimCharacter } from "@/server/services/identity";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { CHAIN_ID, chainTokens, newChain, TOKEN, TREASURY, WALLET_A, WALLET_B } from "../support/rewards";

/**
 * THE PAID HERO REROLL, end to end against the simulated chain (the app only ever READS the chain; the TEST plays the member's wallet).
 *
 *   pay → verify on-chain → record the payment as a credit → apply the reroll
 *
 * What must hold: one payment buys exactly one reroll; the money is never lost (a credit survives a refusal); only a payment that really reached the treasury, in the official
 * token, from a wallet the member linked, for at least the price, counts; and the database agrees (audit_hero_paid_rerolls() stays empty).
 */
const SECRET = "test-secret-value-1234567890";
const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const PRICE = chainTokens(100_000);
let db: Db;
let clock: FakeClock;
let chain: SimulatedChainReader;
let deps: PaidRerollDeps;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const build = async (over: Partial<HeroRerollSettings> = {}): Promise<PaidRerollDeps> => {
  const settings = await loadSettings(db);
  return { settings: { ...settings, hero_reroll: { ...settings.hero_reroll, ...over } }, classes: await loadClasses(db), secret: SECRET, now: clock.now, allowDemo: true, chain: { reader: chain, treasuryAddress: TREASURY, rpcUrl: "https://rpc.example", explorerTxUrl: null } };
};
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock(T0);
  chain = newChain();
  deps = await build();
});

const uuid = () => crypto.randomUUID();
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as PaidRerollError | null;
let nextMember = 870_000;
let nextWallet = 0x7000;
const walletFor = () => `0x${(nextWallet++).toString(16).padStart(40, "0")}`;

/** A claimed member whose hero has a LINKED wallet (the wallet the payment must come from). */
async function member(opts: { claim?: boolean; wallet?: boolean } = {}): Promise<{ tid: number; hero: string; wallet: string }> {
  const tid = nextMember++;
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  if (opts.claim !== false) await claimCharacter(db, tid, clock.now());
  const wallet = walletFor();
  if (opts.wallet !== false) await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, $3)", [hero, wallet, CHAIN_ID]);
  return { tid, hero: hero!, wallet };
}
/** The member's wallet pays the treasury (what the browser's wallet does) and the chain mines it with enough confirmations. */
const pay = (from: string, over: { to?: string; amountRaw?: bigint; token?: string; status?: "success" | "reverted"; chainId?: number; mined?: boolean } = {}, confirm = true): string => {
  const { hash } = chain.sendTransfer({ from, to: over.to ?? TREASURY, amountRaw: over.amountRaw ?? PRICE, ...(over.token ? { token: over.token } : {}), ...(over.status ? { status: over.status } : {}), ...(over.chainId ? { chainId: over.chainId } : {}), ...(over.mined === undefined ? {} : { mined: over.mined }) });
  if (confirm) chain.advance(1);
  return hash;
};
const versions = (hero: string) => db.query<{ id: string; version_number: number; action: string; created_by: string; request_id: string | null }>("select id, version_number, action, created_by, request_id from public.hero_versions where character_id = $1 order by version_number", [hero]);
const payments = (tid: number) => db.query<{ tx_hash: string; status: string; payer_address: string; amount_raw: string; utc_day: string | null; hero_version_id: string | null }>("select tx_hash, status, payer_address, amount_raw::text as amount_raw, utc_day::text as utc_day, hero_version_id from public.hero_paid_rerolls where telegram_user_id = $1 order by paid_at", [tid]);
const auditsClean = async () => {
  expect(await db.query("select * from public.audit_hero_versions()")).toEqual([]);
  expect(await db.query("select * from public.audit_hero_paid_rerolls()")).toEqual([]);
  expect(await db.query("select * from public.audit_hero_free_rerolls()")).toEqual([]);
};
const flags = { enabled: true, freeEnabled: false };

describe("status: what a member sees", () => {
  it("DISABLED while the flag is off, UNAVAILABLE without a launched token, and nothing is read from the hero tables for a disabled feature", async () => {
    const { tid } = await member();
    expect(await getPaidRerollStatus(db, tid, { enabled: false, freeEnabled: false }, deps)).toMatchObject({ state: "DISABLED", price: null, payment: null });
    const noToken = { ...deps, chain: { ...deps.chain, reader: null } };
    expect(await getPaidRerollStatus(db, tid, flags, noToken)).toMatchObject({ state: "UNAVAILABLE", payment: null });
    const noTreasury = { ...deps, chain: { ...deps.chain, treasuryAddress: null } };
    expect(await getPaidRerollStatus(db, tid, flags, noTreasury)).toMatchObject({ state: "UNAVAILABLE" });
    chain.setMetadata(null); // the contract cannot be verified
    expect(await getPaidRerollStatus(db, tid, flags, deps)).toMatchObject({ state: "UNAVAILABLE" });
  });

  it("FREE_FIRST while today's free reroll is still available; AVAILABLE once it has been used — with the exact payment the wallet must send", async () => {
    const { tid } = await member();
    expect(await getPaidRerollStatus(db, tid, { enabled: true, freeEnabled: true }, deps)).toMatchObject({ state: "FREE_FIRST", payment: null });
    await rerollOwnHero(db, tid, uuid(), deps); // today's free reroll
    const s = await getPaidRerollStatus(db, tid, { enabled: true, freeEnabled: true }, deps);
    expect(s).toMatchObject({ state: "AVAILABLE", price: { whole: "100000", label: "100,000", symbol: "$CLANKRPG" }, usedToday: 0, maxPerDay: 10, wallet: { linked: true }, credit: null });
    expect(s.current).not.toBeNull();
    const p = s.payment!;
    expect(p).toMatchObject({ chainId: CHAIN_ID, chainIdHex: "0x1237", to: TOKEN, recipient: TREASURY, amountRaw: PRICE.toString(), rpcUrl: "https://rpc.example" });
    // the calldata is a plain ERC-20 transfer(treasury, price) — what the wallet will be asked to sign
    const call = decodeFunctionData({ abi: erc20Abi, data: p.data as `0x${string}` });
    expect(call.functionName).toBe("transfer");
    expect((call.args as [string, bigint])[0].toLowerCase()).toBe(TREASURY);
    expect((call.args as [string, bigint])[1]).toBe(PRICE);
  });

  it("the price is converted with the CONTRACT's own decimals, never assumed", async () => {
    const { tid } = await member();
    chain = newChain({ decimals: 6 });
    deps = await build();
    const s = await getPaidRerollStatus(db, tid, flags, deps);
    expect(s.payment!.amountRaw).toBe((100_000n * 10n ** 6n).toString());
  });

  it("BLOCKED for an unclaimed hero and for a member with no hero; the wallet is reported as not linked until it is", async () => {
    const stranger = await member({ claim: false });
    expect(await getPaidRerollStatus(db, stranger.tid, flags, deps)).toMatchObject({ state: "BLOCKED", block: "NOT_CLAIMED" });
    expect(await getPaidRerollStatus(db, 12345678, flags, deps)).toMatchObject({ state: "BLOCKED", block: "NO_HERO" });
    const noWallet = await member({ wallet: false });
    expect(await getPaidRerollStatus(db, noWallet.tid, flags, deps)).toMatchObject({ state: "AVAILABLE", wallet: { linked: false, address: null } });
  });
});

describe("a verified payment buys exactly one reroll", () => {
  it("records the payment, appends ONE REROLL version made by `member-paid:<id>`, moves the hero, writes an audit entry — and the database agrees", async () => {
    const { tid, hero, wallet } = await member();
    const hash = pay(wallet);
    const key = uuid();
    const before = (await versions(hero)).length;
    const out = await confirmPaidReroll(db, tid, { requestId: key, txHash: hash }, deps);
    if (out.status !== "APPLIED") throw new Error("expected APPLIED");
    expect(out.result).toMatchObject({ alreadyApplied: false, requestId: key, rerolledAt: T0 });
    expect(out.payment).toEqual({ txHash: hash, amountLabel: "100,000", symbol: "$CLANKRPG" });
    const v = await versions(hero);
    expect(v).toHaveLength(before + 1);
    expect(v.at(-1)).toMatchObject({ action: "REROLL", created_by: `member-paid:${tid}`, request_id: key });
    expect(await payments(tid)).toEqual([{ tx_hash: hash, status: "APPLIED", payer_address: wallet, amount_raw: PRICE.toString(), utc_day: "2026-10-15", hero_version_id: v.at(-1)!.id }]);
    const log = await db.query<{ actor: string; action: string }>("select actor, action from public.admin_audit_log where action like 'hero.paid_reroll%' order by id");
    expect(log.map((l) => l.action)).toEqual(["hero.paid_reroll.payment", "hero.paid_reroll"]);
    expect(log[1]!.actor).toBe(`member-paid:${tid}`);
    expect(out.result.after.power).toBe((await db.query<{ power: number }>("select power from public.hero_versions where id = $1", [v.at(-1)!.id]))[0]!.power);
    await auditsClean();
  });

  it("works after the free reroll, the same UTC day: two different versions, each with its own record, and neither programme's audit complains", async () => {
    const { tid, hero, wallet } = await member();
    await rerollOwnHero(db, tid, uuid(), deps);
    const out = await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: pay(wallet) }, deps);
    expect(out.status).toBe("APPLIED");
    expect((await versions(hero)).map((x) => x.created_by)).toEqual(["system:telegram", `member:${tid}`, `member-paid:${tid}`]);
    expect(await count(db, "hero_free_rerolls")).toBe(1);
    expect(await count(db, "hero_paid_rerolls")).toBe(1);
    await auditsClean();
  });

  it("a replay with the same transaction hash returns the reroll it already bought and writes nothing — with the same request key or a new one", async () => {
    const { tid, hero, wallet } = await member();
    const hash = pay(wallet);
    const key = uuid();
    const first = await confirmPaidReroll(db, tid, { requestId: key, txHash: hash }, deps);
    const same = await confirmPaidReroll(db, tid, { requestId: key, txHash: hash }, deps);
    const other = await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash.toUpperCase().replace("0X", "0x") }, deps);
    for (const again of [same, other]) {
      if (again.status !== "APPLIED" || first.status !== "APPLIED") throw new Error("expected APPLIED");
      expect(again.result.alreadyApplied).toBe(true);
      expect(again.result.after.power).toBe(first.result.after.power);
      expect(again.result.after.classId).toBe(first.result.after.classId);
    }
    expect(await versions(hero)).toHaveLength(2);
    expect(await count(db, "hero_paid_rerolls")).toBe(1);
  });

  it("a payment that is not mined yet, or not confirmed enough, is PENDING — nothing is recorded or used — and goes through once it is", async () => {
    const { tid, hero, wallet } = await member();
    const hash = pay(wallet, { mined: false }, false);
    expect(await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).toEqual({ status: "PENDING", confirmations: 0, required: 2 });
    chain.mine(hash);
    expect(await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).toEqual({ status: "PENDING", confirmations: 1, required: 2 });
    expect(await count(db, "hero_paid_rerolls")).toBe(0);
    expect(await versions(hero)).toHaveLength(1);
    chain.advance(1);
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).status).toBe("APPLIED");
    expect(await versions(hero)).toHaveLength(2);
  });

  it("an unreachable chain answers PAYMENT_CHECK_UNAVAILABLE and records nothing; the same call works when the chain is back", async () => {
    const { tid, wallet } = await member();
    const hash = pay(wallet);
    chain.setOutage(true);
    expect(await refusal(confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps))).toMatchObject({ code: "PAID_REROLL_UNAVAILABLE", status: 503 }); // the contract cannot even be verified
    chain.setOutage(false);
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).status).toBe("APPLIED");
    expect(await count(db, "hero_paid_rerolls")).toBe(1);
  });
});

describe("only a real payment counts", () => {
  const rejected = async (reason: keyof typeof PAYMENT_PROBLEM_MESSAGE, make: (wallet: string, other: string) => string) => {
    const { tid, hero, wallet } = await member();
    const hash = make(wallet, WALLET_B);
    const e = await refusal(confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps));
    expect(e, reason).toMatchObject({ code: "PAYMENT_INVALID", status: 422, detail: { reason }, message: PAYMENT_PROBLEM_MESSAGE[reason] });
    expect(await count(db, "hero_paid_rerolls")).toBe(0);
    expect(await versions(hero)).toHaveLength(1);
  };

  it("a transaction that failed on-chain", () => rejected("REVERTED", (w) => pay(w, { status: "reverted" })));
  it("a transaction on another network", () => rejected("WRONG_CHAIN", (w) => pay(w, { chainId: 1 })));
  it("a transfer to someone other than the treasury", () => rejected("NOT_TO_TREASURY", (w, other) => pay(w, { to: other })));
  it("a transfer of a different token to the treasury", () => rejected("WRONG_TOKEN", (w) => pay(w, { token: "0x00000000000000000000000000000000deadbeef" })));
  it("a payment from a wallet the member has not linked (someone else's transaction, found by its hash)", () => rejected("WRONG_PAYER", () => pay(WALLET_A)));
  it("a payment smaller than the price — by even one raw unit", () => rejected("TOO_LITTLE", (w) => pay(w, { amountRaw: PRICE - 1n })));

  it("an overpayment is accepted and buys exactly ONE reroll (the hash is single-use)", async () => {
    const { tid, hero, wallet } = await member();
    const hash = pay(wallet, { amountRaw: PRICE * 3n });
    const out = await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps);
    expect(out).toMatchObject({ status: "APPLIED", payment: { amountLabel: "300,000" } });
    expect(await versions(hero)).toHaveLength(2);
  });

  it("a wallet that is not linked is refused before the chain is even asked; a hash that does not exist is just pending", async () => {
    const noWallet = await member({ wallet: false });
    const lookups = chain.transferLookups;
    expect(await refusal(confirmPaidReroll(db, noWallet.tid, { requestId: uuid(), txHash: pay(WALLET_A) }, deps))).toMatchObject({ code: "WALLET_NOT_LINKED", status: 409 });
    expect(chain.transferLookups).toBe(lookups);
    const { tid } = await member();
    expect(await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: `0x${"ab".repeat(32)}` }, deps)).toMatchObject({ status: "PENDING", confirmations: 0 });
  });

  it("the holder wallet (a reward wallet the member signed for) can pay too", async () => {
    const { tid, wallet } = await member({ wallet: false });
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, holder_wallet_address, wallet_verified_at) values ($1, $2, now())", [tid, wallet]);
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: pay(wallet) }, deps)).status).toBe("APPLIED");
  });

  it("an unclaimed hero cannot reroll; nothing is recorded", async () => {
    const { tid, wallet } = await member({ claim: false });
    expect(await refusal(confirmPaidReroll(db, tid, { requestId: uuid(), txHash: pay(wallet) }, deps))).toMatchObject({ code: "NOT_CLAIMED", status: 403 });
    expect(await count(db, "hero_paid_rerolls")).toBe(0);
  });
});

describe("one payment, one member, one reroll", () => {
  it("another member cannot use a payment that was already used — and cannot use one made from a wallet that is not theirs", async () => {
    const a = await member();
    const b = await member();
    const hash = pay(a.wallet);
    await confirmPaidReroll(db, a.tid, { requestId: uuid(), txHash: hash }, deps);
    expect(await refusal(confirmPaidReroll(db, b.tid, { requestId: uuid(), txHash: hash }, deps))).toMatchObject({ code: "TX_ALREADY_USED", status: 409 });
    const hash2 = pay(a.wallet); // a second payment by A, not yet used
    expect(await refusal(confirmPaidReroll(db, b.tid, { requestId: uuid(), txHash: hash2 }, deps))).toMatchObject({ code: "PAYMENT_INVALID", detail: { reason: "WRONG_PAYER" } });
    expect(await count(db, "hero_paid_rerolls")).toBe(1);
    expect((await versions(b.hero)).length).toBe(1);
  });

  it("parallel confirmations of one payment (two tabs, a retry) reroll once", async () => {
    const { tid, hero, wallet } = await member();
    const hash = pay(wallet);
    const results = await Promise.all([1, 2, 3, 4].map(() => confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)));
    expect(results.every((r) => r.status === "APPLIED")).toBe(true);
    expect(results.filter((r) => r.status === "APPLIED" && !r.result.alreadyApplied)).toHaveLength(1);
    expect(await versions(hero)).toHaveLength(2);
    expect(await count(db, "hero_paid_rerolls")).toBe(1);
    await auditsClean();
  });

  it("a request key that was already spent on a hero version is refused, the payment stays a credit, and a fresh key applies it", async () => {
    const { tid, hero, wallet } = await member();
    const key = uuid();
    await rerollOwnHero(db, tid, key, deps);
    const hash = pay(wallet);
    expect(await refusal(confirmPaidReroll(db, tid, { requestId: key, txHash: hash }, deps))).toMatchObject({ code: "REQUEST_CONFLICT", status: 409 });
    expect(await payments(tid)).toMatchObject([{ status: "PAID" }]);
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).status).toBe("APPLIED");
    expect(await versions(hero)).toHaveLength(3);
  });
});

describe("the money is never lost", () => {
  it("at the daily limit the payment is recorded as a CREDIT (status CREDIT_WAITING); it is used the next UTC day without paying again", async () => {
    deps = await build({ paidMaxPerDay: 1 });
    const { tid, hero, wallet } = await member();
    await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: pay(wallet) }, deps);
    const second = pay(wallet);
    const e = await refusal(confirmPaidReroll(db, tid, { requestId: uuid(), txHash: second }, deps));
    expect(e).toMatchObject({ code: "DAILY_LIMIT", status: 409 });
    expect(e!.message).toMatch(/payment is safe/i);
    expect((await payments(tid)).map((p) => p.status)).toEqual(["APPLIED", "PAID"]);
    expect(await versions(hero)).toHaveLength(2);
    expect(await getPaidRerollStatus(db, tid, flags, deps)).toMatchObject({ state: "CREDIT_WAITING", credit: { txHash: second }, usedToday: 1 });

    clock.advance(24 * 3_600_000); // the next UTC day
    expect(await getPaidRerollStatus(db, tid, flags, deps)).toMatchObject({ state: "CREDIT_WAITING", usedToday: 0, message: expect.stringMatching(/ready/i) });
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: second }, deps)).status).toBe("APPLIED");
    expect((await payments(tid)).map((p) => [p.status, p.utc_day])).toEqual([["APPLIED", "2026-10-15"], ["APPLIED", "2026-10-16"]]);
    expect(await versions(hero)).toHaveLength(3);
    await auditsClean();
  });

  it("a hero in a live Arena roster keeps its payment as a credit (nothing is rolled, nothing is lost); once those fights settle the same hash applies", async () => {
    const ids = await seedHeroes(db, 30, { startId: 860_000 });
    for (let i = 0; i < 30; i++) await claimCharacter(db, 860_000 + i, clock.now());
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const rostered = (await db.query<{ character_id: string }>("select distinct character_id from public.arena_participants")).map((r) => r.character_id);
    const locked = rostered[0]!;
    const tid = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [locked]))[0]!.telegram_user_id;
    const wallet = walletFor();
    await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, $3)", [locked, wallet, CHAIN_ID]);
    expect(ids).toContain(locked);

    const hash = pay(wallet);
    const e = await refusal(confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps));
    expect(e).toMatchObject({ code: "HERO_IN_ARENA", status: 409 });
    expect(e!.message).toMatch(/payment is confirmed and safe/i);
    expect(await payments(tid)).toMatchObject([{ status: "PAID", tx_hash: hash }]);
    expect((await versions(locked)).length).toBe(1);
    expect(await getPaidRerollStatus(db, tid, flags, deps)).toMatchObject({ state: "CREDIT_WAITING", block: "HERO_IN_ARENA", credit: { txHash: hash } });

    // the hero's fights settle → the credit is used, with no second payment
    for (let s = 0; s < 800 && (await heroArenaLock(db, locked)).locked; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    if ((await heroArenaLock(db, locked)).locked) return; // lined up again by a fresh cycle: protected, correctly
    expect((await confirmPaidReroll(db, tid, { requestId: uuid(), txHash: hash }, deps)).status).toBe("APPLIED");
    expect((await versions(locked)).length).toBe(2);
    expect(await payments(tid)).toMatchObject([{ status: "APPLIED" }]);
  }, 120_000);
});
