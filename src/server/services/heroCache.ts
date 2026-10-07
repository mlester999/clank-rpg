/**
 * In-process memory of rendered hero card images. Keys carry the card's CONTENT key, so a reroll, a rollback or a rename produces a new
 * key and an old entry can never be served for the new look — dropping a hero's entries on change is memory hygiene, not correctness.
 */
const MAX_ENTRIES = 64;
const cache = new Map<string, Buffer>();

export const heroCardCacheKey = (publicId: string, key: string): string => `${publicId}:${key}`;

export function getCachedHeroCard(publicId: string, key: string): Buffer | undefined {
  const k = heroCardCacheKey(publicId, key);
  const hit = cache.get(k);
  if (hit) {
    cache.delete(k);
    cache.set(k, hit);
  }
  return hit;
}

export function putCachedHeroCard(publicId: string, key: string, png: Buffer): void {
  cache.set(heroCardCacheKey(publicId, key), png);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
}

/** Forget every rendered image of one hero (all of them when no id is given). Called after a reroll / rollback. */
export function invalidateHeroCards(publicId?: string): void {
  if (!publicId) return void cache.clear();
  for (const k of [...cache.keys()]) if (k.startsWith(`${publicId}:`)) cache.delete(k);
}
