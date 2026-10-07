import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { drawRarityAura, drawRarityGround, drawRarityMark, drawRarityParticles, hasRarityFx } from "@/components/arena/rarityFx";
import { RARITIES } from "@/domain/character/appearance";
import { RARITY_VISUALS } from "@/domain/hero/rarityVisuals";

/**
 * ARENA RARITY EFFECTS: visible without a label, lightweight, motion-safe, and visual only. A RECORDING canvas stands in for the real one, so we
 * can assert exactly what each tier draws (shapes, counts) and — crucially — that nothing ever draws text.
 */
type Op = { fn: string; args: unknown[] };
function recorder() {
  const ops: Op[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "createRadialGradient" || prop === "createLinearGradient") return (...args: unknown[]) => { ops.push({ fn: prop, args }); return { addColorStop: () => undefined }; };
        if (prop in state) return state[prop];
        return (...args: unknown[]) => { ops.push({ fn: prop, args }); };
      },
      set(_t, prop: string, value) { state[prop] = value; ops.push({ fn: `set:${prop}`, args: [value] }); return true; },
    },
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, ops };
}
const frame = (rarity: string, now: number, slot: number, reduced = false) => {
  const r = recorder();
  drawRarityGround(r.ctx, rarity, now, slot, 1, reduced);
  drawRarityAura(r.ctx, rarity, now, slot, 1, reduced);
  drawRarityParticles(r.ctx, rarity, now, slot, 1, reduced);
  return r.ops;
};
const count = (ops: Op[], fn: string) => ops.filter((o) => o.fn === fn).length;

describe("Arena rarity effects", () => {
  it("draw NO TEXT at all — rarity is never a label in the battle stage", () => {
    for (const rarity of RARITIES) {
      for (const reduced of [false, true]) {
        const ops = frame(rarity, 12_345, 3, reduced);
        expect(count(ops, "fillText") + count(ops, "strokeText") + count(ops, "measureText"), `${rarity} reduced=${reduced}`).toBe(0);
      }
      const mark = recorder();
      drawRarityMark(mark.ctx, rarity, 10, 10, 4);
      expect(count(mark.ops, "fillText") + count(mark.ops, "strokeText")).toBe(0);
    }
  });

  it("the renderer source never prints a rarity name in the stage: it imports no rarity labels and the effects module has no text calls", () => {
    const root = process.cwd();
    const renderer = readFileSync(path.join(root, "src/components/arena/ArenaRenderer.ts"), "utf8");
    const fx = readFileSync(path.join(root, "src/components/arena/rarityFx.ts"), "utf8");
    expect(renderer).not.toMatch(/RARITY_RULES|RARITY_LABEL|rarityLabel|\.label\b.*rarity|rarity.*\.label\b/);
    expect(renderer).not.toMatch(/fillText\([^)]*rarit/i);
    expect(fx).not.toMatch(/fillText|strokeText|measureText/);
  });

  it("each tier is drawn with MORE (and a different SHAPE of) effect than the one below — never colour alone", () => {
    const stats = RARITIES.map((r) => {
      const ops = frame(r, 4_000, 2);
      return { r, ops: ops.length, ellipses: count(ops, "ellipse"), arcs: count(ops, "arc"), diamonds: count(ops, "lineTo"), dashed: ops.some((o) => o.fn === "setLineDash" && Array.isArray(o.args[0]) && (o.args[0] as number[]).length > 0) };
    });
    for (let i = 1; i < stats.length; i++) expect(stats[i]!.ops, stats[i]!.r).toBeGreaterThan(stats[i - 1]!.ops);
    expect(stats[0]!.ellipses).toBe(1); // Common: one thin ring and nothing else
    expect(stats[0]!.arcs).toBe(0);
    expect(stats[1]!.ellipses).toBeGreaterThanOrEqual(2); // Rare: ring + outline
    expect(stats[2]!.dashed).toBe(true); // Epic: a dashed outline…
    expect(stats[3]!.dashed).toBe(false); // …Legendary a solid double outline
    expect(stats[2]!.diamonds).toBeGreaterThan(stats[1]!.diamonds); // Epic sparks are DIAMONDS (path lines)
    expect(stats[3]!.arcs).toBeGreaterThan(stats[2]!.arcs); // Legendary embers are ROUND (arcs)
    // the ring count and rune ticks follow the shared table
    expect(RARITIES.map((r) => RARITY_VISUALS[r].arena.ground.rings)).toEqual([1, 1, 2, 3]);
    expect(RARITIES.map((r) => RARITY_VISUALS[r].arena.particles.count)).toEqual([0, 0, 6, 12]);
  });

  it("the plate mark is a different SHAPE per tier (dot · diamond · star · crown)", () => {
    const shapes = RARITIES.map((r) => {
      const m = recorder();
      drawRarityMark(m.ctx, r, 0, 0, 5);
      return `${count(m.ops, "arc")}a${count(m.ops, "lineTo")}l${count(m.ops, "quadraticCurveTo")}q`;
    });
    expect(new Set(shapes).size).toBe(4);
  });

  it("is LIGHTWEIGHT: eight Legendary heroes cost a bounded number of canvas calls per frame, with no blur filters and no per-frame allocation of state", () => {
    let total = 0;
    for (let slot = 0; slot < 8; slot++) {
      const ops = frame("LEGENDARY", 9_999, slot);
      total += ops.length;
      expect(ops.some((o) => o.fn === "set:shadowBlur" || o.fn === "set:filter")).toBe(false); // no expensive blur
    }
    expect(total).toBeLessThan(900); // ≈ 100 calls per hero
    expect(total / 8).toBeLessThan(120);
  });

  it("is a PURE function of the clock: the same time and slot always draw the same thing, different times move the particles", () => {
    const a = JSON.stringify(frame("EPIC", 7_777, 4));
    const b = JSON.stringify(frame("EPIC", 7_777, 4));
    const c = JSON.stringify(frame("EPIC", 8_333, 4));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("respects prefers-reduced-motion: no particles, no breathing — a still ring, glow and outline remain", () => {
    for (const rarity of ["EPIC", "LEGENDARY"] as const) {
      const live = frame(rarity, 3_000, 1, false);
      const still = frame(rarity, 3_000, 1, true);
      const stillLater = frame(rarity, 9_000, 1, true);
      expect(count(live, "fill")).toBeGreaterThan(count(still, "fill")); // the particles are the only difference: one fill each
      expect(count(still, "arc")).toBe(0);
      expect(count(still, "ellipse")).toBeGreaterThan(0);
      // reduced motion draws the same picture at any time except the ring ticks' spin is also frozen
      expect(JSON.stringify(still)).toBe(JSON.stringify(stillLater));
    }
  });

  it("knocked-out heroes draw nothing (the effects fade out with the hero)", () => {
    const r = recorder();
    drawRarityGround(r.ctx, "LEGENDARY", 1000, 0, 0, false);
    drawRarityAura(r.ctx, "LEGENDARY", 1000, 0, 0, false);
    drawRarityParticles(r.ctx, "LEGENDARY", 1000, 0, 0, false);
    expect(r.ops).toEqual([]);
  });

  it("only rarer-than-Common heroes have an aura / particles; an unknown rarity is dressed as Common, never a crash", () => {
    expect(hasRarityFx("COMMON")).toBe(false);
    expect(RARITIES.slice(1).every((r) => hasRarityFx(r))).toBe(true);
    expect(() => frame("MYTHIC", 1, 0)).not.toThrow();
    expect(frame("MYTHIC", 1, 0).length).toBe(frame("COMMON", 1, 0).length);
  });

  it("the effects never feed combat: the simulation does not import them (visual only)", () => {
    const root = process.cwd();
    for (const f of ["src/domain/combat/engine.ts", "src/domain/combat/ranking.ts", "src/server/services/arena.ts"]) {
      const src = readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/rarityFx|rarityVisuals/);
    }
  });
});
