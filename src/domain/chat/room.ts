import { CHAT_KEEP_MAX, CHAT_KEEP_TRIMMED } from "./limits";
import type { ChatMessageDto } from "./types";

/**
 * ARENA CHAT — the browser's copy of the room, as pure functions. Everything that can reach it — the first page, older pages, a live broadcast, a
 * catch-up after a reconnect — goes through here, which is what makes the room correct no matter how often or in what order things arrive:
 *
 *   · ONE message per id (a broadcast and the sender's own HTTP answer, a re-delivered event, an overlapping catch-up: all the same message);
 *   · ascending id order, always (ids are issued in commit order, so id order IS chronological order);
 *   · a hidden message stays hidden: a moderator's hide leaves a tombstone carrying the moderation revision, so a late or replayed copy of the
 *     message (older revision) cannot bring it back, while a RESTORE (a newer revision) can;
 *   · a catch-up never wipes history: it merges, and drops only what the server no longer shows inside the window it covers.
 */
export interface RoomState {
  messages: ChatMessageDto[];
  /** id → the revision of the hide that removed it. Bounded. */
  hidden: Record<number, number>;
  /** Older messages exist on the server beyond the first one held. */
  hasMore: boolean;
}

export const emptyRoom: RoomState = { messages: [], hidden: {}, hasMore: false };

const TOMBSTONES_MAX = 400;

export const newestId = (s: RoomState): number | null => s.messages[s.messages.length - 1]?.id ?? null;
export const oldestId = (s: RoomState): number | null => s.messages[0]?.id ?? null;

const ascending = (a: ChatMessageDto, b: ChatMessageDto): number => a.id - b.id;

function boundTombstones(hidden: Record<number, number>): Record<number, number> {
  const ids = Object.keys(hidden).map(Number);
  if (ids.length <= TOMBSTONES_MAX) return hidden;
  const keep = ids.sort((a, b) => b - a).slice(0, TOMBSTONES_MAX);
  return Object.fromEntries(keep.map((id) => [id, hidden[id] as number]));
}

/** Adds messages (any order, duplicates welcome). Returns the SAME state object when nothing changed, so React does not re-render for a duplicate. */
export function mergeIncoming(state: RoomState, incoming: readonly ChatMessageDto[]): RoomState {
  if (incoming.length === 0) return state;
  const byId = new Map(state.messages.map((m) => [m.id, m]));
  let hidden = state.hidden;
  let changed = false;
  for (const m of incoming) {
    const tomb = hidden[m.id];
    if (tomb !== undefined) {
      if (m.rev <= tomb) continue; // a stale copy of a message a moderator hid
      hidden = { ...hidden };
      delete hidden[m.id]; // restored
    }
    const have = byId.get(m.id);
    if (have && have.rev >= m.rev) continue;
    byId.set(m.id, m);
    changed = true;
  }
  if (!changed && hidden === state.hidden) return state;
  return { ...state, messages: [...byId.values()].sort(ascending), hidden };
}

/** A moderator hid a message: it leaves the room (and stays gone unless a newer revision restores it). */
export function applyHide(state: RoomState, id: number, rev: number): RoomState {
  const known = state.hidden[id];
  if (known !== undefined && known >= rev) return state;
  const have = state.messages.find((m) => m.id === id);
  if (have && have.rev > rev) return state; // we already hold a newer revision (a restore): this hide is the stale one
  return {
    ...state,
    messages: have ? state.messages.filter((m) => m.id !== id) : state.messages,
    hidden: boundTombstones({ ...state.hidden, [id]: rev }),
  };
}

/** Older history arrived (scrolling up). */
export function prependOlder(state: RoomState, page: { messages: readonly ChatMessageDto[]; hasMore: boolean }): RoomState {
  const merged = mergeIncoming(state, page.messages);
  return merged.hasMore === page.hasMore ? merged : { ...merged, hasMore: page.hasMore };
}

/**
 * The newest page of the room, fetched again after a (re)connect or a long absence. It is the SERVER'S word about the window it covers:
 *   · nothing held yet, or more than a page was missed (a gap) → the page replaces what is held (older history loads again on scroll);
 *   · otherwise the held messages older than the page stay, the page's own range is taken from the server (so a message hidden meanwhile
 *     disappears), and anything newer than the page (a broadcast that arrived meanwhile) is kept.
 */
export function reconcileLatest(state: RoomState, page: { messages: readonly ChatMessageDto[]; hasMore: boolean }): RoomState {
  const fresh = page.messages;
  if (fresh.length === 0) {
    // an empty room (or everything hidden): there is nothing to merge into — unless this page is simply stale, which an empty answer cannot tell
    return state.messages.length === 0 ? state : { ...state, messages: [], hasMore: false };
  }
  const first = (fresh[0] as ChatMessageDto).id;
  const last = (fresh[fresh.length - 1] as ChatMessageDto).id;
  const held = newestId(state);
  if (held === null || held < first) return mergeIncoming({ ...state, messages: [], hasMore: page.hasMore }, fresh);
  const older = state.messages.filter((m) => m.id < first);
  const newer = state.messages.filter((m) => m.id > last);
  const base: RoomState = { ...state, messages: [...older, ...newer], hasMore: older.length > 0 ? state.hasMore : page.hasMore };
  return mergeIncoming(base, fresh);
}

/** A live room that has grown past the budget forgets its oldest messages (the viewer can scroll up to load them again). */
export function trimLive(state: RoomState): RoomState {
  if (state.messages.length <= CHAT_KEEP_MAX) return state;
  return { ...state, messages: state.messages.slice(state.messages.length - CHAT_KEEP_TRIMMED), hasMore: true };
}
