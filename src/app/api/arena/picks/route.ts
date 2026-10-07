import { z } from "zod";

import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk, guarded } from "@/server/http/guards";
import { eligibilityExplanation, getRewardEligibility, publicIneligibleReason } from "@/server/rewards/eligibility";
import { rewardsReady } from "@/server/rewards/pool";
import { getPickRound } from "@/server/rewards/summary";
import { arenaContext, getReadyDb, getSettings, isFlagOn } from "@/server/runtime";
import { getMyPick, getPickCrowd, getPicksWindow, submitPick, type PickRejection } from "@/server/services/picks";
import { demoHeroesAllowed } from "@/server/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const body = z.strictObject({ battleId: z.string().regex(UUID), characterId: z.string().regex(UUID) });

const STATUS: Record<PickRejection, number> = { NOT_FOUND: 404, NOT_A_FIGHTER: 422, NOT_OPEN: 409, LOCKED: 409, RESOLVED: 409, NOT_ELIGIBLE: 403 };

/**
 * The signed-in member's OWN pick for a battle (the battle that was PREDICTED — the upcoming battle at the time of the pick),
 * whether they may make rewarded picks, and that battle's public pick state: whether its window is closed (the server decides:
 * see domain/arena/picksWindow.ts), the crowd (per-fighter counts) only AFTER it closed, and the member's own outcome once the
 * battle is over. Nobody else's pick is ever returned.
 */
async function handleGET(req: Request) {
  const battleId = new URL(req.url).searchParams.get("battleId") ?? "";
  if (!UUID.test(battleId)) return fail("INVALID_BATTLE", 400);
  const db = await getReadyDb();
  const settings = await getSettings();
  const viewer = await getViewer(req);
  const ready = await rewardsReady(db);
  const now = Date.now();
  const base = ready ? await getPickRound(db, viewer?.telegramUserId ?? null, battleId) : { outcome: null };
  // The lock is the window rule's, not the reward module's: picks are made on the UPCOMING battle and close when the battle ahead of
  // it is decided — long before this battle's own combat. The crowd is released only once the window has closed (anti-herding).
  const verdict = await getPicksWindow(db, battleId, now);
  const closed = verdict !== null && (verdict.window.state === "LOCKED" || verdict.window.state === "RESOLVED" || verdict.window.state === "VOID");
  const round = { ...base, locked: closed, distribution: closed && ready ? await getPickCrowd(db, battleId) : null, window: verdict ? verdict.window.state : "NOT_FOUND" };
  if (!viewer) return ok({ signedIn: false, eligibility: null, pick: null, round });
  const eligibility = ready ? await getRewardEligibility(db, viewer.telegramUserId, { threshold: settings.telegram.qualifyingThreshold, allowDemo: demoHeroesAllowed() }) : null;
  return ok({
    signedIn: true,
    eligibility: eligibility ? { eligible: eligibility.eligible, reason: publicIneligibleReason(eligibility.reason), explanation: eligibilityExplanation(eligibility.threshold) } : null,
    pick: ready ? await getMyPick(db, viewer.telegramUserId, battleId) : null,
    round,
  });
}

/**
 * Submit or change a FREE pick. The member is ALWAYS the signed session's Telegram id — a body-supplied identity does not
 * exist. The clock, the roster, the one-pick rule and the eligibility are enforced in the service and the database; this layer
 * only authenticates and validates.
 */
async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`pick:${viewer.telegramUserId}`, 30, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.response;
  if (!(await isFlagOn("arena.picks"))) return fail("PICKS_DISABLED", 409);

  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503);
  const settings = await getSettings();
  const result = await submitPick(db, arenaContext(), { telegramUserId: viewer.telegramUserId, ...parsed.data, threshold: settings.telegram.qualifyingThreshold });
  if (!result.ok) return fail(result.reason, STATUS[result.reason], result.reason === "NOT_ELIGIBLE" ? eligibilityExplanation(settings.telegram.qualifyingThreshold) : undefined);
  return ok({ pick: result.pick, changed: result.changed });
}

export const GET = guarded("arena/picks", handleGET);
export const POST = guarded("arena/picks", handlePOST);
