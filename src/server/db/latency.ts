import type { Db, Queryable } from "./types";

/**
 * Wraps a database so every statement pays `ms` of "network" time — what a hosted Postgres costs from a serverless
 * function or a laptop. Pass an object to change the latency later (`net.ms = 45`).
 *
 * DEVELOPMENT / TESTING ONLY (`CLANK_DEV_DB_LATENCY_MS`, ignored in production): it exists so the timing of the
 * arena can be measured against the round-trip cost a real deployment has.
 */
export function withLatency(db: Db, ms: number | { ms: number }): Db {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, typeof ms === "number" ? ms : ms.ms));
  const wrap = (q: Queryable): Queryable => ({
    query: async (text, params) => {
      await wait();
      return q.query(text, params);
    },
    exec: async (text) => {
      await wait();
      return q.exec(text);
    },
  });
  return { ...wrap(db), driver: db.driver, transaction: (fn) => db.transaction((tx) => fn(wrap(tx))), close: () => db.close() };
}
