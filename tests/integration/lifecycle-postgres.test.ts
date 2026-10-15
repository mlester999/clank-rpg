import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRng } from "@/domain/util/rng";
import { migrate } from "@/server/db/migrate";
import { createPostgresDb } from "@/server/db/postgres";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";
import { patchHero } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { applyLedger } from "@/server/services/economy";
import { createNextSeason, endSeason, getGameControl, heroFingerprint, launchSeason1, pauseArena, resetDevelopment, resumeArena, startArena } from "@/server/services/lifecycle";

import { arenaCtx, count, FakeClock, SUPABASE_ROLE_SHIM, resetDb, seedHeroes } from "../support/db";
import { activeSeason, adminDeps, arenaStatus, freshDevelopment, gamePhase, heroIdentityHash } from "../support/lifecycle";
import { balanceOf, finalize, seedScores, settingsWith, utc } from "../support/rewards";

/**
 * REAL concurrency for the lifecycle: this suite runs only against a real Postgres (PGlite has ONE connection, so "concurrent" requests there are merely
 * queued). Point CLANK_TEST_PG_URL at a THROWAWAY server (never a database that matters — it creates and drops its own database):
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/integration/lifecycle-postgres.test.ts
 *
 * The invariants in every race: exactly one active season; no duplicate Season 1 or Battle #1; no torn queue (the queue / battle integrity auditor stays
 * clean); no suspended hero in a roster made after its suspension; no hero identity change; no lost version; no deadlock.
 */
const url = process.env.CLANK_TEST_PG_URL;
const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
const RESET = { confirmation: "RESET ARENA" };
const END = { confirmation: "END SEASON" };

describe.skipIf(!url)("the game lifecycle with REAL parallel connections", () => {
  let admin: Db;
  let db: Db;
  let arenaDb: Db;
  let dbName: string;
  let clock: FakeClock;
  const errors: string[] = [];

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_lc_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 24 });
    arenaDb = createPostgresDb(u.toString(), { maxConnections: 8 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
  }, 180_000);
  afterAll(async () => {
    await arenaDb?.close();
    await db?.close();
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
  });

  const fresh = async (heroes = 0) => {
    await resetDb(db);
    await freshDevelopment(db);
    clock = new FakeClock();
    return heroes ? seedHeroes(db, heroes) : [];
  };
  /** The outcome of an Admin call as a short code. Deadlocks and serialization failures are recorded: there must be none. */
  const code = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "OK";
    } catch (e) {
      const c = (e as { code?: string }).code;
      const msg = (e as Error).message ?? String(e);
      if (/deadlock|could not serialize/i.test(msg)) errors.push(msg);
      return typeof c === "string" && /^[A-Z_]+$/.test(c) ? c : `ERROR:${msg}`;
    }
  };
  const deps = () => adminDeps(clock);
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      try {
        await advanceArena(arenaDb, arenaCtx(clock));
      } catch (e) {
        errors.push(`advance: ${(e as Error).message}`);
      }
      clock.advance(1000);
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** `n` background ticking streams (viewers / workers advancing the Arena), stopped for certain — even when the test body throws. */
  async function withTicks<T>(n: number, body: () => Promise<T>): Promise<T> {
    const stop = { v: false };
    const streams = Array.from({ length: n }, async () => {
      while (!stop.v) await tick(1);
    });
    try {
      return await body();
    } finally {
      stop.v = true;
      await Promise.all(streams);
    }
  }

  /** What must hold after ANY race. */
  const consistent = async (opts: { competitiveSeasons?: number } = {}) => {
    expect(await count(db, "seasons", "status = 'ACTIVE'")).toBeLessThanOrEqual(1);
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBeLessThanOrEqual(opts.competitiveSeasons ?? 1);
    expect((await db.query("select * from public.audit_game_lifecycle()")), "lifecycle auditor").toEqual([]);
    const dupNumbers = await db.query("select season_id, season_sequence from public.arena_battles group by 1, 2 having count(*) > 1");
    expect(dupNumbers).toEqual([]);
    const badRosters = await db.query("select battle_id from public.arena_participants group by battle_id having count(*) <> 8 or count(distinct character_id) <> 8");
    expect(badRosters).toEqual([]);
    const dupQueue = await db.query("select cycle_id, character_id from public.arena_queue_entries group by 1, 2 having count(*) > 1");
    expect(dupQueue).toEqual([]);
    expect(errors, "no deadlock / serialization failure / step error").toEqual([]);
  };

  it("LAUNCH vs LAUNCH (×10): exactly one Season 1, one audit entry; the other nine are told about that same launch and reset nothing", async () => {
    await fresh(16);
    const results = await Promise.all(Array.from({ length: 10 }, () => launchSeason1(db, deps(), LAUNCH).catch((e) => ({ error: (e as Error).message }))));
    expect(results.filter((r) => "error" in r)).toEqual([]);
    const done = results as Array<{ alreadyLaunched: boolean; seasonId: string }>;
    expect(done.filter((r) => !r.alreadyLaunched)).toHaveLength(1);
    expect(done.filter((r) => r.alreadyLaunched)).toHaveLength(9);
    expect(new Set(done.map((r) => r.seasonId)).size).toBe(1);
    expect(await count(db, "seasons", "kind = 'COMPETITIVE' and number = 1")).toBe(1);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(1);
    expect(await gamePhase(db)).toBe("LIVE");
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    await consistent();
  }, 120_000);

  it("LAUNCH vs LAUNCH (×8) with development Gold, loot and achievements: archived exactly once — one offset per account, Gold 0, ledger consistent, nothing deleted, heroes untouched", async () => {
    const heroes = await fresh(16);
    for (const [i, h] of heroes.slice(0, 6).entries()) {
      await applyLedger(db, { characterId: h, amount: 1000 + i, reason: "test_grant", refType: "test", refId: "dev", idempotencyKey: `pg-dev-gold-${h}` });
      await db.query("insert into public.character_achievements (character_id, achievement_id, context) values ($1, 'arena_debut', '{\"metric\":\"battles\",\"value\":5}'::jsonb), ($1, 'voice_of_clank', '{\"metric\":\"telegram_qualifying\",\"value\":600}'::jsonb)", [h]);
      const [{ class_id }] = (await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [h])) as [{ class_id: string }];
      await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true)", [h, `${class_id}_weapon_rare`]);
    }
    const identity = await heroIdentityHash(db);
    const fingerprint = await heroFingerprint(db);
    const ledgerBefore = await count(db, "currency_ledger");
    const rs = await Promise.all(Array.from({ length: 8 }, () => launchSeason1(db, deps(), LAUNCH).catch((e) => ({ error: (e as Error).message }))));
    expect(rs.filter((r) => "error" in r)).toEqual([]);
    expect((rs as Array<{ alreadyLaunched: boolean }>).filter((r) => !r.alreadyLaunched)).toHaveLength(1); // one launch did the work; the other seven were told about it
    expect(await count(db, "currency_ledger", "reason = 'season_launch_reset'")).toBe(6); // one offset per account — never two
    expect(await count(db, "currency_ledger")).toBe(ledgerBefore + 6);
    expect(await count(db, "currency_accounts", "balance <> 0")).toBe(0);
    expect(await db.query("select * from public.audit_currency_ledger()")).toEqual([]);
    expect(await count(db, "inventory_items", "archived_at is null")).toBe(0);
    expect(await count(db, "inventory_items", "equipped")).toBe(0);
    expect(await count(db, "inventory_items")).toBe(6);
    expect(await count(db, "character_achievements", "archived_at is not null")).toBe(6); // arena_debut ×6
    expect(await count(db, "character_achievements", "archived_at is null")).toBe(6); // the community one is permanent
    expect(await db.query("select * from public.audit_development_economy()")).toEqual([]);
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await heroFingerprint(db)).toEqual(fingerprint);
    await consistent();
  }, 120_000);

  it("LAUNCH vs Arena ticks: viewers' and the worker's advances racing a launch never create a battle while the Arena is NOT_STARTED — before, during or after", async () => {
    await fresh(24);
    const launched = await withTicks(3, async () => {
      await sleep(60);
      const r = await code(launchSeason1(db, deps(), LAUNCH));
      await sleep(120);
      return r;
    });
    expect(launched).toBe("OK");
    expect(await count(db, "arena_battles")).toBe(0);
    expect(await count(db, "arena_cycles")).toBe(0);
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    // START brings exactly Battle #1 — even with many advances racing the start
    await startArena(db, deps());
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => tick(3)));
    const s1 = (await activeSeason(db))!;
    expect(await count(db, "arena_battles", `season_id = '${s1.id}' and season_sequence = 1`)).toBe(1);
    await consistent();
  }, 120_000);

  it("LAUNCH / RESET vs a draining Arena (settlement in flight): refused until the Arena is PAUSED and nothing is committed; then one wins; heroes untouched", async () => {
    for (const action of ["launch", "reset"] as const) {
      await fresh(24);
      await startArena(db, deps());
      for (let i = 0; i < 400 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 2; i++) await tick(1);
      const identity = await heroIdentityHash(db);
      await pauseArena(db, deps());
      const outcomes: string[] = [];
      for (let i = 0; i < 400 && !outcomes.includes("OK"); i++) {
        const [, r] = await Promise.all([tick(1), code(action === "launch" ? launchSeason1(db, deps(), LAUNCH) : resetDevelopment(db, deps(), RESET))]);
        outcomes.push(r);
      }
      expect(outcomes.at(-1)).toBe("OK");
      // every refusal before the success was "the Arena is not stopped yet" (never a half-applied launch)
      expect(new Set(outcomes.slice(0, -1))).toEqual(outcomes.length > 1 ? new Set(["ARENA_NOT_STOPPED"]) : new Set());
      expect(await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')")).toBe(0); // nothing committed was cut in half: it all settled first
      expect(await heroIdentityHash(db)).toEqual(identity);
      expect(await arenaStatus(db)).toBe("NOT_STARTED");
      await consistent();
    }
  }, 240_000);

  it("LAUNCH vs RESET (×6 at once): never both a Season 1 and a second development run active; at most one launch; consistent either way", async () => {
    for (let round = 0; round < 3; round++) {
      await fresh(16);
      const identity = await heroIdentityHash(db);
      const rs = await Promise.all([
        ...Array.from({ length: 3 }, () => code(launchSeason1(db, deps(), LAUNCH))),
        ...Array.from({ length: 3 }, () => code(resetDevelopment(db, deps(), RESET))),
      ]);
      expect(rs.filter((r) => r === "OK").length).toBeGreaterThanOrEqual(1);
      expect(new Set(rs.filter((r) => r !== "OK"))).toSatisfy((s: Set<string>) => [...s].every((c) => ["LIVE_RESET_FORBIDDEN"].includes(c))); // a launch that finds the game LIVE just reports it
      const launches = await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'");
      expect(launches).toBeLessThanOrEqual(1);
      expect(await gamePhase(db)).toBe(launches === 1 ? "LIVE" : "DEVELOPMENT");
      if (launches === 0) expect(await count(db, "admin_audit_log", "action = 'SEASON_RESET'")).toBe(rs.filter((r) => r === "OK").length);
      expect(await heroIdentityHash(db)).toEqual(identity);
      await consistent();
    }
  }, 240_000);

  it("START vs START (×10) and START vs a stream of ticks: one wins, exactly one Battle #1", async () => {
    await fresh(24);
    const [rs] = await Promise.all([Promise.all(Array.from({ length: 10 }, () => code(startArena(db, deps())))), tick(6), tick(6)]);
    expect(rs.filter((r) => r === "OK")).toHaveLength(1);
    expect(rs.filter((r) => r === "ARENA_ALREADY_STARTED")).toHaveLength(9);
    await tick(10);
    const season = (await activeSeason(db))!;
    expect(await count(db, "arena_battles", `season_id = '${season.id}' and season_sequence = 1`)).toBe(1);
    await consistent();
  }, 120_000);

  it("START vs RESET, START vs PAUSE (random order, ×12 rounds): consistent every time", async () => {
    const rng = createRng("start-races");
    for (let round = 0; round < 12; round++) {
      await fresh(16);
      const other = round % 2 === 0 ? () => code(resetDevelopment(db, deps(), RESET)) : () => code(pauseArena(db, deps()));
      const calls = [() => code(startArena(db, deps())), other];
      if (rng.chance(0.5)) calls.reverse();
      const rs = await Promise.all(calls.map(async (f, i) => (await sleep(i * rng.range(0, 8)), f())));
      expect(rs.filter((r) => !["OK", "ARENA_NOT_STOPPED", "ARENA_ALREADY_STARTED", "INVALID_STATE"].includes(r)), rs.join()).toEqual([]);
      await tick(3);
      const s = (await activeSeason(db))!;
      expect(await count(db, "arena_battles", `season_id <> '${s.id}' and status in ('SCHEDULED', 'SIMULATED')`)).toBe(0); // nothing committed in an archived season
      await consistent();
    }
  }, 240_000);

  it("PAUSE vs Arena ticks (×4 streams): once the pause is committed no new roster is ever made; every committed battle plays out; then PAUSED stays", async () => {
    await fresh(24);
    await startArena(db, deps());
    for (let i = 0; i < 300 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 3; i++) await tick(1);
    const out = await withTicks(4, async () => {
      await sleep(40);
      const res = await pauseArena(db, deps());
      expect(["PAUSE_REQUESTED", "PAUSED"]).toContain(res.status);
      const maxSeq = (await db.query<{ n: number }>("select max(sequence)::int as n from public.arena_battles"))[0]!.n;
      const battlesAtPause = await count(db, "arena_battles");
      for (let i = 0; i < 1500 && (await arenaStatus(db)) !== "PAUSED"; i++) await sleep(5);
      return { maxSeq, battlesAtPause };
    });
    expect(await arenaStatus(db)).toBe("PAUSED");
    expect((await db.query<{ n: number }>("select max(sequence)::int as n from public.arena_battles"))[0]!.n).toBe(out.maxSeq);
    expect(await count(db, "arena_battles")).toBe(out.battlesAtPause);
    expect(await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')")).toBe(0);
    await consistent();
  }, 240_000);

  it("RESUME vs RESUME (×10): one wins; the same season, the next battle number — never #1", async () => {
    await fresh(24);
    await startArena(db, deps());
    for (let i = 0; i < 300 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 2; i++) await tick(1);
    await pauseArena(db, deps());
    for (let i = 0; i < 600 && (await arenaStatus(db)) !== "PAUSED"; i++) await tick(1);
    const season = (await activeSeason(db))!;
    const last = Number((await db.query<{ n: number }>("select max(season_sequence)::int as n from public.arena_battles where season_id = $1", [season.id]))[0]!.n);
    const rs = await Promise.all(Array.from({ length: 10 }, () => code(resumeArena(db, deps()))));
    expect(rs.filter((r) => r === "OK")).toHaveLength(1);
    expect(rs.filter((r) => r === "INVALID_STATE")).toHaveLength(9);
    await tick(20);
    const next = Number((await db.query<{ n: number }>("select min(season_sequence)::int as n from public.arena_battles where season_id = $1 and season_sequence > $2", [season.id, last]))[0]!.n);
    expect(next).toBe(last + 1);
    await consistent();
  }, 240_000);

  it("SUSPEND vs the scheduler: a hero suspended while rosters are being made never appears in a roster made after the suspension committed; the scheduler never errors (the locks make it wait, not fail)", async () => {
    const heroes = await fresh(40);
    await startArena(db, deps());
    // A slow roster insert (it fires BEFORE the database's own eligibility check, alphabetically) stretches the window between "the scheduler verified the
    // heroes" and "the roster is written" to ~40 ms per roster — so a suspension has every chance to land inside it. WITH the scheduler's row locks the
    // suspension waits for the scheduling transaction; WITHOUT them the database would refuse the roster and the scheduler would error (SUSPEND_RACE_MUTATION).
    await db.exec(`
      create function public.test_slow_roster_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.005); return new; end $$;
      create trigger a0_test_slow_roster before insert on public.arena_participants for each row execute function public.test_slow_roster_insert();`);
    const rng = createRng("suspend-race");
    const suspensions: Array<{ id: string; at: string }> = [];
    try {
      await withTicks(3, async () => {
        const pool = [...heroes];
        for (let i = 0; i < 30; i++) {
          await sleep(rng.range(8, 30));
          const id = pool.splice(rng.int(pool.length), 1)[0]!;
          await patchHero(db, id, { status: "SUSPENDED" }, "race-admin");
          suspensions.push({ id, at: (await db.query<{ t: string }>("select clock_timestamp()::text as t"))[0]!.t });
        }
        for (let i = 0; i < 400 && (await count(db, "arena_battles")) < 10; i++) await sleep(25); // keep scheduling a while longer
      });
    } finally {
      await db.exec("drop trigger a0_test_slow_roster on public.arena_participants; drop function public.test_slow_roster_insert();");
    }
    expect(await count(db, "arena_battles")).toBeGreaterThanOrEqual(8); // the race really happened over live scheduling
    for (const s of suspensions) {
      const after = await count(db, "arena_participants p join public.arena_battles b on b.id = p.battle_id", `p.character_id = '${s.id}' and b.created_at > '${s.at}'::timestamptz`);
      expect(after, `hero ${s.id} suspended at ${s.at}`).toBe(0);
    }
    await consistent();
  }, 240_000);

  it("FINALIZATION vs LAUNCH (×12 rounds): a board either credits its prizes BEFORE the launch (and the launch then refuses) or is archived BY it — never both a launch and a credited development prize", async () => {
    const DAY = "2026-10-07";
    const END_OF_DAY = utc(2026, 10, 8, 0, 0, 5);
    const rng = createRng("finalize-vs-launch");
    let launches = 0;
    let refusals = 0;
    for (let round = 0; round < 12; round++) {
      await fresh(0);
      await seedScores(db, Array.from({ length: 12 }, (_, i) => ({ user: 9501 + i, day: DAY, picks: 20, correct: 20 - i })));
      const settings = settingsWith({ enabled: true });
      const calls = [() => code(launchSeason1(db, deps(), LAUNCH)), () => finalize(db, "DAILY", DAY, END_OF_DAY, { settings }).then(() => "OK", (e: Error) => `ERROR:${e.message}`)];
      if (rng.chance(0.5)) calls.reverse();
      const rs = await Promise.all(calls.map(async (f, i) => (await sleep(i * rng.range(0, 12)), f())));
      expect(rs.filter((r) => r.startsWith("ERROR")), rs.join()).toEqual([]);
      const phase = await gamePhase(db);
      const credited = (await balanceOf(db, 9501)).earned;
      if (phase === "LIVE") {
        launches++;
        expect(credited, "launched, so no development prize may exist").toBe(0n);
        expect(await count(db, "arena_leaderboards")).toBe(0);
      } else {
        refusals++;
        expect(credited, "refused, so the prize was credited first").toBeGreaterThan(0n);
        expect(rs.some((r) => r === "REWARD_LIABILITIES")).toBe(true);
      }
      await consistent();
    }
    expect(launches + refusals).toBe(12);
  }, 300_000);

  it("a whole lifecycle under load: launch → start → run → pause → end season → create Season 2 → start, all while ticks keep coming — heroes, versions and history intact, no deadlock", async () => {
    const heroes = await fresh(32);
    await patchHero(db, heroes[0]!, { status: "SUSPENDED" }, "race-admin");
    const identity = await heroIdentityHash(db);
    const fingerprint = await heroFingerprint(db);
    await withTicks(3, async () => {
      expect(await code(launchSeason1(db, deps(), LAUNCH))).toBe("OK");
      expect(await code(startArena(db, deps()))).toBe("OK");
      for (let i = 0; i < 800 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 4; i++) await sleep(10);
      expect(await code(pauseArena(db, deps()))).toBe("OK");
      for (let i = 0; i < 1500 && (await arenaStatus(db)) !== "PAUSED"; i++) await sleep(10);
      expect(await arenaStatus(db)).toBe("PAUSED");
      expect(await code(endSeason(db, deps(), END))).toBe("OK");
      expect(await code(createNextSeason(db, deps()))).toBe("OK");
      expect(await code(startArena(db, deps()))).toBe("OK");
      for (let i = 0; i < 800 && (await count(db, "arena_battles", "season_sequence = 1")) < 2; i++) await sleep(10);
    });
    expect(await count(db, "arena_battles", "season_sequence = 1")).toBe(2); // Season 1's #1 and Season 2's #1
    expect(await heroIdentityHash(db)).toEqual(identity);
    expect(await heroFingerprint(db)).toEqual(fingerprint);
    expect((await getGameControl(db, deps())).heroes).toMatchObject({ total: 32, eligible: 31, suspended: 1 });
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(2); // Season 1 (archived) and Season 2
    await consistent({ competitiveSeasons: 2 });
  }, 300_000);
});
