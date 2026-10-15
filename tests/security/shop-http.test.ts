import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { applyLedger, getBalance } from "@/server/services/economy";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * THE GEAR SHOP over real Request objects: GET /api/me/shop, POST /api/me/shop/buy, POST /api/me/shop/sell, and the shop block of GET /api/me/inventory.
 * The body carries ids only — never a price — and only the signed-in, claimed owner can spend or earn their own hero's Gold. Run on the real driver with a pool of ONE
 * connection to prove no route needs a second one inside its transaction:
 *
 *   CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1 CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/security/shop-http.test.ts
 */
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
const post = (path: string, json: unknown, cookie?: string) => {
  const headers = new Headers({ origin: ORIGIN, host: "localhost:3700", "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(json) });
};
const cookieOf = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
let loginClock = Math.floor(Date.now() / 1000);
async function claimedMember(tid: number): Promise<{ cookie: string; hero: string; cls: string }> {
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  const auth = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: tid, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  const login = await (auth.POST as unknown as RouteFn)(post("/api/auth/telegram", payload));
  const cookie = cookieOf(login);
  const claim = await import("@/app/api/me/claim/route");
  expect((await (claim.POST as unknown as RouteFn)(post("/api/me/claim", {}, cookie))).status).toBe(200);
  const [c] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero]);
  return { cookie, hero: hero!, cls: c!.class_id };
}
const SHOP = DEFAULT_SETTINGS.shop;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const call = async (module: string, method: "GET" | "POST", cookie: string | undefined, json?: unknown, origin = true) => {
  const route = (await import(module)) as unknown as Record<string, RouteFn>;
  const headers = new Headers({ host: "localhost:3700" });
  if (origin) headers.set("origin", ORIGIN);
  if (json !== undefined) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  return route[method]!(new Request(`${ORIGIN}/api/me/shop`, { method, headers, body: json === undefined ? null : JSON.stringify(json) }));
};
const buy = (cookie: string | undefined, json: unknown, origin = true) => call("@/app/api/me/shop/buy/route", "POST", cookie, json, origin);
const sell = (cookie: string | undefined, json: unknown, origin = true) => call("@/app/api/me/shop/sell/route", "POST", cookie, json, origin);
const gold = async (cookie: string, hero: string, amount: number) => {
  await applyLedger(db, { characterId: hero, amount, reason: "test", idempotencyKey: `test-gold-${hero}-${amount}` });
  return cookie;
};

describe("GET /api/me/shop and the inventory's shop block", () => {
  it("serves the hero's own shop — class gear, prices from the settings, its Gold — and needs a session", async () => {
    const { cookie, hero } = await claimedMember(7001);
    await gold(cookie, hero, 1234);
    const res = await call("@/app/api/me/shop/route", "GET", cookie);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.shop).toMatchObject({ enabled: true, claimed: true, gold: 1234 });
    expect(body.shop.items.length).toBeGreaterThan(0);
    for (const i of body.shop.items) expect(i.price).toBe(SHOP.buy[i.rarity as keyof typeof SHOP.buy]);
    expect((await call("@/app/api/me/shop/route", "GET", undefined)).status).toBe(401);
  });

  it("the inventory carries what a spare item of each rarity sells for (null while the shop is closed)", async () => {
    const { cookie } = await claimedMember(7002);
    const inv = async () => (await (await call("@/app/api/me/inventory/route", "GET", cookie)).json()).shop;
    expect(await inv()).toEqual({ enabled: true, sell: SHOP.sell });
    await db.query(`update public.game_settings set value = value || '{"enabled": false}'::jsonb where key = 'shop'`);
    const { resetRuntimeCaches } = await import("@/server/runtime");
    resetRuntimeCaches();
    expect(await inv()).toEqual({ enabled: false, sell: null });
  });
});

describe("POST /api/me/shop/buy", () => {
  it("buys the item, charges the SERVER's price, and a replay of the same request id charges nothing more — with a cold settings cache and on a pool of one", async () => {
    const { cookie, hero, cls } = await claimedMember(7003);
    await gold(cookie, hero, 2000);
    const { resetRuntimeCaches } = await import("@/server/runtime");
    resetRuntimeCaches();
    const res = await buy(cookie, { templateId: `${cls}_weapon_rare`, requestId: uuid(1) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, templateId: `${cls}_weapon_rare`, price: SHOP.buy.RARE, gold: 2000 - SHOP.buy.RARE!, alreadyApplied: false });
    const again = await buy(cookie, { templateId: `${cls}_weapon_rare`, requestId: uuid(1) });
    expect(await again.json()).toMatchObject({ ok: true, alreadyApplied: true, gold: 2000 - SHOP.buy.RARE! });
    expect(await getBalance(db, hero)).toBe(2000 - SHOP.buy.RARE!);
  });

  it("an empty purse is 402 with the Gold the hero really has; nothing is charged or delivered", async () => {
    const { cookie, hero, cls } = await claimedMember(7004);
    await gold(cookie, hero, 100);
    const res = await buy(cookie, { templateId: `${cls}_weapon_epic`, requestId: uuid(1) });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ ok: false, error: "INSUFFICIENT_GOLD", gold: 100 });
    expect(await getBalance(db, hero)).toBe(100);
    expect((await db.query("select 1 from public.inventory_items where character_id = $1", [hero])).length).toBe(0);
  });

  it("not-for-sale and wrong-class items are refused with their own codes", async () => {
    const { cookie, hero, cls } = await claimedMember(7005);
    await gold(cookie, hero, 100_000);
    const other = (await db.query<{ id: string }>("select id from public.character_classes where id <> $1 order by sort_order limit 1", [cls]))[0]!.id;
    expect(await (await buy(cookie, { templateId: `${cls}_weapon_legendary`, requestId: uuid(1) })).json()).toMatchObject({ error: "NOT_FOR_SALE" });
    const wrong = await buy(cookie, { templateId: `${other}_weapon_rare`, requestId: uuid(2) });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ error: "CLASS_RESTRICTED" });
    expect(await getBalance(db, hero)).toBe(100_000);
  });

  it("the body is ids only: a client-sent price (or any other key) is refused, junk is refused before the database, and a session and same-origin are required", async () => {
    const { cookie, hero, cls } = await claimedMember(7006);
    await gold(cookie, hero, 5000);
    const ok = { templateId: `${cls}_weapon_common`, requestId: uuid(1) };
    expect((await buy(cookie, { ...ok, price: 1 })).status).toBe(422);
    expect((await buy(cookie, { ...ok, requestId: "not-a-uuid" })).status).toBe(422);
    expect((await buy(cookie, { ...ok, templateId: "../x" })).status).toBe(422);
    expect((await buy(cookie, { templateId: ok.templateId })).status).toBe(422);
    expect((await buy(undefined, ok)).status).toBe(401);
    expect((await buy(cookie, ok, false)).status).toBe(403);
    expect(await getBalance(db, hero)).toBe(5000);
  });
});

describe("POST /api/me/shop/sell", () => {
  it("sells a spare item for the SERVER's price, once", async () => {
    const { cookie, hero, cls } = await claimedMember(7007);
    const [item] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [hero, `${cls}_weapon_rare`]);
    const res = await sell(cookie, { itemId: item!.id });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, price: SHOP.sell.RARE, gold: SHOP.sell.RARE });
    expect((await sell(cookie, { itemId: item!.id })).status).toBe(404);
    expect(await getBalance(db, hero)).toBe(SHOP.sell.RARE);
  });

  it("refuses an equipped item (409), another member's item (404) and a body with a price (422)", async () => {
    const a = await claimedMember(7008);
    const b = await claimedMember(7009);
    const [equipped] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true) returning id", [a.hero, `${a.cls}_weapon_rare`]);
    const [spare] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'ARMOR') returning id", [a.hero, `${a.cls === "warrior" || a.cls === "tank" ? "plate" : a.cls === "rogue" || a.cls === "ranger" ? "leather" : "robe"}_armor_common`]);
    expect((await sell(a.cookie, { itemId: equipped!.id })).status).toBe(409);
    expect((await sell(b.cookie, { itemId: spare!.id })).status).toBe(404);
    expect((await sell(a.cookie, { itemId: spare!.id, price: 99999 })).status).toBe(422);
    expect((await sell(undefined, { itemId: spare!.id })).status).toBe(401);
    expect((await sell(a.cookie, { itemId: spare!.id }, false)).status).toBe(403);
    expect(await getBalance(db, a.hero)).toBe(0);
    expect(await getBalance(db, b.hero)).toBe(0);
  });
});
