import { appendFileSync } from "node:fs";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, eligibleHeroIds } from "@/server/services/arena";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * The Arena at the size the community will have after the guarded hero backfill: 70 + 69 = 139 heroes (each with its hero version).
 * Groups of 8, every eligible hero once per queue cycle, leftovers carried to the front of the next cycle, suspended heroes never queued,
 * and an Arena state that is no slower to build than with a handful of heroes.
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
  clock = new FakeClock();
});

async function runUntil(until: () => Promise<boolean>, stepMs = 2000, maxSteps = 4000) {
  const ctx = arenaCtx(clock);
  for (let i = 0; i < maxSteps; i++) {
    await advanceArena(db, ctx);
    if (await until()) return;
    clock.advance(stepMs);
  }
  throw new Error("condition not reached");
}

const cycleBattles = async (cycleId: string) =>
  db.query<{ id: string; sequence: number; heroes: string[] }>(
    `select b.id, b.sequence, array_agg(p.character_id::text order by p.character_id) as heroes
       from public.arena_battles b join public.arena_participants p on p.battle_id = b.id where b.cycle_id = $1 group by b.id, b.sequence order by b.sequence`,
    [cycleId],
  );

describe("139 heroes", () => {
  it("every hero has exactly one INITIAL version; the queue plans 17 full groups of 8 and carries 3 heroes", async () => {
    const heroes = await seedHeroes(db, 139);
    expect(await count(db, "characters")).toBe(139);
    expect(await count(db, "hero_versions", "action = 'INITIAL'")).toBe(139);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()"))[0]!.n).toBe(0);
    expect(await eligibleHeroIds(db, true)).toHaveLength(139);

    await runUntil(async () => (await count(db, "arena_cycles", "status = 'COMPLETED'")) >= 1 && (await count(db, "arena_cycles")) >= 2);
    const [c1, c2] = await db.query<{ id: string; number: number; hero_count: number; carried_out_count: number; carried_in_count: number }>("select id, number, hero_count, carried_out_count, carried_in_count from public.arena_cycles order by number limit 2");
    expect(c1).toMatchObject({ number: 1, hero_count: 139, carried_out_count: 3 });
    expect(c2).toMatchObject({ number: 2, carried_in_count: 3 });

    const battles = await cycleBattles(c1!.id);
    expect(battles).toHaveLength(17);
    for (const b of battles) {
      expect(b.heroes).toHaveLength(8); // 8 fighters per battle …
      expect(new Set(b.heroes).size).toBe(8); // … never the same fighter twice
    }
    const seen = battles.flatMap((b) => b.heroes);
    expect(new Set(seen).size).toBe(136); // each eligible hero AT MOST once per cycle, none twice
    expect(seen.length).toBe(136);
    const carried = (await db.query<{ character_id: string }>("select character_id from public.arena_queue_entries where cycle_id = $1 and status = 'CARRIED_FORWARD'", [c1!.id])).map((r) => r.character_id);
    expect(carried).toHaveLength(3);
    expect(carried.every((id) => !seen.includes(id) && heroes.includes(id))).toBe(true); // the leftovers did not fight in cycle 1 …
    const next = await cycleBattles(c2!.id);
    expect(next[0]!.heroes.filter((h) => carried.includes(h)).sort()).toEqual([...carried].sort()); // … and they open cycle 2 (first battle)
  }, 180_000);

  it("suspended heroes are never queued — and nobody is lost or duplicated", async () => {
    const heroes = await seedHeroes(db, 139);
    const suspended = heroes.slice(0, 6);
    await db.query("update public.characters set status = 'SUSPENDED' where id = any($1::uuid[])", [suspended]);
    expect(await eligibleHeroIds(db, true)).toHaveLength(133);
    await runUntil(async () => (await count(db, "arena_cycles", "status = 'COMPLETED'")) >= 1);
    const [c1] = await db.query<{ id: string; hero_count: number; carried_out_count: number }>("select id, hero_count, carried_out_count from public.arena_cycles order by number limit 1");
    expect(c1).toMatchObject({ hero_count: 133, carried_out_count: 5 }); // 16 groups of 8 = 128, 5 carried
    const fought = (await cycleBattles(c1!.id)).flatMap((b) => b.heroes);
    expect(fought).toHaveLength(128);
    expect(new Set(fought).size).toBe(128);
    expect(fought.some((id) => suspended.includes(id))).toBe(false);
    // a hero suspended AFTER it was queued is skipped, not fought
    const [pending] = await db.query<{ character_id: string }>("select e.character_id from public.arena_queue_entries e join public.arena_cycles c on c.id = e.cycle_id where c.status = 'ACTIVE' and e.status = 'PENDING' order by e.position limit 1");
    if (pending) {
      await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [pending.character_id]);
      await runUntil(async () => (await count(db, "arena_queue_entries", `character_id = '${pending.character_id}' and status = 'SKIPPED'`)) > 0, 2000, 800);
      expect(await count(db, "arena_participants", `character_id = '${pending.character_id}' and battle_id in (select id from public.arena_battles where status = 'SETTLED' and settled_at > now() - interval '0 seconds')`)).toBe(0);
    }
  }, 240_000);

  it("a RESTART mid-cycle resumes fairly: the persisted queue continues, nobody fights twice in the cycle", async () => {
    await seedHeroes(db, 139);
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 6);
    // "restart": every in-memory object is new; only the database remains
    clock = new FakeClock(clock.ms + 90_000); // the process was down for 90 s
    await runUntil(async () => (await count(db, "arena_cycles", "status = 'COMPLETED'")) >= 1);
    const [c1] = await db.query<{ id: string }>("select id from public.arena_cycles order by number limit 1");
    const fought = (await cycleBattles(c1!.id)).flatMap((b) => b.heroes);
    expect(new Set(fought).size).toBe(fought.length); // no hero twice in one cycle, across the restart
    expect(fought.length).toBe(136);
  }, 240_000);

  it("the upcoming and the prepared rosters are correct and disjoint from the battle on stage; the Arena state is no slower than with a small roster", async () => {
    await seedHeroes(db, 139);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes, picksEnabled: true });
    expect(state.current!.fighters).toHaveLength(8);
    expect(state.upcoming!.fighters).toHaveLength(8);
    const onStage = new Set(state.current!.fighters.map((f) => f.characterId));
    const upcoming = state.upcoming!.fighters.map((f) => f.characterId);
    expect(upcoming.some((id) => onStage.has(id))).toBe(false);
    const prepared = await db.query<{ status: string }>("select status from public.arena_battles order by sequence");
    expect(prepared.map((b) => b.status)).toEqual(["SIMULATED", "SIMULATED", "SIMULATED"]); // on stage + upcoming + one behind
    expect(state.eligibleHeroes).toBe(139);

    const timeIt = async () => {
      const samples: number[] = [];
      for (let i = 0; i < 25; i++) {
        const t0 = performance.now();
        await getArenaState(db, clock.ms, settings, { allowDemo: true, classes, picksEnabled: true });
        samples.push(performance.now() - t0);
      }
      return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
    };
    const big = await timeIt();
    await resetDb(db);
    clock = new FakeClock();
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const small = await timeIt();
    if (process.env.QUEUE139_LOG) appendFileSync(process.env.QUEUE139_LOG, `arena state median ms: 139 heroes=${big.toFixed(2)} 24 heroes=${small.toFixed(2)}\n`);
    // the state is built from the (fixed-size) battles on stage, never from the whole roster: 139 heroes must not make it meaningfully slower
    expect(big).toBeLessThan(Math.max(small * 2.5, 60));
  }, 120_000);
});
