import { afterEach, describe, expect, it } from "vitest";

import { ensureSpriteSet, getLibraryState, resetSpriteLibrary, retrySpriteSetNow, SPRITE_RETRY_MS } from "@/components/sprites/library";

import { makeManifest } from "../support/sprites";

/**
 * A viewer must not be left on the procedural vector hero for a whole session because ONE request failed (a busy server, a flaky mobile network):
 * the sprite set is retried with backoff, and each atlas image is retried before it is given up on.
 */
afterEach(() => resetSpriteLibrary());

const manifest = makeManifest();
const image = {} as CanvasImageSource;
const factory = () => ({}) as HTMLCanvasElement;

function harness(opts: { manifestFailures?: number; imageFailures?: number }) {
  let manifestCalls = 0;
  let imageCalls = 0;
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const deps = {
    base: "/sprites/test",
    factory,
    fetchJson: async () => {
      manifestCalls++;
      if (manifestCalls <= (opts.manifestFailures ?? 0)) throw new Error("manifest 503");
      return manifest;
    },
    loadImage: async () => {
      imageCalls++;
      if (imageCalls <= (opts.imageFailures ?? 0)) throw new Error("image failed");
      return image;
    },
    schedule: (fn: () => void, ms: number) => pending.push({ fn, ms }),
  };
  return { deps, pending, calls: () => ({ manifestCalls, imageCalls }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the sprite set recovers from a failed request instead of staying on the vector fallback", () => {
  it("a manifest request that fails once is retried after a short backoff, and the set becomes ready", async () => {
    const h = harness({ manifestFailures: 1 });
    expect((await ensureSpriteSet("test", h.deps)).status).toBe("failed");
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]!.ms).toBe(SPRITE_RETRY_MS[0]);
    h.pending.shift()!.fn();
    await flush();
    await flush();
    expect(getLibraryState("test").status).toBe("ready");
    expect(getLibraryState("test").source?.manifest.id).toBe(manifest.id);
  });

  it("an atlas image that fails twice is retried within the same attempt (no layer is lost)", async () => {
    const h = harness({ imageFailures: 2 });
    const s = await ensureSpriteSet("test", h.deps);
    expect(s.status).toBe("ready");
    expect(s.failedAtlases).toEqual([]);
  });

  it("a set that keeps failing backs off (1.5 s, 4 s, 10 s, 30 s) and then stops — it never hammers the server", async () => {
    const h = harness({ manifestFailures: 1000 });
    await ensureSpriteSet("test", h.deps);
    const waits: number[] = [];
    while (h.pending.length) {
      const next = h.pending.shift()!;
      waits.push(next.ms);
      next.fn();
      await flush();
      await flush();
    }
    expect(waits).toEqual([...SPRITE_RETRY_MS]);
    expect(getLibraryState("test").status).toBe("failed");
    expect(h.calls().manifestCalls).toBe(SPRITE_RETRY_MS.length + 1);
  });

  it("SLOW atlases: the set stays 'loading' (vector heroes meanwhile) and becomes ready when they arrive — nothing is given up on", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({});
    const slow = { ...h.deps, loadImage: async () => { await gate; return image; } };
    const p = ensureSpriteSet("test", slow);
    await flush();
    expect(getLibraryState("test").status).toBe("loading");
    release();
    expect((await p).status).toBe("ready");
  });

  it("the network comes back / the tab is restored: a failed set is retried AT ONCE (not after its backoff) — and a ready one is left alone", async () => {
    const h = harness({ manifestFailures: 1 });
    await ensureSpriteSet("test", h.deps);
    expect(getLibraryState("test").status).toBe("failed");
    retrySpriteSetNow("test", h.deps); // the 'online' / 'visibilitychange' / 'pageshow' handler
    await flush();
    await flush();
    expect(getLibraryState("test").status).toBe("ready");
    const calls = h.calls().manifestCalls;
    retrySpriteSetNow("test", h.deps);
    await flush();
    expect(h.calls().manifestCalls).toBe(calls);
    h.pending.shift()?.fn(); // the original backoff timer fires later: harmless, the set is ready
    await flush();
    expect(getLibraryState("test").status).toBe("ready");
    expect(h.calls().manifestCalls).toBe(calls);
  });
});

