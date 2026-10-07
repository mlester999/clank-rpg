import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadClasses, loadRuleset, loadSettings } from "@/server/config/settingsRepo";
import { createPostgresDb } from "@/server/db/postgres";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { advanceArena, type BattleSnapshot } from "@/server/services/arena";
import { loadFighters } from "@/server/services/characters";
import { applyRerollPreview, previewReroll, rebalanceHero, rollbackHero, type HeroVersioningDeps } from "@/server/services/heroVersions";
import { seedReferenceData } from "@/server/seed/reference";

import { arenaCtx, FakeClock, SUPABASE_ROLE_SHIM, resetDb, seedHeroes } from "../support/db";

/**
 * REAL concurrency: this suite runs only against a real Postgres (PGlite has ONE connection, so "concurrent" requests there are merely
 * queued). Point CLANK_TEST_PG_URL at a THROWAWAY server (never a database that matters — it creates and drops its own database):
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/integration/hero-versions-postgres.test.ts
 */
const url = process.env.CLANK_TEST_PG_URL;
const SECRET = "test-secret-value-1234567890";

describe.skipIf(!url)("hero versions with REAL parallel connections", () => {
  let admin: Db;
  let db: Db;
  let arenaDb: Db;
  let dbName: string;
  let deps: HeroVersioningDeps;

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_hv_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 16 });
    arenaDb = createPostgresDb(u.toString(), { maxConnections: 4 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
    deps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: SECRET };
    // Sensitivity check of THIS suite (RACE_MUTATION=drop-fk): without the roster's foreign key to `characters` there is nothing that makes an Admin change and
    // roster scheduling exclude each other — the invariant below must then FAIL, proving the suite can see the race it guards against.
    if (process.env.RACE_MUTATION === "drop-fk") {
      const fks = await db.query<{ conrelid: string; conname: string }>(
        `select conrelid::regclass::text as conrelid, conname from pg_constraint where contype = 'f' and confrelid = 'public.characters'::regclass and conrelid in ('public.arena_participants'::regclass, 'public.arena_queue_entries'::regclass)`,
      );
      for (const fk of fks) await db.exec(`alter table ${fk.conrelid} drop constraint ${fk.conname}`);
    }
    // A slow admin transaction: sleeps inside the version insert (after the Arena-roster check, before the commit).
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
  const codes = (rs: Array<PromiseSettledResult<unknown>>) => rs.map((r) => (r.status === "fulfilled" ? "OK" : ((r.reason as { code?: string; message?: string }).code ?? (r.reason as Error).message)));
  const versionCount = async (id: string) => Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1", [id]))[0]!.n);
  const clean = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()"))[0]!.n);

  it("8 parallel Applies of the SAME preview: one version is written, the rest answer idempotently", async () => {
    await resetDb(db);
    const [id] = await seedHeroes(db, 1);
    const p = await previewReroll(db, id!, "admin", deps);
    const rs = await settle(Array.from({ length: 8 }, () => applyRerollPreview(db, id!, p.previewId, "admin", deps)));
    expect(codes(rs)).toEqual(Array(8).fill("OK"));
    const fulfilled = rs.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof applyRerollPreview>>> => r.status === "fulfilled").map((r) => r.value);
    expect(fulfilled.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect(new Set(fulfilled.map((r) => r.version.id)).size).toBe(1);
    expect(await versionCount(id!)).toBe(2);
    expect(await clean()).toBe(0);
  });

  it("6 previews of the same base applied in parallel: exactly one wins, five are STALE, one current version", async () => {
    await resetDb(db);
    const [id] = await seedHeroes(db, 1);
    const previews = await Promise.all(Array.from({ length: 6 }, () => previewReroll(db, id!, "admin", deps)));
    const rs = await settle(previews.map((p) => applyRerollPreview(db, id!, p.previewId, "admin", deps)));
    expect(codes(rs).sort()).toEqual(["OK", "STALE_PREVIEW", "STALE_PREVIEW", "STALE_PREVIEW", "STALE_PREVIEW", "STALE_PREVIEW"]);
    expect(await versionCount(id!)).toBe(2);
    const [cur] = await db.query<{ n: number }>("select v.version_number as n from public.hero_versions v join public.characters c on c.current_hero_version_id = v.id where c.id = $1", [id]);
    expect(cur!.n).toBe(2);
    expect(await clean()).toBe(0);
  });

  it("Apply vs Rollback, and two Rollbacks, race: one committed transition each — no duplicate version numbers, no split brain", async () => {
    await resetDb(db);
    const [id] = await seedHeroes(db, 1);
    for (let i = 0; i < 2; i++) await applyRerollPreview(db, id!, (await previewReroll(db, id!, "admin", deps)).previewId, "admin", deps);
    const vs = await db.query<{ id: string; version_number: number }>("select id, version_number from public.hero_versions where character_id = $1 order by version_number", [id]);
    const [v1, , v3] = vs;
    for (let round = 0; round < 5; round++) {
      const base = (await db.query<{ id: string }>("select current_hero_version_id as id from public.characters where id = $1", [id]))[0]!.id;
      const p = await previewReroll(db, id!, "admin", deps);
      const target = v1!.id === base ? v3!.id : v1!.id;
      const before = await versionCount(id!);
      const rs = await settle([
        applyRerollPreview(db, id!, p.previewId, "admin", deps),
        rollbackHero(db, { characterId: id!, targetVersionId: target, expectedCurrentVersionId: base, requestId: crypto.randomUUID() }, "admin", deps),
        rollbackHero(db, { characterId: id!, targetVersionId: target, expectedCurrentVersionId: base, requestId: crypto.randomUUID() }, "admin", deps),
      ]);
      expect(codes(rs).filter((c) => c === "OK"), `round ${round}: ${codes(rs)}`).toHaveLength(1);
      expect(codes(rs).filter((c) => c !== "OK").every((c) => c === "STALE_VERSION" || c === "STALE_PREVIEW")).toBe(true);
      expect(await versionCount(id!)).toBe(before + 1);
      expect(await clean()).toBe(0);
    }
    const numbers = (await db.query<{ version_number: number }>("select version_number from public.hero_versions where character_id = $1 order by version_number", [id])).map((r) => r.version_number);
    expect(numbers).toEqual(Array.from({ length: numbers.length }, (_, i) => i + 1));
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.admin_audit_log where action in ('hero.reroll','hero.rollback')"))[0]!.n)).toBe(numbers.length - 1);
  });

  it("the Arena freezing rosters while admins reroll those very heroes: no hero is ever changed AFTER its stats were frozen (no deadlock, no torn snapshot)", async () => {
    let refused = 0;
    let applied = 0;
    for (let round = 0; round < Number(process.env.RACE_ROUNDS ?? 6); round++) {
      await resetDb(db);
      const ids = await seedHeroes(db, 40);
      const clock = new FakeClock(Date.now());
      const ctx = arenaCtx(clock);
      // Previews are drawn FIRST, so the Applies below start at the very moment the arena starts freezing rosters (and, with a real network between the
      // admin console and the database, every statement of an Apply takes 100+ ms — modelled here by a trigger that sleeps inside the version insert).
      const previews = await Promise.all(ids.flatMap((id) => [0, 1].map(async () => ({ id, p: await previewReroll(db, id, "admin", deps) }))));
      const attempts = previews.map(({ id, p }) => applyRerollPreview(db, id, p.previewId, "admin", deps));
      // The Arena worker is ANOTHER process in production: it has its own connections and never queues behind the admin console.
      const advances = Array.from({ length: 3 }, () => advanceArena(arenaDb, ctx));
      const rs = await settle([...advances, ...attempts]);
      const failures = codes(rs).filter((c) => c !== "OK");
      for (const f of failures) expect(["HERO_IN_ARENA", "STALE_PREVIEW"], `unexpected failure: ${f}`).toContain(f); // never a deadlock / serialization error
      refused += failures.filter((c) => c === "HERO_IN_ARENA").length;
      applied += codes(rs).filter((c) => c === "OK").length - advances.length;

      // INVARIANT: every roster that is frozen (SIMULATED) still equals the heroes' CURRENT state — class, look and the exact stats the fight was simulated with.
      const settings = await loadSettings(db);
      const { ruleset } = await loadRuleset(db, settings);
      const battles = await db.query<{ id: string; snapshot: BattleSnapshot }>("select id, snapshot from public.arena_battles where status = 'SIMULATED' order by sequence");
      expect(battles.length).toBeGreaterThan(0);
      for (const b of battles) {
        const fighters = await loadFighters(db, b.snapshot.display.map((d) => d.characterId), ruleset, settings);
        for (const f of fighters) {
          const frozen = b.snapshot.display.find((d) => d.characterId === f.characterId)!;
          const unit = b.snapshot.units.find((u) => u.characterId === f.characterId)!;
          expect(frozen.classId, "class").toBe(f.classId);
          expect(frozen.appearance.rarity, "rarity").toBe(f.appearance.rarity);
          expect(unit.stats, "stats the fight was simulated with").toEqual(f.stats);
        }
      }
      expect(await clean()).toBe(0);
    }
    expect(applied).toBeGreaterThan(0); // the admins really did change heroes …
    if (process.env.RACE_LOG) appendFileSync(process.env.RACE_LOG, `[postgres race] ${applied} rerolls applied, ${refused} refused because the hero was already frozen in a roster\n`);
  }, 300_000);

  it("8 parallel SYSTEM_REBALANCEs of the SAME legacy hero (real connections): exactly one SYSTEM_REBALANCE version is written, the rest answer ALREADY_ON_CURRENT_GENERATOR, v1 is untouched", async () => {
    await resetDb(db);
    const [id] = await seedHeroes(db, 1, { legacy: true });
    const v1Before = JSON.stringify((await db.query<{ row: unknown }>("select to_jsonb(v) as row from public.hero_versions v where v.character_id = $1 and v.version_number = 1", [id]))[0]!.row);
    const rs = await settle(Array.from({ length: 8 }, () => rebalanceHero(db, id!, "system:rebalance", deps)));
    expect(codes(rs)).toEqual(Array(8).fill("OK"));
    const statuses = rs.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof rebalanceHero>>>).value.status).sort();
    expect(statuses.filter((x) => x === "REBALANCED")).toHaveLength(1);
    expect(statuses.filter((x) => x === "ALREADY_ON_CURRENT_GENERATOR")).toHaveLength(7);
    expect(await versionCount(id!)).toBe(2);
    expect(JSON.stringify((await db.query<{ row: unknown }>("select to_jsonb(v) as row from public.hero_versions v where v.character_id = $1 and v.version_number = 1", [id]))[0]!.row)).toBe(v1Before);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_rarity_power()"))[0]!.n)).toBe(0);
    expect(await clean()).toBe(0);
  });

  it("the Arena freezing rosters while the SYSTEM REBALANCES those very legacy heroes: no hero is ever rebalanced AFTER its stats were frozen (refused with HERO_IN_ARENA, never a deadlock)", async () => {
    let refused = 0;
    let rebalanced = 0;
    for (let round = 0; round < Number(process.env.RACE_ROUNDS ?? 4); round++) {
      await resetDb(db);
      const ids = await seedHeroes(db, 40, { legacy: true });
      const clock = new FakeClock(Date.now());
      const ctx = arenaCtx(clock);
      const attempts = ids.flatMap((id) => [0, 1].map(() => rebalanceHero(db, id, "system:rebalance", deps)));
      const advances = Array.from({ length: 3 }, () => advanceArena(arenaDb, ctx));
      const rs = await settle([...advances, ...attempts]);
      const failures = codes(rs).filter((c) => c !== "OK");
      for (const f of failures) expect(["HERO_IN_ARENA"], `unexpected failure: ${f}`).toContain(f); // never a deadlock / serialization error
      refused += failures.length;
      rebalanced += rs.slice(advances.length).filter((r) => r.status === "fulfilled" && (r.value as { status: string }).status === "REBALANCED").length;

      // INVARIANT: every frozen (SIMULATED) roster still equals the heroes' CURRENT state — the stats a fight was simulated with are the stats the hero has.
      const settings = await loadSettings(db);
      const { ruleset } = await loadRuleset(db, settings);
      const battles = await db.query<{ id: string; snapshot: BattleSnapshot }>("select id, snapshot from public.arena_battles where status = 'SIMULATED' order by sequence");
      expect(battles.length).toBeGreaterThan(0);
      for (const b of battles) {
        const fighters = await loadFighters(db, b.snapshot.display.map((d) => d.characterId), ruleset, settings);
        for (const f of fighters) {
          const unit = b.snapshot.units.find((u) => u.characterId === f.characterId)!;
          expect(unit.stats, "stats the fight was simulated with").toEqual(f.stats);
        }
      }
      expect(await clean()).toBe(0);
    }
    expect(rebalanced).toBeGreaterThan(0); // the system really did move heroes …
    expect(refused).toBeGreaterThan(0); // … and really did meet frozen rosters
    if (process.env.RACE_LOG) appendFileSync(process.env.RACE_LOG, `[postgres race] ${rebalanced} rebalances applied, ${refused} refused because the hero was already frozen in a roster\n`);
  }, 300_000);
});
