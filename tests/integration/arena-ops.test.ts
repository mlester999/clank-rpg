import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { arenaAdmin } from "@/server/services/admin";
import { arenaOps } from "@/server/services/arenaOps";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { arenaStatus, runUntil } from "../support/lifecycle";

/** Admin → Arena operations: everything players must NOT see lives here. */
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

const ops = () => arenaOps(db, { now: clock.ms, allowDemo: true, groupSize: 8 });

describe("arenaOps (admin only)", () => {
  it("reports the active cycle, eligible and remaining heroes, queued groups, current and next battle, timing and a healthy worker", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const o = await ops();
    expect(o.eligibleHeroes).toBe(24);
    // 24 heroes are on stage / lined up (the one on stage + the two prepared ahead); nobody has FINISHED yet, so nobody counts as having fought.
    expect(o.cycle).toMatchObject({ number: 1, heroCount: 24, fought: 0, inBattle: 24, remaining: 24 });
    expect(o.current).toMatchObject({ sequence: 1, status: "SIMULATED" });
    expect(o.next).toMatchObject({ sequence: 2 });
    expect(o.queuedGroups.length).toBe(0); // every group of this cycle is already on stage or prepared
    expect(o.nextTransition).toMatchObject({ what: expect.stringContaining("combat ends") });
    expect(o.integrity.every((i) => i.ok)).toBe(true);
    expect(o.alerts).toEqual([]);
  });

  it("counts a hero as 'fought' only once its battle has settled", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    clock.ms = (await ops()).current!.combatEndsAt! + 10;
    await advanceArena(db, ctx);
    const o = await ops();
    expect(o.cycle).toMatchObject({ fought: 8, battlesDone: 1 });
    expect(o.worker.status).toBe("HEALTHY");
  });

  it("flags a stale worker, a paused arena and an overdue settlement", async () => {
    await seedHeroes(db, 16);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    clock.ms = (await ops()).current!.combatEndsAt! + 10;
    await advanceArena(db, ctx); // settles → last_advance_at = now
    clock.advance(10 * 60_000);
    let o = await ops();
    expect(o.worker.status).toBe("STALE");
    expect(o.alerts.some((a) => a.type === "WORKER_STALE" && a.severity === "critical")).toBe(true);
    // A pause DRAINS: the battles already committed are fought and settled first, then the Arena is PAUSED.
    await arenaAdmin(db, "pause", "test", { now: clock.now, allowDemo: true });
    o = await ops();
    expect(o.status).toBe("PAUSE_REQUESTED");
    expect(o.alerts.some((a) => a.type === "ARENA_PAUSING" && a.severity === "info")).toBe(true);
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    o = await ops();
    expect(o.status).toBe("PAUSED");
    expect(o.worker.status).toBe("PAUSED"); // a paused Arena is not a "stale worker"
    expect(o.alerts.some((a) => a.type === "ARENA_PAUSED")).toBe(true);
    expect(o.alerts.some((a) => a.type === "WORKER_STALE")).toBe(false);
  });

  it("a stopped Arena (not started) is reported as such — an info alert, never a stale worker", async () => {
    await db.exec("update public.arena_state set status = 'PAUSED'");
    await db.exec("update public.arena_state set status = 'NOT_STARTED', last_advance_at = null, started_at = null");
    await seedHeroes(db, 16);
    const o = await ops();
    expect(o.status).toBe("NOT_STARTED");
    expect(o.worker.status).toBe("NOT_STARTED");
    expect(o.alerts.some((a) => a.type === "ARENA_NOT_STARTED" && a.severity === "info")).toBe(true);
    expect(o.alerts.some((a) => a.type === "WORKER_STALE" || a.type === "NOT_ENOUGH_HEROES")).toBe(false);
  });

  it("alerts when there are not enough heroes and when battles were voided or heroes skipped", async () => {
    await seedHeroes(db, 3);
    expect((await ops()).alerts.some((a) => a.type === "NOT_ENOUGH_HEROES")).toBe(true);
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    await arenaAdmin(db, "void_unsettled", "test");
    expect((await ops()).alerts.some((a) => a.type === "BATTLES_VOIDED")).toBe(true);
  });

  it("detects queue corruption through its integrity checks", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    await db.query("update public.arena_queue_entries set status = 'COMPLETED' where status = 'IN_BATTLE' and position = 0");
    const o = await ops();
    expect(o.integrity.some((i) => !i.ok)).toBe(true);
    expect(o.alerts.some((a) => a.type === "QUEUE_INTEGRITY")).toBe(true);
  });
});
