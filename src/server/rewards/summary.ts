import { formatTokenAmount, LOGICAL_DECIMALS } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import type { Queryable } from "../db/types";

import type { BoardRuleView } from "@/domain/rewards/leaderboardDto";

import { claimView, CLAIM_COLS, type ClaimRow } from "./claims";
import { getHolderCard, type HolderCardDto } from "./holders";
import { boardRules, getMemberPeriodStats, type MemberPeriodStats } from "./leaderboard";
import { getPointsSummary, type PointsSummary } from "./points";
import { DENIAL_REASONS, type DenialReason, type ClaimStatus, type DestinationKind } from "@/domain/rewards/claims";
import { eligibilityExplanation, getRewardEligibility, publicIneligibleReason, type PublicIneligibleReason } from "./eligibility";
import { getRewardAccount } from "./ledger";
import { minimumClaimMicro, REWARD_SYMBOL } from "./pool";

/** Player-facing reward data. Display strings only; nothing here exposes another member, an internal flag or a secret. */
export { shortAddress } from "./format";
import { shortAddress } from "./format";

export interface PickStats {
  totalPicks: number;
  correctPicks: number;
  /** Whole percent of resolved (non-void) picks that were correct; null before the first one. */
  accuracy: number | null;
  currentStreak: number;
  bestStreak: number;
}

export async function getPickStats(q: Queryable, userId: number): Promise<PickStats> {
  const rows = await q.query<{ result: "CORRECT" | "INCORRECT" }>(
    // Only Picks of a season that COUNTS (an official season, or the one being played): the archived pre-season's Picks never count, so a member who made 500 of them
    // begins Season 1 with 0 Picks, 0 correct and no streak.
    `select p.result from public.arena_picks p join public.arena_battles b on b.id = p.battle_id
      where p.telegram_user_id = $1 and p.result in ('CORRECT', 'INCORRECT') and b.season_id in (select z.id from public.seasons z where public.season_counts(z.id))
      order by p.settled_at asc, p.battle_id asc limit 20000`,
    [userId],
  );
  let best = 0;
  let run = 0;
  let correct = 0;
  for (const r of rows) {
    if (r.result === "CORRECT") {
      correct++;
      run++;
      best = Math.max(best, run);
    } else run = 0; // a wrong pick resets the streak — nothing else is affected
  }
  return { totalPicks: rows.length, correctPicks: correct, accuracy: rows.length ? Math.round((correct / rows.length) * 100) : null, currentStreak: run, bestStreak: best };
}

export interface RewardSummaryDto {
  symbol: string;
  /** Earned and still unclaimed (excludes a claim already in flight). */
  claimable: string;
  /** Reserved by a claim that is not finished yet. */
  pending: string;
  /** Sent: paid out by hand and verified on-chain. */
  claimed: string;
  /** Everything earned: claimable + pending + sent. */
  totalEarned: string;
  minimumClaim: string;
  belowMinimum: boolean;
  /** Claims can run right now (token launched and verified, nothing blocking). Rewards accumulate either way — before the token launches they simply stay CLAIMABLE (NOT_LAUNCHED), never denied. */
  claimsAvailable: boolean;
  /** Why CLAIM is not offered, in player terms; never an internal reason. */
  claimsNote: "NOT_LAUNCHED" | "UNAVAILABLE" | "HELD" | "BELOW_MINIMUM" | "NOT_ELIGIBLE" | "PENDING" | null;
  /** The signature-verified HOLDER wallet (short form only). It is not a payout destination: every claim names its own. */
  holderWallet: { short: string | null };
  /** The member's claim waiting for payment (or null). */
  pendingClaim: PlayerClaimDto | null;
  /** Newest first: PENDING / SENT / DENIED with safe explanations. */
  claimHistory: PlayerClaimDto[];
  /** Newest first: the credits that built the balance — Daily / Weekly leaderboard prizes, holder bonuses (kept apart), adjustments. */
  latestRewards: LatestRewardDto[];
  /** The Daily and Weekly rules, and the member's OWN standing in each running period: picks, correct, accuracy, Points and rank (every valid pick counts — no daily cap). */
  boards: { daily: BoardRuleView; weekly: BoardRuleView };
  periodStats: { daily: MemberPeriodStats; weekly: MemberPeriodStats };
  eligibility: { eligible: boolean; reason: PublicIneligibleReason | null; explanation: string };
  /** HOLDER REWARD BONUS: the tier of the last verified balance, the Daily / Weekly bonus status and qualification progress, the tier ladder. */
  holder: HolderCardDto;
  /** Points (off-chain): today's and this week's leaderboard Points, and lifetime Clank Points. */
  points: PointsSummary;
}

export interface PlayerClaimDto {
  id: string;
  status: ClaimStatus;
  amount: string;
  /** Short destination only (0x1234…abcd). */
  destination: string;
  destinationKind: DestinationKind;
  txHash: string | null;
  /** Short transaction hash. */
  txShort: string | null;
  requestedAt: number;
  /** Safe, player-facing reason for a DENIED claim — never internal reasoning. */
  denial: { label: string; message: string } | null;
}

export interface LatestRewardDto {
  /** Coarse source for display; never a raw internal ledger kind. A holder bonus is its own line, apart from the prize it rode on. */
  kind: "DAILY_LEADERBOARD" | "WEEKLY_LEADERBOARD" | "HOLDER_BONUS" | "ADJUSTMENT";
  /** "DAILY #1", "WEEKLY #4", "10M HOLDER BONUS", "ADJUSTMENT". */
  label: string;
  /** The board a prize or bonus belongs to ("Daily" / "Weekly") and the period's start date — null for an adjustment. */
  board: "Daily" | "Weekly" | null;
  period: string | null;
  amount: string;
  at: number;
}

type LedgerRewardKind = "DAILY_LEADERBOARD_BASE_REWARD" | "DAILY_LEADERBOARD_HOLDER_BONUS" | "WEEKLY_LEADERBOARD_BASE_REWARD" | "WEEKLY_LEADERBOARD_HOLDER_BONUS" | "ADMIN_ADJUSTMENT";

export function latestRewardOf(kind: LedgerRewardKind, meta: { rank?: number; tier?: string } | null, amount: string, at: number, period: string | null): LatestRewardDto {
  if (kind === "ADMIN_ADJUSTMENT") return { kind: "ADJUSTMENT", label: "ADJUSTMENT", board: null, period: null, amount, at };
  const board = kind.startsWith("DAILY") ? "Daily" : "Weekly";
  if (kind.endsWith("HOLDER_BONUS")) return { kind: "HOLDER_BONUS", label: `${meta?.tier ?? ""} HOLDER BONUS`.trim(), board, period, amount, at };
  return { kind: board === "Daily" ? "DAILY_LEADERBOARD" : "WEEKLY_LEADERBOARD", label: `${board.toUpperCase()} #${meta?.rank ?? "?"}`, board, period, amount, at };
}

export const toPlayerClaim = (r: ClaimRow): PlayerClaimDto => {
  const v = claimView(r);
  return {
    id: v.id,
    status: v.status,
    amount: v.amount,
    destination: shortAddress(v.destination) ?? "",
    destinationKind: v.destinationKind,
    txHash: v.txHash,
    txShort: shortHash(v.txHash),
    requestedAt: v.requestedAt,
    denial: v.denialReason ? { label: DENIAL_REASONS[v.denialReason as DenialReason].publicLabel, message: DENIAL_REASONS[v.denialReason as DenialReason].publicMessage } : null,
  };
};

const shortHash = (h: string | null): string | null => (h ? `${h.slice(0, 6)}…${h.slice(-4)}` : null);

export async function getRewardSummary(q: Queryable, userId: number, ctx: { settings: GameSettings; token: { launched: boolean; decimals: number | null }; claimsEnabled: boolean; allowDemo: boolean; holdersAvailable: boolean; nowMs: number }): Promise<RewardSummaryDto> {
  const [account, eligibility] = await Promise.all([
    getRewardAccount(q, userId),
    getRewardEligibility(q, userId, { threshold: ctx.settings.telegram.qualifyingThreshold, allowDemo: ctx.allowDemo }),
  ]);
  const claimRows = await q.query<ClaimRow>(`select ${CLAIM_COLS} from public.arena_reward_claims where telegram_user_id = $1 order by requested_at desc limit 20`, [userId]);
  const rewardRows = await q.query<{ kind: LedgerRewardKind; claimable_delta: string; created_at: Date; period_start: string | null; meta: { rank?: number; tier?: string } | null }>(
    `select kind, claimable_delta::text, created_at, period_start::text, meta from public.arena_reward_ledger
      where telegram_user_id = $1 and kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS', 'ADMIN_ADJUSTMENT') and claimable_delta > 0
      order by id desc limit 12`,
    [userId],
  );
  const minimum = minimumClaimMicro(ctx.settings);
  const fmt = (n: bigint) => formatTokenAmount(n, LOGICAL_DECIMALS);
  const held = account.reviewState !== "NORMAL" || eligibility.reviewState !== "NORMAL";
  const belowMinimum = account.claimable > 0n && account.claimable < minimum;
  const hasPending = claimRows.some((c) => c.status === "PENDING");
  const claimsNote: RewardSummaryDto["claimsNote"] = hasPending ? "PENDING" : !ctx.token.launched ? "NOT_LAUNCHED" : !ctx.claimsEnabled ? "UNAVAILABLE" : !eligibility.eligible ? "NOT_ELIGIBLE" : held ? "HELD" : belowMinimum || account.claimable === 0n ? "BELOW_MINIMUM" : null;
  return {
    symbol: REWARD_SYMBOL,
    claimable: fmt(account.claimable),
    pending: fmt(account.reserved),
    claimed: fmt(account.claimed),
    totalEarned: fmt(account.earned),
    minimumClaim: fmt(minimum),
    belowMinimum,
    claimsAvailable: claimsNote === null,
    claimsNote,
    holderWallet: { short: account.walletVerifiedAt ? shortAddress(account.holderWallet) : null },
    pendingClaim: claimRows.find((c) => c.status === "PENDING") ? toPlayerClaim(claimRows.find((c) => c.status === "PENDING") as ClaimRow) : null,
    claimHistory: claimRows.map((c) => toPlayerClaim(c)),
    latestRewards: rewardRows.map((r) => latestRewardOf(r.kind, r.meta, fmt(BigInt(r.claimable_delta)), new Date(r.created_at).getTime(), r.period_start)),
    boards: { daily: boardRules(ctx.settings, "DAILY"), weekly: boardRules(ctx.settings, "WEEKLY") },
    periodStats: { daily: await getMemberPeriodStats(q, userId, ctx.settings, "DAILY", ctx.nowMs), weekly: await getMemberPeriodStats(q, userId, ctx.settings, "WEEKLY", ctx.nowMs) },
    eligibility: { eligible: eligibility.eligible, reason: publicIneligibleReason(eligibility.reason), explanation: eligibilityExplanation(eligibility.threshold) },
    holder: await getHolderCard(q, userId, ctx.settings, ctx.token, ctx.nowMs, ctx.holdersAvailable),
    points: await getPointsSummary(q, userId, ctx.nowMs),
  };
}

export interface PickHistoryRow {
  /** The battle the pick NAMED (the upcoming battle at the time of the pick) — never the battle that happened to be on stage. */
  battleId: string;
  /** When the battle settled (ms); for a pick that is still waiting, when it was made. */
  at: number;
  picked: { characterId: string; publicId: string; name: string };
  /** The authoritative #1 of THIS battle; null until it is decided. */
  winner: { characterId: string; publicId: string; name: string } | null;
  /** Null while the battle the pick names has not been settled: see `phase`. */
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  /**
   * Only on a pick that has no result yet: UPCOMING = the fight it names has not taken the stage yet (its picks may still be open
   * or already locked); FIGHTING = that fight is on stage now. Absent once the pick is resolved.
   */
  phase?: "UPCOMING" | "FIGHTING";
  /** Lifetime Clank Points this pick earned (0 for a wrong, void or still-waiting pick). */
  points: number;
  /** Every valid pick counts toward the Daily and Weekly boards: the Points this one added (10 when correct, 0 when wrong). Null until the battle is scored. */
  leaderboard: { points: number } | null;
}

/**
 * The member's recent picks, newest first. Picks that are still waiting for their fight (UPCOMING / FIGHTING) come FIRST, so the
 * history reads  "UPCOMING PICK · Rin Okumura"  →  later  "Rin Okumura · winner Rin Okumura · CORRECT · +10". Every row is keyed on the
 * battle the pick NAMED and shows the winner of THAT battle (`arena_picks.battle_id` is always the predicted battle), so a result can
 * never be shown against the neighbouring fight. Nothing about the unresolved battle beyond the member's own choice is revealed.
 */
export async function listPickHistory(q: Queryable, userId: number, limit = 25, nowMs: number = Date.now()): Promise<PickHistoryRow[]> {
  const rows = await q.query<{ battle_id: string; settled_at: Date | null; submitted_at: Date; starts_at: Date; character_id: string; picked_public: string; picked_name: string; winner_id: string | null; winner_public: string | null; winner_name: string | null; result: "CORRECT" | "INCORRECT" | "VOID" | null; points: number | null; score_id: string | null; board_points: number | null }>(
    `select p.battle_id, p.settled_at, p.submitted_at, b.starts_at, p.character_id, pc.public_id as picked_public, coalesce(pc.name_override, pc.name) as picked_name,
            case when p.result is null then null else b.winner_id end as winner_id,
            case when p.result is null then null else wc.public_id end as winner_public,
            case when p.result is null then null else coalesce(wc.name_override, wc.name) end as winner_name, p.result,
            (select l.points from public.arena_points_ledger l where l.telegram_user_id = p.telegram_user_id and l.battle_id = p.battle_id and l.kind = 'ARENA_PICK_CORRECT') as points,
            sc.id as score_id, sc.points as board_points
       from public.arena_picks p
       join public.arena_battles b on b.id = p.battle_id
       join public.characters pc on pc.id = p.character_id
       left join public.characters wc on wc.id = b.winner_id
       left join public.arena_pick_scores sc on sc.battle_id = p.battle_id and sc.telegram_user_id = p.telegram_user_id
      where p.telegram_user_id = $1 and b.season_id in (select z.id from public.seasons z where public.season_counts(z.id))
      order by (p.result is null) desc, coalesce(p.settled_at, p.submitted_at) desc, p.battle_id desc limit $2`,
    [userId, Math.min(Math.max(limit, 1), 100)],
  );
  return rows.map((r): PickHistoryRow => {
    const waiting = r.result === null;
    return {
      battleId: r.battle_id,
      at: new Date((waiting ? r.submitted_at : r.settled_at) as Date).getTime(),
      picked: { characterId: r.character_id, publicId: r.picked_public, name: r.picked_name },
      winner: !waiting && r.winner_id ? { characterId: r.winner_id, publicId: r.winner_public ?? "", name: r.winner_name ?? "—" } : null,
      result: r.result,
      ...(waiting ? { phase: new Date(r.starts_at).getTime() > nowMs ? ("UPCOMING" as const) : ("FIGHTING" as const) } : {}),
      points: Number(r.points ?? 0),
      leaderboard: r.score_id === null ? null : { points: Number(r.board_points ?? 0) },
    };
  });
}

export interface PickRoundDto {
  /**
   * Present once the member's own pick has been resolved. (Whether the battle's pick window is closed, and the crowd once it is, are
   * NOT decided here: the pick window is the arena's rule — domain/arena/picksWindow.ts — and /api/arena/picks adds both.)
   */
  outcome: {
    result: "CORRECT" | "INCORRECT" | "VOID";
    winnerCharacterId: string | null;
    /** Lifetime Clank Points earned for this pick. */
    points: number;
    /**
     * The leaderboards (this one pick feeds BOTH the Daily and the Weekly board, and every valid pick counts): the leaderboard Points it
     * added (10 when correct, 0 when wrong). Null until the battle is scored.
     */
    board: { points: number } | null;
    /** `pending` while the scoring settlement has not run yet (it runs seconds after the battle settles). */
    pending: boolean;
    /** The member's claimable balance now (display). */
    claimable: string;
  } | null;
}

export async function getPickRound(q: Queryable, userId: number | null, battleId: string): Promise<PickRoundDto> {
  const [battle] = await q.query<{ status: string; winner_id: string | null }>("select status, winner_id from public.arena_battles where id = $1", [battleId]);
  const over = battle?.status === "SETTLED" || battle?.status === "VOID";
  let outcome: PickRoundDto["outcome"] = null;
  if (userId !== null && over) {
    const [mine] = await q.query<{ result: "CORRECT" | "INCORRECT" | "VOID" | null }>("select result from public.arena_picks where battle_id = $1 and telegram_user_id = $2", [battleId, userId]);
    if (mine?.result) {
      const [settled] = await q.query("select 1 from public.arena_pick_settlements where battle_id = $1", [battleId]);
      const [pts] = await q.query<{ points: number }>("select points from public.arena_points_ledger where telegram_user_id = $1 and battle_id = $2 and kind = 'ARENA_PICK_CORRECT'", [userId, battleId]);
      const [wk] = await q.query<{ points: number }>("select points from public.arena_pick_scores where telegram_user_id = $1 and battle_id = $2", [userId, battleId]);
      const account = await getRewardAccount(q, userId);
      outcome = {
        result: mine.result,
        winnerCharacterId: battle?.winner_id ?? null,
        points: Number(pts?.points ?? 0),
        board: wk ? { points: Number(wk.points) } : null,
        // A pick whose scoring settlement has not run yet (it runs seconds after the battle settles).
        pending: !settled,
        claimable: formatTokenAmount(account.claimable, LOGICAL_DECIMALS),
      };
    }
  }
  return { outcome };
}
