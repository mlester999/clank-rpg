import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { migrate } from "@/server/db/migrate";
import { createPostgresDb } from "@/server/db/postgres";
import type { Db } from "@/server/db/types";
import { finalizeHeroPeriod, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { seedReferenceData } from "@/server/seed/reference";
import { listEventPeriods, resetEventsReadiness } from "@/server/services/events";
import { launchSeason1 } from "@/server/services/lifecycle";

import { count, FakeClock, SUPABASE_ROLE_SHIM, resetDb, seedHeroes } from "../support/db";
import { giveWins } from "../support/heroArena";
import { adminDeps, freshDevelopment, heroIdentityHash } from "../support/lifecycle";
import { finalize as finalizePicks, seedScores, settingsWith } from "../support/rewards";

/**
 * REAL concurrency for the champions history: this suite runs only against a real Postgres (PGlite has ONE connection, so "concurrent" there is merely queued).
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/integration/events-postgres.test.ts
 *
 * Point it at a THROWAWAY server only — it creates and drops its own database. The invariants: a period is finalized exactly once however many finalizers race, its
 * champion snapshot is written in the same transaction (a reader can never see a champion without it), a retry credits nothing twice, and a launch racing the lot
 * still ends with exactly one Season 1 and untouched heroes.
 */
const url = process.env.CLANK_TEST_PG_URL;
const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
const DAY = 86_400_000;

describe.skipIf(!url)("Events and the first official period with REAL parallel connections", () => {
  let admin: Db;
  let db: Db;
  let dbName: string;
  let clock: FakeClock;

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_ev_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 24 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
  }, 180_000);
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
  });
  beforeEach(async () => {
    await resetDb(db);
    await freshDevelopment(db);
    resetHeroArenaReadiness();
    resetEventsReadiness();
    clock = new FakeClock();
  });

  /** A launched game with an official day of results waiting to be finalized. */
  async function launchedWithResults() {
    const heroes = await seedHeroes(db, 14);
    const users = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by created_at, id")).map((r) => Number(r.telegram_user_id));
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const [s] = await db.query<{ ms: string }>("select (extract(epoch from starts_at) * 1000)::bigint::text as ms from public.seasons where kind = 'COMPETITIVE'");
    const dayMs = Math.floor(Number(s!.ms) / DAY) * DAY;
    const day = new Date(dayMs).toISOString().slice(0, 10);
    await seedScores(db, users.slice(0, 8).map((user, i) => ({ user, day, picks: 25 - i, correct: 20 - i * 2 })));
    await giveWins(db, heroes[0]!, 4, `${day}T10:00:00Z`, { filler: [heroes[12]!, heroes[13]!] });
    await giveWins(db, heroes[1]!, 2, `${day}T13:00:00Z`, { filler: [heroes[12]!, heroes[13]!] });
    return { heroes, users, day, dayMs, closed: dayMs + DAY + 3_600_000 };
  }
  const prized = () => ({ ...settingsWith(), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: true, dailyPrizePool: "10000", weeklyPrizePool: "50000" } });

  it("FINALIZE ×8 at once (both programs): each period is frozen exactly once, with exactly one snapshot per result and no duplicated prize", async () => {
    const { day, closed } = await launchedWithResults();
    const identity = await heroIdentityHash(db);
    const picks = await Promise.all(Array.from({ length: 8 }, () => finalizePicks(db, "DAILY", day, closed, { settings: prized() }).then((r) => r.status, (e: Error) => `ERR:${e.message}`)));
    const heroes = await Promise.all(Array.from({ length: 8 }, () => finalizeHeroPeriod(db, { now: () => new Date(closed), settings: prized(), allowDemo: true }, "DAILY", day).then((r) => r.status, (e: Error) => `ERR:${e.message}`)));
    expect(picks.filter((s) => s === "FINALIZED")).toHaveLength(1);
    expect(picks.filter((s) => s === "ALREADY_FINALIZED")).toHaveLength(7);
    expect(heroes.filter((s) => s === "FINALIZED")).toHaveLength(1);
    expect(heroes.filter((s) => s === "ALREADY_FINALIZED")).toHaveLength(7);
    expect(await count(db, "arena_leaderboards")).toBe(1);
    expect(await count(db, "hero_arena_boards")).toBe(1);
    expect(await count(db, "arena_leaderboard_result_snapshots")).toBe(await count(db, "arena_leaderboard_results"));
    expect(await count(db, "hero_arena_result_snapshots")).toBe(await count(db, "hero_arena_results"));
    // one credit per prize position, never two
    expect(await db.query("select telegram_user_id, period_start, count(*) from public.arena_reward_ledger where kind = 'DAILY_LEADERBOARD_BASE_REWARD' group by 1, 2 having count(*) > 1")).toEqual([]);
    expect(await db.query("select hero_character_id, hero_period_start, count(*) from public.arena_reward_ledger where hero_character_id is not null group by 1, 2 having count(*) > 1")).toEqual([]);
    expect(await db.query("select * from public.audit_event_champions()")).toEqual([]);
    expect(await db.query("select * from public.audit_launch_isolation()")).toEqual([]);
    expect(await heroIdentityHash(db)).toEqual(identity);
  }, 120_000);

  it("a reader racing the finalization never sees a champion without its snapshot, or a half-written period", async () => {
    const { day, dayMs, closed } = await launchedWithResults();
    const now = dayMs + 2 * DAY;
    const observed: Array<{ outcome: string; art: boolean; participants: number }> = [];
    let finalizing = true;
    const readers = Array.from({ length: 6 }, async () => {
      while (finalizing) {
        for (const program of ["picks", "hero"] as const) {
          const p = (await listEventPeriods(db, { program, kind: "daily", nowMs: now })).periods.find((x) => x.start === day);
          if (p) observed.push({ outcome: p.outcome, art: p.champions.every((c) => c.art !== null), participants: p.participants });
        }
      }
    });
    await Promise.all([
      (async () => {
        await Promise.all([finalizePicks(db, "DAILY", day, closed, { settings: prized() }), finalizeHeroPeriod(db, { now: () => new Date(closed), settings: prized(), allowDemo: true }, "DAILY", day)]);
        finalizing = false;
      })(),
      ...readers,
    ]);
    expect(observed.length).toBeGreaterThan(0);
    // before the freeze a reader sees FINALIZING; after it, a complete champion (art and all) — never a champion without its snapshot, never an empty board
    for (const o of observed) {
      expect(["FINALIZING", "CHAMPION", "JOINT_CHAMPIONS"], o.outcome).toContain(o.outcome);
      expect(o.art).toBe(true);
      if (o.outcome !== "FINALIZING") expect(o.participants).toBeGreaterThan(0);
    }
    const final = (await listEventPeriods(db, { program: "picks", kind: "daily", nowMs: now })).periods.find((x) => x.start === day)!;
    expect(final.outcome).toBe("CHAMPION");
  }, 120_000);

  it("LAUNCH ×6 racing a pre-season finalization: one Season 1, heroes untouched, no deadlock", async () => {
    const heroes = await seedHeroes(db, 14);
    const users = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by created_at, id")).map((r) => Number(r.telegram_user_id));
    const off = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    await seedScores(db, users.slice(0, 4).map((user, i) => ({ user, day: "2026-10-05", picks: 22 - i, correct: 10 - i })));
    await giveWins(db, heroes[0]!, 3, "2026-10-05T12:00:00Z", { filler: [heroes[12]!, heroes[13]!] });
    const identity = await heroIdentityHash(db);
    const errors: string[] = [];
    const t = Date.parse("2026-10-06T01:00:00Z");
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => launchSeason1(db, adminDeps(clock), LAUNCH).catch((e: Error) => { errors.push(e.message); return null; })),
      finalizePicks(db, "DAILY", "2026-10-05", t, { settings: off }).catch((e: Error) => { errors.push(e.message); return null; }),
      finalizeHeroPeriod(db, { now: () => new Date(t), settings: off, allowDemo: true }, "DAILY", "2026-10-05").catch((e: Error) => { errors.push(e.message); return null; }),
    ]);
    expect(errors.filter((m) => /deadlock|could not serialize/i.test(m))).toEqual([]);
    const launches = results.slice(0, 6) as Array<{ alreadyLaunched: boolean } | null>;
    expect(launches.filter((l) => l && !l.alreadyLaunched)).toHaveLength(1);
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(1);
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await db.query("select * from public.audit_game_lifecycle()")).toEqual([]);
    expect(await db.query("select * from public.audit_launch_isolation()")).toEqual([]);
  }, 180_000);
});
