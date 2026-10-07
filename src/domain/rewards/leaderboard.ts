/**
 * ARENA PICKS LEADERBOARDS (Daily and Weekly) — the pure rules. Everything here is deterministic integer maths on values the
 * server already holds: nothing is read from a client, a wallet or a token balance. Holdings never enter ranking, scoring or
 * the base prize ladder (a holder BONUS is computed elsewhere, on a prize that was already earned).
 *
 *  · EVERY valid pick counts — there is no per-day scoring cap. A correct pick is worth `pointsPerCorrectPick` Points; the board is a
 *    race for the most CORRECT picks over the period.
 *  · Ranking: CORRECT PICKS (desc), then ACCURACY = correct / picks (desc, compared by cross-multiplication — no floats). Points are
 *    the display score (correct × points per correct pick). Two members with the same correct picks AND the same accuracy are an
 *    exact TIE. Ties are never broken by holdings, tier, wallet age, account age, POWER, hero stats or who scored first.
 *  · Prize positions are filled by PRIZE-ELIGIBLE members only (a minimum number of valid picks). Others stay on the board,
 *    marked NOT YET PRIZE ELIGIBLE — they are never silently hidden.
 *  · An exact tie that straddles prize positions COMBINES those positions' prizes and splits them equally; the integer
 *    remainder (a few base units) goes back to the reserve, never to an arbitrary member.
 */
export interface BoardRowInput {
  userId: number;
  /** Display score: correct picks × points per correct pick. */
  points: number;
  /** Every valid pick of the period. */
  picks: number;
  correct: number;
}

export interface RankedRow<T extends BoardRowInput = BoardRowInput> {
  row: T;
  /** Competition rank among ALL participants ("1, 1, 3"): 1 + the number of members strictly ahead. */
  rank: number;
  /** Accuracy across the period's picks in basis points (0–10000), floored. */
  accuracyBps: number;
  prizeEligible: boolean;
  /** Position among PRIZE-ELIGIBLE members (competition ranking), null when not eligible. */
  prizeRank: number | null;
  /** How many members share exactly this (correct picks, accuracy). */
  tieSize: number;
}

export const accuracyBps = (correct: number, picks: number): number => (picks <= 0 ? 0 : Math.floor((correct * 10_000) / picks));
/** Percent with ONE decimal for display, ROUNDED ("59.6"): 28 correct of 47 picks → 59.6, 188 of 321 → 58.6. */
export const accuracyPercent = (correct: number, picks: number): number => (picks <= 0 ? 0 : Math.round((correct * 1000) / picks) / 10);
/** The same display figure from a FROZEN basis-points value (what a finished board stores). */
export const bpsToPercent = (bps: number): number => Math.round(bps / 10) / 10;

/** a before b? (-1), after (1), exact tie (0). Correct picks first, then accuracy (correct/picks, cross-multiplied — integers, no floats); no picks = accuracy 0. */
export function compareBoard(a: BoardRowInput, b: BoardRowInput): number {
  if (a.correct !== b.correct) return a.correct > b.correct ? -1 : 1;
  const aNone = a.picks <= 0;
  const bNone = b.picks <= 0;
  if (aNone && bNone) return 0;
  if (aNone) return 1;
  if (bNone) return -1;
  const left = a.correct * b.picks;
  const right = b.correct * a.picks;
  return left === right ? 0 : left > right ? -1 : 1;
}

/**
 * Orders the participants and attaches rank, eligibility and tie information. The sort is total and deterministic (the final
 * `userId` order only fixes DISPLAY order inside an exact tie — it confers no rank, no prize and no advantage).
 */
export function rankBoard<T extends BoardRowInput>(rows: readonly T[], minimumPicks: number): Array<RankedRow<T>> {
  const sorted = [...rows].sort((a, b) => compareBoard(a, b) || a.userId - b.userId);
  const out: Array<RankedRow<T>> = [];
  let eligibleSeen = 0;
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i] as T;
    const prev = out[i - 1];
    const tiedWithPrev = prev !== undefined && compareBoard(prev.row, row) === 0;
    const eligible = row.picks >= minimumPicks && row.picks > 0;
    // Competition ranking over everyone, and (separately) over the prize-eligible members only.
    const rank = tiedWithPrev ? (prev as RankedRow<T>).rank : i + 1;
    let prizeRank: number | null = null;
    if (eligible) {
      const prevEligibleTied = tiedWithPrev && (prev as RankedRow<T>).prizeEligible;
      prizeRank = prevEligibleTied ? (prev as RankedRow<T>).prizeRank : eligibleSeen + 1;
      eligibleSeen++;
    }
    out.push({ row, rank, accuracyBps: accuracyBps(row.correct, row.picks), prizeEligible: eligible, prizeRank, tieSize: 1 });
  }
  for (let i = 0; i < out.length; ) {
    let j = i + 1;
    while (j < out.length && compareBoard((out[i] as RankedRow<T>).row, (out[j] as RankedRow<T>).row) === 0) j++;
    for (let k = i; k < j; k++) (out[k] as RankedRow<T>).tieSize = j - i;
    i = j;
  }
  return out;
}

export interface PrizeAward {
  userId: number;
  prizeMicro: bigint;
}

export interface PrizeResult {
  awards: PrizeAward[];
  /** Pool not awarded: unfilled positions, rounding remainders of tie splits and the floor of each position's share. */
  returnedMicro: bigint;
  /** The prize of each position (index 0 = #1), before any tie splitting. */
  positionPrizes: bigint[];
}

/** The prize of each position: `pool × bps / 10000`, floored. */
export const positionPrizes = (poolMicro: bigint, ladderBps: readonly number[]): bigint[] => ladderBps.map((bps) => (poolMicro * BigInt(bps)) / 10_000n);

/**
 * THE tie rule of every prize ladder, independent of what is being ranked. `eligible` must already be in rank order. A tie group (as judged by
 * `sameRank`) occupying positions a..b receives the SUM of those positions' prizes divided equally (integer division); what does not divide returns
 * to the reserve. If a tie group reaches past the last rewarded position, the whole group shares the positions that exist (nobody tied for a
 * rewarded rank is left out). Positions past the ladder win nothing. Keys are opaque (a Telegram id for Arena Picks, a hero id for Hero Arena).
 */
export function distributePrizeGroups<K>(eligible: ReadonlyArray<{ key: K }>, sameRank: (a: K, b: K) => boolean, poolMicro: bigint, ladderBps: readonly number[]): { awards: Array<{ key: K; prizeMicro: bigint }>; returnedMicro: bigint; positionPrizes: bigint[] } {
  const prizes = positionPrizes(poolMicro, ladderBps);
  const awards: Array<{ key: K; prizeMicro: bigint }> = [];
  let paid = 0n;
  for (let i = 0; i < eligible.length; ) {
    if (i >= prizes.length) break;
    let j = i + 1;
    while (j < eligible.length && sameRank((eligible[i] as { key: K }).key, (eligible[j] as { key: K }).key)) j++;
    let total = 0n;
    for (let pos = i; pos < j && pos < prizes.length; pos++) total += prizes[pos] as bigint;
    const each = total / BigInt(j - i);
    for (let k = i; k < j; k++) awards.push({ key: (eligible[k] as { key: K }).key, prizeMicro: each });
    paid += each * BigInt(j - i);
    i = j;
  }
  return { awards, returnedMicro: poolMicro - paid, positionPrizes: prizes };
}

/**
 * Distributes the pool over the PRIZE-ELIGIBLE members, who must already be in rank order (`rankBoard`). Example (100,000 pool, 30/20/15/10 %):
 * two exactly tied for #2 → positions 2+3 = 35,000 → each 17,500, and the next member takes #4 (10,000). (The tie rule itself: `distributePrizeGroups`.)
 */
export function distributePrizes(eligible: ReadonlyArray<{ userId: number; row: BoardRowInput }>, poolMicro: bigint, ladderBps: readonly number[]): PrizeResult {
  const byUser = new Map(eligible.map((e) => [e.userId, e.row]));
  const r = distributePrizeGroups(
    eligible.map((e) => ({ key: e.userId })),
    (a, b) => compareBoard(byUser.get(a) as BoardRowInput, byUser.get(b) as BoardRowInput) === 0,
    poolMicro,
    ladderBps,
  );
  return { awards: r.awards.map((a) => ({ userId: a.key, prizeMicro: a.prizeMicro })), returnedMicro: r.returnedMicro, positionPrizes: r.positionPrizes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Countdown: the browser shows time remaining, but the CANONICAL period and "now" come from the server
// ---------------------------------------------------------------------------------------------------------------------
export interface CountdownParts {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  /** The period has ended (the UI must re-fetch: a new period is already running). */
  done: boolean;
}

export function countdownParts(remainingMs: number): CountdownParts {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return { days: Math.floor(total / 86_400), hours: Math.floor((total % 86_400) / 3_600), minutes: Math.floor((total % 3_600) / 60), seconds: total % 60, done: total <= 0 };
}

const two = (n: number): string => String(n).padStart(2, "0");
/**
 * WEEKLY: "6D 23H 59M 59S", and at zero "00D 00H 00M 00S". DAILY (`withDays: false`): "14H 23M 18S", and at zero "00H 00M 00S"
 * (a day never shows days — hours simply run from 23 down).
 */
export function formatCountdown(p: CountdownParts, opts: { withDays?: boolean } = {}): string {
  const withDays = opts.withDays ?? true;
  const hms = `${two(p.hours)}H ${two(p.minutes)}M ${two(p.seconds)}S`;
  return withDays ? `${p.days < 1 ? "00" : String(p.days)}D ${hms}` : hms;
}

/**
 * Converts the server's clock into the browser's monotonic clock once, at fetch time. After that the displayed time never
 * depends on the user's wall clock (skewed, wrong timezone, edited mid-session): `serverNow = anchor + (monotonicNow − atFetch)`.
 */
export interface ServerClock {
  serverNowAtFetch: number;
  monotonicAtFetch: number;
}
export const anchorServerClock = (serverNow: number, monotonicNow: number): ServerClock => ({ serverNowAtFetch: serverNow, monotonicAtFetch: monotonicNow });
export const serverNowFrom = (clock: ServerClock, monotonicNow: number): number => clock.serverNowAtFetch + (monotonicNow - clock.monotonicAtFetch);
