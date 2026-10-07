import { describe, expect, it } from "vitest";

import { computeHoldingScore, holdingStatBonus } from "@/domain/holdings/holdingPower";
import { evolveStreak, loyaltyStatBonus, reachedMilestones, streakDays, type StreakState } from "@/domain/holdings/streaks";
import { computeTradingScore, tradingStatBonus } from "@/domain/holdings/trading";
import { computeRewards } from "@/domain/progression/rewards";
import { seasonRankFor } from "@/domain/progression/seasonRank";
import { DEFAULT_SEASON_RANKS, DEFAULT_SETTINGS, parseSettings, progressionSettingsSchema } from "@/domain/settings";
import { sumStats } from "@/domain/stats";

import { ruleset, settings } from "../support/fixtures";

const H = settings.holdings;
const L = settings.loyalty;
const P = settings.progression;
const hold = (fraction: number, value: number | null = 0.1, id = "t") => ({ tokenId: id, supplyFraction: fraction, valueQuote: value });

describe("holding power (hybrid, strongly diminishing)", () => {
  it("is zero with no eligible holdings, dust, or when disabled", () => {
    expect(computeHoldingScore([], H).score).toBe(0);
    expect(computeHoldingScore([hold(1e-9)], H).score).toBe(0);
    expect(computeHoldingScore([hold(0.05)], { ...H, enabled: false }).score).toBe(0);
  });

  it("is monotonic in value, % of supply and number of coins", () => {
    const base = computeHoldingScore([hold(0.001, 0.1)], H).score;
    expect(computeHoldingScore([hold(0.001, 0.5)], H).score).toBeGreaterThan(base);
    expect(computeHoldingScore([hold(0.01, 0.1)], H).score).toBeGreaterThan(base);
    expect(computeHoldingScore([hold(0.001, 0.1, "a"), hold(0.001, 0.1, "b")], H).score).toBeGreaterThan(base);
  });

  it("has diminishing returns: equal additional holdings add less and less", () => {
    // Equal ADDITIVE steps of value + supply; marginal gain must be non-increasing (concave).
    const at = (steps: number) => computeHoldingScore([hold(0.002 * steps, 0.2 * steps)], H).score;
    const gains = Array.from({ length: 25 }, (_, i) => at(i + 1) - at(i));
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeLessThanOrEqual(gains[i - 1]! + 1e-12);
    expect(gains[24]!).toBeLessThan(gains[0]! * 0.35);
    // and the total is bounded
    expect(at(10_000)).toBeLessThan(1);
  });

  it("whales get an edge but are capped far below 'unbeatable'", () => {
    const small = holdingStatBonus(computeHoldingScore([hold(0.001, 0.05)], H).score, ruleset.classes.warrior!, H);
    const whale = holdingStatBonus(computeHoldingScore([1, 2, 3, 4, 5, 6, 7, 8].map((n) => hold(0.5, 5000, `w${n}`)), H).score, ruleset.classes.warrior!, H);
    expect(sumStats(whale, ["hp"])).toBeGreaterThan(sumStats(small, ["hp"]));
    expect(computeHoldingScore([1, 2, 3, 4, 5, 6, 7, 8].map((n) => hold(0.5, 5000, `w${n}`)), H).score).toBeLessThan(1);
    expect(sumStats(whale, ["hp"]) + whale.hp / H.hpPerPoint).toBeLessThanOrEqual(H.maxBonusPoints + 0.05);
  });

  it("unknown prices (non-ETH quote or no price source) only drop the value term", () => {
    const withValue = computeHoldingScore([hold(0.002, 1)], H);
    const noValue = computeHoldingScore([hold(0.002, null)], H);
    expect(noValue.parts.value).toBe(0);
    expect(noValue.parts.supply).toBeGreaterThan(0);
    expect(noValue.score).toBeLessThan(withValue.score);
  });
});

describe("Diamond Hands streaks", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const t0 = Date.UTC(2026, 6, 1);
  const open = (): StreakState => ({ startedAtMs: t0, peakBalance: 1000n, lastVerifiedAtMs: t0 });

  it("starts at the first OBSERVED balance and never backdates history", () => {
    const r = evolveStreak(null, 500n, t0, L);
    expect(r.action).toBe("START");
    expect(r.next!.startedAtMs).toBe(t0);
    expect(evolveStreak(null, 0n, t0, L)).toEqual({ action: "NONE", next: null });
  });

  it("continues while balance holds, tracking the peak", () => {
    const r = evolveStreak(open(), 1500n, t0 + 6 * HOUR, L);
    expect(r.action).toBe("CONTINUE");
    expect(r.next!.peakBalance).toBe(1500n);
    expect(r.next!.startedAtMs).toBe(t0);
  });

  it("tolerates small sells but resets when holdings drop below the retain fraction", () => {
    expect(evolveStreak(open(), 850n, t0 + HOUR, L).action).toBe("CONTINUE"); // sold 15%
    const sold = evolveStreak(open(), 700n, t0 + HOUR, L); // sold 30%
    expect(sold).toMatchObject({ action: "RESTART", endReason: "SOLD_DOWN" });
    expect(sold.next!.startedAtMs).toBe(t0 + HOUR); // remainder starts a fresh streak
    expect(evolveStreak(open(), 0n, t0 + HOUR, L)).toMatchObject({ action: "RESTART", endReason: "SOLD_DOWN", next: null });
  });

  it("restarts when verification has a gap (a sell-and-rebuy cannot be ruled out)", () => {
    const r = evolveStreak(open(), 1000n, t0 + (L.maxVerifyGapHours + 1) * HOUR, L);
    expect(r).toMatchObject({ action: "RESTART", endReason: "VERIFY_GAP" });
  });

  it("computes milestone days and cumulative reached milestones (1/7/30/90 configurable)", () => {
    const s = open();
    expect(streakDays(s, t0 + 7.5 * DAY)).toBe(7);
    expect(reachedMilestones(0, L)).toEqual([]);
    expect(reachedMilestones(7, L)).toEqual([1, 7]);
    expect(reachedMilestones(120, L)).toEqual([1, 7, 30, 90]);
    expect(reachedMilestones(7, { milestones: [{ days: 3, points: 1, badge: "x" }] })).toEqual([3]);
  });

  it("loyalty bonus is defensive-only and hard-capped", () => {
    const none = loyaltyStatBonus(0, ruleset.classes.mage!, L);
    expect(none.points).toBe(0);
    const max = loyaltyStatBonus(500, ruleset.classes.mage!, L);
    expect(max.points).toBeLessThanOrEqual(L.maxPoints);
    expect(max.bonus.str + max.bonus.int + max.bonus.agi + max.bonus.luck + max.bonus.cha).toBe(0);
    expect(max.bonus.hp).toBeGreaterThan(0);
    expect(max.bonus.def).toBeGreaterThan(0);
    expect(loyaltyStatBonus(500, ruleset.classes.mage!, { ...L, maxPoints: 1 }).points).toBe(1);
  });
});

describe("trading activity is a small, wash-resistant component", () => {
  const T = settings.trading;
  it("1000 same-day trades barely register vs sustained participation", () => {
    const wash = computeTradingScore({ tradeDays: 1, volumeQuote: 0.01, tokens: 1 }, T);
    const steady = computeTradingScore({ tradeDays: 25, volumeQuote: 1, tokens: 3 }, T);
    expect(wash).toBeLessThan(0.1);
    expect(steady).toBeGreaterThan(wash * 5);
  });
  it("is bounded: even absurd activity cannot exceed maxPoints", () => {
    const score = computeTradingScore({ tradeDays: 1e6, volumeQuote: 1e9, tokens: 1e3 }, T);
    expect(score).toBeLessThanOrEqual(1);
    const bonus = tradingStatBonus(score, T);
    expect(sumStats(bonus, ["hp"])).toBeLessThanOrEqual(T.maxPoints + 0.02);
    expect(T.maxPoints).toBeLessThanOrEqual(2);
  });
  it("is zero when disabled", () => {
    expect(computeTradingScore({ tradeDays: 50, volumeQuote: 50, tokens: 5 }, { ...T, enabled: false })).toBe(0);
  });
});

describe("rewards (no XP, no levels)", () => {
  it("an arena appearance pays Clank Gold and season points only — there is no XP reward", () => {
    for (let placement = 1; placement <= 8; placement++) {
      expect(Object.keys(computeRewards(placement, 2, P)).sort()).toEqual(["gold", "seasonPoints"]);
    }
  });
  it("rewards are conservative and strictly better for higher placements", () => {
    const r = Array.from({ length: 8 }, (_, i) => computeRewards(i + 1, 0, P));
    for (let i = 1; i < 8; i++) {
      expect(r[i]!.gold).toBeLessThanOrEqual(r[i - 1]!.gold);
      expect(r[i]!.seasonPoints).toBeLessThanOrEqual(r[i - 1]!.seasonPoints);
    }
    expect(r[0]!.gold).toBeLessThan(100);
    expect(computeRewards(1, 3, P).gold).toBeGreaterThan(computeRewards(1, 0, P).gold);
    expect(computeRewards(8, 0, P).gold).toBeGreaterThan(0); // participation always pays a little
  });
});

describe("settings: retired XP / level keys", () => {
  it("the shipped defaults carry no XP curve and no level cap", () => {
    expect(DEFAULT_SETTINGS.progression).not.toHaveProperty("xp");
    expect(DEFAULT_SETTINGS.character).not.toHaveProperty("levelCap");
  });
  it("settings rows stored before the removal still load, and the retired keys are dropped", () => {
    const legacyProgression = { ...DEFAULT_SETTINGS.progression, xp: { curveBase: 100, curveExponent: 1.7, multiplier: 1, participation: 12, placement: [60, 40, 28, 20, 14, 10, 8, 6], elimination: 8 } } as Record<string, unknown>;
    delete legacyProgression.seasonRanks; // rows from before season ranks existed have none
    const progression = parseSettings("progression", legacyProgression);
    expect(progression).not.toHaveProperty("xp");
    expect(progression.seasonRanks).toEqual(DEFAULT_SEASON_RANKS);
    const character = parseSettings("character", { ...DEFAULT_SETTINGS.character, levelCap: 30 });
    expect(character).not.toHaveProperty("levelCap");
  });
});

describe("season rank (status only, resets with the season)", () => {
  const tiers = DEFAULT_SEASON_RANKS;
  it("ships Bronze → Silver → Gold → Diamond → Clanker, data-driven", () => {
    expect(tiers.map((t) => t.name)).toEqual(["Bronze", "Silver", "Gold", "Diamond", "Clanker"]);
  });
  it("derives the tier from this season's points, at the exact boundaries", () => {
    expect(seasonRankFor(0, tiers).tier.id).toBe("bronze");
    expect(seasonRankFor(tiers[1]!.minPoints - 1, tiers).tier.id).toBe("bronze");
    expect(seasonRankFor(tiers[1]!.minPoints, tiers).tier.id).toBe("silver");
    expect(seasonRankFor(tiers[3]!.minPoints, tiers).tier.id).toBe("diamond");
    expect(seasonRankFor(1e9, tiers).tier.id).toBe("clanker");
  });
  it("reports progress to the next tier, and none at the top", () => {
    const mid = seasonRankFor((tiers[1]!.minPoints + tiers[2]!.minPoints) / 2, tiers);
    expect(mid.next?.id).toBe("gold");
    expect(mid.pointsToNext).toBe(tiers[2]!.minPoints - mid.points);
    expect(mid.progress).toBeCloseTo(0.5, 2);
    const top = seasonRankFor(1e9, tiers);
    expect(top).toMatchObject({ next: null, pointsToNext: null, progress: 1 });
  });
  it("is robust to junk input", () => {
    expect(seasonRankFor(-5, tiers).tier.id).toBe("bronze");
    expect(seasonRankFor(Number.NaN, tiers).points).toBe(0);
  });
  it("a new season (points back to 0) puts everyone — veterans and newcomers — back on the same rung", () => {
    expect(seasonRankFor(0, tiers).tier.id).toBe("bronze");
  });
  it("tier tables are validated: start at 0, strictly increasing, unique ids", () => {
    const base = DEFAULT_SETTINGS.progression;
    const bad = (seasonRanks: unknown) => progressionSettingsSchema.safeParse({ ...base, seasonRanks }).success;
    expect(bad(DEFAULT_SEASON_RANKS)).toBe(true);
    expect(bad([{ id: "a", name: "A", minPoints: 5 }])).toBe(false);
    expect(bad([{ id: "aa", name: "A", minPoints: 0 }, { id: "bb", name: "B", minPoints: 0 }])).toBe(false);
    expect(bad([{ id: "aa", name: "A", minPoints: 0 }, { id: "aa", name: "B", minPoints: 10 }])).toBe(false);
    expect(bad([])).toBe(false);
  });
});
