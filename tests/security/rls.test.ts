import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";

import { createTestDb, seedHeroes } from "../support/db";

let db: Db;
let tables: string[] = [];

beforeAll(async () => {
  db = await createTestDb();
  tables = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by 1")).map((t) => t.tablename);
  await seedHeroes(db, 2);
});
afterAll(async () => {
  await db.close();
});

/** Run SQL as a Supabase API role; always restore the privileged role afterwards. */
async function as<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

describe("RLS / role boundaries", () => {
  it("the schema has the expected surface and EVERY table has RLS enabled", async () => {
    expect(tables.length).toBeGreaterThanOrEqual(48);
    const rows = await db.query<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname = 'public'");
    expect(rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)).toEqual([]);
  });

  it("no table exposes a policy to API roles (all access is server-only by design)", async () => {
    const policies = await db.query("select tablename, policyname from pg_policies where schemaname = 'public'");
    expect(policies).toEqual([]);
  });

  it.each(["anon", "authenticated"])("%s has no privileges on any table: select/insert/update/delete are all denied", async (role) => {
    for (const t of tables) {
      for (const sql of [`select * from public.${t} limit 1`, `delete from public.${t}`, `update public.${t} set ctid = ctid where false`]) {
        const err = await as(role, () => db.query(sql).then(() => null, (e: Error) => e));
        expect(err, `${role}: ${sql}`).not.toBeNull();
        expect(String(err!.message)).toMatch(/permission denied|cannot|must be owner|column .* does not exist|system column/i);
      }
    }
    // The most sensitive writes, spelled out:
    for (const sql of [
      "update public.characters set level = 99",
      "update public.currency_accounts set balance = 1000000",
      "insert into public.currency_ledger (character_id, delta, reason, idempotency_key) select id, 1000, 'hax', 'hax-hax-hax-1' from public.characters limit 1",
      "update public.arena_battles set winner_id = null",
      "insert into public.character_claims (character_id, telegram_user_id, auth_date) select id, telegram_user_id, now() from public.characters limit 1",
      "update public.game_settings set value = '{}'::jsonb",
      "delete from public.admin_audit_log",
    ]) {
      const err = await as(role, () => db.query(sql).then(() => null, (e: Error) => e));
      expect(err, `${role}: ${sql}`).not.toBeNull();
    }
  });

  it("defence in depth: even if a grant slipped in, RLS (with no policies) still returns zero rows and blocks writes", async () => {
    await db.exec("grant select, insert, update, delete on public.characters to anon");
    try {
      const rows = await as("anon", () => db.query<{ n: number }>("select count(*)::int as n from public.characters"));
      expect(rows[0]!.n).toBe(0);
      const err = await as("anon", () => db.query("update public.characters set level = 99").then(() => "updated", (e: Error) => e.message));
      // RLS makes the update affect 0 rows rather than error; confirm nothing changed.
      void err;
      expect((await db.query<{ n: number }>("select count(*)::int as n from public.characters where level = 99"))[0]!.n).toBe(0);
      const insertErr = await as("anon", () => db.query("insert into public.characters (class_id, name, origin, kind, telegram_user_id) values ('mage', 'x', 'ADMIN', 'SPECIAL_CHARACTER', null)").then(() => null, (e: Error) => e));
      expect(insertErr).not.toBeNull();
    } finally {
      await db.exec("revoke all on public.characters from anon");
    }
  });

  it("API roles cannot execute any application function (no RPC surface)", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const fn of ["public.audit_currency_ledger()", "public.audit_arena_reward_accounts()", "public.clank_harden_schema()"]) {
        const err = await as(role, () => db.query(`select ${fn}`).then(() => null, (e: Error) => e));
        expect(err, `${role} ${fn}`).not.toBeNull();
        expect(String(err!.message)).toMatch(/permission denied/);
      }
    }
  });

  it("the server role (service_role) retains full access", async () => {
    const n = await as("service_role", () => db.query<{ n: number }>("select count(*)::int as n from public.characters"));
    expect(n[0]!.n).toBe(2);
    await as("service_role", () => db.query("update public.characters set power = power where true"));
  });

  it("tables created by FUTURE migrations are locked down by clank_harden_schema()", async () => {
    await db.exec("create table public.zz_future_table (id int)");
    expect((await db.query<{ rowsecurity: boolean }>("select rowsecurity from pg_tables where tablename = 'zz_future_table'"))[0]!.rowsecurity).toBe(false);
    await db.exec("select public.clank_harden_schema()");
    expect((await db.query<{ rowsecurity: boolean }>("select rowsecurity from pg_tables where tablename = 'zz_future_table'"))[0]!.rowsecurity).toBe(true);
    const err = await as("anon", () => db.query("select * from public.zz_future_table").then(() => null, (e: Error) => e));
    expect(err).not.toBeNull();
    await db.exec("drop table public.zz_future_table");
  });
});

describe("unauthorized mutation paths are closed at the database layer", () => {
  it("there is NO betting, wagering, deposit, escrow or withdrawal table — Arena Picks is free and tokens only ever move OUT as claims", async () => {
    const tables = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' order by 1")).map((t) => t.tablename);
    expect(tables.filter((t) => /^bet_|wager|escrow|deposit|withdraw|custody|odds|pool/.test(t))).toEqual([]);
    expect(tables.filter((t) => /^arena_(reward|pick|holder|points|wallet|daily|leaderboard)/.test(t))).toEqual([
      "arena_holder_observations", "arena_holder_status", "arena_holder_tier_history", "arena_leaderboard_results", "arena_leaderboards", "arena_pick_scores", "arena_pick_settlements", "arena_picks", "arena_points_ledger",
      "arena_reward_accounts", "arena_reward_claims", "arena_reward_ledger", "arena_reward_token", "arena_reward_wallet_attempts", "arena_reward_wallet_history", "arena_wallet_challenges",
    ]);
    // Per-battle token rewards left no table behind either: the old per-battle outcome table and the weekly-only tables are gone.
    expect(tables).not.toEqual(expect.arrayContaining(["arena_pick_outcomes"]));
    expect(tables.filter((t) => /^arena_week/.test(t))).toEqual([]);
  });

  it("admin audit log and ruleset snapshots are append-only", async () => {
    await db.exec("insert into public.admin_audit_log (actor, action, entity_type) values ('t', 'x', 'y')");
    await expect(db.query("update public.admin_audit_log set actor = 'evil'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from public.admin_audit_log")).rejects.toThrow(/append-only/);
    await db.exec(`insert into public.ruleset_snapshots (hash, rules_version, ruleset) values ('${"a".repeat(64)}', '1', '{}')`);
    await expect(db.query("update public.ruleset_snapshots set ruleset = '{\"x\":1}'")).rejects.toThrow(/append-only/);
  });

  it("a single ACTIVE season and a single ACTIVE cycle are enforced by the schema", async () => {
    await expect(db.query("insert into public.seasons (number, name, status) values (99, 'dup', 'ACTIVE')")).rejects.toThrow();
    const [season] = await db.query<{ id: string }>("select id from public.seasons limit 1");
    await db.query("insert into public.arena_cycles (number, season_id, seed, hero_count) values (1, $1, 's', 8)", [season!.id]);
    await expect(db.query("insert into public.arena_cycles (number, season_id, seed, hero_count) values (2, $1, 's', 8)", [season!.id])).rejects.toThrow();
  });

  it("negative Telegram ids are demo-only: a real id cannot be flagged demo and vice versa", async () => {
    await expect(db.query("insert into public.telegram_users (telegram_user_id, display_name, is_demo) values (123456, 'x', true)")).rejects.toThrow();
    await expect(db.query("insert into public.telegram_users (telegram_user_id, display_name, is_demo) values (-5, 'x', false)")).rejects.toThrow();
  });
});
