import { z } from "zod";

import { demoHeroesAllowed } from "@/server/env";
import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getChainReader } from "@/server/rewards/context";
import { getHolderCard, verifyHolderWallet } from "@/server/rewards/holders";
import { rewardMessage } from "@/server/rewards/messages";
import { rewardsReady } from "@/server/rewards/pool";
import { forbiddenRecipients } from "@/server/rewards/target";
import { tokenView } from "@/server/rewards/tokenMetadata";
import { getReadyDb, getSettings } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ nonce: z.string().min(16).max(128), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });

const STATUS = { INVALID_CHALLENGE: 409, BAD_SIGNATURE: 403, NOT_ELIGIBLE: 403, INVALID_WALLET: 422, WALLET_IN_USE: 409, FRESH_AUTH_REQUIRED: 403 } as const;

/**
 * Step 2: the member signed the server's message. The server recovers the signer, requires it to equal the challenged address,
 * links it as the member's VERIFIED wallet (one wallet ↔ one account), then reads the balance ITSELF (ERC-20 balanceOf on the
 * configured contract) and logs the first observation. The browser never supplies an address-for-balance, a balance or a tier. Even a
 * holder of 10M earns no bonus yet: a holder bonus needs verified holding continuity from BEFORE a leaderboard period began.
 */
export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`hverify:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429, rewardMessage("RATE_LIMITED"));
  const parsed = await readJson(req, body, 2048);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503, rewardMessage("REWARDS_UNAVAILABLE"));
  const reader = await getChainReader();
  if (!reader) return fail("HOLDERS_UNAVAILABLE", 503, rewardMessage("HOLDERS_UNAVAILABLE"));
  const settings = await getSettings();

  const result = await verifyHolderWallet(db, { now: () => new Date(), allowDemo: demoHeroesAllowed() }, {
    userId: viewer.telegramUserId, ...parsed.data, sessionIssuedAtMs: viewer.sessionIssuedAtMs, settings, forbidden: forbiddenRecipients(), reader,
  }).catch((error: unknown) => {
    if (error instanceof Error && /already linked to another account|arena_reward_accounts_wallet_unique/i.test(error.message)) return { ok: false as const, reason: "WALLET_IN_USE" as const };
    throw error;
  });
  if (!result.ok) return fail(result.reason, STATUS[result.reason], rewardMessage(result.reason === "WALLET_IN_USE" ? "HOLDER_WALLET_IN_USE" : result.reason));
  const view = await tokenView(db);
  return ok({ changed: result.changed, holder: await getHolderCard(db, viewer.telegramUserId, settings, view.token, Date.now(), view.available) });
}
