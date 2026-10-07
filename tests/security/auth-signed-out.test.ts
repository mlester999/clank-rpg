import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { sameOriginOk } from "@/server/http/guards";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb } from "../support/db";

/**
 * THE PUBLIC AUTH CONTRACT for a visitor who is not signed in (production showed an account-looking icon and no way in).
 *   · an anonymous visitor has NO session: no cookie is ever set for them, /api/me says `viewer: null`, protected player endpoints answer 401
 *   · there is no "guest" state: only a verified Telegram login creates a session
 *   · the Telegram widget is offered ONLY when BOTH TELEGRAM_BOT_TOKEN and NEXT_PUBLIC_TELEGRAM_BOT_USERNAME are set (the widget needs the username; the
 *     server needs the token to verify the signature) — the matrix below is exactly the production misconfiguration that hid the button
 *   · the login POST is accepted from the site's own origin (Host match, www or apex) and from nowhere else
 * (Admin authentication is a separate cookie and is not touched here.)
 */
const ORIGIN = "https://www.clankrpg.fun";
const BASE = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  NEXT_PUBLIC_APP_URL: ORIGIN,
};
const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const MANAGED = ["TELEGRAM_BOT_TOKEN", "NEXT_PUBLIC_TELEGRAM_BOT_USERNAME", "CLANK_DEV_LOGIN", ...Object.keys(BASE)];
const saved: Record<string, string | undefined> = {};
let db: Db;

const setEnv = (extra: Record<string, string | undefined>) => {
  for (const k of MANAGED) delete process.env[k];
  for (const [k, v] of Object.entries({ ...BASE, ...extra })) if (v !== undefined) process.env[k] = v;
  resetEnvCache();
};

beforeAll(async () => {
  for (const k of MANAGED) saved[k] = process.env[k];
  delete process.env.DATABASE_URL;
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
  setEnv({});
});

const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { method: "GET", headers: { host: "www.clankrpg.fun", ...headers } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { host: "www.clankrpg.fun", origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const me = async (headers: Record<string, string> = {}) => {
  const route = await import("@/app/api/me/route");
  const res = await route.GET(get("/api/me", headers));
  return { res, body: (await res.json()) as { viewer: unknown; login: { telegramBot: string | null; devLogin: boolean }; features: unknown } };
};

describe("an anonymous visitor", () => {
  it("is `viewer: null` — no guest object, no cookie issued, nothing that could be read as authenticated", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: "ClankRpgBot" });
    const { res, body } = await me();
    expect(res.status).toBe(200);
    expect(body.viewer).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("a stale, tampered or garbage session cookie is still anonymous (and the admin cookie is not a player session)", async () => {
    for (const cookie of ["clank_session=garbage", "clank_session=" + encodeURIComponent("a.b.c"), "clank_session=", "clank_admin=whatever", "other=1"]) {
      expect((await me({ cookie })).body.viewer, cookie).toBeNull();
    }
  });

  it("every protected player endpoint refuses them (401) instead of acting on a guest", async () => {
    const inventory = await import("@/app/api/me/inventory/route");
    expect((await inventory.GET(get("/api/me/inventory"))).status).toBe(401);
    const equip = await import("@/app/api/me/equip/route");
    expect((await equip.POST(post("/api/me/equip", { itemId: "00000000-0000-4000-8000-000000000000", equip: true }))).status).toBe(401);
    const tactic = await import("@/app/api/me/tactic/route");
    expect((await tactic.POST(post("/api/me/tactic", { tactic: "BALANCED" }))).status).toBe(401);
    const claim = await import("@/app/api/me/claim/route");
    expect((await claim.POST(post("/api/me/claim", {}))).status).toBe(401);
  });

  it("logging out while anonymous is harmless and issues no session", async () => {
    const logout = await import("@/app/api/auth/logout/route");
    const res = await logout.POST(post("/api/auth/logout", {}));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/clank_session=;/); // clears, never sets
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/clank_session=[^;]+;/);
  });
});

describe("the Telegram sign-in button is offered only when it can work", () => {
  it.each([
    { name: "neither the bot token nor the username (the production state that hid the button)", env: {}, bot: null },
    { name: "token but NO username (the widget cannot be rendered)", env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN }, bot: null },
    { name: "username but NO token (the server could not verify a login)", env: { NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: "ClankRpgBot" }, bot: null },
    { name: "both", env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN, NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: "ClankRpgBot" }, bot: "ClankRpgBot" },
  ])("$name → login.telegramBot = $bot", async ({ env, bot }) => {
    setEnv(env);
    expect((await me()).body.login.telegramBot).toBe(bot);
  });

  it("the dev login can never be offered in production, whatever the flag says", async () => {
    setEnv({ NODE_ENV: "production", CLANK_DEV_LOGIN: "true", TELEGRAM_BOT_TOKEN: BOT_TOKEN, NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: "ClankRpgBot" });
    try {
      expect((await me()).body.login.devLogin).toBe(false);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = "test";
      resetEnvCache();
    }
    setEnv({ CLANK_DEV_LOGIN: "true" }); // …while in development it is (so the local preview keeps working)
    expect((await me()).body.login.devLogin).toBe(true);
  });

  it("without TELEGRAM_BOT_TOKEN the login endpoint says so (503 LOGIN_UNAVAILABLE) — what production returned", async () => {
    const route = await import("@/app/api/auth/telegram/route");
    const res = await route.POST(post("/api/auth/telegram", {}));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: "LOGIN_UNAVAILABLE" });
  });

  it("with the token set, an invalid login is refused as input/credentials (never 503, never a session)", async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, NEXT_PUBLIC_TELEGRAM_BOT_USERNAME: "ClankRpgBot" });
    const route = await import("@/app/api/auth/telegram/route");
    const empty = await route.POST(post("/api/auth/telegram", {}));
    expect([401, 422]).toContain(empty.status);
    const forged = await route.POST(post("/api/auth/telegram", { id: 1, first_name: "x", auth_date: Math.floor(Date.now() / 1000), hash: "0".repeat(64) }));
    expect(forged.status).toBe(401);
    expect(forged.headers.get("set-cookie")).toBeNull();
  });
});

describe("production domain / origin handling for clankrpg.fun", () => {
  const origin = (o: string | null, host: string, forwarded?: string) => {
    const headers = new Headers({ host });
    if (o !== null) headers.set("origin", o);
    if (forwarded) headers.set("x-forwarded-host", forwarded);
    return sameOriginOk(new Request(`${ORIGIN}/api/auth/telegram`, { method: "POST", headers }));
  };

  it("accepts the site's own origin on www (Host match) and when it is the configured NEXT_PUBLIC_APP_URL", () => {
    expect(origin("https://www.clankrpg.fun", "www.clankrpg.fun")).toBe(true);
    expect(origin("https://www.clankrpg.fun", "internal-lambda-host", "www.clankrpg.fun")).toBe(true); // behind the platform proxy
    expect(origin("https://www.clankrpg.fun", "internal-lambda-host")).toBe(true); // via NEXT_PUBLIC_APP_URL
  });

  it("refuses a missing origin, a foreign origin and the other hostname when it is neither the Host nor the configured origin", () => {
    expect(origin(null, "www.clankrpg.fun")).toBe(false);
    expect(origin("https://evil.example", "www.clankrpg.fun")).toBe(false);
    expect(origin("https://clankrpg.fun", "internal-lambda-host")).toBe(false); // apex is not the configured origin (the edge redirects apex → www before any POST)
    expect(origin("http://www.clankrpg.fun", "internal-lambda-host")).toBe(false); // wrong scheme
  });

  it("the session cookie is host-only, HttpOnly, Secure in production and SameSite=Lax — a www login never leaks to another host", async () => {
    const { cookieHeader } = await import("@/server/http/guards");
    setEnv({ NODE_ENV: "production", DATABASE_URL: undefined });
    const header = cookieHeader("clank_session", "token", 1209600);
    (process.env as Record<string, string>).NODE_ENV = "test";
    resetEnvCache();
    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toMatch(/Domain=/i);
  });
});
