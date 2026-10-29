import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { payoutCsv, payoutSummaryText } from "@/domain/rewards/payout";
import { boardPayout, reconcileRewards } from "@/server/rewards/admin";
import { denyClaim, markClaimSent, requestClaim } from "@/server/rewards/claims";
import { reconcileBonus, resolveHeldPrize } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { allResults, bindWallet, finalize, HOUR, ledgerCount, newChain, observeSteady, settingsWith, seedScores, targetFor, tokens, utc, walletFor, WALLET_A, WALLET_B, chainTokens } from "../support/rewards";

/**
 * ADMIN PAYOUT SUMMARY: the exact amount an operator must send for a finalized Daily / Weekly board. The numbers are checked against
 * the LEDGER (what was actually credited) so the summary can never drift from the money records, at every tier mix.
 */
let db: Db;
let chain: SimulatedChainReader;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  chain = newChain();
});

const DAY = "2026-10-07";
const CLOSE = utc(2026, 10, 8, 0, 0, 5);
const WEEK = "2026-10-12";
const WEEK_CLOSE = utc(2026, 10, 19, 0, 0, 5);
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: new Date() })).toEqual([]);
};
const SPEC = { daily: [150_000, 100_000, 75_000, 50_000, 40_000, 30_000, 20_000, 15_000, 10_000, 10_000], weekly: [300_000, 200_000, 150_000, 100_000, 80_000, 60_000, 40_000, 30_000, 20_000, 20_000] };

/** Ten players 9001…9010 on the Daily: 20 picks each, strictly decreasing correct picks (20, 19, …, 11). */
const dailyField = (n = 10) => seedScores(db, Array.from({ length: n }, (_, i) => ({ user: 9001 + i, day: DAY, picks: 20, correct: 20 - i })));
/** Ten players on the Weekly: 100 picks each (20 a day for five days — the Weekly minimum), strictly decreasing correct picks. */
const weeklyField = () =>
  seedScores(db, Array.from({ length: 10 }, (_, i) => i).flatMap((i) => ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((day) => ({ user: 9001 + i, day, picks: 20, correct: 20 - i }))));

/** Tier balances comfortably above each threshold (100K, 500K, 1M, 5M, 10M). */
const BALANCE = { "100K": chainTokens(125_000), "500K": chainTokens(600_000), "1M": chainTokens(1_100_000), "5M": chainTokens(5_250_000), "10M": chainTokens(10_250_000) } as const;
type Tier = keyof typeof BALANCE;
/** A verified holder whose balance has been checked on schedule for the whole qualification window of the Daily (24 h before + all day) or Weekly (7 days before + all week). */
async function holder(userId: number, tier: Tier, kind: "DAILY" | "WEEKLY" = "DAILY"): Promise<void> {
  await seedEligibleMember(db, { id: userId });
  const from = kind === "DAILY" ? utc(2026, 10, 5) : utc(2026, 10, 4);
  const to = kind === "DAILY" ? utc(2026, 10, 7, 22, 0) : utc(2026, 10, 18, 22, 0);
  const wallet = await bindWallet(db, userId, { wallet: walletFor(userId), verifiedAtMs: from });
  await observeSteady(db, userId, from, to, BALANCE[tier], 4 * HOUR);
  chain.setBalance(wallet, BALANCE[tier]);
}
const closeDaily = (over: { settings?: ReturnType<typeof settingsWith>; reader?: SimulatedChainReader | null } = {}) => finalize(db, "DAILY", DAY, CLOSE, { reader: over.reader === undefined ? chain : over.reader, ...(over.settings ? { settings: over.settings } : {}) });
const closeWeekly = () => finalize(db, "WEEKLY", WEEK, WEEK_CLOSE, { reader: chain });
const payoutOf = async (kind: "DAILY" | "WEEKLY", start: string) => {
  const p = await boardPayout(db, kind, start);
  if (!p) throw new Error("board not finalized");
  return p;
};
const sum = (xs: string[]): bigint => xs.reduce((a, x) => a + tokens(x), 0n);
/** What the ledger actually credited for a period (base + holder bonus). */
async function ledgerTotal(kind: "DAILY" | "WEEKLY"): Promise<bigint> {
  const [r] = await db.query<{ n: string }>("select coalesce(sum(claimable_delta), 0)::text as n from public.arena_reward_ledger where kind in ($1, $2)", [`${kind}_LEADERBOARD_BASE_REWARD`, `${kind}_LEADERBOARD_HOLDER_BONUS`]);
  return BigInt(r!.n);
}

describe("DAILY PAYOUT SUMMARY — Base Prize Pool, Holder Bonuses, TOTAL PAYOUT", () => {
  it("all ten winners FREE: base 500,000 + bonuses 0 = TOTAL 500,000, one row per winner with the exact ladder amounts", async () => {
    await dailyField();
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.summary).toMatchObject({ kind: "DAILY", start: DAY, symbol: "$CLANKRPG", basePool: "500,000", baseAwarded: "500,000", returnedToReserve: "0", holderBonuses: "0", totalPayout: "500,000", totalPayoutPlain: "500000", maxBonusPercent: "+25%", prizeWinners: 10, heldForReview: "0", forfeited: "0", bonusesPending: 0 });
    expect(p.rows).toHaveLength(10);
    p.rows.forEach((r, i) => {
      expect(r, `rank ${i + 1}`).toMatchObject({ rank: i + 1, correctPicks: 20 - i, picks: 20, accuracy: Math.round(((20 - i) / 20) * 1000) / 10, points: (20 - i) * 10, holderTier: null, bonusPercent: null, holderBonus: "0", claimStatus: "UNCLAIMED", wallet: null, txHash: null, tied: false });
      expect(r.basePrizePlain).toBe(String(SPEC.daily[i]));
      expect(r.totalRewardPlain).toBe(String(SPEC.daily[i]));
    });
    expect(await ledgerTotal("DAILY")).toBe(tokens(500_000));
    await healthy();
  });

  it("all ten winners hold 10M with verified continuity: base 500,000 + 25% bonuses 125,000 = TOTAL 625,000 — the maximum liability — equal to what the ledger credited", async () => {
    await dailyField();
    for (let i = 0; i < 10; i++) await holder(9001 + i, "10M");
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.summary).toMatchObject({ baseAwarded: "500,000", holderBonuses: "125,000", totalPayout: "625,000", totalPayoutPlain: "625000", bonusesPending: 0 });
    p.rows.forEach((r, i) => expect(r).toMatchObject({ holderTier: "10M", bonusPercent: "+25%", basePrizePlain: String(SPEC.daily[i]), holderBonusPlain: String(SPEC.daily[i]! / 4), totalRewardPlain: String((SPEC.daily[i]! * 5) / 4) }));
    expect(await ledgerTotal("DAILY")).toBe(tokens(625_000));
    expect(tokens(p.summary.totalPayoutPlain)).toBe(await ledgerTotal("DAILY"));
    await healthy();
  });

  it("MIXED tiers (10M / 1M / 500K / 100K / FREE…): each bonus is exactly its tier percentage of its own base prize; the rows add up to the TOTAL to the last unit — no drift", async () => {
    await dailyField();
    await holder(9001, "10M"); // 150,000 × 25 % = 37,500
    await holder(9002, "1M"); //  100,000 × 15 % = 15,000
    await holder(9003, "500K"); // 75,000 × 10 % = 7,500
    await holder(9004, "100K"); // 50,000 ×  5 % = 2,500
    await holder(9005, "5M"); //    40,000 × 20 % = 8,000
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.rows.slice(0, 5).map((r) => [r.holderTier, r.bonusPercent, r.holderBonusPlain, r.totalRewardPlain])).toEqual([
      ["10M", "+25%", "37500", "187500"], ["1M", "+15%", "15000", "115000"], ["500K", "+10%", "7500", "82500"], ["100K", "+5%", "2500", "52500"], ["5M", "+20%", "8000", "48000"],
    ]);
    expect(p.rows.slice(5).every((r) => r.holderTier === null && r.holderBonus === "0")).toBe(true);
    expect(p.summary).toMatchObject({ baseAwarded: "500,000", holderBonuses: "70,500", totalPayout: "570,500" });
    // The summary, the rows and the ledger all agree to the last base unit.
    expect(sum(p.rows.map((r) => r.totalRewardPlain))).toBe(tokens(570_500));
    expect(sum(p.rows.map((r) => r.basePrizePlain)) + sum(p.rows.map((r) => r.holderBonusPlain))).toBe(tokens(570_500));
    expect(await ledgerTotal("DAILY")).toBe(tokens(570_500));
    // …and every winner's claimable balance is exactly their row's total.
    for (const r of p.rows) {
      const [acc] = await db.query<{ earned_total: string }>("select earned_total::text from public.arena_reward_accounts where telegram_user_id = $1", [r.telegramUserId]);
      expect(BigInt(acc!.earned_total), `rank ${r.rank}`).toBe(tokens(r.totalRewardPlain));
    }
    await healthy();
  });

  it("the holder bonus changes only the PAYOUT: the same board with and without holders has identical ranks, correct picks, points and base prizes", async () => {
    await dailyField();
    await closeDaily();
    const free = (await payoutOf("DAILY", DAY)).rows.map((r) => [r.rank, r.correctPicks, r.points, r.basePrizePlain]);
    await resetDb(db);
    chain = newChain();
    await dailyField();
    for (let i = 0; i < 10; i++) await holder(9001 + i, i % 2 === 0 ? "10M" : "100K");
    await closeDaily();
    expect((await payoutOf("DAILY", DAY)).rows.map((r) => [r.rank, r.correctPicks, r.points, r.basePrizePlain])).toEqual(free);
  });

  it("fewer than ten winners: the unfilled positions return to the reserve and are NOT part of the total", async () => {
    await dailyField(3);
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.summary).toMatchObject({ basePool: "500,000", baseAwarded: "325,000", returnedToReserve: "175,000", totalPayout: "325,000", prizeWinners: 3 });
  });

  it("a three-way tie splits positions 1+2+3 evenly; the integer remainder returns to the reserve and the TOTAL equals the exact sum of the rows (fractions included)", async () => {
    await seedScores(db, [9401, 9402, 9403].map((user) => ({ user, day: DAY, picks: 20, correct: 17 })));
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    const each = tokens(325_000) / 3n;
    expect(p.rows.every((r) => r.rank === 1 && r.tied)).toBe(true);
    expect(p.rows.map((r) => tokens(r.totalRewardPlain))).toEqual([each, each, each]);
    expect(tokens(p.summary.totalPayoutPlain)).toBe(each * 3n);
    expect(sum(p.rows.map((r) => r.totalRewardPlain))).toBe(each * 3n);
    expect(tokens(p.summary.basePool.replace(/,/g, "")) - each * 3n).toBe(tokens(500_000) - each * 3n); // the remainder (< 3 base units) + unfilled positions go back to the reserve
    expect(await ledgerTotal("DAILY")).toBe(each * 3n);
    await healthy();
  });

  it("players below the minimum (19 picks) are on the board but are NOT in the payout; exactly 20 is", async () => {
    await seedScores(db, [
      { user: 9101, day: DAY, picks: 19, correct: 19 }, // best record, one pick short
      { user: 9102, day: DAY, picks: 20, correct: 5 },
    ]);
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.rows.map((r) => [r.telegramUserId, r.rank, r.basePrizePlain])).toEqual([[9102, 2, "150000"]]); // the only prize-eligible player takes the first rung (the below-minimum leader takes no position)
    expect(p.summary).toMatchObject({ prizeWinners: 1, totalPayout: "150,000" });
  });
});

describe("WEEKLY PAYOUT SUMMARY — 1,000,000 base, up to 1,250,000", () => {
  it("all ten winners FREE: TOTAL 1,000,000", async () => {
    await weeklyField();
    await closeWeekly();
    const p = await payoutOf("WEEKLY", WEEK);
    expect(p.summary).toMatchObject({ kind: "WEEKLY", start: WEEK, basePool: "1,000,000", baseAwarded: "1,000,000", holderBonuses: "0", totalPayout: "1,000,000", totalPayoutPlain: "1000000", prizeWinners: 10 });
    p.rows.forEach((r, i) => expect(r).toMatchObject({ rank: i + 1, picks: 100, correctPicks: 100 - i * 5, basePrizePlain: String(SPEC.weekly[i]) }));
    expect(await ledgerTotal("WEEKLY")).toBe(tokens(1_000_000));
    await healthy();
  }, 120_000);

  it("all ten winners 10M with 7-day continuity before AND throughout the week: base 1,000,000 + 250,000 = TOTAL 1,250,000 (the maximum)", async () => {
    await weeklyField();
    for (let i = 0; i < 10; i++) await holder(9001 + i, "10M", "WEEKLY");
    await closeWeekly();
    const p = await payoutOf("WEEKLY", WEEK);
    expect(p.summary).toMatchObject({ baseAwarded: "1,000,000", holderBonuses: "250,000", totalPayout: "1,250,000", totalPayoutPlain: "1250000" });
    expect(sum(p.rows.map((r) => r.totalRewardPlain))).toBe(tokens(1_250_000));
    expect(await ledgerTotal("WEEKLY")).toBe(tokens(1_250_000));
    await healthy();
  }, 180_000);
});

describe("review holds, pending verification and the claim status of each winner", () => {
  it("a prize HELD for review stays in the total but is flagged (send only after release); once FORFEITED it leaves the total and is returned to the reserve", async () => {
    await dailyField(3);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values (9001, 'REVIEW', 'test') on conflict (telegram_user_id) do update set review_state = 'REVIEW'");
    await closeDaily();
    let p = await payoutOf("DAILY", DAY);
    expect(p.rows[0]).toMatchObject({ rank: 1, claimStatus: "HELD", baseStatus: "HELD", totalRewardPlain: "150000" });
    expect(p.summary).toMatchObject({ totalPayout: "325,000", heldForReview: "150,000", forfeited: "0" });
    expect(p.summary.byStatus).toMatchObject({ HELD: "150,000", UNCLAIMED: "175,000", SENT: "0" });
    expect(payoutSummaryText(p)).toMatch(/of which held for review \(send only after release\): 150,000/);

    const clock = { now: () => new Date(CLOSE) };
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9001, action: "forfeit", reason: "confirmed abuse", actor: "admin" })).toMatchObject({ ok: true, status: "FORFEITED" });
    p = await payoutOf("DAILY", DAY);
    expect(p.rows[0]).toMatchObject({ claimStatus: "FORFEITED", totalRewardPlain: "0" });
    expect(p.summary).toMatchObject({ totalPayout: "175,000", heldForReview: "0", forfeited: "150,000" });
    expect(sum(p.rows.map((r) => r.totalRewardPlain))).toBe(tokens(175_000));
    await healthy();
  });

  it("a prize released from review becomes a normal winner again (UNCLAIMED) in the same total", async () => {
    await dailyField(2);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values (9001, 'REVIEW', 'test') on conflict (telegram_user_id) do update set review_state = 'REVIEW'");
    await closeDaily();
    expect(await resolveHeldPrize(db, { now: () => new Date(CLOSE) }, { kind: "DAILY", start: DAY, userId: 9001, action: "release", reason: "reviewed — fine", actor: "admin" })).toMatchObject({ ok: true, status: "CREDITED" });
    const p = await payoutOf("DAILY", DAY);
    expect(p.rows.map((r) => r.claimStatus)).toEqual(["UNCLAIMED", "UNCLAIMED"]);
    expect(p.summary).toMatchObject({ totalPayout: "250,000", heldForReview: "0" });
  });

  it("a holder bonus still PENDING VERIFICATION is not in the total (and is counted, with the most it could add); once verified it joins the total as its own credit", async () => {
    await dailyField(3);
    await holder(9001, "10M");
    chain.setOutage(true);
    await closeDaily();
    let p = await payoutOf("DAILY", DAY);
    expect(p.rows[0]).toMatchObject({ bonusStatus: "PENDING_VERIFICATION", holderBonus: "0", holderTier: null, totalRewardPlain: "150000" });
    expect(p.summary).toMatchObject({ holderBonuses: "0", totalPayout: "325,000", bonusesPending: 1, bonusesPendingMaximum: "37,500" });
    expect(payoutSummaryText(p)).toMatch(/1 holder bonus\(es\) still pending verification — not included \(up to 37,500 more\)/);

    chain.setOutage(false);
    expect(await reconcileBonus(db, { now: () => new Date(CLOSE + HOUR), settings: settingsWith(), reader: chain }, "DAILY", DAY, 9001)).toBe("CREDITED");
    p = await payoutOf("DAILY", DAY);
    expect(p.rows[0]).toMatchObject({ holderTier: "10M", bonusPercent: "+25%", holderBonusPlain: "37500", totalRewardPlain: "187500" });
    expect(p.summary).toMatchObject({ holderBonuses: "37,500", totalPayout: "362,500", bonusesPending: 0 });
    expect(await ledgerTotal("DAILY")).toBe(tokens(362_500));
    await healthy();
  });

  it("CLAIM STATUS follows the manual flow: UNCLAIMED → PENDING (the destination) → SENT (with the transaction hash) → and DENIED when the operator refused the claim", async () => {
    await dailyField(4);
    await closeDaily();
    const now = () => new Date();
    const claim = async (userId: number, address: string) => {
      const r = await requestClaim(db, { now, allowDemo: true }, { userId, idempotencyKey: `payout-${userId}`, destination: { kind: "CUSTOM", address }, settings: DEFAULT_SETTINGS, target: targetFor(chain) });
      if (!r.ok) throw new Error(`claim refused: ${r.reason}`);
      return r.claim;
    };
    let p = await payoutOf("DAILY", DAY);
    expect(p.rows.map((r) => r.claimStatus)).toEqual(["UNCLAIMED", "UNCLAIMED", "UNCLAIMED", "UNCLAIMED"]);

    const first = await claim(9001, WALLET_A);
    const second = await claim(9002, WALLET_B);
    p = await payoutOf("DAILY", DAY);
    expect(p.rows.slice(0, 2).map((r) => [r.claimStatus, r.wallet, r.walletSource, r.txHash])).toEqual([["PENDING", WALLET_A, "CLAIM", null], ["PENDING", WALLET_B, "CLAIM", null]]);

    // The operator pays #1 by hand and records the transaction.
    const { hash } = chain.sendTransfer({ to: WALLET_A, amountRaw: chainTokens(150_000) });
    chain.advance(2);
    expect(await markClaimSent(db, { now }, chain, DEFAULT_SETTINGS, { claimId: first.id, txHash: hash, actor: "admin" })).toMatchObject({ ok: true });
    // …and refuses #2 (wrong wallet).
    expect(await denyClaim(db, { now }, { claimId: second.id, reason: "INVALID_WALLET", actor: "admin" })).toMatchObject({ ok: true });

    p = await payoutOf("DAILY", DAY);
    expect(p.rows.map((r) => r.claimStatus)).toEqual(["SENT", "DENIED", "UNCLAIMED", "UNCLAIMED"]);
    expect(p.rows[0]).toMatchObject({ wallet: WALLET_A, txHash: hash });
    expect(p.rows[1]!.txHash).toBeNull();
    expect(p.summary.byStatus).toMatchObject({ SENT: "150,000", DENIED: "100,000", UNCLAIMED: "125,000", PENDING: "0" });
    expect(p.summary.totalPayout).toBe("375,000"); // claim progress never changes what the board owes
    expect(payoutSummaryText(p)).toContain(`tx ${hash}`);
    await healthy();
  });

  it("a verified holder with no claim yet shows their connected wallet as the destination to expect", async () => {
    await dailyField(2);
    await holder(9001, "1M");
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.rows[0]).toMatchObject({ claimStatus: "UNCLAIMED", wallet: walletFor(9001), walletSource: "HOLDER_WALLET" });
    expect(p.rows[1]).toMatchObject({ wallet: null, walletSource: null });
  });

  it("an unfinalized (or never-existing) board has no payout, and a finalized board with nobody eligible has an empty one", async () => {
    expect(await boardPayout(db, "DAILY", DAY)).toBeNull();
    await seedScores(db, [{ user: 9601, day: DAY, picks: 3, correct: 3 }]);
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    expect(p.rows).toEqual([]);
    expect(p.summary).toMatchObject({ basePool: "500,000", baseAwarded: "0", returnedToReserve: "500,000", totalPayout: "0", prizeWinners: 0 });
  });

  it("paused prizes: a zero pool is frozen, so the payout is exactly zero", async () => {
    await dailyField(3);
    await closeDaily({ settings: settingsWith({ enabled: false }) });
    const p = await payoutOf("DAILY", DAY);
    expect(p.summary).toMatchObject({ basePool: "0", totalPayout: "0", prizeWinners: 0 });
    expect(await ledgerCount(db)).toBe(0);
  });
});

describe("COPY PAYOUT SUMMARY and EXPORT CSV carry exactly the payout — and no anti-fraud data", () => {
  it("the CSV has the documented columns, one line per winner, plain decimal amounts that add up to the total", async () => {
    await dailyField();
    await holder(9001, "10M");
    await holder(9002, "1M");
    await closeDaily();
    const p = await payoutOf("DAILY", DAY);
    const csv = payoutCsv(p);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("period_type,period_start,rank,telegram_id,hero,wallet,base_prize,holder_tier,holder_bonus_percent,holder_bonus,total_reward,claim_status,tx_hash");
    expect(lines).toHaveLength(11);
    expect(lines[1]).toBe(`DAILY,${DAY},1,9001,Hero 9001,${walletFor(9001)},150000,10M,25,37500,187500,UNCLAIMED,`);
    expect(lines[2]).toBe(`DAILY,${DAY},2,9002,Hero 9002,${walletFor(9002)},100000,1M,15,15000,115000,UNCLAIMED,`);
    expect(lines[3]).toBe(`DAILY,${DAY},3,9003,Hero 9003,,75000,,,0,75000,UNCLAIMED,`);
    const total = lines.slice(1).map((l) => l.split(",")[10]!).reduce((a, x) => a + tokens(x), 0n);
    expect(total).toBe(tokens(p.summary.totalPayoutPlain));
    // Nothing from the anti-fraud / review side leaks into an export.
    expect(csv).not.toMatch(/evidence|review|hold_reason|balance|observation|flag|suspicious|continuity/i);
  });

  it("the copied summary reads like a statement: the three headline numbers, then one line per winner", async () => {
    await dailyField(3);
    await holder(9001, "10M");
    await closeDaily();
    const text = payoutSummaryText(await payoutOf("DAILY", DAY));
    expect(text).toMatch(/^DAILY PAYOUT SUMMARY — 2026-10-07 \(UTC\)/);
    expect(text).toMatch(/Base Prize Pool\s+500,000 \$CLANKRPG/);
    expect(text).toMatch(/Holder Bonuses\s+37,500 \$CLANKRPG/);
    expect(text).toMatch(/TOTAL PAYOUT\s+362,500 \$CLANKRPG/);
    expect(text).toMatch(/#1 {2}Hero 9001 \(tg 9001\) {2}150,000 \+ 37,500 \(10M \+25%\) = 187,500 {2}\[UNCLAIMED\]/);
    expect(text).toMatch(/#2 {2}Hero 9002 \(tg 9002\) {2}100,000 = 100,000 {2}\[UNCLAIMED\]/);
  });

  it("every winner's number is the same in the rows, the summary and the frozen results table (nothing is recomputed from holdings)", async () => {
    await dailyField();
    await holder(9003, "500K");
    await closeDaily();
    const results = await allResults(db, "DAILY", DAY);
    const p = await payoutOf("DAILY", DAY);
    for (const r of p.rows) {
      const frozen = results.find((x) => Number(x.telegram_user_id) === r.telegramUserId)!;
      expect(tokens(r.basePrizePlain), `rank ${r.rank}`).toBe(BigInt(frozen.base_prize_micro));
      expect(tokens(r.holderBonusPlain)).toBe(frozen.bonus_status === "CREDITED" ? BigInt(frozen.bonus_micro) : 0n);
    }
  });
});
