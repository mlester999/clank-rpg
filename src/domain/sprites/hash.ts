/**
 * FNV-1a 32-bit with a murmur3 finaliser — a small, stable string hash (the same on every machine, forever). The finaliser matters: raw FNV-1a's
 * low bit is just the parity of the input bytes, so `% 2` would pick the SAME variant for a hero's weapon and its headgear.
 */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The parts of a stored look that can never be overridden or re-rolled — what every per-hero design choice is keyed on. */
export const lookKey = (c: { skin: number; hairColor: number; hue: number }): string => `${c.skin}|${c.hairColor}|${c.hue}`;
