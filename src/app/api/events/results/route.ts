import { isEventKind, isEventProgram } from "@/domain/events";
import { fail, guarded, ok } from "@/server/http/guards";
import { getClassVisuals, getReadyDb } from "@/server/runtime";
import { getPeriodDetail } from "@/server/services/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EVENTS — the final standings (Top 10) of one completed period: `?program=picks|hero&kind=daily|weekly&start=YYYY-MM-DD` (+ `&season=<id>`). A period that is not a
 * completed period of an official season — a future date, a day before Season 1, a development-run day, a malformed date — is a plain 404: nothing is guessed or recomputed.
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const program = url.searchParams.get("program");
  const kind = url.searchParams.get("kind");
  const start = url.searchParams.get("start");
  if (!isEventProgram(program)) return fail("INVALID_PROGRAM", 400, "Choose picks or hero.");
  if (!isEventKind(kind)) return fail("INVALID_KIND", 400, "Choose daily or weekly.");
  if (!start) return fail("INVALID_PERIOD", 400);
  const season = url.searchParams.get("season");
  if (season !== null && !UUID.test(season)) return fail("INVALID_SEASON", 400);
  const db = await getReadyDb();
  const detail = await getPeriodDetail(db, { program, kind, start, nowMs: Date.now(), seasonId: season });
  if (!detail) return fail("NOT_FOUND", 404);
  return ok({ period: detail, classes: await getClassVisuals() }, { cache: detail.finalizedAt === null ? "no-store" : "public, max-age=0, s-maxage=60, stale-while-revalidate=300" });
}

export const GET = guarded("events/results", handleGET);
