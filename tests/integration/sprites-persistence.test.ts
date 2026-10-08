import type { Rarity } from "@/domain/character/appearance";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AppearanceParts } from "@/domain/character/appearance";
import { deriveSpriteConfig, type SpriteConfig } from "@/domain/sprites/config";
import { loadClasses, loadRuleset, loadSettings, saveSetting } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { createSpecialCharacter } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { fighterToUnit, loadFighters } from "@/server/services/characters";
import { seedReferenceData } from "@/server/seed/reference";
import { backfillSpriteConfigs } from "@/server/services/sprites";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  // This suite emulates LEGACY rows (NULL sprite) and catalogue drift by editing the look columns directly. The projection guard — which refuses a
  // commit where a hero's look differs from its current hero version — is covered in hero-versions.test.ts, so it is switched off for this file.
  await db.exec("alter table public.character_appearances disable trigger character_appearances_hero_projection");
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

async function fighterOf(id: string) {
  const settings = await loadSettings(db);
  const { ruleset } = await loadRuleset(db, settings);
  return (await loadFighters(db, [id], ruleset, settings))[0]!;
}
const rowOf = async (id: string) =>
  (await db.query<{ sprite: SpriteConfig | null; cosmetic_overrides: Record<string, unknown>; parts: AppearanceParts; rarity: string; class_id: string }>(
    "select ca.sprite, ca.cosmetic_overrides, ca.parts, ca.rarity, c.class_id from public.character_appearances ca join public.characters c on c.id = ca.character_id where ca.character_id = $1",
    [id],
  ))[0]!;

describe("a hero's look is persisted and deterministic", () => {
  it("creating a hero stores the sprite config (derived from the rolled appearance) with no overrides", async () => {
    const [id] = await seedHeroes(db, 1);
    const row = await rowOf(id!);
    const classes = await loadClasses(db, false);
    const look = classes.find((c) => c.id === row.class_id)!.look;
    expect(row.sprite).not.toBeNull();
    expect(row.sprite).toEqual(deriveSpriteConfig(row.parts, look));
    expect(row.cosmetic_overrides).toEqual({});
  });

  it("special (admin-authored) characters get a stored look too", async () => {
    const { id } = await createSpecialCharacter(db, { name: "Team Rivet", classId: "tank", role: "Lead", rarity: "LEGENDARY", appearanceSeed: "rivet" }, "admin");
    const row = await rowOf(id);
    expect(row.sprite).toMatchObject({ v: 1 });
    expect(row.sprite!.slots.weapon).toBe("weapon.mace");
    expect(row.sprite!.slots.aura).toBe("aura.flame"); // legendary flair
  });

  it("legacy rows (NULL sprite) are backfilled to exactly the same deterministic config, once", async () => {
    const ids = await seedHeroes(db, 6);
    const before = await Promise.all(ids.map(async (id) => (await rowOf(id)).sprite));
    await db.exec("update public.character_appearances set sprite = null");
    expect(await backfillSpriteConfigs(db)).toBe(6);
    const after = await Promise.all(ids.map(async (id) => (await rowOf(id)).sprite));
    expect(after).toEqual(before);
    expect(await backfillSpriteConfigs(db)).toBe(0); // idempotent
    // …and it runs as part of the normal boot seeding
    await db.exec("update public.character_appearances set sprite = null");
    const seeded = await seedReferenceData(db);
    expect(seeded.inserted.spriteConfigs).toBe(6);
  });

  it("a stored look wins: it never re-derives, so a catalogue change cannot alter an existing hero", async () => {
    const [id] = await seedHeroes(db, 1);
    const row = await rowOf(id!);
    const edited = { ...row.sprite!, hue: 11, slots: { ...row.sprite!.slots, hair: "hair.5" } };
    await db.query("update public.character_appearances set sprite = $2::jsonb where character_id = $1", [id, JSON.stringify(edited)]);
    const f = await fighterOf(id!);
    expect(f.appearance.sprite).toMatchObject({ hue: 11, slots: { hair: "hair.5" } });
  });
});

describe("cosmetics never touch combat", () => {
  it("rarity, overrides and admin-disabled items change the picture and NOTHING in the combat inputs or POWER", async () => {
    const [id] = await seedHeroes(db, 1);
    const base = await fighterOf(id!);
    const baseUnit = fighterToUnit(base);

    // legendary flair + a player-chosen crown + a (rejected) class-incompatible weapon override
    await db.query("update public.character_appearances set rarity = 'LEGENDARY', cosmetic_overrides = $2::jsonb where character_id = $1", [
      id,
      JSON.stringify({ headgear: "headgear.crown", aura: "aura.flame", weapon: "weapon.nope" }),
    ]);
    const dressed = await fighterOf(id!);
    expect(dressed.appearance.sprite.slots.headgear).toBe("headgear.crown");
    expect(dressed.appearance.sprite.slots.aura).toBe("aura.flame");
    expect(dressed.appearance.sprite.slots.weapon).toBe(base.appearance.sprite.slots.weapon); // invalid override ignored
    expect(fighterToUnit(dressed)).toEqual(baseUnit);
    expect(dressed.power).toBe(base.power);
    expect(dressed.stats).toEqual(base.stats);

    // admin kill-switch: the item disappears from the look, again without any combat effect
    const settings = await loadSettings(db);
    await saveSetting(db, "visuals", { ...settings.visuals, disabledCosmetics: ["headgear.crown", "aura.flame"] }, "test");
    const muted = await fighterOf(id!);
    expect(muted.appearance.sprite.slots.headgear).not.toBe("headgear.crown");
    expect(muted.appearance.sprite.slots.aura).toBeUndefined();
    expect(fighterToUnit(muted)).toEqual(baseUnit);
  });

  it("a battle simulated with different cosmetics is bit-for-bit the same fight (events hash)", async () => {
    await seedHeroes(db, 16);
    const clockA = new FakeClock();
    await advanceArena(db, arenaCtx(clockA, { secureSeed: () => "fixed-seed" }));
    const a = (await db.query<{ events_hash: string; id: string }>("select id, events_hash from public.arena_battles where status = 'SIMULATED'"))[0]!;
    // dress every hero in legendary flair, then replay the SAME stored snapshot + seed
    await db.exec(`update public.character_appearances set rarity = 'LEGENDARY', cosmetic_overrides = '{"aura":"aura.flame","cape":"cape.default"}'::jsonb`);
    const { replayBattle, clearReplayCache } = await import("@/server/services/arena");
    clearReplayCache();
    const re = await replayBattle(db, a.id);
    expect(re!.outcome.eventsHash).toBe(a.events_hash);
  });
});

describe("the arena freezes the look with the battle", () => {
  it("fighters in the arena state carry the resolved look as it was when the battle was simulated", async () => {
    const heroes = await seedHeroes(db, 16);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state = () => getArenaState(db, clock.ms, settings, { allowDemo: true, classes });
    const before = (await state()).current!.fighters;
    expect(before.every((f) => (f.appearance.sprite as SpriteConfig).v === 1)).toBe(true);
    // change every hero's look afterwards: the battle on stage must not change retroactively
    await db.exec(`update public.character_appearances set sprite = jsonb_set(sprite, '{hue}', '-5')`);
    const after = (await state()).current!.fighters;
    expect(after.map((f) => f.appearance.sprite)).toEqual(before.map((f) => f.appearance.sprite));
    expect(heroes).toHaveLength(16);
  });

  it("battles simulated BEFORE layered sprites (no frozen look in the snapshot) fall back to the stored look, then to derivation", async () => {
    await seedHeroes(db, 16);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    // Fixture: fabricate an "old" battle by stripping the frozen sprite configs from its snapshot.
    // (A simulated battle's snapshot is frozen by a trigger; lift it for this fixture only.)
    await db.exec("alter table public.arena_battles disable trigger arena_battles_guard");
    await db.exec(`update public.arena_battles set snapshot = jsonb_set(snapshot, '{display}', (select jsonb_agg(d #- '{appearance,sprite}') from jsonb_array_elements(snapshot->'display') d)) where status = 'SIMULATED'`);
    await db.exec("alter table public.arena_battles enable trigger arena_battles_guard");
    const stripped = await db.query<{ n: number }>("select count(*)::int as n from public.arena_battles b, jsonb_array_elements(b.snapshot->'display') d where b.status = 'SIMULATED' and d->'appearance' ? 'sprite'");
    expect(stripped[0]!.n).toBe(0); // the fixture really is an old-style snapshot

    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state = () => getArenaState(db, clock.ms, settings, { allowDemo: true, classes });
    // 1) stored look exists → used
    const viaStored = (await state()).current!.fighters;
    for (const f of viaStored) expect(f.appearance.sprite).toMatchObject({ v: 1 });
    // 2) nothing stored either → the DTO carries none and the shared resolver derives the SAME look the stored one had
    const expected = viaStored.map((f) => f.appearance.sprite);
    await db.exec("update public.character_appearances set sprite = null");
    const viaDerivation = (await state()).current!.fighters;
    const { resolveSpriteConfig } = await import("@/domain/sprites/config");
    viaDerivation.forEach((f, i) => {
      expect(f.appearance.sprite).toBeUndefined();
      const look = classes.find((c) => c.id === f.classId)!.look;
      expect(resolveSpriteConfig({ stored: f.appearance.sprite, parts: f.appearance.parts as AppearanceParts, look, rarity: f.appearance.rarity as Rarity })).toEqual(expected[i]);
    });
  });
});

describe("settings and flags for the new features", () => {
  it("picks and visuals are new, validated, admin-editable settings with safe defaults", async () => {
    const s = await loadSettings(db);
    expect(s.picks).toEqual({ rewardGold: 2 });
    expect(s.visuals).toEqual({ spriteSet: "clank-dev-v2", disabledCosmetics: [] }); // hero renderer v2
    await expect(saveSetting(db, "picks", { rewardGold: 5000 }, "t")).rejects.toThrow(); // out of range
    await expect(saveSetting(db, "picks", { rewardGold: 5, extra: true }, "t")).rejects.toThrow(); // strict
    await expect(saveSetting(db, "visuals", { spriteSet: "../../evil", disabledCosmetics: [] }, "t")).rejects.toThrow(); // path-safe ids only
    await saveSetting(db, "picks", { rewardGold: 0 }, "t");
    expect((await loadSettings(db)).picks.rewardGold).toBe(0);
  });

  it("the Picks feature flag exists and is ON by default; no betting flag is seeded any more", async () => {
    const flags = Object.fromEntries((await db.query<{ key: string; enabled: boolean }>("select key, enabled from public.feature_flags")).map((f) => [f.key, f.enabled]));
    expect(flags["arena.picks"]).toBe(true);
    expect(Object.keys(flags).filter((k) => k.startsWith("betting."))).toEqual([]);
  });

  it("existing databases (settings rows without the new keys) still load, falling back to defaults", async () => {
    await db.exec("delete from public.game_settings where key in ('picks', 'visuals')");
    const s = await loadSettings(db);
    expect(s.picks.rewardGold).toBe(2);
    expect(s.visuals.spriteSet).toBe("clank-dev-v2");
  });
});
