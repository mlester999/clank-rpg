import { z } from "zod";

import { getEnv } from "@/server/env";
import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk, guarded } from "@/server/http/guards";
import { getReadyDb, isFlagOn } from "@/server/runtime";
import { createWalletChallenge } from "@/server/services/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ address: z.string().min(40).max(64) });

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (!(await isFlagOn("wallet.link"))) return fail("WALLET_LINK_PAUSED", 503);
  if (rateLimited(`wchal:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body);
  if (!parsed.ok) return parsed.response;
  const r = await createWalletChallenge(await getReadyDb(), viewer.characterId, parsed.data.address, getEnv().ROBINHOOD_CHAIN_ID);
  if (!r.ok) return fail(r.reason, r.reason === "BAD_ADDRESS" ? 422 : 409);
  return ok({ nonce: r.nonce, message: r.message, expiresAt: r.expiresAt.toISOString() });
}

export const POST = guarded("me/wallet/challenge", handlePOST);
