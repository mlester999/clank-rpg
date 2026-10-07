import postgres from "postgres";

import type { Db, Queryable, Row } from "./types";

/**
 * Our services hand json/jsonb parameters over as ALREADY-SERIALISED text (`JSON.stringify(x)` with a `::jsonb`
 * cast) — which is what PGlite expects. postgres.js, however, serialises every parameter the server types as
 * json/jsonb with JSON.stringify again, turning an object into a jsonb *string* ("{\"a\":1}") that no query
 * or zod schema can read. Pass text through untouched; serialise anything else (an actual object/array).
 */
export function serializeJsonParam(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

class PostgresQueryable implements Queryable {
  constructor(protected readonly sql: postgres.Sql | postgres.TransactionSql) {}

  async query<T extends object = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
    const rows = await this.sql.unsafe(text, params as never[]);
    return rows as unknown as T[];
  }

  async exec(text: string): Promise<void> {
    await this.sql.unsafe(text);
  }
}

/**
 * Production driver: the Supabase Postgres connection string (server-only secret).
 * Use the transaction pooler (port 6543) for serverless; `prepare: false` is required there.
 */
export function createPostgresDb(connectionString: string, options: { maxConnections?: number } = {}): Db {
  const sql = postgres(connectionString, {
    max: options.maxConnections ?? 5,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    // Match the PGlite driver: int8 → number (safe: ids/counters < 2^53), numeric stays string.
    types: {
      json: { to: 114, from: [114, 3802], serialize: serializeJsonParam, parse: (value: string) => JSON.parse(value) as unknown },
      bigint: {
        to: 20,
        from: [20],
        serialize: (value: unknown) => String(value),
        parse: (value: string) => Number(value),
      },
    },
  });
  const base = new PostgresQueryable(sql);
  return {
    driver: "postgres",
    query: (text, params) => base.query(text, params),
    exec: (text) => base.exec(text),
    async transaction(fn) {
      const result = await sql.begin(async (tx) => fn(new PostgresQueryable(tx)));
      return result as never;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
