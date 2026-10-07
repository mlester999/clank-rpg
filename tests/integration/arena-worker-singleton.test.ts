import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "@/server/db/migrate";
import { acquireSessionLock, createPostgresDb } from "@/server/db/postgres";
import type { Db } from "@/server/db/types";
import { ARENA_WORKER_LOCK_KEY } from "@/server/services/lifecycleLock";

import { SUPABASE_ROLE_SHIM } from "../support/db";

/**
 * ONE ARENA WORKER, PROVEN WITH REAL PROCESSES.
 *
 * `pnpm arena:worker` takes a session-level advisory lock on a dedicated connection before it does anything. Started five times at once against the same
 * database, exactly one of them holds it and runs; the other four exit with code 3 at once. If the winner's connection is cut (failover, a dropped
 * socket) it notices at its next heartbeat and exits with code 4 instead of carrying on unprotected — and the lock is free for a replacement. It also
 * refuses the transaction pooler outright (code 2): a session lock cannot live there.
 *
 * Needs a THROWAWAY server (CLANK_TEST_PG_URL=postgres://postgres@127.0.0.1:5498/postgres); it creates and drops its own database and only ever
 * reads the Arena (the scratch Arena is NOT_STARTED, so the workers have nothing to advance).
 */
const url = process.env.CLANK_TEST_PG_URL;
const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");

interface Worker {
  child: ChildProcess;
  out: string[];
  exited: Promise<number | null>;
  has(text: string): boolean;
}

describe.skipIf(!url)("the Arena worker is a singleton", () => {
  let admin: Db;
  let dbName: string;
  let dbUrl: string;
  let observer: postgres.Sql;
  const started: Worker[] = [];

  const spawnWorker = (databaseUrl = dbUrl): Worker => {
    const child = spawn(TSX, ["scripts/arena-worker.ts"], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl,
        CLANK_SKIP_ENV_FILES: "1", // never read the repository's real .env
        ARENA_WORKER_HEARTBEAT_MS: "250",
        SESSION_SECRET: "s".repeat(40),
        CLASS_ROLL_SECRET: "c".repeat(40),
        TELEGRAM_HASH_PEPPER: "p".repeat(40),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: string[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d.toString()));
    child.stderr?.on("data", (d: Buffer) => out.push(d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    const worker: Worker = { child, out, exited, has: (text) => out.join("").includes(text) };
    started.push(worker);
    return worker;
  };
  const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 30_000) => {
    const t0 = Date.now();
    while (!(await ok())) {
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const lockHolders = async () => Number((await observer`select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${ARENA_WORKER_LOCK_KEY}::oid and granted`)[0]?.n);

  beforeAll(async () => {
    admin = createPostgresDb(url as string, { maxConnections: 1 });
    dbName = `clank_worker_${Date.now().toString(36)}`;
    await admin.exec(`create database ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    dbUrl = u.toString();
    const db = createPostgresDb(dbUrl, { maxConnections: 2 });
    await db.exec(SUPABASE_ROLE_SHIM);
    await migrate(db);
    await db.close();
    observer = postgres(dbUrl, { max: 1, prepare: false });
  }, 180_000);
  afterAll(async () => {
    for (const w of started) w.child.kill("SIGKILL");
    await Promise.allSettled(started.map((w) => w.exited));
    await observer?.end({ timeout: 2 });
    if (admin) {
      await admin.exec(`drop database if exists ${dbName} with (force)`);
      await admin.close();
    }
  });

  it("five workers started at once: exactly ONE runs; the other four exit with code 3 and say why", async () => {
    const workers = Array.from({ length: 5 }, () => spawnWorker());
    await until("four losers to exit", () => workers.filter((w) => w.child.exitCode !== null).length >= 4, 60_000);
    const running = workers.filter((w) => w.child.exitCode === null);
    expect(running).toHaveLength(1);
    expect(running[0]!.has("singleton lock HELD")).toBe(true);
    for (const loser of workers.filter((w) => w !== running[0])) {
      expect(await loser.exited).toBe(3);
      expect(loser.has("ANOTHER Arena worker already holds the lock")).toBe(true);
      expect(loser.has("singleton lock HELD")).toBe(false); // it never started working
    }
    expect(await lockHolders()).toBe(1);

    // A sixth, later one is refused too while the first lives.
    const late = spawnWorker();
    expect(await late.exited).toBe(3);

    // The lock is lost when its connection is cut: the winner notices at the next heartbeat and stops (code 4) — it never carries on unprotected…
    await observer`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = 0 and objid = ${ARENA_WORKER_LOCK_KEY}::oid and granted`;
    expect(await running[0]!.exited).toBe(4);
    expect(running[0]!.has("LOCK LOST")).toBe(true);
    expect(await lockHolders()).toBe(0);

    // …and a replacement takes over cleanly, then a SIGTERM releases the lock (exit 0).
    const replacement = spawnWorker();
    await until("the replacement to hold the lock", () => replacement.has("singleton lock HELD"));
    expect(await lockHolders()).toBe(1);
    replacement.child.kill("SIGTERM");
    expect(await replacement.exited).toBe(0);
    expect(await lockHolders()).toBe(0);
  }, 180_000);

  it("refuses the TRANSACTION pooler (port 6543) before it touches anything", async () => {
    const pooled = new URL(dbUrl);
    pooled.port = "6543";
    const w = spawnWorker(pooled.toString());
    expect(await w.exited).toBe(2);
    expect(w.has("REFUSED")).toBe(true);
  }, 60_000);

  it("acquireSessionLock itself: a second taker gets null, release hands the lock over, and a lost connection fires onLost exactly once", async () => {
    const lost: string[] = [];
    const a = await acquireSessionLock(dbUrl, 7_300_199, { heartbeatMs: 100, onLost: (r) => lost.push(r) });
    expect(a?.held).toBe(true);
    expect(await acquireSessionLock(dbUrl, 7_300_199, { onLost: () => undefined })).toBeNull();
    await observer`select pg_terminate_backend(pid) from pg_locks where locktype = 'advisory' and classid = 0 and objid = 7300199::oid and granted`;
    await until("onLost", () => lost.length > 0, 10_000);
    await new Promise((r) => setTimeout(r, 400));
    expect(lost).toHaveLength(1);
    expect(a?.held).toBe(false);
    const b = await acquireSessionLock(dbUrl, 7_300_199, { onLost: () => undefined });
    expect(b?.held).toBe(true);
    await b?.release();
    const c = await acquireSessionLock(dbUrl, 7_300_199, { onLost: () => undefined });
    expect(c?.held).toBe(true);
    await c?.release();
  }, 60_000);
});
