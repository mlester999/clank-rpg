import type { ItemRarity, ItemSlot } from "@/domain/content/items";
import { ITEM_RARITIES } from "@/domain/content/items";
import type { ShopSettings } from "@/domain/settings";

import type { Db, Queryable } from "../db/types";

import { applyLedger, getBalance } from "./economy";

/**
 * THE GEAR SHOP — what Clank Gold is for (docs/ECONOMY_AND_CHAIN.md). A claimed hero's owner can BUY gear for Gold and SELL spare gear back for Gold. Everything is
 * server-authoritative and Gold only ever moves through the ledger:
 *
 *   · BUY   one transaction: lock the hero, check the item is sold and usable by the hero's class, debit the price (a ledger row keyed by the client's request id — a replay
 *           is a no-op that returns the item it already bought), add the item (`acquired_via = 'SHOP'`, `source_ref = shop:<request id>` — unique per hero). An empty purse is
 *           refused by the ledger's own overdraft trigger, so two parallel buys can never spend the same Gold twice.
 *   · SELL  one transaction: lock the hero, the item must be theirs, active and NOT equipped; credit the sell price (ledger key = the item id, so one item pays once) and
 *           ARCHIVE the item (`archived_at`). It is archived rather than deleted because an Arena result may still point at it as the drop it produced.
 *
 * What is sold: enabled item templates with the `ARENA_DROP` source tag (coin-themed / boss items arrive with their own sources and are never in the shop), below Legendary
 * (a price of `null` in the shop settings), made for the hero's class. Prices live in the `shop` settings; every sell price is below its buy price, so the shop only ever
 * removes Gold from the economy. Gear is the same small flat bonus whether dropped or bought, and neither touches POWER.
 */

export interface ShopItemView {
  templateId: string;
  name: string;
  slot: ItemSlot;
  rarity: ItemRarity;
  description: string;
  statMods: Record<string, number>;
  classRestriction: string[] | null;
  /** Gold to buy one. */
  price: number;
  /** How many of it the hero already holds (active, in the bag or equipped). */
  owned: number;
}

export interface ShopView {
  enabled: boolean;
  claimed: boolean;
  gold: number;
  items: ShopItemView[];
}

/** What a spare item of this rarity sells for, or null while the shop is closed. */
export const sellPriceOf = (settings: ShopSettings, rarity: ItemRarity): number | null => (settings.enabled ? settings.sell[rarity] : null);

const RARITY_RANK: Record<string, number> = Object.fromEntries(ITEM_RARITIES.map((r, i) => [r, i]));

/** The shop window for one hero: what it can buy, at what price. */
export async function listShop(q: Queryable, characterId: string, settings: ShopSettings): Promise<ShopView | null> {
  const [hero] = await q.query<{ class_id: string; claimed: boolean }>(
    "select c.class_id, (cl.character_id is not null) as claimed from public.characters c left join public.character_claims cl on cl.character_id = c.id where c.id = $1",
    [characterId],
  );
  if (!hero) return null;
  const gold = await getBalance(q, characterId);
  if (!settings.enabled) return { enabled: false, claimed: hero.claimed, gold, items: [] };
  const templates = await q.query<{ id: string; name: string; slot: ItemSlot; rarity: ItemRarity; description: string; stat_mods: Record<string, number>; class_restriction: string[] | null }>(
    `select t.id, t.name, t.slot, t.rarity, t.description, t.stat_mods, t.class_restriction
       from public.item_templates t
      where t.enabled and t.source_tag = 'ARENA_DROP' and (t.class_restriction is null or jsonb_exists(t.class_restriction, $1))`,
    [hero.class_id],
  );
  const held = await q.query<{ template_id: string; n: number }>(
    "select template_id, count(*)::int as n from public.inventory_items where character_id = $1 and archived_at is null group by template_id",
    [characterId],
  );
  const owned = new Map(held.map((h) => [h.template_id, Number(h.n)]));
  const items: ShopItemView[] = [];
  for (const t of templates) {
    const price = settings.buy[t.rarity];
    if (price === null || price === undefined) continue;
    items.push({ templateId: t.id, name: t.name, slot: t.slot, rarity: t.rarity, description: t.description, statMods: t.stat_mods, classRestriction: t.class_restriction, price, owned: owned.get(t.id) ?? 0 });
  }
  const slotRank = { WEAPON: 0, ARMOR: 1, TRINKET: 2 } as const;
  items.sort((a, b) => slotRank[a.slot] - slotRank[b.slot] || (RARITY_RANK[a.rarity] ?? 0) - (RARITY_RANK[b.rarity] ?? 0) || a.name.localeCompare(b.name));
  return { enabled: true, claimed: hero.claimed, gold, items };
}

export type ShopFailure = "SHOP_CLOSED" | "NOT_FOUND" | "NOT_CLAIMED" | "NOT_FOR_SALE" | "CLASS_RESTRICTED" | "INSUFFICIENT_GOLD" | "EQUIPPED";

export type BuyResult = { ok: true; itemId: string; templateId: string; price: number; gold: number; alreadyApplied: boolean } | { ok: false; reason: ShopFailure; needed?: number; gold?: number };

const isInsufficient = (error: unknown): boolean => /insufficient Clank Gold/i.test(error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error));

/** Buys one item. `requestId` is the browser's idempotency key for THIS purchase: replaying it returns the item it already bought and charges nothing. */
export async function buyItem(db: Db, characterId: string, templateId: string, requestId: string, settings: ShopSettings): Promise<BuyResult> {
  if (!settings.enabled) return { ok: false, reason: "SHOP_CLOSED" };
  try {
    return await db.transaction(async (tx): Promise<BuyResult> => {
      const [hero] = await tx.query<{ class_id: string; claimed: boolean }>(
        "select c.class_id, (cl.character_id is not null) as claimed from public.characters c left join public.character_claims cl on cl.character_id = c.id where c.id = $1 for update of c",
        [characterId],
      );
      if (!hero) return { ok: false, reason: "NOT_FOUND" };
      if (!hero.claimed) return { ok: false, reason: "NOT_CLAIMED" };
      const sourceRef = `shop:${requestId}`;
      // A replay of a purchase that already went through: the same item, nothing charged.
      const [again] = await tx.query<{ id: string; template_id: string; rarity: ItemRarity }>(
        "select i.id, i.template_id, t.rarity from public.inventory_items i join public.item_templates t on t.id = i.template_id where i.character_id = $1 and i.source_ref = $2",
        [characterId, sourceRef],
      );
      if (again) return { ok: true, itemId: again.id, templateId: again.template_id, price: settings.buy[again.rarity] ?? 0, gold: await getBalance(tx, characterId), alreadyApplied: true };
      const [t] = await tx.query<{ rarity: ItemRarity; slot: ItemSlot; enabled: boolean; source_tag: string; class_restriction: string[] | null }>(
        "select rarity, slot, enabled, source_tag, class_restriction from public.item_templates where id = $1",
        [templateId],
      );
      const price = t ? settings.buy[t.rarity] : null;
      if (!t || !t.enabled || t.source_tag !== "ARENA_DROP" || price === null || price === undefined) return { ok: false, reason: "NOT_FOR_SALE" };
      if (t.class_restriction && !t.class_restriction.includes(hero.class_id)) return { ok: false, reason: "CLASS_RESTRICTED" };
      const debit = await applyLedger(tx, { characterId, amount: -price, reason: "shop purchase", refType: "item_template", refId: templateId, idempotencyKey: `shop:buy:${characterId}:${requestId}` });
      if (!debit.applied) return { ok: false, reason: "NOT_FOUND" }; // the same request id was used for something else: never charged twice, nothing delivered
      const [item] = await tx.query<{ id: string }>(
        "insert into public.inventory_items (character_id, template_id, slot, acquired_via, source_ref) values ($1, $2, $3, 'SHOP', $4) returning id",
        [characterId, templateId, t.slot, sourceRef],
      );
      return { ok: true, itemId: (item as { id: string }).id, templateId, price, gold: debit.balance, alreadyApplied: false };
    });
  } catch (error) {
    if (isInsufficient(error)) {
      const gold = await getBalance(db, characterId);
      return { ok: false, reason: "INSUFFICIENT_GOLD", gold };
    }
    throw error;
  }
}

export type SellResult = { ok: true; price: number; gold: number } | { ok: false; reason: ShopFailure };

/** Sells one spare item for its rarity's sell price. An equipped item cannot be sold (unequip it first); an item pays exactly once. */
export async function sellItem(db: Db, characterId: string, itemId: string, settings: ShopSettings): Promise<SellResult> {
  if (!settings.enabled) return { ok: false, reason: "SHOP_CLOSED" };
  return db.transaction(async (tx): Promise<SellResult> => {
    const [hero] = await tx.query<{ claimed: boolean }>(
      "select (cl.character_id is not null) as claimed from public.characters c left join public.character_claims cl on cl.character_id = c.id where c.id = $1 for update of c",
      [characterId],
    );
    if (!hero) return { ok: false, reason: "NOT_FOUND" };
    if (!hero.claimed) return { ok: false, reason: "NOT_CLAIMED" };
    const [item] = await tx.query<{ id: string; equipped: boolean; rarity: ItemRarity }>(
      `select i.id, i.equipped, t.rarity from public.inventory_items i join public.item_templates t on t.id = i.template_id
        where i.id = $1 and i.character_id = $2 and i.archived_at is null for update of i`,
      [itemId, characterId],
    );
    if (!item) return { ok: false, reason: "NOT_FOUND" };
    if (item.equipped) return { ok: false, reason: "EQUIPPED" };
    const price = settings.sell[item.rarity];
    const credit = await applyLedger(tx, { characterId, amount: price, reason: "shop sale", refType: "inventory_item", refId: itemId, idempotencyKey: `shop:sell:${itemId}` });
    if (!credit.applied) return { ok: false, reason: "NOT_FOUND" }; // this item was already sold
    await tx.query("update public.inventory_items set archived_at = now() where id = $1", [itemId]);
    return { ok: true, price, gold: credit.balance };
  });
}
