import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb, seedEligibleMember, seedHeroes } from "../support/db";

/** HTTP-level guarantees of the free-picks API: who may mutate, how, and what is (not) exposed. */

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
async function loginAs(telegramId: number, opts: { eligible?: boolean } = {}) {
  // Rewarded picks need a member with ≥ 50 qualifying messages and an active hero (the login route would only create a bare identity).
  if (opts.eligible !== false) await seedEligibleMember(db, { id: telegramId });
  const route = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  return cookieOf(await call(route.POST, req("/api/auth/telegram", { json: payload })));
}

/**
 * The public state, as a viewer gets it. A COLD process answers from what is already persisted once its first advance has taken
 * longer than the read cap (COLD_READ_WAIT_CAP_MS in server/runtime.ts) — on a loaded machine running the whole suite in parallel the
 * very first read can therefore arrive before the first fights are committed (`current` / `upcoming` still null). A real viewer
 * simply asks again, and so does this helper (at most ~6 s), which keeps these tests about the lifecycle rather than about machine
 * load. (Seen once in a full parallel run; not reproducible in isolation, so this is the documented mechanism, not a proven one.)
 */
async function stateOf() {
  const state = await import("@/app/api/arena/state/route");
  const read = async () => (await (await call(state.GET, req("/api/arena/state", { method: "GET" }))).json()).state;
  let s = await read();
  for (let i = 0; i < 60 && (!s.current || !s.upcoming); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    s = await read();
  }
  return s;
}

describe("POST /api/arena/picks", () => {
  it("needs a session and a same-origin request", async () => {
    const route = await import("@/app/api/arena/picks/route");
    const cookie = await loginAs(7001);
    const body = { battleId: crypto.randomUUID(), characterId: crypto.randomUUID() };
    expect((await call(route.POST, req("/api/arena/picks", { json: body }))).status).toBe(401);
    expect((await call(route.POST, req("/api/arena/picks", { json: body, cookie, origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(route.POST, req("/api/arena/picks", { json: body, cookie, origin: null }))).status).toBe(403);
    expect(await db.query("select 1 from public.arena_picks")).toHaveLength(0);
  });

  it("the member is the SESSION's Telegram id — a body-supplied identity is rejected, not honoured", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 24);
    const s = await stateOf();
    const cookie = await loginAs(7002);
    const fighter = s.upcoming.fighters[0].characterId as string;
    const forged = await call(route.POST, req("/api/arena/picks", { json: { battleId: s.upcoming.id, characterId: fighter, telegramUserId: 1000 }, cookie }));
    expect(forged.status).toBe(422);
    expect(await db.query("select 1 from public.arena_picks")).toHaveLength(0);
    const good = await call(route.POST, req("/api/arena/picks", { json: { battleId: s.upcoming.id, characterId: fighter }, cookie }));
    expect(good.status).toBe(200);
    const rows = await db.query<{ telegram_user_id: number; battle_id: string }>("select telegram_user_id, battle_id from public.arena_picks");
    expect(rows).toEqual([{ telegram_user_id: 7002, battle_id: s.upcoming.id }]); // the pick names the UPCOMING battle, never the one on stage
  });

  it("validates input: wrong types, malformed ids, wrong content type", async () => {
    const route = await import("@/app/api/arena/picks/route");
    const cookie = await loginAs(7003);
    for (const json of [{}, { battleId: "x", characterId: "y" }, { battleId: 5, characterId: 6 }, { battleId: crypto.randomUUID() }]) {
      expect((await call(route.POST, req("/api/arena/picks", { json, cookie }))).status, JSON.stringify(json)).toBe(422);
    }
    const form = new Request(`${ORIGIN}/api/arena/picks`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3700", cookie, "content-type": "application/x-www-form-urlencoded" }, body: "a=b" });
    expect((await call(route.POST, form)).status).toBe(415);
  });

  it("maps domain rejections to precise, stable codes", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 24);
    const s = await stateOf();
    const cookie = await loginAs(7004);
    const post = async (battleId: string, characterId: string) => {
      const res = await call(route.POST, req("/api/arena/picks", { json: { battleId, characterId }, cookie }));
      return { status: res.status, error: (await res.json()).error as string | undefined };
    };
    const outsider = (await db.query<{ id: string }>("select id from public.characters where id not in (select character_id from public.arena_participants where battle_id = $1) limit 1", [s.upcoming.id]))[0]!.id;
    expect(await post(crypto.randomUUID(), outsider)).toEqual({ status: 404, error: "NOT_FOUND" });
    expect(await post(s.upcoming.id, outsider)).toEqual({ status: 422, error: "NOT_A_FIGHTER" });
    // The battle ON STAGE is never a pick target …
    expect(await post(s.current.id, s.current.fighters[0].characterId)).toEqual({ status: 409, error: "LOCKED" });
    // … and neither is the battle BEHIND the upcoming one (not the next fight yet).
    const [behind] = await db.query<{ id: string; character_id: string }>("select b.id, p.character_id from public.arena_battles b join public.arena_participants p on p.battle_id = b.id where b.status = 'SIMULATED' and b.starts_at > $1::timestamptz order by b.sequence, p.character_id limit 1", [new Date(s.upcoming.startsAt).toISOString()]);
    expect(await post(behind!.id, behind!.character_id)).toEqual({ status: 409, error: "NOT_OPEN" });
    // The window closes when the battle on stage is DECIDED, on the SERVER clock: push its combat end into the past.
    await db.exec(`update public.arena_battles set combat_ends_at = now() - interval '1 second' where id = '${s.current.id}'`);
    expect(await post(s.upcoming.id, s.upcoming.fighters[0].characterId)).toEqual({ status: 409, error: "LOCKED" });
  });

  it("can be switched off by the arena.picks feature flag", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 16);
    const s = await stateOf();
    const cookie = await loginAs(7005);
    await db.exec("update public.feature_flags set enabled = false where key = 'arena.picks'");
    resetRuntimeCaches();
    const res = await call(route.POST, req("/api/arena/picks", { json: { battleId: s.current.id, characterId: s.current.fighters[0].characterId }, cookie }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("PICKS_DISABLED");
    expect((await stateOf()).picks.enabled).toBe(false);
  });

  it("is rate limited per member", async () => {
    const route = await import("@/app/api/arena/picks/route");
    const cookie = await loginAs(7006);
    const statuses: number[] = [];
    for (let i = 0; i < 34; i++) statuses.push((await call(route.POST, req("/api/arena/picks", { json: { battleId: crypto.randomUUID(), characterId: crypto.randomUUID() }, cookie }))).status);
    expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });
});

describe("GET /api/arena/picks", () => {
  it("returns only the signed-in member's own pick; anonymous callers see nothing", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 24);
    const s = await stateOf();
    const alice = await loginAs(7010);
    const bob = await loginAs(7011);
    await call(route.POST, req("/api/arena/picks", { json: { battleId: s.upcoming.id, characterId: s.upcoming.fighters[0].characterId }, cookie: alice }));
    const get = async (cookie?: string) => (await call(route.GET, req(`/api/arena/picks?battleId=${s.upcoming.id}`, { method: "GET", ...(cookie ? { cookie } : {}) }))).json();
    expect(await get()).toMatchObject({ signedIn: false, pick: null, round: { locked: false, distribution: null } });
    expect((await get(alice)).pick).toMatchObject({ characterId: s.upcoming.fighters[0].characterId, locked: false, result: null });
    expect(await get(bob)).toMatchObject({ signedIn: true, pick: null });
    expect((await call(route.GET, req("/api/arena/picks?battleId=nope", { method: "GET" }))).status).toBe(400);
  });
});

describe("public arena state", () => {
  it("shows the CURRENT eight with power and a sprite config, the UPCOMING eight with the server's pick window — but NO pick counts", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 24);
    const s = await stateOf();
    expect(s.current.fighters).toHaveLength(8);
    for (const f of s.current.fighters) {
      expect(typeof f.power).toBe("number");
      expect(f.appearance.sprite).toMatchObject({ v: 1 });
      expect(Object.keys(f.appearance.sprite.slots)).toEqual(expect.arrayContaining(["outfit", "weapon"]));
    }
    expect(s.upcoming.fighters).toHaveLength(8);
    for (const f of s.upcoming.fighters) {
      expect(typeof f.power).toBe("number");
      expect(f.appearance.sprite).toMatchObject({ v: 1 });
    }
    expect(s.upcoming.id).not.toBe(s.current.id);
    expect(s.upcoming.startsAt).toBe(s.current.slotEndsAt); // it is the very next fight
    expect(s.upcoming.picks).toMatchObject({ status: "OPEN", mode: "PREDECESSOR", lockReason: null, locksAt: s.current.combatEndsAt, lockedAt: null });
    expect(s.picks).toMatchObject({ enabled: true, reward: { symbol: "$CLANKRPG" } });
    expect(s.picks).not.toHaveProperty("counts");
    const cookie = await loginAs(7020);
    await call(route.POST, req("/api/arena/picks", { json: { battleId: s.upcoming.id, characterId: s.upcoming.fighters[2].characterId }, cookie }));
    resetRuntimeCaches();
    // Anti-herding: the shared payload never carries the crowd, before OR after a pick exists.
    const after = await stateOf();
    expect(JSON.stringify(after.picks)).not.toMatch(/counts|distribution/);
    expect(JSON.stringify(after.upcoming)).not.toMatch(/counts|distribution|"crowd"|picked/i);
  });

  it("publishes the upcoming roster but NOT the group behind it, and nothing about how the upcoming fight will go", async () => {
    await seedHeroes(db, 24);
    const s = await stateOf();
    expect(s.next).toMatchObject({ id: s.upcoming.id, startsAt: s.current.slotEndsAt });
    const behind = (await db.query<{ character_id: string }>("select p.character_id from public.arena_participants p where p.battle_id = (select id from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz order by sequence limit 1)", [new Date(s.upcoming.startsAt).toISOString()])).map((r) => r.character_id);
    expect(behind).toHaveLength(8);
    const wire = JSON.stringify(s);
    for (const id of behind) expect(wire).not.toContain(id);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(s.upcoming);
    for (const forbidden of ["ranking", "placement", "winnerId", "slot", "maxHp", "startPosition", "events", "seed", "results", "hasReplay"]) expect(keys.has(forbidden), forbidden).toBe(false);
  });
});

describe("two clients, one server: the lock is the server's", () => {
  it("both clients see the same current battle, the same upcoming battle and the same lock transition — and the late client is refused", async () => {
    const route = await import("@/app/api/arena/picks/route");
    await seedHeroes(db, 24);
    const a = await loginAs(7030);
    const b = await loginAs(7031);
    const s1 = await stateOf();
    const s2 = await stateOf();
    for (const s of [s1, s2]) {
      expect(s.current.id).toBe(s1.current.id);
      expect(s.upcoming.id).toBe(s1.upcoming.id);
      expect(s.upcoming.picks.status).toBe("OPEN");
    }
    const fighter = s1.upcoming.fighters[0].characterId as string;
    const post = (cookie: string, characterId = fighter) => call(route.POST, req("/api/arena/picks", { json: { battleId: s1.upcoming.id, characterId }, cookie }));
    expect((await post(a)).status).toBe(200); // client A picks while the fight on stage is undecided

    // The fight on stage is decided (server clock): everybody's next snapshot says LOCKED — the same upcoming battle, the same reason.
    await db.exec(`update public.arena_battles set combat_ends_at = now() - interval '100 milliseconds' where id = '${s1.current.id}'`);
    resetRuntimeCaches();
    const locked1 = await stateOf();
    const locked2 = await stateOf();
    for (const s of [locked1, locked2]) {
      expect(s.upcoming.id).toBe(s1.upcoming.id);
      expect(s.upcoming.picks.status).toBe("LOCKED");
      expect(s.upcoming.picks.lockReason).toBe("PREDECESSOR_DECIDED");
    }
    // Client B, who has just observed the decision, cannot submit — and neither can a client that still shows OPEN (server state wins).
    expect((await post(b)).status).toBe(409);
    expect((await post(a, s1.upcoming.fighters[1].characterId)).status).toBe(409); // a CHANGE is refused too
    const picks = await db.query<{ telegram_user_id: number; character_id: string; battle_id: string }>("select telegram_user_id, character_id, battle_id from public.arena_picks");
    expect(picks).toEqual([{ telegram_user_id: 7030, character_id: fighter, battle_id: s1.upcoming.id }]);
    // Client A's pick is still theirs, now locked — and B has none.
    const get = async (cookie: string) => (await call(route.GET, req(`/api/arena/picks?battleId=${s1.upcoming.id}`, { method: "GET", cookie }))).json();
    expect((await get(a)).pick).toMatchObject({ characterId: fighter, locked: true });
    expect((await get(a)).round.locked).toBe(true);
    expect((await get(b)).pick).toBeNull();
  });
});

describe("admin configuration for picks and visuals", () => {
  const adminRoute = () => import("@/app/api/admin/[...path]/route");
  type Ctxed = (r: Request, c: unknown) => Promise<Response>;
  const run = (fn: unknown, r: Request, ...path: string[]) => (fn as Ctxed)(r, { params: Promise.resolve({ path }) });
  async function adminCookie() {
    const route = await adminRoute();
    const res = await run(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), "session");
    return (res.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
  }

  it("picks/visuals appear in the admin config, validate strictly, and cannot be edited by a normal player", async () => {
    const route = await adminRoute();
    const cookie = await adminCookie();
    const cfg = await (await run(route.GET, req("/api/admin/config", { method: "GET", cookie }), "config")).json();
    expect(cfg.settings.picks).toEqual({ rewardGold: 2 });
    expect(cfg.settings.visuals.spriteSet).toBe("clank-v3"); // hero renderer v3 (procedural) is the default of a fresh database
    const put = (key: string, value: unknown, c = cookie) => run(route.PUT, req(`/api/admin/settings/${key}`, { method: "PUT", json: { value }, cookie: c }), "settings", key);
    expect((await put("picks", { rewardGold: 99999 })).status).toBe(422);
    expect((await put("picks", { rewardGold: 4 })).status).toBe(200);
    expect((await put("visuals", { spriteSet: "clank-dev-v1", disabledCosmetics: ["aura.flame"] })).status).toBe(200);
    expect((await put("picks", { rewardGold: 4 }, await loginAs(7090))).status).toBe(401); // a player session is not an admin session
  });

  it("the Picks flag is togglable by an admin", async () => {
    const route = await adminRoute();
    const cookie = await adminCookie();
    const flag = (key: string, enabled: boolean) => run(route.PUT, req(`/api/admin/flags/${key}`, { method: "PUT", json: { enabled }, cookie }), "flags", key);
    expect((await flag("arena.picks", false)).status).toBe(200);
    expect((await flag("arena.picks", true)).status).toBe(200);
  });
});
