import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { createPostgresDb } from "@/server/db/postgres";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { FreeRerollError, rerollOwnHero, type FreeRerollDeps } from "@/server/services/heroFreeReroll";
import { heroArenaLock } from "@/server/services/heroVersionStore";
import { claimCharacter } from "@/server/services/identity";
import { seedReferenceData } from "@/server/seed/reference";

import { arenaCtx, FakeClock, SUPABASE_ROLE_SHIM, resetDb, seedHeroes } from "../support/db";

/**
 * REAL concurrency for the free daily reroll. PGlite has ONE connection, so "parallel" requests there are merely queued; this suite uses a pool of 16 real
 * connections against a THROWAWAY Postgres (it creates and drops its own database):
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5571/postgres pnpm exec vitest run tests/integration/hero-free-reroll-postgres.test.ts
 *
 * What it proves: however many requests race — one member's tabs, retries with one key, many members, and the Arena freezing rosters meanwhile — the
 * outcome is the same: at most ONE reroll per member per UTC day, one version per logical request, no split brain, no deadlock, and a hero is never
 * changed after it was committed to a roster.
 */
const url = process.env.CLANK_TEST_PG_URL;
const SECRET = "test-secret-value-1234567890";
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

describe.skipIf(!url)("free daily reroll with REAL parallel connections", () => {
  let admin: Db;
  let db: Db;
  let arenaDb: Db;
  let dbName: string;
  let deps: FreeRerollDeps;
  let clock: FakeClock;

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_fr_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 16 });
    arenaDb = createPostgresDb(u.toString(), { maxConnections: 4 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
    clock = new FakeClock(T0);
    deps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: SECRET, allowDemo: true, now: clock.now };
    // Sensitivity check of THIS suite (RACE_MUTATION=drop-pk, run with the hero row lock also removed from the service): without the one-per-day primary key
    // and the lock nothing stops two tabs both succeeding — the first test below must then FAIL, proving the suite can see the race it guards against.
    if (process.env.RACE_MUTATION === "drop-pk") await db.exec("alter table public.hero_free_rerolls drop constraint hero_free_rerolls_pkey");
    // A slow reroll transaction: sleeps inside the version insert (after the Arena-roster check, before the commit) so races have room to happen.
    await db.exec(`
      create function public.test_slow_version_insert() returns trigger language plpgsql as $$ begin perform pg_sleep(0.04); return new; end $$;
      create trigger test_slow_version_insert before insert on public.hero_versions for each row when (new.action <> 'INITIAL') execute function public.test_slow_version_insert();`);
  }, 120_000);
  afterAll(async () => {
    await arenaDb?.close();
    await db?.close();
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
  });

  const settle = (ps: Array<Promise<unknown>>) => Promise.allSettled(ps);
  const codes = (rs: Array<PromiseSettledResult<unknown>>) => rs.map((r) => (r.status === "fulfilled" ? "OK" : r.reason instanceof FreeRerollError ? r.reason.code : String((r.reason as Error).message)));
  const n = async (sql: string, ...params: unknown[]) => Number((await db.query<{ n: number }>(sql, params))[0]!.n);
  const clean = async () => (await n("select count(*)::int as n from public.audit_hero_versions()")) + (await n("select count(*)::int as n from public.audit_hero_free_rerolls()"));
  const claimed = async (count: number, startId: number) => {
    const ids = await seedHeroes(db, count, { startId });
    for (let i = 0; i < count; i++) await claimCharacter(db, startId + i, new Date(T0));
    return ids;
  };

  it("12 parallel requests from ONE member with DIFFERENT keys (twelve tabs): exactly one reroll, eleven refusals, one version", async () => {
    await resetDb(db);
    const [hero] = await claimed(1, 910_000);
    const rs = await settle(Array.from({ length: 12 }, () => rerollOwnHero(db, 910_000, crypto.randomUUID(), deps)));
    expect(codes(rs).filter((c) => c === "OK")).toHaveLength(1);
    expect(codes(rs).filter((c) => c !== "OK").every((c) => c === "ALREADY_USED_TODAY")).toBe(true);
    expect(await n("select count(*)::int as n from public.hero_versions where character_id = $1", hero)).toBe(2);
    expect(await n("select count(*)::int as n from public.hero_free_rerolls where telegram_user_id = 910000")).toBe(1);
    expect(await clean()).toBe(0);
  });

  it("12 parallel requests with the SAME key (a retry storm / double click): one version, every answer identical", async () => {
    await resetDb(db);
    const [hero] = await claimed(1, 911_000);
    const key = crypto.randomUUID();
    const rs = await settle(Array.from({ length: 12 }, () => rerollOwnHero(db, 911_000, key, deps)));
    expect(codes(rs)).toEqual(Array(12).fill("OK"));
    const ok = rs.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof rerollOwnHero>>> => r.status === "fulfilled").map((r) => r.value);
    expect(ok.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect(new Set(ok.map((r) => JSON.stringify(r.after))).size).toBe(1);
    expect(await n("select count(*)::int as n from public.hero_versions where character_id = $1", hero)).toBe(2);
    expect(await clean()).toBe(0);
  });

  it("the midnight race: requests landing on both sides of 00:00 UTC are decided by the server's instant — one per day, never two for one day", async () => {
    await resetDb(db);
    const [hero] = await claimed(1, 912_000);
    const before = new FakeClock(Date.UTC(2026, 9, 9, 23, 59, 59, 900));
    const after = new FakeClock(Date.UTC(2026, 9, 10, 0, 0, 0, 100));
    const rs = await settle([
      ...Array.from({ length: 4 }, () => rerollOwnHero(db, 912_000, crypto.randomUUID(), { ...deps, now: before.now })),
      ...Array.from({ length: 4 }, () => rerollOwnHero(db, 912_000, crypto.randomUUID(), { ...deps, now: after.now })),
    ]);
    expect(codes(rs).filter((c) => c === "OK")).toHaveLength(2); // one for 2026-10-09, one for 2026-10-10
    const days = (await db.query<{ d: string }>("select utc_day::text as d from public.hero_free_rerolls where telegram_user_id = 912000 order by utc_day")).map((r) => r.d);
    expect(days).toEqual(["2026-10-09", "2026-10-10"]);
    expect(await n("select count(*)::int as n from public.hero_versions where character_id = $1", hero)).toBe(3);
    expect(await clean()).toBe(0);
  });

  it("40 members each fire 3 parallel requests: every member gets exactly one reroll, nobody deadlocks, nothing leaks between members", async () => {
    await resetDb(db);
    const ids = await claimed(40, 920_000);
    const rs = await settle(ids.flatMap((_, i) => [0, 1, 2].map(() => rerollOwnHero(db, 920_000 + i, crypto.randomUUID(), deps))));
    expect(codes(rs).filter((c) => c === "OK")).toHaveLength(40);
    expect(codes(rs).filter((c) => c !== "OK").every((c) => c === "ALREADY_USED_TODAY")).toBe(true);
    for (const id of ids) expect(await n("select count(*)::int as n from public.hero_versions where character_id = $1", id)).toBe(2);
    expect(await n("select count(*)::int as n from public.hero_free_rerolls")).toBe(40);
    expect(await clean()).toBe(0);
  }, 120_000);

  it("the Arena freezing rosters while heroes reroll: a hero committed to a roster is NEVER changed — up to 8 rounds of races, zero torn snapshots", async () => {
    await resetDb(db);
    const ids = await claimed(32, 930_000);
    const tidOf = new Map(ids.map((id, i) => [id, 930_000 + i] as const));
    let refused = 0;
    let rerolled = 0;
    for (let round = 0; round < 4; round++) {
      // fresh cycle each round: only rosters of THIS round matter (clock moves a UTC day so allowances renew)
      clock.ms = T0 + (round + 1) * 86_400_000;
      const rs = await settle([
        advanceArena(arenaDb, arenaCtx(clock)),
        ...ids.map((id) => rerollOwnHero(db, tidOf.get(id)!, crypto.randomUUID(), deps)),
      ]);
      for (const r of rs.slice(1)) {
        if (r.status === "fulfilled") rerolled++;
        else {
          const code = (r.reason as FreeRerollError).code;
          expect(["HERO_IN_ARENA", "ALREADY_USED_TODAY"], `round ${round}: ${code}`).toContain(code);
          if (code === "HERO_IN_ARENA") refused++;
        }
      }
      // THE invariant: every frozen snapshot shows each fighter exactly as the version that was current when the roster froze
      const frozen = await db.query<{ id: string; snapshot: { display: Array<{ characterId: string; classId: string; appearance: { rarity: string } }> } }>(
        "select id, snapshot from public.arena_battles where status in ('SCHEDULED','SIMULATED','SETTLED') and snapshot is not null",
      );
      for (const b of frozen) {
        for (const d of b.snapshot.display) {
          const versions = await db.query<{ class_id: string; rarity: string; created_at: Date }>("select class_id, rarity, created_at from public.hero_versions where character_id = $1 order by version_number", [d.characterId]);
          expect(versions.some((v) => v.class_id === d.classId && v.rarity === d.appearance.rarity), `battle ${b.id}: ${d.characterId}`).toBe(true);
        }
      }
      expect(await clean()).toBe(0);
    }
    expect(rerolled).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    // and nobody who was refused for the Arena lost their allowance: they can reroll once free
    const locked = (await Promise.all(ids.map(async (id) => ((await heroArenaLock(db, id)).locked ? id : null)))).filter(Boolean) as string[];
    expect(locked.length).toBeGreaterThan(0);
  }, 180_000);
});
