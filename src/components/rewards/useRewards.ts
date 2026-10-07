"use client";

import { useCallback, useEffect, useState } from "react";

import type { HolderCardDto } from "@/domain/rewards/holderDto";
import type { BoardRuleView } from "@/domain/rewards/leaderboardDto";
import { api } from "@/lib/api";

/** Mirrors the server's reward DTOs (server/rewards/summary.ts). Display strings only. */
export type ClaimStatus = "PENDING" | "SENT" | "DENIED";
export interface ClaimInfo {
  id: string;
  status: ClaimStatus;
  amount: string;
  /** Short destination only (0x1234…abcd). */
  destination: string;
  destinationKind: "HOLDER_WALLET" | "CUSTOM";
  txHash: string | null;
  txShort: string | null;
  requestedAt: number;
  /** A SAFE, player-facing explanation of a DENIED claim — never internal reasoning. */
  denial: { label: string; message: string } | null;
}

export interface LatestReward {
  kind: "DAILY_LEADERBOARD" | "WEEKLY_LEADERBOARD" | "HOLDER_BONUS" | "ADJUSTMENT";
  /** "DAILY #1", "WEEKLY #4", "10M HOLDER BONUS", "ADJUSTMENT". */
  label: string;
  board: "Daily" | "Weekly" | null;
  period: string | null;
  amount: string;
  at: number;
}

export type { BonusStatusDto, HolderCardDto } from "@/domain/rewards/holderDto";

export interface PointsInfo {
  dayStart: string;
  dayEndsAt: number;
  weekStart: string;
  weekEndsAt: number;
  /** Today's leaderboard score (the Daily board ranks this). */
  today: number;
  /** This week's leaderboard score (the Weekly board ranks this). */
  weekly: number;
  /** Every correct pick ever (unlimited, never reset). */
  lifetime: number;
}

/** Mirrors server/rewards/leaderboard.ts `MemberPeriodStats`. */
export interface PeriodStatsInfo {
  kind: "DAILY" | "WEEKLY";
  start: string;
  endsAt: number;
  picks: number;
  correct: number;
  /** Percent correct, one decimal (null with no picks). */
  accuracy: number | null;
  points: number;
  rank: number | null;
  prizeEligible: boolean;
  picksToEligible: number;
  minimumPicks: number;
}

export interface RewardsSummary {
  symbol: string;
  claimable: string;
  /** Reserved by a claim waiting for a manual payout. */
  pending: string;
  /** Sent: paid out by hand and verified on-chain. */
  claimed: string;
  totalEarned: string;
  minimumClaim: string;
  belowMinimum: boolean;
  claimsAvailable: boolean;
  claimsNote: "NOT_LAUNCHED" | "UNAVAILABLE" | "HELD" | "BELOW_MINIMUM" | "NOT_ELIGIBLE" | "PENDING" | null;
  /** The signature-verified HOLDER wallet (short form). Not a payout destination: every claim names its own. */
  holderWallet: { short: string | null };
  pendingClaim: ClaimInfo | null;
  claimHistory: ClaimInfo[];
  latestRewards: LatestReward[];
  /** The Daily and Weekly rules. */
  boards: { daily: BoardRuleView; weekly: BoardRuleView };
  /** The member's OWN standing in the running Daily and Weekly period (every valid pick counts — no daily cap). */
  periodStats: { daily: PeriodStatsInfo; weekly: PeriodStatsInfo };
  eligibility: { eligible: boolean; reason: "NO_HERO" | "BELOW_THRESHOLD" | "NOT_ELIGIBLE" | null; explanation: string };
  /** HOLDER REWARD BONUS: the tier of the last verified balance, the Daily / Weekly bonus status and the tier ladder. */
  holder: HolderCardDto;
  points: PointsInfo;
}

export interface PickStats {
  totalPicks: number;
  correctPicks: number;
  accuracy: number | null;
  currentStreak: number;
  bestStreak: number;
}

export interface PickHistoryRow {
  battleId: string;
  at: number;
  picked: { characterId: string; publicId: string; name: string };
  winner: { characterId: string; publicId: string; name: string } | null;
  /** Null while the battle the pick NAMES has not been settled (see `phase`). */
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  /** Only on a pick without a result: UPCOMING = the fight it names has not started yet; FIGHTING = it is on stage now. */
  phase?: "UPCOMING" | "FIGHTING";
  /** Lifetime Clank Points this pick earned. */
  points: number;
  /** Every valid pick counts toward the Daily and Weekly boards: the Points this one added (null until scored). */
  leaderboard: { points: number } | null;
}

export interface RewardsPayload {
  rewards: RewardsSummary;
  stats: PickStats;
  history: PickHistoryRow[];
  freshAuthMinutes: number;
}

/** The signed-in member's own Arena Picks stats, rewards and history. While a claim waits for its manual payout it re-checks every 30 seconds. */
export function useRewards(enabled = true) {
  const [data, setData] = useState<RewardsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const r = await api<RewardsPayload>("/api/me/rewards");
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.status === 503 ? "UNAVAILABLE" : r.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api<RewardsPayload>("/api/me/rewards").then((r) => {
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setError(r.status === 503 ? "UNAVAILABLE" : r.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const active = Boolean(data?.rewards.pendingClaim);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void reload(), 30_000);
    return () => clearInterval(t);
  }, [active, reload]);

  return { data, error, loading, reload };
}
