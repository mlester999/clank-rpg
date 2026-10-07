import "server-only";

import { NextResponse } from "next/server";
import type { z } from "zod";

import { USER_SESSION_COOKIE, ADMIN_SESSION_COOKIE, verifySession } from "../auth/session";
import { getReadyDb, getSettings } from "../runtime";
import { getEnv, getSecret } from "../env";

/** Error bodies are short, stable codes. Internals (SQL, stack traces) never reach the browser. */
export function fail(code: string, status: number, message?: string): NextResponse {
  return NextResponse.json({ ok: false, error: code, ...(message ? { message } : {}) }, { status, headers: { "Cache-Control": "no-store" } });
}

export function ok<T extends object>(body: T, init?: { status?: number; cache?: string }): NextResponse {
  return NextResponse.json({ ok: true, ...body }, { status: init?.status ?? 200, headers: { "Cache-Control": init?.cache ?? "no-store" } });
}

/**
 * CSRF defence for cookie-authenticated mutations: the Origin header (always sent by browsers
 * on cross-site and same-site POSTs) must match our own origin. SameSite=Lax cookies are the
 * second layer. Server-to-server callers use secret-authenticated endpoints instead.
 */
export function sameOriginOk(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    const o = new URL(origin);
    if (host && o.host === host) return true;
    return o.origin === new URL(getEnv().NEXT_PUBLIC_APP_URL).origin;
  } catch {
    return false;
  }
}

export async function readJson<S extends z.ZodType>(req: Request, schema: S, maxBytes = 32_768): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: NextResponse }> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return { ok: false, response: fail("UNSUPPORTED_MEDIA_TYPE", 415) };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: fail("PAYLOAD_TOO_LARGE", 413) };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, response: fail("BAD_REQUEST", 400) };
  }
  if (text.length > maxBytes) return { ok: false, response: fail("PAYLOAD_TOO_LARGE", 413) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: fail("INVALID_JSON", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: fail("INVALID_INPUT", 422, parsed.error.issues[0]?.message) };
  return { ok: true, data: parsed.data };
}

/**
 * Reads a raw (non-JSON) request body with a hard size cap, refusing early on the declared length and again while
 * streaming — a lying Content-Length cannot make the server buffer more than `maxBytes`.
 */
export async function readBytes(req: Request, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: NextResponse }> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, response: fail("PAYLOAD_TOO_LARGE", 413) };
  if (!req.body) return { ok: false, response: fail("BAD_REQUEST", 400) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: fail("PAYLOAD_TOO_LARGE", 413) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: fail("BAD_REQUEST", 400) };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, bytes };
}

// --- rate limiting (per server instance; DB constraints remain the correctness backstop) ---
const buckets = new Map<string, number[]>();

export function rateLimited(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return true;
  }
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) for (const k of buckets.keys()) { buckets.delete(k); if (buckets.size < 4000) break; }
  return false;
}

export function clientKey(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || "local";
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export interface Viewer {
  telegramUserId: number;
  characterId: string | null;
  claimed: boolean;
  displayName: string;
  qualifyingMessages: number;
  threshold: number;
  /** Telegram member status (BANNED never reaches here). */
  status: "OK" | "FLAGGED";
  /** When the signed session was issued (a fresh Telegram sign-in) — sensitive actions require it to be recent. */
  sessionIssuedAtMs: number;
}

/** Resolves the signed session cookie into a viewer, checking the revocation epoch in the database. */
export async function getViewer(req: Request): Promise<Viewer | null> {
  const env = getEnv();
  const session = verifySession(cookieValue(req, USER_SESSION_COOKIE), getSecret("SESSION_SECRET", env), "user");
  if (!session) return null;
  const db = await getReadyDb();
  const [row] = await db.query<{ session_epoch: number; status: string; display_name: string; qualifying: number; hero: string | null; claimed: boolean }>(
    `select tu.session_epoch, tu.status, tu.display_name, tu.qualifying_message_count as qualifying, c.id as hero, (cl.character_id is not null) as claimed
       from public.telegram_users tu left join public.characters c on c.telegram_user_id = tu.telegram_user_id
       left join public.character_claims cl on cl.character_id = c.id where tu.telegram_user_id = $1`,
    [session.sub],
  );
  if (!row || row.session_epoch !== session.ep || row.status === "BANNED") return null;
  const settings = await getSettings();
  return {
    telegramUserId: session.sub,
    characterId: row.hero,
    claimed: row.claimed,
    displayName: row.display_name,
    qualifyingMessages: row.qualifying,
    threshold: settings.telegram.qualifyingThreshold,
    status: row.status === "FLAGGED" ? "FLAGGED" : "OK",
    sessionIssuedAtMs: session.iat * 1000,
  };
}

export function isAdmin(req: Request): boolean {
  const env = getEnv();
  if (!env.ADMIN_ACCESS_KEY) return false;
  return verifySession(cookieValue(req, ADMIN_SESSION_COOKIE), getSecret("SESSION_SECRET", env), "admin") !== null;
}

export function cookieHeader(name: string, value: string, maxAgeS: number, opts: { strict?: boolean } = {}): string {
  const secure = getEnv().isProduction ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${opts.strict ? "Strict" : "Lax"}; Max-Age=${maxAgeS}${secure}`;
}

export function clearCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`;
}
