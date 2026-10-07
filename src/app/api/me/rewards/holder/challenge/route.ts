import { z } from "zod";

import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk, guarded } from "@/server/http/guards";
import { getChainReader } from "@/server/rewards/context";
import { createHolderChallenge } from "@/server/rewards/holders";
import { rewardMessage } from "@/server/rewards/messages";
import { rewardsReady } from "@/server/rewards/pool";
import { forbiddenRecipients } from "@/server/rewards/target";
import { getReadyDb } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ address: z.string().min(40).max(64) });

/** Step 1 of the OPTIONAL holder-wallet verification: the SERVER issues a single-use, expiring message for the member to sign. */
async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`hchal:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429, rewardMessage("RATE_LIMITED"));
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503, rewardMessage("REWARDS_UNAVAILABLE"));
  const reader = await getChainReader();
  if (!reader) return fail("HOLDERS_UNAVAILABLE", 503, rewardMessage("HOLDERS_UNAVAILABLE"));
  const r = await createHolderChallenge(db, { now: () => new Date() }, { userId: viewer.telegramUserId, address: parsed.data.address, chainId: reader.chainId, forbidden: forbiddenRecipients() });
  if (!r.ok) return fail(r.reason, r.reason === "INVALID_WALLET" ? 422 : 403, rewardMessage(r.reason));
  return ok({ nonce: r.nonce, message: r.message, expiresAt: r.expiresAt });
}

export const POST = guarded("me/rewards/holder/challenge", handlePOST);
