import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { cardKey } from "@/domain/hero/card";
import { PUBLIC_HERO_ID_PATTERN, heroPath } from "@/domain/hero/publicId";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { renderHeroCardPng, CARD_SIZE } from "@/server/heroes/cardImage";
import { renameHero, setTelegramStatus } from "@/server/services/admin";
import { advanceArena } from "@/server/services/arena";
import { createCharacterForUser } from "@/server/services/characters";
import { applyRerollPreview, getHeroVersioning, previewReroll, rollbackHero, type HeroVersioningDeps } from "@/server/services/heroVersions";
import { getPublicHero, getPublicHeroCard, listPublicHeroes } from "@/server/services/publicHeroes";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

const SECRET = "test-secret-value-1234567890";
let db: Db;
let clock: FakeClock;
let deps: HeroVersioningDeps;
let ctx: { allowDemo: boolean; classes: Awaited<ReturnType<typeof loadClasses>>; settings: Awaited<ReturnType<typeof loadSettings>> };

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock();
  const settings = await loadSettings(db);
  const classes = await loadClasses(db);
  deps = { settings, classes, secret: SECRET, now: clock.now };
  ctx = { allowDemo: false, classes: await loadClasses(db, false), settings };
});

/** A real hero created through the real creation path, with a chosen display name and Telegram id. */
async function hero(tid: number, displayName: string, over: { demo?: boolean } = {}): Promise<{ id: string; publicId: string }> {
  await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, activity_score, behavior, is_demo) values ($1, $2, 120, 40, '{}'::jsonb, $3)", [tid, displayName, over.demo ?? false]);
  const user = (await db.query("select * from public.telegram_users where telegram_user_id = $1", [tid]))[0] as never;
  const r = await createCharacterForUser(db, user, { settings: deps.settings, classes: deps.classes, secret: SECRET, origin: over.demo ? "DEV_SEED" : "TELEGRAM" });
  return { id: r.characterId, publicId: (await db.query<{ public_id: string }>("select public_id from public.characters where id = $1", [r.characterId]))[0]!.public_id };
}
const reroll = async (id: string) => applyRerollPreview(db, id, (await previewReroll(db, id, "admin", deps)).previewId, "admin", deps);
const pub = (publicId: string, over: Partial<typeof ctx> = {}) => getPublicHero(db, publicId, { ...ctx, ...over });

describe("public ids", () => {
  it("every hero gets its own well-formed id; two heroes with the SAME display name resolve to different URLs and the right hero each", async () => {
    const a = await hero(7001, "Marky");
    const b = await hero(7002, "Marky");
    expect(a.publicId).toMatch(PUBLIC_HERO_ID_PATTERN);
    expect(b.publicId).toMatch(PUBLIC_HERO_ID_PATTERN);
    expect(a.publicId).not.toBe(b.publicId);
    expect(heroPath(a.publicId)).not.toBe(heroPath(b.publicId));
    const pa = (await pub(a.publicId))!;
    const pb = (await pub(b.publicId))!;
    expect(pa.card.publicId).toBe(a.publicId);
    expect(pb.card.publicId).toBe(b.publicId);
    expect(pa.card.name).toBe("Marky");
    expect(pb.card.name).toBe("Marky");
    // they are different people: look at the real stored classes / looks
    const [ra, rb] = await Promise.all([a, b].map(async (h) => (await db.query<{ class_id: string; seed: string }>("select c.class_id, ca.seed from public.characters c join public.character_appearances ca on ca.character_id = c.id where c.id = $1", [h.id]))[0]!));
    expect(pa.card.classId).toBe(ra!.class_id);
    expect(pb.card.classId).toBe(rb!.class_id);
    expect(ra!.seed).not.toBe(rb!.seed);
    const dir = await listPublicHeroes(db, { search: "marky" }, ctx);
    expect(dir.heroes.map((h) => h.publicId).sort()).toEqual([a.publicId, b.publicId].sort());
  });

  it("a rename never changes the URL; neither does a reroll or a rollback — only what the page shows", async () => {
    const h = await hero(7010, "Original");
    const before = (await pub(h.publicId))!;
    await renameHero(db, h.id, "Brand New Name", "admin");
    const renamed = (await pub(h.publicId))!;
    expect(renamed.card.publicId).toBe(h.publicId);
    expect(renamed.card.name).toBe("Brand New Name");
    expect(renamed.card.classId).toBe(before.card.classId);
    // reroll until the card visibly differs
    let rerolled = renamed;
    for (let i = 0; i < 20 && cardKey(rerolled.card) === cardKey(renamed.card); i++) {
      await reroll(h.id);
      rerolled = (await pub(h.publicId))!;
    }
    expect(rerolled.card.publicId).toBe(h.publicId);
    expect(cardKey(rerolled.card)).not.toBe(cardKey(renamed.card));
    expect((await db.query<{ public_id: string }>("select public_id from public.characters where id = $1", [h.id]))[0]!.public_id).toBe(h.publicId);
    // roll all the way back: the page is exactly the original card again (same key, same URL)
    const versions = (await getHeroVersioning(db, h.id)).versions;
    const v1 = versions.at(-1)!;
    const cur = versions[0]!;
    await rollbackHero(db, { characterId: h.id, targetVersionId: v1.id, expectedCurrentVersionId: cur.id, requestId: crypto.randomUUID() }, "admin", deps);
    const back = (await pub(h.publicId))!;
    expect(back.card.publicId).toBe(h.publicId);
    expect(cardKey(back.card)).toBe(cardKey(renamed.card)); // v1's look + stats, under the new name
  });

  it("an unknown or malformed id is simply not found", async () => {
    await hero(7020, "X");
    for (const id of ["222222222222", "short", "../../etc", "ZZZZZZZZZZZZ", "00000000-0000-4000-8000-000000000000", ""]) expect(await pub(id)).toBeNull();
  });
});

describe("moderation and visibility", () => {
  it("suspended, inactive and banned heroes are NOT FOUND (no reason given); active and merely-flagged heroes are public; version history is kept", async () => {
    const active = await hero(7101, "Active");
    const suspended = await hero(7102, "Suspended");
    const inactive = await hero(7103, "Inactive");
    const banned = await hero(7104, "Banned");
    const flagged = await hero(7105, "Flagged");
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [suspended.id]);
    await db.query("update public.characters set status = 'INACTIVE' where id = $1", [inactive.id]);
    const deps2 = { settings: deps.settings, classes: deps.classes } as never;
    await setTelegramStatus(db, 7104, "BANNED", "spam ring", "admin", deps2);
    await setTelegramStatus(db, 7105, "FLAGGED", "under review", "admin", deps2);

    expect(await pub(active.publicId)).not.toBeNull();
    expect(await pub(flagged.publicId)).not.toBeNull(); // review state does not hide a hero (same rule as the Arena and the boards)
    for (const h of [suspended, inactive, banned]) {
      expect(await pub(h.publicId), h.publicId).toBeNull();
      expect(await getPublicHeroCard(db, h.publicId, ctx)).toBeNull();
    }
    const listed = (await listPublicHeroes(db, {}, ctx)).heroes.map((h) => h.publicId).sort();
    expect(listed).toEqual([active.publicId, flagged.publicId].sort());
    // …and nothing was deleted: the hidden heroes still own their whole history, visible to the admin
    for (const h of [suspended, inactive, banned]) expect((await getHeroVersioning(db, h.id)).versionCount).toBe(1);
    // reactivating makes them public again at the very same URL
    await db.query("update public.characters set status = 'ACTIVE' where id = $1", [suspended.id]);
    expect(await pub(suspended.publicId)).not.toBeNull();
  });

  it("demo heroes are public only where demo heroes are allowed at all", async () => {
    const d = await hero(-7201, "Demo", { demo: true });
    expect(await pub(d.publicId, { allowDemo: false })).toBeNull();
    expect(await pub(d.publicId, { allowDemo: true })).not.toBeNull();
    expect((await listPublicHeroes(db, {}, { ...ctx, allowDemo: false })).total).toBe(0);
    expect((await listPublicHeroes(db, {}, { ...ctx, allowDemo: true })).total).toBe(1);
  });

  it("the admin sees the same hero's state: eligibility and public visibility follow the moderation rules", async () => {
    const h = await hero(7210, "Mod");
    expect((await getHeroVersioning(db, h.id)).moderation).toEqual({ heroStatus: "ACTIVE", memberStatus: "OK", arenaEligible: true, isPublic: true });
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [h.id]);
    expect((await getHeroVersioning(db, h.id)).moderation).toMatchObject({ heroStatus: "SUSPENDED", arenaEligible: false, isPublic: false });
  });
});

describe("the public data is public-safe", () => {
  it("the profile and the directory carry no Telegram id, no database id, no seed, no moderation note, no wallet, no admin note — only whitelisted fields", async () => {
    const h = await hero(99887766, "Private Person");
    await db.query("update public.characters set admin_note = 'SECRET ADMIN NOTE', title = 'The Visible Title' where id = $1", [h.id]);
    await db.query("update public.telegram_users set username = 'private_handle', flag_reason = 'INTERNAL FLAG REASON' where telegram_user_id = 99887766");
    await db.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd', 4663)", [h.id]);
    const seed = (await db.query<{ generation_seed: string; appearance_seed: string }>("select generation_seed, appearance_seed from public.hero_versions where character_id = $1", [h.id]))[0]!;
    const profile = (await pub(h.publicId))!;
    const listing = await listPublicHeroes(db, {}, ctx);
    const blob = JSON.stringify({ profile, listing });
    for (const secret of ["99887766", h.id, "SECRET ADMIN NOTE", "private_handle", "INTERNAL FLAG REASON", "0xabcdefabcdef", seed.generation_seed, seed.appearance_seed, "telegram", "SUSPENDED", "FLAGGED", "BANNED", "adminNote", "flag"]) {
      expect(blob.toLowerCase(), `leaked: ${secret}`).not.toContain(secret.toLowerCase());
    }
    expect(Object.keys(profile).sort()).toEqual(["card", "picks", "recentBattles", "record", "season"]);
    expect(Object.keys(profile.card).sort()).toEqual(["className", "classId", "look", "name", "power", "publicId", "rarity", "seasonRank", "stats"].sort());
    expect(Object.keys(listing.heroes[0]!).sort()).toEqual(["className", "classId", "look", "name", "power", "publicId", "rarity"].sort());
  });

  it("the profile is what the hero fights with: the card's stats and POWER are the effective ones", async () => {
    const h = await hero(7301, "Fighter");
    const p = (await pub(h.publicId))!;
    const [row] = await db.query<{ power: number }>("select power from public.characters where id = $1", [h.id]);
    expect(p.card.power).toBe(Number(row!.power));
    expect(Object.keys(p.card.stats).sort()).toEqual(["agi", "cha", "def", "hp", "int", "luck", "str"]);
  });
});

describe("the directory", () => {
  it("a tile and the profile agree on POWER even when the cached characters.power is stale (as it is for heroes created before the level / XP removal); the order follows the version's POWER", async () => {
    await seedHeroes(db, 12);
    await db.query("update public.characters set power = power + 9 + (random() * 40)::int"); // a stale, scattered cache
    const dir = await listPublicHeroes(db, { limit: 50 }, ctx);
    for (const tile of dir.heroes) expect(tile.power, tile.publicId).toBe((await pub(tile.publicId))!.card.power);
    expect(dir.heroes.map((h) => h.power)).toEqual([...dir.heroes.map((h) => h.power)].sort((a, b) => b - a));
  });

  it("filters by class and rarity, searches by name, sorts, paginates and counts", async () => {
    const ids = await seedHeroes(db, 40);
    const all = await listPublicHeroes(db, { limit: 100 }, ctx);
    expect(all.total).toBe(40);
    expect(all.heroes).toHaveLength(40);
    expect(all.heroes.map((h) => h.power)).toEqual([...all.heroes.map((h) => h.power)].sort((a, b) => b - a)); // default: highest POWER first
    const cls = all.heroes[0]!.classId;
    const byClass = await listPublicHeroes(db, { classId: cls, limit: 100 }, ctx);
    expect(byClass.heroes.every((h) => h.classId === cls)).toBe(true);
    expect(byClass.total).toBe(all.heroes.filter((h) => h.classId === cls).length);
    const rarity = all.heroes[0]!.rarity;
    expect((await listPublicHeroes(db, { rarity, limit: 100 }, ctx)).heroes.every((h) => h.rarity === rarity)).toBe(true);
    expect((await listPublicHeroes(db, { classId: "not-a-class", limit: 100 }, ctx)).total).toBe(40); // an unknown filter is ignored, never an error
    expect((await listPublicHeroes(db, { search: `hero ${ids.length ? "" : ""}` }, ctx)).total).toBeGreaterThan(0);
    const named = await listPublicHeroes(db, { sort: "name", limit: 100 }, ctx);
    expect(named.heroes.map((h) => h.name)).toEqual([...named.heroes.map((h) => h.name)].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    const p1 = await listPublicHeroes(db, { limit: 16, offset: 0 }, ctx);
    const p2 = await listPublicHeroes(db, { limit: 16, offset: 16 }, ctx);
    const p3 = await listPublicHeroes(db, { limit: 16, offset: 32 }, ctx);
    expect([p1.heroes.length, p2.heroes.length, p3.heroes.length]).toEqual([16, 16, 8]);
    expect(new Set([...p1.heroes, ...p2.heroes, ...p3.heroes].map((h) => h.publicId)).size).toBe(40); // no duplicates, nothing lost
    expect((await listPublicHeroes(db, { search: "%" }, ctx)).total).toBe(0); // LIKE wildcards are literal
    expect(all.classes.length).toBeGreaterThanOrEqual(6);
  });
});

describe("recent fights", () => {
  it("shows placement and KOs of settled battles — and a record that matches the arena", async () => {
    await seedHeroes(db, 24);
    const c = arenaCtx(clock);
    await advanceArena(db, c);
    const [b1] = await db.query<{ id: string }>("select id from public.arena_battles order by sequence limit 1");
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [b1!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, c);
    }
    const [w] = await db.query<{ public_id: string; id: string }>("select c.public_id, c.id from public.arena_battles b join public.characters c on c.id = b.winner_id where b.id = $1", [b1!.id]);
    const p = (await pub(w!.public_id))!;
    expect(p.record.battles).toBe(1);
    expect(p.record.wins).toBe(1);
    expect(p.recentBattles[0]).toMatchObject({ placement: 1 });
    expect(JSON.stringify(p.recentBattles)).not.toContain(b1!.id); // no battle id: nothing replayable from a profile
  });
});

describe("the card IMAGE", () => {
  const dims = (png: Buffer) => ({ sig: png.subarray(0, 8).toString("hex"), w: png.readUInt32BE(16), h: png.readUInt32BE(20) });

  it("is a 1200 × 1200 PNG of the hero's CURRENT card, reproducible byte for byte", async () => {
    const h = await hero(7401, "Pixel");
    const card = (await getPublicHeroCard(db, h.publicId, ctx))!;
    const png = await renderHeroCardPng(card);
    expect(dims(png)).toEqual({ sig: "89504e470d0a1a0a", w: 1200, h: 1200 });
    expect(CARD_SIZE).toBe(1200);
    expect(png.length).toBeGreaterThan(20_000);
    expect((await renderHeroCardPng(card)).equals(png)).toBe(true); // deterministic: the same card is the same bytes
  });

  it("changes after a reroll, and after a rollback is byte-identical to the original again", async () => {
    const h = await hero(7402, "Pixel Two");
    const original = (await getPublicHeroCard(db, h.publicId, ctx))!;
    const pngOriginal = await renderHeroCardPng(original);
    let current = original;
    for (let i = 0; i < 20 && cardKey(current) === cardKey(original); i++) {
      await reroll(h.id);
      current = (await getPublicHeroCard(db, h.publicId, ctx))!;
    }
    expect(cardKey(current)).not.toBe(cardKey(original));
    const pngRerolled = await renderHeroCardPng(current);
    expect(pngRerolled.equals(pngOriginal)).toBe(false);
    expect(current.stats).not.toEqual(original.stats);

    const versions = (await getHeroVersioning(db, h.id)).versions;
    await rollbackHero(db, { characterId: h.id, targetVersionId: versions.at(-1)!.id, expectedCurrentVersionId: versions[0]!.id, requestId: crypto.randomUUID() }, "admin", deps);
    const back = (await getPublicHeroCard(db, h.publicId, ctx))!;
    expect(cardKey(back)).toBe(cardKey(original));
    expect((await renderHeroCardPng(back)).equals(pngOriginal)).toBe(true);
  });

  it("every rarity renders at the same size with its own dressing, and hostile names neither break nor inject anything", async () => {
    const h = await hero(7403, "Dress");
    const card = (await getPublicHeroCard(db, h.publicId, ctx))!;
    const sizes = new Set<string>();
    const bytes = new Set<string>();
    for (const rarity of ["COMMON", "RARE", "EPIC", "LEGENDARY"] as const) {
      const png = await renderHeroCardPng({ ...card, rarity, look: { ...card.look, rarity } });
      sizes.add(JSON.stringify(dims(png)));
      bytes.add(png.toString("base64"));
    }
    expect(sizes.size).toBe(1);
    expect(bytes.size).toBe(4);
    for (const name of ["<script>alert(1)</script>", "‮daer", "🥰".repeat(40), "x".repeat(500), "\u0000\u0001\u0002", "Ñandú Žofia 日本語"]) {
      const png = await renderHeroCardPng({ ...card, name });
      expect(dims(png)).toEqual({ sig: "89504e470d0a1a0a", w: 1200, h: 1200 });
    }
  });
});
