import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

export function hmacSha256Hex(secret: string, message: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(secret), utf8ToBytes(message)));
}

/** JSON with recursively sorted object keys — a stable input for hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * A stable UUID (version-5 style layout) derived from a name: the same name always gives the same id. Used for idempotency keys that must
 * be reproducible — e.g. the key of a system action on one specific hero version, so running it twice can only ever write one row.
 */
export function deterministicUuid(name: string): string {
  const h = sha256Hex(`clank-rpg:uuid:${name}`).slice(0, 32).split("");
  h[12] = "5";
  h[16] = "89ab"[parseInt(h[16] as string, 16) & 3] as string;
  const t = h.join("");
  return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20, 32)}`;
}
