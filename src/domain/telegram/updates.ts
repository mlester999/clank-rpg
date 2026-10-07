import { z } from "zod";

import type { IngestMessage, MediaKind } from "./types";

/**
 * Parsing of raw Telegram Bot API updates. Deliberately lenient about unknown fields and
 * strict about the few we trust: an update only becomes a message if it comes from a real
 * (non-bot, non-anonymous) user in the configured official chat.
 */
const userSchema = z.looseObject({
  id: z.number().int().positive(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const chatSchema = z.looseObject({ id: z.number().int(), type: z.string().optional() });

const messageSchema = z.looseObject({
  message_id: z.number().int().positive(),
  date: z.number().int().positive(),
  chat: chatSchema,
  from: userSchema.optional(),
  sender_chat: z.looseObject({ id: z.number().int() }).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  reply_to_message: z
    .looseObject({ from: userSchema.optional(), message_id: z.number().int().optional() })
    .optional(),
  forward_origin: z.unknown().optional(),
  forward_date: z.number().optional(),
  photo: z.unknown().optional(),
  sticker: z.unknown().optional(),
  animation: z.unknown().optional(),
  voice: z.unknown().optional(),
  video: z.unknown().optional(),
  video_note: z.unknown().optional(),
  audio: z.unknown().optional(),
  document: z.unknown().optional(),
});

const reactionSchema = z.looseObject({
  chat: chatSchema,
  message_id: z.number().int().positive(),
  user: userSchema.optional(),
  old_reaction: z.array(z.unknown()).default([]),
  new_reaction: z.array(z.unknown()).default([]),
});

const updateSchema = z.looseObject({
  update_id: z.number().int().nonnegative(),
  message: messageSchema.optional(),
  message_reaction: reactionSchema.optional(),
});

export type ParsedUpdate =
  | { kind: "message"; updateId: number; message: IngestMessage }
  | { kind: "reaction"; updateId: number; chatId: number; messageId: number; reactorId: number; added: boolean }
  | { kind: "ignored"; updateId: number | null; reason: string };

function mediaKindOf(m: z.infer<typeof messageSchema>): MediaKind {
  if (m.photo) return "photo";
  if (m.sticker) return "sticker";
  if (m.animation) return "animation";
  if (m.voice || m.video_note) return "voice";
  if (m.video) return "video";
  if (m.audio) return "audio";
  if (m.document) return "document";
  return "none";
}

export function displayNameOf(u: { first_name?: string | undefined; last_name?: string | undefined; username?: string | undefined }): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "";
}

export function parseTelegramUpdate(raw: unknown, officialChatId: number): ParsedUpdate {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored", updateId: null, reason: "MALFORMED" };
  const update = parsed.data;
  const updateId = update.update_id;

  if (update.message) {
    const m = update.message;
    if (m.chat.id !== officialChatId) return { kind: "ignored", updateId, reason: "WRONG_CHAT" };
    if (m.sender_chat) return { kind: "ignored", updateId, reason: "ANONYMOUS_OR_CHANNEL_SENDER" };
    if (!m.from) return { kind: "ignored", updateId, reason: "NO_SENDER" };
    if (m.from.is_bot) return { kind: "ignored", updateId, reason: "BOT_SENDER" };
    const replyFrom = m.reply_to_message?.from;
    return {
      kind: "message",
      updateId,
      message: {
        chatId: m.chat.id,
        messageId: m.message_id,
        authorId: m.from.id,
        username: m.from.username ?? null,
        displayName: displayNameOf(m.from),
        sentAtMs: m.date * 1000,
        text: m.text ?? m.caption ?? "",
        isReply: Boolean(m.reply_to_message),
        replyToUserId: replyFrom && !replyFrom.is_bot ? replyFrom.id : null,
        isForwarded: Boolean(m.forward_origin) || m.forward_date !== undefined,
        mediaKind: mediaKindOf(m),
        source: "LIVE",
      },
    };
  }

  if (update.message_reaction) {
    const r = update.message_reaction;
    if (r.chat.id !== officialChatId) return { kind: "ignored", updateId, reason: "WRONG_CHAT" };
    if (!r.user || r.user.is_bot) return { kind: "ignored", updateId, reason: "ANONYMOUS_REACTION" };
    const added = r.old_reaction.length === 0 && r.new_reaction.length > 0;
    const removed = r.old_reaction.length > 0 && r.new_reaction.length === 0;
    if (!added && !removed) return { kind: "ignored", updateId, reason: "REACTION_SWAP" };
    return { kind: "reaction", updateId, chatId: r.chat.id, messageId: r.message_id, reactorId: r.user.id, added };
  }

  return { kind: "ignored", updateId, reason: "UNSUPPORTED_UPDATE" };
}
