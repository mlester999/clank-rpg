import { describe, expect, it } from "vitest";

import { RARITIES } from "@/domain/character/appearance";
import {
  CARD_NAME_MAX, CARD_STATS, cardKey, cardText, formatPower, heroSocialMeta, rarityClassLine, shareText, xIntentUrl, type HeroCardModel,
} from "@/domain/hero/card";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { RARITY_VISUALS } from "@/domain/hero/rarityVisuals";
import { PUBLIC_HERO_ID_PATTERN, heroCardImagePath, heroPath, heroUrl, isPublicHeroId } from "@/domain/hero/publicId";
import { imageName } from "@/server/heroes/cardImage";

const base: HeroCardModel = {
  publicId: "k7m2q9x4tb3d", name: "Marky", classId: "mage", className: "Mage", rarity: "LEGENDARY", power: 1234,
  stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 }, seasonRank: null,
  look: {
    rarity: "LEGENDARY", parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 1, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.light", weapon: "weapon.staff" } }, colors: ["#111111", "#222222", "#333333"], weapon: "staff", headgear: "hat", body: "light",
  },
};

describe("public hero id", () => {
  it("is 12 symbols from a 31-symbol alphabet with no 0/1/i/l/o — and nothing else is accepted", () => {
    expect(isPublicHeroId("k7m2q9x4tb3d")).toBe(true);
    for (const bad of ["", "k7m2q9x4tb3", "k7m2q9x4tb3dd", "K7M2Q9X4TB3D", "k7m2q9x4tb30", "k7m2q9x4tb3l", "k7m2q9x4tb3o", "k7m2q9x4tb3i", "../etc/passwd", "k7m2q9x4tb3d?x=1", "5530802189", "00000000-0000-4000-8000-000000000000", null, undefined, 42]) expect(isPublicHeroId(bad)).toBe(false);
    expect(PUBLIC_HERO_ID_PATTERN.test("2222222222zz")).toBe(true);
  });
  it("builds canonical paths and URLs without ever including a name or a Telegram handle", () => {
    expect(heroPath("k7m2q9x4tb3d")).toBe("/heroes/k7m2q9x4tb3d");
    expect(heroUrl("https://clankrpg.example/", "k7m2q9x4tb3d")).toBe("https://clankrpg.example/heroes/k7m2q9x4tb3d");
    expect(heroUrl("https://clankrpg.example", "k7m2q9x4tb3d")).toBe("https://clankrpg.example/heroes/k7m2q9x4tb3d");
    expect(heroCardImagePath("k7m2q9x4tb3d", "abc123")).toBe("/api/hero-cards/k7m2q9x4tb3d?v=abc123");
  });
});

describe("rarity dresses the card from the ONE shared visual table — and the card shows the hero's own numbers", () => {
  it("has a distinct visual treatment per rarity, with the rarer ones richer (shape and intensity, not colour alone)", () => {
    const v = RARITIES.map((r) => RARITY_VISUALS[r]);
    expect(new Set(v.map((x) => x.colors.base)).size).toBe(4);
    expect(v.map((x) => x.tier)).toEqual([0, 1, 2, 3]);
    expect(v.map((x) => x.label)).toEqual(RARITIES.map((r) => RARITY_RULES[r].label));
    expect(new Set(v.map((x) => x.badge.icon)).size).toBe(4); // four different badge SHAPES
    expect(new Set(v.map((x) => x.frame.style)).size).toBe(4); // four different frame styles
    for (let i = 1; i < v.length; i++) expect(v[i]!.arena.intensity).toBeGreaterThan(v[i - 1]!.arena.intensity);
  });
  it("the stats and PWR shown are the model's own (the card never recomputes them): changing only the rarity changes the key but not one number", () => {
    const keys = new Set<string>();
    for (const rarity of RARITIES) {
      const m = { ...base, rarity, look: { ...base.look, rarity } };
      expect(m.stats).toEqual(base.stats);
      expect(m.power).toBe(base.power);
      keys.add(cardKey(m));
    }
    expect(keys.size).toBe(4);
    expect(CARD_STATS.map((s) => s.label)).toEqual(["HP", "STR", "DEF", "INT", "AGI", "CHA", "LUCK"]);
  });
});

describe("card key (cache busting)", () => {
  it("is stable for identical content and changes whenever anything shown changes", () => {
    expect(cardKey(base)).toBe(cardKey({ ...base }));
    expect(cardKey(base)).toMatch(/^[0-9a-f]{12}$/);
    const variants: HeroCardModel[] = [
      { ...base, name: "Marky2" }, { ...base, power: 1235 }, { ...base, classId: "tank" }, { ...base, stats: { ...base.stats, hp: 121 } },
      { ...base, look: { ...base.look, sprite: { ...base.look.sprite, hue: 5 } } }, { ...base, seasonRank: "Silver" },
    ];
    for (const v of variants) expect(cardKey(v)).not.toBe(cardKey(base));
  });
  it("does not depend on the public id (the same look under another id is the same picture)", () => {
    expect(cardKey({ ...base, publicId: "222222222222" })).toBe(cardKey(base));
  });
  it("changes with the sprite set the art is drawn from — a renderer switch must never serve the old drawing from an immutable cache", () => {
    const v1 = { ...base, look: { ...base.look, spriteSet: "clank-dev-v1" } };
    const v2 = { ...base, look: { ...base.look, spriteSet: "clank-dev-v2" } };
    expect(cardKey(v1)).not.toBe(cardKey(v2));
    expect(cardKey(v2)).toBe(cardKey({ ...v2, look: { ...v2.look } }));
  });
});

describe("SHARE TO X", () => {
  it("prepares the copy from public facts only and puts the canonical URL in the url parameter", () => {
    expect(shareText(base)).toBe("My Clank RPG hero\n\nMarky\nLegendary Mage\nPWR 1,234");
    const url = heroUrl("https://clankrpg.example", base.publicId);
    const intent = new URL(xIntentUrl(base, url));
    expect(intent.origin + intent.pathname).toBe("https://x.com/intent/post");
    expect(intent.searchParams.get("text")).toBe(shareText(base));
    expect(intent.searchParams.get("url")).toBe(url);
    expect([...intent.searchParams.keys()].sort()).toEqual(["text", "url"]); // nothing else — no tracking, no ids
  });
  it("never carries an internal id, a Telegram id or a seed (it only knows what the card shows)", () => {
    const text = decodeURIComponent(xIntentUrl({ ...base, name: "A" }, heroUrl("https://x.example", base.publicId)));
    expect(text).not.toMatch(/telegram|seed|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
  it("rarity class line and PWR formatting", () => {
    expect(rarityClassLine(base)).toBe("Legendary Mage");
    expect(formatPower(1234567)).toBe("1,234,567");
    expect(formatPower(-5)).toBe("0");
  });
});

describe("OPEN GRAPH metadata", () => {
  it("title / description / canonical / image — the image URL carries the card's content key", () => {
    const meta = heroSocialMeta(base, "https://clankrpg.example/");
    expect(meta.title).toBe("Marky's Legendary Mage | Clank RPG");
    expect(meta.description).toContain("Legendary Mage");
    expect(meta.description).toContain("PWR 1,234");
    expect(meta.url).toBe("https://clankrpg.example/heroes/k7m2q9x4tb3d");
    expect(meta.imageUrl).toBe(`https://clankrpg.example/api/hero-cards/k7m2q9x4tb3d?v=${cardKey(base)}`);
  });
  it("a different card gets a different image URL — a reroll can never leave a stale social card behind", () => {
    expect(heroSocialMeta({ ...base, power: 999, rarity: "COMMON" }, "https://a.example").imageUrl).not.toBe(heroSocialMeta(base, "https://a.example").imageUrl);
  });
});

describe("display strings are sanitised", () => {
  it("strips control, bidi and zero-width characters and markup, collapses spaces, clips by grapheme", () => {
    expect(cardText("  Mar‮ky​ <b>x</b>\t\n  `code`  ", 40)).toBe("Marky bx/b code");
    expect(cardText("\u0000\u0007hi", 10)).toBe("hi");
    expect(cardText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(cardText("👨‍👩‍👧‍👦".repeat(60), 5).endsWith("…")).toBe(true);
    expect(Array.from(cardText("y".repeat(500), CARD_NAME_MAX)).length).toBeLessThanOrEqual(CARD_NAME_MAX);
    expect(cardText(undefined, 5)).toBe("");
  });
  it("the PNG name keeps what the bundled font can draw and falls back to 'Clank Hero' when nothing drawable is left", () => {
    expect(imageName("Marky 🥰 the Great")).toBe("Marky the Great");
    expect(imageName("Žofia Ñandú")).toBe("Žofia Ñandú");
    expect(imageName("🥰🥰")).toBe("Clank Hero");
    expect(imageName("Привет")).toBe("Clank Hero");
    expect(imageName("<script>alert(1)</script>")).toBe("scriptalert(1)/script");
    expect(imageName("‮evil")).toBe("evil");
  });
});
