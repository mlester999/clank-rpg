import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";

import { HeroSheet, type SpriteSource } from "@/components/sprites/compositor";
import { selectPlayback } from "@/domain/sprites/animator";
import { RARITIES, rollAppearance, type Rarity } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { idleClipOf, planLayers, variantOf } from "@/domain/sprites/plan";
import { decodeCells, encodeCells, parseManifest, safeParseManifest, type PackedCell, type SpriteManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";

import { makeManifest } from "../support/sprites";

/**
 * HERO RENDERER v2 — the DESIGN LIBRARY (third pass): per-class skeletons, packed per-frame atlases, equipment tiers, independent design
 * sub-slots and two stances. These tests guard the CONTRACT (determinism, no rerolls, tier pools, packing); what the heroes look like is
 * judged on the rendered sheets, not here — the 20-hero checks below are a floor that catches clones, not a verdict on the art.
 */

const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const configOf = (id: string, seed: string, rarity: Rarity = "COMMON"): SpriteConfig => deriveSpriteConfig(rollAppearance(createRng(seed), cls(id), rarity), cls(id).look, rarity);
const shipped = (): SpriteManifest => parseManifest(JSON.parse(readFileSync(path.join(process.cwd(), "public", "sprites", "clank-dev-v2", "manifest.json"), "utf8")));
/** The ids of the DESIGNS a plan wears (a class design id carries a class letter + tier: `.w2-`, `.g0-` …). */
const designs = (cfg: SpriteConfig, m: SpriteManifest, rarity: Rarity) => planLayers(cfg, m, rarity).layers.map((l) => l.id).filter((id) => /\.[a-z]\d-[a-z]+$/.test(id));

describe("the packed row format (spec 2): one trimmed cell per frame, in compact text", () => {
  it("round-trips cells, an empty frame included", () => {
    const cells: PackedCell[] = [[0, 0, 12, 30, 4, 8], [0, 0, 0, 0, 0, 0], [2047, 4095, 88, 72, 0, 0]];
    const text = encodeCells(cells);
    expect(text).toBe("0,0,c,u,4,8;-;1kv,35r,2g,20,0,0");
    expect(decodeCells(text)).toEqual(cells);
  });

  it("a manifest whose row has the wrong number of cells for its clip is rejected", () => {
    const m = makeManifest({ spec: 2, rigs: ["a"] });
    m.layers["body.base"] = { z: 10, tint: "skin", cells: { a: [["atlas", "0,0,4,4,1,1;0,0,4,4,1,1"]] } }; // idle has 4 frames
    const r = safeParseManifest(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cells for 4 frames/);
  });

  it("the shipped set stores identical cells once (a held pose, a lying KO): fewer stored cells than frames", () => {
    const m = shipped();
    const seen = new Set<string>();
    let frames = 0;
    for (const l of Object.values(m.layers)) for (const rows of Object.values(l.cells ?? {})) for (const r of rows) if (r) for (const c of decodeCells(r[1])) if (c[2] > 0) {
      frames++;
      seen.add(`${r[0]}:${c[0]},${c[1]}`);
    }
    expect(frames).toBeGreaterThan(40_000);
    expect(seen.size / frames).toBeLessThan(0.9);
  });
});

describe("the planner (spec 2 additions)", () => {
  /** A synthetic library: a helm with a design that brings a plume part, a kit sub-slot whose design brings its far twin, a tiered weapon. */
  function library(): SpriteManifest {
    const m = makeManifest();
    const atlas = { image: "atlas", x: 0, y: 0 };
    m.layers["headgear.helm"] = { ...m.layers["headgear.helm"]!, variants: ["headgear.helm.w0-a", "headgear.helm.w3-b"] };
    m.layers["headgear.helm.w0-a"] = { ...atlas, z: 60, tint: null, tiers: ["COMMON"] };
    m.layers["headgear.helm.w3-b"] = { ...atlas, z: 60, tint: null, tiers: ["LEGENDARY"] };
    m.layers["headgear.helm.w3-b.1"] = { ...atlas, z: 61, tint: null, of: "headgear.helm.w3-b" };
    m.layers["outfit.medium.shoulders"] = { ...atlas, z: 67, tint: null, of: "outfit.medium", variants: ["outfit.medium.shoulders.w0-pad"] };
    m.layers["outfit.medium.shoulders.w0-pad"] = { ...atlas, z: 67, tint: null, tiers: ["COMMON"] };
    m.layers["outfit.medium.shoulders.w0-pad.1"] = { ...atlas, z: 17, tint: null, of: "outfit.medium.shoulders.w0-pad" };
    return m;
  }

  it("rarity picks the POOL: a Common hero only ever wears Common designs, a Legendary only Legendary ones (the generic drawing competes in both)", () => {
    const m = library();
    for (let i = 0; i < 60; i++) {
      const c = configOf("warrior", `pool-${i}`, "COMMON");
      expect(["headgear.helm", "headgear.helm.w0-a"]).toContain(variantOf(c, "headgear.helm", m, { rarity: "COMMON" }));
      expect(["headgear.helm", "headgear.helm.w3-b"]).toContain(variantOf(c, "headgear.helm", m, { rarity: "LEGENDARY" }));
    }
  });

  it("a rarity no design is made for (junk data) still wears one of the skeleton's designs, never nothing", () => {
    const m = library();
    delete m.layers["headgear.helm"]!.cells; // keep block layout: drawable everywhere
    const c = configOf("warrior", "junk");
    expect(m.layers[variantOf(c, "headgear.helm", m, { rarity: "MYTHIC" })]).toBeDefined();
  });

  it("a part's chosen design brings its own parts (a pauldron's far twin, a helm's plume) — and only that design's", () => {
    const m = library();
    for (let i = 0; i < 30; i++) {
      const c = configOf("warrior", `parts-${i}`, "LEGENDARY");
      const ids = planLayers(c, m, "LEGENDARY").layers.map((l) => l.id);
      const helm = variantOf(c, "headgear.helm", m, { rarity: "LEGENDARY" });
      expect(ids.includes("headgear.helm.w3-b.1")).toBe(helm === "headgear.helm.w3-b");
      const pad = variantOf(c, "outfit.medium.shoulders", m, { rarity: "LEGENDARY" });
      expect(ids.includes("outfit.medium.shoulders.w0-pad.1")).toBe(pad === "outfit.medium.shoulders.w0-pad");
    }
  });

  it("an item is worn when the design THIS hero gets can be drawn on its skeleton (a class skeleton carries only class designs)", () => {
    const m = shipped();
    expect(m.layers["outfit.medium"]!.cells?.warrior).toBeUndefined(); // the generic drawing is not drawn on the warrior skeleton …
    for (let i = 0; i < 20; i++) {
      const plan = planLayers(configOf("warrior", `wear-${i}`), m, "COMMON");
      expect(plan.fallback).toBe(false); // … and every Warrior still wears its armour: a Warrior design
      expect(plan.layers.some((l) => /^outfit\.medium\.w0-/.test(l.id))).toBe(true);
    }
  });
});

describe("determinism and no rerolls", () => {
  it("a design choice depends only on the never-rerolled look (skin, hair colour, hue): restyled eyes / hair / accessory change nothing", () => {
    const m = shipped();
    for (const c of DEFAULT_CLASSES) {
      for (const rarity of RARITIES) {
        const cfg = configOf(c.id, `det-${c.id}`, rarity);
        const restyled: SpriteConfig = { ...cfg, slots: { ...cfg.slots, eyes: "eyes.3", mouth: "mouth.2", hair: "hair.4", accessory: "accessory.monocle" } };
        expect(designs(restyled, m, rarity)).toEqual(designs(structuredClone(cfg), m, rarity));
        expect(planLayers(cfg, m, rarity).idleClip).toBe(planLayers(restyled, m, rarity).idleClip);
      }
    }
  });

  it("the stored look is untouched: the catalogue items of a hero are exactly what its appearance derives (v2 only chooses DRAWINGS)", () => {
    for (const c of DEFAULT_CLASSES) {
      const cfg = configOf(c.id, "stored", "LEGENDARY");
      expect(Object.keys(cfg.slots).every((slot) => !/\.[a-z]\d-/.test(cfg.slots[slot as keyof typeof cfg.slots]!))).toBe(true);
      expect(cfg.slots.outfit).toBe(`outfit.${c.look.body}`);
      expect(cfg.slots.weapon).toBe(`weapon.${c.look.weapon}`);
    }
  });

  it("design sub-slots are independent: a hero's helm does not decide its torso, its weapon or its stance", () => {
    const m = shipped();
    const pairs = new Map<string, Set<string>>();
    for (let i = 0; i < 400; i++) {
      const cfg = configOf("warrior", `ind-${i}`);
      const ids = designs(cfg, m, "COMMON");
      const helm = ids.find((id) => id.startsWith("headgear."))!;
      const torso = ids.find((id) => /^outfit\.medium\.w/.test(id))!;
      const weapon = ids.find((id) => /^weapon\.sword\.w/.test(id))!;
      const set = pairs.get(helm) ?? new Set<string>();
      set.add(`${torso}|${weapon}|${planLayers(cfg, m).idleClip}`);
      pairs.set(helm, set);
    }
    expect(pairs.size).toBe(6); // every Common helm occurs (the bare head included) …
    for (const [helm, combos] of pairs) expect(combos.size, helm).toBeGreaterThanOrEqual(15); // … with many torsos × swords × stances
  });
});

describe("stances", () => {
  it("each class stands two ways (idle / idle2), about half its heroes each; the arena, portraits and cards use the hero's own stance", () => {
    const m = shipped();
    for (const c of DEFAULT_CLASSES) {
      const n = Array.from({ length: 80 }, (_, i) => planLayers(configOf(c.id, `st-${i}`), m).idleClip).filter((k) => k === "idle2").length;
      expect(n, c.id).toBeGreaterThan(20);
      expect(n, c.id).toBeLessThan(60);
    }
    const input = { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: Infinity, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 300 };
    expect(selectPlayback(input, m, "attack_slash", "idle2").clip).toBe("idle2");
    expect(selectPlayback(input, makeManifest(), "attack_slash", "idle2").clip).toBe("idle"); // a set without a second stance
  });

  it("a set without idle2 (v1, any production pack) always uses idle", () => {
    expect(idleClipOf(configOf("warrior", "v1"), makeManifest(), null)).toBe("idle");
  });
});

describe("the shipped set at battle size", () => {
  let src: SpriteSource;
  beforeAll(async () => {
    const dir = path.join(process.cwd(), "public", "sprites", "clank-dev-v2");
    const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
    const images: SpriteSource["images"] = {};
    for (const [k, f] of Object.entries(manifest.images)) images[k] = (await loadImage(path.join(dir, f))) as unknown as CanvasImageSource;
    src = { manifest, images, factory: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement };
  });
  const idle = (cid: string, seed: string, rarity: Rarity) => {
    const sheet = new HeroSheet(src, configOf(cid, seed, rarity), cls(cid).look.colors, rarity);
    return sheet.strip(sheet.plan.idleClip)!.getContext("2d")!.getImageData(0, 0, src.manifest.frame.w, src.manifest.frame.h).data;
  };
  const changed = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
    let n = 0;
    for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) + Math.abs(a[i + 3]! - b[i + 3]!) > 30) n++;
    return n;
  };

  it.each(DEFAULT_CLASSES.flatMap((c) => (["COMMON", "LEGENDARY"] as const).map((r) => [c.id, r] as const)))("THE 20-HERO CHALLENGE (floor): 20 %s %s heroes — no two alike (≥ 150 px of 7680 differ for every pair)", (cid, rarity) => {
    // A floor that catches clones; the silhouette variety of the archetypes is measured in hero-archetypes.test.ts.
    const frames = Array.from({ length: 20 }, (_, i) => idle(cid, `qa-${cid}-${i}`, rarity));
    for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) expect(changed(frames[i]!, frames[j]!), `${cid} ${rarity} ${i} vs ${j}`).toBeGreaterThanOrEqual(150);
  });

  it("the atlas budget: one page per skeleton (≤ 3.4 Mpx, ≤ 4096 px a side), an arena of eight decodes only its fighters' pages, ≤ 9.5 MB on disk", () => {
    const dir = path.join(process.cwd(), "public", "sprites", "clank-dev-v2");
    const pages = new Map<string, number>();
    let disk = gzipSync(readFileSync(path.join(dir, "manifest.json"))).length; // JSON is served compressed
    for (const [k, f] of Object.entries(src.manifest.images)) {
      const img = src.images[k] as unknown as { width: number; height: number };
      expect(img.width, f).toBeLessThanOrEqual(4096);
      expect(img.height, f).toBeLessThanOrEqual(4096);
      pages.set(k, img.width * img.height);
      disk += statSync(path.join(dir, f)).size;
    }
    // every skeleton fits ONE page (a hero never needs two), and no page is a memory hog on a phone
    for (const rig of src.manifest.rigs ?? []) expect([...pages.keys()].filter((k) => new RegExp(`^${rig}-\\d+$`).test(k)), rig).toEqual([`${rig}-0`]);
    for (const [k, px] of pages) expect(px, k).toBeLessThan(3_400_000);
    // the worst arena — eight fighters on eight different skeletons — decodes ≤ 8 pages (measured: ≤ 25 Mpx; the whole library is ≈ 40 Mpx and is
    // never loaded at once by a browser — pages are fetched per skeleton on stage)
    const worst = [...pages.values()].sort((x, y) => y - x).slice(0, 8).reduce((n, x) => n + x, 0);
    expect(worst).toBeLessThan(26_000_000);
    expect(disk).toBeLessThan(9.5 * 1024 * 1024); // measured ≈ 9.0 MB for eighteen skeletons; one arena transfers the manifest (0.84 MB gzipped) + its pages
  });
});
