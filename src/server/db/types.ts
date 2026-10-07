/**
 * Minimal database contract used by every service. Two drivers implement it:
 *  - PGlite (embedded Postgres, no Docker) for local development and tests
 *  - postgres.js against the Supabase Postgres connection string in production
 *
 * Conventions that keep the two drivers interchangeable:
 *  - positional `$1` parameters only
 *  - JSON / array parameters are passed as JSON strings and cast in SQL (`$1::jsonb`)
 *  - bigint columns come back as JS numbers (all ids / counters are < 2^53),
 *    numeric columns come back as strings (token balances need exact precision)
 */
export type Row = Record<string, unknown>;

export interface Queryable {
  query<T extends object = Row>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Run a multi-statement script (no parameters). */
  exec(text: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly driver: "pglite" | "postgres";
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Thrown when a unique/check constraint rejects a write. */
export class ConstraintError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly constraint?: string,
  ) {
    super(message);
    this.name = "ConstraintError";
  }
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
