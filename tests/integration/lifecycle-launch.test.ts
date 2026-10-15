import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, replayBattle } from "@/server/services/arena";
import { getHeroDetail } from "@/server/services/heroAdmin";
import { AdminError } from "@/server/services/adminError";
import { patchHero } from "@/server/services/admin";
import { getLeaderboard } from "@/server/services/leaderboard";
import { createNextSeason, endSeason, getGameControl, heroFingerprint, launchSeason1, pauseArena, resetDevelopment, startArena } from "@/server/services/lifecycle";
import { getPublicHero, listPublicHeroes } from "@/server/services/publicHeroes";
import { arenaOps } from "@/server/services/arenaOps";
import { getArenaState, getCharacterDto } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { activeSeason, adminDeps, arenaStatus, battleHistoryHash, battleNumbers, freshDevelopment, gamePhase, heroIdentityHash, idleFor, runUntil } from "../support/lifecycle";

/**
 * DEVELOPMENT → SEASON 1. The heroes are exactly what they were; the competitive records start at zero; the Arena is NOT STARTED until START is pressed.
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

const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AdminError ? e.code : `ERROR:${(e as Error).message}`;
  }
};

interface Dev {
  heroes: string[];
  a: string;
  b: string;
  c: string;
  devSeasonId: string;
}

/** A realistic DEVELOPMENT state: Battle #847 and beyond, test records on heroes A and B, hero C suspended, the Arena paused and drained. */
async function developmentRun(opts: { heroes?: number; battles?: number } = {}): Promise<Dev> {
  const heroes = await seedHeroes(db, opts.heroes ?? 18);
  const [a, b, c] = heroes as [string, string, string];
  await patchHero(db, c, { status: "SUSPENDED" }, "test-admin");
  const dev = (await activeSeason(db))!;
  await db.query("update public.seasons set battle_counter = 846 where id = $1", [dev.id]); // the next public number is #847
  await startArena(db, adminDeps(clock));
  await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= (opts.battles ?? 4));
  await pauseArena(db, adminDeps(clock));
  await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
  // Test records: A = 80 matches / 50 wins, B = 30 / 10 (the lifetime career counters carry the same figures)
  for (const [id, matches, wins] of [[a, 80, 50], [b, 30, 10]] as const) {
    await db.query(
      `insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations) values ($1, $2, $3, $4, $5, $6, 20)
       on conflict (season_id, character_id) do update set points = excluded.points, battles = excluded.battles, wins = excluded.wins, top2 = excluded.top2, eliminations = excluded.eliminations`,
      [dev.id, id, wins * 20, matches, wins, wins + 5],
    );
    await db.query("update public.characters set arena_battles = $2, arena_wins = $3, arena_top2 = $4 where id = $1", [id, matches, wins, wins + 5]);
  }
  return { heroes, a, b, c, devSeasonId: dev.id };
}

const ctxFor = async () => ({ allowDemo: true, classes: await loadClasses(db, false), settings: await loadSettings(db) });

describe("LAUNCH SEASON 1 — the scratch scenario", () => {
  it("Development (Battle #847, A: 80 matches / 50 wins, B: 30 / 10, C suspended) → LIVE, Season 1, Arena NOT_STARTED, every hero exactly as it was, records at zero", async () => {
    const dev = await developmentRun();
    const devNumbers = await battleNumbers(db, dev.devSeasonId);
    expect(devNumbers[0]).toBe(847); // the development run's public numbers are in the hundreds…
    const lastDevNumber = devNumbers.at(-1)!;

    const settings = await loadSettings(db);
    const publicA = (await getPublicHero(db, (await db.query<{ public_id: string }>("select public_id from public.characters where id = $1", [dev.a]))[0]!.public_id, await ctxFor()))!;
    expect(publicA.record).toMatchObject({ battles: 80, wins: 50 }); // the development run's record is what the hero page shows today
    expect(publicA.season).toMatchObject({ kind: "DEVELOPMENT", label: "Pre-season" });

    // ── freeze: everything that must NOT change ──────────────────────────────────────────────────────────────────────
    const identityBefore = await heroIdentityHash(db);
    const fingerprintBefore = await heroFingerprint(db);
    const historyBefore = await battleHistoryHash(db);
    const versionsBefore = await count(db, "hero_versions");
    const battlesBefore = await count(db, "arena_battles");
    const detailBefore = await Promise.all(dev.heroes.map((id) => getHeroDetail(db, id)));
    const rowsBefore = async (id: string) => JSON.stringify((await db.query("select c.id, c.public_id, c.telegram_user_id, c.class_id, c.power, c.name, c.status, ca.rarity, ca.parts, ca.sprite, ca.seed, cs.variation from public.characters c join public.character_appearances ca on ca.character_id = c.id join public.character_stats cs on cs.character_id = c.id where c.id = $1", [id]))[0]);
    const aRowBefore = await rowsBefore(dev.a);
    const bRowBefore = await rowsBefore(dev.b);
    const cRowBefore = await rowsBefore(dev.c);

    // ── LAUNCH ──────────────────────────────────────────────────────────────────────────────────────────────────────
    const launched = await launchSeason1(db, adminDeps(clock), LAUNCH);
    expect(launched.seasonNumber).toBe(1);

    expect(await gamePhase(db)).toBe("LIVE");
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    const s1 = (await activeSeason(db))!;
    expect(s1).toMatchObject({ kind: "COMPETITIVE", number: 1, name: "Season 1", battle_counter: 0 });
    expect(s1.id).toBe(launched.seasonId);
    const [game] = await db.query<{ phase: string; launched_at: Date; launch_season_id: string; launched_by: string }>("select phase, launched_at, launch_season_id, launched_by from public.game_state");
    expect(game).toMatchObject({ phase: "LIVE", launch_season_id: s1.id, launched_by: "test-admin" });
    expect(game!.launched_at).toBeTruthy();

    // the development run is ARCHIVED, not deleted
    const [devRow] = await db.query<{ status: string; ended_reason: string; battle_counter: number; kind: string; archive: { lastBattleNumber: number; battlesSettled: number; heroesWithRecords: number } }>(
      "select status, ended_reason, battle_counter, kind, archive from public.seasons where id = $1", [dev.devSeasonId],
    );
    expect(devRow).toMatchObject({ status: "ENDED", ended_reason: "LAUNCH", kind: "DEVELOPMENT", battle_counter: lastDevNumber });
    expect(devRow!.archive).toMatchObject({ lastBattleNumber: lastDevNumber });
    expect(devRow!.archive.battlesSettled).toBe(devNumbers.length);
    expect(await count(db, "arena_battles")).toBe(battlesBefore);
    expect(await battleHistoryHash(db)).toBe(historyBefore); // results, snapshots, hashes: not a byte moved
    expect(await battleNumbers(db, dev.devSeasonId)).toEqual(devNumbers);
    expect(await count(db, "season_character_stats", `season_id = '${dev.devSeasonId}'`)).toBeGreaterThan(0);

    // ── HEROES: preserved to the byte ────────────────────────────────────────────────────────────────────────────────
    expect(await heroIdentityHash(db)).toEqual(identityBefore);
    expect(await heroFingerprint(db)).toEqual(fingerprintBefore);
    expect(await count(db, "hero_versions")).toBe(versionsBefore); // launching is NOT a reroll: no new version
    expect(await rowsBefore(dev.a)).toBe(aRowBefore);
    expect(await rowsBefore(dev.b)).toBe(bRowBefore);
    expect(await rowsBefore(dev.c)).toBe(cRowBefore);
    const detailAfter = await Promise.all(dev.heroes.map((id) => getHeroDetail(db, id)));
    for (const [i, before] of detailBefore.entries()) {
      const after = detailAfter[i]!;
      expect({ ...after, season: null, career: null }).toEqual({ ...before!, season: null, career: null }); // identity: nothing but the season figures differs
      // the lifetime career counters start clean for Season 1 (development progress does not carry); the development totals stay in the development season's stats rows
      expect(after.career).toEqual({ battles: 0, wins: 0, top2: 0 });
    }

    // ── SEASON RECORDS: zero ─────────────────────────────────────────────────────────────────────────────────────────
    const heroA = (await getCharacterDto(db, dev.a, settings, null))!;
    expect(heroA.record).toMatchObject({ battles: 0, wins: 0, top2: 0, eliminations: 0 });
    expect(heroA.season).toMatchObject({ kind: "COMPETITIVE", number: 1, label: "Season 1", battles: 0, wins: 0, points: 0, ranked: false, rank: { name: "Unranked" } });
    const heroB = (await getCharacterDto(db, dev.b, settings, null))!;
    expect(heroB.season).toMatchObject({ battles: 0, wins: 0, ranked: false, rank: { name: "Unranked" } });
    const publicAAfter = (await getPublicHero(db, publicA.card.publicId, await ctxFor()))!;
    // the very same card — class, rarity, PWR, stats, look — except the season rank it shows, which is season PERFORMANCE (Gold in the test run, Unranked now)
    expect({ ...publicAAfter.card, seasonRank: null }).toEqual({ ...publicA.card, seasonRank: null });
    expect(publicA.card.seasonRank).toBe("Gold");
    expect(publicAAfter.card.seasonRank).toBe("Unranked");
    expect(publicAAfter.record).toEqual({ battles: 0, wins: 0, top2: 0, eliminations: 0 });
    expect(publicAAfter.season).toMatchObject({ label: "Season 1", rank: "Unranked", ranked: false, points: 0 });
    expect(publicAAfter.recentBattles).toEqual([]); // the profile lists this season's fights only
    const adminA = (await getHeroDetail(db, dev.a))!;
    expect(adminA.season).toMatchObject({ label: "Season 1", matches: 0, wins: 0, winRate: null, points: 0 });
    expect(adminA.career).toMatchObject({ battles: 0, wins: 0 }); // the career counters restart too — the 80 / 50 stay in the development season's own stats rows
    expect(adminA.arenaEligible).toBe(true);
    // C: still there, still suspended, still not eligible
    const adminC = (await getHeroDetail(db, dev.c))!;
    expect(adminC).toMatchObject({ status: "SUSPENDED", arenaEligible: false });
    expect(await rowsBefore(dev.c)).toBe(cRowBefore);
    for (const board of ["WINS", "TOP2", "KOS", "SEASON_POINTS", "SEASON_WINS"] as const) expect(await getLeaderboard(db, board, { allowDemo: true, seasonId: s1.id }), board).toEqual([]);

    // ── PUBLIC STATE: live, but nothing running ──────────────────────────────────────────────────────────────────────
    const state = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
    expect(state).toMatchObject({ status: "NOT_STARTED", phase: "LIVE", pausing: false, current: null, upcoming: null, next: null, recent: [], season: { kind: "COMPETITIVE", number: 1, label: "Season 1" } });
    expect(await count(db, "arena_battles", `season_id = '${s1.id}'`)).toBe(0); // no Battle #1 yet

    // ── the admin's own view ─────────────────────────────────────────────────────────────────────────────────────────
    const control = await getGameControl(db, adminDeps(clock));
    expect(control).toMatchObject({
      phase: "LIVE",
      season: { label: "Season 1", kind: "COMPETITIVE" },
      arena: { status: "NOT_STARTED" },
      heroes: { total: 18, eligible: 17, suspended: 1 },
      battles: { current: null, next: null, last: 0, nextToIssue: 1 },
    });
    expect(control.actions.launch.allowed).toBe(false);
    expect(control.actions.launch.blockers[0]!.code).toBe("ALREADY_LIVE");
    expect(control.actions.startArena.allowed).toBe(true);
    expect(control.actions.resetDevelopment.allowed).toBe(false);
    expect(control.actions.resetDevelopment.blockers[0]!.code).toBe("LIVE_RESET_FORBIDDEN");
    expect(control.actions.endSeason.allowed).toBe(true);
    const ops = await arenaOps(db, { now: clock.ms, allowDemo: true, groupSize: 8 });
    expect(ops).toMatchObject({ status: "NOT_STARTED", phase: "LIVE", season: { label: "Season 1" } });
    expect(ops.integrity.every((i) => i.ok), JSON.stringify(ops.integrity)).toBe(true);
    expect((await db.query("select * from public.audit_game_lifecycle()")).length).toBe(0);

    // ── the audit trail ──────────────────────────────────────────────────────────────────────────────────────────────
    const [audit] = await db.query<{ actor: string; detail: { previous: { phase: string; arenaStatus: string }; next: { phase: string; arenaStatus: string; season: { label: string } }; heroes: { total: number; eligible: number; suspended: number } } }>(
      "select actor, detail from public.admin_audit_log where action = 'GAME_LAUNCH'",
    );
    expect(audit).toMatchObject({ actor: "test-admin", detail: { previous: { phase: "DEVELOPMENT", arenaStatus: "PAUSED" }, next: { phase: "LIVE", arenaStatus: "NOT_STARTED", season: { label: "Season 1" } }, heroes: { total: 18, eligible: 17, suspended: 1 } } });
  });

  it("with the Arena worker running the whole time: no battle for as long as it waits — then START ARENA brings Battle #1, and only that", async () => {
    const dev = await developmentRun({ battles: 3 });
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const s1 = (await activeSeason(db))!;

    // "wait long enough that it would normally create battles"
    await idleFor(db, clock, 1800);
    expect(await count(db, "arena_battles", `season_id = '${s1.id}'`)).toBe(0);
    expect(await count(db, "arena_cycles", "status = 'ACTIVE'")).toBe(0);
    expect(await arenaStatus(db)).toBe("NOT_STARTED");

    await startArena(db, adminDeps(clock));
    expect(await arenaStatus(db)).toBe("PREPARING");
    await advanceArena(db, arenaCtx(clock));
    expect(await arenaStatus(db)).toBe("RUNNING");
    expect((await battleNumbers(db, s1.id)).slice(0, 3)).toEqual([1, 2, 3]);
    expect(await count(db, "arena_battles", `season_id = '${s1.id}' and season_sequence = 1`)).toBe(1);

    // Battle #1 → #2 → #3 → … continuously, with the dev numbers untouched underneath
    await runUntil(db, clock, async () => (await count(db, "arena_battles", `season_id = '${s1.id}' and status = 'SETTLED'`)) >= 6);
    const numbers = await battleNumbers(db, s1.id);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    const devMax = Math.max(...(await battleNumbers(db, dev.devSeasonId)));
    expect(devMax).toBeGreaterThanOrEqual(847);
    // internal identity never reset: the global sequence keeps climbing past the development run's
    const minS1Seq = Number((await db.query<{ n: number }>("select min(sequence)::int as n from public.arena_battles where season_id = $1", [s1.id]))[0]!.n);
    const maxDevSeq = Number((await db.query<{ n: number }>("select max(sequence)::int as n from public.arena_battles where season_id = $1", [dev.devSeasonId]))[0]!.n);
    expect(minS1Seq).toBeGreaterThan(maxDevSeq);

    // After the first fights every fighter has exactly the matches it played — records started from zero
    const rows = await db.query<{ battles: number; wins: number }>("select battles, wins from public.season_character_stats where season_id = $1", [s1.id]);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.every((r) => r.battles >= 1)).toBe(true);
    const settledS1 = await count(db, "arena_battles", `season_id = '${s1.id}' and status = 'SETTLED'`);
    expect(rows.reduce((n, r) => n + Number(r.battles), 0)).toBe(settledS1 * 8);
    expect(rows.reduce((n, r) => n + Number(r.wins), 0)).toBe(settledS1);
    // The suspended hero C never fought in Season 1 — nor in the development run after it was suspended
    expect(await count(db, "arena_participants", `character_id = '${dev.c}'`)).toBe(0);
    // Hero A's lifetime career restarted at the launch: it is exactly what it fought in Season 1
    const careerA = (await db.query<{ arena_battles: number }>("select arena_battles from public.characters where id = $1", [dev.a]))[0]!.arena_battles;
    const s1A = Number((await db.query<{ battles: number }>("select coalesce(sum(battles), 0)::int as battles from public.season_character_stats where season_id = $1 and character_id = $2", [s1.id, dev.a]))[0]!.battles);
    expect(careerA).toBe(s1A);
    expect((await getCharacterDto(db, dev.a, await loadSettings(db), null))!.record.battles).toBe(s1A);
  });

  it("historical replay: a development battle replays to the same hash, result and winner after the launch", async () => {
    const dev = await developmentRun({ battles: 3 });
    const [old] = await db.query<{ id: string; events_hash: string; winner_id: string; ruleset_hash: string; seed: string; snapshot: unknown; result: unknown }>(
      "select id, events_hash, winner_id, ruleset_hash, seed, snapshot, result from public.arena_battles where season_id = $1 and status = 'SETTLED' order by sequence limit 1", [dev.devSeasonId],
    );
    const before = await replayBattle(db, old!.id);
    expect(before!.outcome.eventsHash).toBe(old!.events_hash);
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    // …and the new season runs for a while on top of it
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED' and season_sequence <= 2 and season_id = (select id from public.seasons where status = 'ACTIVE')")) >= 2);
    const after = await replayBattle(db, old!.id);
    expect(after!.outcome.eventsHash).toBe(old!.events_hash);
    expect(after!.outcome.participants[after!.outcome.ranking[0]!]!.characterId).toBe(old!.winner_id);
    const [now] = await db.query<{ events_hash: string; winner_id: string; ruleset_hash: string; seed: string; snapshot: unknown; result: unknown }>("select events_hash, winner_id, ruleset_hash, seed, snapshot, result from public.arena_battles where id = $1", [old!.id]);
    expect(JSON.stringify(now)).toBe(JSON.stringify({ events_hash: old!.events_hash, winner_id: old!.winner_id, ruleset_hash: old!.ruleset_hash, seed: old!.seed, snapshot: old!.snapshot, result: old!.result }));
  });

  it("a launch from a PAUSED Arena that still holds committed battles voids them, releases their queue entries and aborts the cycle — heroes untouched", async () => {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock)); // three battles are committed (on stage + two prepared)
    expect(await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')")).toBe(3);
    await db.exec("update public.arena_state set status = 'PAUSED'"); // e.g. a pause carried over from before the lifecycle migration (paused → PAUSED)
    const identity = await heroIdentityHash(db);
    const res = await launchSeason1(db, adminDeps(clock), LAUNCH);
    expect(res.archived).toMatchObject({ battlesVoided: 3, cyclesAborted: 1, queueEntriesReleased: 24 });
    expect(await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')")).toBe(0);
    expect(await count(db, "arena_battles", "status = 'VOID'")).toBe(3);
    expect(await count(db, "arena_cycles", "status = 'ACTIVE'")).toBe(0);
    expect(await count(db, "arena_queue_entries", "status in ('PENDING', 'IN_BATTLE')")).toBe(0);
    expect(await heroIdentityHash(db)).toEqual(identity);
    const ops = await arenaOps(db, { now: clock.ms, allowDemo: true, groupSize: 8 });
    expect(ops.integrity.every((i) => i.ok), JSON.stringify(ops.integrity)).toBe(true);
    // and the new season's queue is fresh: Battle #1 is made from a new cycle
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    const s1 = (await activeSeason(db))!;
    expect((await battleNumbers(db, s1.id)).slice(0, 1)).toEqual([1]);
    expect(await count(db, "arena_cycles", "status = 'ACTIVE'")).toBe(1);
  });

  it("the Season 1 queue holds only the Arena-eligible heroes: 139 total, 18 suspended → 121, no duplicate, no hero recreated", async () => {
    const heroes = await seedHeroes(db, 139);
    const suspended = heroes.slice(0, 18);
    for (const id of suspended) await patchHero(db, id, { status: "SUSPENDED" }, "test-admin");
    const identity = await heroIdentityHash(db);
    expect(identity.heroes).toBe(139);
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await count(db, "characters")).toBe(139); // nobody recreated
    const control = await getGameControl(db, adminDeps(clock));
    expect(control.heroes).toMatchObject({ total: 139, eligible: 121, suspended: 18 });

    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    const [cycle] = await db.query<{ id: string; hero_count: number }>("select id, hero_count from public.arena_cycles where status = 'ACTIVE'");
    expect(cycle!.hero_count).toBe(121);
    const queue = await db.query<{ character_id: string }>("select character_id from public.arena_queue_entries where cycle_id = $1", [cycle!.id]);
    expect(queue).toHaveLength(121);
    expect(new Set(queue.map((q) => q.character_id)).size).toBe(121); // each eligible hero exactly once
    for (const id of suspended) expect(queue.some((q) => q.character_id === id)).toBe(false);
    const fighters = await db.query<{ battle_id: string; n: number; distinct_n: number }>("select battle_id, count(*)::int as n, count(distinct character_id)::int as distinct_n from public.arena_participants group by battle_id");
    expect(fighters.every((f) => f.n === 8 && f.distinct_n === 8)).toBe(true);
    for (const id of suspended) expect(await count(db, "arena_participants", `character_id = '${id}'`)).toBe(0);
    // the directory still lists the active heroes only, as before (a suspended hero is simply not public)
    const page = await listPublicHeroes(db, { limit: 48 }, await ctxFor());
    expect(page.total).toBe(121);
  });
});

describe("a new hero after Season 1 has started", () => {
  it("is created by the normal generator, starts at 0 matches / 0 wins, joins a FUTURE cycle through the ordinary queue — and the season is not restarted", async () => {
    await developmentRun({ battles: 2 });
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    await startArena(db, adminDeps(clock));
    const s1 = (await activeSeason(db))!;
    await runUntil(db, clock, async () => (await count(db, "arena_battles", `season_id = '${s1.id}' and status = 'SETTLED'`)) >= 3);
    const numbersBefore = await battleNumbers(db, s1.id);

    const [fresh] = await seedHeroes(db, 1); // a member who just reached the threshold: the authoritative generator, hero version v1 INITIAL
    expect(await count(db, "hero_versions", `character_id = '${fresh}'`)).toBe(1);
    expect(await count(db, "hero_versions", `character_id = '${fresh}' and action = 'INITIAL' and version_number = 1`)).toBe(1);
    const record = (await getCharacterDto(db, fresh!, await loadSettings(db), null))!;
    expect(record.record).toMatchObject({ battles: 0, wins: 0 });
    expect(record.season).toMatchObject({ label: "Season 1", ranked: false, rank: { name: "Unranked" } });
    expect(await count(db, "arena_participants", `character_id = '${fresh}'`)).toBe(0); // not injected into any roster that already exists

    // the ordinary queue takes it in at the next cycle that is planned — no restart, no special case
    await runUntil(db, clock, async () => (await count(db, "arena_participants", `character_id = '${fresh}'`)) >= 1, { maxSeconds: 8000 });
    expect((await activeSeason(db))!.id).toBe(s1.id); // the same season
    const numbers = await battleNumbers(db, s1.id);
    expect(numbers.slice(0, numbersBefore.length)).toEqual(numbersBefore);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1)); // numbering carried on, gapless
    expect(await count(db, "arena_cycles", `season_id = '${s1.id}'`)).toBeGreaterThanOrEqual(2);
  });
});

describe("the launch is deliberate, one-way and exactly once", () => {
  it("needs the exact typed phrase (checked by the server): nothing changes without it", async () => {
    await seedHeroes(db, 16);
    for (const wrong of ["", "launch season 1", "LAUNCH SEASON", "RESET ARENA", "LAUNCH SEASON 1 NOW"]) {
      expect(await code(launchSeason1(db, adminDeps(clock), { confirmation: wrong })), JSON.stringify(wrong)).toBe("CONFIRMATION_REQUIRED");
    }
    expect(await gamePhase(db)).toBe("DEVELOPMENT");
    expect(await count(db, "seasons")).toBe(1);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(0);
  });

  it("three launches at once: exactly one Season 1 is created; the others get that same launch back and reset nothing", async () => {
    await seedHeroes(db, 16);
    const outcomes = await Promise.all([launchSeason1(db, adminDeps(clock), LAUNCH), launchSeason1(db, adminDeps(clock), LAUNCH), launchSeason1(db, adminDeps(clock), LAUNCH)]);
    expect(outcomes.filter((r) => !r.alreadyLaunched)).toHaveLength(1);
    expect(outcomes.filter((r) => r.alreadyLaunched)).toHaveLength(2);
    expect(new Set(outcomes.map((r) => r.seasonId)).size).toBe(1); // everyone is told about the SAME Season 1
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(1);
    expect(await count(db, "seasons", "status = 'ACTIVE'")).toBe(1);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(1);
  });

  it("LIVE is one-way: no code path and no SQL goes back to DEVELOPMENT, rewrites the launch, deletes or reopens a season", async () => {
    await seedHeroes(db, 16);
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const again = await launchSeason1(db, adminDeps(clock), LAUNCH);
    expect(again.alreadyLaunched).toBe(true); // a second request returns the launch that happened — it does not reset Season 1 again
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(1);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(1);
    expect(await code(resetDevelopment(db, adminDeps(clock), { confirmation: "RESET ARENA" }))).toBe("LIVE_RESET_FORBIDDEN");
    await expect(db.exec("update public.game_state set phase = 'DEVELOPMENT'")).rejects.toThrow(/cannot go back to DEVELOPMENT/);
    await expect(db.exec("update public.game_state set launched_at = now() - interval '1 year'")).rejects.toThrow(/launch record is permanent/);
    await expect(db.exec("delete from public.game_state")).rejects.toThrow(/permanent/);
    await expect(db.exec("delete from public.seasons")).rejects.toThrow(/never deleted/);
    await expect(db.exec("update public.seasons set kind = 'DEVELOPMENT', run_number = 9, number = null where kind = 'COMPETITIVE'")).rejects.toThrow(/permanent/);
    await expect(db.exec("update public.seasons set status = 'ACTIVE' where kind = 'DEVELOPMENT'")).rejects.toThrow(/reopened|only one|unique|LIVE/i);
    await expect(db.query("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 9, 'sneaky', 'ENDED')")).resolves.toBeDefined(); // an archived row is harmless…
    await expect(db.query("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 10, 'sneakier', 'ACTIVE')")).rejects.toThrow(/LIVE|one ACTIVE|unique/i); // …an active development season is not
    expect((await db.query("select * from public.audit_game_lifecycle() where problem <> 'LIVE_WITH_ACTIVE_DEVELOPMENT_SEASON'")).length).toBe(0);
  });

  it("refuses while the Arena is running, and also refuses when real reward obligations exist — until they are reversed", async () => {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    expect(await code(launchSeason1(db, adminDeps(clock), LAUNCH))).toBe("ARENA_NOT_STOPPED");
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");

    const { seedEligibleMember } = await import("../support/db");
    const { adminAdjust } = await import("@/server/rewards/admin");
    const member = await seedEligibleMember(db);
    await adminAdjust(db, { userId: member, amount: "5", direction: "credit", reason: "test credit", key: "launch-test-1" }, "admin");
    expect(await code(launchSeason1(db, adminDeps(clock), LAUNCH))).toBe("REWARD_LIABILITIES");
    expect(await code(resetDevelopment(db, adminDeps(clock), { confirmation: "RESET ARENA" }))).toBe("REWARD_LIABILITIES");
    expect(await gamePhase(db)).toBe("DEVELOPMENT");
    const control = await getGameControl(db, adminDeps(clock));
    expect(control.rewards).toMatchObject({ checked: true, blocking: true, claimableMicro: "5000000" });
    expect(control.actions.launch.blockers.map((b) => b.code)).toContain("REWARD_LIABILITIES");

    await adminAdjust(db, { userId: member, amount: "5", direction: "debit", reason: "reverse the test credit", key: "launch-test-2" }, "admin");
    expect((await getGameControl(db, adminDeps(clock))).rewards.blocking).toBe(false);
    expect(await code(launchSeason1(db, adminDeps(clock), LAUNCH))).toBe("OK");
  });

  it("the fingerprint tripwire covers a hero's immutable identity — a reroll (a new hero version) moves it, battles and moderation do not — and the database refuses any change without a version", async () => {
    await seedHeroes(db, 12);
    const base = await heroFingerprint(db);
    expect(base.heroes).toBe(12);
    expect(base.hash).toMatch(/^[0-9a-f]{32}$/);
    const [hero] = await db.query<{ id: string }>("select id from public.characters order by id limit 1");

    // what other actors may legitimately change while a launch runs must NOT trip it (a spurious abort would be a bug of its own)
    await db.query("update public.characters set title = 'Champion', name_override = 'Renamed', status = 'INACTIVE', arena_wins = 9, power = power + 1 where id = $1", [hero!.id]);
    expect((await heroFingerprint(db)).hash).toBe(base.hash);
    await db.query("update public.characters set status = 'ACTIVE' where id = $1", [hero!.id]);

    // a hero VERSION is the only way rarity / class / stats / PWR change, and that moves the fingerprint
    const { previewReroll, applyRerollPreview } = await import("@/server/services/heroVersions");
    const d = { settings: await loadSettings(db), classes: await loadClasses(db), secret: "test-secret-value-1234567890", now: clock.now };
    const preview = await previewReroll(db, hero!.id, "admin", d);
    await applyRerollPreview(db, hero!.id, preview.previewId, "admin", d);
    const rerolled = await heroFingerprint(db);
    expect(rerolled.hash).not.toBe(base.hash);
    expect(rerolled.versions).toBe(base.versions + 1);

    // …and nothing short of a version can do it: the database refuses
    await expect(db.query("update public.character_appearances set rarity = case when rarity = 'LEGENDARY' then 'COMMON' else 'LEGENDARY' end where character_id = $1", [hero!.id])).rejects.toThrow(/inconsistent with its current hero version/);
    await expect(db.query("update public.characters set class_id = (select id from public.character_classes where id <> (select class_id from public.characters where id = $1) limit 1) where id = $1", [hero!.id])).rejects.toThrow(/class is permanent|inconsistent with its current hero version/);
    expect((await heroFingerprint(db)).hash).toBe(rerolled.hash);
  });
});

describe("if anything ever changed a hero during a launch, the whole launch would roll back", () => {
  it("a (test-only) trigger that edits a hero's stored look when Season 1 is created makes the launch fail with HERO_FINGERPRINT_CHANGED and persists NOTHING", async () => {
    await seedHeroes(db, 12);
    const identity = await heroIdentityHash(db);
    await db.exec(`
      create function public.test_touch_hero_on_launch() returns trigger language plpgsql as $$
      begin
        update public.character_appearances set seed = seed || '-tampered' where character_id = (select id from public.characters order by id limit 1);
        return new;
      end $$;
      create trigger test_touch_hero_on_launch after insert on public.seasons for each row when (new.kind = 'COMPETITIVE') execute function public.test_touch_hero_on_launch();`);
    try {
      expect(await code(launchSeason1(db, adminDeps(clock), LAUNCH))).toBe("HERO_FINGERPRINT_CHANGED");
    } finally {
      await db.exec("drop trigger test_touch_hero_on_launch on public.seasons; drop function public.test_touch_hero_on_launch();");
    }
    // …and it was ALL rolled back: still DEVELOPMENT, no Season 1, the development run still active, nothing audited, every hero as it was
    expect(await gamePhase(db)).toBe("DEVELOPMENT");
    expect(await count(db, "seasons")).toBe(1);
    expect((await activeSeason(db))!.kind).toBe("DEVELOPMENT");
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(0);
    expect(await heroIdentityHash(db)).toEqual(identity);
    // with the trigger gone the very same launch succeeds
    expect(await code(launchSeason1(db, adminDeps(clock), LAUNCH))).toBe("OK");
  });
});

describe("RESET (development only) and the later season lifecycle", () => {
  it("RESET ARENA archives the test run and starts the next one: numbers from #1, records at zero, heroes and history untouched", async () => {
    const dev = await developmentRun({ battles: 3 });
    const identity = await heroIdentityHash(db);
    const history = await battleHistoryHash(db);
    expect(await code(resetDevelopment(db, adminDeps(clock), { confirmation: "nope" }))).toBe("CONFIRMATION_REQUIRED");
    const res = await resetDevelopment(db, adminDeps(clock), { confirmation: "RESET ARENA" });
    expect(res.runNumber).toBe(2);
    expect(await gamePhase(db)).toBe("DEVELOPMENT"); // a development reset is not a launch
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    const next = (await activeSeason(db))!;
    expect(next).toMatchObject({ kind: "DEVELOPMENT", run_number: 2, battle_counter: 0 });
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await battleHistoryHash(db)).toBe(history);
    const [devRow] = await db.query<{ status: string; ended_reason: string }>("select status, ended_reason from public.seasons where id = $1", [dev.devSeasonId]);
    expect(devRow).toMatchObject({ status: "ENDED", ended_reason: "DEVELOPMENT_RESET" });
    expect((await getCharacterDto(db, dev.a, await loadSettings(db), null))!.record).toMatchObject({ battles: 0, wins: 0 });
    expect((await db.query<{ arena_battles: number }>("select arena_battles from public.characters where id = $1", [dev.a]))[0]!.arena_battles).toBe(80); // the career is kept
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    expect((await battleNumbers(db, next.id)).slice(0, 3)).toEqual([1, 2, 3]);
    expect(await count(db, "admin_audit_log", "action = 'SEASON_RESET'")).toBe(1);
  });

  it("Season 1 → END SEASON → archive → CREATE Season 2 → START: Season 2's battles are #1, #2, … and every record starts again at zero", async () => {
    const dev = await developmentRun({ battles: 2 });
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED' and season_id = (select id from public.seasons where status = 'ACTIVE')")) >= 3);
    const s1 = (await activeSeason(db))!;
    expect(await code(endSeason(db, adminDeps(clock), { confirmation: "END SEASON" }))).toBe("ARENA_NOT_STOPPED");
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    const identity = await heroIdentityHash(db);
    const s1History = await battleHistoryHash(db, s1.id);
    const s1Numbers = await battleNumbers(db, s1.id);
    expect(await code(endSeason(db, adminDeps(clock), { confirmation: "wrong" }))).toBe("CONFIRMATION_REQUIRED");
    const ended = await endSeason(db, adminDeps(clock), { confirmation: "END SEASON" });
    expect(ended.archived).toMatchObject({ label: "Season 1", reason: "SEASON_END", lastBattleNumber: s1Numbers.at(-1) });
    expect(await activeSeason(db)).toBeUndefined(); // between seasons
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    const between = await getArenaState(db, clock.ms, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
    expect(between).toMatchObject({ status: "NOT_STARTED", phase: "LIVE", season: null, current: null });
    expect(await code(startArena(db, adminDeps(clock)))).toBe("NO_ACTIVE_SEASON");
    expect(await code(createNextSeason(db, adminDeps(clock)))).toBe("OK");
    expect(await code(createNextSeason(db, adminDeps(clock)))).toBe("SEASON_ACTIVE");
    const s2 = (await activeSeason(db))!;
    expect(s2).toMatchObject({ kind: "COMPETITIVE", number: 2, name: "Season 2", battle_counter: 0 });
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await battleHistoryHash(db, s1.id)).toBe(s1History);
    expect(await code(startArena(db, adminDeps(clock)))).toBe("OK");
    await advanceArena(db, arenaCtx(clock));
    expect((await battleNumbers(db, s2.id)).slice(0, 3)).toEqual([1, 2, 3]);
    expect((await getCharacterDto(db, dev.a, await loadSettings(db), null))!.season).toMatchObject({ number: 2, label: "Season 2", battles: 0, ranked: false });
    expect((await db.query("select * from public.audit_game_lifecycle()")).length).toBe(0);
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log where action in ('SEASON_END', 'SEASON_CREATE') order by id")).map((r) => r.action)).toEqual(["SEASON_END", "SEASON_CREATE"]);
  });
});
