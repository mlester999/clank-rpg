import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { AdminError } from "@/server/services/adminError";
import { getGameControl, pauseArena, resumeArena, startArena } from "@/server/services/lifecycle";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { activeSeason, adminDeps, arenaStatus, battleNumbers, freshDevelopment, gamePhase, idleFor, runUntil } from "../support/lifecycle";

/**
 * THE ARENA'S RUNTIME STATE — NOT_STARTED → PREPARING → RUNNING ⇄ PAUSE_REQUESTED → PAUSED — persisted in the database, enforced by the Arena step and by
 * database triggers, driven only by the Admin actions. A worker process, a viewer's request or a restart can never start the Arena.
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

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AdminError ? e.code : `ERROR:${(e as Error).message}`;
  }
};

describe("a freshly migrated database", () => {
  it("is in the DEVELOPMENT phase with the Arena NOT_STARTED and a development season — never LIVE, never running", async () => {
    expect(await gamePhase(db)).toBe("DEVELOPMENT");
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
    const season = (await activeSeason(db))!;
    expect(season).toMatchObject({ kind: "DEVELOPMENT", number: null, run_number: 1, name: "Development / Beta", battle_counter: 0 });
    const control = await getGameControl(db, adminDeps(clock));
    expect(control).toMatchObject({ phase: "DEVELOPMENT", arena: { status: "NOT_STARTED" }, season: { kind: "DEVELOPMENT", label: "Development" } });
    expect(control.actions.launch.allowed).toBe(true);
    expect(control.actions.launch.phrase).toBe("LAUNCH SEASON 1");
    expect(control.actions.resetDevelopment.phrase).toBe("RESET ARENA");
    expect(control.actions.startArena.allowed).toBe(false); // no heroes yet
    expect(control.actions.pauseArena.allowed).toBe(false);
    expect(control.actions.resumeArena.allowed).toBe(false);
    expect(control.actions.endSeason.allowed).toBe(false);
  });
});

describe("NOT_STARTED: the worker does nothing", () => {
  it("makes no battle and no cycle however many heroes exist and however long it waits — and a restarted worker is no different", async () => {
    await seedHeroes(db, 24);
    for (let restart = 0; restart < 3; restart++) {
      // every iteration is a "new worker process": a brand-new context with its own seed source
      const ctx = arenaCtx(clock);
      for (let i = 0; i < 100; i++) {
        const r = await advanceArena(db, ctx);
        expect(r.status).toBe("NOT_STARTED");
        expect(r.dueAtMs).toBeNull();
        clock.advance(5000);
      }
    }
    expect(await count(db, "arena_battles")).toBe(0);
    expect(await count(db, "arena_cycles")).toBe(0);
    expect(await count(db, "arena_queue_entries")).toBe(0);
    expect(await arenaStatus(db)).toBe("NOT_STARTED");
  });

  it("the database refuses to schedule a battle while the Arena is NOT_STARTED (or PAUSED), whoever asks", async () => {
    await seedHeroes(db, 8);
    const season = (await activeSeason(db))!;
    const cycle = await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, seed, hero_count) values (1, $1, 's', 8) returning id", [season.id]);
    const insert = () => db.query("insert into public.arena_battles (season_id, cycle_id, status, starts_at) values ($1, $2, 'SCHEDULED', now())", [season.id, cycle[0]!.id]);
    await expect(insert()).rejects.toThrow(/no battle can be scheduled while the Arena is NOT_STARTED/);
    await db.exec("update public.arena_state set status = 'PREPARING'");
    await expect(insert()).resolves.toBeDefined();
    await db.exec("update public.arena_battles set status = 'VOID'");
    await db.exec("update public.arena_state set status = 'PAUSED'");
    await expect(insert()).rejects.toThrow(/no battle can be scheduled while the Arena is PAUSED/);
  });
});

describe("START ARENA", () => {
  it("NOT_STARTED → PREPARING; the next advance prepares Battle #1 and the Arena is RUNNING — one battle at a time, no click per fight", async () => {
    await seedHeroes(db, 24);
    const res = await startArena(db, adminDeps(clock));
    expect(res).toEqual({ status: "PREPARING", nextBattleNumber: 1 });
    expect(await arenaStatus(db)).toBe("PREPARING");
    expect(await count(db, "arena_battles")).toBe(0); // starting only changes the status; the Arena makes the battle

    const r = await advanceArena(db, arenaCtx(clock));
    expect(r.status).toBe("LIVE");
    expect(await arenaStatus(db)).toBe("RUNNING");
    const season = (await activeSeason(db))!;
    expect(await battleNumbers(db, season.id)).toEqual([1, 2, 3]); // on stage + the two prepared ahead
    expect((await activeSeason(db))!.battle_counter).toBe(3);

    // continuous operation with NO further admin click
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 5);
    const numbers = await battleNumbers(db, season.id);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1)); // gapless: #1, #2, #3, …
    expect(numbers.length).toBeGreaterThanOrEqual(5);
  });

  it("is audited with the previous and the new state", async () => {
    await seedHeroes(db, 16);
    await startArena(db, adminDeps(clock, { actor: "ops-1" }));
    const [row] = await db.query<{ action: string; actor: string; detail: Record<string, unknown> }>("select action, actor, detail from public.admin_audit_log where action = 'ARENA_START'");
    expect(row).toMatchObject({ actor: "ops-1", detail: { previous: { arenaStatus: "NOT_STARTED" }, next: { arenaStatus: "PREPARING" }, phase: "DEVELOPMENT", nextBattleNumber: 1, eligibleHeroes: 16 } });
    expect(JSON.stringify(row)).not.toMatch(/secret|password|token/i);
  });

  it("is refused without enough Arena-eligible heroes, and while the Arena is already started", async () => {
    await seedHeroes(db, 7);
    expect(await code(startArena(db, adminDeps(clock)))).toBe("NOT_ENOUGH_HEROES");
    await seedHeroes(db, 1);
    expect(await code(startArena(db, adminDeps(clock)))).toBe("OK");
    expect(await code(startArena(db, adminDeps(clock)))).toBe("ARENA_ALREADY_STARTED");
    await advanceArena(db, arenaCtx(clock));
    expect(await arenaStatus(db)).toBe("RUNNING");
    expect(await code(startArena(db, adminDeps(clock)))).toBe("ARENA_ALREADY_STARTED");
  });

  it("two simultaneous START requests: exactly one wins, and there is exactly one Battle #1", async () => {
    await seedHeroes(db, 16);
    const results = await Promise.all([startArena(db, adminDeps(clock)), startArena(db, adminDeps(clock)), startArena(db, adminDeps(clock))].map((p) => code(p)));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    expect(results.filter((r) => r === "ARENA_ALREADY_STARTED")).toHaveLength(2);
    // many workers advance at once as well
    await Promise.all([1, 2, 3, 4].map(() => advanceArena(db, arenaCtx(clock))));
    const season = (await activeSeason(db))!;
    expect(await count(db, "arena_battles", `season_id = '${season.id}' and season_sequence = 1`)).toBe(1);
    expect((await battleNumbers(db, season.id))[0]).toBe(1);
  });
});

describe("PAUSE ARENA", () => {
  async function runningAt(battles: number): Promise<string> {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= battles);
    return (await activeSeason(db))!.id;
  }

  it("drains: no NEW roster is made after the request, the committed battles are fought and settled exactly as planned, then the Arena is PAUSED and stays paused", async () => {
    const seasonId = await runningAt(6);
    const committedAtRequest = await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')");
    expect(committedAtRequest).toBeGreaterThan(0);
    const rostersAtRequest = await db.query<{ battle_id: string; ids: string }>("select battle_id, string_agg(character_id::text, ',' order by character_id) as ids from public.arena_participants group by battle_id");
    const lastNumber = Math.max(...(await battleNumbers(db, seasonId)));

    const res = await pauseArena(db, adminDeps(clock));
    expect(res.status).toBe("PAUSE_REQUESTED");
    expect(await arenaStatus(db)).toBe("PAUSE_REQUESTED");

    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    // nothing beyond what was committed at the request
    expect(Math.max(...(await battleNumbers(db, seasonId)))).toBe(lastNumber);
    expect(await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')")).toBe(0);
    // every roster that already existed is byte-identical (frozen: nobody saw it change)
    const after = await db.query<{ battle_id: string; ids: string }>("select battle_id, string_agg(character_id::text, ',' order by character_id) as ids from public.arena_participants where battle_id = any($1::uuid[]) group by battle_id", [rostersAtRequest.map((r) => r.battle_id)]);
    expect(new Map(after.map((r) => [r.battle_id, r.ids]))).toEqual(new Map(rostersAtRequest.map((r) => [r.battle_id, r.ids])));

    const before = await count(db, "arena_battles");
    await idleFor(db, clock, 1200); // twenty minutes of waiting
    expect(await count(db, "arena_battles")).toBe(before);
    expect(await arenaStatus(db)).toBe("PAUSED");
    const audits = await db.query<{ action: string; actor: string }>("select action, actor from public.admin_audit_log where action in ('ARENA_PAUSE_REQUEST', 'ARENA_PAUSED') order by id");
    expect(audits).toEqual([{ action: "ARENA_PAUSE_REQUEST", actor: "test-admin" }, { action: "ARENA_PAUSED", actor: "system" }]);
  });

  it("PAUSED is not declared while the last battle's own results screen is still on display", async () => {
    await runningAt(2);
    await pauseArena(db, adminDeps(clock));
    // run until nothing is committed any more, but stop BEFORE the last battle's slot has ended
    let last = 0;
    for (let i = 0; i < 4000; i++) {
      await advanceArena(db, arenaCtx(clock));
      const open = await count(db, "arena_battles", "status in ('SCHEDULED', 'SIMULATED')");
      if (open === 0) {
        last = (await db.query<{ t: Date }>("select max(slot_ends_at) as t from public.arena_battles where status = 'SETTLED'"))[0]!.t.getTime();
        break;
      }
      clock.advance(1000);
    }
    expect(last).toBeGreaterThan(0);
    // Settlement happens when the fight is decided, seconds BEFORE the results screen ends: the screen is still on.
    expect(clock.ms).toBeLessThan(last);
    expect(await arenaStatus(db)).toBe("PAUSE_REQUESTED"); // everything settled, but viewers are still watching the results
    clock.ms = last - 1;
    await advanceArena(db, arenaCtx(clock));
    expect(await arenaStatus(db)).toBe("PAUSE_REQUESTED");
    clock.ms = last;
    await advanceArena(db, arenaCtx(clock));
    expect(await arenaStatus(db)).toBe("PAUSED");
  });

  it("pauses at once when nothing is committed (idle at a safe boundary)", async () => {
    await seedHeroes(db, 16);
    await startArena(db, adminDeps(clock)); // PREPARING: no battle has been made yet
    expect(await pauseArena(db, adminDeps(clock))).toEqual({ status: "PAUSED", openBattles: 0 });
    expect(await arenaStatus(db)).toBe("PAUSED");
    const actions = (await db.query<{ action: string }>("select action from public.admin_audit_log where action like 'ARENA_%' order by id")).map((r) => r.action);
    expect(actions).toEqual(["ARENA_START", "ARENA_PAUSE_REQUEST", "ARENA_PAUSED"]);
    expect(await count(db, "arena_battles")).toBe(0);
  });

  it("a requested pause can be cancelled (RESUME while PAUSE_REQUESTED): the Arena just keeps running", async () => {
    await runningAt(2);
    expect((await pauseArena(db, adminDeps(clock))).status).toBe("PAUSE_REQUESTED");
    expect(await code(resumeArena(db, adminDeps(clock)))).toBe("OK");
    expect(await arenaStatus(db)).toBe("RUNNING");
    const settled = await count(db, "arena_battles", "status = 'SETTLED'");
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= settled + 3);
    expect(await arenaStatus(db)).toBe("RUNNING");
  });
});

describe("RESUME ARENA", () => {
  it("continues the SAME season: after a pause at #N the next battle is #N+1 (never #1), the queue and every season record carry on", async () => {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 8);
    const season = (await activeSeason(db))!;
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    const numbers = await battleNumbers(db, season.id);
    const last = numbers.at(-1)!;
    const statsBefore = await db.query<{ character_id: string; battles: number; wins: number; points: number }>("select character_id, battles, wins, points from public.season_character_stats where season_id = $1 order by character_id", [season.id]);
    const cycleBefore = (await db.query<{ id: string; number: number }>("select id, number from public.arena_cycles where status = 'ACTIVE'"))[0];

    const control = await getGameControl(db, adminDeps(clock));
    expect(control.battles.nextToIssue).toBe(last + 1);
    expect((await resumeArena(db, adminDeps(clock))).nextBattleNumber).toBe(last + 1);
    expect(await arenaStatus(db)).toBe("RUNNING");
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= numbers.length + 3);
    const after = await battleNumbers(db, season.id);
    expect(after.slice(0, numbers.length)).toEqual(numbers);
    expect(after[numbers.length]).toBe(last + 1); // not #1
    expect(after).toEqual(after.map((_, i) => i + 1));
    // records carried on (nothing was reset): every hero's season battles never went down
    const statsAfter = await db.query<{ character_id: string; battles: number }>("select character_id, battles from public.season_character_stats where season_id = $1", [season.id]);
    const was = new Map(statsBefore.map((r) => [r.character_id, Number(r.battles)]));
    for (const r of statsAfter) expect(Number(r.battles)).toBeGreaterThanOrEqual(was.get(r.character_id) ?? 0);
    // the persisted queue continued (the same cycle, or its natural successor) — never a restart from scratch
    const cycleAfter = (await db.query<{ number: number }>("select number from public.arena_cycles where status = 'ACTIVE'"))[0]!;
    expect(cycleAfter.number).toBeGreaterThanOrEqual(cycleBefore!.number);
    const audit = await db.query<{ detail: { nextBattleNumber: number; previous: { arenaStatus: string } } }>("select detail from public.admin_audit_log where action = 'ARENA_RESUME'");
    expect(audit[0]!.detail).toMatchObject({ nextBattleNumber: last + 1, previous: { arenaStatus: "PAUSED" } });
  });
});

describe("invalid transitions fail clearly", () => {
  it("cannot START while RUNNING, RESUME while NOT_STARTED, PAUSE while NOT_STARTED or PAUSED, RESET / LAUNCH while running", async () => {
    await seedHeroes(db, 16);
    expect(await code(resumeArena(db, adminDeps(clock)))).toBe("INVALID_STATE");
    expect(await code(pauseArena(db, adminDeps(clock)))).toBe("INVALID_STATE");
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    expect(await code(startArena(db, adminDeps(clock)))).toBe("ARENA_ALREADY_STARTED");
    expect(await code(resumeArena(db, adminDeps(clock)))).toBe("INVALID_STATE");
    const { resetDevelopment, launchSeason1, endSeason, createNextSeason } = await import("@/server/services/lifecycle");
    expect(await code(resetDevelopment(db, adminDeps(clock), { confirmation: "RESET ARENA" }))).toBe("ARENA_NOT_STOPPED");
    expect(await code(launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" }))).toBe("ARENA_NOT_STOPPED");
    expect(await code(endSeason(db, adminDeps(clock), { confirmation: "END SEASON" }))).toBe("NOT_LIVE");
    expect(await code(createNextSeason(db, adminDeps(clock)))).toBe("NOT_LIVE");
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    expect(await code(pauseArena(db, adminDeps(clock)))).toBe("INVALID_STATE");
    expect(await code(startArena(db, adminDeps(clock)))).toBe("ARENA_ALREADY_STARTED");
    // nothing above changed the state
    expect(await arenaStatus(db)).toBe("PAUSED");
  });

  it("the database enforces the same table: no illegal status move, and nothing runs without an active season", async () => {
    await expect(db.exec("update public.arena_state set status = 'RUNNING'")).rejects.toThrow(/illegal arena status transition NOT_STARTED -> RUNNING/);
    await expect(db.exec("update public.arena_state set status = 'PAUSED'")).rejects.toThrow(/illegal arena status transition NOT_STARTED -> PAUSED/);
    await db.exec("update public.arena_state set status = 'PREPARING'");
    await db.exec("update public.arena_state set status = 'RUNNING'");
    await expect(db.exec("update public.arena_state set status = 'NOT_STARTED'")).rejects.toThrow(/illegal arena status transition RUNNING -> NOT_STARTED/);
    await expect(db.exec("delete from public.arena_state")).rejects.toThrow(/permanent/);
    await db.exec("update public.arena_state set status = 'PAUSED'");
    await db.exec("update public.seasons set status = 'ENDED', ends_at = now() where status = 'ACTIVE'");
    await expect(db.exec("update public.arena_state set status = 'RUNNING'")).rejects.toThrow(/cannot run without an ACTIVE season/);
  });

  it("keeps the legacy `paused` flag in step with the status — and, until the new code is deployed, honours a flag toggle from the previous version", async () => {
    await db.exec("update public.arena_state set status = 'PREPARING'");
    await db.exec("update public.arena_state set status = 'RUNNING'");
    expect((await db.query<{ paused: boolean }>("select paused from public.arena_state"))[0]!.paused).toBe(false);
    await db.exec("update public.arena_state set paused = true"); // the previous application's Pause button
    expect(await arenaStatus(db)).toBe("PAUSED");
    expect((await db.query<{ paused: boolean }>("select paused from public.arena_state"))[0]!.paused).toBe(true);
    await db.exec("update public.arena_state set paused = false"); // … and its Resume button
    expect(await arenaStatus(db)).toBe("RUNNING");
    await db.exec("update public.arena_state set status = 'PAUSED'");
    expect((await db.query<{ paused: boolean }>("select paused from public.arena_state"))[0]!.paused).toBe(true);
  });
});

describe("the persisted status survives a restart", () => {
  it("NOT_STARTED stays NOT_STARTED, PAUSED stays PAUSED, RUNNING resumes — whichever process asks", async () => {
    await seedHeroes(db, 24);
    expect((await advanceArena(db, arenaCtx(clock))).status).toBe("NOT_STARTED");
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 3);
    // a "restart": new context objects, a long gap (outage) — the Arena picks up where the persisted state says it is
    clock.advance(10 * 60_000);
    expect((await advanceArena(db, arenaCtx(clock))).status).toBe("LIVE");
    expect(await arenaStatus(db)).toBe("RUNNING");
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
    for (let restart = 0; restart < 3; restart++) {
      clock.advance(30 * 60_000);
      expect((await advanceArena(db, arenaCtx(clock))).status).toBe("PAUSED");
    }
    expect(await arenaStatus(db)).toBe("PAUSED");
  });
});
