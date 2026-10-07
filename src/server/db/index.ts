import "server-only";

import path from "node:path";

import { getEnv } from "../env";

import { withLatency } from "./latency";
import { migrate } from "./migrate";
import { createPgliteDb } from "./pglite";
import { createPostgresDb, installRejectionGuard } from "./postgres";
import type { Db } from "./types";

export type { Db, Queryable } from "./types";

interface DbHolder {
  promise: Promise<Db> | null;
}

// Survive Next.js dev-server module reloads.
const g = globalThis as unknown as { __clankDb?: DbHolder };
/** Resolved at call time (not module load) so tests and hot reloads always see the live holder. */
const holderOf = (): DbHolder => (g.__clankDb ??= { promise: null });

/**
 * One shared database handle per server process.
 *  - DATABASE_URL set  → Supabase Postgres (production path)
 *  - otherwise, outside production → embedded PGlite persisted in .data/pglite (local dev)
 *  - production without DATABASE_URL → hard error (we never fall back to a toy database)
 */
export function getDb(): Promise<Db> {
  const holder = holderOf();
  if (!holder.promise) {
    const opening = open();
    holder.promise = opening;
    // A handle that failed to open must not be cached for the life of the instance: forget it, so the next request tries again.
    opening.catch(() => {
      if (holder.promise === opening) holder.promise = null;
    });
  }
  return holder.promise;
}

/** The most connections ONE server instance may ever hold, whatever DATABASE_POOL_MAX says (fan-out = instances × pool: see docs/DATABASE_CONNECTIONS.md). */
export const POOL_HARD_CAP = 4;

/**
 * Pool settings for the shared handle (see createPostgresDb for the Transaction-Pooler rules they enforce). Every value can be tuned without a
 * deploy: DATABASE_POOL_MAX (default 1, never above POOL_HARD_CAP: on Vercel every concurrently-warm function instance holds its OWN pool, so the pooler
 * sees instances × DATABASE_POOL_MAX client connections) · DATABASE_QUERY_TIMEOUT_MS (10000; 0 = off) · DATABASE_TX_TIMEOUT_MS (120000; 0 = off) ·
 * DATABASE_LIVENESS_IDLE_MS (5000; a connection quiet for that long is probed with `select 1` before the next statement trusts it; 0 = off).
 * A hung connection therefore costs a request at most one timeout, never the platform's 60 s / 300 s function limit. (10 s: with a pool of one every request queues behind
 * a silently-dead connection's statement, so the timeout IS the outage length; the browser gives up on a state read after 8 s anyway.)
 */
export function serverlessPoolOptions(source: NodeJS.ProcessEnv = process.env): { maxConnections: number; queryTimeoutMs: number; transactionTimeoutMs: number; livenessAfterIdleMs: number } {
  const num = (name: string, fallback: number): number => {
    const raw = source[name];
    const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const requested = Math.max(1, Math.floor(num("DATABASE_POOL_MAX", 1)));
  if (requested > POOL_HARD_CAP) console.warn(`[db] DATABASE_POOL_MAX=${requested} is above the per-instance ceiling; using ${POOL_HARD_CAP}`);
  return {
    maxConnections: Math.min(requested, POOL_HARD_CAP),
    queryTimeoutMs: num("DATABASE_QUERY_TIMEOUT_MS", 10_000),
    transactionTimeoutMs: num("DATABASE_TX_TIMEOUT_MS", 120_000),
    livenessAfterIdleMs: num("DATABASE_LIVENESS_IDLE_MS", 5_000),
  };
}

async function open(): Promise<Db> {
  const env = getEnv();
  if (env.DATABASE_URL) {
    installRejectionGuard();
    const db = createPostgresDb(env.DATABASE_URL, serverlessPoolOptions());
    // Dev-only (never in production): pay a fixed "network" cost per statement to rehearse a distant database.
    const ms = Number(process.env.CLANK_DEV_DB_LATENCY_MS ?? 0) || 0;
    return !env.isProduction && ms > 0 ? withLatency(db, Math.min(ms, 1000)) : db;
  }
  if (env.isProduction) {
    throw new Error("DATABASE_URL is required in production (Supabase Postgres connection string).");
  }
  // CLANK_PGLITE_DIR lets a second local process use its own embedded database (PGlite is single-process).
  const dir = process.env.CLANK_PGLITE_DIR ? path.resolve(process.env.CLANK_PGLITE_DIR) : path.join(process.cwd(), ".data", "pglite");
  // Dev-only: CLANK_DEV_DB_LATENCY_MS makes the embedded database behave like a remote one (timing experiments).
  const latencyMs = Number(process.env.CLANK_DEV_DB_LATENCY_MS ?? 0) || 0;
  const db = await createPgliteDb(dir, { latencyMs });
  await migrate(db);
  return db;
}

export async function closeDb(): Promise<void> {
  const holder = holderOf();
  if (!holder.promise) return;
  const db = await holder.promise;
  holder.promise = null;
  await db.close();
}
