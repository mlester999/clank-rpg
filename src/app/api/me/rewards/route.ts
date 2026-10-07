import { fail, getViewer, ok } from "@/server/http/guards";
import { demoHeroesAllowed } from "@/server/env";
import { rewardsReady } from "@/server/rewards/pool";
import { getPickStats, getRewardSummary, listPickHistory } from "@/server/rewards/summary";
import { tokenView } from "@/server/rewards/tokenMetadata";
import { getReadyDb, getSettings } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The signed-in member's own Arena Picks stats, reward balances, claims and recent rewards (their own only), and pick history. */
export async function GET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503);
  const settings = await getSettings();
  // The token's launched / verified state from the persisted cache (no chain call unless nothing is cached): reward amounts themselves are logical.
  const view = await tokenView(db);
  const [summary, stats, history] = await Promise.all([
    getRewardSummary(db, viewer.telegramUserId, { settings, token: view.token, claimsEnabled: view.available, allowDemo: demoHeroesAllowed(), holdersAvailable: view.available, nowMs: Date.now() }),
    getPickStats(db, viewer.telegramUserId),
    listPickHistory(db, viewer.telegramUserId, 25),
  ]);
  return ok({ rewards: summary, stats, history, freshAuthMinutes: settings.arena_picks.walletChangeFreshMinutes });
}
