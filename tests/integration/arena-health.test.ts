import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { arenaHealth } from "@/server/services/arenaHealth";
import { pauseArena, startArena } from "@/server/services/lifecycle";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { adminDeps, freshDevelopment, runUntil } from "../support/lifecycle";

/** The worker-is-down signal: nothing is "stalled" while the Arena is stopped or being advanced; it turns on once something DUE has waited > 30 s. */
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
  await seedHeroes(db, 24);
});

describe("arenaHealth", () => {
  it("a stopped Arena is never stalled", async () => {
    expect(await arenaHealth(db, Date.now() + 3_600_000)).toMatchObject({ status: "NOT_STARTED", stalled: false, settleOverdueMs: 0, queueDryMs: 0 });
  });

  it("a RUNNING Arena that is being advanced is healthy; with nobody advancing it, it becomes stalled once something due has waited 30 s", async () => {
    const clock = new FakeClock(Date.now());
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await db.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'SETTLED'"))[0]!.n >= 2);
    expect(await arenaHealth(db, clock.now().getTime())).toMatchObject({ status: "RUNNING", stalled: false });

    // The worker dies: no more advances while the wall clock goes on. The first thing that falls due is the earliest of "a decided battle awaits settlement" and
    // "the last prepared battle's slot ends".
    const settleDue = (await db.query<{ t: Date | null }>("select min(combat_ends_at) as t from public.arena_battles where status = 'SIMULATED'"))[0]?.t ?? null;
    const latestSlotEnd = (await db.query<{ t: Date }>("select max(slot_ends_at) as t from public.arena_battles"))[0]!.t.getTime();
    const firstDue = Math.min(settleDue?.getTime() ?? Number.POSITIVE_INFINITY, latestSlotEnd);
    expect((await arenaHealth(db, firstDue + 10_000)).stalled).toBe(false); // 10 s late: a normal gap
    const stalled = await arenaHealth(db, firstDue + 45_000);
    expect(stalled.status).toBe("RUNNING");
    expect(stalled.stalled).toBe(true);
    expect(Math.max(stalled.settleOverdueMs, stalled.queueDryMs)).toBeGreaterThanOrEqual(45_000);

    // The worker comes back and catches up: healthy again.
    const catchUp = new FakeClock(firstDue + 45_000);
    await advanceArena(db, arenaCtx(catchUp));
    expect((await arenaHealth(db, catchUp.now().getTime())).stalled).toBe(false);
  });

  it("PAUSED is never stalled however long ago the last battle ended", async () => {
    const clock = new FakeClock(Date.now());
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await db.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'SETTLED'"))[0]!.n >= 1);
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await db.query<{ status: string }>("select status from public.arena_state"))[0]!.status === "PAUSED");
    expect(await arenaHealth(db, clock.now().getTime() + 86_400_000)).toMatchObject({ status: "PAUSED", stalled: false });
  });
});
