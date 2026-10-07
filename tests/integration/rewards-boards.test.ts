import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { reconcileRewards } from "@/server/rewards/admin";
import { findFinalizingPeriod, finalizeDueBoards, getFinalBoard, getLiveBoard, getMemberPeriodStats, listFinalizedPeriods, resolveHeldPrize } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import { getPointsSummary } from "@/server/rewards/summary-points";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDb, resetDb } from "../support/db";
import { allResults, balanceOf, finalize, ledgerCount, resultOf, seedScores, settingsWith, tokens, utc } from "../support/rewards";
import { pickers, settle } from "../support/rewards";
import { finishBattle, stageBattle } from "../support/stage";

void createPgliteDb;
void migrate;

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

const DAY = "2026-10-07";
const AFTER_DAY = utc(2026, 10, 8, 0, 0, 5); // five seconds after the Daily ended
const LADDER_DAILY = [30_000, 20_000, 15_000, 10_000, 8_000, 6_000, 4_000, 3_000, 2_000, 2_000];
const LADDER_WEEKLY = [150_000, 100_000, 75_000, 50_000, 40_000, 30_000, 20_000, 15_000, 10_000, 10_000];
const healthy = async () => {
  expect(await auditRewardAccounts(db)).toEqual([]);
  expect(await reconcileRewards(db, { now: new Date() })).toEqual([]);
};

/** Members 9001… with strictly decreasing correct picks (each made `picks` valid picks that day — 20 is the Daily minimum). */
const ladderField = (n: number, day = DAY, picks = 20) => Array.from({ length: n }, (_, i) => ({ user: 9001 + i, day, picks, correct: picks - i }));

describe("DAILY ARENA PICKS — the Top 10 are paid from a fixed 100,000 pool", () => {
  it("twelve eligible players: #1–#10 receive 30,000 / 20,000 / 15,000 / 10,000 / 8,000 / 6,000 / 4,000 / 3,000 / 2,000 / 2,000; #11 and #12 receive nothing; the whole pool is awarded", async () => {
    await seedScores(db, ladderField(12));
    const r = await finalize(db, "DAILY", DAY, AFTER_DAY);
    expect(r).toMatchObject({ status: "FINALIZED", participants: 12, eligible: 12, credited: 10, held: 0, baseAwardedMicro: tokens(100_000), returnedMicro: 0n });
    for (let i = 0; i < 10; i++) {
      const row = await resultOf(db, "DAILY", DAY, 9001 + i);
      expect(row, `rank ${i + 1}`).toMatchObject({ rank: i + 1, prize_rank: i + 1, base_status: "CREDITED", base_prize_micro: tokens(LADDER_DAILY[i]!).toString(), bonus_status: "NONE" });
      expect((await balanceOf(db, 9001 + i)).claimable).toBe(tokens(LADDER_DAILY[i]!));
    }
    for (const u of [9011, 9012]) {
      expect(await resultOf(db, "DAILY", DAY, u)).toMatchObject({ base_status: "NONE", base_prize_micro: "0" });
      expect((await balanceOf(db, u)).earned).toBe(0n);
    }
    const [board] = await db.query<Record<string, unknown>>("select * from public.arena_leaderboards where kind = 'DAILY'");
    expect(board).toMatchObject({ prize_pool_micro: tokens(100_000).toString(), base_awarded_micro: tokens(100_000).toString(), returned_to_reserve_micro: "0", participants: 12, eligible_participants: 12 });
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_BASE_REWARD")).toBe(10);
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_HOLDER_BONUS")).toBe(0);
    await healthy();
  });

  it("the ladder lives in ONE setting: change it and the prizes change — nothing is hard-coded in the server", async () => {
    await seedScores(db, ladderField(3));
    await finalize(db, "DAILY", DAY, AFTER_DAY, { settings: settingsWith({ dailyPrizePool: "10000", prizeSplitBps: [5000, 3000, 2000] }) });
    expect((await allResults(db, "DAILY", DAY)).map((r) => r.base_prize_micro)).toEqual([tokens(5_000).toString(), tokens(3_000).toString(), tokens(2_000).toString()]);
  });

  it("fewer than ten eligible players: unfilled prizes return to the reserve (never rolled over to tomorrow)", async () => {
    await seedScores(db, ladderField(3));
    const r = await finalize(db, "DAILY", DAY, AFTER_DAY);
    expect(r).toMatchObject({ status: "FINALIZED", baseAwardedMicro: tokens(65_000), returnedMicro: tokens(35_000) });
    const [board] = await db.query<{ returned_to_reserve_micro: string }>("select returned_to_reserve_micro::text from public.arena_leaderboards");
    expect(board!.returned_to_reserve_micro).toBe(tokens(35_000).toString());
    await healthy();
  });

  it("MINIMUM PARTICIPATION (Daily = 20 picks): 19 picks, all correct (100% accuracy) stays on the board as NOT PRIZE ELIGIBLE and takes no prize position; exactly 20 is eligible", async () => {
    await seedScores(db, [
      { user: 9101, day: DAY, picks: 19, correct: 19 }, // 190 points, 100% — one pick below the 20-pick minimum
      { user: 9102, day: DAY, picks: 20, correct: 5 }, // 50 points — exactly at the minimum
      { user: 9103, day: DAY, picks: 24, correct: 4 },
    ]);
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    const gamer = await resultOf(db, "DAILY", DAY, 9101);
    expect(gamer).toMatchObject({ rank: 1, prize_eligible: false, prize_rank: null, base_status: "NONE", base_prize_micro: "0" });
    expect(await resultOf(db, "DAILY", DAY, 9102)).toMatchObject({ rank: 2, prize_eligible: true, prize_rank: 1, base_prize_micro: tokens(30_000).toString() });
    expect(await resultOf(db, "DAILY", DAY, 9103)).toMatchObject({ prize_rank: 2, base_prize_micro: tokens(20_000).toString() });
    // The board still LISTS them (nobody is silently hidden).
    const final = await getFinalBoard(db, "DAILY", DAY, { nowMs: AFTER_DAY });
    expect(final!.board.rows.map((x) => [x.rank, x.prizeEligible])).toEqual([[1, false], [2, true], [3, true]]);
  });

  it("1 pick, 1 correct, 100% accuracy cannot win — it is not even eligible", async () => {
    await seedScores(db, [{ user: 9111, day: DAY, picks: 1, correct: 1 }, { user: 9112, day: DAY, picks: 20, correct: 3 }]);
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    expect(await resultOf(db, "DAILY", DAY, 9111)).toMatchObject({ prize_eligible: false, base_status: "NONE" });
    expect(await resultOf(db, "DAILY", DAY, 9112)).toMatchObject({ prize_rank: 1, base_prize_micro: tokens(30_000).toString() });
  });

  it("EXACT TIE: two players tied for #2 share positions 2+3 — 17,500 each — and the next player takes #4 (10,000); the tie size is recorded", async () => {
    await seedScores(db, [
      { user: 9201, day: DAY, picks: 20, correct: 18 },
      { user: 9202, day: DAY, picks: 20, correct: 15 },
      { user: 9203, day: DAY, picks: 20, correct: 15 },
      { user: 9204, day: DAY, picks: 20, correct: 12 },
      { user: 9205, day: DAY, picks: 20, correct: 11 },
    ]);
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    const prizes = Object.fromEntries((await allResults(db, "DAILY", DAY)).map((r) => [r.telegram_user_id, BigInt(r.base_prize_micro)]));
    expect(prizes).toEqual({ 9201: tokens(30_000), 9202: tokens(17_500), 9203: tokens(17_500), 9204: tokens(10_000), 9205: tokens(8_000) });
    expect(await resultOf(db, "DAILY", DAY, 9202)).toMatchObject({ rank: 2, tie_size: 2, prize_rank: 2 });
    expect(await resultOf(db, "DAILY", DAY, 9204)).toMatchObject({ rank: 4, tie_size: 1, prize_rank: 4 });
    await healthy();
  });

  it("ties never look at anything but correct picks and accuracy: equal correct picks (equal Points) → the higher ACCURACY across ALL picks ranks first", async () => {
    await seedScores(db, [
      { user: 9301, day: DAY, picks: 30, correct: 15 }, // 150 pts, 50%
      { user: 9302, day: DAY, picks: 20, correct: 15 }, // 150 pts, 75%
    ]);
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    expect(await resultOf(db, "DAILY", DAY, 9302)).toMatchObject({ rank: 1, tie_size: 1, base_prize_micro: tokens(30_000).toString() });
    expect(await resultOf(db, "DAILY", DAY, 9301)).toMatchObject({ rank: 2, base_prize_micro: tokens(20_000).toString() });
  });

  it("a tie at the prize boundary is split evenly with a deterministic integer remainder that returns to the reserve (nothing is lost or invented)", async () => {
    // Three exactly tied for #1 share 30,000 + 20,000 + 15,000 = 65,000 → 21,666.666… each.
    await seedScores(db, [9401, 9402, 9403].map((user) => ({ user, day: DAY, picks: 20, correct: 17 })));
    const r = await finalize(db, "DAILY", DAY, AFTER_DAY);
    const each = (tokens(65_000) / 3n);
    expect((await allResults(db, "DAILY", DAY)).map((x) => BigInt(x.base_prize_micro))).toEqual([each, each, each]);
    expect(r.status === "FINALIZED" && r.baseAwardedMicro + r.returnedMicro).toBe(tokens(100_000));
    await healthy();
  });
});

describe("finalization is exact, idempotent and immutable", () => {
  it("a day cannot be finalized before it ends — and can the instant it does", async () => {
    await seedScores(db, ladderField(2));
    expect(await finalize(db, "DAILY", DAY, utc(2026, 10, 7, 23, 59, 59))).toEqual({ status: "NOT_ENDED", kind: "DAILY", start: DAY });
    expect(await db.query("select 1 from public.arena_leaderboards")).toHaveLength(0);
    expect(await finalize(db, "DAILY", DAY, utc(2026, 10, 8, 0, 0, 0))).toMatchObject({ status: "FINALIZED" });
  });

  it("re-running finalization (or running it concurrently) never double-credits: ONE board, ONE ledger entry per winner", async () => {
    await seedScores(db, ladderField(4));
    const [a, b, c] = await Promise.all([finalize(db, "DAILY", DAY, AFTER_DAY), finalize(db, "DAILY", DAY, AFTER_DAY), finalize(db, "DAILY", DAY, AFTER_DAY)]);
    expect([a, b, c].filter((r) => r.status === "FINALIZED")).toHaveLength(1);
    expect(await finalize(db, "DAILY", DAY, AFTER_DAY)).toEqual({ status: "ALREADY_FINALIZED", kind: "DAILY", start: DAY });
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_BASE_REWARD")).toBe(4);
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(30_000));
    await healthy();
  });

  it("a finalized period is FROZEN: its rows, scores and prizes cannot be edited or deleted — only an explicit audited resolution may change a held prize", async () => {
    await seedScores(db, ladderField(3));
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    await expect(db.query("update public.arena_leaderboards set prize_pool_micro = 1")).rejects.toThrow();
    await expect(db.query("delete from public.arena_leaderboards")).rejects.toThrow();
    await expect(db.query("update public.arena_leaderboard_results set base_prize_micro = base_prize_micro * 2 where telegram_user_id = 9003")).rejects.toThrow(/frozen|constraint/i);
    await expect(db.query("update public.arena_leaderboard_results set points = 999 where telegram_user_id = 9003")).rejects.toThrow(/frozen/i);
    await expect(db.query("update public.arena_leaderboard_results set base_status = 'FORFEITED' where telegram_user_id = 9003")).rejects.toThrow(/illegal prize transition/i);
    await expect(db.query("delete from public.arena_leaderboard_results")).rejects.toThrow();
    await expect(db.query("update public.arena_pick_scores set points = 0")).rejects.toThrow();
  });

  it("a very late pick of a FINALIZED day can never change the board: the database refuses ANY score row for a frozen day or week (correct or not)", async () => {
    await seedScores(db, ladderField(2));
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    const [s] = await db.query<{ id: string }>("select id from public.arena_pick_settlements limit 1");
    const [b] = await db.query<{ id: string }>("insert into public.arena_battles (season_id, cycle_id, status, starts_at) select (select id from public.seasons limit 1), (select id from public.arena_cycles limit 1), 'VOID', now() returning id");
    const insert = (correct: boolean) =>
      db.query("insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points) values (9001, $1, $2, '2026-10-05', $3, $4, $5)", [b!.id, s!.id, DAY, correct, correct ? 10 : 0]);
    await expect(insert(true)).rejects.toThrow(/finalized/i);
    await expect(insert(false)).rejects.toThrow(/finalized/i);
  });

  it("a period waits until every battle that settled in it has been scored (a late settlement can never change a frozen board)", async () => {
    const s = await stageBattle(db); // 2026-10-04
    await pickers(db, s, s.winnerId, 12);
    await finishBattle(db, s);
    const day = new Date(s.clock.ms).toISOString().slice(0, 10);
    const next = utc(2026, 10, 5, 0, 0, 5);
    expect(await finalize(db, "DAILY", day, next)).toMatchObject({ status: "WAITING_FOR_SETTLEMENT" });
    await settle(db, s);
    expect(await finalize(db, "DAILY", day, next)).toMatchObject({ status: "FINALIZED", participants: 12 });
  });

  it("PAUSED prizes (arena_picks.enabled = false): the board is still frozen and ranked, but a ZERO pool is frozen with it and nobody is paid", async () => {
    await seedScores(db, ladderField(3));
    await finalize(db, "DAILY", DAY, AFTER_DAY, { settings: settingsWith({ enabled: false }) });
    expect((await db.query<{ prize_pool_micro: string }>("select prize_pool_micro::text from public.arena_leaderboards"))[0]!.prize_pool_micro).toBe("0");
    expect((await allResults(db, "DAILY", DAY)).every((r) => r.base_status === "NONE")).toBe(true);
    expect(await ledgerCount(db)).toBe(0);
  });

  it("an account under REVIEW keeps its place but its prize is HELD; an admin releases it (credited) or forfeits it (returned) — audited, once", async () => {
    await seedScores(db, ladderField(3));
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values (9001, 'REVIEW', 'test') on conflict (telegram_user_id) do update set review_state = 'REVIEW'");
    await finalize(db, "DAILY", DAY, AFTER_DAY);
    expect(await resultOf(db, "DAILY", DAY, 9001)).toMatchObject({ rank: 1, base_status: "HELD", base_prize_micro: tokens(30_000).toString() });
    expect((await balanceOf(db, 9001)).earned).toBe(0n);
    expect(await resultOf(db, "DAILY", DAY, 9002)).toMatchObject({ rank: 2, base_prize_micro: tokens(20_000).toString() }); // nobody shifted up
    const clock = { now: () => new Date(AFTER_DAY) };
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9001, action: "release", reason: "reviewed — fine", actor: "admin" })).toMatchObject({ ok: true, status: "CREDITED", baseMicro: tokens(30_000) });
    expect((await balanceOf(db, 9001)).claimable).toBe(tokens(30_000));
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9001, action: "release", reason: "again", actor: "admin" })).toEqual({ ok: false, reason: "NOT_HELD" });
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9002, action: "forfeit", reason: "not held", actor: "admin" })).toEqual({ ok: false, reason: "NOT_HELD" });
    expect(await resolveHeldPrize(db, clock, { kind: "DAILY", start: DAY, userId: 9002, action: "forfeit", reason: "x", actor: "admin" })).toEqual({ ok: false, reason: "REASON_REQUIRED" }); // a reason is mandatory
    await healthy();
  });
});

describe("WEEKLY ARENA PICKS — Monday 00:00 UTC → Monday, a fixed 500,000 pool, the same ladder", () => {
  const WEEK = "2026-10-05";
  const AFTER_WEEK = utc(2026, 10, 12, 0, 0, 5);
  const DAYS = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"];
  // Three players over five days (20 picks a day = 100 for the week, the Weekly minimum): correct picks accumulate across every day.
  const specs = [
    ...DAYS.flatMap((day, i) => [
      { user: 9501, day, picks: 20, correct: 18 - i }, // 100 picks, 80 correct (18+17+16+15+14)
      { user: 9502, day, picks: 20, correct: 10 }, // 100 picks, 50 correct
      { user: 9503, day, picks: 20, correct: 5 }, // 100 picks, 25 correct
    ]),
    { user: 9504, day: "2026-10-05", picks: 20, correct: 20 }, // 100% — but only 20 picks: far below the weekly minimum of 100
  ];

  it("weekly points are the SUM of every counted pick of the UTC week; the Top 10 ladder is 150,000 / 100,000 / 75,000 …", async () => {
    await seedScores(db, specs);
    const r = await finalize(db, "WEEKLY", WEEK, AFTER_WEEK);
    expect(r).toMatchObject({ status: "FINALIZED", participants: 4, eligible: 3 });
    expect(await resultOf(db, "WEEKLY", WEEK, 9501)).toMatchObject({ rank: 1, points: 800, picks: 100, correct_picks: 80, prize_rank: 1, base_prize_micro: tokens(LADDER_WEEKLY[0]!).toString() });
    expect(await resultOf(db, "WEEKLY", WEEK, 9502)).toMatchObject({ points: 500, prize_rank: 2, base_prize_micro: tokens(LADDER_WEEKLY[1]!).toString() });
    expect(await resultOf(db, "WEEKLY", WEEK, 9503)).toMatchObject({ points: 250, prize_rank: 3, base_prize_micro: tokens(LADDER_WEEKLY[2]!).toString() });
    expect(await ledgerCount(db, "WEEKLY_LEADERBOARD_BASE_REWARD")).toBe(3);
    await healthy();
  });

  it("MINIMUM PARTICIPATION (Weekly = 100 picks): 99 picks stays on the board as NOT PRIZE ELIGIBLE, exactly 100 is eligible — and the 99-pick player never takes a prize position", async () => {
    await seedScores(db, [
      ...DAYS.slice(0, 4).map((day) => ({ user: 9511, day, picks: 25, correct: 24 })), // 100 picks, 96 correct
      ...DAYS.slice(0, 4).map((day, i) => ({ user: 9512, day, picks: i === 0 ? 24 : 25, correct: i === 0 ? 24 : 25 })), // 99 picks, 99 correct — more correct picks than anyone, one pick short
    ]);
    await finalize(db, "WEEKLY", WEEK, AFTER_WEEK);
    expect(await resultOf(db, "WEEKLY", WEEK, 9512)).toMatchObject({ rank: 1, picks: 99, correct_picks: 99, prize_eligible: false, prize_rank: null, base_status: "NONE", base_prize_micro: "0" });
    expect(await resultOf(db, "WEEKLY", WEEK, 9511)).toMatchObject({ rank: 2, picks: 100, prize_eligible: true, prize_rank: 1, base_prize_micro: tokens(LADDER_WEEKLY[0]!).toString() });
    const board = await getFinalBoard(db, "WEEKLY", WEEK, { nowMs: AFTER_WEEK });
    expect(board!.board.rows.map((x) => [x.rank, x.prizeEligible])).toEqual([[1, false], [2, true]]); // listed, never hidden
  });

  it("NOT YET PRIZE ELIGIBLE: 40 picks at 100% accuracy ranks above players with fewer correct picks but is under the weekly minimum of 100 — shown, never silently hidden, never paid", async () => {
    await seedScores(db, [...specs, { user: 9504, day: "2026-10-06", picks: 20, correct: 20 }]);
    await finalize(db, "WEEKLY", WEEK, AFTER_WEEK);
    const low = await resultOf(db, "WEEKLY", WEEK, 9504);
    expect(low).toMatchObject({ rank: 3, prize_eligible: false, base_status: "NONE", base_prize_micro: "0", picks: 40, correct_picks: 40, points: 400 });
    expect(await resultOf(db, "WEEKLY", WEEK, 9503)).toMatchObject({ rank: 4, prize_rank: 3 }); // the eligible player below keeps prize position #3: ineligible members never take one
    const board = await getFinalBoard(db, "WEEKLY", WEEK, { nowMs: AFTER_WEEK });
    expect(board!.board.rows.find((x) => x.points === 400)).toMatchObject({ prizeEligible: false });
  });

  it("a DAILY board and the WEEKLY board are independent: the same counted picks feed both, each is finalized and paid separately", async () => {
    await seedScores(db, specs);
    await finalize(db, "WEEKLY", WEEK, AFTER_WEEK);
    for (const day of DAYS) await finalize(db, "DAILY", day, AFTER_WEEK);
    // Daily boards: 10-05 has four players (9504 included — 20 picks is the Daily minimum).
    expect((await db.query<{ participants: number }>("select participants from public.arena_leaderboards where kind = 'DAILY' and period_start = '2026-10-05'"))[0]!.participants).toBe(4);
    // Daily prizes: Oct 5 has four eligible players, the other four days three each → 16 daily credits; the weekly board pays 3 more — all separate ledger rows.
    expect(await ledgerCount(db, "DAILY_LEADERBOARD_BASE_REWARD")).toBe(16);
    expect(await ledgerCount(db, "WEEKLY_LEADERBOARD_BASE_REWARD")).toBe(3);
    await healthy();
  });

  it("the weekly pool is its own setting (500,000), distinct from the daily one", async () => {
    await seedScores(db, specs);
    await finalize(db, "WEEKLY", WEEK, AFTER_WEEK);
    const [b] = await db.query<{ prize_pool_micro: string; kind: string }>("select kind, prize_pool_micro::text from public.arena_leaderboards");
    expect(b).toMatchObject({ kind: "WEEKLY", prize_pool_micro: tokens(500_000).toString() });
  });
});

describe("the sweep (tick / worker) finalizes ended days and weeks automatically, and only those", () => {
  it("at the boundary: the previous day is frozen, the running day is untouched, and a second sweep does nothing", async () => {
    await seedScores(db, [...ladderField(3, "2026-10-07"), ...ladderField(2, "2026-10-08")]);
    const ctx = { now: () => new Date(utc(2026, 10, 8, 12, 0, 0)), settings: settingsWith(), reader: null };
    const a = await finalizeDueBoards(db, ctx);
    expect(a).toMatchObject({ finalized: 1, failed: 0, periods: ["DAILY:2026-10-07"] });
    expect(await db.query("select 1 from public.arena_leaderboards where period_start = '2026-10-08'")).toHaveLength(0); // still running
    expect(await finalizeDueBoards(db, ctx)).toMatchObject({ finalized: 0, failed: 0 });
  });
  it("Monday 00:00:05: Sunday's day AND the week that just ended are both frozen", async () => {
    await seedScores(db, [{ user: 9601, day: "2026-10-11", picks: 20, correct: 10 }, { user: 9602, day: "2026-10-11", picks: 20, correct: 5 }]);
    const ctx = { now: () => new Date(utc(2026, 10, 12, 0, 0, 5)), settings: settingsWith({ weeklyMinimumPicks: 20 }), reader: null };
    const r = await finalizeDueBoards(db, ctx);
    expect(r.periods.sort()).toEqual(["DAILY:2026-10-11", "WEEKLY:2026-10-05"]);
  });
});

describe("reading the boards", () => {
  it("the LIVE board projects prizes from the current standings, carries my own standing (Picks · Correct · Accuracy · Points · Rank) and shows nothing private", async () => {
    await seedScores(db, [
      { user: 9701, day: DAY, picks: 22, correct: 14 },
      { user: 9702, day: DAY, picks: 20, correct: 10 },
      { user: 9703, day: DAY, picks: 6, correct: 6 },
    ]);
    const nowMs = utc(2026, 10, 7, 18, 0, 0);
    const { board, me } = await getLiveBoard(db, { kind: "DAILY", nowMs, settings: settingsWith(), viewerId: 9703 });
    expect(board).toMatchObject({ kind: "DAILY", state: "CURRENT", start: DAY, serverNow: nowMs, startsAt: utc(2026, 10, 7), endsAt: utc(2026, 10, 8), participants: 3, eligibleParticipants: 2 });
    expect(board.rules).toMatchObject({ prizePool: "100,000", topRewarded: 10, minimumPicks: 20, pointsPerCorrectPick: 10, prizesPaused: false });
    expect(board.rules).not.toHaveProperty("scoredPicksPerDay");
    expect(board.rules.prizes.slice(0, 3).map((p) => p.amount)).toEqual(["30,000", "20,000", "15,000"]);
    expect(board.rows.map((r) => [r.rank, r.points, r.picks, r.correctPicks, r.prizeEligible, r.basePrize])).toEqual([[1, 140, 22, 14, true, "30,000"], [2, 100, 20, 10, true, "20,000"], [3, 60, 6, 6, false, "0"]]);
    expect(board.rows.map((r) => r.accuracy)).toEqual([63.6, 50, 100]); // 14/22, 10/20, 6/6 — one decimal
    expect(me).toMatchObject({ rank: 3, points: 60, picks: 6, correctPicks: 6, accuracy: 100, prizeEligible: false, picksToEligible: 14 });
    expect(me).not.toHaveProperty("scoredToday");
    expect(me).not.toHaveProperty("scoredLimit");
    // Public rows never carry a Telegram id, wallet, balance or holder tier.
    expect(JSON.stringify(board)).not.toMatch(/telegram|wallet|balance|0x[0-9a-f]{40}/i);
    expect(board.rows.every((r) => r.holderTier === null && r.holderBonus === "0")).toBe(true);
  });

  it("the member's DAILY stats reset at the UTC boundary (17 picks yesterday → 0 the second the new day begins) while the WEEKLY stats keep adding up", async () => {
    await seedScores(db, [{ user: 9801, day: DAY, picks: 17, correct: 9 }]);
    const daily = (nowMs: number) => getMemberPeriodStats(db, 9801, settingsWith(), "DAILY", nowMs);
    const weekly = (nowMs: number) => getMemberPeriodStats(db, 9801, settingsWith(), "WEEKLY", nowMs);
    expect(await daily(utc(2026, 10, 7, 23, 59, 59))).toMatchObject({ start: DAY, picks: 17, correct: 9, accuracy: 52.9, points: 90, rank: 1, prizeEligible: false, picksToEligible: 3, minimumPicks: 20, endsAt: utc(2026, 10, 8) });
    expect(await daily(utc(2026, 10, 8, 0, 0, 0))).toMatchObject({ start: "2026-10-08", picks: 0, correct: 0, accuracy: null, points: 0, rank: null, picksToEligible: 20, endsAt: utc(2026, 10, 9) });
    expect(await weekly(utc(2026, 10, 8, 0, 0, 1))).toMatchObject({ start: "2026-10-05", picks: 17, correct: 9, points: 90, minimumPicks: 100, picksToEligible: 83 });
    const pts = await getPointsSummary(db, 9801, utc(2026, 10, 8, 0, 0, 1));
    expect(pts).toMatchObject({ dayStart: "2026-10-08", today: 0, weekly: 90, weekStart: "2026-10-05" });
  });

  it("history: finalized days list newest first, the just-ended one shows as FINALIZING until frozen, and a frozen board never changes afterwards", async () => {
    await seedScores(db, [...ladderField(3, "2026-10-06"), ...ladderField(3, "2026-10-07")]);
    const nowMs = utc(2026, 10, 8, 0, 0, 5);
    expect(await findFinalizingPeriod(db, "DAILY", nowMs)).toBe("2026-10-07");
    const live = await getLiveBoard(db, { kind: "DAILY", start: "2026-10-07", nowMs, settings: settingsWith() });
    expect(live.board.state).toBe("FINALIZING");
    await finalize(db, "DAILY", "2026-10-06", nowMs);
    await finalize(db, "DAILY", "2026-10-07", nowMs);
    expect(await findFinalizingPeriod(db, "DAILY", nowMs)).toBeNull();
    expect((await listFinalizedPeriods(db, "DAILY")).map((p) => p.start)).toEqual(["2026-10-07", "2026-10-06"]);
    const before = await getFinalBoard(db, "DAILY", "2026-10-06", { nowMs });
    expect(before!.board).toMatchObject({ state: "FINAL", participants: 3 });
    expect(before!.board.rows[0]).toMatchObject({ rank: 1, basePrize: "30,000", holderBonus: "0", totalReward: "30,000", bonusStatus: "NONE" });
    // Settings change later — the finished board still shows what it paid.
    const again = await getFinalBoard(db, "DAILY", "2026-10-06", { nowMs: nowMs + 86_400_000 });
    expect(again!.board.rows).toEqual(before!.board.rows);
    expect(await getFinalBoard(db, "DAILY", "2026-10-01", { nowMs })).toBeNull();
  });
});
