import { fail, getViewer, guarded, ok } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { listShop } from "@/server/services/shop";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/me/shop — the Gear Shop for the signed-in hero: what its class can buy and at what price, its Gold, and whether the shop is open. */
async function handleGET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  const settings = await getSettings();
  const view = await listShop(await getReadyDb(), viewer.characterId, settings.shop);
  return view ? ok({ shop: view }) : fail("NOT_FOUND", 404);
}

export const GET = guarded("me/shop", handleGET);
