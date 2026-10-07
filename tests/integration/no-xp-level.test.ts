import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SEASON_RANKS, DEFAULT_SETTINGS } from "@/domain/settings";
import { simulateBattle } from "@/domain/combat/engine";
import { loadClasses, loadRuleset, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { putAchievement } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { evaluateAchievements } from "@/server/services/achievements";
import { fighterToUnit, loadFighters, refreshPower } from "@/server/services/characters";
import { claimCharacter } from "@/server/services/identity";
import { getArenaState, getCharacterDto, searchHeroes } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * Permanent XP and character levels are gone. Heroes keep identity, class, stats, holdings, gear, achievements,
 * Gold and their Arena record — but fighting never makes anyone permanently stronger, so a member who qualifies
 * later starts level with one who qualified long ago.
 */

let db: Db;
let clock: FakeClock;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock();
});

async function runUntil(until: () => Promise<boolean>, maxSeconds = 3000) {
  const ctx = arenaCtx(clock);
  for (let s = 0; s < maxSeconds; s++) {
    await advanceArena(db, ctx);
    if (await until()) return;
    clock.advance(1000);
  }
  throw new Error("condition not reached");
}
const settled = () => count(db, "arena_battles", "status = 'SETTLED'");

/** Every column of a hero that is NOT the Arena record — what the removal (and a battle) must leave alone. */
async function permanentIdentity(ids: string[]): Promise<string> {
  const rows = await db.query(
    `select c.id, c.kind, c.telegram_user_id, c.class_id, c.name, c.name_override, c.level, c.xp, c.power, c.status, c.origin, c.tactic, c.title,
            to_jsonb(s) - 'updated_at' as stats, ca.rarity, ca.parts, ca.seed, ca.sprite,
            (select count(*) from public.character_claims x where x.character_id = c.id) as claims
       from public.characters c join public.character_stats s on s.character_id = c.id join public.character_appearances ca on ca.character_id = c.id
      where c.id = any($1::uuid[]) order by c.id`,
    [ids],
  );
  return JSON.stringify(rows);
}

describe("the Arena awards no XP and never changes a hero's permanent build", () => {
  it("after many battles: xp / level / class / stats / POWER / appearance are untouched; only the Arena record, season points and Gold move", async () => {
    const ids = await seedHeroes(db, 16);
    const before = await permanentIdentity(ids);
    await runUntil(async () => (await settled()) >= 6);
    expect(await permanentIdentity(ids)).toBe(before);

    expect(await count(db, "characters", "arena_battles > 0")).toBeGreaterThan(0); // the record DID grow
    expect(await count(db, "season_character_stats", "points > 0")).toBeGreaterThan(0);
    expect(await count(db, "currency_ledger", "reason = 'arena_reward'")).toBeGreaterThan(0);
    expect(await count(db, "characters", "xp <> 0 or level <> 1")).toBe(0);
    expect(await count(db, "arena_participants", "xp_awarded <> 0")).toBe(0);
  });

  it("the stored POWER stays exactly what a fresh recomputation gives, battle after battle", async () => {
    const ids = await seedHeroes(db, 8);
    await runUntil(async () => (await settled()) >= 3);
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    for (const id of ids) {
      const stored = (await db.query<{ power: number }>("select power from public.characters where id = $1", [id]))[0]!.power;
      expect(await refreshPower(db, id, settings, classes)).toBe(stored);
    }
  });

  it("legacy values in the retired xp / level columns do not change stats, POWER, the combat input or the fight", async () => {
    const ids = await seedHeroes(db, 8);
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    const snapshot = async () => {
      const fighters = await loadFighters(db, ids, ruleset, settings);
      const units = fighters.map(fighterToUnit);
      return { fighters, units, hash: simulateBattle({ seed: "legacy-columns", ruleset, units, maxCombatMs: 30_000 }).eventsHash };
    };
    const clean = await snapshot();
    await db.query("update public.characters set level = 500, xp = 987654321 where id = any($1::uuid[])", [ids]);
    const stuffed = await snapshot();
    expect(stuffed.fighters.map((f) => [f.stats, f.power])).toEqual(clean.fighters.map((f) => [f.stats, f.power]));
    expect(stuffed.units).toEqual(clean.units);
    expect(stuffed.units[0]).not.toHaveProperty("level");
    expect(stuffed.hash).toBe(clean.hash);
  });

  it("a hero with huge legacy xp/level and gear is not locked out of, or boosted in, the arena", async () => {
    const ids = await seedHeroes(db, 8);
    await db.query("update public.characters set level = 99, xp = 5000000 where id = $1", [ids[0]]);
    await runUntil(async () => (await settled()) >= 2);
    expect((await db.query<{ level: number; xp: number }>("select level, xp from public.characters where id = $1", [ids[0]]))[0]).toMatchObject({ level: 99, xp: 5000000 }); // not mutated either way
    expect(await count(db, "arena_participants", `character_id = '${ids[0]}'`)).toBeGreaterThan(0);
  });
});

describe("claiming preserves everything", () => {
  it("claim changes only the claim record — identity, class, stats, POWER, sprite, Gold and record are untouched", async () => {
    const [hero] = await seedHeroes(db, 1);
    const tid = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [hero]))[0]!.telegram_user_id;
    await db.query("update public.characters set arena_battles = 7, arena_wins = 2, arena_top2 = 4 where id = $1", [hero]);
    await db.query("insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ($1, 40, 'test_grant', 'no-xp-claim-1')", [hero]);
    const gold = async () => JSON.stringify(await db.query("select balance, lifetime_earned from public.currency_accounts where character_id = $1", [hero]));
    const record = async () => JSON.stringify(await db.query("select arena_battles, arena_wins, arena_top2 from public.characters where id = $1", [hero]));
    const [identity0, gold0, record0] = [await permanentIdentity([hero!]), await gold(), await record()];
    expect((await claimCharacter(db, tid, new Date())).ok).toBe(true);
    const identity1 = JSON.parse(await permanentIdentity([hero!])) as Array<{ claims: number }>;
    const expected = JSON.parse(identity0) as Array<{ claims: number }>;
    expect(Number(expected[0]!.claims)).toBe(0);
    expect(Number(identity1[0]!.claims)).toBe(1); // the claim record is the ONLY thing that changed
    expected[0]!.claims = identity1[0]!.claims;
    expect(identity1).toEqual(expected);
    expect(await gold()).toBe(gold0);
    expect(await record()).toBe(record0);
  });
});

describe("what players are sent has no level or XP", () => {
  it("arena state: fighters carry class + POWER, results carry battle performance — no level, no xpAwarded", async () => {
    await seedHeroes(db, 16);
    await runUntil(async () => (await settled()) >= 1);
    clock.advance(1000);
    await advanceArena(db, arenaCtx(clock));
    const settings = await loadSettings(db);
    const s = await getArenaState(db, clock.ms, settings, { allowDemo: true, classes: await loadClasses(db, false) });
    expect(s.current).not.toBeNull();
    for (const f of s.current!.fighters) {
      expect(f).not.toHaveProperty("level");
      expect(f.classId).toBeTruthy();
      expect(f.power).toBeGreaterThan(0);
    }
    for (const w of s.recent) for (const f of [w.winner, w.runnerUp]) if (f) expect(f).not.toHaveProperty("level");
    // Jump to just after combat ends so the results rows are present.
    const combatEnds = s.current!.combatEndsAt!;
    const done = await getArenaState(db, combatEnds + 10, settings, { allowDemo: true, classes: await loadClasses(db, false) });
    for (const r of done.current?.results ?? []) {
      expect(Object.keys(r).sort()).toEqual(["characterId", "damageDealt", "eliminations", "finalHp", "goldAwarded", "maxHp", "placement", "slot", "survivedMs"]);
    }
    // KEYS named xp… / level… — never a bare substring: public hero ids are random 12-character strings and can contain "xp" by chance.
    expect(JSON.stringify(done)).not.toMatch(/"(xp\w*|level\w*)"\s*:/i);
  });

  it("hero page: no level / XP / progress fields; primary stats and season rank are present", async () => {
    await seedHeroes(db, 8);
    await runUntil(async () => (await settled()) >= 2);
    const [id] = (await db.query<{ character_id: string }>("select character_id from public.arena_participants limit 1")).map((r) => r.character_id);
    const settings = await loadSettings(db);
    const dto = (await getCharacterDto(db, id!, settings, null))!;
    for (const key of ["level", "xp", "xpIntoLevel", "xpForNextLevel"]) expect(dto).not.toHaveProperty(key);
    for (const b of dto.recentBattles) expect(b).not.toHaveProperty("xp");
    expect(JSON.stringify(dto)).not.toMatch(/"(xp\w*|level\w*)"\s*:/i);
    expect(dto.classId).toBeTruthy();
    expect(dto.power).toBeGreaterThan(0);
    expect(dto.record.battles).toBeGreaterThan(0);
    expect(dto.season?.rank).toMatchObject({ id: "bronze", name: "Bronze" });
    expect((await searchHeroes(db, "Hero", true))[0]).not.toHaveProperty("level");
  });
});

describe("season rank", () => {
  it("is derived from this season's points and moves up as they grow", async () => {
    const [id] = await seedHeroes(db, 1);
    const [season] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'");
    const settings = await loadSettings(db);
    const rankAt = async (points: number) => {
      await db.query(
        `insert into public.season_character_stats (season_id, character_id, points, battles) values ($1, $2, $3, 1)
         on conflict (season_id, character_id) do update set points = excluded.points`,
        [season!.id, id, points],
      );
      return (await getCharacterDto(db, id!, settings, null))!.season!.rank;
    };
    expect(await rankAt(0)).toMatchObject({ name: "Bronze", index: 0, tierCount: 5, next: { name: "Silver" } });
    expect(await rankAt(DEFAULT_SEASON_RANKS[2]!.minPoints)).toMatchObject({ name: "Gold", index: 2 });
    expect(await rankAt(DEFAULT_SEASON_RANKS[4]!.minPoints + 10)).toMatchObject({ name: "Clanker", next: null, pointsToNext: null, progress: 1 });
  });

  it("resets with the season: the same hero is Unranked in a fresh season, and earns the first rung by fighting", async () => {
    const [id] = await seedHeroes(db, 1);
    const settings = await loadSettings(db);
    const [s1] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'");
    await db.query("insert into public.season_character_stats (season_id, character_id, points, battles) values ($1, $2, 5000, 50)", [s1!.id, id]);
    expect((await getCharacterDto(db, id!, settings, null))!.season!.rank.name).toBe("Clanker");
    await db.exec("update public.seasons set status = 'ENDED', ends_at = now() where status = 'ACTIVE'");
    const [s2] = await db.query<{ id: string }>("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 2, 'Development run 2', 'ACTIVE') returning id");
    expect((await getCharacterDto(db, id!, settings, null))!.season).toMatchObject({ name: "Development run 2", points: 0, ranked: false, rank: { name: "Unranked", index: -1 } });
    await db.query("insert into public.season_character_stats (season_id, character_id, points, battles) values ($1, $2, 0, 1)", [s2!.id, id]);
    expect((await getCharacterDto(db, id!, settings, null))!.season).toMatchObject({ ranked: true, rank: { name: "Bronze", index: 0 } });
  });

  it("is status only: the top season rank does not change stats, POWER, or the combat input", async () => {
    const ids = await seedHeroes(db, 8);
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    const [season] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'");
    const before = (await loadFighters(db, ids, ruleset, settings)).map((f) => [f.stats, f.power, fighterToUnit(f)]);
    for (const id of ids) {
      await db.query("insert into public.season_character_stats (season_id, character_id, points, battles, wins) values ($1, $2, 99999, 500, 100)", [season!.id, id]);
    }
    expect((await loadFighters(db, ids, ruleset, settings)).map((f) => [f.stats, f.power, fighterToUnit(f)])).toEqual(before);
  });
});

describe("retired achievements and stored settings from before the removal", () => {
  async function insertLegacyLevelAchievement() {
    await db.query(
      `insert into public.achievements (id, name, description, category, criteria, reward, sort_order)
       values ('level_10', 'Rising Cog', 'Reach character level 10.', 'PROGRESSION', '{"metric":"level","gte":10}'::jsonb, '{"badge":"level10"}'::jsonb, 40)`,
    );
  }

  it("the shipped catalogue has no level achievements", async () => {
    expect(await count(db, "achievements", "criteria->>'metric' = 'level'")).toBe(0);
  });

  it("an old level achievement row is never awarded (even to a hero with a stuffed level column) and is hidden from the profile", async () => {
    await insertLegacyLevelAchievement();
    const [id] = await seedHeroes(db, 1);
    await db.query("update public.characters set level = 30 where id = $1", [id]);
    expect(await evaluateAchievements(db, id!)).not.toContain("level_10");
    expect(await count(db, "character_achievements", "achievement_id = 'level_10'")).toBe(0);
    const dto = (await getCharacterDto(db, id!, await loadSettings(db), null))!;
    expect(dto.achievements.map((a) => a.id)).not.toContain("level_10");
    expect(dto.achievements.length).toBeGreaterThan(0);
  });

  it("achievements are still earned from real activity (Arena record), and admins cannot author a level achievement", async () => {
    const [id] = await seedHeroes(db, 1);
    // (arena achievements count the hero's record in the ACTIVE season)
    await db.query("insert into public.season_character_stats (season_id, character_id, battles) select id, $1, 1 from public.seasons where status = 'ACTIVE'", [id]);
    expect(await evaluateAchievements(db, id!)).toContain("arena_debut");
    await expect(
      putAchievement(db, { id: "lvl_x", name: "x", criteria: { metric: "level", gte: 5 }, reward: { badge: "x" } }, "admin"),
    ).rejects.toThrow();
  });

  it("settings rows stored before the removal (with an XP curve and a level cap) still load and the arena still runs", async () => {
    await db.query(
      `update public.game_settings set value = value || '{"xp":{"curveBase":100,"curveExponent":1.7,"multiplier":1,"participation":12,"placement":[60,40,28,20,14,10,8,6],"elimination":8}}'::jsonb where key = 'progression'`,
    );
    await db.query("update public.game_settings set value = (value - 'seasonRanks') where key = 'progression'"); // …and from before season ranks existed
    await db.query(`update public.game_settings set value = value || '{"levelCap":30}'::jsonb where key = 'character'`);
    const settings = await loadSettings(db);
    expect(settings.progression).not.toHaveProperty("xp");
    expect(settings.character).not.toHaveProperty("levelCap");
    expect(settings.progression.seasonRanks).toEqual(DEFAULT_SETTINGS.progression.seasonRanks);
    await seedHeroes(db, 8);
    await runUntil(async () => (await settled()) >= 1);
    expect(await count(db, "characters", "xp <> 0 or level <> 1")).toBe(0);
  });

  it("class rows and ruleset snapshots stored with a legacy `growth` table still load", async () => {
    const [row] = await db.query<{ definition: Record<string, unknown> }>("select definition from public.character_classes where id = 'warrior'");
    const growth = { hp: 3.4, str: 0.62, def: 0.34, int: 0.1, agi: 0.28, cha: 0.15, luck: 0.18 };
    await db.query("update public.character_classes set definition = $1::jsonb where id = 'warrior'", [JSON.stringify({ ...row!.definition, growth })]);
    const ids = await seedHeroes(db, 8);
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    expect(ruleset.classes.warrior).toBeDefined();
    const fighters = await loadFighters(db, ids, ruleset, settings);
    const warrior = fighters.find((f) => f.classId === "warrior");
    if (warrior) expect(warrior.breakdown.base).toEqual(ruleset.classes.warrior!.base); // the growth table contributes nothing
  });
});
