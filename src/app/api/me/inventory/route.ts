import { fail, getViewer, ok, guarded } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { getBalance } from "@/server/services/economy";
import { listInventory } from "@/server/services/inventory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  const db = await getReadyDb();
  const shop = (await getSettings()).shop;
  // `shop.sell` is what a spare item of each rarity sells for (the inventory shows it on every item); null while the shop is closed.
  return ok({ claimed: viewer.claimed, items: await listInventory(db, viewer.characterId), gold: await getBalance(db, viewer.characterId), shop: { enabled: shop.enabled, sell: shop.enabled ? shop.sell : null } });
}

export const GET = guarded("me/inventory", handleGET);
