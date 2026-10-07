import { describe, expect, it } from "vitest";

import { createRng } from "@/domain/util/rng";

describe("seeded RNG", () => {
  it("is fully deterministic for a seed", () => {
    const a = createRng("seed-1");
    const b = createRng("seed-1");
    expect(Array.from({ length: 50 }, () => a.next())).toEqual(Array.from({ length: 50 }, () => b.next()));
  });

  it("diverges for different seeds and forks", () => {
    expect(createRng("a").next()).not.toBe(createRng("b").next());
    const r = createRng("root");
    expect(r.fork("x").next()).not.toBe(r.fork("y").next());
    expect(r.fork("x").next()).toBe(createRng("root").fork("x").next());
  });

  it("produces values in range and a valid shuffle permutation", () => {
    const rng = createRng("range");
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(rng.range(3, 7)).toBeGreaterThanOrEqual(3);
      expect(rng.range(3, 7)).toBeLessThanOrEqual(7);
    }
    const shuffled = rng.shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("weighted() never picks zero-weight items and respects proportions", () => {
    const rng = createRng("weights");
    const counts = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 20_000; i++) counts[rng.weighted(["a", "b", "c"] as const, (k) => ({ a: 1, b: 3, c: 0 })[k])]++;
    expect(counts.c).toBe(0);
    expect(counts.b / counts.a).toBeGreaterThan(2.6);
    expect(counts.b / counts.a).toBeLessThan(3.4);
  });
});
