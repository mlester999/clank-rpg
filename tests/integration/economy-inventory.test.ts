import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { applyLedger, auditLedger, getBalance } from "@/server/services/economy";
import { claimCharacter } from "@/server/services/identity";
import { listInventory, setEquipped, setTactic } from "@/server/services/inventory";
import { loadSettings } from "@/server/config/settingsRepo";
import { loadFighters } from "@/server/services/characters";
import { loadRuleset } from "@/server/config/settingsRepo";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

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

describe("Clank Gold ledger", () => {
  it("every mutation is a ledger row; balance equals the sum; replays are no-ops", async () => {
    const [hero] = await seedHeroes(db, 1);
    const key = "test-credit-0001";
    const a = await applyLedger(db, { characterId: hero!, amount: 50, reason: "test", idempotencyKey: key });
    expect(a).toEqual({ applied: true, balance: 50 });
    // replayed request (same key) does nothing
    expect(await applyLedger(db, { characterId: hero!, amount: 50, reason: "test", idempotencyKey: key })).toEqual({ applied: false, balance: 50 });
    expect(await getBalance(db, hero!)).toBe(50);
    await applyLedger(db, { characterId: hero!, amount: -20, reason: "spend", idempotencyKey: "test-debit-0002" });
    expect(await getBalance(db, hero!)).toBe(30);
    expect(await auditLedger(db)).toEqual([]);
    expect(await count(db, "currency_ledger")).toBe(2);
  });

  it("rejects overdrafts atomically (no partial state)", async () => {
    const [hero] = await seedHeroes(db, 1);
    await applyLedger(db, { characterId: hero!, amount: 10, reason: "seed", idempotencyKey: "seed-0000001" });
    await expect(applyLedger(db, { characterId: hero!, amount: -11, reason: "overspend", idempotencyKey: "overspend-0001" })).rejects.toThrow(/insufficient/);
    expect(await getBalance(db, hero!)).toBe(10);
    expect(await count(db, "currency_ledger")).toBe(1);
  });

  it("the ledger is append-only and balances cannot be edited by hand", async () => {
    const [hero] = await seedHeroes(db, 1);
    await applyLedger(db, { characterId: hero!, amount: 10, reason: "seed", idempotencyKey: "seed-0000002" });
    await expect(db.query("update public.currency_ledger set delta = 1000000")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.currency_ledger")).rejects.toThrow(/append-only/);
    // Direct balance edits are not blocked at the table level for the privileged server role, but
    // they are detected by the integrity audit.
    await db.query("update public.currency_accounts set balance = balance + 999 where character_id = $1", [hero]);
    const drift = await auditLedger(db);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ character_id: hero, balance: 1009, ledger_sum: 10 });
  });

  it("zero and fractional amounts are refused", async () => {
    const [hero] = await seedHeroes(db, 1);
    await expect(applyLedger(db, { characterId: hero!, amount: 0, reason: "x", idempotencyKey: "zero-00000001" })).rejects.toThrow();
    await expect(applyLedger(db, { characterId: hero!, amount: 1.5, reason: "x", idempotencyKey: "frac-00000001" })).rejects.toThrow();
  });

  it("concurrent credits with the same key apply once; with different keys they all apply", async () => {
    const [hero] = await seedHeroes(db, 1);
    await Promise.all(Array.from({ length: 12 }, () => applyLedger(db, { characterId: hero!, amount: 5, reason: "dup", idempotencyKey: "same-key-0000001" })));
    expect(await getBalance(db, hero!)).toBe(5);
    await Promise.all(Array.from({ length: 12 }, (_, i) => applyLedger(db, { characterId: hero!, amount: 1, reason: "distinct", idempotencyKey: `distinct-${String(i).padStart(8, "0")}` })));
    expect(await getBalance(db, hero!)).toBe(17);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("arena rewards are idempotent per (battle, hero) and conservative", async () => {
    await seedHeroes(db, 16);
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    for (let s = 0; s < 120; s++) { await advanceArena(db, ctx); clock.advance(1000); }
    const rows = await db.query<{ idempotency_key: string; delta: number }>("select idempotency_key, delta from public.currency_ledger where reason = 'arena_reward'");
    expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(rows.length);
    expect(Math.max(...rows.map((r) => r.delta))).toBeLessThanOrEqual(60); // winner of a single battle earns well under 100
    expect(await auditLedger(db)).toEqual([]);
  });
});

describe("inventory & equipment", () => {
  async function heroWithItem(over: { claimed?: boolean; template?: string } = {}) {
    const [hero] = await seedHeroes(db, 1);
    const cls = (await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero]))[0]!.class_id;
    const template = over.template ?? `${cls}_weapon_common`;
    const [item] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [hero, template]);
    if (over.claimed !== false) {
      const tid = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [hero]))[0]!.telegram_user_id;
      await claimCharacter(db, tid, new Date());
    }
    return { hero: hero!, item: item!.id, cls };
  }

  it("claimed owners can equip gear; equipped gear changes effective stats; unclaimed heroes cannot", async () => {
    const claimed = await heroWithItem();
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    const before = (await loadFighters(db, [claimed.hero], ruleset, settings))[0]!;
    expect(await setEquipped(db, claimed.hero, claimed.item, true)).toEqual({ ok: true, equipped: true });
    const after = (await loadFighters(db, [claimed.hero], ruleset, settings))[0]!;
    // gear changes how the hero FIGHTS (effective stats) — but never its PWR, which is the power of its generated, rarity-tier stats
    expect(after.stats.str + after.stats.def + after.stats.int + after.stats.agi + after.stats.hp).toBeGreaterThan(before.stats.str + before.stats.def + before.stats.int + before.stats.agi + before.stats.hp);
    expect(after.power).toBe(before.power);
    expect(after.generatedStats).toEqual(before.generatedStats);

    await resetDb(db);
    const unclaimed = await heroWithItem({ claimed: false });
    expect(await setEquipped(db, unclaimed.hero, unclaimed.item, true)).toEqual({ ok: false, reason: "NOT_CLAIMED" });
  });

  it("enforces the class restriction and ownership — there is no level requirement", async () => {
    const h = await heroWithItem();
    const wrongClass = h.cls === "mage" ? "warrior_weapon_common" : "mage_weapon_common";
    const [bad] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [h.hero, wrongClass]);
    expect(await setEquipped(db, h.hero, bad!.id, true)).toEqual({ ok: false, reason: "CLASS_RESTRICTED" });
    const [high] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [h.hero, `${h.cls}_weapon_legendary`]);
    // A top-rarity item for the hero's own class is usable straight away: gear is not gated behind XP or levels.
    expect(await setEquipped(db, h.hero, high!.id, true)).toEqual({ ok: true, equipped: true });
    expect((await listInventory(db, h.hero)).find((i) => i.id === high!.id)).toMatchObject({ usable: true, equipped: true });
    const [other] = await seedHeroes(db, 1);
    expect(await setEquipped(db, other!, h.item, true)).toEqual({ ok: false, reason: "NOT_FOUND" }); // someone else's item
  });

  it("one item per slot: equipping a second item swaps; the DB also forbids double-equip", async () => {
    const h = await heroWithItem();
    const [second] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot) values ($1, $2, 'WEAPON') returning id", [h.hero, `${h.cls}_weapon_rare`]);
    await setEquipped(db, h.hero, h.item, true);
    await setEquipped(db, h.hero, second!.id, true);
    const eq = await db.query<{ id: string }>("select id from public.inventory_items where character_id = $1 and equipped", [h.hero]);
    expect(eq.map((e) => e.id)).toEqual([second!.id]);
    await expect(db.query("update public.inventory_items set equipped = true where id = $1", [h.item])).rejects.toThrow(/inventory_items_one_equipped_per_slot|duplicate/);
  });

  it("items drop from the arena deterministically and idempotently per battle", async () => {
    await seedHeroes(db, 16);
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    await db.query("update public.game_settings set value = jsonb_set(value, '{drops,chanceByPlacement}', '[1,1,1,1,1,1,1,1]'::jsonb) where key = 'progression'");
    for (let s = 0; s < 80; s++) { await advanceArena(db, ctx); clock.advance(1000); }
    const settled = await count(db, "arena_battles", "status = 'SETTLED'");
    expect(settled).toBeGreaterThan(0);
    // chance 100% but only class-appropriate templates drop; at most one per hero per battle
    const dups = await db.query("select character_id, source_ref from public.inventory_items group by 1, 2 having count(*) > 1");
    expect(dups).toHaveLength(0);
    expect(await count(db, "inventory_items")).toBeGreaterThan(0);
    const items = await listInventory(db, (await db.query<{ character_id: string }>("select character_id from public.inventory_items limit 1"))[0]!.character_id);
    expect(items[0]).toMatchObject({ equipped: false });
  });

  it("the retired item_templates.min_level column is not enforced anywhere", async () => {
    const h = await heroWithItem();
    await db.query("update public.item_templates set min_level = 500 where id = $1", [`${h.cls}_weapon_common`]);
    expect((await listInventory(db, h.hero))[0]).toMatchObject({ usable: true });
    expect(await setEquipped(db, h.hero, h.item, true)).toEqual({ ok: true, equipped: true });
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    const fighter = (await loadFighters(db, [h.hero], ruleset, settings))[0]!;
    expect(fighter.breakdown.gear.hp + fighter.breakdown.gear.str + fighter.breakdown.gear.def + fighter.breakdown.gear.int + fighter.breakdown.gear.agi + fighter.breakdown.gear.cha + fighter.breakdown.gear.luck).toBeGreaterThan(0);
  });

  it("tactics are claimed-owner only", async () => {
    const claimed = await heroWithItem();
    expect(await setTactic(db, claimed.hero, "AGGRESSIVE")).toBe(true);
    await resetDb(db);
    const u = await heroWithItem({ claimed: false });
    expect(await setTactic(db, u.hero, "AGGRESSIVE")).toBe(false);
    // and unclaimed heroes always fight with the class default regardless of stored value
    await db.query("update public.characters set tactic = 'AGGRESSIVE' where id = $1", [u.hero]);
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    expect((await loadFighters(db, [u.hero], ruleset, settings))[0]!.tactic).toBe("BALANCED");
  });
});
