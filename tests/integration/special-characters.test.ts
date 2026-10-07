import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadRuleset, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { createSpecialCharacter, patchHero } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { loadFighters } from "@/server/services/characters";
import { claimCharacter } from "@/server/services/identity";

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

const SPEC = { name: "Team Rivet", classId: "tank", role: "Community lead", bio: "Hand-crafted.", rarity: "LEGENDARY", fixedStats: { hp: 300, str: 30, def: 30, int: 8, agi: 12, cha: 20, luck: 10 }, appearanceSeed: "team-rivet" };

describe("special characters (team/staff heroes)", () => {
  it("are admin-authored, start INACTIVE, and are audit-logged", async () => {
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    const [row] = await db.query<{ kind: string; status: string; telegram_user_id: number | null; origin: string }>("select kind, status, telegram_user_id, origin from public.characters where id = $1", [id]);
    expect(row).toMatchObject({ kind: "SPECIAL_CHARACTER", status: "INACTIVE", telegram_user_id: null, origin: "ADMIN" });
    expect(await count(db, "special_character_profiles")).toBe(1);
    expect((await db.query<{ action: string }>("select action from public.admin_audit_log")).map((a) => a.action)).toEqual(["special.create"]);
  });

  it("use their authored stats exactly, bypassing class baselines and bonuses", async () => {
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    const [f] = await loadFighters(db, [id], ruleset, settings);
    expect(f!.stats).toEqual(SPEC.fixedStats);
    expect(f!.kind).toBe("SPECIAL_CHARACTER");
  });

  it("have no level or XP: the admin API refuses them, and the stored row keeps the defaults", async () => {
    await expect(createSpecialCharacter(db, { ...SPEC, level: 12 }, "admin")).rejects.toThrow();
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    const [row] = await db.query<{ level: number; xp: number }>("select level, xp from public.characters where id = $1", [id]);
    expect(row).toMatchObject({ level: 1, xp: 0 });
  });

  it("stay out of the arena until activated, then fight like anyone else", async () => {
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    await seedHeroes(db, 8);
    const clock = new FakeClock();
    await advanceArena(db, arenaCtx(clock));
    expect(await count(db, "arena_participants", `character_id = '${id}'`)).toBe(0);

    await resetDb(db);
    const again = await createSpecialCharacter(db, SPEC, "admin");
    await patchHero(db, again.id, { status: "ACTIVE" }, "admin");
    await seedHeroes(db, 7);
    await advanceArena(db, arenaCtx(new FakeClock()));
    // With exactly 8 eligible heroes the same eight also line up for the next battle, so look at the one on stage (battle 1).
    const onStage = await db.query<{ n: number }>(
      `select count(*)::int as n from public.arena_participants p join public.arena_battles b on b.id = p.battle_id
        where b.sequence = 1 and p.character_id = $1`,
      [again.id],
    );
    expect(onStage[0]!.n).toBe(1);
  });

  it("cannot be claimed through the community flow and cannot be created with an unknown class", async () => {
    await expect(createSpecialCharacter(db, { ...SPEC, classId: "nonexistent" }, "admin")).rejects.toMatchObject({ code: "UNKNOWN_CLASS" });
    await expect(createSpecialCharacter(db, { ...SPEC, fixedStats: { ...SPEC.fixedStats, hp: 0 } }, "admin")).rejects.toThrow();
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    expect(await claimCharacter(db, 12345, new Date())).toEqual({ ok: false, reason: "NO_HERO" });
    expect(id).toBeTruthy();
  });

  it("class changes are blocked even for special characters unless an audited override is set", async () => {
    const { id } = await createSpecialCharacter(db, SPEC, "admin");
    await expect(db.query("update public.characters set class_id = 'mage' where id = $1", [id])).rejects.toThrow(/permanent/);
  });
});
