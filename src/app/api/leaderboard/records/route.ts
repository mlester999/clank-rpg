import { isHeroScope, isRecordMetric, type HeroScope, type RecordMetric } from "@/domain/heroArena";
import type { HeroRecordsPayload } from "@/domain/heroArenaDto";
import { demoHeroesAllowed } from "@/server/env";
import { fail, guarded, ok } from "@/server/http/guards";
import { getClassVisuals, getReadyDb, getSettings } from "@/server/runtime";
import { getHeroRecordsPayload } from "@/server/services/heroBoards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const memo = new Map<string, { at: number; payload: HeroRecordsPayload }>();
const MEMO_MS = 4_000;

/**
 * HERO RECORDS — statistics, NO prizes: `?metric=top2|kos|pwr`, and for Top-2 / KOs `?scope=daily|weekly|season` (default season) and `?season=<id>`.
 * PWR is the CURRENT power of every active hero (no scope: power is not an event that accumulates, and no history of it is kept).
 * Wins are not here: they are the rewarded HERO ARENA metric and live there.
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const metric = (url.searchParams.get("metric") ?? "top2").toUpperCase();
  if (!isRecordMetric(metric)) return fail("INVALID_METRIC", 400, "Choose top2, kos or pwr.");
  const scope = (url.searchParams.get("scope") ?? "season").toUpperCase();
  if (!isHeroScope(scope)) return fail("INVALID_SCOPE", 400, "Choose daily, weekly or season.");
  const season = url.searchParams.get("season");
  const nowMs = Date.now();
  const key = `${metric}:${metric === "PWR" ? "" : scope}:${season ?? ""}`;
  const hit = memo.get(key);
  if (hit && nowMs - hit.at < MEMO_MS) return ok({ ...hit.payload, board: { ...hit.payload.board, serverNow: nowMs } }, { cache: "no-store" });
  const db = await getReadyDb();
  const payload = await getHeroRecordsPayload(db, metric as RecordMetric, scope as HeroScope, { nowMs, settings: await getSettings(), allowDemo: demoHeroesAllowed(), classes: await getClassVisuals(), seasonId: season, limit: 50 });
  memo.set(key, { at: nowMs, payload });
  if (memo.size > 60) memo.delete(memo.keys().next().value as string);
  return ok(payload, { cache: "no-store" });
}

export const GET = guarded("leaderboard/records", handleGET);
