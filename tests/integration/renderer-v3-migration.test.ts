import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "@/server/config/settingsRepo";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";

/**
 * Migration 2600 — HERO RENDERER v3: settings only. It moves the `visuals` row from the v2 set to the procedural v3 set, and nothing else: no
 * hero, no hero version, no battle, no other setting. A database pointed at any other set (v1, a studio pack) is left alone; re-running it is a
 * no-op. v1 and v2 stay shipped (an admin can switch back), and battles never stored pixels, so no historical result or hash can move.
 */

const PREVIOUS = "20261009002500";
const NEW = "20261014002600";
const FILE = "20261014002600_hero_renderer_v3.sql";
let db: Db;

const put = (key: string, value: unknown, version = 1, by = "seed") =>
  db.query("update public.game_settings set value = $2::jsonb, version = $3, updated_by = $4 where key = $1", [key, JSON.stringify(value), version, by]);
const row = async (key: string) => (await db.query<{ value: Record<string, unknown>; version: number; updated_by: string }>("select value, version, updated_by from public.game_settings where key = $1", [key]))[0]!;
const everythingElse = async () => ({
  settings: await db.query("select key, version, value from public.game_settings where key <> 'visuals' order by key"),
  characters: await db.query("select * from public.characters order by id"),
  versions: await db.query("select * from public.hero_versions order by id"),
  battles: await db.query("select * from public.arena_battles order by id"),
});

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
});
afterEach(async () => {
  await db.close();
});

describe("migration 2600 — hero renderer v3 (settings only)", () => {
  it("sits right after the free reroll, and only updates one guarded settings value", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(NEW)).toBe(all.indexOf(PREVIOUS) + 1);
    expect(all.filter((v) => v > NEW)).toEqual(["20261015002700", "20261017002800", "20261029002900"]); // the champion-snapshot migration and the two Arena Picks pool settings migrations are the only files after it
    const code = (await readFile(path.join(process.cwd(), "supabase", "migrations", FILE), "utf8")).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    expect(code).not.toMatch(/\b(delete|drop|truncate|insert|alter|create)\b/);
    expect(code.match(/\bupdate\b/g)).toHaveLength(1);
    expect(code).toMatch(/where key = 'visuals'/);
    expect(code).toMatch(/value ->> 'spriteset' = 'clank-dev-v2'/);
  });

  it("moves a database that selects v2 to v3 and touches nothing else", async () => {
    await put("visuals", { spriteSet: "clank-dev-v2", disabledCosmetics: ["aura.flame"] }, 2, "migration:20261007002300");
    const before = await everythingElse();
    const result = await migrate(db, undefined, { upTo: NEW });
    expect(result.applied).toEqual([NEW]);
    const v = await row("visuals");
    expect(v.value).toEqual({ spriteSet: "clank-v3", disabledCosmetics: ["aura.flame"] }); // the admin's kill-switches are kept
    expect([v.version, v.updated_by]).toEqual([3, `migration:${NEW}`]);
    expect(await everythingElse()).toEqual(before);
    expect((await loadSettings(db)).visuals.spriteSet).toBe("clank-v3");
  });

  it("leaves v1 or a custom set alone, and re-running is a no-op", async () => {
    for (const set of ["clank-dev-v1", "studio-art-v1"]) {
      await put("visuals", { spriteSet: set, disabledCosmetics: [] }, 4, "admin");
      await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
      await migrate(db, undefined, { upTo: NEW });
      const v = await row("visuals");
      expect(v.value.spriteSet).toBe(set);
      expect([v.version, v.updated_by]).toEqual([4, "admin"]);
    }
    await put("visuals", { spriteSet: "clank-dev-v2", disabledCosmetics: [] }, 2, "seed");
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db, undefined, { upTo: NEW });
    const once = await row("visuals");
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db, undefined, { upTo: NEW });
    expect(await row("visuals")).toEqual(once);
  });
});
