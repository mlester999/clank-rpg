import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db, Queryable } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { adminOverview } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { getGameControl, startArena } from "@/server/services/lifecycle";
import { listPublicHeroes } from "@/server/services/publicHeroes";

import { getHeroArenaPayload, getHeroRecordsPayload, getPicksSeasonPayload } from "@/server/services/heroBoards";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { seedHeroBattles } from "../support/heroArena";
import { adminDeps, freshDevelopment } from "../support/lifecycle";

/**
 * DATABASE PRESSURE: reliability must not be bought with a slower, chattier app. Every hot read is measured in STATEMENTS per request (round trips: on a
 * pooler the cost of a request is statements × RTT) at two hero populations. The number must be BOUNDED and must NOT GROW with the number of heroes —
 * an N+1 would show up here as a count that depends on the population.
 */
const ORIGIN = "http://localhost:3700";
const ENV: Record<string, string> = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789", NEXT_PUBLIC_APP_URL: ORIGIN, ARENA_VIEWER_ADVANCE: "off" };
const saved: Record<string, string | undefined> = {};
let db: Db;
const g = globalThis as unknown as { __clankDb?: { promise: Promise<Db> }; __clankSeeded?: Promise<void> };

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
let log: Recorder;
/** The recording handle the routes see (through the global holder) and the services below are handed directly. */
let rdb: Db;
const install = (): void => {
  log = { statements: [], transactions: 0 };
  rdb = recording(db, log);
  g.__clankDb = { promise: Promise.resolve(rdb) };
  g.__clankSeeded = Promise.resolve();
  resetRuntimeCaches();
};
const count = () => log.statements.length;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
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
});

/** A RUNNING Arena with battles prepared ahead, over `heroes` heroes. */
async function populate(heroes: number): Promise<void> {
  await seedHeroes(db, heroes);
  const clock = new FakeClock(Date.now());
  await startArena(db, adminDeps(clock));
  for (let i = 0; i < 6; i++) await advanceArena(db, arenaCtx(clock));
}

const measure = async (what: string, fn: () => Promise<unknown>): Promise<number> => {
  install();
  await fn();
  return count();
};

const get = (path: string) => new Request(`${ORIGIN}${path}`, { headers: { host: "localhost:3700" } });
type RouteFn = (req?: Request, ctx?: never) => Promise<Response>;
const route = async (mod: string): Promise<RouteFn> => ((await import(mod)) as { GET: RouteFn }).GET;

async function readings(): Promise<Record<string, number>> {
  const state = await route("@/app/api/arena/state/route");
  const board = await route("@/app/api/leaderboard/route");
  const classes = await loadClasses(db, false);
  const settings = await loadSettings(db);
  return {
    "arena state (cold cache)": await measure("state", async () => (await state(get("/api/arena/state"))).json()),
    "arena state (served from cache)": await (async () => {
      install();
      await state(get("/api/arena/state"));
      const first = count();
      await state(get("/api/arena/state"));
      return count() - first;
    })(),
    "admin overview": await measure("overview", () => adminOverview(rdb, false)),
    "admin game": await measure("game", () => getGameControl(rdb, { allowDemo: false })),
    "heroes directory page": await measure("heroes", () => listPublicHeroes(rdb, { sort: "power", limit: 24, offset: 0 }, { allowDemo: false, classes, settings })),
    "leaderboard (WINS)": await measure("board", async () => (await board(get("/api/leaderboard?board=WINS&limit=25"))).json()),
  };
}

describe("statements per request: bounded, and independent of the number of heroes", () => {
  it("no hot read costs more round trips with 200 heroes than with 24 (no N+1), and each stays a handful", async () => {
    await populate(24);
    const small = await readings();
    await resetDb(db);
    await freshDevelopment(db);
    await populate(200);
    const large = await readings();
    console.info("statements per request (24 heroes → 200 heroes):", JSON.stringify(Object.fromEntries(Object.keys(small).map((k) => [k, `${small[k]} → ${large[k]}`]))));
    // (the two arenas differ in which battle is on stage, so a count may differ by a statement — but an N+1 would make the LARGER population cost MORE)
    for (const key of Object.keys(small)) expect(large[key], `${key} must not grow with the number of heroes`).toBeLessThanOrEqual(small[key]!);
    // Budgets (round trips) — generous ceilings that still catch a regression into per-hero queries.
    expect(large["arena state (cold cache)"]!).toBeLessThanOrEqual(16);
    expect(large["arena state (served from cache)"]!).toBe(0); // a quarter-second cache: the second viewer costs the database nothing
    expect(large["admin overview"]!).toBeLessThanOrEqual(8);
    expect(large["admin game"]!).toBeLessThanOrEqual(16); // admin-only: ~15 statements, flat in the number of heroes
    expect(large["heroes directory page"]!).toBeLessThanOrEqual(5);
    expect(large["leaderboard (WINS)"]!).toBeLessThanOrEqual(6);
  }, 240_000);

  it("with viewers read-only, the state read is plain SELECTs: no transaction, no lock, no write", async () => {
    await populate(24);
    install();
    const state = await route("@/app/api/arena/state/route");
    await state(get("/api/arena/state"));
    expect(log.transactions).toBe(0);
    expect(log.statements.filter((s) => /\b(insert|update|delete)\b|for update/i.test(s))).toEqual([]);
  });
});

/**
 * THE HALL OF CHAMPIONS' QUERIES: every board — Hero Arena Daily / Weekly / Season, Hero Records, Arena Picks Season — is a handful of set-based statements, the same
 * handful at 24 heroes and at 200 (an N+1 would make the larger population cost more), and never writes anything.
 */
describe("Hall of Champions: statements per board, independent of the number of heroes", () => {
  const now = Date.now();
  async function history(heroes: number): Promise<void> {
    const ids = await seedHeroes(db, heroes);
    const battles = Array.from({ length: 40 }, (_, i) => ({
      at: new Date(now - 60_000 * (60 - i)).toISOString(),
      placements: Array.from({ length: 8 }, (_, k) => ({ hero: ids[(i * 8 + k) % ids.length]!, placement: k + 1, kos: k === 0 ? 2 : 0 })),
    }));
    await seedHeroBattles(db, battles);
  }
  const boards = async (): Promise<Record<string, number>> => {
    const ctx = { nowMs: now, settings: await loadSettings(db), allowDemo: false, classes: {} };
    const run = async (fn: () => Promise<unknown>) => {
      install();
      await fn();
      expect(log.statements.filter((t) => /\b(insert|update|delete)\b|for update/i.test(t)), "a board never writes").toEqual([]);
      expect(log.transactions).toBe(0);
      return count();
    };
    return {
      "hero arena · daily": await run(() => getHeroArenaPayload(rdb, "DAILY", ctx)),
      "hero arena · weekly": await run(() => getHeroArenaPayload(rdb, "WEEKLY", ctx)),
      "hero arena · season": await run(() => getHeroArenaPayload(rdb, "SEASON", ctx)),
      "records · top-2 daily": await run(() => getHeroRecordsPayload(rdb, "TOP2", "DAILY", ctx)),
      "records · KOs season": await run(() => getHeroRecordsPayload(rdb, "KOS", "SEASON", ctx)),
      "records · PWR": await run(() => getHeroRecordsPayload(rdb, "PWR", "SEASON", ctx)),
      "picks · season": await run(() => getPicksSeasonPayload(rdb, { nowMs: now, viewerId: null })),
    };
  };

  it("each board costs the same few statements at 24 and at 200 heroes (no N+1) and never writes", async () => {
    await history(24);
    const small = await boards();
    await resetDb(db);
    await freshDevelopment(db);
    await history(200);
    const large = await boards();
    console.info("Hall of Champions statements per board (24 heroes → 200 heroes):", JSON.stringify(Object.fromEntries(Object.keys(small).map((k) => [k, `${small[k]} → ${large[k]}`]))));
    for (const key of Object.keys(small)) {
      expect(large[key], `${key} must not grow with the number of heroes`).toBeLessThanOrEqual(small[key]!);
      expect(large[key]!, key).toBeLessThanOrEqual(8); // seasons list · readiness · (period season) · aggregate · hero cards · finalized periods · finalizing probe
    }
  }, 240_000);
});
