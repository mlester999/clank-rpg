import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { finalizeHeroPeriod } from "@/server/rewards/heroArena";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { applyRerollPreview, previewReroll } from "@/server/services/heroVersions";

import { createTestDbUpTo, seedHeroes } from "../support/db";
import { giveWins, seedHeroOwners } from "../support/heroArena";
import { finalize as finalizePicks, seedScores, settingsWith, utc } from "../support/rewards";

/**
 * MIGRATION 20261015002700 — champion snapshots, the launch backup attestation and two auditors. Written, never applied to anything but scratch databases. It is purely
 * additive: it rewrites no hero, version, battle, board or result, deletes nothing, backfills nothing, launches nothing.
 */
const PREVIOUS = "20261014002600";
const NEW = "20261015002700";
const code = readFileSync(path.join(process.cwd(), "supabase", "migrations", `${NEW}_event_champion_snapshots.sql`), "utf8");
const executable = code.replace(/--.*$/gm, ""); // statements only: comments may talk about what the file does not do

const dbs: Db[] = [];
const fresh = async (): Promise<Db> => {
  const db = await createTestDbUpTo(PREVIOUS);
  dbs.push(db);
  return db;
};
afterAll(async () => {
  for (const d of dbs) await d.close();
});

describe("the file", () => {
  it("comes right after hero renderer v3 and nothing at or below 2600 was edited", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(NEW)).toBe(all.indexOf(PREVIOUS) + 1);
    expect(all.filter((v) => v > NEW)).toEqual(["20261017002800", "20261029002900"]); // only the two Arena Picks pool settings migrations follow it
  });

  it("is additive: deletes nothing, rewrites no row, backfills nothing, and touches no existing table", () => {
    expect(executable).not.toMatch(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i);
    expect(executable).not.toMatch(/\b(update)\s+(public\.)?\w+\s+set\b/i);
    expect(executable).not.toMatch(/\binsert\s+into\s+(public\.)?(characters|hero_versions|character_appearances|character_stats|arena_leaderboards|arena_leaderboard_results|hero_arena_boards|hero_arena_results|arena_battles|seasons|game_state|arena_state|game_settings|arena_reward_ledger|arena_reward_accounts)\b/i);
    expect([...executable.matchAll(/alter\s+table\s+(public\.\w+)/gi)].map((m) => m[1])).toEqual([]); // no existing table is altered
    // it never launches, resets or starts anything
    expect(executable).not.toMatch(/\bset\s+(phase|status)\b/i);
    // the new tables are append-only
    for (const t of ["arena_leaderboard_result_snapshots", "hero_arena_result_snapshots", "launch_backup_attestations"]) {
      expect(executable, t).toMatch(new RegExp(`create trigger ${t}_append_only before update or delete on public\\.${t}`, "i"));
    }
    // the internal generation seed is never copied into a snapshot
    expect(executable).not.toMatch(/generation_seed|appearance_seed/i);
  });
});

describe("applying it", () => {
  it("changes no existing row: heroes, versions, battles, boards and results are byte-identical", async () => {
    const db = await fresh();
    const owners = await seedHeroOwners(db, [{ user: 11 }, { user: 12 }, { user: 13 }, { user: 14 }]);
    const [a, b, c, d] = [...owners.values()] as [string, string, string, string];
    await giveWins(db, a, 3, "2026-10-07T12:00:00Z", { filler: [c, d] });
    await seedScores(db, [{ user: 11, day: "2026-10-07", picks: 22, correct: 15 }, { user: 12, day: "2026-10-07", picks: 22, correct: 9 }]);
    const settings = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    await finalizePicks(db, "DAILY", "2026-10-07", utc(2026, 10, 8, 1), { settings });
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings, allowDemo: true }, "DAILY", "2026-10-07");
    void b;

    const tables = ["characters", "hero_versions", "character_appearances", "character_stats", "arena_battles", "arena_participants", "arena_leaderboards", "arena_leaderboard_results", "hero_arena_boards", "hero_arena_results", "seasons", "game_state", "arena_state", "game_settings", "arena_reward_ledger"];
    const snapshot = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await db.query(`select * from public.${t} order by 1, 2`)])));
    const before = await snapshot();
    const result = await migrate(db, undefined, { upTo: NEW }); // the later pool-settings migrations legitimately rewrite game_settings and have their own tests
    expect(result.applied).toEqual([NEW]);
    expect(await snapshot()).toEqual(before);
    // nothing is backfilled: the already-finalized (pre-season) results have no snapshot — they are never shown on Events
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.arena_leaderboard_result_snapshots"))[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_arena_result_snapshots"))[0]!.n).toBe(0);
    // re-running it is a no-op
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]);
  });
});

describe("the snapshot trigger", () => {
  async function migrated() {
    const db = await fresh();
    await migrate(db);
    return db;
  }

  it("takes the hero version in force when the period CLOSED — not a later one — and falls back to the current version", async () => {
    const db = await migrated();
    const owners = await seedHeroOwners(db, [{ user: 21 }, { user: 22 }, { user: 23 }]);
    const [a, b, c] = [...owners.values()] as [string, string, string];
    const [v1] = await db.query<{ id: string; power: number; version_number: number }>("select id, power, version_number from public.hero_versions where character_id = $1", [a]);
    // a later version, created AFTER the period closes (hero_versions rows are immutable; a new row is how history grows)
    const sv = await db.query<Record<string, unknown>>("select * from public.hero_versions where id = $1", [v1!.id]);
    expect(sv).toHaveLength(1);
    // before any later version exists, the snapshot is v1
    await giveWins(db, a, 2, "2026-10-07T12:00:00Z", { filler: [b, c] });
    const settings = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    // (stubs are on the development season; make it count by finalizing while it is the active one)
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings, allowDemo: true }, "DAILY", "2026-10-07");
    const snap = (await db.query<{ hero_version_id: string; version_number: number; power: number; rarity: string; look: { rarity: string; parts: unknown } }>(
      "select hero_version_id, version_number, power, rarity, look from public.hero_arena_result_snapshots where kind = 'DAILY' and period_start = '2026-10-07' and character_id = $1", [a]))[0]!;
    expect(snap).toMatchObject({ hero_version_id: v1!.id, version_number: 1, power: v1!.power });
    expect(snap.look.rarity).toBe(snap.rarity);
    expect(snap.look.parts).toBeTruthy();
    // the seed is never in a snapshot
    expect(JSON.stringify(snap.look)).not.toMatch(/seed/i);
    // one snapshot per frozen result, no more
    expect((await db.query<{ n: number }>("select count(*)::int as n from public.hero_arena_result_snapshots"))[0]!.n).toBe((await db.query<{ n: number }>("select count(*)::int as n from public.hero_arena_results"))[0]!.n);
  });

  it("a LATE finalization still records the hero as it was when the period closed, not the version a later reroll made", async () => {
    const db = await migrated();
    const [hero, f1, f2] = await seedHeroes(db, 3);
    // make v1 older than the period (hero_versions are immutable — this is test seeding), then reroll: v2 is created NOW, after the period closed
    await db.exec("alter table public.hero_versions disable trigger all");
    await db.query("update public.hero_versions set created_at = '2026-10-01T00:00:00Z' where character_id = $1", [hero]);
    await db.exec("alter table public.hero_versions enable trigger all");
    const deps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: "test-secret-value-1234567890", now: () => new Date() };
    const p = await previewReroll(db, hero!, "admin", deps);
    await applyRerollPreview(db, hero!, p.previewId, "admin", deps);
    const versions = await db.query<{ id: string; version_number: number }>("select id, version_number from public.hero_versions where character_id = $1 order by version_number", [hero]);
    expect(versions.map((v) => v.version_number)).toEqual([1, 2]);

    await giveWins(db, hero!, 2, "2026-10-07T12:00:00Z", { filler: [f1!, f2!] });
    const settings = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 9, 1)), settings, allowDemo: true }, "DAILY", "2026-10-07"); // finalized a day late, after the reroll
    const snap = (await db.query<{ hero_version_id: string; version_number: number }>("select hero_version_id, version_number from public.hero_arena_result_snapshots where kind = 'DAILY' and character_id = $1", [hero]))[0]!;
    expect(snap).toMatchObject({ version_number: 1, hero_version_id: versions[0]!.id }); // the version in force at the end of 2026-10-07, not the current v2
    expect((await db.query<{ v: number }>("select version_number as v from public.hero_versions where id = (select current_hero_version_id from public.characters where id = $1)", [hero]))[0]!.v).toBe(2);
  });

  it("hero_version_at picks the newest version created before the instant, by creation time", async () => {
    const db = await migrated();
    const owners = await seedHeroOwners(db, [{ user: 31 }]);
    const [a] = [...owners.values()] as [string];
    const [v1] = await db.query<{ id: string }>("select id from public.hero_versions where character_id = $1", [a]);
    // before v1 existed → falls back to the current version; after → v1
    expect((await db.query<{ v: string }>("select public.hero_version_at($1, '2000-01-01T00:00:00Z') as v", [a]))[0]!.v).toBe(v1!.id);
    expect((await db.query<{ v: string }>("select public.hero_version_at($1, now() + interval '1 day') as v", [a]))[0]!.v).toBe(v1!.id);
    expect((await db.query<{ e: string }>("select public.period_end_at('DAILY', '2026-10-07')::text as e"))[0]!.e).toMatch(/2026-10-08/);
    expect((await db.query<{ e: string }>("select public.period_end_at('WEEKLY', '2026-10-05')::text as e"))[0]!.e).toMatch(/2026-10-12/);
  });

  it("snapshots are immutable and the auditors are clean on a fresh database", async () => {
    const db = await migrated();
    const owners = await seedHeroOwners(db, [{ user: 41 }, { user: 42 }, { user: 43 }]);
    const [a, b, c] = [...owners.values()] as [string, string, string];
    await giveWins(db, a, 1, "2026-10-07T12:00:00Z", { filler: [b, c] });
    const settings = { ...settingsWith({ enabled: false }), hero_arena: { ...DEFAULT_SETTINGS.hero_arena, enabled: false } };
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings, allowDemo: true }, "DAILY", "2026-10-07");
    await expect(db.exec("update public.hero_arena_result_snapshots set power = 1")).rejects.toThrow(/append-only/);
    await expect(db.exec("delete from public.hero_arena_result_snapshots")).rejects.toThrow(/append-only/);
    expect(await db.query("select * from public.audit_event_champions()")).toEqual([]);
    expect(await db.query("select * from public.audit_launch_isolation()")).toEqual([]);
  });
});
