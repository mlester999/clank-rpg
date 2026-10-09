import { z } from "zod";

import { FREE_REROLL_FLAG, REROLL_REQUEST_ID } from "@/domain/hero/freeReroll";
import { demoHeroesAllowed, getSecret } from "@/server/env";
import { clientKey, fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getEnabledClasses, getReadyDb, getSettings, isFlagOn } from "@/server/runtime";
import { FreeRerollError, getFreeRerollStatus, rerollOwnHero, type FreeRerollDeps } from "@/server/services/heroFreeReroll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE FREE DAILY HERO REROLL (docs/HERO_FREE_REROLL.md).
 *
 *   GET   /api/me/hero/reroll   the signed-in member's status: DISABLED · UNAVAILABLE · AVAILABLE · USED (with today's before/after) · BLOCKED, the
 *                               server's clock, the next 00:00 UTC, and the hero as it is now. Read-only.
 *   POST  /api/me/hero/reroll   { requestId }   rerolls the SESSION's own hero with today's allowance. The body carries nothing but an idempotency
 *                               key: no hero id, no member id, no seed, no class, no rarity — the server decides all of it. Same-origin only.
 *
 * Behind the feature flag `hero.free_reroll` (OFF by default): a disabled feature answers 403 FREE_REROLL_DISABLED and writes nothing.
 */

async function deps(): Promise<FreeRerollDeps> {
  return { settings: await getSettings(), classes: await getEnabledClasses(), secret: getSecret("CLASS_ROLL_SECRET"), allowDemo: demoHeroesAllowed() };
}

async function handleGET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  const status = await getFreeRerollStatus(await getReadyDb(), viewer.telegramUserId, await isFlagOn(FREE_REROLL_FLAG), await deps());
  return ok({ status });
}

const body = z.strictObject({ requestId: z.string().regex(REROLL_REQUEST_ID, "requestId must be a UUID") });

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  // A courtesy brake against a script hammering the endpoint — NOT the limit: the one-per-UTC-day rule is a database constraint.
  if (rateLimited(`hero-reroll:${viewer.telegramUserId}`, 12, 60_000) || rateLimited(`hero-reroll-ip:${clientKey(req)}`, 60, 60_000)) return fail("RATE_LIMITED", 429);
  if (!(await isFlagOn(FREE_REROLL_FLAG))) return fail("FREE_REROLL_DISABLED", 403);
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const result = await rerollOwnHero(await getReadyDb(), viewer.telegramUserId, parsed.data.requestId.toLowerCase(), await deps());
    return ok({ result });
  } catch (error) {
    if (error instanceof FreeRerollError) {
      // `INVALID_ROLL` is a server fault (the generator produced something it should not): say so briefly, never the internals.
      if (error.code === "INVALID_ROLL") console.error("[hero-reroll] invalid roll refused:", error.message);
      return fail(error.code, error.status, error.code === "INVALID_ROLL" ? "The roll could not be completed. Nothing was used — try again." : error.message);
    }
    throw error;
  }
}

export const GET = guarded("me/hero/reroll", handleGET);
export const POST = guarded("me/hero/reroll", handlePOST);
