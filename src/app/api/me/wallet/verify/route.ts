import { z } from "zod";

import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getEnabledClasses, getProviders, getReadyDb, getSettings } from "@/server/runtime";
import { syncCharacterHoldings } from "@/server/services/holdings";
import { verifyWalletLink } from "@/server/services/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ nonce: z.string().min(16).max(128), signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) });

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`wverify:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  const r = await verifyWalletLink(db, viewer.characterId, parsed.data.nonce, parsed.data.signature);
  if (!r.ok) return fail(r.reason, r.reason === "BAD_SIGNATURE" ? 401 : 409);
  // First verification of holdings happens right away; if the chain is unreachable the link still stands.
  const sync = await syncCharacterHoldings(db, viewer.characterId, { reader: getProviders().reader, settings: await getSettings(), classes: await getEnabledClasses(), force: true }).catch(() => ({ status: "UNAVAILABLE" as const, reason: "Chain data unavailable." }));
  return ok({ linked: true, holdings: sync });
}
