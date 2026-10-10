import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArenaChat, CHAT_PANEL_HEIGHT, ChatBody } from "@/components/arena/chat/ArenaChat";
import type { ChatSnapshot } from "@/components/arena/chat/chatController";
import { ChatComposer, GuestPrompt } from "@/components/arena/chat/ChatComposer";
import { ChatMessageRow } from "@/components/arena/chat/ChatMessageRow";
import { keyboardUp, KEYBOARD_MIN_PX, NAV_CLEAR_PX, revealDelta } from "@/components/arena/chat/keyboard";
import { emptyRoom, mergeIncoming } from "@/domain/chat/room";
import type { ChatMessageDto } from "@/domain/chat/types";

/**
 * THE COMPACT ARENA CHAT — one fixed panel height per screen size (the history scrolls INSIDE it), a one-row guest prompt, a message box that keeps
 * clear of the keyboard and the bottom navigation. (Measured in a real browser — 300 / 280 / 240 px, scrolling, long names — in docs/ARENA_RESPONSIVE.md.)
 */
const rem = (r: number) => r * 16;
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
const msg = (id: number, over: Partial<ChatMessageDto> = {}): ChatMessageDto => ({ id, at: "2026-10-08T12:00:00.000Z", name: "Markyyester", avatarUrl: null, senderKey: "abcdefghijklmnop", body: "That Ranger is crazy!", rev: 0, ...over });
const snap = (over: Partial<ChatSnapshot> = {}): ChatSnapshot => ({ phase: "ready", closedReason: null, room: mergeIncoming(emptyRoom, [msg(1)]), you: null, live: "live", realtime: true, loadingOlder: false, olderFailed: false, ownTick: 0, ...over });
const body = (s: ChatSnapshot) => renderToStaticMarkup(createElement(ChatBody, { snap: s, onRetry: () => undefined, onLoadOlder: () => undefined, onTrim: () => undefined }));

describe("the panel's total height", () => {
  const [mobile, tablet, desktop] = [/(?:^|\s)h-\[([\d.]+)rem\]/, /sm:h-\[([\d.]+)rem\]/, /lg:h-\[([\d.]+)rem\]/].map((re) => rem(Number(re.exec(CHAT_PANEL_HEIGHT)![1]))) as [number, number, number];

  it("is about 240 px on a phone, 280 px on a tablet and 300 px on a desktop — inside the compact targets (220–260 · 260–300 · 280–320)", () => {
    expect(mobile).toBeGreaterThanOrEqual(220);
    expect(mobile).toBeLessThanOrEqual(260);
    expect(tablet).toBeGreaterThanOrEqual(260);
    expect(tablet).toBeLessThanOrEqual(300);
    expect(desktop).toBeGreaterThanOrEqual(280);
    expect(desktop).toBeLessThanOrEqual(320);
  });

  it("the whole panel has that height (header + history + message box together), not just the history", () => {
    const html = renderToStaticMarkup(createElement(ArenaChat));
    const section = /<section[^>]*class="([^"]*)"/.exec(html)![1]!;
    expect(section).toContain(CHAT_PANEL_HEIGHT);
    expect(section).toContain("flex-col");
    expect(html).toContain('data-testid="arena-chat"');
  });

  it("the history takes whatever the header and the box leave (min-h-0 flex-1) and scrolls by itself — the page never grows with the room", () => {
    const html = renderToStaticMarkup(createElement(ArenaChat));
    expect(html).toMatch(/<div class="flex min-h-0 flex-1 flex-col">/);
    const list = body(snap({ room: mergeIncoming(emptyRoom, Array.from({ length: 300 }, (_, i) => msg(i + 1))) }));
    expect(list).toMatch(/class="relative min-h-0 flex-1"/);
    expect(list).toMatch(/class="h-full overflow-x-hidden overflow-y-auto overscroll-contain/);
    expect(list).toContain('data-testid="chat-scroll"');
    expect(list).not.toMatch(/\bh-\[\d/); // no height anywhere in the list: it is the panel's
  });

  it("the loading skeleton, a closed room and a failed load all sit in the same fixed panel (no jump, no shrink)", () => {
    for (const s of [snap({ phase: "loading" }), snap({ phase: "closed", closedReason: "CLOSED" }), snap({ phase: "error" })]) {
      const b = body(s);
      expect(b).not.toMatch(/min-h-48|h-\[(?:18|26|30)/); // the old tall heights are gone
    }
    expect(body(snap({ phase: "error" }))).toContain("overflow-y-auto"); // the calm notice can scroll in a short panel instead of being cut off
  });
});

describe("a compact message row", () => {
  const row = (m: ChatMessageDto) => renderToStaticMarkup(createElement(ChatMessageRow, { message: m, label: "1m ago", exact: "Oct 8, 2026", mine: false }));

  it("keeps the avatar, the name on the LEFT, the age on the FAR RIGHT and the text under them — in less space", () => {
    const html = row(msg(1));
    expect(html).toMatch(/h-7 w-7/); // a 28 px avatar on a phone
    expect(html).toMatch(/class="[^"]*\bjustify-between\b[^"]*"[^>]*data-testid="chat-header"/);
    expect(html).toContain("py-1.5"); // tight rows
    expect(html).not.toContain("py-2.5");
    expect(text(html)).toBe("M Markyyester 1m ago That Ranger is crazy!");
  });

  it("a long name shortens with an ellipsis and never into the age; a long word wraps inside the row", () => {
    const html = row(msg(1, { name: "Sir Bartholomew Maximilian Featherstone", body: "W".repeat(280) }));
    expect(html).toMatch(/class="[^"]*\bmin-w-0\b[^"]*\btruncate\b[^"]*"[^>]*data-testid="chat-author"/);
    expect(html).toMatch(/<time[^>]*class="[^"]*\bshrink-0\b/);
    expect(html).toContain("[overflow-wrap:anywhere]");
  });
});

describe("the message box on a phone", () => {
  const you = { senderKey: "mine-mine-mine-12", canSend: true, muted: null };
  const send = async () => ({ ok: true as const, message: msg(9), duplicate: false });
  const html = renderToStaticMarkup(createElement(ChatComposer, { you, onSend: send }));

  it("is typed in at 16 px (no iOS zoom on focus), at least 44 px tall, with a visible Send button that never shrinks", () => {
    expect(html).toMatch(/text-base/);
    expect(html).toMatch(/min-h-11/);
    expect(html).toMatch(/data-testid="chat-send"/);
    expect(html).toMatch(/class="btn min-h-11 shrink-0/);
    expect(html).toMatch(/aria-label="Send message"/);
  });

  it("grows to at most 88 px and wraps long messages (no horizontal scroll)", () => {
    expect(html).toMatch(/max-h-\[88px\]/);
    expect(html).toContain("min-w-0 flex-1");
  });

  it("scrolls into view with room for the bottom navigation, and the keyboard hint line costs nothing on a phone", () => {
    expect(html).toMatch(/<form[^>]*class="scroll-mb-20 /);
    expect(html).toMatch(/id="arena-chat-hint"/);
    expect(html).toMatch(/class="hidden sm:mt-1 sm:flex/); // hidden on a phone until it has something to say (an error, the count near the limit)
  });

  it("the guest prompt is ONE compact row — the sentence beside the button — and stays readable", () => {
    const g = renderToStaticMarkup(createElement(GuestPrompt));
    expect(g).toMatch(/class="flex items-center justify-between gap-3 px-3 py-2/);
    expect(text(g)).toContain("Sign in with Telegram to chat.");
    expect(g).toContain('aria-label="Sign in with Telegram"'); // the button says "Sign in" on a phone; its accessible name is always the full one
    expect(g).toContain('href="/character"');
    expect(g).toMatch(/hidden sm:inline/);
    for (const forbidden of ["<textarea", "chat-send", "chat-input"]) expect(g).not.toContain(forbidden);
  });
});

describe("the on-screen keyboard", () => {
  it("is 'up' only when the visible viewport is clearly shorter than the window (an address-bar collapse is not a keyboard)", () => {
    expect(keyboardUp(844, 844)).toBe(false);
    expect(keyboardUp(844, 790)).toBe(false); // the toolbar collapsing
    expect(keyboardUp(844, 844 - KEYBOARD_MIN_PX)).toBe(false);
    expect(keyboardUp(844, 844 - KEYBOARD_MIN_PX - 1)).toBe(true);
    expect(keyboardUp(844, 480)).toBe(true);
    expect(keyboardUp(844, null)).toBe(false); // no visualViewport API: no guess
  });

  it("scrolls the box up out from under the keyboard, and clear of the bottom navigation when there is no keyboard", () => {
    // keyboard up: the visible area is 0..470; the form's bottom edge at 600 must come up by 600 - (470 - 8)
    expect(revealDelta({ formBottom: 600, visualTop: 0, visualHeight: 470, keyboard: true })).toBe(138);
    // already clear: nothing to do
    expect(revealDelta({ formBottom: 400, visualTop: 0, visualHeight: 470, keyboard: true })).toBe(0);
    // no keyboard: the box must stay NAV_CLEAR_PX above the bottom of the screen
    expect(revealDelta({ formBottom: 844, visualTop: 0, visualHeight: 844, keyboard: false })).toBe(NAV_CLEAR_PX);
    expect(revealDelta({ formBottom: 844 - NAV_CLEAR_PX, visualTop: 0, visualHeight: 844, keyboard: false })).toBe(0);
    // the visual viewport can be panned (iOS): its top edge counts
    expect(revealDelta({ formBottom: 900, visualTop: 200, visualHeight: 470, keyboard: true })).toBe(900 - (200 + 470 - 8));
  });

  it("the navigation clearance covers the real bottom bar (h-16 = 64 px) plus air", () => {
    expect(NAV_CLEAR_PX).toBeGreaterThanOrEqual(64);
  });
});
