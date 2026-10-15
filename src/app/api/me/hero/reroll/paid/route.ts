import { z } from "zod";

import { REROLL_REQUEST_ID } from "@/domain/hero/freeReroll";
import { FREE_REROLL_FLAG } from "@/domain/hero/freeReroll";
import { PAID_REROLL_FLAG, TX_HASH } from "@/domain/hero/paidReroll";
import { demoHeroesAllowed, getEnv, getSecret } from "@/server/env";
import { clientKey, fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { resolveTokenConfig } from "@/server/rewards/config";
import { getChainReader } from "@/server/rewards/context";
import { getEnabledClasses, getReadyDb, getSettings, isFlagOn } from "@/server/runtime";
import { confirmPaidReroll, getPaidRerollStatus, PaidRerollError, type PaidRerollDeps } from "@/server/services/heroPaidReroll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * THE PAID HERO REROLL (docs/HERO_PAID_REROLL.md).
 *
 *   GET   /api/me/hero/reroll/paid   the signed-in member's status: DISABLED · UNAVAILABLE · FREE_FIRST · AVAILABLE (with the exact payment the wallet must send) ·
 *                                    CREDIT_WAITING · LIMIT_REACHED · BLOCKED. Read-only.
 *   POST  /api/me/hero/reroll/paid   { requestId, txHash }   the member has PAID (their wallet signed an ERC-20 transfer to the reward treasury and returned the transaction
 *                                    hash): the server verifies it on-chain, read-only, and rerolls the SESSION's own hero. The body carries nothing else — no hero, no member,
 *                                    no amount, no address: everything is decided from the chain and the session. PENDING until the payment is confirmed. Same-origin only.
 *
 * Behind the feature flag `hero.paid_reroll` (OFF by default): a disabled feature answers 403 PAID_REROLL_DISABLED and writes nothing.
 */

async function deps(): Promise<PaidRerollDeps> {
  const env = getEnv();
  const token = resolveTokenConfig(env);
  // Everything async is resolved HERE, before any transaction opens (the shared handle has one connection in production).
  const settings = await getSettings();
  const classes = await getEnabledClasses();
  return {
    settings,
    classes,
    secret: getSecret("CLASS_ROLL_SECRET"),
    allowDemo: demoHeroesAllowed(),
    chain: {
      reader: await getChainReader(),
      treasuryAddress: token.configured ? token.treasuryAddress : null,
      rpcUrl: token.configured ? token.rpcUrl : null,
      explorerTxUrl: token.configured ? token.explorerTxUrl : null,
    },
  };
}

async function handleGET(req: Request) {
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  const flags = { enabled: await isFlagOn(PAID_REROLL_FLAG), freeEnabled: await isFlagOn(FREE_REROLL_FLAG) };
  return ok({ status: await getPaidRerollStatus(await getReadyDb(), viewer.telegramUserId, flags, await deps()) });
}

const body = z.strictObject({
  requestId: z.string().regex(REROLL_REQUEST_ID, "requestId must be a UUID"),
  txHash: z.string().regex(TX_HASH, "txHash must be a 0x-prefixed 32-byte hash"),
});

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  // A courtesy brake: a pending payment is re-asked every few seconds, never faster. NOT the limit — the transaction hash is single-use in the database.
  if (rateLimited(`hero-paid-reroll:${viewer.telegramUserId}`, 40, 60_000) || rateLimited(`hero-paid-reroll-ip:${clientKey(req)}`, 120, 60_000)) return fail("RATE_LIMITED", 429);
  if (!(await isFlagOn(PAID_REROLL_FLAG))) return fail("PAID_REROLL_DISABLED", 403);
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.response;
  try {
    const outcome = await confirmPaidReroll(await getReadyDb(), viewer.telegramUserId, { requestId: parsed.data.requestId.toLowerCase(), txHash: parsed.data.txHash }, await deps());
    return ok({ outcome });
  } catch (error) {
    if (error instanceof PaidRerollError) {
      if (error.code === "INVALID_ROLL") console.error("[hero-paid-reroll] invalid roll refused:", error.message);
      const message = error.code === "INVALID_ROLL" ? "The roll could not be completed. Your payment is safe — try again." : error.message;
      return Response.json({ ok: false, error: error.code, message, ...error.detail }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    }
    throw error;
  }
}

export const GET = guarded("me/hero/reroll/paid", handleGET);
export const POST = guarded("me/hero/reroll/paid", handlePOST);
