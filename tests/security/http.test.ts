import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, insertStubHero, resetDb, seedHeroes } from "../support/db";

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
const req = (path: string, init: RequestInit & { origin?: string | null; json?: unknown; cookie?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? null) });
};
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx as never);
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";

let loginClock = Math.floor(Date.now() / 1000);
async function loginAs(telegramId: number) {
  const route = await import("@/app/api/auth/telegram/route");
  // A fresh auth_date each time: identical payloads are (correctly) rejected as replays.
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  const res = await call(route.POST, req("/api/auth/telegram", { json: payload }));
  return { res, cookie: cookieOf(res, "clank_session"), payload };
}

describe("Telegram webhook", () => {
  const CHAT = -1001234567890;
  const update = (over: Record<string, unknown> = {}) => ({
    update_id: Math.floor(Math.random() * 1e9), message: { message_id: Math.floor(Math.random() * 1e9), date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "supergroup" }, from: { id: 31337, is_bot: false, first_name: "Z" }, text: "a perfectly reasonable message about the project and its launch", ...over },
  });
  const post = async (body: unknown, secret: string | null = ENV.TELEGRAM_WEBHOOK_SECRET, raw?: string) => {
    const route = await import("@/app/api/telegram/webhook/route");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
    return call(route.POST, new Request(`${ORIGIN}/api/telegram/webhook`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  };

  it("rejects requests without or with a wrong secret token (403)", async () => {
    expect((await post(update(), null)).status).toBe(403);
    expect((await post(update(), "wrong-secret-wrong-secret-1234")).status).toBe(403);
    expect((await post(update(), ENV.TELEGRAM_WEBHOOK_SECRET + "x")).status).toBe(403);
    expect((await db.query("select 1 from public.telegram_users")).length).toBe(0);
  });
  it("rejects invalid JSON (400) and oversize bodies (413)", async () => {
    expect((await post(null, ENV.TELEGRAM_WEBHOOK_SECRET, "{not json")).status).toBe(400);
    expect((await post(null, ENV.TELEGRAM_WEBHOOK_SECRET, "x".repeat(600 * 1024))).status).toBe(413);
  });
  it("acknowledges (200) but ignores malformed / hostile / foreign-chat updates without crashing", async () => {
    for (const body of [{}, [], "string", 5, { update_id: "NaN" }, { update_id: 1, message: { chat: { id: "x" } } }, update({ chat: { id: -1009, type: "supergroup" } })]) {
      const res = await post(body);
      expect(res.status).toBe(200);
    }
    expect((await db.query("select 1 from public.telegram_users")).length).toBe(0);
  });
  it("processes a real update exactly once, even when Telegram redelivers it", async () => {
    const u = update();
    const first = await (await post(u)).json();
    const again = await (await post(u)).json();
    expect(first).toMatchObject({ ok: true, status: "PROCESSED" });
    expect(again).toMatchObject({ ok: true, status: "DUPLICATE_UPDATE" });
    expect((await db.query<{ n: number }>("select total_message_count as n from public.telegram_users where telegram_user_id = 31337"))[0]!.n).toBe(1);
  });
  it("does not exist for GET (method not allowed)", async () => {
    const route = (await import("@/app/api/telegram/webhook/route")) as Record<string, unknown>;
    expect(route.GET).toBeUndefined();
  });
});

describe("login, sessions and CSRF", () => {
  it("login requires a same-origin request, a valid signature, and is single-use", async () => {
    const route = await import("@/app/api/auth/telegram/route");
    const payload = signTelegramLoginPayload({ id: 4001, first_name: "A", auth_date: Math.floor(Date.now() / 1000) }, BOT_TOKEN);
    expect((await call(route.POST, req("/api/auth/telegram", { json: payload, origin: null }))).status).toBe(403);
    expect((await call(route.POST, req("/api/auth/telegram", { json: payload, origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(route.POST, req("/api/auth/telegram", { json: { ...payload, id: 4002 } }))).status).toBe(401);
    const ok = await call(route.POST, req("/api/auth/telegram", { json: payload }));
    expect(ok.status).toBe(200);
    expect(ok.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
    expect(ok.headers.getSetCookie().join(";")).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(await ok.json())).not.toMatch(/clank_session|\./); // token never in the body
    expect((await call(route.POST, req("/api/auth/telegram", { json: payload }))).status).toBe(401); // replay
  });

  it("a tampered or foreign cookie is not a session", async () => {
    const me = await import("@/app/api/me/route");
    const { cookie } = await loginAs(4003);
    expect(cookie).toContain("clank_session=");
    const good = await (await call(me.GET, req("/api/me", { method: "GET", cookie }))).json();
    expect(good.viewer).not.toBeNull();
    const tampered = cookie.slice(0, -3) + "AAA";
    expect((await (await call(me.GET, req("/api/me", { method: "GET", cookie: tampered }))).json()).viewer).toBeNull();
    expect((await (await call(me.GET, req("/api/me", { method: "GET" }))).json()).viewer).toBeNull();
  });

  it("sessions are revocable (epoch bump) and banned members lose access immediately", async () => {
    const me = await import("@/app/api/me/route");
    const { cookie } = await loginAs(4004);
    await db.query("update public.telegram_users set session_epoch = session_epoch + 1 where telegram_user_id = 4004");
    expect((await (await call(me.GET, req("/api/me", { method: "GET", cookie }))).json()).viewer).toBeNull();
    const second = await loginAs(4004);
    expect((await (await call(me.GET, req("/api/me", { method: "GET", cookie: second.cookie }))).json()).viewer).not.toBeNull();
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = 4004");
    expect((await (await call(me.GET, req("/api/me", { method: "GET", cookie: second.cookie }))).json()).viewer).toBeNull();
  });

  it("mutating endpoints need a session AND a same-origin request", async () => {
    const claim = await import("@/app/api/me/claim/route");
    const tactic = await import("@/app/api/me/tactic/route");
    const equip = await import("@/app/api/me/equip/route");
    expect((await call(claim.POST, req("/api/me/claim", { json: {} }))).status).toBe(401);
    expect((await call(tactic.POST, req("/api/me/tactic", { json: { tactic: "AGGRESSIVE" } }))).status).toBe(401);
    expect((await call(equip.POST, req("/api/me/equip", { json: { itemId: crypto.randomUUID(), equip: true } }))).status).toBe(401);
    const { cookie } = await loginAs(4005);
    expect((await call(claim.POST, req("/api/me/claim", { json: {}, cookie, origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(claim.POST, req("/api/me/claim", { json: {}, cookie, origin: null }))).status).toBe(403);
  });

  it("claiming derives the hero from the SESSION's Telegram id; a body-supplied hero id is ignored", async () => {
    const claim = await import("@/app/api/me/claim/route");
    const [mine, theirs] = await seedHeroes(db, 2, { startId: 4100 });
    const { cookie } = await loginAs(4100);
    const res = await call(claim.POST, req("/api/me/claim", { json: { characterId: theirs }, cookie }));
    expect(res.status).toBe(200);
    expect((await res.json()).characterId).toBe(mine);
    const claims = await db.query<{ character_id: string }>("select character_id from public.character_claims");
    expect(claims.map((c) => c.character_id)).toEqual([mine]);
  });

  it("a member cannot equip or read another hero's inventory", async () => {
    const equip = await import("@/app/api/me/equip/route");
    const claim = await import("@/app/api/me/claim/route");
    const [a, b] = await seedHeroes(db, 2, { startId: 4200 });
    const [item] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) select $1, id, 'WEAPON' from public.item_templates where id like '%_weapon_common' limit 1 returning id", [b]);
    const { cookie } = await loginAs(4200);
    await call(claim.POST, req("/api/me/claim", { json: {}, cookie }));
    const res = await call(equip.POST, req("/api/me/equip", { json: { itemId: item!.id, equip: true }, cookie }));
    expect(res.status).toBe(404);
    expect(a).not.toBe(b);
  });

  it("input validation: unknown fields, wrong types and wrong content-type are rejected", async () => {
    const tactic = await import("@/app/api/me/tactic/route");
    await seedHeroes(db, 1, { startId: 4300 });
    const { cookie } = await loginAs(4300);
    expect((await call(tactic.POST, req("/api/me/tactic", { json: { tactic: "GODMODE" }, cookie }))).status).toBe(422);
    expect((await call(tactic.POST, req("/api/me/tactic", { json: { tactic: "BALANCED", power: 9999 }, cookie }))).status).toBe(422);
    expect((await call(tactic.POST, req("/api/me/tactic", { body: "tactic=BALANCED", cookie, headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(415);
  });
});

describe("admin API", () => {
  const adminRoute = () => import("@/app/api/admin/[...path]/route");
  const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

  async function adminCookie() {
    const route = await adminRoute();
    const res = await call(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), ctx("session"));
    return { res, cookie: cookieOf(res, "clank_admin") };
  }

  it("every admin route is closed without an admin session", async () => {
    const route = await adminRoute();
    for (const path of [["overview"], ["heroes"], ["config"], ["arena"], ["audit"], ["tokens"], ["flags"], ["bosses"], ["seasons"]]) {
      expect((await call(route.GET, req(`/api/admin/${path.join("/")}`, { method: "GET" }), ctx(...path))).status, path.join("/")).toBe(401);
    }
    expect((await call(route.POST, req("/api/admin/arena", { json: { action: "pause" } }), ctx("arena"))).status).toBe(401);
    expect((await call(route.PUT, req("/api/admin/flags/arena.picks", { method: "PUT", json: { enabled: true } }), ctx("flags", "arena.picks"))).status).toBe(401);
  });

  it("a normal player session is NOT an admin session", async () => {
    const route = await adminRoute();
    const { cookie } = await loginAs(5001);
    expect((await call(route.GET, req("/api/admin/overview", { method: "GET", cookie }), ctx("overview"))).status).toBe(401);
  });

  it("login needs the exact key, is origin-checked and rate-limited; the cookie is strict", async () => {
    const route = await adminRoute();
    expect((await call(route.POST, req("/api/admin/session", { json: { key: "wrong" } }), ctx("session"))).status).toBe(401);
    expect((await call(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY }, origin: "https://evil.example" }), ctx("session"))).status).toBe(403);
    const { res } = await adminCookie();
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().join(";")).toMatch(/SameSite=Strict/i);
    expect(res.headers.getSetCookie().join(";")).toMatch(/HttpOnly/i);
  });

  it("brute-forcing the key is throttled", async () => {
    const route = await adminRoute();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = new Request(`${ORIGIN}/api/admin/session`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3700", "content-type": "application/json", "x-forwarded-for": "203.0.113.77" }, body: JSON.stringify({ key: `guess-${i}` }) });
      statuses.push((await call(route.POST, r, ctx("session"))).status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true);
  });

  it("authenticated admin mutations require same-origin and are audit-logged", async () => {
    const route = await adminRoute();
    const { cookie } = await adminCookie();
    expect((await call(route.POST, req("/api/admin/arena", { json: { action: "pause" }, cookie, origin: "https://evil.example" }), ctx("arena"))).status).toBe(403);
    expect((await call(route.POST, req("/api/admin/arena", { json: { action: "pause" }, cookie }), ctx("arena"))).status).toBe(200);
    // Nothing is committed in a freshly reset arena, so the pause completes at once (a busy arena would be PAUSE_REQUESTED first).
    expect((await db.query<{ status: string; paused: boolean }>("select status, paused from public.arena_state"))[0]).toEqual({ status: "PAUSED", paused: true });
    const log = await db.query<{ action: string; actor: string }>("select action, actor from public.admin_audit_log order by id");
    expect(log).toEqual([{ action: "ARENA_PAUSE_REQUEST", actor: "admin" }, { action: "ARENA_PAUSED", actor: "admin" }]);
  });

  it("admin balance edits are validated: unknown keys and out-of-range values are rejected", async () => {
    const route = await adminRoute();
    const { cookie } = await adminCookie();
    const put = (key: string, value: unknown) => call(route.PUT, req(`/api/admin/settings/${key}`, { method: "PUT", json: { value }, cookie }), ctx("settings", key));
    expect((await put("nonsense", {})).status).toBe(404);
    expect((await put("arena", { groupSize: 8 })).status).toBe(422); // missing fields (strict schema)
    const cfg = await (await call(route.GET, req("/api/admin/config", { method: "GET", cookie }), ctx("config"))).json();
    const arena = { ...cfg.settings.arena, maxCombatMs: 999_999_999 };
    expect((await put("arena", arena)).status).toBe(422);
    const okArena = { ...cfg.settings.arena, resultsMs: 6000 };
    expect((await put("arena", okArena)).status).toBe(200);
    expect((await db.query<{ value: { resultsMs: number }; version: number }>("select value, version from public.game_settings where key = 'arena'"))[0]).toMatchObject({ value: { resultsMs: 6000 }, version: 2 });
  });

  it("without ADMIN_ACCESS_KEY configured the admin area is disabled entirely", async () => {
    const route = await adminRoute();
    const key = process.env.ADMIN_ACCESS_KEY;
    delete process.env.ADMIN_ACCESS_KEY;
    resetEnvCache();
    try {
      expect((await call(route.POST, req("/api/admin/session", { json: { key: "anything-at-all-anything-123" } }), ctx("session"))).status).toBe(503);
      expect((await call(route.GET, req("/api/admin/overview", { method: "GET" }), ctx("overview"))).status).toBe(401);
    } finally {
      process.env.ADMIN_ACCESS_KEY = key;
      resetEnvCache();
    }
  });
});

describe("internal cron endpoint", () => {
  it("requires the exact bearer secret", async () => {
    const route = await import("@/app/api/internal/tick/route");
    const get = (auth?: string) => call(route.GET, new Request(`${ORIGIN}/api/internal/tick`, { method: "GET", headers: auth ? { authorization: auth } : {} }));
    expect((await get()).status).toBe(403);
    expect((await get("Bearer nope")).status).toBe(403);
    expect((await get(`Bearer ${ENV.CRON_SECRET}x`)).status).toBe(403);
    expect((await get(ENV.CRON_SECRET)).status).toBe(403);
    expect((await get(`Bearer ${ENV.CRON_SECRET}`)).status).toBe(200);
  });
  it("advances the arena", async () => {
    await seedHeroes(db, 24);
    const route = await import("@/app/api/internal/tick/route");
    const res = await call(route.POST, new Request(`${ORIGIN}/api/internal/tick`, { method: "POST", headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    // One battle on stage, the UPCOMING battle and the one behind it, both already prepared ahead of their slots.
    expect((await db.query("select 1 from public.arena_battles where status = 'SIMULATED'")).length).toBe(3);
  });
});

describe("environment handling", () => {
  it("treats blank KEY= lines (as shipped in .env.example) as unset instead of crashing", async () => {
    const { getEnv } = await import("@/server/env");
    const env = getEnv({ NODE_ENV: "production", SESSION_SECRET: "", ADMIN_ACCESS_KEY: "", DATABASE_URL: "", TELEGRAM_BOT_TOKEN: "" } as NodeJS.ProcessEnv);
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.ADMIN_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.isProduction).toBe(true);
  });
  it("still rejects weak secrets that ARE set, and refuses to invent production secrets", async () => {
    const { getEnv, getSecret } = await import("@/server/env");
    expect(() => getEnv({ NODE_ENV: "production", SESSION_SECRET: "short" } as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
    const prod = getEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
    expect(() => getSecret("SESSION_SECRET", prod)).toThrow(/must be configured/);
    expect(() => getSecret("CLASS_ROLL_SECRET", prod)).toThrow(/must be configured/);
    expect(() => getSecret("TELEGRAM_HASH_PEPPER", prod)).toThrow(/must be configured/);
    // development with the EMBEDDED database gets documented, non-secret fallbacks ...
    const dev = getEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
    expect(getSecret("SESSION_SECRET", dev)).toContain("dev-only");
    // ... but NOT when pointed at a real database, even outside production (e.g. an import script run
    // from a laptop against Supabase): class rolls / hashes from a public fallback would be permanent.
    const devAgainstReal = getEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres" } as NodeJS.ProcessEnv);
    for (const name of ["SESSION_SECRET", "CLASS_ROLL_SECRET", "TELEGRAM_HASH_PEPPER"] as const) {
      expect(() => getSecret(name, devAgainstReal)).toThrow(/must be configured/);
    }
    const configured = getEnv({ NODE_ENV: "development", DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres", CLASS_ROLL_SECRET: "c".repeat(32) } as NodeJS.ProcessEnv);
    expect(getSecret("CLASS_ROLL_SECRET", configured)).toBe("c".repeat(32));
  });
  it("demo heroes and dev login are never implied in production", async () => {
    const { demoHeroesAllowed, devLoginEnabled, getEnv } = await import("@/server/env");
    const prod = getEnv({ NODE_ENV: "production", CLANK_DEV_LOGIN: "true" } as NodeJS.ProcessEnv);
    expect(devLoginEnabled(prod)).toBe(false);
    expect(demoHeroesAllowed(prod)).toBe(false);
    expect(demoHeroesAllowed(getEnv({ NODE_ENV: "production", CLANK_ALLOW_DEMO_HEROES: "true" } as NodeJS.ProcessEnv))).toBe(true); // only by explicit opt-in
    expect(demoHeroesAllowed(getEnv({ NODE_ENV: "development", DATABASE_URL: "postgres://u:p@h:6543/db" } as NodeJS.ProcessEnv))).toBe(false);
    expect(demoHeroesAllowed(getEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv))).toBe(true); // local embedded DB
  });
});

describe("dev login is impossible in production and limited to demo heroes", () => {
  it("is available in test only for DEV_SEED heroes", async () => {
    const route = await import("@/app/api/auth/dev/route");
    const [real] = await seedHeroes(db, 1, { startId: 6001 });
    expect((await call(route.POST, req("/api/auth/dev", { json: { characterId: real } }))).status).toBe(404); // real hero → refused
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, is_demo) values (-6001, 'Demo', true)");
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes limit 1");
    const demoId = await insertStubHero(db, { telegram_user_id: -6001, class_id: cls!.id, name: "Demo", origin: "DEV_SEED", is_demo: true });
    expect((await call(route.POST, req("/api/auth/dev", { json: { characterId: demoId } }))).status).toBe(200);
  });
  it("is hard-disabled when NODE_ENV=production, whatever the env flag says", async () => {
    const route = await import("@/app/api/auth/dev/route");
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetEnvCache();
    try {
      expect((await call(route.POST, req("/api/auth/dev", { json: { characterId: crypto.randomUUID() } }))).status).toBe(404);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
      resetEnvCache();
    }
  });
});

describe("public read endpoints", () => {
  it("arena state, leaderboard and hero endpoints work and never leak internals", async () => {
    await seedHeroes(db, 16);
    const state = await import("@/app/api/arena/state/route");
    const lb = await import("@/app/api/leaderboard/route");
    const hero = await import("@/app/api/heroes/[id]/route");
    const res = await call(state.GET, req("/api/arena/state", { method: "GET" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state.status).toBe("LIVE");
    expect(body.state.current.fighters).toHaveLength(8);
    expect(JSON.stringify(body)).not.toMatch(/seed|password|secret|token/i);
    expect(body.state.current.results).toBeNull(); // results are withheld until combat has ended on the server clock
    expect((await call(lb.GET, req("/api/leaderboard?board=NOPE", { method: "GET" }))).status).toBe(400);
    expect((await call(lb.GET, req("/api/leaderboard?board=POWER", { method: "GET" }))).status).toBe(200);
    expect((await call(hero.GET, req("/api/heroes/not-a-uuid", { method: "GET" }), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(404);
    const id = body.state.current.fighters[0].characterId as string;
    const h = await (await call(hero.GET, req(`/api/heroes/${id}`, { method: "GET" }), { params: Promise.resolve({ id }) })).json();
    expect(h.isOwner).toBe(false);
    expect(h.owner).toBeNull();
    expect(JSON.stringify(h)).not.toMatch(/telegram_user_id|address|session/i);
  });

  it("replay endpoint: unknown/malformed ids are 404; a live battle replays with matching hash", async () => {
    await seedHeroes(db, 16);
    const state = await import("@/app/api/arena/state/route");
    const replay = await import("@/app/api/arena/battles/[id]/replay/route");
    const body = await (await call(state.GET, req("/api/arena/state", { method: "GET" }))).json();
    const id = body.state.current.id as string;
    expect((await call(replay.GET, req("/x", { method: "GET" }), { params: Promise.resolve({ id: "../etc/passwd" }) })).status).toBe(404);
    expect((await call(replay.GET, req("/x", { method: "GET" }), { params: Promise.resolve({ id: crypto.randomUUID() }) })).status).toBe(404);
    // The replay holds the whole outcome, so it is withheld while free picks are still open (until combat starts)…
    expect((await call(replay.GET, req("/x", { method: "GET" }), { params: Promise.resolve({ id }) })).status).toBe(404);
    // …and served once combat has begun (move the battle's window into the past to simulate that moment).
    await db.query("update public.arena_battles set starts_at = now() - interval '7 seconds', combat_starts_at = now() - interval '1 second' where id = $1", [id]);
    const ok = await (await call(replay.GET, req("/x", { method: "GET" }), { params: Promise.resolve({ id }) })).json();
    expect(ok.replay.eventsHash).toBe(body.state.current.eventsHash);
    expect(ok.replay.frames.length).toBe((ok.replay.ticks + 1) * 8 * ok.replay.stride);
  });
});
