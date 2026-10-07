import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Rarity } from "@/domain/character/appearance";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { getLiveBoard } from "@/server/rewards/leaderboard";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedEligibleMember, seedHeroes } from "../support/db";
import { pickAs, settle, stageNext } from "../support/rewards";
import { describeStage, finishBattle } from "../support/stage";

/**
 * RARITY IS A COMBAT-STRENGTH TIER AND NOTHING ELSE. It must not reach: Arena Pick Points, the daily / weekly score, rank, tie-breaks,
 * prize pools, the holder bonus, claims or wallets. Pinned two ways: by construction (the code that scores and ranks cannot even see a
 * rarity) and by behaviour (a battle played out with Legendary and Common heroes: every pick earns exactly what the rules say).
 */
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

const src = (rel: string) => readFileSync(path.join(process.cwd(), "src", rel), "utf8");
/** Code with comments removed (they say "rarity never touches…" on purpose). */
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const RARITY_WORDS = /rarity|RARITY|appearance|powerMin|powerMax|hero_versions|character_appearances|visualTier|statBudget/;

const forced = (rarity: Rarity) => ({ ...DEFAULT_SETTINGS, character: { ...DEFAULT_SETTINGS.character, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0, [rarity]: 1 } } });

describe("by CONSTRUCTION: the code that scores, ranks, prices and pays cannot see a rarity", () => {
  it("scoring, ranking, ties, prize ladder, the holder bonus, claims and the reward ledger never mention rarity, appearance or the rarity tables", () => {
    for (const file of [
      "domain/rewards/leaderboard.ts", "domain/rewards/economy.ts", "domain/rewards/holderBonus.ts", "domain/rewards/claims.ts", "domain/rewards/payout.ts",
      "server/rewards/settlement.ts", "server/rewards/points.ts", "server/rewards/claims.ts", "server/rewards/ledger.ts", "server/rewards/pool.ts", "server/rewards/holders.ts",
    ]) expect(code(file), file).not.toMatch(RARITY_WORDS);
  });

  it("the leaderboard module's standings → prizes → bonus path has no rarity in it; the ONLY rarity in the file is the display-only badge lookup", () => {
    const lb = code("server/rewards/leaderboard.ts");
    const standings = lb.slice(lb.indexOf("interface AggRow"), lb.indexOf("async function attachHeroLinks"));
    expect(standings.length).toBeGreaterThan(1500);
    expect(standings).not.toMatch(RARITY_WORDS);
    const finalize = lb.slice(lb.indexOf("export async function finalizePeriod"), lb.indexOf("// RECONCILIATION"));
    expect(finalize).not.toMatch(RARITY_WORDS);
    const hits = lb.split("\n").filter((l) => RARITY_WORDS.test(l));
    // every mention lives inside attachHeroLinks / the row type — the badge is read AFTER ranking, from the hero, and written to no result row
    const attach = lb.slice(lb.indexOf("async function attachHeroLinks"), lb.indexOf("function liveRow"));
    for (const l of hits) expect(attach.includes(l) || /rarity: null/.test(l), l).toBe(true);
  });

  it("no stored result or score row has a rarity or a power column — nothing about rarity is frozen into the economy", async () => {
    const cols = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'
        and table_name in ('arena_leaderboard_results', 'arena_pick_scores', 'arena_leaderboards', 'arena_reward_ledger', 'arena_reward_accounts', 'arena_reward_claims', 'arena_picks')`,
    );
    expect(cols.length).toBeGreaterThan(40);
    expect(cols.filter((c) => /rarity|power|pwr/i.test(c.column_name))).toEqual([]); // (the only "tier" columns are the HOLDER-bonus tiers)
  });

  it("combat does not read rarity either: the engine takes stats and class only (rarity matters through the stats it was built with)", () => {
    expect(code("domain/combat/engine.ts")).not.toMatch(/rarity|RARITY|appearance/);
  });
});

describe("by BEHAVIOUR: Legendary and Common heroes pay the very same", () => {
  it("a battle of 8 Legendary + 8 Common heroes: every member picks a DIFFERENT fighter — the one correct pick earns exactly +10 whatever its rarity, every wrong pick 0", async () => {
    await seedHeroes(db, 8, { settings: forced("LEGENDARY") });
    await seedHeroes(db, 8, { settings: forced("COMMON") });
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    let s = await describeStage(db, clock, ctx);
    const rarityOf = async (id: string) => (await db.query<{ rarity: Rarity }>("select rarity from public.character_appearances where character_id = $1", [id]))[0]!.rarity;
    const winnerRarities = new Set<Rarity>();
    const members: number[] = [];
    for (let i = 0; i < 8; i++) members.push(await seedEligibleMember(db));

    for (let round = 0; round < 14; round++) {
      if (round > 0) s = await stageNext(db, s);
      const picked = new Map<number, string>();
      for (const [i, u] of members.entries()) {
        const fighter = s.fighters[(i + round) % s.fighters.length]!;
        const r = await pickAs(db, s, u, fighter);
        expect(r.ok, `member ${i} round ${round}`).toBe(true);
        picked.set(u, fighter);
      }
      winnerRarities.add(await rarityOf(s.winnerId));
      await finishBattle(db, s);
      await settle(db, s);
      const scores = await db.query<{ telegram_user_id: number; correct: boolean; points: number }>("select telegram_user_id, correct, points from public.arena_pick_scores where battle_id = $1", [s.battleId]);
      for (const row of scores) {
        const right = picked.get(Number(row.telegram_user_id)) === s.winnerId;
        expect(row.correct).toBe(right);
        expect(row.points).toBe(right ? DEFAULT_SETTINGS.arena_picks.pointsPerCorrectPick : 0); // +10 / 0 — the same for a Legendary winner and a Common one
      }
    }
    expect(winnerRarities.size).toBeGreaterThanOrEqual(2); // the run really saw both a Legendary winner and a Common winner
  });

  it("the leaderboard ranks by correct picks and accuracy only: rarity badges are attached AFTER ranking and the order is identical with them removed", async () => {
    await seedHeroes(db, 8, { settings: forced("LEGENDARY") });
    await seedHeroes(db, 8, { settings: forced("COMMON") });
    const clock = new FakeClock();
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    let s = await describeStage(db, clock, ctx);
    const members: number[] = [];
    for (let i = 0; i < 5; i++) members.push(await seedEligibleMember(db));
    for (let round = 0; round < 6; round++) {
      if (round > 0) s = await stageNext(db, s);
      // member 0 always picks the winner, member 1 on even rounds, the rest a loser
      await pickAs(db, s, members[0]!, s.winnerId);
      await pickAs(db, s, members[1]!, round % 2 === 0 ? s.winnerId : s.fighters.find((f) => f !== s.winnerId)!);
      for (const u of members.slice(2)) await pickAs(db, s, u, s.fighters.find((f) => f !== s.winnerId)!);
      await finishBattle(db, s);
      await settle(db, s);
    }
    const { board } = await getLiveBoard(db, { kind: "DAILY", nowMs: s.clock.ms, settings: DEFAULT_SETTINGS });
    expect(board.rows.length).toBe(5);
    const ranks = board.rows.map((r) => [r.rank, r.correctPicks, r.picks, r.points]);
    for (let i = 1; i < ranks.length; i++) expect(ranks[i - 1]![1]).toBeGreaterThanOrEqual(ranks[i]![1]!); // sorted by correct picks
    expect(board.rows[0]!.correctPicks).toBe(6);
    expect(board.rows[0]!.points).toBe(60);
    // the badge is real data about the hero (a rarity) …
    expect(board.rows.every((r) => r.rarity === "LEGENDARY" || r.rarity === "COMMON")).toBe(true);
    // … and removing it changes nothing about the ranking: the same rows, the same order, the same points and prizes
    const stripped = board.rows.map((r) => ({ ...r, rarity: null }));
    expect(stripped.map((r) => [r.rank, r.name, r.correctPicks, r.points, r.basePrize])).toEqual(board.rows.map((r) => [r.rank, r.name, r.correctPicks, r.points, r.basePrize]));
  });
});
