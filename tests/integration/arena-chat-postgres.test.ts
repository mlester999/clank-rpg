import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "@/server/db/migrate";
import { createPostgresDb } from "@/server/db/postgres";
import type { Db } from "@/server/db/types";
import { createChatSigner } from "@/server/chat/signing";
import { readPage, resetChatCaches, sendMessage, type SendResult } from "@/server/chat/service";
import { seedReferenceData } from "@/server/seed/reference";

import { SUPABASE_ROLE_SHIM } from "../support/db";

/**
 * REAL concurrency for the Arena Chat: this suite runs only against a real Postgres (PGlite has ONE connection, so "simultaneous" sends there are merely
 * queued). Point CLANK_TEST_PG_URL at a THROWAWAY server (it creates and drops its own database):
 *
 *   CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5571/postgres pnpm exec vitest run tests/integration/arena-chat-postgres.test.ts
 *
 * What must hold with many connections writing at once: every message stored exactly once; ids issued in COMMIT order (a reader that has seen id N has seen
 * every smaller id, so "give me what is after N" can never skip a message); the per-member limits cannot be raced; and a pool of ONE connection (production)
 * never needs a second one inside a send (that would be a deadlock).
 */
const url = process.env.CLANK_TEST_PG_URL;
const signer = createChatSigner("x".repeat(40));

describe.skipIf(!url)("the Arena Chat with REAL parallel connections", () => {
  let admin: Db;
  let db: Db;
  let dbName: string;
  let seq = 0;
  const nonce = () => `pg${(++seq).toString(36).padStart(10, "0")}`;

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_chat_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString(), { maxConnections: 24 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await seedReferenceData(db);
    await db.query("insert into public.telegram_users (telegram_user_id, display_name) select 9000000 + g, 'Member ' || g from generate_series(1, 400) g");
  }, 180_000);
  afterAll(async () => {
    await db?.close();
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
  });
  const reset = async () => {
    await db.exec("truncate public.arena_chat_messages, public.arena_chat_mutes restart identity");
    resetChatCaches();
  };

  it("200 members sending at once over 24 connections: every message stored once, no deadlock, ids in commit order", async () => {
    await reset();
    const members = Array.from({ length: 200 }, (_, i) => 9_000_001 + i);
    const results = await Promise.all(members.map((m) => sendMessage(db, m, `hello from ${m}`, nonce(), signer)));
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await db.query<{ id: number; created_at: Date; sender_member_id: number }>("select id, created_at, sender_member_id from public.arena_chat_messages order by id");
    expect(rows).toHaveLength(200);
    expect(new Set(rows.map((r) => r.sender_member_id)).size).toBe(200);
    const times = rows.map((r) => new Date(r.created_at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times); // the id order IS the clock order
  });

  it("a reader following 'after the last id I saw' while writers hammer the room never skips a message", async () => {
    await reset();
    const writers = Array.from({ length: 60 }, (_, i) => 9_000_201 + i);
    let stop = false;
    const seen: number[] = [];
    let cursor = 0;
    const reader = (async () => {
      while (!stop) {
        // a fresh page every time (the 1 s read cache is bypassed by asking at different "now" values)
        const page = await readPage(db, signer, { after: cursor, limit: 100 }, Date.now() + seen.length * 5_000);
        for (const m of page.messages) {
          seen.push(m.id);
          cursor = Math.max(cursor, m.id);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    for (let wave = 0; wave < 3; wave++) {
      await Promise.all(writers.map((m) => sendMessage(db, m, `wave ${wave} from ${m}`, nonce(), signer)));
      // within a member the 3 s gap would refuse the next wave: age them out (as time would)
      await db.exec("update public.arena_chat_messages set created_at = created_at - interval '10 seconds'");
    }
    await new Promise((r) => setTimeout(r, 60));
    stop = true;
    await reader;
    const all = (await db.query<{ id: number }>("select id from public.arena_chat_messages order by id")).map((r) => r.id);
    expect(all).toHaveLength(180);
    expect(new Set(seen).size).toBe(seen.length); // no message delivered twice
    expect([...new Set(seen)].sort((a, b) => a - b)).toEqual(all); // …and none skipped
  });

  it("the same member racing with 12 simultaneous sends gets exactly one message; the limits cannot be raced", async () => {
    await reset();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => sendMessage(db, 9_000_300, `race ${i}`, nonce(), signer)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === "TOO_FAST")).toHaveLength(11);
    expect((await db.query("select 1 from public.arena_chat_messages")).length).toBe(1);
  });

  it("the same request retried in parallel (a double-clicked Send) is one message, and every attempt is answered with it", async () => {
    await reset();
    const n = nonce();
    const results = await Promise.all(Array.from({ length: 10 }, () => sendMessage(db, 9_000_301, "double click", n, signer)));
    expect(results.every((r) => r.ok)).toBe(true);
    const ids = new Set((results as Array<Extract<SendResult, { ok: true }>>).map((r) => r.message.id));
    expect(ids.size).toBe(1);
    expect((await db.query("select 1 from public.arena_chat_messages")).length).toBe(1);
  });

  it("with a pool of ONE connection (production's setting) a burst of sends completes — nothing inside a send needs a second connection", async () => {
    await reset();
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    const one = createPostgresDb(u.toString(), { maxConnections: 1, queryTimeoutMs: 20_000, transactionTimeoutMs: 40_000 });
    try {
      const results = await Promise.all(Array.from({ length: 80 }, (_, i) => sendMessage(one, 9_000_400 - i, `one connection ${i}`, nonce(), signer)));
      expect(results.every((r) => r.ok)).toBe(true);
      const reads = await Promise.all(Array.from({ length: 30 }, () => readPage(one, signer, {})));
      expect(reads.every((p) => p.messages.length === 50)).toBe(true);
      const active = await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [dbName]);
      expect(active[0]!.n).toBeLessThanOrEqual(25); // never more than the pools hold open (24 here + this one)
    } finally {
      await one.close();
    }
  });

  it("history reads are ONE bounded statement even when many arrive together", async () => {
    await reset();
    await db.query("insert into public.arena_chat_messages (sender_member_id, body, client_nonce) select 9000001 + (g % 50), 'm' || g, 'bulk' || lpad(g::text, 6, '0') from generate_series(1, 400) g");
    let statements = 0;
    const counting = { ...db, query: (...a: Parameters<Db["query"]>) => { statements++; return db.query(...a); } } as Db;
    const t = Date.now();
    const pages = await Promise.all(Array.from({ length: 100 }, () => readPage(counting, signer, {}, t)));
    expect(statements).toBe(1);
    expect(pages.every((p) => p.messages.length === 50 && p.hasMore)).toBe(true);
    const plan = await db.query<{ "QUERY PLAN": string }>("explain select m.id from public.arena_chat_messages m where m.deleted_at is null order by m.id desc limit 51");
    expect(plan.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/Index/); // the keyset is served by an index, never a table scan + sort
  });

  it("every statement of a send and of a read stays an index probe on a LARGE room (100 000 messages): a quiet member never costs a table walk", async () => {
    await reset();
    await db.query("insert into public.arena_chat_messages (sender_member_id, body, client_nonce, created_at) select 9000001 + (g % 300), 'bulk ' || g, 'big' || lpad(g::text, 8, '0'), now() - (g * interval '2 seconds') from generate_series(100000, 1, -1) g");
    await db.exec("analyze public.arena_chat_messages");
    const explain = async (sql: string, params: unknown[]) => {
      const rows = await db.query<{ "QUERY PLAN": string }>(`explain (analyze, buffers, costs off, timing off) ${sql}`, params);
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    };
    // the member's last minute (rate limit + repeat check): this member's rows are all old, so only the (member, created_at) index can answer without a walk
    const recent = await explain("select (extract(epoch from (statement_timestamp() - created_at)) * 1000)::int as age_ms, body from public.arena_chat_messages where sender_member_id = $1 and created_at > statement_timestamp() - make_interval(secs => $2::float8) order by created_at desc, id desc limit $3", [9_000_007, 60, 10]);
    expect(recent).toMatch(/arena_chat_messages_sender_idx/);
    expect(recent).toMatch(/Index Cond: \(\(sender_member_id = [^)]*\) AND \(created_at > /); // the minute is part of the index condition: only the last minute's rows are even read
    expect(recent).not.toMatch(/Rows Removed by Filter/);
    expect(recent).not.toMatch(/Seq Scan/);
    // the idempotency lookup, the latest page and a deep older page
    expect(await explain("select id, created_at, body, rev from public.arena_chat_messages where sender_member_id = $1 and client_nonce = $2", [9_000_007, "nothing-here"])).toMatch(/arena_chat_messages_sender_member_id_client_nonce_key/);
    const latest = await explain("select m.id from public.arena_chat_messages m where m.deleted_at is null and ($1::bigint is null or m.id < $1::bigint) order by m.id desc limit 51", [null]);
    expect(latest).toMatch(/Index Scan Backward/);
    expect(latest).not.toMatch(/Seq Scan/);
    const deep = await explain("select m.id from public.arena_chat_messages m where m.deleted_at is null and m.id < $1::bigint order by m.id desc limit 51", [50_000]);
    expect(deep).toMatch(/Index Scan Backward/);
    expect(deep).toMatch(/Buffers: shared hit=\d{1,2}\b/); // a handful of pages, wherever in the history the page is
  });
});
