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

// ── Array types ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// postgres.js learns the array types by running a catalog query ("fetch_types") on EVERY new physical connection — from a promise nothing awaits
// (`fetchArrayTypes()` in its connection.js). When a connection dies during that handshake (a pooler reset, or this driver throwing the pool away) the
// query rejects with `write CONNECTION_DESTROYED host:port` / `read ECONNRESET` and, because nobody holds the promise, Node reports an UNHANDLED
// REJECTION — the production error. It is also a wasted round trip + catalog scan per connection. So `fetch_types` is off and the handful of array
// types the app can meet are registered here, statically.

/** Parses a Postgres array literal (`{1,2}`, `{"a b",NULL}`, `{{1,2},{3,4}}`), converting each element with `element`. */
export function parsePgArray(text: string, element: (raw: string) => unknown = (raw) => raw): unknown[] {
  let i = text.startsWith("[") ? text.indexOf("=") + 1 : 0; // skip a "[1:3]=" dimension decoration
  const walk = (): unknown[] => {
    i++; // the opening brace
    const out: unknown[] = [];
    while (i < text.length) {
      const c = text[i];
      if (c === "}") {
        i++;
        return out;
      }
      if (c === ",") {
        i++;
      } else if (c === "{") {
        out.push(walk());
      } else if (c === '"') {
        i++;
        let s = "";
        while (i < text.length && text[i] !== '"') {
          if (text[i] === "\\") i++;
          s += text[i++];
        }
        i++;
        out.push(element(s));
      } else {
        let j = i;
        while (j < text.length && text[j] !== "," && text[j] !== "}") j++;
        const raw = text.slice(i, j).trim();
        i = j;
        out.push(raw.toUpperCase() === "NULL" ? null : element(raw));
      }
    }
    return out;
  };
  return walk();
}

const arrayLiteral = (xs: readonly unknown[]): string =>
  `{${xs
    .map((x) => {
      if (x === null || x === undefined) return "NULL";
      if (Array.isArray(x)) return arrayLiteral(x);
      const text = x instanceof Date ? x.toISOString() : typeof x === "object" ? JSON.stringify(x) : String(x);
      return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join(",")}}`;

/** A text array literal (our convention: `{a,b}` + a `::text[]` cast) passes through; a real JS array is turned into one. */
export function serializeArrayParam(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value) ? arrayLiteral(value) : String(value);
}

const asText = (raw: string): unknown => raw;
const asNumber = (raw: string): unknown => Number(raw);
const asDate = (raw: string): unknown => new Date(raw);
const asJson = (raw: string): unknown => JSON.parse(raw);
/** [array type oid, element parser] — the element parsers match what the scalar types give back (int8 → number, numeric → string, dates → Date). */
const ARRAY_TYPES: ReadonlyArray<readonly [name: string, oid: number, element: (raw: string) => unknown]> = [
  ["boolArray", 1000, (raw) => raw === "t" || raw === "true"],
  ["int2Array", 1005, asNumber],
  ["int4Array", 1007, asNumber],
  ["int8Array", 1016, asNumber],
  ["float4Array", 1021, asNumber],
  ["float8Array", 1022, asNumber],
  ["numericArray", 1231, asText],
  ["textArray", 1009, asText],
  ["varcharArray", 1015, asText],
  ["bpcharArray", 1014, asText],
  ["uuidArray", 2951, asText],
  ["jsonArray", 199, asJson],
  ["jsonbArray", 3807, asJson],
  ["dateArray", 1182, asDate],
  ["timestampArray", 1115, asDate],
  ["timestamptzArray", 1185, asDate],
];
const arrayTypes = Object.fromEntries(
  ARRAY_TYPES.map(([name, oid, element]) => [name, { to: oid, from: [oid], serialize: serializeArrayParam, parse: (value: string) => parsePgArray(value, element) }]),
);

// ── Connection-class errors ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Errors that mean "this connection (or the pooler behind it) is gone", as opposed to "the database refused the statement".
 * They are the only ones a retry can fix, and the only ones that justify throwing the connection pool away.
 *
 * What reaches callers is always THIS class (never postgres.js's raw error, whose message carries the pooler host:port): `code` is the original
 * code, `cause` the raw error (for the server log only), and `ambiguous` says whether a WRITE may nevertheless have been applied — see `outcome`.
 */
export class DbConnectionError extends Error {
  /**
   * true  → the statement / transaction MAY have been applied (a write whose reply was lost, a COMMIT that never answered): never replay it blindly.
   * false → it certainly was not applied (nothing was sent, a read, or a transaction that died before COMMIT — the server rolls those back).
   */
  readonly ambiguous: boolean;
  constructor(message: string, readonly code: string, options: { cause?: unknown; ambiguous?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "DbConnectionError";
    this.ambiguous = options.ambiguous ?? false;
  }
}
/**
 * "Too many connections": the pooler or the database refused a NEW connection (53300 too_many_connections, Supavisor's EMAXCONNSESSION / EMAXCLIENTCONN). The statement
 * was never sent, so nothing was applied — but retrying at once only adds to the overload, so it is neither retried nor does it throw the pool away: it becomes a
 * DbConnectionError (→ HTTP 503 + Retry-After, the viewer backs off) and the next request tries again.
 */
const CAPACITY_CODES = new Set(["53300", "EMAXCONNSESSION", "EMAXCLIENTCONN"]);
export function isCapacityError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CAPACITY_CODES.has(code);
}
const CONNECTION_CODES = new Set(["CONNECTION_CLOSED", "CONNECTION_DESTROYED", "CONNECTION_ENDED", "CONNECT_TIMEOUT", "CONNECTION_TIMEOUT", "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03", "08006", "08003", "08001", "08004"]);
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return error instanceof DbConnectionError || (typeof code === "string" && CONNECTION_CODES.has(code));
}

/** The caller-facing form of a connection failure (generic message: no pooler host, port or credentials). Anything else passes through untouched. */
function asConnectionError(error: unknown, ambiguous: boolean): unknown {
  if (isCapacityError(error)) return new DbConnectionError(`database is at its connection limit (${String((error as { code?: unknown }).code)})`, String((error as { code?: unknown }).code), { cause: error, ambiguous: false });
  if (!isConnectionError(error)) return error;
  if (error instanceof DbConnectionError) return error.ambiguous === ambiguous || !ambiguous ? error : new DbConnectionError(error.message, error.code, { cause: error.cause, ambiguous });
  const code = String((error as { code?: unknown }).code);
  return new DbConnectionError(`database connection lost (${code})`, code, { cause: error, ambiguous });
}

/**
 * Rejections that postgres.js itself leaves floating (it has had at least one: the array-type fetch above). Registered once per process by the web
 * app and the Arena worker: a connection-class one is logged in one line and counted instead of surfacing as an UNHANDLED REJECTION. Every other
 * rejection is left to whoever else listens (the Next.js runtime) — or, for the worker (`rethrowOthers`), raised exactly as Node's default would.
 */
export const strayRejections = { absorbed: 0 };
export function installRejectionGuard(options: { rethrowOthers?: boolean; log?: (line: string) => void } = {}): void {
  const g = globalThis as unknown as { __clankRejectionGuard?: true };
  if (g.__clankRejectionGuard) return;
  g.__clankRejectionGuard = true;
  const log = options.log ?? ((line: string) => console.error(line));
  process.on("unhandledRejection", (reason) => {
    if (isConnectionError(reason)) {
      strayRejections.absorbed++;
      log(`[db] stray connection rejection absorbed (${String((reason as { code?: unknown }).code)}): ${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    if (options.rethrowOthers && process.listenerCount("unhandledRejection") <= 1) throw reason;
  });
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

/** Rejects (and calls `onTimeout`) when `promise` has not settled within `ms`; `ms <= 0` means no timeout. The original promise is always observed. */
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
  /**
   * A connection nobody has heard from for this many ms is probed with a bounded `select 1` BEFORE the next statement is trusted to it — a warm
   * serverless instance can wake up (or be thawed) holding a socket the pooler closed long ago, and a write sent down such a socket has an unknowable
   * outcome. A busy instance never probes (its connection was used a moment ago). Default 5000 when `queryTimeoutMs` is set, otherwise off; 0 = off.
   */
  livenessAfterIdleMs?: number;
  /** How long that probe may take before the connection is presumed dead (default: min(3000, queryTimeoutMs)). */
  livenessTimeoutMs?: number;
  idleTimeoutSeconds?: number;
  maxLifetimeSeconds?: number;
  connectTimeoutSeconds?: number;
}

export interface PostgresDb extends Db {
  /** Counters for diagnostics and tests. */
  readonly stats: { recycles: number; retries: number; timeouts: number; probes: number; probeFailures: number; txRetries: number };
}

/**
 * Production driver: the Supabase Postgres connection string (server-only secret).
 *
 * SERVERLESS / TRANSACTION-POOLER RULES (Supabase Supavisor, port 6543) — what this driver guarantees:
 *  · `prepare: false` — no named prepared statements (they live in one backend session, which the pooler hands to someone else).
 *  · `fetch_types: false` — postgres.js's own array-type handshake is a floating promise (see above); the array codecs are static.
 *  · NO QUERY PIPELINING. postgres.js writes up to `max_pipeline` (default 100) statements to one connection without waiting for the previous
 *    answer, and a shared transaction pooler can lose such a batch — the query then never answers (a hang, not an error). `max_pipeline` cannot be
 *    used to switch this off (0 breaks `sql.begin`, 1 still allows two in flight), so the guarantee is made here instead: a Gate keeps the number of
 *    running statements / transactions at or below the pool size (each gets a connection of its own), and the statements INSIDE a transaction run
 *    strictly one after the other.
 *  · No session state anywhere in the app: every advisory lock is transaction-scoped (`pg_advisory_xact_lock*`), `set_config(…, true)` is local,
 *    there is no LISTEN, no temp table, no SET. Nothing here needs a session pooler.
 *  · A hung connection can never hold a request forever: with `queryTimeoutMs` / `transactionTimeoutMs` set, an unanswered statement fails, the
 *    whole pool is thrown away (a fresh one connects on the next call) and a pure SELECT is retried once on the new connection.
 *  · A connection that went stale while the instance was idle / frozen is found by a bounded `select 1` before it is trusted with the next statement
 *    (see `livenessAfterIdleMs`) — never before every statement.
 *  · REPLAY RULES. A pure SELECT is retried ONCE after a connection failure. A transaction is retried ONCE only if it died before BEGIN completed (its
 *    body never ran). Anything else — a write, a statement inside a transaction, a COMMIT whose reply was lost — fails with a DbConnectionError
 *    (`ambiguous` says whether it may have been applied) and is never repeated by the driver.
 */
export function createPostgresDb(connectionString: string, options: PostgresDbOptions = {}): PostgresDb {
  const max = Math.max(1, options.maxConnections ?? 8);
  const queryTimeoutMs = options.queryTimeoutMs ?? 0;
  const transactionTimeoutMs = options.transactionTimeoutMs ?? 0;
  const livenessAfterIdleMs = options.livenessAfterIdleMs ?? (queryTimeoutMs > 0 ? 5_000 : 0);
  const livenessTimeoutMs = options.livenessTimeoutMs ?? (queryTimeoutMs > 0 ? Math.min(3_000, queryTimeoutMs) : 3_000);
  const gate = new Gate(max);
  const stats = { recycles: 0, retries: 0, timeouts: 0, probes: 0, probeFailures: 0, txRetries: 0 };

  const connect = () =>
    postgres(connectionString, {
      max,
      prepare: false,
      fetch_types: false,
      idle_timeout: options.idleTimeoutSeconds ?? 10,
      max_lifetime: options.maxLifetimeSeconds ?? 15 * 60,
      connect_timeout: options.connectTimeoutSeconds ?? 10,
      // Match the PGlite driver: int8 → number (safe: ids/counters < 2^53), numeric stays string, arrays are arrays.
      types: {
        json: { to: 114, from: [114, 3802], serialize: serializeJsonParam, parse: (value: string) => JSON.parse(value) as unknown },
        bigint: {
          to: 20,
          from: [20],
          serialize: (value: unknown) => String(value),
          parse: (value: string) => Number(value),
        },
        ...arrayTypes,
      },
    });

  let sql = connect();
  let closed = false;
  /** When the server last answered anything on this pool (0 = never: a brand-new pool has no stale socket to doubt). */
  let lastHeardAt = 0;
  const heard = (): void => {
    lastHeardAt = Date.now();
  };

  /**
   * Throws the pool away (dead sockets, lost replies) and starts a fresh one. With a pool of ONE (production: the only connection is the one that just failed)
   * the old connection is destroyed at once — nothing healthy can be running on it, and a draining socket next to its replacement would briefly DOUBLE this instance's
   * share of the pooler. With a larger pool, work on the OTHER connections gets 2 s to finish (graceful end). Whatever is destroyed rejects its statement, and every
   * one of them is observed by its caller.
   */
  const recycle = (client: postgres.Sql): void => {
    if (closed || client !== sql) return; // somebody already replaced it
    stats.recycles++;
    lastHeardAt = 0;
    sql = connect();
    void client.end({ timeout: max > 1 ? 2 : 0 }).catch(() => undefined);
  };

  const timed = <T>(client: postgres.Sql, promise: Promise<T>, ms: number, what: string): Promise<T> =>
    withTimeout(promise, ms, what, () => {
      stats.timeouts++;
      recycle(client);
    });

  let probing: Promise<void> | null = null;
  const probe = async (): Promise<void> => {
    const client = sql;
    stats.probes++;
    try {
      await withTimeout(client.unsafe("select 1") as unknown as Promise<unknown>, livenessTimeoutMs, "liveness probe", () => {
        stats.timeouts++;
      });
      heard();
    } catch (error) {
      if (!isConnectionError(error)) {
        heard(); // the server answered (with an error): the socket is alive
        return;
      }
      stats.probeFailures++;
      recycle(client);
    }
  };
  /**
   * Smart liveness: only a connection that has been quiet for `livenessAfterIdleMs` is doubted, and the doubt costs one bounded `select 1`. A failed
   * probe throws the (poisoned) pool away; the caller's own statement then runs on a fresh connection. Concurrent callers share ONE probe.
   */
  const ensureLive = (): Promise<void> => {
    if (!(livenessAfterIdleMs > 0) || lastHeardAt === 0 || Date.now() - lastHeardAt < livenessAfterIdleMs) return Promise.resolve();
    probing ??= probe().finally(() => {
      probing = null;
    });
    return probing;
  };

  /** One statement on the shared pool (outside a transaction): gated, probed when stale, timed, and — for a pure SELECT — retried once after a connection failure. */
  const runStatement = async <T>(text: string, params: readonly unknown[], script: boolean): Promise<T[]> => {
    const retryable = !script && isRetryableRead(text);
    for (let attempt = 0; ; attempt++) {
      const used: { client: postgres.Sql | null } = { client: null };
      try {
        return await gate.run(async () => {
          await ensureLive();
          const client = (used.client = sql);
          const pending = script ? client.unsafe(text) : client.unsafe(text, params as never[]);
          const rows = (await timed(client, pending as unknown as Promise<unknown>, queryTimeoutMs, "statement")) as T[];
          heard();
          return rows;
        });
      } catch (error) {
        if (isCapacityError(error)) throw asConnectionError(error, false); // refused at the door: nothing ran, and a retry would only add to the overload
        if (!isConnectionError(error)) {
          heard(); // a database error: the server answered
          throw error;
        }
        if (used.client) recycle(used.client);
        if (attempt === 0 && retryable) {
          stats.retries++;
          continue;
        }
        throw asConnectionError(error, !retryable);
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
      return this.enqueue(async () => {
        const rows = (await timed(this.client, this.tx.unsafe(text, params as never[]) as unknown as Promise<unknown>, queryTimeoutMs, "statement")) as T[];
        heard();
        return rows;
      });
    }

    exec(text: string): Promise<void> {
      return this.enqueue(async () => {
        await timed(this.client, this.tx.unsafe(text) as unknown as Promise<unknown>, queryTimeoutMs, "statement");
        heard();
      });
    }
  }

  const runTransaction = async <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      // `began`: postgres.js has run BEGIN and handed us the transaction — from here on the body (and its writes) may have executed.
      const phase: { began: boolean; body: "pending" | "done" | "failed" } = { began: false, body: "pending" };
      const used: { client: postgres.Sql | null } = { client: null };
      try {
        return await gate.run(async () => {
          await ensureLive();
          const client = (used.client = sql);
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
            phase.began = true;
            disarm();
            try {
              const result = await fn(new TransactionQueryable(client, tx));
              phase.body = "done";
              return result;
            } catch (error) {
              phase.body = "failed";
              throw error;
            } finally {
              arm(); // COMMIT / ROLLBACK
            }
          });
          try {
            const result = (await timed(client, run as unknown as Promise<unknown>, transactionTimeoutMs, "transaction")) as T;
            heard();
            return result;
          } finally {
            disarm();
          }
        });
      } catch (error) {
        if (isCapacityError(error)) throw asConnectionError(error, false);
        if (!isConnectionError(error)) {
          heard();
          throw error;
        }
        if (used.client) recycle(used.client);
        // Died before BEGIN completed: the body never ran, nothing was written — replaying it once cannot duplicate anything.
        if (attempt === 0 && !phase.began) {
          stats.txRetries++;
          continue;
        }
        // Died inside the body: the server rolls an unfinished transaction back. Only a COMMIT that was sent and not answered may have been applied.
        throw asConnectionError(error, phase.began && phase.body === "done");
      }
    }
  };

  return {
    driver: "postgres",
    stats,
    query: <T extends object = Row>(text: string, params: readonly unknown[] = []) => runStatement<T>(text, params, false),
    exec: async (text) => {
      await runStatement(text, [], true);
    },
    transaction: runTransaction,
    async close() {
      closed = true;
      await sql.end({ timeout: 5 });
    },
  };
}

// ── Singleton lock for the long-lived Arena worker ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface SessionLock {
  /** True while the lock is believed held (the heartbeat has confirmed it recently and the connection has not been lost). */
  readonly held: boolean;
  release(): Promise<void>;
}

/**
 * Tries to become THE holder of a session-level advisory lock: a dedicated connection (never the shared pool) that owns `pg_try_advisory_lock(key)` for as
 * long as it lives. Returns null if somebody else holds it — the caller must not run. The lock is a property of the SESSION, so this only works on a
 * direct or session-pooler connection: behind a TRANSACTION pooler (Supavisor :6543) the backend is handed to other clients between statements, which
 * is why the heartbeat verifies — every `heartbeatMs` — that the lock is held by the very backend answering the question. If it is not (a dropped
 * connection, a pooler that switched backends, a failover), `onLost` fires once and `held` turns false: the owner must stop, never carry on unprotected.
 */
export async function acquireSessionLock(
  connectionString: string,
  key: number,
  options: { heartbeatMs?: number; timeoutMs?: number; applicationName?: string; onLost: (reason: string) => void },
): Promise<SessionLock | null> {
  if (!Number.isInteger(key) || key < 0 || key > 2_147_483_647) throw new Error("the lock key must be an int32 (it is matched against pg_locks.objid)");
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const sql = postgres(connectionString, {
    max: 1,
    prepare: false,
    fetch_types: false,
    idle_timeout: 0, // the lock lives exactly as long as this connection: never let postgres.js close it for being idle…
    max_lifetime: 0, // …or for being old (its default is to recycle every 30-60 minutes)
    connect_timeout: 10,
    onnotice: () => undefined,
    connection: { application_name: options.applicationName ?? "clank-arena-worker" },
  });
  let held = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const bounded = <T>(promise: Promise<T>): Promise<T> => withTimeout(promise, timeoutMs, "session-lock heartbeat", () => undefined);
  /** Does THIS backend own the lock? (pg_locks.pid is the owner; pg_backend_pid() is whoever is answering.) */
  const ownedByThisBackend = async (): Promise<boolean> => {
    const rows = (await bounded(
      sql.unsafe("select count(*)::int as n from pg_locks where locktype = 'advisory' and classid = 0 and objid = $1::oid and objsubid = 1 and pid = pg_backend_pid() and granted", [String(key)]) as unknown as Promise<unknown>,
    )) as Array<{ n: number | string }>;
    return Number(rows[0]?.n) === 1;
  };
  const lose = (reason: string): void => {
    if (!held) return;
    held = false;
    clearInterval(timer);
    void sql.end({ timeout: 0 }).catch(() => undefined);
    options.onLost(reason);
  };
  try {
    const rows = (await bounded(sql.unsafe("select pg_try_advisory_lock($1::bigint) as ok", [String(key)]) as unknown as Promise<unknown>)) as Array<{ ok: boolean }>;
    if (rows[0]?.ok !== true) {
      await sql.end({ timeout: 2 }).catch(() => undefined);
      return null;
    }
    held = true;
    if (!(await ownedByThisBackend())) {
      held = false;
      await sql.end({ timeout: 2 }).catch(() => undefined);
      throw new Error("the connection does not keep one backend between statements (a TRANSACTION pooler, port 6543?): a session lock cannot be held through it — use a direct or session-pooler connection");
    }
  } catch (error) {
    await sql.end({ timeout: 0 }).catch(() => undefined);
    throw error;
  }
  let beating = false;
  timer = setInterval(() => {
    if (beating || !held) return;
    beating = true;
    ownedByThisBackend()
      .then((owned) => {
        if (!owned) lose("the advisory lock is no longer held by this connection");
      })
      .catch((error: unknown) => lose(`heartbeat failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        beating = false;
      });
  }, heartbeatMs);
  timer.unref?.();
  return {
    get held() {
      return held;
    },
    async release() {
      if (!held && !timer) return;
      held = false;
      clearInterval(timer);
      timer = undefined;
      await sql.end({ timeout: 2 }).catch(() => undefined); // ending the session releases the lock
    },
  };
}
