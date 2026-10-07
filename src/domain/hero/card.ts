import type { AppearanceParts, Rarity } from "../character/appearance";
import type { SpriteConfig } from "../sprites/config";
import { graphemes } from "../character/displayName";
import { STAT_KEYS, STAT_LABELS, type StatBlock } from "../stats";
import { hashObject } from "../util/hash";
import { RARITY_LADDER } from "./rarity";
import { heroUrl } from "./publicId";

/**
 * THE canonical hero card: ONE public-safe data model and ONE set of presentation rules, used by every surface that draws a hero —
 * Admin preview, the public profile, the public directory, the downloadable PNG and the social (Open Graph) preview.
 *
 * It carries only what is public: the RPG name, class, rarity, POWER, the seven stats and the look. It never carries a Telegram id,
 * an internal database id, a seed, a wallet, a moderation note or an anti-abuse flag — the builders that produce it select only
 * those fields, and tests assert the serialised model contains nothing else.
 */
export interface HeroCardModel {
  /** Stable public id (never the Telegram id or the database id). */
  publicId: string;
  name: string;
  classId: string;
  className: string;
  rarity: Rarity;
  power: number;
  /** HP · STR · DEF · INT · AGI · CHA · LUCK — the hero's GENERATED stats: the exact block `power` (PWR) is computed from. */
  stats: StatBlock;
  /** Season ladder tier (status only), when known. */
  seasonRank: string | null;
  /** Everything needed to draw the hero's art (same shape the arena portraits use): the RESOLVED sprite layers plus the class's colours and kit. */
  look: HeroCardLook;
}

export interface HeroCardLook {
  rarity: Rarity;
  parts: AppearanceParts;
  sprite: SpriteConfig;
  colors: [string, string, string];
  weapon: string;
  headgear: string;
  body: string;
}

export const RARITY_LABEL: Record<Rarity, string> = Object.fromEntries(RARITY_LADDER.map((r) => [r.id, r.label])) as Record<Rarity, string>;

/** The brand purple the card is framed in (Clank RPG's scale: clank-300 / clank-500 / clank-700). */
export const CLANK_PURPLE = { light: "#CA94F9", mid: "#9663DA", dark: "#4D2D87", ink: "#0b0818" } as const;

export const CARD_STATS: ReadonlyArray<{ key: keyof StatBlock; label: string }> = STAT_KEYS.map((key) => ({ key, label: STAT_LABELS[key] }));

const CONTROL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁯﻿]/g;
const MARKUP = /[<>`]/g;

/**
 * Text drawn on a card or put in a share link: control / bidi / zero-width characters and markup stripped, whitespace collapsed, clipped to
 * `max` user-perceived characters. (The PNG renderer draws text with canvas calls, never as HTML, so there is nothing to inject into —
 * this keeps the output clean and bounded all the same.)
 */
export function cardText(raw: unknown, max: number): string {
  const cleaned = String(raw ?? "").replace(CONTROL, "").replace(MARKUP, "").replace(/\s+/g, " ").trim();
  const parts = graphemes(cleaned);
  return parts.length <= max ? cleaned : `${parts.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

export const CARD_NAME_MAX = 40;

/** A short content key for the image / OG URL: it changes exactly when something visible on the card changes (a reroll, a rollback to a different look, a rename, …). */
export function cardKey(m: HeroCardModel): string {
  return hashObject({ n: cardText(m.name, CARD_NAME_MAX), c: m.classId, r: m.rarity, p: m.power, s: m.stats, l: m.look, k: m.seasonRank }).slice(0, 12);
}

/** "Legendary Mage" */
export const rarityClassLine = (m: Pick<HeroCardModel, "rarity" | "className">): string => `${RARITY_LABEL[m.rarity]} ${cardText(m.className, 24)}`;

export const formatPower = (power: number): string => Math.max(0, Math.round(power)).toLocaleString("en-US");

/** The share copy. No internal ids, no Telegram handle — just what the card shows and the canonical link (added by the X intent URL). */
export function shareText(m: Pick<HeroCardModel, "name" | "rarity" | "className" | "power">): string {
  return `My Clank RPG hero\n\n${cardText(m.name, CARD_NAME_MAX)}\n${rarityClassLine(m)}\nPWR ${formatPower(m.power)}`;
}

/**
 * A web-intent link to X's composer. It needs no X API credentials — and it CANNOT attach the card image (an intent can only carry text and
 * a link), so the image is downloaded separately and attached by hand. `url` is the canonical hero URL; X appends it after the text.
 */
export function xIntentUrl(m: Pick<HeroCardModel, "name" | "rarity" | "className" | "power">, canonicalUrl: string): string {
  return `https://x.com/intent/post?text=${encodeURIComponent(shareText(m))}&url=${encodeURIComponent(canonicalUrl)}`;
}

export const canonicalHeroUrl = heroUrl;

/** Open Graph / Twitter metadata for a hero page: title, description and an image URL that carries the card's content key. */
export function heroSocialMeta(m: HeroCardModel, origin: string): { title: string; description: string; url: string; imageUrl: string } {
  const name = cardText(m.name, CARD_NAME_MAX);
  const key = cardKey(m);
  return {
    title: `${name}'s ${rarityClassLine(m)} | Clank RPG`,
    description: `${rarityClassLine(m)} · PWR ${formatPower(m.power)} · HP ${m.stats.hp} STR ${m.stats.str} DEF ${m.stats.def} INT ${m.stats.int} AGI ${m.stats.agi} CHA ${m.stats.cha} LUCK ${m.stats.luck}`,
    url: heroUrl(origin, m.publicId),
    imageUrl: `${origin.replace(/\/+$/, "")}/api/hero-cards/${m.publicId}?v=${key}`,
  };
}
