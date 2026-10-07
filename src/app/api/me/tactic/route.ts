import { z } from "zod";

import { fail, getViewer, ok, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { setTactic } from "@/server/services/inventory";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ tactic: z.enum(["AGGRESSIVE", "BALANCED", "DEFENSIVE"]) });

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer?.characterId) return fail("UNAUTHENTICATED", 401);
  const parsed = await readJson(req, body);
  if (!parsed.ok) return parsed.response;
  const changed = await setTactic(await getReadyDb(), viewer.characterId, parsed.data.tactic);
  return changed ? ok({ tactic: parsed.data.tactic }) : fail("NOT_CLAIMED", 403);
}
