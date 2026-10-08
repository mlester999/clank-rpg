import { CHAT_BODY_MAX, CHAT_NAME_MAX } from "./limits";
import type { ChatEnvelope, ChatEvent, ChatMessageDto } from "./types";

/**
 * ARENA CHAT — strict readers for everything that arrives over the wire. The envelope is verified (a signature only the server can make) BEFORE
 * its content is read; these checks then make sure even a signed payload from a buggy server cannot put a malformed message into the room.
 */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A Realtime payload → the envelope it must be, or null. Size-bounded: a megabyte "message" is not even parsed. */
export function readEnvelope(payload: unknown): ChatEnvelope | null {
  if (!isObj(payload)) return null;
  const { v, j, s } = payload;
  if (v !== 1 || typeof j !== "string" || typeof s !== "string") return null;
  if (j.length === 0 || j.length > 4_096 || s.length < 80 || s.length > 100 || !B64URL.test(s)) return null;
  return { v: 1, j, s };
}

export function readMessage(v: unknown): ChatMessageDto | null {
  if (!isObj(v)) return null;
  const { id, at, name, avatarUrl, senderKey, body, rev } = v;
  if (!isId(id) || typeof at !== "string" || Number.isNaN(Date.parse(at))) return null;
  if (typeof name !== "string" || name.length === 0 || name.length > CHAT_NAME_MAX * 8) return null;
  if (avatarUrl !== null && (typeof avatarUrl !== "string" || !/^\/api\/avatars\/[0-9a-f-]{36}\?v=[0-9a-f]{1,32}$/i.test(avatarUrl))) return null;
  if (typeof senderKey !== "string" || !B64URL.test(senderKey) || senderKey.length > 32) return null;
  if (typeof body !== "string" || body.length === 0 || body.length > CHAT_BODY_MAX * 4) return null;
  if (typeof rev !== "number" || !Number.isSafeInteger(rev) || rev < 0) return null;
  return { id, at, name, avatarUrl, senderKey, body, rev };
}

/** The (already verified) JSON text of an envelope → the event, or null. */
export function readEvent(text: string): ChatEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  if (raw.t === "msg") {
    const m = readMessage(raw.m);
    return m ? { t: "msg", m } : null;
  }
  if (raw.t === "hide" && isId(raw.id) && typeof raw.rev === "number" && Number.isSafeInteger(raw.rev) && raw.rev >= 0) return { t: "hide", id: raw.id, rev: raw.rev };
  return null;
}
