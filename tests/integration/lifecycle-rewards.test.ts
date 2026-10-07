import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { findFinalizingPeriod, finalizeDueBoards, getLiveBoard, listFinalizedPeriods, periodSeasonId } from "@/server/rewards/leaderboard";
import { getPointsSummary } from "@/server/rewards/summary-points";
import { loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { endSeason, getGameControl, launchSeason1 } from "@/server/services/lifecycle";

import { createTestDb, FakeClock, resetDb } from "../support/db";
import { activeSeason, adminDeps, freshDevelopment } from "../support/lifecycle";
import { balanceOf, finalize, ledgerCount, seedScores, settingsWith, utc } from "../support/rewards";

/**
 * ARENA PICKS ARE SEASON-AWARE. Development picks are test data: when Season 1 launches, the Daily and Weekly boards, the lifetime Points and the prizes begin
 * clean — the development rows stay in the tables (archive), but they never count, are never finalized, never paid.
 */
let db: Db;
let clock: FakeClock;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  await freshDevelopment(db);
  clock = new FakeClock();
});

const DAY = "2026-10-07"; // a Wednesday
const WEEK = "2026-10-05";
const END_OF_DAY = utc(2026, 10, 8, 0, 0, 5);
const END_OF_WEEK = utc(2026, 10, 12, 0, 0, 5);
const LAUNCH = { confirmation: "LAUNCH SEASON 1" };

const liveDaily = async (nowMs = END_OF_DAY - 60_000) => (await getLiveBoard(db, { kind: "DAILY", start: DAY, nowMs, settings: await loadSettings(db), limit: 50 })).board;
const liveWeekly = async (nowMs = END_OF_WEEK - 60_000) => (await getLiveBoard(db, { kind: "WEEKLY", start: WEEK, nowMs, settings: await loadSettings(db), limit: 50 })).board;

async function developmentPicks() {
  // three members played the DAY in the development run: 9001 (20 picks, 15 right), 9002 (20, 10), 9003 (20, 5)
  await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 15 }, { user: 9002, day: DAY, picks: 20, correct: 10 }, { user: 9003, day: DAY, picks: 20, correct: 5 }]);
}

describe("development picks never become Season 1 picks", () => {
  it("before the launch the development boards work as ever; after it Daily and Weekly begin clean — even on the same UTC day / week", async () => {
    await developmentPicks();
    const dev = (await activeSeason(db))!;
    expect((await liveDaily()).participants).toBe(3);
    expect((await liveWeekly()).participants).toBe(3);
    expect(await periodSeasonId(db, "DAILY", DAY)).toBe(dev.id);

    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const s1 = (await activeSeason(db))!;
    // the development scores are still there (archive) …
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.arena_pick_scores where season_id = $1", [dev.id]))[0]!.n).toBe(60);
    // … but the very same day / week now has nobody on it
    expect(await periodSeasonId(db, "DAILY", DAY)).toBeNull();
    expect((await liveDaily()).participants).toBe(0);
    expect((await liveDaily()).rows).toEqual([]);
    expect((await liveWeekly()).participants).toBe(0);

    // Season 1's picks on the same day: only they are ranked — member 9001 starts at 5 picks, not 25
    await seedScores(db, [{ user: 9001, day: DAY, picks: 5, correct: 3 }, { user: 9004, day: DAY, picks: 20, correct: 12 }], { seasonId: s1.id });
    expect(await periodSeasonId(db, "DAILY", DAY)).toBe(s1.id);
    const board = await liveDaily();
    expect(board.participants).toBe(2);
    expect(board.rows.map((r) => [r.rank, r.picks, r.correctPicks])).toEqual([[1, 20, 12], [2, 5, 3]]);
    expect((await liveWeekly()).rows.map((r) => [r.picks, r.correctPicks])).toEqual([[20, 12], [5, 3]]);
  });

  it("a period that holds only ARCHIVED development picks is never finalized and never paid; Season 1's period is, once, with its season recorded", async () => {
    await developmentPicks();
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const s1 = (await activeSeason(db))!;
    const settings = settingsWith({ enabled: true });

    // the sweep finds nothing to finalize and the direct call says so
    expect(await findFinalizingPeriod(db, "DAILY", END_OF_DAY)).toBeNull();
    expect((await finalizeDueBoards(db, { now: () => new Date(END_OF_DAY), settings, reader: null })).finalized).toBe(0);
    expect(await finalize(db, "DAILY", DAY, END_OF_DAY, { settings })).toMatchObject({ status: "NO_PARTICIPANTS" });
    expect(await db.query("select 1 from public.arena_leaderboards")).toEqual([]);
    expect(await ledgerCount(db)).toBe(0);
    for (const u of [9001, 9002, 9003]) expect((await balanceOf(db, u)).earned).toBe(0n);

    // Season 1 plays the same day: the board is finalized from ITS picks only
    await seedScores(db, [{ user: 9001, day: DAY, picks: 20, correct: 4 }, { user: 9004, day: DAY, picks: 20, correct: 12 }], { seasonId: s1.id });
    expect(await findFinalizingPeriod(db, "DAILY", END_OF_DAY)).toBe(DAY);
    const swept = await finalizeDueBoards(db, { now: () => new Date(END_OF_DAY), settings, reader: null });
    expect(swept.periods).toContain(`DAILY:${DAY}`);
    const [board] = await db.query<{ season_id: string; participants: number }>("select season_id, participants from public.arena_leaderboards where kind = 'DAILY' and period_start = $1::date", [DAY]);
    expect(board).toMatchObject({ season_id: s1.id, participants: 2 });
    const results = await db.query<{ telegram_user_id: number; picks: number; correct_picks: number; base_status: string }>("select telegram_user_id, picks, correct_picks, base_status from public.arena_leaderboard_results where kind = 'DAILY' order by rank");
    expect(results.map((r) => [Number(r.telegram_user_id), Number(r.picks), Number(r.correct_picks)])).toEqual([[9004, 20, 12], [9001, 20, 4]]);
    for (const u of [9002, 9003]) expect((await balanceOf(db, u)).earned).toBe(0n); // development players earned nothing from the archived run
    expect((await balanceOf(db, 9004)).earned).toBeGreaterThan(0n);
    expect((await listFinalizedPeriods(db, "DAILY")).map((p) => p.start)).toEqual([DAY]);
    // idempotent
    expect((await finalizeDueBoards(db, { now: () => new Date(END_OF_DAY), settings, reader: null })).finalized).toBe(0);
  });

  it("lifetime Clank Points exclude the archived development run; manual adjustments (no season) always count", async () => {
    await developmentPicks();
    const dev = (await activeSeason(db))!;
    // a development Point and an admin adjustment, written the way the rewards module writes them
    const [devBattle] = await db.query<{ id: string }>("select id from public.arena_battles where season_id = $1 limit 1", [dev.id]);
    const [settlement] = await db.query<{ id: string }>("select id from public.arena_pick_settlements where battle_id = $1", [devBattle!.id]);
    await db.query(
      `insert into public.arena_points_ledger (telegram_user_id, kind, points, battle_id, settlement_id, week_start, idempotency_key) values (9001, 'ARENA_PICK_CORRECT', 10, $1, $2, $3::date, 'dev-point-0001')`,
      [devBattle!.id, settlement!.id, WEEK],
    );
    await db.query("insert into public.arena_points_ledger (telegram_user_id, kind, points, week_start, idempotency_key) values (9001, 'ADMIN_ADJUSTMENT', 7, $1::date, 'adj-point-0001')", [WEEK]);
    expect((await getPointsSummary(db, 9001, END_OF_DAY - 60_000)).lifetime).toBe(17); // the running development season counts while it is the active one

    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const after = await getPointsSummary(db, 9001, END_OF_DAY - 60_000);
    expect(after.lifetime).toBe(7); // the test point is archived; the adjustment stays
    expect(after.today).toBe(0);
    expect(after.weekly).toBe(0);
    // the rows themselves are untouched (append-only)
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.arena_points_ledger where telegram_user_id = 9001"))[0]!.n).toBe(2);
  });
});

describe("END SEASON waits for the season's own boards", () => {
  it("is refused while a Daily / Weekly board of the season has picks but is not finalized (its prizes would be skipped) — and allowed once they are", async () => {
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const s1 = (await activeSeason(db))!;
    await seedScores(db, [{ user: 9101, day: DAY, picks: 20, correct: 9 }, { user: 9102, day: DAY, picks: 20, correct: 6 }], { seasonId: s1.id });
    const control = await getGameControl(db, adminDeps(clock));
    expect(control.actions.endSeason.allowed).toBe(false);
    expect(control.actions.endSeason.blockers.map((b) => b.code)).toContain("UNFINALIZED_PERIODS");
    await db.exec("update public.arena_state set status = 'PREPARING'"); // (the Arena never ran: pretend it did, to reach the pause precondition)
    await db.exec("update public.arena_state set status = 'PAUSED'");
    await expect(endSeason(db, adminDeps(clock), { confirmation: "END SEASON" })).rejects.toMatchObject({ code: "UNFINALIZED_PERIODS" });

    const settings = settingsWith({ enabled: true });
    await finalize(db, "DAILY", DAY, END_OF_DAY, { settings });
    await finalize(db, "WEEKLY", WEEK, END_OF_WEEK, { settings });
    expect((await getGameControl(db, adminDeps(clock))).actions.endSeason.allowed).toBe(true);
    const ended = await endSeason(db, adminDeps(clock), { confirmation: "END SEASON" });
    expect(ended.archived.pickScores).toBe(40);
  });
});

describe("the reward-liability check reads the real ledger", () => {
  it("scores and picks of unfinalized periods are NOT a liability (nothing was credited): a launch proceeds", async () => {
    await developmentPicks();
    const control = await getGameControl(db, adminDeps(clock));
    expect(control.rewards).toMatchObject({ checked: true, blocking: false, earnedMicro: "0", claimableMicro: "0", reservedMicro: "0", claimedMicro: "0", pendingOrSentClaims: 0, heldPrizes: 0, finalizedBoards: 0 });
    expect(control.actions.launch.allowed).toBe(true);
  });

  it("a finalized board that credited prizes IS one: the launch refuses until they are reversed, and the response names the reason", async () => {
    await developmentPicks();
    const settings = settingsWith({ enabled: true });
    await finalize(db, "DAILY", DAY, END_OF_DAY, { settings });
    expect((await balanceOf(db, 9001)).earned).toBeGreaterThan(0n);
    const control = await getGameControl(db, adminDeps(clock));
    expect(control.rewards.blocking).toBe(true);
    expect(control.rewards.finalizedBoards).toBe(1);
    expect(control.rewards.reasons.join(" ")).toMatch(/credited/);
    expect(control.actions.launch.allowed).toBe(false);
    expect(control.actions.launch.blockers.map((b) => b.code)).toContain("REWARD_LIABILITIES");
    await expect(launchSeason1(db, adminDeps(clock), LAUNCH)).rejects.toMatchObject({ code: "REWARD_LIABILITIES", status: 409 });
  });

  it("a launch while prizes are ON in development warns the operator (finalized boards credit prizes and would block it)", async () => {
    const control = await getGameControl(db, adminDeps(clock));
    const enabled = (await loadSettings(db)).arena_picks.enabled;
    expect(control.actions.launch.warnings.some((w) => /prizes are ON/i.test(w))).toBe(enabled);
  });
});
