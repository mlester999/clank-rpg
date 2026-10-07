import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDbUpTo } from "../support/db";
import { seedLegacyHeroes } from "../support/legacyHeroes";

/**
 * Migration 20261006002100 — the database side of "development progress does not carry into Season 1". It is ADDITIVE: it gives achievement unlocks an id,
 * a season and an `archived_at`, gives loot an `archived_at`, and adds a read-only auditor. It archives NOTHING by itself and changes no hero.
 */
const BEFORE = "20261006002000";
const NEW = "20261006002100";
const FILE = "20261006002100_development_economy_archive";
const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", `${FILE}.sql`), "utf8");
const code = sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");

const dbs: Db[] = [];
afterAll(async () => {
  for (const d of dbs) await d.close();
});

describe("the migration file", () => {
  it("is the newest migration, right after the game-lifecycle migration", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.at(-1)).toBe(NEW);
    expect(all.indexOf(NEW)).toBe(all.indexOf(BEFORE) + 1);
  });

  it("never touches a hero, deletes nothing and does not launch, reset or archive anything", () => {
    expect(code).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+(public\.)?(characters|hero_versions|character_appearances|character_stats|currency_ledger|currency_accounts|game_state|seasons|reward_\w+)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i);
    expect(code).not.toMatch(/\bupdate\s+(public\.)?(character_achievements|inventory_items)\b/i); // adding the columns archives nothing
    expect(code).toMatch(/select public\.clank_harden_schema\(\);\s*$/);
  });

  it("is finalized by hash: the sha256 prefix recorded in docs/RELEASE_PLAN.md is this file's", () => {
    const plan = readFileSync(path.join(process.cwd(), "docs/RELEASE_PLAN.md"), "utf8");
    const prefix = createHash("sha256").update(readFileSync(path.join(process.cwd(), "supabase/migrations", `${FILE}.sql`))).digest("hex").slice(0, 8);
    expect(plan, "update the approved-hash table in docs/RELEASE_PLAN.md §9 when the migration changes").toContain(prefix);
  });
});

describe("applied to a database that holds development progress", () => {
  async function developmentDb(): Promise<{ db: Db; hero: string }> {
    const db = await createTestDbUpTo(BEFORE);
    dbs.push(db);
    const [h] = await seedLegacyHeroes(db, 3, { startId: 9_400_000, origin: "TELEGRAM" });
    const hero = h!.id;
    await db.query("insert into public.character_achievements (character_id, achievement_id, context) values ($1, 'arena_debut', '{\"metric\":\"battles\",\"value\":3}'::jsonb), ($1, 'voice_of_clank', '{\"metric\":\"telegram_qualifying\",\"value\":600}'::jsonb)", [hero]);
    const [cls] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [hero]);
    await db.query("insert into public.item_templates (id, name, slot, rarity, description, stat_mods, class_restriction) values ('mig_axe', 'Axe', 'WEAPON', 'RARE', 'x', '{}'::jsonb, null) on conflict (id) do nothing");
    await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, 'mig_axe', 'WEAPON', true)", [hero]);
    void cls;
    await db.query("insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ($1, 500, 'test_grant', 'mig-gold-1')", [hero]);
    return { db, hero };
  }

  const heroFingerprint = async (db: Db): Promise<string> =>
    JSON.stringify(await db.query(
      `select (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.characters c) as characters,
              (select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from public.hero_versions v) as versions,
              (select coalesce(jsonb_agg(to_jsonb(a) order by a.character_id), '[]') from public.character_appearances a) as appearances,
              (select coalesce(jsonb_agg(to_jsonb(s) order by s.character_id), '[]') from public.character_stats s) as stats`,
    ));

  it("keeps every unlock, every item, every ledger row and every hero exactly — and archives NOTHING (the game is still DEVELOPMENT)", async () => {
    const { db, hero } = await developmentDb();
    const heroes = await heroFingerprint(db);
    const ledger = JSON.stringify(await db.query("select * from public.currency_ledger order by id"));
    const unlockedBefore = (await db.query<{ achievement_id: string }>("select achievement_id from public.character_achievements order by 1")).map((r) => r.achievement_id);

    expect((await migrate(db)).applied).toEqual([NEW]);

    expect(await heroFingerprint(db)).toBe(heroes);
    expect(JSON.stringify(await db.query("select * from public.currency_ledger order by id"))).toBe(ledger);
    const rows = await db.query<{ achievement_id: string; archived_at: Date | null; season_id: string | null; id: string }>("select id, achievement_id, archived_at, season_id from public.character_achievements order by 2");
    expect(rows.map((r) => r.achievement_id)).toEqual(unlockedBefore);
    expect(rows.every((r) => r.archived_at === null && r.id)).toBe(true);
    expect((await db.query<{ archived_at: Date | null; equipped: boolean }>("select archived_at, equipped from public.inventory_items where character_id = $1", [hero]))).toEqual([{ archived_at: null, equipped: true }]);
    expect((await db.query("select phase from public.game_state"))[0]).toEqual({ phase: "DEVELOPMENT" });
    // a development database is clean for the auditor (it only speaks once the game is LIVE)
    expect(await db.query("select * from public.audit_development_economy()")).toEqual([]);
    // idempotent
    expect((await migrate(db)).applied).toEqual([]);
  });

  it("schema: an archived unlock does not block a new one; an active duplicate still does; archived loot can never be equipped", async () => {
    const { db, hero } = await developmentDb();
    await migrate(db);
    await db.query("update public.character_achievements set archived_at = now() where character_id = $1 and achievement_id = 'arena_debut'", [hero]);
    await db.query("insert into public.character_achievements (character_id, achievement_id) values ($1, 'arena_debut')", [hero]); // earned again
    await expect(db.query("insert into public.character_achievements (character_id, achievement_id) values ($1, 'arena_debut')", [hero])).rejects.toThrow(/character_achievements_active_unique|duplicate/);
    // the season of a new unlock is stamped from the ACTIVE season
    const [row] = await db.query<{ season_id: string | null }>("select season_id from public.character_achievements where character_id = $1 and achievement_id = 'arena_debut' and archived_at is null", [hero]);
    expect(row!.season_id).toBeTruthy();
    // equipped + archived is rejected
    await expect(db.query("update public.inventory_items set archived_at = now() where character_id = $1", [hero])).rejects.toThrow(/inventory_items_archived_not_equipped/);
    await db.query("update public.inventory_items set equipped = false, archived_at = now() where character_id = $1", [hero]);
    await expect(db.query("update public.inventory_items set equipped = true where character_id = $1", [hero])).rejects.toThrow(/inventory_items_archived_not_equipped/);
  });

  it("the auditor finds development progress that is still active once the game is LIVE — and is silent when it was archived", async () => {
    const { db, hero } = await developmentDb();
    await migrate(db);
    // pretend a launch happened WITHOUT the archive step (the thing the auditor exists to catch)
    // (set up directly, bypassing the lifecycle guards: this test is about the auditor, not about how a launch is allowed)
    await db.exec(`set session_replication_role = replica;
                   update public.arena_state set status = 'NOT_STARTED', paused = false, started_at = null;
                   update public.game_state set phase = 'LIVE', launched_at = now() + interval '1 minute', launch_season_id = (select id from public.seasons order by created_at desc limit 1);
                   set session_replication_role = origin;`);
    const problems = (await db.query<{ problem: string }>("select problem from public.audit_development_economy()")).map((r) => r.problem).sort();
    expect(problems).toEqual(["DEVELOPMENT_ACHIEVEMENT_ACTIVE_IN_LIVE", "DEVELOPMENT_GOLD_ACTIVE_IN_LIVE", "DEVELOPMENT_LOOT_ACTIVE_IN_LIVE"]);
    // …the permanent unlock (community metric) is never a finding
    expect((await db.query<{ detail: string }>("select detail from public.audit_development_economy() where problem = 'DEVELOPMENT_ACHIEVEMENT_ACTIVE_IN_LIVE'")).map((r) => r.detail)).toEqual([`${hero}:arena_debut`]);
    // archive it by hand the way the launch does: clean
    await db.exec(`update public.character_achievements set archived_at = now() where achievement_id = 'arena_debut';
                   update public.inventory_items set equipped = false, archived_at = now();
                   insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ('${hero}', -500, 'season_launch_reset', 'mig-reset-1');`);
    // (the launch's own reset entry is stamped with the launch transaction's time: launched_at = that moment)
    await db.exec("set session_replication_role = replica; update public.game_state set launched_at = (select max(created_at) from public.currency_ledger); set session_replication_role = origin;");
    expect(await db.query("select * from public.audit_development_economy()")).toEqual([]);
  });

  it("refuses to run before the game-lifecycle migration", async () => {
    const early = await createTestDbUpTo("20261006001900");
    dbs.push(early);
    const target = (await readMigrations()).find((f) => f.version === NEW)!;
    await expect(early.exec(target.sql)).rejects.toThrow(/must be applied first/);
  });
});
