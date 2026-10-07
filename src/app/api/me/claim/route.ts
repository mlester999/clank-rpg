import { fail, getViewer, ok, rateLimited, sameOriginOk, guarded } from "@/server/http/guards";
import { getReadyDb, isFlagOn } from "@/server/runtime";
import { claimCharacter } from "@/server/services/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`claim:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429);
  if (!(await isFlagOn("claims.enabled"))) return fail("CLAIMS_PAUSED", 503);
  // The hero is resolved from the session's IMMUTABLE Telegram id — nothing from the request body is trusted.
  const result = await claimCharacter(await getReadyDb(), viewer.telegramUserId, new Date());
  if (!result.ok) return fail(result.reason, result.reason === "NO_HERO" ? 404 : 409);
  return ok({ characterId: result.characterId, alreadyClaimed: result.alreadyClaimed });
}

export const POST = guarded("me/claim", handlePOST);
