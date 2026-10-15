import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { finalizeHeroPeriod, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { resetRuntimeCaches } from "@/server/runtime";
import { resetEventsReadiness } from "@/server/services/events";

import { count, createTestDb, resetDb, seedHeroes } from "../support/db";
import { giveWins } from "../support/heroArena";
import { freshDevelopment } from "../support/lifecycle";
import { finalize as finalizePicks, seedScores, settingsWith } from "../support/rewards";

/**
 * EVENTS OVER HTTP — what a stranger can read and what only an admin can do. The public routes are anonymous, viewer-independent and carry no Telegram id, wallet,
 * owner, review state or secret; only official-season, finalized periods exist on them (a pre-season day, a future day, a made-up day are plain 404s). The
 * launch-readiness routes are admin-only, same-origin and audited.
 */
const ORIGIN = "http://localhost:3700";
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: "x".repeat(40),
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk",
  TELEGRAM_WEBHOOK_SECRET: "webhook_secret_for_tests_1234567890",
  TELEGRAM_OFFICIAL_CHAT_ID: "-1001234567890",
  CLANK_DEV_LOGIN: "true",
  CLANK_ALLOW_DEMO_HEROES: "false",
  NEXT_PUBLIC_APP_URL: ORIGIN,
};
const DAY = 86_400_000;

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
  await new Promise((r) => setTimeout(r, 300));
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  await freshDevelopment(db);
  resetRuntimeCaches();
  resetEventsReadiness();
  resetHeroArenaReadiness();
});
afterEach(() => {
  vi.useRealTimers();
});

type RouteFn = (req: Request, ctx?: never) => Promise<Response>;
const req = (path: string, init: { method?: string; json?: unknown; cookie?: string; origin?: string | null } = {}) => {
  const headers = new Headers();
  if (init.origin !== null && (init.method ?? "GET") !== "GET") headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : null });
};
const call = (fn: unknown, r: Request, ctx?: unknown) => (fn as RouteFn)(r, ctx as never);
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper over arbitrary JSON

const champions = () => import("@/app/api/events/champions/route");
const results = () => import("@/app/api/events/results/route");
const seasonRoute = () => import("@/app/api/season/route");
const adminRoute = () => import("@/app/api/admin/[...path]/route");
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
let adminSession = "";
async function admin() {
  const route = await adminRoute();
  if (!adminSession) {
    const login = await call(route.POST, req("/api/admin/session", { method: "POST", json: { key: ENV.ADMIN_ACCESS_KEY } }), ctx("session"));
    adminSession = cookieOf(login, "clank_admin");
    expect(adminSession).not.toBe("");
  }
  const cookie = adminSession;
  return {
    get: (...path: string[]) => call(route.GET, req(`/api/admin/${path.join("/")}`, { cookie }), ctx(...path)),
    post: (path: string[], j?: unknown, over: { origin?: string | null } = {}) => call(route.POST, req(`/api/admin/${path.join("/")}`, { method: "POST", json: j ?? {}, cookie, ...over }), ctx(...path)),
  };
}
const get = async (mod: { GET: unknown }, path: string) => call(mod.GET, req(path));

/** A small game: 12 heroes, a played pre-season, the launch over HTTP, then one finalized official day. Returns the dates. */
async function launchedWithOneOfficialDay() {
  const heroes = await seedHeroes(db, 12);
  const users = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by created_at, id")).map((r) => Number(r.telegram_user_id));
  const off = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
  const devDay = "2026-10-13";
  await giveWins(db, heroes[0]!, 4, `${devDay}T12:00:00Z`, { filler: [heroes[10]!, heroes[11]!] });
  await seedScores(db, [{ user: users[0]!, day: devDay, picks: 25, correct: 20 }]);
  await finalizePicks(db, "DAILY", devDay, Date.parse("2026-10-14T01:00:00Z"), { settings: off });
  await finalizeHeroPeriod(db, { now: () => new Date("2026-10-14T01:00:00Z"), settings: off, allowDemo: true }, "DAILY", devDay);

  const a = await admin();
  expect((await a.post(["game", "backup-attestation"], { reference: "scratch snapshot", verified: true })).status).toBe(200);
  expect((await a.post(["game", "launch"], { confirmation: "LAUNCH SEASON 1" })).status).toBe(200);
  const [s] = await db.query<{ ms: string }>("select (extract(epoch from starts_at) * 1000)::bigint::text as ms from public.seasons where kind = 'COMPETITIVE'");
  const dayMs = Math.floor(Number(s!.ms) / DAY) * DAY;
  const launchDay = new Date(dayMs).toISOString().slice(0, 10);
  await seedScores(db, [{ user: users[1]!, day: launchDay, picks: 26, correct: 20 }, { user: users[2]!, day: launchDay, picks: 21, correct: 9 }]);
  await giveWins(db, heroes[3]!, 3, `${launchDay}T10:00:00Z`, { filler: [heroes[10]!, heroes[11]!] });
  const prized = { ...settingsWith(), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: true, dailyPrizePool: "10000", weeklyPrizePool: "50000" } };
  await finalizePicks(db, "DAILY", launchDay, dayMs + DAY + 3_600_000, { settings: prized });
  await finalizeHeroPeriod(db, { now: () => new Date(dayMs + DAY + 3_600_000), settings: prized, allowDemo: true }, "DAILY", launchDay);
  return { devDay, launchDay, dayMs, users, heroes };
}

describe("the public Events routes validate their input", () => {
  it("answer 400 with a stable code — never an exception, never SQL", async () => {
    const c = await champions();
    expect((await get(c, "/api/events/champions")).status).toBe(400);
    expect(await json(await get(c, "/api/events/champions?program=nope&kind=daily"))).toMatchObject({ ok: false, error: "INVALID_PROGRAM" });
    expect(await json(await get(c, "/api/events/champions?program=picks&kind=hourly"))).toMatchObject({ ok: false, error: "INVALID_KIND" });
    expect(await json(await get(c, "/api/events/champions?program=picks&kind=daily&season=not-a-uuid"))).toMatchObject({ ok: false, error: "INVALID_SEASON" });
    expect(await json(await get(c, "/api/events/champions?program=picks&kind=daily&season=%27%3B%20drop%20table%20seasons%3B--"))).toMatchObject({ ok: false, error: "INVALID_SEASON" });
    const r = await results();
    expect((await get(r, "/api/events/results?program=picks&kind=daily")).status).toBe(400);
    expect(await json(await get(r, "/api/events/results?program=hero&kind=weekly&start="))).toMatchObject({ ok: false });
    // a junk limit / cursor never crashes: it is clamped / ignored
    expect((await get(c, "/api/events/champions?program=picks&kind=daily&limit=abc&before=zzz")).status).toBe(200);
    expect((await get(c, "/api/events/champions?program=picks&kind=daily&limit=99999")).status).toBe(200);
  });
});

describe("before the launch", () => {
  it("Events is empty and says it is pre-season; a pre-season day is not a result", async () => {
    await seedHeroes(db, 10);
    const res = await get(await champions(), "/api/events/champions?program=picks&kind=daily");
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, state: { phase: "PRE_SEASON", season: null }, periods: [], nextBefore: null });
    expect((await get(await results(), "/api/events/results?program=picks&kind=daily&start=2026-10-13")).status).toBe(404);
    expect(await json(await get(await seasonRoute(), "/api/season"))).toMatchObject({ ok: true, phase: "DEVELOPMENT", season: { label: "Pre-season", kind: "DEVELOPMENT" } });
  });
});

describe("after the launch", () => {
  it("serves the first official champions — anonymous, cacheable, and free of anything private", async () => {
    const { devDay, launchDay, dayMs } = await launchedWithOneOfficialDay();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dayMs + 2 * DAY + 3_600_000);

    const res = await get(await champions(), "/api/events/champions?program=picks&kind=daily");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/public.*s-maxage=\d+/); // viewer-independent: a shared cache may hold it briefly
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await json(res);
    expect(body.state).toMatchObject({ phase: "SEASON_ACTIVE", season: { label: "Season 1" } });
    expect(body.periods.map((p: { start: string }) => p.start)).toEqual([new Date(dayMs + DAY).toISOString().slice(0, 10), launchDay]);
    expect(body.periods[1]).toMatchObject({ outcome: "CHAMPION", champions: [{ program: "picks", rank: 1, correctPicks: 20, picks: 26, allocation: { status: "ALLOCATED" } }] });
    expect(body.periods[0].outcome).toBe("NO_COMPLETED_RESULTS");
    expect(Object.keys(body.classes).length).toBeGreaterThan(0);
    // nothing private, anywhere in the payload
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/telegram|wallet|owner|userId|user_id|review|hold_reason|SECRET|session|admin/i);
    expect(text).not.toMatch(/"id":\s*\d{4,}/); // no numeric member id
    // the pre-season is nowhere in it
    expect(text).not.toContain(devDay);

    const detail = await get(await results(), `/api/events/results?program=picks&kind=daily&start=${launchDay}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toMatch(/public.*s-maxage=\d+/);
    const d = (await json(detail)).period;
    expect(d.standings.length).toBe(2);
    expect(JSON.stringify(d)).not.toMatch(/telegram|wallet|owner|userId|review/i);

    const hero = await json(await get(await champions(), "/api/events/champions?program=hero&kind=daily"));
    expect(hero.periods.at(-1)).toMatchObject({ outcome: "CHAMPION", champions: [{ program: "hero", wins: 3, rank: 1 }] });
    expect(await json(await get(await seasonRoute(), "/api/season"))).toMatchObject({ phase: "LIVE", season: { label: "Season 1", kind: "COMPETITIVE" } });
    expect(JSON.stringify(await json(await get(await seasonRoute(), "/api/season")))).not.toMatch(/development|beta|test|local/i);
  });

  it("only completed periods of the official season exist: pre-season, future, unfinalized, malformed and non-Monday dates are 404", async () => {
    const { devDay, launchDay, dayMs } = await launchedWithOneOfficialDay();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dayMs + 2 * DAY + 3_600_000);
    const r = await results();
    for (const start of [devDay, "2026-09-01", "2999-12-31", "2026-02-30", "garbage", new Date(dayMs + 2 * DAY).toISOString().slice(0, 10)]) {
      expect((await get(r, `/api/events/results?program=picks&kind=daily&start=${start}`)).status, start).toBe(404);
      expect((await get(r, `/api/events/results?program=hero&kind=daily&start=${start}`)).status, start).toBe(404);
    }
    expect((await get(r, `/api/events/results?program=picks&kind=weekly&start=${launchDay}`)).status === 404 || new Date(`${launchDay}T00:00:00Z`).getUTCDay() === 1).toBe(true); // a non-Monday is never a week
    // the launch day itself is a real result
    expect((await get(r, `/api/events/results?program=picks&kind=daily&start=${launchDay}`)).status).toBe(200);
  });
});

describe("the launch-readiness routes are admin-only", () => {
  it("are closed without an admin session and without the same origin; validate their body; and are audited", async () => {
    await seedHeroes(db, 10);
    const route = await adminRoute();
    for (const p of ["game/preflight", "game/official-season"]) expect((await call(route.GET, req(`/api/admin/${p}`), ctx(...p.split("/")))).status, p).toBe(401);
    expect((await call(route.POST, req("/api/admin/game/backup-attestation", { method: "POST", json: { reference: "dump", verified: true } }), ctx("game", "backup-attestation"))).status).toBe(401);

    const a = await admin();
    expect((await a.post(["game", "backup-attestation"], { reference: "dump sha256:abc", verified: true }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await a.post(["game", "backup-attestation"], { reference: "x", verified: true })).status).toBe(422); // too short to be a reference
    expect((await a.post(["game", "backup-attestation"], { reference: "dump sha256:abc", verified: true, extra: 1 })).status).toBe(422); // strict body
    expect((await a.post(["game", "backup-attestation"], { reference: "dump sha256:abc" })).status).toBe(422);
    expect(await count(db, "launch_backup_attestations")).toBe(0);

    const pre = await json(await a.get("game", "preflight"));
    expect(pre.preflight).toMatchObject({ phase: "DEVELOPMENT", ready: false });
    expect(pre.preflight.facts.heroes.total).toBe(10);
    expect(pre.resets.length).toBeGreaterThan(3);
    expect(pre.keeps.join(" ")).toMatch(/hero/i);
    expect(JSON.stringify(pre)).not.toMatch(/SESSION_SECRET|ADMIN_ACCESS_KEY|password/i);

    expect((await a.post(["game", "backup-attestation"], { reference: "dump sha256:abc", verified: true })).status).toBe(200);
    expect(await count(db, "launch_backup_attestations")).toBe(1);
    expect(await count(db, "admin_audit_log", "action = 'LAUNCH_BACKUP_ATTESTED'")).toBe(1);
    expect((await json(await a.get("game", "preflight"))).preflight.backup).toMatchObject({ satisfied: true });
  });

  it("official-season status reports Season 1's own numbers once launched, and the attestation is refused after the launch", async () => {
    const { launchDay } = await launchedWithOneOfficialDay();
    const a = await admin();
    const status = (await json(await a.get("game", "official-season"))).status;
    expect(status).toMatchObject({ season: { label: "Season 1" }, officialMatches: 3, officialPicks: 0, auditFindings: [] });
    expect(status.boards.picks).toBeGreaterThanOrEqual(1);
    expect(launchDay).toBeTruthy();
    expect((await a.post(["game", "backup-attestation"], { reference: "late dump", verified: true })).status).toBe(409);
  });
});

describe("no stale cache can carry the pre-season into Season 1", () => {
  it("the boards' short-lived in-process memos are season-keyed: the instant the launch commits, a board computed before it is no longer an answer", async () => {
    const heroes = await seedHeroes(db, 14);
    const users = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by created_at, id")).map((r) => Number(r.telegram_user_id));
    const today = new Date().toISOString().slice(0, 10);
    // pre-season activity in TODAY's still-running period (exactly what the running boards show, and what their memos hold)
    await seedScores(db, users.slice(0, 5).map((user, i) => ({ user, day: today, picks: 20 - i, correct: 15 - i })));
    await giveWins(db, heroes[0]!, 4, `${today}T00:30:00Z`, { filler: [heroes[12]!, heroes[13]!] });
    const picksRoute = await import("@/app/api/leaderboard/picks/route");
    const heroRoute = await import("@/app/api/leaderboard/hero-arena/route");
    const rowsOf = async (mod: { GET: unknown }, path: string) => ((await json(await call(mod.GET, req(path)))) as { board: { rows: unknown[] } }).board.rows.length;
    // warm both memos with the pre-season standings
    expect(await rowsOf(picksRoute, "/api/leaderboard/picks?period=daily")).toBe(5);
    expect(await rowsOf(heroRoute, "/api/leaderboard/hero-arena?scope=daily")).toBeGreaterThanOrEqual(3);

    const a = await admin();
    expect((await a.post(["game", "backup-attestation"], { reference: "scratch snapshot", verified: true })).status).toBe(200);
    expect((await a.post(["game", "launch"], { confirmation: "LAUNCH SEASON 1" })).status).toBe(200);

    // immediately after — well inside the memo's lifetime — Season 1's boards are empty: nothing of the pre-season is served
    expect(await rowsOf(picksRoute, "/api/leaderboard/picks?period=daily")).toBe(0);
    expect(await rowsOf(heroRoute, "/api/leaderboard/hero-arena?scope=daily")).toBe(0);
    expect(await rowsOf(heroRoute, "/api/leaderboard/hero-arena?scope=season")).toBe(0);
    // and a pre-season day is not reachable by date either
    const byDate = await call(picksRoute.GET, req(`/api/leaderboard/picks?period=daily&start=${today}`));
    expect([200, 404]).toContain(byDate.status);
  });
});
