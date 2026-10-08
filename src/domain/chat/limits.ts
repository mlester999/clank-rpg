/**
 * ARENA CHAT — the numbers every layer agrees on. The server enforces them (the browser only mirrors them for friendly feedback), so a client that
 * ignores them gains nothing.
 */

/** The ONE Realtime topic of the ONE room, and the broadcast event name its signed envelopes travel under. */
export const CHAT_TOPIC = "arena-chat";
export const CHAT_EVENT = "chat";

/** Characters (Unicode code points) a message may hold, and how many lines. */
export const CHAT_BODY_MAX = 280;
export const CHAT_MAX_LINES = 4;
/** A display name is shortened to this many user-perceived characters (hero names are capped at 40 already). */
export const CHAT_NAME_MAX = 40;

/** Spam protection, per member: at least this long between two messages, and no more than this many in any rolling minute. */
export const CHAT_MIN_GAP_MS = 3_000;
export const CHAT_PER_WINDOW = 10;
export const CHAT_WINDOW_MS = 60_000;

/** History paging: the first page, and the most one request may ask for. */
export const CHAT_PAGE = 50;
export const CHAT_PAGE_MAX = 100;

/** A send request is a tiny JSON object; anything bigger than this is refused before it is parsed. */
export const CHAT_REQUEST_MAX_BYTES = 2_048;

/** How the browser keeps the room: messages held in memory, and how far a live room is trimmed back to when it grows past the first number. */
export const CHAT_KEEP_MAX = 600;
export const CHAT_KEEP_TRIMMED = 400;
