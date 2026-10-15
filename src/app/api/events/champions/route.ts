import { isEventKind, isEventProgram } from "@/domain/events";
import { fail, guarded, ok } from "@/server/http/guards";
import { getClassVisuals, getReadyDb } from "@/server/runtime";
import { listEventPeriods } from "@/server/services/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * EVENTS — the champions of the COMPLETED periods of an official season: `?program=picks|hero&kind=daily|weekly` (required), `&before=YYYY-MM-DD` for the next older
 * page, `&limit=` (1–12, default 8), `&season=<id>` for another official season. Public and viewer-independent: finalized results are frozen rows and carry no
 * Telegram id, wallet, owner or review state, so a shared cache may hold them briefly (the short lifetime only covers a period being finalized or a prize being resolved).
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const program = url.searchParams.get("program");
  const kind = url.searchParams.get("kind");
  if (!isEventProgram(program)) return fail("INVALID_PROGRAM", 400, "Choose picks or hero.");
  if (!isEventKind(kind)) return fail("INVALID_KIND", 400, "Choose daily or weekly.");
  const season = url.searchParams.get("season");
  if (season !== null && !UUID.test(season)) return fail("INVALID_SEASON", 400);
  const limit = Math.min(Math.max(Math.trunc(Number(url.searchParams.get("limit") ?? 8)) || 8, 1), 12);
  const db = await getReadyDb();
  const body = await listEventPeriods(db, { program, kind, nowMs: Date.now(), before: url.searchParams.get("before"), limit, seasonId: season });
  return ok({ ...body, classes: await getClassVisuals() }, { cache: "public, max-age=0, s-maxage=30, stale-while-revalidate=120" });
}

export const GET = guarded("events/champions", handleGET);
