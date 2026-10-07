import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { migrate } from "@/server/db/migrate";
import { createPostgresDb } from "@/server/db/postgres";
import type { Db } from "@/server/db/types";
import { finalizeDueHeroBoards, finalizeHeroPeriod, releaseReservedHeroPrizes, resolveHeldHeroPrize } from "@/server/rewards/heroArena";
import { finalizeDueBoards } from "@/server/rewards/leaderboard";
import { auditRewardAccounts } from "@/server/rewards/ledger";
import { seedReferenceData } from "@/server/seed/reference";
import { claimCharacter } from "@/server/services/identity";

import { runArena, SUPABASE_ROLE_SHIM } from "../support/db";
import { giveWins, seedHeroOwners } from "../support/heroArena";
import { finalize as finalizePicks, seedScores, tokens, utc } from "../support/rewards";

/**
 * HERO ARENA WITH REAL PARALLEL CONNECTIONS: this suite runs only against a real Postgres (PGlite has ONE connection, so "concurrent" there is merely queued). Point
 * CLANK_TEST_PG_URL at a THROWAWAY server (it creates and drops its own database):
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/integration/hero-arena-postgres.test.ts
 *
 * Invariants in every race: a period is finalized exactly once; a hero is paid exactly once; no credit without a result and no result marked credited without a credit
 * (audit_hero_arena); every account equals the sum of its ledger; no deadlock; the two reward programs never block or corrupt each other.
 */
const url = process.env.CLANK_TEST_PG_URL;
const settings = { ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000" } };
const DAY = "2026-10-07";
const AFTER = utc(2026, 10, 14, 1); // the day AND the week have ended
const clock = (ms = AFTER) => ({ now: () => new Date(ms) });

describe.skipIf(!url)("Hero Arena under real concurrency", () => {
  let admin: Db;
  let db: Db;
  let dbName: string;
  const errors: string[] = [];

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_hero_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 12 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
    await runArena(db);
  }, 180_000);
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
    expect(errors, "no deadlock / serialization failure anywhere").toEqual([]);
  });

  const note = (e: unknown) => {
    const m = e instanceof Error ? e.message : String(e);
    if (/deadlock|could not serialize/i.test(m)) errors.push(m);
    throw e;
  };

  /** Twelve heroes with distinct owners; the first four claimed. Wins on DAY: h0 9 · h1 9 · h2 7 · h3 5 · h4 5 · h5 3 · h6..h11 1 (each is an exact tie group somewhere). */
  async function populate(): Promise<{ heroes: string[]; owners: number[]; filler: [string, string] }> {
    const owners = Array.from({ length: 14 }, (_, i) => 600_000 + i);
    const map = await seedHeroOwners(db, owners.map((user, i) => ({ user, name: `Hero ${i}`, claimed: i < 4 })));
    const ids = owners.map((o) => map.get(o)!);
    const filler: [string, string] = [ids[12]!, ids[13]!];
    const wins = [9, 9, 7, 5, 5, 3, 1, 1, 1, 1, 1, 1];
    for (let i = 0; i < 12; i++) await giveWins(db, ids[i]!, wins[i]!, new Date(utc(2026, 10, 7, 1 + i)).toISOString(), { filler });
    return { heroes: ids.slice(0, 12), owners: owners.slice(0, 12), filler };
  }

  it("20 parallel finalizations of the same day: ONE board, one ledger credit per claimed prize winner, a clean audit", async () => {
    const { heroes } = await populate();
    const results = await Promise.all(Array.from({ length: 20 }, () => finalizeHeroPeriod(db, { ...clock(), settings }, "DAILY", DAY).catch(note)));
    expect(results.filter((r) => r.status === "FINALIZED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "ALREADY_FINALIZED").length).toBe(19);
    expect(await db.query("select count(*)::int as n from public.hero_arena_boards where kind = 'DAILY' and period_start = $1", [DAY])).toEqual([{ n: 1 }]);
    // ranks: 9,9 → #1 (positions 1+2), 7 → #3, 5,5 → #4 (positions 4+5), 3 → #6, six heroes with 1 win → #7 (positions 7..10 shared by SIX: the whole tie group shares what exists)
    const credits = await db.query<{ hero_character_id: string; claimable_delta: string }>("select hero_character_id, claimable_delta::text from public.arena_reward_ledger where hero_period_kind = 'DAILY' and hero_period_start = $1", [DAY]);
    expect(new Set(credits.map((c) => c.hero_character_id)).size).toBe(credits.length); // never two credits for one hero
    expect(credits.map((c) => c.hero_character_id).sort()).toEqual([heroes[0], heroes[1], heroes[2], heroes[3]].sort()); // only the CLAIMED heroes were credited
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
    const [b] = await db.query<{ awarded: string; returned: string; pool: string }>("select awarded_micro::text as awarded, returned_to_reserve_micro::text as returned, prize_pool_micro::text as pool from public.hero_arena_boards");
    expect(BigInt(b!.awarded) + BigInt(b!.returned)).toBe(BigInt(b!.pool));
  }, 240_000);

  it("a DAY and a WEEK finalize at the same time with overlapping owners: no deadlock, each hero paid once per program-period", async () => {
    const { heroes } = await populate();
    // (continue the same data: Daily is already frozen above; freeze the WEEK and every other day of it in parallel)
    const runs = await Promise.all([
      finalizeHeroPeriod(db, { ...clock(), settings }, "WEEKLY", "2026-10-05").catch(note),
      finalizeDueHeroBoards(db, { ...clock(), settings }),
      finalizeDueHeroBoards(db, { ...clock(), settings }),
      finalizeHeroPeriod(db, { ...clock(), settings }, "WEEKLY", "2026-10-05").catch(note),
    ]);
    expect(runs.filter((r) => "status" in r && r.status === "FINALIZED").length).toBeLessThanOrEqual(1);
    expect(await db.query("select count(*)::int as n from public.hero_arena_boards where kind = 'WEEKLY'")).toEqual([{ n: 1 }]);
    const dup = await db.query("select hero_character_id, hero_period_kind, hero_period_start, count(*)::int as n from public.arena_reward_ledger where hero_character_id is not null group by 1, 2, 3 having count(*) > 1");
    expect(dup).toEqual([]);
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
    void heroes;
  }, 240_000);

  it("the owner claims the hero while the sweep runs and a second claim races in: the reserved prize is credited EXACTLY once", async () => {
    // hero 4 (5 wins, tied with hero 3) is UNCLAIMED with a reserved prize on DAY (owner 600004)
    const [h4] = await db.query<{ id: string }>("select id from public.characters where telegram_user_id = 600004");
    const before = await db.query<{ prize_status: string }>("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY' and period_start = $2", [h4!.id, DAY]);
    expect(before).toEqual([{ prize_status: "RESERVED" }]);
    const racers = await Promise.all([
      claimCharacter(db, 600004, new Date(AFTER)).catch(note),
      claimCharacter(db, 600004, new Date(AFTER)).catch(note),
      finalizeDueHeroBoards(db, { ...clock(AFTER + 1000), settings }),
      db.transaction((tx) => releaseReservedHeroPrizes(tx, clock(AFTER + 2000), h4!.id, 600004)).catch(note),
      db.transaction((tx) => releaseReservedHeroPrizes(tx, clock(AFTER + 3000), h4!.id, 600000)).catch(note), // somebody ELSE's id: can never receive it
    ]);
    expect(racers.length).toBe(5);
    expect(await db.query("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY' and period_start = $2", [h4!.id, DAY])).toEqual([{ prize_status: "CREDITED" }]);
    expect(await db.query("select telegram_user_id from public.arena_reward_ledger where hero_character_id = $1 and hero_period_kind = 'DAILY' and hero_period_start = $2", [h4!.id, DAY])).toEqual([{ telegram_user_id: 600004 }]);
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
  }, 240_000);

  it("an admin releases and another forfeits the same HELD prize at once: exactly one wins, and the amount is credited at most once", async () => {
    const [h5] = await db.query<{ id: string }>("select id from public.characters where telegram_user_id = 600005");
    // make hero 5's prize HELD (the guard allows RESERVED → HELD; here the prize is RESERVED because the hero is unclaimed)
    await db.query("update public.hero_arena_results set prize_status = 'HELD', hold_reason = 'REVIEW' where character_id = $1 and kind = 'DAILY' and period_start = $2 and prize_status = 'RESERVED'", [h5!.id, DAY]);
    const input = { kind: "DAILY" as const, start: DAY, characterId: h5!.id, actor: "admin" };
    const outcomes = await Promise.all([
      resolveHeldHeroPrize(db, clock(), { ...input, action: "release", reason: "reviewed fine" }).catch(note),
      resolveHeldHeroPrize(db, clock(), { ...input, action: "forfeit", reason: "reviewed bad" }).catch(note),
      resolveHeldHeroPrize(db, clock(), { ...input, action: "release", reason: "reviewed again" }).catch(note),
    ]);
    expect(outcomes.filter((o) => o && "ok" in o && o.ok)).toHaveLength(1);
    const credits = await db.query("select 1 from public.arena_reward_ledger where hero_character_id = $1 and hero_period_start = $2", [h5!.id, DAY]);
    const [row] = await db.query<{ prize_status: string }>("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY' and period_start = $2", [h5!.id, DAY]);
    expect(credits.length).toBe(row!.prize_status === "CREDITED" ? 1 : 0);
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
  }, 240_000);

  it("Arena Picks and Hero Arena finalize side by side without blocking or corrupting each other", async () => {
    await seedScores(db, [{ user: 700_001, day: "2026-10-06", picks: 25, correct: 20 }, { user: 700_002, day: "2026-10-06", picks: 22, correct: 9 }]);
    const [picks, hero, picksSweep, heroSweep] = await Promise.all([
      finalizePicks(db, "DAILY", "2026-10-06", AFTER).catch(note),
      finalizeHeroPeriod(db, { ...clock(), settings }, "DAILY", "2026-10-06").catch(note),
      finalizeDueBoards(db, { ...clock(), settings }),
      finalizeDueHeroBoards(db, { ...clock(), settings }),
    ]);
    expect([picks, hero, picksSweep, heroSweep].every(Boolean)).toBe(true);
    expect(await db.query("select count(*)::int as n from public.arena_leaderboards where kind = 'DAILY' and period_start = '2026-10-06'")).toEqual([{ n: 1 }]);
    const sources = await db.query<{ reward_source: string }>("select distinct reward_source from public.arena_reward_ledger where reward_source is not null order by 1");
    expect(sources.map((s) => s.reward_source)).toEqual(expect.arrayContaining(["ARENA_PICKS_DAILY", "HERO_ARENA_DAILY", "HERO_ARENA_WEEKLY"]));
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
    expect(await auditRewardAccounts(db)).toEqual([]);
    expect(tokens(1)).toBe(1_000_000n); // (logical micro-token units, as everywhere in the reward ledger)
  }, 240_000);
});
