/**
 * Deterministic seeded RNG (sfc32 seeded through an xmur3 string hash).
 *
 * Only integer arithmetic (Math.imul, shifts) is used so the stream is identical on
 * every JS engine — a hard requirement for replayable, auditable battles.
 * NOT cryptographic: production seeds come from a CSPRNG (see server/crypto), this just
 * expands a seed into a reproducible stream.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Integer in [min, max] inclusive. */
  range(min: number, max: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Pick by non-negative weights. Weights of 0 are never picked. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T;
  /** In-place-safe Fisher–Yates; returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Independent child stream; deterministic for (seed, label). */
  fork(label: string): Rng;
}

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

export function createRng(seed: string | number): Rng {
  const seedString = String(seed);
  const seedGen = xmur3(seedString);
  let a = seedGen();
  let b = seedGen();
  let c = seedGen();
  let d = seedGen();

  const nextUint32 = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  // Warm up so similar seeds diverge immediately.
  for (let i = 0; i < 12; i++) nextUint32();

  const rng: Rng = {
    next: () => nextUint32() / 4294967296,
    int(maxExclusive) {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`int(): maxExclusive must be a positive integer, got ${maxExclusive}`);
      }
      return Math.floor(rng.next() * maxExclusive);
    },
    range(min, max) {
      return min + rng.int(max - min + 1);
    },
    chance(probability) {
      return rng.next() < probability;
    },
    pick(items) {
      if (items.length === 0) throw new RangeError("pick(): empty list");
      return items[rng.int(items.length)] as never;
    },
    weighted(items, weight) {
      let total = 0;
      for (const item of items) total += Math.max(0, weight(item));
      if (!(total > 0)) throw new RangeError("weighted(): total weight must be positive");
      let roll = rng.next() * total;
      let last: unknown;
      for (const item of items) {
        const w = Math.max(0, weight(item));
        if (w === 0) continue;
        last = item;
        if (roll < w) return item;
        roll -= w;
      }
      return last as never;
    },
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        const tmp = out[i] as never;
        out[i] = out[j] as never;
        out[j] = tmp;
      }
      return out;
    },
    fork: (label) => createRng(`${seedString}/${label}`),
  };
  return rng;
}
