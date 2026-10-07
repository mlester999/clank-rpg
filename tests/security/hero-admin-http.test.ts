import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedEligibleMember, seedHeroes } from "../support/db";

/** HTTP-level guarantees of hero management (admin) and of the eligibility data players see. */

const ORIGIN = "http://localhost:3700";
const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret_for_tests_1234567890",
  TELEGRAM_OFFICIAL_CHAT_ID: "-1001234567890",
  CLANK_DEV_LOGIN: "true",
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
});

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const req = (path: string, init: { method?: string; origin?: string | null; json?: unknown; cookie?: string; ip?: string } = {}) => {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : null });
};
const call = (fn: unknown, r: Request) => (fn as RouteFn)(r);
const cookieOf = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";

let loginClock = Math.floor(Date.now() / 1000);
async function loginAs(telegramId: number) {
  const route = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  return cookieOf(await call(route.POST, req("/api/auth/telegram", { json: payload })));
}


const adminRoute = () => import("@/app/api/admin/[...path]/route");
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const callAdmin = (fn: unknown, r: Request, ...path: string[]) => (fn as (r: Request, c: unknown) => Promise<Response>)(r, ctx(...path));

// Admin login is throttled (5/min) — by design — so sign in once; the signed session does not depend on database state.
let cachedAdminCookie: string | null = null;
async function adminCookie() {
  if (cachedAdminCookie) return cachedAdminCookie;
  const route = await adminRoute();
  const res = await callAdmin(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), "session");
  cachedAdminCookie = (res.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
  expect(cachedAdminCookie).toContain("clank_admin=");
  return cachedAdminCookie;
}
const nameOf = async (id: string) => (await db.query<{ n: string; o: string | null }>("select name as n, name_override as o from public.characters where id = $1", [id]))[0]!;

describe("admin hero management API", () => {
  const rename = async (id: string, json: unknown, opts: { cookie?: string; origin?: string | null } = {}) => {
    const route = await adminRoute();
    return callAdmin(route.PUT, req(`/api/admin/heroes/${id}/name`, { method: "PUT", json, ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.origin !== undefined ? { origin: opts.origin } : {}) }), "heroes", id, "name");
  };

  it("is closed without an admin session — list, detail, rename and note", async () => {
    const [id] = await seedHeroes(db, 1);
    const route = await adminRoute();
    expect((await callAdmin(route.GET, req("/api/admin/heroes", { method: "GET" }), "heroes")).status).toBe(401);
    expect((await callAdmin(route.GET, req("/api/admin/telegram/eligibility", { method: "GET" }), "telegram", "eligibility")).status).toBe(401);
    expect((await callAdmin(route.GET, req(`/api/admin/heroes/${id}`, { method: "GET" }), "heroes", id as string)).status).toBe(401);
    expect((await rename(id as string, { name: "Hacker" })).status).toBe(401);
    expect((await callAdmin(route.PUT, req(`/api/admin/heroes/${id}/note`, { method: "PUT", json: { note: "x" } }), "heroes", id as string, "note")).status).toBe(401);
    expect((await nameOf(id as string)).o).toBeNull();
  });

  it("shows the configured hero threshold and aggregate eligibility counts to admins", async () => {
    await seedHeroes(db, 1, { startId: 6_100_001 });
    await seedEligibleMember(db, { id: 6_100_002, qualifying: 50, hero: false });
    await seedEligibleMember(db, { id: 6_100_003, qualifying: 49, hero: false });
    const route = await adminRoute();
    const res = await callAdmin(route.GET, req("/api/admin/telegram/eligibility", { method: "GET", cookie: await adminCookie() }), "telegram", "eligibility");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, threshold: 50, eligibleTelegramUsers: 2, heroesCreated: 1, eligibleWithoutHero: 1 });
  });

  it("a signed-in PLAYER (even the hero's own owner) cannot rename through the admin API", async () => {
    const [id] = await seedHeroes(db, 1, { startId: 6_000_001 });
    const cookie = await loginAs(6_000_001);
    expect((await rename(id as string, { name: "MyOwnName" }, { cookie })).status).toBe(401);
    expect((await nameOf(id as string)).o).toBeNull();
  });

  it("requires same-origin for mutations", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    expect((await rename(id as string, { name: "CrossSite" }, { cookie, origin: "https://evil.example" })).status).toBe(403);
    expect((await nameOf(id as string)).o).toBeNull();
  });

  it("renames as admin, audits it, and returns old/new names", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    const res = await rename(id as string, { name: "  NuggetMage " }, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, newName: "NuggetMage", heroId: id });
    expect((await nameOf(id as string)).o).toBe("NuggetMage");
    const log = await db.query<{ actor: string; action: string; entity_id: string }>("select actor, action, entity_id from public.admin_audit_log where action = 'hero.rename'");
    expect(log).toEqual([{ actor: "admin", action: "hero.rename", entity_id: id }]);
  });

  it("rejects invalid names with 422 and leaves the hero untouched", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    for (const bad of ["", "   ", "x".repeat(33), "a\u0000b", "<img src=x onerror=1>"]) {
      const res = await rename(id as string, { name: bad }, { cookie });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect((await nameOf(id as string)).o).toBeNull();
    expect(await db.query("select 1 from public.admin_audit_log where action = 'hero.rename'")).toHaveLength(0);
  });

  it("does not trust the client: non-UUID and unknown ids are 404, and the body can carry nothing but a name", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    expect((await rename("not-a-uuid", { name: "x" }, { cookie })).status).toBe(404);
    expect((await rename("00000000-0000-4000-8000-000000000000", { name: "Ghost" }, { cookie })).status).toBe(404);
    for (const extra of [{ name: "Ok", classId: "mage" }, { name: "Ok", telegramUserId: 1 }, { name: "Ok", id: "other" }, { name: "Ok", level: 99 }]) {
      expect((await rename(id as string, extra, { cookie })).status, JSON.stringify(extra)).toBe(422);
    }
    expect((await nameOf(id as string)).o).toBeNull();
    // the id in the URL is the only hero that can change
    const others = await seedHeroes(db, 1);
    expect((await rename(id as string, { name: "OnlyMe" }, { cookie })).status).toBe(200);
    expect((await nameOf(others[0] as string)).o).toBeNull();
  });

  it("the general hero PATCH refuses class, stats, XP and identity fields", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    const route = await adminRoute();
    for (const body of [{ classId: "mage" }, { class_id: "mage" }, { level: 50 }, { xp: 1 }, { telegramUserId: 5 }, { stats: { str: 99 } }]) {
      const res = await callAdmin(route.PATCH, req(`/api/admin/heroes/${id}`, { method: "PATCH", json: body, cookie }), "heroes", id as string);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
    }
  });

  it("search and filters work over HTTP, and unknown filter values are ignored instead of trusted", async () => {
    const ids = await seedHeroes(db, 3, { startId: 6_100_001 });
    const cookie = await adminCookie();
    const route = await adminRoute();
    const list = async (qs: string) => (await (await callAdmin(route.GET, req(`/api/admin/heroes${qs}`, { method: "GET", cookie }), "heroes")).json()) as { heroes: Array<{ id: string; telegramUserId: number }>; total: number };
    expect((await list("?search=6100002")).heroes.map((h) => h.id)).toEqual([ids[1]]);
    expect((await list("?claimed=claimed")).total).toBe(0);
    expect((await list("?claimed=unclaimed")).total).toBe(3);
    expect((await list("?claimed=%27%3B%20drop%20table%20public.characters%3B--")).total).toBe(3); // ignored, not interpreted
    expect((await list("?search=%27%20or%201%3D1%20--")).total).toBe(0);
    const detail = await callAdmin(route.GET, req(`/api/admin/heroes/${ids[0]}`, { method: "GET", cookie }), "heroes", ids[0] as string);
    expect(detail.status).toBe(200);
    expect((await detail.json()).hero).toMatchObject({ id: ids[0], telegram: { userId: 6_100_001 } });
    expect(await db.query("select 1 from public.characters")).toHaveLength(3);
  });

  it("a rename shows up in the PUBLIC hero search immediately", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    expect((await rename(id as string, { name: "PublicName" }, { cookie })).status).toBe(200);
    const pub = await import("@/app/api/heroes/route");
    const hits = (await (await call(pub.GET, req("/api/heroes?q=PublicName", { method: "GET" }))).json()).heroes as Array<{ id: string; name: string }>;
    expect(hits).toEqual([expect.objectContaining({ id, name: "PublicName" })]);
  });
});

describe("eligibility data the UI is built on (/api/me, arena state)", () => {
  const me = async (cookie?: string) => (await (await call((await import("@/app/api/me/route")).GET, req("/api/me", { method: "GET", ...(cookie ? { cookie } : {}) }))).json()) as { viewer: null | { qualifyingMessages: number; threshold: number; characterId: string | null; claimed: boolean; status: string } };

  it("signed-out visitors get no member data at all", async () => {
    expect((await me()).viewer).toBeNull();
  });

  it("a signed-in member gets their VERIFIED stored count and the configured threshold — 49 vs 50", async () => {
    const cookie = await loginAs(7_000_001);
    expect((await me(cookie)).viewer).toMatchObject({ qualifyingMessages: 0, threshold: 50, characterId: null, claimed: false, status: "OK" });
    await db.query("update public.telegram_users set qualifying_message_count = 49 where telegram_user_id = 7000001");
    expect((await me(cookie)).viewer).toMatchObject({ qualifyingMessages: 49, threshold: 50 });
    await db.query("update public.telegram_users set qualifying_message_count = 50 where telegram_user_id = 7000001");
    expect((await me(cookie)).viewer).toMatchObject({ qualifyingMessages: 50, threshold: 50 });
  });

  it("reports existing-unclaimed and claimed hero states", async () => {
    const [hero] = await seedHeroes(db, 1, { startId: 7_000_002 });
    const cookie = await loginAs(7_000_002);
    expect((await me(cookie)).viewer).toMatchObject({ characterId: hero, claimed: false });
    const claim = await import("@/app/api/me/claim/route");
    expect((await call(claim.POST, req("/api/me/claim", { json: {}, cookie }))).status).toBe(200);
    expect((await me(cookie)).viewer).toMatchObject({ characterId: hero, claimed: true });
  });

  it("flags a member under review so the UI never promises them a hero", async () => {
    const cookie = await loginAs(7_000_003);
    await db.query("update public.telegram_users set status = 'FLAGGED', qualifying_message_count = 400 where telegram_user_id = 7000003");
    expect((await me(cookie)).viewer).toMatchObject({ status: "FLAGGED" });
  });

  it("the public arena state carries the configured threshold for the explanation card", async () => {
    const state = await import("@/app/api/arena/state/route");
    expect((await (await call(state.GET, req("/api/arena/state", { method: "GET" }))).json()).state.heroThreshold).toBe(50);
    await db.query("update public.game_settings set value = jsonb_set(value, '{qualifyingThreshold}', '150') where key = 'telegram'");
    resetRuntimeCaches();
    await new Promise((r) => setTimeout(r, 2100)); // settings cache TTL
    expect((await (await call(state.GET, req("/api/arena/state", { method: "GET" }))).json()).state.heroThreshold).toBe(150);
  });
});
