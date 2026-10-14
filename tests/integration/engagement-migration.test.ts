import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { buildDefaultRuleset } from "@/domain/content";
import { COMBAT_RULES_VERSION, PRE_ENGAGEMENT_RULES_VERSION } from "@/domain/rules";
import { DEFAULT_ENGAGEMENT, DEFAULT_SETTINGS } from "@/domain/settings";
import { canonicalJson, hashObject } from "@/domain/util/hash";
import { loadRuleset, loadRulesetSnapshot, loadSettings } from "@/server/config/settingsRepo";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";

import { makeLineup } from "../support/fixtures";
import { rules300Stored } from "../support/rules300";

const PREVIOUS = "20261007002200";
const NEW = "20261007002300";
let db: Db;

/** The combat row as a database moved to rules 3.0.0 by migration 1700 holds it: the 3.0.0 numbers, no `engagement`, and the retired `ring` key. */
const COMBAT_300 = (() => {
  const c = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.combat)) as Record<string, unknown>;
  delete c.engagement;
  return { ...c, ring: { startMs: 6000, endMs: 18_000, minRadius: 80, damagePctPerSec: 0.06, damageRampPerSec: 0.02 } };
})();
const VISUALS_V1 = { spriteSet: "clank-dev-v1", disabledCosmetics: [] as string[] };

const put = (key: string, value: unknown, version = 1, by = "seed") =>
  db.query("update public.game_settings set value = $2::jsonb, version = $3, updated_by = $4 where key = $1", [key, JSON.stringify(value), version, by]);
type SettingRow = { value: Record<string, unknown>; version: number; updated_by: string };
const row = async (key: string) => (await db.query<SettingRow>("select value, version, updated_by from public.game_settings where key = $1", [key]))[0]!;
const otherRows = () => db.query<{ key: string; version: number; value: unknown }>("select key, version, value from public.game_settings where key not in ('combat','visuals') order by key");
const heroData = async () => ({
  characters: await db.query("select * from public.characters order by id"),
  versions: await db.query("select * from public.hero_versions order by id"),
  battles: await db.query("select id, events_hash, rules_version, ruleset_hash from public.arena_battles order by id"),
  snapshots: await db.query("select hash, rules_version from public.ruleset_snapshots order by hash"),
});

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
  await put("combat", COMBAT_300);
  await put("visuals", VISUALS_V1);
});
afterEach(async () => {
  await db.close();
});

describe("migration 2300 — combat rules 3.1.0 engagement + hero renderer v2 (settings only)", () => {
  it("moves a 3.0.0 database to rules 3.1.0 and the v2 renderer, and touches nothing else (no setting, no hero, no battle)", async () => {
    const before = await loadSettings(db);
    expect((await loadRuleset(db)).ruleset.rulesVersion).toBe(PRE_ENGAGEMENT_RULES_VERSION);
    const others = await otherRows();
    const heroes = await heroData();

    const result = await migrate(db, undefined, { upTo: NEW });
    expect(result.applied).toEqual([NEW]);

    const combat = await row("combat");
    expect([combat.version, combat.updated_by]).toEqual([2, `migration:${NEW}`]);
    expect(combat.value.engagement).toEqual(DEFAULT_ENGAGEMENT);
    const visuals = await row("visuals");
    expect([visuals.version, visuals.updated_by]).toEqual([2, `migration:${NEW}`]);
    expect(visuals.value).toEqual({ spriteSet: "clank-dev-v2", disabledCosmetics: [] });

    const after = await loadSettings(db);
    expect(after.combat).toEqual(DEFAULT_SETTINGS.combat); // the app now reads EXACTLY the shipped 3.1.0 combat
    expect({ ...after.combat, engagement: undefined }).toEqual({ ...before.combat, engagement: undefined }); // …and only `engagement` was added
    expect(after.visuals).toEqual({ spriteSet: "clank-dev-v2", disabledCosmetics: [] }); // 2300's own target (renderer v3 is moved by migration 2600)
    expect({ ...after, combat: before.combat, visuals: before.visuals }).toEqual(before);
    expect(await otherRows()).toEqual(others);
    expect(await heroData()).toEqual(heroes);
    expect((await loadRuleset(db)).ruleset.rulesVersion).toBe(COMBAT_RULES_VERSION); // new battles: rules 3.1.0
  });

  it("leaves a re-paced combat row and a custom sprite set alone (each row independently), and re-running is a no-op", async () => {
    await put("combat", { ...COMBAT_300, pace: { time: 2.2, move: 1.1 } }, 4, "admin");
    await put("visuals", { spriteSet: "studio-art-v1", disabledCosmetics: ["aura.flame"] }, 3, "admin");
    await migrate(db);
    const combat = await row("combat");
    expect(combat.value).not.toHaveProperty("engagement");
    expect([combat.version, combat.updated_by]).toEqual([4, "admin"]);
    const visuals = await row("visuals");
    expect(visuals.value.spriteSet).toBe("studio-art-v1");
    expect([visuals.version, visuals.updated_by]).toEqual([3, "admin"]);

    // one tuned, one still at the 3.0.0 default → only the untouched one moves
    await put("combat", COMBAT_300);
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db);
    expect((await row("combat")).value.engagement).toEqual(DEFAULT_ENGAGEMENT);
    expect((await row("visuals")).value.spriteSet).toBe("studio-art-v1");

    // re-running: nothing changes again
    const v = (await row("combat")).version;
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db);
    expect((await row("combat")).version).toBe(v);
  });

  it("a row that already carries an engagement block (a fresh 3.1.0 seed, or an admin's own) is not touched", async () => {
    await put("combat", DEFAULT_SETTINGS.combat);
    await put("visuals", DEFAULT_SETTINGS.visuals);
    await migrate(db);
    expect((await row("combat")).version).toBe(1);
    expect((await row("visuals")).version).toBe(1);
    await put("combat", { ...DEFAULT_SETTINGS.combat, engagement: { ...DEFAULT_ENGAGEMENT, backpedal: 0.8 } }, 5, "admin");
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db);
    expect((await row("combat")).value.engagement).toMatchObject({ backpedal: 0.8 });
  });

  it("a battle stored under rules 3.0.0 replays to the same event hash before AND after the migration; a new battle is rules 3.1.0", async () => {
    const stored = rules300Stored(buildDefaultRuleset());
    const hash = hashObject(stored);
    await db.query("insert into public.ruleset_snapshots (hash, rules_version, ruleset) values ($1, '3.0.0', $2::jsonb)", [hash, canonicalJson(stored)]);
    const replay = async () => simulateBattle({ seed: "stored-3.0.0", ruleset: await loadRulesetSnapshot(db, hash), units: makeLineup("mig31"), maxCombatMs: 60_000 });

    const before = await replay();
    await migrate(db);
    const after = await replay();
    expect(after.rulesVersion).toBe("3.0.0");
    expect(after.eventsHash).toBe(before.eventsHash);
    expect(after.durationMs).toBe(before.durationMs);

    const { ruleset } = await loadRuleset(db);
    const fresh = simulateBattle({ seed: "stored-3.0.0", ruleset, units: makeLineup("mig31"), maxCombatMs: 60_000 });
    expect(fresh.rulesVersion).toBe("3.1.0");
    expect(fresh.eventsHash).not.toBe(before.eventsHash);
  });
});
