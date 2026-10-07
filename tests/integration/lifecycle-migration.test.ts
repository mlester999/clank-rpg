import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ensureRulesetSnapshot, loadRuleset, loadSettings } from "@/server/config/settingsRepo";
import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";

import { createTestDbUpTo } from "../support/db";
import { seedLegacyHeroes } from "../support/legacyHeroes";
import { seedScores } from "../support/rewards";

/**
 * Migration 20261006002000 on a database in the state a development database is in today (everything through 1900 applied, test battles, test Picks).
 * It is ADDITIVE: it layers the game phase, seasons-with-a-kind, public battle numbers and the Arena's runtime status around the existing data. It changes no
 * hero, no hero version, no battle result, snapshot or hash — and it switches nothing on: the default is DEVELOPMENT, and nothing is reset or started.
 */
const BEFORE = "20261006001900";
const NEW = "20261006002000";
const FILE = "20261006002000_game_lifecycle_seasons";
const sql = readFileSync(path.join(process.cwd(), "supabase/migrations", `${FILE}.sql`), "utf8");
/** The file without comments and with every `$$ … $$` body collapsed (a function body contains its own semicolons). */
const code = sql.replace(/--.*$/gm, "").replace(/\$\$[\s\S]*?\$\$/g, "$$$$");

const dbs: Db[] = [];
afterAll(async () => {
  for (const d of dbs) await d.close();
});

interface Old {
  db: Db;
  heroIds: string[];
}

/** A database from before the lifecycle migration: legacy-shaped heroes, two seasons (one ended), settled / void / scheduled battles, picks scores. */
async function oldShaped(opts: { battles: boolean; paused: boolean }): Promise<Old> {
  const db = await createTestDbUpTo(BEFORE);
  dbs.push(db);
  const heroes = await seedLegacyHeroes(db, 12, { startId: 9_300_000, origin: "TELEGRAM" });
  await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [heroes[0]!.id]);
  if (opts.battles) {
    const settings = await loadSettings(db);
    const { ruleset, hash } = await loadRuleset(db, settings);
    await ensureRulesetSnapshot(db, ruleset, hash);
    const [s1] = await db.query<{ id: string }>("select id from public.seasons where number = 1");
    await db.exec("update public.seasons set status = 'ENDED', ends_at = now() where number = 1");
    const [s2] = await db.query<{ id: string }>("insert into public.seasons (number, name, status) values (2, 'Season 2', 'ACTIVE') returning id");
    const cycle = async (season: string, n: number) =>
      (await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, seed, hero_count, status) values ($1, $2, 'old-cycle', 12, 'COMPLETED') returning id", [n, season]))[0]!.id;
    const [c1, c2] = [await cycle(s1!.id, 1), await cycle(s2!.id, 2)];
    const battle = async (season: string, cyc: string, status: "SETTLED" | "VOID" | "SCHEDULED", minute: number) =>
      db.query(
        status === "SETTLED"
          ? `insert into public.arena_battles (season_id, cycle_id, status, starts_at, seed, snapshot, ruleset_hash, events_hash, result, settled_at, rules_version) values ($1, $2, 'SETTLED', now() - ($3 || ' minutes')::interval, 'seed-x', '{"units":[]}'::jsonb, $4, 'hash-x', '{"ranking":[]}'::jsonb, now(), '3.0.0')`
          : `insert into public.arena_battles (season_id, cycle_id, status, starts_at) values ($1, $2, '${status}', now() - ($3 || ' minutes')::interval)`,
        status === "SETTLED" ? [season, cyc, String(minute), hash] : [season, cyc, String(minute)],
      );
    for (const [i, status] of (["SETTLED", "SETTLED", "VOID", "SETTLED"] as const).entries()) await battle(s1!.id, c1, status, 600 - i);
    for (const [i, status] of (["SETTLED", "SETTLED", "SCHEDULED"] as const).entries()) await battle(s2!.id, c2, status, 100 - i);
    await seedScores(db, [{ user: 9401, day: "2026-10-07", picks: 3, correct: 2 }], { seasonId: s2!.id });
  }
  if (opts.paused) await db.exec("update public.arena_state set paused = true");
  return { db, heroIds: heroes.map((h) => h.id) };
}

const heroFingerprint = async (db: Db): Promise<string> =>
  JSON.stringify(await db.query(
    `select (select coalesce(jsonb_agg(to_jsonb(c) order by c.id), '[]') from public.characters c) as characters,
            (select coalesce(jsonb_agg(to_jsonb(v) order by v.id), '[]') from public.hero_versions v) as versions,
            (select coalesce(jsonb_agg(to_jsonb(a) order by a.character_id), '[]') from public.character_appearances a) as appearances,
            (select coalesce(jsonb_agg(to_jsonb(s) order by s.character_id), '[]') from public.character_stats s) as stats`,
  ));
/** Every battle column except the one the migration adds: results, snapshots, hashes and timings must not move. */
const battleFingerprint = async (db: Db): Promise<string> =>
  JSON.stringify(await db.query("select to_jsonb(b) - 'season_sequence' as b from public.arena_battles b order by sequence"));
const otherArena = async (db: Db): Promise<string> =>
  JSON.stringify(await db.query(
    `select (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.arena_cycles x) as cycles,
            (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.arena_queue_entries x) as queue,
            (select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]') from public.arena_pick_scores x) as scores,
            (select coalesce(jsonb_agg(to_jsonb(x) - 'battle_counter' - 'kind' - 'run_number' - 'ended_reason' - 'archive' - 'created_by' - 'number' - 'name' order by x.id), '[]') from public.seasons x) as seasons`,
  )).replace(/"season_id":"[0-9a-f-]+",?/g, "");

describe("the migration file", () => {
  it("sorts right after the rarity-power migration (the development-economy migration, 2100, comes after it)", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.at(-1)).toBe("20261006002100");
    expect(all.indexOf(NEW)).toBe(all.indexOf(BEFORE) + 1);
  });

  it("never touches a hero: no statement writes characters, hero versions, appearances or stats — and it deletes nothing", () => {
    expect(code).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+(public\.)?(characters|hero_versions|character_appearances|character_stats|character_claims|wallet_links)\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.(characters|hero_versions|character_appearances|character_stats)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate)\b/i);
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+column\b/i);
    // it does not launch, reset or start anything: the only game_state row it writes is the DEVELOPMENT default
    expect(code).toMatch(/insert into public\.game_state \(id\) values \(1\)/);
    expect(code).not.toMatch(/update\s+(public\.)?game_state/i);
    expect(code).not.toMatch(/status\s*=\s*'(PREPARING|RUNNING)'\s*(where|,|$)/i); // (the status backfill CASE maps the previous state; it never starts anything on its own)
  });

  it("is finalized by hash: the sha256 prefix recorded in docs/RELEASE_PLAN.md is this file's", () => {
    const plan = readFileSync(path.join(process.cwd(), "docs/RELEASE_PLAN.md"), "utf8");
    const prefix = createHash("sha256").update(readFileSync(path.join(process.cwd(), "supabase/migrations", `${FILE}.sql`))).digest("hex").slice(0, 8);
    expect(plan, "update the approved-hash table in docs/RELEASE_PLAN.md §9 when the migration changes").toContain(prefix);
  });
});

describe("applied to a development database that has run (battles exist, test Picks)", () => {
  it("changes NO hero, NO version, NO battle result / snapshot / hash, NO queue row and NO score — and leaves the game in DEVELOPMENT with the Arena in the state it had", async () => {
    const { db } = await oldShaped({ battles: true, paused: false });
    const [heroes, battles, other] = [await heroFingerprint(db), await battleFingerprint(db), await otherArena(db)];
    expect(JSON.parse(heroes)[0].characters).toHaveLength(13); // 12 legacy heroes + the Picks member's hero

    const result = await migrate(db, undefined, { upTo: NEW });
    expect(result.applied).toEqual([NEW]);

    expect(await heroFingerprint(db)).toBe(heroes);
    expect(await battleFingerprint(db)).toBe(battles);
    expect(await otherArena(db)).toBe(other);

    // DEVELOPMENT by default: not LIVE, nothing reset, nothing started by the migration itself
    expect((await db.query("select phase, launched_at, launch_season_id from public.game_state"))[0]).toEqual({ phase: "DEVELOPMENT", launched_at: null, launch_season_id: null });
    // the Arena kept the state it had: it had run, so it is RUNNING (the old "not paused")
    const [arena] = await db.query<{ status: string; paused: boolean; started_at: Date | null }>("select status, paused, started_at from public.arena_state");
    expect(arena).toMatchObject({ status: "RUNNING", paused: false });
    expect(arena!.started_at).toBeTruthy();

    // every existing season is a DEVELOPMENT run — none is called Season 1
    const seasons = await db.query<{ kind: string; number: number | null; run_number: number; name: string; status: string; battle_counter: number }>("select kind, number, run_number, name, status, battle_counter from public.seasons order by run_number");
    expect(seasons).toEqual([
      { kind: "DEVELOPMENT", number: null, run_number: 1, name: "Development / Beta", status: "ENDED", battle_counter: 4 },
      { kind: "DEVELOPMENT", number: null, run_number: 2, name: "Development run 2", status: "ACTIVE", battle_counter: 6 }, // 3 battles + the 3 synthetic ones the Picks scores hang on
    ]);
    expect(seasons.some((s) => /Season 1/.test(s.name))).toBe(false);

    // public battle numbers: deterministic, per season, in creation order — and the global sequence is untouched
    const numbers = await db.query<{ season_id: string; n: number; seq: number }>("select season_id, season_sequence as n, sequence::int as seq from public.arena_battles order by sequence");
    const bySeason = new Map<string, number[]>();
    for (const r of numbers) bySeason.set(r.season_id, [...(bySeason.get(r.season_id) ?? []), Number(r.n)]);
    expect([...bySeason.values()]).toEqual([[1, 2, 3, 4], [1, 2, 3, 4, 5, 6]]);
    expect(numbers.map((r) => r.seq)).toEqual([...numbers.map((r) => r.seq)].sort((a, b) => a - b));

    // Picks remember their season (backfilled from the battle they were made on)
    const scores = await db.query<{ season_id: string | null; battle_season: string }>("select s.season_id, b.season_id as battle_season from public.arena_pick_scores s join public.arena_battles b on b.id = s.battle_id");
    expect(scores).toHaveLength(3);
    expect(scores.every((s) => s.season_id === s.battle_season)).toBe(true);

    expect(await db.query("select * from public.audit_game_lifecycle()")).toEqual([]);
    // idempotent
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]);
  });

  it("a PAUSED arena stays PAUSED (mirror flag kept); a database that never ran is NOT_STARTED", async () => {
    const paused = await oldShaped({ battles: true, paused: true });
    await migrate(paused.db);
    expect((await paused.db.query("select status, paused from public.arena_state"))[0]).toEqual({ status: "PAUSED", paused: true });

    const fresh = await oldShaped({ battles: false, paused: false });
    await migrate(fresh.db);
    expect((await fresh.db.query("select status, paused, started_at from public.arena_state"))[0]).toEqual({ status: "NOT_STARTED", paused: false, started_at: null });
    expect((await fresh.db.query("select kind, run_number, battle_counter, status from public.seasons"))[0]).toEqual({ kind: "DEVELOPMENT", run_number: 1, battle_counter: 0, status: "ACTIVE" });
  });
});

describe("the schema it leaves behind", () => {
  it("refuses to run before the Arena Picks migrations it extends", async () => {
    const early = await createTestDbUpTo("20261005001300");
    dbs.push(early);
    const files = await readMigrations();
    const target = files.find((f) => f.version === NEW)!;
    await expect(early.exec(target.sql)).rejects.toThrow(/must be applied first/);
  });
});
