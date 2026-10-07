import { ADMIN_SESSION_COOKIE, USER_SESSION_COOKIE, USER_SESSION_TTL_S, newSession, signSession } from "@/server/auth/session";
import { getEnv, getSecret } from "@/server/env";
import { clientKey, cookieHeader, fail, ok, rateLimited, sameOriginOk } from "@/server/http/guards";
import { getReadyDb, getSettings } from "@/server/runtime";
import { loginWithTelegram } from "@/server/services/identity";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

void ADMIN_SESSION_COOKIE;

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  if (rateLimited(`login:${clientKey(req)}`, 20, 60_000)) return fail("RATE_LIMITED", 429);
  const env = getEnv();
  if (!env.TELEGRAM_BOT_TOKEN) return fail("LOGIN_UNAVAILABLE", 503, "Telegram sign-in is not configured yet.");
  let raw: unknown;
  try {
    raw = z.record(z.string(), z.union([z.string(), z.number()])).parse(await req.json());
  } catch {
    return fail("INVALID_INPUT", 422);
  }
  const settings = await getSettings();
  const result = await loginWithTelegram(await getReadyDb(), raw, { botToken: env.TELEGRAM_BOT_TOKEN, threshold: settings.telegram.qualifyingThreshold });
  if (!result.ok) return fail(result.reason === "REPLAYED" ? "LOGIN_REPLAYED" : "LOGIN_REJECTED", 401);
  const token = signSession(newSession("user", result.telegramUserId, result.epoch, USER_SESSION_TTL_S), getSecret("SESSION_SECRET", env));
  const res = ok({ characterId: result.characterId, claimed: result.claimed });
  res.headers.append("Set-Cookie", cookieHeader(USER_SESSION_COOKIE, token, USER_SESSION_TTL_S));
  return res;
}
