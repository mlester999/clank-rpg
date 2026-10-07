import { fail, getViewer, ok } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { getBalance } from "@/server/services/economy";
import { listInventory } from "@/server/services/inventory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  const db = await getReadyDb();
  return ok({ claimed: viewer.claimed, items: await listInventory(db, viewer.characterId), gold: await getBalance(db, viewer.characterId) });
}
