import { existsSync } from "node:fs";
import path from "node:path";

import { createPgliteDb } from "../../src/server/db/pglite";
import { createPostgresDb, type PostgresDbOptions } from "../../src/server/db/postgres";
import type { Db } from "../../src/server/db/types";
import { getEnv } from "../../src/server/env";

/**
 * Loads .env.local / .env (if present) the same way Next does, without extra dependencies. Variables already in the environment always win, and
 * CLANK_SKIP_ENV_FILES=1 skips the files altogether (scratch / test runs that must never pick up the repository's real DATABASE_URL).
 */
export function loadLocalEnv(): void {
  if (process.env.CLANK_SKIP_ENV_FILES === "1") return;
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (existsSync(p)) process.loadEnvFile(p);
  }
}

export interface ScriptContext {
  db: Db;
  target: string;
  /** The Postgres connection string in use (null for the embedded PGlite). */
  databaseUrl: string | null;
  close(): Promise<void>;
}

/**
 * Opens the same database the app would use: DATABASE_URL (Supabase Postgres) when set,
 * otherwise the local PGlite directory. Never silently falls back in production.
 */
export async function openContext(options: { postgres?: PostgresDbOptions } = {}): Promise<ScriptContext> {
  loadLocalEnv();
  const env = getEnv();
  if (env.DATABASE_URL) {
    const db = createPostgresDb(env.DATABASE_URL, options.postgres);
    const u = new URL(env.DATABASE_URL);
    return { db, target: `LIVE postgres://…@${u.host}${u.pathname}`, databaseUrl: env.DATABASE_URL, close: () => db.close() };
  }
  if (env.isProduction) throw new Error("DATABASE_URL is required in production.");
  const dir = process.env.CLANK_PGLITE_DIR ? path.resolve(process.env.CLANK_PGLITE_DIR) : path.join(process.cwd(), ".data", "pglite");
  const db = await createPgliteDb(dir);
  return { db, target: `PGlite (${dir})`, databaseUrl: null, close: () => db.close() };
}

export async function run(main: (ctx: ScriptContext) => Promise<void>, options: { postgres?: PostgresDbOptions } = {}): Promise<void> {
  let ctx: ScriptContext | null = null;
  try {
    ctx = await openContext(options);
    console.log(`→ database: ${ctx.target}`);
    await main(ctx);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await ctx?.close();
  }
}
