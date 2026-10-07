import { randomBytes, timingSafeEqual } from "node:crypto";

import { hmacSha256Hex } from "@/domain/util/hash";

/** 128-bit CSPRNG seed (hex) for cycles and battles. */
export function secureSeed(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function secureToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time string comparison that does not leak length via early return. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still do a comparison of equal-length buffers to keep timing roughly constant.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function makeTextHasher(pepper: string): (normalized: string) => string {
  return (normalized) => hmacSha256Hex(pepper, normalized);
}
