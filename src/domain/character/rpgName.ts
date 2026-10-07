/**
 * The RPG display name: the name shown INSIDE Clank RPG. It is presentation only —
 * ownership, claims, wallets and history are always keyed by the immutable Telegram id /
 * character id, never by this string.
 *
 *   Telegram user id      → immutable identity
 *   Telegram display name → external information (telegram_users.display_name)
 *   RPG display name      → characters.name_override ?? characters.name (generated)
 */

/** Practical cap, in Unicode code points (the database allows up to 40). */
export const RPG_NAME_MAX = 32;

export type RpgNameProblem = "EMPTY" | "TOO_LONG" | "CONTROL_CHARACTERS" | "MARKUP" | "NO_VISIBLE_CHARACTERS";

export type RpgNameResult = { ok: true; name: string } | { ok: false; problem: RpgNameProblem; message: string };

// Control characters (incl. tab/newline), bidi overrides/isolates, zero-width space, word joiners and BOM.
// Zero-width JOINER / NON-JOINER are deliberately allowed: emoji sequences and several scripts need them.
const FORBIDDEN = /[\p{Cc}​‎‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const MARKUP = /[<>`]/;
// A name needs something a person can actually see: a letter, a digit or an emoji.
const VISIBLE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

const MESSAGES: Record<RpgNameProblem, string> = {
  EMPTY: "A name can't be empty.",
  TOO_LONG: `Names can be at most ${RPG_NAME_MAX} characters.`,
  CONTROL_CHARACTERS: "Names can't contain control or invisible formatting characters.",
  MARKUP: "Names can't contain < > or backticks.",
  NO_VISIBLE_CHARACTERS: "A name needs at least one letter, number or emoji.",
};

const bad = (problem: RpgNameProblem): RpgNameResult => ({ ok: false, problem, message: MESSAGES[problem] });

/** Normalises (NFC, collapsed spaces, trimmed) and validates. Normal Unicode and emoji are fine. */
export function validateRpgName(raw: unknown): RpgNameResult {
  if (typeof raw !== "string") return bad("EMPTY");
  if (FORBIDDEN.test(raw)) return bad("CONTROL_CHARACTERS");
  const name = raw.normalize("NFC").replace(/ +/g, " ").trim();
  if (!name) return bad("EMPTY");
  if (MARKUP.test(name)) return bad("MARKUP");
  if (Array.from(name).length > RPG_NAME_MAX) return bad("TOO_LONG");
  if (!VISIBLE.test(name)) return bad("NO_VISIBLE_CHARACTERS");
  return { ok: true, name };
}

/** True for the neutral fallback given to members whose Telegram name has nothing printable ("Wanderer 1234"). */
export const isFallbackName = (name: string): boolean => /^Wanderer \d{4}$/.test(name);
