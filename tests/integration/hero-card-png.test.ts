import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RARITIES, type Rarity } from "@/domain/character/appearance";
import { getHeroCardBackground, heroArenaLayout } from "@/domain/hero/cardBackground";
import type { HeroCardModel } from "@/domain/hero/card";
import { CARD_SIZE, renderHeroCardPng, resetCardImageState } from "@/server/heroes/cardImage";

/**
 * THE SERVER-RENDERED HERO CARD (the download, the share image and the social preview are all this one PNG): the same arena image as the web card, read from
 * the same file, the hero small inside it, no PWR band — and byte-for-byte deterministic, so a historical version always renders the same.
 */
const POWER: Record<Rarity, number> = { COMMON: 141, RARE: 158, EPIC: 181, LEGENDARY: 204 };
const model = (rarity: Rarity, over: Partial<HeroCardModel> = {}): HeroCardModel => ({
  publicId: "k7m2q9x4tb3d", name: "Baoskee", classId: "mage", className: "Mage", rarity, power: POWER[rarity], seasonRank: null,
  stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 },
  look: {
    rarity, parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 2, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.robe", weapon: "weapon.staff" } }, colors: ["#6b4fd8", "#f4c542", "#2a1a5e"], weapon: "staff", headgear: "hat", body: "robe",
  },
  ...over,
});

/** A region of a PNG as raw RGBA. */
async function region(png: Buffer, x: number, y: number, w: number, h: number): Promise<Uint8ClampedArray> {
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(x, y, w, h).data as unknown as Uint8ClampedArray;
}
const meanDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0)) + Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)) + Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0));
  return sum / ((a.length / 4) * 3);
};
const dims = (png: Buffer) => [png.readUInt32BE(16), png.readUInt32BE(20)];
// the art panel of the PNG (see cardImage.ts): x 110, y 156, 980 × 560 — sample blocks near its corners, away from the hero standing in the middle
const ART = { x: 110, y: 156, w: 980, h: 560 };
const cornerBlocks = (png: Buffer) => Promise.all([region(png, ART.x + 70, ART.y + 60, 60, 60), region(png, ART.x + ART.w - 130, ART.y + 60, 60, 60), region(png, ART.x + 70, ART.y + ART.h - 120, 60, 60)]);

const MISSING_DIR = path.join(mkdtempSync(path.join(tmpdir(), "no-arenas-")), "nothing-here");

afterEach(() => {
  resetCardImageState();
  vi.restoreAllMocks();
});

describe("renders every rarity at the fixed size, deterministically", () => {
  it("1200 × 1200 PNG for COMMON, RARE, EPIC and LEGENDARY — the same card is the same bytes, a different rarity is a different picture", async () => {
    const pngs = new Map<Rarity, Buffer>();
    for (const rarity of RARITIES) {
      const a = await renderHeroCardPng(model(rarity));
      const b = await renderHeroCardPng(model(rarity));
      expect(a.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(dims(a)).toEqual([CARD_SIZE, CARD_SIZE]);
      expect(a.equals(b)).toBe(true); // deterministic
      pngs.set(rarity, a);
    }
    for (let i = 0; i < RARITIES.length; i++) for (let j = i + 1; j < RARITIES.length; j++) expect(pngs.get(RARITIES[i]!)!.equals(pngs.get(RARITIES[j]!)!)).toBe(false);
  }, 60_000);

  it("a fresh process (nothing cached) renders the same bytes as a warm one", async () => {
    const warm = await renderHeroCardPng(model("EPIC"));
    resetCardImageState();
    expect((await renderHeroCardPng(model("EPIC"))).equals(warm)).toBe(true);
  });
});

describe("each rarity stands in its own arena image", () => {
  it("the art panel shows the arena (not the neutral backdrop), and each rarity's arena looks different", async () => {
    const withArena = new Map<Rarity, Buffer[]>();
    for (const rarity of RARITIES) {
      const arena = await renderHeroCardPng(model(rarity));
      const neutral = await renderHeroCardPng(model(rarity), { backgroundDir: MISSING_DIR });
      const [a, n] = [await cornerBlocks(arena), await cornerBlocks(neutral)];
      for (let i = 0; i < a.length; i++) expect(meanDiff(a[i]!, n[i]!), `${rarity} block ${i}: arena vs neutral`).toBeGreaterThan(12);
      withArena.set(rarity, [arena]);
    }
    for (let i = 0; i < RARITIES.length; i++) {
      for (let j = i + 1; j < RARITIES.length; j++) {
        const [a, b] = [await cornerBlocks(withArena.get(RARITIES[i]!)![0]!), await cornerBlocks(withArena.get(RARITIES[j]!)![0]!)];
        const total = a.reduce((sum, block, k) => sum + meanDiff(block, b[k]!), 0) / a.length;
        expect(total, `${RARITIES[i]} vs ${RARITIES[j]}`).toBeGreaterThan(10);
      }
    }
  }, 120_000);

  it("the panel IS the shipped file fitted with the shared layout: sampled arena pixels match the file scaled with heroArenaLayout (same file, same crop)", async () => {
    for (const rarity of RARITIES) {
      const file = readFileSync(path.join(process.cwd(), "public", getHeroCardBackground(rarity) as string));
      const image = await loadImage(file);
      const expectedCanvas = createCanvas(ART.w, ART.h);
      const ectx = expectedCanvas.getContext("2d");
      const { image: rect } = heroArenaLayout({ w: ART.w, h: ART.h });
      ectx.imageSmoothingEnabled = true;
      ectx.imageSmoothingQuality = "high";
      ectx.drawImage(image, rect.x, rect.y, rect.size, rect.size);
      const png = await renderHeroCardPng(model(rarity));
      for (const [bx, by] of [[70, 60], [ART.w - 130, 60], [70, ART.h - 120], [ART.w - 130, ART.h - 120], [ART.w / 2 - 30, 40]] as const) {
        const expected = ectx.getImageData(bx, by, 60, 60).data as unknown as Uint8ClampedArray;
        const actual = await region(png, ART.x + bx, ART.y + by, 60, 60);
        expect(meanDiff(expected, actual), `${rarity} block at ${bx},${by}`).toBeLessThan(8);
      }
    }
  }, 120_000);
});

describe("versions render from their own rarity", () => {
  it("a historical (rolled-back-to) card is independent of the hero's current rarity: the same version is the same bytes", async () => {
    const v1 = model("COMMON", { power: 139 });
    const current = model("EPIC", { power: 181 });
    const first = await renderHeroCardPng(v1);
    await renderHeroCardPng(current); // the hero was rerolled in between
    expect((await renderHeroCardPng(model("COMMON", { power: 139 }))).equals(first)).toBe(true);
    expect((await renderHeroCardPng(current)).equals(first)).toBe(false);
  }, 60_000);
});

describe("fallback: an arena image that cannot be read", () => {
  it("renders the neutral backdrop instead — a valid, deterministic 1200 × 1200 PNG, with a warning but no crash and no blank card", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const rarity of RARITIES) {
      const a = await renderHeroCardPng(model(rarity), { backgroundDir: MISSING_DIR });
      const b = await renderHeroCardPng(model(rarity), { backgroundDir: MISSING_DIR });
      expect(dims(a)).toEqual([CARD_SIZE, CARD_SIZE]);
      expect(a.equals(b)).toBe(true);
      expect(a.length).toBeGreaterThan(20_000); // not a blank card
      const [stats] = [await region(a, 110, 1030, 980, 86)];
      expect(stats.some((v, i) => i % 4 !== 3 && v > 200)).toBe(true); // the stats row (white numbers) is drawn
    }
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("arena image");
  }, 60_000);

  it("a failed read is not remembered: once the file is there again the arena comes back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = mkdtempSync(path.join(tmpdir(), "late-arenas-"));
    const neutral = await renderHeroCardPng(model("COMMON"), { backgroundDir: dir }); // nothing in it yet
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(dir, "common.webp"), readFileSync(path.join(process.cwd(), "public", "hero-card-backgrounds", "common.webp")));
    const arena = await renderHeroCardPng(model("COMMON"), { backgroundDir: dir });
    expect(arena.equals(neutral)).toBe(false);
    expect(arena.equals(await renderHeroCardPng(model("COMMON")))).toBe(true); // …and it is exactly the shipped arena
  }, 60_000);
});

describe("no PWR band on the card", () => {
  it("the renderer neither imports nor draws the tier / band line", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "server", "heroes", "cardImage.ts"), "utf8");
    expect(source).not.toMatch(/bandLabel|positionInBand|TIER ·|RARITY_RULES/);
  });
});
