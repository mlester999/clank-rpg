import { afterAll, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";
import { loadSettings } from "@/server/config/settingsRepo";
import { migrate, readMigrations } from "@/server/db/migrate";
import { createPgliteDb } from "@/server/db/pglite";
import type { Db } from "@/server/db/types";
import { resetRewardsReadyCache } from "@/server/rewards/pool";
import { settleDueRewards } from "@/server/rewards/settlement";
import { seedReferenceData } from "@/server/seed/reference";

import { seedLegacyHeroes } from "../support/legacyHeroes";

/**
 * Migration 20261005001400 (the FINAL reward economy) is a FOLLOW-UP to 20261005001300, which is already applied to the live
 * database and must never be edited. So the realistic starting point is exactly what live has today: migrations through …001300,
 * the untouched v1 seed of the `arena_picks` setting, every reward table empty. It must evolve that forward, carry over anything a
 * database may hold from the weekly design, refuse to discard money records, and fail atomically.
 */
const BASE = "20261005001300";
const NEW = "20261005001400";
const opened: Db[] = [];
const open = async (): Promise<Db> => {
  const db = await createPgliteDb();
  opened.push(db);
  return db;
};
afterAll(async () => {
  for (const db of opened) await db.close();
});

const tableExists = async (db: Db, name: string) => (await db.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [`public.${name}`]))[0]!.ok;
const columnExists = async (db: Db, table: string, column: string) => (await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2", [table, column])).length > 0;
const NEW_TABLES = ["arena_leaderboards", "arena_leaderboard_results", "arena_holder_observations", "arena_pick_scores"];
const RETIRED_TABLES = ["arena_pick_outcomes", "arena_weeks", "arena_week_results", "arena_weekly_pick_scores"];

/** The `arena_picks` row exactly as live has it today (version 1, written by the seed; never edited by an admin). */
const LIVE_SEED_ROW = {
  enabled: true, holderTiers: [{ minimum: "0", rewardedWins: 1 }, { minimum: "100000", rewardedWins: 2 }, { minimum: "500000", rewardedWins: 5 }, { minimum: "1000000", rewardedWins: 10 }, { minimum: "5000000", rewardedWins: 15 }, { minimum: "10000000", rewardedWins: 30 }],
  minimumClaim: "10000", rewardPerBattle: "10000", weeklyPrizePool: "100000", dailyEmissionCap: null, minConfirmations: 2, holderMaxAgeHours: 6, weeklyPrizeSplitBps: [5000, 3000, 2000], holderCheckBatchSize: 25,
  holderRefreshMinutes: 30, pointsPerCorrectPick: 10, holderRefreshJitterPct: 20, weeklyScoredPicksPerDay: 20, walletChangeFreshMinutes: 15, weeklyMinimumScoredPicks: 20, holderTierActivationHours: 24, holderManualRefreshSeconds: 300,
};

/** A database in the state live is in today: …000100 through …001300 applied, reference data seeded, the OLD arena_picks setting row. */
async function liveToday(): Promise<Db> {
  const db = await open();
  const r = await migrate(db, undefined, { upTo: BASE });
  expect(r.pending).toContain(NEW);
  await seedReferenceData(db);
  await db.query("update public.game_settings set value = $1::jsonb, version = 1, updated_by = 'seed' where key = 'arena_picks'", [JSON.stringify(LIVE_SEED_ROW)]);
  return db;
}

describe("on an EMPTY scratch database", () => {
  it("the whole chain applies, creates the leaderboard tables with RLS on, retires the per-battle tables, and leaves no betting objects behind", async () => {
    const db = await open();
    const r = await migrate(db);
    expect(r.applied).toContain(NEW);
    for (const t of NEW_TABLES) expect(await tableExists(db, t), t).toBe(true);
    for (const t of RETIRED_TABLES) expect(await tableExists(db, t), t).toBe(false);
    expect((await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and rowsecurity = false")).map((t) => t.tablename)).toEqual([]);
    expect((await db.query<{ n: number }>("select count(*)::int as n from pg_tables where schemaname = 'public' and tablename like 'bet\\_%'"))[0]!.n).toBe(0);
    expect(await db.query("select * from public.audit_arena_reward_accounts()")).toEqual([]);
    expect((await migrate(db)).applied).toEqual([]); // re-running is a no-op
  });

  it("1300 was NOT edited to make this work: it still sits unchanged before the follow-up in the list, and no betting migration exists", async () => {
    const names = (await readMigrations()).map((m) => `${m.version}_${m.name}`);
    expect(names).toContain(`${BASE}_arena_picks_rewards`);
    expect(names.indexOf(`${NEW}_arena_picks_leaderboards`)).toBeGreaterThan(names.indexOf(`${BASE}_arena_picks_rewards`));
    expect(names.filter((n) => /bet|wager|escrow|shadow/i.test(n))).toEqual([]);
    // The per-battle schema is still described by 1300 (the file records what was applied); 1400 is what removes it.
    const base = (await readMigrations()).find((m) => m.version === BASE)!.sql;
    expect(base).toContain("create table public.arena_pick_outcomes");
  });

  it("the new constraints are DATABASE-enforced: the ledger has no per-battle kind, and a bonus must equal floor(base × bps / 10000) on an earned prize", async () => {
    const db = await open();
    await migrate(db);
    await seedReferenceData(db);
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values (1, 'a', 150)");
    await expect(db.query("insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, idempotency_key) values (1, 'ARENA_PICK_REWARD', 1, 1, 'k-per-battle')")).rejects.toThrow();
    // A leaderboard credit must name its period and match its kind.
    await expect(db.query("insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, idempotency_key) values (1, 'DAILY_LEADERBOARD_BASE_REWARD', 1, 1, 'k-no-period')")).rejects.toThrow();
    await expect(db.query("insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, period_kind, period_start, idempotency_key) values (1, 'DAILY_LEADERBOARD_BASE_REWARD', 1, 1, 'WEEKLY', '2026-10-05', 'k-wrong-period')")).rejects.toThrow();
    // Result-row arithmetic.
    await db.query("insert into public.arena_leaderboards (kind, period_start, prize_pool_micro, prize_split_bps, minimum_picks, points_per_correct_pick, bonus_reconcile_until, participants, eligible_participants, base_awarded_micro, returned_to_reserve_micro) values ('DAILY', '2026-10-06', 100, '[10000]', 20, 10, now(), 1, 1, 100, 0)");
    const row = (bonus: string, bps: number) =>
      db.query(
        `insert into public.arena_leaderboard_results (kind, period_start, telegram_user_id, hero_name, class_id, rank, points, picks, correct_picks, accuracy_bps, prize_eligible, prize_rank, base_prize_micro, base_status, bonus_status, bonus_tier_index, bonus_label, bonus_bps, bonus_micro)
         values ('DAILY', '2026-10-06', 1, 'h', 'warrior', 1, 100, 10, 10, 10000, true, 1, 100, 'CREDITED', 'CREDITED', 5, '10M', ${bps}, ${bonus}) on conflict do nothing`,
      );
    await expect(row("26", 2500)).rejects.toThrow(); // 25% of 100 is 25, not 26
    await expect(row("25", 2500)).resolves.toBeDefined();
  });

  it("the database also refuses a daily board dated in a way a weekly board cannot be: a WEEKLY period must start on a Monday", async () => {
    const db = await open();
    await migrate(db);
    const insert = (start: string) => db.query("insert into public.arena_leaderboards (kind, period_start, prize_pool_micro, prize_split_bps, minimum_picks, points_per_correct_pick, bonus_reconcile_until, participants, eligible_participants) values ('WEEKLY', $1, 0, '[]', 100, 10, now(), 0, 0)", [start]);
    await expect(insert("2026-10-07")).rejects.toThrow();
    await expect(insert("2026-10-05")).resolves.toBeDefined();
  });
});

describe("on a database in the state LIVE is in today (…001300 applied, old settings row, empty reward tables)", () => {
  it("applies on top, rewrites the untouched v1 settings row to the FINAL economy (audited), and the app reads it", async () => {
    const db = await liveToday();
    const applied = await migrate(db, undefined, { upTo: NEW });
    expect(applied.applied).toEqual([NEW]);
    const [row] = await db.query<{ value: Record<string, unknown>; version: number; updated_by: string }>("select value, version, updated_by from public.game_settings where key = 'arena_picks'");
    expect(row).toMatchObject({ version: 2, updated_by: `migration:${NEW}` });
    for (const gone of ["rewardPerBattle", "dailyEmissionCap", "holderTiers", "holderTierActivationHours", "weeklyScoredPicksPerDay", "weeklyPrizeSplitBps", "scoredPicksPerDay", "dailyMinimumScoredPicks", "weeklyMinimumScoredPicks"]) expect(row!.value).not.toHaveProperty(gone);
    expect(row!.value).toMatchObject({ dailyPrizePool: "100000", weeklyPrizePool: "500000", dailyMinimumPicks: 20, weeklyMinimumPicks: 100, holderWeeklyQualifyHours: 168, holderDailyQualifyHours: 24 });
    // The SQL rewrite and the application's own reader agree: strict validation accepts the stored row as-is.
    expect(parseSettings("arena_picks", row!.value)).toEqual(DEFAULT_SETTINGS.arena_picks);
    expect((await loadSettings(db)).arena_picks).toEqual(DEFAULT_SETTINGS.arena_picks);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]); // re-running touches nothing (version stays 2)
    expect((await db.query<{ version: number }>("select version from public.game_settings where key = 'arena_picks'"))[0]!.version).toBe(2);
  });

  it("knobs an admin tuned survive (claim minimum, batch size, confirmations); the retired economy numbers — pools, ladder, minimums and every per-day scoring limit — do not", async () => {
    const db = await liveToday();
    await db.query("update public.game_settings set value = $1::jsonb, version = 3, updated_by = 'admin' where key = 'arena_picks'", [JSON.stringify({ ...LIVE_SEED_ROW, minimumClaim: "25000", holderCheckBatchSize: 40, minConfirmations: 3, weeklyScoredPicksPerDay: 30, scoredPicksPerDay: 30, weeklyPrizePool: "250000" })]);
    await migrate(db, undefined, { upTo: NEW });
    const [row] = await db.query<{ value: Record<string, unknown>; version: number }>("select value, version from public.game_settings where key = 'arena_picks'");
    expect(row).toMatchObject({ version: 4, value: { minimumClaim: "25000", holderCheckBatchSize: 40, minConfirmations: 3, weeklyPrizePool: "500000", dailyPrizePool: "100000", dailyMinimumPicks: 20, weeklyMinimumPicks: 100 } });
    expect(row!.value).not.toHaveProperty("scoredPicksPerDay"); // an old per-day limit is dropped, never carried over
    expect(parseSettings("arena_picks", row!.value)).not.toHaveProperty("scoredPicksPerDay");
  });

  it("a row ALREADY in the new shape is left exactly alone", async () => {
    const db = await liveToday();
    await db.query("update public.game_settings set value = $1::jsonb, version = 5, updated_by = 'admin' where key = 'arena_picks'", [JSON.stringify({ ...DEFAULT_SETTINGS.arena_picks, dailyPrizePool: "123456" })]);
    await migrate(db, undefined, { upTo: NEW });
    expect((await db.query<{ value: { dailyPrizePool: string }; version: number }>("select value, version from public.game_settings where key = 'arena_picks'"))[0]).toMatchObject({ version: 5, value: { dailyPrizePool: "123456" } });
  });

  it("the new code reads the OLD row correctly even BEFORE the migration (the dev server hot-reloads against live): it is upgraded in memory, nothing is written", async () => {
    const db = await liveToday();
    resetRewardsReadyCache();
    const settings = await loadSettings(db);
    expect(settings.arena_picks).toMatchObject({ dailyPrizePool: "100000", weeklyPrizePool: "500000", dailyMinimumPicks: 20, weeklyMinimumPicks: 100 });
    expect(settings.arena_picks).not.toHaveProperty("scoredPicksPerDay");
    expect((await db.query<{ version: number }>("select version from public.game_settings where key = 'arena_picks'"))[0]!.version).toBe(1);
    // …and the sweep is a quiet no-op until the migration exists: no errors, nothing touched.
    expect(await settleDueRewards(db, { now: () => new Date(), settings }, () => { throw new Error("must stay quiet"); })).toEqual({ settled: 0, failed: 0 });
  });

  it("keeps live's arena data and historical picks untouched and never turns them into rewards", async () => {
    const db = await liveToday();
    // Historical free picks written by the code that ran BEFORE the reward system, on a battle that was fought and settled (plain SQL: no arena code involved).
    const [season] = await db.query<{ id: string }>("select id from public.seasons limit 1");
    const [cycle] = await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, seed, hero_count) values (1, $1, 's', 0) returning id", [season!.id]);
    await db.query("insert into public.ruleset_snapshots (hash, rules_version, ruleset) values (repeat('a', 64), '2.0.0', '{}'::jsonb)");
    const [battle] = await db.query<{ id: string }>("insert into public.arena_battles (season_id, cycle_id, status, seed, snapshot, ruleset_hash, starts_at) values ($1, $2, 'SIMULATED', 's', '{}'::jsonb, repeat('a', 64), now()) returning id", [season!.id, cycle!.id]);
    await seedLegacyHeroes(db, 4, { startId: 1000 });
    const heroes = await db.query<{ id: string; telegram_user_id: number }>("select id, telegram_user_id from public.characters order by telegram_user_id limit 4");
    for (const [slot, h] of heroes.entries()) await db.query("insert into public.arena_participants (battle_id, character_id, slot) values ($1, $2, $3)", [battle!.id, h.id, slot]);
    for (const h of heroes) await db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, now())", [battle!.id, h.telegram_user_id, heroes[0]!.id]);
    await db.query("update public.arena_picks set result = 'CORRECT', settled_at = now(), reward_gold = 2 where telegram_user_id = $1", [heroes[0]!.telegram_user_id]);
    await db.query("update public.arena_picks set result = 'INCORRECT', settled_at = now() where telegram_user_id <> $1", [heroes[0]!.telegram_user_id]);
    const picksBefore = await db.query<Record<string, unknown>>("select battle_id, telegram_user_id, character_id, result, reward_gold, settled_at from public.arena_picks order by telegram_user_id");
    const battlesBefore = await db.query<Record<string, unknown>>("select id, status, starts_at from public.arena_battles order by sequence");
    expect(picksBefore).toHaveLength(4);

    // The code is deployed BEFORE the migration: the sweep is a quiet no-op.
    resetRewardsReadyCache();
    expect(await settleDueRewards(db, { now: () => new Date(), settings: DEFAULT_SETTINGS }, () => { throw new Error("must stay quiet"); })).toEqual({ settled: 0, failed: 0 });
    // The whole pending chain, as a real deploy applies it.
    expect((await migrate(db)).applied).toContain(NEW);
    expect(await db.query<Record<string, unknown>>("select battle_id, telegram_user_id, character_id, result, reward_gold, settled_at from public.arena_picks order by telegram_user_id")).toEqual(picksBefore);
    expect(await db.query<Record<string, unknown>>("select id, status, starts_at from public.arena_battles order by sequence")).toEqual(battlesBefore);
    resetRewardsReadyCache();
    expect(await db.query("select 1 from public.arena_picks where reward_eligible")).toHaveLength(0); // historical picks are never eligible…
    expect(await settleDueRewards(db, { now: () => new Date(), settings: DEFAULT_SETTINGS })).toEqual({ settled: 0, failed: 0 }); // …so nothing is scored for them
    expect(await db.query("select 1 from public.arena_reward_ledger")).toHaveLength(0);
    expect(await db.query("select 1 from public.arena_pick_scores")).toHaveLength(0);
  });

  it("the retired holder-allowance machinery is gone (lock snapshot trigger, tier columns) but the pick guard still works", async () => {
    const db = await liveToday();
    await migrate(db, undefined, { upTo: NEW });
    expect(await db.query("select 1 from pg_trigger where tgname = 'arena_picks_lock_snapshot'")).toHaveLength(0);
    expect((await db.query("select 1 from pg_proc where proname = 'snapshot_pick_tier'"))).toHaveLength(0);
    for (const c of ["active_tier_index", "active_allowance", "candidate_tier_index", "candidate_since", "effective_until"]) expect(await columnExists(db, "arena_holder_status", c), c).toBe(false);
    expect(await columnExists(db, "arena_picks", "tier_snapshot")).toBe(true); // kept (inert): the pick guard still names it
    expect(await db.query("select 1 from pg_trigger where tgname = 'arena_picks_guard'")).not.toHaveLength(0);
  });

  it("tolerates the leftover rows the retired betting code seeded on live (a `betting` settings row and betting.* flags)", async () => {
    const db = await liveToday();
    await db.exec(`
      insert into public.game_settings (key, value) values ('betting', '{"platformFeeBps":500,"surprise":true}'::jsonb) on conflict do nothing;
      insert into public.feature_flags (key, enabled, description) values ('betting.test_mode', true, 'old'), ('betting.real_money_enabled', false, 'old'), ('betting.enabled', false, 'old') on conflict do nothing;
    `);
    await migrate(db, undefined, { upTo: NEW });
    const settings = await loadSettings(db); // must not throw on the unknown stored key
    expect(settings).not.toHaveProperty("betting");
    expect(settings.arena_picks).toEqual(DEFAULT_SETTINGS.arena_picks);
  });
});

describe("LOGICAL accounting in the schema: no token, no contract and no decimals inside a finished board", () => {
  it("the boards carry LOGICAL micro-token columns only: no token_decimals, no per-battle columns, no per-day scoring cap anywhere", async () => {
    const db = await open();
    await migrate(db);
    for (const c of ["prize_pool_micro", "base_awarded_micro", "returned_to_reserve_micro"]) expect(await columnExists(db, "arena_leaderboards", c), c).toBe(true);
    for (const c of ["token_decimals", "prize_pool_raw", "base_awarded_raw", "returned_to_reserve_raw"]) expect(await columnExists(db, "arena_leaderboards", c), c).toBe(false);
    for (const c of ["base_prize_micro", "bonus_micro"]) expect(await columnExists(db, "arena_leaderboard_results", c), c).toBe(true);
    for (const c of ["base_prize_raw", "bonus_raw"]) expect(await columnExists(db, "arena_leaderboard_results", c), c).toBe(false);
    for (const c of ["scored", "scored_index", "daily_limit"]) expect(await columnExists(db, "arena_pick_scores", c), c).toBe(false); // every valid pick counts
    expect(await columnExists(db, "arena_pick_settlements", "token_decimals")).toBe(false);
  });

  it("a claim's raw on-chain amount must be EXACTLY its logical amount converted at the contract's decimals — a database CHECK, not a convention", async () => {
    const db = await open();
    await migrate(db);
    for (let n = 1; n <= 7; n++) await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values ($1, 'a', 150)", [n]); // one pending claim per member
    const claim = (n: number, micro: string, raw: string, decimals: number) =>
      db.query(
        "insert into public.arena_reward_claims (telegram_user_id, amount_micro, amount_raw, destination_address, destination_kind, token_address, chain_id, token_decimals, idempotency_key) values ($5, $1::numeric, $2::numeric, '0x52908400098527886e0f7030069857d2e4169ee7', 'CUSTOM', '0x000000000000000000000000000000000c1a4c1a', 4663, $3, $4)",
        [micro, raw, decimals, `key-claim-${n}`, n],
      );
    await expect(claim(1, "30000000000", "30000000000000000000000", 18)).resolves.toBeDefined(); // 30,000 tokens at 18 decimals
    await expect(claim(2, "30000000000", "30000000000", 6)).resolves.toBeDefined(); // …at 6
    await expect(claim(3, "30000000000", "30000000000000", 9)).resolves.toBeDefined(); // …at 9
    await expect(claim(4, "30000000000", "3000000", 2)).resolves.toBeDefined(); // …at 2 (the amount is a whole number of 0.01)
    await expect(claim(5, "30000000000", "30000000000000000000001", 18)).rejects.toThrow(/arena_reward_claims_conversion/); // one unit off
    await expect(claim(6, "30000000000", "30000000000", 18)).rejects.toThrow(/arena_reward_claims_conversion/); // a logical amount posing as raw
    await expect(claim(7, "30000000001", "3000000", 2)).rejects.toThrow(/arena_reward_claims_conversion/); // dust cannot be expressed at 2 decimals: it never becomes a payout
  });

  it("the token's metadata is a ONE-ROW cache of what the contract reported (RLS on); nothing in it is a setting", async () => {
    const db = await open();
    await migrate(db);
    expect(await tableExists(db, "arena_reward_token")).toBe(true);
    const ins = (id: number, decimals: number) =>
      db.query("insert into public.arena_reward_token (id, token_address, chain_id, symbol, decimals) values ($1, '0x000000000000000000000000000000000c1a4c1a', 4663, 'CLANKRPG', $2)", [id, decimals]);
    await expect(ins(1, 18)).resolves.toBeDefined();
    await expect(ins(2, 18)).rejects.toThrow(); // a singleton
    await expect(ins(1, 18)).rejects.toThrow(); // duplicate key
    const nothing = await db.query("select 1 from public.game_settings where value::text ilike '%decimals%'");
    expect(nothing).toEqual([]);
    expect((await db.query<{ rowsecurity: boolean }>("select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'arena_reward_token'"))[0]!.rowsecurity).toBe(true);
  });
});

describe("it REFUSES to discard money records, and a failure half-way leaves NOTHING behind", () => {
  it("reward amounts recorded under 1300 are in token base units at an assumed scale: the migration aborts whole rather than guess what they are worth in logical amounts", async () => {
    const db = await liveToday();
    await db.exec(`
      insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values (7, 'w', 150);
      insert into public.arena_weeks (week_start, token_decimals, prize_pool_raw, prize_split_bps, scored_picks_per_day, minimum_scored_picks, points_per_correct_pick, participants, eligible_participants, prizes_awarded_raw, returned_to_reserve_raw)
        values ('2026-09-28', 18, 100000000000000000000000, '[5000,3000,2000]'::jsonb, 20, 20, 10, 1, 1, 50000000000000000000000, 50000000000000000000000);
      insert into public.arena_week_results (week_start, telegram_user_id, hero_name, class_id, rank, weekly_points, scored_picks, correct_picks, accuracy_bps, prize_eligible, prize_rank, prize_raw, prize_status)
        values ('2026-09-28', 7, 'Seven', 'warrior', 1, 300, 30, 30, 10000, true, 1, 50000000000000000000000, 'CREDITED');
      insert into public.arena_reward_ledger (telegram_user_id, kind, claimable_delta, earned_delta, week_start, idempotency_key)
        values (7, 'WEEKLY_LEADERBOARD_REWARD', 50000000000000000000000, 50000000000000000000000, '2026-09-28', 'weekly-prize:2026-09-28:7');
    `);
    const before = await db.query("select telegram_user_id, claimable::text, earned_total::text from public.arena_reward_accounts order by 1");
    await expect(migrate(db, undefined, { upTo: NEW })).rejects.toThrow(/refusing to reinterpret reward amounts/);
    expect(await db.query("select telegram_user_id, claimable::text, earned_total::text from public.arena_reward_accounts order by 1")).toEqual(before); // untouched
    expect(await tableExists(db, "arena_weeks")).toBe(true);
    expect(await tableExists(db, "arena_leaderboards")).toBe(false);
    expect(await db.query("select 1 from supabase_migrations.schema_migrations where version = $1", [NEW])).toHaveLength(0);
    expect((await db.query<{ version: number }>("select version from public.game_settings where key = 'arena_picks'"))[0]!.version).toBe(1);
  });

  it("if any per-battle $CLANKRPG was ever credited, the migration aborts whole with an explanation — nothing is changed, nothing is recorded", async () => {
    const db = await liveToday();
    const [season] = await db.query<{ id: string }>("select id from public.seasons limit 1");
    const [cycle] = await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, status, seed, hero_count, completed_at) values (1, $1, 'COMPLETED', 's', 0, now()) returning id", [season!.id]);
    const [battle] = await db.query<{ id: string }>("insert into public.arena_battles (season_id, cycle_id, status, starts_at) values ($1, $2, 'VOID', now()) returning id", [season!.id, cycle!.id]);
    await db.query(
      `insert into public.arena_pick_settlements (battle_id, status, token_decimals, reward_pool_raw, picks_total, correct_picks, correct_pickers, rewarded_pickers, share_raw, distributed_raw, returned_to_reserve_raw, points_awarded, config)
       values ($1, 'REWARDED', 18, 10000, 1, 1, 1, 1, 10000, 10000, 0, 10, '{}'::jsonb)`,
      [battle!.id],
    );
    await expect(migrate(db, undefined, { upTo: NEW })).rejects.toThrow(/refusing to retire the per-battle token reward schema/);
    expect(await tableExists(db, "arena_pick_outcomes")).toBe(true); // untouched
    expect(await tableExists(db, "arena_leaderboards")).toBe(false);
    expect(await db.query("select 1 from supabase_migrations.schema_migrations where version = $1", [NEW])).toHaveLength(0);
    expect((await db.query<{ version: number }>("select version from public.game_settings where key = 'arena_picks'"))[0]!.version).toBe(1); // the settings rewrite rolled back too
  });

  /** The 1300-shape rows a database that ran under the 20-per-day cap could hold: one settled battle and its score rows. */
  async function legacyScoreRows(db: Db, rows: Array<{ user: number; scored: boolean; correct: boolean }>): Promise<void> {
    const [season] = await db.query<{ id: string }>("select id from public.seasons limit 1");
    const [cycle] = await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, status, seed, hero_count, completed_at) values (1, $1, 'COMPLETED', 's', 0, now()) returning id", [season!.id]);
    for (const r of rows) {
      await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values ($1, 'u', 150) on conflict do nothing", [r.user]);
      const [battle] = await db.query<{ id: string }>("insert into public.arena_battles (season_id, cycle_id, status, starts_at) values ($1, $2, 'VOID', now()) returning id", [season!.id, cycle!.id]);
      const [settlement] = await db.query<{ id: string }>("insert into public.arena_pick_settlements (battle_id, status, token_decimals, picks_total, config) values ($1, 'PAUSED', 18, 1, '{}'::jsonb) returning id", [battle!.id]);
      await db.query(
        "insert into public.arena_weekly_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, scored, daily_limit, weekly_points) values ($1, $2, $3, '2026-09-28', '2026-10-04', $4, $5, 20, $6)",
        [r.user, battle!.id, settlement!.id, r.correct, r.scored, r.scored && r.correct ? 10 : 0],
      );
    }
  }

  it("a database that ever recorded a pick the old cap left UNSCORED makes the migration abort whole with an explanation (it will not guess what that pick should be worth)", async () => {
    const db = await liveToday();
    await legacyScoreRows(db, [{ user: 11, scored: true, correct: true }, { user: 11, scored: false, correct: true }]);
    await expect(migrate(db, undefined, { upTo: NEW })).rejects.toThrow(/refusing to remove the per-day scoring cap/);
    expect(await tableExists(db, "arena_weekly_pick_scores")).toBe(true); // untouched
    expect(await tableExists(db, "arena_leaderboards")).toBe(false);
    expect(await db.query("select 1 from supabase_migrations.schema_migrations where version = $1", [NEW])).toHaveLength(0);
  });

  it("legacy rows that WERE scored (nothing was capped) carry over unchanged into the uncapped table: same pick, same points, the counting columns gone", async () => {
    const db = await liveToday();
    await legacyScoreRows(db, [{ user: 21, scored: true, correct: true }, { user: 22, scored: true, correct: false }]);
    await migrate(db, undefined, { upTo: NEW });
    expect(await db.query<Record<string, unknown>>("select telegram_user_id::int as u, correct, points, utc_date::text from public.arena_pick_scores order by telegram_user_id")).toEqual([
      { u: 21, correct: true, points: 10, utc_date: "2026-10-04" },
      { u: 22, correct: false, points: 0, utc_date: "2026-10-04" },
    ]);
    const cols = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'arena_pick_scores'")).map((c) => c.column_name);
    for (const gone of ["scored", "scored_index", "daily_limit", "weekly_points"]) expect(cols).not.toContain(gone);
    expect(cols).toEqual(expect.arrayContaining(["points", "correct", "utc_date", "week_start"]));
  });

  it("an error after some of the new objects were created rolls all of them back, and the version is not recorded", async () => {
    const db = await liveToday();
    const sql = (await readMigrations()).find((m) => m.version === NEW)!.sql;
    await expect(
      db.transaction(async (tx) => {
        await tx.exec(sql);
        expect(await tableExists(tx as unknown as Db, "arena_leaderboards")).toBe(true); // it WAS created inside the transaction…
        await tx.exec("select 1 / 0"); // …and then something goes wrong
      }),
    ).rejects.toThrow();
    for (const t of NEW_TABLES) expect(await tableExists(db, t), t).toBe(false);
    for (const t of ["arena_pick_outcomes", "arena_weeks", "arena_week_results", "arena_weekly_pick_scores"]) expect(await tableExists(db, t), t).toBe(true); // all still there
    expect((await db.query<{ version: number }>("select version from public.game_settings where key = 'arena_picks'"))[0]!.version).toBe(1);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([NEW]); // a clean retry succeeds
  });

  it("the migration runner itself applies it atomically: a deliberately broken copy fails as a whole", async () => {
    const db = await liveToday();
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
    const all = await readMigrations();
    for (const m of all.filter((x) => x.version < NEW)) await writeFile(path.join(dir, `${m.version}_${m.name}.sql`), m.sql);
    const good = all.find((m) => m.version === NEW)!;
    await writeFile(path.join(dir, `${good.version}_${good.name}.sql`), `${good.sql}\nselect no_such_function();`);
    await expect(migrate(db, dir)).rejects.toThrow();
    for (const t of NEW_TABLES) expect(await tableExists(db, t), t).toBe(false);
    expect(await db.query("select 1 from supabase_migrations.schema_migrations where version = $1", [NEW])).toHaveLength(0);
  });
});
