import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type GameSettings } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import { finalizeDueHeroBoards, finalizeHeroPeriod, releaseReservedHeroPrizes, resolveHeldHeroPrize, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { finalizeDueBoards } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import { claimCharacter } from "@/server/services/identity";
import { getHeroArenaPayload, getHeroRecordsPayload, getPicksSeasonPayload, type BoardCtx } from "@/server/services/heroBoards";
import { createNextSeason, endSeason, launchSeason1 } from "@/server/services/lifecycle";

import { loadClasses } from "@/server/config/settingsRepo";
import { applyRerollPreview, previewReroll } from "@/server/services/heroVersions";

import { createTestDb, FakeClock, insertStubHero, resetDb } from "../support/db";
import { giveWins, seedHeroBattles, seedHeroOwners } from "../support/heroArena";
import { adminDeps, activeSeason, freshDevelopment } from "../support/lifecycle";
import { balanceOf, finalize as finalizePicks, seedScores, tokens, utc } from "../support/rewards";

/**
 * HERO ARENA, end to end on a real schema: Daily / Weekly (rewarded) and Season (standings) ranked by ARENA WINS over SETTLED battles of ONE season; separate reward
 * program (own pools, own ledger source); owner attribution (claimed → credited, unclaimed → reserved, under review → held); exact ties pool and split; Season 2 starts clean.
 */
const WED = utc(2026, 10, 7, 18); // Wednesday; the week is Mon 2026-10-05 → Mon 2026-10-12
const settingsWith = (hero: Partial<GameSettings["hero_arena"]> = {}): GameSettings => ({ ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000", ...hero } });
const ctxAt = (nowMs: number, settings = settingsWith(), over: Partial<BoardCtx> = {}): BoardCtx => ({ nowMs, settings, allowDemo: false, classes: {}, ...over });

let db: Db;
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
});

interface Cast {
  A: string;
  B: string;
  C: string;
  F: [string, string];
  users: { A: number; B: number; C: number };
}

/** The brief's scenario: Daily wins A 8 · B 6 · C 8; Weekly wins A 25 · B 28 · C 20. A and B are CLAIMED heroes, C is not. Two filler heroes fill the other seats and never win. */
async function briefScenario(): Promise<Cast> {
  const heroes = await seedHeroOwners(db, [{ user: 101, name: "Hero A", claimed: true }, { user: 102, name: "Hero B", claimed: true }, { user: 103, name: "Hero C" }, { user: 104, name: "Filler One" }, { user: 105, name: "Filler Two" }]);
  const cast: Cast = { A: heroes.get(101)!, B: heroes.get(102)!, C: heroes.get(103)!, F: [heroes.get(104)!, heroes.get(105)!], users: { A: 101, B: 102, C: 103 } };
  const day = (d: number, h = 9) => new Date(utc(2026, 10, d, h)).toISOString();
  // Mon + Tue (earlier in the same week) …
  await giveWins(db, cast.A, 10, day(5), { filler: cast.F });
  await giveWins(db, cast.A, 7, day(6), { filler: cast.F });
  await giveWins(db, cast.B, 12, day(5, 12), { filler: cast.F });
  await giveWins(db, cast.B, 10, day(6, 12), { filler: cast.F });
  await giveWins(db, cast.C, 12, day(6, 15), { filler: cast.F });
  // … and Wednesday, the day under test: A 8 · B 6 · C 8
  await giveWins(db, cast.A, 8, day(7, 10), { filler: cast.F });
  await giveWins(db, cast.B, 6, day(7, 11), { filler: cast.F });
  await giveWins(db, cast.C, 8, day(7, 12), { filler: cast.F });
  return cast;
}

const byName = <T extends { name: string }>(rows: T[]): Record<string, T> => Object.fromEntries(rows.map((r) => [r.name, r]));

describe("the brief's scenario: ranked by Arena Wins in the period AND the season", () => {
  it("DAILY: A and C tie at 8 wins (rank 1, TIE), B has 6 (rank 3) — and the rewarded view carries the prize rules + projected pooled prizes", async () => {
    await briefScenario();
    const { board } = await getHeroArenaPayload(db, "DAILY", ctxAt(WED));
    const rows = byName(board.rows);
    expect(board).toMatchObject({ scope: "DAILY", rewarded: true, state: "CURRENT", start: "2026-10-07" });
    expect([rows["Hero A"]!.rank, rows["Hero C"]!.rank, rows["Hero B"]!.rank]).toEqual([1, 1, 3]);
    expect([rows["Hero A"]!.tied, rows["Hero C"]!.tied, rows["Hero B"]!.tied]).toEqual([true, true, false]);
    expect([rows["Hero A"]!.wins, rows["Hero B"]!.wins, rows["Hero C"]!.wins]).toEqual([8, 6, 8]);
    // Positions 1+2 = 30% + 20% of 100,000 = 50,000 → 25,000 each; B takes position 3 (15%).
    expect([rows["Hero A"]!.prize, rows["Hero C"]!.prize, rows["Hero B"]!.prize]).toEqual(["25,000", "25,000", "15,000"]);
    expect(rows["Filler One"]!.prize).toBe("0");
    expect(rows["Filler One"]!.prizeEligible).toBe(false);
    expect(board.rules).toMatchObject({ poolSet: true, prizePool: "100,000", topRewarded: 10, minimumWins: 1 });
    expect(board.rules!.prizes[0]).toEqual({ position: 1, share: "30%", amount: "30,000" });
    expect(board.participants).toBe(5);
  });

  it("WEEKLY: B leads with 28, then A 25, then C 20 — the same battles, a different period", async () => {
    await briefScenario();
    const { board } = await getHeroArenaPayload(db, "WEEKLY", ctxAt(WED));
    expect(board).toMatchObject({ scope: "WEEKLY", rewarded: true, start: "2026-10-05" });
    const top = board.rows.slice(0, 3);
    expect(top.map((r) => [r.name, r.rank, r.wins])).toEqual([["Hero B", 1, 28], ["Hero A", 2, 25], ["Hero C", 3, 20]]);
    expect(top.map((r) => r.prize)).toEqual(["150,000", "100,000", "75,000"]); // weekly pool 500,000: 30 / 20 / 15 %
    expect(board.rules).toMatchObject({ prizePool: "500,000" });
  });

  it("SEASON: every settled battle of the season, standings only — no prize rules, no prizes, no ladder", async () => {
    await briefScenario();
    const { board } = await getHeroArenaPayload(db, "SEASON", ctxAt(WED));
    expect(board).toMatchObject({ scope: "SEASON", rewarded: false, state: "SEASON", rules: null });
    expect(board.rows.slice(0, 3).map((r) => [r.name, r.rank, r.wins, r.matches])).toEqual([["Hero B", 1, 28, 28], ["Hero A", 2, 25, 25], ["Hero C", 3, 20, 20]]);
    expect(board.rows.every((r) => r.prize === "0" && r.prizeStatus === "NONE")).toBe(true);
    expect(board.season).toMatchObject({ kind: "DEVELOPMENT", current: true, label: "Development" }); // clearly the development run, not a Season record
  });

  it("the rewarded boards never rank by PWR, rarity, wallet or Telegram activity: changing them reorders nothing", async () => {
    const cast = await briefScenario();
    const before = (await getHeroArenaPayload(db, "WEEKLY", ctxAt(WED))).board.rows.map((r) => [r.name, r.rank]);
    await db.query("update public.characters set power = case id when $1 then 9999 when $2 then 1 else power end", [cast.C, cast.B]);
    await db.query("update public.telegram_users set activity_score = 99999, qualifying_message_count = 99999 where telegram_user_id = $1", [cast.users.C]);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, holder_wallet_address, wallet_verified_at) values ($1, '0x8617e340b3d01fa5f11f306f4090fd50e238070d', now()) on conflict (telegram_user_id) do update set holder_wallet_address = excluded.holder_wallet_address, wallet_verified_at = excluded.wallet_verified_at", [cast.users.C]);
    expect((await getHeroArenaPayload(db, "WEEKLY", ctxAt(WED))).board.rows.map((r) => [r.name, r.rank])).toEqual(before);
  });
});

describe("a period only holds ITS season's battles, and a hero keeps its record through suspension and reroll", () => {
  it("a SUSPENDED hero keeps its settled wins on every board (its row just has no public link)", async () => {
    const cast = await briefScenario();
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [cast.A]);
    const daily = (await getHeroArenaPayload(db, "DAILY", ctxAt(WED))).board.rows.find((r) => r.name === "Hero A")!;
    expect(daily).toMatchObject({ rank: 1, wins: 8, heroPublicId: null });
    expect((await getHeroArenaPayload(db, "SEASON", ctxAt(WED))).board.rows.find((r) => r.name === "Hero A")).toMatchObject({ wins: 25, heroPublicId: null });
    expect((await getHeroArenaPayload(db, "DAILY", ctxAt(WED))).board.rows.find((r) => r.name === "Hero B")!.heroPublicId).toMatch(/\S/); // an active hero links
  });

  it("a REROLL (a new hero version: class / rarity / PWR may change) does not touch earned wins: the leaderboard is tied to the stable hero identity", async () => {
    const cast = await briefScenario();
    const deps = { settings: DEFAULT_SETTINGS, classes: await loadClasses(db), secret: "test-secret-value-1234567890", now: () => new Date(WED) };
    const before = (await getHeroArenaPayload(db, "SEASON", ctxAt(WED))).board.rows.find((r) => r.characterId === cast.A)!;
    let changed = before;
    for (let i = 0; i < 12 && changed.classId === before.classId && changed.rarity === before.rarity; i++) {
      const preview = await previewReroll(db, cast.A, "admin", deps);
      await applyRerollPreview(db, cast.A, preview.previewId, "admin", deps);
      changed = (await getHeroArenaPayload(db, "SEASON", ctxAt(WED))).board.rows.find((r) => r.characterId === cast.A)!;
    }
    expect(changed.classId !== before.classId || changed.rarity !== before.rarity || changed.power !== before.power).toBe(true); // the hero really changed…
    expect(changed).toMatchObject({ wins: 25, rank: 2, characterId: cast.A, name: "Hero A" }); // …and its record did not
    expect((await getHeroArenaPayload(db, "DAILY", ctxAt(WED))).board.rows.find((r) => r.characterId === cast.A)).toMatchObject({ wins: 8, rank: 1, classId: changed.classId });
  });

  it("demo heroes are excluded unless demo heroes are allowed", async () => {
    const cast = await briefScenario();
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes order by sort_order limit 1");
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, is_demo) values (-501, 'Demo', 0, true)");
    const demo = await insertStubHero(db, { telegram_user_id: -501, class_id: cls!.id, name: "Demo Hero", origin: "DEV_SEED", is_demo: true, status: "ACTIVE" });
    await giveWins(db, demo, 4, new Date(utc(2026, 10, 7, 17)).toISOString(), { filler: cast.F });
    expect((await getHeroArenaPayload(db, "SEASON", ctxAt(WED))).board.rows.some((r) => r.name === "Demo Hero")).toBe(false);
    expect((await getHeroArenaPayload(db, "DAILY", ctxAt(WED))).board.rows.some((r) => r.name === "Demo Hero")).toBe(false);
    expect((await getHeroArenaPayload(db, "SEASON", ctxAt(WED, undefined, { allowDemo: true }))).board.rows.find((r) => r.name === "Demo Hero")).toMatchObject({ wins: 4, isDemo: true });
  });

  it("battles that are NOT settled (decided but unsettled, void) never count", async () => {
    const cast = await briefScenario();
    const at = (min: number) => new Date(utc(2026, 10, 7, 14, min)).toISOString();
    await seedHeroBattles(db, [
      { at: at(1), outcome: "SIMULATED", placements: [{ hero: cast.B, placement: 1 }, { hero: cast.F[0], placement: 2 }, { hero: cast.F[1], placement: 3 }] },
      { at: at(2), outcome: "VOID", placements: [{ hero: cast.B, placement: 1 }, { hero: cast.F[0], placement: 2 }, { hero: cast.F[1], placement: 3 }] },
    ]);
    const { board } = await getHeroArenaPayload(db, "DAILY", ctxAt(WED));
    expect(board.rows.find((r) => r.name === "Hero B")).toMatchObject({ wins: 6, matches: 6 }); // unchanged: the two extra B "wins" are not settled
  });
});

describe("FINALIZATION: a separate reward program with owner attribution", () => {
  const nextDay = utc(2026, 10, 8, 0, 5);
  const nowFn = (ms: number) => ({ now: () => new Date(ms) });
  const tie = async (cast: Cast) => {
    // B's owner is under review
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values ($1, 'REVIEW', 'manual look') on conflict (telegram_user_id) do update set review_state = 'REVIEW'", [cast.users.B]);
  };

  it("freezes the board; CLAIMED hero → CREDITED to its owner (ledger source HERO_ARENA_DAILY); UNCLAIMED → RESERVED (nothing credited); owner under review → HELD", async () => {
    const cast = await briefScenario();
    await tie(cast);
    const r = await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    expect(r).toMatchObject({ status: "FINALIZED", participants: 5, eligible: 3, credited: 1, reserved: 1, held: 1 });

    const rows = await db.query<{ character_id: string; prize_status: string; prize_micro: string; owner_claimed: boolean; rank: number; tie_size: number }>("select character_id, prize_status, prize_micro::text, owner_claimed, rank, tie_size from public.hero_arena_results where kind = 'DAILY' and period_start = '2026-10-07'");
    const of = (id: string) => rows.find((x) => x.character_id === id)!;
    expect(of(cast.A)).toMatchObject({ prize_status: "CREDITED", prize_micro: tokens(25_000).toString(), owner_claimed: true, rank: 1, tie_size: 2 });
    expect(of(cast.C)).toMatchObject({ prize_status: "RESERVED", prize_micro: tokens(25_000).toString(), owner_claimed: false, rank: 1, tie_size: 2 });
    expect(of(cast.B)).toMatchObject({ prize_status: "HELD", prize_micro: tokens(15_000).toString() });

    // Exactly ONE credit exists, to A's owner, in its own ledger source — and C's reserved prize was NOT paid to anybody else.
    const ledger = await db.query<{ telegram_user_id: number; kind: string; reward_source: string; claimable_delta: string }>("select telegram_user_id, kind, reward_source, claimable_delta::text from public.arena_reward_ledger where hero_character_id is not null");
    expect(ledger).toEqual([{ telegram_user_id: cast.users.A, kind: "HERO_ARENA_DAILY_REWARD", reward_source: "HERO_ARENA_DAILY", claimable_delta: tokens(25_000).toString() }]);
    expect((await balanceOf(db, cast.users.A)).claimable).toBe(tokens(25_000));
    expect((await balanceOf(db, cast.users.C)).claimable).toBe(0n);
    expect((await balanceOf(db, cast.users.B)).claimable).toBe(0n);

    // The pool is exactly accounted: awarded (credited + reserved + held) + returned = pool.
    const [board] = await db.query<{ awarded: string; returned: string; pool: string; pool_set: boolean }>("select awarded_micro::text as awarded, returned_to_reserve_micro::text as returned, prize_pool_micro::text as pool, pool_set from public.hero_arena_boards where kind = 'DAILY'");
    expect(board).toEqual({ awarded: tokens(65_000).toString(), returned: tokens(35_000).toString(), pool: tokens(100_000).toString(), pool_set: true });
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
  });

  it("is idempotent: finalizing again changes nothing (one board, one ledger credit)", async () => {
    const cast = await briefScenario();
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    const day = async () => JSON.stringify(await db.query("select (select count(*)::int from public.arena_reward_ledger where hero_period_kind = 'DAILY' and hero_period_start = '2026-10-07') as ledger, (select count(*)::int from public.hero_arena_results where kind = 'DAILY' and period_start = '2026-10-07') as results"));
    const before = await day();
    expect(await finalizeHeroPeriod(db, { ...nowFn(nextDay + 3_600_000), settings: settingsWith() }, "DAILY", "2026-10-07")).toMatchObject({ status: "ALREADY_FINALIZED" });
    const sweep = await finalizeDueHeroBoards(db, { ...nowFn(nextDay + 3_600_000), settings: settingsWith() }); // (the sweep also freezes the EARLIER days of the week: that is its job)
    expect(sweep.failed).toBe(0);
    expect(sweep.periods).not.toContain("HERO_ARENA_DAILY:2026-10-07"); // already frozen: never frozen twice
    expect(await day()).toBe(before);
    expect(await db.query("select count(*)::int as n from public.hero_arena_boards where kind = 'DAILY' and period_start = '2026-10-07'")).toEqual([{ n: 1 }]);
    expect(await db.query("select claimable_delta::text as d from public.arena_reward_ledger where hero_character_id = $1 and hero_period_kind = 'DAILY' and hero_period_start = '2026-10-07'", [cast.A])).toEqual([{ d: tokens(25_000).toString() }]);
  });

  it("does not finalize a period that has not ended (or is inside the clock-skew grace)", async () => {
    await briefScenario();
    expect(await finalizeHeroPeriod(db, { ...nowFn(WED), settings: settingsWith() }, "DAILY", "2026-10-07")).toMatchObject({ status: "NOT_ENDED" });
    expect(await finalizeHeroPeriod(db, { ...nowFn(utc(2026, 10, 8, 0, 0, 3)), settings: settingsWith() }, "DAILY", "2026-10-07")).toMatchObject({ status: "NOT_ENDED" });
    expect(await finalizeHeroPeriod(db, { ...nowFn(utc(2026, 10, 8, 0, 0, 30)), settings: settingsWith() }, "DAILY", "2026-10-07")).toMatchObject({ status: "FINALIZED" });
  });

  it("the frozen board is what is served afterwards (and a later setting change never rewrites it)", async () => {
    await briefScenario();
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    const changed = settingsWith({ dailyPrizePool: "999999" });
    const { board, periods } = await getHeroArenaPayload(db, "DAILY", ctxAt(nextDay + 1000, changed, { start: "2026-10-07" }));
    expect(board).toMatchObject({ state: "FINAL", rules: { prizePool: "100,000", poolSet: true } });
    expect(board.rows.find((r) => r.name === "Hero A")).toMatchObject({ prize: "25,000", prizeStatus: "CREDITED" });
    expect(board.rows.find((r) => r.name === "Hero C")).toMatchObject({ prize: "25,000", prizeStatus: "RESERVED" });
    expect(periods).toEqual([{ start: "2026-10-07", participants: 5 }]);
  });

  it("an UNCLAIMED hero's prize is released to its OWNER when the owner claims the hero — once, to nobody else", async () => {
    const cast = await briefScenario();
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    // Another member cannot take it: they have no claim on the hero, and the release is keyed by the row's OWNER.
    expect(await releaseReservedHeroPrizes(db, nowFn(nextDay), cast.C, cast.users.A)).toEqual({ credited: 0, held: 0 });
    expect(await claimCharacter(db, 9999, new Date(nextDay))).toMatchObject({ ok: false });
    expect((await balanceOf(db, cast.users.A)).claimable).toBe(tokens(25_000)); // unchanged: A did not receive C's prize
    // The real owner signs in with Telegram and claims the hero.
    expect(await claimCharacter(db, cast.users.C, new Date(nextDay + 1000))).toMatchObject({ ok: true });
    expect((await balanceOf(db, cast.users.C)).claimable).toBe(tokens(25_000));
    expect(await db.query("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY'", [cast.C])).toEqual([{ prize_status: "CREDITED" }]);
    // Claiming again (or a sweep) never pays twice.
    expect(await claimCharacter(db, cast.users.C, new Date(nextDay + 2000))).toMatchObject({ ok: true, alreadyClaimed: true });
    expect((await balanceOf(db, cast.users.C)).claimable).toBe(tokens(25_000));
    const sweep = await finalizeDueHeroBoards(db, { ...nowFn(nextDay + 5000), settings: settingsWith() }); // freezes the earlier days: C (claimed by now) is CREDITED those directly, nothing is "released"
    expect(sweep.released).toBe(0);
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where hero_character_id = $1 and hero_period_kind = 'DAILY' and hero_period_start = '2026-10-07'", [cast.C])).toEqual([{ n: 1 }]);
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
  });

  it("the sweep releases a reservation whose hero was claimed some other way", async () => {
    const cast = await briefScenario();
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    await db.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, $2, now())", [cast.C, cast.users.C]); // e.g. an import / repair
    expect((await finalizeDueHeroBoards(db, { ...nowFn(nextDay + 5000), settings: settingsWith() })).released).toBe(1);
    expect(await db.query("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY' and period_start = '2026-10-07'", [cast.C])).toEqual([{ prize_status: "CREDITED" }]);
    expect(await db.query("select claimable_delta::text as d from public.arena_reward_ledger where hero_character_id = $1 and hero_period_kind = 'DAILY' and hero_period_start = '2026-10-07'", [cast.C])).toEqual([{ d: tokens(25_000).toString() }]);
  });

  it("a HELD prize is resolved by an admin: release credits its owner, forfeit returns it to the reserve; nothing else moves it", async () => {
    const cast = await briefScenario();
    await tie(cast);
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    const base = { kind: "DAILY" as const, start: "2026-10-07", characterId: cast.B, actor: "admin" };
    expect(await resolveHeldHeroPrize(db, nowFn(nextDay), { ...base, action: "release", reason: "" })).toEqual({ ok: false, reason: "REASON_REQUIRED" });
    expect(await resolveHeldHeroPrize(db, nowFn(nextDay), { ...base, characterId: cast.A, action: "release", reason: "no" + "pe" })).toEqual({ ok: false, reason: "NOT_HELD" }); // A is already credited
    expect(await resolveHeldHeroPrize(db, nowFn(nextDay), { ...base, action: "release", reason: "reviewed, fine" })).toMatchObject({ ok: true, status: "CREDITED" });
    expect((await balanceOf(db, cast.users.B)).claimable).toBe(tokens(15_000));
    expect(await resolveHeldHeroPrize(db, nowFn(nextDay), { ...base, action: "release", reason: "again please" })).toEqual({ ok: false, reason: "NOT_HELD" });
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
  });

  it("NO POOL SET → 'REWARD POOL NOT SET': the board still ranks and freezes, and nothing is credited, reserved or held", async () => {
    const cast = await briefScenario();
    const unset = DEFAULT_SETTINGS; // hero_arena pools are null by default
    const live = (await getHeroArenaPayload(db, "DAILY", ctxAt(WED, unset))).board;
    expect(live.rules).toMatchObject({ poolSet: false, prizePool: null });
    expect(live.rules!.prizes.every((p) => p.amount === null)).toBe(true);
    expect(live.rows.every((r) => r.prize === "0")).toBe(true);
    expect(await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: unset }, "DAILY", "2026-10-07")).toMatchObject({ status: "FINALIZED", credited: 0, reserved: 0, held: 0 });
    expect(await db.query("select pool_set, prize_pool_micro::text as pool from public.hero_arena_boards")).toEqual([{ pool_set: false, pool: "0" }]);
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where hero_character_id is not null")).toEqual([{ n: 0 }]);
    expect((await balanceOf(db, cast.users.A)).claimable).toBe(0n);
    const frozen = (await getHeroArenaPayload(db, "DAILY", ctxAt(nextDay + 1000, unset, { start: "2026-10-07" }))).board;
    expect(frozen).toMatchObject({ state: "FINAL", rules: { poolSet: false, prizePool: null } });
    expect(frozen.rows.find((r) => r.name === "Hero A")).toMatchObject({ rank: 1, wins: 8, prize: "0" });
  });

  it("prizes switched off: a zero pool is frozen with the period", async () => {
    await briefScenario();
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith({ enabled: false }) }, "DAILY", "2026-10-07");
    expect(await db.query("select pool_set, prize_pool_micro::text as pool from public.hero_arena_boards")).toEqual([{ pool_set: true, pool: "0" }]);
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where hero_character_id is not null")).toEqual([{ n: 0 }]);
  });

  it("a hero with NO Telegram owner keeps its position, and its share returns to the reserve — never to another hero", async () => {
    const cast = await briefScenario();
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes order by sort_order limit 1");
    const special = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", telegram_user_id: null, class_id: cls!.id, name: "The Founder", origin: "ADMIN", status: "ACTIVE" });
    await giveWins(db, special, 9, new Date(utc(2026, 10, 7, 16)).toISOString(), { filler: cast.F }); // the Founder wins 9 today: rank 1 outright
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    expect(await db.query("select prize_status, prize_micro::text, rank, owner_user_id from public.hero_arena_results where character_id = $1 and kind = 'DAILY'", [special])).toEqual([{ prize_status: "NONE", prize_micro: "0", rank: 1, owner_user_id: null }]);
    const [board] = await db.query<{ awarded: string; returned: string }>("select awarded_micro::text as awarded, returned_to_reserve_micro::text as returned from public.hero_arena_boards where kind = 'DAILY'");
    // Positions: Founder #1 (30%, no owner → returned), A+C tied #2/#3 (20% + 15% → 17,500 each), B #4 (10%). Nobody moved up into the Founder's place.
    expect(board).toEqual({ awarded: tokens(45_000).toString(), returned: tokens(55_000).toString() });
    expect(await db.query("select prize_micro::text as p from public.hero_arena_results where character_id = $1 and kind = 'DAILY'", [cast.A])).toEqual([{ p: tokens(17_500).toString() }]);
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
  });

  it("holdings play no part: a hero's owner holding tokens (a verified wallet with a huge balance) changes neither the rank nor the prize", async () => {
    const cast = await briefScenario();
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, holder_wallet_address, wallet_verified_at) values ($1, '0x52908400098527886e0f7030069857d2e4169ee7', now()) on conflict (telegram_user_id) do update set holder_wallet_address = excluded.holder_wallet_address, wallet_verified_at = excluded.wallet_verified_at", [cast.users.A]);
    await finalizeHeroPeriod(db, { ...nowFn(nextDay), settings: settingsWith() }, "DAILY", "2026-10-07");
    expect((await balanceOf(db, cast.users.A)).claimable).toBe(tokens(25_000)); // exactly the ladder: no holder bonus exists for Hero Arena
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where kind like '%HOLDER_BONUS' and hero_character_id is not null")).toEqual([{ n: 0 }]);
  });

  it("WEEKLY finalizes independently of DAILY, with its own ledger source and its own pool", async () => {
    const cast = await briefScenario();
    const weekEnd = utc(2026, 10, 12, 0, 5);
    expect(await finalizeHeroPeriod(db, { ...nowFn(weekEnd), settings: settingsWith() }, "WEEKLY", "2026-10-05")).toMatchObject({ status: "FINALIZED", credited: 2, reserved: 1 });
    const ledger = await db.query<{ reward_source: string; claimable_delta: string; telegram_user_id: number }>("select reward_source, claimable_delta::text, telegram_user_id from public.arena_reward_ledger where hero_character_id is not null order by telegram_user_id");
    expect(ledger).toEqual([
      { reward_source: "HERO_ARENA_WEEKLY", claimable_delta: tokens(100_000).toString(), telegram_user_id: cast.users.A }, // A: 2nd of the week
      { reward_source: "HERO_ARENA_WEEKLY", claimable_delta: tokens(150_000).toString(), telegram_user_id: cast.users.B }, // B: 1st
    ]);
    expect(await db.query("select count(*)::int as n from public.hero_arena_boards where kind = 'DAILY'")).toEqual([{ n: 0 }]);
  });
});

describe("independence: Arena Picks and Hero Arena never touch each other", () => {
  it("the Picks pools do not move the Hero Arena pools, and finalizing one program creates nothing in the other", async () => {
    await briefScenario();
    const odd = settingsWith();
    odd.arena_picks = { ...odd.arena_picks, dailyPrizePool: "7", weeklyPrizePool: "9" };
    expect((await getHeroArenaPayload(db, "DAILY", ctxAt(WED, odd))).board.rules).toMatchObject({ prizePool: "100,000" });
    expect((await getHeroArenaPayload(db, "DAILY", ctxAt(WED, DEFAULT_SETTINGS))).board.rules).toMatchObject({ poolSet: false }); // not 100,000 copied from Picks

    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings: settingsWith() }, "DAILY", "2026-10-07");
    expect(await db.query("select count(*)::int as n from public.arena_leaderboards")).toEqual([{ n: 0 }]); // no Picks board appeared
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where period_kind is not null")).toEqual([{ n: 0 }]);

    // …and the Picks sweep (which finds nothing here) leaves the Hero Arena tables exactly as they are.
    const before = JSON.stringify(await db.query("select (select count(*)::int from public.hero_arena_boards) as b, (select count(*)::int from public.hero_arena_results) as r, (select count(*)::int from public.arena_reward_ledger where hero_character_id is not null) as l"));
    await finalizeDueBoards(db, { now: () => new Date(utc(2026, 10, 8, 2)), settings: settingsWith() });
    expect(JSON.stringify(await db.query("select (select count(*)::int from public.hero_arena_boards) as b, (select count(*)::int from public.hero_arena_results) as r, (select count(*)::int from public.arena_reward_ledger where hero_character_id is not null) as l"))).toBe(before);
  });

  it("every ledger row names its program: ARENA_PICKS_DAILY | ARENA_PICKS_WEEKLY | HERO_ARENA_DAILY | HERO_ARENA_WEEKLY — never a generic 'leaderboard'", async () => {
    await briefScenario();
    await seedScores(db, [{ user: 301, day: "2026-10-06", picks: 25, correct: 20 }, { user: 302, day: "2026-10-06", picks: 22, correct: 3 }]);
    await finalizePicks(db, "DAILY", "2026-10-06", utc(2026, 10, 7, 1));
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings: settingsWith() }, "DAILY", "2026-10-07");
    const sources = await db.query<{ reward_source: string; n: number }>("select reward_source, count(*)::int as n from public.arena_reward_ledger where reward_source is not null group by 1 order by 1");
    expect(sources.map((s) => s.reward_source)).toEqual(["ARENA_PICKS_DAILY", "HERO_ARENA_DAILY"]);
    expect(await db.query("select count(*)::int as n from public.arena_reward_ledger where kind not in ('CLAIM_RESERVED', 'CLAIM_SENT', 'CLAIM_RELEASED', 'ADMIN_ADJUSTMENT') and reward_source is null")).toEqual([{ n: 0 }]);
  });
});

describe("SEASONS: everything competitive respects the season; Season 2 starts clean; Season 1 is preserved", () => {
  async function launchSeasonOne(): Promise<{ clock: FakeClock; s1: string }> {
    const clock = new FakeClock(WED);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    return { clock, s1: (await activeSeason(db))!.id };
  }

  it("Season 1: Hero A 100 wins and Player A 4,000 Pick points → Season 2 starts at 0 for both, and Season 1 stays selectable with its own totals", async () => {
    const heroes = await seedHeroOwners(db, [{ user: 201, name: "Hero A", claimed: true }, { user: 202, name: "Filler One" }, { user: 203, name: "Filler Two" }]);
    const A = heroes.get(201)!;
    const F: [string, string] = [heroes.get(202)!, heroes.get(203)!];
    const { clock, s1 } = await launchSeasonOne();
    await giveWins(db, A, 100, new Date(utc(2026, 10, 7, 1)).toISOString(), { filler: F, seasonId: s1 });
    await seedScores(db, [{ user: 201, day: "2026-10-07", picks: 400, correct: 400 }], { seasonId: s1 }); // 400 correct × 10 = 4,000 points
    const day1 = (await getHeroArenaPayload(db, "SEASON", ctxAt(WED))).board;
    expect(day1.season).toMatchObject({ label: "Season 1", kind: "COMPETITIVE", current: true });
    expect(day1.rows.find((r) => r.characterId === A)).toMatchObject({ wins: 100 });
    expect((await getPicksSeasonPayload(db, { nowMs: WED, viewerId: 201 })).rows[0]).toMatchObject({ correctPicks: 400, points: 4000 });

    // Both programs finalize their periods, then the season ends and Season 2 begins (the real lifecycle).
    const after = utc(2026, 10, 14, 1);
    await finalizePicks(db, "DAILY", "2026-10-07", after);
    await finalizePicks(db, "WEEKLY", "2026-10-05", after);
    await finalizeDueHeroBoards(db, { now: () => new Date(after), settings: settingsWith() });
    clock.ms = after;
    await endSeason(db, adminDeps(clock), { confirmation: "END SEASON" });
    await createNextSeason(db, adminDeps(clock));
    const s2 = (await activeSeason(db))!;
    expect(s2.id).not.toBe(s1);

    // Season 2 (the default) starts clean…
    const s2Hero = (await getHeroArenaPayload(db, "SEASON", ctxAt(after + 1000))).board;
    expect(s2Hero.season).toMatchObject({ label: "Season 2", current: true });
    expect(s2Hero.rows).toEqual([]);
    expect(s2Hero.participants).toBe(0);
    const s2Picks = await getPicksSeasonPayload(db, { nowMs: after + 1000, viewerId: 201 });
    expect(s2Picks.season).toMatchObject({ label: "Season 2" });
    expect(s2Picks.rows).toEqual([]);
    expect(s2Picks.me).toMatchObject({ points: 0, correctPicks: 0, rank: null });
    for (const metric of ["TOP2", "KOS"] as const) expect((await getHeroRecordsPayload(db, metric, "SEASON", ctxAt(after + 1000))).board.rows).toEqual([]);

    // …and Season 1 is untouched and selectable.
    const old = (await getHeroArenaPayload(db, "SEASON", ctxAt(after + 1000, undefined, { seasonId: s1 }))).board;
    expect(old.season).toMatchObject({ label: "Season 1", current: false });
    expect(old.rows.find((r) => r.characterId === A)).toMatchObject({ wins: 100, rank: 1 });
    const oldPicks = await getPicksSeasonPayload(db, { nowMs: after + 1000, seasonId: s1, viewerId: 201 });
    expect(oldPicks.rows[0]).toMatchObject({ correctPicks: 400, points: 4000, rank: 1 });
    expect(oldPicks.me).toMatchObject({ points: 4000, rank: 1 });
    expect((await getHeroArenaPayload(db, "SEASON", ctxAt(after + 1000))).seasons.map((s) => [s.label, s.current])).toEqual([["Season 2", true], ["Season 1", false]]);
  });

  it("DAILY / WEEKLY are season-aware: Season 2's Tuesday contains none of Season 1's Tuesday — not even Season 1's battles of the SAME UTC day", async () => {
    const heroes = await seedHeroOwners(db, [{ user: 211, name: "Season One Star" }, { user: 212, name: "Season Two Star" }, { user: 213, name: "Filler One" }, { user: 214, name: "Filler Two" }]);
    const F: [string, string] = [heroes.get(213)!, heroes.get(214)!];
    const { clock, s1 } = await launchSeasonOne();
    // Season 1: five wins on Tuesday 2026-10-06, two more on Tuesday 2026-10-13 (the morning of the day Season 1 ends)
    await giveWins(db, heroes.get(211)!, 5, new Date(utc(2026, 10, 6, 9)).toISOString(), { filler: F, seasonId: s1 });
    await giveWins(db, heroes.get(211)!, 2, new Date(utc(2026, 10, 13, 9)).toISOString(), { filler: F, seasonId: s1 });
    clock.ms = utc(2026, 10, 13, 12);
    await endSeason(db, adminDeps(clock), { confirmation: "END SEASON" });
    await createNextSeason(db, adminDeps(clock));
    // Season 2 fights on that same Tuesday afternoon.
    await giveWins(db, heroes.get(212)!, 3, new Date(utc(2026, 10, 13, 15)).toISOString(), { filler: F });

    const daily = (await getHeroArenaPayload(db, "DAILY", ctxAt(utc(2026, 10, 13, 20)))).board;
    expect(daily.season).toMatchObject({ label: "Season 2" });
    expect(daily.rows.filter((r) => r.wins > 0).map((r) => [r.name, r.wins])).toEqual([["Season Two Star", 3]]); // Season 1's two morning wins are not in Season 2's day
    const weekly = (await getHeroArenaPayload(db, "WEEKLY", ctxAt(utc(2026, 10, 13, 20)))).board;
    expect(weekly.rows.filter((r) => r.wins > 0).map((r) => [r.name, r.wins])).toEqual([["Season Two Star", 3]]);
    const records = (await getHeroRecordsPayload(db, "TOP2", "DAILY", ctxAt(utc(2026, 10, 13, 20)))).board;
    expect(records.rows.find((r) => r.name === "Season One Star")).toBeUndefined();

    // Season 1's earlier Tuesday, frozen, is Season 1's alone.
    await finalizeDueHeroBoards(db, { now: () => new Date(utc(2026, 10, 14, 1)), settings: settingsWith() });
    const past = (await getHeroArenaPayload(db, "DAILY", ctxAt(utc(2026, 10, 14, 2), undefined, { start: "2026-10-06" }))).board;
    expect(past.state).toBe("FINAL");
    expect(past.season).toMatchObject({ label: "Season 1" });
    expect(past.rows.filter((r) => r.wins > 0).map((r) => [r.name, r.wins])).toEqual([["Season One Star", 5]]);
    // And the frozen Tuesday the two seasons shared belongs to Season 2 only.
    const shared = (await getHeroArenaPayload(db, "DAILY", ctxAt(utc(2026, 10, 14, 2), undefined, { start: "2026-10-13" }))).board;
    expect(shared.season).toMatchObject({ label: "Season 2" });
    expect(shared.rows.filter((r) => r.wins > 0).map((r) => [r.name, r.wins])).toEqual([["Season Two Star", 3]]);
  });
});

describe("HERO RECORDS: statistics only — never a prize, never a rule", () => {
  it("Top-2 and KOs rank by their own value for Daily / Weekly / Season, with no rules and no prizes", async () => {
    const cast = await briefScenario();
    await seedHeroBattles(db, [{ at: new Date(utc(2026, 10, 7, 13)).toISOString(), placements: [{ hero: cast.F[0], placement: 1, kos: 9 }, { hero: cast.A, placement: 2, kos: 0 }, { hero: cast.B, placement: 3, kos: 0 }] }]);
    const top2 = await getHeroRecordsPayload(db, "TOP2", "DAILY", ctxAt(WED));
    expect(top2.board).toMatchObject({ rewarded: false, rules: null, scope: "DAILY" });
    const values = top2.board.rows.map((r) => r.top2);
    expect(values).toEqual([...values].sort((a, b) => b - a)); // ranked by Top-2, highest first
    const rank = (name: string) => top2.board.rows.find((r) => r.name === name)!;
    expect(rank("Hero A").top2).toBe(9); // 8 wins + one runner-up finish today
    expect(rank("Hero C").top2).toBe(8);
    expect(rank("Hero A").rank).toBeLessThan(rank("Hero C").rank);
    expect(rank("Hero A").rank).toBe(top2.board.rows.filter((r) => r.top2 > 9).length + 1); // competition ranking
    const kos = await getHeroRecordsPayload(db, "KOS", "SEASON", ctxAt(WED));
    expect(kos.board.rows.map((r) => r.kos)).toEqual([...kos.board.rows.map((r) => r.kos)].sort((a, b) => b - a));
    expect(kos.board.rows[0]).toMatchObject({ name: "Hero B", kos: 28, rank: 1 }); // every win in the scenario carries one KO
    expect(kos.board.rows.find((r) => r.name === "Filler One")).toMatchObject({ kos: 9 }); // …and the one 9-KO battle
    expect(kos.board.rows.every((r) => r.prize === "0" && r.prizeStatus === "NONE" && !r.prizeEligible)).toBe(true);
    expect((await getHeroRecordsPayload(db, "KOS", "WEEKLY", ctxAt(WED))).board).toMatchObject({ scope: "WEEKLY", rules: null, rewarded: false });
  });

  it("PWR is the CURRENT power of active heroes (exact ties share a rank) — no daily / weekly figure is ever invented", async () => {
    const cast = await briefScenario();
    await db.query("update public.characters set power = case id when $1 then 500 when $2 then 500 when $3 then 300 else 100 end", [cast.A, cast.C, cast.B]);
    const { board } = await getHeroRecordsPayload(db, "PWR", "DAILY", ctxAt(WED)); // a scope is accepted and ignored: PWR has none
    expect(board).toMatchObject({ rewarded: false, rules: null, scope: "SEASON" });
    expect(board.rows.slice(0, 3).map((r) => [r.name, r.rank, r.power])).toEqual([["Hero A", 1, 500], ["Hero C", 1, 500], ["Hero B", 3, 300]]);
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [cast.A]);
    expect((await getHeroRecordsPayload(db, "PWR", "SEASON", ctxAt(WED))).board.rows.some((r) => r.name === "Hero A")).toBe(false); // PWR lists current, active heroes
  });
});

describe("SWEEP COST: the idle sweep probes the last periods; the exact full scan runs when it is due — and finds exactly what the full scan always found", () => {
  async function oneWinOn(hero: string, F: [string, string], dayIso: string): Promise<void> {
    await giveWins(db, hero, 1, `${dayIso}T09:00:00.000Z`, { filler: F });
  }
  const dailyBoards = async (): Promise<string[]> => (await db.query<{ d: string }>("select period_start::text as d from public.hero_arena_boards where kind = 'DAILY' order by 1")).map((r) => r.d);

  it("a period older than the probe window is NOT looked for on a quick second pass, and IS found by the exact scan once it is due (5 minutes later)", async () => {
    const heroes = await seedHeroOwners(db, [{ user: 801, name: "Sweep A", claimed: true }, { user: 802, name: "Fill One" }, { user: 803, name: "Fill Two" }]);
    const A = heroes.get(801)!;
    const F: [string, string] = [heroes.get(802)!, heroes.get(803)!];
    await oneWinOn(A, F, "2026-10-06");
    const t0 = utc(2026, 10, 8, 1);
    const ctx = (at: number) => ({ now: () => new Date(at), settings: settingsWith() });
    expect((await finalizeDueHeroBoards(db, ctx(t0))).periods).toContain("HERO_ARENA_DAILY:2026-10-06"); // first pass = exact scan
    // an old gap appears (a period that had been stuck behind an unsettled battle, say): 20 days older than anything the probe covers
    await oneWinOn(A, F, "2026-09-10");
    expect((await finalizeDueHeroBoards(db, ctx(t0 + 60_000))).periods).not.toContain("HERO_ARENA_DAILY:2026-09-10"); // probe only (1 minute later)
    expect(await dailyBoards()).toEqual(["2026-10-06"]);
    expect((await finalizeDueHeroBoards(db, ctx(t0 + 6 * 60_000))).periods).toContain("HERO_ARENA_DAILY:2026-09-10"); // exact scan is due again
    expect(await dailyBoards()).toEqual(["2026-09-10", "2026-10-06"]);
  });

  it("a recent period is found by the probe alone — no waiting for the exact scan", async () => {
    const heroes = await seedHeroOwners(db, [{ user: 811, name: "Probe A", claimed: true }, { user: 812, name: "Fill One" }, { user: 813, name: "Fill Two" }]);
    const A = heroes.get(811)!;
    const F: [string, string] = [heroes.get(812)!, heroes.get(813)!];
    await oneWinOn(A, F, "2026-10-06");
    const ctx = (at: number) => ({ now: () => new Date(at), settings: settingsWith() });
    // The exact scan runs on the first pass (23:58 — the day has not ended, nothing is due) …
    expect((await finalizeDueHeroBoards(db, ctx(utc(2026, 10, 6, 23, 58)))).periods).toEqual([]);
    // … so 2½ minutes later (the day has ended, the exact scan is NOT due again) it is the probe that finds the period.
    const r = await finalizeDueHeroBoards(db, ctx(utc(2026, 10, 7, 0, 0, 30)));
    expect(r.periods).toContain("HERO_ARENA_DAILY:2026-10-06");
  });

  it("a backlog of more than eight periods drains across consecutive passes (each pass freezes at most eight; the next one starts straight away)", async () => {
    const heroes = await seedHeroOwners(db, [{ user: 821, name: "Drain A", claimed: true }, { user: 822, name: "Fill One" }, { user: 823, name: "Fill Two" }]);
    const A = heroes.get(821)!;
    const F: [string, string] = [heroes.get(822)!, heroes.get(823)!];
    for (let d = 1; d <= 11; d++) await oneWinOn(A, F, `2026-09-${String(d).padStart(2, "0")}`);
    const ctx = { now: () => new Date(utc(2026, 10, 8, 1)), settings: settingsWith() };
    const first = await finalizeDueHeroBoards(db, ctx);
    expect(first.periods.filter((p) => p.startsWith("HERO_ARENA_DAILY")).length).toBe(8);
    const second = await finalizeDueHeroBoards(db, ctx); // same instant: the backlog flag makes this an exact scan
    expect(second.periods.filter((p) => p.startsWith("HERO_ARENA_DAILY")).length).toBe(3);
    expect((await dailyBoards()).length).toBe(11);
    expect(await db.query("select count(*)::int as n from public.audit_hero_arena()")).toEqual([{ n: 0 }]);
  });
});
