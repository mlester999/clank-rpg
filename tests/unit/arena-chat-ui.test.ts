import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatBody, LiveChip } from "@/components/arena/chat/ArenaChat";
import type { ChatSnapshot } from "@/components/arena/chat/chatController";
import { ChatComposer, GuestPrompt, MutedNotice } from "@/components/arena/chat/ChatComposer";
import { ChatMessageRow } from "@/components/arena/chat/ChatMessageRow";
import { emptyRoom, mergeIncoming } from "@/domain/chat/room";
import type { ChatMessageDto } from "@/domain/chat/types";

/** What the Arena Chat renders — as markup (no browser): who sees an input, how a message is laid out, which calm panels exist. */

const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const m = (over: Partial<ChatMessageDto> = {}): ChatMessageDto => ({ id: 1, at: "2026-10-08T12:00:00.000Z", name: "Markyyester", avatarUrl: null, senderKey: "abcdefghijklmnop", body: "That Ranger is crazy lol", rev: 0, ...over });
const snap = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({ phase: "ready", closedReason: null, room: mergeIncoming(emptyRoom, [m()]), you: null, live: "live", realtime: true, loadingOlder: false, olderFailed: false, ownTick: 0, ...over });
const body = (s: ChatSnapshot) => renderToStaticMarkup(createElement(ChatBody, { snap: s, onRetry: () => undefined, onLoadOlder: () => undefined, onTrim: () => undefined }));

describe("a message row", () => {
  const row = (message: ChatMessageDto, mine = false) => renderToStaticMarkup(createElement(ChatMessageRow, { message, label: "1m ago", exact: "Oct 8, 2026, 8:00:00 PM", mine }));

  it("puts the name on the LEFT and the age on the FAR RIGHT of one full-width header row, with the text under it", () => {
    const html = row(m());
    expect(html).toMatch(/class="[^"]*\bjustify-between\b[^"]*"[^>]*data-testid="chat-header"/);
    const header = html.slice(html.indexOf('data-testid="chat-header"'), html.indexOf('data-testid="chat-body"'));
    expect(header.indexOf("Markyyester")).toBeGreaterThan(-1);
    expect(header.indexOf("Markyyester")).toBeLessThan(header.indexOf("1m ago")); // name first, time after it
    expect(html.indexOf("That Ranger is crazy lol")).toBeGreaterThan(html.indexOf("1m ago")); // text after the header
    // the time never shrinks and the name is the one that gives way (ellipsis), so a long name can never collide with the time
    expect(html).toMatch(/<time[^>]*class="[^"]*\bshrink-0\b/);
    expect(html).toMatch(/class="[^"]*\bmin-w-0\b[^"]*\btruncate\b[^"]*"[^>]*data-testid="chat-author"/);
    // not "name 1m ago" and not "name: text 1m ago"
    expect(text(html)).toBe("M Markyyester 1m ago That Ranger is crazy lol");
  });

  it("the time carries the exact moment (tooltip + machine-readable) and the avatar falls back to a styled initial", () => {
    const html = row(m({ name: "alex" }));
    expect(html).toContain('title="Oct 8, 2026, 8:00:00 PM"');
    expect(html).toContain('dateTime="2026-10-08T12:00:00.000Z"');
    expect(html).toContain(">A<");
  });

  it("shows a profile photo when there is one, as a same-origin image", () => {
    const html = row(m({ avatarUrl: "/api/avatars/123e4567-e89b-12d3-a456-426614174000?v=ab12cd34ef56" }));
    expect(html).toContain('<img src="/api/avatars/123e4567-e89b-12d3-a456-426614174000?v=ab12cd34ef56"');
  });

  it("renders text as TEXT: markup in a message is escaped, never interpreted", () => {
    const html = row(m({ body: `<img src=x onerror=alert(1)><script>alert("x")</script> & more`, name: `<b>Evil</b>` }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>Evil</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  });

  it("wraps long words and keeps line breaks; the viewer's own messages are marked", () => {
    const html = row(m({ body: `${"w".repeat(300)}\nsecond line` }), true);
    expect(html).toMatch(/data-testid="chat-body"[^>]*class="[^"]*whitespace-pre-wrap[^"]*"|class="[^"]*whitespace-pre-wrap[^"]*"[^>]*data-testid="chat-body"/);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).toContain('data-mine="true"');
    expect(row(m(), false)).toContain('data-mine="false"');
  });
});

describe("who gets an input", () => {
  const send = async () => ({ ok: true as const, message: m(), duplicate: false });
  const you = { senderKey: "mine-mine-mine-12", canSend: true, muted: null };

  it("a guest sees 'Sign in with Telegram to chat.' and a sign-in button — NO input and NO send button anywhere", () => {
    const html = renderToStaticMarkup(createElement(GuestPrompt));
    expect(text(html)).toContain("Sign in with Telegram to chat.");
    expect(html).toContain('href="/character"');
    expect(html).toContain('data-testid="chat-signin"');
    for (const forbidden of ["<textarea", "<input", 'type="submit"', "chat-send", "chat-input"]) expect(html).not.toContain(forbidden);
    const section = renderToStaticMarkup(createElement(ChatBody, { snap: snap({ you: null }), onRetry: () => undefined, onLoadOlder: () => undefined, onTrim: () => undefined }));
    expect(section).not.toContain("<textarea");
  });

  it("a signed-in member gets the message box, 'Message the Arena...', a labelled Send button and the 280 limit", () => {
    const html = renderToStaticMarkup(createElement(ChatComposer, { you, onSend: send }));
    expect(html).toContain("<textarea");
    expect(html).toContain('placeholder="Message the Arena..."');
    expect(html).toContain('aria-label="Send message"');
    expect(html).toContain('data-testid="chat-send"');
    expect(html).toContain('enterKeyHint="send"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/); // nothing to send yet → the button is off
    expect(html).toContain("Enter to send");
    // 16 px on phones: no zoom-on-focus on iOS
    expect(html).toMatch(/class="[^"]*\btext-base\b[^"]*\bsm:text-sm\b/);
  });

  it("a muted member can read but sees a calm notice instead of the input (timed mutes say until when)", () => {
    const permanent = renderToStaticMarkup(createElement(ChatComposer, { you: { ...you, canSend: false, muted: { permanent: true } }, onSend: send }));
    expect(permanent).not.toContain("<textarea");
    expect(text(permanent)).toContain("You can read the chat, but you can't send messages right now.");
    const timed = renderToStaticMarkup(createElement(MutedNotice, { mute: { permanent: false, until: "2026-10-09T10:00:00.000Z" } }));
    expect(text(timed)).toContain("This lasts until");
    expect(timed).not.toContain("<textarea");
  });
});

describe("the calm states — never a spinner that does not end", () => {
  it("loading is a skeleton; a failed first load is a message with a retry button", () => {
    expect(body(snap({ phase: "loading" }))).toContain('data-testid="chat-skeleton"');
    const err = body(snap({ phase: "error" }));
    expect(text(err)).toContain("Couldn't load the chat");
    expect(err).toContain('data-testid="chat-retry"');
  });

  it("a closed room says why, plainly (switched off, or opening soon) and shows no input", () => {
    expect(text(body(snap({ phase: "closed", closedReason: "CLOSED" })))).toContain("switched off");
    expect(text(body(snap({ phase: "closed", closedReason: "NOT_READY" })))).toContain("opens soon");
    expect(body(snap({ phase: "closed", closedReason: "NOT_READY" }))).not.toContain("<textarea");
  });

  it("an empty room invites the first message (different words for a guest)", () => {
    const empty = emptyRoom;
    expect(text(body(snap({ room: empty, you: { senderKey: "k", canSend: true, muted: null } })))).toContain("Say hello to the Arena.");
    expect(text(body(snap({ room: empty, you: null })))).toContain("sign in with Telegram");
  });

  it("messages render in a log region (screen readers hear additions) with the room's name for it", () => {
    const html = body(snap());
    expect(html).toContain('role="log"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Markyyester");
  });
});

describe("the status chip tells the truth", () => {
  const chip = (live: Parameters<typeof LiveChip>[0]["live"], realtime = true) => renderToStaticMarkup(createElement(LiveChip, { live, realtime }));
  it("'Live' only when the room is actually joined; reconnecting and connecting are said as such; without live delivery it says it is updating", () => {
    expect(text(chip("live"))).toBe("Live");
    expect(text(chip("reconnecting"))).toBe("Reconnecting…");
    expect(text(chip("connecting"))).toBe("Connecting…");
    expect(text(chip("off", false))).toBe("Updating");
    expect(text(chip("off", true))).toBe("Updating");
    expect(chip("live")).toContain('data-tone="live"');
    expect(chip("reconnecting")).toContain('data-tone="warn"');
  });
});
