/**
 * The PUBLIC hero id: what public URLs (/heroes/<id>) and share links use.
 *
 * Random, permanent and collision-safe (a unique column, minted by the database): it is never derived from the display name, the Telegram
 * username / numeric id or a sequence, so renaming a hero, rerolling it or a duplicate display name can never change or collide with it, and
 * it reveals nothing about the account behind it. 12 symbols from a 31-symbol alphabet without 0 / 1 / i / l / o.
 */
export const PUBLIC_HERO_ID_PATTERN = /^[2-9a-hj-km-np-z]{12}$/;

export const isPublicHeroId = (value: unknown): value is string => typeof value === "string" && PUBLIC_HERO_ID_PATTERN.test(value);

/** Site-relative path of a hero's public profile. */
export const heroPath = (publicId: string): string => `/heroes/${publicId}`;

/** Absolute canonical URL of a hero's public profile (`origin` = the site's public origin, e.g. NEXT_PUBLIC_APP_URL). */
export function heroUrl(origin: string, publicId: string): string {
  return `${origin.replace(/\/+$/, "")}${heroPath(publicId)}`;
}

/** Site-relative URL of the downloadable card image. `key` is the card's content key (it changes when anything shown on the card changes). */
export const heroCardImagePath = (publicId: string, key?: string): string => `/api/hero-cards/${publicId}${key ? `?v=${encodeURIComponent(key)}` : ""}`;
