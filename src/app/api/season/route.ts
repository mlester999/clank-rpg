import { fail, guarded, ok } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { getPublicSeason } from "@/server/services/publicSeason";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Where the game stands, for the navigation, the footer and page headings: the persisted phase and the active season's public label. No viewer data — a shared cache may hold it for seconds. */
async function handleGET() {
  const db = await getReadyDb();
  const s = await getPublicSeason(db);
  if (!s) return fail("UNAVAILABLE", 503);
  return ok(s, { cache: "public, max-age=0, s-maxage=15, stale-while-revalidate=60" });
}

export const GET = guarded("season", handleGET);
