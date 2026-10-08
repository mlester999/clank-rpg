import { NextResponse } from "next/server";
import { z } from "zod";

import { CHAT_PAGE_MAX, CHAT_REQUEST_MAX_BYTES } from "@/domain/chat/limits";
import { CHAT_TEXT_MESSAGE, normalizeChatBody } from "@/domain/chat/text";
import type { ChatMessageDto, ChatPageDto } from "@/domain/chat/types";
import { chatBroadcaster, chatRealtimeConfig, chatSigner } from "@/server/chat/runtime";
import { chatSchemaReady, readPage, sendMessage, youOf } from "@/server/chat/service";
import { clientKey, fail, getViewer, guarded, ok, rateLimited, readJson, sameOriginOk } from "@/server/http/guards";
import { getReadyDb, isFlagOn } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * ARENA CHAT — the one global room.
 *
 *   GET  /api/arena/chat/messages[?before=<id>|?after=<id>][&limit=n]   PUBLIC. The newest page (ascending), older pages by `before`, a catch-up by
 *        `after`. Guests read freely; the first page also says who the signed-in viewer is and how to join the room live. At most CHAT_PAGE_MAX
 *        rows, one indexed statement (identical requests within a second share it).
 *   POST /api/arena/chat/messages   {body, nonce}   Telegram-signed-in members only. The sender is the SESSION's member — the body carries no identity,
 *        and a field that tries is refused (strict schema). Saved first, then broadcast: a message exists once it is durable.
 *
 * The room is "closed" (a calm answer, not an error) when its switch is off or its migration has not been applied yet.
 */

const closedPage = (reason: "CLOSED" | "NOT_READY"): ChatPageDto => ({ enabled: false, reason, messages: [], hasMore: false, you: null, realtime: null, serverTime: new Date().toISOString() });

async function roomStatus(): Promise<"OPEN" | "CLOSED" | "NOT_READY"> {
  if (!(await isFlagOn("arena.chat"))) return "CLOSED";
  return (await chatSchemaReady(await getReadyDb())) ? "OPEN" : "NOT_READY";
}

const cursor = z.string().regex(/^[1-9]\d{0,15}$/).transform(Number).pipe(z.number().int().safe());
const query = z.object({ before: cursor.optional(), after: cursor.optional(), limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(CHAT_PAGE_MAX)).optional() });

async function handleGET(req: Request) {
  // reads are cheap (one shared, cached statement) and a whole campus or office can sit behind one address: the brake only stops a flood
  if (rateLimited(`chatread:${clientKey(req)}`, 600, 60_000)) return fail("RATE_LIMITED", 429);
  const parsed = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success || (parsed.data.before !== undefined && parsed.data.after !== undefined)) return fail("INVALID_INPUT", 422);
  const { before, after, limit } = parsed.data;

  const status = await roomStatus();
  if (status !== "OPEN") return ok(closedPage(status));

  const signer = chatSigner();
  const db = await getReadyDb();
  const page = await readPage(db, signer, { ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), ...(limit !== undefined ? { limit } : {}) });
  const first = before === undefined && after === undefined;
  const viewer = first ? await getViewer(req) : null;
  const body: ChatPageDto = {
    enabled: true,
    messages: page.messages,
    hasMore: page.hasMore,
    ...(first ? { you: viewer ? await youOf(db, viewer.telegramUserId, signer) : null, realtime: chatRealtimeConfig() } : {}),
    serverTime: new Date().toISOString(),
  };
  return ok(body);
}

const sendBody = z.strictObject({ body: z.string().max(2_000), nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/) });

function refused(error: string, status: number, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json({ ok: false, error, ...extra }, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function handlePOST(req: Request) {
  if (!sameOriginOk(req)) return fail("BAD_ORIGIN", 403);
  const viewer = await getViewer(req);
  if (!viewer) return fail("UNAUTHENTICATED", 401);
  // A cheap per-instance brake ahead of the database (the database's own limits are the ones that count): one member, one address.
  if (rateLimited(`chatsend:m:${viewer.telegramUserId}`, 30, 60_000) || rateLimited(`chatsend:ip:${clientKey(req)}`, 90, 60_000)) {
    return refused("RATE_LIMITED", 429, { retryAfterMs: 5_000, message: "You're sending too fast. Try again in a few seconds." }, { "Retry-After": "5" });
  }
  const input = await readJson(req, sendBody, CHAT_REQUEST_MAX_BYTES);
  if (!input.ok) return input.response;
  const text = normalizeChatBody(input.data.body);
  if (!text.ok) return refused(text.reason === "EMPTY" ? "EMPTY_MESSAGE" : text.reason, 422, { message: CHAT_TEXT_MESSAGE[text.reason] });

  const status = await roomStatus();
  if (status !== "OPEN") return refused("CHAT_CLOSED", 503, { message: "The Arena Chat isn't open right now." });

  const signer = chatSigner();
  const result = await sendMessage(await getReadyDb(), viewer.telegramUserId, text.body, input.data.nonce, signer);
  if (!result.ok) {
    switch (result.error) {
      case "MUTED":
        return refused("MUTED", 403, { muted: result.mute, message: "You can't send messages in the Arena Chat right now." });
      case "TOO_FAST":
      case "RATE_LIMITED":
        return refused(result.error, 429, { retryAfterMs: result.retryAfterMs, message: result.error === "TOO_FAST" ? "Slow down a little — one message every few seconds." : "That's a lot of messages. Take a short break." }, { "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))) });
      case "DUPLICATE_MESSAGE":
        return refused("DUPLICATE_MESSAGE", 409, { message: "You just sent that." });
      default:
        return fail("UNAUTHENTICATED", 401);
    }
  }
  // Saved. Tell the room (the answer does not depend on it: the message is already durable).
  if (!result.duplicate) await chatBroadcaster().publish(signer.seal({ t: "msg", m: result.message }));
  return ok({ message: result.message satisfies ChatMessageDto, duplicate: result.duplicate });
}

export const GET = guarded("arena-chat", handleGET);
export const POST = guarded("arena-chat", handlePOST);
