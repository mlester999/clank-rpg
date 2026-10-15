import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { grantAchievement } from "@/server/services/achievements";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * POST /api/me/title — choosing which unlocked achievement's title shows above the hero's name, over real Request objects. The body names an ACHIEVEMENT (never
 * text); the server reads the title from the achievement, refuses one that is not unlocked, and only the signed-in, claimed owner can change their own hero.
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
const title = async (cookie: string | undefined, json: unknown, origin = true) => {
  const route = (await import("@/app/api/me/title/route")) as unknown as { POST: RouteFn };
  const headers = new Headers({ host: "localhost:3700", "content-type": "application/json" });
  if (origin) headers.set("origin", ORIGIN);
  if (cookie) headers.set("cookie", cookie);
  return route.POST(new Request(`${ORIGIN}/api/me/title`, { method: "POST", headers, body: JSON.stringify(json) }));
};
const titleOf = async (hero: string) => (await db.query<{ title: string | null }>("select title from public.characters where id = $1", [hero]))[0]!.title;

describe("POST /api/me/title", () => {
  it("shows an unlocked achievement's title, swaps it, and removes it", async () => {
    const { cookie, hero } = await claimedMember(6101);
    await grantAchievement(db, hero, "og_clanker");
    await grantAchievement(db, hero, "seasonal_champion");
    const a = await title(cookie, { achievementId: "og_clanker" });
    expect(a.status).toBe(200);
    expect(await a.json()).toMatchObject({ ok: true, title: "OG Clanker" });
    expect(await titleOf(hero)).toBe("OG Clanker");
    expect(await (await title(cookie, { achievementId: "seasonal_champion" })).json()).toMatchObject({ title: "Seasonal Champion" });
    const off = await title(cookie, { achievementId: null });
    expect(await off.json()).toMatchObject({ ok: true, title: null });
    expect(await titleOf(hero)).toBeNull();
  });

  it("refuses an achievement that is not unlocked (403), and changes nothing", async () => {
    const { cookie, hero } = await claimedMember(6102);
    await grantAchievement(db, hero, "og_clanker");
    await title(cookie, { achievementId: "og_clanker" });
    const r = await title(cookie, { achievementId: "legend_of_the_pit" });
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, error: "NOT_UNLOCKED" });
    expect(await titleOf(hero)).toBe("OG Clanker");
  });

  it("a member can only ever change their OWN hero: the body carries no hero id, and another member's unlocks do not count", async () => {
    const a = await claimedMember(6103);
    const b = await claimedMember(6104);
    await grantAchievement(db, a.hero, "og_clanker");
    expect((await title(b.cookie, { achievementId: "og_clanker" })).status).toBe(403); // b has not unlocked it, whatever a has
    expect((await title(b.cookie, { achievementId: "og_clanker", characterId: a.hero })).status).toBe(422); // strict body: no hero id, no title text
    expect((await title(b.cookie, { achievementId: "og_clanker", title: "Anything I like" })).status).toBe(422);
    expect(await titleOf(a.hero)).toBeNull();
    expect(await titleOf(b.hero)).toBeNull();
  });

  it("needs a session and a same-origin request; junk ids are refused before the database", async () => {
    const { cookie, hero } = await claimedMember(6105);
    await grantAchievement(db, hero, "og_clanker");
    expect((await title(undefined, { achievementId: "og_clanker" })).status).toBe(401);
    expect((await title(cookie, { achievementId: "og_clanker" }, false)).status).toBe(403);
    for (const bad of ["", "OG CLANKER", "../etc", "x".repeat(80), 5, undefined]) expect((await title(cookie, { achievementId: bad })).status, String(bad)).toBe(422);
    expect(await titleOf(hero)).toBeNull();
  });
});
