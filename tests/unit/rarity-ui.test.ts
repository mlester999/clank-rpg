import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PowerCompare, StatDiff } from "@/components/admin/HeroVersionsPanel";
import { HeroCard, HeroCardCompact } from "@/components/hero/HeroCard";
import { PwrDelta, PwrValue, RarityBadge, RarityFrame, RarityIcon } from "@/components/hero/rarity";
import { RARITIES, type Rarity } from "@/domain/character/appearance";
import type { HeroCardModel } from "@/domain/hero/card";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { RARITY_VISUALS } from "@/domain/hero/rarityVisuals";

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const model = (rarity: Rarity, power: number, over: Partial<HeroCardModel> = {}): HeroCardModel => ({
  publicId: "k7m2q9x4tb3d", name: "Forge Fay", classId: "mage", className: "Mage", rarity, power, seasonRank: null,
  stats: { hp: 120, str: 8, def: 7, int: 22, agi: 10, cha: 9, luck: 11 },
  look: {
    rarity, parts: { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 },
    sprite: { v: 1, catalog: 2, skin: 0, hairColor: 0, hue: 0, slots: { outfit: "outfit.robe", weapon: "weapon.staff" } }, colors: ["#111111", "#222222", "#333333"], weapon: "staff", headgear: "hat", body: "robe",
  },
  ...over,
});

describe("rarity badge — never colour alone", () => {
  it("each tier has its own NAME and its own SHAPE (dot · diamond · star · crown)", () => {
    const icons = RARITIES.map((r) => /data-rarity-icon="([a-z]+)"/.exec(render(createElement(RarityBadge, { rarity: r })))![1]);
    expect(icons).toEqual(["dot", "diamond", "star", "crown"]);
    for (const r of RARITIES) {
      const out = render(createElement(RarityBadge, { rarity: r }));
      expect(text(out)).toBe(RARITY_RULES[r].label);
      expect(out).toContain(`data-rarity="${r}"`);
      expect(out).toContain('data-testid="rarity-badge"');
      expect(out).toContain(`title="${RARITY_RULES[r].label} rarity"`);
    }
    expect(new Set(RARITIES.map((r) => RARITY_VISUALS[r].badge.icon)).size).toBe(4);
  });

  it("is readable at every size down to a leaderboard row", () => {
    for (const size of ["xs", "sm", "md", "lg"] as const) expect(render(createElement(RarityBadge, { rarity: "EPIC", size }))).toContain("Epic");
    expect(render(createElement(RarityIcon, { rarity: "LEGENDARY" }))).toContain('aria-hidden="true"');
  });
});

describe("PWR is one of the biggest things shown", () => {
  it("PwrValue shows the exact number, large, with its caption", () => {
    const out = render(createElement(PwrValue, { power: 1234.4, rarity: "LEGENDARY", size: "xl" }));
    expect(out).toContain('data-pwr="1234"');
    expect(text(out)).toBe("PWR 1,234");
    expect(out).toContain("text-6xl"); // the xl size is the biggest type in the app
    expect(out).toContain('aria-label="Power 1234"');
    expect(render(createElement(PwrValue, { power: 143, rarity: "RARE", size: "sm", inline: true }))).toContain("items-baseline");
  });

  it("PwrDelta spells the change out with a sign AND an arrow (not colour alone)", () => {
    const up = render(createElement(PwrDelta, { delta: 33 }));
    const down = render(createElement(PwrDelta, { delta: -18 }));
    const same = render(createElement(PwrDelta, { delta: 0 }));
    expect(text(up)).toBe("▲ +33");
    expect(up).toContain('data-direction="up"');
    expect(text(down)).toBe("▼ −18");
    expect(down).toContain('data-direction="down"');
    expect(text(same)).toBe("＝ 0");
    expect(same).toContain('data-direction="same"');
  });
});

describe("rarity frame", () => {
  it("a different frame STYLE and corner ornament per tier; the compact (avatar) variant drops the ornaments but keeps the style", () => {
    const frames = RARITIES.map((r) => render(createElement(RarityFrame, { rarity: r }, "x")));
    expect(frames.map((f) => /data-frame="([a-z]+)"/.exec(f)![1])).toEqual(["plain", "bevel", "double", "ornate"]);
    expect(frames.map((f) => /data-tier="(\d)"/.exec(f)![1])).toEqual(["0", "1", "2", "3"]);
    expect(frames.map((f) => /data-frame-corners="([a-z]+)"/.exec(f)?.[1] ?? "none")).toEqual(["none", "notch", "gem", "crown"]);
    const compact = render(createElement(RarityFrame, { rarity: "LEGENDARY", compact: true }, "x"));
    expect(compact).toContain('data-frame="ornate"');
    expect(compact).toContain('data-compact="true"');
    expect(compact).not.toContain("data-frame-corners");
    // every colour comes from the shared table, as CSS variables
    expect(frames[3]).toContain(`--rarity:${RARITY_VISUALS.LEGENDARY.colors.base}`);
    expect(frames[0]).toContain(`--rarity:${RARITY_VISUALS.COMMON.colors.base}`);
  });
});

describe("hero card — art → name → rarity + class → PWR → stats", () => {
  it("renders the hierarchy in that order, with a big PWR and all seven stats — and no PWR band / tier line", () => {
    const out = render(createElement(HeroCard, { model: model("LEGENDARY", 208) }));
    const order = ["hero-card-name", "hero-card-class", "hero-card-power", "hero-card-stats"].map((id) => out.indexOf(`data-testid="${id}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // strictly in the documented order
    expect(out.indexOf('data-testid="rarity-frame"')).toBeLessThan(order[0]!); // the art comes first
    expect(out).toContain('data-pwr="208"');
    expect(out).toContain("text-6xl");
    const t = text(out);
    expect(out).not.toContain("hero-card-tier"); // the tier meter (bar + "Legendary tier · 190–209") is gone
    expect(t).not.toMatch(/tier\s*·/i);
    expect(t).not.toMatch(/\b1[3-9]\d\s*[–-]\s*2?\d{2}\b/); // no band such as 130–149 … 190–209 anywhere on the card
    expect(t).toContain("Forge Fay");
    expect(t).toMatch(/Legendary\s+Mage/);
    for (const stat of ["HP", "STR", "DEF", "INT", "AGI", "CHA", "LUCK"]) expect(t).toContain(stat);
    expect(out).toContain('data-rarity="LEGENDARY"');
    expect(out).toContain('aria-label="Forge Fay — Legendary Mage, PWR 208"');
  });

  it("a Legendary card is dressed far more richly than a Common one", () => {
    const common = render(createElement(HeroCard, { model: model("COMMON", 139) }));
    const legendary = render(createElement(HeroCard, { model: model("LEGENDARY", 208) }));
    expect(common).toContain('data-frame="plain"');
    expect(legendary).toContain('data-frame="ornate"');
    expect(legendary).toContain("data-frame-corners=\"crown\"");
    expect(common).not.toContain("data-frame-corners");
    expect(legendary.length).toBeGreaterThan(common.length);
    expect(legendary).toContain("rarity-glow");
    expect(common).toContain(`--rarity-glow-blur:${RARITY_VISUALS.COMMON.frame.glowBlur}px`);
    expect(legendary).toContain(`--rarity-glow-blur:${RARITY_VISUALS.LEGENDARY.frame.glowBlur}px`);
    expect(RARITY_VISUALS.LEGENDARY.frame.glowBlur).toBeGreaterThan(RARITY_VISUALS.RARE.frame.glowBlur);
  });

  it("shows exactly the model's numbers (it never recomputes PWR or a stat) and nothing private", () => {
    const m = model("EPIC", 177, { stats: { hp: 111, str: 12, def: 13, int: 14, agi: 15, cha: 16, luck: 17 } });
    const out = render(createElement(HeroCard, { model: m }));
    for (const v of [111, 12, 13, 14, 15, 16, 17]) expect(out).toContain(`>${v}<`);
    expect(out).toContain("177");
    expect(out).not.toMatch(/telegram|seed|wallet|0x[0-9a-f]{40}/i);
  });

  it("directory tile: portrait frame, name, rarity badge, class and a large PWR, linking to the public profile", () => {
    const out = render(createElement(HeroCardCompact, { model: model("EPIC", 177) }));
    expect(out).toContain('href="/heroes/k7m2q9x4tb3d"');
    expect(out).toContain('data-testid="hero-tile"');
    expect(out).toContain('data-testid="rarity-badge"');
    expect(out).toContain('data-testid="rarity-frame"');
    expect(out).toContain('data-pwr="177"');
    expect(text(out)).toContain("Mage");
    expect(text(out)).toContain("Forge Fay");
  });
});

describe("admin reroll preview — PWR is the headline", () => {
  it("shows PWR current → new, big, with the change and a rarity change (a stronger reroll)", () => {
    const out = render(createElement(PowerCompare, { current: model("RARE", 143), next: model("EPIC", 176) }));
    expect(out).toContain('data-testid="power-compare"');
    expect(out).toContain('data-direction="up"');
    expect(out.match(/data-pwr="/g)!.length).toBe(2);
    expect(out).toContain('data-pwr="143"');
    expect(out).toContain('data-pwr="176"');
    expect(out).toContain("text-6xl");
    const t = text(out);
    expect(t).toContain("+33");
    expect(t).toContain("Stronger");
    expect(t).toMatch(/rarity changes\s+Rare\s*→\s*Epic/);
  });

  it("a WEAKER reroll is just as obvious: Epic → Common, −59", () => {
    const out = render(createElement(PowerCompare, { current: model("EPIC", 171), next: model("COMMON", 112 + 6) }));
    expect(out).toContain('data-direction="down"');
    expect(text(out)).toContain("−53");
    expect(text(out)).toContain("Weaker");
    expect(text(out)).toMatch(/Epic\s*→\s*Common/);
  });

  it("flags a class change, and 'same' when nothing moved", () => {
    const other = model("RARE", 150, { classId: "tank", className: "Tank" });
    expect(text(render(createElement(PowerCompare, { current: model("RARE", 150), next: other })))).toContain("class changes Mage → Tank");
    expect(render(createElement(PowerCompare, { current: model("RARE", 150), next: model("RARE", 150) }))).toContain('data-direction="same"');
  });

  it("the stat table lists class, rarity (as badges), PWR (emphasised) and the seven stats with ▲ / ▼ changes", () => {
    const next = model("EPIC", 176, { stats: { hp: 130, str: 6, def: 7, int: 25, agi: 10, cha: 9, luck: 11 } });
    const out = render(createElement(StatDiff, { current: model("RARE", 143), next }));
    const t = text(out);
    for (const label of ["Class", "Rarity", "PWR", "HP", "STR", "DEF", "INT", "AGI", "CHA", "LUCK"]) expect(t).toContain(label);
    expect(out.match(/data-testid="rarity-badge"/g)!.length).toBe(2);
    expect(t).toContain("▲ +33");
    expect(t).toContain("▲ +10"); // HP 120 → 130
    expect(t).toContain("▼ −2"); // STR 8 → 6
  });
});
