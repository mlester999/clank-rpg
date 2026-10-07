import { z } from "zod";

import { demoHeroesAllowed } from "@/server/env";
import { fail, getViewer, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { requestClaim, type ClaimDestinationInput, type ClaimRejection } from "@/server/rewards/claims";
import { rewardsReady } from "@/server/rewards/pool";
import { rewardMessage } from "@/server/rewards/messages";
import { getClaimTarget } from "@/server/rewards/target";
import { getReadyDb, getSettings } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Creates a MANUAL PAYOUT REQUEST (an admin pays it by hand). There is NO amount in this body: the payout is derived by the
 * server from the member's reward ledger. The destination is either the member's verified holder wallet (`HOLDER_WALLET`) or an
 * address typed for THIS claim only (`CUSTOM` + `address`) — a custom address never changes the holder wallet. Strict body:
 * anything else (an amount, a recipient, a status…) is refused.
 */
const body = z.discriminatedUnion("destination", [
  z.strictObject({ idempotencyKey: z.string().min(8).max(120), destination: z.literal("HOLDER_WALLET") }),
  z.strictObject({ idempotencyKey: z.string().min(8).max(120), destination: z.literal("CUSTOM"), address: z.string().min(40).max(64) }),
]);

const STATUS: Record<ClaimRejection, number> = {
  TOKEN_NOT_LAUNCHED: 409, CLAIMS_UNAVAILABLE: 503, NOT_ELIGIBLE: 403, CLAIMS_HELD: 409, DESTINATION_REQUIRED: 422, NO_HOLDER_WALLET: 422, INVALID_WALLET: 422, WALLET_IN_USE: 409,
  BELOW_MINIMUM: 409, NOTHING_TO_CLAIM: 409, CLAIM_IN_PROGRESS: 409,
};

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  if (rateLimited(`rclaim:${viewer.telegramUserId}`, 10, 60_000)) return fail("RATE_LIMITED", 429, rewardMessage("RATE_LIMITED"));
  const parsed = await readJson(req, body, 1024);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  if (!(await rewardsReady(db))) return fail("REWARDS_UNAVAILABLE", 503, rewardMessage("REWARDS_UNAVAILABLE"));

  const destination: ClaimDestinationInput = parsed.data.destination === "HOLDER_WALLET" ? { kind: "HOLDER_WALLET" } : { kind: "CUSTOM", address: parsed.data.address };
  const result = await requestClaim(db, { now: () => new Date(), allowDemo: demoHeroesAllowed() }, {
    userId: viewer.telegramUserId,
    idempotencyKey: parsed.data.idempotencyKey,
    destination,
    settings: await getSettings(),
    target: await getClaimTarget(db),
  }).catch((error: unknown) => {
    // Two requests racing to reserve lose at the database (partial unique index), not in application code.
    const m = error instanceof Error ? error.message : "";
    if (/arena_reward_claims_one_pending/i.test(m)) return { ok: false as const, reason: "CLAIM_IN_PROGRESS" as const };
    throw error;
  });
  if (!result.ok) return fail(result.reason, STATUS[result.reason], rewardMessage(result.reason));
  const c = result.claim;
  return ok({
    claim: { id: c.id, status: c.status, amount: c.amount, destinationKind: c.destinationKind, requestedAt: c.requestedAt },
    replayed: result.replayed,
  });
}
