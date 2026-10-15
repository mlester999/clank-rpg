import { isHeroScope, type HeroScope } from "@/domain/heroArena";
import type { HeroBoardPayload } from "@/domain/heroArenaDto";
import { demoHeroesAllowed } from "@/server/env";
import { fail, guarded, ok } from "@/server/http/guards";
import { getClassVisuals, getReadyDb, getSettings } from "@/server/runtime";
import { activeSeasonKey } from "@/server/services/seasonKey";
import { getHeroArenaPayload } from "@/server/services/heroBoards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The aggregate behind a board is the expensive part: it is shared for a few seconds. `serverNow` is stamped per request, never cached.
const memo = new Map<string, { at: number; payload: HeroBoardPayload }>();
const MEMO_MS = 4_000;

/**
 * HERO ARENA — `?scope=daily|weekly|season` (default daily), `?start=YYYY-MM-DD` for a past Daily / Weekly period, `?season=<id>` for another season's standings.
 *
 * Heroes ranked by ARENA WINS over the SETTLED battles of the period and of ONE season. Daily and Weekly are REWARDED (the payload carries the prize rules);
 * Season is standings only (no rules, no prizes). Public: hero identities only — never a Telegram id, a wallet or an owner id.
 */
async function handleGET(req: Request) {
  const url = new URL(req.url);
  const scope = (url.searchParams.get("scope") ?? "daily").toUpperCase();
  if (!isHeroScope(scope)) return fail("INVALID_SCOPE", 400, "Choose daily, weekly or season.");
  const start = url.searchParams.get("start");
  const season = url.searchParams.get("season");
  const nowMs = Date.now();
  const db = await getReadyDb();
  const key = `${await activeSeasonKey(db)}:${scope}:${start ?? ""}:${season ?? ""}`; // season-scoped: a launch can never be answered from a board computed before it
  const hit = memo.get(key);
  if (hit && nowMs - hit.at < MEMO_MS) return ok({ ...hit.payload, board: { ...hit.payload.board, serverNow: nowMs } }, { cache: "no-store" });
  const payload = await getHeroArenaPayload(db, scope as HeroScope, { nowMs, settings: await getSettings(), allowDemo: demoHeroesAllowed(), classes: await getClassVisuals(), seasonId: season, start, limit: 50 });
  memo.set(key, { at: nowMs, payload });
  if (memo.size > 60) memo.delete(memo.keys().next().value as string);
  return ok(payload, { cache: "no-store" });
}

export const GET = guarded("leaderboard/hero-arena", handleGET);
