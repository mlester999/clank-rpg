import { createHash, createHmac } from "node:crypto";

import { z } from "zod";

import { safeEqual } from "../crypto";

/**
 * Verification of the Telegram Login Widget payload
 * (https://core.telegram.org/widgets/login#checking-authorization):
 *   secret = SHA256(bot_token)
 *   hash   = HMAC_SHA256(secret, data_check_string)       hex-encoded
 * where data_check_string = all received fields except `hash`, as `key=value`, sorted by key,
 * joined with "\n". The payload id is Telegram's IMMUTABLE numeric user id — that, never a
 * username, is the identity we bind a hero to.
 */
export const loginPayloadSchema = z.object({
  id: z.coerce.number().int().positive(),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  username: z.string().max(64).optional(),
  photo_url: z.string().max(2048).optional(),
  auth_date: z.coerce.number().int().positive(),
  hash: z.string().regex(/^[0-9a-f]{64}$/i),
});

export type LoginPayload = z.infer<typeof loginPayloadSchema>;

export type LoginVerification =
  | { ok: true; user: { id: number; displayName: string; username: string | null; authDate: number; hash: string } }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "FROM_FUTURE" };

export function verifyTelegramLogin(raw: unknown, botToken: string, nowMs = Date.now(), maxAgeSeconds = 300): LoginVerification {
  const parsed = loginPayloadSchema.safeParse(raw);
  if (!parsed.success || typeof raw !== "object" || raw === null) return { ok: false, reason: "MALFORMED" };
  const entries = Object.entries(raw as Record<string, unknown>)
    .filter(([k, v]) => k !== "hash" && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${String(v)}`)
    .sort();
  const secret = createHash("sha256").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(entries.join("\n")).digest("hex");
  if (!safeEqual(expected, parsed.data.hash.toLowerCase())) return { ok: false, reason: "BAD_SIGNATURE" };
  const ageS = Math.floor(nowMs / 1000) - parsed.data.auth_date;
  if (ageS > maxAgeSeconds) return { ok: false, reason: "EXPIRED" };
  if (ageS < -60) return { ok: false, reason: "FROM_FUTURE" };
  const d = parsed.data;
  return {
    ok: true,
    user: {
      id: d.id,
      displayName: [d.first_name, d.last_name].filter(Boolean).join(" "),
      username: d.username ?? null,
      authDate: d.auth_date,
      hash: d.hash.toLowerCase(),
    },
  };
}

/** Test/dev helper: produce a payload exactly as Telegram's widget would sign it. */
export function signTelegramLoginPayload(fields: Record<string, string | number>, botToken: string): Record<string, string | number> {
  const entries = Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).sort();
  const secret = createHash("sha256").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(entries.join("\n")).digest("hex");
  return { ...fields, hash };
}
