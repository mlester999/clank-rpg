import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { computePower } from "@/domain/character/stats";
import { generatedStats } from "@/domain/hero/heroVersion";
import { PUBLIC_HERO_ID_PATTERN } from "@/domain/hero/publicId";
import { addStats } from "@/domain/stats";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDbUpTo, insertStubHero } from "../support/db";
import { seedLegacyHeroes } from "../support/legacyHeroes";

/**
 * Migration 20261005001800 on a database in the state LIVE is in today: every earlier migration applied, real heroes present, NO version history.
 * It must turn each hero into a hero with exactly one INITIAL v1 — a pure SNAPSHOT: nothing re-rolled, no new seed, nothing moderated or renamed.
 */
const BEFORE = "20261005001700";
const NEW = "20261005001800";

let db: Db;
const fingerprint = async () =>
  db.query<Record<string, unknown>>(
    `select to_jsonb(c) - 'public_id' - 'current_hero_version_id' as character, to_jsonb(s) as stats, to_jsonb(a) as appearance
       from public.characters c left join public.character_stats s on s.character_id = c.id left join public.character_appearances a on a.character_id = c.id
      order by c.created_at, c.id`,
  );

let before: Record<string, unknown>[] = [];
let legacy: Array<{ id: string; telegramUserId: number }> = [];
let specialId = "";

beforeAll(async () => {
  db = await createTestDbUpTo(BEFORE);
  // the visual setting as live held it when this migration ran (hero renderer v2 came later, with migration 2300)
  await db.query(`update public.game_settings set value = jsonb_set(value, '{spriteSet}', '"clank-dev-v1"') where key = 'visuals'`);
  // 300 heroes with a spread of classes / rarities / activity, so rounding ties and every class are exercised
  legacy = await seedLegacyHeroes(db, 300, { activity: (i) => (i * 7) % 100 });
  // moderation states must survive untouched
  await db.query("update public.characters set status = 'SUSPENDED' where id = any($1::uuid[])", [legacy.slice(0, 3).map((h) => h.id)]);
  await db.query("update public.characters set name_override = 'Renamed by admin', name_changed_by = 'ADMIN', name_changed_at = now() where id = $1", [legacy[3]!.id]);
  await db.query("update public.characters set tactic = 'AGGRESSIVE', title = 'The Old Guard' where id = $1", [legacy[4]!.id]);
  // a legacy hero whose sprite was never backfilled (NULL), one with a hand-authored fixed-stat special character, and a demo hero
  await db.query("update public.character_appearances set sprite = null where character_id = $1", [legacy[5]!.id]);
  const [special] = await db.query<{ id: string }>(
    "insert into public.characters (kind, telegram_user_id, class_id, name, status, origin) values ('SPECIAL_CHARACTER', null, 'tank', 'The Founder', 'INACTIVE', 'ADMIN') returning id",
  );
  specialId = special!.id;
  await db.query("insert into public.character_stats (character_id, variation, fixed_stats) values ($1, '{}'::jsonb, $2::jsonb)", [specialId, JSON.stringify({ hp: 150, str: 22.4, def: 30.5, int: 9, agi: 8, cha: 12, luck: 7 })]);
  await db.query("insert into public.character_appearances (character_id, rarity, parts, seed) values ($1, 'LEGENDARY', '{\"skin\":0,\"hairStyle\":0,\"hairColor\":0,\"eyes\":0,\"mouth\":0,\"accessory\":3,\"cape\":true,\"aura\":\"flame\",\"outfitHue\":10}'::jsonb, 'special')", [specialId]);
  before = await fingerprint();
}, 180_000);
afterAll(async () => {
  await db.close();
});

describe("before the migration: the hero-version schema does not exist (the live state)", () => {
  it("has no version table and no public id column", async () => {
    expect((await db.query<{ t: string | null }>("select to_regclass('public.hero_versions')::text as t"))[0]!.t).toBeNull();
    expect(await db.query("select 1 from information_schema.columns where table_name = 'characters' and column_name = 'public_id'")).toHaveLength(0);
    expect(before).toHaveLength(301);
  });
});

describe("applying the migration", () => {
  it("applies alone and is recorded", async () => {
    const r = await migrate(db, undefined, { upTo: NEW });
    expect(r.applied).toEqual([NEW]);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]); // re-running the runner is a no-op
  });

  it("every existing hero — active, suspended, renamed, special, legacy-sprite — has EXACTLY one INITIAL v1 and it is current", async () => {
    const rows = await db.query<{ id: string; n: number; initial: number; current_ok: boolean }>(
      `select c.id, (select count(*) from public.hero_versions v where v.character_id = c.id)::int as n,
              (select count(*) from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL' and v.version_number = 1)::int as initial,
              (c.current_hero_version_id = (select v.id from public.hero_versions v where v.character_id = c.id and v.version_number = 1)) as current_ok
         from public.characters c`,
    );
    expect(rows).toHaveLength(301);
    expect(rows.every((r) => r.n === 1 && r.initial === 1 && r.current_ok)).toBe(true);
    expect(await db.query("select * from public.audit_hero_versions()")).toEqual([]);
  });

  it("changes NOTHING that existed: every pre-existing column of characters, character_stats and character_appearances is byte-identical (incl. updated_at, status, names, tactic, title)", async () => {
    const after = await fingerprint();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.characters where status = 'SUSPENDED'"))[0]!.n).toBe(3);
  });

  it("v1 is a pure SNAPSHOT of the stored hero: class, rarity, seed, components, parts and sprite are copied verbatim (no new seed, no re-derivation)", async () => {
    const mismatches = await db.query<{ id: string }>(
      `select c.id from public.characters c
         join public.hero_versions v on v.id = c.current_hero_version_id
         join public.character_stats s on s.character_id = c.id join public.character_appearances a on a.character_id = c.id
        where v.action <> 'INITIAL' or v.version_number <> 1 or v.class_id <> c.class_id or v.rarity <> a.rarity or v.appearance <> a.parts
           or v.appearance_seed <> a.seed or v.generation_seed <> a.seed or v.sprite is distinct from a.sprite
           or v.variation <> s.variation or v.telegram_bonus <> s.telegram_bonus
           or v.created_at <> c.created_at or v.previous_version_id is not null or v.source_version_id is not null or v.request_id is not null`,
    );
    expect(mismatches).toEqual([]);
    const [nullSprite] = await db.query<{ sprite: unknown }>("select v.sprite from public.hero_versions v where v.character_id = $1", [legacy[5]!.id]);
    expect(nullSprite!.sprite).toBeNull(); // a legacy NULL sprite stays NULL (derived on read), never invented here
    const [meta] = await db.query<{ generator_version: string; created_by: string; render: { spriteSet: string } }>("select generator_version, created_by, render from public.hero_versions limit 1");
    expect(meta).toMatchObject({ generator_version: "hero-gen/1", created_by: "system:migration:20261005001800", render: { spriteSet: "clank-dev-v1" } });
  });

  it("the stat / POWER snapshot equals the application's own arithmetic for ALL 301 heroes (SQL ≙ TypeScript, including rounding), and — with no wallet or gear — the cached power", async () => {
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const rows = await db.query<{ id: string; class_id: string; variation: Record<string, number>; telegram_bonus: Record<string, number>; fixed_stats: Record<string, number> | null; stats: Record<string, number>; power: number; cached: number }>(
      `select c.id, c.class_id, s.variation, s.telegram_bonus, s.fixed_stats, v.stats, v.power, c.power as cached
         from public.characters c join public.character_stats s on s.character_id = c.id join public.hero_versions v on v.id = c.current_hero_version_id`,
    );
    for (const r of rows) {
      const cls = classes.find((c) => c.id === r.class_id)!;
      const stats = generatedStats(cls, addStats(r.variation), addStats(r.telegram_bonus), r.fixed_stats);
      expect(r.stats, `stats of ${r.id}`).toEqual(stats);
      expect(r.power, `power of ${r.id}`).toBe(computePower(stats, settings.character));
    }
    // legacy heroes were generated with no wallet/gear parts, so the cached effective POWER is the very same number
    const generatedOnly = rows.filter((r) => r.fixed_stats === null);
    expect(generatedOnly.filter((r) => r.power !== Number(r.cached))).toEqual([]);
  });

  it("the special character's authored fixed stats are snapshotted (rounded, floor 1)", async () => {
    const [v] = await db.query<{ stats: Record<string, number> }>("select v.stats from public.hero_versions v where v.character_id = $1", [specialId]);
    expect(v!.stats).toEqual({ hp: 150, str: 22, def: 31, int: 9, agi: 8, cha: 12, luck: 7 });
  });

  it("every hero got a distinct, well-formed PUBLIC id (random — nothing derived from the name, the Telegram id or a sequence)", async () => {
    const rows = await db.query<{ public_id: string; telegram_user_id: number | null }>("select public_id, telegram_user_id from public.characters");
    expect(rows.every((r) => PUBLIC_HERO_ID_PATTERN.test(r.public_id))).toBe(true);
    expect(new Set(rows.map((r) => r.public_id)).size).toBe(301);
    expect(rows.some((r) => r.telegram_user_id !== null && r.public_id.includes(String(r.telegram_user_id)))).toBe(false);
  });

  it("is idempotent: capturing the snapshot again returns the same version and creates nothing; a second INITIAL is impossible", async () => {
    const before = (await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions"))[0]!.n;
    for (const h of legacy.slice(0, 20)) await db.query("select public.hero_snapshot_initial_version($1, 'system:again')", [h.id]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions"))[0]!.n).toBe(before);
    const [cur] = await db.query<{ id: string }>("select id from public.hero_versions where character_id = $1", [legacy[0]!.id]);
    await expect(
      db.query(
        `insert into public.hero_versions (character_id, version_number, action, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, created_by)
         select character_id, 1, 'INITIAL', generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, 'system:test' from public.hero_versions where id = $1`,
        [cur!.id],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});

describe("after the migration the database itself keeps hero state honest", () => {
  it("a hero cannot be created without its INITIAL v1 (the commit is refused) — but with it, it can", async () => {
    await expect(db.query("insert into public.characters (kind, telegram_user_id, class_id, name, origin) values ('SPECIAL_CHARACTER', null, 'mage', 'No version', 'ADMIN')")).rejects.toThrow(/no current hero version/);
    expect(await db.query("select 1 from public.characters where name = 'No version'")).toHaveLength(0);
    const id = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "mage", name: "With version", origin: "ADMIN" });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1 and action = 'INITIAL'", [id]))[0]!.n).toBe(1);
    expect(await db.query("select public_id from public.characters where id = $1", [id])).toHaveLength(1); // the default minted one
  });

  it("class, rarity, look and generated components can change ONLY through a new version: a bare UPDATE is refused at commit", async () => {
    const id = legacy[10]!.id;
    const other = (await db.query<{ class_id: string }>("select id as class_id from public.character_classes where id <> (select class_id from public.characters where id = $1) limit 1", [id]))[0]!.class_id;
    // even with the audited class-change switch on, a class that differs from the current version is refused at commit
    await expect(db.transaction(async (tx) => {
      await tx.query("select set_config('clank.allow_class_change', 'on', true)");
      await tx.query("update public.characters set class_id = $2 where id = $1", [id, other]);
    })).rejects.toThrow(/inconsistent with its current hero version \(CLASS\)/);
    await expect(db.query("update public.character_appearances set rarity = case rarity when 'LEGENDARY' then 'COMMON' else 'LEGENDARY' end where character_id = $1", [id])).rejects.toThrow(/\(RARITY\)/);
    await expect(db.query("update public.character_appearances set parts = jsonb_set(parts, '{skin}', '5') where character_id = $1 and (parts->>'skin') <> '5'", [id])).rejects.toThrow(/\(APPEARANCE\)/);
    await expect(db.query("update public.character_stats set variation = jsonb_set(variation, '{str}', '99') where character_id = $1", [id])).rejects.toThrow(/\(VARIATION\)/);
    await expect(db.query("update public.character_stats set telegram_bonus = jsonb_set(telegram_bonus, '{hp}', '99') where character_id = $1", [id])).rejects.toThrow(/\(TELEGRAM_BONUS\)/);
    // a wallet/gear component is NOT part of the generated state and may change freely
    await db.query("update public.character_stats set holdings_bonus = '{\"def\": 3}'::jsonb where character_id = $1", [id]);
    await db.query("update public.characters set name_override = 'x', status = 'SUSPENDED' where id = $1", [id]);
    expect(await db.query("select * from public.audit_hero_versions()")).toEqual([]);
  });

  it("versions are immutable and append-only; the public id never changes; the current pointer cannot point at another hero's version", async () => {
    const a = legacy[20]!.id;
    const b = legacy[21]!.id;
    await expect(db.query("update public.hero_versions set power = power + 1 where character_id = $1", [a])).rejects.toThrow(/immutable/);
    await expect(db.query("delete from public.hero_versions where character_id = $1", [a])).rejects.toThrow(/append-only/);
    await expect(db.query("update public.characters set public_id = '222222222222' where id = $1", [a])).rejects.toThrow(/permanent/);
    await expect(db.query("update public.characters set current_hero_version_id = (select id from public.hero_versions where character_id = $2) where id = $1", [a, b])).rejects.toThrow(/foreign key/);
    await expect(db.query("update public.characters set current_hero_version_id = null where id = $1", [a])).rejects.toThrow(/no current hero version/);
  });

  it("a ROLLBACK must name a source, an INITIAL must not have one (check constraints)", async () => {
    const id = legacy[30]!.id;
    const [v1] = await db.query<{ id: string }>("select id from public.hero_versions where character_id = $1", [id]);
    const insert = (action: string, number: number, source: string | null, previous: string | null, request: string | null) =>
      db.query(
        `insert into public.hero_versions (character_id, version_number, action, source_version_id, previous_version_id, request_id, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, created_by)
         select character_id, $2, $3, $4::uuid, $5::uuid, $6::uuid, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, 'system:test' from public.hero_versions where id = $1`,
        [v1!.id, number, action, source, previous, request],
      );
    await expect(insert("ROLLBACK", 2, null, v1!.id, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(/check/);
    await expect(insert("REROLL", 2, v1!.id, v1!.id, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(/check/);
    await expect(insert("REROLL", 1, null, v1!.id, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(/check|unique/);
    await expect(insert("INITIAL", 2, null, null, null)).rejects.toThrow(/check/);
  });

  it("deleting a whole hero (a test / reset path) is the only way its versions go away", async () => {
    const id = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "mage", name: "Disposable", origin: "ADMIN" });
    await db.query("delete from public.characters where id = $1", [id]);
    expect(await db.query("select 1 from public.hero_versions where character_id = $1", [id])).toHaveLength(0);
  });
});
