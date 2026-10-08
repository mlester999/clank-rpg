import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { beforeAll, describe, expect, it } from "vitest";

import { getHeroSheet, HeroSheet, type CanvasFactory, type SpriteSource } from "@/components/sprites/compositor";
import { drawHero, IDLE_POSE } from "@/components/hero/drawHero";
import { lookFor } from "@/components/hero/look";
import { drawHeroSprite, playbackFor } from "@/components/sprites/draw";
import { classVisuals } from "@/server/services/views";
import { rollAppearance } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { COSMETIC_ITEMS } from "@/domain/sprites/catalog";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { parseManifest, type SpriteManifest } from "@/domain/sprites/spec";
import { createRng } from "@/domain/util/rng";
import { validateSpriteSet } from "../../scripts/lib/validateSprites";

/**
 * Tests against the SHIPPED dev sprite set, exercising the real runtime compositor in Node.
 * If these fail with "cannot read manifest", run `pnpm sprites:build`.
 */

/** Every shipped set is held to the same bar: v1 (kept, selectable) and hero renderer v2 (the default). */
const SPRITE_SETS = ["clank-dev-v1", "clank-dev-v2"] as const;
const factory: CanvasFactory = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement;
const pixels = (c: HTMLCanvasElement): Uint8ClampedArray => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
const hashOf = (c: HTMLCanvasElement): string => Buffer.from(pixels(c).buffer).toString("base64").length + ":" + Buffer.from(pixels(c)).reduce((a, b, i) => (a * 31 + b + i) >>> 0, 7);
const opaque = (c: HTMLCanvasElement): number => { let n = 0; const d = pixels(c); for (let i = 3; i < d.length; i += 4) if (d[i]! > 8) n++; return n; };

const cls = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!;
const configFor = (id: string, seed = "t", rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" = "COMMON") => {
  const c = cls(id);
  return deriveSpriteConfig(rollAppearance(createRng(`${seed}-${id}`), c, rarity), c.look);
};
describe.each(SPRITE_SETS)("sprite set %s", (SET) => {
  let src: SpriteSource;
  beforeAll(async () => {
    const dir = path.join(process.cwd(), "public", "sprites", SET);
    const manifest = parseManifest(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")));
    const images: SpriteSource["images"] = {};
    for (const [k, f] of Object.entries(manifest.images)) images[k] = (await loadImage(path.join(dir, f))) as unknown as CanvasImageSource;
    src = { manifest, images, factory };
  });

  const hero = (id: string, seed = "t", rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY" = "COMMON") => {
    const c = cls(id);
    const config = configFor(id, seed, rarity);
    return { cls: c, config, sheet: new HeroSheet(src, config, c.look.colors, rarity) };
  };

  describe("the shipped dev sprite set", () => {
    it("passes the sprite validator: valid manifest, atlases big enough, no clipped art, full catalogue coverage", async () => {
      const r = await validateSpriteSet(SET, { strict: true });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.stats.cellsChecked).toBeGreaterThan(1500);
    });

    it("is honestly labelled as placeholder art, not production art", () => {
      expect(src.manifest.status).toBe("dev-placeholder");
      expect(src.manifest.credits).toMatch(/placeholder/i);
    });

    it("covers every enabled catalogue item with a layer on the standard grid", () => {
      for (const item of COSMETIC_ITEMS.filter((i) => i.enabled)) expect(src.manifest.layers[item.id], item.id).toBeDefined();
    });

    it("supports every required animation state (idle, move, attack, skill, hit, ko) plus victory", () => {
      for (const k of ["idle", "move", "attack_slash", "attack_thrust", "attack_shoot", "skill", "hit", "ko", "victory"] as const) expect(src.manifest.clips[k], k).toBeDefined();
    });

    it("uses one consistent frame size for every layer (so any combination aligns)", () => {
      // v1: 80 × 64 blocks. v2: 96 × 80 (headroom for crests, wings, a brute's greatsword and a warden's longbow), every layer PACKED per skeleton.
      expect(src.manifest.frame).toEqual(SET === "clank-dev-v1" ? { w: 80, h: 64 } : { w: 96, h: 80 });
      const images = new Set(Object.values(src.manifest.layers).filter((l) => !l.loop).flatMap((l) => (l.cells ? Object.values(l.cells).flatMap((rows) => rows.filter(Boolean).map((r) => r![0])) : [`${l.image}`])));
      expect(images.size).toBeGreaterThan(1); // several atlases, one grid
    });
  });

  describe("compositing a hero (real runtime code)", () => {
    it("composites every clip of every class into non-empty strips of the right size", () => {
      for (const c of DEFAULT_CLASSES) {
        const { sheet } = hero(c.id);
        expect(sheet.needsFallback, c.id).toBe(false);
        for (const [clip, def] of Object.entries(src.manifest.clips)) {
          // a packed set draws each class skeleton with its OWN attack only (a class never plays the others)
          if (src.manifest.rigs && clip.startsWith("attack_") && clip !== sheet.plan.attackClip) continue;
          const strip = sheet.strip(clip as never)!;
          expect(strip.width, `${c.id}/${clip}`).toBe(def!.frames * src.manifest.frame.w);
          expect(strip.height).toBe(src.manifest.frame.h);
          expect(opaque(strip), `${c.id}/${clip}`).toBeGreaterThan(300);
        }
      }
    });

    it("is deterministic: the same config always renders the same pixels", () => {
      const a = hero("warrior", "same");
      const b = hero("warrior", "same");
      expect(a.config).toEqual(b.config);
      for (const clip of ["idle", "attack_slash", "ko"] as const) expect(hashOf(a.sheet.strip(clip)!)).toBe(hashOf(b.sheet.strip(clip)!));
    });

    it("different heroes of one class look different (skin / hair / outfit hue are real parameters)", () => {
      const hashes = new Set(Array.from({ length: 12 }, (_, i) => hashOf(hero("rogue", `variety-${i}`).sheet.strip("idle")!)));
      expect(hashes.size).toBeGreaterThanOrEqual(11);
    });

    it("the six classes are visibly different at a glance, for any hero (silhouette AND colour)", () => {
      // Thresholds come from measurement over 5 seeds × 15 class pairs: the closest pair (warrior vs
      // tank, both helmed melee) differs by ≥ 118 silhouette px and ≥ 645 visibly different px.
      const { w: FW, h: FH } = src.manifest.frame;
      for (const seed of ["a", "b", "c", "d", "e"]) {
        const frames = DEFAULT_CLASSES.map((c) => hero(c.id, seed).sheet.strip("idle")!.getContext("2d")!.getImageData(0, 0, FW, FH).data); // frame 0 of the idle strip
        for (let i = 0; i < frames.length; i++) {
          for (let j = i + 1; j < frames.length; j++) {
            let silhouette = 0;
            let visible = 0;
            for (let k = 0; k < FW * FH; k++) {
              const a = frames[i]![k * 4 + 3]! > 8;
              const b = frames[j]![k * 4 + 3]! > 8;
              if (a !== b) silhouette++;
              if (a || b) {
                const d = [0, 1, 2].reduce((acc, ch) => acc + Math.abs(frames[i]![k * 4 + ch]! - frames[j]![k * 4 + ch]!), 0);
                if (d > 60 || a !== b) visible++;
              }
            }
            const pair = `${seed}: ${DEFAULT_CLASSES[i]!.id} vs ${DEFAULT_CLASSES[j]!.id}`;
            expect(silhouette, pair).toBeGreaterThan(80);
            expect(visible, pair).toBeGreaterThan(400);
          }
        }
      }
    });

    it("rarity dresses the hero: an aura appears for Rare+ configs and the class kit is unchanged", () => {
      const common = hero("mage", "flair", "COMMON");
      const legend = hero("mage", "flair", "LEGENDARY");
      expect(common.sheet.aura()).toBeNull();
      expect(legend.sheet.aura()).not.toBeNull();
      expect(legend.config.slots.weapon).toBe(common.config.slots.weapon);
      expect(legend.config.slots.outfit).toBe(common.config.slots.outfit);
    });

    it("tinted layers take the palette colour (skin) and untinted layers are left as authored", () => {
      const c = cls("warrior");
      const base = deriveSpriteConfig(rollAppearance(createRng("skin"), c, "COMMON"), c.look);
      const pale = new HeroSheet(src, { ...base, skin: 0 }, c.look.colors, "COMMON");
      const dark = new HeroSheet(src, { ...base, skin: 5 }, c.look.colors, "COMMON");
      expect(hashOf(pale.strip("idle")!)).not.toBe(hashOf(dark.strip("idle")!));
      expect(pale.palette.skin).toBe("#f6d9bd");
      expect(dark.palette.skin).toBe("#573a2a");
    });

    it("caches composed heroes: identical visuals share one sheet", () => {
      const c = cls("tank");
      const cfg = deriveSpriteConfig(rollAppearance(createRng("cache"), c, "COMMON"), c.look);
      expect(getHeroSheet(src, cfg, c.look.colors, "COMMON")).toBe(getHeroSheet(src, cfg, c.look.colors, "COMMON"));
      expect(getHeroSheet(src, cfg, c.look.colors, "EPIC")).not.toBe(getHeroSheet(src, cfg, c.look.colors, "COMMON"));
    });

    it("draws through the real draw path (selects the weapon's attack clip) without throwing", () => {
      const { sheet, cls: c } = hero("ranger");
      const target = factory(400, 300);
      const ctx = target.getContext("2d") as unknown as CanvasRenderingContext2D;
      ctx.translate(200, 250);
      const input = { alive: true, moving: false, victory: false, stunned: false, sinceAttackMs: 40, sinceSkillMs: Infinity, sinceHurtMs: Infinity, sinceKoMs: null, loopClockMs: 0 };
      const pb = playbackFor(sheet, src, input);
      expect(pb).toMatchObject({ state: "ATTACK", clip: "attack_shoot" }); // archers shoot
      expect(drawHeroSprite(ctx, src, sheet, { playback: pb, direction: "left", flash: 0.6, chill: true }, 140)).toBe(true);
      expect(opaque(target)).toBeGreaterThan(1500);
      void c;
    });
  });

  describe("missing assets degrade, they do not break", () => {
    const strip = (m: SpriteManifest, c: SpriteConfig) => new HeroSheet({ ...src, manifest: m }, c, cls("warrior").look.colors, "COMMON");
    const warriorCfg = configFor("warrior", "gap");

    it("a missing optional layer is skipped: the hero still renders, minus that layer", () => {
      const full = hero("warrior", "gap").sheet;
      const m = structuredClone(src.manifest);
      const hairId = warriorCfg.slots.hair;
      if (hairId) delete m.layers[hairId];
      delete m.layers["cape.default"];
      const partial = strip(m, { ...warriorCfg, slots: { ...warriorCfg.slots, hair: hairId ?? "hair.0", cape: "cape.default", headgear: "headgear.cap" } });
      expect(partial.needsFallback).toBe(false);
      expect(partial.plan.missing).toEqual(expect.arrayContaining(["cape.default"]));
      expect(opaque(partial.strip("idle")!)).toBeGreaterThan(300);
      expect(full.needsFallback).toBe(false);
    });

    it("a missing OUTFIT flags the vector fallback instead of drawing a naked, classless hero", () => {
      const m = structuredClone(src.manifest);
      delete m.layers[warriorCfg.slots.outfit!];
      expect(strip(m, warriorCfg).needsFallback).toBe(true);
    });

    it("an atlas image that failed to load skips just its layers (no crash)", () => {
      if (!src.manifest.rigs) {
        const broken: SpriteSource = { ...src, images: { ...src.images, weapons: undefined } };
        const sheet = new HeroSheet(broken, warriorCfg, cls("warrior").look.colors, "COMMON");
        expect(opaque(sheet.strip("idle")!)).toBeGreaterThan(300); // body + outfit still drawn
        const full = hero("warrior", "gap").sheet;
        expect(opaque(sheet.strip("idle")!)).toBeLessThan(opaque(full.strip("idle")!)); // weapon is gone
        return;
      }
      // a packed set keeps each class skeleton on its own page: a lost aura atlas costs a Rare hero its aura, never the hero
      const rare = configFor("warrior", "gap", "RARE");
      const broken: SpriteSource = { ...src, images: { ...src.images, auras: undefined } };
      const sheet = new HeroSheet(broken, rare, cls("warrior").look.colors, "RARE");
      expect(sheet.aura()).toBeNull();
      expect(opaque(sheet.strip("idle")!)).toBe(opaque(new HeroSheet(src, rare, cls("warrior").look.colors, "RARE").strip("idle")!));
      // and a lost class page costs only that class: another class still draws in full
      const page = Object.keys(src.manifest.images).find((k) => k.startsWith("warrior-"))!;
      const noWarrior: SpriteSource = { ...src, images: { ...src.images, [page]: undefined } };
      const mage = configFor("mage", "gap");
      expect(opaque(new HeroSheet(noWarrior, mage, cls("mage").look.colors, "COMMON").strip("idle")!)).toBe(opaque(hero("mage", "gap").sheet.strip("idle")!));
      expect(() => new HeroSheet(noWarrior, warriorCfg, cls("warrior").look.colors, "COMMON").strip("idle")).not.toThrow();
    });

    it("an unknown clip yields no strip rather than throwing", () => {
      const m = structuredClone(src.manifest);
      delete m.clips.victory;
      expect(strip(m, warriorCfg).strip("victory")).toBeNull();
    });
  });
});

describe("the vector fallback hero (what shows when a sprite set is unavailable)", () => {
  it("still draws every class, every rarity — a hero is never invisible", () => {
    const visuals = classVisuals(DEFAULT_CLASSES);
    for (const c of DEFAULT_CLASSES) {
      for (const rarity of ["COMMON", "LEGENDARY"] as const) {
        const look = lookFor({ rarity, parts: rollAppearance(createRng(`fb-${c.id}`), c, rarity) }, visuals[c.id]);
        const target = factory(160, 160);
        const ctx = target.getContext("2d") as unknown as CanvasRenderingContext2D;
        ctx.translate(80, 140);
        drawHero(ctx, look, { ...IDLE_POSE, t: 0.4 });
        expect(opaque(target), `${c.id}/${rarity}`).toBeGreaterThan(1500);
      }
    }
  });

  it("lookFor resolves the same look the server would (and never throws on junk appearance data)", () => {
    const visuals = classVisuals(DEFAULT_CLASSES);
    const parts = rollAppearance(createRng("lf"), cls("mage"), "EPIC");
    const appearance = { rarity: "EPIC", parts };
    const a = lookFor(appearance, visuals.mage);
    expect(a.sprite).toEqual(deriveSpriteConfig(parts, cls("mage").look, "EPIC")); // a generator-2 hero keeps its rarity layers even when its look must be derived
    expect(a.sprite.slots.trim).toBe("trim.epic.robe");
    expect(lookFor(appearance, visuals.mage)).toBe(a); // memoised per appearance object (the arena re-renders often)
    expect(() => lookFor({ rarity: "???", parts: {}, sprite: "junk", overrides: 7 }, undefined)).not.toThrow();
  });
});

describe("a replacement sprite set of a DIFFERENT size works with no code change", () => {
  /** A tiny set with 24×32 frames built in memory: mid-grey body (tinted by skin) + a pure-red untinted outfit. */
  function tinySet(): SpriteSource {
    const fw = 24;
    const fh = 32;
    const rows = 6;
    const body = createCanvas(fw * 2, fh * rows);
    const bg = body.getContext("2d");
    bg.fillStyle = "#808080";
    const outfit = createCanvas(fw * 2, fh * rows);
    const og = outfit.getContext("2d");
    og.fillStyle = "#ff0000";
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < 2; c++) {
        bg.fillRect(c * fw + 4, r * fh + 4, 10, 20);
        og.fillRect(c * fw + 6, r * fh + 10, 6, 6);
      }
    }
    const manifest = parseManifest({
      spec: 1, id: "tiny-test", name: "Tiny", status: "production", frame: { w: fw, h: fh }, anchor: { x: 12, y: 30 }, nominalHeightPx: 26,
      images: { a: "a.png", o: "o.png" },
      clips: {
        idle: { row: 0, frames: 2, fps: 4, loop: true }, move: { row: 1, frames: 2, fps: 8, loop: true },
        attack_slash: { row: 2, frames: 2, fps: 8, loop: false }, skill: { row: 3, frames: 2, fps: 8, loop: false },
        hit: { row: 4, frames: 1, fps: 8, loop: false }, ko: { row: 5, frames: 1, fps: 8, loop: false },
      },
      directions: { right: { index: 0 }, left: { mirror: "right" } },
      layers: { "body.base": { image: "a", x: 0, y: 0, z: 1, tint: "skin" }, "outfit.medium": { image: "o", x: 0, y: 0, z: 2, tint: null } },
    });
    return { manifest, images: { a: body as unknown as CanvasImageSource, o: outfit as unknown as CanvasImageSource }, factory };
  }

  it("composites, tints and draws at its own frame size", () => {
    const set = tinySet();
    const cfg: SpriteConfig = { v: 1, catalog: 1, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.medium" } };
    const sheet = new HeroSheet(set, cfg, ["#c8483a", "#e8c28a", "#7d2a22"], "COMMON");
    expect(sheet.needsFallback).toBe(false);
    const idle = sheet.strip("idle")!;
    expect(idle.width).toBe(48); // 2 frames × 24
    expect(idle.height).toBe(32);
    const px = (x: number, y: number) => Array.from(idle.getContext("2d")!.getImageData(x, y, 1, 1).data);
    // mid-grey × skin tint (hard-light) ⇒ the exact skin colour #f6d9bd
    const body = px(5, 5);
    expect(Math.abs(body[0]! - 0xf6)).toBeLessThanOrEqual(3);
    expect(Math.abs(body[1]! - 0xd9)).toBeLessThanOrEqual(3);
    expect(Math.abs(body[2]! - 0xbd)).toBeLessThanOrEqual(3);
    expect(px(7, 11)).toEqual([255, 0, 0, 255]); // untinted outfit is drawn exactly as authored, on top
    expect(px(20, 2)[3]).toBe(0); // outside the art stays transparent
    // draw scales so the sprite's nominal height equals the requested height
    const target = factory(200, 200);
    const ctx = target.getContext("2d") as unknown as CanvasRenderingContext2D;
    ctx.translate(100, 190);
    expect(drawHeroSprite(ctx, set, sheet, { playback: { state: "IDLE", clip: "idle", frame: 0, progress: 0 }, direction: "right" }, 104)).toBe(true);
    expect(opaque(target)).toBeGreaterThan(500);
  });
});
