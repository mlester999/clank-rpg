import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { boardResultsAdmin, reconcileRewards } from "@/server/rewards/admin";
import { requestClaim } from "@/server/rewards/claims";
import { getFinalBoard, reconcileBonus, reconcilePendingBonuses, resolveHeldPrize, expirePendingBonus } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { allResults, balanceOf, bindWallet, finalize, HOUR, ledgerCount, newChain, observe, observeSteady, resultOf, seedScores, settingsWith, targetFor, tokens, utc, walletFor, chainTokens } from "../support/rewards";

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
const CLOSE = utc(2026, 10, 8, 0, 0, 5); // the Daily ended 5 s ago; this is when the sweep runs
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: new Date(CLOSE) })).toEqual([]); // the fixture's own clock — the real one drifts past every window
};
/** #1 (9001), #2 (9002) and #3 (9003) on the Daily of Oct 7 — scores are fixed by merit alone. */
const podium = () => seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 20 }, { user: 9002, day: DAY, picks: 20, correct: 15 }, { user: 9003, day: DAY, picks: 20, correct: 10 }]);
/** Binds the member's verified holder wallet as of `sinceMs` and makes the chain report `closeBalance` at the close. */
async function holder(userId: number, sinceMs: number, closeBalance: bigint): Promise<string> {
  await seedEligibleMember(db, { id: userId });
  const wallet = await bindWallet(db, userId, { wallet: walletFor(userId), verifiedAtMs: sinceMs });
  chain.setBalance(wallet, closeBalance);
  return wallet;
}
const close = (over: { settings?: ReturnType<typeof settingsWith> } = {}) => finalize(db, "DAILY", DAY, CLOSE, { reader: chain, ...over });
const ledgerOf = (userId: number) => db.query<{ kind: string; claimable_delta: string }>("select kind, claimable_delta::text from public.arena_reward_ledger where telegram_user_id = $1 order by id", [userId]);

describe("CASE A — the #1 player buys 10M five minutes before the Daily closes", () => {
  it("gets the BASE prize (150,000) and NO holder bonus; the evidence says the 10M run began too recently", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(1_000)); // FREE balance all along…
    await observe(db, 9001, [{ at: utc(2026, 10, 7, 23, 55), balance: chainTokens(10_250_000) }]); // …then the buy, five minutes before the close
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ rank: 1, base_status: "CREDITED", base_prize_micro: tokens(150_000).toString(), bonus_status: "NONE", bonus_bps: 0, bonus_micro: "0" });
    expect((await ledgerOf(9001)).map((l) => l.kind)).toEqual(["DAILY_LEADERBOARD_BASE_REWARD"]);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(150_000));
    const ev = (await resultOf(db, "DAILY", DAY, 9001))!.bonus_evidence as { decision: string; tiers: Array<{ tierIndex: number; reason: string }> };
    expect(ev.decision).toBe("NONE");
    expect(ev.tiers.find((t) => t.tierIndex === 5)!.reason).toBe("RUN_TOO_RECENT");
    await healthy();
  });
});

describe("CASE B — held 10M for the previous 24 h and all day", () => {
  it("+25%: BASE 150,000 and a separate HOLDER BONUS of 37,500 = 187,500 claimable; nobody else's base prize shrinks", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 6, 0, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    expect(await close()).toMatchObject({ status: "FINALIZED", bonusesCredited: 1, bonusesPending: 0 });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_prize_micro: tokens(150_000).toString(), base_status: "CREDITED", bonus_status: "CREDITED", bonus_tier_index: 5, bonus_label: "10M", bonus_bps: 2500, bonus_micro: tokens(37_500).toString() });
    expect(await ledgerOf(9001)).toEqual([
      { kind: "DAILY_LEADERBOARD_BASE_REWARD", claimable_delta: tokens(150_000).toString() },
      { kind: "DAILY_LEADERBOARD_HOLDER_BONUS", claimable_delta: tokens(37_500).toString() },
    ]);
    expect(await balanceOf(db, 9001)).toEqual({ claimable: tokens(187_500), reserved: 0n, claimed: 0n, earned: tokens(187_500) });
    // The bonus is EXTRA: #2 and #3 still receive exactly their ladder prizes, and the board's base accounting is untouched.
    expect(await resultOf(db, "DAILY", DAY, 9002)).toMatchObject({ base_prize_micro: tokens(100_000).toString(), bonus_status: "NONE" });
    expect(await resultOf(db, "DAILY", DAY, 9003)).toMatchObject({ base_prize_micro: tokens(75_000).toString() });
    const [board] = await db.query<{ base_awarded_micro: string; returned_to_reserve_micro: string }>("select base_awarded_micro::text, returned_to_reserve_micro::text from public.arena_leaderboards");
    expect(board).toEqual({ base_awarded_micro: tokens(325_000).toString(), returned_to_reserve_micro: tokens(175_000).toString() });
    await healthy();
  });

  it("the continuity PROOF is frozen with the result (admin eyes only): the tier, when it began, how many checks, the lowest balance", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 6, 0, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    const rows = await boardResultsAdmin(db, "DAILY", DAY);
    const first = rows[0] as Record<string, unknown>;
    expect(first).toMatchObject({ rank: 1, basePrize: "150,000", holderTier: "10M", holderBonusPercent: "+25%", holderBonus: "37,500", totalReward: "187,500", baseStatus: "CREDITED", bonusStatus: "CREDITED" });
    expect(String(first.evidenceSummary)).toMatch(/QUALIFIED: verified at\/above the threshold at every one of \d+ checks since 2026-10-06T00:00:00Z/);
    expect(first.evidence).toMatchObject({ decision: "QUALIFIED", wallet: walletFor(9001) });
  });

  it("PUBLIC finished board shows the winner's tier label and the bonus, but never a balance, wallet or the evidence", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 6, 0, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    const final = await getFinalBoard(db, "DAILY", DAY, { nowMs: CLOSE });
    expect(final!.board.rows[0]).toMatchObject({ rank: 1, basePrize: "150,000", holderBonus: "37,500", holderTier: "10M", bonusStatus: "CREDITED", totalReward: "187,500" });
    expect(final!.board.rows[1]).toMatchObject({ holderBonus: "0", holderTier: null, totalReward: "100,000" });
    expect(JSON.stringify(final)).not.toMatch(/evidence|wallet|0x[0-9a-f]{40}|10,250,000|balance/i);
  });
});

describe("CASE C — qualified, then the balance drops before the close", () => {
  it("base prize stays; the 10M bonus is removed and the highest tier still held all day (1M, +15%) is paid instead", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(1_200_000)); // the chain says 1.2M at the close
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 13, 30), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 14, 0), utc(2026, 10, 7, 23, 30), chainTokens(1_200_000));
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_prize_micro: tokens(150_000).toString(), bonus_status: "CREDITED", bonus_label: "1M", bonus_bps: 1500, bonus_micro: tokens(22_500).toString() });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(172_500));
  });

  it("selling EVERYTHING before the close removes the bonus entirely; rank, points and the base prize are untouched", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), 0n);
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 13, 30), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 14, 0), utc(2026, 10, 7, 23, 30), 0n);
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ rank: 1, points: 200, base_status: "CREDITED", base_prize_micro: tokens(150_000).toString(), bonus_status: "NONE" });
  });

  it("TIER FALLBACK: a 10M holder who fell to 6M keeps the 5M bonus (+20%) — not all the way down to FREE", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(6_000_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 9, 30), chainTokens(10_000_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 10, 0), utc(2026, 10, 7, 23, 30), chainTokens(6_000_000));
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ bonus_label: "5M", bonus_bps: 2000, bonus_micro: tokens(30_000).toString() });
  });

  it("buying DURING the day (20:00) while #1 grants nothing for that day", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 19, 30), 0n);
    await observeSteady(db, 9001, utc(2026, 10, 7, 20, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_status: "CREDITED", bonus_status: "NONE" });
  });

  it("an unverified gap (> 6 h without a successful check) breaks continuity even though the balance never moved", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 4, 0), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 11, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000)); // 7 h hole
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_status: "CREDITED", bonus_status: "NONE" });
  });
});

describe("CASE F — the same 10M moved between wallets/accounts: no instant reuse of qualification", () => {
  it("A qualified all day, sends everything to B at 22:00; B only has a wallet history since 22:00 — NEITHER gets the 10M bonus", async () => {
    await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 20 }, { user: 9002, day: DAY, picks: 20, correct: 19 }]);
    await holder(9001, utc(2026, 10, 5), 0n); // A: the chain shows 0 at the close
    await holder(9002, utc(2026, 10, 7, 22, 0), chainTokens(10_250_000)); // B: bound and funded at 22:00
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 21, 30), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 22, 0), utc(2026, 10, 7, 23, 30), 0n);
    await observeSteady(db, 9002, utc(2026, 10, 7, 22, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_prize_micro: tokens(150_000).toString(), bonus_status: "NONE" });
    expect(await resultOf(db, "DAILY", DAY, 9002)).toMatchObject({ base_prize_micro: tokens(100_000).toString(), bonus_status: "NONE" });
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
  });

  it("a wallet that is not bound to any account (or whose history belongs to another account) contributes nothing", async () => {
    await podium();
    await seedEligibleMember(db, { id: 9001 }); // no wallet at all
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_status: "CREDITED", bonus_status: "NONE", bonus_evidence: null });
  });
});

describe("WEEKLY bonus — 7 days before AND throughout the week", () => {
  const WEEK = "2026-10-12";
  const WEEK_CLOSE = utc(2026, 10, 19, 0, 0, 5);
  const weekScores = () => seedScores(db, [{ user: 9001, day: "2026-10-13", picks: 20, correct: 20 }, ...[9002, 9003].map((user, i) => ({ user, day: "2026-10-13", picks: 20, correct: 15 - i * 5 })), ...Array.from({ length: 3 }, (_, d) => ({ user: 9001, day: `2026-10-${14 + d}`, picks: 20, correct: 20 })), ...[9002].flatMap((user) => Array.from({ length: 3 }, (_, d) => ({ user, day: `2026-10-${14 + d}`, picks: 20, correct: 12 })))]);
  const weekClose = () => finalize(db, "WEEKLY", WEEK, WEEK_CLOSE, { reader: chain, settings: settingsWith({ weeklyMinimumPicks: 50 }) });

  it("CASE D — buys 10M on Sunday night while already #1 for the week: NO instant +25% (base 300,000 only)", async () => {
    await weekScores();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 18, 21, 30), 0n);
    await observeSteady(db, 9001, utc(2026, 10, 18, 22, 0), utc(2026, 10, 18, 23, 30), chainTokens(10_250_000));
    await weekClose();
    expect(await resultOf(db, "WEEKLY", WEEK, 9001)).toMatchObject({ rank: 1, base_prize_micro: tokens(300_000).toString(), bonus_status: "NONE" });
    expect(await ledgerCount(db, "WEEKLY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
  });

  it("CASE E — satisfied the 7-day pre-week requirement and the entire week: +25% Weekly bonus (75,000 on the 300,000)", async () => {
    await weekScores();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 18, 23, 30), chainTokens(10_250_000), HOUR);
    await weekClose();
    expect(await resultOf(db, "WEEKLY", WEEK, 9001)).toMatchObject({ base_prize_micro: tokens(300_000).toString(), bonus_status: "CREDITED", bonus_label: "10M", bonus_micro: tokens(75_000).toString() });
    expect((await ledgerOf(9001)).map((l) => l.kind)).toEqual(["WEEKLY_LEADERBOARD_BASE_REWARD", "WEEKLY_LEADERBOARD_HOLDER_BONUS"]);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(375_000));
  });

  it("the weekly bar is HARDER than the daily one: the same holding (since Oct 7 18:00) qualifies a Daily board but not the Weekly", async () => {
    await weekScores();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5, 18, 0), utc(2026, 10, 18, 23, 30), chainTokens(10_250_000), HOUR); // 6 d 6 h before the week
    await weekClose();
    expect((await resultOf(db, "WEEKLY", WEEK, 9001))!.bonus_status).toBe("NONE");
  });

  it("selling below the tier during the active week breaks it: rank and base prize stay, only the bonus changes (here 10M → the 100K tier)", async () => {
    await weekScores();
    await holder(9001, utc(2026, 10, 5), chainTokens(300_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 14, 9, 0), chainTokens(10_250_000), HOUR);
    await observeSteady(db, 9001, utc(2026, 10, 14, 10, 0), utc(2026, 10, 18, 23, 0), chainTokens(300_000), HOUR);
    await weekClose();
    expect(await resultOf(db, "WEEKLY", WEEK, 9001)).toMatchObject({ rank: 1, base_prize_micro: tokens(300_000).toString(), bonus_label: "100K", bonus_micro: tokens(15_000).toString() });
  });
});

describe("the FINAL CLOSE verification and the PENDING window — never granted blindly", () => {
  it("each prize winner with a verified wallet gets a FRESH authoritative read at the close, logged as CLOSE (and only winners are read)", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await holder(9002, utc(2026, 10, 5), chainTokens(2_000_000));
    await seedEligibleMember(db, { id: 9099 });
    await bindWallet(db, 9099, { verifiedAtMs: utc(2026, 10, 5) }); // a connected non-winner
    chain.setBalance(walletFor(9099), chainTokens(7_000_000));
    const before = chain.reads;
    await close();
    expect(chain.reads - before).toBe(2); // exactly the two winners with wallets
    expect((await db.query<{ source: string; n: number }>("select source, count(*)::int as n from public.arena_holder_observations group by source")).map((r) => [r.source, r.n])).toEqual([["CLOSE", 2]]);
  });

  it("if the close read FAILS the base prize is still paid at once and the bonus waits as PENDING VERIFICATION (not credited, not lost) — the board is NOT blocked", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    expect(await close()).toMatchObject({ status: "FINALIZED", credited: 3, bonusesCredited: 0, bonusesPending: 1 });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_status: "CREDITED", bonus_status: "PENDING_VERIFICATION", bonus_micro: "0", bonus_bps: 0 });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(150_000)); // base only, for now
    expect((await finalizedPublic()).rows[0]).toMatchObject({ bonusStatus: "PENDING", holderBonus: "0", totalReward: "150,000" });
    await healthy();
  });

  it("…and a later successful verification (still inside the window, still continuous) CREDITS the bonus as its own ledger entry — exactly once", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    await close();
    chain.setOutage(false);
    const ctx = { now: () => new Date(CLOSE + HOUR), settings: settingsWith(), reader: chain };
    expect(await reconcileBonus(db, ctx, "DAILY", DAY, 9001)).toBe("CREDITED");
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ bonus_status: "CREDITED", bonus_label: "10M", bonus_micro: tokens(37_500).toString() });
    expect((await ledgerOf(9001)).map((l) => l.kind)).toEqual(["DAILY_LEADERBOARD_BASE_REWARD", "DAILY_LEADERBOARD_HOLDER_BONUS"]);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(187_500));
    expect(await reconcileBonus(db, ctx, "DAILY", DAY, 9001)).toBe("NOT_PENDING"); // idempotent
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(1);
    await healthy();
  });

  it("while the chain is still down the bonus keeps WAITING (re-checked on every sweep); once the window passes it EXPIRES — the base prize is never touched", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    await close();
    const inside = { now: () => new Date(CLOSE + 12 * HOUR), settings: settingsWith(), reader: chain };
    expect(await reconcileBonus(db, inside, "DAILY", DAY, 9001)).toBe("STILL_PENDING");
    expect((await resultOf(db, "DAILY", DAY, 9001))!.bonus_status).toBe("PENDING_VERIFICATION");
    const after = { now: () => new Date(CLOSE + 25 * HOUR), settings: settingsWith(), reader: chain };
    expect(await reconcilePendingBonuses(db, after)).toEqual({ checked: 1, credited: 0, expired: 1 });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ bonus_status: "EXPIRED", base_status: "CREDITED", bonus_micro: "0" });
    chain.setOutage(false);
    expect(await reconcileBonus(db, { ...after, now: () => new Date(CLOSE + 26 * HOUR) }, "DAILY", DAY, 9001)).toBe("NOT_PENDING"); // expired is final
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(150_000));
  });

  it("a pending bonus that no longer qualifies by the time it is re-checked (the balance is gone) resolves to NONE — never credited on the old promise", async () => {
    await podium();
    const wallet = await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    await close();
    chain.setOutage(false);
    chain.setBalance(wallet, 0n);
    expect(await reconcileBonus(db, { now: () => new Date(CLOSE + HOUR), settings: settingsWith(), reader: chain }, "DAILY", DAY, 9001)).toBe("NONE");
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
  });

  it("a bonus that could never have qualified is NONE immediately — nothing waits for a verification that cannot help", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 7, 20, 0), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 20, 0), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    await close();
    expect((await resultOf(db, "DAILY", DAY, 9001))!.bonus_status).toBe("NONE");
  });

  it("an admin may give up on a pending bonus (reason required, audited); the base prize is untouched", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    chain.setOutage(true);
    await close();
    const ctx = { now: () => new Date(CLOSE + HOUR) };
    expect(await expirePendingBonus(db, ctx, { kind: "DAILY", start: DAY, userId: 9001, reason: "x", actor: "admin" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await expirePendingBonus(db, ctx, { kind: "DAILY", start: DAY, userId: 9001, reason: "chain unavailable for the whole window", actor: "admin" })).toEqual({ ok: true });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ bonus_status: "EXPIRED", base_status: "CREDITED" });
    expect(await expirePendingBonus(db, ctx, { kind: "DAILY", start: DAY, userId: 9001, reason: "again please", actor: "admin" })).toEqual({ ok: false, reason: "NOT_PENDING" });
  });

  it("with no reader configured at all, bonuses wait as PENDING for any winner whose evidence would qualify, and the finalization still completes", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    expect(await finalize(db, "DAILY", DAY, CLOSE, { reader: null })).toMatchObject({ status: "FINALIZED", bonusesPending: 1, credited: 3 });
  });
});

describe("a prize HELD for review carries its bonus with it", () => {
  it("base HELD + bonus HELD (nothing credited); an admin RELEASE credits both as separate ledger entries; a FORFEIT returns both to the reserve", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await holder(9002, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9002, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    for (const u of [9001, 9002]) await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values ($1, 'REVIEW', 'test') on conflict (telegram_user_id) do update set review_state = 'REVIEW'", [u]);
    await close();
    for (const [u, base, bonus] of [[9001, 150_000, 37_500], [9002, 100_000, 25_000]] as const) {
      expect(await resultOf(db, "DAILY", DAY, u)).toMatchObject({ base_status: "HELD", bonus_status: "HELD", base_prize_micro: tokens(base).toString(), bonus_micro: tokens(bonus).toString() });
      expect((await balanceOf(db, u)).earned).toBe(0n);
    }
    const clock = { now: () => new Date(CLOSE + HOUR) };
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9001, action: "release", reason: "reviewed — fine", actor: "admin" })).toMatchObject({ ok: true, status: "CREDITED", baseMicro: tokens(150_000), bonusMicro: tokens(37_500) });
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ base_status: "CREDITED", bonus_status: "CREDITED" });
    expect((await ledgerOf(9001)).map((l) => l.kind)).toEqual(["DAILY_LEADERBOARD_BASE_REWARD", "DAILY_LEADERBOARD_HOLDER_BONUS"]);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(187_500));
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9002, action: "forfeit", reason: "confirmed abuse", actor: "admin" })).toMatchObject({ ok: true, status: "FORFEITED" });
    expect(await resultOf(db, "DAILY", DAY, 9002)).toMatchObject({ base_status: "FORFEITED", bonus_status: "FORFEITED" });
    expect((await balanceOf(db, 9002)).earned).toBe(0n);
    await healthy();
  });
});

describe("holdings NEVER affect rank, points, ties or the base prize", () => {
  it("a qualified 10M holder tied EXACTLY with a FREE player shares the SAME base (87,500 each); the bonus is the only difference and is added on top", async () => {
    await seedScores(db, [
      { user: 9001, day: DAY, picks: 20, correct: 19 },
      { user: 9002, day: DAY, picks: 20, correct: 15 }, // the holder
      { user: 9003, day: DAY, picks: 20, correct: 15 }, // FREE, exactly tied
    ]);
    await holder(9002, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9002, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    const [holderRow, freeRow] = [await resultOf(db, "DAILY", DAY, 9002), await resultOf(db, "DAILY", DAY, 9003)];
    expect(holderRow).toMatchObject({ rank: 2, tie_size: 2, points: 150, base_prize_micro: tokens(87_500).toString(), bonus_micro: tokens(21_875).toString() });
    expect(freeRow).toMatchObject({ rank: 2, tie_size: 2, points: 150, base_prize_micro: tokens(87_500).toString(), bonus_status: "NONE" });
    expect((await balanceOf(db, 9002)).claimable).toBe(tokens(109_375));
    expect((await balanceOf(db, 9003)).claimable).toBe(tokens(87_500));
  });

  it("the same scores produce IDENTICAL ranks, points, tie sizes and base prizes with and without a holder in the field", async () => {
    const field = [{ user: 9001, day: DAY, picks: 20, correct: 18 }, { user: 9002, day: DAY, picks: 20, correct: 14 }, { user: 9003, day: DAY, picks: 20, correct: 14 }, { user: 9004, day: DAY, picks: 15, correct: 9 }];
    await seedScores(db, field);
    await close();
    const plain = (await allResults(db, "DAILY", DAY)).map((r) => [r.telegram_user_id, r.rank, r.points, r.tie_size, r.base_prize_micro]);
    await resetDb(db);
    chain = newChain();
    await seedScores(db, field);
    await holder(9003, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9003, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    const withHolder = (await allResults(db, "DAILY", DAY)).map((r) => [r.telegram_user_id, r.rank, r.points, r.tie_size, r.base_prize_micro]);
    expect(withHolder).toEqual(plain);
  });

  it("a holder who is NOT a prize winner gets no bonus and no extra read (a bonus is only ever on an earned prize)", async () => {
    await seedScores(db, ladderOf(11));
    await holder(9011, utc(2026, 10, 5), chainTokens(10_250_000)); // #11: outside the Top 10
    await observeSteady(db, 9011, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    expect(await resultOf(db, "DAILY", DAY, 9011)).toMatchObject({ rank: 11, base_status: "NONE", bonus_status: "NONE" });
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
  });
});

describe("base and bonus stay apart all the way to a claim", () => {
  it("a manual claim reserves the member's WHOLE claimable balance (base + bonus); the ledger still shows each part separately", async () => {
    await podium();
    await holder(9001, utc(2026, 10, 5), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await close();
    const r = await requestClaim(db, { now: () => new Date(CLOSE + HOUR), allowDemo: true }, { userId: 9001, idempotencyKey: "claim-base-and-bonus", destination: { kind: "HOLDER_WALLET" }, settings: DEFAULT_SETTINGS, target: targetFor(chain) });
    expect(r).toMatchObject({ ok: true });
    expect(await balanceOf(db, 9001)).toEqual({ claimable: 0n, reserved: tokens(187_500), claimed: 0n, earned: tokens(187_500) });
    expect((await ledgerOf(9001)).map((l) => l.kind)).toEqual(["DAILY_LEADERBOARD_BASE_REWARD", "DAILY_LEADERBOARD_HOLDER_BONUS", "CLAIM_RESERVED"]);
    await healthy();
  });
});

function ladderOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ user: 9001 + i, day: DAY, picks: 20, correct: 20 - i }));
}
async function finalizedPublic() {
  const f = await getFinalBoard(db, "DAILY", DAY, { nowMs: CLOSE });
  return f!.board;
}
