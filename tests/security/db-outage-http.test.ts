import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DbConnectionError } from "@/server/db/postgres";
import type { Db, Queryable } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRewardsReadiness } from "@/server/rewards/pool";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedHeroes } from "../support/db";
import { freshDevelopment } from "../support/lifecycle";

/**
 * WHEN THE DATABASE IS DOWN, THE SITE SAYS SO — BRIEFLY, SAFELY, AND WITH A RETRY HINT.
 *
 * A connection-class failure that outlived the driver's one safe retry must reach callers as a 503 with a stable code and `Retry-After` — on every public
 * route and on Admin — and NEVER as the driver's message: no SQL, no `write CONNECTION_DESTROYED <pooler host>:6543`, no stack. When the database is back the
 * very same routes answer normally (nothing is cached as "down"). Admin's message is actionable, and says when a write's outcome is unknown.
 */
const ORIGIN = "http://localhost:3700";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  CLANK_ALLOW_DEMO_HEROES: "false",
  NEXT_PUBLIC_APP_URL: ORIGIN,
};
/** What must never reach a browser: the driver's words, the pooler's host / port / region, SQL. (Admin's own advice may name "the pooler" and "Supabase" — it is an operator message.) */
const LEAKS = /aws-0|CONNECTION_(DESTROYED|CLOSED)|ECONNRESET|:6543|ap-south|\.supabase\.com|select\s|public\.|postgres:/i;
const PUBLIC_LEAKS = new RegExp(`${LEAKS.source}|pooler|supabase`, "i");

let real: Db;
let mode: "up" | "down" | "ambiguous" = "up";
const saved: Record<string, string | undefined> = {};
const raw = () => new Error("write CONNECTION_DESTROYED aws-0-ap-south-1.pooler.supabase.com:6543");
const boom = (): never => {
  throw new DbConnectionError("database connection lost (CONNECTION_DESTROYED)", "CONNECTION_DESTROYED", { cause: raw(), ambiguous: mode === "ambiguous" });
};
/** Delegates to the real scratch database while "up"; throws what the production driver throws while not. */
// `async` like the real driver: a failure is always a REJECTED PROMISE (never a synchronous throw), so a promise the app starts and does not await is an
// unobserved rejection here exactly as it would be in production — vitest fails this file on any such unhandled rejection.
const flaky: Db = {
  driver: "pglite",
  query: async (t, p) => (mode === "up" ? real.query(t, p) : boom()),
  exec: async (t) => (mode === "up" ? real.exec(t) : boom()),
  transaction: async (fn) => (mode === "up" ? real.transaction(fn as (tx: Queryable) => Promise<unknown>) : boom()) as never,
  close: () => Promise.resolve(),
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  real = await createTestDb();
  const g = globalThis as unknown as { __clankDb: { promise: Promise<Db> }; __clankSeeded: Promise<void> };
  g.__clankDb = { promise: Promise.resolve(flaky) };
  g.__clankSeeded = Promise.resolve();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await real.close();
});
beforeEach(async () => {
  mode = "up";
  await resetDb(real);
  await freshDevelopment(real);
  await seedHeroes(real, 8);
  resetRuntimeCaches();
});

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx as never);
const get = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: { host: "localhost:3700", ...(cookie ? { cookie } : {}) } });
const adminCtx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

const PUBLIC: Array<[string, () => Promise<Record<string, unknown>>, string]> = [
  ["/api/arena/state", () => import("@/app/api/arena/state/route"), "ARENA_UNAVAILABLE"],
  ["/api/heroes?q=ab", () => import("@/app/api/heroes/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard", () => import("@/app/api/leaderboard/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard/picks", () => import("@/app/api/leaderboard/picks/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard/picks?period=season", () => import("@/app/api/leaderboard/picks/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard/hero-arena?scope=daily", () => import("@/app/api/leaderboard/hero-arena/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard/hero-arena?scope=season", () => import("@/app/api/leaderboard/hero-arena/route"), "DB_UNAVAILABLE"],
  ["/api/leaderboard/records?metric=top2", () => import("@/app/api/leaderboard/records/route"), "DB_UNAVAILABLE"],
];

describe("public routes during a database outage", () => {
  for (const [path, load, code] of PUBLIC) {
    it(`${path}: 503 ${code} + Retry-After, nothing from the driver or the pooler in the body — and 200 again the moment the database is back`, async () => {
      const route = await load();
      mode = "down";
      resetRuntimeCaches();
      const down = await call(route.GET, get(path));
      const text = await down.text();
      expect(down.status, text).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: code });
      expect(down.headers.get("retry-after")).toBe("3");
      expect(down.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toMatch(PUBLIC_LEAKS);

      mode = "up";
      resetRuntimeCaches();
      const up = await call(route.GET, get(path));
      expect(up.status, await up.clone().text()).toBe(200);
    });
  }
});

describe("an outage is never cached as 'not ready'", () => {
  it("the Picks leaderboard answers 503 DB_UNAVAILABLE while the database is down and 200 on the VERY NEXT request after it is back (it used to stay 503 for 30 s: the outage was cached as 'rewards not installed')", async () => {
    const route = await import("@/app/api/leaderboard/picks/route");
    resetRewardsReadiness();
    mode = "down";
    const down = await call(route.GET, get("/api/leaderboard/picks"));
    expect(down.status).toBe(503);
    expect(((await down.json()) as { error: string }).error).toBe("DB_UNAVAILABLE");
    mode = "up";
    const up = await call(route.GET, get("/api/leaderboard/picks"));
    expect(up.status, await up.clone().text()).toBe(200);
  });
});

describe("Admin during a database outage", () => {
  const login = async () => {
    const route = await import("@/app/api/admin/[...path]/route");
    const res = await call(route.POST, new Request(`${ORIGIN}/api/admin/session`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3700", "content-type": "application/json" }, body: JSON.stringify({ key: ENV.ADMIN_ACCESS_KEY }) }), adminCtx("session"));
    const cookie = (res.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    return { route, cookie };
  };

  it("a read (overview, game) says what happened and what to do — never the driver's words", async () => {
    const { route, cookie } = await login();
    for (const path of [["overview"], ["game"]]) {
      mode = "down";
      const res = await call(route.GET, get(`/api/admin/${path.join("/")}`, cookie), adminCtx(...path));
      const text = await res.text();
      expect(res.status, text).toBe(503);
      const body = JSON.parse(text) as { error: string; message: string };
      expect(body.error).toBe("DB_UNAVAILABLE");
      expect(body.message).toMatch(/Nothing was changed\. Wait a few seconds and retry/);
      expect(res.headers.get("retry-after")).toBe("3");
      expect(text).not.toMatch(LEAKS);
      mode = "up";
      expect((await call(route.GET, get(`/api/admin/${path.join("/")}`, cookie), adminCtx(...path))).status).toBe(200);
    }
  });

  it("a WRITE whose outcome is unknown tells the operator to check the current state before repeating it", async () => {
    const { route, cookie } = await login();
    mode = "ambiguous";
    const res = await call(route.POST, new Request(`${ORIGIN}/api/admin/game/pause`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3700", cookie, "content-type": "application/json" }, body: "{}" }), adminCtx("game", "pause"));
    const text = await res.text();
    expect(res.status, text).toBe(503);
    expect((JSON.parse(text) as { message: string }).message).toMatch(/outcome is unknown.*check the current state before repeating/);
    expect(text).not.toMatch(LEAKS);
  });
});
