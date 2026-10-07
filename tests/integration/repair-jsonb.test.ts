import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { repairDoubleEncodedJsonb, scanDoubleEncodedJsonb } from "@/server/services/repairJsonb";

import { createTestDb, resetDb } from "../support/db";

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

const corrupt = async () => {
  await db.exec("update public.game_settings set value = to_jsonb(value::text)");
  await db.exec("update public.character_classes set definition = to_jsonb(definition::text)");
  await db.exec("update public.item_templates set stat_mods = to_jsonb(stat_mods::text)");
};

describe("repairDoubleEncodedJsonb", () => {
  it("finds nothing in a correctly-encoded database and changes nothing", async () => {
    expect(await scanDoubleEncodedJsonb(db)).toEqual([]);
    expect(await repairDoubleEncodedJsonb(db)).toEqual([]);
  });

  it("restores double-encoded objects so the strict readers work again, and is idempotent", async () => {
    const before = await loadSettings(db);
    const classesBefore = await loadClasses(db);
    await corrupt();
    await expect(loadSettings(db)).rejects.toThrow();
    const found = await scanDoubleEncodedJsonb(db);
    expect(found.map((f) => `${f.table}.${f.column}`)).toEqual(expect.arrayContaining(["game_settings.value", "character_classes.definition", "item_templates.stat_mods"]));

    await repairDoubleEncodedJsonb(db);
    expect(await loadSettings(db)).toEqual(before);
    expect(await loadClasses(db)).toEqual(classesBefore);
    expect(await scanDoubleEncodedJsonb(db)).toEqual([]);
    expect(await repairDoubleEncodedJsonb(db)).toEqual([]); // second run: nothing left to do
  });

  it("never touches a legitimate string value", async () => {
    await db.exec(`update public.feature_flags set payload = to_jsonb('just a plain note'::text) where key = (select key from public.feature_flags limit 1)`);
    expect(await scanDoubleEncodedJsonb(db)).toEqual([]);
    expect(await repairDoubleEncodedJsonb(db)).toEqual([]);
    expect((await db.query<{ t: string }>("select count(*)::int as t from public.feature_flags where payload = to_jsonb('just a plain note'::text)"))[0]?.t).toBe(1);
  });
});
