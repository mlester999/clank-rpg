import { distributePrizeGroups } from "./rewards/leaderboard";

/**
 * HERO ARENA — the pure rules of the HERO competition (a reward program completely separate from Arena Picks).
 *
 *  · The ONLY ranking metric is ARENA WINS: the number of SETTLED Arena battles the hero finished #1 in, inside the period AND the season.
 *    PWR, rarity, class, wallet balance, holdings and Telegram activity never enter it — not as a tiebreaker either.
 *  · Heroes with the same number of wins are an EXACT TIE: the same rank, and a prize that straddles the tie is POOLED and split equally
 *    (`distributePrizeGroups`, the one tie rule Arena Picks uses too). The order of tied heroes on screen (name, then id) is display only.
 *  · A hero with fewer than `minimumWins` wins (default 1) is on the board but earns no prize — a prize for zero wins would be nonsense.
 *  · Statistics that are NOT rewarded (Top-2, KOs, PWR) are ranked by their own metric with the same competition ranking, and never carry a prize.
 */
export type HeroScope = "DAILY" | "WEEKLY" | "SEASON";
export const HERO_SCOPES: readonly HeroScope[] = ["DAILY", "WEEKLY", "SEASON"];
export const isHeroScope = (v: unknown): v is HeroScope => v === "DAILY" || v === "WEEKLY" || v === "SEASON";

/** Which scopes of each competition pay. Season is standings only (no season payout exists, by decision). */
export const REWARDED_SCOPES: readonly HeroScope[] = ["DAILY", "WEEKLY"];
export const isRewardedScope = (scope: HeroScope): boolean => scope === "DAILY" || scope === "WEEKLY";

/** The statistic boards of HERO RECORDS (none of them pays). Wins live on HERO ARENA — one rewarded home, no duplicate screen. */
export type RecordMetric = "TOP2" | "KOS" | "PWR";
export const RECORD_METRICS: readonly RecordMetric[] = ["TOP2", "KOS", "PWR"];
export const isRecordMetric = (v: unknown): v is RecordMetric => v === "TOP2" || v === "KOS" || v === "PWR";
export const RECORD_LABEL: Record<RecordMetric, string> = { TOP2: "Top-2", KOS: "KOs", PWR: "PWR" };

/** What a hero did in a period / season (all from settled battles). */
export interface HeroStat {
  characterId: string;
  /** Display order inside an exact tie ONLY (never a rank factor). */
  name: string;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
}

export interface HeroRanked<T extends HeroStat> {
  row: T;
  /** Competition rank ("1, 1, 3"): 1 + the number of heroes strictly ahead. */
  rank: number;
  /** How many heroes share exactly this metric value. */
  tieSize: number;
  prizeEligible: boolean;
}

/** Win rate in basis points, floored (0 with no matches). */
export const winRateBps = (wins: number, matches: number): number => (matches <= 0 ? 0 : Math.floor((wins * 10_000) / matches));
/** Percent with ONE decimal for display, rounded ("37.5"). */
export const winRatePercent = (wins: number, matches: number): number => (matches <= 0 ? 0 : Math.round((wins * 1000) / matches) / 10);

/**
 * Orders heroes by ONE metric (descending) and attaches competition rank and tie size. Total and deterministic; the final name / id order only fixes the
 * display order inside an exact tie — it confers no rank, no prize and no advantage.
 */
export function rankByMetric<T extends HeroStat>(rows: readonly T[], metric: (row: T) => number, minimumForPrize = Number.POSITIVE_INFINITY): Array<HeroRanked<T>> {
  const sorted = [...rows].sort((a, b) => metric(b) - metric(a) || a.name.localeCompare(b.name) || a.characterId.localeCompare(b.characterId));
  const out: Array<HeroRanked<T>> = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i] as T;
    const prev = out[i - 1];
    const rank = prev && metric(prev.row) === metric(row) ? prev.rank : i + 1;
    out.push({ row, rank, tieSize: 1, prizeEligible: metric(row) >= minimumForPrize && metric(row) > 0 });
  }
  for (let i = 0; i < out.length; ) {
    let j = i + 1;
    while (j < out.length && metric((out[j] as HeroRanked<T>).row) === metric((out[i] as HeroRanked<T>).row)) j++;
    for (let k = i; k < j; k++) (out[k] as HeroRanked<T>).tieSize = j - i;
    i = j;
  }
  return out;
}

/** The rewarded ranking: ARENA WINS, prizes for heroes with at least `minimumWins`. */
export const rankHeroArena = <T extends HeroStat>(rows: readonly T[], minimumWins: number): Array<HeroRanked<T>> => rankByMetric(rows, (r) => r.wins, Math.max(1, minimumWins));

export interface HeroPrizeResult {
  /** characterId → micro-tokens (0n entries are omitted). */
  prizeOf: Map<string, bigint>;
  /** The pool not awarded to a position (unfilled positions, tie-split remainders). */
  returnedMicro: bigint;
}

/**
 * The prize of every prize-eligible hero. `ranked` is the full ranking (`rankHeroArena`); heroes tied on wins share the SUM of the positions they occupy,
 * equally, and the integer remainder returns to the reserve. Nobody is ever paid more because of PWR, rarity or holdings — they are not inputs.
 */
export function distributeHeroPrizes<T extends HeroStat>(ranked: ReadonlyArray<HeroRanked<T>>, poolMicro: bigint, ladderBps: readonly number[]): HeroPrizeResult {
  const eligible = ranked.filter((r) => r.prizeEligible);
  const winsOf = new Map(eligible.map((r) => [r.row.characterId, r.row.wins]));
  const r = distributePrizeGroups(
    eligible.map((e) => ({ key: e.row.characterId })),
    (a, b) => winsOf.get(a) === winsOf.get(b),
    poolMicro,
    ladderBps,
  );
  return { prizeOf: new Map(r.awards.filter((a) => a.prizeMicro > 0n).map((a) => [a.key, a.prizeMicro])), returnedMicro: r.returnedMicro };
}

/** Whether a Hero Arena prize pool has been configured (null = "REWARD POOL NOT SET": nothing is invented, nothing is paid). */
export const poolIsSet = (pool: string | null | undefined): pool is string => typeof pool === "string" && pool.trim() !== "";
