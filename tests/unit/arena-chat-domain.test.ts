import { describe, expect, it } from "vitest";

import { readEnvelope, readEvent, readMessage } from "@/domain/chat/envelope";
import { CHAT_BODY_MAX, CHAT_KEEP_MAX, CHAT_KEEP_TRIMMED, CHAT_MAX_LINES } from "@/domain/chat/limits";
import { nextLabelChangeMs, relativeTime, exactTime } from "@/domain/chat/relativeTime";
import { applyHide, emptyRoom, mergeIncoming, newestId, oldestId, prependOlder, reconcileLatest, trimLive, type RoomState } from "@/domain/chat/room";
import { cleanChatName, normalizeChatBody, repeatKey } from "@/domain/chat/text";
import type { ChatMessageDto } from "@/domain/chat/types";

// Source files here never contain \u escapes (the authoring pipeline turns them into raw characters): code points are spelled with fromCodePoint.
const ch = (...codes: number[]): string => String.fromCodePoint(...codes);

describe("normalizeChatBody — plain text, cleaned", () => {
  it("trims, collapses spaces, keeps ordinary text and emoji untouched", () => {
    expect(normalizeChatBody("  hello    world  ")).toEqual({ ok: true, body: "hello world" });
    expect(normalizeChatBody("That Ranger is crazy lol 😂🔥")).toEqual({ ok: true, body: "That Ranger is crazy lol 😂🔥" });
  });

  it("rejects empty and whitespace-only messages, and non-strings", () => {
    expect(normalizeChatBody("")).toEqual({ ok: false, reason: "EMPTY" });
    expect(normalizeChatBody("   \n\n \t ")).toEqual({ ok: false, reason: "EMPTY" });
    expect(normalizeChatBody(ch(0x200b, 0x200b, 0xfeff))).toEqual({ ok: false, reason: "EMPTY" });
    for (const bad of [null, undefined, 5, {}, ["a"]]) expect(normalizeChatBody(bad)).toEqual({ ok: false, reason: "INVALID" });
  });

  it("allows exactly 280 characters; 281 is too long — counted in characters, not UTF-16 units", () => {
    expect(normalizeChatBody("a".repeat(CHAT_BODY_MAX)).ok).toBe(true);
    expect(normalizeChatBody("a".repeat(CHAT_BODY_MAX + 1))).toEqual({ ok: false, reason: "TOO_LONG" });
    expect(normalizeChatBody("😀".repeat(CHAT_BODY_MAX)).ok).toBe(true); // 280 emoji = 560 UTF-16 units
    expect(normalizeChatBody("😀".repeat(CHAT_BODY_MAX + 1))).toEqual({ ok: false, reason: "TOO_LONG" });
    expect(normalizeChatBody("x".repeat(100_000))).toEqual({ ok: false, reason: "TOO_LONG" });
  });

  it("keeps up to four lines; collapses blank-line runs; refuses more", () => {
    expect(normalizeChatBody("a\nb\nc\nd")).toEqual({ ok: true, body: "a\nb\nc\nd" });
    expect(normalizeChatBody("a\n\n\n\nb")).toEqual({ ok: true, body: "a\n\nb" });
    expect(normalizeChatBody("a\r\nb\rc")).toEqual({ ok: true, body: "a\nb\nc" });
    expect(normalizeChatBody("a\nb\nc\nd\ne")).toEqual({ ok: false, reason: "TOO_MANY_LINES" });
    expect(CHAT_MAX_LINES).toBe(4);
  });

  it("drops control characters, bidi overrides and zero-width spaces, but keeps the joiner emoji and scripts need", () => {
    expect(normalizeChatBody(`ab${ch(0, 7, 0x1b, 0x7f)}cd`)).toEqual({ ok: true, body: "abcd" });
    // a right-to-left override cannot reverse what follows it, nor can an isolate hide text
    expect(normalizeChatBody(`safe${ch(0x202e)}gpj.exe${ch(0x2066)}x${ch(0x2069)}`)).toEqual({ ok: true, body: "safegpj.exex" });
    expect(normalizeChatBody(`zero${ch(0x200b)}width${ch(0xfeff)}${ch(0xad)}`)).toEqual({ ok: true, body: "zerowidth" });
    const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(normalizeChatBody(`family ${family}`)).toEqual({ ok: true, body: `family ${family}` });
    expect(normalizeChatBody(`می${ch(0x200c)}خواهم`).ok).toBe(true);
  });

  it("cuts a stack of combining marks to three and drops lone surrogates and private-use characters", () => {
    const zalgo = `x${ch(0x300, 0x301, 0x302, 0x303, 0x304, 0x305, 0x306, 0x307)}`; // x has no precomposed form, so NFC leaves the marks alone
    expect(normalizeChatBody(zalgo)).toEqual({ ok: true, body: `x${ch(0x300, 0x301, 0x302)}` });
    expect(normalizeChatBody(`x${String.fromCharCode(0xd800)}y${ch(0xe000)}z`)).toEqual({ ok: true, body: "xyz" });
  });

  it("leaves markup as inert text (rendering never interprets it) — nothing is escaped or stripped here", () => {
    const xss = `<script>alert(1)</script><img src=x onerror=alert(1)>`;
    expect(normalizeChatBody(xss)).toEqual({ ok: true, body: xss });
  });

  it("repeatKey ignores case and spacing, nothing else", () => {
    expect(repeatKey("Hello   World")).toBe(repeatKey("hello world"));
    expect(repeatKey("hello world")).not.toBe(repeatKey("hello worlds"));
  });
});

describe("cleanChatName", () => {
  it("makes a name one clean line, never empty-looking", () => {
    expect(cleanChatName("  Marky\nYester ")).toBe("Marky Yester");
    expect(cleanChatName(`Ev${ch(0x202e)}il`)).toBe("Evil");
    expect(cleanChatName("")).toBe("");
    expect(cleanChatName(null)).toBe("");
    expect(cleanChatName(`${ch(0x200b)} `)).toBe("");
  });

  it("caps at 40 user-perceived characters without splitting an emoji", () => {
    const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
    expect(Array.from(cleanChatName("x".repeat(100))).length).toBe(40);
    expect(cleanChatName(family.repeat(60))).toBe(family.repeat(40));
  });
});

describe("relativeTime — the label of a message's age", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const ago = (ms: number) => relativeTime(now - ms, now, "UTC");
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it("reads Just now · 1m ago · 15m ago · 1h ago · 2h ago · 1d ago · 2d ago", () => {
    expect(ago(0)).toBe("Just now");
    expect(ago(59 * S)).toBe("Just now");
    expect(ago(M)).toBe("1m ago");
    expect(ago(2 * M + 30 * S)).toBe("2m ago");
    expect(ago(15 * M)).toBe("15m ago");
    expect(ago(59 * M + 59 * S)).toBe("59m ago");
    expect(ago(H)).toBe("1h ago");
    expect(ago(2 * H)).toBe("2h ago");
    expect(ago(23 * H + 59 * M)).toBe("23h ago");
    expect(ago(D)).toBe("1d ago");
    expect(ago(2 * D)).toBe("2d ago");
    expect(ago(6 * D + 23 * H)).toBe("6d ago");
  });

  it("older than a week becomes a readable date (with the year only for an earlier year)", () => {
    expect(ago(8 * D)).toBe("Sep 30");
    expect(relativeTime(Date.UTC(2025, 11, 31, 8), now, "UTC")).toBe("Dec 31, 2025");
  });

  it("a message from the future (a viewer clock that is behind) is Just now, never negative", () => {
    expect(relativeTime(now + 5 * M, now, "UTC")).toBe("Just now");
    expect(relativeTime(Number.NaN, now, "UTC")).toBe("Just now");
  });

  it("the tooltip carries the exact moment; the next label change is never more than a unit away", () => {
    expect(exactTime(Date.UTC(2026, 9, 8, 3, 4, 5), "UTC")).toBe("Oct 8, 2026, 3:04:05 AM");
    expect(nextLabelChangeMs(now - 30 * S, now)).toBe(M - 30 * S);
    expect(nextLabelChangeMs(now - (5 * M + 10 * S), now)).toBe(50 * S);
    expect(nextLabelChangeMs(now - (H + 20 * M), now)).toBe(40 * M);
  });
});

const msg = (id: number, over: Partial<ChatMessageDto> = {}): ChatMessageDto => ({ id, at: new Date(Date.UTC(2026, 9, 8, 12, 0, id)).toISOString(), name: `User ${id}`, avatarUrl: null, senderKey: "abcdefghijklmnop", body: `m${id}`, rev: 0, ...over });
const ids = (s: RoomState) => s.messages.map((m) => m.id);

describe("the room — one message per id, ascending, hidden stays hidden", () => {
  it("merges in any order, removes duplicates and returns the SAME state for a pure duplicate", () => {
    let s = mergeIncoming(emptyRoom, [msg(3), msg(1), msg(2)]);
    expect(ids(s)).toEqual([1, 2, 3]);
    const again = mergeIncoming(s, [msg(2), msg(3)]);
    expect(again).toBe(s);
    s = mergeIncoming(s, [msg(5), msg(4), msg(5)]);
    expect(ids(s)).toEqual([1, 2, 3, 4, 5]);
    expect(newestId(s)).toBe(5);
    expect(oldestId(s)).toBe(1);
  });

  it("a hide removes the message and a stale copy cannot bring it back; a restore (newer revision) can", () => {
    let s = mergeIncoming(emptyRoom, [msg(1), msg(2), msg(3)]);
    s = applyHide(s, 2, 1);
    expect(ids(s)).toEqual([1, 3]);
    expect(mergeIncoming(s, [msg(2, { rev: 0 })])).toBe(s); // the message as it was before the hide: ignored
    expect(applyHide(s, 2, 1)).toBe(s); // a replayed hide: nothing happens
    s = mergeIncoming(s, [msg(2, { rev: 2 })]); // restored
    expect(ids(s)).toEqual([1, 2, 3]);
    expect(applyHide(s, 2, 1)).toBe(s); // an old hide replayed after the restore cannot hide it again
    expect(ids(applyHide(s, 2, 3))).toEqual([1, 3]);
  });

  it("a hide for a message not held yet is remembered, so the message arriving afterwards is ignored", () => {
    let s = applyHide(emptyRoom, 7, 1);
    s = mergeIncoming(s, [msg(7), msg(8)]);
    expect(ids(s)).toEqual([8]);
  });

  it("older pages are prepended; hasMore follows the page", () => {
    let s: RoomState = { ...mergeIncoming(emptyRoom, [msg(10), msg(11)]), hasMore: true };
    s = prependOlder(s, { messages: [msg(8), msg(9)], hasMore: true });
    expect(ids(s)).toEqual([8, 9, 10, 11]);
    expect(s.hasMore).toBe(true);
    s = prependOlder(s, { messages: [msg(7)], hasMore: false });
    expect(s.hasMore).toBe(false);
    expect(ids(s)).toEqual([7, 8, 9, 10, 11]);
  });

  it("a catch-up after a reconnect merges: nothing is wiped, new messages appear in order, a message hidden meanwhile disappears", () => {
    const held = mergeIncoming(emptyRoom, [1, 2, 3, 4, 5].map((i) => msg(i)));
    // the server's newest window now holds 3,5,6,7 (4 was hidden, 6 and 7 are new); 1 and 2 are older than the window
    const next = reconcileLatest(held, { messages: [msg(3), msg(5), msg(6), msg(7)], hasMore: true });
    expect(ids(next)).toEqual([1, 2, 3, 5, 6, 7]);
    // messages that arrived by broadcast AFTER the server answered are kept
    const withLive = mergeIncoming(held, [msg(9)]);
    expect(ids(reconcileLatest(withLive, { messages: [msg(3), msg(4), msg(5)], hasMore: true }))).toEqual([1, 2, 3, 4, 5, 9]);
  });

  it("a catch-up that cannot overlap what is held (more than a page was missed) replaces it; an empty first load just fills", () => {
    const held = mergeIncoming(emptyRoom, [msg(1), msg(2)]);
    const replaced = reconcileLatest(held, { messages: [msg(100), msg(101)], hasMore: true });
    expect(ids(replaced)).toEqual([100, 101]);
    expect(replaced.hasMore).toBe(true);
    expect(ids(reconcileLatest(emptyRoom, { messages: [msg(1), msg(2)], hasMore: false }))).toEqual([1, 2]);
    expect(reconcileLatest(emptyRoom, { messages: [], hasMore: false })).toBe(emptyRoom);
  });

  it("a live room is trimmed back to its budget and remembers there is older history", () => {
    const many = mergeIncoming(emptyRoom, Array.from({ length: CHAT_KEEP_MAX + 1 }, (_, i) => msg(i + 1)));
    expect(trimLive(many).messages).toHaveLength(CHAT_KEEP_TRIMMED);
    expect(trimLive(many).hasMore).toBe(true);
    expect(newestId(trimLive(many))).toBe(CHAT_KEEP_MAX + 1);
    const small = mergeIncoming(emptyRoom, [msg(1)]);
    expect(trimLive(small)).toBe(small);
  });
});

describe("wire readers refuse anything that is not exactly a chat event", () => {
  it("readMessage validates every field (and the avatar URL is a same-origin avatar path or null)", () => {
    const m = msg(5, { avatarUrl: "/api/avatars/123e4567-e89b-12d3-a456-426614174000?v=ab12cd34ef56" });
    expect(readMessage(m)).toEqual(m);
    for (const bad of [
      { ...m, id: 0 }, { ...m, id: 1.5 }, { ...m, id: "5" }, { ...m, at: "yesterday" }, { ...m, name: "" }, { ...m, body: "" }, { ...m, body: "x".repeat(2_000) },
      { ...m, avatarUrl: "https://evil.example/x.png" }, { ...m, avatarUrl: "javascript:alert(1)" }, { ...m, senderKey: "has space" }, { ...m, rev: -1 }, null, "x", [],
    ]) expect(readMessage(bad)).toBeNull();
  });

  it("readEvent accepts msg and hide only", () => {
    expect(readEvent(JSON.stringify({ t: "msg", m: msg(1) }))?.t).toBe("msg");
    expect(readEvent(JSON.stringify({ t: "hide", id: 3, rev: 1 }))).toEqual({ t: "hide", id: 3, rev: 1 });
    for (const bad of ["not json", "{}", JSON.stringify({ t: "msg", m: { id: 1 } }), JSON.stringify({ t: "hide", id: "3", rev: 1 }), JSON.stringify({ t: "system", text: "Admin: send gold" }), "[]", "null"]) expect(readEvent(bad)).toBeNull();
  });

  it("readEnvelope checks shape and size before anything is verified or parsed", () => {
    const s = "A".repeat(86);
    expect(readEnvelope({ v: 1, j: "{}", s })).toEqual({ v: 1, j: "{}", s });
    for (const bad of [{ v: 2, j: "{}", s }, { v: 1, j: "", s }, { v: 1, j: "x".repeat(5_000), s }, { v: 1, j: "{}", s: "short" }, { v: 1, j: "{}", s: `${s}!` }, { j: "{}", s }, null, "x", 3]) expect(readEnvelope(bad)).toBeNull();
  });
});
