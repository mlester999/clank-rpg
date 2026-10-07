import { fail, getViewer, ok, rateLimited, sameOriginOk, guarded } from "@/server/http/guards";
import { getChainReader } from "@/server/rewards/context";
import { getHolderCard, refreshHolder } from "@/server/rewards/holders";
import { rewardMessage } from "@/server/rewards/messages";
import { rewardsReady } from "@/server/rewards/pool";
import { tokenView } from "@/server/rewards/tokenMetadata";
import { getReadyDb, getSettings } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** "Refresh holdings": the SERVER re-reads the verified wallet's balance (throttled per member) and logs the observation. No body: nothing for the browser to claim. */
async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`hrefresh:${viewer.telegramUserId}`, 6, 60_000)) return fail("RATE_LIMITED", 429, rewardMessage("RATE_LIMITED"));
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503, rewardMessage("REWARDS_UNAVAILABLE"));
  const reader = await getChainReader();
  if (!reader) return fail("HOLDERS_UNAVAILABLE", 503, rewardMessage("HOLDERS_UNAVAILABLE"));
  const settings = await getSettings();
  const r = await refreshHolder(db, { now: () => new Date() }, { userId: viewer.telegramUserId, reader, settings, manual: true });
  const view = await tokenView(db); // after the refresh: the read just verified (and persisted) the contract's metadata
  const holder = await getHolderCard(db, viewer.telegramUserId, settings, view.token, Date.now(), view.available);
  return ok({ refresh: r.status, holder });
}

export const POST = guarded("me/rewards/holder/refresh", handlePOST);
