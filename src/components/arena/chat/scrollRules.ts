/**
 * THE CHAT HISTORY'S SCROLL RULES, as numbers (no DOM, so they are tested without a browser; ChatMessageList applies them):
 *
 *   · near the bottom the viewer is FOLLOWING the room: new messages scroll into view;
 *   · scrolled up they are READING: nothing moves, a small "New messages" indicator counts what arrived;
 *   · older history added at the top must not move what is on screen: the scroll position is corrected by exactly the height that was added;
 *   · a long way back to the newest (more than a few screens) jumps instead of gliding.
 */

/** Within this many pixels of the bottom the viewer is "following" the room. */
export const FOLLOW_PX = 56;
/** Scrolled this close to the top, the next page of history is requested. */
export const TOP_PX = 96;
/** A smooth scroll over more than this many viewport heights is a jump instead (nobody wants to watch thousands of pixels glide by). */
export const GLIDE_SCREENS = 3;

/** The box's own geometry: scrollHeight, scrollTop and clientHeight. */
export interface Box {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** How far the bottom of the content is below the bottom of the visible part. */
export const fromBottom = (b: Box): number => b.scrollHeight - b.scrollTop - b.clientHeight;

/** Is the viewer following the room (at, or within FOLLOW_PX of, the newest message)? */
export const isFollowing = (b: Box, slack = FOLLOW_PX): boolean => fromBottom(b) <= slack;

/** Has the viewer scrolled close enough to the top that older history should load? */
export const nearTop = (scrollTop: number): boolean => scrollTop <= TOP_PX;

/** Should a scroll to the newest glide (true) or jump (false)? */
export const shouldGlide = (b: Box): boolean => fromBottom(b) <= b.clientHeight * GLIDE_SCREENS;

/** What was on screen when older history was requested. */
export interface Anchor {
  height: number;
  top: number;
}

/** The scrollTop that keeps the reader exactly where they were once older rows have grown the content: the old position plus the height that was added. */
export const restoredTop = (anchor: Anchor, newScrollHeight: number): number => anchor.top + (newScrollHeight - anchor.height);

/** What a change in the list's messages means for the scroll position. */
export type ListChange = "keep" | "restore" | "to-bottom";

/**
 * Decides what to do after the messages changed. `first` / `last` are the oldest and newest ids now; `was` the ids before. `anchored`: older history was
 * requested (an anchor was taken). `following`: the viewer was at the bottom.
 */
export function onMessagesChanged(input: { first: number | null; last: number | null; was: { first: number | null; last: number | null }; anchored: boolean; following: boolean }): ListChange {
  const { first, last, was, anchored, following } = input;
  if (anchored && was.first !== null && first !== null && first < was.first) return "restore"; // older history arrived above
  if (last !== null && was.last !== last) return was.last === null || following ? "to-bottom" : "keep"; // the first load, or a newer message
  if (first !== null && was.first !== null && first > was.first && following) return "to-bottom"; // the oldest were trimmed away while following
  return "keep";
}

/** How many messages are newer than the last one the viewer was shown at the bottom (0 until they have been shown any). */
export function unseenCount(ids: readonly number[], seenUpTo: number | null): number {
  if (seenUpTo === null) return 0;
  let n = 0;
  for (const id of ids) if (id > seenUpTo) n++;
  return n;
}

/** The indicator's label: "↓ New messages", or with a count ("99+" past 99) when there is more than one. */
export const newMessagesLabel = (unseen: number): string => `↓ New messages${unseen > 1 ? ` (${unseen > 99 ? "99+" : unseen})` : ""}`;
