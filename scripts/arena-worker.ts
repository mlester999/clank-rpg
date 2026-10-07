/**
 * Long-running arena driver for hosts that allow a persistent process (Fly, Railway, a VPS…).
 * Without it the arena only advances while someone has the site open (or a scheduler hits
 * /api/internal/tick): heroes stop fighting — and battles stop settling — the moment the last viewer leaves.
 * The worker is what makes the Global Arena run on its own, and it keeps the schedule tight: it sleeps until
 * the next transition is DUE (combat start → picks lock, combat end → settle + prepare the next battle) rather
 * than ticking blindly, so the next battle is always prepared before the results screen ends.
 * Safe to run alongside the web app and even multiple copies: transitions are row-locked.
 *
 *   pnpm arena:worker
 */
import { randomBytes } from "node:crypto";

import { demoHeroesAllowed } from "../src/server/env";
import { loadSettings } from "../src/server/config/settingsRepo";
import { getChainReader } from "../src/server/rewards/context";
import { verifiedTokenMetadata } from "../src/server/rewards/tokenMetadata";
import { refreshDueHolders } from "../src/server/rewards/holders";
import { settleDueRewards } from "../src/server/rewards/settlement";
import { finalizeDueBoards } from "../src/server/rewards/leaderboard";
import { advanceArena } from "../src/server/services/arena";

import { run } from "./lib/context";

/** Safety net: look at least this often (new heroes, resume after pause, a clock jump). */
const IDLE_TICK_MS = 1000;
/** Never spin faster than this when a transition is due "right now". */
const MIN_TICK_MS = 25;

void run(async ({ db }) => {
  const ctx = { now: () => new Date(), secureSeed: () => randomBytes(16).toString("hex"), allowDemo: demoHeroesAllowed() };
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; });
  console.log(`arena worker started (demo heroes ${ctx.allowDemo ? "ALLOWED" : "excluded"}). Ctrl-C to stop.`);
  let lastStatus = "";
  let holderAt = 0;
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
      if (r.dueAtMs !== null) sleepMs = Math.min(IDLE_TICK_MS, Math.max(MIN_TICK_MS, r.dueAtMs - Date.now()));
      for (const step of r.steps) console.log(new Date().toISOString(), step);
      if (r.status !== lastStatus) {
        console.log(new Date().toISOString(), `status → ${r.status}${r.eligibleHeroes !== undefined ? ` (${r.eligibleHeroes} eligible heroes)` : ""}`);
        lastStatus = r.status;
      }
    } catch (error) {
      console.error(new Date().toISOString(), "advance failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
});
