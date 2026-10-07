import "server-only";

import path from "node:path";

import { getEnv } from "../env";

import { withLatency } from "./latency";
import { migrate } from "./migrate";
import { createPgliteDb } from "./pglite";
import { createPostgresDb } from "./postgres";
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
  holder.promise ??= open();
  return holder.promise;
}

/**
 * Pool settings for the shared handle (see createPostgresDb for the Transaction-Pooler rules they enforce). Every value can be tuned without a
 * deploy: DATABASE_POOL_MAX (default 8; use 1-2 behind a SESSION pooler) · DATABASE_QUERY_TIMEOUT_MS (20000; 0 = off) · DATABASE_TX_TIMEOUT_MS (120000; 0 = off).
 * A hung connection therefore costs a request at most one timeout, never the platform's 60 s / 300 s function limit.
 */
function serverlessPoolOptions(): { maxConnections: number; queryTimeoutMs: number; transactionTimeoutMs: number } {
  const num = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    maxConnections: Math.max(1, Math.floor(num("DATABASE_POOL_MAX", 8))),
    queryTimeoutMs: num("DATABASE_QUERY_TIMEOUT_MS", 20_000),
    transactionTimeoutMs: num("DATABASE_TX_TIMEOUT_MS", 120_000),
  };
}

async function open(): Promise<Db> {
  const env = getEnv();
  if (env.DATABASE_URL) {
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
