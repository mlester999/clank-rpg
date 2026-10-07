import { getEnv } from "@/server/env";
import { getViewer, ok } from "@/server/http/guards";
import { isFlagOn } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const env = getEnv();
  const viewer = await getViewer(req);
  return ok({
    viewer: viewer
      ? {
          displayName: viewer.displayName,
          characterId: viewer.characterId,
          claimed: viewer.claimed,
          qualifyingMessages: viewer.qualifyingMessages,
          threshold: viewer.threshold,
          status: viewer.status,
        }
      : null,
    login: {
      telegramBot: env.TELEGRAM_BOT_TOKEN && env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ? env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME : null,
      devLogin: !env.isProduction && Boolean(env.CLANK_DEV_LOGIN),
    },
    features: { claims: await isFlagOn("claims.enabled"), wallet: await isFlagOn("wallet.link") },
  });
}
