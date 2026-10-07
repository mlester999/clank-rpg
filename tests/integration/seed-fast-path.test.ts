import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ACHIEVEMENTS } from "@/domain/content";
import type { Db, Queryable } from "@/server/db/types";
import { getReadyDb } from "@/server/runtime";
import { seedReferenceData } from "@/server/seed/reference";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * The reference-data seed runs on EVERY cold start of a serverless instance, and every request of that instance waits for it. Its full pass is
 * ~130 sequential INSERT … ON CONFLICT DO NOTHING round trips (≈ 40 s at 150 ms to the database): behind the Transaction Pooler the first request of
 * each fresh instance sat there until the platform's 60 s / 300 s limit. On a database that already holds the defaults it must cost ONE statement,
 * and when anything is missing the full pass must still run, unchanged (insert what is missing, never overwrite an edit).
 */
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db); // truncates everything and seeds once
});

function counting(inner: Db): { q: Queryable; count: () => number } {
  let n = 0;
  return { q: { query: (t, p) => (n++, inner.query(t, p)), exec: (t) => (n++, inner.exec(t)) }, count: () => n };
}

describe("seedReferenceData", () => {
  it("costs ONE statement on a database that already holds the defaults, and writes nothing", async () => {
    const before = JSON.stringify(await db.query("select (select count(*) from public.game_settings) as s, (select count(*) from public.achievements) as a, (select count(*) from public.item_templates) as i, (select count(*) from public.feature_flags) as f, (select count(*) from public.seasons) as seasons"));
    const c = counting(db);
    const result = await seedReferenceData(c.q);
    expect(c.count()).toBe(1);
    expect(result.inserted).toEqual({ settings: 0, classes: 0, skills: 0, achievements: 0, items: 0, flags: 0, spriteConfigs: 0 });
    expect(JSON.stringify(await db.query("select (select count(*) from public.game_settings) as s, (select count(*) from public.achievements) as a, (select count(*) from public.item_templates) as i, (select count(*) from public.feature_flags) as f, (select count(*) from public.seasons) as seasons"))).toBe(before);
  });

  it("still runs the full pass when a default row is missing — inserting only what is missing and never overwriting an edit", async () => {
    const [victim, edited] = DEFAULT_ACHIEVEMENTS;
    await db.query("delete from public.achievements where id = $1", [victim!.id]);
    await db.query("update public.achievements set name = 'edited by an admin' where id = $1", [edited!.id]);
    const c = counting(db);
    const result = await seedReferenceData(c.q);
    expect(c.count()).toBeGreaterThan(100); // the full pass
    expect(result.inserted.achievements).toBe(1);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.achievements where id = $1", [victim!.id]))[0]?.n).toBe(1);
    expect((await db.query<{ name: string }>("select name from public.achievements where id = $1", [edited!.id]))[0]?.name).toBe("edited by an admin");
    // and the very next call is the cheap one again
    const again = counting(db);
    await seedReferenceData(again.q);
    expect(again.count()).toBe(1);
  });

  it("still persists a missing sprite config (a hero that predates the layered sprites)", async () => {
    await seedHeroes(db, 1);
    // Emulates a LEGACY row (NULL sprite) by editing the look column directly — which the projection guard (covered in hero-versions.test.ts) forbids
    // for a versioned hero — exactly as sprites-persistence.test.ts does; the guard is switched off for this test only.
    await db.exec("alter table public.character_appearances disable trigger character_appearances_hero_projection");
    try {
      await db.exec("update public.character_appearances set sprite = null");
      const result = await seedReferenceData(db);
      expect(result.inserted.spriteConfigs).toBe(1);
      expect((await db.query<{ n: number }>("select count(*)::int as n from public.character_appearances where sprite is null"))[0]?.n).toBe(0);
    } finally {
      await db.exec("alter table public.character_appearances enable trigger character_appearances_hero_projection");
    }
  });

  it("on an empty database the full pass seeds everything (first boot)", async () => {
    await db.exec("truncate table public.game_settings, public.feature_flags cascade");
    const result = await seedReferenceData(db);
    expect(result.inserted.settings).toBeGreaterThan(0);
    expect(result.inserted.flags).toBeGreaterThan(0);
  });
});

describe("getReadyDb", () => {
  type Global = { __clankDb?: { promise: Promise<Db> | null }; __clankSeeded?: Promise<void> };
  const g = globalThis as unknown as Global;

  it("forgets a seed that failed: the next request retries it instead of every request failing (or hanging) forever", async () => {
    let failures = 2; // the probe (swallowed) and the first insert of the full pass
    const flaky: Db = {
      driver: db.driver,
      query: (t, p) => (failures-- > 0 ? Promise.reject(new Error("connection lost")) : db.query(t, p)),
      exec: (t) => db.exec(t),
      transaction: (fn) => db.transaction(fn),
      close: () => Promise.resolve(),
    };
    await db.exec("truncate table public.feature_flags cascade"); // something is missing, so the full pass runs and hits the failure
    const saved = { holder: g.__clankDb, seeded: g.__clankSeeded };
    g.__clankDb = { promise: Promise.resolve(flaky) };
    g.__clankSeeded = undefined;
    try {
      await expect(getReadyDb()).rejects.toThrow("connection lost");
      expect(g.__clankSeeded).toBeUndefined(); // not cached
      await expect(getReadyDb()).resolves.toBe(flaky); // retried, and now it works
      const again = await getReadyDb(); // cached from here on: no further statements
      expect(again).toBe(flaky);
      expect(g.__clankSeeded).toBeDefined();
    } finally {
      g.__clankDb = saved.holder;
      g.__clankSeeded = saved.seeded;
    }
  });
});
