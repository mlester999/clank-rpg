import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDbUpTo } from "../support/db";
import { seedLegacyHeroes } from "../support/legacyHeroes";

/**
 * docs/RELEASE_PLAN.md §8 carries the SQL to back the hero-version migration out BEFORE any reroll or backfill. A rollback statement nobody ran is a
 * liability, so this test extracts THAT block from the document and runs it: the database must return to the pre-1800 shape with every hero intact,
 * and the migration must be re-applicable afterwards.
 */
const NEW = "20261005001800";
const BEFORE = "20261005001700";
const plan = readFileSync(path.join(process.cwd(), "docs", "RELEASE_PLAN.md"), "utf8");
const sqlBlocks = [...plan.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] as string);
const rollbackSql = sqlBlocks.find((s) => /drop table public\.hero_versions/.test(s)) as string;
const refreshSql = sqlBlocks.find((s) => /update public\.characters c set power = v\.power/.test(s)) as string;

let db: Db;
beforeAll(async () => {
  expect(rollbackSql, "the rollback SQL block in docs/RELEASE_PLAN.md").toBeTruthy();
  db = await createTestDbUpTo(BEFORE);
}, 120_000);
afterAll(async () => {
  await db.close();
});

describe("the documented rollback of the hero-version migration", () => {
  it("returns a migrated database to the pre-1800 shape, keeps every hero byte-identical, and the migration can be applied again", async () => {
    const heroes = await seedLegacyHeroes(db, 25);
    const shape = async () => ({
      columns: await db.query("select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('characters', 'character_stats', 'character_appearances') order by 1, 2"),
      tables: await db.query("select tablename from pg_tables where schemaname = 'public' order by 1"),
      triggers: await db.query("select tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not tgisinternal order by 1"),
      functions: await db.query("select proname from pg_proc where pronamespace = 'public'::regnamespace order by 1"),
    });
    const heroRows = async () => db.query("select to_jsonb(c) as c, to_jsonb(s) as s, to_jsonb(a) as a from public.characters c join public.character_stats s on s.character_id = c.id join public.character_appearances a on a.character_id = c.id order by c.telegram_user_id");
    const shapeBefore = await shape();
    const heroesBefore = await heroRows();

    await migrate(db, undefined, { upTo: NEW });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions"))[0]!.n).toBe(heroes.length);
    await db.exec(rollbackSql);

    expect(await shape()).toEqual(shapeBefore);
    expect(await heroRows()).toEqual(heroesBefore);
    expect((await db.query("select version from supabase_migrations.schema_migrations where version = $1", [NEW])).length).toBe(0);
    // the class guard and the updated_at trigger are intact (the migration disabled and re-enabled the latter)
    await expect(db.query("update public.characters set class_id = 'x' where telegram_user_id = $1", [heroes[0]!.telegramUserId])).rejects.toThrow();
    expect((await db.query<{ tgenabled: string }>("select tgenabled from pg_trigger where tgname = 'characters_updated_at'"))[0]!.tgenabled).toBe("O");

    // …and the migration applies cleanly again
    await migrate(db, undefined, { upTo: NEW });
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()"))[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where action = 'INITIAL'"))[0]!.n).toBe(heroes.length);
  }, 120_000);

  it("the OPTIONAL stale-POWER refresh (Stage E2) fixes exactly the heroes whose cache is stale, and only those without a wallet / gear component", async () => {
    expect(refreshSql, "the Stage E2 SQL block in docs/RELEASE_PLAN.md").toBeTruthy();
    const fresh = await createTestDbUpTo(BEFORE); // a database in the pre-1800 (live) state — the shared one above has already been migrated
    const heroes = await seedLegacyHeroes(fresh, 12, { startId: 6_000_000 });
    await migrate(fresh, undefined, { upTo: NEW });
    // emulate live: every cached POWER is stale; one hero has a wallet component, one has equipped gear
    await fresh.query("update public.characters set power = power + 7 where telegram_user_id >= 6000000");
    const [walletHero, gearHero] = [heroes[0]!, heroes[1]!];
    await fresh.query("update public.character_stats set holdings_bonus = '{\"def\": 3}'::jsonb where character_id = $1", [walletHero.id]);
    await fresh.query("insert into public.item_templates (id, name, slot, rarity, stat_mods) values ('qa_blade', 'QA blade', 'WEAPON', 'COMMON', '{\"str\": 2}'::jsonb) on conflict do nothing");
    await fresh.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, 'qa_blade', 'WEAPON', true)", [gearHero.id]);
    const stale = async () => (await fresh.query<{ id: string; stale: boolean }>("select c.id, (c.power <> v.power) as stale from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id where c.telegram_user_id >= 6000000")).filter((r) => r.stale).map((r) => r.id);
    expect(await stale()).toHaveLength(12);
    const dry = sqlBlocks.find((b) => b === refreshSql)!.split("-- 2) apply")[0]!.replace("-- 1) dry run (read-only): who would change", "");
    const preview = await fresh.query<{ cached: number; fresh: number }>(dry);
    expect(preview).toHaveLength(10); // the 10 plain heroes; the wallet hero and the gear hero are skipped
    await fresh.exec(refreshSql.split("-- 2) apply")[1] as string);
    const left = await stale();
    expect(left.sort()).toEqual([walletHero.id, gearHero.id].sort());
    // identity, class, rarity and versions are untouched by the refresh
    expect((await fresh.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()"))[0]!.n).toBe(0);
    await fresh.close();
  }, 120_000);

  it("(sanity) the block is the only destructive statement set in the document and touches nothing but hero-version objects", () => {
    const touched = [...rollbackSql.matchAll(/(?:drop (?:trigger if exists|table|function|constraint|column)|alter table|delete from|drop column)\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(touched.every((t) => /hero|characters|character_|supabase_migrations|current_version|public_id|audit_hero|check_hero|require_current|guard_hero|new_hero/.test(t as string))).toBe(true);
    expect(rollbackSql).not.toMatch(/truncate|drop schema|drop database/i);
  });
});
