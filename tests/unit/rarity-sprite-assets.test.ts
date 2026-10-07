import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";

import { HeroSheet, type CanvasFactory, type SpriteSource } from "@/components/sprites/compositor";
import { RARITIES, rollAppearance, type Rarity } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { planLayers } from "@/domain/sprites/plan";
import { parseManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";

/**
 * VISUAL ASSET QA for every class × rarity combination (6 × 4 = 24, five heroes each): every layer a hero's rarity asks for exists and draws,
 * the weapon and outfit are always there, the rarity layers really add something you can see (and only on Rare and above), they ADD to the
 * silhouette rather than replacing it (a Legendary Ranger is still a Ranger), and the idle / attack frames read at battle size.
 */
const SET = "clank-dev-v1";
const factory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement;
let src: SpriteSource;
beforeAll(async () => {
  const dir = path.join(process.cwd(), "public", "sprites", SET);
  const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
  const images: SpriteSource["images"] = {};
  for (const [k, f] of Object.entries(manifest.images)) images[k] = (await loadImage(path.join(dir, f))) as unknown as CanvasImageSource;
  src = { manifest, images, factory };
});

const SEEDS = ["a", "b", "c", "d", "e"];
const RARITY_SLOTS = ["trim", "shoulder", "crest", "weaponfx"] as const;
const pix = (c: HTMLCanvasElement | null): Uint8ClampedArray => c!.getContext("2d")!.getImageData(0, 0, 80, 64).data;
const alphaCount = (d: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]! > 8) n++; return n; };
const configOf = (classId: string, rarity: Rarity, seed: string): SpriteConfig => {
  const cls = DEFAULT_CLASSES.find((c) => c.id === classId)!;
  return deriveSpriteConfig(rollAppearance(createRng(`${seed}-${classId}`), cls, rarity), cls.look, rarity);
};
const sheetOf = (classId: string, rarity: Rarity, config: SpriteConfig) => new HeroSheet(src, config, DEFAULT_CLASSES.find((c) => c.id === classId)!.look.colors, rarity);
const silhouette = (d: Uint8ClampedArray) => { const s = new Uint8Array(d.length / 4); for (let i = 0; i < s.length; i++) s[i] = d[i * 4 + 3]! > 8 ? 1 : 0; return s; };
const changedPixels = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) + Math.abs(a[i + 3]! - b[i + 3]!) > 30) n++;
  return n;
};
const jaccard = (a: Uint8Array, b: Uint8Array) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; } return u ? i / u : 1; };

describe("all 24 class × rarity combinations", () => {
  const combos = DEFAULT_CLASSES.flatMap((c) => RARITIES.map((r) => [c.id, r] as const));
  it("is exactly 24", () => expect(combos).toHaveLength(24));

  it.each(combos)("%s %s: every layer resolves, nothing is missing, the weapon and outfit are always there", (classId, rarity) => {
    for (const seed of SEEDS) {
      const config = configOf(classId, rarity, seed);
      const plan = planLayers(config, src.manifest);
      expect(plan.missing, `${classId} ${rarity} ${seed}`).toEqual([]);
      expect(plan.fallback).toBe(false);
      expect(config.slots.weapon, "weapon").toMatch(/^weapon\./);
      expect(config.slots.outfit, "outfit").toMatch(/^outfit\./);
      expect(config.slots.headgear, "headgear").toMatch(/^headgear\./);
      expect(sheetOf(classId, rarity, config).needsFallback).toBe(false);
    }
  });

  it.each(combos)("%s %s: wears the layers its tier promises, and no others", (classId, rarity) => {
    for (const seed of SEEDS) {
      const slots = configOf(classId, rarity, seed).slots;
      const worn = RARITY_SLOTS.filter((s) => slots[s]);
      if (rarity === "COMMON") expect(worn, "Common is clean").toEqual([]);
      if (rarity === "RARE") expect(worn.sort()).toEqual(["trim", "weaponfx"]);
      if (rarity === "EPIC") {
        expect(worn).toEqual(expect.arrayContaining(["trim", "shoulder", "weaponfx"]));
        expect(worn.length).toBeLessThanOrEqual(4);
      }
      if (rarity === "LEGENDARY") expect([...worn].sort()).toEqual(["crest", "shoulder", "trim", "weaponfx"]);
      for (const slot of worn) expect(slots[slot], slot).toContain(`.${rarity.toLowerCase()}.`); // the items of THIS tier, never another
      // class-aware: the layer item is mapped onto this class's own body / weapon / headgear
      const cls = DEFAULT_CLASSES.find((c) => c.id === classId)!;
      if (slots.trim) expect(slots.trim).toContain(`.${cls.look.body}`);
      if (slots.weaponfx) expect(slots.weaponfx).toContain(`.${cls.look.weapon}`);
      if (slots.crest) expect(slots.crest).toContain(`.${cls.look.headgear}`);
    }
  });

  it.each(combos)("%s %s: the rarity layers are VISIBLE on the battle sprite (more of them, the higher the tier) and never erase the hero underneath", (classId, rarity) => {
    // Measured on the shipped set over 5 seeds × 6 classes (changed pixels in the 80×64 idle frame): Common 0 · Rare 27–112 · Epic 167–331 · Legendary 283–398.
    const MIN = { COMMON: 0, RARE: 20, EPIC: 120, LEGENDARY: 220 } as const;
    for (const seed of SEEDS) {
      const config = configOf(classId, rarity, seed);
      const bare: SpriteConfig = { ...config, slots: Object.fromEntries(Object.entries(config.slots).filter(([k]) => !(RARITY_SLOTS as readonly string[]).includes(k))) };
      const dressed = pix(sheetOf(classId, rarity, config).strip("idle"));
      const plain = pix(sheetOf(classId, rarity, bare).strip("idle"));
      const changed = changedPixels(dressed, plain);
      if (rarity === "COMMON") expect(changed, "Common is left clean").toBe(0);
      else expect(changed, `${classId} ${rarity} ${seed}: visibly dressed`).toBeGreaterThanOrEqual(MIN[rarity]);
      // layers sit ON TOP: every pixel of the bare hero is still drawn in the dressed one
      const bareSil = silhouette(plain);
      const dressSil = silhouette(dressed);
      let erased = 0;
      for (let i = 0; i < bareSil.length; i++) if (bareSil[i] && !dressSil[i]) erased++;
      expect(erased, `${classId} ${rarity} ${seed}: nothing underneath is erased`).toBeLessThanOrEqual(2);
    }
  });

  it.each(combos)("%s %s: readable at battle size — a solid, non-trivial silhouette in idle and attack frames", (classId, rarity) => {
    for (const seed of SEEDS) {
      const sheet = sheetOf(classId, rarity, configOf(classId, rarity, seed));
      for (const clip of ["idle", "attack_slash", "ko"] as const) {
        const strip = sheet.strip(clip);
        if (!strip) continue;
        const n = alphaCount(pix(strip));
        expect(n, `${classId} ${rarity} ${clip}`).toBeGreaterThan(450);
        expect(n, `${classId} ${rarity} ${clip}`).toBeLessThan(80 * 64 * 0.6); // not a smear that fills the cell
      }
    }
  });
});

describe("the ladder is visible", () => {
  /** Changed pixels between a hero and the SAME hero with everything rarity gives it removed (the four layers, the cape, the accessory) plus the pixels of its aura layer. */
  const COMMON_LOOK = [...RARITY_SLOTS, "cape", "accessory", "aura"] as readonly string[];
  const dressing = (classId: string, rarity: Rarity, seed: string) => {
    const config = configOf(classId, rarity, seed);
    const plainCfg: SpriteConfig = { ...config, slots: Object.fromEntries(Object.entries(config.slots).filter(([k]) => !COMMON_LOOK.includes(k))) };
    const sheet = sheetOf(classId, rarity, config);
    const aura = sheet.aura();
    const auraPixels = aura ? alphaCount(aura.getContext("2d")!.getImageData(0, 0, 80, 64).data) : 0; // the aura is its own layer, drawn behind the hero
    return changedPixels(pix(sheet.strip("idle")), pix(sheetOf(classId, rarity, plainCfg).strip("idle"))) + auraPixels;
  };
  it("each tier visibly changes clearly more of the sprite than the one below it, for every class (layers + cape + accessory + aura)", () => {
    for (const c of DEFAULT_CLASSES) {
      const median = (rarity: Rarity) => {
        const xs = SEEDS.map((seed) => dressing(c.id, rarity, seed)).sort((x, y) => x - y);
        return xs[Math.floor(xs.length / 2)]!;
      };
      const m = RARITIES.map(median);
      expect(m[0], `${c.id} Common`).toBeLessThan(150); // Common: clean — only what it starts with (goggles, a scarf, the cleric's halo). Measured medians Common / Rare / Epic / Legendary: warrior 11 / 242 / 455 / 713 · mage 0 / 233 / 455 / 743 · rogue 19 / 206 / 447 / 634 · ranger 76 / 330 / 487 / 718 · tank 11 / 203 / 427 / 698 · cleric 133 / 350 / 515 / 689
      for (let i = 1; i < m.length; i++) expect(m[i]!, `${c.id} ${RARITIES[i]}`).toBeGreaterThan(m[i - 1]! * 1.2);
    }
  });
});

describe("class identity survives rarity", () => {
  it("a Legendary of a class still looks like THAT class: its silhouette is closer to its own Common than to any other class's", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const commons = new Map(DEFAULT_CLASSES.map((c) => [c.id, silhouette(pix(sheetOf(c.id, "COMMON", configOf(c.id, "COMMON", seed)).strip("idle")))]));
      for (const c of DEFAULT_CLASSES) {
        for (const rarity of ["EPIC", "LEGENDARY"] as const) {
          const mine = silhouette(pix(sheetOf(c.id, rarity, configOf(c.id, rarity, seed)).strip("idle")));
          const own = jaccard(mine, commons.get(c.id)!);
          const others = DEFAULT_CLASSES.filter((o) => o.id !== c.id).map((o) => jaccard(mine, commons.get(o.id)!));
          expect(own, `${seed}: ${rarity} ${c.id} vs its own Common`).toBeGreaterThan(Math.max(...others) - 0.02);
          expect(own, `${rarity} ${c.id}`).toBeGreaterThan(0.45);
          checked++;
        }
      }
    }
    expect(checked).toBe(60);
  });

  it("the aura is a SEPARATE layer drawn behind the hero, so it can never cover a face", () => {
    for (const rarity of RARITIES.slice(1)) {
      const config = configOf("mage", rarity, "a");
      const sheet = sheetOf("mage", rarity, config);
      expect(sheet.aura(), rarity).not.toBeNull();
      expect(sheet.aura()).not.toBe(sheet.strip("idle")); // a different canvas: drawn first, then the hero over it
    }
    expect(sheetOf("mage", "COMMON", configOf("mage", "COMMON", "a")).aura()).toBeNull();
  });
});
