import { describe, expect, it } from "vitest";

import { distributeHeroPrizes, isRewardedScope, poolIsSet, rankByMetric, rankHeroArena, winRatePercent, type HeroStat } from "@/domain/heroArena";
import { DEFAULT_SETTINGS, heroArenaSettingsSchema, parseSettings } from "@/domain/settings";

/**
 * HERO ARENA — the pure rules: ranked by ARENA WINS and nothing else; exact ties pool and split the positions they occupy; no hidden tiebreaker; no pool, no invented amount.
 */
const hero = (id: string, wins: number, extra: Partial<HeroStat> = {}): HeroStat => ({ characterId: id, name: id, matches: wins + 2, wins, top2: wins + 1, kos: 0, ...extra });
const LADDER = [3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200];
const POOL = 100_000_000_000n; // 100,000 tokens in micro units

describe("ranking by Arena Wins", () => {
  it("ranks by wins only and gives exact ties the same (competition) rank: 1, 1, 3", () => {
    const r = rankHeroArena([hero("b", 6), hero("a", 8), hero("c", 8), hero("d", 0)], 1);
    expect(r.map((x) => [x.row.characterId, x.rank, x.tieSize])).toEqual([["a", 1, 2], ["c", 1, 2], ["b", 3, 1], ["d", 4, 1]]);
  });

  it("PWR, rarity, class, matches played and the hero's name never break a tie — the order inside a tie is display-only", () => {
    const strong = { ...hero("zz-legendary", 5, { matches: 5 }), power: 9999, rarity: "LEGENDARY" } as HeroStat;
    const weak = { ...hero("aa-common", 5, { matches: 40 }), power: 1, rarity: "COMMON" } as HeroStat;
    const r = rankHeroArena([strong, weak], 1);
    expect(r.map((x) => x.rank)).toEqual([1, 1]); // exact tie whatever the power / matches
    expect(r.map((x) => x.tieSize)).toEqual([2, 2]);
    expect(rankHeroArena([weak, strong], 1).map((x) => x.rank)).toEqual([1, 1]); // input order is irrelevant
  });

  it("only heroes with at least `minimumWins` wins are prize-eligible (a prize for zero wins is meaningless); the rest stay on the board", () => {
    const r = rankHeroArena([hero("a", 3), hero("b", 1), hero("c", 0)], 2);
    expect(r.map((x) => [x.row.characterId, x.prizeEligible])).toEqual([["a", true], ["b", false], ["c", false]]);
    expect(rankHeroArena([hero("c", 0)], 1)[0]!.prizeEligible).toBe(false); // even a minimum of 1 refuses zero wins
  });

  it("the other metrics (Top-2, KOs) are ranked by their own value with the same competition ranking — and carry no prize", () => {
    const rows = [hero("a", 1, { top2: 9, kos: 2 }), hero("b", 9, { top2: 3, kos: 7 }), hero("c", 0, { top2: 9, kos: 7 })];
    expect(rankByMetric(rows, (r) => r.top2).map((x) => [x.row.characterId, x.rank])).toEqual([["a", 1], ["c", 1], ["b", 3]]);
    expect(rankByMetric(rows, (r) => r.kos).map((x) => [x.row.characterId, x.rank])).toEqual([["b", 1], ["c", 1], ["a", 3]]);
    expect(rankByMetric(rows, (r) => r.top2).every((x) => !x.prizeEligible)).toBe(true);
  });
});

describe("prizes: one ladder, pooled ties, an exact accounting", () => {
  it("brief scenario — A and C tied on wins for #1/#2: positions 1+2 are COMBINED and split equally; B takes position 3", () => {
    const ranked = rankHeroArena([hero("A", 8), hero("B", 6), hero("C", 8)], 1);
    const { prizeOf, returnedMicro } = distributeHeroPrizes(ranked, POOL, LADDER);
    expect(prizeOf.get("A")).toBe(25_000_000_000n); // (30% + 20%) / 2
    expect(prizeOf.get("C")).toBe(25_000_000_000n);
    expect(prizeOf.get("B")).toBe(15_000_000_000n); // position 3
    expect(returnedMicro).toBe(POOL - 65_000_000_000n); // unfilled positions return to the reserve — never to anyone
  });

  it("the higher PWR / rarity / name does not get the higher prize of a tie", () => {
    const a = { ...hero("a-weak", 4), power: 10 } as HeroStat;
    const b = { ...hero("z-strong", 4), power: 9000 } as HeroStat;
    const { prizeOf } = distributeHeroPrizes(rankHeroArena([a, b], 1), POOL, LADDER);
    expect(prizeOf.get("a-weak")).toBe(prizeOf.get("z-strong"));
  });

  it("a tie reaching past the last rewarded position: the whole group shares the positions that exist, nobody tied for a paid rank is left out", () => {
    const heroes = Array.from({ length: 14 }, (_, i) => hero(`h${i}`, 1)); // fourteen heroes with one win each
    const { prizeOf, returnedMicro } = distributeHeroPrizes(rankHeroArena(heroes, 1), POOL, LADDER);
    expect(prizeOf.size).toBe(14);
    const total = [...prizeOf.values()].reduce((a, b) => a + b, 0n);
    expect(total + returnedMicro).toBe(POOL);
    expect(total).toBeLessThanOrEqual(POOL);
    expect(new Set([...prizeOf.values()]).size).toBe(1); // exactly equal shares
  });

  it("integer remainders of a split return to the reserve (the pool is always exactly accounted for)", () => {
    const { prizeOf, returnedMicro } = distributeHeroPrizes(rankHeroArena([hero("a", 5), hero("b", 5), hero("c", 5)], 1), 100n, LADDER); // 30+20+15 of 100 → 65 / 3
    expect([...prizeOf.values()].reduce((a, b) => a + b, 0n) + returnedMicro).toBe(100n);
    expect(returnedMicro).toBeGreaterThanOrEqual(35n);
  });

  it("no wins, no prize: nobody ranks into a paid position without a win", () => {
    const { prizeOf } = distributeHeroPrizes(rankHeroArena([hero("a", 0), hero("b", 0)], 1), POOL, LADDER);
    expect(prizeOf.size).toBe(0);
  });

  it("a zero pool pays nothing and returns nothing", () => {
    const { prizeOf, returnedMicro } = distributeHeroPrizes(rankHeroArena([hero("a", 3)], 1), 0n, LADDER);
    expect(prizeOf.size).toBe(0);
    expect(returnedMicro).toBe(0n);
  });
});

describe("scopes and display figures", () => {
  it("Daily and Weekly are rewarded; Season is standings only", () => {
    expect([isRewardedScope("DAILY"), isRewardedScope("WEEKLY"), isRewardedScope("SEASON")]).toEqual([true, true, false]);
  });
  it("win rate: wins / matches, one decimal, 0 with no matches", () => {
    expect(winRatePercent(3, 8)).toBe(37.5);
    expect(winRatePercent(1, 3)).toBe(33.3);
    expect(winRatePercent(0, 0)).toBe(0);
  });
});

describe("the hero_arena setting: separate from Arena Picks, and NO amount invented", () => {
  it("both pools default to null = REWARD POOL NOT SET — the 100k / 500k of Arena Picks are NOT copied", () => {
    expect(DEFAULT_SETTINGS.hero_arena.dailyPrizePool).toBeNull();
    expect(DEFAULT_SETTINGS.hero_arena.weeklyPrizePool).toBeNull();
    expect(DEFAULT_SETTINGS.arena_picks.dailyPrizePool).toBe("500000"); // Arena Picks keeps its own pools
    expect(DEFAULT_SETTINGS.arena_picks.weeklyPrizePool).toBe("1000000");
    expect(poolIsSet(null)).toBe(false);
    expect(poolIsSet("")).toBe(false);
    expect(poolIsSet("250000")).toBe(true);
  });

  it("has its own ladder (default: the same Top-10 shape), its own minimum, and no holder-bonus field at all", () => {
    expect(DEFAULT_SETTINGS.hero_arena.prizeSplitBps).toEqual([3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200]);
    expect(Object.keys(DEFAULT_SETTINGS.hero_arena).sort()).toEqual(["dailyPrizePool", "enabled", "minimumWins", "prizeSplitBps", "weeklyPrizePool"]);
    expect(() => heroArenaSettingsSchema.parse({ ...DEFAULT_SETTINGS.hero_arena, holderBonusTiers: [] })).toThrow(); // strict: nothing sneaks a bonus in
  });

  it("validates like the Picks config: a ladder over 100%, a bad amount, a zero minimum are refused; a real pool is accepted", () => {
    const ok = { ...DEFAULT_SETTINGS.hero_arena, dailyPrizePool: "50000", weeklyPrizePool: "250000" };
    expect(parseSettings("hero_arena", ok)).toEqual(ok);
    expect(() => parseSettings("hero_arena", { ...ok, prizeSplitBps: [6000, 6000] })).toThrow();
    expect(() => parseSettings("hero_arena", { ...ok, dailyPrizePool: "-5" })).toThrow();
    expect(() => parseSettings("hero_arena", { ...ok, minimumWins: 0 })).toThrow();
  });
});
