import { fail, ok, guarded } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { BattleIntegrityError } from "@/server/services/arena";
import { getReplayDto } from "@/server/services/views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleGET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return fail("NOT_FOUND", 404);
  try {
    const replay = await getReplayDto(await getReadyDb(), id, Date.now());
    if (!replay) return fail("NOT_FOUND", 404);
    // A battle's replay is immutable once it may be shown, so it can be cached aggressively.
    return ok({ replay }, { cache: "public, max-age=300, immutable" });
  } catch (error) {
    if (error instanceof BattleIntegrityError) console.error("[INTEGRITY]", error.message);
    else console.error("[arena/replay]", error);
    return fail("REPLAY_UNAVAILABLE", 503);
  }
}

export const GET = guarded("arena/battles/[id]/replay", handleGET);
