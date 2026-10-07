import { z } from "zod";

import { USER_SESSION_COOKIE, USER_SESSION_TTL_S, newSession, signSession } from "@/server/auth/session";
import { devLoginEnabled, getEnv, getSecret } from "@/server/env";
import { cookieHeader, fail, ok, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb } from "@/server/runtime";
import { claimCharacter } from "@/server/services/identity";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.strictObject({ characterId: z.string().uuid() });

/**
 * LOCAL DEVELOPMENT ONLY. Signs you in as a seeded DEMO hero so the claim / inventory / wallet UI
 * can be exercised without a Telegram bot. It is impossible to use in production (devLoginEnabled
 * returns false there regardless of env) and can only target heroes with origin DEV_SEED.
 */
export async function POST(req: Request) {
  if (!devLoginEnabled()) return fail("NOT_FOUND", 404);
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const parsed = await readJson(req, body);
  if (!parsed.ok) return parsed.response;
  const db = await getReadyDb();
  const [hero] = await db.query<{ telegram_user_id: number; epoch: number }>(
    `select c.telegram_user_id, tu.session_epoch as epoch from public.characters c join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where c.id = $1 and c.origin = 'DEV_SEED' and c.is_demo`,
    [parsed.data.characterId],
  );
  if (!hero) return fail("NOT_FOUND", 404);
  await claimCharacter(db, hero.telegram_user_id, new Date());
  const token = signSession(newSession("user", hero.telegram_user_id, hero.epoch, USER_SESSION_TTL_S), getSecret("SESSION_SECRET", getEnv()));
  const res = ok({ characterId: parsed.data.characterId });
  res.headers.append("Set-Cookie", cookieHeader(USER_SESSION_COOKIE, token, USER_SESSION_TTL_S));
  return res;
}
