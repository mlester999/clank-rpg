import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { saveSetting } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";
import type { ArenaAdvanceResult } from "@/server/services/arena";
import type { ArenaStateDto } from "@/server/services/views";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * DETERMINISTIC guard for the property that real-time tests can only sample by luck:
 *
 *   A state READ never waits for work that is merely in progress — above all never for a settlement.
 *
 * Settlement is ≈ 77 statements of bookkeeping (rewards, season points, loot). When it outlasts the 6 s results window
 * (a slow database, a loaded host), requests that queued behind it arrived AFTER the next battle was due: the viewers'
 * own polling stalled at exactly the wrong moment (dead time ≈ the overrun, ~1.4 s, and no held request could even be
 * sent). These tests park the advance "in flight" forever — an infinitely slow settlement — and require that reads still
 * answer at once. Nothing here depends on how fast the machine is.
 */

const ORIGIN = "http://localhost:3700";
const ENV = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), CLANK_DEV_LOGIN: "true", NEXT_PUBLIC_APP_URL: ORIGIN };
const saved: Record<string, string | undefined> = {};
let db: Db;
let GET: (req?: Request) => Promise<Response>;

interface AdvanceSlot {
  promise: Promise<ArenaAdvanceResult> | null;
  at: number;
  last: ArenaAdvanceResult | null;
}
const slot = () => (globalThis as unknown as { __clankAdvance: AdvanceSlot }).__clankAdvance;
const stuckAdvance = () => new Promise<ArenaAdvanceResult>(() => undefined);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function read(): Promise<{ state: ArenaStateDto; ms: number }> {
  const t0 = performance.now();
  const res = await GET(new Request(`${ORIGIN}/api/arena/state`));
  const ms = performance.now() - t0;
  return { state: ((await res.json()) as { state: ArenaStateDto }).state, ms };
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
  (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = { promise: Promise.resolve(db) };
  GET = ((await import("@/app/api/arena/state/route")) as unknown as { GET: (req?: Request) => Promise<Response> }).GET;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  resetRuntimeCaches();
  // Combat ends ≈ 1 s after the battle starts and the results stay up for a minute: the "results window" is wide open.
  await saveSetting(db, "arena", { ...DEFAULT_SETTINGS.arena, introMs: 0, countdownMs: 0, maxCombatMs: 1000, victoryHoldMs: 0, resultsMs: 60_000 }, "test");
  resetRuntimeCaches();
  await seedHeroes(db, 16);
});

describe("a state read never waits for a settlement that is still running", () => {
  it("answers immediately while an advance is stuck in flight after combat has ended — and the results catch up once it completes", async () => {
    const first = await read(); // cold: runs the first advance (battle 1 on stage)
    const b1 = first.state.current!;
    expect(b1.status).toBe("SIMULATED");
    await sleep(Math.max(0, b1.combatEndsAt! - Date.now()) + 120); // combat is over: settlement is now DUE

    slot().promise = stuckAdvance(); // …and the settlement never finishes (infinitely slow database / host)
    const during = await read();
    // Old behaviour: the read queued behind the in-flight settlement forever. Now: a normal read.
    expect(during.ms).toBeLessThan(1500);
    expect(during.state.current!.id).toBe(b1.id);
    expect(during.state.current!.status).toBe("SIMULATED"); // the client sees "settlement pending" and looks again
    expect(during.state.current!.results).toHaveLength(8); // placements are already persisted
    expect(during.state.status).toBe("LIVE");

    // The settlement finally completes (a normal advance): the same battle now carries its rewards.
    slot().promise = null;
    let after = during.state;
    for (let i = 0; i < 40 && after.current!.status !== "SETTLED"; i++) {
      await sleep(150);
      after = (await read()).state;
    }
    expect(after.current!.id).toBe(b1.id);
    expect(after.current!.status).toBe("SETTLED");
    expect(after.current!.results!.some((r) => r.goldAwarded > 0)).toBe(true);
  }, 30_000);

  it("keeps answering at once through repeated reads while the settlement is stuck (no pile-up, no per-read wait)", async () => {
    const b1 = (await read()).state.current!;
    await sleep(Math.max(0, b1.combatEndsAt! - Date.now()) + 120);
    slot().promise = stuckAdvance();
    const durations: number[] = [];
    for (let i = 0; i < 6; i++) {
      await sleep(260); // past the state cache TTL, so each read is a real computation
      durations.push((await read()).ms);
    }
    expect(Math.max(...durations)).toBeLessThan(1500);
  }, 30_000);

  it("a cold process never waits more than a bounded time for its first advance, and then answers from the persisted rows", async () => {
    const b1 = (await read()).state.current!; // battle 1 persisted by a normal advance
    // A fresh serverless instance: nothing known yet, and its first advance is stuck behind a long transaction.
    (globalThis as unknown as { __clankAdvance?: AdvanceSlot }).__clankAdvance = { promise: stuckAdvance(), at: 0, last: null };
    (globalThis as unknown as { __clankStateCache?: unknown }).__clankStateCache = undefined;
    const t0 = performance.now();
    const cold = (await read()).state;
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(1400); // it did wait for the first advance…
    expect(waited).toBeLessThan(4000); // …but only up to the cap, never indefinitely
    expect(cold.current!.id).toBe(b1.id); // answered from the rows
    expect(cold.status).toBe("LIVE"); // battles on the books ⇒ the arena is live (not "gathering heroes")
  }, 30_000);

  it("after an outage (nothing advanced for a long time, nothing in flight) the first read still recovers the arena before answering", async () => {
    await read();
    // Every read kicks off a background advance (that is the point of the design); the precondition of THIS test is "nothing in flight", so let the one the
    // read above started finish instead of racing it (on a loaded machine it can still be running when the read returns).
    await slot().promise?.then(() => undefined, () => undefined);
    const s = slot();
    expect(s.promise).toBeNull();
    s.at = Date.now() - 60_000; // the last advance was a minute ago
    s.last = { ...(s.last as ArenaAdvanceResult), dueAtMs: null };
    (globalThis as unknown as { __clankStateCache?: unknown }).__clankStateCache = undefined;
    const before = s.at;
    await read();
    expect(slot().at).toBeGreaterThan(before + 59_000); // the read ran (and waited for) a fresh advance
  }, 30_000);
});
