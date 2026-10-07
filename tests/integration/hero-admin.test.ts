import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { AdminError, patchHero, renameHero, setHeroNote, telegramEligibilityOverview } from "@/server/services/admin";
import { grantAchievement } from "@/server/services/achievements";
import { advanceArena } from "@/server/services/arena";
import { createCharacterForUser } from "@/server/services/characters";
import { getHeroDetail, searchHeroes } from "@/server/services/heroAdmin";
import { claimCharacter } from "@/server/services/identity";
import { getLeaderboard } from "@/server/services/leaderboard";
import { getArenaState, searchHeroes as publicSearch } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, insertStubHero, resetDb, seedHeroes } from "../support/db";

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

const tgId = async (heroId: string) => Number((await db.query<{ t: number }>("select telegram_user_id as t from public.characters where id = $1", [heroId]))[0]?.t);

describe("admin Telegram hero eligibility overview", () => {
  it("uses the configured qualifying-message threshold and excludes flagged members and demos", async () => {
    await seedHeroes(db, 1, { startId: 770_001 }); // 120 qualifying, with a hero
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values (770002, 'At fifty', 50), (770003, 'One short', 49), (770004, 'Flagged', 80)");
    await db.query("update public.telegram_users set status = 'FLAGGED' where telegram_user_id = 770004");
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, is_demo) values (-770005, 'Demo', 100, true)");

    expect(await telegramEligibilityOverview(db)).toEqual({ threshold: 50, eligibleTelegramUsers: 2, heroesCreated: 1, eligibleWithoutHero: 1 });
  });
});

/** A hero whose Telegram name has nothing printable gets the generated fallback "Wanderer ####". */
async function fallbackHero(telegramId = 777_7777): Promise<string> {
  await db.query("insert into public.telegram_users (telegram_user_id, display_name, username, qualifying_message_count) values ($1, '🥰', 'emoji_fan', 140)", [telegramId]);
  const user = (await db.query("select * from public.telegram_users where telegram_user_id = $1", [telegramId]))[0] as never;
  const r = await createCharacterForUser(db, user, { settings: await loadSettings(db), classes: await loadClasses(db), secret: "test-secret-value-1234567890", origin: "HISTORICAL_IMPORT" });
  return r.characterId;
}

/** Everything a rename must leave exactly as it was. */
async function identityOf(id: string): Promise<string> {
  const one = async (sql: string) => JSON.stringify(await db.query(sql, [id]));
  return [
    await one(`select id, kind, telegram_user_id, class_id, level, xp, power, status, origin, is_demo, tactic, title, arena_battles, arena_wins, arena_top2, arena_eliminations, arena_damage, created_at from public.characters where id = $1`),
    await one("select to_jsonb(s) as s from public.character_stats s where character_id = $1"),
    await one("select rarity, parts, seed, sprite, cosmetic_overrides from public.character_appearances where character_id = $1"),
    await one("select character_id, telegram_user_id, claimed_at from public.character_claims where character_id = $1"),
    await one("select address, chain_id, linked_at, unlinked_at from public.wallet_links where character_id = $1 order by address"),
    await one("select achievement_id, unlocked_at from public.character_achievements where character_id = $1 order by achievement_id"),
    await one("select template_id, equipped from public.inventory_items where character_id = $1 order by template_id"),
    await one("select delta, reason, balance_after from public.currency_ledger where character_id = $1 order by id"),
    await one("select balance, lifetime_earned from public.currency_accounts where character_id = $1"),
    await one("select battle_id, placement, xp_awarded, gold_awarded from public.arena_participants where character_id = $1 order by battle_id"),
  ].join("|");
}

/** Gives a hero every kind of thing a rename must not disturb. */
async function fullyLoadedHero(): Promise<string> {
  const [id] = await seedHeroes(db, 1);
  const hero = id as string;
  expect((await claimCharacter(db, await tgId(hero), new Date())).ok).toBe(true);
  await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, 4663)", [hero, `0x${"ab".repeat(20)}`]);
  await grantAchievement(db, hero, "og_clanker");
  await db.query("insert into public.inventory_items (character_id, template_id) select $1, id from public.item_templates limit 1", [hero]);
  await db.query("insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ($1, 75, 'test_grant', 'hero-admin-test-key-1')", [hero]);
  await db.query("update public.characters set xp = 321, level = 4, arena_battles = 9, arena_wins = 3, arena_top2 = 5 where id = $1", [hero]);
  return hero;
}

describe("hero search", () => {
  it("finds heroes by RPG name, Telegram display name, @username, Telegram ID and character ID", async () => {
    const ids = await seedHeroes(db, 3, { startId: 4_001_000 });
    await db.query("update public.telegram_users set display_name = 'Ada Lovelace', username = 'ada_l' where telegram_user_id = 4001001");
    await renameHero(db, ids[1] as string, "NuggetMage", "admin");

    const names = async (search: string) => (await searchHeroes(db, { search })).heroes.map((h) => h.id);
    expect(await names("nuggetm")).toEqual([ids[1]]); // RPG display name (current)
    expect(await names("Hero 4001000")).toEqual([ids[0]]); // generated name still searchable after a rename
    expect(await names("hero 4001001")).toEqual([ids[1]]);
    expect(await names("lovelace")).toEqual([ids[1]]); // Telegram display name
    expect(await names("@ada_l")).toEqual([ids[1]]); // Telegram @username, with or without @
    expect(await names("ada_l")).toEqual([ids[1]]);
    expect(await names("4001002")).toEqual([ids[2]]); // Telegram user ID (exact)
    expect((await names("40010")).length).toBe(3); // a partial number is just a substring search over names — it never matches by id alone
    expect(await names(ids[0] as string)).toEqual([ids[0]]); // full character ID
    expect(await names((ids[2] as string).slice(0, 8))).toEqual([ids[2]]); // character ID prefix
    expect(await names("no-such-hero")).toEqual([]);
  });

  it("treats LIKE wildcards in the search term literally", async () => {
    await seedHeroes(db, 2);
    expect((await searchHeroes(db, { search: "%" })).heroes).toEqual([]);
    expect((await searchHeroes(db, { search: "_" })).heroes).toEqual([]);
  });

  it("filters by claimed state, class, rarity, hero type, status and manually renamed", async () => {
    const ids = await seedHeroes(db, 4);
    await claimCharacter(db, await tgId(ids[0] as string), new Date());
    await renameHero(db, ids[2] as string, "Renamed One", "admin");
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [ids[3]]);
    await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "mage", name: "The Founder", level: 5, status: "INACTIVE", origin: "ADMIN" });

    const idsOf = async (f: Parameters<typeof searchHeroes>[1]) => (await searchHeroes(db, f)).heroes.map((h) => h.id).sort();
    expect(await idsOf({ claimed: "claimed" })).toEqual([ids[0]]);
    expect((await idsOf({ claimed: "unclaimed" })).length).toBe(4); // 3 heroes + the special character
    expect(await idsOf({ renamed: "renamed" })).toEqual([ids[2]]);
    expect((await idsOf({ renamed: "original" })).length).toBe(4);
    expect(await idsOf({ status: "SUSPENDED" })).toEqual([ids[3]]);
    const special = (await searchHeroes(db, { kind: "SPECIAL_CHARACTER" })).heroes;
    expect(special.map((h) => h.rpgName)).toEqual(["The Founder"]);
    expect((await searchHeroes(db, { kind: "COMMUNITY" })).heroes).toHaveLength(4);

    const some = (await searchHeroes(db, { kind: "COMMUNITY" })).heroes[0]!;
    expect((await searchHeroes(db, { classId: some.classId })).heroes.every((h) => h.classId === some.classId)).toBe(true);
    expect((await searchHeroes(db, { rarity: some.rarity as string })).heroes.every((h) => h.rarity === some.rarity)).toBe(true);
    expect((await searchHeroes(db, { classId: "no-such-class" })).heroes).toEqual([]);
  });

  it("pages with a stable total and clamps the page size", async () => {
    await seedHeroes(db, 7);
    const first = await searchHeroes(db, { limit: 3, sort: "name" });
    const second = await searchHeroes(db, { limit: 3, offset: 3, sort: "name" });
    expect(first.total).toBe(7);
    expect(first.heroes).toHaveLength(3);
    expect(new Set([...first.heroes, ...second.heroes].map((h) => h.id)).size).toBe(6);
    expect((await searchHeroes(db, { limit: 100_000 })).limit).toBe(100);
  });

  it("separates the RPG identity from the Telegram identity in every row", async () => {
    const [id] = await seedHeroes(db, 1, { startId: 4_002_000 });
    await db.query("update public.telegram_users set display_name = 'Tele Name', username = 'tele_user' where telegram_user_id = 4002000");
    await renameHero(db, id as string, "RpgName", "admin");
    const row = (await searchHeroes(db, { search: "4002000" })).heroes[0]!;
    expect(row).toMatchObject({ rpgName: "RpgName", generatedName: "Hero 4002000", renamed: true, telegramDisplayName: "Tele Name", telegramUsername: "tele_user", telegramUserId: 4_002_000, claimed: false });
  });
});

describe("hero detail", () => {
  it("returns identity, class, power, rarity, sprite, Telegram activity, wallet, ownership and dates", async () => {
    const hero = await fullyLoadedHero();
    const d = (await getHeroDetail(db, hero))!;
    expect(d).toMatchObject({ id: hero, kind: "COMMUNITY", claimed: true, wallet: `0x${"ab".repeat(20)}`, career: { battles: 9, wins: 3, top2: 5 }, arenaEligible: true });
    // The hero's PERFORMANCE is the ACTIVE season's (nothing fought in it yet), kept apart from the all-time career counters above.
    expect(d.season).toMatchObject({ kind: "DEVELOPMENT", matches: 0, wins: 0, top2: 0, winRate: null, points: 0 });
    expect(d).not.toHaveProperty("record");
    expect(d).not.toHaveProperty("level"); // permanent levels / XP were removed from the hero admin view
    expect(d).not.toHaveProperty("xp");
    expect(d.rpgName).toBe(d.generatedName);
    expect(d.nameOverride).toBeNull();
    expect(d.telegram).toMatchObject({ userId: await tgId(hero), status: "OK" });
    expect(d.activity?.qualifyingMessages).toBe(120);
    expect(d.rarity).toMatch(/^(COMMON|RARE|EPIC|LEGENDARY)$/);
    expect(d.sprite).toMatchObject({ v: 1 });
    expect(d.power).toBeGreaterThan(0);
    expect(d.claimedAt).toBeTruthy();
    expect(d.createdAt).toBeTruthy();
    expect(await getHeroDetail(db, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("special characters have no Telegram identity", async () => {
    const id = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "mage", name: "The Founder", status: "INACTIVE", origin: "ADMIN" });
    const d = (await getHeroDetail(db, id))!;
    expect(d.telegram).toBeNull();
    expect(d.activity).toBeNull();
    expect(d.kind).toBe("SPECIAL_CHARACTER");
  });
});

describe("renaming a hero (presentation only)", () => {
  it("changes ONLY the RPG name — identity, class, stats, claim, wallet, XP, achievements, inventory, gold and battle history are untouched", async () => {
    const hero = await fullyLoadedHero();
    const before = await identityOf(hero);
    const telegramBefore = JSON.stringify(await db.query("select * from public.telegram_users where telegram_user_id = $1", [await tgId(hero)]));

    const r = await renameHero(db, hero, "NuggetMage", "admin");
    expect(r).toMatchObject({ changed: true, oldName: expect.stringMatching(/^Hero /), newName: "NuggetMage" });

    expect(await identityOf(hero)).toBe(before);
    expect(JSON.stringify(await db.query("select * from public.telegram_users where telegram_user_id = $1", [await tgId(hero)]))).toBe(telegramBefore);
    const d = (await getHeroDetail(db, hero))!;
    expect(d.rpgName).toBe("NuggetMage");
    expect(d.generatedName).toMatch(/^Hero /); // original kept
    expect(d.nameChangedBy).toBe("ADMIN");
    expect(d.claimed).toBe(true); // the player can still hold / be recognised as owner
  });

  it("the Telegram user can still be resolved to the same hero and can still claim it after a rename", async () => {
    const [hero] = await seedHeroes(db, 1);
    const tid = await tgId(hero as string);
    await renameHero(db, hero as string, "Totally Different", "admin");
    const claim = await claimCharacter(db, tid, new Date());
    expect(claim).toMatchObject({ ok: true, characterId: hero });
    expect(await count(db, "characters", `telegram_user_id = ${tid}`)).toBe(1);
  });

  it("a fallback 'Wanderer ####' hero can be renamed safely, and reset to its generated name", async () => {
    const hero = await fallbackHero();
    const d0 = (await getHeroDetail(db, hero))!;
    expect(d0.rpgName).toMatch(/^Wanderer \d{4}$/);
    const before = await identityOf(hero);
    await renameHero(db, hero, "🥰 Lovebug", "admin");
    expect((await getHeroDetail(db, hero))!.rpgName).toBe("🥰 Lovebug");
    expect(await identityOf(hero)).toBe(before);
    const reset = await renameHero(db, hero, null, "admin");
    expect(reset).toMatchObject({ changed: true, newName: d0.generatedName });
    expect((await getHeroDetail(db, hero))!.nameOverride).toBeNull();
    expect(await identityOf(hero)).toBe(before);
  });

  it("rejects empty, huge, control-character and markup names and writes nothing", async () => {
    const [hero] = await seedHeroes(db, 1);
    const before = await identityOf(hero as string);
    const audit0 = await count(db, "admin_audit_log");
    for (const bad of ["", "   ", "x".repeat(33), "a\nb", "a\u0000b", "a‮b", "<b>hi</b>", "---"]) {
      await expect(renameHero(db, hero as string, bad, "admin"), JSON.stringify(bad)).rejects.toMatchObject({ code: "INVALID_NAME", status: 422 });
    }
    expect(await identityOf(hero as string)).toBe(before);
    expect(await count(db, "characters", "name_override is not null")).toBe(0);
    expect(await count(db, "admin_audit_log")).toBe(audit0);
  });

  it("the database itself refuses control characters in a name", async () => {
    const [hero] = await seedHeroes(db, 1);
    await expect(db.query("update public.characters set name_override = $2 where id = $1", [hero, "bad\u0007name"])).rejects.toThrow(/characters_name_override_clean|check/i);
    await expect(db.query("update public.characters set name_override = $2 where id = $1", [hero, "x".repeat(41)])).rejects.toThrow();
  });

  it("an unknown hero is NOT_FOUND", async () => {
    await expect(renameHero(db, "00000000-0000-4000-8000-000000000000", "Whoever", "admin")).rejects.toBeInstanceOf(AdminError);
  });

  it("audits every rename with hero id, old and new name, timestamp and actor — and does not pretend to know the operator", async () => {
    const [hero] = await seedHeroes(db, 1);
    const generated = (await getHeroDetail(db, hero as string))!.generatedName;
    await renameHero(db, hero as string, "First", "admin");
    await renameHero(db, hero as string, "Second", "admin");
    await renameHero(db, hero as string, null, "admin");
    const log = await db.query<{ actor: string; action: string; entity_type: string; entity_id: string; detail: Record<string, unknown>; created_at: Date }>(
      "select actor, action, entity_type, entity_id, detail, created_at from public.admin_audit_log where action = 'hero.rename' order by id",
    );
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ actor: "admin", entity_type: "character", entity_id: hero, detail: { heroId: hero, oldName: generated, newName: "First", cleared: false } });
    expect(log[1]!.detail).toMatchObject({ oldName: "First", newName: "Second" });
    expect(log[2]!.detail).toMatchObject({ oldName: "Second", newName: generated, cleared: true, newOverride: null });
    expect(log.every((l) => l.created_at instanceof Date || typeof l.created_at === "string")).toBe(true);
    expect(String(log[0]!.detail.operator)).toMatch(/not identifiable/);
    const d = (await getHeroDetail(db, hero as string))!;
    expect(d.renameHistory.map((h) => `${h.oldName}→${h.newName}`)).toEqual([`Second→${generated}`, "First→Second", `${generated}→First`]);
  });

  it("renaming to the name already in use is a no-op: no write and no audit noise", async () => {
    const [hero] = await seedHeroes(db, 1);
    await renameHero(db, hero as string, "Same", "admin");
    const audits = await count(db, "admin_audit_log");
    const r = await renameHero(db, hero as string, "Same", "admin");
    expect(r.changed).toBe(false);
    expect(await count(db, "admin_audit_log")).toBe(audits);
  });

  it("works for special characters too, and via the legacy PATCH route (one validated, audited implementation)", async () => {
    const id = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "mage", name: "The Founder", status: "INACTIVE", origin: "ADMIN" });
    await patchHero(db, id, { nameOverride: "Founder Prime" }, "admin");
    expect((await getHeroDetail(db, id))!.rpgName).toBe("Founder Prime");
    await expect(patchHero(db, id, { nameOverride: "<bad>" }, "admin")).rejects.toMatchObject({ code: "INVALID_NAME" });
    expect(await count(db, "admin_audit_log", "action = 'hero.rename'")).toBe(1);
  });

  it("the new name appears everywhere a hero name is shown: search, leaderboard, the stage and Recent Winners", async () => {
    const clock = new FakeClock();
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state = () => getArenaState(db, clock.ms, settings, { allowDemo: true, classes });

    // on stage right now (its battle snapshot is frozen, but the display name is presentation only)
    const onStage = (await state()).current!.fighters[0]!;
    await renameHero(db, onStage.characterId, "StageRenamed", "admin");
    expect((await state()).current!.fighters.find((f) => f.characterId === onStage.characterId)!.name).toBe("StageRenamed");

    // run until someone has won, rename the winner
    let s = await state();
    for (let i = 0; i < 400 && s.recent.length === 0; i++) {
      clock.advance(1000);
      await advanceArena(db, arenaCtx(clock));
      s = await state();
    }
    expect(s.recent.length).toBeGreaterThan(0);
    const winner = s.recent[0]!.winner!;
    await renameHero(db, winner.characterId, "Champion Renamed", "admin");
    expect((await state()).recent.find((r) => r.winner?.characterId === winner.characterId)!.winner!.name).toBe("Champion Renamed");

    const board = await getLeaderboard(db, "POWER", { allowDemo: true, limit: 100 });
    expect(board.find((r) => r.characterId === winner.characterId)!.name).toBe("Champion Renamed");
    expect((await publicSearch(db, "Champion Renamed", true)).map((h) => h.id)).toEqual([winner.characterId]);
  });
});

describe("what an admin can and cannot edit", () => {
  it("class, stats, XP, level, identity and claim fields are not accepted by the hero edit", async () => {
    const hero = await fullyLoadedHero();
    const before = await identityOf(hero);
    for (const forbidden of [{ classId: "mage" }, { class_id: "mage" }, { level: 99 }, { xp: 9999 }, { power: 1 }, { telegramUserId: 1 }, { telegram_user_id: 1 }, { id: "x" }, { claimed: false }, { stats: { str: 99 } }, { walletAddress: "0x0" }]) {
      await expect(patchHero(db, hero, forbidden, "admin"), JSON.stringify(forbidden)).rejects.toThrow();
    }
    expect(await identityOf(hero)).toBe(before);
  });

  it("a class change is still blocked at the database level (permanent unless an audited override flag is set)", async () => {
    const [hero] = await seedHeroes(db, 1);
    const current = (await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero]))[0]!.class_id;
    await expect(db.query("update public.characters set class_id = $2 where id = $1", [hero, current === "mage" ? "tank" : "mage"])).rejects.toThrow(/permanent/);
  });

  it("admin notes are stored, audited, length-limited and clearable", async () => {
    const [hero] = await seedHeroes(db, 1);
    await setHeroNote(db, hero as string, "  contacted on Telegram  ", "admin");
    expect((await getHeroDetail(db, hero as string))!.adminNote).toBe("contacted on Telegram");
    await expect(setHeroNote(db, hero as string, "x".repeat(501), "admin")).rejects.toMatchObject({ code: "INVALID_NOTE" });
    await expect(setHeroNote(db, hero as string, "bad\u0000note", "admin")).rejects.toMatchObject({ code: "INVALID_NOTE" });
    await setHeroNote(db, hero as string, "", "admin");
    expect((await getHeroDetail(db, hero as string))!.adminNote).toBeNull();
    expect(await count(db, "admin_audit_log", "action = 'hero.note'")).toBe(2);
  });
});
