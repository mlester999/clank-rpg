import { ACTIVE_CLAIM_STATUSES, DENIAL_REASONS, type DenialReason } from "@/domain/rewards/claims";
import { economyPlan, economyPlanView } from "@/domain/rewards/economy";
import { isVerificationStale } from "@/domain/rewards/holderSchedule";
import { bpsToPercent } from "@/domain/rewards/leaderboard";
import { applyBonus, bonusPercentLabel, buildBonusTiers, liveBonus, tierForBalance, tierName, type BonusStatus, type LiveBonus, type Observation } from "@/domain/rewards/holderBonus";
import type { BoardRuleView } from "@/domain/rewards/leaderboardDto";
import { PAYOUT_CLAIM_STATUSES, type PayoutClaimStatus, type PayoutDto, type PayoutRowDto } from "@/domain/rewards/payout";
import { periodWindow, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, formatTokenPlain, LOGICAL_DECIMALS, logicalToRaw, parseTokenAmount } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { json, type Db, type Queryable } from "../db/types";
import { audit } from "../services/admin";
import { AdminError } from "../services/admin";

import type { RewardChainReader, TokenHealth } from "./chain";
import { denyClaim, markClaimSent } from "./claims";
import { retiredEnvPresent } from "./config";
import type { TokenStatus } from "./context";
import type { TokenMetadataView } from "./tokenMetadata";
import { computeHolderLive, EVIDENCE_DISPLAY_EXTRA_MS, liveTerms } from "./holders";
import { auditRewardAccounts, lockRewardAccount, postRewardLedger, rewardTotals } from "./ledger";
import { boardRules, COUNTING_SEASON_SCORE, expirePendingBonus, getLiveBoard, reconcileBonus, resolveHeldPrize } from "./leaderboard";
import { REWARD_SYMBOL } from "./pool";

/**
 * ARENA PICKS — operations view for admins. Everything here may show internal state (Telegram ids, wallets, balances, holder
 * continuity evidence, review reasons, why claims are off); none of it is ever served to players. The only writes are audited:
 * review state, a wallet exception, an ADMIN_ADJUSTMENT ledger entry, a manual claim decision (SENT with a verified transaction,
 * or DENIED with a reason), the resolution of a leaderboard prize held for review, and the reconciliation of a holder bonus
 * that was pending verification.
 */
const ACTIVE_SQL = ACTIVE_CLAIM_STATUSES.map((s) => `'${s}'`).join(", ");
const clampLimit = (n: number | undefined): number => Math.min(Math.max(Math.trunc(n ?? 50) || 50, 1), 200);
const HOUR = 3_600_000;

export interface RewardsOverview {
  /** Leaderboard PRIZES on/off (picks and scoring continue either way). */
  prizesEnabled: boolean;
  minimumClaim: string;
  /** Holder verification and manual-payout verification can run (token configured, chain readable). */
  token: { launched: boolean; available: boolean; reasons: string[]; adapter: string | null; chainId: number | null; address: string | null; treasury: string | null };
  eligibleMembers: number;
  /** The battle picks are being made on right now (admins see the live crowd before it locks). */
  currentBattle: { id: string; picks: number; distribution: Record<string, number> } | null;
  /** What the rules COST: the maximum each board can pay (base pool + the largest holder bonus on every prize) and the Season 1 plan. No token is emitted per battle. */
  economy: ReturnType<typeof economyPlanView>;
  rules: { daily: BoardRuleView; weekly: BoardRuleView };
  /** Credited so far, all boards (base prizes and holder bonuses kept apart), and what is still held / pending. */
  awarded: { base: string; bonus: string; heldBase: string; pendingBonuses: number };
  outstanding: string;
  claimableLiability: string;
  /** Reserved by claims waiting for a manual payout. */
  reservedByClaims: string;
  /** Sent: paid out by hand and verified on-chain. */
  claimed: string;
  treasuryBalance: string | null;
  /** Treasury ÷ outstanding liabilities (null when nothing is owed or the balance is unknown). */
  coverageRatio: number | null;
  /** Manual payout queue. */
  pendingClaims: { count: number; amount: string };
  heldAccounts: number;
  warnings: string[];
  /** Expected states worth knowing about but not problems (e.g. the token has not launched yet). */
  notices: string[];
  pointsPerCorrectPick: number;
  /** Valid picks needed in the UTC day / week to be eligible for a Daily / Weekly prize. There is NO per-day scoring cap. */
  minimumPicks: { daily: number; weekly: number };
  /** The configured holder bonus ladder (the ONLY thing holdings change: a bonus on a prize already earned). */
  holderBonusTiers: Array<{ label: string; name: string; minimum: string; bonus: string }>;
  holderQualifyHours: { daily: number; weekly: number };
  holderRefreshMinutes: number;
  holderMaxAgeHours: number;
  utcReset: string;
  /** Today (UTC): picks resolved, picks that counted on the boards (every valid pick), leaderboard points and lifetime Points issued. */
  today: { totalPicks: number; correctPicks: number; boardPicks: number; leaderboardPoints: number; lifetimePointsIssued: number; participants: number };
  /** Connected holder wallets by the tier of their last VERIFIED balance (FREE = every other eligible member). */
  holderCounts: Array<{ label: string; name: string; users: number }>;
}

export async function rewardsOverview(q: Queryable, ctx: { settings: GameSettings; tokenDecimals: number | null; token: TokenStatus; reader: RewardChainReader | null; nowMs: number }): Promise<RewardsOverview> {
  const { settings } = ctx;
  const cfg = settings.arena_picks;
  const decimals = LOGICAL_DECIMALS; // every reward amount is LOGICAL; only holder balances (chain amounts) use the contract's decimals, below
  const fmt = (n: bigint) => formatTokenAmount(n, decimals);
  const totals = await rewardTotals(q);
  const outstanding = totals.claimable + totals.reserved;
  const [eligible] = await q.query<{ n: number }>(
    `select count(*)::int as n from public.telegram_users tu join public.characters c on c.telegram_user_id = tu.telegram_user_id
      where tu.status <> 'BANNED' and c.status = 'ACTIVE' and tu.qualifying_message_count >= $1 and not coalesce((select ra.review_state = 'SUSPENDED' from public.arena_reward_accounts ra where ra.telegram_user_id = tu.telegram_user_id), false)`,
    [settings.telegram.qualifyingThreshold],
  );
  // The crowd that matters is on the battle picks are MADE on: the UPCOMING one (it takes the stage after the fight in progress); with none, the one on stage.
  const [cur] = await q.query<{ id: string }>(
    `select id from public.arena_battles where status = 'SIMULATED' order by (starts_at > $1::timestamptz) desc, case when starts_at > $1::timestamptz then sequence end asc nulls last, sequence desc limit 1`,
    [new Date(ctx.nowMs).toISOString()],
  );
  let currentBattle: RewardsOverview["currentBattle"] = null;
  if (cur) {
    const rows = await q.query<{ character_id: string; n: number }>("select character_id, count(*)::int as n from public.arena_picks where battle_id = $1 group by character_id", [cur.id]);
    currentBattle = { id: cur.id, picks: rows.reduce((a, r) => a + Number(r.n), 0), distribution: Object.fromEntries(rows.map((r) => [r.character_id, Number(r.n)])) };
  }
  const [counts] = await q.query<{ pending: number; pending_micro: string; held: number; held_prizes: number; held_micro: string; pending_bonuses: number; base: string; bonus: string }>(
    `select (select count(*)::int from public.arena_reward_claims where status = 'PENDING') as pending,
            (select coalesce(sum(amount_micro), 0)::text from public.arena_reward_claims where status = 'PENDING') as pending_micro,
            (select count(*)::int from public.arena_reward_accounts where review_state <> 'NORMAL') as held,
            (select count(*)::int from public.arena_leaderboard_results where base_status = 'HELD') as held_prizes,
            (select coalesce(sum(base_prize_micro), 0)::text from public.arena_leaderboard_results where base_status = 'HELD') as held_micro,
            (select count(*)::int from public.arena_leaderboard_results where bonus_status = 'PENDING_VERIFICATION') as pending_bonuses,
            (select coalesce(sum(claimable_delta), 0)::text from public.arena_reward_ledger where kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_BASE_REWARD')) as base,
            (select coalesce(sum(claimable_delta), 0)::text from public.arena_reward_ledger where kind in ('DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_HOLDER_BONUS')) as bonus`,
  );
  // The treasury balance is a READ-ONLY reserve check (optional treasury address). A failing RPC never blocks anything.
  let balance: bigint | null = null;
  if (ctx.reader && ctx.token.treasuryAddress && ctx.tokenDecimals !== null) balance = await ctx.reader.balanceOf(ctx.token.treasuryAddress).catch(() => null);
  // The treasury balance is a CHAIN amount (raw units): compare it with the logical liabilities at the contract's decimals, never at an assumed scale.
  const outstandingRaw = ctx.tokenDecimals !== null ? logicalToRaw(outstanding, ctx.tokenDecimals).raw : null;
  const coverageRatio = balance !== null && outstandingRaw !== null && outstandingRaw > 0n ? Number((balance * 10_000n) / outstandingRaw) / 10_000 : null;

  const plan = economyPlan(cfg);
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!ctx.token.launched) notices.push("$CLANKRPG has not launched yet. Nothing waits on it: the Arena, picks, boards and finalization run normally, every holder bonus is 0 %, and prizes accumulate as claimable (claims open after launch).");
  else if (!ctx.token.available) warnings.push(`The $CLANKRPG token is configured but unusable: ${ctx.token.reasons.join("; ") || "not available"}. Holder verification and claims are off (nobody earns a holder bonus), and prizes keep accumulating.`);
  else if (ctx.tokenDecimals === null) warnings.push("The $CLANKRPG contract could not be verified (chain id, bytecode, decimals() and symbol()). Holder verification and claims stay closed until it can; the Arena and the boards are unaffected.");
  for (const r of retiredEnvPresent()) warnings.push(`${r.name} is set in the server environment: ${r.why}.`);
  if (!cfg.enabled) warnings.push("Leaderboard prizes are switched OFF (arena_picks.enabled): periods that finalize now award nothing.");
  if (ctx.token.available && ctx.token.treasuryAddress) {
    if (balance === null) warnings.push("The reward wallet's token balance could not be read (chain endpoint unreachable?).");
    else if (outstandingRaw !== null && balance < outstandingRaw) warnings.push(`Reward liabilities (${fmt(outstanding)}) exceed the reward wallet's token balance (${formatTokenAmount(balance, ctx.tokenDecimals as number)}). Top it up BEFORE paying claims.`);
    else if (coverageRatio !== null && coverageRatio < 1.25) warnings.push(`Reward wallet coverage is low (${coverageRatio.toFixed(2)}× outstanding rewards).`);
  }
  if (!plan.season.fits) warnings.push(`Season plan: the maximum payout with every holder bonus (${fmt(plan.season.maximumWithBonuses)}) exceeds the reward allocation (${fmt(plan.season.allocation)}).`);
  if (Number(counts?.pending ?? 0) > 0) warnings.push(`${counts?.pending} claim(s) are waiting for a manual payout (${fmt(BigInt(counts?.pending_micro ?? "0"))}).`);
  if (Number(counts?.held_prizes ?? 0) > 0) warnings.push(`${counts?.held_prizes} leaderboard prize(s) are held for review (${fmt(BigInt(counts?.held_micro ?? "0"))}) — release or forfeit them under Boards.`);
  if (Number(counts?.pending_bonuses ?? 0) > 0) warnings.push(`${counts?.pending_bonuses} holder bonus(es) are PENDING VERIFICATION (the close verification failed) — they are re-checked every tick and expire after ${cfg.holderReconcileHours} h.`);
  const [overdue] = await q.query<{ n: number }>(
    `select count(*)::int as n from public.arena_reward_accounts ra left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id
      where ra.wallet_verified_at is not null and (hs.telegram_user_id is null or hs.next_check_at < $1::timestamptz)`,
    [new Date(ctx.nowMs - cfg.holderRefreshMinutes * 60_000 * 2).toISOString()],
  );
  if (Number(overdue?.n ?? 0) > 0) warnings.push(`${overdue?.n} connected holder wallet(s) are more than ${cfg.holderRefreshMinutes * 2} min overdue for verification (raise holderCheckBatchSize, or check the tick / chain RPC) — an unverified gap longer than ${cfg.holderMaxAgeHours} h breaks continuity.`);

  // Tiers for DISPLAY use the logical scale (whole tokens); tiers compared with CHAIN balances use the contract's decimals (none = nobody can be tiered yet).
  const tiers = buildBonusTiers(cfg, decimals);
  const chainTiers = ctx.tokenDecimals === null ? null : buildBonusTiers(cfg, ctx.tokenDecimals);
  const day = periodWindow("DAILY", ctx.nowMs);
  const [picksToday] = await q.query<{ total: number; correct: number }>(
    "select count(*) filter (where result in ('CORRECT', 'INCORRECT'))::int as total, count(*) filter (where result = 'CORRECT')::int as correct from public.arena_picks where settled_at >= $1::timestamptz",
    [new Date(day.startsAt).toISOString()],
  );
  const [scoredToday] = await q.query<{ scored: number; points: number; participants: number }>(
    "select count(*)::int as scored, coalesce(sum(points), 0)::int as points, count(distinct telegram_user_id)::int as participants from public.arena_pick_scores where utc_date = $1::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)",
    [day.start],
  );
  const [lifetimeToday] = await q.query<{ points: number }>("select coalesce(sum(points), 0)::int as points from public.arena_points_ledger where created_at >= $1::timestamptz and kind = 'ARENA_PICK_CORRECT' and (season_id is null or public.season_counts(season_id))", [new Date(day.startsAt).toISOString()]);
  const holderRows = await q.query<{ balance: string }>("select hs.verified_balance_raw::text as balance from public.arena_holder_status hs join public.arena_reward_accounts ra on ra.telegram_user_id = hs.telegram_user_id where ra.wallet_verified_at is not null");
  const tierOf = (balance: string): number => (chainTiers ? tierForBalance(chainTiers, BigInt(balance)).index : 0);
  const byTier = new Map<number, number>();
  for (const r of holderRows) {
    const idx = tierOf(r.balance);
    byTier.set(idx, (byTier.get(idx) ?? 0) + 1);
  }
  const holderCounts = tiers.map((t) => ({ label: t.label, name: tierName(t), users: t.index === 0 ? Math.max(Number(eligible?.n ?? 0) - holderRows.filter((r) => tierOf(r.balance) > 0).length, 0) : (byTier.get(t.index) ?? 0) }));

  return {
    prizesEnabled: cfg.enabled,
    minimumClaim: formatTokenAmount(parseTokenAmount(cfg.minimumClaim, decimals), decimals),
    token: { launched: ctx.token.launched, available: ctx.token.available, reasons: ctx.token.reasons, adapter: ctx.token.adapter, chainId: ctx.token.chainId, address: ctx.token.tokenAddress, treasury: ctx.token.treasuryAddress },
    eligibleMembers: Number(eligible?.n ?? 0),
    currentBattle,
    economy: economyPlanView(plan),
    rules: { daily: boardRules(settings, "DAILY"), weekly: boardRules(settings, "WEEKLY") },
    awarded: { base: fmt(BigInt(counts?.base ?? "0")), bonus: fmt(BigInt(counts?.bonus ?? "0")), heldBase: fmt(BigInt(counts?.held_micro ?? "0")), pendingBonuses: Number(counts?.pending_bonuses ?? 0) },
    outstanding: fmt(outstanding),
    claimableLiability: fmt(totals.claimable),
    reservedByClaims: fmt(totals.reserved),
    claimed: fmt(totals.claimed),
    treasuryBalance: balance === null ? null : fmt(balance),
    coverageRatio,
    pendingClaims: { count: Number(counts?.pending ?? 0), amount: fmt(BigInt(counts?.pending_micro ?? "0")) },
    heldAccounts: Number(counts?.held ?? 0),
    warnings,
    notices,
    pointsPerCorrectPick: cfg.pointsPerCorrectPick,
    minimumPicks: { daily: cfg.dailyMinimumPicks, weekly: cfg.weeklyMinimumPicks },
    holderBonusTiers: tiers.filter((t) => t.bonusBps > 0).map((t) => ({ label: t.label, name: tierName(t), minimum: formatTokenAmount(t.minimumRaw, decimals), bonus: bonusPercentLabel(t.bonusBps) })),
    holderQualifyHours: { daily: cfg.holderDailyQualifyHours, weekly: cfg.holderWeeklyQualifyHours },
    holderRefreshMinutes: cfg.holderRefreshMinutes,
    holderMaxAgeHours: cfg.holderMaxAgeHours,
    utcReset: "00:00 UTC",
    today: { totalPicks: Number(picksToday?.total ?? 0), correctPicks: Number(picksToday?.correct ?? 0), boardPicks: Number(scoredToday?.scored ?? 0), leaderboardPoints: Number(scoredToday?.points ?? 0), lifetimePointsIssued: Number(lifetimeToday?.points ?? 0), participants: Number(scoredToday?.participants ?? 0) },
    holderCounts,
  };
}

/** Recently SCORED battles (no token is ever attached to a battle): picks, correct pickers, how many picks counted toward the boards (every valid one). */
export async function listRecentBattles(q: Queryable, limit?: number) {
  return q.query<Record<string, unknown>>(
    `select s.battle_id, b.sequence, s.status, s.settled_at, s.picks_total, s.correct_picks, s.correct_pickers, s.valid_picks, s.points_awarded as lifetime_points,
            coalesce(wc.name_override, wc.name) as winner,
            (select json_object_agg(coalesce(pc.name_override, pc.name), x.n) from (select character_id, count(*)::int as n from public.arena_picks where battle_id = s.battle_id group by character_id) x join public.characters pc on pc.id = x.character_id) as picks_by_fighter
       from public.arena_pick_settlements s join public.arena_battles b on b.id = s.battle_id left join public.characters wc on wc.id = s.winner_character_id
      order by s.settled_at desc limit $1`,
    [clampLimit(limit)],
  );
}

export type ClaimQueueStatus = "PENDING" | "SENT" | "DENIED";

/**
 * The manual payout queue. Each row carries everything an admin needs to pay by hand and nothing editable: the frozen amount
 * and destination, whether the destination is the member's verified holder wallet or a custom address, the member's review
 * status, and how many OTHER accounts have used the same destination (a duplicate-wallet signal, never an automatic ban).
 */
/**
 * `amount` is the DISPLAY figure (grouped, truncated to 4 decimals); `amount_exact` is the frozen claim amount at FULL precision as a plain
 * decimal string of whole tokens — the figure to send; the chain check converts it to raw units at the contract's decimals() and compares
 * the transfer with that. A tie share can have up to 6 decimals, so paying the display figure would never verify.
 */
export async function listClaims(q: Queryable, opts: { status?: ClaimQueueStatus; limit?: number } = {}): Promise<Array<Record<string, unknown> & { amount: string; amount_exact: string }>> {
  const rows = await q.query<Record<string, unknown>>(
    `select c.id, c.telegram_user_id, tu.display_name, tu.username, coalesce(ch.name_override, ch.name) as hero_name, c.destination_address, c.destination_kind, c.amount_micro::text as amount_micro, c.amount_raw::text as amount_raw,
            c.token_decimals, c.status, c.tx_hash, c.requested_at, c.sent_at, c.sent_by, c.denied_at, c.denied_by, c.denial_reason, c.denial_note,
            coalesce(ra.review_state, 'NORMAL') as review_state, tu.status as telegram_status,
            (select count(distinct o.telegram_user_id)::int from public.arena_reward_claims o where o.destination_address = c.destination_address and o.telegram_user_id <> c.telegram_user_id) as other_accounts_same_destination
       from public.arena_reward_claims c
       join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.characters ch on ch.telegram_user_id = c.telegram_user_id
       left join public.arena_reward_accounts ra on ra.telegram_user_id = c.telegram_user_id
      where ($1::text is null or c.status = $1) order by c.requested_at ${opts.status === "PENDING" ? "asc" : "desc"} limit $2`,
    [opts.status ?? null, clampLimit(opts.limit)],
  );
  // The figure to send is the LOGICAL amount in whole tokens (exact, plain); the server converts it to raw units at the contract's decimals when it verifies the transaction.
  return rows.map((r) => {
    const micro = BigInt(String(r.amount_micro));
    return { ...r, amount: formatTokenAmount(micro, LOGICAL_DECIMALS), amount_exact: formatTokenPlain(micro, LOGICAL_DECIMALS), amount_micro: undefined };
  });
}

export async function claimCounts(q: Queryable): Promise<Record<ClaimQueueStatus, { count: number; amount: string }>> {
  const rows = await q.query<{ status: ClaimQueueStatus; n: number; sum: string }>("select status, count(*)::int as n, coalesce(sum(amount_micro), 0)::text as sum from public.arena_reward_claims group by status");
  const out = { PENDING: { count: 0, amount: "0" }, SENT: { count: 0, amount: "0" }, DENIED: { count: 0, amount: "0" } } as Record<ClaimQueueStatus, { count: number; amount: string }>;
  for (const r of rows) out[r.status] = { count: Number(r.n), amount: formatTokenAmount(BigInt(r.sum), LOGICAL_DECIMALS) };
  return out;
}

/** Accounts held for review, duplicate-wallet attempts, and failed / ambiguous claims — everything that needs a human. */
export async function listReview(q: Queryable) {
  const decimals = LOGICAL_DECIMALS;
  const held = await q.query<Record<string, unknown>>(
    `select ra.telegram_user_id, tu.display_name, tu.status as telegram_status, tu.flag_reason, ra.review_state, ra.review_reason, ra.review_updated_by, ra.review_updated_at, ra.holder_wallet_address, ra.claimable::text as claimable_micro
       from public.arena_reward_accounts ra join public.telegram_users tu on tu.telegram_user_id = ra.telegram_user_id
      where ra.review_state <> 'NORMAL' or tu.status = 'FLAGGED' order by ra.review_updated_at desc nulls last limit 200`,
  );
  const attempts = await q.query<Record<string, unknown>>(
    `select a.id, a.telegram_user_id, tu.display_name, a.attempted_address, a.conflicting_user_id, a.created_at
       from public.arena_reward_wallet_attempts a join public.telegram_users tu on tu.telegram_user_id = a.telegram_user_id order by a.id desc limit 100`,
  );
  // Holder wallets used by several accounts (admin-approved exceptions) and payout destinations used by several accounts.
  const sharing = await q.query<Record<string, unknown>>(
    `select holder_wallet_address as wallet, 'HOLDER' as kind, count(*)::int as accounts, array_agg(telegram_user_id order by telegram_user_id) as telegram_user_ids
       from public.arena_reward_accounts where holder_wallet_address is not null group by 1 having count(*) > 1
     union all
     select destination_address, 'DESTINATION', count(distinct telegram_user_id)::int, array_agg(distinct telegram_user_id)
       from public.arena_reward_claims group by 1 having count(distinct telegram_user_id) > 1`,
  );
  const heldPrizes = await q.query<Record<string, unknown>>(
    `select r.kind, r.period_start::text, r.telegram_user_id, r.hero_name, r.rank, r.base_prize_micro::text as prize_micro, r.bonus_micro::text as bonus_micro, r.bonus_status, r.hold_reason, r.points
       from public.arena_leaderboard_results r where r.base_status = 'HELD' order by r.period_start desc, r.kind, r.rank limit 100`,
  );
  return {
    held: held.map((r) => ({ ...r, claimable: formatTokenAmount(BigInt(String(r.claimable_micro)), decimals), claimable_micro: undefined })),
    walletAttempts: attempts,
    sharedWallets: sharing,
    heldPrizes: heldPrizes.map((r) => ({ ...r, prize: formatTokenAmount(BigInt(String(r.prize_micro)), decimals), bonus: formatTokenAmount(BigInt(String(r.bonus_micro)), decimals), prize_micro: undefined, bonus_micro: undefined })),
  };
}

/** Anti-farming observability — NEVER an automatic ban: a high accuracy alone proves nothing. */
export async function listAccounts(q: Queryable, limit?: number) {
  const decimals = LOGICAL_DECIMALS;
  const rows = await q.query<Record<string, unknown>>(
    `select tu.telegram_user_id, tu.display_name, tu.first_seen_at, tu.qualifying_message_count, tu.status as telegram_status,
            coalesce(ra.review_state, 'NORMAL') as review_state, ra.holder_wallet_address,
            (select count(*)::int from public.arena_reward_accounts o where o.holder_wallet_address is not null and o.holder_wallet_address = ra.holder_wallet_address) as accounts_on_wallet,
            p.picks, p.correct, case when p.resolved > 0 then round(100.0 * p.correct / p.resolved)::int end as accuracy,
            coalesce(ra.earned_total, 0)::text as earned_micro, coalesce(ra.claimed_total, 0)::text as claimed_micro
       from public.telegram_users tu
       join lateral (select count(*)::int as picks, count(*) filter (where result = 'CORRECT')::int as correct, count(*) filter (where result in ('CORRECT','INCORRECT'))::int as resolved
                       from public.arena_picks where telegram_user_id = tu.telegram_user_id) p on p.picks > 0
       left join public.arena_reward_accounts ra on ra.telegram_user_id = tu.telegram_user_id
      order by p.picks desc, tu.telegram_user_id limit $1`,
    [clampLimit(limit)],
  );
  return rows.map((r) => ({ ...r, earned: formatTokenAmount(BigInt(String(r.earned_micro)), decimals), claimed: formatTokenAmount(BigInt(String(r.claimed_micro)), decimals), earned_micro: undefined, claimed_micro: undefined }));
}

export interface RewardIssue {
  severity: "critical" | "warning" | "info";
  type: string;
  ref: string;
  detail: string;
}

/** Every discrepancy the reward books can have. The healthy answer is an empty list. */
export async function reconcileRewards(q: Queryable, ctx: { now: Date }): Promise<RewardIssue[]> {
  const issues: RewardIssue[] = [];
  for (const r of await auditRewardAccounts(q)) issues.push({ severity: "critical", type: "ACCOUNT_LEDGER_MISMATCH", ref: String(r.telegram_user_id), detail: `account ${r.claimable} ≠ ledger ${r.ledger_claimable}` });

  // Reserved units are exactly the pending claims' amounts.
  for (const r of await q.query<{ telegram_user_id: number; reserved: string; expected: string }>(
    `select a.telegram_user_id, a.reserved::text, coalesce((select sum(amount_micro) from public.arena_reward_claims c where c.telegram_user_id = a.telegram_user_id and c.status in (${ACTIVE_SQL})), 0)::text as expected
       from public.arena_reward_accounts a`,
  )) if (BigInt(r.reserved) !== BigInt(r.expected)) issues.push({ severity: "critical", type: "RESERVED_MISMATCH", ref: String(r.telegram_user_id), detail: `reserved ${r.reserved} ≠ pending claims ${r.expected}` });

  // Sent units are exactly the SENT claims' amounts.
  for (const r of await q.query<{ telegram_user_id: number; claimed: string; sent: string }>(
    `select a.telegram_user_id, a.claimed_total::text as claimed, coalesce((select sum(amount_micro) from public.arena_reward_claims c where c.telegram_user_id = a.telegram_user_id and c.status = 'SENT'), 0)::text as sent
       from public.arena_reward_accounts a`,
  )) if (BigInt(r.claimed) !== BigInt(r.sent)) issues.push({ severity: "critical", type: "CLAIMED_MISMATCH", ref: String(r.telegram_user_id), detail: `sent ${r.claimed} ≠ SENT claims ${r.sent}` });

  // A finalized board credited exactly its CREDITED base prizes and CREDITED holder bonuses (kept apart), and awarded + returned = the pool.
  for (const r of await q.query<{ kind: string; period_start: string; base: string; ledger_base: string; bonus: string; ledger_bonus: string }>(
    `select l.kind, l.period_start::text,
            coalesce((select sum(base_prize_micro) from public.arena_leaderboard_results x where x.kind = l.kind and x.period_start = l.period_start and x.base_status = 'CREDITED'), 0)::text as base,
            coalesce((select sum(g.claimable_delta) from public.arena_reward_ledger g where g.period_kind = l.kind and g.period_start = l.period_start and g.kind = l.kind || '_LEADERBOARD_BASE_REWARD'), 0)::text as ledger_base,
            coalesce((select sum(bonus_micro) from public.arena_leaderboard_results x where x.kind = l.kind and x.period_start = l.period_start and x.bonus_status = 'CREDITED'), 0)::text as bonus,
            coalesce((select sum(g.claimable_delta) from public.arena_reward_ledger g where g.period_kind = l.kind and g.period_start = l.period_start and g.kind = l.kind || '_LEADERBOARD_HOLDER_BONUS'), 0)::text as ledger_bonus
       from public.arena_leaderboards l`,
  )) {
    if (BigInt(r.base) !== BigInt(r.ledger_base)) issues.push({ severity: "critical", type: "BOARD_PRIZE_LEDGER_MISMATCH", ref: `${r.kind}:${r.period_start}`, detail: `credited base prizes ${r.base} ≠ ledger ${r.ledger_base}` });
    if (BigInt(r.bonus) !== BigInt(r.ledger_bonus)) issues.push({ severity: "critical", type: "BOARD_BONUS_LEDGER_MISMATCH", ref: `${r.kind}:${r.period_start}`, detail: `credited holder bonuses ${r.bonus} ≠ ledger ${r.ledger_bonus}` });
  }
  for (const r of await q.query<{ kind: string; period_start: string; awarded: string; rows: string; pool: string; returned: string }>(
    `select l.kind, l.period_start::text, l.base_awarded_micro::text as awarded, l.prize_pool_micro::text as pool, l.returned_to_reserve_micro::text as returned,
            coalesce((select sum(base_prize_micro) from public.arena_leaderboard_results x where x.kind = l.kind and x.period_start = l.period_start), 0)::text as rows
       from public.arena_leaderboards l`,
  )) if (BigInt(r.awarded) !== BigInt(r.rows)) issues.push({ severity: "critical", type: "BOARD_PRIZE_TOTAL_MISMATCH", ref: `${r.kind}:${r.period_start}`, detail: `board awarded ${r.awarded} ≠ results ${r.rows}` });

  // A bonus waiting for verification past its window should have expired or been resolved by the sweep.
  for (const r of await q.query<{ kind: string; period_start: string; telegram_user_id: number }>(
    `select r.kind, r.period_start::text, r.telegram_user_id from public.arena_leaderboard_results r join public.arena_leaderboards l on l.kind = r.kind and l.period_start = r.period_start
      where r.bonus_status = 'PENDING_VERIFICATION' and l.bonus_reconcile_until < $1::timestamptz`,
    [ctx.now.toISOString()],
  )) issues.push({ severity: "warning", type: "BONUS_PENDING_PAST_WINDOW", ref: `${r.kind}:${r.period_start}:${r.telegram_user_id}`, detail: "a holder bonus is still pending verification after its window — the sweep will expire it, or resolve it under Boards" });

  for (const c of await q.query<{ id: string }>("select id from public.arena_reward_claims where status = 'PENDING' and requested_at < $1::timestamptz", [new Date(ctx.now.getTime() - 3 * 86_400_000).toISOString()]))
    issues.push({ severity: "warning", type: "CLAIM_WAITING", ref: c.id, detail: "pending for over 3 days — pay it (Mark sent) or deny it" });
  return issues;
}

// ---------------------------------------------------------------------------------------------------------------------
// Audited writes
// ---------------------------------------------------------------------------------------------------------------------

export async function setReviewState(db: Db, userId: number, state: "NORMAL" | "REVIEW" | "SUSPENDED", reason: string, actor: string): Promise<void> {
  const text = reason.trim().slice(0, 300);
  if (state !== "NORMAL" && text.length < 3) throw new AdminError("REASON_REQUIRED", 422, "Explain why this account is held.");
  await db.transaction(async (tx) => {
    const [user] = await tx.query("select 1 from public.telegram_users where telegram_user_id = $1", [userId]);
    if (!user) throw new AdminError("NOT_FOUND", 404);
    await lockRewardAccount(tx, userId);
    await tx.query("update public.arena_reward_accounts set review_state = $2, review_reason = $3, review_updated_at = now(), review_updated_by = $4 where telegram_user_id = $1", [userId, state, state === "NORMAL" ? null : text, actor]);
    await audit(tx, actor, "rewards.review_state", "telegram_user", String(userId), { state, reason: text });
  });
}

export async function approveWalletException(db: Db, userId: number, reason: string, actor: string): Promise<void> {
  const text = reason.trim().slice(0, 300);
  if (text.length < 3) throw new AdminError("REASON_REQUIRED", 422, "Explain why sharing a wallet is legitimate.");
  await db.transaction(async (tx) => {
    const [user] = await tx.query("select 1 from public.telegram_users where telegram_user_id = $1", [userId]);
    if (!user) throw new AdminError("NOT_FOUND", 404);
    await lockRewardAccount(tx, userId);
    await tx.query("update public.arena_reward_accounts set wallet_exception = true where telegram_user_id = $1", [userId]);
    await audit(tx, actor, "rewards.wallet_exception", "telegram_user", String(userId), { reason: text });
  });
}

/** An audited ledger adjustment (credit or debit, in whole tokens). Idempotent per key; can never overdraw a balance (database CHECK). */
export async function adminAdjust(db: Db, input: { userId: number; amount: string; direction: "credit" | "debit"; reason: string; key: string }, actor: string): Promise<{ applied: boolean }> {
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 3) throw new AdminError("REASON_REQUIRED", 422, "Explain the adjustment.");
  let raw: bigint;
  try {
    raw = parseTokenAmount(input.amount, LOGICAL_DECIMALS);
  } catch {
    throw new AdminError("INVALID_AMOUNT", 422, "The amount is not a valid token amount.");
  }
  if (raw <= 0n) throw new AdminError("INVALID_AMOUNT", 422, "The amount must be greater than zero.");
  return db.transaction(async (tx) => {
    const [user] = await tx.query("select 1 from public.telegram_users where telegram_user_id = $1", [input.userId]);
    if (!user) throw new AdminError("NOT_FOUND", 404);
    await lockRewardAccount(tx, input.userId);
    const delta = input.direction === "credit" ? raw : -raw;
    let result: { applied: boolean };
    try {
      result = await postRewardLedger(tx, { userId: input.userId, kind: "ADMIN_ADJUSTMENT", claimableDelta: delta, earnedDelta: delta, meta: { reason, actor }, idempotencyKey: `admin:${input.key}` });
    } catch (e) {
      if (e instanceof Error && /insufficient claimable|cannot go negative/i.test(e.message)) throw new AdminError("WOULD_OVERDRAW", 409, "That debit is larger than the claimable balance.");
      throw e;
    }
    if (result.applied) await audit(tx, actor, "rewards.adjustment", "telegram_user", String(input.userId), { direction: input.direction, amount: input.amount, reason, key: input.key });
    return result;
  });
}

/** MARK SENT: verifies the named transaction on-chain (read-only) before the claim becomes SENT. The admin supplies only the hash. */
export async function adminMarkClaimSent(db: Db, ctx: { now: () => Date }, reader: RewardChainReader | null, settings: GameSettings, input: { claimId: string; txHash: string }, actor: string) {
  const result = await markClaimSent(db, ctx, reader, settings, { ...input, actor });
  await audit(db, actor, "rewards.claim_sent", "arena_reward_claim", input.claimId, { ok: result.ok, reason: result.ok ? null : result.reason, txHash: input.txHash.trim().toLowerCase().slice(0, 66) });
  return result;
}

/** DENY: a reason is required; the reservation returns to claimable. */
export async function adminDenyClaim(db: Db, ctx: { now: () => Date }, input: { claimId: string; reason: DenialReason; note?: string }, actor: string) {
  const result = await denyClaim(db, ctx, { ...input, actor });
  await audit(db, actor, "rewards.claim_denied", "arena_reward_claim", input.claimId, { ok: result.ok, reason: input.reason, label: DENIAL_REASONS[input.reason]?.label ?? null, note: (input.note ?? "").slice(0, 200), accountHeld: result.ok ? result.accountHeld : false });
  return result;
}

/** Releases (credits) or forfeits (returns to the reserve) a leaderboard prize that was HELD because the account was under review — its holder bonus follows it. */
export async function adminResolveHeldPrize(db: Db, ctx: { now: () => Date }, input: { kind: PeriodKind; start: string; userId: number; action: "release" | "forfeit"; reason: string }, actor: string) {
  const result = await resolveHeldPrize(db, ctx, { ...input, actor });
  await audit(db, actor, `rewards.prize_${input.action}`, "arena_leaderboard_result", `${input.kind}:${input.start}:${input.userId}`, { ok: result.ok, reason: input.reason.slice(0, 300), baseMicro: result.ok ? result.baseMicro.toString() : null, bonusMicro: result.ok ? result.bonusMicro.toString() : null });
  return result;
}

/** Re-verifies a pending holder bonus now ("reverify"), or gives up on it ("expire"). Audited; the base prize is never touched. */
export async function adminReconcileBonus(db: Db, ctx: { now: () => Date; settings: GameSettings; reader: RewardChainReader | null }, input: { kind: PeriodKind; start: string; userId: number; action: "reverify" | "expire"; reason: string }, actor: string) {
  const reason = input.reason.trim().slice(0, 300);
  if (input.action === "expire") {
    const r = await expirePendingBonus(db, ctx, { kind: input.kind, start: input.start, userId: input.userId, reason, actor });
    await audit(db, actor, "rewards.bonus_expire", "arena_leaderboard_result", `${input.kind}:${input.start}:${input.userId}`, { ok: r.ok, reason });
    return r.ok ? ({ ok: true, outcome: "EXPIRED" } as const) : ({ ok: false, reason: r.reason } as const);
  }
  const outcome = await reconcileBonus(db, { now: ctx.now, settings: ctx.settings, reader: ctx.reader }, input.kind, input.start, input.userId);
  await audit(db, actor, "rewards.bonus_reverify", "arena_leaderboard_result", `${input.kind}:${input.start}:${input.userId}`, { outcome });
  return outcome === "NOT_PENDING" ? ({ ok: false, reason: "NOT_PENDING" } as const) : ({ ok: true, outcome } as const);
}

/** The full reward view of ONE member (admin only). Never served to players. */
export async function getAccountDetail(q: Queryable, userId: number, ctx: { settings: GameSettings; tokenDecimals: number | null; nowMs: number }) {
  const { settings, nowMs } = ctx;
  const fmt = (n: bigint) => formatTokenAmount(n, LOGICAL_DECIMALS); // rewards: LOGICAL
  const fmtChain = (n: bigint): string | null => (ctx.tokenDecimals === null ? null : formatTokenAmount(n, ctx.tokenDecimals)); // balances: the contract's decimals, or unknown
  const [who] = await q.query<Record<string, unknown>>(
    `select tu.telegram_user_id, tu.display_name, tu.username, tu.status as telegram_status, tu.flag_reason, tu.first_seen_at, tu.qualifying_message_count,
            c.id as hero_id, coalesce(c.name_override, c.name) as hero_name, c.class_id, c.status as hero_status
       from public.telegram_users tu left join public.characters c on c.telegram_user_id = tu.telegram_user_id where tu.telegram_user_id = $1`,
    [userId],
  );
  if (!who) return null;
  const [acc] = await q.query<Record<string, unknown>>(
    `select claimable::text, reserved::text, claimed_total::text, earned_total::text, holder_wallet_address, wallet_verified_at, wallet_exception, review_state, review_reason, review_updated_by, review_updated_at
       from public.arena_reward_accounts where telegram_user_id = $1`,
    [userId],
  );
  const [hs] = await q.query<Record<string, unknown>>("select * from public.arena_holder_status where telegram_user_id = $1", [userId]);
  const tiers = buildBonusTiers(settings.arena_picks, ctx.tokenDecimals ?? LOGICAL_DECIMALS);
  const live = await computeHolderLive(q, userId, settings, ctx.tokenDecimals, nowMs);
  const day = periodWindow("DAILY", nowMs);
  const week = periodWindow("WEEKLY", nowMs);
  const [pts] = await q.query<{ today: number; weekly: number; lifetime: number; picks_week: number; picks_today: number }>(
    `select (select coalesce(sum(points), 0)::int from public.arena_pick_scores where telegram_user_id = $1 and utc_date = $2::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)) as today,
            (select coalesce(sum(points), 0)::int from public.arena_pick_scores where telegram_user_id = $1 and week_start = $3::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)) as weekly,
            (select coalesce(sum(points), 0)::int from public.arena_points_ledger where telegram_user_id = $1 and (season_id is null or public.season_counts(season_id))) as lifetime,
            (select count(*)::int from public.arena_pick_scores where telegram_user_id = $1 and week_start = $3::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)) as picks_week,
            (select count(*)::int from public.arena_pick_scores where telegram_user_id = $1 and utc_date = $2::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)) as picks_today`,
    [userId, day.start, week.start],
  );
  const [pk] = await q.query<{ picks: number; correct: number; resolved: number }>(
    "select count(*)::int as picks, count(*) filter (where result = 'CORRECT')::int as correct, count(*) filter (where result in ('CORRECT', 'INCORRECT'))::int as resolved from public.arena_picks where telegram_user_id = $1",
    [userId],
  );
  const observations = await q.query<Record<string, unknown>>("select o.observed_at, o.balance_raw::text as balance_raw, o.source, o.wallet_address from public.arena_holder_observations o where o.telegram_user_id = $1 order by o.id desc limit 12", [userId]);
  const results = await q.query<Record<string, unknown>>(
    "select kind, period_start::text, rank, points, base_prize_micro::text as base_micro, base_status, bonus_status, bonus_label, bonus_bps, bonus_micro::text as bonus_micro from public.arena_leaderboard_results where telegram_user_id = $1 order by period_start desc, kind limit 12",
    [userId],
  );
  const raw = (v: unknown) => BigInt(String(v ?? "0"));
  const liveRow = (l: LiveBonus) => ({ status: l.status, tier: l.tierIndex > 0 ? (tiers[l.tierIndex]?.label ?? null) : null, since: l.sinceMs, heldMs: l.heldMs, brokenAt: l.brokenAtMs, brokenBy: l.brokenBy, eligibleFrom: l.eligibleFromMs });
  return {
    identity: { telegramUserId: who.telegram_user_id, displayName: who.display_name, username: who.username, telegramStatus: who.telegram_status, flagReason: who.flag_reason, firstSeenAt: who.first_seen_at, qualifyingMessages: who.qualifying_message_count },
    hero: { id: who.hero_id, name: who.hero_name, classId: who.class_id, status: who.hero_status },
    holder: {
      wallet: acc?.holder_wallet_address ?? null,
      walletVerifiedAt: acc?.wallet_verified_at ?? null,
      observedTier: tierName(live.observed),
      verifiedBalance: hs ? fmtChain(raw(hs.verified_balance_raw)) : null,
      balanceVerifiedAt: hs?.balance_verified_at ?? null,
      lastCheckAt: hs?.last_check_at ?? null,
      nextCheckAt: hs?.next_check_at ?? null,
      checkFailures: Number(hs?.check_failures ?? 0),
      lastError: hs?.last_error ?? null,
      stale: hs ? isVerificationStale(hs.balance_verified_at ? new Date(String(hs.balance_verified_at)).getTime() : null, nowMs, settings.arena_picks.holderMaxAgeHours) : false,
      daily: liveRow(live.daily),
      weekly: liveRow(live.weekly),
      observations: observations.map((o) => ({ at: o.observed_at, balance: fmtChain(raw(o.balance_raw)), source: o.source, wallet: o.wallet_address })),
    },
    points: { today: Number(pts?.today ?? 0), weekly: Number(pts?.weekly ?? 0), lifetime: Number(pts?.lifetime ?? 0), weekStart: week.start, weekEndsAt: week.endsAt, picksToday: Number(pts?.picks_today ?? 0), picksThisWeek: Number(pts?.picks_week ?? 0) },
    picks: { total: Number(pk?.picks ?? 0), correct: Number(pk?.correct ?? 0), accuracy: Number(pk?.resolved ?? 0) > 0 ? Math.round((Number(pk?.correct) / Number(pk?.resolved)) * 100) : null },
    rewards: { claimable: fmt(raw(acc?.claimable)), reserved: fmt(raw(acc?.reserved)), claimed: fmt(raw(acc?.claimed_total)), earned: fmt(raw(acc?.earned_total)) },
    boards: results.map((r) => ({ kind: r.kind, period: r.period_start, rank: r.rank, points: r.points, base: fmt(raw(r.base_micro)), baseStatus: r.base_status, bonus: fmt(raw(r.bonus_micro)), bonusStatus: r.bonus_status, bonusTier: r.bonus_label, bonusPercent: r.bonus_bps ? bonusPercentLabel(Number(r.bonus_bps)) : null })),
    review: { state: acc?.review_state ?? "NORMAL", reason: acc?.review_reason ?? null, by: acc?.review_updated_by ?? null, at: acc?.review_updated_at ?? null, walletException: Boolean(acc?.wallet_exception) },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// HOLDER VERIFICATION and QUALIFICATION (admin only — never public)
// ---------------------------------------------------------------------------------------------------------------------
export interface HolderQualification {
  status: BonusStatus;
  tier: string | null;
  /** Start of the unbroken verified run of the tier the status is about (ms). */
  qualificationStart: number | null;
  /** When and why continuity broke during the period (null when it has not). */
  brokenAt: number | null;
  brokenBy: string | null;
  /** QUALIFYING: the first period (start, ms) this holding can count for. */
  eligibleFrom: number | null;
}

export interface HolderOverview {
  connectedWallets: number;
  dueForRefresh: number;
  /** Wallets whose next check is more than two refresh intervals overdue — their continuity is at risk (a gap over `holderMaxAgeHours` breaks it). */
  overdue: number;
  withFailures: number;
  staleOverMaxAge: number;
  holderMaxAgeHours: number;
  refreshMinutes: number;
  batchSize: number;
  accounts: Array<{
    telegramUserId: number;
    hero: string | null;
    wallet: string | null;
    balance: string;
    /** The tier of the last verified balance. */
    observedTier: string;
    lastVerifiedAt: number | null;
    nextCheckAt: number | null;
    failures: number;
    stale: boolean;
    lastError: string | null;
    daily: HolderQualification;
    weekly: HolderQualification;
  }>;
}

const qualification = (l: LiveBonus, tiers: ReadonlyArray<{ label: string }>): HolderQualification => ({
  status: l.status,
  tier: l.tierIndex > 0 ? (tiers[l.tierIndex]?.label ?? null) : null,
  qualificationStart: l.sinceMs,
  brokenAt: l.brokenAtMs,
  brokenBy: l.brokenBy,
  eligibleFrom: l.eligibleFromMs,
});

export async function holderOverview(q: Queryable, ctx: { settings: GameSettings; tokenDecimals: number | null; nowMs: number; limit?: number }): Promise<HolderOverview> {
  const cfg = ctx.settings.arena_picks;
  // Balances are CHAIN amounts: they are tiered and shown only at the contract's own decimals. Before launch / without a verified contract nobody is tiered (all FREE).
  const tiers = buildBonusTiers(cfg, ctx.tokenDecimals ?? LOGICAL_DECIMALS);
  const nowIso = new Date(ctx.nowMs).toISOString();
  const staleIso = new Date(ctx.nowMs - cfg.holderMaxAgeHours * HOUR).toISOString();
  const overdueIso = new Date(ctx.nowMs - cfg.holderRefreshMinutes * 60_000 * 2).toISOString();
  const [c] = await q.query<{ connected: number; due: number; overdue: number; failing: number; stale: number }>(
    `select (select count(*)::int from public.arena_reward_accounts where wallet_verified_at is not null) as connected,
            (select count(*)::int from public.arena_reward_accounts ra left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id where ra.wallet_verified_at is not null and (hs.telegram_user_id is null or hs.next_check_at <= $1::timestamptz)) as due,
            (select count(*)::int from public.arena_reward_accounts ra left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id where ra.wallet_verified_at is not null and (hs.telegram_user_id is null or hs.next_check_at < $3::timestamptz)) as overdue,
            (select count(*)::int from public.arena_holder_status where check_failures > 0) as failing,
            (select count(*)::int from public.arena_reward_accounts ra left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id where ra.wallet_verified_at is not null and (hs.balance_verified_at is null or hs.balance_verified_at < $2::timestamptz)) as stale`,
    [nowIso, staleIso, overdueIso],
  );
  const rows = await q.query<{ telegram_user_id: number; hero: string | null; wallet: string | null; balance: string | null; verified: Date | null; next_check: Date | null; failures: number | null; last_error: string | null }>(
    `select ra.telegram_user_id, coalesce(ch.name_override, ch.name) as hero, ra.holder_wallet_address as wallet,
            hs.verified_balance_raw::text as balance, hs.balance_verified_at as verified, hs.next_check_at as next_check, hs.check_failures as failures, hs.last_error
       from public.arena_reward_accounts ra
       left join public.arena_holder_status hs on hs.telegram_user_id = ra.telegram_user_id
       left join public.characters ch on ch.telegram_user_id = ra.telegram_user_id
      where ra.wallet_verified_at is not null order by hs.check_failures desc nulls last, hs.next_check_at nulls first limit $1`,
    [clampLimit(ctx.limit ?? 100)],
  );
  // One query for every listed member's evidence, then the SAME pure evaluation the member's own card and the finalization use.
  const dTerms = liveTerms(ctx.settings, "DAILY", ctx.nowMs);
  const wTerms = liveTerms(ctx.settings, "WEEKLY", ctx.nowMs);
  const sinceMs = Math.min(dTerms.startsAtMs - dTerms.requiredMs, wTerms.startsAtMs - wTerms.requiredMs) - wTerms.maxGapMs - EVIDENCE_DISPLAY_EXTRA_MS;
  const obsRows = rows.length
    ? await q.query<{ telegram_user_id: number; observed_at: Date; balance_raw: string }>(
        `select o.telegram_user_id, o.observed_at, o.balance_raw::text from public.arena_holder_observations o
           join public.arena_reward_accounts a on a.telegram_user_id = o.telegram_user_id and a.holder_wallet_address = o.wallet_address and o.observed_at >= a.wallet_verified_at
          where o.telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint) and o.observed_at >= $2::timestamptz
          order by o.telegram_user_id, o.observed_at, o.id`,
        [JSON.stringify(rows.map((r) => String(r.telegram_user_id))), new Date(sinceMs).toISOString()],
      )
    : [];
  const byUser = new Map<number, Observation[]>();
  for (const o of ctx.tokenDecimals === null ? [] : obsRows) {
    const list = byUser.get(Number(o.telegram_user_id)) ?? [];
    list.push({ atMs: new Date(o.observed_at).getTime(), balanceRaw: BigInt(o.balance_raw) });
    byUser.set(Number(o.telegram_user_id), list);
  }
  const fmt = (n: bigint): string => (ctx.tokenDecimals === null ? "–" : formatTokenAmount(n, ctx.tokenDecimals));
  const tierOfBalance = (raw: bigint) => (ctx.tokenDecimals === null ? (tiers[0] as (typeof tiers)[number]) : tierForBalance(tiers, raw));
  return {
    connectedWallets: Number(c?.connected ?? 0),
    dueForRefresh: Number(c?.due ?? 0),
    overdue: Number(c?.overdue ?? 0),
    withFailures: Number(c?.failing ?? 0),
    staleOverMaxAge: Number(c?.stale ?? 0),
    holderMaxAgeHours: cfg.holderMaxAgeHours,
    refreshMinutes: cfg.holderRefreshMinutes,
    batchSize: cfg.holderCheckBatchSize,
    accounts: rows.map((r) => {
      const verifiedMs = r.verified ? new Date(r.verified).getTime() : null;
      const obs = byUser.get(Number(r.telegram_user_id)) ?? [];
      return {
        telegramUserId: Number(r.telegram_user_id),
        hero: r.hero,
        wallet: r.wallet,
        balance: fmt(BigInt(r.balance ?? "0")),
        observedTier: tierName(tierOfBalance(BigInt(r.balance ?? "0"))),
        lastVerifiedAt: verifiedMs,
        nextCheckAt: r.next_check ? new Date(r.next_check).getTime() : null,
        failures: Number(r.failures ?? 0),
        stale: isVerificationStale(verifiedMs, ctx.nowMs, cfg.holderMaxAgeHours),
        lastError: r.last_error,
        daily: qualification(liveBonus({ tiers, observations: obs, kind: "DAILY", terms: dTerms, nowMs: ctx.nowMs }), tiers),
        weekly: qualification(liveBonus({ tiers, observations: obs, kind: "WEEKLY", terms: wTerms, nowMs: ctx.nowMs }), tiers),
      };
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// LEADERBOARDS (admin only)
// ---------------------------------------------------------------------------------------------------------------------
export interface BoardsAdminOverview {
  current: Record<PeriodKind, { start: string; endsAt: number; serverNow: number; remainingMs: number; prizePool: string; minimumPicks: number; participants: number; eligibleParticipants: number; reviewAccounts: number }>;
  /** Ended periods that have scores but are not finalized yet (normally none, or a few seconds' worth). */
  unfinalized: Array<{ kind: PeriodKind; start: string }>;
  finalized: Array<{ kind: PeriodKind; start: string; participants: number; eligible: number; prizePool: string; baseAwarded: string; returned: string; credited: number; held: number; forfeited: number; bonusesCredited: number; bonusTotal: string; bonusesPending: number; finalizedAt: number }>;
}

export async function boardsAdminOverview(q: Queryable, ctx: { settings: GameSettings; nowMs: number }): Promise<BoardsAdminOverview> {
  const current = {} as BoardsAdminOverview["current"];
  const unfinalized: BoardsAdminOverview["unfinalized"] = [];
  for (const kind of ["DAILY", "WEEKLY"] as const) {
    const win = periodWindow(kind, ctx.nowMs);
    const { board } = await getLiveBoard(q, { kind, nowMs: ctx.nowMs, settings: ctx.settings, limit: 1 });
    const col = kind === "DAILY" ? "s.utc_date" : "s.week_start";
    const [rev] = await q.query<{ n: number }>(
      `select count(distinct s.telegram_user_id)::int as n from public.arena_pick_scores s
         join public.telegram_users tu on tu.telegram_user_id = s.telegram_user_id left join public.arena_reward_accounts ra on ra.telegram_user_id = s.telegram_user_id
        where ${col} = $1::date and s.season_id = (select id from public.seasons where status = 'ACTIVE' limit 1) and (coalesce(ra.review_state, 'NORMAL') <> 'NORMAL' or tu.status in ('FLAGGED', 'BANNED'))`,
      [win.start],
    );
    current[kind] = { start: win.start, endsAt: win.endsAt, serverNow: ctx.nowMs, remainingMs: Math.max(win.endsAt - ctx.nowMs, 0), prizePool: board.rules.prizePool, minimumPicks: board.rules.minimumPicks, participants: board.participants, eligibleParticipants: board.eligibleParticipants, reviewAccounts: Number(rev?.n ?? 0) };
    for (const u of await q.query<{ start: string }>(`select distinct ${col}::text as start from public.arena_pick_scores s where ${col} < $1::date and not exists (select 1 from public.arena_leaderboards l where l.kind = $2 and l.period_start = ${col}) and ${COUNTING_SEASON_SCORE} order by 1`, [win.start, kind])) unfinalized.push({ kind, start: u.start });
  }
  const boards = await q.query<{ kind: PeriodKind; period_start: string; participants: number; eligible: number; pool: string; awarded: string; returned: string; credited: number; held: number; forfeited: number; bonuses: number; bonus_total: string; pending: number; finalized_at: Date }>(
    `select l.kind, l.period_start::text, l.participants, l.eligible_participants as eligible, l.prize_pool_micro::text as pool, l.base_awarded_micro::text as awarded, l.returned_to_reserve_micro::text as returned,
            (select count(*)::int from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.base_status = 'CREDITED') as credited,
            (select count(*)::int from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.base_status = 'HELD') as held,
            (select count(*)::int from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.base_status = 'FORFEITED') as forfeited,
            (select count(*)::int from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.bonus_status = 'CREDITED') as bonuses,
            (select coalesce(sum(bonus_micro), 0)::text from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.bonus_status in ('CREDITED', 'HELD')) as bonus_total,
            (select count(*)::int from public.arena_leaderboard_results r where r.kind = l.kind and r.period_start = l.period_start and r.bonus_status = 'PENDING_VERIFICATION') as pending,
            l.finalized_at
       from public.arena_leaderboards l order by l.period_start desc, l.kind limit 60`,
  );
  return {
    current,
    unfinalized,
    finalized: boards.map((w) => ({
      kind: w.kind, start: w.period_start, participants: Number(w.participants), eligible: Number(w.eligible),
      prizePool: formatTokenAmount(BigInt(w.pool), LOGICAL_DECIMALS), baseAwarded: formatTokenAmount(BigInt(w.awarded), LOGICAL_DECIMALS), returned: formatTokenAmount(BigInt(w.returned), LOGICAL_DECIMALS),
      credited: Number(w.credited), held: Number(w.held), forfeited: Number(w.forfeited), bonusesCredited: Number(w.bonuses), bonusTotal: formatTokenAmount(BigInt(w.bonus_total), LOGICAL_DECIMALS), bonusesPending: Number(w.pending), finalizedAt: new Date(w.finalized_at).getTime(),
    })),
  };
}

interface EvidenceTier { tierIndex: number; qualifies: boolean; sinceMs: number | null; neededSinceMs: number; reason: string; observations: number; minBalanceRaw: string | null; longestGapMs: number | null }
interface EvidenceJson { wallet?: string | null; decision?: string; reason?: string; tokenDecimals?: number | null; closeAtMs?: number | null; closeBalanceRaw?: string | null; observationsConsidered?: number; tiers?: EvidenceTier[] }

/** One readable line of the continuity proof (the full JSON is also returned). */
export function summarizeEvidence(ev: unknown, tierLabel: (i: number) => string): string | null {
  if (!ev || typeof ev !== "object") return null;
  const e = ev as EvidenceJson;
  const decimals = e.tokenDecimals ?? LOGICAL_DECIMALS; // the contract decimals the decision was made at (recorded in the evidence itself)
  if (e.reason === "NO_HISTORY_LONG_ENOUGH") return "Not qualified — the verified holding began too recently for any tier (the token contract could not be read at the close, so balances were not compared).";
  if (e.reason === "TOKEN_METADATA_UNVERIFIED") return "Waiting — the token contract could not be verified (chain id, bytecode, decimals(), symbol()), so balances cannot be compared yet.";
  const iso = (ms: number | null | undefined) => (ms == null ? "—" : new Date(ms).toISOString().replace(".000Z", "Z"));
  const tiers = e.tiers ?? [];
  const win = tiers.find((t) => t.qualifies);
  if (e.decision === "QUALIFIED" && win) return `${tierLabel(win.tierIndex)} QUALIFIED: verified at/above the threshold at every one of ${win.observations} checks since ${iso(win.sinceMs)} (needed ≤ ${iso(win.neededSinceMs)}); lowest balance ${formatTokenAmount(BigInt(win.minBalanceRaw ?? "0"), decimals)}; longest gap ${Math.round((win.longestGapMs ?? 0) / 60_000)} min; closed ${iso(e.closeAtMs)}.`;
  if (e.decision === "PENDING_VERIFICATION") return "No close verification exists yet — waiting for a successful balance read.";
  const why = tiers.map((t) => `${tierLabel(t.tierIndex)}: ${t.reason === "RUN_TOO_RECENT" ? `held only since ${iso(t.sinceMs)} (needed ≤ ${iso(t.neededSinceMs)})` : t.reason === "BELOW_THRESHOLD_AT_CLOSE" ? "below the threshold at the close" : t.reason === "NO_CLOSE_OBSERVATION" ? "no close verification" : t.reason}`);
  return why.length ? `Not qualified — ${why.join("; ")}.` : "Not qualified (no paying tier configured).";
}

/** The frozen results of one finalized board, with prize / bonus status, the continuity evidence and (admin only) the member's Telegram id and hold reason. */
export async function boardResultsAdmin(q: Queryable, kind: PeriodKind, start: string): Promise<Array<Record<string, unknown>>> {
  const board = await q.query<{ holder_bonus_tiers: Array<{ index: number; minimum: string }> }>("select holder_bonus_tiers from public.arena_leaderboards where kind = $1 and period_start = $2::date", [kind, start]);
  const dec = LOGICAL_DECIMALS;
  const labels = new Map((board[0]?.holder_bonus_tiers ?? []).map((t) => [Number(t.index), Number(t.minimum) === 0 ? "FREE" : t.minimum]));
  const rows = await q.query<Record<string, unknown>>(
    `select r.rank, r.telegram_user_id, r.hero_name, r.points, r.picks, r.correct_picks, r.accuracy_bps, r.prize_eligible, r.prize_rank, r.tie_size,
            r.base_prize_micro::text as base_micro, r.base_status, r.hold_reason, r.bonus_status, r.bonus_tier_index, r.bonus_label, r.bonus_bps, r.bonus_micro::text as bonus_micro, r.bonus_evidence,
            r.resolved_by, r.resolution_reason, r.bonus_resolved_at
       from public.arena_leaderboard_results r where r.kind = $1 and r.period_start = $2::date order by r.rank, r.telegram_user_id limit 200`,
    [kind, start],
  );
  return rows.map((r) => {
    const base = BigInt(String(r.base_micro));
    const bonus = BigInt(String(r.bonus_micro));
    return {
      rank: r.rank, telegramUserId: r.telegram_user_id, hero: r.hero_name, points: r.points, picks: r.picks, correctPicks: r.correct_picks, accuracyBps: r.accuracy_bps,
      prizeEligible: r.prize_eligible, prizeRank: r.prize_rank, tieSize: r.tie_size,
      basePrize: formatTokenAmount(base, dec), holderTier: r.bonus_label ?? null, holderBonusPercent: r.bonus_bps ? bonusPercentLabel(Number(r.bonus_bps)) : null,
      holderBonus: formatTokenAmount(bonus, dec), totalReward: formatTokenAmount(base + (r.bonus_status === "CREDITED" || r.bonus_status === "HELD" ? bonus : 0n), dec),
      baseStatus: r.base_status, holdReason: r.hold_reason, bonusStatus: r.bonus_status, evidence: r.bonus_evidence ?? null,
      evidenceSummary: summarizeEvidence(r.bonus_evidence, (i) => labels.get(i) ?? `tier ${i}`),
      resolvedBy: r.resolved_by, resolutionReason: r.resolution_reason,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// PAYOUT SUMMARY of ONE finalized board (admin only) — the EXACT amounts to send by hand, no calculator needed
// ---------------------------------------------------------------------------------------------------------------------
interface PayoutResultRow { rank: number; telegram_user_id: number; hero_name: string; points: number; picks: number; correct_picks: number; accuracy_bps: number; tie_size: number; base_micro: string; base_status: "CREDITED" | "HELD" | "FORFEITED"; bonus_status: PayoutRowDto["bonusStatus"]; bonus_label: string | null; bonus_bps: number; bonus_micro: string }

/**
 * What an operator must send for a finalized Daily / Weekly board: the base prizes that stand plus the QUALIFIED holder bonuses = the
 * exact total, and one row per prize winner with the amounts, the tier, the claim status, the wallet and the transaction hash.
 *
 * Claim status per winner (a claim reserves a member's WHOLE claimable balance at that moment, ordered by its CLAIM_RESERVED ledger
 * row): the first PENDING / SENT claim reserved AFTER the prize was credited is the one that covers it; if every claim since was DENIED
 * the status is DENIED; otherwise UNCLAIMED. A prize held for review (HELD) or given up after review (FORFEITED) has no claim status.
 * A bonus credited later (reconciled after a failed close verification) is a separate credit — if a claim was already reserved before
 * it, the winner shows UNCLAIMED again for that remainder.
 */
export async function boardPayout(q: Queryable, kind: PeriodKind, start: string): Promise<PayoutDto | null> {
  const [board] = await q.query<{ prize_pool_micro: string; holder_bonus_tiers: Array<{ bonusBps: number }>; finalized_at: Date }>(
    "select prize_pool_micro::text, holder_bonus_tiers, finalized_at from public.arena_leaderboards where kind = $1 and period_start = $2::date",
    [kind, start],
  );
  if (!board) return null;
  const dec = LOGICAL_DECIMALS; // a payout summary is in LOGICAL tokens: the exact figures to send, whether or not the token exists yet
  const results = await q.query<PayoutResultRow>(
    `select r.rank, r.telegram_user_id, r.hero_name, r.points, r.picks, r.correct_picks, r.accuracy_bps, r.tie_size, r.base_prize_micro::text as base_micro, r.base_status, r.bonus_status, r.bonus_label, r.bonus_bps, r.bonus_micro::text as bonus_micro
       from public.arena_leaderboard_results r where r.kind = $1 and r.period_start = $2::date and r.base_prize_micro > 0 order by r.rank, r.telegram_user_id`,
    [kind, start],
  );
  const ids = json(results.map((r) => String(r.telegram_user_id)));
  const baseKind = kind === "DAILY" ? "DAILY_LEADERBOARD_BASE_REWARD" : "WEEKLY_LEADERBOARD_BASE_REWARD";
  const bonusKind = kind === "DAILY" ? "DAILY_LEADERBOARD_HOLDER_BONUS" : "WEEKLY_LEADERBOARD_HOLDER_BONUS";
  const empty = results.length === 0;
  const credits = empty ? [] : await q.query<{ telegram_user_id: number; id: string }>(
    "select telegram_user_id, id::text as id from public.arena_reward_ledger where period_kind = $1 and period_start = $2::date and kind in ($3, $4) and telegram_user_id in (select (jsonb_array_elements_text($5::jsonb))::bigint)",
    [kind, start, baseKind, bonusKind, ids],
  );
  const claims = empty ? [] : await q.query<{ telegram_user_id: number; reserved_id: string; status: "PENDING" | "SENT" | "DENIED"; destination_address: string; tx_hash: string | null }>(
    `select l.telegram_user_id, l.id::text as reserved_id, c.status, c.destination_address, c.tx_hash
       from public.arena_reward_ledger l join public.arena_reward_claims c on c.id = l.claim_id
      where l.kind = 'CLAIM_RESERVED' and l.telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint) order by l.id`,
    [ids],
  );
  const wallets = empty ? [] : await q.query<{ telegram_user_id: number; w: string }>(
    "select telegram_user_id, holder_wallet_address as w from public.arena_reward_accounts where holder_wallet_address is not null and wallet_verified_at is not null and telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)",
    [ids],
  );
  const holderWallet = new Map(wallets.map((w) => [Number(w.telegram_user_id), w.w]));
  const maxBps = Math.max(0, ...(Array.isArray(board.holder_bonus_tiers) ? board.holder_bonus_tiers : []).map((t) => Number(t.bonusBps)));

  const byStatus = Object.fromEntries(PAYOUT_CLAIM_STATUSES.map((s) => [s, 0n])) as Record<PayoutClaimStatus, bigint>;
  let baseStanding = 0n, bonuses = 0n, held = 0n, forfeited = 0n, pendingMax = 0n;
  let pendingCount = 0;
  const rows: PayoutRowDto[] = results.map((r) => {
    const uid = Number(r.telegram_user_id);
    const base = BigInt(r.base_micro);
    const bonusMicro = BigInt(r.bonus_micro);
    const bonusStands = r.bonus_status === "CREDITED" || r.bonus_status === "HELD";
    const bonus = bonusStands ? bonusMicro : 0n;
    const total = r.base_status === "FORFEITED" ? 0n : base + bonus;
    if (r.base_status !== "FORFEITED") { baseStanding += base; bonuses += bonus; }
    else forfeited += base + (r.bonus_status === "FORFEITED" ? bonusMicro : 0n);
    if (r.base_status === "HELD") held += total;
    if (r.bonus_status === "PENDING_VERIFICATION") { pendingCount += 1; pendingMax += applyBonus(base, maxBps); }

    let claimStatus: PayoutClaimStatus;
    let wallet: string | null = holderWallet.get(uid) ?? null;
    let walletSource: PayoutRowDto["walletSource"] = wallet ? "HOLDER_WALLET" : null;
    let txHash: string | null = null;
    if (r.base_status !== "CREDITED") claimStatus = r.base_status;
    else {
      const creditId = credits.filter((c) => Number(c.telegram_user_id) === uid).reduce((m, c) => (BigInt(c.id) > m ? BigInt(c.id) : m), 0n);
      const after = claims.filter((c) => Number(c.telegram_user_id) === uid && BigInt(c.reserved_id) > creditId);
      const covering = after.find((c) => c.status !== "DENIED");
      if (covering) {
        claimStatus = covering.status;
        wallet = covering.destination_address;
        walletSource = "CLAIM";
        txHash = covering.status === "SENT" ? covering.tx_hash : null;
      } else claimStatus = after.length > 0 ? "DENIED" : "UNCLAIMED";
    }
    byStatus[claimStatus] += total;
    return {
      rank: Number(r.rank),
      tied: Number(r.tie_size) > 1,
      telegramUserId: uid,
      hero: r.hero_name,
      correctPicks: Number(r.correct_picks),
      picks: Number(r.picks),
      accuracy: bpsToPercent(Number(r.accuracy_bps)),
      points: Number(r.points),
      basePrize: formatTokenAmount(base, dec),
      basePrizePlain: formatTokenPlain(base, dec),
      holderTier: bonusStands ? r.bonus_label : null,
      bonusPercent: bonusStands && r.bonus_bps ? bonusPercentLabel(Number(r.bonus_bps)) : null,
      holderBonus: formatTokenAmount(bonus, dec),
      holderBonusPlain: formatTokenPlain(bonus, dec),
      totalReward: formatTokenAmount(total, dec),
      totalRewardPlain: formatTokenPlain(total, dec),
      baseStatus: r.base_status,
      bonusStatus: r.bonus_status,
      claimStatus,
      wallet,
      walletSource,
      txHash,
    };
  });

  const pool = BigInt(board.prize_pool_micro);
  const fmt = (n: bigint) => formatTokenAmount(n, dec);
  const total = baseStanding + bonuses;
  return {
    summary: {
      kind,
      start,
      finalizedAt: new Date(board.finalized_at).getTime(),
      symbol: REWARD_SYMBOL,
      basePool: fmt(pool),
      baseAwarded: fmt(baseStanding),
      returnedToReserve: fmt(pool - baseStanding),
      maxBonusPercent: bonusPercentLabel(maxBps),
      holderBonuses: fmt(bonuses),
      totalPayout: fmt(total),
      totalPayoutPlain: formatTokenPlain(total, dec),
      heldForReview: fmt(held),
      forfeited: fmt(forfeited),
      bonusesPending: pendingCount,
      bonusesPendingMaximum: fmt(pendingMax),
      prizeWinners: rows.length,
      byStatus: Object.fromEntries(PAYOUT_CLAIM_STATUSES.map((s) => [s, fmt(byStatus[s])])) as Record<PayoutClaimStatus, string>,
    },
    rows,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// TOKEN STATUS (admin only; names and public facts — never a secret)
// ---------------------------------------------------------------------------------------------------------------------
export interface TokenAdminStatus {
  /** An official contract address is configured (the token exists as far as this server knows). */
  launched: boolean;
  /** The official $CLANKRPG contract. The address is PUBLIC (shown and copyable). NOT_LAUNCHED = no address configured yet (a normal state). */
  contract: { status: "NOT_LAUNCHED" | "CONFIGURED" | "INVALID"; address: string | null };
  /**
   * What the CONTRACT itself reports (chain id, bytecode, decimals(), symbol()) — nothing is configured or typed. VERIFIED = all of it checks out.
   * FAILED = the contract answered but is not a usable token. UNVERIFIED = it could not be asked right now (RPC down); `cached` then shows the last good read.
   */
  metadata: { status: "NOT_LAUNCHED" | "VERIFIED" | "FAILED" | "UNVERIFIED"; symbol: string | null; decimals: number | null; verifiedAt: number | null; source: "CONTRACT" | "CACHE" | null; error: string | null };
  rpc: { status: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"; chainId: number | null; chainIdMatches: boolean | null; error: string | null };
  adapter: "rpc" | "simulated" | null;
  rewardWallet: string | null;
  holderVerificationAvailable: boolean;
  /** Claims can be requested and verified (token launched and its contract verified). Before that members keep a CLAIMABLE balance. */
  claimsAvailable: boolean;
  reasons: string[];
  warnings: string[];
  notices: string[];
}

export function tokenAdminStatus(token: TokenStatus, health: TokenHealth | null, cached: TokenMetadataView | null): TokenAdminStatus {
  const warnings: string[] = [];
  const notices: string[] = [];
  const contractStatus: TokenAdminStatus["contract"]["status"] = !token.launched ? "NOT_LAUNCHED" : token.tokenAddress ? "CONFIGURED" : "INVALID";
  let metadata: TokenAdminStatus["metadata"] = { status: "NOT_LAUNCHED", symbol: null, decimals: null, verifiedAt: null, source: null, error: null };
  if (token.launched) {
    metadata = { status: "UNVERIFIED", symbol: cached?.symbol ?? null, decimals: cached?.decimals ?? null, verifiedAt: cached?.verifiedAt ?? null, source: cached ? "CACHE" : null, error: null };
    if (health?.metadataStatus === "VERIFIED") metadata = { status: "VERIFIED", symbol: health.onChainSymbol, decimals: health.onChainDecimals, verifiedAt: Date.now(), source: "CONTRACT", error: null };
    else if (health?.metadataStatus === "FAILED") metadata = { ...metadata, status: "FAILED", error: health.error };
    else if (health) metadata = { ...metadata, error: health.error };
  }
  if (!token.launched) notices.push("$CLANKRPG has not launched yet. Set CLANKRPG_TOKEN_ADDRESS when it does — that is the ONLY token setting; decimals and symbol are read from the contract. Until then every holder bonus is 0 % and claims open after launch; the Arena, picks and boards are unaffected.");
  else if (contractStatus === "INVALID") warnings.push("CLANKRPG_TOKEN_ADDRESS is set but is not a valid address: holder verification and claims are off.");
  if (metadata.status === "FAILED") warnings.push(`The token contract could not be verified (${metadata.error ?? "unusable"}). Holder verification and claims stay CLOSED; the Arena and the boards are unaffected.`);
  if (health && !health.rpcAvailable) warnings.push("The Robinhood RPC is unavailable right now: holder checks are failing and will back off; verifications go stale after the configured window.");
  if (health && health.chainIdMatches === false) warnings.push("The RPC endpoint reports a different chain id than ROBINHOOD_CHAIN_ID.");
  for (const r of retiredEnvPresent()) warnings.push(`${r.name} is set in the environment: ${r.why}.`);
  const verified = metadata.status === "VERIFIED" || (metadata.status === "UNVERIFIED" && cached !== null);
  return {
    launched: token.launched,
    contract: { status: contractStatus, address: token.publicAddress },
    metadata,
    rpc: { status: health === null ? "UNKNOWN" : health.rpcAvailable ? "AVAILABLE" : "UNAVAILABLE", chainId: token.chainId, chainIdMatches: health?.chainIdMatches ?? null, error: health?.error ?? null },
    adapter: token.adapter,
    rewardWallet: token.treasuryAddress,
    holderVerificationAvailable: token.available && verified && metadata.status !== "FAILED",
    claimsAvailable: token.available && verified && metadata.status !== "FAILED",
    reasons: token.reasons,
    warnings,
    notices,
  };
}
