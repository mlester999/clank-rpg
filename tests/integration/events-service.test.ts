import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type GameSettings } from "@/domain/settings";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { finalizeHeroPeriod, listFinalizedHeroPeriods, getFrozenHeroBoard, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { getFinalBoard, listFinalizedPeriods } from "@/server/rewards/leaderboard";
import { getPickStats, listPickHistory } from "@/server/rewards/summary";
import { applyLedger } from "@/server/services/economy";
import { eventsReady, getEventsState, getPeriodDetail, listEventPeriods, resetEventsReadiness } from "@/server/services/events";
import { applyRerollPreview, previewReroll, type HeroVersioningDeps } from "@/server/services/heroVersions";
import { getLaunchPreflight, getOfficialSeasonStatus, launchSeason1, recordBackupAttestation } from "@/server/services/lifecycle";
import { getPublicHero } from "@/server/services/publicHeroes";
import { getPublicSeason } from "@/server/services/publicSeason";
import { advanceArena } from "@/server/services/arena";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { giveWins } from "../support/heroArena";
import { activeSeason, adminDeps, battleHistoryHash, freshDevelopment, heroIdentityHash } from "../support/lifecycle";
import { finalize as finalizePicks, seedScores, settingsWith, utc } from "../support/rewards";

/**
 * THE FIRST OFFICIAL PERIOD — a whole pre-season is played, Season 1 is launched, and the first official Daily and Weekly champions are crowned, all on a scratch
 * database. The point of every assertion is the same: what the PUBLIC sees as official starts at zero, what the hero IS never moves, and a champion is read from a
 * frozen result — not from anything that can change afterwards.
 */
const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
const SECRET = "test-secret-value-1234567890";
const MON = "2026-10-12";

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
  resetEventsReadiness();
  clock = new FakeClock();
});

interface Cast {
  /** Telegram member id → hero id, in creation order. */
  users: number[];
  heroes: string[];
  byUser: Map<number, string>;
}

/** Real, generated heroes (versions, appearance, stats) with a Telegram member each — what the live database holds. */
async function cast(n: number): Promise<Cast> {
  const heroes = await seedHeroes(db, n);
  const rows = await db.query<{ id: string; telegram_user_id: number }>("select id, telegram_user_id from public.characters order by created_at, id");
  const byUser = new Map(rows.map((r) => [Number(r.telegram_user_id), r.id]));
  return { users: rows.map((r) => Number(r.telegram_user_id)), heroes, byUser };
}

/** Pick prizes OFF (a pre-season finalization must not credit anything, or the launch would — rightly — refuse). */
const noPrizes = (): GameSettings => ({ ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } });
const prizes = (): GameSettings => ({ ...settingsWith(), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: true, dailyPrizePool: "10000", weeklyPrizePool: "50000" } });
const heroCtx = (settings: GameSettings, atMs: number) => ({ now: () => new Date(atMs), settings, allowDemo: true });

/** Everything a hero accumulates during the pre-season. Returns the facts the later assertions compare against. */
async function playPreSeason(c: Cast) {
  const [h0, h1, h2, , , , h6, h7] = c.heroes as [string, string, string, string, string, string, string, string];
  const filler: [string, string] = [h6, h7];
  const day = "2026-10-13";
  // hero fights (settled battles of the pre-season run): h0 wins 5, h1 wins 3 … and h0's KOs
  await giveWins(db, h0, 5, `${day}T12:00:00Z`, { filler, kos: 2 });
  await giveWins(db, h1, 3, `${day}T14:00:00Z`, { filler });
  await giveWins(db, h2, 2, `${day}T16:00:00Z`, { filler });
  // Picks: a heavy better (m0) and others, scored through the same tables the real settlement writes
  await seedScores(db, [
    { user: c.users[0]!, day, picks: 30, correct: 24 },
    { user: c.users[1]!, day, picks: 22, correct: 12 },
    { user: c.users[2]!, day, picks: 21, correct: 10 },
  ]);
  // the pre-season boards, frozen WITHOUT prizes (a credited prize would block the launch)
  const next = utc(2026, 10, 14, 1);
  expect((await finalizePicks(db, "DAILY", day, next, { settings: noPrizes() })).status).toBe("FINALIZED");
  expect((await finalizeHeroPeriod(db, heroCtx(noPrizes(), next), "DAILY", day)).status).toBe("FINALIZED");
  // personal picks: m0 has made 6 resolved Picks in the pre-season (they used to feed the personal accuracy / streak)
  const dev = (await activeSeason(db))!;
  await db.exec("alter table public.arena_picks disable trigger arena_picks_guard");
  await db.query(
    `insert into public.arena_picks (battle_id, telegram_user_id, character_id, result, settled_at, locked_at)
     select b.id, $1, p.character_id, case when row_number() over (order by b.sequence) <= 4 then 'CORRECT' else 'INCORRECT' end, b.settled_at, b.settled_at
       from public.arena_battles b join public.arena_participants p on p.battle_id = b.id and p.placement = 1 where b.season_id = $2 and b.status = 'SETTLED' order by b.sequence limit 6`,
    [c.users[0], dev.id],
  );
  await db.exec("alter table public.arena_picks enable trigger arena_picks_guard");
  // economy: Gold, loot and a battle achievement
  await applyLedger(db, { characterId: h0, amount: 750, reason: "arena", idempotencyKey: "pre-season-gold-h0" });
  await applyLedger(db, { characterId: h1, amount: 120, reason: "arena", idempotencyKey: "pre-season-gold-h1" });
  const [cls] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [h0]);
  await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true)", [h0, `${cls!.class_id}_weapon_rare`]);
  await db.query("update public.characters set arena_battles = 10, arena_wins = 5 where id = $1", [h0]);
  return { day, dev };
}

async function admin(over: Parameters<typeof adminDeps>[1] = {}) {
  return adminDeps(clock, over);
}

describe("before the launch, the Events page has nothing official to show", () => {
  it("shows no champions — the pre-season boards exist, are frozen, and are NOT official history", async () => {
    const c = await cast(10);
    await playPreSeason(c);
    expect(await count(db, "arena_leaderboards")).toBe(1);
    expect(await count(db, "hero_arena_boards")).toBe(1);

    const now = utc(2026, 10, 20, 12);
    const state = await getEventsState(db, now);
    expect(state).toMatchObject({ phase: "PRE_SEASON", season: null, seasons: [] });
    for (const program of ["picks", "hero"] as const) {
      for (const kind of ["daily", "weekly"] as const) {
        const list = await listEventPeriods(db, { program, kind, nowMs: now });
        expect(list.periods, `${program} ${kind}`).toEqual([]);
        expect(await getPeriodDetail(db, { program, kind, start: kind === "daily" ? "2026-10-13" : MON, nowMs: now })).toBeNull(); // not even by guessing the date
      }
    }
    expect(await getPublicSeason(db)).toMatchObject({ phase: "DEVELOPMENT", season: { kind: "DEVELOPMENT", label: "Pre-season" } });
  });

  it("works before migration 2700 is applied: Events simply has nothing (no error)", async () => {
    // eventsReady looks for the new tables; this suite's database has them, so prove the negative against a probe
    expect(await eventsReady(db, Date.now() + 1_000_000)).toBe(true);
  });
});

describe("the launch preflight, with real numbers", () => {
  it("counts exactly what was played, blocks without a verified backup, and clears once one is attested", async () => {
    const c = await cast(10);
    await playPreSeason(c);
    const deps = await admin({ requireBackup: true });

    const pf = await getLaunchPreflight(db, deps);
    expect(pf.facts.heroes).toMatchObject({ total: 10, eligible: 10, suspended: 0 });
    expect(pf.facts.heroes.versions).toBe(await count(db, "hero_versions"));
    expect(pf.facts.battles).toMatchObject({ settled: 10 + 0, voided: expect.any(Number), open: 0 });
    expect(pf.facts.picks.submitted).toBe(6);
    expect(pf.facts.boards).toMatchObject({ picksBoards: 1, heroBoards: 1 });
    expect(pf.facts.boards.picksResults).toBe(3);
    expect(pf.facts.boards.heroResults).toBeGreaterThanOrEqual(3);
    expect(pf.facts.economy).toMatchObject({ goldAccounts: 2, goldTotal: "870", lootItems: 1 });
    expect(pf.ready).toBe(false);
    expect(pf.unsafe.join(" ")).toMatch(/backup/i);
    expect(pf.backup).toMatchObject({ required: true, satisfied: false });

    // the launch itself refuses, by name, and changes nothing
    const before = await heroIdentityHash(db);
    await expect(launchSeason1(db, deps, LAUNCH)).rejects.toMatchObject({ code: "PREFLIGHT_BACKUP" });
    expect((await activeSeason(db))!.kind).toBe("DEVELOPMENT");
    expect(await heroIdentityHash(db)).toEqual(before);

    // an unverified attestation does not count; a verified one does
    await recordBackupAttestation(db, deps, { reference: "dump clank-pre-launch.sql sha256:abc123", verified: false });
    expect((await getLaunchPreflight(db, deps)).ready).toBe(false);
    const att = await recordBackupAttestation(db, deps, { reference: "dump clank-pre-launch.sql sha256:abc123", verified: true, notes: "restored into a scratch project" });
    expect(att.schemaVersion).toMatch(/^\d{14}$/);
    const ready = await getLaunchPreflight(db, deps);
    expect(ready.ready).toBe(true);
    expect(ready.backup).toMatchObject({ satisfied: true });
    expect(await count(db, "admin_audit_log", "action = 'LAUNCH_BACKUP_ATTESTED'")).toBe(2);
    // attestations are append-only
    await expect(db.exec("update public.launch_backup_attestations set verified = true")).rejects.toThrow(/append-only/);
    await expect(db.exec("delete from public.launch_backup_attestations")).rejects.toThrow(/append-only/);
    await expect(recordBackupAttestation(db, deps, { reference: "x", verified: true })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  });

  it("blocks while a settled battle's Picks have not been scored", async () => {
    const c = await cast(10);
    const { dev } = await playPreSeason(c);
    // a settled battle with a rewarded Pick but no scoring settlement: the settlement has not run yet
    const [b] = await db.query<{ id: string }>("select id from public.arena_battles where season_id = $1 and status = 'SETTLED' order by sequence limit 1", [dev.id]);
    await db.exec("alter table public.arena_picks disable trigger arena_picks_guard"); // (test seeding only: a resolved pick is frozen in production)
    await db.query("update public.arena_picks set reward_eligible = true where battle_id = $1", [b!.id]);
    await db.exec("alter table public.arena_picks enable trigger arena_picks_guard");
    const pf = await getLaunchPreflight(db, await admin());
    expect(pf.facts.picks.settledBattlesAwaitingScoring).toBe(1);
    expect(pf.ready).toBe(false);
    expect(pf.checks.find((x) => x.id === "PICK_SETTLEMENTS")).toMatchObject({ status: "FAIL", blocking: true });
    await expect(launchSeason1(db, await admin(), LAUNCH)).rejects.toMatchObject({ code: "PREFLIGHT_PICK_SETTLEMENTS" });
  });
});

describe("LAUNCH SEASON 1 → the first official period → the first champions", () => {
  it("the whole story", async () => {
    const c = await cast(14);
    const { day: devDay } = await playPreSeason(c);
    const heroesBefore = await heroIdentityHash(db);
    const historyBefore = await battleHistoryHash(db);
    const devPick = await getPickStats(db, c.users[0]!);
    expect(devPick).toMatchObject({ totalPicks: 6, correctPicks: 4 }); // before the launch the member's record is what they played

    // ── 1. LAUNCH ────────────────────────────────────────────────────────────────────────────────────────────────
    const first = await launchSeason1(db, await admin(), LAUNCH);
    expect(first).toMatchObject({ seasonNumber: 1, alreadyLaunched: false });
    const s1 = (await activeSeason(db))!;
    expect(s1).toMatchObject({ kind: "COMPETITIVE", number: 1, battle_counter: 0 });

    // a second request returns THE SAME launch and resets nothing
    const again = await launchSeason1(db, await admin(), LAUNCH);
    expect(again).toMatchObject({ alreadyLaunched: true, seasonId: first.seasonId, launchedAt: first.launchedAt });
    expect(again.economy).toEqual(first.economy);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(1);
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(1);

    // ── 2. what survived and what did not ───────────────────────────────────────────────────────────────────────
    expect(await heroIdentityHash(db)).toEqual(heroesBefore); // same heroes, byte for byte (class, rarity, PWR, stats, look, versions, ownership)
    expect(await battleHistoryHash(db)).toEqual(historyBefore); // no historical battle hash or result moved
    expect(await count(db, "arena_battles")).toBeGreaterThan(0); // archived, not deleted
    expect(await count(db, "arena_leaderboards")).toBe(1); // the frozen pre-season boards are still there
    // the member's Picks record begins at zero
    expect(await getPickStats(db, c.users[0]!)).toEqual({ totalPicks: 0, correctPicks: 0, accuracy: null, currentStreak: 0, bestStreak: 0 });
    expect(await listPickHistory(db, c.users[0]!, 25, Date.now())).toEqual([]);
    // Gold, loot and the career counter: all back to a clean start
    expect(await count(db, "currency_accounts", "balance <> 0")).toBe(0);
    expect(await count(db, "inventory_items", "archived_at is null")).toBe(0);
    expect((await db.query<{ arena_battles: number }>("select arena_battles from public.characters where id = $1", [c.heroes[0]]))[0]!.arena_battles).toBe(0);
    // the hero's public record is zero
    const profile = await getPublicHero(db, (await db.query<{ public_id: string }>("select public_id from public.characters where id = $1", [c.heroes[0]]))[0]!.public_id, { allowDemo: true, classes: await loadClasses(db), settings: await loadSettings(db) });
    expect(profile?.record).toMatchObject({ battles: 0, wins: 0 });
    // the Hall's history lists / by-date reads no longer show the pre-season boards
    expect(await listFinalizedPeriods(db, "DAILY")).toEqual([]);
    expect(await getFinalBoard(db, "DAILY", devDay, { nowMs: Date.now() })).toBeNull();
    expect(await listFinalizedHeroPeriods(db, "DAILY")).toEqual([]);
    expect(await getFrozenHeroBoard(db, "DAILY", devDay)).toBeNull();
    // Events: Season 1 exists, nothing has closed yet → NO CHAMPIONS YET (and no pre-season winner is backfilled)
    const t0 = Number((await db.query<{ ms: string }>("select (extract(epoch from starts_at) * 1000)::bigint::text as ms from public.seasons where id = $1", [s1.id]))[0]!.ms); // Season 1's own start, from the database clock
    const duringDay1 = await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: t0 + 3_600_000 });
    expect(duringDay1.state).toMatchObject({ phase: "SEASON_ACTIVE", season: { label: "Season 1", number: 1, status: "ACTIVE" } });
    expect(duringDay1.periods).toEqual([]);
    // the public season state says SEASON 1, with no development wording anywhere in it
    expect(JSON.stringify(await getPublicSeason(db))).not.toMatch(/development|test|beta/i);

    // ── 3. the Arena is started properly and cannot resume an old battle ────────────────────────────────────────
    expect(await count(db, "arena_battles", `season_id = '${s1.id}'`)).toBe(0);
    for (let i = 0; i < 5; i++) await advanceArena(db, arenaCtx(clock)); // a stale worker's ticks: the Arena is NOT_STARTED, nothing is written
    expect(await count(db, "arena_battles", `season_id = '${s1.id}'`)).toBe(0);

    // ── 4. the first official period: the launch day ────────────────────────────────────────────────────────────
    const launchDay = new Date(t0).toISOString().slice(0, 10);
    const dayMs = Date.parse(`${launchDay}T00:00:00Z`);
    const monday = new Date(dayMs - ((new Date(dayMs).getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const [m0, m1, m2, m3, m4] = c.users as [number, number, number, number, number];
    const [h0, , , h3, h4, , h6, h7] = c.heroes as [string, string, string, string, string, string, string, string];
    // Arena Picks: m2 is the best ELIGIBLE player (18 of 25 correct); m4 led the raw board with 19 of 19 but did not reach the 20-Pick minimum; m0/m1 tie at 12 of 20
    await seedScores(db, [
      { user: m2, day: launchDay, picks: 25, correct: 18 },
      { user: m4, day: launchDay, picks: 19, correct: 19 },
      { user: m0, day: launchDay, picks: 20, correct: 12 },
      { user: m1, day: launchDay, picks: 20, correct: 12 },
      { user: m3, day: launchDay, picks: 21, correct: 5 },
    ]);
    // Hero Arena: h3 wins 4, h4 wins 2 — and h0 (the pre-season's star, 5 wins back then) wins 1 now
    await giveWins(db, h3, 4, `${launchDay}T10:00:00Z`, { filler: [h6, h7], kos: 3 });
    await giveWins(db, h4, 2, `${launchDay}T13:00:00Z`, { filler: [h6, h7] });
    await giveWins(db, h0, 1, `${launchDay}T15:00:00Z`, { filler: [h6, h7] });

    // Season 1's own numbers: the pre-season's 5 wins are nowhere in it
    const status = await getOfficialSeasonStatus(db, dayMs + 86_400_000 + 3_600_000);
    expect(status).toMatchObject({ season: { label: "Season 1" }, officialMatches: 7, heroesWithRecords: 5 });
    const h0Record = await db.query<{ wins: number; battles: number }>("select wins, battles from public.season_character_stats where season_id = $1 and character_id = $2", [s1.id, h0]);
    expect(h0Record[0]).toMatchObject({ wins: 1, battles: 1 });

    // ── 5. finalize the DAILY boards of the launch day (with prizes ON) ─────────────────────────────────────────
    const closed = dayMs + 86_400_000 + 3_600_000;
    expect((await finalizePicks(db, "DAILY", launchDay, closed, { settings: prizes() })).status).toBe("FINALIZED");
    expect((await finalizeHeroPeriod(db, heroCtx(prizes(), closed), "DAILY", launchDay)).status).toBe("FINALIZED");

    const now = dayMs + 3 * 86_400_000 + 6 * 3_600_000; // three days later
    const daily = await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: now });
    expect(daily.state.phase).toBe("SEASON_ACTIVE");
    expect(daily.periods.map((p) => p.start)).toEqual([0, 1, 2].map((i) => new Date(dayMs + (2 - i) * 86_400_000).toISOString().slice(0, 10)));
    expect(daily.periods.map((p) => p.outcome)).toEqual(["NO_COMPLETED_RESULTS", "NO_COMPLETED_RESULTS", "CHAMPION"]); // empty days are said, not filled
    const day1 = daily.periods.at(-1)!;
    expect(day1.champions).toHaveLength(1);
    const champ = day1.champions[0]!;
    expect(champ).toMatchObject({ program: "picks", rank: 2, prizeRank: 1, points: 180, picks: 25, correctPicks: 18, prizeEligible: true, accuracy: 72 }); // #1 among those who QUALIFY; #2 on the raw board
    expect(champ.allocation).toMatchObject({ status: "ALLOCATED", amount: "150,000", symbol: "$CLANKRPG" }); // 30% of the 500,000 fixture pool, an ALLOCATION
    expect(champ.art).not.toBeNull(); // the hero as it was, rendered from the snapshot
    expect(champ.power).toBeGreaterThan(0);
    // the raw leader (19/19) is said plainly and is NOT a champion or a prize winner
    expect(day1.leader).toMatchObject({ picks: 19, correctPicks: 19, minimum: 20 });
    expect(day1.participants).toBe(5);
    expect(day1.eligibleParticipants).toBe(4);
    // full results: Top 10 in the real rank order, the below-minimum leader marked, prizes only for eligible positions
    const detail = (await getPeriodDetail(db, { program: "picks", kind: "daily", start: launchDay, nowMs: now }))!;
    expect(detail.standings.map((r) => [r.rank, r.program === "picks" ? r.correctPicks : -1])).toEqual([[1, 19], [2, 18], [3, 12], [3, 12], [5, 5]]);
    const leaderRow = detail.standings[0]!;
    expect(leaderRow).toMatchObject({ prizeEligible: false, allocation: { status: "NONE" } });
    expect(detail.standings[1]).toMatchObject({ prizeEligible: true, allocation: { status: "ALLOCATED", amount: "150,000" } });
    expect(detail.standings.filter((r) => r.rank === 3).every((r) => r.tied && r.allocation.status === "ALLOCATED")).toBe(true); // the tie shares positions 2+3's prizes
    expect(JSON.stringify(detail)).not.toMatch(/telegram|wallet|owner|"userId"|review/i);

    // Hero Arena: h3 is the champion with 4 wins (and the ordering is wins-only)
    const heroDaily = await listEventPeriods(db, { program: "hero", kind: "daily", nowMs: now });
    expect(heroDaily.periods.at(-1)!.outcome).toBe("CHAMPION");
    const hero = heroDaily.periods.at(-1)!.champions[0]!;
    expect(hero).toMatchObject({ program: "hero", rank: 1, wins: 4, kos: 12, matches: 4 });
    expect(hero.allocation.status).toBe("ALLOCATED"); // the pool was set for this period (10,000 daily); a non-claimed hero's prize is RESERVED but still an allocation
    const heroDetail = (await getPeriodDetail(db, { program: "hero", kind: "daily", start: launchDay, nowMs: now }))!;
    expect(heroDetail.standings.slice(0, 3).map((r) => [r.rank, r.name === "" ? "" : (r as { wins: number }).wins])).toEqual([[1, 4], [2, 2], [3, 1]]);
    // the pre-season's star (5 wins in the pre-season) is rank 3 here, with 1 win: nothing carried over
    expect(heroDetail.standings.find((r) => (r as { wins: number }).wins === 5)).toBeUndefined();

    // ── 6. finalization is idempotent and late results cannot change a frozen champion ─────────────────────────
    const ledgerBefore = await count(db, "arena_reward_ledger");
    const snapsBefore = await count(db, "arena_leaderboard_result_snapshots");
    expect((await finalizePicks(db, "DAILY", launchDay, closed, { settings: prizes() })).status).toBe("ALREADY_FINALIZED");
    expect((await finalizeHeroPeriod(db, heroCtx(prizes(), closed), "DAILY", launchDay)).status).toBe("ALREADY_FINALIZED");
    expect(await count(db, "arena_reward_ledger")).toBe(ledgerBefore); // no payout duplication
    expect(await count(db, "arena_leaderboard_result_snapshots")).toBe(snapsBefore);
    await expect(seedScores(db, [{ user: m3, day: launchDay, picks: 30, correct: 30 }])).rejects.toThrow(/already finalized/i); // a late score is refused by the database
    expect((await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: now })).periods.at(-1)!.champions[0]).toEqual(champ);

    // ── 7. a later reroll never rewrites a past champion ─────────────────────────────────────────────────────────
    const championHero = c.byUser.get((await db.query<{ telegram_user_id: number }>("select r.telegram_user_id from public.arena_leaderboard_results r where r.kind = 'DAILY' and r.period_start = $1::date and r.rank = 2", [launchDay]))[0]!.telegram_user_id)!;
    const heroOfWinnerBefore = heroDaily.periods.at(-1)!.champions[0]!;
    const versioning: HeroVersioningDeps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: SECRET, now: clock.now };
    for (const id of [championHero, h3]) {
      const p = await previewReroll(db, id, "admin", versioning);
      await applyRerollPreview(db, id, p.previewId, "admin", versioning);
    }
    const afterReroll = await listEventPeriods(db, { program: "hero", kind: "daily", nowMs: now });
    expect(afterReroll.periods.at(-1)!.champions[0]).toEqual(heroOfWinnerBefore); // identical: art, rarity, PWR, version number
    expect((await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: now })).periods.at(-1)!.champions[0]).toEqual(champ);
    expect((await db.query("select * from public.audit_event_champions()"))).toEqual([]);
    expect((await db.query("select * from public.audit_launch_isolation()"))).toEqual([]);

    // ── 8. the WEEKLY boards close on the Monday boundary ───────────────────────────────────────────────────────
    const nextMonday = Date.parse(`${monday}T00:00:00Z`) + 7 * 86_400_000;
    const afterWeek = nextMonday + 2 * 3_600_000;
    const weeklyBefore = await listEventPeriods(db, { program: "picks", kind: "weekly", nowMs: nextMonday - 1 });
    expect(weeklyBefore.periods).toEqual([]); // not complete one millisecond before the boundary
    // the weekly minimum is 100 valid Picks and nobody made that many in the launch week
    expect((await finalizePicks(db, "WEEKLY", monday, afterWeek, { settings: prizes() })).status).toBe("FINALIZED");
    expect((await finalizeHeroPeriod(db, heroCtx(prizes(), afterWeek), "WEEKLY", monday)).status).toBe("FINALIZED");
    const weekly = await listEventPeriods(db, { program: "picks", kind: "weekly", nowMs: afterWeek });
    expect(weekly.periods.length).toBeGreaterThanOrEqual(1);
    const w = weekly.periods.find((p) => p.start === monday)!;
    expect(w.outcome).toBe("NO_ELIGIBLE_WINNER"); // nobody reached 100 valid picks that week: said plainly, no champion invented
    expect(w.champions).toEqual([]);
    expect(w.leader).toMatchObject({ minimum: 100 });
    const heroWeekly = (await listEventPeriods(db, { program: "hero", kind: "weekly", nowMs: afterWeek })).periods.find((p) => p.start === monday)!;
    expect(heroWeekly.outcome).toBe("CHAMPION");
    expect(heroWeekly.champions[0]).toMatchObject({ program: "hero", wins: 4, rank: 1 }); // only Season 1's wins: the pre-season's 5 are not in the week
    // pagination: one at a time, every period exactly once, oldest ends the chain
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page = await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: now, limit: 1, before });
      seen.push(...page.periods.map((p) => p.start));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(seen).toEqual(daily.periods.map((p) => p.start));
    // unknown / foreign periods are not Events results
    for (const bad of [devDay, "2026-09-01", "2999-01-01", "not-a-date"]) expect(await getPeriodDetail(db, { program: "picks", kind: "daily", start: bad, nowMs: now }), bad).toBeNull();
    expect(await getPeriodDetail(db, { program: "picks", kind: "weekly", start: launchDay === monday ? "2026-10-13" : launchDay, nowMs: now })).toBeNull(); // not a Monday
  });
});
