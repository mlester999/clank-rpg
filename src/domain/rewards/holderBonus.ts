import type { ArenaPicksSettings } from "@/domain/settings";

import { firstPeriodStartAtOrAfter, type PeriodKind } from "./time";
import { parseTokenAmount } from "./tokens";

/**
 * HOLDER PRIZE BONUS. Holding $CLANKRPG changes exactly ONE thing: a percentage BONUS added to a leaderboard prize the member
 * already earned on merit. It never touches picks, scored picks, Points, accuracy, rank, tie-breaks, POWER or combat, and it is
 * extra — it never reduces any other player's base prize.
 *
 * VERIFIED HOLDING CONTINUITY (what the bonus requires). Tokens are NOT locked in a contract, so nobody can prove a wallet held
 * "every second". What the server CAN prove is a chain of authoritative `balanceOf` reads on the official token: the wallet was
 * observed at or above the tier's threshold at EVERY check from before the period began until the final close verification,
 * and no two consecutive checks were further apart than the freshness window (`holderMaxAgeHours`) — an unverified gap proves
 * nothing, so continuity restarts. Everything here is pure: the observations are rows the server wrote; no browser value is read.
 */
export interface BonusTier {
  index: number;
  /** Smallest verified balance (base units) for this tier. */
  minimumRaw: bigint;
  /** Bonus on an earned prize, in basis points (2500 = +25%). */
  bonusBps: number;
  /** "FREE", "100K", "1M", … */
  label: string;
}

/** 100000 → "100K", 1000000 → "1M", 5500000 → "5.5M". */
export function compactWholeTokens(whole: bigint): string {
  const fmt = (n: bigint, unit: bigint, suffix: string) => {
    const tenths = (n * 10n) / unit;
    return `${tenths / 10n}${tenths % 10n === 0n ? "" : `.${tenths % 10n}`}${suffix}`;
  };
  if (whole >= 1_000_000_000n) return fmt(whole, 1_000_000_000n, "B");
  if (whole >= 1_000_000n) return fmt(whole, 1_000_000n, "M");
  if (whole >= 1_000n) return fmt(whole, 1_000n, "K");
  return whole.toString();
}

export function buildBonusTiers(settings: Pick<ArenaPicksSettings, "holderBonusTiers">, decimals: number): BonusTier[] {
  return settings.holderBonusTiers.map((t, index) => {
    const minimumRaw = parseTokenAmount(t.minimum, decimals);
    const whole = minimumRaw / 10n ** BigInt(decimals);
    return { index, minimumRaw, bonusBps: t.bonusBps, label: minimumRaw === 0n ? "FREE" : compactWholeTokens(whole) };
  });
}

/** The highest tier whose minimum the balance reaches. Always defined (the first tier starts at 0). */
export function tierForBalance(tiers: readonly BonusTier[], balanceRaw: bigint): BonusTier {
  let best = tiers[0] as BonusTier;
  for (const t of tiers) if (balanceRaw >= t.minimumRaw) best = t;
  return best;
}

export const tierName = (t: BonusTier): string => (t.minimumRaw === 0n ? "FREE" : `${t.label} HOLDER`);
/** "+15%" — whole percents show no decimals ("+7.5%" for 750 bps). */
export const bonusPercentLabel = (bps: number): string => `+${Number.isInteger(bps / 100) ? bps / 100 : (bps / 100).toFixed(2).replace(/0+$/, "")}%`;
export const maxBonusBps = (tiers: readonly BonusTier[]): number => tiers.reduce((m, t) => Math.max(m, t.bonusBps), 0);

/** The bonus on a base prize: `floor(base × bps / 10000)` — exact integer maths (30,000 × 25% = 7,500). */
export const applyBonus = (baseMicro: bigint, bonusBps: number): bigint => (baseMicro * BigInt(bonusBps)) / 10_000n;

/** For the UI: every tier with display data. */
export function bonusTierTable(tiers: readonly BonusTier[]): Array<{ index: number; label: string; name: string; bonusBps: number; bonus: string }> {
  return tiers.map((t) => ({ index: t.index, label: t.label, name: tierName(t), bonusBps: t.bonusBps, bonus: bonusPercentLabel(t.bonusBps) }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Continuity: evidence → qualification
// ---------------------------------------------------------------------------------------------------------------------

/** One authoritative balance read of the member's CURRENT holder wallet (a row the server wrote; never browser input). Ascending by time. */
export interface Observation {
  atMs: number;
  balanceRaw: bigint;
}

export type RunBreak = "BELOW_THRESHOLD" | "GAP" | "START_OF_EVIDENCE";

export interface Run {
  /** The first observation of the unbroken run (the earliest moment continuity is PROVEN). */
  sinceMs: number;
  /** Observations in the run. */
  observations: number;
  /** The smallest balance seen in the run. */
  minBalanceRaw: bigint;
  /** The longest gap between two consecutive observations inside the run. */
  longestGapMs: number;
  /** Why the run does not extend further back. */
  endedBy: RunBreak;
}

/**
 * The unbroken run of observations that ENDS at `endIdx` and stays at/above `thresholdRaw` with no gap longer than `maxGapMs`.
 * Null when the observation at `endIdx` itself is below the threshold.
 */
export function runEndingAt(obs: readonly Observation[], endIdx: number, thresholdRaw: bigint, maxGapMs: number): Run | null {
  const end = obs[endIdx];
  if (!end || end.balanceRaw < thresholdRaw) return null;
  let start = endIdx;
  let min = end.balanceRaw;
  let longest = 0;
  let endedBy: RunBreak = "START_OF_EVIDENCE";
  for (let k = endIdx - 1; k >= 0; k--) {
    const o = obs[k] as Observation;
    const next = obs[k + 1] as Observation;
    if (o.balanceRaw < thresholdRaw) {
      endedBy = "BELOW_THRESHOLD";
      break;
    }
    const gap = next.atMs - o.atMs;
    if (gap > maxGapMs) {
      endedBy = "GAP";
      break;
    }
    longest = Math.max(longest, gap);
    if (o.balanceRaw < min) min = o.balanceRaw;
    start = k;
  }
  return { sinceMs: (obs[start] as Observation).atMs, observations: endIdx - start + 1, minBalanceRaw: min, longestGapMs: longest, endedBy };
}

export interface PeriodTerms {
  /** The period's start (ms). The qualification window must have been complete BEFORE this. */
  startsAtMs: number;
  /** The period's end (ms). The final close verification must be taken at/after this. */
  endsAtMs: number;
  /** Required verified continuity BEFORE the period starts (24 h for a day, 7 d for a week). */
  requiredMs: number;
  maxGapMs: number;
}

export interface TierEvaluation {
  tierIndex: number;
  qualifies: boolean;
  /** Start of the unbroken run that ends at the close observation (null when none). */
  sinceMs: number | null;
  /** The instant by which continuity had to already be proven (period start − required). */
  neededSinceMs: number;
  reason: "QUALIFIED" | "BELOW_THRESHOLD_AT_CLOSE" | "RUN_TOO_RECENT" | "NO_CLOSE_OBSERVATION";
  observations: number;
  minBalanceRaw: string | null;
  longestGapMs: number | null;
}

/** Does the wallet qualify for `tier` for the period? `closeIdx` is the close observation (the first one at/after the period end), or -1 when there is none. */
function evaluateTier(obs: readonly Observation[], tier: BonusTier, terms: PeriodTerms, closeIdx: number): TierEvaluation {
  const neededSinceMs = terms.startsAtMs - terms.requiredMs;
  const base = { tierIndex: tier.index, neededSinceMs };
  if (closeIdx < 0) return { ...base, qualifies: false, sinceMs: null, reason: "NO_CLOSE_OBSERVATION", observations: 0, minBalanceRaw: null, longestGapMs: null };
  const run = runEndingAt(obs, closeIdx, tier.minimumRaw, terms.maxGapMs);
  if (!run) return { ...base, qualifies: false, sinceMs: null, reason: "BELOW_THRESHOLD_AT_CLOSE", observations: 0, minBalanceRaw: null, longestGapMs: null };
  const qualifies = run.sinceMs <= neededSinceMs;
  return { ...base, qualifies, sinceMs: run.sinceMs, reason: qualifies ? "QUALIFIED" : "RUN_TOO_RECENT", observations: run.observations, minBalanceRaw: run.minBalanceRaw.toString(), longestGapMs: run.longestGapMs };
}

export interface BonusEvidence {
  /** The close observation (ms) — the first authoritative read at/after the period ended — or null when there is none yet. */
  closeAtMs: number | null;
  closeBalanceRaw: string | null;
  observationsConsidered: number;
  requiredMs: number;
  maxGapMs: number;
  tiers: TierEvaluation[];
}

/**
 * A DECIMALS-FREE necessary condition: every run starts at or after the wallet's first read, so when that first read is later than
 * `period start − required continuity` (or there is none) NO tier can qualify, whatever the balances were. Used only when the token
 * contract cannot be verified (its decimals() are needed to compare balances with tier minimums): such a winner is settled NONE at
 * once instead of waiting for a verification that cannot help.
 */
export const cannotHaveQualified = (observations: readonly Observation[], terms: PeriodTerms): boolean =>
  observations.length === 0 || (observations[0] as Observation).atMs > terms.startsAtMs - terms.requiredMs;

export type BonusDecision =
  | { kind: "QUALIFIED"; tier: BonusTier; evidence: BonusEvidence }
  /** Not qualified (never held long enough, dropped below, or a gap broke continuity). The base prize is untouched. */
  | { kind: "NONE"; evidence: BonusEvidence }
  /** No close verification exists yet but a tier COULD still qualify once one succeeds: the bonus waits (limited window); the base prize does not. */
  | { kind: "PENDING_VERIFICATION"; evidence: BonusEvidence };

/**
 * The bonus tier a prize winner earns for a period, decided from the evidence — ONCE, at finalization (or at reconciliation when
 * the close verification had failed). The HIGHEST tier whose continuity holds wins; a lower tier still qualifies when the wallet
 * continuously held at least that much, even if a higher tier's continuity broke (10M → 5M keeps the 5M bonus if every check
 * stayed ≥ 5M). Buying near the close can never qualify: the run would have started too recently.
 */
export function decideBonus(input: { tiers: readonly BonusTier[]; observations: readonly Observation[]; terms: PeriodTerms }): BonusDecision {
  const { tiers, observations: obs, terms } = input;
  const closeIdx = obs.findIndex((o) => o.atMs >= terms.endsAtMs);
  const paying = tiers.filter((t) => t.index > 0 && t.bonusBps > 0).sort((a, b) => b.index - a.index);
  const evals = paying.map((t) => evaluateTier(obs, t, terms, closeIdx));
  const evidenceBase = { closeAtMs: closeIdx >= 0 ? (obs[closeIdx] as Observation).atMs : null, closeBalanceRaw: closeIdx >= 0 ? (obs[closeIdx] as Observation).balanceRaw.toString() : null, observationsConsidered: obs.length, requiredMs: terms.requiredMs, maxGapMs: terms.maxGapMs };

  if (closeIdx >= 0) {
    const winner = evals.find((e) => e.qualifies);
    const evidence: BonusEvidence = { ...evidenceBase, tiers: evals };
    return winner ? { kind: "QUALIFIED", tier: tiers[winner.tierIndex] as BonusTier, evidence } : { kind: "NONE", evidence };
  }
  // No close read yet. Could ANY tier qualify if the last read stands in for it? If not, there is nothing to wait for.
  const last = obs.length - 1;
  const provisional = last < 0 ? [] : paying.map((t) => evaluateTier(obs, t, terms, last));
  const evidence: BonusEvidence = { ...evidenceBase, tiers: evals.map((e, i) => (provisional[i]?.qualifies ? { ...e, reason: "NO_CLOSE_OBSERVATION" as const, sinceMs: provisional[i]?.sinceMs ?? null } : e)) };
  return provisional.some((e) => e.qualifies) ? { kind: "PENDING_VERIFICATION", evidence } : { kind: "NONE", evidence };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the member sees RIGHT NOW (profile card): the status of the bonus for the period that is running
// ---------------------------------------------------------------------------------------------------------------------
export type BonusStatus =
  /** The bonus would pay if the period closed now (continuity proven from before it began, unbroken, fresh). */
  | "QUALIFIED"
  /** Holding a paying tier, but continuity is not old enough for THIS period — it counts for a future one. */
  | "QUALIFYING"
  /** Was qualified when the period began, but a below-threshold check or an unverified gap broke it during the period. */
  | "BROKEN"
  /** The last verification is older than the freshness window: nothing can be assumed until the next check. */
  | "NEEDS_VERIFICATION"
  /** No wallet, FREE balance, or nothing observed. */
  | "NONE";

export interface LiveBonus {
  status: BonusStatus;
  /** The tier the status is about: QUALIFIED = the tier that would PAY now; QUALIFYING/BROKEN/NEEDS_VERIFICATION = the tier the balance holds. */
  tierIndex: number;
  /** QUALIFIED while a HIGHER tier than the one paying is still qualifying (e.g. paying 100K while 1M accumulates). */
  upgradingToIndex: number | null;
  /** When the unbroken run of the tier in question began (ms), if any. */
  sinceMs: number | null;
  /** How long it has been held, and how long the period requires. */
  heldMs: number;
  requiredMs: number;
  /** QUALIFYING: the first period (start, ms) this holding can count for. */
  eligibleFromMs: number | null;
  /** BROKEN: when and why. */
  brokenAtMs: number | null;
  brokenBy: RunBreak | null;
}

/** First observation after `fromIdx` that breaks continuity for `thresholdRaw` (a drop below, or a gap > maxGap), or null. */
function firstBreakAfter(obs: readonly Observation[], fromIdx: number, thresholdRaw: bigint, maxGapMs: number): { atMs: number; by: RunBreak } | null {
  for (let k = fromIdx + 1; k < obs.length; k++) {
    const o = obs[k] as Observation;
    const prev = obs[k - 1] as Observation;
    if (o.atMs - prev.atMs > maxGapMs) return { atMs: o.atMs, by: "GAP" };
    if (o.balanceRaw < thresholdRaw) return { atMs: o.atMs, by: "BELOW_THRESHOLD" };
  }
  return null;
}

/**
 * Where does the member stand for the CURRENT period of `kind`? Computed from the same evidence the finalization uses, so the
 * card never promises what the close would not pay. `terms.endsAtMs` is not used (the period is still running).
 */
export function liveBonus(input: { tiers: readonly BonusTier[]; observations: readonly Observation[]; kind: PeriodKind; terms: PeriodTerms; nowMs: number }): LiveBonus {
  const { tiers, observations: obs, terms, nowMs, kind } = input;
  const none: LiveBonus = { status: "NONE", tierIndex: 0, upgradingToIndex: null, sinceMs: null, heldMs: 0, requiredMs: terms.requiredMs, eligibleFromMs: null, brokenAtMs: null, brokenBy: null };
  const lastIdx = obs.length - 1;
  const last = obs[lastIdx];
  if (!last) return none;
  const observed = tierForBalance(tiers, last.balanceRaw);
  const neededSinceMs = terms.startsAtMs - terms.requiredMs;
  const paying = tiers.filter((t) => t.index > 0 && t.bonusBps > 0);
  const stale = nowMs - last.atMs > terms.maxGapMs;

  const runs = paying.map((t) => ({ tier: t, run: runEndingAt(obs, lastIdx, t.minimumRaw, terms.maxGapMs) }));
  const observedRun = runs.find((r) => r.tier.index === observed.index)?.run ?? null;
  const heldMs = observedRun ? Math.max(0, nowMs - observedRun.sinceMs) : 0;
  const common = { requiredMs: terms.requiredMs, heldMs };

  if (stale) {
    // Do not assume anything from stale data — but remember what the last verified state was.
    return { ...none, ...common, status: observed.index > 0 ? "NEEDS_VERIFICATION" : "NONE", tierIndex: observed.index, sinceMs: observedRun?.sinceMs ?? null };
  }

  const qualifying = runs.filter((r) => r.run && r.run.sinceMs <= neededSinceMs).sort((a, b) => b.tier.index - a.tier.index);
  const best = qualifying[0];
  if (best) {
    const upgrading = observed.index > best.tier.index ? observed.index : null;
    const upgradingRun = upgrading !== null ? observedRun : null;
    return { status: "QUALIFIED", tierIndex: best.tier.index, upgradingToIndex: upgrading, sinceMs: best.run?.sinceMs ?? null, heldMs: Math.max(0, nowMs - (best.run?.sinceMs ?? nowMs)), requiredMs: terms.requiredMs, eligibleFromMs: upgradingRun ? firstPeriodStartAtOrAfter(kind, upgradingRun.sinceMs + terms.requiredMs) : null, brokenAtMs: null, brokenBy: null };
  }
  if (observed.index === 0 || paying.length === 0) {
    // Below every paying tier now — was a bonus lost during this period?
    const lost = lostDuringPeriod(obs, tiers, terms);
    return lost ? { ...none, ...common, status: "BROKEN", tierIndex: lost.tierIndex, brokenAtMs: lost.atMs, brokenBy: lost.by } : { ...none, ...common };
  }
  // Holding a paying tier whose continuity is too young for this period.
  const lost = lostDuringPeriod(obs, tiers, terms);
  if (lost && lost.tierIndex >= observed.index) return { ...none, ...common, status: "BROKEN", tierIndex: lost.tierIndex, sinceMs: observedRun?.sinceMs ?? null, brokenAtMs: lost.atMs, brokenBy: lost.by };
  const eligibleFromMs = observedRun ? firstPeriodStartAtOrAfter(kind, observedRun.sinceMs + terms.requiredMs) : null;
  return { status: "QUALIFYING", tierIndex: observed.index, upgradingToIndex: null, sinceMs: observedRun?.sinceMs ?? null, heldMs, requiredMs: terms.requiredMs, eligibleFromMs, brokenAtMs: null, brokenBy: null };
}

/**
 * Was the member qualified for some paying tier when the period began, and did that qualification break afterwards? The highest
 * such tier is reported. "Qualified at the start" = the last observation at/before the start is fresh enough to stand for the start
 * and its run reaches back past (start − required).
 */
function lostDuringPeriod(obs: readonly Observation[], tiers: readonly BonusTier[], terms: PeriodTerms): { tierIndex: number; atMs: number; by: RunBreak } | null {
  let enteringIdx = -1;
  for (let i = 0; i < obs.length; i++) if ((obs[i] as Observation).atMs <= terms.startsAtMs) enteringIdx = i;
  const entering = obs[enteringIdx];
  if (!entering || terms.startsAtMs - entering.atMs > terms.maxGapMs) return null;
  const neededSinceMs = terms.startsAtMs - terms.requiredMs;
  const paying = tiers.filter((t) => t.index > 0 && t.bonusBps > 0).sort((a, b) => b.index - a.index);
  for (const t of paying) {
    const run = runEndingAt(obs, enteringIdx, t.minimumRaw, terms.maxGapMs);
    if (!run || run.sinceMs > neededSinceMs) continue;
    const broke = firstBreakAfter(obs, enteringIdx, t.minimumRaw, terms.maxGapMs);
    if (broke) return { tierIndex: t.index, atMs: broke.atMs, by: broke.by };
    // Unbroken through the last observation: nothing was lost.
    return null;
  }
  return null;
}
