import { z } from "zod";

import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb, getSettings, getEnabledClasses } from "@/server/runtime";
import { refreshPower } from "@/server/services/characters";
import { setEquipped } from "@/server/services/inventory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ itemId: z.string().uuid(), equip: z.boolean() });

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`equip:${viewer.telegramUserId}`, 40, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  const characterId = viewer.characterId;
  const result = await db.transaction(async (tx) => {
    const r = await setEquipped(tx, characterId, parsed.data.itemId, parsed.data.equip);
    if (r.ok) await refreshPower(tx, characterId, await getSettings(), await getEnabledClasses());
    return r;
  });
  if (!result.ok) return fail(result.reason, result.reason === "NOT_FOUND" ? 404 : 403);
  return ok({ equipped: result.equipped });
}
