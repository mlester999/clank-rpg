import { createHmac } from "node:crypto";

import { safeEqual } from "../crypto";

/**
 * Stateless signed session token: base64url(JSON).HMAC-SHA256. Contains only the immutable
 * Telegram user id, a revocation epoch and expiry — never a username.
 *
 * Revocation: the epoch is compared with telegram_users.session_epoch on each authenticated
 * request, so "log out everywhere" / admin revoke works without a session table.
 */
export interface SessionPayload {
  typ: "user" | "admin";
  /** Telegram user id for user sessions; 0 for admin sessions. */
  sub: number;
  /** Revocation epoch. */
  ep: number;
  iat: number;
  exp: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");

export function signSession(payload: SessionPayload, secret: string): string {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(token: string | undefined | null, secret: string, expectedType: SessionPayload["typ"], nowMs = Date.now()): SessionPayload | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot < 1 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, expected)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (payload.typ !== expectedType) return null;
  if (!Number.isInteger(payload.sub) || !Number.isInteger(payload.ep) || !Number.isInteger(payload.exp)) return null;
  if (payload.exp * 1000 <= nowMs) return null;
  return payload;
}

export const USER_SESSION_COOKIE = "clank_session";
export const ADMIN_SESSION_COOKIE = "clank_admin";
export const USER_SESSION_TTL_S = 60 * 60 * 24 * 14;
export const ADMIN_SESSION_TTL_S = 60 * 60 * 8;

export function newSession(typ: SessionPayload["typ"], sub: number, epoch: number, ttlS: number, nowMs = Date.now()): SessionPayload {
  const iat = Math.floor(nowMs / 1000);
  return { typ, sub, ep: epoch, iat, exp: iat + ttlS };
}
