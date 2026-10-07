import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { loadRuleset, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { evaluateAchievements, grantAchievement, loadMetrics } from "@/server/services/achievements";
import { loadFighters } from "@/server/services/characters";
import { applyLedger } from "@/server/services/economy";
import { claimCharacter } from "@/server/services/identity";
import { listInventory, setEquipped } from "@/server/services/inventory";
import { heroFingerprint, launchSeason1, pauseArena, startArena } from "@/server/services/lifecycle";
import { getCharacterDto } from "@/server/services/views";

import { count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { activeSeason, adminDeps, arenaStatus, freshDevelopment, gamePhase, heroIdentityHash, runUntil } from "../support/lifecycle";

/**
 * DEVELOPMENT PROGRESS DOES NOT CARRY INTO SEASON 1 — the scratch scenario: a Legendary hero (PWR 208) with 50 wins / 80 matches in the test run, 25,000
 * Clank Gold, several development achievements and development loot. The launch keeps the HERO exactly (identity, rarity, PWR, stats, versions) and starts
 * everything else clean — archiving, never deleting.
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
  await freshDevelopment(db);
  clock = new FakeClock();
});

const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
const gold = async (id: string): Promise<number> => Number((await db.query<{ balance: string }>("select balance from public.currency_accounts where character_id = $1", [id]))[0]?.balance ?? 0);
const unlocked = async (id: string): Promise<string[]> =>
  (await db.query<{ achievement_id: string }>("select achievement_id from public.character_achievements where character_id = $1 and archived_at is null order by achievement_id", [id])).map((r) => r.achievement_id);
const ledgerAudit = async () => db.query("select * from public.audit_currency_ledger()");

interface Scenario {
  hero: string;
  other: string;
  devSeasonId: string;
  lootIds: string[];
}

/** Legendary / PWR 208 / 80 matches / 50 wins / 25,000 Gold / achievements (arena + permanent + admin-granted) / loot with some equipped. */
async function developmentHero(): Promise<Scenario> {
  // a genuinely LEGENDARY hero (rarity and PWR belong to its hero version — they can only be generated, never edited in place)
  const legendary = { ...DEFAULT_SETTINGS, character: { ...DEFAULT_SETTINGS.character, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 1 } } };
  const [hero] = (await seedHeroes(db, 1, { settings: legendary })) as [string];
  const [other, ...rest] = (await seedHeroes(db, 17)) as [string, ...string[]];
  void rest;
  const dev = (await activeSeason(db))!;
  // a CLAIMED hero (gear only works for a claimed hero)
  const tid = (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [hero]))[0]!.telegram_user_id;
  expect((await claimCharacter(db, tid, new Date())).ok).toBe(true);
  // the test run's record: Season (development) stats AND the lifetime career counters
  for (const [id, matches, wins, ko] of [[hero, 80, 50, 120], [other, 12, 3, 9]] as const) {
    await db.query(
      `insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (season_id, character_id) do update set points = excluded.points, battles = excluded.battles, wins = excluded.wins, top2 = excluded.top2, eliminations = excluded.eliminations`,
      [dev.id, id, wins * 20, matches, wins, wins + 5, ko],
    );
    await db.query("update public.characters set arena_battles = $2, arena_wins = $3, arena_top2 = $4, arena_eliminations = $5, arena_damage = 9000 where id = $1", [id, matches, wins, wins + 5, ko]);
  }
  await db.query("update public.characters set title = 'Champion' where id = $1", [hero]);
  // Gold
  await applyLedger(db, { characterId: hero, amount: 25000, reason: "arena_drop", refType: "test", refId: "dev", idempotencyKey: "dev-gold-hero" });
  await applyLedger(db, { characterId: other, amount: 340, reason: "arena_drop", refType: "test", refId: "dev", idempotencyKey: "dev-gold-other" });
  // an ARENA achievement the admin granted by hand (a decision, not test activity: it must survive)
  expect(await grantAchievement(db, hero, "reaper")).toBe(true);
  // achievements: arena ones from the record, one community one (a real-member fact) and one the admin granted
  expect(await evaluateAchievements(db, hero)).toEqual(expect.arrayContaining(["arena_debut", "arena_regular", "victor", "champion", "legend_of_the_pit", "first_blood", "podium_regular"]));
  await db.query("insert into public.character_achievements (character_id, achievement_id, context) values ($1, 'voice_of_clank', '{\"metric\":\"telegram_qualifying\",\"value\":600}'::jsonb)", [hero]);
  expect(await grantAchievement(db, hero, "diamond_1d")).toBe(true); // admin-granted (context.granted = admin)
  // loot: three items of the hero's class, two equipped
  const [{ class_id }] = (await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero])) as [{ class_id: string }];
  const lootIds: string[] = [];
  for (const [tpl, slot, equipped] of [[`${class_id}_weapon_legendary`, "WEAPON", true], [`${class_id}_weapon_rare`, "WEAPON", false], [`${class_id}_armor_rare`, "ARMOR", true]] as const) {
    const exists = await db.query("select 1 from public.item_templates where id = $1", [tpl]);
    if (exists.length === 0) continue;
    const [row] = await db.query<{ id: string }>("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, $3, $4) returning id", [hero, tpl, slot, equipped]);
    lootIds.push(row!.id);
  }
  expect(lootIds.length).toBeGreaterThanOrEqual(2);
  // the Arena has run and is stopped (a launch needs a drained Arena)
  await startArena(db, adminDeps(clock));
  await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 2);
  await pauseArena(db, adminDeps(clock));
  await runUntil(db, clock, async () => (await arenaStatus(db)) === "PAUSED");
  return { hero, other, devSeasonId: dev.id, lootIds };
}

const heroRow = async (id: string) =>
  JSON.stringify(
    (await db.query(
      `select c.id, c.public_id, c.telegram_user_id, c.class_id, c.power, c.name, c.status, ca.rarity, ca.parts, ca.sprite, ca.seed, cs.variation,
              (select jsonb_agg(to_jsonb(v) order by v.version_number) from public.hero_versions v where v.character_id = c.id) as versions
         from public.characters c join public.character_appearances ca on ca.character_id = c.id join public.character_stats cs on cs.character_id = c.id where c.id = $1`,
      [id],
    ))[0],
  );

describe("LAUNCH SEASON 1 — development progress does not carry over", () => {
  it("Legendary / PWR 208 / 50 wins / 80 matches / 25,000 Gold / achievements / loot → the same hero, a clean Season 1", async () => {
    const s = await developmentHero();
    const settings = await loadSettings(db);
    const { ruleset } = await loadRuleset(db, settings);
    expect(await gold(s.hero)).toBeGreaterThanOrEqual(25000);
    const goldBefore = await gold(s.hero);
    const totalGoldBefore = Number((await db.query<{ s: string }>("select coalesce(sum(balance), 0)::text as s from public.currency_accounts where balance > 0"))[0]!.s);
    const unlockedBefore = await unlocked(s.hero);
    expect(unlockedBefore.length).toBeGreaterThanOrEqual(9);
    const [fighterWithGear] = await loadFighters(db, [s.hero], ruleset, settings);

    const identityBefore = await heroIdentityHash(db);
    const fingerprintBefore = await heroFingerprint(db);
    const heroBefore = await heroRow(s.hero);
    const power = JSON.parse(heroBefore).power as number;
    expect(JSON.parse(heroBefore).rarity).toBe("LEGENDARY");
    const otherBefore = await heroRow(s.other);
    const versionsBefore = await count(db, "hero_versions");
    const ledgerRowsBefore = await count(db, "currency_ledger");
    const lootBefore = await count(db, "inventory_items"); // (the two test battles dropped some loot too)
    const heroLootBefore = await count(db, "inventory_items", `character_id = '${s.hero}'`);
    const dev = (await getCharacterDto(db, s.hero, settings, null))!;
    expect(dev.record.battles).toBeGreaterThanOrEqual(80); // (80 / 50 seeded, plus whatever the two test battles added)
    expect(dev.record.wins).toBeGreaterThanOrEqual(50);

    const launched = await launchSeason1(db, adminDeps(clock), LAUNCH);
    expect(await gamePhase(db)).toBe("LIVE");
    expect(launched.economy.lootArchived).toBe(lootBefore);
    expect(launched.economy.achievementsArchived).toBeGreaterThanOrEqual(7);
    expect(Number(launched.economy.goldReset)).toBe(totalGoldBefore);
    expect(launched.economy.goldAccountsReset).toBeGreaterThanOrEqual(2);

    // ── the HERO: byte for byte ──────────────────────────────────────────────────────────────────────────────────
    expect(await heroRow(s.hero)).toBe(heroBefore); // id, public id, Telegram link, class, PWR 208, name, status, LEGENDARY, parts, sprite, stats, every version
    expect(await heroRow(s.other)).toBe(otherBefore);
    expect(await heroIdentityHash(db)).toEqual(identityBefore);
    expect(await heroFingerprint(db)).toEqual(fingerprintBefore);
    expect(await count(db, "hero_versions")).toBe(versionsBefore); // not a reroll
    expect(JSON.parse(await heroRow(s.hero))).toMatchObject({ rarity: "LEGENDARY", power });

    // ── SEASON 1: clean ──────────────────────────────────────────────────────────────────────────────────────────
    const after = (await getCharacterDto(db, s.hero, settings, null))!;
    expect(after.record).toMatchObject({ battles: 0, wins: 0, top2: 0, eliminations: 0 });
    expect(after.season).toMatchObject({ kind: "COMPETITIVE", number: 1, battles: 0, wins: 0, points: 0, ranked: false, rank: { name: "Unranked" } });
    // Clank Gold: 0 — and the ledger is complete (the offset is an entry, nothing was edited or deleted)
    expect(await gold(s.hero)).toBe(0);
    expect(await gold(s.other)).toBe(0);
    expect(await count(db, "currency_ledger")).toBeGreaterThan(ledgerRowsBefore);
    expect(await ledgerAudit()).toEqual([]);
    const offsets = await db.query<{ delta: string; reason: string }>("select delta::text, reason from public.currency_ledger where reason = 'season_launch_reset' and character_id = $1", [s.hero]);
    expect(offsets).toEqual([{ delta: String(-goldBefore), reason: "season_launch_reset" }]);
    // Achievements: no progress, nothing unlocked from development…
    expect(await loadMetrics(db, s.hero)).toMatchObject({ battles: 0, wins: 0, top2: 0, eliminations: 0 });
    const keep = await unlocked(s.hero);
    expect(keep).toEqual(["diamond_1d", "reaper", "voice_of_clank"]); // …except the permanent ones: community fact + admin grants (even of an arena achievement)
    expect(after.achievements.filter((a) => a.unlocked).map((a) => a.id).sort()).toEqual(["diamond_1d", "reaper", "voice_of_clank"]);
    expect(await evaluateAchievements(db, s.hero)).toEqual([]); // and a re-evaluation does NOT hand the development ones back
    // …the development unlocks are archived, not deleted
    const archived = await db.query<{ achievement_id: string }>("select achievement_id from public.character_achievements where character_id = $1 and archived_at is not null order by achievement_id", [s.hero]);
    expect(archived.map((r) => r.achievement_id)).toEqual(expect.arrayContaining(["arena_debut", "champion", "legend_of_the_pit", "victor"]));
    expect(await count(db, "character_achievements", `character_id = '${s.hero}'`)).toBe(keep.length + archived.length);
    // a title that an archived achievement granted is gone
    expect((await db.query<{ title: string | null }>("select title from public.characters where id = $1", [s.hero]))[0]!.title).toBeNull();
    // Loot: not in the inventory, not equipped, no combat stat from it — and still inspectable
    expect(await listInventory(db, s.hero)).toEqual([]);
    expect(await count(db, "inventory_items", `character_id = '${s.hero}' and equipped`)).toBe(0);
    expect(await count(db, "inventory_items", `character_id = '${s.hero}' and archived_at is not null`)).toBe(heroLootBefore);
    expect(await count(db, "inventory_items", "archived_at is null")).toBe(0);
    expect(await count(db, "inventory_items")).toBe(lootBefore); // archived, not deleted
    expect((await setEquipped(db, s.hero, s.lootIds[0]!, true)).ok).toBe(false);
    const [fighterAfter] = await loadFighters(db, [s.hero], ruleset, settings);
    expect(fighterAfter!.stats).not.toEqual(fighterWithGear!.stats); // development gear was part of the old stats…
    // …and the gear component of the hero's stats is zero: it fights with its own stats only
    expect(Object.values(fighterWithGear!.breakdown.gear).some((v) => v > 0)).toBe(true);
    expect(Object.values(fighterAfter!.breakdown.gear).every((v) => v === 0)).toBe(true);

    // ── the development history is preserved and inspectable ────────────────────────────────────────────────────────
    const [devSeason] = await db.query<{ archive: { economy: Record<string, unknown> } }>("select archive from public.seasons where id = $1", [s.devSeasonId]);
    expect(devSeason!.archive.economy).toMatchObject({ lootArchived: lootBefore });
    const [devStats] = await db.query<{ battles: number; wins: number }>("select battles, wins from public.season_character_stats where season_id = $1 and character_id = $2", [s.devSeasonId, s.hero]);
    expect(devStats).toMatchObject({ battles: dev.record.battles, wins: dev.record.wins });
    expect(await db.query("select * from public.audit_development_economy()")).toEqual([]);
    expect(await db.query("select * from public.audit_game_lifecycle()")).toEqual([]);
  });

  it("Season 1 earns everything from zero — and the same achievements can be earned (and paid) again", async () => {
    const s = await developmentHero();
    await launchSeason1(db, adminDeps(clock), LAUNCH);
    const s1 = (await activeSeason(db))!;
    // one official win in Season 1
    await db.query("insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations) values ($1, $2, 20, 1, 1, 1, 1)", [s1.id, s.hero]);
    const earned = await evaluateAchievements(db, s.hero);
    expect(earned.sort()).toEqual(["arena_debut", "first_blood", "victor"]); // exactly what ONE official win earns — nothing pre-completed
    expect(earned).not.toContain("champion");
    expect(await gold(s.hero)).toBe(10); // victor pays its 10 Gold again (a different unlock row)
    expect(await ledgerAudit()).toEqual([]);
  });

  it("permanent achievements are exactly the community / chain / admin-granted ones — arena ones are the seasonal ones", async () => {
    const { ARENA_ACHIEVEMENT_METRICS, DEFAULT_ACHIEVEMENTS } = await import("@/domain/content/achievements");
    const permanent = DEFAULT_ACHIEVEMENTS.flatMap((a) => ("metric" in a.criteria && !(ARENA_ACHIEVEMENT_METRICS as readonly string[]).includes(a.criteria.metric) ? [a.criteria.metric] : []));
    expect([...new Set(permanent)].sort()).toEqual(["bonded_tokens_held", "diamond_days", "telegram_active_days", "telegram_qualifying"]);
    expect([...ARENA_ACHIEVEMENT_METRICS].sort()).toEqual(["battles", "eliminations", "top2", "wins"]);
  });

  it("a launch that is refused archives nothing (the reward-liability refusal itself is covered by lifecycle-rewards.test.ts)", async () => {
    const s = await developmentHero();
    const before = await gold(s.hero);
    await expect(launchSeason1(db, adminDeps(clock), { confirmation: "wrong" })).rejects.toThrow();
    expect(await gold(s.hero)).toBe(before);
    expect(await listInventory(db, s.hero)).not.toEqual([]);
    expect((await unlocked(s.hero)).length).toBeGreaterThanOrEqual(9);
  });
});
