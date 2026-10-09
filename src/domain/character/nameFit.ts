import { graphemes } from "./displayName";

/**
 * FITTING A HERO'S NAME ON ITS LINE. The display face (Bungee) is wide, so a fixed Tailwind size either leaves a short name small or — worse — breaks an ordinary
 * 11-letter name as "MARKYYEST / ER". Instead the UI sizes the name from the width of its box and the name's own width in `em`, so that a name sits on ONE line at
 * the largest size that fits, a longer name wraps only BETWEEN words (balanced), and a single very long word shrinks to fit. This file is the pure part: how wide
 * a name is.
 *
 * Widths are Bungee's real advances (measured in Chrome at 100 px; the face is unicase, so a letter is as wide in either case), bucketed; anything the Latin
 * subset does not carry (CJK, emoji, other scripts) is drawn in a fallback face and gets a deliberately generous width. The total is padded a little, so the
 * estimate errs on the SMALL side of the type — a name never overflows because of a rounding.
 */
const BUCKETS: ReadonlyArray<readonly [number, string]> = [
  [0.23, " "],
  [0.35, "/\\|"],
  [0.37, "',.:;"],
  [0.42, "!-"],
  [0.44, "()[]{}"],
  [0.5, "`"],
  [0.6, "1"],
  [0.62, "IiFf"],
  [0.65, "7Cc23$5\"ESes"],
  [0.67, "?TZtzPp"],
  [0.7, "69JjLl"],
  [0.72, "48<>GY^gy*"],
  [0.74, "0+=ABV_abv~OQRXoqrx"],
  [0.76, "#DKNUdknuHh&"],
  [0.84, "WwMm"],
  [0.87, "@"],
  [1.03, "%"],
];
const ASCII = new Map<string, number>(BUCKETS.flatMap(([w, chars]) => [...chars].map((c) => [c, w] as const)));

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// Built from code points (never typed as raw or escaped characters in the source: invisible characters in a literal are a trap).
const cp = (n: number): string => String.fromCodePoint(n);
const span = (a: number, b: number): string => `${cp(a)}-${cp(b)}`;
const WIDE = new RegExp(`[${[span(0x1100, 0x11ff), span(0x2e80, 0x9fff), span(0xac00, 0xd7af), span(0xf900, 0xfaff), span(0xff00, 0xffef)].join("")}]`, "u");
const MARK_ONLY = new RegExp(`^[\\p{M}${span(0x200b, 0x200f)}${cp(0x2060)}${cp(0xfeff)}]+$`, "u");

/** The width of one user-perceived character (a grapheme) in em. */
export function glyphEm(grapheme: string): number {
  if (grapheme.length === 1 && grapheme.charCodeAt(0) < 128) return ASCII.get(grapheme) ?? 0.74;
  if (MARK_ONLY.test(grapheme)) return 0;
  if (EMOJI.test(grapheme)) return 1.3;
  if (WIDE.test(grapheme)) return 1.15;
  // a Latin letter with its accent (é, ñ, ü …) is one grapheme drawn from the face: about a capital's width
  return [...grapheme.normalize("NFD")].every((c) => ASCII.has(c) || /\p{M}/u.test(c)) ? 0.8 : 0.92;
}

const PAD = 1.02;

export interface NameFit {
  /** The whole name on one line, in em. */
  totalEm: number;
  /** The widest unbreakable run (a word, up to and including a hyphen), in em — what a wrapped name must still fit. */
  wordEm: number;
}

export function nameFit(name: string): NameFit {
  const parts = graphemes(name.normalize("NFC"));
  let total = 0;
  let word = 0;
  let widest = 0;
  for (const g of parts) {
    const w = glyphEm(g);
    total += w;
    if (/^\s$/.test(g)) {
      word = 0; // a space is a break opportunity
      continue;
    }
    word += w;
    widest = Math.max(widest, word);
    if (g === "-" || g === "‐" || g === "–" || g === "—") word = 0; // text may also wrap after a hyphen / dash
  }
  const round = (n: number) => Math.round(Math.max(n * PAD, 0.5) * 100) / 100;
  return { totalEm: round(total), wordEm: round(Math.max(widest, 0.5)) };
}
