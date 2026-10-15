import { isPeriodStart, periodWindow, type PeriodKind } from "@/domain/rewards/time";
import { fail, getViewer, ok, guarded } from "@/server/http/guards";
import { boardRules, findFinalizingPeriod, getFinalBoard, getLiveBoard, listFinalizedPeriods, type BoardDto, type BoardMeDto, type BoardPayload } from "@/server/rewards/leaderboard";
import { rewardsReady } from "@/server/rewards/pool";
import { getReadyDb, getSettings } from "@/server/runtime";
import { activeSeasonKey } from "@/server/services/seasonKey";
import { getPicksSeasonPayload, listLeaderboardSeasons, pickSeason } from "@/server/services/heroBoards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The aggregate of a running period is the expensive part; it is shared for a few seconds. Everything time-related
// (`serverNow`) and everything personal (`me`) is stamped per request, never cached.
const memo = new Map<string, { at: number; board: BoardDto }>();
const MEMO_MS = 4_000;

/**
 * The DAILY and WEEKLY ARENA PICKS leaderboards. `?period=daily|weekly` (default daily).
 *
 *   DAILY   00:00:00 UTC → next 00:00:00 UTC       WEEKLY  Monday 00:00:00 UTC → next Monday
 *
 * Ranked by points then accuracy across scored picks. Public; hero identities only. `serverNow`, `startsAt` and `endsAt` are the
 * SERVER's: the browser only counts down between fetches and re-fetches when the period ends (the next one is already running;
 * nobody can reset a leaderboard). `?start=YYYY-MM-DD` shows a past period from its frozen rows — or, for the one that just ended
 * and is still being frozen, its live standings marked FINALIZING. A signed-in member also gets their own standing (`me`).
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const periodParam = (url.searchParams.get("period") ?? "daily").toLowerCase();
  // SEASON: the cumulative standings of one season (default the current one) — standings only, no prize ladder, no payout.
  if (periodParam === "season") {
    const viewer = await getViewer(req);
    return ok(await getPicksSeasonPayload(await getReadyDb(), { nowMs: Date.now(), seasonId: url.searchParams.get("season"), viewerId: viewer?.telegramUserId ?? null, limit: 50 }), { cache: "no-store" });
  }
  if (periodParam !== "daily" && periodParam !== "weekly") return fail("INVALID_PERIOD", 400, "Choose daily, weekly or season.");
  const kind: PeriodKind = periodParam === "weekly" ? "WEEKLY" : "DAILY";
  const start = url.searchParams.get("start");
  const nowMs = Date.now();
  const current = periodWindow(kind, nowMs);
  if (start !== null && (!isPeriodStart(kind, start) || Date.parse(`${start}T00:00:00Z`) > nowMs)) return fail("INVALID_PERIOD", 400, kind === "WEEKLY" ? "Choose a week (a Monday, YYYY-MM-DD) that has started." : "Choose a day (YYYY-MM-DD) that has started.");
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503);
  const settings = await getSettings();
  const viewer = await getViewer(req);
  const viewerId = viewer?.telegramUserId ?? null;
  const finalizing = await findFinalizingPeriod(db, kind, nowMs);

  let board: BoardDto;
  let me: BoardMeDto | null;
  if (start === null || start === current.start) {
    const key = `${await activeSeasonKey(db)}:${kind}:${current.start}`; // season-scoped: a launch can never be answered from a board computed before it
    const cached = memo.get(key);
    if (cached && nowMs - cached.at < MEMO_MS && viewerId === null) {
      board = { ...cached.board, serverNow: nowMs };
      me = null;
    } else {
      const r = await getLiveBoard(db, { kind, nowMs, settings, viewerId, limit: 50 });
      board = r.board;
      me = r.me;
      memo.set(key, { at: nowMs, board: r.board });
    }
  } else {
    const final = await getFinalBoard(db, kind, start, { nowMs, viewerId, limit: 100 });
    if (final) {
      board = final.board;
      me = final.me;
    } else if (start === finalizing) {
      // Ended, scored, not frozen yet (a few seconds): its live standings, honestly marked FINALIZING.
      const r = await getLiveBoard(db, { kind, start, nowMs, settings, viewerId, limit: 100 });
      board = r.board;
      me = r.me;
    } else {
      return fail("PERIOD_NOT_FINALIZED", 404, "That period has no results.");
    }
  }
  const periods = await listFinalizedPeriods(db, kind, 30);
  const season = pickSeason(await listLeaderboardSeasons(db), null);
  const payload: BoardPayload = { board, me, periods, current: { kind, start: current.start, startsAt: current.startsAt, endsAt: current.endsAt }, finalizing, serverNow: nowMs, season: season ? { label: season.label, kind: season.kind } : null, programme: { daily: boardRules(settings, "DAILY"), weekly: boardRules(settings, "WEEKLY") } };
  return ok(payload, { cache: "no-store" });
}

export const GET = guarded("leaderboard/picks", handleGET);
