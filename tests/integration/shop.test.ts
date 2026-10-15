import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type ShopSettings } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import { applyLedger, auditLedger, getBalance } from "@/server/services/economy";
import { claimCharacter } from "@/server/services/identity";
import { listInventory, setEquipped } from "@/server/services/inventory";
import { buyItem, listShop, sellItem, sellPriceOf } from "@/server/services/shop";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * THE GEAR SHOP — what Clank Gold is for. Buying and selling are ledger operations: idempotent per request, never overdrafting, owner-only, and the shop can only
 * ever remove Gold from the economy.
 */
const SHOP: ShopSettings = DEFAULT_SETTINGS.shop;
let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

let tid = 9500;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function owner(gold = 0): Promise<{ hero: string; cls: string }> {
  const id = tid++;
  const [hero] = await seedHeroes(db, 1, { startId: id });
  expect((await claimCharacter(db, id, new Date())).ok).toBe(true);
  const [c] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero]);
  if (gold > 0) await applyLedger(db, { characterId: hero!, amount: gold, reason: "test", idempotencyKey: `test-gold-${hero}` });
  return { hero: hero!, cls: c!.class_id };
}
const activeItems = async (hero: string) => (await listInventory(db, hero)).map((i) => i.templateId);

describe("the shop window", () => {
  it("lists what the hero's CLASS can use — class-free trinkets included, no other class's gear, no Legendary — at the settings' prices, with how many are already held", async () => {
    const { hero, cls } = await owner(0);
    await db.query("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON')", [hero, `${cls}_weapon_rare`]);
    const view = (await listShop(db, hero, SHOP))!;
    expect(view).toMatchObject({ enabled: true, claimed: true, gold: 0 });
    expect(view.items.length).toBeGreaterThan(0);
    for (const i of view.items) {
      expect(i.rarity, i.templateId).not.toBe("LEGENDARY");
      expect(i.price, i.templateId).toBe(SHOP.buy[i.rarity]);
      expect(i.classRestriction === null || i.classRestriction.includes(cls), i.templateId).toBe(true);
    }
    expect(view.items.some((i) => i.slot === "TRINKET")).toBe(true);
    expect(view.items.find((i) => i.templateId === `${cls}_weapon_rare`)).toMatchObject({ owned: 1, price: SHOP.buy.RARE });
    expect(view.items.find((i) => i.templateId === `${cls}_weapon_epic`)).toMatchObject({ owned: 0, price: SHOP.buy.EPIC });
    // ordered weapon → armor → trinket, then by rarity
    const slots = view.items.map((i) => i.slot);
    expect(slots).toEqual([...slots].sort((a, b) => ["WEAPON", "ARMOR", "TRINKET"].indexOf(a) - ["WEAPON", "ARMOR", "TRINKET"].indexOf(b)));
  });

  it("a closed shop lists nothing and refuses every purchase and sale; an unknown hero has no shop", async () => {
    const { hero, cls } = await owner(10_000);
    const closed: ShopSettings = { ...SHOP, enabled: false };
    expect(await listShop(db, hero, closed)).toMatchObject({ enabled: false, items: [] });
    expect(await buyItem(db, hero, `${cls}_weapon_common`, uuid(1), closed)).toEqual({ ok: false, reason: "SHOP_CLOSED" });
    expect(sellPriceOf(closed, "RARE")).toBeNull();
    expect(sellPriceOf(SHOP, "RARE")).toBe(SHOP.sell.RARE);
    expect(await listShop(db, "00000000-0000-4000-8000-000000000000", SHOP)).toBeNull();
    expect(await getBalance(db, hero)).toBe(10_000);
  });
});

describe("buying", () => {
  it("debits the price through the ledger and adds the item to the bag (source SHOP); the balance equals the ledger", async () => {
    const { hero, cls } = await owner(2000);
    const r = await buyItem(db, hero, `${cls}_weapon_rare`, uuid(1), SHOP);
    expect(r).toMatchObject({ ok: true, templateId: `${cls}_weapon_rare`, price: SHOP.buy.RARE, gold: 2000 - SHOP.buy.RARE!, alreadyApplied: false });
    expect(await getBalance(db, hero)).toBe(2000 - SHOP.buy.RARE!);
    expect(await activeItems(hero)).toEqual([`${cls}_weapon_rare`]);
    const [row] = await db.query<{ acquired_via: string; source_ref: string; slot: string }>("select acquired_via, source_ref, slot from public.inventory_items where character_id = $1", [hero]);
    expect(row).toEqual({ acquired_via: "SHOP", source_ref: `shop:${uuid(1)}`, slot: "WEAPON" });
    const [ledger] = await db.query<{ delta: string; reason: string; ref_type: string; ref_id: string }>("select delta::text, reason, ref_type, ref_id from public.currency_ledger where reason = 'shop purchase'");
    expect(ledger).toEqual({ delta: String(-SHOP.buy.RARE!), reason: "shop purchase", ref_type: "item_template", ref_id: `${cls}_weapon_rare` });
    expect(await auditLedger(db)).toEqual([]);
  });

  it("a bought item can be equipped like any other", async () => {
    const { hero, cls } = await owner(2000);
    const r = await buyItem(db, hero, `${cls}_weapon_rare`, uuid(1), SHOP);
    if (!r.ok) throw new Error("purchase refused");
    expect(await setEquipped(db, hero, r.itemId, true)).toEqual({ ok: true, equipped: true });
  });

  it("replaying the SAME request id charges once and returns the item already bought; a new request id buys another", async () => {
    const { hero, cls } = await owner(5000);
    const first = await buyItem(db, hero, `${cls}_weapon_common`, uuid(1), SHOP);
    const again = await buyItem(db, hero, `${cls}_weapon_common`, uuid(1), SHOP);
    expect(first.ok && again.ok && again.itemId === first.itemId && again.alreadyApplied).toBe(true);
    expect(await getBalance(db, hero)).toBe(5000 - SHOP.buy.COMMON!);
    expect((await activeItems(hero)).length).toBe(1);
    await buyItem(db, hero, `${cls}_weapon_common`, uuid(2), SHOP);
    expect(await getBalance(db, hero)).toBe(5000 - 2 * SHOP.buy.COMMON!);
    expect((await activeItems(hero)).length).toBe(2);
  });

  it("not enough Gold: refused, nothing charged, nothing delivered — and the answer says how much Gold the hero has", async () => {
    const { hero, cls } = await owner(SHOP.buy.EPIC! - 1);
    const r = await buyItem(db, hero, `${cls}_weapon_epic`, uuid(1), SHOP);
    expect(r).toEqual({ ok: false, reason: "INSUFFICIENT_GOLD", gold: SHOP.buy.EPIC! - 1 });
    expect(await getBalance(db, hero)).toBe(SHOP.buy.EPIC! - 1);
    expect(await activeItems(hero)).toEqual([]);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("two parallel purchases with Gold for only one: exactly one succeeds, the purse never goes negative", async () => {
    const { hero, cls } = await owner(SHOP.buy.RARE! + 100);
    const results = await Promise.all([1, 2, 3, 4].map((n) => buyItem(db, hero, `${cls}_weapon_rare`, uuid(n), SHOP)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "INSUFFICIENT_GOLD")).toBe(true);
    expect(await getBalance(db, hero)).toBe(100);
    expect((await activeItems(hero)).length).toBe(1);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("refuses what is not for sale: Legendary, another class's gear, a disabled template, a non-arena source, an unknown id — and an unclaimed hero", async () => {
    const { hero, cls } = await owner(1_000_000);
    const other = (await db.query<{ id: string }>("select id from public.character_classes where id <> $1 order by sort_order limit 1", [cls]))[0]!.id;
    expect(await buyItem(db, hero, `${cls}_weapon_legendary`, uuid(1), SHOP)).toEqual({ ok: false, reason: "NOT_FOR_SALE" });
    expect(await buyItem(db, hero, `${other}_weapon_rare`, uuid(2), SHOP)).toEqual({ ok: false, reason: "CLASS_RESTRICTED" });
    expect(await buyItem(db, hero, "no_such_item", uuid(3), SHOP)).toEqual({ ok: false, reason: "NOT_FOR_SALE" });
    await db.query("update public.item_templates set enabled = false where id = $1", [`${cls}_weapon_rare`]);
    expect(await buyItem(db, hero, `${cls}_weapon_rare`, uuid(4), SHOP)).toEqual({ ok: false, reason: "NOT_FOR_SALE" });
    await db.query("update public.item_templates set source_tag = 'BOSS_LOOT' where id = $1", [`${cls}_weapon_epic`]);
    expect(await buyItem(db, hero, `${cls}_weapon_epic`, uuid(5), SHOP)).toEqual({ ok: false, reason: "NOT_FOR_SALE" });
    const [stranger] = await seedHeroes(db, 1, { startId: 9899 }); // never claimed
    await applyLedger(db, { characterId: stranger!, amount: 5000, reason: "test", idempotencyKey: "test-gold-stranger" });
    expect(await buyItem(db, stranger!, `${(await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [stranger]))[0]!.class_id}_weapon_common`, uuid(6), SHOP)).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    expect(await getBalance(db, hero)).toBe(1_000_000);
    expect(await getBalance(db, stranger!)).toBe(5000);
    expect(await activeItems(hero)).toEqual([]);
  });
});

describe("selling", () => {
  it("credits the rarity's sell price, takes the item out of the bag, and keeps the row (an Arena result may point at it)", async () => {
    const { hero, cls } = await owner(0);
    const [item] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [hero, `${cls}_weapon_epic`]);
    const r = await sellItem(db, hero, item!.id, SHOP);
    expect(r).toEqual({ ok: true, price: SHOP.sell.EPIC, gold: SHOP.sell.EPIC });
    expect(await getBalance(db, hero)).toBe(SHOP.sell.EPIC);
    expect(await activeItems(hero)).toEqual([]);
    expect((await db.query("select 1 from public.inventory_items where id = $1 and archived_at is not null", [item!.id])).length).toBe(1);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("an item pays exactly once, even when the request is repeated or raced", async () => {
    const { hero, cls } = await owner(0);
    const [item] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [hero, `${cls}_weapon_rare`]);
    const results = await Promise.all([1, 2, 3].map(() => sellItem(db, hero, item!.id, SHOP)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "NOT_FOUND")).toBe(true);
    expect(await getBalance(db, hero)).toBe(SHOP.sell.RARE);
  });

  it("an EQUIPPED item cannot be sold, nor another hero's, nor an unclaimed hero's", async () => {
    const a = await owner(0);
    const b = await owner(0);
    const [equipped] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true) returning id", [a.hero, `${a.cls}_weapon_rare`]);
    expect(await sellItem(db, a.hero, equipped!.id, SHOP)).toEqual({ ok: false, reason: "EQUIPPED" });
    expect(await sellItem(db, b.hero, equipped!.id, SHOP)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const [stranger] = await seedHeroes(db, 1, { startId: 9898 });
    const [theirs] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [stranger, `${(await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [stranger]))[0]!.class_id}_weapon_rare`]);
    expect(await sellItem(db, stranger!, theirs!.id, SHOP)).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    expect(await getBalance(db, a.hero)).toBe(0);
    expect(await activeItems(a.hero)).toEqual([`${a.cls}_weapon_rare`]);
  });

  it("buying and selling straight back always LOSES Gold: the shop only removes Gold from the economy", async () => {
    const { hero, cls } = await owner(10_000);
    for (const [rarity, n] of [["COMMON", 1], ["UNCOMMON", 2], ["RARE", 3], ["EPIC", 4]] as const) {
      const bought = await buyItem(db, hero, `${cls}_weapon_${rarity.toLowerCase()}`, uuid(n), SHOP);
      if (!bought.ok) throw new Error("purchase refused");
      const before = await getBalance(db, hero);
      const sold = await sellItem(db, hero, bought.itemId, SHOP);
      expect(sold.ok && sold.price < bought.price, rarity).toBe(true);
      expect(await getBalance(db, hero), rarity).toBeLessThan(before + bought.price);
    }
    expect(await getBalance(db, hero)).toBeLessThan(10_000);
    expect(await auditLedger(db)).toEqual([]);
  });
});
