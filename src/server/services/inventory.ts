import type { Queryable } from "../db/types";

export interface InventoryItemView {
  id: string;
  templateId: string;
  name: string;
  slot: "WEAPON" | "ARMOR" | "TRINKET";
  rarity: "COMMON" | "UNCOMMON" | "RARE" | "EPIC" | "LEGENDARY";
  description: string;
  statMods: Record<string, number>;
  classRestriction: string[] | null;
  equipped: boolean;
  usable: boolean;
  acquiredAt: Date;
}

export async function listInventory(q: Queryable, characterId: string): Promise<InventoryItemView[]> {
  const rows = await q.query<{
    id: string; template_id: string; name: string; slot: InventoryItemView["slot"]; rarity: InventoryItemView["rarity"]; description: string;
    stat_mods: Record<string, number>; class_restriction: string[] | null; equipped: boolean; acquired_at: Date; class_id: string;
  }>(
    `select i.id, i.template_id, t.name, i.slot, t.rarity, t.description, t.stat_mods, t.class_restriction, i.equipped, i.acquired_at, c.class_id
       from public.inventory_items i join public.item_templates t on t.id = i.template_id join public.characters c on c.id = i.character_id
      where i.character_id = $1 and i.archived_at is null
      order by i.equipped desc, array_position(array['LEGENDARY','EPIC','RARE','UNCOMMON','COMMON'], t.rarity), i.acquired_at desc`,
    [characterId],
  );
  return rows.map((r) => ({
    id: r.id, templateId: r.template_id, name: r.name, slot: r.slot, rarity: r.rarity, description: r.description,
    statMods: r.stat_mods, classRestriction: r.class_restriction, equipped: r.equipped, acquiredAt: r.acquired_at,
    usable: !r.class_restriction || r.class_restriction.includes(r.class_id),
  }));
}

export type EquipResult =
  | { ok: true; equipped: boolean }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CLAIMED" | "CLASS_RESTRICTED" };

/**
 * Equip/unequip. Server-validated: the item must belong to the hero, the hero must be
 * CLAIMED (owner-only management), and the class restriction is enforced (there is no level requirement). One item per slot
 * is also guaranteed by a partial unique index, so concurrent requests can't double-equip.
 */
export async function setEquipped(q: Queryable, characterId: string, itemId: string, equip: boolean): Promise<EquipResult> {
  const [row] = await q.query<{ slot: string; class_restriction: string[] | null; class_id: string; claimed: boolean; equipped: boolean }>(
    `select i.slot, t.class_restriction, c.class_id, (cl.character_id is not null) as claimed, i.equipped
       from public.inventory_items i join public.item_templates t on t.id = i.template_id
       join public.characters c on c.id = i.character_id left join public.character_claims cl on cl.character_id = c.id
      where i.id = $1 and i.character_id = $2 and i.archived_at is null for update of i`,
    [itemId, characterId],
  );
  if (!row) return { ok: false, reason: "NOT_FOUND" };
  if (!row.claimed) return { ok: false, reason: "NOT_CLAIMED" };
  if (!equip) {
    await q.query("update public.inventory_items set equipped = false where id = $1", [itemId]);
    return { ok: true, equipped: false };
  }
  if (row.class_restriction && !row.class_restriction.includes(row.class_id)) return { ok: false, reason: "CLASS_RESTRICTED" };
  await q.query("update public.inventory_items set equipped = false where character_id = $1 and slot = $2 and id <> $3 and equipped", [characterId, row.slot, itemId]);
  await q.query("update public.inventory_items set equipped = true where id = $1", [itemId]);
  return { ok: true, equipped: true };
}

export async function setTactic(q: Queryable, characterId: string, tactic: "AGGRESSIVE" | "BALANCED" | "DEFENSIVE"): Promise<boolean> {
  const rows = await q.query(
    `update public.characters set tactic = $2 where id = $1 and exists (select 1 from public.character_claims where character_id = $1) returning id`,
    [characterId, tactic],
  );
  return rows.length > 0;
}
