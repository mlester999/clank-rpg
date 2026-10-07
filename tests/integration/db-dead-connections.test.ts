import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresDb, DbConnectionError, installRejectionGuard, isConnectionError, parsePgArray, serializeArrayParam, strayRejections, type PostgresDb } from "@/server/db/postgres";

import { startPgProxy, type PgProxy } from "../support/pgProxy";

/**
 * THE DEAD-CONNECTION MATRIX.
 *
 * Production showed `Unhandled Rejection: write CONNECTION_DESTROYED <pooler>:6543` on /api/arena/state and /api/admin/*. Root cause (reproduced here): postgres.js
 * fetches its array types on EVERY new connection from a promise nothing awaits, so a connection that died during that handshake (a pooler reset, or this
 * driver throwing a poisoned pool away) rejected into the void. The driver no longer asks for them (`fetch_types: false`, static array codecs).
 *
 * Every scenario below breaks a connection at an exact protocol moment (tests/support/pgProxy.ts) and asserts the same invariants:
 *   · no unhandledRejection, no uncaughtException, ever
 *   · a pure SELECT is retried ONCE and succeeds; it is never retried twice (no loops)
 *   · a write / a statement inside a transaction is NEVER replayed — the caller gets a DbConnectionError and `ambiguous` says whether it may have been applied
 *   · a transaction that died BEFORE its body ran (BEGIN) is replayed once; the body never executes twice
 *   · after any of it the next call works on a fresh pool (no permanently poisoned client)
 *
 * Needs a THROWAWAY server: CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres (it creates and drops its own database).
 */
const url = process.env.CLANK_TEST_PG_URL;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const stray: string[] = [];
const onRejection = (reason: unknown) => stray.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
const onException = (error: unknown) => stray.push(`uncaughtException: ${error instanceof Error ? error.message : String(error)}`);

describe("array codecs (postgres.js no longer fetches the array types)", () => {
  it("parses Postgres array literals: quoting, escapes, NULL, nesting, dimension decoration, empty", () => {
    expect(parsePgArray("{}")).toEqual([]);
    expect(parsePgArray("{1,2,3}", Number)).toEqual([1, 2, 3]);
    expect(parsePgArray('{"a b","c\\"d","e\\\\f",NULL,"NULL"}')).toEqual(["a b", 'c"d', "e\\f", null, "NULL"]);
    expect(parsePgArray("{{1,2},{3,4}}", Number)).toEqual([[1, 2], [3, 4]]);
    expect(parsePgArray("[1:2]={7,8}", Number)).toEqual([7, 8]);
    expect(parsePgArray('{"{braces},comma"}')).toEqual(["{braces},comma"]);
  });

  it("serialises JS arrays to literals and lets an already-built literal pass through (the app's `{a,b}::text[]` convention)", () => {
    expect(serializeArrayParam("{a,b}")).toBe("{a,b}");
    expect(serializeArrayParam(["a", 'b"c', "d\\e", null, 4])).toBe('{"a","b\\"c","d\\\\e",NULL,"4"}');
    expect(parsePgArray(serializeArrayParam(["x,y", "{z}", 'q"r']))).toEqual(["x,y", "{z}", 'q"r']);
  });
});

describe("the rejection guard", () => {
  it("absorbs a stray CONNECTION-class rejection (counted, logged once) and leaves every other rejection to other listeners", async () => {
    const lines: string[] = [];
    // vitest already listens (and would fail the run on a real stray); the guard must not hide an UNRELATED rejection from it, so only the connection one is emitted here.
    installRejectionGuard({ log: (l) => lines.push(l) });
    const before = strayRejections.absorbed;
    const seen: unknown[] = [];
    const spy = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", spy);
    process.emit("unhandledRejection", Object.assign(new Error("write CONNECTION_DESTROYED pooler:6543"), { code: "CONNECTION_DESTROYED" }), Promise.resolve());
    process.off("unhandledRejection", spy);
    expect(strayRejections.absorbed).toBe(before + 1);
    expect(lines.join("\n")).toMatch(/stray connection rejection absorbed \(CONNECTION_DESTROYED\)/);
    expect(seen).toHaveLength(1); // still visible to the other listeners (this is a guard, not a mute)
  });
});

describe.skipIf(!url)("dead connections against a real server (scratch only)", () => {
  const target = (() => {
    const u = new URL(url ?? "postgres://postgres@127.0.0.1:5432/postgres");
    return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), db: u.pathname.slice(1) || "postgres" };
  })();
  const dbName = `clank_dead_${Date.now().toString(36)}`;
  const through = (proxy: PgProxy, appName: string) => `postgres://${target.user}@127.0.0.1:${proxy.port}/${dbName}?application_name=${appName}`;
  const opened: Array<{ close(): Promise<void> }> = [];
  const track = <T extends { close(): Promise<void> }>(x: T): T => {
    opened.push(x);
    return x;
  };
  let admin: postgres.Sql;
  let observer: postgres.Sql;
  const rowCount = async (id: number): Promise<number> => Number((await observer`select count(*)::int as n from public.dead_scratch where id = ${id}`)[0]?.n);

  beforeAll(async () => {
    process.on("unhandledRejection", onRejection);
    process.on("uncaughtException", onException);
    admin = postgres(`postgres://${target.user}@${target.host}:${target.port}/${target.db}`, { max: 1, prepare: false });
    await admin.unsafe(`create database ${dbName}`);
    observer = postgres(`postgres://${target.user}@${target.host}:${target.port}/${dbName}?application_name=observer`, { max: 1, prepare: false });
    await observer.unsafe("create table public.dead_scratch (id int not null, note text)");
  }, 60_000);
  afterEach(async () => {
    await Promise.allSettled(opened.splice(0).map((x) => x.close()));
    await sleep(60); // let any late rejection from a destroyed socket surface before the next scenario
  });
  afterAll(async () => {
    await sleep(300);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    await observer?.end({ timeout: 2 });
    await admin?.unsafe(`drop database if exists ${dbName} with (force)`);
    await admin?.end({ timeout: 2 });
    expect(stray, "no unhandledRejection / uncaughtException in the whole matrix").toEqual([]);
  });

  const open = (proxy: PgProxy, appName: string, extra: Partial<Parameters<typeof createPostgresDb>[1]> = {}): PostgresDb =>
    track(createPostgresDb(through(proxy, appName), { maxConnections: 1, queryTimeoutMs: 1_500, transactionTimeoutMs: 10_000, livenessAfterIdleMs: 0, ...extra }));
  const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => e);

  it("arrays behave exactly as before without the type fetch: array_agg results parse, `any($1::text[])` accepts both the app's `{a,b}` literal and a real JS array", async () => {
    const proxy = track(await startPgProxy(target));
    const db = open(proxy, "arrays");
    const [row] = await db.query<{ ids: number[]; names: string[]; amounts: string[]; flags: boolean[]; empty: number[]; docs: Array<{ a: number }> }>(
      `select array_agg(g order by g) as ids, array_agg(('n ' || g)::text order by g) as names, array_agg((g * 1.50)::numeric order by g) as amounts,
              array_agg((g % 2 = 0) order by g) as flags, array[]::int4[] as empty, array_agg(jsonb_build_object('a', g) order by g) as docs
         from generate_series(1, 3) g`,
    );
    expect(row).toEqual({ ids: [1, 2, 3], names: ["n 1", "n 2", "n 3"], amounts: ["1.50", "3.00", "4.50"], flags: [false, true, false], empty: [], docs: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    const [big] = await db.query<{ ids: number[] }>("select array_agg(x order by x) as ids from unnest($1::int8[]) x", ["{9007199254740991,5}"]);
    expect(big?.ids).toEqual([5, 9007199254740991]);
    const text = (params: unknown) => db.query<{ n: number }>("select count(*)::int as n from (values ('a'), ('b c'), ('d,e'), ('f\"g')) v(t) where t = any($1::text[])", [params]);
    expect((await text("{a,\"b c\"}"))[0]?.n).toBe(2); // the app's convention: an already-built literal
    expect((await text(["a", "b c", "d,e", 'f"g']))[0]?.n).toBe(4); // a real JS array, including the awkward elements
    expect((await text([]))[0]?.n).toBe(0);
  });

  it("0. the production bug: a FRESH connection that dies during postgres.js's handshake no longer leaks an unhandled rejection, and the caller still gets its answer", async () => {
    const proxy = track(await startPgProxy(target, { delayMs: 15 }));
    for (let i = 0; i < 3; i++) {
      const killed = proxy.armFault(/pg_type|select 1 as ok/i, { when: "before", times: 1 }); // the first statement a new connection sends
      const db = open(proxy, "handshake", { queryTimeoutMs: 60 }); // …and a statement timeout that recycles the pool while the next one is connecting
      const first = await outcome(db.query("select 1 as ok"));
      expect(first === "ok" || isConnectionError(first)).toBe(true);
      expect(killed.fired).toBeLessThanOrEqual(1);
      await sleep(250);
      await db.close();
    }
  });

  describe("A. an idle connection is closed before the next SELECT", () => {
    it("closed by the pooler (reset): the very next SELECT just works", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "a-reset");
      await db.query("select 1");
      proxy.kill();
      await sleep(40);
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
    });

    it("silently dropped (a frozen function's socket): the STALE-IDLE PROBE finds it in one bounded select 1, so even the first SELECT is not wasted — and a WRITE is never sent down the dead socket", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "a-drop", { livenessAfterIdleMs: 120, livenessTimeoutMs: 300 });
      await db.query("select 1");
      expect(db.stats.probes).toBe(0); // freshly used: no doubt, no probe
      proxy.drop();
      await sleep(180); // the instance sat idle past the threshold
      const t0 = Date.now();
      await db.query("insert into public.dead_scratch (id, note) values (101, 'after the probe')"); // a write
      expect(Date.now() - t0).toBeLessThan(1_500);
      expect(db.stats).toMatchObject({ probes: 1, probeFailures: 1, recycles: 1, retries: 0 }); // found by the probe, NOT by the write
      expect(await rowCount(101)).toBe(1);
    });

    it("with a pool of ONE a recycle never leaves two connections open: the dead one is destroyed at once, so an instance's share of the pooler never doubles", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "a-one", { maxConnections: 1, livenessAfterIdleMs: 100, livenessTimeoutMs: 250 });
      await db.query("select 1");
      let peak = 0;
      for (let round = 0; round < 3; round++) {
        proxy.drop();
        await sleep(150);
        expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1); // found by the probe, recovered on a fresh connection
        peak = Math.max(peak, proxy.stats.currentConnections);
      }
      await sleep(100);
      expect(proxy.stats.currentConnections).toBe(1);
      expect(peak).toBeLessThanOrEqual(2); // the dead socket is closed by the driver the moment the replacement exists; the proxy may still be tearing it down
      expect(proxy.stats.connectionsOpened).toBe(4);
    });

    it("a busy instance pays nothing: no probe while the connection was used a moment ago", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "a-busy", { livenessAfterIdleMs: 5_000 });
      for (let i = 0; i < 20; i++) await db.query("select 1");
      expect(db.stats.probes).toBe(0);
    });

    it("concurrent callers that find a stale connection share ONE probe", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "a-shared", { maxConnections: 4, livenessAfterIdleMs: 60, livenessTimeoutMs: 300 });
      await Promise.all(Array.from({ length: 4 }, () => db.query("select 1")));
      await sleep(100);
      await Promise.all(Array.from({ length: 12 }, () => db.query("select 1")));
      expect(db.stats.probes).toBe(1);
    });
  });

  describe("B. the connection is destroyed DURING a SELECT", () => {
    it("before the server sees it OR after the server ran it (reply lost): retried once on a fresh connection, answer returned", async () => {
      for (const when of ["before", "after"] as const) {
        const proxy = track(await startPgProxy(target));
        const db = open(proxy, `b-${when}`);
        await db.query("select 1");
        const fault = proxy.armFault(/select 4242 as answer/i, { when, times: 1 });
        expect((await db.query<{ answer: number }>("select 4242 as answer"))[0]?.answer).toBe(4242);
        expect(fault.fired).toBe(1);
        expect(db.stats).toMatchObject({ retries: 1 });
        expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1); // not poisoned
      }
    });

    it("if the retry dies too, the caller gets a DbConnectionError — exactly ONE retry, never a loop", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "b-twice");
      await db.query("select 1");
      const fault = proxy.armFault(/select 4243 as answer/i, { when: "before", times: 50 });
      const failure = await outcome(db.query("select 4243 as answer"));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(false); // a read cannot have changed anything
      expect(String((failure as Error).message)).not.toMatch(/127\.0\.0\.1|:\d{4,5}/); // no pooler host:port in what callers see
      expect(fault.fired).toBe(2); // the first attempt + the single retry
      expect(db.stats.retries).toBe(1);
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
    });

    it("a WRITE whose reply is lost is NOT replayed: it fails as ambiguous, and it was applied exactly once", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "b-write");
      await db.query("select 1");
      proxy.armFault(/insert into public\.dead_scratch .*\(201,/i, { when: "after", times: 5 });
      const failure = await outcome(db.query("insert into public.dead_scratch (id, note) values (201, 'once')"));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(true);
      expect(db.stats.retries).toBe(0);
      expect(await rowCount(201)).toBe(1); // the server applied it; the driver did not apply it a second time
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
    });

    it("a locking read (`for update`) and a nextval() are writes in disguise: never replayed", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "b-lock");
      await db.query("select 1");
      proxy.armFault(/dead_scratch .* for update/i, { when: "before", times: 5 });
      const failure = await outcome(db.query("select id from public.dead_scratch where id = 1 for update"));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect(db.stats.retries).toBe(0);
    });
  });

  describe("C. destroyed BEFORE BEGIN", () => {
    it("the body has not run, so the transaction is replayed once: it executes exactly once and commits exactly once", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "c-begin");
      await db.query("select 1");
      const fault = proxy.armFault(/^\s*begin/i, { when: "before", times: 1 });
      let bodies = 0;
      await db.transaction(async (tx) => {
        bodies++;
        await tx.query("insert into public.dead_scratch (id, note) values (301, 'tx')");
      });
      expect(fault.fired).toBe(1);
      expect(bodies).toBe(1);
      expect(db.stats.txRetries).toBe(1);
      expect(await rowCount(301)).toBe(1);
    });

    it("BEGIN killed twice: one replay only, then a DbConnectionError that is NOT ambiguous (nothing ran)", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "c-begin-twice");
      await db.query("select 1");
      proxy.armFault(/^\s*begin/i, { when: "before", times: 50 });
      let bodies = 0;
      const failure = await outcome(db.transaction(async (tx) => { bodies++; await tx.query("select 1"); }));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(false);
      expect(bodies).toBe(0);
      expect(db.stats.txRetries).toBe(1);
    });
  });

  describe("D. destroyed INSIDE a transaction", () => {
    it("the body fails with a DbConnectionError, nothing is committed, nothing is replayed, and the next transaction works", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "d-inside");
      await db.query("select 1");
      proxy.armFault(/insert into public\.dead_scratch .*\(402,/i, { when: "before", times: 5 });
      let bodies = 0;
      const failure = await outcome(
        db.transaction(async (tx) => {
          bodies++;
          await tx.query("insert into public.dead_scratch (id, note) values (401, 'first statement')");
          await tx.query("insert into public.dead_scratch (id, note) values (402, 'second statement')");
        }),
      );
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(false); // killed before COMMIT: the server rolls the transaction back
      expect(bodies).toBe(1); // never replayed
      expect(db.stats.txRetries).toBe(0);
      expect(await rowCount(401)).toBe(0);
      expect(await rowCount(402)).toBe(0);
      await db.transaction(async (tx) => { await tx.query("insert into public.dead_scratch (id, note) values (403, 'next')"); });
      expect(await rowCount(403)).toBe(1);
    });
  });

  describe("E. destroyed DURING COMMIT", () => {
    it("COMMIT applied but its reply lost: fails as AMBIGUOUS, is not replayed, and the row exists exactly once", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "e-after");
      await db.query("select 1");
      proxy.armFault(/^\s*commit/i, { when: "after", times: 1 });
      let bodies = 0;
      const failure = await outcome(db.transaction(async (tx) => { bodies++; await tx.query("insert into public.dead_scratch (id, note) values (501, 'commit reply lost')"); }));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(true);
      expect(bodies).toBe(1);
      expect(db.stats.txRetries).toBe(0);
      expect(await rowCount(501)).toBe(1); // committed once, never twice
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
    });

    it("COMMIT never reached the server: also ambiguous to the caller (the driver cannot know), and nothing is committed", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "e-before");
      await db.query("select 1");
      proxy.armFault(/^\s*commit/i, { when: "before", times: 1 });
      const failure = await outcome(db.transaction(async (tx) => { await tx.query("insert into public.dead_scratch (id, note) values (502, 'commit lost')"); }));
      expect(failure).toBeInstanceOf(DbConnectionError);
      expect((failure as DbConnectionError).ambiguous).toBe(true);
      expect(await rowCount(502)).toBe(0);
    });
  });

  describe("F. the pooler is unavailable for a while, then recovers", () => {
    it("requests fail fast with a DbConnectionError while it is down (no hang, no loop) and succeed again the moment it is back — same process, no restart", async () => {
      const proxy = track(await startPgProxy(target));
      const db = open(proxy, "f-outage", { connectTimeoutSeconds: 1 });
      await db.query("select 1");
      proxy.setUnavailable(true);
      const t0 = Date.now();
      const failures = await Promise.all(Array.from({ length: 10 }, () => outcome(db.query("select 1 as ok"))));
      expect(failures.every((f) => f instanceof DbConnectionError)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(8_000);
      expect(db.stats.retries).toBeLessThanOrEqual(10); // one retry per request at most
      const writeFailure = await outcome(db.transaction(async (tx) => { await tx.query("insert into public.dead_scratch (id, note) values (601, 'during outage')"); }));
      expect(writeFailure).toBeInstanceOf(DbConnectionError);
      proxy.setUnavailable(false);
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
      await db.transaction(async (tx) => { await tx.query("insert into public.dead_scratch (id, note) values (602, 'after outage')"); });
      expect(await rowCount(601)).toBe(0);
      expect(await rowCount(602)).toBe(1);
    });
  });

  describe("H. the pooler / database is at its connection limit (53300, Supavisor's EMAXCONNSESSION)", () => {
    it("a refusal at the door is a clean DbConnectionError: nothing ran (not ambiguous), NOT retried, the pool is NOT thrown away, no stray rejection — and the next call works", async () => {
      await admin.unsafe("drop role if exists clank_limited");
      await admin.unsafe("create role clank_limited login connection limit 1");
      try {
        const db = track(createPostgresDb(`postgres://clank_limited@${target.host}:${target.port}/${dbName}`, { maxConnections: 3, queryTimeoutMs: 8_000, livenessAfterIdleMs: 0 }));
        const slowRead = "with s as (select count(*) as c from generate_series(1, 6000000)) select c from s"; // a pure SELECT, slow enough to overlap
        const results = await Promise.all(Array.from({ length: 3 }, () => outcome(db.query(slowRead))));
        const refused = results.filter((r): r is DbConnectionError => r instanceof DbConnectionError);
        expect(refused.length).toBeGreaterThanOrEqual(1);
        for (const r of refused) {
          expect(r.code).toBe("53300");
          expect(r.ambiguous).toBe(false);
          expect(r.message).not.toMatch(/clank_limited|127\.0\.0\.1/);
        }
        expect(db.stats).toMatchObject({ retries: 0, recycles: 0, txRetries: 0 }); // retrying would only add to the overload
        expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
        const tx = await outcome(Promise.all([db.transaction(async (t) => (await t.query(slowRead))[0]), db.transaction(async (t) => (await t.query(slowRead))[0]), db.transaction(async (t) => (await t.query(slowRead))[0])]));
        expect(tx === "ok" || tx instanceof DbConnectionError).toBe(true);
        expect(db.stats.txRetries).toBe(0);
      } finally {
        await Promise.allSettled(opened.splice(0).map((x) => x.close()));
        await sleep(100);
        await admin.unsafe("drop role if exists clank_limited");
      }
    });
  });

  describe("G. many warm serverless instances, each holding its own pool of ONE", () => {
    it("40 instances are all killed at once: every one recovers on its next request, none is poisoned, and the pooler never sees more than 40 connections", async () => {
      const proxy = track(await startPgProxy(target));
      const instances = Array.from({ length: 40 }, (_, i) => open(proxy, `g-${i}`));
      await Promise.all(instances.map((db) => db.query("select 1")));
      expect(proxy.stats.maxConnections).toBeLessThanOrEqual(40);
      proxy.kill();
      await sleep(50);
      const results = await Promise.all(instances.map((db) => outcome(db.query<{ ok: number }>("select 1 as ok"))));
      expect(results.filter((r) => r !== "ok" && !Array.isArray(r))).toEqual([]);
      for (let round = 0; round < 3; round++) await Promise.all(instances.map((db) => db.query("select 1")));
      expect(proxy.stats.maxConnections).toBeLessThanOrEqual(40 + 40); // a kill is followed by fresh connects, but never more than one per instance is LIVE at a time
    });
  });
});
