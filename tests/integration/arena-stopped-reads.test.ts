import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db, Queryable } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { ensureArenaAdvanced, resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { adminDeps, freshDevelopment, runUntil } from "../support/lifecycle";
import { pauseArena, startArena } from "@/server/services/lifecycle";

/**
 * A STOPPED Arena (NOT_STARTED — the whole development period — or PAUSED) costs a viewer's state read ONE plain `SELECT status`: no transaction, no
 * `FOR UPDATE` row lock on arena_state, no write. Before, every poll of every viewer opened BEGIN / SELECT … FOR UPDATE / COMMIT for a step that
 * returns at once — three round trips and a lock per poll, which on a transaction pooler far from the database was pure overhead.
 * Every state that CAN advance still goes through the locked gate (stepArena), unchanged.
 */
const ORIGIN = "http://localhost:3700";
const ENV = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), NEXT_PUBLIC_APP_URL: ORIGIN };
const saved: Record<string, string | undefined> = {};
let db: Db;
let GET: (req?: Request) => Promise<Response>;

interface Recorder {
  statements: string[];
  transactions: number;
}
function recording(inner: Db, log: Recorder): Db {
  const wrap = (q: Queryable): Queryable => ({
    query: (t, p) => (log.statements.push(t), q.query(t, p)),
    exec: (t) => (log.statements.push(t), q.exec(t)),
  });
  return { ...wrap(inner), driver: inner.driver, transaction: (fn) => (log.transactions++, inner.transaction((tx) => fn(wrap(tx)))), close: () => Promise.resolve() };
}

const g = globalThis as unknown as { __clankDb?: { promise: Promise<Db> }; __clankSeeded?: Promise<void> };
let log: Recorder;
const install = (): void => {
  log = { statements: [], transactions: 0 };
  g.__clankDb = { promise: Promise.resolve(recording(db, log)) };
  g.__clankSeeded = Promise.resolve(); // (the seed is covered in seed-fast-path.test.ts)
  resetRuntimeCaches();
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
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
  await freshDevelopment(db);
  await seedHeroes(db, 16);
});

const writes = (statements: string[]) => statements.filter((s) => /\b(insert|update|delete)\b|for update/i.test(s));

describe("a stopped Arena costs the viewers one plain read", () => {
  it("NOT_STARTED: the advance is a single SELECT — no transaction, no lock, no write", async () => {
    install();
    const result = await ensureArenaAdvanced(0);
    expect(result).toMatchObject({ status: "NOT_STARTED", steps: [], dueAtMs: null });
    expect(log.transactions).toBe(0);
    expect(log.statements).toEqual(["select status from public.arena_state where id = 1"]);
  });

  it("PAUSED: same — and the whole public state read (GET /api/arena/state) writes and locks nothing", async () => {
    const clock = new FakeClock(Date.now());
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await db.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'SETTLED'"))[0]!.n >= 1);
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await db.query<{ status: string }>("select status from public.arena_state"))[0]!.status === "PAUSED");
    const before = JSON.stringify(await db.query("select (select md5(to_jsonb(a)::text) from public.arena_state a where id = 1) as arena, (select count(*)::int from public.arena_battles) as battles, (select count(*)::int from public.currency_ledger) as ledger"));

    install();
    expect(await ensureArenaAdvanced(0)).toMatchObject({ status: "PAUSED", steps: [] });
    expect(log.transactions).toBe(0);
    expect(log.statements).toEqual(["select status from public.arena_state where id = 1"]);

    install();
    const res = await GET(new Request(`${ORIGIN}/api/arena/state`));
    const body = (await res.json()) as { state: { status: string; phase: string } };
    expect(res.status).toBe(200);
    expect(body.state.status).toBe("PAUSED");
    expect(log.transactions).toBe(0);
    expect(writes(log.statements)).toEqual([]); // not one INSERT / UPDATE / DELETE / FOR UPDATE on the whole read path
    expect(JSON.stringify(await db.query("select (select md5(to_jsonb(a)::text) from public.arena_state a where id = 1) as arena, (select count(*)::int from public.arena_battles) as battles, (select count(*)::int from public.currency_ledger) as ledger"))).toBe(before);
  });

  it("a state that can advance still takes the locked gate (RUNNING → BEGIN / SELECT … FOR UPDATE)", async () => {
    const clock = new FakeClock(Date.now());
    await startArena(db, adminDeps(clock));
    install();
    await ensureArenaAdvanced(0);
    expect(log.transactions).toBeGreaterThanOrEqual(1);
    expect(log.statements.some((s) => /arena_state where id = 1 for update/i.test(s))).toBe(true);
  });

  it("START is picked up by the very next advance after a stopped read (no stale 'stopped' answer is kept)", async () => {
    install();
    expect(await ensureArenaAdvanced(0)).toMatchObject({ status: "NOT_STARTED" });
    await startArena(db, adminDeps(new FakeClock(Date.now())));
    const next = await ensureArenaAdvanced(0);
    expect(next.status).not.toBe("NOT_STARTED");
    expect(log.transactions).toBeGreaterThanOrEqual(1);
  });
});
