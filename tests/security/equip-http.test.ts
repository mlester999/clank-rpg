import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * POST /api/me/equip — equip / unequip over real Request objects.
 *
 * The regression this file exists for: the handler used to read the (2 s cached) settings and class list from INSIDE its own transaction. On the production
 * driver (pool of ONE connection) that read needs a second connection while the transaction holds the only one, so every equip that met a cold cache waited
 * behind its own transaction until the browser gave up ("The server is taking too long to answer"). Run this file on the real driver to see it:
 *
 *   CLANK_TEST_DRIVER=postgres CLANK_TEST_POOL=1 CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres pnpm exec vitest run tests/security/equip-http.test.ts
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
const give = async (hero: string, template: string, slot: string) =>
  (await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, $3) returning id", [hero, template, slot]))[0]!.id;
const equip = async (cookie: string, itemId: string, on: boolean) => {
  const route = (await import("@/app/api/me/equip/route")) as unknown as { POST: RouteFn };
  return route.POST(post("/api/me/equip", { itemId, equip: on }, cookie));
};
const equippedIds = async (hero: string) => (await db.query<{ id: string }>("select id from public.inventory_items where character_id = $1 and equipped order by slot", [hero])).map((r) => r.id);

describe("POST /api/me/equip", () => {
  it("equips, swaps within a slot and unequips — and answers (no waiting on a second connection) when the settings cache is cold", async () => {
    const { cookie, hero, cls } = await claimedMember(6001);
    const rare = await give(hero, `${cls}_weapon_rare`, "WEAPON");
    const epic = await give(hero, `${cls}_weapon_epic`, "WEAPON");

    resetRuntimeCaches(); // a cold cache: the production case (the cache lives 2 s and an equip is rare)
    const a = await equip(cookie, rare, true);
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ ok: true, equipped: true });
    expect(await equippedIds(hero)).toEqual([rare]);

    resetRuntimeCaches();
    expect((await equip(cookie, epic, true)).status).toBe(200);
    expect(await equippedIds(hero)).toEqual([epic]);

    resetRuntimeCaches();
    const off = await equip(cookie, epic, false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ ok: true, equipped: false });
    expect(await equippedIds(hero)).toEqual([]);
  });

  it("keeps the cached POWER in step with the gear (the work the transaction exists for)", async () => {
    const { cookie, hero, cls } = await claimedMember(6002);
    const epic = await give(hero, `${cls}_weapon_epic`, "WEAPON");
    // PWR is derived from the GENERATED stats, so gear never moves it; the point is that the refresh ran inside the same commit and left a valid number.
    const [before] = await db.query<{ power: number }>("select power from public.characters where id = $1", [hero]);
    resetRuntimeCaches();
    expect((await equip(cookie, epic, true)).status).toBe(200);
    const [after] = await db.query<{ power: number }>("select power from public.characters where id = $1", [hero]);
    expect(after!.power).toBe(before!.power);
  });

  it("refuses without a session, for another hero's item, and for a class-restricted item — and changes nothing", async () => {
    const a = await claimedMember(6003);
    const b = await claimedMember(6004);
    const mine = await give(a.hero, `${a.cls}_weapon_rare`, "WEAPON");
    const route = (await import("@/app/api/me/equip/route")) as unknown as { POST: RouteFn };
    expect((await route.POST(post("/api/me/equip", { itemId: mine, equip: true }))).status).toBe(401);
    expect((await equip(b.cookie, mine, true)).status).toBe(404);
    expect(await equippedIds(a.hero)).toEqual([]);
    const other = (await db.query<{ id: string }>("select id from public.character_classes where id <> $1 order by sort_order limit 1", [a.cls]))[0]!.id;
    const foreign = await give(a.hero, `${other}_weapon_rare`, "WEAPON");
    expect((await equip(a.cookie, foreign, true)).status).toBe(403);
    expect(await equippedIds(a.hero)).toEqual([]);
  });
});
