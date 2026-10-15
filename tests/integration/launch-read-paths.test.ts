import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { finalizeHeroPeriod, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { getPickStats } from "@/server/rewards/summary";
import { getPointsSummary } from "@/server/rewards/points";
import { getHeroArenaPayload, getHeroRecordsPayload, getPicksSeasonPayload, listLeaderboardSeasons } from "@/server/services/heroBoards";
import { launchSeason1 } from "@/server/services/lifecycle";
import { getLeaderboard, BOARD_IDS } from "@/server/services/leaderboard";
import { activeSeasonRecord } from "@/server/services/seasonRecords";
import { listPublicHeroes } from "@/server/services/publicHeroes";
import { getArenaState } from "@/server/services/views";

import { createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { giveWins } from "../support/heroArena";
import { adminDeps, freshDevelopment } from "../support/lifecycle";
import { finalize as finalizePicks, seedScores, settingsWith, utc } from "../support/rewards";

/**
 * EVERY ACTIVE READ PATH, AFTER THE LAUNCH. Pre-season data is rich and everywhere (battles, wins, KOs, Picks, Points, boards, records); once Season 1 is launched, no
 * public read may show any of it as a current figure — not by zeroing a counter, but because every read is scoped to the season that counts. One test, every path.
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
  resetHeroArenaReadiness();
  clock = new FakeClock();
});

describe("after Season 1 launches, no public read path shows a pre-season figure", () => {
  it("leaderboards, records, hero profiles, the Arena state, Points and Picks stats all start from zero", async () => {
    const heroes = await seedHeroes(db, 14);
    const users = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by created_at, id")).map((r) => Number(r.telegram_user_id));
    const off = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    // a rich pre-season
    await giveWins(db, heroes[0]!, 6, "2026-10-05T12:00:00Z", { filler: [heroes[12]!, heroes[13]!], kos: 3, top2Only: 2 });
    await giveWins(db, heroes[1]!, 3, "2026-10-05T15:00:00Z", { filler: [heroes[12]!, heroes[13]!] });
    await seedScores(db, users.slice(0, 5).map((user, i) => ({ user, day: "2026-10-05", picks: 25 - i, correct: 20 - i * 2 })));
    await finalizePicks(db, "DAILY", "2026-10-05", utc(2026, 10, 6, 1), { settings: off });
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 6, 1)), settings: off, allowDemo: true }, "DAILY", "2026-10-05");
    // the pre-season Points ledger (what a settled battle writes for a correct pick)
    const [b] = await db.query<{ id: string; sid: string }>("select b.id, (select id from public.arena_pick_settlements where battle_id = b.id) as sid from public.arena_battles b where b.status = 'VOID' and exists (select 1 from public.arena_pick_settlements s where s.battle_id = b.id) order by b.sequence limit 1");
    await db.query(
      "insert into public.arena_points_ledger (telegram_user_id, kind, points, battle_id, settlement_id, week_start, idempotency_key) values ($1, 'ARENA_PICK_CORRECT', 10, $2, $3, '2026-10-05', 'pre-season-points-1')",
      [users[0], b!.id, b!.sid],
    );
    const settings = await loadSettings(db);
    const classes = await loadClasses(db);
    const beforeLaunch = {
      wins: (await getLeaderboard(db, "WINS", { allowDemo: true, seasonRanks: settings.progression.seasonRanks, seasonId: (await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'"))[0]!.id }))[0],
      points: (await getPointsSummary(db, users[0]!, utc(2026, 10, 6, 12))).lifetime,
    };
    expect(beforeLaunch.wins?.value ?? 0).toBeGreaterThan(0); // the pre-season record is real, and visible while it IS the season
    expect(beforeLaunch.points).toBeGreaterThan(0);

    // (the same reads are NOT empty before the launch — so the emptiness below is the launch, not a vacuous check)
    const preCtx = { nowMs: utc(2026, 10, 7, 12), settings, allowDemo: true, classes: {}, limit: 50 };
    expect((await getHeroArenaPayload(db, "SEASON", preCtx)).board.rows.length).toBeGreaterThan(2);
    expect((await getHeroRecordsPayload(db, "KOS", "SEASON", preCtx)).board.rows.length).toBeGreaterThan(0);
    expect((await getPicksSeasonPayload(db, { nowMs: preCtx.nowMs })).rows.length).toBe(5);
    expect((await listLeaderboardSeasons(db)).map((s) => s.label)).toEqual(["Pre-season"]);
    expect((await activeSeasonRecord(db, heroes[0]!)).wins).toBe(6);

    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    const s1 = (await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'"))[0]!.id;
    const ctx = { nowMs: utc(2026, 10, 7, 12), settings, allowDemo: true, classes: {}, limit: 50 };

    // Hall of Champions — every board and every scope
    for (const board of BOARD_IDS) {
      const rows = await getLeaderboard(db, board, { allowDemo: true, seasonRanks: settings.progression.seasonRanks, seasonId: s1 });
      if (["WINS", "TOP2", "KOS", "SEASON_POINTS"].includes(board)) expect(rows.every((r) => Number(r.value) === 0) || rows.length === 0, `board ${board}`).toBe(true);
    }
    for (const scope of ["DAILY", "WEEKLY", "SEASON"] as const) {
      expect((await getHeroArenaPayload(db, scope, ctx)).board.rows, `hero arena ${scope}`).toEqual([]);
      for (const metric of ["TOP2", "KOS"] as const) expect((await getHeroRecordsPayload(db, metric, scope, ctx)).board.rows, `${metric} ${scope}`).toEqual([]);
    }
    expect((await getPicksSeasonPayload(db, { nowMs: ctx.nowMs })).rows).toEqual([]);
    // the season selectors never offer the archived pre-season run
    expect((await listLeaderboardSeasons(db)).map((s) => s.label)).toEqual(["Season 1"]);
    expect((await getHeroArenaPayload(db, "DAILY", ctx)).periods).toEqual([]);

    // a hero's own record, the directory, the Arena state
    const rec = await activeSeasonRecord(db, heroes[0]!);
    expect(rec).toMatchObject({ battles: 0, wins: 0 });
    const directory = await listPublicHeroes(db, {}, { allowDemo: true, classes, settings });
    expect(directory.heroes.length).toBeGreaterThan(0);
    for (const h of directory.heroes) for (const k of ["record", "wins", "battles", "losses", "kos"]) expect(h, `${h.name}.${k}`).not.toHaveProperty(k); // the directory carries identity and PWR — no pre-season record can leak through it
    const arena = await getArenaState(db, ctx.nowMs, settings, { allowDemo: true, classes, picksEnabled: true });
    expect(arena).toMatchObject({ phase: "LIVE", status: "NOT_STARTED", current: null, upcoming: null, next: null });
    expect(arena.recent ?? []).toEqual([]);

    // a member's Points and Picks begin at zero
    const pts = await getPointsSummary(db, users[0]!, ctx.nowMs);
    expect(pts).toMatchObject({ lifetime: 0, today: 0, weekly: 0 });
    expect(await getPickStats(db, users[0]!)).toMatchObject({ totalPicks: 0, correctPicks: 0, bestStreak: 0 });
  });
});
