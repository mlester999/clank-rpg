import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { simulateBattle } from "@/domain/combat/engine";
import { buildDefaultRuleset } from "@/domain/content";
import { validateRuleset } from "@/domain/rules";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { canonicalJson, hashObject } from "@/domain/util/hash";
import { loadRulesetSnapshot, loadSettings } from "@/server/config/settingsRepo";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";

import { makeLineup, ruleset } from "../support/fixtures";
import { rules200Stored } from "../support/rules200";

const PREVIOUS = "20261005001600";
const NEW = "20261005001700";
let db: Db;

/** The two rows exactly as LIVE holds them today (seeded 2026-10-04 under rules 2.0.0; v1, no `pace`, a retired `ring` key). */
const LIVE_COMBAT = {
  ...(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS.combat, hpScale: 1.5, overtime: { startMs: 10_000, damageRampPerSec: 0.08 }, derive: { ...DEFAULT_SETTINGS.combat.derive, atkPerStr: 1, atkPerInt: 1 } })) as Record<string, unknown>),
  ring: { startMs: 6000, endMs: 18_000, minRadius: 80, damagePctPerSec: 0.06, damageRampPerSec: 0.02 },
};
delete (LIVE_COMBAT as { pace?: unknown }).pace;
delete (LIVE_COMBAT as { engagement?: unknown }).engagement; // rules 3.1.0 came later (migration 2300)
delete (LIVE_COMBAT as { rangedPlantMs?: unknown }).rangedPlantMs;
const LIVE_ARENA = { introMs: 2500, groupSize: 8, resultsMs: 5000, countdownMs: 3000, maxCombatMs: 30_000, staleAnchorMs: 20_000, victoryHoldMs: 1200, battleHistoryKeep: 2000 };

const put = (key: string, value: unknown, version = 1, by = "seed") =>
  db.query("update public.game_settings set value = $2::jsonb, version = $3, updated_by = $4 where key = $1", [key, JSON.stringify(value), version, by]);
type SettingRow = { value: Record<string, unknown> & { hpScale?: number; derive?: { atkPerStr: number; atkPerInt: number }; overtime?: unknown; pace?: unknown; maxCombatMs?: number }; version: number; updated_by: string };
const row = async (key: string) => (await db.query<SettingRow>("select value, version, updated_by from public.game_settings where key = $1", [key]))[0]!;

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
  await put("combat", LIVE_COMBAT);
  await put("arena", LIVE_ARENA);
});
afterEach(async () => {
  await db.close();
});

describe("migration 1700 — combat rules 3.0.0 pacing (settings only)", () => {
  it("moves live's two seed rows to the 3.0.0 numbers, and touches nothing else", async () => {
    const before = await loadSettings(db);
    const otherRowsBefore = (await db.query<{ key: string; version: number }>("select key, version from public.game_settings where key not in ('combat','arena') order by key"));

    const result = await migrate(db, undefined, { upTo: NEW });
    expect(result.applied).toEqual([NEW]);

    const combat = await row("combat");
    expect(combat.version).toBe(2);
    expect(combat.updated_by).toBe(`migration:${NEW}`);
    expect(combat.value.hpScale).toBe(1.55);
    expect(combat.value.derive?.atkPerStr).toBe(0.925);
    expect(combat.value.derive?.atkPerInt).toBe(0.925);
    expect(combat.value.overtime).toEqual({ startMs: 28_000, damageRampPerSec: 0.16 });
    expect(combat.value.pace).toEqual({ time: 1.95, move: 1.1 });
    const arena = await row("arena");
    expect(arena.version).toBe(2);
    expect(arena.value.maxCombatMs).toBe(60_000);

    const after = await loadSettings(db);
    const { engagement: _later, ...combat300 } = DEFAULT_SETTINGS.combat;
    void _later;
    expect(after.combat).toEqual(combat300); // the app now reads EXACTLY the shipped 3.0.0 combat (ring stripped on read; 3.1.0's engagement is migration 2300)
    expect(after.arena).toEqual({ ...before.arena, maxCombatMs: 60_000 }); // every other arena timing is untouched
    expect({ ...after, combat: before.combat, arena: before.arena }).toEqual(before); // no other setting moved
    expect(await db.query<{ key: string; version: number }>("select key, version from public.game_settings where key not in ('combat','arena') order by key")).toEqual(otherRowsBefore);
  });

  it("leaves a row an admin has tuned alone (each row independently), and re-running is a no-op", async () => {
    await put("combat", { ...LIVE_COMBAT, hpScale: 1.8 }, 3, "admin");
    await put("arena", { ...LIVE_ARENA, maxCombatMs: 45_000 }, 2, "admin");
    await migrate(db);
    const combat = await row("combat");
    expect(combat.value.hpScale).toBe(1.8);
    expect(combat.value).not.toHaveProperty("pace");
    expect([combat.version, combat.updated_by]).toEqual([3, "admin"]);
    const arena = await row("arena");
    expect(arena.value.maxCombatMs).toBe(45_000);
    expect([arena.version, arena.updated_by]).toEqual([2, "admin"]);

    // one tuned, one still at the old default → only the untouched one moves
    await put("combat", LIVE_COMBAT);
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db);
    expect((await row("combat")).value.pace).toEqual({ time: 1.95, move: 1.1 });
    expect((await row("arena")).value.maxCombatMs).toBe(45_000);

    // re-running: nothing changes again
    const v = (await row("combat")).version;
    await db.query("delete from supabase_migrations.schema_migrations where version = $1", [NEW]);
    await migrate(db);
    expect((await row("combat")).version).toBe(v);
  });

  it("a database that already carries the 3.0.0 numbers (fresh seed) is not touched", async () => {
    await put("combat", DEFAULT_SETTINGS.combat);
    await put("arena", DEFAULT_SETTINGS.arena);
    await migrate(db);
    expect((await row("combat")).version).toBe(1);
    expect((await row("arena")).version).toBe(1);
  });

  it("a battle stored under rules 2.0.0 (no pace, 30 s cap) replays to the same result before AND after the migration", async () => {
    const stored = rules200Stored(buildDefaultRuleset());
    const json = canonicalJson(stored);
    const hash = hashObject(stored);
    await db.query("insert into public.ruleset_snapshots (hash, rules_version, ruleset) values ($1, '2.0.0', $2::jsonb)", [hash, json]);
    const replay = async () => simulateBattle({ seed: "stored-2.0.0", ruleset: await loadRulesetSnapshot(db, hash), units: makeLineup("mig"), maxCombatMs: 30_000 });

    const before = await replay();
    await migrate(db);
    const after = await replay();
    expect(after.eventsHash).toBe(before.eventsHash);
    expect(after.rulesVersion).toBe("2.0.0");
    expect(after.durationMs).toBe(before.durationMs);
    // …while a NEW battle under the migrated settings is a different ruleset: 3.0.0 numbers, 60 s cap
    const fresh = validateRuleset({ rulesVersion: "3.0.0", combat: (await loadSettings(db)).combat, classes: ruleset.classes, skills: ruleset.skills });
    expect(simulateBattle({ seed: "stored-2.0.0", ruleset: fresh, units: makeLineup("mig"), maxCombatMs: 60_000 }).eventsHash).not.toBe(before.eventsHash);
  });
});
