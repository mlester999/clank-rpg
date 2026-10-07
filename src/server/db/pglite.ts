import type * as PGliteModule from "@electric-sql/pglite";

import type { Db, Queryable, Row } from "./types";


class PgliteQueryable implements Queryable {
  constructor(
    protected readonly runner: {
      query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      exec: (text: string) => Promise<unknown>;
    },
    /** Dev-only: pretend every statement crosses a network (see `createPgliteDb`). */
    private readonly latencyMs = 0,
  ) {}

  async query<T extends object = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const result = await this.runner.query(text, params as unknown[]);
    return result.rows as T[];
  }

  async exec(text: string): Promise<void> {
    await this.runner.exec(text);
  }
}

/**
 * Embedded Postgres (WASM) used for local development and the automated test-suite.
 * `dataDir` undefined → in-memory. Never used in production builds.
 *
 * `latencyMs` adds a fixed delay to every statement so a laptop can reproduce the round-trip cost of a
 * hosted database (Supabase from a serverless function is typically 20–120 ms per statement). It exists
 * to measure timing-sensitive paths such as the arena battle boundary; it is never set in production.
 */
export async function createPgliteDb(dataDir?: string, opts: { latencyMs?: number } = {}): Promise<Db> {
  const mod: typeof PGliteModule = await import("@electric-sql/pglite");
  const pg = dataDir ? new mod.PGlite(dataDir) : new mod.PGlite();
  await pg.waitReady;
  const latencyMs = Math.max(0, Math.min(opts.latencyMs ?? 0, 1000));
  const base = new PgliteQueryable(pg as never, latencyMs);
  return {
    driver: "pglite",
    query: (text, params) => base.query(text, params),
    exec: (text) => base.exec(text),
    async transaction(fn) {
      return pg.transaction(async (tx) => fn(new PgliteQueryable(tx as never, latencyMs)));
    },
    async close() {
      await pg.close();
    },
  };
}
