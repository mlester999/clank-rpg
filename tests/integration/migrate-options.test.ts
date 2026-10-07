import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPgliteDb } from "@/server/db/pglite";
import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

const HERO_ADMIN = "20261005000800";
const PREVIOUS = "20261005000700";

// Supabase ships these roles; plain Postgres (PGlite) doesn't, and clank_harden_schema() grants to them.
const ROLE_SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
`;

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
  await db.exec(ROLE_SHIM);
});
afterEach(async () => {
  await db.close();
});

const applied = async () => (await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")).map((r) => r.version);
const hasColumn = async (name: string) => (await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'characters' and column_name = $1", [name])).length > 0;

describe("migrate options (apply exactly one migration to a live database)", () => {
  it("--dry-run reports what would be applied and changes nothing — not even the bookkeeping table", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    const r = await migrate(db, undefined, { dryRun: true });
    expect(r.applied).toEqual([]);
    expect(r.pending).toEqual(all);
    const schemas = await db.query("select 1 from information_schema.schemata where schema_name in ('supabase_migrations') ");
    expect(schemas).toEqual([]);
    expect(await db.query("select 1 from information_schema.tables where table_schema = 'public'")).toEqual([]);
  });

  it("--up-to applies migrations through that version and leaves every later one pending", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    const r = await migrate(db, undefined, { upTo: HERO_ADMIN });
    expect(r.applied).toEqual(all.filter((v) => v <= HERO_ADMIN));
    expect(r.pending).toEqual(all.filter((v) => v > HERO_ADMIN));
    expect(await applied()).toEqual(all.filter((v) => v <= HERO_ADMIN));
    expect(await hasColumn("admin_note")).toBe(true);
  });

  it("a later plain migrate picks up exactly the remainder, and a third run is a no-op", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    await migrate(db, undefined, { upTo: PREVIOUS });
    expect(await hasColumn("admin_note")).toBe(false);
    const second = await migrate(db);
    expect(second.applied).toEqual(all.filter((v) => v > PREVIOUS));
    expect(second.pending).toEqual([]);
    expect((await migrate(db)).applied).toEqual([]);
  });

  it("--dry-run on a partly migrated database lists only the pending versions", async () => {
    await migrate(db, undefined, { upTo: PREVIOUS });
    const all = (await readMigrations()).map((m) => m.version);
    const r = await migrate(db, undefined, { dryRun: true, upTo: HERO_ADMIN });
    expect(r.applied).toEqual([]);
    expect(r.pending).toEqual(all.filter((v) => v > PREVIOUS));
    expect(await hasColumn("admin_note")).toBe(false);
  });

  it("rejects anything that is not a 14-digit version", async () => {
    await expect(migrate(db, undefined, { upTo: "800" })).rejects.toThrow(/14-digit/);
    await expect(migrate(db, undefined, { upTo: "--dry-run" })).rejects.toThrow(/14-digit/);
  });
});

describe(`migration ${HERO_ADMIN} on a populated database (the live path: everything before it applied, real rows present)`, () => {
  async function populatedAtPrevious() {
    await migrate(db, undefined, { upTo: PREVIOUS });
    await db.exec(`
      insert into public.character_classes (id, name, definition) values ('warrior', 'Warrior', '{}'::jsonb);
      insert into public.telegram_users (telegram_user_id, display_name) values (7001, 'Plain Name'), (7002, 'Has Override'), (7003, '🥰');
      insert into public.characters (kind, telegram_user_id, class_id, name, name_override, origin) values
        ('COMMUNITY', 7001, 'warrior', 'Plain Name', null, 'HISTORICAL_IMPORT'),
        ('COMMUNITY', 7002, 'warrior', 'Has Override', 'Chosen 🍀 Name', 'HISTORICAL_IMPORT'),
        ('COMMUNITY', 7003, 'warrior', 'Wanderer 7003', null, 'HISTORICAL_IMPORT');
    `);
  }

  it("applies cleanly, keeps every existing row byte-for-byte, and adds only nullable columns", async () => {
    await populatedAtPrevious();
    const before = JSON.stringify(await db.query("select id, kind, telegram_user_id, class_id, name, name_override, level, xp, status, origin, power, created_at from public.characters order by telegram_user_id"));
    const r = await migrate(db, undefined, { upTo: HERO_ADMIN });
    expect(r.applied).toEqual([HERO_ADMIN]);
    const after = JSON.stringify(await db.query("select id, kind, telegram_user_id, class_id, name, name_override, level, xp, status, origin, power, created_at from public.characters order by telegram_user_id"));
    expect(after).toBe(before);
    const rows = await db.query<{ admin_note: string | null; name_changed_at: Date | null; name_changed_by: string | null }>("select admin_note, name_changed_at, name_changed_by from public.characters");
    expect(rows).toHaveLength(3);
    expect(rows.every((x) => x.admin_note === null && x.name_changed_at === null && x.name_changed_by === null)).toBe(true);
  });

  it("the new constraints reject control characters / oversized notes / unknown rename actors, and accept normal names", async () => {
    await populatedAtPrevious();
    await migrate(db, undefined, { upTo: HERO_ADMIN });
    await expect(db.query("update public.characters set name_override = $1 where telegram_user_id = 7001", ["bad\tname"])).rejects.toThrow(/characters_name_override_clean/);
    await expect(db.query("update public.characters set name_override = $1 where telegram_user_id = 7001", ["bad\u0007name"])).rejects.toThrow(/characters_name_override_clean/);
    await expect(db.query("update public.characters set admin_note = $1 where telegram_user_id = 7001", ["x".repeat(501)])).rejects.toThrow();
    await expect(db.query("update public.characters set name_changed_by = 'ROBOT' where telegram_user_id = 7001")).rejects.toThrow();
    await db.query("update public.characters set name_override = $1, name_changed_by = 'ADMIN', name_changed_at = now(), admin_note = $2 where telegram_user_id = 7001", ["Fine 👑 Name", "ok"]);
    expect((await db.query<{ name_override: string }>("select name_override from public.characters where telegram_user_id = 7001"))[0]?.name_override).toBe("Fine 👑 Name");
  });

  it("refuses (and rolls back) if an existing name_override already contains a control character — nothing half-applied", async () => {
    await populatedAtPrevious();
    await db.query("update public.characters set name_override = $1 where telegram_user_id = 7003", ["tab\there"]);
    await expect(migrate(db, undefined, { upTo: HERO_ADMIN })).rejects.toThrow(/characters_name_override_clean/);
    expect(await applied()).toEqual((await readMigrations()).map((m) => m.version).filter((v) => v <= PREVIOUS));
    expect(await hasColumn("admin_note")).toBe(false);
  });
});
