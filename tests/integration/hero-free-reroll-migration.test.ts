import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPgliteDb } from "@/server/db/pglite";
import { migrate, MIGRATIONS_DIR, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { createCharacterForUser } from "@/server/services/characters";

import { SUPABASE_ROLE_SHIM } from "../support/db";

/**
 * MIGRATION 2500 — the free-reroll allowance. ONE focused, forward-only file: a table, three guards and an auditor. It reads and rewrites nothing that exists, and
 * the highest migration before it is the Arena Chat's 2400 (checked from the repository's own list, never assumed).
 */
const PREVIOUS = "20261008002400";
const NEW = "20261009002500";
const FILE = `${NEW}_hero_free_reroll.sql`;
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await db.exec(SUPABASE_ROLE_SHIM);
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
});
afterEach(async () => {
  await db.close();
});

const snapshot = async () => {
  const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'hero_free_rerolls' order by 1");
  const out: Record<string, string> = {};
  for (const t of tables) out[t.tablename] = JSON.stringify(await db.query(`select * from public.${t.tablename} order by 1`));
  return out;
};

describe("migration 2500 — placement and shape", () => {
  it("comes directly after the Arena Chat's 2400, and the only new file for the reroll — forward-only (no existing migration is edited)", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(NEW)).toBe(all.indexOf(PREVIOUS) + 1);
    // only hero renderer v3 (2600), the champion snapshots (2700), the prize pools (2800), the achievement rewards (2900) and the paid reroll (3000) follow it
    expect(all.filter((v) => v > PREVIOUS)).toEqual([NEW, "20261014002600", "20261015002700", "20261015002800", "20261015002900", "20261015003000"]);
    const sql = await readFile(path.join(MIGRATIONS_DIR, FILE), "utf8");
    expect(sql.trimEnd().endsWith("select public.clank_harden_schema();")).toBe(true);
  });

  it("only ADDS: it never drops, truncates, updates or deletes anything, and alters nothing but its own table's relatives", async () => {
    const code = (await readFile(path.join(MIGRATIONS_DIR, FILE), "utf8")).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    for (const forbidden of [/\bdrop\s+(table|column|constraint|trigger|function)\b/, /\balter\s+table\b/, /\bupdate\s+public\./, /\bdelete\s+from\b/, /\btruncate\b/, /\binsert\s+into\s+public\.(?!hero_free_rerolls)/]) expect(code).not.toMatch(forbidden);
    expect(code).toMatch(/create\s+table\s+public\.hero_free_rerolls/);
    expect(code).toMatch(/primary key \(telegram_user_id, utc_day\)/);
  });

  it("applies on top of a database with heroes, changes no existing row, creates an empty table, and a second run is a no-op", async () => {
    const settings = await loadSettings(db);
    const classes = await loadClasses(db);
    for (const id of [101, 102, 103]) {
      await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values ($1, $2, 120)", [id, `Member ${id}`]);
      const [user] = await db.query("select * from public.telegram_users where telegram_user_id = $1", [id]);
      await createCharacterForUser(db, user as never, { settings, classes, secret: "test-secret-value-1234567890", origin: "TELEGRAM" });
    }
    const before = await snapshot();
    const result = await migrate(db, undefined, { upTo: NEW });
    expect(result.applied).toEqual([NEW]);
    expect(await snapshot()).toEqual(before); // every existing table is byte-identical
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_free_rerolls"))[0]!.n)).toBe(0);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]);
    expect(await db.query("select * from public.audit_hero_versions()")).toEqual([]);
    expect(await db.query("select * from public.audit_hero_free_rerolls()")).toEqual([]);
  });
});

describe("migration 2500 — what the database enforces by itself", () => {
  beforeEach(async () => {
    await migrate(db);
  });

  it("has the one-per-day key, the idempotency keys and the day-matches-instant CHECK", async () => {
    const cons = await db.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.hero_free_rerolls'::regclass order by conname");
    const byName = Object.fromEntries(cons.map((c) => [c.conname, c.def]));
    expect(byName.hero_free_rerolls_pkey).toBe("PRIMARY KEY (telegram_user_id, utc_day)");
    expect(byName.hero_free_rerolls_request_id_key).toBe("UNIQUE (request_id)");
    expect(byName.hero_free_rerolls_hero_version_id_key).toBe("UNIQUE (hero_version_id)");
    expect(byName.hero_free_rerolls_day_matches_instant).toMatch(/utc_day = \(\(created_at AT TIME ZONE 'UTC'::text\)\)::date/);
    expect(cons.filter((c) => c.def.startsWith("FOREIGN KEY")).length).toBeGreaterThanOrEqual(4); // member, hero, this hero's version, this hero's previous version
  });

  it("has the guards: insert guard, immutability, and the DEFERRED 'a member-made version must consume a free reroll' check on hero_versions", async () => {
    const triggers = await db.query<{ tgname: string; tgrelid: string; deferrable: boolean; initdeferred: boolean }>(
      "select tgname, tgrelid::regclass::text as tgrelid, tgdeferrable as deferrable, tginitdeferred as initdeferred from pg_trigger where not tgisinternal and tgname like any (array['hero_free_rerolls_%', 'hero_versions_member_reroll_allowance']) order by tgname",
    );
    expect(triggers.map((t) => t.tgname)).toEqual(["hero_free_rerolls_guard", "hero_free_rerolls_immutable", "hero_versions_member_reroll_allowance"]);
    const deferred = triggers.find((t) => t.tgname === "hero_versions_member_reroll_allowance")!;
    expect(deferred).toMatchObject({ tgrelid: "hero_versions", deferrable: true, initdeferred: true });
  });

  it("is hardened like every table: row-level security on, no policy, no browser-role privileges", async () => {
    const [t] = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.hero_free_rerolls'::regclass");
    expect(t!.relrowsecurity).toBe(true);
    expect(await db.query("select 1 from pg_policies where tablename = 'hero_free_rerolls'")).toEqual([]);
    const grants = await db.query<{ grantee: string }>("select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'hero_free_rerolls' and grantee in ('anon', 'authenticated')");
    expect(grants).toEqual([]);
  });

  it("the feature flag is NOT created by the migration: it is seeded DISABLED by the reference data (and a missing flag is off)", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, FILE), "utf8");
    expect(sql).not.toMatch(/feature_flags/);
    await seedReferenceData(db);
    const [flag] = await db.query<{ enabled: boolean }>("select enabled from public.feature_flags where key = 'hero.free_reroll'");
    expect(flag).toEqual({ enabled: false });
  });
});
