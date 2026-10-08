import { CHAT_EVENT, CHAT_TOPIC } from "@/domain/chat/limits";
import type { ChatRealtimeConfig } from "@/domain/chat/types";

import { getEnv, getSecret, type ServerEnv } from "../env";

import { createRestBroadcaster, noBroadcaster, type ChatBroadcaster } from "./broadcast";
import { createChatSigner, type ChatSigner } from "./signing";

/**
 * ARENA CHAT — the composition root: which signer, which broadcaster, and what the browser is told about live delivery. Everything is derived from
 * the environment on demand and cached per process; nothing here touches the database.
 */

export function chatSigner(env: ServerEnv = getEnv()): ChatSigner {
  return createChatSigner(getSecret("SESSION_SECRET", env));
}

const validUrl = (v: string | undefined): string | undefined => {
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : undefined;
  } catch {
    return undefined; // a mistyped URL switches live delivery off; it never stops the app
  }
};

/** The Realtime base the SERVER broadcasts to (and which project that is), or null when live delivery is not configured. */
function serverTarget(env: ServerEnv): { url: string; key: string } | null {
  const url = validUrl(env.CHAT_REALTIME_URL) ?? validUrl(env.SUPABASE_URL);
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

/** `https://x.supabase.co` → `wss://x.supabase.co/realtime/v1` (what the Realtime client wants). */
export function realtimeSocketUrl(projectUrl: string): string {
  const u = new URL(projectUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/realtime/v1`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * What the browser gets to join the room live — or null (then it catches up on a slow timer instead). It is offered ONLY when the server can also
 * broadcast: a browser must never sit "live" on a channel nothing is ever published to.
 */
export function chatRealtimeConfig(env: ServerEnv = getEnv(), signer: ChatSigner = chatSigner(env)): ChatRealtimeConfig | null {
  const base = validUrl(env.CHAT_REALTIME_URL) ?? validUrl(env.NEXT_PUBLIC_SUPABASE_URL) ?? validUrl(env.SUPABASE_URL);
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!base || !key || key.length < 16 || !serverTarget(env)) return null;
  return { url: realtimeSocketUrl(base), key, topic: CHAT_TOPIC, event: CHAT_EVENT, verifyKey: signer.publicKey };
}

const g = globalThis as unknown as { __clankChatBroadcaster?: { key: string; value: ChatBroadcaster } };

/** The one broadcaster of this process (its failure circuit must be shared by every request). */
export function chatBroadcaster(env: ServerEnv = getEnv()): ChatBroadcaster {
  const t = serverTarget(env);
  if (!t) return noBroadcaster;
  const id = `${t.url}|${t.key.slice(-6)}`;
  if (g.__clankChatBroadcaster?.key !== id) g.__clankChatBroadcaster = { key: id, value: createRestBroadcaster({ url: t.url, key: t.key }) };
  return g.__clankChatBroadcaster.value;
}

/** Test hook. */
export function resetChatRuntime(): void {
  g.__clankChatBroadcaster = undefined;
}
