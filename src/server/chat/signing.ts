import { createHmac, createPrivateKey, createPublicKey, hkdfSync, sign, verify, type KeyObject } from "node:crypto";

import type { ChatEnvelope, ChatEvent } from "@/domain/chat/types";

/**
 * ARENA CHAT — what makes a broadcast TRUSTWORTHY.
 *
 * A browser that receives something over the Realtime channel cannot tell who put it there. Supabase's private-channel authorization keeps browsers
 * from publishing (docs/ARENA_CHAT.md), but the browser must not depend on a dashboard toggle it cannot see — so every event the server broadcasts is
 * SIGNED, and the browser shows only what verifies:
 *
 *   · the key pair is derived from SESSION_SECRET with HKDF (a separate label, so it is unrelated to session signing) — no extra secret to configure,
 *     and it changes only when the session secret does (browsers fetch the public key with every first page);
 *   · Ed25519 over the exact JSON text of the event: nothing to canonicalise, nothing to re-serialise;
 *   · the public key is public by design; the private key never leaves this module.
 *
 * Also here: the opaque `senderKey` ("the same sender", not reversible to a Telegram id without the secret).
 */
export interface ChatSigner {
  /** The envelope for an event: its JSON text and the signature over it. */
  seal(event: ChatEvent): ChatEnvelope;
  /** Ed25519 public key, raw 32 bytes, base64url. */
  publicKey: string;
  /** Verifies an envelope made by `seal` (tests, and the server's own paranoia). */
  verify(envelope: ChatEnvelope): boolean;
  senderKey(memberId: number): string;
}

// RFC 8410: the fixed PKCS#8 prefix of an Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

const cache = new Map<string, ChatSigner>();

export function createChatSigner(secret: string): ChatSigner {
  const hit = cache.get(secret);
  if (hit) return hit;
  const seed = Buffer.from(hkdfSync("sha256", secret, "clank-rpg", "arena-chat/ed25519/v1", 32));
  const privateKey: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const publicObject = createPublicKey(privateKey);
  const publicKey = publicObject.export({ format: "jwk" }).x as string;
  const senderSecret = Buffer.from(hkdfSync("sha256", secret, "clank-rpg", "arena-chat/sender-key/v1", 32));
  const signer: ChatSigner = {
    publicKey,
    seal(event) {
      const j = JSON.stringify(event);
      return { v: 1, j, s: sign(null, Buffer.from(j, "utf8"), privateKey).toString("base64url") };
    },
    verify(e) {
      return verify(null, Buffer.from(e.j, "utf8"), publicObject, Buffer.from(e.s, "base64url"));
    },
    senderKey: (memberId) => createHmac("sha256", senderSecret).update(String(memberId)).digest("base64url").slice(0, 16),
  };
  if (cache.size > 8) cache.clear();
  cache.set(secret, signer);
  return signer;
}
