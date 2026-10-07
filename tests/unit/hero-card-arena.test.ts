import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { loadImage } from "@napi-rs/canvas";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CompareCards } from "@/components/admin/HeroVersionsPanel";
import { HeroCard, HeroCardCompact } from "@/components/hero/HeroCard";
import { RarityFrame } from "@/components/hero/rarity";
import { RARITIES, type Rarity } from "@/domain/character/appearance";
import type { HeroCardModel } from "@/domain/hero/card";
import {
  HERO_ARENA,
  HERO_CARD_BACKGROUND_DIR,
  HERO_CARD_BACKGROUND_FILES,
  getHeroCardBackground,
  heroArenaLayout,
  heroCardBackgroundFile,
} from "@/domain/hero/cardBackground";

/**
 * THE HERO CARD ARENA. The four uploaded rarity backgrounds are the card's visual identity: one authoritative rarity → file map, used as uploaded, fitted with
 * "cover", with a small hero standing in them — and no PWR band printed on a card. Every surface (web card, directory tile, admin reroll / rollback previews,
 * the server-rendered PNG — see tests/integration/hero-card-png.test.ts) resolves the image through that one map.
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const POWER: Record<Rarity, number> = { COMMON: 141, RARE: 158, EPIC: 181, LEGENDARY: 204 };

const model = (rarity: Rarity, over: Partial<HeroCardModel> = {}): HeroCardModel => ({
  publicId: "k7m2q9x4tb3d", name: "Baoskee", classId: "mage", className: "Mage", rarity, power: POWER[rarity], seasonRank: null,
  stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 },
  look: {
    rarity, parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 2, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.robe", weapon: "weapon.staff" } }, colors: ["#111111", "#222222", "#333333"], weapon: "staff", headgear: "hat", body: "robe",
  },
  ...over,
});

const PUBLIC = path.join(process.cwd(), "public");
const FILE = { COMMON: "common.webp", RARE: "rare.webp", EPIC: "epic.webp", LEGENDARY: "legendary.webp" } as const;

describe("rarity → arena background: ONE authoritative map", () => {
  it("COMMON → image 1, RARE → image 2, EPIC → image 4, LEGENDARY → image 3 (the uploaded order of the brief)", () => {
    expect(HERO_CARD_BACKGROUND_DIR).toBe("/hero-card-backgrounds");
    expect(HERO_CARD_BACKGROUND_FILES).toEqual(FILE);
    for (const r of RARITIES) expect(getHeroCardBackground(r)).toBe(`/hero-card-backgrounds/${FILE[r]}`);
    expect(Object.isFrozen(HERO_CARD_BACKGROUND_FILES)).toBe(true);
  });

  it("a missing or invalid rarity resolves to null (→ the neutral backdrop) — never to a path, never throws", () => {
    for (const bad of [undefined, null, "", "UNCOMMON", "common", "constructor", "__proto__", "toString", 42, {}, []]) {
      expect(getHeroCardBackground(bad), String(bad)).toBeNull();
      expect(heroCardBackgroundFile(bad), String(bad)).toBeNull();
    }
  });

  it("no component or renderer hard-codes an arena image path: only the shared map names the files", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /hero-card-backgrounds|(?:common|rare|epic|legendary)\.webp/.test(readFileSync(full, "utf8")) && !full.endsWith(path.join("domain", "hero", "cardBackground.ts"))) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

describe("the four arena images, exactly as uploaded", () => {
  // sha256 of the uploaded files (never processed, resized or made transparent): replacing one is a deliberate act that has to change this table.
  const APPROVED: Record<Rarity, { sha256: string; bytes: number }> = {
    COMMON: { sha256: "926db7c18267f5d7756d66404cdabbb2c2637a9d33c29efc50b58ead10ac790c", bytes: 420_490 },
    RARE: { sha256: "8ea9207bf31fd6e269dfead89e5b3e642752648a7c574e2a6361893703e61db4", bytes: 498_992 },
    EPIC: { sha256: "84a6cbdbebaf0af80c92dd95c3566416ccf1322ec0d5806f1d9eee0b2ad72e79", bytes: 450_352 },
    LEGENDARY: { sha256: "a0e3112d2fce85caf95f4396d182e71a3e630718dc10646e2d91445cae602a31", bytes: 387_208 },
  };

  it.each(RARITIES.map((r) => [r] as const))("%s: the file exists, is byte-identical to the upload, is a 1254 × 1254 WebP", async (rarity) => {
    const file = path.join(PUBLIC, getHeroCardBackground(rarity) as string);
    const bytes = readFileSync(file);
    expect(bytes.length).toBe(APPROVED[rarity].bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(APPROVED[rarity].sha256);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("latin1")).toBe("WEBP");
    const image = await loadImage(bytes);
    expect([image.width, image.height]).toEqual([1254, 1254]); // square: "cover" fits them to any frame by cropping, never stretching
  });

  it("the four are different pictures", () => {
    const hashes = new Set(RARITIES.map((r) => APPROVED[r].sha256));
    expect(hashes.size).toBe(4);
  });
});

describe("hero layout in the arena (shared by the web card, the tile and the PNG)", () => {
  it("web card (square frame): the image fills the frame, the hero is a small centred figure well inside the rim", () => {
    const layout = heroArenaLayout({ w: 408, h: 408 });
    expect(layout.image).toEqual({ x: 0, y: 0, size: 408 });
    expect(layout.hero.feetX).toBeCloseTo(204, 5); // centred
    const heroTop = layout.hero.feetY - layout.hero.height;
    expect(layout.hero.height).toBeCloseTo(408 * HERO_ARENA.heroHeight, 5);
    expect(layout.hero.height / 408).toBeLessThanOrEqual(0.3); // before: ≈ 0.6 of the frame
    expect(heroTop).toBeGreaterThan(408 * 0.15);
    expect(layout.hero.feetY).toBeLessThan(408 * 0.8);
    // the canvas that draws it is centred on the feet and its drawn hero lines up with the layout
    expect(layout.hero.canvasX + layout.hero.canvas / 2).toBeCloseTo(layout.hero.feetX, 5);
    expect(layout.hero.canvas * HERO_ARENA.canvas.heroOfCanvas).toBeCloseTo(layout.hero.height, 5);
  });

  it("the PNG art box (wide): the square image is covered and cropped (never stretched), the hero stands at the same spot of the ARENA", () => {
    const layout = heroArenaLayout({ w: 980, h: 560 });
    expect(layout.image.size).toBe(980); // covers the longer side
    expect(layout.image.x).toBe(0);
    expect(layout.image.y).toBeCloseTo((560 - 980) / 2, 5); // centred crop: the middle band of the arena stays in view
    expect(layout.hero.height / 980).toBeCloseTo(HERO_ARENA.heroHeight, 5); // same size relative to the arena as on the web card
    expect((layout.hero.feetY - layout.image.y) / 980).toBeCloseTo(HERO_ARENA.feet.y, 5); // the same floor position inside the arena image
    expect(layout.hero.feetY - layout.hero.height).toBeGreaterThan(560 * 0.1); // full body, not touching the top edge
    expect(layout.hero.feetY).toBeLessThan(560 * 0.9); // …nor the bottom edge
  });

  it("a thumbnail can enlarge the hero without moving its feet", () => {
    const base = heroArenaLayout({ w: 188, h: 188 });
    const tile = heroArenaLayout({ w: 188, h: 188 }, { heroScale: 1.4 });
    expect(tile.hero.height).toBeCloseTo(base.hero.height * 1.4, 5);
    expect(tile.hero.feetX).toBe(base.hero.feetX);
    expect(tile.hero.feetY).toBe(base.hero.feetY);
    expect(tile.hero.feetY - tile.hero.height).toBeGreaterThan(188 * 0.1);
  });
});

describe("the hero card shows its rarity's arena — and no PWR band", () => {
  it.each(RARITIES.map((r) => [r] as const))("%s: its own image, as a decorative cover background; the hero keeps its accessible name", (rarity) => {
    const out = render(createElement(HeroCard, { model: model(rarity) }));
    expect(out).toContain('data-arena="image"');
    expect(out).toContain(`data-arena-background="/hero-card-backgrounds/${FILE[rarity]}"`);
    expect(out).toContain(`background-image:url(/hero-card-backgrounds/${FILE[rarity]})`);
    for (const other of RARITIES.filter((r) => r !== rarity)) expect(out).not.toContain(FILE[other]); // never another rarity's image
    expect(out).toMatch(/<span class="rarity-arena" aria-hidden="true"/); // decorative: no alt-text noise, no <img> that could show a broken icon
    expect(out).not.toMatch(/<img\b/);
    expect(out).toContain(`aria-label="Baoskee, ${rarity[0]}${rarity.slice(1).toLowerCase()} Mage"`); // the hero art still has a meaningful name
    expect(out).toContain('data-testid="hero-arena"');
  });

  it("the tier / range line is gone from every rarity — PWR, rarity badge, class and the seven stats stay", () => {
    for (const rarity of RARITIES) {
      const out = render(createElement(HeroCard, { model: model(rarity) }));
      const t = text(out);
      expect(out).not.toContain("hero-card-tier");
      expect(t).not.toMatch(/tier\s*·/i);
      expect(t).not.toMatch(/\b(130|150|170|190)\s*[–-]\s*(149|169|189|209)\b/);
      expect(t).not.toMatch(/\bCommon tier|Rare tier|Epic tier|Legendary tier\b/);
      expect(out).toContain('data-testid="rarity-badge"');
      expect(out).toContain('data-testid="hero-card-class"');
      expect(out).toContain(`data-pwr="${POWER[rarity]}"`);
      for (const stat of ["HP", "STR", "DEF", "INT", "AGI", "CHA", "LUCK"]) expect(t).toContain(stat);
    }
  });

  it("the arena frame is square (like the images) and the hero is drawn without its own opaque backdrop", () => {
    const out = render(createElement(HeroCard, { model: model("EPIC") }));
    expect(out).toContain("aspect-ratio:1");
    expect(out).toContain("data-arena-hero");
    expect(out).toContain("data-arena-shadow"); // the contact shadow grounds the figure
  });

  it("rendering is deterministic: the same card is the same markup", () => {
    expect(render(createElement(HeroCard, { model: model("RARE") }))).toBe(render(createElement(HeroCard, { model: model("RARE") })));
  });

  it("the directory tile stands in the same arena", () => {
    for (const rarity of RARITIES) {
      const out = render(createElement(HeroCardCompact, { model: model(rarity) }));
      expect(out).toContain(`data-arena-background="/hero-card-backgrounds/${FILE[rarity]}"`);
      expect(out).toContain('data-testid="hero-tile"');
      expect(text(out)).not.toMatch(/tier\s*·/i);
    }
  });
});

describe("the frame's fallback", () => {
  it("without `arena` (avatars, rows, the docs swatch) nothing changes: no image layer, no arena attribute", () => {
    const out = render(createElement(RarityFrame, { rarity: "LEGENDARY", compact: true }, "x"));
    expect(out).not.toContain("rarity-arena");
    expect(out).not.toContain("data-arena");
  });

  it("an unknown rarity with `arena` keeps the neutral backdrop: no image, no <img>, no crash", () => {
    const out = render(createElement(RarityFrame, { rarity: "BOGUS" as Rarity, arena: true }, "x"));
    expect(out).toContain('data-arena="fallback"');
    expect(out).not.toContain("rarity-arena");
    expect(out).not.toMatch(/<img\b|url\(/);
  });
});

describe("admin previews: the background follows the rarity of the version shown", () => {
  const arenaOf = (html: string) => [...html.matchAll(/data-arena-background="\/hero-card-backgrounds\/([a-z]+\.webp)"/g)].map((m) => m[1]);

  it("reroll preview: CURRENT and NEW each get their own arena, and a rarity change changes the background", () => {
    const transitions: Array<[Rarity, Rarity]> = [["COMMON", "RARE"], ["RARE", "EPIC"], ["EPIC", "COMMON"], ["COMMON", "LEGENDARY"], ["LEGENDARY", "LEGENDARY"]];
    for (const [from, to] of transitions) {
      const out = render(createElement(CompareCards, { current: model(from), next: model(to) }));
      expect(arenaOf(out), `${from}→${to}`).toEqual([FILE[from], FILE[to]]);
      expect(text(out)).not.toMatch(/tier\s*·/i);
    }
  });

  it("rollback preview: the OLD version's card uses the OLD rarity's arena, not the current one", () => {
    const current = model("EPIC");
    const v1 = model("COMMON", { power: 139 });
    const out = render(createElement(CompareCards, { current, next: v1, nextLabel: "v1" }));
    expect(arenaOf(out)).toEqual(["epic.webp", "common.webp"]);
    expect(out).toContain(">v1<");
  });
});
