import type { IngestMessage, MediaKind, ReactionRef } from "./types";

/**
 * Parser for Telegram Desktop's "Export chat history" JSON (result.json), validated against a real
 * 97k-entry export of a public forum supergroup (see docs/TELEGRAM.md → "What a real export looks like").
 *
 * WHY THIS EXISTS: the Telegram Bot API cannot read message history — a bot only sees messages sent
 * after it joins. Historical activity can therefore only come from (a) a Telegram Desktop export or
 * (b) an MTProto user client. This parser feeds the SAME scoring pipeline as live traffic, so imported
 * counts are never fabricated or hand-edited — they are recomputed from the messages themselves.
 *
 * Identity rules (nothing is guessed):
 *  - A sender is a real person only if `from_id` is `user<digits>` AND `from` (the display name) is present.
 *  - `from === null` with a `user<id>` is a DELETED ACCOUNT: the id is stable but nobody can ever sign in
 *    as it, so those messages are reported and skipped (they would only create unclaimable heroes).
 *  - `channel<id>` senders are anonymous-admin / "chatting as a channel" posts: not a person → skipped.
 *  - The export has NO usernames and NO bot flag. Names that merely look like bots are REPORTED, not removed.
 *
 * Reply rules: forum supergroups attach an implicit `reply_to_message_id` (the topic's root service
 * message) to ordinary messages inside a topic. Those are NOT conversational replies. Replies into other
 * chats (`reply_to_peer_id`) are not replies within this group either.
 */
export type SkipReason =
  | "SERVICE"
  | "CHANNEL_OR_ANONYMOUS_SENDER"
  | "DELETED_ACCOUNT"
  | "EXCLUDED_BY_OPERATOR"
  | "NON_USER_OR_MALFORMED"
  | "BAD_DATE"
  | "UNKNOWN_ENTRY_TYPE";

export interface BotLikeSender {
  id: number;
  name: string;
  messages: number;
}

export interface ExportParseStats {
  entries: number;
  messageEntries: number;
  serviceEntries: number;
  serviceByAction: Record<string, number>;
  unknownEntryTypes: Record<string, number>;
  /** Telegram marks edited messages; the text we receive is the final edited text. */
  editedMessages: number;
  forwardedMessages: number;
  viaBotMessages: number;
  mediaOnlyMessages: number;
  messagesWithText: number;
  replyKinds: {
    /** Real conversational replies to a user message in this group. */
    toUser: number;
    /** Replies to a message posted by a channel / anonymous sender. */
    toChannel: number;
    /** Replies whose target is not in the export (deleted message) — still a reply, author unknown. */
    toUnknown: number;
    /** Implicit forum-topic / join-message replies: NOT counted as replies. */
    implicitTopicOrService: number;
    /** Replies into another chat: NOT counted as replies. */
    otherChat: number;
  };
  reactions: { total: number; attributedToUsers: number; attributedToChannels: number; unattributed: number; customEmoji: number };
  deletedAccountIds: number[];
  channelSenders: Array<{ id: string; name: string; messages: number }>;
  botLikeSenders: BotLikeSender[];
  /** First few unparseable entries, for the report. */
  parseErrors: string[];
}

export interface ExportParseResult {
  chatId: number;
  chatName: string;
  chatType: string;
  exportChatId: number;
  messages: IngestMessage[];
  skipped: Record<string, number>;
  stats: ExportParseStats;
}

interface ExportEntry {
  id?: unknown;
  type?: unknown;
  date_unixtime?: unknown;
  date?: unknown;
  from?: unknown;
  from_id?: unknown;
  text?: unknown;
  reply_to_message_id?: unknown;
  reply_to_peer_id?: unknown;
  forwarded_from?: unknown;
  forwarded_from_id?: unknown;
  photo?: unknown;
  media_type?: unknown;
  mime_type?: unknown;
  file?: unknown;
  sticker_emoji?: unknown;
  edited?: unknown;
  via_bot?: unknown;
  action?: unknown;
  reactions?: unknown;
}

function flattenText(text: unknown): string | null {
  if (text === undefined || text === null) return "";
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    let out = "";
    for (const part of text) {
      if (typeof part === "string") out += part;
      else if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") out += (part as { text: string }).text;
      else return null;
    }
    return out;
  }
  return null;
}

function mediaKindOf(m: ExportEntry): MediaKind {
  switch (m.media_type) {
    case "sticker":
      return "sticker";
    case "animation":
      return "animation";
    case "voice_message":
    case "video_message":
      return "voice";
    case "video_file":
      return "video";
    case "audio_file":
      return "audio";
  }
  if (m.photo) return "photo";
  if (m.file) return "document";
  return "none";
}

export function toBotApiChatId(exportId: number, exportType: string): number {
  if (exportType.includes("supergroup") || exportType.includes("channel")) return -(1_000_000_000_000 + exportId);
  return -exportId;
}

/** Display names ending in "bot" — surfaced for operator review, never silently removed. */
const BOT_LIKE = /bot\s*$/i;

const USER_ID = /^user(\d+)$/;

export interface ExportParseOptions {
  /** Override the Bot-API style chat id derived from the export. */
  chatId?: number;
  /** Operator-supplied Telegram user ids to leave out (e.g. confirmed bots). */
  excludeUserIds?: ReadonlySet<number>;
}

export function parseTelegramExport(json: unknown, options: ExportParseOptions = {}): ExportParseResult {
  if (typeof json !== "object" || json === null) throw new Error("Export is not a JSON object");
  const root = json as { id?: unknown; type?: unknown; name?: unknown; messages?: unknown };
  if (!Array.isArray(root.messages)) throw new Error("Export has no messages array (expected Telegram Desktop result.json)");
  if (typeof root.id !== "number" && options.chatId === undefined) throw new Error("Export has no chat id; pass the chat id explicitly");
  const exportChatId = typeof root.id === "number" ? root.id : 0;
  const chatType = String(root.type ?? "");
  const chatId = options.chatId ?? toBotApiChatId(exportChatId, chatType);
  const entries = root.messages as ExportEntry[];

  const skipped: Record<string, number> = {};
  const skip = (reason: SkipReason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const stats: ExportParseStats = {
    entries: entries.length,
    messageEntries: 0,
    serviceEntries: 0,
    serviceByAction: {},
    unknownEntryTypes: {},
    editedMessages: 0,
    forwardedMessages: 0,
    viaBotMessages: 0,
    mediaOnlyMessages: 0,
    messagesWithText: 0,
    replyKinds: { toUser: 0, toChannel: 0, toUnknown: 0, implicitTopicOrService: 0, otherChat: 0 },
    reactions: { total: 0, attributedToUsers: 0, attributedToChannels: 0, unattributed: 0, customEmoji: 0 },
    deletedAccountIds: [],
    channelSenders: [],
    botLikeSenders: [],
    parseErrors: [],
  };
  const err = (msg: string) => {
    if (stats.parseErrors.length < 25) stats.parseErrors.push(msg);
  };

  // Pass 1: who wrote what, which ids are service messages (topic roots, joins …).
  const authorByMessage = new Map<number, number | null>(); // null = channel / deleted / unknown author
  const serviceIds = new Set<number>();
  for (const e of entries) {
    if (typeof e.id !== "number") continue;
    if (e.type === "service") {
      serviceIds.add(e.id);
    } else if (e.type === "message") {
      const m = typeof e.from_id === "string" ? USER_ID.exec(e.from_id) : null;
      authorByMessage.set(e.id, m ? Number(m[1]) : null);
    }
  }

  const deleted = new Set<number>();
  const channels = new Map<string, { name: string; messages: number }>();
  const botLike = new Map<number, BotLikeSender>();
  const messages: IngestMessage[] = [];

  for (const e of entries) {
    if (e.type === "service") {
      stats.serviceEntries++;
      const action = typeof e.action === "string" ? e.action : "unknown";
      stats.serviceByAction[action] = (stats.serviceByAction[action] ?? 0) + 1;
      skip("SERVICE");
      continue;
    }
    if (e.type !== "message") {
      const t = String(e.type);
      stats.unknownEntryTypes[t] = (stats.unknownEntryTypes[t] ?? 0) + 1;
      skip("UNKNOWN_ENTRY_TYPE");
      err(`entry ${String(e.id)}: unknown entry type "${t}"`);
      continue;
    }
    stats.messageEntries++;

    if (typeof e.id !== "number" || typeof e.from_id !== "string") {
      skip("NON_USER_OR_MALFORMED");
      err(`entry ${String(e.id)}: missing id or from_id`);
      continue;
    }
    const idMatch = USER_ID.exec(e.from_id);
    if (!idMatch) {
      if (e.from_id.startsWith("channel")) {
        const c = channels.get(e.from_id) ?? { name: typeof e.from === "string" ? e.from : "", messages: 0 };
        c.messages++;
        channels.set(e.from_id, c);
        skip("CHANNEL_OR_ANONYMOUS_SENDER");
      } else {
        skip("NON_USER_OR_MALFORMED");
        err(`entry ${e.id}: unrecognised from_id "${e.from_id.slice(0, 30)}"`);
      }
      continue;
    }
    const authorId = Number(idMatch[1]);
    if (typeof e.from !== "string") {
      // Telegram shows "Deleted Account": id is stable but unusable. Never import as a person.
      deleted.add(authorId);
      skip("DELETED_ACCOUNT");
      continue;
    }
    if (options.excludeUserIds?.has(authorId)) {
      skip("EXCLUDED_BY_OPERATOR");
      continue;
    }

    const unix = Number(e.date_unixtime);
    const sentAtMs = Number.isFinite(unix) && unix > 0 ? unix * 1000 : Date.parse(typeof e.date === "string" ? `${e.date}Z` : "");
    if (!Number.isFinite(sentAtMs)) {
      skip("BAD_DATE");
      err(`entry ${e.id}: no usable date`);
      continue;
    }

    const text = flattenText(e.text);
    if (text === null) {
      err(`entry ${e.id}: text has an unexpected shape`);
    }
    const body = text ?? "";

    // --- replies
    let isReply = false;
    let replyToUserId: number | null = null;
    if (typeof e.reply_to_message_id === "number") {
      if (e.reply_to_peer_id !== undefined) {
        stats.replyKinds.otherChat++;
      } else if (serviceIds.has(e.reply_to_message_id)) {
        stats.replyKinds.implicitTopicOrService++;
      } else if (!authorByMessage.has(e.reply_to_message_id)) {
        isReply = true;
        stats.replyKinds.toUnknown++;
      } else {
        isReply = true;
        replyToUserId = authorByMessage.get(e.reply_to_message_id) ?? null;
        if (replyToUserId === null) stats.replyKinds.toChannel++;
        else stats.replyKinds.toUser++;
      }
    }

    // --- reactions (only reactors we can actually identify)
    const refs: ReactionRef[] = [];
    if (Array.isArray(e.reactions)) {
      const offsetMs = typeof e.date === "string" ? Date.parse(`${e.date}Z`) - sentAtMs : 0; // export-local clock → UTC (approximate across DST)
      for (const r of e.reactions as Array<{ count?: unknown; type?: unknown; recent?: unknown }>) {
        const count = typeof r.count === "number" ? r.count : 0;
        stats.reactions.total += count;
        if (r.type === "custom_emoji") stats.reactions.customEmoji += count;
        const recent = Array.isArray(r.recent) ? (r.recent as Array<{ from_id?: unknown; date?: unknown }>) : [];
        let attributed = 0;
        for (const who of recent) {
          if (typeof who.from_id !== "string" || typeof who.date !== "string") continue;
          const m = USER_ID.exec(who.from_id);
          if (!m) {
            stats.reactions.attributedToChannels++;
            attributed++;
            continue;
          }
          const atMs = Date.parse(`${who.date}Z`) - offsetMs;
          if (!Number.isFinite(atMs)) continue;
          attributed++;
          stats.reactions.attributedToUsers++;
          refs.push({ reactorId: Number(m[1]), atMs, day: who.date.slice(0, 10) });
        }
        stats.reactions.unattributed += Math.max(0, count - attributed);
      }
    }

    // --- misc counters
    const edited = e.edited !== undefined;
    if (edited) stats.editedMessages++;
    if (e.forwarded_from !== undefined || e.forwarded_from_id !== undefined) stats.forwardedMessages++;
    if (e.via_bot !== undefined) stats.viaBotMessages++;
    if (body.trim()) stats.messagesWithText++;
    else if (mediaKindOf(e) !== "none" || e.sticker_emoji !== undefined) stats.mediaOnlyMessages++;
    if (BOT_LIKE.test(e.from)) {
      const b = botLike.get(authorId) ?? { id: authorId, name: e.from, messages: 0 };
      b.messages++;
      botLike.set(authorId, b);
    }

    messages.push({
      chatId,
      messageId: e.id,
      authorId,
      username: null, // the export carries no usernames — never invent one
      displayName: e.from,
      sentAtMs,
      text: body,
      isReply,
      replyToUserId,
      isForwarded: e.forwarded_from !== undefined || e.forwarded_from_id !== undefined,
      mediaKind: mediaKindOf(e),
      source: "IMPORT",
      edited,
      ...(refs.length ? { reactions: refs } : {}),
    });
  }

  messages.sort((a, b) => a.sentAtMs - b.sentAtMs || a.messageId - b.messageId);
  stats.deletedAccountIds = [...deleted].sort((a, b) => a - b);
  stats.channelSenders = [...channels.entries()].map(([id, c]) => ({ id, ...c })).sort((a, b) => b.messages - a.messages);
  stats.botLikeSenders = [...botLike.values()].sort((a, b) => b.messages - a.messages);
  return { chatId, chatName: typeof root.name === "string" ? root.name : "", chatType, exportChatId, messages, skipped, stats };
}
