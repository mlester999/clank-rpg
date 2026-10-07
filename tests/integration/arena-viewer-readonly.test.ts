import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db, Queryable } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { advanceForPage, advanceForRead, resetRuntimeCaches } from "@/server/runtime";
import { advanceArena } from "@/server/services/arena";
import { startArena } from "@/server/services/lifecycle";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { adminDeps, freshDevelopment } from "../support/lifecycle";

/**
 * VIEWING MUST NOT DRIVE THE GAME (ARENA_VIEWER_ADVANCE=off).
 *
 * With the switch off, the public state read (GET /api/arena/state, including a `?hold=` read) and the home-page render never create, prepare, settle or
 * lock anything and never move a phase: not one INSERT / UPDATE / DELETE / FOR UPDATE / BEGIN on the whole viewer path — even while the Arena is RUNNING with
 * transitions overdue. The worker's path (advanceArena) is untouched and still does all of it. With the switch unset (today's default) viewers still kick the advance.
 */
const ORIGIN = "http://localhost:3700";
const ENV: Record<string, string> = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), NEXT_PUBLIC_APP_URL: ORIGIN };
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
  g.__clankSeeded = Promise.resolve();
  resetRuntimeCaches();
};
const writes = (statements: string[]) => statements.filter((s) => /\b(insert|update|delete)\b|for update/i.test(s));
const fingerprint = async () =>
  JSON.stringify(
    await db.query(
      `select (select md5(to_jsonb(a)::text) from public.arena_state a where id = 1) as arena,
              (select count(*)::int from public.arena_battles) as battles,
              (select count(*)::int from public.arena_battles where status = 'SETTLED') as settled,
              (select count(*)::int from public.arena_battles where picks_locked_at is not null) as locked,
              (select count(*)::int from public.currency_ledger) as ledger`,
    ),
  );

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  saved.ARENA_VIEWER_ADVANCE = process.env.ARENA_VIEWER_ADVANCE;
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
  GET = ((await import("@/app/api/arena/state/route")) as unknown as { GET: (req?: Request) => Promise<Response> }).GET;
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
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
  await seedHeroes(db, 24);
  delete process.env.ARENA_VIEWER_ADVANCE;
  resetEnvCache();
});

/** A RUNNING Arena whose clock has run far past several transitions: everything a viewer used to be asked to do is overdue. */
async function overdueArena(): Promise<void> {
  const clock = new FakeClock(Date.now());
  await startArena(db, adminDeps(clock));
  await advanceArena(db, arenaCtx(clock)); // battle 1 prepared
  // Real time moves on, the persisted rows do not: the live clock is now past combat start / end of what was prepared.
}

describe("ARENA_VIEWER_ADVANCE=off: the viewer path is read-only", () => {
  it("GET /api/arena/state ×40 (plain and held) on a RUNNING Arena writes nothing, opens no transaction, takes no lock, and changes no row", async () => {
    process.env.ARENA_VIEWER_ADVANCE = "off";
    resetEnvCache();
    await overdueArena();
    const before = await fingerprint();
    install();
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => GET(new Request(`${ORIGIN}/api/arena/state${i % 4 === 3 ? `?hold=${Date.now() + 500}` : ""}`))),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const body = (await results[0]!.json()) as { state: { status: string } };
    expect(["LIVE", "PREPARING", "GATHERING"]).toContain(body.state.status);
    expect(log.transactions).toBe(0);
    expect(writes(log.statements)).toEqual([]);
    expect(log.statements.filter((s) => /begin|commit/i.test(s))).toEqual([]);
    await new Promise((r) => setTimeout(r, 400)); // nothing was kicked off in the background either
    expect(writes(log.statements)).toEqual([]);
    expect(await fingerprint()).toBe(before);
  });

  it("advanceForRead and the home page's advance are no-ops", async () => {
    process.env.ARENA_VIEWER_ADVANCE = "off";
    resetEnvCache();
    await overdueArena();
    install();
    expect(await advanceForRead()).toBeNull();
    expect(await advanceForRead({ neverWait: true })).toBeNull();
    await advanceForPage();
    expect(log.statements).toEqual([]);
    expect(log.transactions).toBe(0);
  });

  it("…while the WORKER's path still does everything: it prepares, locks and settles on its own", async () => {
    process.env.ARENA_VIEWER_ADVANCE = "off";
    resetEnvCache();
    const clock = new FakeClock(Date.now());
    await startArena(db, adminDeps(clock));
    install();
    for (let i = 0; i < 400; i++) {
      await advanceArena(db, arenaCtx(clock));
      clock.advance(1000);
    }
    const [row] = await db.query<{ settled: number; battles: number }>("select count(*) filter (where status = 'SETTLED')::int as settled, count(*)::int as battles from public.arena_battles");
    expect(row!.settled).toBeGreaterThan(3);
    expect(row!.battles).toBeGreaterThan(row!.settled);
  });
});

describe("ARENA_VIEWER_ADVANCE unset (today's default): viewers still kick the advance — nothing changes until the worker is approved", () => {
  it("a state read on a RUNNING Arena goes through the locked advance gate", async () => {
    await overdueArena();
    install();
    const res = await GET(new Request(`${ORIGIN}/api/arena/state`));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(log.transactions).toBeGreaterThanOrEqual(1);
    expect(log.statements.some((s) => /arena_state where id = 1 for update/i.test(s))).toBe(true);
  });

  it("the switch understands off / 0 / false / no (any case) and ignores everything else", async () => {
    const { viewerAdvanceEnabled } = await import("@/server/env");
    for (const off of ["off", "OFF", " Off ", "0", "false", "no"]) expect(viewerAdvanceEnabled({ ARENA_VIEWER_ADVANCE: off } as never), off).toBe(false);
    for (const on of [undefined, "", "on", "1", "true", "yes", "banana"]) expect(viewerAdvanceEnabled({ ARENA_VIEWER_ADVANCE: on } as never), String(on)).toBe(true);
  });
});
