import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";
import { setAvatarStoreForTests } from "@/server/storage";
import { createMemoryAvatarStore } from "@/server/storage/avatarStore";

import { createTestDb, resetDb, seedHeroes } from "../support/db";
import { EXE_HEADER, HTML_DOCUMENT, makeJpeg, makePng, SVG_WITH_SCRIPT } from "../support/images";

/** Who may change a hero's photo, what is served to the public, and that Telegram's bot token never leaks. */

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
let store = createMemoryAvatarStore();
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
  setAvatarStoreForTests(undefined);
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
  store = createMemoryAvatarStore();
  setAvatarStoreForTests(store);
});

const adminRoute = () => import("@/app/api/admin/[...path]/route");
const avatarRoute = () => import("@/app/api/avatars/[id]/route");
const callAdmin = async (method: string, path: string[], init: { cookie?: string; origin?: string | null; body?: BodyInit | null; type?: string; length?: number } = {}) => {
  const route = await adminRoute();
  const headers = new Headers({ host: "localhost:3700" });
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.type) headers.set("content-type", init.type);
  if (init.length !== undefined) headers.set("content-length", String(init.length));
  const handler = (route as unknown as Record<string, (r: Request, c: unknown) => Promise<Response>>)[method]!;
  return handler(new Request(`${ORIGIN}/api/admin/${path.join("/")}`, { method, headers, body: init.body ?? null }), { params: Promise.resolve({ path }) });
};

let cachedAdminCookie: string | null = null;
async function adminCookie() {
  if (cachedAdminCookie) return cachedAdminCookie;
  const route = await adminRoute();
  const headers = new Headers({ host: "localhost:3700", origin: ORIGIN, "content-type": "application/json" });
  const res = await (route.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(new Request(`${ORIGIN}/api/admin/session`, { method: "POST", headers, body: JSON.stringify({ key: ENV.ADMIN_ACCESS_KEY }) }), { params: Promise.resolve({ path: ["session"] }) });
  cachedAdminCookie = (res.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
  expect(cachedAdminCookie).toContain("clank_admin=");
  return cachedAdminCookie;
}

async function playerCookie(telegramId: number) {
  const route = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: Math.floor(Date.now() / 1000) - 1 }, BOT_TOKEN);
  const headers = new Headers({ host: "localhost:3700", origin: ORIGIN, "content-type": "application/json" });
  const res = await (route.POST as unknown as (r: Request) => Promise<Response>)(new Request(`${ORIGIN}/api/auth/telegram`, { method: "POST", headers, body: JSON.stringify(payload) }));
  return (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
}

const getAvatar = async (id: string, query = "", headers: Record<string, string> = {}) => {
  const route = await avatarRoute();
  return route.GET(new Request(`${ORIGIN}/api/avatars/${id}${query}`, { headers }), { params: Promise.resolve({ id }) });
};
const photoCount = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_photo_overrides"))[0]!.n);

describe("only an admin can change a hero's photo", () => {
  it("rejects every write without an admin session — anonymous callers and signed-in players alike", async () => {
    const [victim] = await seedHeroes(db, 2);
    const player = await playerCookie(555001);
    for (const cookie of [undefined, player]) {
      for (const [method, path] of [["PUT", ["heroes", victim!, "photo"]], ["DELETE", ["heroes", victim!, "photo"]], ["POST", ["heroes", victim!, "photo", "telegram-refresh"]]] as const) {
        const res = await callAdmin(method, [...path], { ...(cookie ? { cookie } : {}), body: method === "PUT" ? new Uint8Array(makePng()) : null, type: "image/png" });
        expect(res.status).toBe(401);
      }
    }
    expect(await photoCount()).toBe(0);
    expect(store.files.size).toBe(0);
  });

  it("rejects an admin request that does not come from this site (CSRF)", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    for (const origin of [null, "https://evil.example"]) {
      const res = await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, origin, body: new Uint8Array(makePng()), type: "image/png" });
      expect(res.status).toBe(403);
    }
    expect(await photoCount()).toBe(0);
  });

  it("an authorised upload works and only ever touches the hero named in the URL", async () => {
    const [a, b] = await seedHeroes(db, 2);
    const cookie = await adminCookie();
    const res = await callAdmin("PUT", ["heroes", a!, "photo"], { cookie, body: new Uint8Array(makePng(200, 200)), type: "image/png" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.photo).toMatchObject({ changed: true, source: "ADMIN", width: 200 });
    expect(body.view).toMatchObject({ active: "ADMIN" });
    expect((await db.query<{ character_id: string }>("select character_id from public.hero_photo_overrides")).map((r) => r.character_id)).toEqual([a]);
    expect((await getAvatar(b!)).status).toBe(404);
  });

  it("malformed hero ids are 404, and the admin detail shows the active source", async () => {
    const cookie = await adminCookie();
    expect((await callAdmin("PUT", ["heroes", "not-a-uuid", "photo"], { cookie, body: new Uint8Array(makePng()), type: "image/png" })).status).toBe(404);
    const [id] = await seedHeroes(db, 1);
    await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, body: new Uint8Array(makePng()), type: "image/png" });
    const detail = await (await callAdmin("GET", ["heroes", id!], { cookie })).json();
    expect(detail.hero.photo).toMatchObject({ active: "ADMIN", url: expect.stringContaining(`/api/avatars/${id}?v=`) });
  });
});

describe("uploads are validated on the server", () => {
  it.each([
    ["an SVG with a script", SVG_WITH_SCRIPT, "image/svg+xml", 422, "PHOTO_UNSUPPORTED_TYPE"],
    ["an HTML page claiming to be an image", HTML_DOCUMENT, "image/png", 422, "PHOTO_UNSUPPORTED_TYPE"],
    ["an executable", EXE_HEADER, "application/octet-stream", 422, "PHOTO_UNSUPPORTED_TYPE"],
    ["a JPEG labelled PNG", makeJpeg(), "image/png", 422, "PHOTO_MIME_MISMATCH"],
    ["an empty body", Buffer.alloc(0), "image/png", 422, "PHOTO_EMPTY"],
  ])("%s", async (_name, bytes, type, status, code) => {
    const [id] = await seedHeroes(db, 1);
    const res = await callAdmin("PUT", ["heroes", id!, "photo"], { cookie: await adminCookie(), body: new Uint8Array(bytes), type });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(code);
    expect(await photoCount()).toBe(0);
    expect(store.files.size).toBe(0);
  });

  it("refuses an oversized body early (declared length) and while streaming (no or false length)", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    const big = new Uint8Array(3 * 1024 * 1024);
    expect((await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, body: big, type: "image/png", length: big.length })).status).toBe(413);
    expect((await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, body: big, type: "image/png" })).status).toBe(413);
    expect((await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, body: big, type: "image/png", length: 100 })).status).toBe(413); // a lying Content-Length buys nothing
    expect(await photoCount()).toBe(0);
  });

  it("says so plainly when photo storage is not configured (and writes nothing)", async () => {
    const [id] = await seedHeroes(db, 1);
    setAvatarStoreForTests(null);
    const res = await callAdmin("PUT", ["heroes", id!, "photo"], { cookie: await adminCookie(), body: new Uint8Array(makePng()), type: "image/png" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("STORAGE_NOT_CONFIGURED");
    expect(await photoCount()).toBe(0);
  });
});

describe("the public avatar endpoint", () => {
  it("serves the image with safe headers and long-lived caching keyed by the content version", async () => {
    const [id] = await seedHeroes(db, 1);
    const png = makePng(180, 180, 7);
    await callAdmin("PUT", ["heroes", id!, "photo"], { cookie: await adminCookie(), body: new Uint8Array(png), type: "image/png" });
    const url = (await (await callAdmin("GET", ["heroes", id!], { cookie: await adminCookie() })).json()).hero.photo.url as string;
    const version = new URL(url, ORIGIN).searchParams.get("v")!;

    const res = await getAvatar(id!, `?v=${version}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(`"${version}"`);

    expect((await getAvatar(id!)).headers.get("cache-control")).toContain("must-revalidate"); // bare/outdated URLs revalidate quickly
    expect((await getAvatar(id!, `?v=${version}`, { "if-none-match": `"${version}"` })).status).toBe(304);
  });

  it("answers 404 (never a broken body) for no photo, unknown heroes and malformed ids", async () => {
    const [id] = await seedHeroes(db, 1);
    for (const target of [id!, "00000000-0000-4000-8000-000000000000", "not-a-uuid", "../etc/passwd"]) {
      const res = await getAvatar(target);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("application/json");
    }
  });

  it("serves 404 (→ default portrait) if the stored object has gone missing, instead of erroring", async () => {
    const [id] = await seedHeroes(db, 1);
    await callAdmin("PUT", ["heroes", id!, "photo"], { cookie: await adminCookie(), body: new Uint8Array(makePng()), type: "image/png" });
    store.files.clear();
    expect((await getAvatar(id!)).status).toBe(404);
  });

  it("removal makes the endpoint 404 again", async () => {
    const [id] = await seedHeroes(db, 1);
    const cookie = await adminCookie();
    await callAdmin("PUT", ["heroes", id!, "photo"], { cookie, body: new Uint8Array(makePng()), type: "image/png" });
    expect((await getAvatar(id!)).status).toBe(200);
    expect((await callAdmin("DELETE", ["heroes", id!, "photo"], { cookie })).status).toBe(200);
    expect((await getAvatar(id!)).status).toBe(404);
  });
});

describe("Telegram photo wiring (bot not connected in this environment)", () => {
  it("the admin refresh reports NOT_CONFIGURED when there is no bot token, and does not call Telegram", async () => {
    const [id] = await seedHeroes(db, 1);
    const prev = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetEnvCache();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const res = await callAdmin("POST", ["heroes", id!, "photo", "telegram-refresh"], { cookie: await adminCookie() });
      expect((await res.json()).result.status).toBe("NOT_CONFIGURED");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = prev;
      resetEnvCache();
    }
  });

  it("with a token it fetches by the immutable Telegram id, caches the photo and serves it publicly", async () => {
    const [id] = await seedHeroes(db, 1);
    const tg = Number((await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [id]))[0]!.telegram_user_id);
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/getUserProfilePhotos")) return Response.json({ ok: true, result: { total_count: 1, photos: [[{ file_id: "F1", file_unique_id: "U1", width: 320, height: 320 }]] } });
      if (url.includes("/getFile")) return Response.json({ ok: true, result: { file_path: "p/1.jpg" } });
      return new Response(new Uint8Array(makeJpeg(320, 320, 1)));
    }) as typeof fetch);
    const res = await callAdmin("POST", ["heroes", id!, "photo", "telegram-refresh"], { cookie: await adminCookie() });
    expect(res.status).toBe(200);
    expect((await res.json()).result.status).toBe("UPDATED");
    expect(urls[0]).toContain(`getUserProfilePhotos?user_id=${tg}`);
    expect((await getAvatar(id!)).status).toBe(200);

    // the cron tick refreshes in bulk only when asked, and reports (never logs) what happened
    const tick = await import("@/app/api/internal/tick/route");
    const out = await tick.GET(new Request(`${ORIGIN}/api/internal/tick?photos=1`, { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
    expect(JSON.stringify(await out.json())).not.toContain(BOT_TOKEN);
  });
});
