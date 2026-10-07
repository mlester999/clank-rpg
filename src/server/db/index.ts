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

async function open(): Promise<Db> {
  const env = getEnv();
  if (env.DATABASE_URL) {
    const db = createPostgresDb(env.DATABASE_URL);
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
