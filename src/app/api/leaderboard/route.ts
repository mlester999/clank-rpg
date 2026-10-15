import { publicSeasonLabel, type SeasonKind } from "@/domain/lifecycle";
import { demoHeroesAllowed } from "@/server/env";
import { fail, ok, guarded } from "@/server/http/guards";
import { getClassVisuals, getReadyDb, getSettings } from "@/server/runtime";
import { BOARDS, BOARD_IDS, getLeaderboard, type BoardId } from "@/server/services/leaderboard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handleGET(req: Request) {
  const params = new URL(req.url).searchParams;
  const board = (params.get("board") ?? "WINS").toUpperCase() as BoardId;
  if (!BOARD_IDS.includes(board)) return fail("UNKNOWN_BOARD", 400);
  const limit = Math.min(Math.max(Number(params.get("limit") ?? 25) || 25, 1), 100);
  const offset = Math.max(Number(params.get("offset") ?? 0) || 0, 0);
  const db = await getReadyDb();
  const [seasonRow] = await db.query<{ id: string; kind: SeasonKind; number: number | null; name: string }>("select id, kind, number, name from public.seasons where status = 'ACTIVE' limit 1");
  const season = seasonRow ? { ...seasonRow, label: publicSeasonLabel(seasonRow) } : undefined;
  const rows = await getLeaderboard(db, board, { limit, offset, seasonId: season?.id ?? null, allowDemo: demoHeroesAllowed(), seasonRanks: (await getSettings()).progression.seasonRanks });
  return ok({ board, label: BOARDS[board].label, seasonal: BOARDS[board].season, season: season ?? null, rows, classes: await getClassVisuals() }, { cache: "public, s-maxage=5, stale-while-revalidate=15" });
}

export const GET = guarded("leaderboard", handleGET);
