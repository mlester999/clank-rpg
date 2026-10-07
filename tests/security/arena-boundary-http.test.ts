import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ArenaStateDto } from "@/server/services/views";

import { runFleet, startBoundaryEnv, type BoundaryEnv } from "../support/arenaFleet";

/**
 * The end-to-end proof for "NEXT BATTLE IN 0 SEC": a fleet of viewers, running the browser's real polling plan,
 * talks to the real /api/arena/state handler in REAL TIME over a database that costs 10 ms per statement
 * (a hosted Postgres seen from a serverless function). The slot is shrunk (≈ 8 s) so several boundaries fit in a
 * test; what is measured is the dead time between "the results timer ended" and "the next eight arrived".
 *
 * Before the fix the same measurement, taken against the unchanged server over a 30 ms database, gave
 * p50 ≈ 7.0 s / max ≈ 7.3 s for every viewer at every boundary.
 *
 * About the numbers: the in-process database (PGlite) has ONE connection, so a settlement transaction blocks every
 * other query while it runs — unlike Postgres, where readers are not blocked by a writer. The window after combat
 * ends is therefore kept at production's 6.2 s, about six times longer than settlement (≈ 77 statements ≈ 1 s at
 * 10 ms each), so a busy machine (the full suite) cannot make a settlement overrun the boundary and turn this into
 * a test of PGlite's locking. The property "a read never waits for a settlement" is asserted deterministically in
 * tests/security/arena-reads-never-wait.test.ts instead of through wall-clock luck.
 */

let env: BoundaryEnv;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  // Production's own victory beat (1.2 s) and results screen (5 s) — only the intro, countdown and combat are shrunk.
  env = await startBoundaryEnv({ latencyMs: 10, arena: { introMs: 300, countdownMs: 300, maxCombatMs: 1000 } });
});
afterAll(async () => {
  await env.close();
});

describe("battle boundary over a 10 ms-per-statement database (real time, real handler)", () => {
  it("the next eight appear essentially the instant the results timer ends — for every viewer, at every boundary", async () => {
    await runFleet(env, 4, 4);
  }, 90_000);

  it("a client that does NOT use the held request (an older browser tab) still gets the next battle within a normal round trip", async () => {
    const get = async () => ((await (await env.GET(new Request("http://localhost:3700/api/arena/state"))).json()) as { state: ArenaStateDto }).state;
    const first = await get();
    const T = first.current!.slotEndsAt!;
    await sleep(Math.max(0, T - Date.now() - 20));
    // Poll once just BEFORE the boundary, then right after it, the way the old client did (+150 ms).
    await get();
    await sleep(Math.max(0, T + 150 - Date.now()));
    const t0 = Date.now();
    const after = await get();
    expect(after.current!.id).not.toBe(first.current!.id); // never the previous battle again
    expect(Date.now() - t0).toBeLessThan(600);
  }, 30_000);
});
