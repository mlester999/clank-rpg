import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ArenaScreen } from "@/components/arena/ArenaScreen";
import { cardKey, heroSocialMeta } from "@/domain/hero/card";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";
import { advanceArena } from "@/server/services/arena";
import { getPublicHeroCard } from "@/server/services/publicHeroes";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

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
  CLANK_ALLOW_DEMO_HEROES: "true",
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

type RouteFn = (req: Request, ctx?: unknown) => Promise<Response>;
const req = (path: string, init: { method?: string; origin?: string | null; json?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
  const headers = new Headers(init.headers);
  if (init.origin !== null && (init.method ?? "GET") !== "GET") headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : null });
};
const adminRoute = () => import("@/app/api/admin/[...path]/route");
const callAdmin = async (method: "GET" | "POST", path: string, init: { json?: unknown; cookie?: string | null; origin?: string | null } = {}) => {
  const route = await adminRoute();
  const cookie = init.cookie === null ? undefined : (init.cookie ?? (await adminCookie()));
  const r = req(path, { method, ...(init.json !== undefined ? { json: init.json } : {}), ...(cookie ? { cookie } : {}), ...(init.origin !== undefined ? { origin: init.origin } : {}) });
  return (route[method] as RouteFn)(r, { params: Promise.resolve({ path: path.replace(/^\/api\/admin\//, "").split("?")[0]!.split("/") }) });
};
let cachedAdminCookie: string | null = null;
async function adminCookie() {
  if (cachedAdminCookie) return cachedAdminCookie;
  const route = await adminRoute();
  const res = await (route.POST as RouteFn)(req("/api/admin/session", { method: "POST", json: { key: ENV.ADMIN_ACCESS_KEY } }), { params: Promise.resolve({ path: ["session"] }) });
  cachedAdminCookie = (res.headers.getSetCookie().find((c) => c.startsWith("clank_admin=")) ?? "").split(";")[0] ?? "";
  expect(cachedAdminCookie).toContain("clank_admin=");
  return cachedAdminCookie;
}
const body = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- wide JSON bodies, asserted field by field
const pubIdOf = async (id: string) => (await db.query<{ public_id: string }>("select public_id from public.characters where id = $1", [id]))[0]!.public_id;
const uuid = () => crypto.randomUUID();
const publicCtx = async () => ({ allowDemo: true, classes: await loadClasses(db, false), settings: await loadSettings(db) });

describe("admin hero version routes are admin-only, same-origin and strict", () => {
  it("every route is closed without an admin session — and for a signed-in PLAYER", async () => {
    const [id] = await seedHeroes(db, 1);
    const v = uuid();
    const calls: Array<[("GET" | "POST"), string, unknown?]> = [
      ["GET", `/api/admin/heroes/${id}/versions`], ["GET", `/api/admin/heroes/${id}/versions/${v}/card`], ["GET", `/api/admin/heroes/${id}/card-image`],
      ["POST", `/api/admin/heroes/${id}/reroll/preview`, {}], ["POST", `/api/admin/heroes/${id}/reroll/apply`, { previewId: v }],
      ["POST", `/api/admin/heroes/${id}/rollback`, { versionId: v, expectedCurrentVersionId: v, requestId: v }],
    ];
    for (const [m, path, json] of calls) expect((await callAdmin(m, path, { cookie: null, ...(json !== undefined ? { json } : {}) })).status, `${m} ${path}`).toBe(401);
    // a signed-in player's session is not an admin session
    const login = await import("@/app/api/auth/telegram/route");
    const payload = signTelegramLoginPayload({ id: 5001, first_name: "Ada", auth_date: Math.floor(Date.now() / 1000) - 1 }, BOT_TOKEN);
    const lr = await (login.POST as RouteFn)(req("/api/auth/telegram", { method: "POST", json: payload }));
    const player = (lr.headers.getSetCookie().find((c) => c.startsWith("clank_session=")) ?? "").split(";")[0] ?? "";
    for (const [m, path, json] of calls) expect((await callAdmin(m, path, { cookie: player, ...(json !== undefined ? { json } : {}) })).status, `player ${m} ${path}`).toBe(401);
    expect(await db.query("select 1 from public.hero_versions where action <> 'INITIAL'")).toHaveLength(0);
  });

  it("refuses cross-site mutations (CSRF) and malformed ids", async () => {
    const [id] = await seedHeroes(db, 1);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {}, origin: "https://evil.example" })).status).toBe(403);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {}, origin: null })).status).toBe(403);
    expect((await callAdmin("GET", "/api/admin/heroes/not-a-uuid/versions")).status).toBe(404);
    expect((await callAdmin("POST", "/api/admin/heroes/not-a-uuid/reroll/preview", { json: {} })).status).toBe(404);
    expect((await callAdmin("GET", `/api/admin/heroes/${uuid()}/versions`)).status).toBe(404);
  });

  it("the browser can send NOTHING that decides the roll: a seed, class, rarity, stats or power in the body is refused outright", async () => {
    const [id] = await seedHeroes(db, 1);
    for (const evil of [{ seed: "abc" }, { rarity: "LEGENDARY" }, { classId: "mage" }, { stats: { hp: 999 } }, { power: 1e9 }, { nonce: "x" }]) {
      const res = await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: evil });
      expect(res.status, JSON.stringify(evil)).toBe(422);
    }
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: uuid(), rarity: "LEGENDARY" } })).status).toBe(422);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: "nope" } })).status).toBe(422);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: {} })).status).toBe(422);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/rollback`, { json: { versionId: uuid() } })).status).toBe(422);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/rollback`, { json: { versionId: uuid(), expectedCurrentVersionId: uuid(), requestId: uuid(), classId: "mage" } })).status).toBe(422);
    expect(await db.query("select 1 from public.hero_reroll_previews")).toHaveLength(0);
  });
});

describe("the full admin flow over HTTP", () => {
  it("view → preview → reroll again → apply → history → roll back → download card", async () => {
    const [id] = await seedHeroes(db, 1);
    const view0 = await body(await callAdmin("GET", `/api/admin/heroes/${id}/versions`));
    expect(view0.versioning).toMatchObject({ currentVersion: 1, versionCount: 1, rerollable: true, moderation: { arenaEligible: true, isPublic: true } });
    expect(view0.publicUrl).toBe(`${ORIGIN}/heroes/${await pubIdOf(id!)}`);
    expect(JSON.stringify(view0)).not.toMatch(/generation_?seed|generationSeed|appearanceSeed|telegram_user_id/i); // no seed ever reaches the browser

    const p1 = await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {} }));
    const p2 = await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {} }));
    expect(p1.preview.previewId).not.toBe(p2.preview.previewId);
    expect(p1.preview.candidate.publicId).toBe(view0.card.publicId);
    expect(JSON.stringify(p1)).not.toMatch(/generation_?seed|generationSeed/i);
    expect((await body(await callAdmin("GET", `/api/admin/heroes/${id}/versions`))).versioning.currentVersion).toBe(1); // previews change nothing

    const applied = await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: p2.preview.previewId } });
    expect(applied.status).toBe(200);
    const r = (await body(applied)).result;
    expect(r).toMatchObject({ alreadyApplied: false, version: { number: 2, action: "REROLL", current: true } });
    expect(r.card.classId).toBe(p2.preview.candidate.classId);
    expect(r.card.rarity).toBe(p2.preview.candidate.rarity);
    // the other (older) candidate is now stale, the applied one answers idempotently
    const stale = await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: p1.preview.previewId } });
    expect(stale.status).toBe(409);
    expect((await body(stale)).error).toBe("STALE_PREVIEW");
    expect((await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: p2.preview.previewId } }))).result.alreadyApplied).toBe(true);

    const view1 = (await body(await callAdmin("GET", `/api/admin/heroes/${id}/versions`))).versioning;
    expect(view1.versions.map((v: { number: number; action: string }) => [v.number, v.action])).toEqual([[2, "REROLL"], [1, "INITIAL"]]);
    const v1 = view1.versions[1];
    const v2 = view1.versions[0];

    // PREVIEW of the old version draws a card without changing anything
    const old = await body(await callAdmin("GET", `/api/admin/heroes/${id}/versions/${v1.id}/card`));
    expect(old).toMatchObject({ version: 1 });
    expect(old.card.classId).toBe(v1.classId);

    // ROLL BACK needs the current version the screen showed and a key; a retry returns the same version
    const key = uuid();
    const rb = await callAdmin("POST", `/api/admin/heroes/${id}/rollback`, { json: { versionId: v1.id, expectedCurrentVersionId: v2.id, requestId: key } });
    expect(rb.status).toBe(200);
    expect((await body(rb)).result.version).toMatchObject({ number: 3, action: "ROLLBACK", sourceVersion: 1 });
    expect((await body(await callAdmin("POST", `/api/admin/heroes/${id}/rollback`, { json: { versionId: v1.id, expectedCurrentVersionId: v2.id, requestId: key } }))).result.alreadyApplied).toBe(true);
    expect((await callAdmin("POST", `/api/admin/heroes/${id}/rollback`, { json: { versionId: v1.id, expectedCurrentVersionId: v2.id, requestId: uuid() } })).status).toBe(409); // stale screen
    expect(await db.query("select 1 from public.hero_versions where character_id = $1", [id])).toHaveLength(3);

    // DOWNLOAD CARD (admin): a 1200×1200 PNG attachment
    const png = await callAdmin("GET", `/api/admin/heroes/${id}/card-image`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("content-disposition")).toContain("attachment");
    expect(png.headers.get("cache-control")).toContain("no-store");
    const buf = Buffer.from(await png.arrayBuffer());
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 1200]);

    const audit = await db.query<{ action: string }>("select action from public.admin_audit_log where action like 'hero.re%' or action = 'hero.rollback' order by id");
    expect(audit.map((a) => a.action)).toEqual(["hero.reroll", "hero.rollback"]);
  });

  it("a hero in a prepared Arena roster: Apply / Roll back answer 409 with the standard message; the card and history stay available", async () => {
    const ids = await seedHeroes(db, 24);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    const [p] = await db.query<{ character_id: string }>("select p.character_id from public.arena_participants p join public.arena_battles b on b.id = p.battle_id where b.status = 'SIMULATED' order by b.sequence desc limit 1");
    const id = p!.character_id;
    const view = (await body(await callAdmin("GET", `/api/admin/heroes/${id}/versions`))).versioning;
    expect(view.arenaLock).toMatchObject({ locked: true, message: "Hero is currently queued in a live Arena fight. Try again after the prepared battle cycle completes." });
    const preview = await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {} }));
    expect(preview.preview.arenaLock.locked).toBe(true);
    const apply = await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: preview.preview.previewId } });
    expect(apply.status).toBe(409);
    const err = await body(apply);
    expect(err).toMatchObject({ error: "HERO_IN_ARENA", message: "Hero is currently queued in a live Arena fight. Try again after the prepared battle cycle completes." });
    expect(await db.query("select 1 from public.hero_versions where character_id = $1", [id])).toHaveLength(1);
    void ids;
  });
});

describe("the public card image route", () => {
  const publicRoute = () => import("@/app/api/hero-cards/[publicId]/route");
  const getCard = async (publicId: string, qs = "", headers: Record<string, string> = {}) => (await publicRoute()).GET(req(`/api/hero-cards/${publicId}${qs}`, { headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers } }), { params: Promise.resolve({ publicId }) });

  it("serves a 1200×1200 PNG for a public hero; the content key makes it immutable, a wrong key never gets long-term caching, and an ETag answers 304", async () => {
    const [id] = await seedHeroes(db, 1);
    const publicId = await pubIdOf(id!);
    const card = (await getPublicHeroCard(db, publicId, await publicCtx()))!;
    const key = cardKey(card);
    const ok = await getCard(publicId, `?v=${key}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(ok.headers.get("etag")).toBe(`"${key}"`);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    const buf = Buffer.from(await ok.arrayBuffer());
    expect([buf.subarray(1, 4).toString(), buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual(["PNG", 1200, 1200]);
    expect((await getCard(publicId, "?v=stale")).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await getCard(publicId)).headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect((await getCard(publicId, `?v=${key}`, { "if-none-match": `"${key}"` })).status).toBe(304);
    const dl = await getCard(publicId, `?v=${key}&download=1`);
    expect(dl.headers.get("content-disposition")).toBe(`attachment; filename="clank-rpg-hero-${publicId}.png"`);
  });

  it("is a plain 404 — identical for a suspended hero, a banned member, an unknown id and a malformed id (no reason leaks)", async () => {
    const [a, b] = await seedHeroes(db, 2);
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [a]);
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = (select telegram_user_id from public.characters where id = $1)", [b]);
    const responses = await Promise.all([getCard(await pubIdOf(a!)), getCard(await pubIdOf(b!)), getCard("222222222222"), getCard("not-an-id")]);
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/suspend|ban|moderat/i);
  });

  it("after a reroll the image URL (its key) changes — a stale image can never be served for the new version", async () => {
    const [id] = await seedHeroes(db, 1);
    const publicId = await pubIdOf(id!);
    const before = cardKey((await getPublicHeroCard(db, publicId, await publicCtx()))!);
    const pngBefore = Buffer.from(await (await getCard(publicId, `?v=${before}`)).arrayBuffer());
    let after = before;
    for (let i = 0; i < 20 && after === before; i++) {
      const p = await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {} }));
      expect((await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: p.preview.previewId } })).status).toBe(200);
      after = cardKey((await getPublicHeroCard(db, publicId, await publicCtx()))!);
    }
    expect(after).not.toBe(before);
    const fresh = await getCard(publicId, `?v=${before}`); // an OLD key still gets the CURRENT picture, never cached forever
    expect(fresh.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(Buffer.from(await fresh.arrayBuffer()).equals(pngBefore)).toBe(false);
    expect((await getCard(publicId, `?v=${after}`)).headers.get("cache-control")).toContain("immutable");
  });
});

describe("the public pages", () => {
  const dir = async (q: Record<string, string> = {}) => {
    const page = (await import("@/app/heroes/page")).default;
    return renderToStaticMarkup(await page({ searchParams: Promise.resolve(q) }));
  };
  const profile = async (publicId: string) => {
    const mod = await import("@/app/heroes/[publicId]/page");
    return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ publicId }) }));
  };
  const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  it("HEROES lists the public heroes as cards that link to their profile; class / rarity / search filters and paging work", async () => {
    await seedHeroes(db, 30);
    const html = await dir();
    expect(html.match(/data-testid="hero-tile"/g)).toHaveLength(24);
    const links = [...html.matchAll(/href="\/heroes\/([2-9a-hj-km-np-z]{12})"/g)].map((m) => m[1]);
    expect(links.length).toBe(24);
    expect(html).toContain('data-testid="filter-class"');
    expect(html).toContain("Page 1 of 2");
    expect(html).not.toMatch(/\/character\//);
    expect((await dir({ page: "2" })).match(/data-testid="hero-tile"/g)).toHaveLength(6);
    const classes = (await publicCtx()).classes;
    const withClass = await dir({ class: classes[0]!.id });
    const n = (await db.query<{ n: number }>("select count(*)::int as n from public.characters where class_id = $1", [classes[0]!.id]))[0]!.n;
    expect(withClass.match(/data-testid="hero-tile"/g)?.length ?? 0).toBe(Math.min(n, 24));
    expect(await dir({ rarity: "NOPE", class: "nope", sort: "nope", page: "-9" })).toContain("hero-grid"); // junk filters degrade to the default view
  });

  it("a PROFILE shows name, class, rarity, PWR and all seven stats, with DOWNLOAD / SHARE TO X / COPY LINK — and nothing private", async () => {
    const [id] = await seedHeroes(db, 1, { startId: 424242 });
    await db.query("update public.characters set name = 'Visible Name' where id = $1", [id]); // the seeded name embeds the Telegram id; a real one does not
    const publicId = await pubIdOf(id!);
    const html = await profile(publicId);
    const card = (await getPublicHeroCard(db, publicId, await publicCtx()))!;
    const text = visible(html);
    expect(text).toContain(card.name);
    expect(text).toContain(card.className);
    expect(text).toContain(`PWR ${card.power.toLocaleString("en-US")}`);
    for (const s of ["HP", "STR", "DEF", "INT", "AGI", "CHA", "LUCK"]) expect(html).toContain(`>${s}<`);
    for (const [k, v] of Object.entries(card.stats)) expect(html).toContain(`data-stat="${k}">${Math.round(v)}<`);
    // actions
    expect(html).toContain(`href="/api/hero-cards/${publicId}?v=${cardKey(card)}&amp;download=1"`);
    expect(html).toMatch(/Download card/);
    const share = html.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)![1]!.replace(/&amp;/g, "&");
    const su = new URL(share);
    expect(su.searchParams.get("url")).toBe(`${ORIGIN}/heroes/${publicId}`); // canonical URL, no internal id
    expect(su.searchParams.get("text")).toContain("My Clank RPG hero");
    expect(su.searchParams.get("text")).toContain(`PWR ${card.power.toLocaleString("en-US")}`);
    expect(html).toMatch(/target="_blank"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*target="_blank"/);
    expect(html).toMatch(/Copy link/);
    expect(html).toMatch(/can(&#x27;|')t attach the image/); // honest about what a web intent cannot do
    // privacy
    for (const secret of [String(424242), id!, "telegram", "seed"]) expect(html.toLowerCase(), secret).not.toContain(secret.toLowerCase());
  });

  it("OPEN GRAPH: 'Name's Legendary Mage | Clank RPG', canonical URL, and an image URL carrying the CURRENT card key", async () => {
    const [id] = await seedHeroes(db, 1);
    const publicId = await pubIdOf(id!);
    const { generateMetadata } = await import("@/app/heroes/[publicId]/page");
    const card = (await getPublicHeroCard(db, publicId, await publicCtx()))!;
    const meta = heroSocialMeta(card, ORIGIN);
    const m = await generateMetadata({ params: Promise.resolve({ publicId }) });
    expect(m.title).toEqual({ absolute: meta.title });
    expect(meta.title).toMatch(/^.+'s (Common|Rare|Epic|Legendary) \w+ \| Clank RPG$/);
    expect(m.description).toBe(meta.description);
    expect(m.alternates?.canonical).toBe(`${ORIGIN}/heroes/${publicId}`);
    expect((m.openGraph as { images: Array<{ url: string; width: number; height: number }> }).images[0]).toMatchObject({ url: `${ORIGIN}/api/hero-cards/${publicId}?v=${cardKey(card)}`, width: 1200, height: 1200 });
    expect((m.twitter as { card: string }).card).toBe("summary");
    // after a reroll the metadata points at the NEW image
    let key = cardKey(card);
    for (let i = 0; i < 20 && key === cardKey(card); i++) {
      const p = await body(await callAdmin("POST", `/api/admin/heroes/${id}/reroll/preview`, { json: {} }));
      await callAdmin("POST", `/api/admin/heroes/${id}/reroll/apply`, { json: { previewId: p.preview.previewId } });
      const m2 = await generateMetadata({ params: Promise.resolve({ publicId }) });
      key = new URL((m2.openGraph as { images: Array<{ url: string }> }).images[0]!.url).searchParams.get("v")!;
    }
    expect(key).not.toBe(cardKey(card));
  });

  it("a hidden hero's page is Next's not-found — the same for suspended, banned and unknown; the metadata says nothing either", async () => {
    const [a, b] = await seedHeroes(db, 2);
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [a]);
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = (select telegram_user_id from public.characters where id = $1)", [b]);
    const { generateMetadata } = await import("@/app/heroes/[publicId]/page");
    for (const publicId of [await pubIdOf(a!), await pubIdOf(b!), "222222222222", "bad"]) {
      await expect(profile(publicId)).rejects.toMatchObject({ digest: expect.stringContaining("404") });
      expect(await generateMetadata({ params: Promise.resolve({ publicId }) })).toEqual({ title: "Hero not found", robots: { index: false } });
    }
  });
});

describe("hero identity is clickable where heroes appear", () => {
  it("the arena state and the leaderboard carry each hero's public id, and the arena page links to /heroes/<id> (never to the internal id)", async () => {
    await seedHeroes(db, 24);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    const settings = await loadSettings(db);
    const state = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
    const all = [...state.current!.fighters, ...state.upcoming!.fighters];
    expect(all.every((f) => /^[2-9a-hj-km-np-z]{12}$/.test(f.publicId))).toBe(true);
    for (const f of all) expect(f.publicId).toBe(await pubIdOf(f.characterId));
    const html = renderToStaticMarkup(createElement(ArenaScreen, { initial: state }));
    for (const f of state.current!.fighters) expect(html).toContain(`href="/heroes/${f.publicId}"`);
    for (const f of state.upcoming!.fighters) expect(html).toContain(`href="/heroes/${f.publicId}"`);
    expect(html).not.toMatch(/href="\/character\//);

    // leaderboard
    const lb = await import("@/app/api/leaderboard/route");
    const res = await (lb.GET as RouteFn)(req("/api/leaderboard?board=POWER&limit=10"));
    const rows = (await body(res)).rows as Array<{ characterId: string; publicId: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.publicId).toBe(await pubIdOf(r.characterId));
  });
});
