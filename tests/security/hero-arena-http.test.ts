import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { finalizeHeroPeriod } from "@/server/rewards/heroArena";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, resetDb } from "../support/db";
import { giveWins, seedHeroOwners } from "../support/heroArena";
import { freshDevelopment } from "../support/lifecycle";
import { utc } from "../support/rewards";

/**
 * THE HALL OF CHAMPIONS OVER HTTP: public, read-only, validated, leak-free — and Admin: authenticated, same-origin, audited, with the two programs' pools independent.
 */
const ORIGIN = "http://localhost:3700";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  CLANK_ALLOW_DEMO_HEROES: "false",
  NEXT_PUBLIC_APP_URL: ORIGIN,
};
const OWNER_A = 987_654_321; // a distinctive Telegram id: it must never appear in any public payload
const OWNER_B = 987_654_322;

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
  const g = globalThis as unknown as { __clankDb: { promise: Promise<Db> }; __clankSeeded: Promise<void> };
  g.__clankDb = { promise: Promise.resolve(db) };
  g.__clankSeeded = Promise.resolve();
});
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 200));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await db.close();
});

let cast: { A: string; B: string; F: [string, string] };
beforeEach(async () => {
  await resetDb(db);
  await freshDevelopment(db);
  resetRuntimeCaches();
  const heroes = await seedHeroOwners(db, [{ user: OWNER_A, name: "Hero A", claimed: true }, { user: OWNER_B, name: "Hero B" }, { user: 880_001, name: "Filler One" }, { user: 880_002, name: "Filler Two" }]);
  cast = { A: heroes.get(OWNER_A)!, B: heroes.get(OWNER_B)!, F: [heroes.get(880_001)!, heroes.get(880_002)!] };
  const today = utc(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, new Date().getUTCDate(), 0, 0, 5);
  await giveWins(db, cast.A, 3, new Date(today).toISOString(), { filler: cast.F });
  await giveWins(db, cast.B, 2, new Date(today + 3_600_000 > Date.now() ? today + 30_000 : today + 3_600_000).toISOString(), { filler: cast.F });
});

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx as never);
const get = (path: string, cookie?: string) => new Request(`${ORIGIN}${path}`, { headers: { host: "localhost:3700", ...(cookie ? { cookie } : {}) } });

describe("public routes", () => {
  it("GET /api/leaderboard/hero-arena: daily (default), weekly and season answer 200 with the right shape; Season carries no prize rules", async () => {
    const { GET } = await import("@/app/api/leaderboard/hero-arena/route");
    for (const [path, scope, rewarded] of [["", "DAILY", true], ["?scope=weekly", "WEEKLY", true], ["?scope=season", "SEASON", false]] as const) {
      const res = await call(GET, get(`/api/leaderboard/hero-arena${path}`));
      const body = (await res.json()) as { ok: boolean; board: { scope: string; rewarded: boolean; rules: unknown; rows: Array<{ name: string; wins: number }> }; seasons: unknown[] };
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body.board).toMatchObject({ scope, rewarded });
      expect(body.board.rows.find((r) => r.name === "Hero A")!.wins).toBeGreaterThan(0);
      expect(body.board.rules === null).toBe(!rewarded);
      expect(Array.isArray(body.seasons)).toBe(true);
    }
  });

  it("rejects an invalid scope / metric / period with a 400 and a message; an invalid or future start simply shows the running period", async () => {
    const hero = await import("@/app/api/leaderboard/hero-arena/route");
    const records = await import("@/app/api/leaderboard/records/route");
    const picks = await import("@/app/api/leaderboard/picks/route");
    expect((await call(hero.GET, get("/api/leaderboard/hero-arena?scope=yearly"))).status).toBe(400);
    expect((await call(records.GET, get("/api/leaderboard/records?metric=wins"))).status).toBe(400); // Wins live on Hero Arena, not in Records
    expect((await call(records.GET, get("/api/leaderboard/records?metric=top2&scope=hourly"))).status).toBe(400);
    expect((await call(picks.GET, get("/api/leaderboard/picks?period=yearly"))).status).toBe(400);
    const odd = await call(hero.GET, get("/api/leaderboard/hero-arena?scope=daily&start=2999-01-01"));
    expect(odd.status).toBe(200);
    expect(((await odd.json()) as { board: { state: string } }).board.state).toBe("CURRENT");
  });

  it("GET /api/leaderboard/records: Top-2, KOs and PWR — never rules, never prizes", async () => {
    const { GET } = await import("@/app/api/leaderboard/records/route");
    for (const q of ["metric=top2&scope=daily", "metric=top2", "metric=kos&scope=weekly", "metric=kos&scope=season", "metric=pwr"]) {
      const res = await call(GET, get(`/api/leaderboard/records?${q}`));
      const body = (await res.json()) as { board: { rewarded: boolean; rules: unknown; rows: Array<{ prize: string; prizeStatus: string }> } };
      expect(res.status, q).toBe(200);
      expect(body.board.rewarded, q).toBe(false);
      expect(body.board.rules, q).toBeNull();
      expect(body.board.rows.every((r) => r.prize === "0" && r.prizeStatus === "NONE"), q).toBe(true);
    }
  });

  it("GET /api/leaderboard/picks?period=season: cumulative standings, standings only", async () => {
    const { GET } = await import("@/app/api/leaderboard/picks/route");
    const res = await call(GET, get("/api/leaderboard/picks?period=season"));
    const body = (await res.json()) as { rewarded: boolean; season: { kind: string } | null; rows: unknown[]; seasons: unknown[] };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ rewarded: false });
    expect(body.season?.kind).toBe("DEVELOPMENT");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("the Daily / Weekly Picks payload now names the season (so the page can say DEVELOPMENT / BETA)", async () => {
    const { GET } = await import("@/app/api/leaderboard/picks/route");
    const body = (await (await call(GET, get("/api/leaderboard/picks?period=daily"))).json()) as { season: { label: string; kind: string } | null };
    expect(body.season).toMatchObject({ kind: "DEVELOPMENT", label: "Development" });
  });

  it("NO identity leaks: no Telegram id, owner, wallet, internal id column or SQL in any Hall of Champions payload — even for a finalized board with credited prizes", async () => {
    const settings = { ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000" } };
    const day = new Date().toISOString().slice(0, 10);
    // freeze today's board "in the future" so a credited prize and a reserved one both exist
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    await finalizeHeroPeriod(db, { now: () => new Date(dayMs + 2 * 86_400_000), settings }, "DAILY", day);
    const hero = await import("@/app/api/leaderboard/hero-arena/route");
    const records = await import("@/app/api/leaderboard/records/route");
    const picks = await import("@/app/api/leaderboard/picks/route");
    const bodies = [
      await (await call(hero.GET, get(`/api/leaderboard/hero-arena?scope=daily&start=${day}`))).text(),
      await (await call(hero.GET, get("/api/leaderboard/hero-arena?scope=weekly"))).text(),
      await (await call(hero.GET, get("/api/leaderboard/hero-arena?scope=season"))).text(),
      await (await call(records.GET, get("/api/leaderboard/records?metric=kos"))).text(),
      await (await call(picks.GET, get("/api/leaderboard/picks?period=season"))).text(),
    ];
    for (const b of bodies) {
      expect(b).not.toMatch(new RegExp(`${OWNER_A}|${OWNER_B}|880001|880002`)); // the Telegram ids of the owners
      expect(b).not.toMatch(/owner|telegram|wallet|0x[0-9a-f]{40}|select\s|public\.|stack/i);
    }
    const final = JSON.parse(bodies[0]!) as { board: { state: string; rows: Array<{ name: string; prizeStatus: string }> } };
    expect(final.board.state).toBe("FINAL");
    expect(final.board.rows.find((r) => r.name === "Hero A")!.prizeStatus).toBe("CREDITED");
    expect(final.board.rows.find((r) => r.name === "Hero B")!.prizeStatus).toBe("RESERVED"); // B is not claimed
  });

  it("a prize HELD for review reads as awarded publicly — the review state is private, exactly like Arena Picks", async () => {
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values ($1, 'REVIEW', 'x') on conflict (telegram_user_id) do update set review_state = 'REVIEW'", [OWNER_A]);
    const settings = { ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000" } };
    const day = new Date().toISOString().slice(0, 10);
    await finalizeHeroPeriod(db, { now: () => new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000), settings }, "DAILY", day);
    expect((await db.query<{ prize_status: string }>("select prize_status from public.hero_arena_results where character_id = $1 and kind = 'DAILY'", [cast.A]))[0]!.prize_status).toBe("HELD");
    const { GET } = await import("@/app/api/leaderboard/hero-arena/route");
    const body = (await (await call(GET, get(`/api/leaderboard/hero-arena?scope=daily&start=${day}`))).json()) as { board: { rows: Array<{ name: string; prizeStatus: string; prize: string }> } };
    expect(body.board.rows.find((r) => r.name === "Hero A")).toMatchObject({ prizeStatus: "CREDITED" });
    expect(JSON.stringify(body)).not.toMatch(/HELD|REVIEW|review/);
  });
});

describe("Admin: reward programs", () => {
  const adminRoute = () => import("@/app/api/admin/[...path]/route");
  const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
  let cookie = "";
  async function admin() {
    const route = await adminRoute();
    if (!cookie) {
      const login = await call(route.POST, new Request(`${ORIGIN}/api/admin/session`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3700", "content-type": "application/json" }, body: JSON.stringify({ key: ENV.ADMIN_ACCESS_KEY }) }), ctx("session"));
      cookie = (login.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
      expect(cookie).not.toBe("");
    }
    const send = (method: string, path: string[], json?: unknown, over: { origin?: string | null; cookie?: string | null } = {}) => {
      const headers = new Headers({ host: "localhost:3700" });
      if (over.origin !== null && method !== "GET") headers.set("origin", over.origin ?? ORIGIN);
      if (over.cookie !== null) headers.set("cookie", over.cookie ?? cookie);
      if (json !== undefined) headers.set("content-type", "application/json");
      return call(method === "GET" ? route.GET : method === "PUT" ? route.PUT : route.POST, new Request(`${ORIGIN}/api/admin/${path.join("/")}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : null }), ctx(...path));
    };
    return { get: (...p: string[]) => send("GET", p), put: (p: string[], j: unknown) => send("PUT", p, j), post: (p: string[], j: unknown, o?: { origin?: string | null; cookie?: string | null }) => send("POST", p, j, o), send };
  }

  it("the overview needs an admin session", async () => {
    const a = await admin();
    expect((await a.send("GET", ["hero-arena", "overview"], undefined, { cookie: null })).status).toBe(401);
  });

  it("shows BOTH programs side by side: Arena Picks 100,000 / 500,000 and Hero Arena 'REWARD POOL NOT SET' — nothing copied from one to the other", async () => {
    const a = await admin();
    const res = await a.get("hero-arena", "overview");
    const { overview } = (await res.json()) as { overview: { programs: Array<{ id: string; dailyPool: string | null; weeklyPool: string | null; notSet: string[]; ladderBps: number[]; setting: string }>; notices: string[] } };
    expect(res.status).toBe(200);
    const picks = overview.programs.find((p) => p.id === "ARENA_PICKS")!;
    const hero = overview.programs.find((p) => p.id === "HERO_ARENA")!;
    expect(picks).toMatchObject({ dailyPool: "100,000", weeklyPool: "500,000", setting: "arena_picks" });
    expect(hero).toMatchObject({ dailyPool: null, weeklyPool: null, notSet: ["daily", "weekly"], setting: "hero_arena" });
    expect(hero.ladderBps).toEqual(picks.ladderBps); // the same default SHAPE, but it is Hero Arena's own setting
    expect(overview.notices.join(" ")).toMatch(/Daily and Weekly reward pool is NOT SET/);
  });

  it("setting a Hero Arena pool goes through the audited settings editor, moves only Hero Arena, and a bad value is refused", async () => {
    const a = await admin();
    const bad = await a.put(["settings", "hero_arena"], { value: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "-1" } });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const ok = await a.put(["settings", "hero_arena"], { value: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "50000", weeklyPrizePool: "250000" } });
    expect(ok.status).toBe(200);
    expect(await db.query("select action, entity_id from public.admin_audit_log where action = 'settings.put' and entity_id = 'hero_arena'")).toEqual([{ action: "settings.put", entity_id: "hero_arena" }]);
    const { overview } = (await (await a.get("hero-arena", "overview")).json()) as { overview: { programs: Array<{ id: string; dailyPool: string | null; weeklyPool: string | null; notSet: string[] }> } };
    expect(overview.programs.find((p) => p.id === "HERO_ARENA")).toMatchObject({ dailyPool: "50,000", weeklyPool: "250,000", notSet: [] });
    expect(overview.programs.find((p) => p.id === "ARENA_PICKS")).toMatchObject({ dailyPool: "100,000", weeklyPool: "500,000" }); // untouched
  });

  it("releasing a HELD prize: same-origin only, a reason is required, it is audited under its own source, and it credits the OWNER once", async () => {
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values ($1, 'REVIEW', 'x') on conflict (telegram_user_id) do update set review_state = 'REVIEW'", [OWNER_A]);
    const settings = { ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000" } };
    const day = new Date().toISOString().slice(0, 10);
    await finalizeHeroPeriod(db, { now: () => new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86_400_000), settings }, "DAILY", day);
    const a = await admin();
    const path = ["hero-arena", "boards", "DAILY", day, "prizes", cast.A, "resolve"];
    expect((await a.post(path, { action: "release", reason: "reviewed" }, { origin: null })).status).toBe(403); // CSRF: a cross-site / origin-less POST
    expect((await a.post(path, { action: "release", reason: "no" })).status).toBe(422); // the reason is mandatory
    expect((await a.post(["hero-arena", "boards", "DAILY", "not-a-date", "prizes", cast.A, "resolve"], { action: "release", reason: "reviewed" })).status).toBe(404);
    const ok = await a.post(path, { action: "release", reason: "reviewed, account is fine" });
    expect(ok.status).toBe(200);
    expect(await db.query("select telegram_user_id, reward_source from public.arena_reward_ledger where hero_character_id = $1", [cast.A])).toEqual([{ telegram_user_id: OWNER_A, reward_source: "HERO_ARENA_DAILY" }]);
    expect((await a.post(path, { action: "release", reason: "again please" })).status).toBe(409); // nothing left to release
    const audit = await db.query<{ action: string; entity_id: string }>("select action, entity_id from public.admin_audit_log where action like 'rewards.hero_arena_prize_%'");
    expect(audit).toEqual([{ action: "rewards.hero_arena_prize_release", entity_id: `DAILY:${day}:${cast.A}` }, { action: "rewards.hero_arena_prize_release", entity_id: `DAILY:${day}:${cast.A}` }]); // both attempts are on the record
  });
});
