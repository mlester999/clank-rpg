import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { migrate, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { finalizeDueHeroBoards, finalizeHeroPeriod, resetHeroArenaReadiness } from "@/server/rewards/heroArena";
import { heroArenaAdminOverview } from "@/server/rewards/heroArenaAdmin";
import { claimCharacter } from "@/server/services/identity";
import { getHeroArenaPayload } from "@/server/services/heroBoards";

import { createTestDbUpTo } from "../support/db";
import { giveWins, seedHeroOwners } from "../support/heroArena";
import { balanceOf, finalize as finalizePicks, seedScores, tokens, utc } from "../support/rewards";

/**
 * THE HERO ARENA MIGRATION (20261007002200) — written, never applied to anything but scratch databases. It is purely additive, it leaves every Arena Picks row exactly as it
 * was (only labelling it), and the code that needs it is safe to deploy BEFORE it is applied.
 */
const PREVIOUS = "20261006002100";
const NEW = "20261007002200";
const code = readFileSync(path.join(process.cwd(), "supabase", "migrations", `${NEW}_hero_arena_rewards.sql`), "utf8");
const executable = code.replace(/--.*$/gm, ""); // statements only: comments may talk about what they do not do

const dbs: Db[] = [];
const fresh = async (): Promise<Db> => {
  const db = await createTestDbUpTo(PREVIOUS);
  dbs.push(db);
  return db;
};
afterAll(async () => {
  for (const d of dbs) await d.close();
});
const WED = utc(2026, 10, 7, 18);
const settings = { ...DEFAULT_SETTINGS, hero_arena: { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "100000", weeklyPrizePool: "500000" } };

describe("the file", () => {
  it("comes right after the development-economy migration, and nothing at or below 2100 was edited", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(NEW)).toBe(all.indexOf(PREVIOUS) + 1);
    expect(all.filter((v) => v > NEW)).toEqual(["20261007002300", "20261008002400", "20261009002500", "20261014002600"]); // only combat 3.1.0 + hero renderer v2 (settings rows), the Arena Chat (its own tables), the free reroll allowance (its own table + guards) and hero renderer v3 (one settings value) follow it
  });

  it("is additive: it deletes nothing, rewrites no row, never touches a hero, the Arena Picks tables, combat or a season", () => {
    expect(executable).not.toMatch(/\b(delete\s+from|truncate|drop\s+table|drop\s+column)\b/i);
    expect(executable).not.toMatch(/\b(update|insert\s+into)\s+(public\.)?(characters|hero_versions|character_appearances|character_stats|arena_leaderboards|arena_leaderboard_results|arena_pick_scores|arena_picks|arena_battles|arena_participants|seasons|game_state|arena_state|game_settings|arena_reward_ledger|arena_reward_accounts)\b/i);
    expect(executable).not.toMatch(/\balter\s+table\s+public\.(characters|hero_versions|character_appearances|character_stats|arena_leaderboards|arena_leaderboard_results|arena_pick_scores|arena_picks|arena_participants|seasons|game_state|arena_state)\b/i);
    // the ONLY existing table it alters is the reward ledger, and only by adding columns / swapping its two CHECKs for wider ones
    expect([...executable.matchAll(/alter\s+table\s+(public\.\w+)/gi)].map((m) => m[1]).filter((t) => t !== "public.arena_reward_ledger")).toEqual([]);
    // no holder bonus for Hero Arena: no bonus ledger kind, and no bonus / holder column on its tables
    expect(executable).not.toMatch(/HERO_ARENA_\w*(BONUS|HOLDER)/i);
    for (const table of ["hero_arena_boards", "hero_arena_results"]) {
      const body = executable.slice(executable.indexOf(`create table public.${table}`), executable.indexOf(");", executable.indexOf(`create table public.${table}`)));
      expect(body.length, table).toBeGreaterThan(200);
      expect(body, table).not.toMatch(/bonus|holder/i);
    }
    expect(executable).not.toMatch(/\bprize_pool_micro\s+numeric\(78, 0\)\s+not null default/i); // no default pool: nothing is invented
  });
});

describe("applied to a database that already paid Arena Picks prizes", () => {
  it("leaves every Picks board, result, ledger row and balance exactly as it was — the old rows are only LABELLED (ARENA_PICKS_DAILY / ARENA_PICKS_WEEKLY)", async () => {
    const db = await fresh();
    await seedScores(db, [{ user: 301, day: "2026-10-06", picks: 25, correct: 20 }, { user: 302, day: "2026-10-06", picks: 22, correct: 3 }, { user: 301, day: "2026-10-05", picks: 110, correct: 90 }]);
    await finalizePicks(db, "DAILY", "2026-10-06", utc(2026, 10, 7, 1));
    await finalizePicks(db, "WEEKLY", "2026-10-05", utc(2026, 10, 13, 1));
    const dump = async () =>
      JSON.stringify({
        ledger: await db.query("select id, telegram_user_id, kind, claimable_delta::text, reserved_delta::text, claimed_delta::text, earned_delta::text, claimable_after::text, period_kind, period_start::text, idempotency_key, meta from public.arena_reward_ledger order by id"),
        boards: await db.query("select * from public.arena_leaderboards order by kind, period_start"),
        results: await db.query("select * from public.arena_leaderboard_results order by kind, period_start, telegram_user_id"),
        accounts: await db.query("select telegram_user_id, claimable::text, earned_total::text from public.arena_reward_accounts order by 1"),
      });
    const before = await dump();
    expect(JSON.parse(before).ledger.length).toBeGreaterThan(0);

    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([NEW]);

    expect(await dump()).toBe(before);
    const labels = await db.query<{ kind: string; reward_source: string }>("select distinct kind, reward_source from public.arena_reward_ledger order by 1");
    expect(labels).toEqual([
      { kind: "DAILY_LEADERBOARD_BASE_REWARD", reward_source: "ARENA_PICKS_DAILY" },
      { kind: "WEEKLY_LEADERBOARD_BASE_REWARD", reward_source: "ARENA_PICKS_WEEKLY" },
    ]);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]); // idempotent (later migrations are not this file's business)
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);
  });
});

describe("the code is safe to deploy BEFORE the migration is applied", () => {
  it("Arena Picks still finalizes and pays; Hero Arena boards rank live; the Hero Arena sweep, claims and Admin are quiet no-ops that say what is missing", async () => {
    const db = await fresh();
    resetHeroArenaReadiness();
    const heroes = await seedHeroOwners(db, [{ user: 401, name: "Hero A", claimed: true }, { user: 402, name: "Hero B" }, { user: 403, name: "Filler One" }, { user: 404, name: "Filler Two" }]);
    const F: [string, string] = [heroes.get(403)!, heroes.get(404)!];
    await giveWins(db, heroes.get(401)!, 3, new Date(utc(2026, 10, 7, 9)).toISOString(), { filler: F });

    // Arena Picks keeps working on the OLD schema (its ledger insert is untouched by the Hero Arena columns).
    await seedScores(db, [{ user: 301, day: "2026-10-06", picks: 25, correct: 20 }]);
    expect(await finalizePicks(db, "DAILY", "2026-10-06", utc(2026, 10, 7, 1))).toMatchObject({ status: "FINALIZED" });
    expect((await balanceOf(db, 301)).claimable).toBeGreaterThan(0n);

    // Hero Arena: the live board works from battles alone; nothing that needs the new tables is attempted.
    const live = await getHeroArenaPayload(db, "DAILY", { nowMs: WED, settings, allowDemo: false, classes: {} });
    expect(live.board.rows.find((r) => r.name === "Hero A")).toMatchObject({ wins: 3, rank: 1 });
    expect(live.periods).toEqual([]);
    expect(await finalizeDueHeroBoards(db, { now: () => new Date(utc(2026, 10, 9)), settings })).toEqual({ finalized: 0, failed: 0, released: 0, periods: [] });
    expect(await claimCharacter(db, 402, new Date(WED))).toMatchObject({ ok: true }); // claiming a hero is not blocked by a missing reward table
    const overview = await heroArenaAdminOverview(db, settings, WED);
    expect(overview.hero.migrated).toBe(false);
    expect(overview.notices.join(" ")).toMatch(/migration \(20261007002200\) has not been applied/);

    // …and once it is applied, everything above carries on, and a period can finally be finalized.
    await migrate(db);
    resetHeroArenaReadiness();
    expect(await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings }, "DAILY", "2026-10-07")).toMatchObject({ status: "FINALIZED", credited: 1 });
    expect((await balanceOf(db, 401)).claimable).toBe(tokens(100_000) * 3000n / 10_000n); // A is alone with wins: position 1 = 30%
  });
});

describe("what the database itself refuses once the migration is applied", () => {
  async function migrated(): Promise<{ db: Db; hero: string; owner: number }> {
    const db = await fresh();
    const heroes = await seedHeroOwners(db, [{ user: 501, name: "Hero A", claimed: true }, { user: 502, name: "Filler One" }, { user: 503, name: "Filler Two" }]);
    await giveWins(db, heroes.get(501)!, 2, new Date(utc(2026, 10, 7, 9)).toISOString(), { filler: [heroes.get(502)!, heroes.get(503)!] });
    await migrate(db);
    resetHeroArenaReadiness();
    await finalizeHeroPeriod(db, { now: () => new Date(utc(2026, 10, 8, 1)), settings }, "DAILY", "2026-10-07");
    return { db, hero: heroes.get(501)!, owner: 501 };
  }
  const rejects = async (p: Promise<unknown>): Promise<string> => (await p.then(() => "", (e: Error) => e.message)) || "ACCEPTED";

  it("a Hero Arena credit must reference its hero and a real result; an Arena Picks credit can carry no hero reference; no second credit per hero per period", async () => {
    const { db, hero, owner } = await migrated();
    const insert = (cols: string, vals: string, key: string) => db.query(`insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, ${cols}, idempotency_key) values (${owner}, ${vals}, ${key})`);
    expect(await rejects(insert("hero_period_kind", "'HERO_ARENA_DAILY_REWARD', 5, 5, 'DAILY'", "'k-no-hero-ref-0001'"))).toMatch(/sign_rules|check/i); // missing hero reference
    expect(await rejects(insert("hero_period_kind, hero_period_start, hero_character_id", `'HERO_ARENA_DAILY_REWARD', 5, 5, 'DAILY', '2026-10-07', '${hero}'`, "'k-second-credit-0002'"))).toMatch(/duplicate|unique/i); // A already has one for that day
    expect(await rejects(insert("hero_period_kind, hero_period_start, hero_character_id", `'HERO_ARENA_DAILY_REWARD', 5, 5, 'DAILY', '2026-10-01', '${hero}'`, "'k-no-result-row-0003'"))).toMatch(/foreign key|violates/i); // no such result
    expect(await rejects(insert("hero_period_kind, hero_period_start, hero_character_id", `'HERO_ARENA_WEEKLY_REWARD', 5, 5, 'DAILY', '2026-10-07', '${hero}'`, "'k-kind-mismatch-0004'"))).toMatch(/sign_rules|check/i); // a WEEKLY kind on a DAILY board
    expect(await rejects(insert("period_kind, period_start, hero_period_kind, hero_period_start, hero_character_id", `'DAILY_LEADERBOARD_BASE_REWARD', 5, 5, 'DAILY', '2026-10-07', 'DAILY', '2026-10-07', '${hero}'`, "'k-picks-with-hero-0005'"))).toMatch(/sign_rules|check|foreign key/i); // a Picks credit with a hero reference
    expect(await rejects(insert("hero_period_kind, hero_period_start, hero_character_id", `'HERO_ARENA_DAILY_REWARD', -5, -5, 'DAILY', '2026-10-07', '${hero}'`, "'k-negative-0006'"))).toMatch(/sign_rules|check/i);
    expect(await rejects(insert("hero_period_kind, hero_period_start, hero_character_id, period_kind, period_start", `'HERO_ARENA_DAILY_REWARD', 5, 5, 'DAILY', '2026-10-07', '${hero}', 'DAILY', '2026-10-07'`, "'k-borrowing-picks-0007'"))).toMatch(/sign_rules|check|foreign key/i); // cannot borrow the Picks reference columns
  });

  it("finalized boards are immutable; a result's numbers are frozen; its prize status only moves forward (RESERVED → CREDITED / HELD / FORFEITED, HELD → CREDITED / FORFEITED)", async () => {
    const { db, hero } = await migrated();
    expect(await rejects(db.query("update public.hero_arena_boards set prize_pool_micro = 1"))).toMatch(/append-only|cannot|immutable|forbid/i);
    expect(await rejects(db.query("delete from public.hero_arena_boards"))).toMatch(/append-only|cannot|immutable|forbid/i);
    expect(await rejects(db.query("update public.hero_arena_results set wins = wins + 1 where character_id = $1", [hero]))).toMatch(/frozen/i);
    expect(await rejects(db.query("update public.hero_arena_results set prize_micro = prize_micro + 1 where character_id = $1", [hero]))).toMatch(/frozen/i);
    expect(await rejects(db.query("delete from public.hero_arena_results"))).toMatch(/cannot be deleted/i);
    expect(await rejects(db.query("update public.hero_arena_results set prize_status = 'RESERVED' where character_id = $1", [hero]))).toMatch(/illegal hero arena prize transition/i); // CREDITED never goes back
    expect(await rejects(db.query("update public.hero_arena_results set prize_status = 'FORFEITED' where character_id = $1", [hero]))).toMatch(/illegal hero arena prize transition/i); // …and is never clawed back by an UPDATE
  });

  it("the tables' own CHECKs: the pool is exactly accounted, a prize needs an owner and a win, stats are coherent", async () => {
    const { db, hero } = await migrated();
    const board = (over: string) => db.query(`insert into public.hero_arena_boards (kind, period_start, season_id, pool_set, prize_pool_micro, prize_split_bps, minimum_wins, participants, eligible_participants, awarded_micro, returned_to_reserve_micro) select 'DAILY', '2026-10-20', id, true, ${over} from public.seasons where status = 'ACTIVE'`);
    expect(await rejects(board("100, '[3000]'::jsonb, 1, 3, 1, 60, 30"))).toMatch(/check/i); // 60 + 30 ≠ 100
    expect(await rejects(db.query("insert into public.hero_arena_boards (kind, period_start, season_id, pool_set, prize_pool_micro, prize_split_bps, minimum_wins, participants, eligible_participants) select 'WEEKLY', '2026-10-07', id, false, 5, '[]'::jsonb, 1, 1, 1 from public.seasons where status = 'ACTIVE'"))).toMatch(/check/i); // a Wednesday is not a week start / and no pool means no amount
    expect(await rejects(db.query("insert into public.hero_arena_results (kind, period_start, character_id, owner_user_id, hero_name, class_id, rank, matches, wins, top2, kos, prize_eligible, prize_micro, prize_status) values ('DAILY', '2026-10-07', $1, null, 'x', 'mage', 1, 1, 1, 1, 0, true, 5, 'CREDITED')", [hero]))).toMatch(/duplicate|check|violates/i);
    await expect(db.query("select * from public.audit_hero_arena()")).resolves.toEqual([]);
  });

  it("the auditor stays silent on a clean database — and names the problem when a credit loses its ledger entry or a board total stops matching its results", async () => {
    const { db, hero } = await migrated();
    expect(await db.query("select * from public.audit_hero_arena()")).toEqual([]);

    // A bug (or a hand edit) that removes the ledger entry of a CREDITED prize:
    await db.query("alter table public.arena_reward_ledger disable trigger arena_reward_ledger_append_only");
    await db.query("delete from public.arena_reward_ledger where hero_character_id = $1", [hero]);
    await db.query("alter table public.arena_reward_ledger enable trigger arena_reward_ledger_append_only");
    expect((await db.query<{ problem: string }>("select problem from public.audit_hero_arena()")).map((r) => r.problem)).toContain("CREDITED_WITHOUT_LEDGER");

    // …and a board whose recorded total no longer equals what its results hold:
    await db.query("alter table public.hero_arena_boards disable trigger hero_arena_boards_append_only");
    await db.query("update public.hero_arena_boards set awarded_micro = 0, returned_to_reserve_micro = prize_pool_micro");
    await db.query("alter table public.hero_arena_boards enable trigger hero_arena_boards_append_only");
    expect((await db.query<{ problem: string }>("select problem from public.audit_hero_arena()")).map((r) => r.problem)).toContain("BOARD_TOTAL_MISMATCH");
  });
});
