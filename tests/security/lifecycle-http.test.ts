import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { count, createTestDb, resetDb, seedHeroes } from "../support/db";
import { freshDevelopment } from "../support/lifecycle";

/**
 * THE LIFECYCLE OVER HTTP — who may do what. Every game-control route is admin-only, same-origin-checked, audited, and needs the typed phrase for the
 * destructive actions (the SERVER checks it; the console only enables its button). There is no route that sets the phase or a season row directly.
 */
const ORIGIN = "http://localhost:3700";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk",
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret_for_tests_1234567890",
  TELEGRAM_OFFICIAL_CHAT_ID: "-1001234567890",
  CLANK_DEV_LOGIN: "true",
  CLANK_ALLOW_DEMO_HEROES: "false",
  NEXT_PUBLIC_APP_URL: ORIGIN,
};

let db: Db;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  db = await createTestDb();
  (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = { promise: Promise.resolve(db) };
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300)); // let a background advance kicked off by a request finish before the database closes
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
  resetRuntimeCaches();
});

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const req = (path: string, init: { method?: string; json?: unknown; cookie?: string; origin?: string | null } = {}) => {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : null });
};
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx as never);
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";

const adminRoute = () => import("@/app/api/admin/[...path]/route");
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
let adminSession = ""; // one login for the whole file: the login route is rate-limited (5 / minute) — that is its own test elsewhere
async function admin() {
  const route = await adminRoute();
  if (!adminSession) {
    const login = await call(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), ctx("session"));
    adminSession = cookieOf(login, "clank_admin");
    expect(adminSession).not.toBe("");
  }
  const cookie = adminSession;
  const get = async (...path: string[]) => call(route.GET, req(`/api/admin/${path.join("/")}`, { method: "GET", cookie }), ctx(...path));
  const post = async (path: string[], json?: unknown, over: { origin?: string | null } = {}) => call(route.POST, req(`/api/admin/${path.join("/")}`, { json: json ?? {}, cookie, ...over }), ctx(...path));
  return { route, cookie, get, post };
}
const body = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over arbitrary JSON

describe("game control routes are admin-only and same-origin", () => {
  it("every one is closed without an admin session (a player session is not an admin session)", async () => {
    const route = await adminRoute();
    expect((await call(route.GET, req("/api/admin/game", { method: "GET" }), ctx("game"))).status).toBe(401);
    for (const action of ["launch", "start", "pause", "resume", "reset", "end-season", "create-season"]) {
      expect((await call(route.POST, req(`/api/admin/game/${action}`, { json: { confirmation: "LAUNCH SEASON 1" } }), ctx("game", action))).status, action).toBe(401);
    }
    expect(await count(db, "admin_audit_log")).toBe(0);
  });

  it("a cross-origin request is refused before anything happens", async () => {
    await seedHeroes(db, 16);
    const a = await admin();
    for (const action of ["launch", "start", "pause", "resume", "reset", "end-season", "create-season"]) {
      expect((await a.post(["game", action], { confirmation: "LAUNCH SEASON 1" }, { origin: "https://evil.example" })).status, action).toBe(403);
    }
    expect((await db.query<{ phase: string }>("select phase from public.game_state"))[0]!.phase).toBe("DEVELOPMENT");
    expect((await db.query<{ status: string }>("select status from public.arena_state"))[0]!.status).toBe("NOT_STARTED");
  });

  it("there is no route that sets the phase or edits a season: the old free-form season routes are gone", async () => {
    const a = await admin();
    expect((await a.post(["seasons"], { name: "Season 99", activate: true })).status).toBe(404);
    expect((await a.post(["seasons", "00000000-0000-4000-8000-000000000000", "activate"], {})).status).toBe(404);
    expect((await a.post(["game", "phase"], { phase: "LIVE" })).status).toBe(404);
    expect((await a.post(["game"], { phase: "LIVE" })).status).toBe(404);
    const settings = await call(a.route.PUT, req("/api/admin/settings/game_state", { method: "PUT", json: { value: { phase: "LIVE" } }, cookie: a.cookie }), ctx("settings", "game_state"));
    expect(settings.status).toBe(404);
  });
});

describe("GET /api/admin/game", () => {
  it("is the one authoritative read: phase, season, Arena status, TOTAL vs ELIGIBLE heroes, battle numbers, the actions and why each is (not) allowed", async () => {
    await seedHeroes(db, 20);
    await db.query("update public.characters set status = 'SUSPENDED' where id in (select id from public.characters order by id limit 4)");
    const a = await admin();
    const res = await a.get("game");
    expect(res.status).toBe(200);
    const g = await body(res);
    expect(g).toMatchObject({
      ok: true,
      phase: "DEVELOPMENT",
      season: { kind: "DEVELOPMENT", label: "Development", status: "ACTIVE" },
      arena: { status: "NOT_STARTED" },
      heroes: { total: 20, eligible: 16, suspended: 4 },
      battles: { current: null, next: null, last: 0, nextToIssue: 1 },
      groupSize: 8,
    });
    expect(g.actions.launch).toMatchObject({ allowed: true, phrase: "LAUNCH SEASON 1" });
    expect(g.actions.startArena).toMatchObject({ allowed: true, phrase: null });
    expect(g.actions.resetDevelopment).toMatchObject({ allowed: true, phrase: "RESET ARENA" });
    for (const id of ["pauseArena", "resumeArena", "endSeason", "createSeason"]) expect(g.actions[id].allowed, id).toBe(false);
    expect(g.actions.pauseArena.blockers[0].code).toBe("INVALID_STATE");
    expect(g.rewards).toMatchObject({ checked: true, blocking: false });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(g)).not.toMatch(/secret|password|ADMIN_ACCESS_KEY|SESSION_SECRET/i);
  });
});

describe("the typed phrase is checked by the server", () => {
  it("launch and reset answer 422 CONFIRMATION_REQUIRED without the exact phrase and change nothing", async () => {
    await seedHeroes(db, 16);
    const a = await admin();
    for (const [action, good] of [["launch", "LAUNCH SEASON 1"], ["reset", "RESET ARENA"]] as const) {
      for (const wrong of [undefined, "", "launch season 1", good.slice(0, -1), `${good}!`, good === "RESET ARENA" ? "LAUNCH SEASON 1" : "RESET ARENA"]) {
        const res = await a.post(["game", action], wrong === undefined ? {} : { confirmation: wrong });
        expect([422], `${action} ${String(wrong)}`).toContain(res.status);
      }
    }
    expect((await db.query<{ phase: string }>("select phase from public.game_state"))[0]!.phase).toBe("DEVELOPMENT");
    expect(await count(db, "seasons")).toBe(1);
    expect(await count(db, "admin_audit_log")).toBe(0);
  });

  it("rejects unknown fields on the confirmation body (strict schema)", async () => {
    const a = await admin();
    expect((await a.post(["game", "launch"], { confirmation: "LAUNCH SEASON 1", season: 2 })).status).toBe(422);
  });
});

describe("the whole flow over HTTP: launch → start → pause → resume → (live) end-season guard", () => {
  it("LAUNCH leaves the Arena NOT_STARTED; START is a separate request; the public state follows; every step is audited", async () => {
    await seedHeroes(db, 24);
    const a = await admin();
    const launch = await a.post(["game", "launch"], { confirmation: "LAUNCH SEASON 1" });
    expect(launch.status).toBe(200);
    expect(await body(launch)).toMatchObject({ ok: true, seasonNumber: 1 });
    expect(((await body(await a.get("game"))) as { phase: string; arena: { status: string } })).toMatchObject({ phase: "LIVE", arena: { status: "NOT_STARTED" } });

    // the PUBLIC state, as a viewer's browser asks for it: live, waiting
    const stateRoute = await import("@/app/api/arena/state/route");
    const pub = await body(await call(stateRoute.GET, req("/api/arena/state", { method: "GET" })));
    expect(pub.state).toMatchObject({ status: "NOT_STARTED", phase: "LIVE", season: { label: "Season 1" }, current: null, upcoming: null });
    expect(await count(db, "arena_battles")).toBe(0); // the request that advances the Arena found it NOT_STARTED and did nothing

    // a second launch: refused
    expect((await a.post(["game", "launch"], { confirmation: "LAUNCH SEASON 1" })).status).toBe(409);

    const start = await a.post(["game", "start"]);
    expect(start.status).toBe(200);
    expect(await body(start)).toMatchObject({ status: "PREPARING", nextBattleNumber: 1 });
    expect((await a.post(["game", "start"])).status).toBe(409); // already started
    // the kicked-off advance (and any viewer's) prepares Battle #1
    const running = await body(await call(stateRoute.GET, req("/api/arena/state", { method: "GET" })));
    expect(["PREPARING", "LIVE"]).toContain(running.state.status);
    for (let i = 0; i < 40 && (await count(db, "arena_battles")) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await count(db, "arena_battles", "season_sequence = 1")).toBe(1);

    expect((await a.post(["game", "end-season"], { confirmation: "END SEASON" })).status).toBe(409); // the Arena is running
    const pause = await a.post(["game", "pause"]);
    expect(pause.status).toBe(200);
    expect((await body(pause)).status).toBe("PAUSE_REQUESTED");
    expect((await a.post(["game", "reset"], { confirmation: "RESET ARENA" })).status).toBe(409); // LIVE: never reset
    expect((await a.post(["game", "resume"])).status).toBe(200);

    const actions = (await db.query<{ action: string; actor: string }>("select action, actor from public.admin_audit_log order by id")).map((r) => `${r.action}`);
    expect(actions).toEqual(["GAME_LAUNCH", "ARENA_START", "ARENA_PAUSE_REQUEST", "ARENA_RESUME"]);
    const [launchAudit] = await db.query<{ actor: string; detail: unknown }>("select actor, detail from public.admin_audit_log where action = 'GAME_LAUNCH'");
    expect(launchAudit!.actor).toBe("admin");
    expect(JSON.stringify(launchAudit)).not.toMatch(/ADMIN_ACCESS_KEY|SESSION_SECRET|admin-access-key/);
  });

  it("the legacy pause / resume endpoint still works and is routed through the same lifecycle (drain, audit)", async () => {
    await seedHeroes(db, 24);
    const a = await admin();
    await a.post(["game", "start"]);
    for (let i = 0; i < 40 && (await count(db, "arena_battles")) === 0; i++) await new Promise((r) => setTimeout(r, 50)); // the request kicked off Battle #1
    const legacy = await a.post(["arena"], { action: "pause" });
    expect(legacy.status).toBe(200);
    expect((await db.query<{ status: string }>("select status from public.arena_state"))[0]!.status).toBe("PAUSE_REQUESTED"); // committed battles drain first
    expect((await a.post(["arena"], { action: "resume" })).status).toBe(200);
    expect((await db.query<{ status: string }>("select status from public.arena_state"))[0]!.status).toBe("RUNNING");
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log order by id")).map((r) => r.action)).toEqual(["ARENA_START", "ARENA_PAUSE_REQUEST", "ARENA_RESUME"]);
  });
});
