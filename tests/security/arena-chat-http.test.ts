import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readEvent } from "@/domain/chat/envelope";
import type { ChatEnvelope, ChatMessageDto, ChatPageDto } from "@/domain/chat/types";
import { signTelegramLoginPayload } from "@/server/auth/telegramLogin";
import { resetChatRuntime } from "@/server/chat/runtime";
import { resetChatCaches } from "@/server/chat/service";
import { createChatSigner } from "@/server/chat/signing";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";

import { createTestDb, createTestDbUpTo, resetDb, seedEligibleMember } from "../support/db";

/** HTTP-level guarantees of the Arena Chat: who may read, who may write, what a request can and cannot decide, and what moderation does. */

const ORIGIN = "http://localhost:3700";
const BOT_TOKEN = "123456789:AAExampleBotTokenForTestsOnly_abcdefghijk";
const SECRET = "x".repeat(40);
const ENV = {
  NODE_ENV: "test",
  SESSION_SECRET: SECRET,
  ADMIN_ACCESS_KEY: "admin-access-key-for-tests-0123456789",
  CRON_SECRET: "cron-secret-for-tests-0123456789abcd",
  TELEGRAM_BOT_TOKEN: BOT_TOKEN,
  CLANK_DEV_LOGIN: "true",
  NEXT_PUBLIC_APP_URL: ORIGIN,
  // live delivery configured (the broadcast target is a fetch stub below, never a network)
  CHAT_REALTIME_URL: "https://realtime.test.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key-for-tests-0123456789",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_for_tests_0123456789",
};
const signer = createChatSigner(SECRET);

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

/** Everything the server tried to broadcast (the Realtime REST call is replaced; nothing leaves the process). */
let broadcasts: Array<{ url: string; headers: Record<string, string>; body: { messages: Array<{ topic: string; event: string; payload: ChatEnvelope; private: boolean }> } }> = [];
let realtimeUp = true;
beforeEach(async () => {
  await resetDb(db);
  resetRuntimeCaches();
  resetChatCaches();
  resetChatRuntime();
  broadcasts = [];
  realtimeUp = true;
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://realtime.test.invalid")) return real(input, init);
    if (!realtimeUp) throw new Error("realtime unreachable");
    broadcasts.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(init?.body as string) });
    return new Response(null, { status: 202 });
  });
});

type RouteFn = (req: Request, ctx?: unknown) => Promise<Response>;
let ipSeq = 0;
const req = (path: string, init: { method?: string; origin?: string | null; json?: unknown; raw?: string; type?: string | null; cookie?: string; ip?: string } = {}) => {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  headers.set("host", "localhost:3700");
  headers.set("x-forwarded-for", init.ip ?? `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`);
  const body = init.raw ?? (init.json !== undefined ? JSON.stringify(init.json) : null);
  if (body !== null && init.type !== null) headers.set("content-type", init.type ?? "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body });
};
const cookieOf = (res: Response, name = "clank_session") => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0] ?? "";
const chatRoute = () => import("@/app/api/arena/chat/messages/route");
const adminRoute = () => import("@/app/api/admin/[...path]/route");
const callAdmin = (fn: unknown, r: Request, ...path: string[]) => (fn as RouteFn)(r, { params: Promise.resolve({ path }) });

let loginClock = Math.floor(Date.now() / 1000);
async function loginAs(telegramId: number, opts: { hero?: boolean; name?: string } = {}) {
  await seedEligibleMember(db, { id: telegramId, hero: opts.hero ?? true });
  const route = await import("@/app/api/auth/telegram/route");
  const payload = signTelegramLoginPayload({ id: telegramId, first_name: opts.name ?? "Ada", username: "ada", auth_date: ++loginClock - 1 }, BOT_TOKEN);
  return cookieOf(await (route.POST as RouteFn)(req("/api/auth/telegram", { json: payload })));
}
let cachedAdmin: string | null = null;
async function adminCookie() {
  if (cachedAdmin) return cachedAdmin;
  const route = await adminRoute();
  cachedAdmin = cookieOf(await callAdmin(route.POST, req("/api/admin/session", { json: { key: ENV.ADMIN_ACCESS_KEY } }), "session"), "clank_admin");
  expect(cachedAdmin).toContain("clank_admin=");
  return cachedAdmin;
}

let nonceSeq = 0;
const nonce = () => `http${(++nonceSeq).toString(36).padStart(10, "0")}`;
const post = async (cookie: string | undefined, json: unknown, extra: { origin?: string | null } = {}) => (await chatRoute()).POST(req("/api/arena/chat/messages", { json, ...(cookie ? { cookie } : {}), ...(extra.origin !== undefined ? { origin: extra.origin } : {}) }));
const say = (cookie: string, body: string) => post(cookie, { body, nonce: nonce() });
const get = async (query = "", cookie?: string) => (await chatRoute()).GET(req(`/api/arena/chat/messages${query}`, { method: "GET", ...(cookie ? { cookie } : {}) }));
const page = async (query = "", cookie?: string) => (await (await get(query, cookie)).json()) as ChatPageDto & { ok: boolean };
const age = (member: number, seconds: number) => db.query("update public.arena_chat_messages set created_at = created_at - make_interval(secs => $2::float8) where sender_member_id = $1", [member, seconds]);

describe("reading — public", () => {
  it("a guest reads the room: no session needed, no cookie is ever set, nothing cached, no identity in the answer", async () => {
    const cookie = await loginAs(8001, { name: "Markyyester" });
    await db.query("update public.characters set name = 'Sir Bonk' where telegram_user_id = 8001");
    expect((await say(cookie, "hello everyone")).status).toBe(200);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = (await res.json()) as ChatPageDto;
    expect(body).toMatchObject({ enabled: true, hasMore: false, you: null });
    expect(body.messages).toHaveLength(1);
    expect(Object.keys(body.messages[0]!).sort()).toEqual(["at", "avatarUrl", "body", "id", "name", "rev", "senderKey"]);
    expect(body.messages[0]).toMatchObject({ body: "hello everyone", name: "Sir Bonk" });
    expect(JSON.stringify(body)).not.toMatch(/8001|telegram|ada\b/i);
  });

  it("the first page tells a signed-in viewer who they are (their opaque key, whether they may send) and how to join live — public values only", async () => {
    const cookie = await loginAs(8002);
    const body = await page("", cookie);
    expect(body.you).toEqual({ senderKey: signer.senderKey(8002), canSend: true, muted: null });
    expect(body.realtime).toEqual({ url: "wss://realtime.test.invalid/realtime/v1", key: ENV.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, topic: "arena-chat", event: "chat", verifyKey: signer.publicKey });
    expect(JSON.stringify(body)).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    // older pages carry neither (they are fetched while scrolling)
    const older = await page("?before=999999", cookie);
    expect(older.you).toBeUndefined();
    expect(older.realtime).toBeUndefined();
  });

  it("validates the query: a cursor is a positive integer, the limit is 1–100, before and after never together; unknown params are ignored", async () => {
    for (const q of ["?before=abc", "?before=-1", "?before=0", "?after=1.5", "?limit=0", "?limit=101", "?limit=x", "?before=1&after=2", `?before=${"9".repeat(20)}`]) {
      const res = await get(q);
      expect(res.status, q).toBe(422);
    }
    expect((await get("?limit=10&fbclid=abc")).status).toBe(200);
  });

  it("an unauthenticated or tampered cookie is simply a guest; a banned member is a guest too", async () => {
    expect((await page("", "clank_session=garbage")).you).toBeNull();
    const cookie = await loginAs(8003);
    expect((await page("", cookie)).you).not.toBeNull();
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = 8003");
    expect((await page("", cookie)).you).toBeNull();
    expect((await say(cookie, "banned but trying")).status).toBe(401);
  });

  it("reading is throttled per address (a flood is turned away, normal use never notices)", async () => {
    const route = await chatRoute();
    const statuses: number[] = [];
    for (let i = 0; i < 620; i++) statuses.push((await route.GET(req("/api/arena/chat/messages", { method: "GET", ip: "203.0.113.9" }))).status);
    expect(statuses.slice(0, 600).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(600).every((s) => s === 429)).toBe(true);
  });
});

describe("the room can be closed — calmly", () => {
  it("switched off by the admin → 'closed' (reads and sends both), nothing is queried or stored", async () => {
    const cookie = await loginAs(8010);
    await db.query("update public.feature_flags set enabled = false where key = 'arena.chat'");
    resetRuntimeCaches();
    const body = await page("", cookie);
    expect(body).toMatchObject({ ok: true, enabled: false, reason: "CLOSED", messages: [], you: null, realtime: null });
    const res = await say(cookie, "anyone home?");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "CHAT_CLOSED" });
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(0);
  });

  it("the migration is not applied yet → 'not ready' (a normal answer, never a 500), sends refused, and it opens by itself afterwards", async () => {
    const old = await createTestDbUpTo("20261007002300");
    const previous = (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb;
    (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = { promise: Promise.resolve(old) };
    try {
      resetRuntimeCaches();
      resetChatCaches();
      await old.query("insert into public.feature_flags (key, enabled, description) values ('arena.chat', true, 'x') on conflict (key) do update set enabled = true");
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, enabled: false, reason: "NOT_READY", messages: [] });
      await old.query("insert into public.telegram_users (telegram_user_id, display_name) values (8011, 'X') on conflict do nothing");
      const route = await import("@/app/api/auth/telegram/route");
      const cookie = cookieOf(await (route.POST as RouteFn)(req("/api/auth/telegram", { json: signTelegramLoginPayload({ id: 8011, first_name: "X", auth_date: ++loginClock - 1 }, BOT_TOKEN) })));
      expect((await say(cookie, "too early")).status).toBe(503);
    } finally {
      (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = previous;
      resetChatCaches();
      resetRuntimeCaches();
      await old.close();
    }
  });
});

describe("writing — Telegram sign-in only, the sender is the session", () => {
  it("a guest cannot send: 401, nothing stored, nothing broadcast — and the same-origin rule holds for everyone", async () => {
    expect((await post(undefined, { body: "hi", nonce: nonce() })).status).toBe(401);
    expect((await post("clank_session=garbage", { body: "hi", nonce: nonce() })).status).toBe(401);
    const cookie = await loginAs(8020);
    expect((await post(cookie, { body: "hi", nonce: nonce() }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(cookie, { body: "hi", nonce: nonce() }, { origin: null })).status).toBe(403);
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(0);
    expect(broadcasts).toHaveLength(0);
  });

  it("the sender is ALWAYS the signed-in member; a body that tries to name one (id, name, key, role, timestamp) is refused, not honoured", async () => {
    const cookie = await loginAs(8021, { name: "Honest" });
    for (const extra of [{ senderId: 1 }, { telegramUserId: 1000 }, { memberId: 1 }, { name: "Admin" }, { senderKey: "abcdefghijklmnop" }, { created_at: "2020-01-01" }, { role: "admin" }, { rev: 5 }]) {
      const res = await post(cookie, { body: "I am someone else", nonce: nonce(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(0);
    // headers that look like identity carry no weight either
    const spoof = req("/api/arena/chat/messages", { json: { body: "hello", nonce: nonce() }, cookie });
    spoof.headers.set("x-telegram-user-id", "1");
    spoof.headers.set("x-member-id", "1");
    expect((await (await chatRoute()).POST(spoof)).status).toBe(200);
    expect(await db.query("select sender_member_id from public.arena_chat_messages")).toEqual([{ sender_member_id: 8021 }]);
  });

  it("a send returns the stored message (server timestamp, hero name, avatar, opaque key) and broadcasts exactly that, signed", async () => {
    const cookie = await loginAs(8022);
    const res = await say(cookie, "Hello, Arena!");
    expect(res.status).toBe(200);
    const { message, duplicate } = (await res.json()) as { message: ChatMessageDto; duplicate: boolean };
    expect(duplicate).toBe(false);
    expect(message).toMatchObject({ body: "Hello, Arena!", name: "Hero 8022", senderKey: signer.senderKey(8022), rev: 0 });
    expect(Math.abs(Date.now() - Date.parse(message.at))).toBeLessThan(5_000);

    expect(broadcasts).toHaveLength(1);
    const b = broadcasts[0]!;
    expect(b.url).toBe("https://realtime.test.invalid/realtime/v1/api/broadcast");
    expect(b.headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(b.body.messages).toHaveLength(1);
    const sent = b.body.messages[0]!;
    expect(sent).toMatchObject({ topic: "arena-chat", event: "chat", private: true });
    expect(signer.verify(sent.payload)).toBe(true);
    expect(readEvent(sent.payload.j)).toEqual({ t: "msg", m: message });
  });

  it("the message is saved FIRST: a Realtime outage costs only the push — the send succeeds and the room has the message", async () => {
    realtimeUp = false;
    const cookie = await loginAs(8023);
    const res = await say(cookie, "saved even though realtime is down");
    expect(res.status).toBe(200);
    expect((await page()).messages.map((m) => m.body)).toEqual(["saved even though realtime is down"]);
  });

  it("a retried request (same nonce) is answered with the same message, stored once and broadcast once", async () => {
    const cookie = await loginAs(8024);
    const n = nonce();
    const first = await (await post(cookie, { body: "double click", nonce: n })).json();
    const second = await (await post(cookie, { body: "double click", nonce: n })).json();
    expect(second.message).toEqual(first.message);
    expect(second.duplicate).toBe(true);
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it("validates what is sent: empty, whitespace, too long, too many lines, bad nonce, wrong type, not JSON, oversized", async () => {
    const cookie = await loginAs(8025);
    expect(await (await say(cookie, "")).json()).toMatchObject({ error: "EMPTY_MESSAGE" });
    expect((await say(cookie, "   \n  ")).status).toBe(422);
    const long = await say(cookie, "x".repeat(281));
    expect(long.status).toBe(422);
    expect(await long.json()).toMatchObject({ error: "TOO_LONG", message: "Messages can be up to 280 characters." });
    expect(await (await say(cookie, "a\nb\nc\nd\ne")).json()).toMatchObject({ error: "TOO_MANY_LINES" });
    for (const json of [{ body: "x", nonce: "short" }, { body: "x" }, { nonce: nonce() }, { body: 5, nonce: nonce() }, { body: "x", nonce: "has spaces in it!!" }, []]) expect((await post(cookie, json)).status, JSON.stringify(json)).toBe(422);
    const route = await chatRoute();
    expect((await route.POST(req("/api/arena/chat/messages", { cookie, raw: "{not json", type: "application/json" }))).status).toBe(400);
    expect((await route.POST(req("/api/arena/chat/messages", { cookie, raw: JSON.stringify({ body: "hi", nonce: nonce() }), type: "text/plain" }))).status).toBe(415);
    expect((await route.POST(req("/api/arena/chat/messages", { cookie, json: { body: "x".repeat(5_000), nonce: nonce() } }))).status).toBe(413);
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(0);
  });

  it("stores plain text exactly: markup is inert, hostile characters are removed, and what is returned is what a reader gets", async () => {
    const cookie = await loginAs(8026);
    const xss = `<img src=x onerror=alert(document.cookie)><script>fetch('//evil')</script>`;
    const { message } = await (await say(cookie, xss)).json();
    expect(message.body).toBe(xss); // plain text: the reader renders it as text, never as HTML
    await age(8026, 4);
    const sneaky = await (await say(cookie, `pay${String.fromCodePoint(0x202e)}gnirts${String.fromCodePoint(0x200b)}`)).json();
    expect(sneaky.message.body).toBe("paygnirts");
    expect((await page()).messages.map((m) => m.body)).toEqual([xss, "paygnirts"]);
  });

  it("answers a flood with friendly 429s and Retry-After; the limits are the member's, not the address's", async () => {
    const cookie = await loginAs(8027);
    const other = await loginAs(8028);
    expect((await say(cookie, "one")).status).toBe(200);
    const quick = await say(cookie, "two");
    expect(quick.status).toBe(429);
    expect(Number(quick.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await quick.json()).toMatchObject({ error: "TOO_FAST", retryAfterMs: expect.any(Number), message: expect.stringContaining("Slow down") });
    expect((await say(other, "I am fine")).status).toBe(200);
    await age(8027, 4);
    expect(await (await say(cookie, "one")).json()).toMatchObject({ error: "DUPLICATE_MESSAGE" });
  });

  it("a muted member can read but not write — and learns only that, never why", async () => {
    const cookie = await loginAs(8029);
    await db.query("insert into public.arena_chat_mutes (member_id, permanent, created_by, reason) values (8029, true, 'admin', 'LEAKY-REASON')");
    const res = await say(cookie, "let me talk");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ error: "MUTED", muted: { permanent: true } });
    expect(JSON.stringify(body)).not.toContain("LEAKY");
    const view = await page("", cookie);
    expect(view.you).toEqual({ senderKey: signer.senderKey(8029), canSend: false, muted: { permanent: true } });
    expect(JSON.stringify(view)).not.toContain("LEAKY");
    expect(view.enabled).toBe(true);
  });
});

describe("moderation — admin only", () => {
  it("every chat admin endpoint needs the admin session: a signed-in PLAYER is not an admin, and non-GET needs a same-origin request", async () => {
    const player = await loginAs(8030);
    const route = await adminRoute();
    for (const [method, path] of [["GET", ["chat", "messages"]], ["POST", ["chat", "messages", "1", "hide"]], ["POST", ["chat", "messages", "1", "restore"]], ["GET", ["chat", "mutes"]], ["POST", ["chat", "mutes"]], ["DELETE", ["chat", "mutes", "1"]], ["GET", ["chat", "log"]]] as const) {
      const fn = route[method];
      expect((await callAdmin(fn, req(`/api/admin/${path.join("/")}`, { method, cookie: player, json: method === "GET" ? undefined : {} }), ...path)).status, `${method} ${path.join("/")}`).toBe(401);
    }
    const admin = await adminCookie();
    expect((await callAdmin(route.POST, req("/api/admin/chat/mutes", { cookie: admin, origin: "https://evil.example", json: { memberId: 8030, permanent: true } }), "chat", "mutes")).status).toBe(403);
    expect(await db.query("select 1 from public.arena_chat_mutes")).toHaveLength(0);
  });

  it("hide: the message leaves the room, a SIGNED hide event is broadcast with the new revision, the audit log records it; restore re-broadcasts the message", async () => {
    const cookie = await loginAs(8031);
    const { message } = await (await say(cookie, "abusive words")).json();
    broadcasts = [];
    const admin = await adminCookie();
    const route = await adminRoute();
    const hid = await callAdmin(route.POST, req(`/api/admin/chat/messages/${message.id}/hide`, { cookie: admin, json: { reason: "abuse" } }), "chat", "messages", String(message.id), "hide");
    expect(hid.status).toBe(200);
    expect(await hid.json()).toMatchObject({ id: message.id, rev: 1, changed: true });
    expect((await page()).messages).toEqual([]);
    expect(broadcasts).toHaveLength(1);
    const hideEnv = broadcasts[0]!.body.messages[0]!.payload;
    expect(signer.verify(hideEnv)).toBe(true);
    expect(readEvent(hideEnv.j)).toEqual({ t: "hide", id: message.id, rev: 1 });
    // hiding twice changes nothing and broadcasts nothing
    await callAdmin(route.POST, req(`/api/admin/chat/messages/${message.id}/hide`, { cookie: admin, json: {} }), "chat", "messages", String(message.id), "hide");
    expect(broadcasts).toHaveLength(1);

    const back = await callAdmin(route.POST, req(`/api/admin/chat/messages/${message.id}/restore`, { cookie: admin, json: {} }), "chat", "messages", String(message.id), "restore");
    expect(await back.json()).toMatchObject({ rev: 2, changed: true });
    expect((await page()).messages.map((m) => m.id)).toEqual([message.id]);
    expect(readEvent(broadcasts[1]!.body.messages[0]!.payload.j)).toMatchObject({ t: "msg", m: { id: message.id, rev: 2, body: "abusive words" } });

    const log = (await (await callAdmin(route.GET, req("/api/admin/chat/log", { method: "GET", cookie: admin }), "chat", "log")).json()) as { log: Array<{ action: string }> };
    expect(log.log.map((l) => l.action)).toEqual(["chat.restore", "chat.hide"]);
    expect((await callAdmin(route.POST, req("/api/admin/chat/messages/999999/hide", { cookie: admin, json: {} }), "chat", "messages", "999999", "hide")).status).toBe(404);
    expect((await callAdmin(route.POST, req("/api/admin/chat/messages/abc/hide", { cookie: admin, json: {} }), "chat", "messages", "abc", "hide")).status).toBe(404);
  });

  it("mute: timed or permanent (exactly one), takes effect at once, is listed, can be lifted; a bad request or an unknown member is refused", async () => {
    const cookie = await loginAs(8032);
    const admin = await adminCookie();
    const route = await adminRoute();
    const mute = (json: unknown) => callAdmin(route.POST, req("/api/admin/chat/mutes", { cookie: admin, json }), "chat", "mutes");
    for (const bad of [{ memberId: 8032 }, { memberId: 8032, minutes: 5, permanent: true }, { memberId: 8032, minutes: 0 }, { memberId: 8032, minutes: 99_999_999 }, { memberId: "8032", permanent: true }, { memberId: 8032, permanent: true, extra: 1 }]) {
      expect((await mute(bad)).status, JSON.stringify(bad)).toBe(422);
    }
    expect((await mute({ memberId: 424242, permanent: true })).status).toBe(404);
    expect((await mute({ memberId: 8032, minutes: 15, reason: "links" })).status).toBe(200);
    expect((await say(cookie, "muted now")).status).toBe(403);
    const listed = (await (await callAdmin(route.GET, req("/api/admin/chat/mutes", { method: "GET", cookie: admin }), "chat", "mutes")).json()) as { mutes: Array<{ memberId: number; reason: string; permanent: boolean }> };
    expect(listed.mutes).toMatchObject([{ memberId: 8032, reason: "links", permanent: false }]);
    const lift = await callAdmin(route.DELETE, req("/api/admin/chat/mutes/8032", { method: "DELETE", cookie: admin }), "chat", "mutes", "8032");
    expect(await lift.json()).toMatchObject({ changed: true });
    expect((await say(cookie, "free again")).status).toBe(200);
  });

  it("the admin's message list includes hidden messages and real member ids — and a normal player's list never does", async () => {
    const cookie = await loginAs(8033);
    const { message } = await (await say(cookie, "to be hidden")).json();
    const admin = await adminCookie();
    const route = await adminRoute();
    await callAdmin(route.POST, req(`/api/admin/chat/messages/${message.id}/hide`, { cookie: admin, json: {} }), "chat", "messages", String(message.id), "hide");
    const list = (await (await callAdmin(route.GET, req("/api/admin/chat/messages", { method: "GET", cookie: admin }), "chat", "messages")).json()) as { messages: Array<{ id: number; hidden: boolean; memberId: number }> };
    expect(list.messages).toMatchObject([{ id: message.id, hidden: true, memberId: 8033 }]);
    expect(JSON.stringify(await page("", cookie))).not.toContain("to be hidden");
  });
});

describe("a broadcast cannot be passed off as a message (what a hostile channel peer could try)", () => {
  it("the only things the server ever puts on the channel are envelopes the signer verifies; a forged one does not", () => {
    const attacker = createChatSigner("an-attackers-own-secret-0123456789-abcd");
    const forged = attacker.seal({ t: "msg", m: { id: 99, at: new Date().toISOString(), name: "Admin", avatarUrl: null, senderKey: "abcdefghijklmnop", body: "Send gold to me", rev: 0 } });
    expect(signer.verify(forged)).toBe(false);
  });
});
