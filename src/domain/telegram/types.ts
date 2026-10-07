export type MediaKind = "none" | "photo" | "sticker" | "animation" | "voice" | "video" | "audio" | "document" | "other";
export type MessageSource = "LIVE" | "IMPORT";
export type UserStatus = "OK" | "FLAGGED" | "BANNED";

/** A Telegram message in the shape the pipeline ingests (from webhook or export). */
export interface IngestMessage {
  chatId: number;
  messageId: number;
  authorId: number;
  username?: string | null;
  displayName: string;
  sentAtMs: number;
  /** Text or caption; empty string when there is none. Never persisted. */
  text: string;
  isReply: boolean;
  replyToUserId?: number | null;
  isForwarded: boolean;
  mediaKind: MediaKind;
  source: MessageSource;
  /** Telegram Desktop exports mark edited messages (the text here is the FINAL edited text). */
  edited?: boolean;
  /** Reactions whose reactor identity is known (export `recent[]`). `day` is the export's local calendar day. */
  reactions?: ReactionRef[];
}

export interface ReactionRef {
  reactorId: number;
  atMs: number;
  day: string;
}

export interface MessageFeatures {
  sentAtMs: number;
  /** Keyed hash of the normalised text, for duplicate detection. Null when there is no text. */
  textHash: string | null;
  charCount: number;
  wordCount: number;
  uniqueWordRatio: number;
  lowValueRatio: number;
  hasLink: boolean;
  linkOnly: boolean;
  isReply: boolean;
  replyToSelf: boolean;
  isForwarded: boolean;
  mediaKind: MediaKind;
  hasQuestion: boolean;
  hasExclaim: boolean;
  isLong: boolean;
  hourUtc: number;
  repeatedCharRun: boolean;
}

export type RejectReason =
  | "USER_BANNED"
  | "USER_FLAGGED"
  | "FORWARDED"
  | "NO_TEXT"
  | "TOO_FAST"
  | "BURST"
  | "DUPLICATE"
  | "LINK_ONLY"
  | "GIBBERISH"
  | "TOO_SHORT"
  | "LOW_VALUE"
  | "DAILY_CAP";

/** Rejections that indicate spam-like behaviour (used for auto-flagging). */
export const SPAM_REASONS: ReadonlySet<RejectReason> = new Set<RejectReason>([
  "TOO_FAST",
  "BURST",
  "DUPLICATE",
  "GIBBERISH",
  "LOW_VALUE",
  "LINK_ONLY",
]);

export interface ScoreResult {
  qualifies: boolean;
  weight: number;
  reason: RejectReason | null;
}

export interface ScoringContext {
  userStatus: UserStatus;
  /** ms since this user's previous message (any kind); null if none. */
  sinceLastMs: number | null;
  /** Earlier messages by this user inside the burst window. */
  messagesInBurstWindow: number;
  /** Earlier messages by this user with the same text hash inside the duplicate window. */
  duplicatesInWindow: number;
  /** Qualifying messages this user already has on this UTC day. */
  qualifyingToday: number;
}

export interface UserCounters {
  totalMessages: number;
  qualifyingMessages: number;
  activeDays: number;
  repliesSent: number;
  repliesReceived: number;
  reactionsReceived: number;
  qualitySum: number;
}

export interface BehaviorCounters {
  msgs: number;
  replies: number;
  questions: number;
  exclaims: number;
  long: number;
  links: number;
  media: number;
  night: number;
  burst: number;
  spam: number;
}
