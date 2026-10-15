import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";

/** The `shop` and `hero_reroll` settings: validated like every other setting, defaults that are safe, and a shop that can never mint Gold. */
describe("shop settings", () => {
  const shop = DEFAULT_SETTINGS.shop;

  it("the shipped defaults validate, sell below buy for every rarity that is sold, and never sell Legendary", () => {
    expect(parseSettings("shop", shop)).toEqual(shop);
    for (const rarity of ["COMMON", "UNCOMMON", "RARE", "EPIC"] as const) expect(shop.sell[rarity]).toBeLessThan(shop.buy[rarity]!);
    expect(shop.buy.LEGENDARY).toBeNull();
    // dearer rarities cost more, to buy and to sell
    const buys = [shop.buy.COMMON!, shop.buy.UNCOMMON!, shop.buy.RARE!, shop.buy.EPIC!];
    expect(buys).toEqual([...buys].sort((a, b) => a - b));
    const sells = [shop.sell.COMMON, shop.sell.UNCOMMON, shop.sell.RARE, shop.sell.EPIC, shop.sell.LEGENDARY];
    expect(sells).toEqual([...sells].sort((a, b) => a - b));
  });

  it("refuses a sell price at or above the buy price of the same rarity (buy-and-sell-back may never be a profit)", () => {
    expect(() => parseSettings("shop", { ...shop, sell: { ...shop.sell, RARE: shop.buy.RARE } })).toThrow(/sell price must be below/);
    expect(() => parseSettings("shop", { ...shop, sell: { ...shop.sell, COMMON: shop.buy.COMMON! + 1 } })).toThrow(/sell price must be below/);
    // a rarity that is not sold may have any sell price
    expect(parseSettings("shop", { ...shop, buy: { ...shop.buy, LEGENDARY: null }, sell: { ...shop.sell, LEGENDARY: 9_999 } }).sell.LEGENDARY).toBe(9_999);
  });

  it("refuses floats, zero, negatives, unknown keys and missing rarities", () => {
    expect(() => parseSettings("shop", { ...shop, buy: { ...shop.buy, COMMON: 1.5 } })).toThrow();
    expect(() => parseSettings("shop", { ...shop, buy: { ...shop.buy, COMMON: 0 } })).toThrow();
    expect(() => parseSettings("shop", { ...shop, sell: { ...shop.sell, COMMON: -5 } })).toThrow();
    expect(() => parseSettings("shop", { ...shop, bonus: 1 })).toThrow();
    expect(() => parseSettings("shop", { ...shop, sell: { COMMON: 1 } })).toThrow();
  });
});

describe("hero_reroll settings (the paid reroll)", () => {
  const cfg = DEFAULT_SETTINGS.hero_reroll;

  it("ships a price of 100,000 whole $CLANKRPG, a daily brake and a confirmation count", () => {
    expect(cfg).toEqual({ paidPrice: "100000", paidMaxPerDay: 10, paymentConfirmations: 2 });
    expect(parseSettings("hero_reroll", cfg)).toEqual(cfg);
  });

  it("a price is a decimal STRING of whole tokens — a JavaScript number never carries a token amount", () => {
    expect(parseSettings("hero_reroll", { ...cfg, paidPrice: "250000.5" }).paidPrice).toBe("250000.5");
    for (const bad of [100000, "1e5", "-5", "", "0x10", "100,000"]) expect(() => parseSettings("hero_reroll", { ...cfg, paidPrice: bad }), String(bad)).toThrow();
    expect(() => parseSettings("hero_reroll", { ...cfg, paidMaxPerDay: 0 })).toThrow();
    expect(() => parseSettings("hero_reroll", { ...cfg, paymentConfirmations: 0 })).toThrow();
    expect(() => parseSettings("hero_reroll", { ...cfg, extra: true })).toThrow();
  });
});
