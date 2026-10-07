import { fail, getViewer, ok, rateLimited, sameOriginOk, guarded } from "@/server/http/guards";
import { getEnabledClasses, getProviders, getReadyDb, getSettings } from "@/server/runtime";
import { syncCharacterHoldings } from "@/server/services/holdings";
import { unlinkWallet } from "@/server/services/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`wrefresh:${viewer.telegramUserId}`, 6, 60_000)) return fail("RATE_LIMITED", 429);
  const result = await syncCharacterHoldings(await getReadyDb(), viewer.characterId, { reader: getProviders().reader, settings: await getSettings(), classes: await getEnabledClasses() }).catch(() => ({ status: "UNAVAILABLE" as const, reason: "Chain data unavailable." }));
  return ok({ holdings: result });
}

async function handleDELETE(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  return ok({ unlinked: await unlinkWallet(await getReadyDb(), viewer.characterId) });
}

export const POST = guarded("me/wallet/refresh", handlePOST);
export const DELETE = guarded("me/wallet/refresh", handleDELETE);
