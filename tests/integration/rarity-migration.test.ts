import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDbUpTo } from "../support/db";
import { seedLegacyHeroes } from "../support/legacyHeroes";

/**
 * MIGRATION 20261006001900 — the rarity power system's database side. It must be additive and safe: it adds the SYSTEM_REBALANCE action, a
 * tier guard for generator-2 versions and a read-only auditor — and it must not touch a single hero, version, Arena row or setting.
 */
const FILE = "20261006001900_hero_rarity_power"; // (the runner reports versions: 20261006001900)
const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", `${FILE}.sql`), "utf8");
/** The file without comments and with every `$$ … $$` body collapsed (a function / DO body contains its own semicolons). */
const code = sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");

describe("the migration file", () => {
  it("is sorted right after the hero-version migration it extends (the lifecycle migration comes after it)", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.slice(all.indexOf("20261005001800"), all.indexOf("20261006001900") + 1)).toEqual(["20261005001800", "20261006001900"]);
    // (later migrations may follow the development-economy one — each has its own test)
    expect(all.slice(all.indexOf("20261006001900"), all.indexOf("20261006002100") + 1)).toEqual(["20261006001900", "20261006002000", "20261006002100"]);
  });

  it("changes no data: no INSERT / UPDATE / DELETE / TRUNCATE anywhere, only DDL (constraints, one function, one comment) and the schema hardening call", () => {
    expect(code).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate)\b/i);
    const statements = code.split(";").map((s) => s.trim()).filter(Boolean);
    for (const s of statements) expect(s, s.slice(0, 80)).toMatch(/^(do\b|alter\s+table|comment\s+on|create\s+or\s+replace\s+function|select\s+public\.clank_harden_schema)/i);
    // the single destructive statement is the swap of one CHECK constraint for its superset (the old actions all stay valid)
    expect(code.match(/drop\s+constraint/gi)).toHaveLength(1);
    expect(code).toMatch(/check \(action in \('INITIAL', 'REROLL', 'ROLLBACK', 'SYSTEM_REBALANCE'\)\)/);
  });

  it("ends with the schema hardening call every migration ends with", () => {
    expect(code.trim().endsWith("select public.clank_harden_schema();")).toBe(true);
  });
});

describe("applied to a database that holds legacy heroes (the shape LIVE has after migration 1800)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDbUpTo("20261005001800");
  });
  afterAll(async () => {
    await db.close();
  });

  it("refuses to run before the hero-version migration (an explicit guard, not a mystery SQL error)", async () => {
    const early = await createTestDbUpTo("20261005001700");
    try {
      const e = await early.exec(sql).then(() => null, (x: Error) => x);
      expect(e?.message ?? "").toMatch(/hero-version migration \(20261005001800\) must be applied first/);
    } finally {
      await early.close();
    }
  });

  it("changes NO hero, NO version, NO appearance, NO stat row and NO arena row; v1 history stays byte-for-byte; the auditor then lists every legacy hero as NOT_REBALANCED", async () => {
    await seedLegacyHeroes(db, 12, { startId: 8_100_000, origin: "TELEGRAM" });
    const fingerprint = async () => JSON.stringify(await db.query(
      `select (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.characters c) as characters,
              (select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from public.hero_versions v) as versions,
              (select coalesce(jsonb_agg(to_jsonb(a) order by a.character_id), '[]') from public.character_appearances a) as appearances,
              (select coalesce(jsonb_agg(to_jsonb(s) order by s.character_id), '[]') from public.character_stats s) as stats,
              (select coalesce(jsonb_agg(to_jsonb(g) order by g.key), '[]') from public.game_settings g) as settings,
              (select count(*) from public.arena_battles) as battles`,
    ));
    const before = await fingerprint();
    expect(JSON.parse(before)[0].versions).toHaveLength(12);
    const result = await migrate(db, undefined, { upTo: "20261006001900" });
    expect(result.applied).toEqual(["20261006001900"]);
    expect(await fingerprint()).toBe(before);
    const audit = await db.query<{ problem: string }>("select problem from public.audit_hero_rarity_power()");
    expect(audit).toHaveLength(12);
    expect(new Set(audit.map((r) => r.problem))).toEqual(new Set(["NOT_REBALANCED"]));
  });

  it("is re-runnable: applying it again is a no-op (the runner skips it) and the auditor and constraint survive", async () => {
    const again = await migrate(db, undefined, { upTo: "20261006001900" });
    expect(again.applied).toEqual([]);
    const n = (await db.query<{ n: number }>("select count(*)::int as n from pg_constraint where conname = 'hero_versions_gen2_power_in_rarity_band'"))[0]!.n;
    expect(n).toBe(1);
  });

  it("the action constraint now accepts SYSTEM_REBALANCE and still rejects anything else", async () => {
    const def = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'hero_versions_action_check'"))[0]!.d;
    for (const a of ["INITIAL", "REROLL", "ROLLBACK", "SYSTEM_REBALANCE"]) expect(def).toContain(a);
    expect(def).not.toContain("DELETE");
  });

  it("documents the column with the CURRENT rule (rarity is a PWR tier), superseding the old applied migration's 'COSMETIC ONLY' comment", async () => {
    const [c] = await db.query<{ d: string | null }>("select col_description('public.character_appearances'::regclass, (select attnum from pg_attribute where attrelid = 'public.character_appearances'::regclass and attname = 'rarity')) as d");
    expect(c!.d ?? "").toMatch(/strength tier/);
    expect(c!.d ?? "").not.toMatch(/cosmetic only/i);
  });
});
