import { graphemes } from "../character/displayName";

import { CHAT_BODY_MAX, CHAT_MAX_LINES, CHAT_NAME_MAX } from "./limits";

/**
 * ARENA CHAT — what a message (and a name) is allowed to contain. Messages are PLAIN TEXT: they are rendered as text nodes and never as HTML, but the
 * server also cleans what it stores, so nothing odd ever reaches a reader:
 *
 *   · Unicode is normalised (NFC); line endings become `\n`; control characters, lone surrogates, private-use code points and soft hyphens are dropped;
 *   · characters that RE-ORDER or HIDE text are dropped (bidirectional overrides and isolates, zero-width space / word-joiner / BOM, invisible
 *     operators). The zero-width JOINER and NON-JOINER stay: emoji sequences and Persian / Indic scripts need them;
 *   · a stack of combining marks ("zalgo") is cut to three;
 *   · runs of spaces collapse, every line is trimmed, blank lines collapse to one, and the message may have at most four lines.
 *
 * Pure and dependency-free, so the browser's composer applies the very same rules for feedback while typing.
 */

export type ChatTextFailure = "INVALID" | "EMPTY" | "TOO_LONG" | "TOO_MANY_LINES";
export type ChatTextResult = { ok: true; body: string } | { ok: false; reason: ChatTextFailure };

// The character classes are built from code points (never written as escapes in this file): what each one means is listed in plain numbers.
const BS = String.fromCharCode(92);
const u = (code: number): string => `${BS}u{${code.toString(16)}}`;
const cls = (...parts: Array<number | [number, number]>): RegExp => new RegExp(`[${parts.map((p) => (typeof p === "number" ? u(p) : `${u(p[0])}-${u(p[1])}`)).join("")}]`, "gu");

/** C0 / C1 controls (the line feed 0x0A is handled before this runs). */
const CONTROLS = cls([0x00, 0x08], 0x0b, 0x0c, [0x0e, 0x1f], [0x7f, 0x9f]);
/** Soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width space, LRM / RLM, bidi embeddings & overrides (202A-202E), word joiner & invisible
 *  operators (2060-2064), bidi isolates & deprecated format characters (2066-206F), BOM, interlinear annotations & the object replacement character. */
const INVISIBLE = cls(0xad, 0x61c, 0x180e, 0x200b, 0x200e, 0x200f, [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x206f], 0xfeff, [0xfff9, 0xfffc]);
/** CR LF, CR, line separator, paragraph separator, next line. */
const LINE_BREAKS = new RegExp(`${BS}r${BS}n?|${u(0x2028)}|${u(0x2029)}|${u(0x85)}`, "gu");
/** Lone surrogates, private use, and the replacement character that malformed input decodes to. */
const JUNK = new RegExp(`[${BS}p{Cs}${BS}p{Co}${u(0xfffd)}]`, "gu");

/** Everything common to a body and a name: normalise, drop what must not be stored. Line breaks are kept as `\n`. */
function scrub(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(LINE_BREAKS, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROLS, "")
    .replace(INVISIBLE, "")
    .replace(JUNK, "")
    .replace(/(\p{M}{3})\p{M}+/gu, "$1");
}

/** The count of code points (what the database's `char_length` counts). */
export const codePoints = (s: string): number => Array.from(s).length;

/** A raw message from the browser → the text that will be stored, or the reason it cannot be. */
export function normalizeChatBody(raw: unknown): ChatTextResult {
  if (typeof raw !== "string") return { ok: false, reason: "INVALID" };
  // Cheap guard first: nothing below should ever run over a megabyte.
  if (raw.length > CHAT_BODY_MAX * 8) return { ok: false, reason: "TOO_LONG" };
  const lines = scrub(raw)
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim());
  // blank lines collapse to one; the ends are trimmed
  const kept: string[] = [];
  for (const line of lines) if (line !== "" || (kept.length > 0 && kept[kept.length - 1] !== "")) kept.push(line);
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  if (kept.length === 0) return { ok: false, reason: "EMPTY" };
  if (kept.length > CHAT_MAX_LINES) return { ok: false, reason: "TOO_MANY_LINES" };
  const body = kept.join("\n");
  if (codePoints(body) > CHAT_BODY_MAX) return { ok: false, reason: "TOO_LONG" };
  return { ok: true, body };
}

/** The same body, compared for "is this a repeat?": case and spacing do not make a message new. */
export const repeatKey = (body: string): string => body.toLowerCase().replace(/\s+/g, " ");

/** A display name (hero name or Telegram name) made safe to show: one line, no invisible or re-ordering characters, at most CHAT_NAME_MAX characters. */
export function cleanChatName(raw: string | null | undefined, max = CHAT_NAME_MAX): string {
  if (!raw) return "";
  const one = scrub(raw).replace(/\n+/g, " ").replace(/ {2,}/g, " ").trim();
  const parts = graphemes(one);
  return parts.length > max ? parts.slice(0, max).join("").trim() : one;
}

/** The sentence the composer shows for a refused message. */
export const CHAT_TEXT_MESSAGE: Record<ChatTextFailure, string> = {
  INVALID: "That message can't be sent.",
  EMPTY: "Write a message first.",
  TOO_LONG: `Messages can be up to ${CHAT_BODY_MAX} characters.`,
  TOO_MANY_LINES: `Messages can have up to ${CHAT_MAX_LINES} lines.`,
};
