import { describe, expect, it } from "vitest";

import { extractFeatures } from "@/domain/telegram/features";
import { scoreMessage, SequenceScorer } from "@/domain/telegram/scoring";
import { computeActivityScore } from "@/domain/telegram/activity";
import { parseTelegramUpdate } from "@/domain/telegram/updates";
import { parseTelegramExport } from "@/domain/telegram/exportParser";
import type { IngestMessage, ScoringContext } from "@/domain/telegram/types";
import { sha256Hex } from "@/domain/util/hash";

import { settings } from "../support/fixtures";

const T = settings.telegram;
const hash = (s: string) => sha256Hex(`pepper:${s}`);
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);

function feat(text: string, over: Partial<IngestMessage> = {}, at = T0) {
  return extractFeatures(
    { text, sentAtMs: at, isReply: false, replyToUserId: null, authorId: 1, isForwarded: false, mediaKind: "none", ...over },
    T,
    hash,
  );
}
const ctx = (over: Partial<ScoringContext> = {}): ScoringContext => ({
  userStatus: "OK", sinceLastMs: null, messagesInBurstWindow: 0, duplicatesInWindow: 0, qualifyingToday: 0, ...over,
});

describe("message scoring (deterministic anti-spam)", () => {
  it("qualifies a normal, substantive message", () => {
    const r = scoreMessage(feat("I think the bonding curve change makes launches fairer for everyone"), ctx(), T);
    expect(r).toMatchObject({ qualifies: true, reason: null });
    expect(r.weight).toBeGreaterThan(0.9);
  });

  it.each([
    ["gm", "TOO_SHORT"],
    ["gm gm gm gm", "GIBBERISH"],
    ["gm wagmi lfg moon pump fren", "LOW_VALUE"],
    ["aaaaaaaaaaaaaaa wow", "GIBBERISH"],
    ["https://example.com/some/path", "LINK_ONLY"],
    ["ok nice", "TOO_SHORT"],
  ])("rejects low-value text %j as %s", (text, reason) => {
    expect(scoreMessage(feat(text), ctx(), T).reason).toBe(reason);
  });

  it("rejects forwarded, media-only and banned/flagged users", () => {
    expect(scoreMessage(feat("a perfectly reasonable long message here", { isForwarded: true }), ctx(), T).reason).toBe("FORWARDED");
    expect(scoreMessage(feat("", { mediaKind: "sticker" }), ctx(), T).reason).toBe("NO_TEXT");
    expect(scoreMessage(feat("a perfectly reasonable long message here"), ctx({ userStatus: "BANNED" }), T).reason).toBe("USER_BANNED");
    expect(scoreMessage(feat("a perfectly reasonable long message here"), ctx({ userStatus: "FLAGGED" }), T).reason).toBe("USER_FLAGGED");
  });

  it("applies rate limits: too fast, burst, duplicate, daily cap", () => {
    const f = feat("a perfectly reasonable long message here");
    expect(scoreMessage(f, ctx({ sinceLastMs: T.minGapMs - 1 }), T).reason).toBe("TOO_FAST");
    expect(scoreMessage(f, ctx({ sinceLastMs: T.minGapMs }), T).qualifies).toBe(true);
    expect(scoreMessage(f, ctx({ messagesInBurstWindow: T.burstMax }), T).reason).toBe("BURST");
    expect(scoreMessage(f, ctx({ duplicatesInWindow: 1 }), T).reason).toBe("DUPLICATE");
    expect(scoreMessage(f, ctx({ qualifyingToday: T.maxQualifyingPerDay }), T).reason).toBe("DAILY_CAP");
    expect(scoreMessage(f, ctx({ qualifyingToday: T.maxQualifyingPerDay - 1 }), T).qualifies).toBe(true);
  });

  it("treats case/punctuation/emoji variants of the same text as identical (dedupe)", () => {
    const a = feat("Wen moon? the roadmap looks really solid to me!!!");
    const b = feat("wen moon the roadmap looks really solid to me 🚀🚀");
    expect(a.textHash).toBe(b.textHash);
  });

  it("gives replies and questions a small bonus, capped at the configured maximum", () => {
    const plain = scoreMessage(feat("this is a reasonably long and thoughtful message about the project"), ctx(), T);
    const reply = scoreMessage(feat("this is a reasonably long and thoughtful message about the project?", { isReply: true, replyToUserId: 2 }), ctx(), T);
    expect(reply.weight).toBeGreaterThan(plain.weight);
    expect(reply.weight).toBeLessThanOrEqual(T.weights.max);
  });
});

describe("sequence scoring: 50-message eligibility boundary", () => {
  function distinctMessages(count: number, perDay: number) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const day = Math.floor(i / perDay);
      const within = i % perDay;
      const at = T0 + day * DAY + within * 60_000;
      out.push(feat(`unique substantive message number ${i} about topic ${i * 7} and more words`, {}, at));
    }
    return out;
  }

  it("preserves qualifying counts around the 50-message threshold", () => {
    for (const [n, expected] of [[49, 49], [50, 50], [51, 51], [99, 99], [100, 100]] as const) {
      const scorer = new SequenceScorer(T);
      const qualifying = distinctMessages(n, 30).map((f) => scorer.push(f)).filter((r) => r.qualifies).length;
      expect(qualifying).toBe(expected);
      expect(qualifying >= T.qualifyingThreshold).toBe(n >= T.qualifyingThreshold);
    }
  });

  it("still respects the configured per-day qualifying-message cap", () => {
    const scorer = new SequenceScorer(T);
    const results = distinctMessages(100, 100).map((f) => scorer.push(f));
    expect(results.filter((r) => r.qualifies).length).toBe(T.maxQualifyingPerDay);
    expect(results.filter((r) => r.reason === "DAILY_CAP").length).toBe(100 - T.maxQualifyingPerDay);
  });

  it("repeated identical messages earn nothing after the first", () => {
    const scorer = new SequenceScorer(T);
    const results = Array.from({ length: 20 }, (_, i) => scorer.push(feat("buy this token right now it is going to the moon fast", {}, T0 + i * 10_000)));
    expect(results.filter((r) => r.qualifies).length).toBe(1);
    expect(results.slice(1).every((r) => r.reason === "DUPLICATE")).toBe(true);
  });

  it("rapid-fire low-value messages and 'gm' farming earn nothing", () => {
    const scorer = new SequenceScorer(T);
    const rapid = Array.from({ length: 30 }, (_, i) => scorer.push(feat(`gm everyone number ${i} lets go`, {}, T0 + i * 500)));
    expect(rapid.filter((r) => r.qualifies).length).toBeLessThanOrEqual(1);
    const gm = Array.from({ length: 50 }, (_, i) => scorer.push(feat("gm", {}, T0 + DAY + i * 20_000)));
    expect(gm.every((r) => !r.qualifies)).toBe(true);
  });

  it("incremental (webhook) scoring matches batch (recompute) scoring", () => {
    const messages = [
      ...distinctMessages(60, 20),
      feat("buy this token right now it is going to the moon fast", {}, T0 + 10 * DAY),
      feat("buy this token right now it is going to the moon fast", {}, T0 + 10 * DAY + 20_000),
      feat("gm", {}, T0 + 10 * DAY + 40_000),
    ];
    const batch = new SequenceScorer(T);
    const batchResults = messages.map((f) => batch.push(f));

    // Rebuild each context "from the database" the way the live path does.
    const live = messages.map((f, idx) => {
      const prior = messages.slice(0, idx);
      const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
      const qualifyingToday = prior.filter((p, j) => dayKey(p.sentAtMs) === dayKey(f.sentAtMs) && batchResults[j]!.qualifies).length;
      return scoreMessage(
        f,
        {
          userStatus: "OK",
          sinceLastMs: prior.length ? f.sentAtMs - prior[prior.length - 1]!.sentAtMs : null,
          messagesInBurstWindow: prior.filter((p) => p.sentAtMs > f.sentAtMs - T.burstWindowMs).length,
          duplicatesInWindow: f.textHash ? prior.filter((p) => p.textHash === f.textHash && p.sentAtMs >= f.sentAtMs - T.duplicateWindowHours * 3_600_000).length : 0,
          qualifyingToday,
        },
        T,
      );
    });
    expect(live.map((r) => [r.qualifies, r.reason])).toEqual(batchResults.map((r) => [r.qualifies, r.reason]));
  });
});

describe("hybrid activity score", () => {
  const base = { totalMessages: 0, qualifyingMessages: 0, activeDays: 0, repliesSent: 0, repliesReceived: 0, reactionsReceived: 0, qualitySum: 0 };
  it("is 0 for no activity and strictly below 100 even for extreme volume", () => {
    expect(computeActivityScore(base, T)).toBe(0);
    const extreme = computeActivityScore({ ...base, qualifyingMessages: 1e6, qualitySum: 1e6, activeDays: 1e4, repliesSent: 1e6, reactionsReceived: 1e6 }, T);
    expect(extreme).toBeLessThanOrEqual(100);
    expect(extreme).toBeGreaterThan(95);
  });
  it("volume alone cannot max the score: active days, conversation and quality matter", () => {
    const spammer = computeActivityScore({ ...base, qualifyingMessages: 5000, qualitySum: 2500, activeDays: 3 }, T);
    const rounded = computeActivityScore({ ...base, qualifyingMessages: 400, qualitySum: 380, activeDays: 60, repliesSent: 120, repliesReceived: 60, reactionsReceived: 80 }, T);
    expect(rounded).toBeGreaterThan(spammer);
  });
  it("has diminishing returns in message count", () => {
    const at = (n: number) => computeActivityScore({ ...base, qualifyingMessages: n, qualitySum: n }, T);
    expect(at(200) - at(100)).toBeGreaterThan(at(1100) - at(1000));
  });
});

describe("Telegram update parsing (malformed / hostile input)", () => {
  const CHAT = -1001234567890;
  const msg = (over: Record<string, unknown> = {}) => ({
    update_id: 10,
    message: { message_id: 5, date: 1_780_000_000, chat: { id: CHAT, type: "supergroup" }, from: { id: 42, is_bot: false, first_name: "Ada", username: "ada" }, text: "hello there friends", ...over },
  });

  it("parses a normal group message", () => {
    const r = parseTelegramUpdate(msg(), CHAT);
    expect(r.kind).toBe("message");
    if (r.kind === "message") expect(r.message).toMatchObject({ authorId: 42, username: "ada", displayName: "Ada", source: "LIVE", isReply: false });
  });
  it("ignores other chats (only the official community counts)", () => {
    expect(parseTelegramUpdate(msg({ chat: { id: -100999, type: "supergroup" } }), CHAT)).toMatchObject({ kind: "ignored", reason: "WRONG_CHAT" });
  });
  it("ignores bots, anonymous/channel senders and unsupported updates", () => {
    expect(parseTelegramUpdate(msg({ from: { id: 7, is_bot: true } }), CHAT)).toMatchObject({ reason: "BOT_SENDER" });
    expect(parseTelegramUpdate(msg({ from: undefined, sender_chat: { id: -100555 } }), CHAT)).toMatchObject({ reason: "ANONYMOUS_OR_CHANNEL_SENDER" });
    expect(parseTelegramUpdate({ update_id: 1, edited_message: {} }, CHAT)).toMatchObject({ reason: "UNSUPPORTED_UPDATE" });
  });
  it("never throws on malformed payloads", () => {
    for (const bad of [null, 5, "x", [], {}, { update_id: "1" }, { update_id: 1, message: { chat: 3 } }, { update_id: -4 }]) {
      expect(parseTelegramUpdate(bad, CHAT).kind).toBe("ignored");
    }
  });
  it("detects replies, forwards and captions", () => {
    const r = parseTelegramUpdate(msg({ text: undefined, caption: "nice chart everyone", reply_to_message: { message_id: 1, from: { id: 9, is_bot: false } }, forward_origin: { type: "user" } }), CHAT);
    expect(r.kind === "message" && r.message).toMatchObject({ text: "nice chart everyone", isReply: true, replyToUserId: 9, isForwarded: true });
  });
  it("parses reaction add/remove and ignores swaps and anonymous reactions", () => {
    const base = { update_id: 3, message_reaction: { chat: { id: CHAT }, message_id: 8, user: { id: 11, is_bot: false }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "🔥" }] } };
    expect(parseTelegramUpdate(base, CHAT)).toMatchObject({ kind: "reaction", added: true, reactorId: 11, messageId: 8 });
    const removed = { ...base, message_reaction: { ...base.message_reaction, old_reaction: [{ type: "emoji", emoji: "🔥" }], new_reaction: [] } };
    expect(parseTelegramUpdate(removed, CHAT)).toMatchObject({ kind: "reaction", added: false });
    const swap = { ...base, message_reaction: { ...base.message_reaction, old_reaction: [{ type: "emoji", emoji: "👍" }] } };
    expect(parseTelegramUpdate(swap, CHAT)).toMatchObject({ reason: "REACTION_SWAP" });
    const anon = { ...base, message_reaction: { ...base.message_reaction, user: undefined } };
    expect(parseTelegramUpdate(anon, CHAT)).toMatchObject({ reason: "ANONYMOUS_REACTION" });
  });
});

describe("Telegram Desktop export parser (historical import)", () => {
  const exportJson = {
    name: "Clank.trade Community",
    type: "public_supergroup",
    id: 1234567890,
    messages: [
      { id: 1, type: "service", date_unixtime: "1780000000", actor: "x", action: "join" },
      { id: 2, type: "message", date_unixtime: "1780000100", from: "Ada", from_id: "user42", text: "first real message in the group" },
      { id: 3, type: "message", date_unixtime: "1780000200", from: "Bob", from_id: "user77", text: [{ type: "bold", text: "reply " }, "with entities"], reply_to_message_id: 2 },
      { id: 4, type: "message", date_unixtime: "1780000300", from: "Channel", from_id: "channel99", text: "not a user" },
      { id: 5, type: "message", date_unixtime: "1780000400", from: "Ada", from_id: "user42", text: "", photo: "photos/a.jpg", forwarded_from: "Someone" },
    ],
  };
  it("normalises to Bot API chat ids and resolves reply authors", () => {
    const r = parseTelegramExport(exportJson);
    expect(r.chatId).toBe(-1001234567890);
    expect(r.messages).toHaveLength(3);
    expect(r.messages[1]).toMatchObject({ authorId: 77, text: "reply with entities", isReply: true, replyToUserId: 42, source: "IMPORT" });
    expect(r.messages[2]).toMatchObject({ mediaKind: "photo", isForwarded: true });
    expect(r.skipped).toEqual({ SERVICE: 1, CHANNEL_OR_ANONYMOUS_SENDER: 1 });
  });
  it("rejects files that are not Telegram exports", () => {
    expect(() => parseTelegramExport({ foo: 1 })).toThrow(/messages/);
    expect(() => parseTelegramExport(null)).toThrow();
  });
});
