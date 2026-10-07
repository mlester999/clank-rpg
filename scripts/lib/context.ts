import { existsSync } from "node:fs";
import path from "node:path";

import { createPgliteDb } from "../../src/server/db/pglite";
import { createPostgresDb } from "../../src/server/db/postgres";
import type { Db } from "../../src/server/db/types";
import { getEnv } from "../../src/server/env";

/** Loads .env.local / .env (if present) the same way Next does, without extra dependencies. */
export function loadLocalEnv(): void {
  for (const file of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), file);
    if (existsSync(p)) process.loadEnvFile(p);
  }
}

export interface ScriptContext {
  db: Db;
  target: string;
  close(): Promise<void>;
}

/**
 * Opens the same database the app would use: DATABASE_URL (Supabase Postgres) when set,
 * otherwise the local PGlite directory. Never silently falls back in production.
 */
export async function openContext(): Promise<ScriptContext> {
  loadLocalEnv();
  const env = getEnv();
  if (env.DATABASE_URL) {
    const db = createPostgresDb(env.DATABASE_URL);
    const u = new URL(env.DATABASE_URL);
    return { db, target: `LIVE postgres://…@${u.host}${u.pathname}`, close: () => db.close() };
  }
  if (env.isProduction) throw new Error("DATABASE_URL is required in production.");
  const dir = process.env.CLANK_PGLITE_DIR ? path.resolve(process.env.CLANK_PGLITE_DIR) : path.join(process.cwd(), ".data", "pglite");
  const db = await createPgliteDb(dir);
  return { db, target: `PGlite (${dir})`, close: () => db.close() };
}

export async function run(main: (ctx: ScriptContext) => Promise<void>): Promise<void> {
  let ctx: ScriptContext | null = null;
  try {
    ctx = await openContext();
    console.log(`→ database: ${ctx.target}`);
    await main(ctx);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await ctx?.close();
  }
}
