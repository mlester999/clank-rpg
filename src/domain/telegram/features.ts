import type { TelegramSettings } from "../settings";

import type { IngestMessage, MessageFeatures } from "./types";

const URL_RE = /(?:https?:\/\/|www\.|t\.me\/)\S+/gi;
const MENTION_RE = /@\w+/g;
const NON_WORD_RE = /[^\p{L}\p{N}\s]/gu;
const LONG_WORDS = 25;

/** Lower-case, strip links/mentions/punctuation/emoji, collapse whitespace. */
export function normalizeText(text: string): { normalized: string; hadLink: boolean } {
  const hadLink = URL_RE.test(text);
  URL_RE.lastIndex = 0;
  const stripped = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(URL_RE, " ")
    .replace(MENTION_RE, " ")
    .replace(NON_WORD_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { normalized: stripped, hadLink };
}

export function extractFeatures(
  message: Pick<IngestMessage, "text" | "sentAtMs" | "isReply" | "replyToUserId" | "authorId" | "isForwarded" | "mediaKind">,
  settings: Pick<TelegramSettings, "lowValueTokens">,
  hash: (normalizedText: string) => string,
): MessageFeatures {
  const { normalized, hadLink } = normalizeText(message.text);
  const words = normalized.length ? normalized.split(" ") : [];
  const wordCount = words.length;
  const unique = new Set(words);
  const lowValue = new Set(settings.lowValueTokens.map((t) => t.toLowerCase()));
  const lowValueWords = words.filter((w) => lowValue.has(w)).length;
  const charCount = normalized.replace(/\s/g, "").length;
  const raw = message.text;
  return {
    sentAtMs: message.sentAtMs,
    textHash: normalized ? hash(normalized) : null,
    charCount,
    wordCount,
    uniqueWordRatio: wordCount ? unique.size / wordCount : 1,
    lowValueRatio: wordCount ? lowValueWords / wordCount : 0,
    hasLink: hadLink,
    linkOnly: hadLink && wordCount < 2,
    isReply: message.isReply,
    replyToSelf: message.isReply && message.replyToUserId === message.authorId,
    isForwarded: message.isForwarded,
    mediaKind: message.mediaKind,
    hasQuestion: raw.includes("?"),
    hasExclaim: raw.includes("!"),
    isLong: wordCount >= LONG_WORDS,
    hourUtc: new Date(message.sentAtMs).getUTCHours(),
    repeatedCharRun: /(.)\1{5,}/u.test(normalized),
  };
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
