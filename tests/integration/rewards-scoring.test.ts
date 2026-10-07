import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { createTestDb, resetDb, seedEligibleMember } from "../support/db";
import { getPickStats } from "@/server/rewards/summary";
import { postRewardLedger } from "@/server/rewards/ledger";
import { resetRewardsReadyCache } from "@/server/rewards/pool";
import { settleDueRewards, settleBattleRewards } from "@/server/rewards/settlement";
import type { Db } from "@/server/db/types";
import { arenaAdmin } from "@/server/services/admin";
import { getLiveBoard } from "@/server/rewards/leaderboard";

import { balanceOf, ledgerCount, loser, pickAs, pickers, seedScores, settingsWith, settle, stageAfterJump, stageNext, tokens } from "../support/rewards";
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
  resetRewardsReadyCache();
});

const scoreRows = (userId: number) =>
  db.query<{ correct: boolean; points: number; utc_date: string }>("select correct, points, utc_date::text from public.arena_pick_scores where telegram_user_id = $1 order by id", [userId]);
const lifetimePoints = async (userId: number) => Number((await db.query<{ n: number }>("select coalesce(sum(points), 0)::int as n from public.arena_points_ledger where telegram_user_id = $1", [userId]))[0]!.n);

describe("a correct Arena Pick produces POINTS — never tokens", () => {
  it("a correct pick earns +10 leaderboard points and +10 lifetime Clank Points; a wrong pick earns 0; NO token is credited to anyone", async () => {
    const s = await stageBattle(db);
    const [right] = await pickers(db, s, s.winnerId, 1);
    const [wrong] = await pickers(db, s, loser(s), 1);
    await finishBattle(db, s);
    expect(await settle(db, s)).toMatchObject({ status: "SETTLED", result: "SCORED", picks: 2, correctPickers: 1, pointsAwarded: 10, validPicks: 2 });

    expect(await scoreRows(right!)).toMatchObject([{ correct: true, points: 10 }]);
    expect(await scoreRows(wrong!)).toMatchObject([{ correct: false, points: 0 }]); // a wrong pick still COUNTS (accuracy) — it just earns nothing
    expect(await lifetimePoints(right!)).toBe(10);
    expect(await lifetimePoints(wrong!)).toBe(0);

    // NOT ONE token: no ledger row, no balance, for the right or the wrong picker.
    expect(await ledgerCount(db)).toBe(0);
    expect(await balanceOf(db, right!)).toEqual({ claimable: 0n, reserved: 0n, claimed: 0n, earned: 0n });
    expect(await db.query("select 1 from public.arena_reward_accounts where claimable <> 0 or earned_total <> 0")).toHaveLength(0);
  });

  it("the battle's settlement is a scoring anchor only: SCORED, with counts and no token field at all", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 3);
    await pickers(db, s, loser(s), 2);
    await finishBattle(db, s);
    await settle(db, s);
    const [row] = await db.query<Record<string, unknown>>("select * from public.arena_pick_settlements");
    expect(row).toMatchObject({ status: "SCORED", picks_total: 5, correct_picks: 3, correct_pickers: 3, valid_picks: 5, points_awarded: 30 });
    for (const gone of ["reward_pool_raw", "share_raw", "distributed_raw", "returned_to_reserve_micro", "rewarded_pickers", "token_decimals", "scored_picks", "scored_points", "leaderboard_points"]) expect(row).not.toHaveProperty(gone);
    expect(await db.query("select to_regclass('public.arena_pick_outcomes') as t")).toEqual([{ t: null }]); // the per-battle outcome table is gone
  });

  it("the DATABASE refuses a per-battle credit even if the application tried one (the ledger has no such kind)", async () => {
    const u = await seedEligibleMember(db);
    await expect(db.query("insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, idempotency_key) values ($1, 'ARENA_PICK_REWARD', 10000, 10000, 'forged-per-battle-credit')", [u])).rejects.toThrow();
    await expect(postRewardLedger(db, { userId: u, kind: "ARENA_PICK_REWARD" as never, claimableDelta: tokens(10_000), earnedDelta: tokens(10_000), idempotencyKey: "forged-per-battle-credit-2" })).rejects.toThrow();
    expect(await ledgerCount(db)).toBe(0);
  });
});

describe("newly eligible members appear on both Arena Picks boards", () => {
  it("a member at exactly 50 qualifying messages can score on the daily and weekly boards", async () => {
    const s = await stageBattle(db);
    const userId = await seedEligibleMember(db, { qualifying: 50 });
    expect((await pickAs(db, s, userId, s.winnerId)).ok).toBe(true);
    await finishBattle(db, s);
    await settle(db, s);

    for (const kind of ["DAILY", "WEEKLY"] as const) {
      const { board, me } = await getLiveBoard(db, {
        kind,
        nowMs: s.clock.ms,
        settings: DEFAULT_SETTINGS,
        viewerId: userId,
      });
      expect(board.participants).toBe(1);
      expect(board.rows).toHaveLength(1);
      expect(me).toMatchObject({ picks: 1, correctPicks: 1, points: 10, prizeEligible: false }); // one pick is far below the minimum, but the member is ON the board
    }
  });
});

describe("Arena Picks are UNLIMITED and EVERY valid pick scores — there is no daily cap", () => {
  const picksAcrossBattles = async (u: number, n: number, firstStage?: Awaited<ReturnType<typeof stageBattle>>, plan: (i: number) => "win" | "lose" = () => "win") => {
    let s = firstStage ?? (await stageBattle(db));
    const points: number[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) s = await stageNext(db, s);
      expect((await pickAs(db, s, u, plan(i) === "win" ? s.winnerId : loser(s))).ok).toBe(true);
      await finishBattle(db, s);
      await settleBattleRewards(db, { now: s.clock.now, settings: settingsWith() }, s.battleId);
      points.push((await scoreRows(u)).at(-1)!.points);
    }
    return { s, points };
  };

  it("pick #1, #20, #21 and #100 of the same UTC day ALL earn +10 (and a member can pick in every single battle)", async () => {
    const u = await seedEligibleMember(db);
    const { points } = await picksAcrossBattles(u, 100);
    expect(points).toHaveLength(100);
    for (const n of [1, 20, 21, 100]) expect(points[n - 1], `pick #${n}`).toBe(10);
    expect(points.every((p) => p === 10)).toBe(true);
    const rows = await scoreRows(u);
    expect(rows).toHaveLength(100);
    expect(rows.reduce((a, r) => a + r.points, 0)).toBe(1000); // 100 correct picks → 1,000 leaderboard points, not 200
    expect(await lifetimePoints(u)).toBe(1000);
    expect(await getPickStats(db, u)).toMatchObject({ totalPicks: 100, correctPicks: 100, accuracy: 100, currentStreak: 100, bestStreak: 100 });
    expect(await db.query("select 1 from public.arena_picks where telegram_user_id = $1", [u])).toHaveLength(100);
  }, 180_000);

  it("a WRONG pick earns 0 wherever it falls, but it still counts: accuracy drops and the streak breaks", async () => {
    const u = await seedEligibleMember(db);
    const plan: Array<"win" | "lose"> = ["win", "win", "lose", "win", "lose", "lose", "win"];
    const { points } = await picksAcrossBattles(u, plan.length, undefined, (i) => plan[i]!);
    expect(points).toEqual([10, 10, 0, 10, 0, 0, 10]);
    expect(await getPickStats(db, u)).toMatchObject({ totalPicks: 7, correctPicks: 4, currentStreak: 1, bestStreak: 2 });
    expect((await scoreRows(u)).map((r) => r.correct)).toEqual([true, true, false, true, false, false, true]); // 7 rows: every valid pick is one row
  });

  it("the board counts every one of them: Picks / Correct / Accuracy / Points for the day and the week, to the decimal", async () => {
    // 52 picks, 31 correct → 59.6 % accuracy (31/52), 310 Points — nothing beyond a "20th pick" is dropped.
    await seedScores(db, [{ user: 7200, day: "2026-10-06", picks: 52, correct: 31 }]);
    for (const kind of ["DAILY", "WEEKLY"] as const) {
      const { me } = await getLiveBoard(db, { kind, nowMs: Date.parse("2026-10-06T23:00:00Z"), settings: DEFAULT_SETTINGS, viewerId: 7200 });
      expect(me, kind).toMatchObject({ picks: 52, correctPicks: 31, accuracy: 59.6, points: 310, rank: 1 });
    }
  });

  it("the daily allowance no longer exists, so each row records its own UTC day and every one scores; 00:00 UTC starts a fresh Daily board (and Monday 00:00 UTC a fresh Weekly one)", async () => {
    let s = await stageBattle(db); // 2026-10-04 12:00Z
    const u = await seedEligibleMember(db);
    for (let i = 0; i < 2; i++) {
      if (i > 0) s = await stageNext(db, s);
      await pickAs(db, s, u, s.winnerId);
      await finishBattle(db, s);
      await settle(db, s);
    }
    s = await stageAfterJump(db, s, 13 * 3_600_000); // → 2026-10-05 01:00Z
    await pickAs(db, s, u, s.winnerId);
    await finishBattle(db, s);
    await settle(db, s);
    const rows = await scoreRows(u);
    expect(rows.map((r) => [r.utc_date, r.points])).toEqual([["2026-10-04", 10], ["2026-10-04", 10], ["2026-10-05", 10]]);
    const day = (nowMs: number, kind: "DAILY" | "WEEKLY") => getLiveBoard(db, { kind, nowMs, settings: DEFAULT_SETTINGS, viewerId: u });
    expect((await day(Date.parse("2026-10-04T23:00:00Z"), "DAILY")).me).toMatchObject({ picks: 2, points: 20 });
    expect((await day(Date.parse("2026-10-05T23:00:00Z"), "DAILY")).me).toMatchObject({ picks: 1, points: 10 });
    // 2026-10-04 is a Sunday: the first two picks belong to the week of Sep 28, the third opens the week of Oct 5.
    expect((await day(Date.parse("2026-10-04T23:00:00Z"), "WEEKLY")).me).toMatchObject({ picks: 2, points: 20 });
    expect((await day(Date.parse("2026-10-05T23:00:00Z"), "WEEKLY")).me).toMatchObject({ picks: 1, points: 10 });
  });

  it("the database stores any number of picks per member per day (130 on one day), and the counting columns of the old cap are gone", async () => {
    await seedScores(db, [{ user: 7001, day: "2026-10-06", picks: 130, correct: 77 }]);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.arena_pick_scores where telegram_user_id = 7001 and utc_date = '2026-10-06'"))[0]!.n)).toBe(130);
    expect(Number((await db.query<{ n: number }>("select coalesce(sum(points), 0)::int as n from public.arena_pick_scores where telegram_user_id = 7001"))[0]!.n)).toBe(770);
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'arena_pick_scores'")).map((c) => c.column_name);
    for (const gone of ["scored", "scored_index", "daily_limit"]) expect(columns).not.toContain(gone);
  });

  it("the database still refuses points on a wrong pick and a second row for the same member and battle", async () => {
    await seedScores(db, [{ user: 7002, day: "2026-10-06", picks: 2, correct: 1 }]);
    const [row] = await db.query<{ battle_id: string; settlement_id: string }>("select battle_id, settlement_id from public.arena_pick_scores where telegram_user_id = 7002 order by id limit 1");
    await expect(db.query("insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points) values (7002, $1, $2, '2026-10-05', '2026-10-06', true, 10)", [row!.battle_id, row!.settlement_id])).rejects.toThrow(/duplicate|unique/i);
    await expect(db.query("insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points) values (7002, (select id from public.arena_battles order by starts_at desc limit 1), $1, '2026-10-05', '2026-10-06', false, 10)", [row!.settlement_id])).rejects.toThrow();
  });
});

describe("scoring is exactly-once and tolerant", () => {
  it("settling the same battle twice (or concurrently) scores it once", async () => {
    const s = await stageBattle(db);
    const [u] = await pickers(db, s, s.winnerId, 1);
    await finishBattle(db, s);
    const [a, b] = await Promise.all([settle(db, s), settle(db, s)]);
    expect([a.status, b.status].sort()).toEqual(["NOOP", "SETTLED"]);
    expect(await settle(db, s)).toEqual({ status: "NOOP" });
    expect(await scoreRows(u!)).toHaveLength(1);
    expect(await lifetimePoints(u!)).toBe(10);
  });

  it("the sweep scores every finished battle with eligible picks, once, and is a no-op when idle", async () => {
    let s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 2);
    await finishBattle(db, s);
    s = await stageNext(db, s);
    await pickers(db, s, s.winnerId, 1);
    await finishBattle(db, s);
    const ctx = { now: s.clock.now };
    expect(await settleDueRewards(db, ctx)).toEqual({ settled: 2, failed: 0 });
    expect(await settleDueRewards(db, ctx)).toEqual({ settled: 0, failed: 0 });
  });

  it("a VOID battle scores nothing: the picks are void, no points, no score rows", async () => {
    const s = await stageBattle(db);
    const [u] = await pickers(db, s, s.winnerId, 1);
    await arenaAdmin(db, "void_unsettled", "test");
    const r = await settle(db, s);
    expect(r).toMatchObject({ status: "SETTLED", result: "VOID", correctPickers: 0, validPicks: 0, pointsAwarded: 0 });
    expect(await scoreRows(u!)).toHaveLength(0);
    expect(await lifetimePoints(u!)).toBe(0);
    expect((await db.query<{ status: string }>("select status from public.arena_pick_settlements"))[0]!.status).toBe("VOID");
  });

  it("a battle that is not over is not scored yet", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 1);
    expect(await settle(db, s)).toEqual({ status: "NOT_READY" });
  });

  it("a pick that was NOT reward-eligible when picks locked never scores — and an eligible pick next to it still does", async () => {
    const s = await stageBattle(db);
    const [ineligible, eligible] = await pickers(db, s, s.winnerId, 2);
    // Eligibility is snapshotted on the pick up to the lock (before the lock it may still change; after it, the database freezes it).
    await db.query("update public.arena_picks set reward_eligible = false where telegram_user_id = $1", [ineligible]);
    await finishBattle(db, s);
    await settle(db, s);
    expect(await scoreRows(ineligible!)).toHaveLength(0);
    expect(await lifetimePoints(ineligible!)).toBe(0);
    expect(await scoreRows(eligible!)).toHaveLength(1);
  });
});

describe("scoring settings are data (one source)", () => {
  it("Points per correct pick is configurable: 25 → +25 on the board and +25 lifetime", async () => {
    const s = await stageBattle(db);
    const [u] = await pickers(db, s, s.winnerId, 1);
    await finishBattle(db, s);
    await settleBattleRewards(db, { now: s.clock.now, settings: settingsWith({ pointsPerCorrectPick: 25 }) }, s.battleId);
    expect((await scoreRows(u!))[0]!.points).toBe(25);
    expect(await lifetimePoints(u!)).toBe(25);
  });
  it("the defaults: 10 points per correct pick, minimum 20 picks for a Daily prize and 100 for a Weekly prize — and no per-day cap setting exists", () => {
    expect([DEFAULT_SETTINGS.arena_picks.pointsPerCorrectPick, DEFAULT_SETTINGS.arena_picks.dailyMinimumPicks, DEFAULT_SETTINGS.arena_picks.weeklyMinimumPicks]).toEqual([10, 20, 100]);
    for (const gone of ["scoredPicksPerDay", "weeklyScoredPicksPerDay", "dailyMinimumScoredPicks", "weeklyMinimumScoredPicks"]) expect(DEFAULT_SETTINGS.arena_picks).not.toHaveProperty(gone);
  });
  it("a full day of play scores EVERYTHING: 25 correct picks in a UTC day → 25 counted picks, 250 points (not 200)", async () => {
    await seedScores(db, [{ user: 7100, day: "2026-10-06", picks: 25, correct: 25 }]);
    const rows = await db.query<{ points: number }>("select points from public.arena_pick_scores where telegram_user_id = 7100");
    expect(rows).toHaveLength(25);
    expect(rows.reduce((a, r) => a + r.points, 0)).toBe(250);
  });
});

describe("scoring uses the AUTHORITATIVE result only and survives crashes", () => {
  it("a battle with no picks at all creates no settlement and nothing is owed", async () => {
    const s = await stageBattle(db);
    await finishBattle(db, s);
    expect(await settleDueRewards(db, { now: s.clock.now, settings: settingsWith() })).toEqual({ settled: 0, failed: 0 });
    expect(await db.query("select 1 from public.arena_pick_settlements")).toHaveLength(0);
  });

  it("the winner is the one recorded on the BATTLE — a tampered pick `result` cannot make a wrong picker score", async () => {
    const s = await stageBattle(db);
    const [right] = await pickers(db, s, s.winnerId, 1);
    const [wrong] = await pickers(db, s, loser(s), 1);
    await finishBattle(db, s);
    // Corrupt the resolved pick rows (bypassing the freeze guard): scoring must not look at them.
    await db.exec("alter table public.arena_picks disable trigger arena_picks_guard");
    await db.query("update public.arena_picks set result = 'CORRECT' where telegram_user_id = $1", [wrong]);
    await db.query("update public.arena_picks set result = 'INCORRECT' where telegram_user_id = $1", [right]);
    await db.exec("alter table public.arena_picks enable trigger arena_picks_guard");
    await settle(db, s);
    expect((await scoreRows(right!))[0]).toMatchObject({ correct: true, points: 10 });
    expect((await scoreRows(wrong!))[0]).toMatchObject({ correct: false, points: 0 });
  });

  it("a crash half-way (rolled back) leaves nothing, and the retry scores each pick exactly once", async () => {
    const s = await stageBattle(db);
    const right = await pickers(db, s, s.winnerId, 4);
    await finishBattle(db, s);
    let writes = 0;
    const flaky: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({ ...tx, query: (text: string, params?: readonly unknown[]) => (/insert into public\.arena_pick_scores/i.test(text) && ++writes === 3 ? Promise.reject(new Error("simulated crash")) : tx.query(text, params)), exec: tx.exec } as never),
        ),
    };
    const errors: unknown[] = [];
    expect(await settleDueRewards(flaky, { now: s.clock.now, settings: settingsWith() }, (_id, e) => errors.push(e))).toEqual({ settled: 0, failed: 1 });
    expect(errors).toHaveLength(1);
    expect(await db.query("select 1 from public.arena_pick_settlements")).toHaveLength(0); // atomic: no settlement row…
    expect(await db.query("select 1 from public.arena_pick_scores")).toHaveLength(0); // …no partial scores…
    expect(await db.query("select 1 from public.arena_points_ledger")).toHaveLength(0); // …no partial points
    expect(await settleDueRewards(db, { now: s.clock.now, settings: settingsWith() })).toEqual({ settled: 1, failed: 0 });
    for (const u of right) expect(await scoreRows(u)).toHaveLength(1);
    expect(await ledgerCount(db)).toBe(0);
  });

  it("the database refuses a second settlement for a battle and a second score row for the same member and battle", async () => {
    const s = await stageBattle(db);
    const [u] = await pickers(db, s, s.winnerId, 1);
    await finishBattle(db, s);
    await settle(db, s);
    await expect(db.query("insert into public.arena_pick_settlements (battle_id, status, picks_total, config) values ($1, 'SCORED', 0, '{}'::jsonb)", [s.battleId])).rejects.toThrow();
    const [row] = await db.query<{ settlement_id: string }>("select settlement_id from public.arena_pick_scores where telegram_user_id = $1", [u]);
    await expect(db.query("insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points) values ($1, $2, $3, '2026-09-28', '2026-10-04', true, 10)", [u, s.battleId, row!.settlement_id])).rejects.toThrow();
  });
});

describe("scoring never stalls or breaks the arena", () => {
  it("the arena keeps advancing and settling even when the scoring tables are gone entirely; the sweep fails QUIETLY and the arena carries on", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 2);
    await db.exec("alter table public.arena_pick_scores rename to zz_parked_scores");
    resetRewardsReadyCache();
    await finishBattle(db, s); // arena settles (its own transaction never touches the scoring tables)
    expect((await db.query<{ status: string }>("select status from public.arena_battles where id = $1", [s.battleId]))[0]!.status).toBe("SETTLED");
    expect(await settleDueRewards(db, { now: s.clock.now, settings: settingsWith() }, () => { throw new Error("must stay quiet"); })).toEqual({ settled: 0, failed: 0 });
    const next = await stageNext(db, s);
    expect(next.battleId).not.toBe(s.battleId);
    await db.exec("alter table public.zz_parked_scores rename to arena_pick_scores");
  });

  it("a failing scoring transaction is reported, not thrown — the sweep survives", async () => {
    const s = await stageBattle(db);
    await pickers(db, s, s.winnerId, 1);
    await finishBattle(db, s);
    const broken: Db = { ...db, transaction: () => Promise.reject(new Error("scoring database down")) };
    const errors: unknown[] = [];
    await expect(settleDueRewards(broken, { now: s.clock.now, settings: settingsWith() }, (_i, e) => errors.push(e))).resolves.toEqual({ settled: 0, failed: 1 });
    expect(errors[0]).toMatchObject({ message: "scoring database down" });
  });
});
