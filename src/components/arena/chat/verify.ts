import type { ChatEnvelope } from "@/domain/chat/types";

/**
 * ARENA CHAT — the browser's check on a broadcast. Anything that arrives over the Realtime channel is just bytes until it verifies: the envelope's
 * signature must be the SERVER's (Ed25519 over the exact event text, public key delivered by this site's own first page). Only a verified event is
 * ever read or shown.
 *
 *   ok            the server made this
 *   forged        the signature does not match (someone else put this on the channel) → dropped
 *   unverifiable  this browser cannot check (no WebCrypto / no Ed25519, a malformed key) → the caller treats the event as a HINT that something
 *                 happened and fetches the room from the server instead; it never shows the payload
 */
export type Verdict = "ok" | "forged" | "unverifiable";

const keys = new Map<string, Promise<CryptoKey | null>>();

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function importKey(subtle: SubtleCrypto, verifyKey: string): Promise<CryptoKey | null> {
  let p = keys.get(verifyKey);
  if (!p) {
    p = (async () => {
      try {
        const raw = fromBase64Url(verifyKey);
        if (raw.length !== 32) return null;
        return await subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
      } catch {
        return null;
      }
    })();
    if (keys.size > 4) keys.clear();
    keys.set(verifyKey, p);
  }
  return p;
}

export async function verifyEnvelope(envelope: ChatEnvelope, verifyKey: string): Promise<Verdict> {
  const subtle = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto.subtle;
  if (!subtle) return "unverifiable";
  const key = await importKey(subtle, verifyKey);
  if (!key) return "unverifiable";
  try {
    const ok = await subtle.verify({ name: "Ed25519" }, key, fromBase64Url(envelope.s), new TextEncoder().encode(envelope.j));
    return ok ? "ok" : "forged";
  } catch {
    return "unverifiable";
  }
}
