import { z } from "zod";

import { fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { sellItem } from "@/server/services/shop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ itemId: z.string().uuid() });
const STATUS = { SHOP_CLOSED: 403, NOT_FOUND: 404, NOT_CLAIMED: 403, NOT_FOR_SALE: 404, CLASS_RESTRICTED: 403, INSUFFICIENT_GOLD: 402, EQUIPPED: 409 } as const;

/** POST /api/me/shop/sell { itemId } — sells one spare (unequipped) item of the signed-in hero for its rarity's sell price. The body carries no price. Claimed owners only; same-origin. */
async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`shop:${viewer.telegramUserId}`, 40, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body, 256);
  if (!parsed.ok) return parsed.response;
  const settings = await getSettings();
  const result = await sellItem(await getReadyDb(), viewer.characterId, parsed.data.itemId, settings.shop);
  return result.ok ? ok({ price: result.price, gold: result.gold }) : fail(result.reason, STATUS[result.reason]);
}

export const POST = guarded("me/shop/sell", handlePOST);
