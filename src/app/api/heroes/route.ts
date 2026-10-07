import { demoHeroesAllowed } from "@/server/env";
import { clientKey, fail, ok, rateLimited } from "@/server/http/guards";
import { getClassVisuals, getReadyDb } from "@/server/runtime";
import { searchHeroes } from "@/server/services/views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  if (rateLimited(`search:${clientKey(req)}`, 60, 60_000)) return fail("RATE_LIMITED", 429);
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2 || q.length > 40) return ok({ heroes: [], classes: {} });
  return ok({ heroes: await searchHeroes(await getReadyDb(), q, demoHeroesAllowed()), classes: await getClassVisuals() });
}
