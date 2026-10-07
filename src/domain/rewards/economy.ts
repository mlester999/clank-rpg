import type { ArenaPicksSettings } from "@/domain/settings";

import { applyBonus, buildBonusTiers, maxBonusBps } from "./holderBonus";
import { formatTokenAmount, LOGICAL_DECIMALS, parseTokenAmount } from "./tokens";

/**
 * THE REWARD ECONOMY, as numbers an operator can plan against. Because no token is emitted per battle, the worst case is a
 * PRODUCT of settings — not of player behaviour:
 *
 *   max liability of a board = base pool + the largest holder bonus on every base prize actually awarded
 *                            = pool × (1 + maxBonusBps / 10000)
 *
 * Nothing here mints, reserves or moves a token. It is an Admin planning metric (and the single source for the docs' numbers).
 */
export interface BoardEconomy {
  basePool: bigint;
  /** The most holder bonuses can add on top of the base pool (every prize at the top tier). */
  maxBonusExposure: bigint;
  maxLiability: bigint;
}

export interface EconomyPlan {
  maxBonusBps: number;
  daily: BoardEconomy;
  weekly: BoardEconomy;
  season: {
    weeks: number;
    days: number;
    dailyBaseTotal: bigint;
    weeklyBaseTotal: bigint;
    /** Daily + weekly base pools over the whole season (no holder bonus). */
    baseMaximum: bigint;
    /** The same with the top bonus on every prize. */
    maximumWithBonuses: bigint;
    allocation: bigint;
    /** allocation − maximumWithBonuses (negative = the season could exceed its allocation). */
    buffer: bigint;
    fits: boolean;
  };
}

const board = (pool: bigint, bps: number): BoardEconomy => {
  const maxBonusExposure = applyBonus(pool, bps);
  return { basePool: pool, maxBonusExposure, maxLiability: pool + maxBonusExposure };
};

export function economyPlan(settings: Pick<ArenaPicksSettings, "dailyPrizePool" | "weeklyPrizePool" | "holderBonusTiers" | "seasonPlanWeeks" | "seasonRewardAllocation">): EconomyPlan {
  const decimals = LOGICAL_DECIMALS; // planning is in LOGICAL tokens, independent of any contract
  const bps = maxBonusBps(buildBonusTiers(settings, decimals));
  const dailyPool = parseTokenAmount(settings.dailyPrizePool, decimals);
  const weeklyPool = parseTokenAmount(settings.weeklyPrizePool, decimals);
  const weeks = settings.seasonPlanWeeks;
  const days = weeks * 7;
  const dailyBaseTotal = dailyPool * BigInt(days);
  const weeklyBaseTotal = weeklyPool * BigInt(weeks);
  const baseMaximum = dailyBaseTotal + weeklyBaseTotal;
  const maximumWithBonuses = baseMaximum + applyBonus(baseMaximum, bps);
  const allocation = parseTokenAmount(settings.seasonRewardAllocation, decimals);
  return {
    maxBonusBps: bps,
    daily: board(dailyPool, bps),
    weekly: board(weeklyPool, bps),
    season: { weeks, days, dailyBaseTotal, weeklyBaseTotal, baseMaximum, maximumWithBonuses, allocation, buffer: allocation - maximumWithBonuses, fits: maximumWithBonuses <= allocation },
  };
}

/** Display strings for the Admin dashboard. */
export function economyPlanView(plan: EconomyPlan) {
  const f = (n: bigint) => (n < 0n ? `-${formatTokenAmount(-n, LOGICAL_DECIMALS)}` : formatTokenAmount(n, LOGICAL_DECIMALS));
  const b = (x: BoardEconomy) => ({ basePool: f(x.basePool), maxBonusExposure: f(x.maxBonusExposure), maxLiability: f(x.maxLiability) });
  return {
    maxBonusPercent: plan.maxBonusBps / 100,
    daily: b(plan.daily),
    weekly: b(plan.weekly),
    season: {
      weeks: plan.season.weeks,
      days: plan.season.days,
      dailyBaseTotal: f(plan.season.dailyBaseTotal),
      weeklyBaseTotal: f(plan.season.weeklyBaseTotal),
      baseMaximum: f(plan.season.baseMaximum),
      maximumWithBonuses: f(plan.season.maximumWithBonuses),
      allocation: f(plan.season.allocation),
      buffer: f(plan.season.buffer),
      fits: plan.season.fits,
    },
  };
}
