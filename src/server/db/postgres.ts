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

/**
 * Errors that mean "this connection (or the pooler behind it) is gone", as opposed to "the database refused the statement".
 * They are the only ones a retry can fix, and the only ones that justify throwing the connection pool away.
 */
export class DbConnectionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "DbConnectionError";
  }
}
const CONNECTION_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "57P01", "08006", "08003"]);
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof DbConnectionError || (typeof code === "string" && CONNECTION_CODES.has(code));
}

/**
 * A pure `select` may be run a second time after a connection failure: it changes nothing, so the first attempt (which may or may not have
 * reached the server) can never have a side effect. Anything that locks, writes, calls a volatile function or sets session state is NOT retried.
 */
const NOT_RETRYABLE = /\b(insert|update|delete|lock|nextval|setval|set_config|copy)\b|pg_advisory|pg_sleep|\bfor\s+(no\s+key\s+)?(update|share)\b/i;
export function isRetryableRead(text: string): boolean {
  return /^\s*(select|with)\b/i.test(text) && !NOT_RETRYABLE.test(text);
}

/**
 * At most `limit` operations run at once; the rest wait their turn. With `limit` equal to the pool size every operation gets a connection of its
 * own, so postgres.js never has to PIPELINE a second statement onto a connection that is still busy — see createPostgresDb.
 */
export class Gate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiters.push(resolve)); // the slot is handed over: `active` stays the same
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  get inFlight(): number {
    return this.active;
  }
  get queued(): number {
    return this.waiters.length;
  }
}

/** Rejects (and calls `onTimeout`) when `promise` has not settled within `ms`; `ms <= 0` means no timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout: () => void): Promise<T> {
  if (!(ms > 0)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new DbConnectionError(`database ${what} did not answer within ${ms} ms (connection presumed dead)`, "CONNECTION_TIMEOUT"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export interface PostgresDbOptions {
  /** Pool size AND the cap on concurrent statements / transactions (default 8: the hottest read runs a 6-wide group of statements next to a background advance). */
  maxConnections?: number;
  /** A statement that has not answered within this many ms is treated as a dead connection (default: no timeout). */
  queryTimeoutMs?: number;
  /** Cap on a whole transaction, which also covers a lost COMMIT / ROLLBACK reply (default: no timeout). */
  transactionTimeoutMs?: number;
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
  connectTimeoutSeconds?: number;
}

export interface PostgresDb extends Db {
  /** Counters for diagnostics and tests. */
  readonly stats: { recycles: number; retries: number; timeouts: number };
}

/**
 * Production driver: the Supabase Postgres connection string (server-only secret).
 *
 * SERVERLESS / TRANSACTION-POOLER RULES (Supabase Supavisor, port 6543) — what this driver guarantees:
 *  · `prepare: false` — no named prepared statements (they live in one backend session, which the pooler hands to someone else).
 *  · NO QUERY PIPELINING. postgres.js writes up to `max_pipeline` (default 100) statements to one connection without waiting for the previous
 *    answer, and a shared transaction pooler can lose such a batch — the query then never answers (a hang, not an error). `max_pipeline` cannot be
 *    used to switch this off (0 breaks `sql.begin`, 1 still allows two in flight), so the guarantee is made here instead: a Gate keeps the number of
 *    running statements / transactions at or below the pool size (each gets a connection of its own), and the statements INSIDE a transaction run
 *    strictly one after the other.
 *  · No session state anywhere in the app: every advisory lock is transaction-scoped (`pg_advisory_xact_lock*`), `set_config(…, true)` is local,
 *    there is no LISTEN, no temp table, no SET. Nothing here needs a session pooler.
 *  · A hung connection can never hold a request forever: with `queryTimeoutMs` / `transactionTimeoutMs` set, an unanswered statement fails, the
 *    whole pool is thrown away (a fresh one connects on the next call) and a pure SELECT is retried once on the new connection.
 */
export function createPostgresDb(connectionString: string, options: PostgresDbOptions = {}): PostgresDb {
  const max = Math.max(1, options.maxConnections ?? 8);
  const queryTimeoutMs = options.queryTimeoutMs ?? 0;
  const transactionTimeoutMs = options.transactionTimeoutMs ?? 0;
  const gate = new Gate(max);
  const stats = { recycles: 0, retries: 0, timeouts: 0 };

  const connect = () =>
    postgres(connectionString, {
      max,
      prepare: false,
      idle_timeout: options.idleTimeoutSeconds ?? 10,
      max_lifetime: options.maxLifetimeSeconds ?? 15 * 60,
      connect_timeout: options.connectTimeoutSeconds ?? 10,
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

  let sql = connect();
  let closed = false;

  /** Throws the pool away (dead sockets, lost replies). In-flight statements reject with CONNECTION_DESTROYED; the next call connects afresh. */
  const recycle = (client: postgres.Sql): void => {
    if (closed || client !== sql) return; // somebody already replaced it
    stats.recycles++;
    sql = connect();
    void client.end({ timeout: 0 }).catch(() => undefined);
  };

  const timed = <T>(client: postgres.Sql, promise: Promise<T>, ms: number, what: string): Promise<T> =>
    withTimeout(promise, ms, what, () => {
      stats.timeouts++;
      recycle(client);
    });

  /** One statement on the shared pool (outside a transaction): gated, timed, and — for a pure SELECT — retried once after a connection failure. */
  const runStatement = async <T>(text: string, params: readonly unknown[], script: boolean): Promise<T[]> => {
    const retryable = !script && isRetryableRead(text);
    for (let attempt = 0; ; attempt++) {
      try {
        return await gate.run(async () => {
          const client = sql;
          const pending = script ? client.unsafe(text) : client.unsafe(text, params as never[]);
          return (await timed(client, pending as unknown as Promise<unknown>, queryTimeoutMs, "statement")) as T[];
        });
      } catch (error) {
        if (attempt === 0 && retryable && isConnectionError(error)) {
          stats.retries++;
          continue;
        }
        throw error;
      }
    }
  };

  /** The statements of ONE transaction: strictly sequential (no pipelining even for `Promise.all`), each with its own timeout. */
  class TransactionQueryable implements Queryable {
    private chain: Promise<unknown> = Promise.resolve();
    constructor(private readonly client: postgres.Sql, private readonly tx: postgres.TransactionSql) {}

    private enqueue<T>(run: () => Promise<T>): Promise<T> {
      const result = this.chain.then(run, run);
      this.chain = result.catch(() => undefined);
      return result;
    }

    query<T extends object = Row>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      return this.enqueue(async () => (await timed(this.client, this.tx.unsafe(text, params as never[]) as unknown as Promise<unknown>, queryTimeoutMs, "statement")) as T[]);
    }

    exec(text: string): Promise<void> {
      return this.enqueue(async () => {
        await timed(this.client, this.tx.unsafe(text) as unknown as Promise<unknown>, queryTimeoutMs, "statement");
      });
    }
  }

  return {
    driver: "postgres",
    stats,
    query: <T extends object = Row>(text: string, params: readonly unknown[] = []) => runStatement<T>(text, params, false),
    exec: async (text) => {
      await runStatement(text, [], true);
    },
    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
      gate.run(async () => {
        const client = sql;
        // BEGIN and COMMIT / ROLLBACK are issued by postgres.js itself, outside our statement wrapper: guard those two phases with the statement
        // timeout too (a lost reply there would otherwise only end at the whole-transaction cap). Destroying the pool makes `begin` reject.
        let guard: ReturnType<typeof setTimeout> | undefined;
        const disarm = () => clearTimeout(guard);
        const arm = () => {
          disarm();
          if (queryTimeoutMs > 0) {
            guard = setTimeout(() => {
              stats.timeouts++;
              recycle(client);
            }, queryTimeoutMs);
          }
        };
        arm(); // BEGIN
        const run = client.begin(async (tx) => {
          disarm();
          try {
            return await fn(new TransactionQueryable(client, tx));
          } finally {
            arm(); // COMMIT / ROLLBACK
          }
        });
        try {
          return (await timed(client, run as unknown as Promise<unknown>, transactionTimeoutMs, "transaction")) as T;
        } finally {
          disarm();
        }
      }),
    async close() {
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}
