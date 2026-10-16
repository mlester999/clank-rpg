import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { boardResultsAdmin, boardsAdminOverview, holderOverview, listAccounts, listClaims, listRecentBattles, listReview, reconcileRewards, rewardsOverview, setReviewState } from "@/server/rewards/admin";
import type { SimulatedChainReader } from "@/server/rewards/chain";
import { requestClaim } from "@/server/rewards/claims";
import type { TokenStatus } from "@/server/rewards/context";
import { finalizeDueBoards } from "@/server/rewards/leaderboard";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { bindWallet, credit, DECIMALS, finalize, newChain, observe, observeSteady, pickers, seedScores, settingsWith, settle, targetFor, TOKEN, tokens, TREASURY, utc, walletFor, WALLET_A, chainTokens } from "../support/rewards";
import { finishBattle, stageBattle } from "../support/stage";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

const tokenStatus = (over: Partial<TokenStatus> = {}): TokenStatus => ({ launched: true, available: true, reasons: [], adapter: "simulated", tokenAddress: TOKEN, publicAddress: TOKEN, chainId: 4663, treasuryAddress: TREASURY, explorerTxUrl: null, ...over });
const funded = (): SimulatedChainReader => {
  const c = newChain();
  c.setBalance(TREASURY, chainTokens(1_000_000)); // the optional, read-only reward wallet
  return c;
};
const overview = async (reader: SimulatedChainReader | null = funded(), nowMs = Date.now(), token: TokenStatus = tokenStatus(), settings = DEFAULT_SETTINGS) =>
  rewardsOverview(db, { settings, tokenDecimals: reader ? DECIMALS : null, token, reader, nowMs });

describe("admin: the LEADERBOARD ECONOMY — what the rules can cost at most", () => {
  it("DAILY base 500,000 + max holder bonus exposure 125,000 = max liability 625,000; WEEKLY 1,000,000 + 250,000 = 1,250,000", async () => {
    const o = await overview();
    expect(o.economy.daily).toEqual({ basePool: "500,000", maxBonusExposure: "125,000", maxLiability: "625,000" });
    expect(o.economy.weekly).toEqual({ basePool: "1,000,000", maxBonusExposure: "250,000", maxLiability: "1,250,000" });
    expect(o.economy.maxBonusPercent).toBe(25);
  });
  it("SEASON 1 PLAN: 84 days × 500,000 + 12 weeks × 1,000,000 = 54,000,000 base; 67,500,000 with every bonus at 25%; inside a 75,000,000 allocation with a 7,500,000 buffer — a planning metric only", async () => {
    const { season } = (await overview()).economy;
    expect(season).toEqual({ weeks: 12, days: 84, dailyBaseTotal: "42,000,000", weeklyBaseTotal: "12,000,000", baseMaximum: "54,000,000", maximumWithBonuses: "67,500,000", allocation: "75,000,000", buffer: "7,500,000", fits: true });
    expect((await overview()).warnings.join(" ")).not.toMatch(/Season plan/);
    // Nothing was minted or reserved by looking at it.
    expect(await db.query("select 1 from public.arena_reward_ledger")).toHaveLength(0);
  });
  it("a plan that does not fit the allocation raises a warning; the numbers follow the settings", async () => {
    const o = await overview(undefined, Date.now(), tokenStatus(), settingsWith({ seasonRewardAllocation: "60000000" }));
    expect(o.economy.season).toMatchObject({ fits: false, buffer: "-7,500,000" });
    expect(o.warnings.join(" ")).toMatch(/Season plan: the maximum payout with every holder bonus \(67,500,000\) exceeds the reward allocation \(60,000,000\)/);
    expect((await overview(undefined, Date.now(), tokenStatus(), settingsWith({ dailyPrizePool: "50000" }))).economy.daily.maxLiability).toBe("62,500");
  });
  it("carries the rules the boards run on: the minimum picks, points, the ladder, the bonus tiers and the qualification windows — and no per-battle pool or daily emission cap exists", async () => {
    const o = await overview();
    expect(o).toMatchObject({ prizesEnabled: true, minimumPicks: { daily: 20, weekly: 100 }, pointsPerCorrectPick: 10, holderQualifyHours: { daily: 24, weekly: 168 }, holderMaxAgeHours: 6, holderRefreshMinutes: 30 });
    expect(o.rules.daily).toMatchObject({ prizePool: "500,000", topRewarded: 10, minimumPicks: 20 });
    expect(o).not.toHaveProperty("scoredPicksPerDay");
    expect(o.rules.weekly).toMatchObject({ prizePool: "1,000,000", topRewarded: 10, minimumPicks: 100 });
    expect(o.rules.daily.prizes.map((p) => p.amount)).toEqual(["150,000", "100,000", "75,000", "50,000", "40,000", "30,000", "20,000", "15,000", "10,000", "10,000"]);
    expect(o.holderBonusTiers.map((t) => `${t.label} ${t.bonus}`)).toEqual(["100K +5%", "500K +10%", "1M +15%", "5M +20%", "10M +25%"]);
    expect(Object.keys(o)).not.toEqual(expect.arrayContaining(["rewardPerBattle", "dailyEmissionCap", "emittedToday"]));
    expect(o.warnings.join(" ")).not.toMatch(/emission cap/i);
  });
});

describe("admin: Arena Picks overview & reserve health", () => {
  it("shows the live crowd (admins always see counts), today's scoring and, after a finalization, what was awarded as BASE and as HOLDER BONUS", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 2);
    await pickers(db, s, s.fighters.find((f) => f !== s.winnerId)!, 3);
    const live = await overview(undefined, s.clock.ms);
    expect(live).toMatchObject({ minimumClaim: "10,000", eligibleMembers: expect.any(Number), token: { available: true, adapter: "simulated" } });
    expect(live.currentBattle).toMatchObject({ id: s.battleId, picks: 5 });
    expect(live.currentBattle!.distribution[s.winnerId]).toBe(2); // before lock — admins only
    await finishBattle(db, s);
    await settle(db, s);
    expect((await overview(undefined, s.clock.ms)).today).toMatchObject({ totalPicks: 5, boardPicks: 5, leaderboardPoints: 20, lifetimePointsIssued: 20, participants: 5 });
    // A finalized day: base and bonus kept apart; nothing is "emitted" until a board is finalized.
    expect((await overview(undefined, s.clock.ms)).awarded).toEqual({ base: "0", bonus: "0", heldBase: "0", pendingBonuses: 0 });
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }, { user: 9002, day: "2026-10-07", picks: 20, correct: 15 }]);
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 5) });
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    const chain = funded();
    chain.setBalance(walletFor(9001), chainTokens(10_250_000)); // what the close verification will read
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5), { reader: chain });
    const after = await overview();
    expect(after.awarded).toMatchObject({ base: "250,000", bonus: "37,500" });
    expect(after).toMatchObject({ outstanding: "287,500", claimableLiability: "287,500" });
    expect(after.coverageRatio).toBeCloseTo(1_000_000 / 287_500, 3);
  });

  it("watches the reward wallet READ-ONLY: warns BEFORE liabilities exceed its balance, when coverage is thin, when the token is off, and when a retired private key is still in the environment", async () => {
    const u = await seedEligibleMember(db);
    await credit(db, u, tokens(5_000));
    const fund = (n: bigint) => {
      const c = newChain();
      c.setBalance(TREASURY, n);
      return c;
    };
    expect((await overview(fund(chainTokens(1_000_000)))).warnings).toEqual([]);
    expect((await overview(fund(chainTokens(5_500)))).warnings.join(" ")).toMatch(/coverage is low/i); // 1.1× — below the 1.25× comfort line
    expect((await overview(fund(chainTokens(4_000)))).warnings.join(" ")).toMatch(/exceed the reward wallet/i);
    const unreadable = newChain();
    unreadable.setOutage(true);
    expect((await overview(unreadable)).warnings.join(" ")).toMatch(/could not be read/i);
    const noWallet = await overview(newChain(), Date.now(), tokenStatus({ treasuryAddress: null }));
    expect(noWallet.treasuryBalance).toBeNull();
    // NOT LAUNCHED is a normal state: a notice, never a warning — nothing waits on the token
    const off = await overview(null, Date.now(), tokenStatus({ launched: false, available: false, reasons: ["CLANKRPG_TOKEN_ADDRESS is not set"], tokenAddress: null, publicAddress: null }));
    expect(off.token).toMatchObject({ launched: false, available: false });
    expect(off.warnings).toEqual([]);
    expect(off.notices.join(" ")).toMatch(/has not launched yet/);
    expect(off.notices.join(" ")).toMatch(/every holder bonus is 0 %/);
    // launched (an address is configured) but unusable: a real warning
    const broken = await overview(null, Date.now(), tokenStatus({ available: false, reasons: ["the chain reader is switched off"] }));
    expect(broken.warnings.join(" ")).toMatch(/configured but unusable/);
    expect(broken.warnings.join(" ")).toMatch(/nobody earns a holder bonus/);
    process.env.CLANKRPG_REWARD_TREASURY_PRIVATE_KEY = "0xdeadbeef";
    try {
      const warned = await overview(newChain());
      expect(warned.warnings.join(" ")).toMatch(/CLANKRPG_REWARD_TREASURY_PRIVATE_KEY is set/);
      expect(JSON.stringify(warned)).not.toContain("deadbeef"); // the NAME is reported, never the value
    } finally {
      delete process.env.CLANKRPG_REWARD_TREASURY_PRIVATE_KEY;
    }
  });

  it("counts the manual payout queue and held accounts", async () => {
    const u = await seedEligibleMember(db);
    await credit(db, u, tokens(12_000));
    const r = await requestClaim(db, { now: () => new Date(), allowDemo: true }, { userId: u, idempotencyKey: "admin-test-claim-1", destination: { kind: "CUSTOM", address: WALLET_A }, settings: DEFAULT_SETTINGS, target: targetFor(newChain()) });
    expect(r.ok).toBe(true);
    await setReviewState(db, await seedEligibleMember(db), "REVIEW", "odd pattern", "admin");
    const o = await overview();
    expect(o).toMatchObject({ pendingClaims: { count: 1, amount: "12,000" }, reservedByClaims: "12,000", heldAccounts: 1 });
    expect(o.warnings.join(" ")).toMatch(/1 claim\(s\) are waiting for a manual payout/);
  });

  it("warns when connected holder wallets are overdue for verification (a gap over the freshness window breaks continuity) and when a bonus is pending verification", async () => {
    const u = await seedEligibleMember(db);
    await bindWallet(db, u, { verifiedAtMs: utc(2026, 10, 1) });
    const o = await overview(undefined, utc(2026, 10, 7)); // never verified since binding → overdue
    expect(o.warnings.join(" ")).toMatch(/1 connected holder wallet\(s\) are more than 60 min overdue for verification/);
  });
});

describe("admin: leaderboards, finalized Top 10 with evidence, and holder qualification", () => {
  const DAY = "2026-10-07";
  const CLOSE = utc(2026, 10, 8, 0, 0, 5);

  it("the boards overview lists the running Daily and Weekly, finalized boards (base awarded, bonuses, held, pending) and any period still waiting to be frozen", async () => {
    await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 18 }, { user: 9002, day: DAY, picks: 20, correct: 6 }, { user: 9003, day: "2026-10-08", picks: 15, correct: 9 }]);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state) values (9002, 'REVIEW') on conflict (telegram_user_id) do update set review_state = 'REVIEW'");
    const nowMs = utc(2026, 10, 8, 12, 0, 0);
    let ov = await boardsAdminOverview(db, { settings: settingsWith(), nowMs });
    expect(ov.current.DAILY).toMatchObject({ start: "2026-10-08", prizePool: "500,000", participants: 1, minimumPicks: 20 });
    expect(ov.current.WEEKLY).toMatchObject({ start: "2026-10-05", prizePool: "1,000,000" });
    expect(ov.unfinalized).toEqual([{ kind: "DAILY", start: DAY }]); // ended, scored, not frozen yet
    await finalizeDueBoards(db, { now: () => new Date(nowMs), settings: settingsWith(), reader: null });
    ov = await boardsAdminOverview(db, { settings: settingsWith(), nowMs });
    expect(ov.unfinalized).toEqual([]);
    expect(ov.finalized[0]).toMatchObject({ kind: "DAILY", start: DAY, participants: 2, eligible: 2, prizePool: "500,000", baseAwarded: "250,000", returned: "250,000", credited: 1, held: 1, bonusesCredited: 0 });
  });

  it("each finalized Top-10 row carries rank, hero, points, accuracy, base prize, holder tier, bonus %, bonus amount, total, review status and the qualification evidence summary", async () => {
    await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 20 }, { user: 9002, day: DAY, picks: 20, correct: 15 }]);
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 5) });
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    const chain = newChain();
    chain.setBalance(walletFor(9001), chainTokens(10_250_000));
    await finalize(db, "DAILY", DAY, CLOSE, { reader: chain });
    const rows = await boardResultsAdmin(db, "DAILY", DAY);
    expect(rows[0]).toMatchObject({ rank: 1, hero: "Hero 9001", points: 200, accuracyBps: 10000, basePrize: "150,000", holderTier: "10M", holderBonusPercent: "+25%", holderBonus: "37,500", totalReward: "187,500", baseStatus: "CREDITED", bonusStatus: "CREDITED", telegramUserId: 9001 });
    expect(String(rows[0]!.evidenceSummary)).toMatch(/QUALIFIED/);
    expect(rows[1]).toMatchObject({ rank: 2, basePrize: "100,000", holderTier: null, holderBonus: "0", totalReward: "100,000", bonusStatus: "NONE", evidenceSummary: null });
  });

  it("an admin's evidence line says WHY a buyer near the close did not qualify", async () => {
    await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 20 }]);
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 5) });
    await observe(db, 9001, [{ at: utc(2026, 10, 7, 23, 55), balance: chainTokens(10_250_000) }]);
    const chain = newChain();
    chain.setBalance(walletFor(9001), chainTokens(10_250_000));
    await finalize(db, "DAILY", DAY, CLOSE, { reader: chain });
    const [row] = await boardResultsAdmin(db, "DAILY", DAY);
    expect(row).toMatchObject({ bonusStatus: "NONE", basePrize: "150,000" });
    expect(String(row!.evidenceSummary)).toMatch(/Not qualified — .*held only since 2026-10-07T23:55:00Z \(needed ≤ 2026-10-06T00:00:00Z\)/);
  });

  it("the HOLDER QUALIFICATION table shows wallet, balance, observed tier, last verified, next check, failures and Daily / Weekly Qualified / Qualifying / Broken with start and break time", async () => {
    const now = utc(2026, 10, 12, 10, 0, 0); // a Monday
    for (const [u, tier] of [[9001, 5_000_000], [9002, 1_300_000], [9003, 0]] as const) {
      await seedEligibleMember(db, { id: u });
      await bindWallet(db, u, { verifiedAtMs: utc(2026, 10, 1) });
      await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, verified_balance_raw, balance_verified_at, next_check_at) values ($1, $2, $3::numeric, $4::timestamptz, $5::timestamptz)", [u, walletFor(u), chainTokens(tier).toString(), new Date(now - 10 * 60_000).toISOString(), new Date(now + 20 * 60_000).toISOString()]);
    }
    await observeSteady(db, 9001, utc(2026, 10, 1), now - 10 * 60_000, chainTokens(5_000_000)); // qualified for both
    await observeSteady(db, 9002, utc(2026, 10, 11, 20, 0), now - 10 * 60_000, chainTokens(1_300_000)); // only since Oct 11 20:00 → QUALIFYING
    await observeSteady(db, 9003, utc(2026, 10, 1), now - 10 * 60_000, chainTokens(2_000)); // FREE
    const h = await holderOverview(db, { settings: settingsWith(), tokenDecimals: DECIMALS, nowMs: now });
    const by = (id: number) => h.accounts.find((a) => a.telegramUserId === id)!;
    expect(h).toMatchObject({ connectedWallets: 3, overdue: 0, holderMaxAgeHours: 6, refreshMinutes: 30, batchSize: 25 });
    expect(by(9001)).toMatchObject({ wallet: walletFor(9001), balance: "5,000,000", observedTier: "5M HOLDER", failures: 0, stale: false, daily: { status: "QUALIFIED", tier: "5M" }, weekly: { status: "QUALIFIED", tier: "5M" } });
    expect(by(9001).weekly.qualificationStart).toBe(utc(2026, 10, 1));
    expect(by(9002)).toMatchObject({ observedTier: "1M HOLDER", daily: { status: "QUALIFYING", tier: "1M", eligibleFrom: utc(2026, 10, 13) }, weekly: { status: "QUALIFYING", eligibleFrom: utc(2026, 10, 19) } });
    expect(by(9003)).toMatchObject({ observedTier: "FREE", daily: { status: "NONE" } });
    expect(by(9001).nextCheckAt).toBe(now + 20 * 60_000);
  });

  it("a qualification BROKEN during the period shows when and why (admin only)", async () => {
    const now = utc(2026, 10, 7, 15, 0, 0);
    await seedEligibleMember(db, { id: 9001 });
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 1) });
    await observeSteady(db, 9001, utc(2026, 10, 1), utc(2026, 10, 7, 13, 30), chainTokens(10_250_000));
    await observeSteady(db, 9001, utc(2026, 10, 7, 14, 0), now - 5 * 60_000, 0n);
    await db.query("insert into public.arena_holder_status (telegram_user_id, wallet_address, verified_balance_raw, balance_verified_at, next_check_at) values (9001, $1, 0, $2::timestamptz, $2::timestamptz)", [walletFor(9001), new Date(now - 5 * 60_000).toISOString()]);
    const h = await holderOverview(db, { settings: settingsWith(), tokenDecimals: DECIMALS, nowMs: now });
    expect(h.accounts[0]!.daily).toMatchObject({ status: "BROKEN", tier: "10M", brokenAt: utc(2026, 10, 7, 14, 0), brokenBy: "BELOW_THRESHOLD" });
  });
});

describe("admin: lists and analytics", () => {
  it("recent battles show picks, the winner, the correct pickers, how many counted toward the boards — and NO token amount", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 4);
    await finishBattle(db, s);
    await settle(db, s);
    const [row] = await listRecentBattles(db, 10);
    expect(row).toMatchObject({ status: "SCORED", picks_total: 4, correct_pickers: 4, valid_picks: 4, lifetime_points: 40 });
    for (const gone of ["pool", "share", "distributed", "returned_to_reserve"]) expect(row).not.toHaveProperty(gone);
  });

  it("claims, review queue and account analytics expose what an operator needs — and never decide anything automatically", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }]);
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5));
    await requestClaim(db, { now: () => new Date(), allowDemo: true }, { userId: 9001, idempotencyKey: "admin-test-claim-2", destination: { kind: "CUSTOM", address: WALLET_A }, settings: DEFAULT_SETTINGS, target: targetFor(newChain()) });
    const accounts = await listAccounts(db, 10);
    expect(accounts.length).toBe(0); // account analytics list members who made real picks; this fixture only has scored rows
    expect((await listClaims(db, { limit: 10 }))[0]).toMatchObject({ status: "PENDING", amount: "150,000", telegram_user_id: 9001, destination_kind: "CUSTOM", review_state: "NORMAL" });
    expect((await listReview(db)).held).toEqual([]);
    await setReviewState(db, 9001, "REVIEW", "manual look", "admin");
    expect((await listReview(db)).held[0]).toMatchObject({ telegram_user_id: 9001, review_state: "REVIEW", review_reason: "manual look", claimable: "0" });
  });

  it("the review queue lists prizes HELD for review (with their bonus) so an operator can release or forfeit them", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }]);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state) values (9001, 'SUSPENDED') on conflict (telegram_user_id) do update set review_state = 'SUSPENDED'");
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5));
    const held = (await listReview(db)).heldPrizes;
    expect(held[0]).toMatchObject({ kind: "DAILY", period_start: "2026-10-07", telegram_user_id: 9001, rank: 1, prize: "150,000", bonus: "0", hold_reason: "SUSPENDED" });
  });

  it("review states are audited, need a reason when holding, and can be cleared", async () => {
    const u = await seedEligibleMember(db);
    await expect(setReviewState(db, u, "SUSPENDED", "", "admin")).rejects.toMatchObject({ code: "REASON_REQUIRED" });
    await expect(setReviewState(db, 999_999_999, "REVIEW", "unknown member", "admin")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await setReviewState(db, u, "SUSPENDED", "fraud ring", "admin");
    await setReviewState(db, u, "NORMAL", "", "admin");
    expect((await db.query<{ review_state: string; review_reason: string | null }>("select review_state, review_reason from public.arena_reward_accounts where telegram_user_id = $1", [u]))[0]).toEqual({ review_state: "NORMAL", review_reason: null });
    expect((await db.query<{ detail: { state: string } }>("select detail from public.admin_audit_log where action = 'rewards.review_state' order by id")).map((r) => r.detail.state)).toEqual(["SUSPENDED", "NORMAL"]);
  });
});

describe("reconciliation catches corrupted books", () => {
  it("a healthy ledger reconciles to an empty list; deliberate corruption is reported as critical", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }, { user: 9002, day: "2026-10-07", picks: 20, correct: 10 }]);
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5));
    const ctx = { now: new Date() };
    expect(await reconcileRewards(db, ctx)).toEqual([]);

    // Someone with raw database access bypasses every guard and edits a balance.
    await db.exec("alter table public.arena_reward_accounts disable trigger arena_reward_accounts_guard");
    await db.exec("alter table public.arena_reward_accounts disable trigger user");
    await db.query("update public.arena_reward_accounts set claimable = claimable - 1, earned_total = earned_total - 1 where telegram_user_id = 9001");
    await db.exec("alter table public.arena_reward_accounts enable trigger user");
    await db.exec("alter table public.arena_reward_accounts enable trigger arena_reward_accounts_guard");
    const issues = await reconcileRewards(db, ctx);
    expect(issues.some((i) => i.severity === "critical" && i.type === "ACCOUNT_LEDGER_MISMATCH")).toBe(true);
  });

  it("notices a board whose credited prizes no longer match the ledger (base and bonus checked separately)", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }]);
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5));
    // A rogue statement removes the base credit's effect on the ledger sum by adding an offsetting admin adjustment-free path: simulate by editing the result row past its guard.
    await db.exec("alter table public.arena_leaderboard_results disable trigger arena_leaderboard_results_guard");
    await db.query("update public.arena_leaderboard_results set base_prize_micro = base_prize_micro - 1 where telegram_user_id = 9001");
    await db.exec("alter table public.arena_leaderboard_results enable trigger arena_leaderboard_results_guard");
    const types = (await reconcileRewards(db, { now: new Date() })).map((i) => i.type);
    expect(types).toEqual(expect.arrayContaining(["BOARD_PRIZE_LEDGER_MISMATCH", "BOARD_PRIZE_TOTAL_MISMATCH"]));
  });

  it("a finalized board carries NO token decimals at all: it is logical, so there is no 'decimals mismatch' to flag whatever the token turns out to use", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 12 }]);
    const { finalizePeriod } = await import("@/server/rewards/leaderboard");
    await finalizePeriod(db, { now: () => new Date(utc(2026, 10, 8, 0, 0, 5)), settings: settingsWith(), reader: null }, "DAILY", "2026-10-07");
    expect((await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'arena_leaderboards' and column_name like '%decimals%'")).length).toBe(0);
    expect((await reconcileRewards(db, { now: new Date() })).map((i) => i.type)).not.toContain("DECIMALS_MISMATCH");
  });

  it("flags a holder bonus still pending verification after its window", async () => {
    await seedScores(db, [{ user: 9001, day: "2026-10-07", picks: 20, correct: 20 }]);
    await bindWallet(db, 9001, { verifiedAtMs: utc(2026, 10, 5) });
    await observeSteady(db, 9001, utc(2026, 10, 5), utc(2026, 10, 7, 23, 30), chainTokens(10_250_000));
    await finalize(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 0, 0, 5), { reader: null });
    expect((await db.query<{ bonus_status: string }>("select bonus_status from public.arena_leaderboard_results"))[0]!.bonus_status).toBe("PENDING_VERIFICATION");
    const types = (await reconcileRewards(db, { now: new Date(utc(2026, 10, 12)) })).map((i) => i.type);
    expect(types).toContain("BONUS_PENDING_PAST_WINDOW");
  });
});
