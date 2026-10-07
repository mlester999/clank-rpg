/** Control chars, bidi overrides/isolates, zero-width and BOM characters. */
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;
const MARKUP_RE = /[<>`]/g;

/**
 * Telegram display names are arbitrary user input and become public hero names. Strip
 * invisible/bidi characters and markup, collapse whitespace, cap by code points, and fall back
 * to a neutral name when nothing printable remains.
 */
export function sanitizeDisplayName(raw: string, maxLength: number, fallbackId: number): string {
  const cleaned = raw.replace(INVISIBLE_RE, "").replace(MARKUP_RE, "").replace(/\s+/g, " ").trim();
  const codePoints = Array.from(cleaned);
  const clipped = codePoints.slice(0, maxLength).join("").trim();
  const hasLetterOrNumber = /[\p{L}\p{N}]/u.test(clipped);
  if (!clipped || !hasLetterOrNumber) return `Wanderer ${String(Math.abs(fallbackId)).slice(-4).padStart(4, "0")}`;
  return clipped;
}
