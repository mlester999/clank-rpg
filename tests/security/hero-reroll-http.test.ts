import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { invalidateFlagCache, resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * THE FREE REROLL ROUTE, over real Request objects: what a browser (or an attacker with a cookie) can and cannot do.
 * GET /api/me/hero/reroll (status) and POST /api/me/hero/reroll { requestId } (the reroll itself).
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
const req = (init: RequestInit & { origin?: string | null; json?: unknown; cookie?: string; method?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}/api/me/hero/reroll`, { method: init.method ?? "POST", headers, body: init.json !== undefined ? JSON.stringify(init.json) : (init.body ?? null) });
};
const route = async () => (await import("@/app/api/me/hero/reroll/route")) as unknown as { GET: RouteFn; POST: RouteFn };
const flag = async (on: boolean) => {
  await db.query("insert into public.feature_flags (key, enabled, description) values ('hero.free_reroll', $1, 'test') on conflict (key) do update set enabled = excluded.enabled", [on]);
  invalidateFlagCache();
};
const cookieOf = (res: Response) => (res.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
let loginClock = Math.floor(Date.now() / 1000);
async function loginAs(telegramId: number): Promise<string> {
  const auth = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  const h = new Headers({ origin: ORIGIN, host: "localhost:3700", "content-type": "application/json" });
  const res = await (auth.POST as unknown as RouteFn)(new Request(`${ORIGIN}/api/auth/telegram`, { method: "POST", headers: h, body: JSON.stringify(payload) }));
  return cookieOf(res);
}
/** A signed-in member whose hero is claimed. */
async function claimedMember(tid: number): Promise<{ cookie: string; hero: string }> {
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  const cookie = await loginAs(tid);
  const claim = await import("@/app/api/me/claim/route");
  const r = await (claim.POST as unknown as RouteFn)(req({ json: {}, cookie }));
  expect(r.status).toBe(200);
  return { cookie, hero: hero! };
}
const versions = async (hero: string) => Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1", [hero]))[0]!.n);

describe("the feature flag: OFF by default, and a disabled feature writes nothing", () => {
  it("a missing flag is OFF: status says DISABLED, the POST is refused with 403 FREE_REROLL_DISABLED and nothing changes", async () => {
    const { cookie, hero } = await claimedMember(5001);
    const r = await route();
    const status = await (await r.GET(req({ method: "GET", cookie }))).json();
    expect(status).toMatchObject({ ok: true, status: { state: "DISABLED", current: null, today: null } });
    const res = await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "FREE_REROLL_DISABLED" });
    expect(await versions(hero)).toBe(1);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_free_rerolls"))[0]!.n)).toBe(0);
  });

  it("the reference seed ships the flag DISABLED", async () => {
    const [row] = await db.query<{ enabled: boolean }>("select enabled from public.feature_flags where key = 'hero.free_reroll'");
    expect(row?.enabled).toBe(false);
  });

  it("switching the flag on opens it, switching it off closes it again immediately", async () => {
    const { cookie } = await claimedMember(5002);
    const r = await route();
    await flag(true);
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status.state).toBe("AVAILABLE");
    await flag(false);
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status.state).toBe("DISABLED");
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie }))).status).toBe(403);
  });
});

describe("who may call it", () => {
  it("signed-out visitors get 401 on both verbs; a cross-site or origin-less POST is 403; garbage cookies are anonymous", async () => {
    await flag(true);
    const r = await route();
    expect((await r.GET(req({ method: "GET" }))).status).toBe(401);
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() } }))).status).toBe(401);
    const { cookie } = await claimedMember(5003);
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie, origin: "https://evil.example" }))).status).toBe(403);
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie, origin: null }))).status).toBe(403);
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie: "clank_session=garbage" }))).status).toBe(401);
  });

  it("the body is STRICT: only a UUID requestId — a hero id, a member id, a seed, a class or a rarity is refused (422), and nothing changes", async () => {
    await flag(true);
    const { cookie, hero } = await claimedMember(5004);
    const other = (await seedHeroes(db, 1, { startId: 5090 }))[0]!;
    const r = await route();
    const ok = () => crypto.randomUUID();
    for (const body of [
      {}, { requestId: "nope" }, { requestId: 5 },
      { requestId: ok(), characterId: other }, { requestId: ok(), telegramUserId: 5090 }, { requestId: ok(), seed: "aaaa" },
      { requestId: ok(), classId: "mage" }, { requestId: ok(), rarity: "LEGENDARY" }, { requestId: ok(), power: 999 },
    ]) {
      const res = await r.POST(req({ json: body, cookie }));
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect((await r.POST(req({ cookie, body: "not json", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await r.POST(req({ cookie, body: JSON.stringify({ requestId: ok() }), headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect(await versions(hero)).toBe(1);
    expect(await versions(other)).toBe(1);
  });

  it("an unclaimed hero gets 403 NOT_CLAIMED; a member without a hero gets 404 NO_HERO / status BLOCKED", async () => {
    await flag(true);
    const [hero] = await seedHeroes(db, 1, { startId: 5005 });
    const cookie = await loginAs(5005);
    const r = await route();
    expect((await (await r.GET(req({ method: "GET", cookie }))).json()).status).toMatchObject({ state: "BLOCKED", block: "NOT_CLAIMED" });
    const res = await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "NOT_CLAIMED" });
    expect(await versions(hero!)).toBe(1);
    const heroless = await loginAs(5006);
    expect((await (await r.GET(req({ method: "GET", cookie: heroless }))).json()).status).toMatchObject({ state: "BLOCKED", block: "NO_HERO" });
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie: heroless }))).status).toBe(404);
  });
});

describe("the reroll over HTTP", () => {
  it("first POST succeeds with before/after (no seed, no Telegram id); a second key the same UTC day is 409 ALREADY_USED_TODAY; a replay of the first key returns the same result", async () => {
    await flag(true);
    const { cookie, hero } = await claimedMember(5010);
    const r = await route();
    const key = crypto.randomUUID();
    const res = await r.POST(req({ json: { requestId: key }, cookie }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toMatchObject({ requestId: key, alreadyApplied: false });
    expect(body.result.before.publicId).toBe(body.result.after.publicId);
    expect(JSON.stringify(body)).not.toMatch(/generationSeed|telegram_user_id|telegramUserId|nonce|"5010"/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await versions(hero)).toBe(2);

    const second = await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie }));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, error: "ALREADY_USED_TODAY" });

    const replay = await r.POST(req({ json: { requestId: key.toUpperCase() }, cookie }));
    expect(replay.status).toBe(200);
    const again = await replay.json();
    expect(again.result).toMatchObject({ requestId: key, alreadyApplied: true });
    expect(again.result.after).toEqual(body.result.after);
    expect(await versions(hero)).toBe(2);

    const status = (await (await r.GET(req({ method: "GET", cookie }))).json()).status;
    expect(status).toMatchObject({ state: "USED" });
    expect(status.today.requestId).toBe(key);
    expect(status.current).toEqual(body.result.after);
  });

  it("another member's cookie can never reroll or replay someone else's hero or key", async () => {
    await flag(true);
    const a = await claimedMember(5020);
    const b = await claimedMember(5021);
    const r = await route();
    const key = crypto.randomUUID();
    expect((await r.POST(req({ json: { requestId: key }, cookie: a.cookie }))).status).toBe(200);
    const stolen = await r.POST(req({ json: { requestId: key }, cookie: b.cookie }));
    expect(stolen.status).toBe(409);
    expect(await stolen.json()).toMatchObject({ error: "REQUEST_CONFLICT" });
    expect(await versions(b.hero)).toBe(1);
    expect(await versions(a.hero)).toBe(2);
  });

  it("a banned member's session is dead (401); a suspended hero is 409 HERO_UNAVAILABLE with no reason", async () => {
    await flag(true);
    const banned = await claimedMember(5030);
    const suspended = await claimedMember(5031);
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [suspended.hero]);
    await db.query("update public.telegram_users set status = 'BANNED', session_epoch = session_epoch + 1 where telegram_user_id = 5030");
    const r = await route();
    expect((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie: banned.cookie }))).status).toBe(401);
    const res = await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie: suspended.cookie }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "HERO_UNAVAILABLE", message: "Your hero can't be rerolled right now." });
    expect(JSON.stringify(body)).not.toMatch(/suspend|ban|flag|review/i);
  });

  it("a courtesy rate limit answers 429 to a script hammering the endpoint — the daily rule itself is a database constraint, not this", async () => {
    await flag(true);
    const { cookie } = await claimedMember(5040);
    const r = await route();
    const codes: number[] = [];
    for (let i = 0; i < 16; i++) codes.push((await r.POST(req({ json: { requestId: crypto.randomUUID() }, cookie }))).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes).toContain(429);
  });
});
