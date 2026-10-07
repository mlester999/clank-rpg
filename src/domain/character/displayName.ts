/**
 * Presentation-only shortening of a hero's RPG name.
 *
 * Imported Telegram names can be very long or read like a status line ("Celsius - Busy With …").
 * The STORED name is never changed to make a label fit — this only decides what a cramped surface
 * (an arena name tag, a kill-feed pill) draws. Wide surfaces simply use CSS `truncate` and put the
 * full name in a `title`.
 */

/** Longest name drawn on an arena name tag / kill-feed line before it is shortened. */
export const ARENA_LABEL_MAX = 16;

const segmenter: Intl.Segmenter | null = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** User-perceived characters: an emoji (with skin tone / ZWJ sequence) or a letter + combining marks counts as one. */
export function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

export function graphemeLength(text: string): number {
  return graphemes(text).length;
}

const TRAILING_SEPARATORS = /[\s\-–—_.,:;|/\\·•~]+$/u;

/**
 * Shortens to at most `max` user-perceived characters, ending in "…". Prefers to cut at a word boundary
 * ("Celsius - Busy With…") and never leaves a dangling separator or a half emoji. Names that already fit are
 * returned untouched.
 */
export function truncateDisplayName(name: string, max: number): string {
  const limit = Math.max(2, Math.floor(max));
  const parts = graphemes(name);
  if (parts.length <= limit) return name;
  const kept = parts.slice(0, limit - 1);
  const cutMidWord = parts[limit - 1] !== " ";
  if (cutMidWord) {
    const lastSpace = kept.lastIndexOf(" ");
    // Only back off to a word boundary when that keeps a reasonable amount of the name.
    if (lastSpace >= Math.floor(limit * 0.4)) kept.length = lastSpace;
  }
  const head = kept.join("").replace(TRAILING_SEPARATORS, "");
  return `${head || kept.join("").trim()}…`;
}
