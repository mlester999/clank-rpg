import type { ChatMessageDto, ChatMute, ChatPageDto } from "@/domain/chat/types";
import { api, type ApiErr, type ApiOk } from "@/lib/api";

/** ARENA CHAT — the two HTTP calls the browser makes (everything else arrives over Realtime). */

export interface PageQuery {
  before?: number;
  after?: number;
  limit?: number;
}

export function fetchChatPage(q: PageQuery = {}): Promise<ApiOk<ChatPageDto & { ok: true }> | ApiErr> {
  const params = new URLSearchParams();
  if (q.before !== undefined) params.set("before", String(q.before));
  if (q.after !== undefined) params.set("after", String(q.after));
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  const qs = params.toString();
  return api(`/api/arena/chat/messages${qs ? `?${qs}` : ""}`, { timeoutMs: 12_000 });
}

export type SendOutcome =
  | { ok: true; message: ChatMessageDto; duplicate: boolean }
  | { ok: false; error: string; message: string; retryAfterMs?: number; muted?: ChatMute; transient: boolean };

const WORDS: Record<string, string> = {
  UNAUTHENTICATED: "Sign in with Telegram to chat.",
  BAD_ORIGIN: "Reload the page and try again.",
  NETWORK: "Couldn't reach the server. Your message is still here — try again.",
  TIMEOUT: "The server is taking too long. Your message is still here — try again.",
  DB_UNAVAILABLE: "Chat is busy for a moment. Your message is still here — try again.",
  CHAT_CLOSED: "The Arena Chat isn't open right now.",
};

/** Sends one message. `nonce` identifies THIS message: sending the same text with the same nonce again (a retry) can never post it twice. */
export async function sendChatMessage(body: string, nonce: string): Promise<SendOutcome> {
  const r = await api<{ message: ChatMessageDto; duplicate: boolean }>("/api/arena/chat/messages", { method: "POST", json: { body, nonce }, timeoutMs: 12_000 });
  if (r.ok) return { ok: true, message: r.data.message, duplicate: r.data.duplicate };
  const detail = (r.detail ?? {}) as { message?: string; retryAfterMs?: number; muted?: ChatMute };
  const transient = r.error === "NETWORK" || r.error === "TIMEOUT" || r.error === "DB_UNAVAILABLE" || r.status >= 500;
  return {
    ok: false,
    error: r.error,
    message: detail.message ?? WORDS[r.error] ?? "That message couldn't be sent. Please try again.",
    ...(typeof detail.retryAfterMs === "number" ? { retryAfterMs: detail.retryAfterMs } : {}),
    ...(detail.muted ? { muted: detail.muted } : {}),
    transient,
  };
}
