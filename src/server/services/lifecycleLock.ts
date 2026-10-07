import type { Queryable } from "../db/types";

/**
 * The advisory lock that separates the game's LIFECYCLE actions from reward FINALIZATION.
 *
 * Launching a season, resetting the development run and ending a season look at the reward ledger ("is anything owed that archiving would orphan?")
 * and then archive the season. A Daily / Weekly board that finalizes in between would credit a prize AFTER that look — an obligation the archive
 * never saw. So lifecycle actions take this lock EXCLUSIVELY (after `arena_state`, the order every Arena path uses) and every board finalization
 * takes it SHARED: finalizations run side by side, a lifecycle action waits for the ones in flight and then sees what they credited, and a
 * finalization that starts during one waits for it and then sees which season owns the period.
 *
 * It is deliberately NOT a row lock on `arena_state`: a finalization writes a result row per participant, and holding the Arena's own lock for that
 * long would stall every battle at midnight UTC.
 */
export const LIFECYCLE_LOCK_KEY = 7_300_101;

export async function lockLifecycleExclusive(tx: Queryable): Promise<void> {
  await tx.query("select pg_advisory_xact_lock($1::bigint)", [LIFECYCLE_LOCK_KEY]);
}

export async function lockLifecycleShared(tx: Queryable): Promise<void> {
  await tx.query("select pg_advisory_xact_lock_shared($1::bigint)", [LIFECYCLE_LOCK_KEY]);
}
