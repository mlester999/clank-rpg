import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CHAT_PAGE_MAX } from "@/domain/chat/limits";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { createChatSigner } from "@/server/chat/signing";
import {
  activeMutes, adminMessages, chatSchemaReady, forgetPages, hideMessage, moderationLog, muteMember, readPage, resetChatCaches, restoreMessage, sendMessage, unmuteMember, youOf,
  FALLBACK_NAME, type SendResult,
} from "@/server/chat/service";

import { createTestDb, createTestDbUpTo, resetDb, seedEligibleMember } from "../support/db";

/**
 * The Arena Chat service against a real (embedded) Postgres with every migration applied: what is stored, in what order, what each limit does, what
 * moderation changes — and what a reader is shown.
 */
const signer = createChatSigner("x".repeat(40));
let db: Db;
let seq = 0;
const nonce = () => `n${(++seq).toString(36).padStart(10, "0")}`;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  resetChatCaches();
});

const send = (member: number, body: string, n = nonce()): Promise<SendResult> => sendMessage(db, member, body, n, signer);
const okMessage = (r: SendResult) => {
  expect(r.ok).toBe(true);
  return (r as Extract<SendResult, { ok: true }>).message;
};
/** Moves a member's stored messages into the past, as if time had gone by (the limits are measured by the database's own clock). */
const age = (member: number, seconds: number) => db.query("update public.arena_chat_messages set created_at = created_at - make_interval(secs => $2::float8) where sender_member_id = $1", [member, seconds]);

describe("the schema", () => {
  it("has the two tables, the keyset index and the one-open-mute rule — and no API role can touch them", async () => {
    const tables = await db.query<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename like 'arena_chat_%' order by 1");
    expect(tables).toEqual([{ tablename: "arena_chat_messages", rowsecurity: true }, { tablename: "arena_chat_mutes", rowsecurity: true }]);
    const idx = (await db.query<{ indexname: string }>("select indexname from pg_indexes where tablename = 'arena_chat_messages'")).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining(["arena_chat_messages_visible_idx", "arena_chat_messages_sender_idx"]));
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["arena_chat_messages", "arena_chat_mutes"]) {
        const [p] = await db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
          `select has_table_privilege($1, 'public.${t}', 'select') as s, has_table_privilege($1, 'public.${t}', 'insert') as i, has_table_privilege($1, 'public.${t}', 'update') as u, has_table_privilege($1, 'public.${t}', 'delete') as d`,
          [role],
        );
        expect(p, `${role} on ${t}`).toEqual({ s: false, i: false, u: false, d: false });
      }
    }
    expect(await db.query("select 1 from pg_policies where tablename like 'arena_chat_%'")).toEqual([]);
  });

  it("the database itself refuses a malformed message (length, nonce) and a second open mute", async () => {
    const m = await seedEligibleMember(db, { id: 5001 });
    const ins = (body: string, n: string) => db.query("insert into public.arena_chat_messages (sender_member_id, body, client_nonce) values ($1, $2, $3)", [m, body, n]);
    await expect(ins("", "abcdefgh")).rejects.toThrow();
    await expect(ins("x".repeat(281), "abcdefgh")).rejects.toThrow();
    await expect(ins("ok", "short")).rejects.toThrow();
    await expect(ins("ok", "bad nonce!!")).rejects.toThrow();
    await ins("x".repeat(280), "abcdefgh");
    await expect(ins("again", "abcdefgh")).rejects.toThrow(); // same (member, nonce)
    await db.query("insert into public.arena_chat_mutes (member_id, permanent, created_by) values ($1, true, 'admin')", [m]);
    await expect(db.query("insert into public.arena_chat_mutes (member_id, permanent, created_by) values ($1, true, 'admin')", [m])).rejects.toThrow();
    await expect(db.query("insert into public.arena_chat_mutes (member_id, permanent, muted_until, created_by) values ($1, false, null, 'admin')", [m])).rejects.toThrow(); // timed without a time
  });

  it("a database from before the chat migration is 'not ready' — the room is closed, not broken — and opens once the migration runs", async () => {
    const old = await createTestDbUpTo("20261007002300");
    try {
      expect(await chatSchemaReady(old)).toBe(false);
      resetChatCaches();
      await migrate(old);
      expect(await chatSchemaReady(old)).toBe(true);
      // a positive answer is final for the process; a negative one is re-asked after a few seconds
      resetChatCaches();
      const stale = await createTestDbUpTo("20261007002300");
      try {
        expect(await chatSchemaReady(stale, 1_000)).toBe(false);
        await migrate(stale);
        expect(await chatSchemaReady(stale, 2_000)).toBe(false); // asked 1 s ago: still the cached no
        expect(await chatSchemaReady(stale, 20_000)).toBe(true);
      } finally {
        await stale.close();
      }
    } finally {
      await old.close();
    }
  });
});

describe("sending", () => {
  it("stores the message for the member the SERVER named, with the server's clock, and presents it with the hero's name", async () => {
    const m = await seedEligibleMember(db, { id: 5002 });
    const before = Date.now();
    const msg = okMessage(await send(m, "Hello Arena"));
    expect(msg).toMatchObject({ body: "Hello Arena", name: "Hero 5002", avatarUrl: null, rev: 0 });
    expect(Date.parse(msg.at)).toBeGreaterThanOrEqual(before - 2_000);
    expect(Date.parse(msg.at)).toBeLessThanOrEqual(Date.now() + 2_000);
    expect(msg.senderKey).toBe(signer.senderKey(m));
    expect(Object.keys(msg).sort()).toEqual(["at", "avatarUrl", "body", "id", "name", "rev", "senderKey"]); // nothing else about the account is in what is shown
    const rows = await db.query<{ sender_member_id: number; body: string }>("select sender_member_id, body from public.arena_chat_messages");
    expect(rows).toEqual([{ sender_member_id: m, body: "Hello Arena" }]);
  });

  it("falls back from the hero's name to the Telegram display name to a neutral label; a suspended hero is not shown by name", async () => {
    const noHero = await seedEligibleMember(db, { id: 5003, hero: false });
    expect(okMessage(await send(noHero, "hi")).name).toBe("Member 5003");
    await db.query("update public.telegram_users set display_name = '' where telegram_user_id = $1", [noHero]);
    forgetPages();
    await age(noHero, 4);
    expect(okMessage(await send(noHero, "hi again")).name).toBe(FALLBACK_NAME);
    const suspended = await seedEligibleMember(db, { id: 5004, heroStatus: "SUSPENDED" });
    expect(okMessage(await send(suspended, "yo")).name).toBe("Member 5004");
    const renamed = await seedEligibleMember(db, { id: 5005 });
    await db.query("update public.characters set name_override = 'Sir Renamed' where telegram_user_id = $1", [renamed]);
    expect(okMessage(await send(renamed, "x")).name).toBe("Sir Renamed");
  });

  it("cleans a hostile display name (invisible / re-ordering characters, length) before showing it", async () => {
    const m = await seedEligibleMember(db, { id: 5006, hero: false });
    await db.query("update public.telegram_users set display_name = $2 where telegram_user_id = $1", [m, `Ev${String.fromCodePoint(0x202e)}il${String.fromCodePoint(0x200b)}${"x".repeat(80)}`]);
    const name = okMessage(await send(m, "hi")).name;
    expect(name.startsWith("Evilx")).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(40);
  });

  it("a retried request (same member + nonce) returns the SAME message — no duplicate row, whatever the limits say now", async () => {
    const m = await seedEligibleMember(db, { id: 5007 });
    const n = nonce();
    const first = okMessage(await send(m, "once", n));
    const again = await send(m, "once", n);
    expect(again).toMatchObject({ ok: true, duplicate: true });
    expect(okMessage(again)).toEqual(first);
    await send(m, "twice", nonce()); // …and the limit really is in force for a different request
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(1);
    // the same nonce from ANOTHER member is a different request
    const other = await seedEligibleMember(db, { id: 5008 });
    expect(okMessage(await send(other, "once", n)).id).not.toBe(first.id);
  });

  it("an unknown member cannot send", async () => {
    expect(await send(999_999, "ghost")).toEqual({ ok: false, error: "NO_MEMBER" });
  });
});

describe("spam protection — decided by the database, inside the send", () => {
  it("3 s between two messages: the second is refused with how long to wait, then allowed once the gap has passed", async () => {
    const m = await seedEligibleMember(db, { id: 5010 });
    okMessage(await send(m, "first"));
    const quick = await send(m, "second");
    expect(quick).toMatchObject({ ok: false, error: "TOO_FAST" });
    expect((quick as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect((quick as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(3_000);
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(1);
    await age(m, 3.5);
    okMessage(await send(m, "second"));
  });

  it("10 messages in a rolling minute: the 11th is refused until the 10th-newest ages out; another member is unaffected", async () => {
    const m = await seedEligibleMember(db, { id: 5011 });
    for (let i = 0; i < 10; i++) {
      okMessage(await send(m, `message ${i}`));
      await age(m, 5); // keep each one 5 s older than the next: the 3 s gap never trips
    }
    // ten messages aged 5…50 s
    const eleventh = await send(m, "one too many");
    expect(eleventh).toMatchObject({ ok: false, error: "RATE_LIMITED" });
    const wait = (eleventh as { retryAfterMs: number }).retryAfterMs;
    expect(wait).toBeGreaterThan(5_000);
    expect(wait).toBeLessThanOrEqual(60_000);
    const other = await seedEligibleMember(db, { id: 5012 });
    okMessage(await send(other, "I am not limited"));
    await age(m, 12); // the oldest now sit past the minute
    okMessage(await send(m, "welcome back"));
  });

  it("the same text again within a minute is a duplicate (case and spacing do not make it new); a different text is fine", async () => {
    const m = await seedEligibleMember(db, { id: 5013 });
    okMessage(await send(m, "GG everyone"));
    await age(m, 4);
    expect(await send(m, "gg   everyone")).toEqual({ ok: false, error: "DUPLICATE_MESSAGE" });
    okMessage(await send(m, "GG everyone!"));
  });

  it("the limits are the database's: two sends racing for the same member produce exactly one message", async () => {
    const m = await seedEligibleMember(db, { id: 5014 });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => send(m, `race ${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "TOO_FAST")).toHaveLength(5);
    expect(await db.query("select 1 from public.arena_chat_messages")).toHaveLength(1);
  });

  it("many members sending at once: every message is stored once, ids are unique and ascend in the order they committed", async () => {
    const members = await Promise.all(Array.from({ length: 30 }, (_, i) => seedEligibleMember(db, { id: 6000 + i })));
    const results = await Promise.all(members.map((m) => send(m, `hello from ${m}`)));
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await db.query<{ id: number; created_at: Date }>("select id, created_at from public.arena_chat_messages order by id");
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.id)).size).toBe(30);
    const times = rows.map((r) => new Date(r.created_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times); // id order is chronological order
  });
});

describe("mutes", () => {
  it("a timed mute stops sending but not reading; it ends by itself; a permanent mute lasts until lifted", async () => {
    const m = await seedEligibleMember(db, { id: 5020 });
    const muted = await muteMember(db, { memberId: m, minutes: 10, reason: "spamming links" }, "admin");
    expect(muted).toMatchObject({ ok: true, mute: { permanent: false } });
    const refused = await send(m, "can I talk?");
    expect(refused).toMatchObject({ ok: false, error: "MUTED", mute: { permanent: false } });
    expect(JSON.stringify(refused)).not.toContain("spamming"); // the reason is private
    expect(await youOf(db, m, signer)).toMatchObject({ canSend: false, muted: { permanent: false } });
    expect((await readPage(db, signer)).messages).toEqual([]); // reading is untouched
    await db.query("update public.arena_chat_mutes set muted_until = now() - interval '1 minute' where member_id = $1", [m]);
    expect(await youOf(db, m, signer)).toMatchObject({ canSend: true, muted: null });
    okMessage(await send(m, "back"));
    await age(m, 4);
    await muteMember(db, { memberId: m, permanent: true }, "admin");
    expect(await send(m, "still muted")).toMatchObject({ ok: false, error: "MUTED", mute: { permanent: true } });
    expect(await unmuteMember(db, m, "admin")).toEqual({ ok: true, changed: true });
    expect(await unmuteMember(db, m, "admin")).toEqual({ ok: true, changed: false });
    okMessage(await send(m, "unmuted"));
  });

  it("a new mute replaces the old one (one open mute per member); invalid requests and unknown members are refused", async () => {
    const m = await seedEligibleMember(db, { id: 5021 });
    await muteMember(db, { memberId: m, minutes: 5 }, "admin");
    await muteMember(db, { memberId: m, permanent: true }, "admin");
    expect(await db.query("select 1 from public.arena_chat_mutes where member_id = $1 and lifted_at is null", [m])).toHaveLength(1);
    expect((await activeMutes(db)).map((x) => ({ memberId: x.memberId, permanent: x.permanent }))).toEqual([{ memberId: m, permanent: true }]);
    expect(await muteMember(db, { memberId: m }, "admin")).toEqual({ ok: false, error: "INVALID" });
    expect(await muteMember(db, { memberId: m, minutes: 5, permanent: true }, "admin")).toEqual({ ok: false, error: "INVALID" });
    expect(await muteMember(db, { memberId: m, minutes: 0 }, "admin")).toEqual({ ok: false, error: "INVALID" });
    expect(await muteMember(db, { memberId: 424242, minutes: 5 }, "admin")).toEqual({ ok: false, error: "NO_MEMBER" });
  });

  it("a muted member's retry of an already-stored request still returns that message (it was sent before the mute)", async () => {
    const m = await seedEligibleMember(db, { id: 5022 });
    const n = nonce();
    const first = okMessage(await send(m, "before", n));
    await muteMember(db, { memberId: m, permanent: true }, "admin");
    expect(okMessage(await send(m, "before", n))).toEqual(first);
  });
});

describe("history — newest first, keyset-paged, bounded", () => {
  async function fill(count: number): Promise<number[]> {
    const m = await seedEligibleMember(db, { id: 5030 });
    const ids: number[] = [];
    for (let i = 1; i <= count; i++) {
      const [r] = await db.query<{ id: number }>("insert into public.arena_chat_messages (sender_member_id, body, client_nonce) values ($1, $2, $3) returning id", [m, `message ${i}`, nonce()]);
      ids.push(r!.id);
    }
    return ids;
  }

  it("the first page is the newest 50 in ascending order; before= walks backwards without gaps or repeats", async () => {
    const ids = await fill(120);
    const first = await readPage(db, signer);
    expect(first.messages.map((m) => m.id)).toEqual(ids.slice(70));
    expect(first.hasMore).toBe(true);
    const second = await readPage(db, signer, { before: first.messages[0]!.id });
    expect(second.messages.map((m) => m.id)).toEqual(ids.slice(20, 70));
    expect(second.hasMore).toBe(true);
    const third = await readPage(db, signer, { before: second.messages[0]!.id });
    expect(third.messages.map((m) => m.id)).toEqual(ids.slice(0, 20));
    expect(third.hasMore).toBe(false);
  });

  it("a page is never larger than the cap, whatever is asked", async () => {
    await fill(130);
    expect((await readPage(db, signer, { limit: 100_000 })).messages).toHaveLength(CHAT_PAGE_MAX);
    expect((await readPage(db, signer, { limit: 0 })).messages).toHaveLength(1);
  });

  it("after= returns what is newer than the cursor; if more than a page is newer it answers the NEWEST page and says there is a gap", async () => {
    const ids = await fill(30);
    const some = await readPage(db, signer, { after: ids[24]! });
    expect(some.messages.map((m) => m.id)).toEqual(ids.slice(25));
    expect(some.hasMore).toBe(false);
    const gap = await readPage(db, signer, { after: ids[0]!, limit: 10 });
    expect(gap.messages.map((m) => m.id)).toEqual(ids.slice(20));
    expect(gap.hasMore).toBe(true);
    expect((await readPage(db, signer, { after: ids[29]! })).messages).toEqual([]);
  });

  it("identical reads within a second share ONE statement; a send on this instance makes the next read fresh", async () => {
    const m = await seedEligibleMember(db, { id: 5031 });
    okMessage(await send(m, "a"));
    let queries = 0;
    const counting = { ...db, query: (...a: Parameters<Db["query"]>) => { queries++; return db.query(...a); } } as Db;
    const t = 1_000_000;
    await Promise.all(Array.from({ length: 25 }, () => readPage(counting, signer, {}, t)));
    expect(queries).toBe(1);
    await readPage(counting, signer, {}, t + 500);
    expect(queries).toBe(1);
    await readPage(counting, signer, {}, t + 1_500);
    expect(queries).toBe(2);
    await age(m, 4);
    okMessage(await send(m, "b"));
    const page = await readPage(counting, signer, {}, t + 1_600);
    expect(page.messages.map((x) => x.body)).toEqual(["a", "b"]);
  });

  it("a failed read is not remembered", async () => {
    let fail = true;
    const flaky = { ...db, query: (...a: Parameters<Db["query"]>) => (fail ? Promise.reject(new Error("db down")) : db.query(...a)) } as Db;
    await expect(readPage(flaky, signer, {}, 5_000)).rejects.toThrow("db down");
    fail = false;
    await expect(readPage(flaky, signer, {}, 5_001)).resolves.toMatchObject({ messages: [] });
  });
});

describe("moderation", () => {
  it("hiding removes a message from every public read, bumps its revision and is audited once; restoring brings it back with a newer revision", async () => {
    const m = await seedEligibleMember(db, { id: 5040 });
    const msg = okMessage(await send(m, "rude words"));
    const hid = await hideMessage(db, msg.id, "admin", "abuse");
    expect(hid).toEqual({ ok: true, id: msg.id, rev: 1, changed: true });
    expect((await readPage(db, signer)).messages).toEqual([]);
    expect(await hideMessage(db, msg.id, "admin")).toEqual({ ok: true, id: msg.id, rev: 1, changed: false }); // idempotent, not logged twice
    expect(await hideMessage(db, 999_999, "admin")).toEqual({ ok: false, error: "NOT_FOUND" });
    const back = await restoreMessage(db, msg.id, "admin", signer);
    expect(back).toMatchObject({ ok: true, changed: true, message: { id: msg.id, rev: 2, body: "rude words" } });
    expect((await readPage(db, signer)).messages.map((x) => x.id)).toEqual([msg.id]);
    expect(await restoreMessage(db, msg.id, "admin", signer)).toMatchObject({ ok: true, changed: false });
    expect(await restoreMessage(db, 999_999, "admin", signer)).toEqual({ ok: false, error: "NOT_FOUND" });
    const log = await moderationLog(db);
    expect(log.map((l) => l.action)).toEqual(["chat.restore", "chat.hide"]);
    expect(log.find((l) => l.action === "chat.hide")?.detail).toMatchObject({ memberId: m, reason: "abuse" });
  });

  it("the admin's view includes hidden messages, the real member id and who is muted — and pages by id", async () => {
    const a = await seedEligibleMember(db, { id: 5041 });
    const b = await seedEligibleMember(db, { id: 5042 });
    const first = okMessage(await send(a, "visible"));
    const second = okMessage(await send(b, "hidden one"));
    await hideMessage(db, second.id, "admin");
    await muteMember(db, { memberId: b, minutes: 30, reason: "private note" }, "admin");
    const view = await adminMessages(db, { limit: 10 });
    expect(view.messages.map((x) => ({ id: x.id, hidden: x.hidden, memberId: x.memberId, muted: x.muted }))).toEqual([
      { id: second.id, hidden: true, memberId: b, muted: true },
      { id: first.id, hidden: false, memberId: a, muted: false },
    ]);
    expect((await adminMessages(db, { before: second.id })).messages.map((x) => x.id)).toEqual([first.id]);
    const mutes = await activeMutes(db);
    expect(mutes[0]).toMatchObject({ memberId: b, permanent: false, reason: "private note", by: "admin" });
    // a timed mute that ran out is no longer listed
    await db.query("update public.arena_chat_mutes set muted_until = now() - interval '1 second'");
    expect(await activeMutes(db)).toEqual([]);
  });

  it("every moderation action leaves an append-only audit row, and the public page never contains a reason", async () => {
    const m = await seedEligibleMember(db, { id: 5043 });
    const msg = okMessage(await send(m, "hello"));
    await muteMember(db, { memberId: m, permanent: true, reason: "SECRET-REASON" }, "admin");
    await unmuteMember(db, m, "admin");
    await hideMessage(db, msg.id, "admin", "SECRET-REASON");
    expect((await moderationLog(db)).map((l) => l.action)).toEqual(["chat.hide", "chat.unmute", "chat.mute"]);
    expect(JSON.stringify(await readPage(db, signer))).not.toContain("SECRET-REASON");
    expect(JSON.stringify(await youOf(db, m, signer))).not.toContain("SECRET-REASON");
    await expect(db.query("delete from public.admin_audit_log where action like 'chat.%'")).rejects.toThrow();
  });
});
