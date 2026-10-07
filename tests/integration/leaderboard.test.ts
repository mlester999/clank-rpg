import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { DEFAULT_SEASON_RANKS } from "@/domain/settings";
import { BOARD_IDS, BOARDS, getLeaderboard } from "@/server/services/leaderboard";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

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

/** Columns of the hero row itself (POWER, and the retired / lifetime counters, which no public board reads any more). */
async function setStats(id: string, s: Record<string, number>) {
  const cols = Object.keys(s);
  await db.query(`update public.characters set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")} where id = $1`, [id, ...cols.map((c) => s[c])]);
}

/** A hero's record in the ACTIVE season — what the Wins / Top-2 / KO boards rank. */
async function setSeason(id: string, s: { wins?: number; top2?: number; eliminations?: number; battles?: number; points?: number }): Promise<string> {
  const [season] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'");
  await db.query(
    `insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (season_id, character_id) do update set points = excluded.points, battles = excluded.battles, wins = excluded.wins, top2 = excluded.top2, eliminations = excluded.eliminations`,
    [season!.id, id, s.points ?? 0, s.battles ?? 0, s.wins ?? 0, s.top2 ?? 0, s.eliminations ?? 0],
  );
  return season!.id;
}
const activeSeasonId = async (): Promise<string> => (await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'"))[0]!.id;

describe("leaderboards", () => {
  it("rank by wins with deterministic tie-breaks (top-2, then fewer battles, then POWER)", async () => {
    const [a, b, c, d, e] = await seedHeroes(db, 5);
    await setStats(a!, { power: 100 });
    await setStats(b!, { power: 100 });
    await setStats(c!, { power: 100 });
    await setStats(d!, { power: 150 });
    await setSeason(a!, { wins: 5, top2: 7, battles: 20 });
    await setSeason(b!, { wins: 5, top2: 9, battles: 30 }); // same wins, more top-2 → ahead of a
    await setSeason(c!, { wins: 5, top2: 9, battles: 25 }); // same, fewer battles → ahead of b
    await setSeason(d!, { wins: 5, top2: 9, battles: 25 }); // same, higher POWER → ahead of c
    await setSeason(e!, { wins: 0, battles: 0 }); // never fought this season → not listed
    const rows = await getLeaderboard(db, "WINS", { allowDemo: true, limit: 50, seasonId: await activeSeasonId() });
    expect(rows.map((r) => r.characterId)).toEqual([d, c, b, a]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3, 4]);
    expect(rows[0]).toMatchObject({ value: 5, secondary: 9 });
  });

  it("power, top-2 and KO boards order correctly", async () => {
    const [a, b, c] = await seedHeroes(db, 3);
    await setStats(a!, { power: 100 });
    await setStats(b!, { power: 300 });
    await setStats(c!, { power: 200 });
    const seasonId = await setSeason(a!, { top2: 1, eliminations: 30, battles: 3 });
    await setSeason(b!, { top2: 9, eliminations: 1, battles: 3 });
    await setSeason(c!, { top2: 4, eliminations: 12, battles: 3 });
    expect((await getLeaderboard(db, "POWER", { allowDemo: true })).map((r) => r.characterId)).toEqual([b, c, a]);
    expect((await getLeaderboard(db, "TOP2", { allowDemo: true, seasonId })).map((r) => r.characterId)).toEqual([b, c, a]);
    expect((await getLeaderboard(db, "KOS", { allowDemo: true, seasonId })).map((r) => r.characterId)).toEqual([a, c, b]);
  });

  it("there is no XP / level board, and the retired xp/level columns cannot move any board", async () => {
    expect(BOARD_IDS).not.toContain("LEVEL");
    expect(Object.values(BOARDS).map((b) => b.label.toLowerCase()).join(" ")).not.toMatch(/level|xp|experience/);
    const [a, b, c] = await seedHeroes(db, 3);
    await setStats(a!, { power: 100 });
    await setStats(b!, { power: 300 });
    await setStats(c!, { power: 200 });
    const seasonId = await setSeason(a!, { wins: 3, top2: 3, eliminations: 3, battles: 5 });
    await setSeason(b!, { wins: 2, top2: 6, eliminations: 9, battles: 5 });
    await setSeason(c!, { wins: 1, top2: 2, eliminations: 6, battles: 5 });
    const order = () => Promise.all(BOARD_IDS.map((id) => getLeaderboard(db, id, { allowDemo: true, seasonId }).then((r) => r.map((x) => x.characterId))));
    const before = await order();
    // Stuff the retired columns with absurd values on the hero who is last everywhere.
    await setStats(c!, { level: 500, xp: 999_999_999 });
    expect(await order()).toEqual(before);
  });

  it("season boards carry the seasonal tier; permanent boards carry none", async () => {
    const [a, b] = await seedHeroes(db, 2);
    const [season] = await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'");
    const tiers = DEFAULT_SEASON_RANKS;
    for (const [id, pts] of [[a!, tiers[2]!.minPoints], [b!, 3]] as const) {
      await db.query("insert into public.season_character_stats (season_id, character_id, points, battles, wins) values ($1, $2, $3, 4, 1)", [season!.id, id, pts]);
    }
    const rows = await getLeaderboard(db, "SEASON_POINTS", { allowDemo: true, seasonId: season!.id, seasonRanks: tiers });
    expect(rows.map((r) => [r.characterId, r.seasonRank?.name])).toEqual([[a, "Gold"], [b, "Bronze"]]);
    const wins = await getLeaderboard(db, "SEASON_WINS", { allowDemo: true, seasonId: season!.id, seasonRanks: tiers });
    expect(wins.every((r) => r.seasonRank !== null)).toBe(true);
    // The POWER board (identity, not a season figure) carries no seasonal tier; the Wins board is a season board now and does.
    expect((await getLeaderboard(db, "POWER", { allowDemo: true, seasonId: season!.id, seasonRanks: tiers })).every((r) => r.seasonRank === null)).toBe(true);
    expect((await getLeaderboard(db, "WINS", { allowDemo: true, seasonId: season!.id, seasonRanks: tiers }))[0]!.seasonRank).not.toBeNull();
  });

  it("Wins / Top-2 / KOs rank the CURRENT SEASON, never the lifetime career counters", async () => {
    const [a, b] = await seedHeroes(db, 2);
    // A hero with an enormous career but nothing this season is not listed; a hero with one season win is.
    await setStats(a!, { arena_wins: 50, arena_top2: 60, arena_eliminations: 99, arena_battles: 80 });
    const seasonId = await setSeason(b!, { wins: 1, top2: 1, eliminations: 2, battles: 1 });
    for (const board of ["WINS", "TOP2", "KOS"] as const) {
      expect(BOARDS[board].season).toBe(true);
      expect((await getLeaderboard(db, board, { allowDemo: true, seasonId })).map((r) => r.characterId), board).toEqual([b]);
    }
    // A fresh season starts every board empty — and the career counters are still there, untouched.
    await db.exec("update public.seasons set status = 'ENDED', ends_at = now() where status = 'ACTIVE'");
    const [next] = await db.query<{ id: string }>("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 2, 'Development run 2', 'ACTIVE') returning id");
    for (const board of ["WINS", "TOP2", "KOS", "SEASON_POINTS", "SEASON_WINS"] as const) expect(await getLeaderboard(db, board, { allowDemo: true, seasonId: next!.id }), board).toEqual([]);
    expect((await db.query<{ arena_wins: number }>("select arena_wins from public.characters where id = $1", [a]))[0]!.arena_wins).toBe(50);
    // With no season at all there is nothing to rank.
    expect(await getLeaderboard(db, "WINS", { allowDemo: true, seasonId: null })).toEqual([]);
  });

  it("community activity ranks by the hybrid activity score, not by raw message count", async () => {
    const [a, b] = await seedHeroes(db, 2);
    const tid = async (id: string) => (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [id]))[0]!.telegram_user_id;
    await db.query("update public.telegram_users set activity_score = 80, qualifying_message_count = 150 where telegram_user_id = $1", [await tid(a!)]);
    await db.query("update public.telegram_users set activity_score = 40, qualifying_message_count = 5000 where telegram_user_id = $1", [await tid(b!)]);
    const rows = await getLeaderboard(db, "COMMUNITY", { allowDemo: true });
    expect(rows.map((r) => r.characterId)).toEqual([a, b]);
  });

  it("no leaderboard ranks wallet wealth: richer wallets do not move any board", async () => {
    expect(BOARD_IDS).toEqual(["WINS", "TOP2", "KOS", "POWER", "COMMUNITY", "SEASON_POINTS", "SEASON_WINS"]);
    const [a, b] = await seedHeroes(db, 2);
    const seasonId = await setSeason(a!, { wins: 3, battles: 5, points: 10 });
    await setSeason(b!, { wins: 9, battles: 12, points: 30 });
    const before = await Promise.all(BOARD_IDS.map((id) => getLeaderboard(db, id, { allowDemo: true, seasonId }).then((r) => r.map((x) => x.characterId))));
    // Give hero A an enormous verified bonded-coin position.
    const [tok] = await db.query<{ id: string }>("insert into public.eligible_tokens (chain_id, address, symbol, status, bonded_observed, approved_at) values (4663, '0x" + "ab".repeat(20) + "', 'W', 'ELIGIBLE', true, now()) returning id");
    await db.query("insert into public.token_holdings (character_id, token_id, balance, supply_fraction, value_quote) values ($1, $2, 1000000000000000000000000000, 0.9, 1000000)", [a, tok!.id]);
    const after = await Promise.all(BOARD_IDS.map((id) => getLeaderboard(db, id, { allowDemo: true, seasonId }).then((r) => r.map((x) => x.characterId))));
    expect(after).toEqual(before);
  });

  it("hides demo heroes unless allowed, and hides banned/suspended members", async () => {
    const [a, b, c] = await seedHeroes(db, 3);
    for (const id of [a!, b!, c!]) await setSeason(id, { wins: 1, battles: 1 });
    const seasonId = await activeSeasonId();
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = (select telegram_user_id from public.characters where id = $1)", [a]);
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [b]);
    expect((await getLeaderboard(db, "WINS", { allowDemo: true, seasonId })).map((r) => r.characterId)).toEqual([c]);
    // demo flag
    await db.query("update public.characters set origin = 'DEV_SEED', is_demo = true where id = $1", [c]);
    expect(await getLeaderboard(db, "WINS", { allowDemo: false, seasonId })).toEqual([]);
    expect((await getLeaderboard(db, "WINS", { allowDemo: true, seasonId })).map((r) => r.characterId)).toEqual([c]);
  });

  it("paginates and clamps limits", async () => {
    const ids = await seedHeroes(db, 10);
    let seasonId = "";
    for (const [i, id] of ids.entries()) seasonId = await setSeason(id, { wins: i + 1, battles: 20 });
    const page2 = await getLeaderboard(db, "WINS", { allowDemo: true, limit: 3, offset: 3, seasonId });
    expect(page2.map((r) => r.rank)).toEqual([4, 5, 6]);
    expect((await getLeaderboard(db, "WINS", { allowDemo: true, limit: 9999, seasonId })).length).toBe(10);
    expect((await getLeaderboard(db, "WINS", { allowDemo: true, limit: -5, seasonId })).length).toBe(1);
  });

  it("seasonal boards are separated by season and reset independently of permanent progression", async () => {
    await seedHeroes(db, 16);
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    const run = async (secs: number) => { for (let s = 0; s < secs; s++) { await advanceArena(db, ctx); clock.advance(1000); } };
    await run(140);
    const s1 = (await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'"))[0]!.id;
    const s1Board = await getLeaderboard(db, "SEASON_POINTS", { allowDemo: true, seasonId: s1, limit: 50 });
    expect(s1Board.length).toBeGreaterThan(0);

    await db.query("update public.seasons set status = 'ENDED', ends_at = now() where id = $1", [s1]);
    const s2 = (await db.query<{ id: string }>("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 2, 'Development run 2', 'ACTIVE') returning id"))[0]!.id;
    expect(await getLeaderboard(db, "SEASON_POINTS", { allowDemo: true, seasonId: s2 })).toEqual([]); // fresh ladder
    // Battles already lined up under season 1 may still settle there, but nothing NEW is ever assigned to it.
    const s1BattlesAtRollover = await count(db, "arena_battles", `season_id = '${s1}'`);
    for (let i = 0; i < 30 && await count(db, "arena_battles", `season_id = '${s2}' and status = 'SETTLED'`) === 0; i++) {
      const advanced = await advanceArena(db, ctx);
      if (advanced.dueAtMs !== null && advanced.dueAtMs > clock.ms) clock.ms = advanced.dueAtMs + 10;
      else clock.advance(1000);
    }
    expect(await count(db, "arena_battles", `season_id = '${s1}'`)).toBe(s1BattlesAtRollover);
    expect(await count(db, "arena_battles", `season_id = '${s2}' and status = 'SETTLED'`)).toBeGreaterThan(0);
    const s2Board = await getLeaderboard(db, "SEASON_POINTS", { allowDemo: true, seasonId: s2, limit: 50 });
    expect(s2Board.length).toBeGreaterThan(0);
    // Every season's ladder is the sum of exactly the settled battles that belong to that season.
    for (const sid of [s1, s2]) {
      const [row] = await db.query<{ stat: number; settled: number }>(
        `select coalesce((select sum(battles)::int from public.season_character_stats where season_id = $1), 0) as stat,
                (select count(*)::int from public.arena_battles where season_id = $1 and status = 'SETTLED') as settled`,
        [sid],
      );
      expect(row!.stat).toBe(row!.settled * 8);
    }
    // The Wins board is a SEASON board: each season's wins are exactly its own settled battles, and the career counters on the heroes accumulate across both.
    for (const sid of [s1, s2]) {
      const wins = (await getLeaderboard(db, "WINS", { allowDemo: true, limit: 50, seasonId: sid })).reduce((sum, r) => sum + r.value, 0);
      expect(wins).toBe(await count(db, "arena_battles", `season_id = '${sid}' and status = 'SETTLED'`));
    }
    const career = (await db.query<{ n: number }>("select sum(arena_wins)::int as n from public.characters"))[0]!.n;
    expect(career).toBe(await count(db, "arena_battles", "status = 'SETTLED'"));
    expect(await getLeaderboard(db, "SEASON_POINTS", { allowDemo: true, seasonId: null })).toEqual([]); // no season → no seasonal board
  });
});
