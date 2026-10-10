import { describe, expect, it } from "vitest";

import { FOLLOW_PX, GLIDE_SCREENS, TOP_PX, fromBottom, isFollowing, nearTop, newMessagesLabel, onMessagesChanged, restoredTop, shouldGlide, unseenCount } from "@/components/arena/chat/scrollRules";

/** The chat history's scroll rules — the numbers behind "follow at the bottom, stay put when reading, keep your place when older messages load". */
const box = (scrollHeight: number, scrollTop: number, clientHeight = 156) => ({ scrollHeight, scrollTop, clientHeight });

describe("following the room", () => {
  it("at the very bottom, or within 56 px of it, the viewer is following; further up they are reading", () => {
    expect(isFollowing(box(1000, 844))).toBe(true); // exactly at the bottom
    expect(isFollowing(box(1000, 844 - FOLLOW_PX))).toBe(true);
    expect(isFollowing(box(1000, 844 - FOLLOW_PX - 1))).toBe(false);
    expect(fromBottom(box(1000, 600))).toBe(244);
  });

  it("a short history (everything fits) is always 'following'", () => {
    expect(isFollowing(box(120, 0))).toBe(true);
  });
});

describe("what a change in the messages does to the scroll position", () => {
  const was = { first: 10, last: 60 };
  it("a newer message while following → go to the bottom; while reading → keep (and the indicator counts it)", () => {
    expect(onMessagesChanged({ first: 10, last: 61, was, anchored: false, following: true })).toBe("to-bottom");
    expect(onMessagesChanged({ first: 10, last: 61, was, anchored: false, following: false })).toBe("keep");
  });

  it("the first messages ever shown always start at the bottom", () => {
    expect(onMessagesChanged({ first: 1, last: 50, was: { first: null, last: null }, anchored: false, following: false })).toBe("to-bottom");
  });

  it("older history arriving above (after it was asked for) → restore the reader's place, whether or not they were at the bottom", () => {
    expect(onMessagesChanged({ first: 1, last: 60, was, anchored: true, following: false })).toBe("restore");
    expect(onMessagesChanged({ first: 1, last: 60, was, anchored: true, following: true })).toBe("restore");
  });

  it("older ids appearing WITHOUT a request (nothing anchored) never move the view", () => {
    expect(onMessagesChanged({ first: 1, last: 60, was, anchored: false, following: false })).toBe("keep");
  });

  it("the oldest rows trimmed away while following keep the view at the bottom; trimmed while reading, nothing moves", () => {
    expect(onMessagesChanged({ first: 200, last: 60, was: { first: 10, last: 60 }, anchored: false, following: true })).toBe("to-bottom");
    expect(onMessagesChanged({ first: 200, last: 60, was: { first: 10, last: 60 }, anchored: false, following: false })).toBe("keep");
  });

  it("nothing changed → keep", () => {
    expect(onMessagesChanged({ first: 10, last: 60, was, anchored: false, following: true })).toBe("keep");
  });
});

describe("older history keeps the reader's place", () => {
  it("the new scrollTop is the old one plus exactly the height that was added", () => {
    // the reader was 0 px from the top with 1000 px of content; 1500 px of older messages were added above
    expect(restoredTop({ height: 1000, top: 0 }, 2500)).toBe(1500);
    // …a reader 40 px down keeps looking at the same row
    expect(restoredTop({ height: 1000, top: 40 }, 2500)).toBe(1540);
    // nothing added → nothing moves
    expect(restoredTop({ height: 1000, top: 40 }, 1000)).toBe(40);
  });

  it("the next page is requested only near the top", () => {
    expect(nearTop(0)).toBe(true);
    expect(nearTop(TOP_PX)).toBe(true);
    expect(nearTop(TOP_PX + 1)).toBe(false);
  });
});

describe("the 'New messages' indicator", () => {
  it("counts what is newer than the last message the viewer was shown at the bottom — and nothing before they were shown any", () => {
    expect(unseenCount([1, 2, 3, 4, 5], null)).toBe(0);
    expect(unseenCount([1, 2, 3, 4, 5], 5)).toBe(0);
    expect(unseenCount([1, 2, 3, 4, 5], 3)).toBe(2);
    expect(unseenCount([], 3)).toBe(0);
  });

  it("is labelled with the count from two on, and caps at 99+", () => {
    expect(newMessagesLabel(1)).toBe("↓ New messages");
    expect(newMessagesLabel(2)).toBe("↓ New messages (2)");
    expect(newMessagesLabel(99)).toBe("↓ New messages (99)");
    expect(newMessagesLabel(100)).toBe("↓ New messages (99+)");
  });

  it("tapping it glides when the newest is near and jumps when it is more than three screens away", () => {
    expect(shouldGlide(box(1000, 700))).toBe(true);
    expect(shouldGlide(box(10_000, 0))).toBe(false);
    expect(GLIDE_SCREENS).toBe(3);
  });
});
