import { describe, expect, it } from "vitest";

import { parseTelegramExport } from "@/domain/telegram/exportParser";

/** Entries copy the exact field names/shapes observed in a real 97k-entry Telegram Desktop export. */
const T = Date.UTC(2025, 2, 1, 12, 0, 0) / 1000;
const msg = (id: number, over: Record<string, unknown> = {}) => ({
  id, type: "message", date: "2025-03-01T12:00:00", date_unixtime: String(T + id), from: `User ${id}`, from_id: `user${1000 + id}`,
  text: "a perfectly ordinary message", text_entities: [{ type: "plain", text: "a perfectly ordinary message" }], ...over,
});
const service = (id: number, action: string, over: Record<string, unknown> = {}) => ({ id, type: "service", date: "2025-03-01T12:00:00", date_unixtime: String(T), actor: "x", actor_id: "channel1", action, text: "", text_entities: [], ...over });

const EXPORT = {
  name: "clank.trade (ex daos.fun)", type: "public_supergroup", id: 2494847180,
  messages: [
    service(1, "migrate_from_group", { title: "DAOS.FUN" }),
    service(2, "topic_created", { title: "Issues" }),
    service(3, "invite_members", { members: ["A", "B"] }),
    msg(10),
    msg(11, { reply_to_message_id: 10 }), // real reply to a user message
    msg(12, { reply_to_message_id: 2 }), // implicit forum-topic reply → NOT a reply
    msg(13, { reply_to_message_id: 3 }), // reply to a join message → NOT a reply
    msg(14, { reply_to_message_id: 999 }), // reply to a deleted message → reply, author unknown
    msg(15, { reply_to_message_id: 7, reply_to_peer_id: "channel2189722115" }), // other chat → NOT a reply
    msg(16, { from: null, from_id: "user555" }), // deleted account
    msg(17, { from: "DONG | BNB", from_id: "channel4242" }), // chatting as a channel
    msg(18, { reply_to_message_id: 17 }), // reply to a channel-sent message → reply, no user target
    msg(19, { forwarded_from: "Someone", forwarded_from_id: "user77" }),
    msg(20, { text: "", text_entities: [], sticker_emoji: "🔥", file: "(File not included)", media_type: "sticker" }),
    msg(21, { photo: "(File not included)", text: [{ type: "bold", text: "caption " }, "with ", { type: "link", text: "link.io" }], edited: "2025-03-01T12:05:00", edited_unixtime: String(T + 300) }),
    msg(22, { text: [{ type: "bold" }] }), // malformed entity → parse error, but the message is still read as empty text
    msg(23, { from: "CLANK BOT", from_id: "user8888" }),
    msg(24, { via_bot: "@catizenbot" }),
    msg(25, { date: "garbage", date_unixtime: "" }), // no usable date
    { id: 26, type: "weird" },
    msg(27, {
      reactions: [
        { type: "emoji", count: 4, emoji: "👍", recent: [
          { from: "User 11", from_id: "user1011", date: "2025-03-01T12:10:00" },
          { from: "Self", from_id: "user1027", date: "2025-03-01T12:11:00" },
          { from: "Chan", from_id: "channel9", date: "2025-03-01T12:12:00" },
        ] },
        { type: "custom_emoji", count: 1, document_id: "5", recent: [] },
      ],
    }),
  ],
};

describe("Telegram Desktop export parser — real-export shapes", () => {
  const r = parseTelegramExport(EXPORT);
  const byId = new Map(r.messages.map((m) => [m.messageId, m]));

  it("identifies the chat and maps it to the Bot API id", () => {
    expect(r.chatName).toBe("clank.trade (ex daos.fun)");
    expect(r.chatType).toBe("public_supergroup");
    expect(r.exportChatId).toBe(2494847180);
    expect(r.chatId).toBe(-1002494847180);
  });

  it("ignores service messages and reports them by action", () => {
    expect(r.stats.serviceEntries).toBe(3);
    expect(r.stats.serviceByAction).toEqual({ migrate_from_group: 1, topic_created: 1, invite_members: 1 });
    expect(r.skipped.SERVICE).toBe(3);
  });

  it("never turns a deleted account or a channel into a person, and says how many", () => {
    expect(byId.has(16)).toBe(false);
    expect(byId.has(17)).toBe(false);
    expect(r.skipped.DELETED_ACCOUNT).toBe(1);
    expect(r.skipped.CHANNEL_OR_ANONYMOUS_SENDER).toBe(1);
    expect(r.stats.deletedAccountIds).toEqual([555]);
    expect(r.stats.channelSenders).toEqual([{ id: "channel4242", name: "DONG | BNB", messages: 1 }]);
  });

  it("counts only REAL conversational replies", () => {
    expect(byId.get(11)).toMatchObject({ isReply: true, replyToUserId: 1010 });
    expect(byId.get(12)).toMatchObject({ isReply: false, replyToUserId: null }); // forum topic root
    expect(byId.get(13)).toMatchObject({ isReply: false }); // join message
    expect(byId.get(14)).toMatchObject({ isReply: true, replyToUserId: null }); // deleted target
    expect(byId.get(15)).toMatchObject({ isReply: false }); // other chat
    expect(byId.get(18)).toMatchObject({ isReply: true, replyToUserId: null }); // channel-sent target
    expect(r.stats.replyKinds).toEqual({ toUser: 1, toChannel: 1, toUnknown: 1, implicitTopicOrService: 2, otherChat: 1 });
  });

  it("handles forwards, stickers, captions, edits and via-bot messages", () => {
    expect(byId.get(19)).toMatchObject({ isForwarded: true });
    expect(byId.get(20)).toMatchObject({ mediaKind: "sticker", text: "" });
    expect(byId.get(21)).toMatchObject({ mediaKind: "photo", text: "caption with link.io", edited: true });
    expect(byId.get(24)!.isForwarded).toBe(false);
    expect(r.stats).toMatchObject({ forwardedMessages: 1, editedMessages: 1, viaBotMessages: 1 });
    expect(r.stats.mediaOnlyMessages).toBeGreaterThanOrEqual(1);
  });

  it("never invents a username", () => {
    for (const m of r.messages) expect(m.username).toBeNull();
  });

  it("reports unparseable entries instead of crashing or silently dropping them", () => {
    expect(r.skipped.BAD_DATE).toBe(1);
    expect(r.skipped.UNKNOWN_ENTRY_TYPE).toBe(1);
    expect(r.stats.unknownEntryTypes).toEqual({ weird: 1 });
    expect(r.stats.parseErrors.some((e) => e.includes("entry 22"))).toBe(true);
    expect(r.stats.parseErrors.some((e) => e.includes("entry 25"))).toBe(true);
    expect(byId.get(22)!.text).toBe("");
  });

  it("surfaces bot-LIKE names for review without removing them; operators can exclude explicit ids", () => {
    expect(byId.has(23)).toBe(true);
    expect(r.stats.botLikeSenders).toEqual([{ id: 8888, name: "CLANK BOT", messages: 1 }]);
    const excluded = parseTelegramExport(EXPORT, { excludeUserIds: new Set([8888]) });
    expect(excluded.messages.some((m) => m.authorId === 8888)).toBe(false);
    expect(excluded.skipped.EXCLUDED_BY_OPERATOR).toBe(1);
  });

  it("keeps only reactions whose reactor Telegram actually identified", () => {
    const refs = byId.get(27)!.reactions!;
    expect(refs.map((x) => x.reactorId).sort()).toEqual([1011, 1027]);
    expect(r.stats.reactions).toMatchObject({ total: 5, attributedToUsers: 2, attributedToChannels: 1, customEmoji: 1 });
    expect(r.stats.reactions.unattributed).toBe(2); // 5 total − 3 listed
  });

  it("sorts chronologically with a stable id tiebreak and keeps ids unique", () => {
    const times = r.messages.map((m) => [m.sentAtMs, m.messageId]);
    expect(times).toEqual([...times].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    expect(new Set(r.messages.map((m) => m.messageId)).size).toBe(r.messages.length);
  });

  it("rejects things that are not an export", () => {
    expect(() => parseTelegramExport({ foo: 1 })).toThrow(/messages/);
    expect(() => parseTelegramExport([])).toThrow();
    expect(() => parseTelegramExport({ messages: [] })).toThrow(/chat id/);
    expect(parseTelegramExport({ messages: [] }, { chatId: -100 }).chatId).toBe(-100);
  });
});
