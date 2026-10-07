import { USER_SESSION_COOKIE } from "@/server/auth/session";
import { clearCookieHeader, ok, sameOriginOk, fail } from "@/server/http/guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const res = ok({});
  res.headers.append("Set-Cookie", clearCookieHeader(USER_SESSION_COOKIE));
  return res;
}
