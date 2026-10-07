/**
 * Long-running arena driver for hosts that allow a persistent process (Fly, Railway, a VPS…).
 * Without it the arena only advances while someone has the site open (or a scheduler hits
 * /api/internal/tick): heroes stop fighting — and battles stop settling — the moment the last viewer leaves.
 * The worker is what makes the Global Arena run on its own, and it keeps the schedule tight: it sleeps until
 * the next transition is DUE (combat start → picks lock, combat end → settle + prepare the next battle) rather
 * than ticking blindly, so the next battle is always prepared before the results screen ends.
 *
 * ONE WORKER ONLY. At start the worker takes a session-level advisory lock on a dedicated connection; a second worker (same database) finds it taken and
 * exits with code 3 — it never runs next to the first. The lock needs a DIRECT (or session-pooler) connection: the worker refuses the transaction
 * pooler (port 6543). If the lock is ever lost (connection dropped, failover) the worker stops with code 4 instead of carrying on unprotected —
 * run it under a supervisor that restarts it (systemd, Fly, Railway). Transitions are row-locked as well, so even a duplicate could not corrupt state;
 * the lock keeps the work, the logs and the reward sweeps single. See docs/ARENA_WORKER.md.
 *
 *   pnpm arena:worker
 *
 * Exit codes: 0 stopped by signal · 1 fatal error · 2 refused (transaction pooler) · 3 another worker is running · 4 lock lost
 */
import { randomBytes } from "node:crypto";

import { acquireSessionLock, installRejectionGuard } from "../src/server/db/postgres";

import { demoHeroesAllowed } from "../src/server/env";
import { loadSettings } from "../src/server/config/settingsRepo";
import { getChainReader } from "../src/server/rewards/context";
import { verifiedTokenMetadata } from "../src/server/rewards/tokenMetadata";
import { refreshDueHolders } from "../src/server/rewards/holders";
import { settleDueRewards } from "../src/server/rewards/settlement";
import { finalizeDueHeroBoards } from "../src/server/rewards/heroArena";
import { finalizeDueBoards } from "../src/server/rewards/leaderboard";
import { advanceArena } from "../src/server/services/arena";
import { ARENA_WORKER_LOCK_KEY } from "../src/server/services/lifecycleLock";

import { run } from "./lib/context";

/** Safety net: look at least this often (new heroes, resume after pause, a clock jump). */
const IDLE_TICK_MS = 1000;
/** Never spin faster than this when a transition is due "right now". */
const MIN_TICK_MS = 25;
/** After consecutive failures (database down, pooler restarting) the worker backs off instead of hammering: 1 s, 2 s, 4 s … up to this. */
const MAX_FAILURE_SLEEP_MS = 30_000;
/** The port Supabase's TRANSACTION pooler (Supavisor) listens on: session state — and therefore a session lock — cannot live there. */
const TRANSACTION_POOLER_PORT = "6543";

void run(async ({ db, databaseUrl }) => {
  installRejectionGuard({ rethrowOthers: true });
  const ctx = { now: () => new Date(), secureSeed: () => randomBytes(16).toString("hex"), allowDemo: demoHeroesAllowed() };
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; });

  // ── ONE worker: take the singleton lock before doing anything ──────────────────────────────────────────────────────────────────────────────────
  let lock: Awaited<ReturnType<typeof acquireSessionLock>> = null;
  if (databaseUrl) {
    if (new URL(databaseUrl).port === TRANSACTION_POOLER_PORT && process.env.ARENA_WORKER_ALLOW_POOLER !== "1") {
      console.error(`REFUSED: DATABASE_URL points at port ${TRANSACTION_POOLER_PORT} (the transaction pooler). The Arena worker needs a DIRECT connection (or the session pooler, port 5432): it holds a session lock so that only one worker runs.`);
      process.exitCode = 2;
      return;
    }
    lock = await acquireSessionLock(databaseUrl, ARENA_WORKER_LOCK_KEY, {
      heartbeatMs: Number(process.env.ARENA_WORKER_HEARTBEAT_MS) || 5_000,
      onLost: (reason) => {
        console.error(new Date().toISOString(), `LOCK LOST (${reason}) — stopping so a supervisor can restart a single, protected worker.`);
        process.exitCode = 4;
        stop = true;
      },
    });
    if (!lock) {
      console.error("ANOTHER Arena worker already holds the lock on this database — exiting. (Only one worker may run; this is by design.)");
      process.exitCode = 3;
      return;
    }
  }
  console.log(`arena worker started (demo heroes ${ctx.allowDemo ? "ALLOWED" : "excluded"}; singleton lock ${lock ? "HELD" : "n/a (embedded database)"}). Ctrl-C to stop.`);
  try {
    await loop();
  } finally {
    await lock?.release();
  }

  async function loop(): Promise<void> {
    let lastStatus = "";
    let holderAt = 0;
    let failures = 0;
    while (!stop) {
      let sleepMs = IDLE_TICK_MS;
      try {
        const r = await advanceArena(db, ctx);
        // Picks of finished battles are SCORED right after the arena settled (own transaction; one cheap query when idle). No token is
        // credited per battle — only the Daily / Weekly boards pay, when they are finalized below. A failure is logged and retried — never fatal.
        const rewards = await settleDueRewards(db, ctx).catch((error: unknown) => {
          console.error(new Date().toISOString(), "pick scoring sweep failed:", error instanceof Error ? error.message : error);
          return null;
        });
        if (rewards && (rewards.settled || rewards.failed)) console.log(new Date().toISOString(), `picks → scored ${rewards.settled} battle(s), failed ${rewards.failed}`);
        // Leaderboards: freeze an ended DAY or WEEK (idempotent, cheap when idle; each prize winner's holdings get a fresh close verification
        // first) — prizes become claimable, never auto-sent — then reconcile any holder bonus whose close verification had failed.
        const boards = await finalizeDueBoards(db, { ...ctx, settings: await loadSettings(db) }).catch((error: unknown) => {
          console.error(new Date().toISOString(), "leaderboard finalization failed:", error instanceof Error ? error.message : error);
          return null;
        });
        if (boards && (boards.finalized || boards.failed || boards.reconciled.checked)) console.log(new Date().toISOString(), `boards → finalized ${boards.periods.join(", ") || 0}, failed ${boards.failed}, bonuses re-checked ${boards.reconciled.checked}`);
        // HERO ARENA: a separate reward program with its own sweep — never throws, never touches the Arena Picks boards above (and they never touch it).
        const heroBoards = await finalizeDueHeroBoards(db, { ...ctx, settings: await loadSettings(db) });
        if (heroBoards.finalized || heroBoards.failed || heroBoards.released) console.log(new Date().toISOString(), `hero arena → finalized ${heroBoards.periods.join(", ") || 0}, prizes released to claiming owners ${heroBoards.released}, failed ${heroBoards.failed}`);
        // Holder verification (path C): a bounded batch of connected wallets whose next_check_at is due (~30 min each, jittered). Read-only chain
        // calls, each success appended to the observation log; a failure backs off and counts. There is NO token sender: payouts are manual.
        if (Date.now() - holderAt > 30_000) {
          holderAt = Date.now();
          // The contract's own metadata (decimals(), symbol()) — verified and persisted (the reader caches an hour, the row is rewritten every 10 minutes). Null = not launched / not verifiable.
          await verifiedTokenMetadata(db, await getChainReader()).catch(() => null);
          const holders = await refreshDueHolders(db, ctx, await getChainReader(), await loadSettings(db)).catch((error: unknown) => {
            console.error(new Date().toISOString(), "holder refresh failed:", error instanceof Error ? error.message : error);
            return null;
          });
          if (holders && (holders.refreshed || holders.failed)) console.log(new Date().toISOString(), `holders → due ${holders.due}, refreshed ${holders.refreshed}, failed ${holders.failed}`);
        }
        if (failures > 0) console.log(new Date().toISOString(), `recovered after ${failures} failed tick(s)`);
        failures = 0;
        if (r.dueAtMs !== null) sleepMs = Math.min(IDLE_TICK_MS, Math.max(MIN_TICK_MS, r.dueAtMs - Date.now()));
        for (const step of r.steps) console.log(new Date().toISOString(), step);
        if (r.status !== lastStatus) {
          console.log(new Date().toISOString(), `status → ${r.status}${r.eligibleHeroes !== undefined ? ` (${r.eligibleHeroes} eligible heroes)` : ""}`);
          lastStatus = r.status;
        }
      } catch (error) {
        // A dropped connection, a pooler restart, a database failover: the driver has already thrown the poisoned pool away. Back off — do not hammer — and carry on;
        // every step of advanceArena is its own row-locked transaction, so whatever it was in the middle of is simply done again (or already was).
        failures++;
        sleepMs = Math.min(MAX_FAILURE_SLEEP_MS, 1000 * 2 ** Math.min(failures - 1, 5));
        console.error(new Date().toISOString(), `advance failed (${failures} in a row; retrying in ${sleepMs} ms):`, error instanceof Error ? error.message : error);
      }
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
  }
}, { postgres: { maxConnections: 2, queryTimeoutMs: 30_000, transactionTimeoutMs: 120_000, livenessAfterIdleMs: 5_000 } });
