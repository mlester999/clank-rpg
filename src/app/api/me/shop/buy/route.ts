import { NextResponse } from "next/server";
import { z } from "zod";

import { fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { buyItem } from "@/server/services/shop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** `requestId` is the browser's idempotency key for ONE purchase click: a retry with the same key never charges twice. The price is the server's; the body carries no amount. */
const body = z.strictObject({ templateId: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/), requestId: z.string().regex(UUID, "requestId must be a UUID") });

const STATUS = { SHOP_CLOSED: 403, NOT_FOUND: 404, NOT_CLAIMED: 403, NOT_FOR_SALE: 404, CLASS_RESTRICTED: 403, INSUFFICIENT_GOLD: 402, EQUIPPED: 409 } as const;

/** POST /api/me/shop/buy { templateId, requestId } — buys one item for Clank Gold. Claimed owners only; same-origin. */
async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`shop:${viewer.telegramUserId}`, 40, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body, 512);
  if (!parsed.ok) return parsed.response;
  // Settings are read BEFORE the purchase transaction opens (the shared handle has one connection in production: see docs/DATABASE_CONNECTIONS.md).
  const settings = await getSettings();
  const result = await buyItem(await getReadyDb(), viewer.characterId, parsed.data.templateId, parsed.data.requestId.toLowerCase(), settings.shop);
  if (result.ok) return ok({ itemId: result.itemId, templateId: result.templateId, price: result.price, gold: result.gold, alreadyApplied: result.alreadyApplied });
  // An empty purse answers with how much Gold the hero really has, so the screen can say what is missing.
  if (result.reason === "INSUFFICIENT_GOLD") return NextResponse.json({ ok: false, error: "INSUFFICIENT_GOLD", gold: result.gold ?? 0 }, { status: 402, headers: { "Cache-Control": "no-store" } });
  return fail(result.reason, STATUS[result.reason]);
}

export const POST = guarded("me/shop/buy", handlePOST);
