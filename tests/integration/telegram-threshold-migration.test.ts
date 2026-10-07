import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSettings } from "@/server/config/settingsRepo";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";

const PREVIOUS = "20261005001500";
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
});
afterEach(async () => {
  await db.close();
});

describe("Telegram hero threshold migration", () => {
  it("changes only the previous 100 default and preserves anti-spam settings", async () => {
    await db.query(
      "update public.game_settings set value = jsonb_set(jsonb_set(value, '{qualifyingThreshold}', '100'), '{maxQualifyingPerDay}', '37') where key = 'telegram'",
    );
    const before = await loadSettings(db);

    const result = await migrate(db, undefined, { upTo: "20261005001600" }); // this test is about 1600 only; later migrations have their own
    const after = await loadSettings(db);

    expect(result.applied).toEqual(["20261005001600"]);
    expect(after.telegram.qualifyingThreshold).toBe(50);
    expect({ ...after, telegram: { ...after.telegram, qualifyingThreshold: before.telegram.qualifyingThreshold } }).toEqual(before);
  });

  it("leaves an explicitly configured non-default threshold alone", async () => {
    await db.query("update public.game_settings set value = jsonb_set(value, '{qualifyingThreshold}', '75') where key = 'telegram'");

    await migrate(db, undefined, { upTo: "20261005001600" });

    expect((await loadSettings(db)).telegram.qualifyingThreshold).toBe(75);
  });
});
