import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPostgresDb, DbConnectionError, Gate, isConnectionError, isRetryableRead, type PostgresDb } from "@/server/db/postgres";

import { startPgProxy, type PgProxy } from "../support/pgProxy";

/**
 * THE POSTGRES DRIVER UNDER A SERVERLESS TRANSACTION POOLER.
 *
 * Production incident: behind the Supabase Transaction Pooler, database-backed routes hung until the platform killed them (504 after 60 s / 300 s).
 * Causes, each pinned here:
 *   1. postgres.js PIPELINES statements on a busy connection (up to 100 in flight); a shared transaction pooler can lose such a batch, so the query
 *      never answers. The driver now guarantees at most ONE statement in flight per connection (Gate + sequential statements in a transaction).
 *   2. A connection that dies silently (idle drop, frozen function) made every query hang forever — there was no timeout. The driver now times
 *      statements out, throws the pool away and retries a pure SELECT once.
 *   3. (seed / getReadyDb: see seed-fast-path.test.ts)
 *
 * The real-Postgres half needs a THROWAWAY server: CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres. It runs SELECTs and advisory
 * locks only. The proxy EMULATES the pooler behaviours (it is not Supavisor): it measures pipelining and can swallow a pipelined batch / silently
 * drop connections.
 */
const url = process.env.CLANK_TEST_PG_URL;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Gate", () => {
  it("never runs more than `limit` operations at once, serves the rest in order and always releases its slot", async () => {
    const gate = new Gate(3);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (i: number, fail = false) =>
      gate.run(async () => {
        active++;
        peak = Math.max(peak, active);
        order.push(i);
        await sleep(5);
        active--;
        if (fail) throw new Error(`task ${i} failed`);
        return i;
      });
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => task(i, i % 5 === 4)));
    expect(peak).toBe(3);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // first come, first served
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
    expect(gate.inFlight).toBe(0);
    expect(gate.queued).toBe(0);
    expect(await gate.run(async () => "still usable")).toBe("still usable");
  });
});

describe("what may be retried, and what means 'the connection is gone'", () => {
  it("retries only pure reads", () => {
    for (const ok of ["select 1", "  SELECT * from public.characters where id = $1", "with x as (select 1) select * from x"]) expect(isRetryableRead(ok), ok).toBe(true);
    for (const no of [
      "insert into t values (1)",
      "update public.arena_state set status = 'PAUSED'",
      "select status from public.arena_state where id = 1 for update",
      "select id from t for no key update",
      "select pg_advisory_xact_lock($1::bigint)",
      "select nextval('s')",
      "select set_config('clank.allow_class_change', 'on', true)",
      "with moved as (delete from t returning *) select * from moved",
      "delete from t",
      "begin",
    ]) {
      expect(isRetryableRead(no), no).toBe(false);
    }
    expect(isRetryableRead("select updated_at, last_update from t")).toBe(true); // column names are not statements
  });

  it("recognises connection-class errors only", () => {
    for (const code of ["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECT_TIMEOUT", "ECONNRESET", "EPIPE", "57P01"]) expect(isConnectionError(Object.assign(new Error("x"), { code })), code).toBe(true);
    expect(isConnectionError(new DbConnectionError("hung", "CONNECTION_TIMEOUT"))).toBe(true);
    for (const code of ["23505", "42P01", "22012", "40P01"]) expect(isConnectionError(Object.assign(new Error("x"), { code })), code).toBe(false);
    expect(isConnectionError(new Error("plain"))).toBe(false);
    expect(isConnectionError(null)).toBe(false);
  });
});

describe.skipIf(!url)("createPostgresDb against a real server, behind the pooler emulation", () => {
  const target = (() => {
    const u = new URL(url ?? "postgres://postgres@127.0.0.1:5432/postgres");
    return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), db: u.pathname.slice(1) || "postgres" };
  })();
  const through = (proxy: PgProxy, appName: string) => `postgres://${target.user}@127.0.0.1:${proxy.port}/${target.db}?application_name=${appName}`;
  const opened: Array<{ close(): Promise<void> }> = [];
  let observer: postgres.Sql;
  const track = <T extends { close(): Promise<void> }>(x: T): T => {
    opened.push(x);
    return x;
  };

  beforeAll(() => {
    observer = postgres(`postgres://${target.user}@${target.host}:${target.port}/${target.db}?application_name=observer`, { max: 1, prepare: false });
  });
  afterEach(async () => {
    await Promise.allSettled(opened.splice(0).map((x) => x.close()));
  });
  afterAll(async () => {
    await observer?.end({ timeout: 2 });
  });

  const readAll = (db: PostgresDb, n: number) => Promise.all(Array.from({ length: n }, () => db.query<{ n: number }>("select count(*)::int as n from pg_catalog.pg_class")));

  it("CONTROL: plain postgres.js pipelines a saturated pool — and behind a pooler that loses pipelined batches those queries never answer", async () => {
    const proxy = await startPgProxy(target, { mode: "pipeline-hang" });
    track(proxy);
    const sql = postgres(through(proxy, "control"), { max: 5, prepare: false, idle_timeout: 20, connect_timeout: 15 });
    await Promise.all(Array.from({ length: 5 }, () => sql.unsafe("select 1")));
    proxy.resetStats();
    let answered = 0;
    for (let i = 0; i < 50; i++) void sql.unsafe("select count(*)::int as n from pg_catalog.pg_class").then(() => answered++, () => answered++);
    await sleep(1500);
    expect(proxy.stats.pipelinedBatches).toBeGreaterThan(0);
    expect(answered).toBeLessThan(50); // hung
    void sql.end({ timeout: 0 });
  });

  it("50 concurrent reads: every one answers, none is ever pipelined, the pool is never larger than max", async () => {
    const proxy = track(await startPgProxy(target, { mode: "pipeline-hang", delayMs: 5 }));
    const db = track(createPostgresDb(through(proxy, "pipeline-free"), { maxConnections: 4, queryTimeoutMs: 20_000 }));
    await readAll(db, 4);
    proxy.resetStats();
    const rows = await readAll(db, 50);
    expect(rows).toHaveLength(50);
    expect(proxy.stats.maxInFlightOnOneConnection).toBe(1);
    expect(proxy.stats.pipelinedBatches).toBe(0);
    expect(proxy.stats.swallowedBatches).toBe(0);
    expect(proxy.stats.maxConnections).toBeLessThanOrEqual(4);
  });

  it("mixed parameterised / parameterless reads and transactions with Promise.all inside never pipeline either", async () => {
    const proxy = track(await startPgProxy(target, { mode: "pipeline-hang", delayMs: 3 }));
    const db = track(createPostgresDb(through(proxy, "mixed"), { maxConnections: 3, queryTimeoutMs: 20_000 }));
    await readAll(db, 3);
    proxy.resetStats();
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => db.query("select $1::int as n", [i])),
      ...Array.from({ length: 20 }, () => db.query("select count(*)::int as n from pg_catalog.pg_class")),
      ...Array.from({ length: 6 }, () =>
        db.transaction(async (tx) => {
          const [a, b, c] = await Promise.all([tx.query<{ n: number }>("select 1 as n"), tx.query<{ n: number }>("select 2 as n"), tx.query<{ n: number }>("select 3 as n")]);
          expect([a?.[0]?.n, b?.[0]?.n, c?.[0]?.n]).toEqual([1, 2, 3]); // results still line up with their statements
        }),
      ),
    ]);
    expect(proxy.stats.maxInFlightOnOneConnection).toBe(1);
    expect(proxy.stats.pipelinedBatches).toBe(0);
    expect(proxy.stats.maxConnections).toBeLessThanOrEqual(3);
  });

  it("holds the database session count at the pool size however many requests arrive (no unbounded growth)", async () => {
    const appName = `cap-${Date.now().toString(36)}`;
    const db = track(createPostgresDb(`postgres://${target.user}@${target.host}:${target.port}/${target.db}?application_name=${appName}`, { maxConnections: 3 }));
    let peak = 0;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        const [row] = await observer`select count(*)::int as n from pg_stat_activity where application_name = ${appName}`;
        peak = Math.max(peak, Number(row?.n ?? 0));
        await sleep(15);
      }
    })();
    for (let round = 0; round < 5; round++) await readAll(db, 60); // repeated polling bursts
    stop = true;
    await watcher;
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("transaction-scoped advisory locks keep their meaning through the driver: a second transaction waits for the first to commit", async () => {
    const db = track(createPostgresDb(`postgres://${target.user}@${target.host}:${target.port}/${target.db}`, { maxConnections: 4, queryTimeoutMs: 20_000 }));
    const key = 7_300_199;
    const events: string[] = [];
    const first = db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1::bigint)", [key]);
      events.push("first holds");
      await sleep(250);
      events.push("first commits");
    });
    await sleep(60);
    const second = db.transaction(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1::bigint)", [key]);
      events.push("second holds");
    });
    await Promise.all([first, second]);
    expect(events).toEqual(["first holds", "first commits", "second holds"]);
    // …and the lock is gone with the transaction (nothing leaks onto the pooled connection)
    const [held] = await observer`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${key}`;
    expect(Number(held?.n)).toBe(0);
  });

  it("a database error is an error, not a dead connection: no retry, no new pool", async () => {
    const db = track(createPostgresDb(`postgres://${target.user}@${target.host}:${target.port}/${target.db}`, { queryTimeoutMs: 5_000 }));
    await expect(db.query("select 1/0")).rejects.toMatchObject({ code: "22012" });
    await expect(db.transaction(async (tx) => tx.query("select * from public.no_such_table_anywhere"))).rejects.toMatchObject({ code: "42P01" });
    expect(db.stats).toMatchObject({ recycles: 0, retries: 0, timeouts: 0 });
    expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
  });

  it("keeps the type mapping: bigint → number, numeric → string, jsonb text round-trips", async () => {
    const db = track(createPostgresDb(`postgres://${target.user}@${target.host}:${target.port}/${target.db}`));
    const [row] = await db.query<{ big: number; num: string; doc: { a: number } }>("select 5::bigint as big, 1.50::numeric as num, $1::jsonb as doc", [JSON.stringify({ a: 1 })]);
    expect(row).toEqual({ big: 5, num: "1.50", doc: { a: 1 } });
  });

  describe("a connection that dies silently (idle drop by the pooler, frozen function) — the old client hung forever", () => {
    it("a SELECT recovers on a fresh connection; a write fails fast and is NOT retried; the next call just works", async () => {
      const proxy = track(await startPgProxy(target));
      const db = track(createPostgresDb(through(proxy, "dead-select"), { maxConnections: 2, queryTimeoutMs: 400 }));
      await readAll(db, 2);
      proxy.drop();
      const t0 = Date.now();
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
      expect(Date.now() - t0).toBeLessThan(2_500);
      expect(db.stats).toMatchObject({ timeouts: 1, recycles: 1, retries: 1 });

      proxy.drop();
      const t1 = Date.now();
      const write = await db.query("select pg_sleep(0)").then(() => "ok", (e: unknown) => e);
      expect(write).toBeInstanceOf(DbConnectionError);
      expect(isConnectionError(write)).toBe(true);
      expect(Date.now() - t1).toBeLessThan(2_500);
      expect(db.stats.retries).toBe(1); // unchanged: a statement that may have written is never repeated

      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1); // the pool was replaced
    });

    it("a transaction whose BEGIN hits a dead connection is cut off within the statement timeout and — its body never having run — replayed ONCE on a fresh connection", async () => {
      const proxy = track(await startPgProxy(target));
      const db = track(createPostgresDb(through(proxy, "dead-tx"), { maxConnections: 2, queryTimeoutMs: 400, transactionTimeoutMs: 10_000, livenessAfterIdleMs: 0 }));
      await readAll(db, 2);
      proxy.drop();
      const t0 = Date.now();
      let bodies = 0;
      const result = await db.transaction(async (tx) => {
        bodies++;
        return (await tx.query<{ ok: number }>("select 1 as ok"))[0]?.ok;
      });
      expect(result).toBe(1);
      expect(bodies).toBe(1); // the first attempt died before BEGIN completed: its body never executed
      expect(db.stats.txRetries).toBe(1);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect(await db.transaction(async (tx) => (await tx.query<{ ok: number }>("select 1 as ok"))[0]?.ok)).toBe(1);
    });

    it("a statement that hangs INSIDE a transaction is cut off too (and the callback sees the error)", async () => {
      const proxy = track(await startPgProxy(target));
      const db = track(createPostgresDb(through(proxy, "dead-in-tx"), { maxConnections: 2, queryTimeoutMs: 400, transactionTimeoutMs: 10_000 }));
      await readAll(db, 2);
      const t0 = Date.now();
      const failure = await db
        .transaction(async (tx) => {
          await tx.query("select 1");
          proxy.drop(); // the connection dies mid-transaction
          await tx.query("select 2");
        })
        .then(() => "ok", (e: unknown) => e);
      expect(isConnectionError(failure)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(3_000);
      expect((await db.query<{ ok: number }>("select 1 as ok"))[0]?.ok).toBe(1);
    });

    it("without timeouts configured nothing is armed (scripts, migrations and long statements are unaffected)", async () => {
      const proxy = track(await startPgProxy(target));
      const db = track(createPostgresDb(through(proxy, "no-timeout"), { maxConnections: 2 }));
      const [row] = await db.query<{ ok: number }>("select 1 as ok, pg_sleep(0.6)");
      expect(row?.ok).toBe(1);
      expect(db.stats).toMatchObject({ recycles: 0, retries: 0, timeouts: 0 });
    });
  });
});
