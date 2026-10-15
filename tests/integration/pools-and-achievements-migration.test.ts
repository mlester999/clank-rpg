import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_ACHIEVEMENTS } from "@/domain/content/achievements";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate, MIGRATIONS_DIR, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";
import { auditLedger, applyLedger, getBalance } from "@/server/services/economy";

import { SUPABASE_ROLE_SHIM, insertStubHero } from "../support/db";

/**
 * MIGRATIONS 2800 and 2900 — DATA ONLY, on a database that was seeded earlier (the live shape):
 *
 *   2800  the Arena Picks pools move 100,000 → 500,000 (Daily) and 500,000 → 1,000,000 (Weekly) — each only while it still holds the previous shipped default.
 *   2900  every shipped achievement moves to its new reward (a title + Gold), a retuned reward is left alone, and members who already unlocked something get the
 *         Gold it now pays — once, with the application's own idempotency key.
 */
const PREVIOUS = "20261015002700";
const POOLS = "20261015002800";
const ACHIEVEMENTS = "20261015002900";
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await db.exec(SUPABASE_ROLE_SHIM);
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
});
afterEach(async () => {
  await db.close();
});

/** What an OLD seed wrote: the PREVIOUS shipped reward of every achievement (what a database seeded before this version still holds). */
const OLD_REWARDS: Record<string, Record<string, unknown>> = {
  arena_debut: { badge: "debut" },
  arena_regular: { badge: "regular", gold: 25 },
  arena_veteran: { badge: "veteran", title: "Veteran", gold: 100 },
  first_blood: { badge: "first_blood" },
  reaper: { badge: "reaper", title: "Reaper" },
  victor: { badge: "victor", gold: 10 },
  champion: { badge: "champion", title: "Champion", gold: 50 },
  legend_of_the_pit: { badge: "legend", title: "Legend of the Pit", gold: 250 },
  podium_regular: { badge: "podium" },
  voice_of_clank: { badge: "voice500" },
  pillar_of_clank: { badge: "voice2000", title: "Pillar" },
  steady_presence: { badge: "days60" },
  og_clanker: { badge: "og", title: "OG Clanker" },
  diamond_1d: { badge: "diamond1" },
  diamond_7d: { badge: "diamond7" },
  diamond_30d: { badge: "diamond30", title: "Diamond Hands" },
  diamond_90d: { badge: "diamond90", title: "Unbreakable Grip" },
  bonded_collector: { badge: "collector" },
  boss_slayer: { badge: "boss_slayer", title: "Boss Slayer" },
  seasonal_champion: { badge: "season_champion", title: "Seasonal Champion" },
};
const oldSeed = async (db: Db) => {
  for (const [id, reward] of Object.entries(OLD_REWARDS)) await db.query("update public.achievements set reward = $2::jsonb where id = $1", [id, JSON.stringify(reward)]);
};

const setting = async (key: string) => (await db.query<{ value: Record<string, unknown>; version: number }>("select value, version from public.game_settings where key = $1", [key]))[0]!;
const code = async (file: string) => (await readFile(path.join(MIGRATIONS_DIR, file), "utf8")).split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();

describe("migration 2800 — prize pools", () => {
  it("follows 2700, is settings only, and ends by hardening the schema", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(POOLS)).toBe(all.indexOf(PREVIOUS) + 1);
    const sql = await code(`${POOLS}_prize_pools_500k_1m.sql`);
    for (const forbidden of [/\bcreate\s+table\b/, /\balter\s+table\b/, /\bdrop\b/, /\bdelete\s+from\b/, /\btruncate\b/, /\binsert\s+into\b/]) expect(sql).not.toMatch(forbidden);
    expect(sql).toMatch(/update\s+public\.game_settings/);
    expect(sql.trimEnd().endsWith("select public.clank_harden_schema();")).toBe(true);
  });

  it("a database still on the previous defaults moves to 500,000 / 1,000,000 and nothing else in the row changes", async () => {
    await db.query(`update public.game_settings set value = value || '{"dailyPrizePool":"100000","weeklyPrizePool":"500000"}'::jsonb where key = 'arena_picks'`);
    const before = await setting("arena_picks");
    await migrate(db, undefined, { upTo: POOLS });
    const after = await setting("arena_picks");
    expect(after.value).toEqual({ ...before.value, dailyPrizePool: "500000", weeklyPrizePool: "1000000" });
    expect(Number(after.version)).toBe(Number(before.version) + 1);
  });

  it("a pool an admin already retuned is left alone — each pool is judged on its own", async () => {
    await db.query(`update public.game_settings set value = value || '{"dailyPrizePool":"250000","weeklyPrizePool":"500000"}'::jsonb where key = 'arena_picks'`);
    await migrate(db, undefined, { upTo: POOLS });
    expect((await setting("arena_picks")).value).toMatchObject({ dailyPrizePool: "250000", weeklyPrizePool: "1000000" });
  });

  it("a row already at the new values (or with no stored row at all) is untouched, and a second run changes nothing", async () => {
    await db.query(`update public.game_settings set value = value || '{"dailyPrizePool":"100000","weeklyPrizePool":"500000"}'::jsonb where key = 'arena_picks'`);
    await migrate(db, undefined, { upTo: POOLS });
    const once = await setting("arena_picks");
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, `${POOLS}_prize_pools_500k_1m.sql`), "utf8")); // the same file again
    expect(await setting("arena_picks")).toEqual(once);
    await db.query("delete from public.game_settings where key = 'arena_picks'");
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, `${POOLS}_prize_pools_500k_1m.sql`), "utf8"));
    expect((await db.query("select 1 from public.game_settings where key = 'arena_picks'")).length).toBe(0); // the code default (500,000 / 1,000,000) applies
  });
});

describe("migration 2900 — achievement titles and Gold", () => {
  const hero = async (tid: number): Promise<string> => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values ($1, $2, 120)", [tid, `Member ${tid}`]);
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes order by sort_order limit 1");
    return insertStubHero(db, { telegram_user_id: tid, class_id: cls!.id, name: `Hero ${tid}`, origin: "TELEGRAM", status: "ACTIVE" });
  };
  const unlock = async (heroId: string, achievement: string, extra: { archived?: boolean; admin?: boolean } = {}): Promise<string> =>
    (
      await db.query<{ id: string }>(
        `insert into public.character_achievements (character_id, achievement_id, context, archived_at) values ($1, $2, $3::jsonb, ${extra.archived ? "now()" : "null"}) returning id`,
        [heroId, achievement, JSON.stringify(extra.admin ? { granted: "admin" } : { metric: "battles", value: 1 })],
      )
    )[0]!.id;
  const reward = async (id: string) => (await db.query<{ reward: Record<string, unknown> }>("select reward from public.achievements where id = $1", [id]))[0]!.reward;

  it("follows 2800, adds no schema, and the shipped rewards in the database equal the code's after it", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(ACHIEVEMENTS)).toBe(all.indexOf(POOLS) + 1);
    const sql = await code(`${ACHIEVEMENTS}_achievement_titles_and_gold.sql`);
    for (const forbidden of [/\bcreate\s+table\b/, /\balter\s+table\b/, /\bdrop\b/, /\bdelete\s+from\b/, /\btruncate\b/]) expect(sql).not.toMatch(forbidden);
    expect(sql.trimEnd().endsWith("select public.clank_harden_schema();")).toBe(true);
    // The database starts from what an OLD seed wrote, then migrates.
    expect(Object.keys(OLD_REWARDS).sort()).toEqual(DEFAULT_ACHIEVEMENTS.map((d) => d.id).sort());
    await oldSeed(db);
    await migrate(db, undefined, { upTo: ACHIEVEMENTS });
    for (const def of DEFAULT_ACHIEVEMENTS) expect(await reward(def.id), def.id).toEqual(def.reward);
  });

  it("moves each OLD shipped reward to the new one, leaves a retuned reward alone, and is a no-op the second time", async () => {
    await oldSeed(db);
    await db.query(`update public.achievements set reward = '{"badge":"first_blood","gold":3}'::jsonb where id = 'first_blood'`); // an admin retuned this one
    await migrate(db, undefined, { upTo: ACHIEVEMENTS });
    expect(await reward("arena_debut")).toEqual({ badge: "debut", title: "Rookie", gold: 10 });
    expect(await reward("reaper")).toEqual({ badge: "reaper", title: "Reaper", gold: 75 });
    expect(await reward("first_blood")).toEqual({ badge: "first_blood", gold: 3 }); // untouched
    const before = JSON.stringify(await db.query("select id, reward from public.achievements order by id"));
    await db.exec(await readFile(path.join(MIGRATIONS_DIR, `${ACHIEVEMENTS}_achievement_titles_and_gold.sql`), "utf8"));
    expect(JSON.stringify(await db.query("select id, reward from public.achievements order by id"))).toBe(before);
  });

  it("pays the Gold of achievements already unlocked — exactly once: paid unlocks, archived unlocks and the second run pay nothing more", async () => {
    await migrate(db, undefined, { upTo: POOLS });
    await oldSeed(db);
    await db.query(`update public.achievements set reward = '{"badge":"first_blood","gold":3}'::jsonb where id = 'first_blood'`);
    const h = await hero(9101);
    const regular = await unlock(h, "arena_regular"); // already paid under the old rules (+25, the application's own key)
    await applyLedger(db, { characterId: h, amount: 25, reason: "achievement", refType: "achievement", refId: "arena_regular", idempotencyKey: `achv:${h}:arena_regular:${regular}` });
    await unlock(h, "arena_debut"); // never paid (no gold before) → +10
    await unlock(h, "reaper", { admin: true }); // an admin grant never paid → +75
    await unlock(h, "first_blood"); // retuned reward (3 gold) → +3
    await unlock(h, "victor", { archived: true }); // a development unlock, archived: history only → nothing
    expect(await getBalance(db, h)).toBe(25);

    await migrate(db, undefined, { upTo: ACHIEVEMENTS });
    expect(await getBalance(db, h)).toBe(25 + 10 + 75 + 3);
    const rows = await db.query<{ delta: string; ref_id: string; balance_after: string }>("select delta::text, ref_id, balance_after::text from public.currency_ledger where character_id = $1 order by id", [h]);
    expect(rows.map((r) => r.ref_id).sort()).toEqual(["arena_debut", "arena_regular", "first_blood", "reaper"]);
    // balance_after is a true running balance (one INSERT per row), ending at the account balance
    let running = 0;
    for (const r of rows) {
      running += Number(r.delta);
      expect(Number(r.balance_after)).toBe(running);
    }
    expect(await auditLedger(db)).toEqual([]);

    await db.exec(await readFile(path.join(MIGRATIONS_DIR, `${ACHIEVEMENTS}_achievement_titles_and_gold.sql`), "utf8"));
    expect(await getBalance(db, h)).toBe(25 + 10 + 75 + 3); // nothing is paid twice
    expect((await db.query("select 1 from public.currency_ledger where character_id = $1", [h])).length).toBe(4);
  });

  it("changes nothing else: hero rows, titles already on heroes and every other table are byte-identical", async () => {
    await migrate(db, undefined, { upTo: POOLS });
    const h = await hero(9102);
    await db.query("update public.characters set title = 'Veteran' where id = $1", [h]);
    const tables = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename not in ('achievements', 'currency_ledger', 'currency_accounts', 'schema_migrations') order by 1")).map((t) => t.tablename);
    const snap = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, JSON.stringify(await db.query(`select * from public.${t} order by 1`))] as const)));
    const before = await snap();
    await migrate(db, undefined, { upTo: ACHIEVEMENTS });
    expect(await snap()).toEqual(before);
  });
});
