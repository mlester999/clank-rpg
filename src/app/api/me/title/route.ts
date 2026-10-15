import { z } from "zod";

import { fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { setDisplayTitle } from "@/server/services/achievements";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/me/title  { achievementId: string | null }
 *
 * Chooses which unlocked achievement's TITLE is shown above the signed-in member's hero (`null` removes it). The body names an achievement, never a piece of
 * text: the server reads the title from the achievement's own reward and refuses an achievement the hero has not unlocked. Claimed owners only; same-origin.
 */
const body = z.strictObject({ achievementId: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/).nullable() });

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`title:${viewer.telegramUserId}`, 30, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body, 512);
  if (!parsed.ok) return parsed.response;
  const characterId = viewer.characterId;
  const result = await (await getReadyDb()).transaction((tx) => setDisplayTitle(tx, characterId, parsed.data.achievementId));
  if (result.ok) return ok({ title: result.title });
  return fail(result.reason, result.reason === "NOT_FOUND" ? 404 : 403);
}

export const POST = guarded("me/title", handlePOST);
