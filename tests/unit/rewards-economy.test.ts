import { describe, expect, it } from "vitest";

import { economyPlan, economyPlanView } from "@/domain/rewards/economy";
import { LOGICAL_DECIMALS } from "@/domain/rewards/tokens";
import { upgradeLegacyArenaPicks } from "@/domain/settings";
import { DEFAULT_SETTINGS, parseSettings } from "@/domain/settings";

/** One whole $CLANKRPG in LOGICAL units (micro-tokens): the economy is planned in logical amounts, independent of any contract. */
const UNIT = 10n ** BigInt(LOGICAL_DECIMALS);
const plan = economyPlan(DEFAULT_SETTINGS.arena_picks);

describe("the reward economy is a PRODUCT OF SETTINGS — maximum emission is predictable", () => {
  it("DAILY: base pool 200,000 · maximum holder-bonus exposure 50,000 · maximum liability 250,000", () => {
    expect(plan.daily).toEqual({ basePool: 200_000n * UNIT, maxBonusExposure: 50_000n * UNIT, maxLiability: 250_000n * UNIT });
  });
  it("WEEKLY: base pool 1,000,000 · maximum holder-bonus exposure 250,000 · maximum liability 1,250,000", () => {
    expect(plan.weekly).toEqual({ basePool: 1_000_000n * UNIT, maxBonusExposure: 250_000n * UNIT, maxLiability: 1_250_000n * UNIT });
  });
  it("SEASON 1 (12 weeks = 84 days): daily 16,800,000 + weekly 12,000,000 = 28,800,000 base; 36,000,000 with 25% bonuses everywhere; fits a 75,000,000 allocation with a 39,000,000 buffer", () => {
    expect(plan.season).toMatchObject({ weeks: 12, days: 84, dailyBaseTotal: 16_800_000n * UNIT, weeklyBaseTotal: 12_000_000n * UNIT, baseMaximum: 28_800_000n * UNIT, maximumWithBonuses: 36_000_000n * UNIT, allocation: 75_000_000n * UNIT, buffer: 39_000_000n * UNIT, fits: true });
  });
  it("the Admin view carries the same numbers as display strings, and a season that cannot fit its allocation is reported (negative buffer, fits=false)", () => {
    const v = economyPlanView(plan);
    expect(v).toMatchObject({ maxBonusPercent: 25, daily: { maxLiability: "250,000" }, weekly: { maxLiability: "1,250,000" }, season: { baseMaximum: "28,800,000", maximumWithBonuses: "36,000,000", buffer: "39,000,000", fits: true } });
    const tight = economyPlanView(economyPlan({ ...DEFAULT_SETTINGS.arena_picks, seasonRewardAllocation: "15000000" }));
    expect(tight.season).toMatchObject({ fits: false, buffer: "-21,000,000" });
  });
  it("changing a pool, the bonus ladder or the season length moves every figure — nothing is hard-coded", () => {
    const p = economyPlan({ ...DEFAULT_SETTINGS.arena_picks, dailyPrizePool: "10000", holderBonusTiers: [{ minimum: "0", bonusBps: 0 }, { minimum: "1", bonusBps: 1000 }], seasonPlanWeeks: 4 });
    expect(p.daily.maxLiability).toBe(11_000n * UNIT);
    expect(p.season.days).toBe(28);
    expect(p.season.dailyBaseTotal).toBe(280_000n * UNIT);
  });
});

describe("settings: a stored row of the superseded per-battle design is UPGRADED on read", () => {
  const legacy = { enabled: true, holderTiers: [{ minimum: "0", rewardedWins: 1 }, { minimum: "100000", rewardedWins: 2 }], minimumClaim: "25000", rewardPerBattle: "10000", weeklyPrizePool: "100000", dailyEmissionCap: null, minConfirmations: 3, holderMaxAgeHours: 6, weeklyPrizeSplitBps: [5000, 3000, 2000], holderCheckBatchSize: 40, holderRefreshMinutes: 30, pointsPerCorrectPick: 10, holderRefreshJitterPct: 20, weeklyScoredPicksPerDay: 20, walletChangeFreshMinutes: 15, weeklyMinimumScoredPicks: 20, holderTierActivationHours: 24, holderManualRefreshSeconds: 300 };
  it("the retired keys disappear, the economy takes the FINAL numbers, and operational knobs the admin tuned survive", () => {
    const up = parseSettings("arena_picks", legacy);
    expect(up).not.toHaveProperty("rewardPerBattle");
    expect(up).not.toHaveProperty("holderTiers");
    expect(up).not.toHaveProperty("scoredPicksPerDay"); // no per-day scoring cap exists any more
    expect(up).toMatchObject({ dailyPrizePool: "200000", weeklyPrizePool: "1000000", weeklyMinimumPicks: 100, dailyMinimumPicks: 20, minimumClaim: "25000", minConfirmations: 3, holderCheckBatchSize: 40 });
    expect(up.prizeSplitBps).toEqual([3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200]);
    expect(up.holderBonusTiers.map((t) => t.bonusBps)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });
  it("a stored per-day scoring limit (and the old minimums) is RETIRED, not carried over; a row already in the new shape is untouched; garbage is left to fail validation", () => {
    const up = parseSettings("arena_picks", { ...legacy, weeklyScoredPicksPerDay: 30, weeklyMinimumScoredPicks: 20, scoredPicksPerDay: 20, dailyMinimumScoredPicks: 10 });
    expect(up).not.toHaveProperty("scoredPicksPerDay");
    expect(up).not.toHaveProperty("weeklyScoredPicksPerDay");
    expect(up).toMatchObject({ dailyMinimumPicks: 20, weeklyMinimumPicks: 100 });
    expect(upgradeLegacyArenaPicks(DEFAULT_SETTINGS.arena_picks)).toBe(DEFAULT_SETTINGS.arena_picks);
    expect(upgradeLegacyArenaPicks(null)).toBeNull();
    expect(() => parseSettings("arena_picks", "nope")).toThrow();
  });
  it("cross-field rules: a freshness window shorter than twice the refresh, a free tier with a bonus and an over-100 % ladder are refused; a participation minimum is NOT capped (there is no daily cap)", () => {
    const base = DEFAULT_SETTINGS.arena_picks;
    expect(parseSettings("arena_picks", { ...base, dailyMinimumPicks: 500, weeklyMinimumPicks: 5000 })).toMatchObject({ dailyMinimumPicks: 500, weeklyMinimumPicks: 5000 });
    expect(parseSettings("arena_picks", { ...base, scoredPicksPerDay: 20 })).not.toHaveProperty("scoredPicksPerDay"); // an old row carrying the retired key is upgraded: the key is dropped, never honoured
    expect(() => parseSettings("arena_picks", { ...base, holderRefreshMinutes: 60, holderMaxAgeHours: 1 })).toThrow(/twice the refresh/);
    expect(() => parseSettings("arena_picks", { ...base, holderBonusTiers: [{ minimum: "0", bonusBps: 100 }] })).toThrow(/FREE/);
    expect(() => parseSettings("arena_picks", { ...base, holderBonusTiers: [{ minimum: "0", bonusBps: 0 }, { minimum: "100", bonusBps: 900 }, { minimum: "200", bonusBps: 500 }] })).toThrow(/smaller bonus/);
    expect(() => parseSettings("arena_picks", { ...base, prizeSplitBps: [6000, 5000] })).toThrow();
  });
});
