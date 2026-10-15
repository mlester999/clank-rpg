import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ACHIEVEMENTS } from "@/domain/content/achievements";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import { evaluateAchievements, grantAchievement, setDisplayTitle } from "@/server/services/achievements";
import { auditLedger, getBalance } from "@/server/services/economy";
import { claimCharacter } from "@/server/services/identity";
import { getCharacterDto } from "@/server/services/views";

import { createTestDb, resetDb, seedHeroes } from "../support/db";

/**
 * ACHIEVEMENT REWARDS AND TITLES.
 *   · every achievement pays a one-off Clank Gold grant — when it unlocks by metric AND when an admin grants it — and never twice;
 *   · an unlock does NOT put a title on the hero any more: the member chooses which unlocked title to show (setDisplayTitle);
 *   · the title text always comes from the achievement's own reward, only an UNLOCKED, non-archived achievement can be chosen, and only by the claimed owner.
 */
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

const goldOf = (id: string) => DEFAULT_ACHIEVEMENTS.find((a) => a.id === id)!.reward.gold!;
const titleOf = async (hero: string) => (await db.query<{ title: string | null }>("select title from public.characters where id = $1", [hero]))[0]!.title;
const claimed = async (tid: number): Promise<string> => {
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  expect((await claimCharacter(db, tid, new Date())).ok).toBe(true);
  return hero!;
};
/** Gives a hero an ACTIVE-season arena record big enough to unlock Arena Debut / First Blood without a real fight. */
async function giveRecord(hero: string, rec: { battles: number; eliminations: number }): Promise<void> {
  const [season] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE' limit 1");
  await db.query(
    `insert into public.season_character_stats (season_id, character_id, battles, eliminations) values ($1, $2, $3, $4)
     on conflict (season_id, character_id) do update set battles = excluded.battles, eliminations = excluded.eliminations`,
    [season!.id, hero, rec.battles, rec.eliminations],
  );
}

describe("every shipped achievement has a title and a Gold reward", () => {
  it("the stored reference rows (what a fresh database is seeded with) carry both", async () => {
    const rows = await db.query<{ id: string; reward: { title?: string; gold?: number } }>("select id, reward from public.achievements order by id");
    expect(rows.length).toBe(DEFAULT_ACHIEVEMENTS.length);
    for (const r of rows) {
      expect(r.reward.title, r.id).toBeTruthy();
      expect(r.reward.gold, r.id).toBeGreaterThan(0);
    }
  });
});

describe("Gold on unlock", () => {
  it("a metric unlock pays its Gold once and puts NO title on the hero; a re-evaluation pays nothing more", async () => {
    const hero = await claimed(8201);
    await giveRecord(hero, { battles: 1, eliminations: 1 });
    const unlocked = await evaluateAchievements(db, hero);
    expect(unlocked).toEqual(expect.arrayContaining(["arena_debut", "first_blood"]));
    expect(await getBalance(db, hero)).toBe(goldOf("arena_debut") + goldOf("first_blood"));
    expect(await titleOf(hero)).toBeNull(); // chosen by the member, never imposed
    expect(await evaluateAchievements(db, hero)).toEqual([]);
    expect(await getBalance(db, hero)).toBe(goldOf("arena_debut") + goldOf("first_blood"));
    expect(await auditLedger(db)).toEqual([]);
  });

  it("an admin grant pays the achievement's Gold too — once, even if granted again", async () => {
    const hero = await claimed(8202);
    expect(await grantAchievement(db, hero, "og_clanker")).toBe(true);
    expect(await getBalance(db, hero)).toBe(goldOf("og_clanker"));
    expect(await grantAchievement(db, hero, "og_clanker")).toBe(false);
    expect(await getBalance(db, hero)).toBe(goldOf("og_clanker"));
    expect(await auditLedger(db)).toEqual([]);
  });

  it("an achievement whose reward has no Gold pays nothing and still unlocks", async () => {
    const hero = await claimed(8203);
    await db.query(`update public.achievements set reward = '{"badge":"debut","title":"Rookie"}'::jsonb where id = 'arena_debut'`);
    await giveRecord(hero, { battles: 1, eliminations: 0 });
    expect(await evaluateAchievements(db, hero)).toContain("arena_debut");
    expect(await getBalance(db, hero)).toBe(0);
  });
});

describe("choosing the title that shows above the name", () => {
  it("the owner picks one unlocked title, swaps it, and removes it; the text comes from the achievement", async () => {
    const hero = await claimed(8204);
    await giveRecord(hero, { battles: 1, eliminations: 1 });
    await evaluateAchievements(db, hero);

    expect(await setDisplayTitle(db, hero, "arena_debut")).toEqual({ ok: true, title: "Rookie" });
    expect(await titleOf(hero)).toBe("Rookie");
    expect(await setDisplayTitle(db, hero, "first_blood")).toEqual({ ok: true, title: "First Blood" });
    expect(await titleOf(hero)).toBe("First Blood");
    expect(await setDisplayTitle(db, hero, null)).toEqual({ ok: true, title: null });
    expect(await titleOf(hero)).toBeNull();
  });

  it("an achievement that is not unlocked, an unknown one and a disabled one cannot be chosen — the title stays as it was", async () => {
    const hero = await claimed(8205);
    await giveRecord(hero, { battles: 1, eliminations: 0 });
    await evaluateAchievements(db, hero);
    await setDisplayTitle(db, hero, "arena_debut");
    expect(await setDisplayTitle(db, hero, "legend_of_the_pit")).toEqual({ ok: false, reason: "NOT_UNLOCKED" });
    expect(await setDisplayTitle(db, hero, "no_such_achievement")).toEqual({ ok: false, reason: "NOT_UNLOCKED" });
    await db.query("update public.achievements set enabled = false where id = 'arena_debut'");
    expect(await setDisplayTitle(db, hero, "arena_debut")).toEqual({ ok: false, reason: "NOT_UNLOCKED" });
    expect(await titleOf(hero)).toBe("Rookie");
  });

  it("an ARCHIVED unlock (a development one) no longer counts, and an achievement without a title cannot be shown", async () => {
    const hero = await claimed(8206);
    await giveRecord(hero, { battles: 1, eliminations: 0 });
    await evaluateAchievements(db, hero);
    await db.query("update public.character_achievements set archived_at = now() where character_id = $1 and achievement_id = 'arena_debut'", [hero]);
    expect(await setDisplayTitle(db, hero, "arena_debut")).toEqual({ ok: false, reason: "NOT_UNLOCKED" });
    await grantAchievement(db, hero, "og_clanker");
    await db.query(`update public.achievements set reward = '{"badge":"og","gold":100}'::jsonb where id = 'og_clanker'`);
    expect(await setDisplayTitle(db, hero, "og_clanker")).toEqual({ ok: false, reason: "NO_TITLE" });
  });

  it("an unclaimed hero cannot choose a title, and neither can anyone for a hero that does not exist", async () => {
    const [hero] = await seedHeroes(db, 1, { startId: 8207 }); // not claimed
    await grantAchievement(db, hero!, "og_clanker");
    expect(await setDisplayTitle(db, hero!, "og_clanker")).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    expect(await setDisplayTitle(db, hero!, null)).toEqual({ ok: false, reason: "NOT_CLAIMED" });
    expect(await setDisplayTitle(db, "00000000-0000-4000-8000-000000000000", "og_clanker")).toEqual({ ok: false, reason: "NOT_FOUND" });
    expect(await titleOf(hero!)).toBeNull();
  });

  it("the hero's public data carries the reward of every achievement and the title currently shown", async () => {
    const hero = await claimed(8208);
    await grantAchievement(db, hero, "og_clanker");
    await setDisplayTitle(db, hero, "og_clanker");
    const dto = (await getCharacterDto(db, hero, DEFAULT_SETTINGS, null))!;
    expect(dto.title).toBe("OG Clanker");
    const og = dto.achievements.find((a) => a.id === "og_clanker")!;
    expect(og).toMatchObject({ unlocked: true, title: "OG Clanker", gold: goldOf("og_clanker") });
    for (const a of dto.achievements) {
      expect(a.title, a.id).toBeTruthy();
      expect(a.gold, a.id).toBeGreaterThan(0);
    }
  });
});
