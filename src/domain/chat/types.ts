/**
 * ARENA CHAT — the wire shapes. A message carries only what the room may show: never a Telegram id, username, e-mail, session or wallet.
 */
export interface ChatMessageDto {
  /** Monotone cursor: a larger id is a later message. */
  id: number;
  /** The server's UTC timestamp (ISO 8601). */
  at: string;
  /** The sender's public name (hero name when they have one, else their Telegram display name). */
  name: string;
  /** The sender's profile photo (same-origin, versioned), or null → the app draws an initial. */
  avatarUrl: string | null;
  /** An opaque, stable token for "the same sender" (own-message styling, grouping). Not reversible to any account. */
  senderKey: string;
  body: string;
  /** Moderation revision: bumped on every hide / restore. */
  rev: number;
}

/** What the browser needs to join the room live. Everything here is public by design (the publishable key and the verification key). */
export interface ChatRealtimeConfig {
  /** The Realtime endpoint, e.g. wss://<project>.supabase.co/realtime/v1 */
  url: string;
  /** The project's publishable (anon) key. */
  key: string;
  topic: string;
  event: string;
  /** Ed25519 public key (raw, base64url) that every broadcast must be signed with. */
  verifyKey: string;
}

export type ChatMute = { permanent: true } | { permanent: false; until: string };

export interface ChatYou {
  senderKey: string;
  canSend: boolean;
  muted: ChatMute | null;
}

/** GET /api/arena/chat/messages */
export interface ChatPageDto {
  /** false → the room is closed (switched off, or its schema is not installed yet): the UI shows a calm "not open" panel. */
  enabled: boolean;
  reason?: "CLOSED" | "NOT_READY";
  /** Ascending (oldest first). */
  messages: ChatMessageDto[];
  /** Older messages exist beyond the first of this page. */
  hasMore: boolean;
  /** Present on the first page only. */
  you?: ChatYou | null;
  realtime?: ChatRealtimeConfig | null;
  serverTime: string;
}

export type ChatEvent = { t: "msg"; m: ChatMessageDto } | { t: "hide"; id: number; rev: number };

/** What actually crosses the Realtime channel: the event as JSON text, and the server's Ed25519 signature over exactly that text. */
export interface ChatEnvelope {
  v: 1;
  j: string;
  s: string;
}
