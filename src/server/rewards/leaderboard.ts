import { accuracyBps, accuracyPercent, bpsToPercent, distributePrizes, rankBoard, type BoardRowInput, type RankedRow } from "@/domain/rewards/leaderboard";
import type { BoardDto, BoardMeDto, BoardPayload, BoardRowDto, BoardRuleView, BonusPublicStatus, PeriodListItem } from "@/domain/rewards/leaderboardDto";
import { applyBonus, bonusPercentLabel, buildBonusTiers, cannotHaveQualified, compactWholeTokens, decideBonus, type BonusDecision, type BonusTier, type PeriodTerms } from "@/domain/rewards/holderBonus";
import { isPeriodStart, periodWindow, periodWindowOf, type PeriodKind, PERIOD_KINDS } from "@/domain/rewards/time";
import { formatTokenAmount, formatTokenPlain, LOGICAL_DECIMALS, parseTokenAmount } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { json, type Db, type Queryable } from "../db/types";

import type { RewardChainReader } from "./chain";
import { getChainReader, getTokenStatus } from "./context";
import { loadObservations, verifyForClose } from "./holders";
import { lockLifecycleShared } from "../services/lifecycleLock";
import { leaderboardKind, lockRewardAccount, postRewardLedger } from "./ledger";
import { boardPoolMicro, minimumPicksFor, REWARD_SYMBOL, rewardsReady } from "./pool";
import { verifiedTokenMetadata } from "./tokenMetadata";

/**
 * THE DAILY AND WEEKLY ARENA PICKS LEADERBOARDS.
 *
 *  DAILY   00:00:00 UTC → next 00:00:00 UTC      (default pool 200,000 $CLANKRPG)
 *  WEEKLY  Monday 00:00:00 UTC → next Monday     (default pool 1,000,000 $CLANKRPG)
 *
 * Both rank by CORRECT PICKS, then ACCURACY (correct / picks), from ONE source: the per-pick score rows (`arena_pick_scores`), one per
 * valid settled pick. EVERY valid pick counts — there is no daily cap, so the boards are a race for the most correct picks over
 * the period, and a minimum number of picks keeps one lucky pick from winning a prize. A fixed pool is paid down the same Top-10
 * ladder when a period is FINALIZED: an idempotent sweep that freezes every score, rank and prize.
 *
 * Holdings never enter scoring, ranking, ties or the BASE prize. A holder BONUS is decided once, at finalization, from the
 * append-only log of authoritative balance reads (verified holding continuity from BEFORE the period began — see
 * domain/rewards/holderBonus.ts) and is added on top; it is never taken from another player.
 *
 * All amounts here are LOGICAL (micro-tokens, domain/rewards/tokens.ts): a board finalizes the same way whether or not the token exists
 * yet, and nothing about a contract's decimals is ever frozen into a finished period. Before launch nobody can have a verified balance,
 * so every bonus is simply NONE (0 %) — the base prizes are still earned, recorded and claimable.
 *
 * "Now" and every boundary are the SERVER's; the browser only counts down between fetches.
 */
export { REWARD_SYMBOL as BOARD_SYMBOL };
export type { BoardDto, BoardMeDto, BoardPayload, BoardRowDto, BoardRuleView, PeriodListItem };

const HOUR = 3_600_000;

export function boardRules(settings: GameSettings, kind: PeriodKind): BoardRuleView {
  const c = settings.arena_picks;
  const decimals = LOGICAL_DECIMALS;
  const pool = boardPoolMicro(settings, kind);
  return {
    kind,
    minimumPicks: minimumPicksFor(settings, kind),
    pointsPerCorrectPick: c.pointsPerCorrectPick,
    prizePool: formatTokenAmount(pool, decimals),
    prizePoolPlain: formatTokenPlain(pool, decimals),
    symbol: REWARD_SYMBOL,
    topRewarded: c.prizeSplitBps.length,
    prizes: c.prizeSplitBps.map((bps, i) => ({ position: i + 1, share: `${bps / 100}%`, amount: formatTokenAmount((pool * BigInt(bps)) / 10_000n, decimals) })),
    prizesPaused: !c.enabled,
    holderBonuses: buildBonusTiers(c, decimals).filter((t) => t.bonusBps > 0).map((t) => ({ label: t.label, minimum: formatTokenAmount(t.minimumRaw, decimals), bonus: bonusPercentLabel(t.bonusBps) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Standings (the live computation — also what finalization freezes)
// ---------------------------------------------------------------------------------------------------------------------
interface AggRow {
  telegram_user_id: number;
  character_id: string | null;
  name: string | null;
  class_id: string | null;
  points: number;
  picks: number;
  correct: number;
}
type Input = BoardRowInput & { agg: AggRow };

/** Where a period's pick scores live: a UTC date for DAILY, the Monday for WEEKLY. */
const scoreColumn = (kind: PeriodKind): string => (kind === "DAILY" ? "s.utc_date" : "s.week_start");
/**
 * "This score row belongs to a season that counts." A period has an OWNER (`public.period_season`) exactly when some score in it is of a counting season, so for a scan
 * that lists the periods with scores the owner test IS this row-level test — evaluated against the few season rows once (a hashed sub-select), not by a call to
 * `period_season` per score row (which itself scans the scores of the period: quadratic in the number of picks, on every request).
 */
export const COUNTING_SEASON_SCORE = "s.season_id in (select z.id from public.seasons z where public.season_counts(z.id))";
/**
 * The same test for a FINALIZED board (`arena_leaderboards.season_id`): a board is public history only when the season that owned it counts — an official season, or the
 * one being played. Boards of an archived development run (and any old board that has no owner) are never listed and never readable by date, so the pre-season's winners
 * cannot reappear as official history after the Season 1 launch.
 */
export const COUNTING_SEASON_BOARD = "l.season_id in (select z.id from public.seasons z where public.season_counts(z.id))";

/**
 * The season whose picks a period's board ranks: the season of the LAST COUNTING pick scored in it (see `public.period_season`). A pick of an archived
 * development run never counts, so after the Season 1 launch the Daily / Weekly boards begin clean even on the same UTC day / week — and a period that
 * holds nothing but archived development picks has no owner at all: it is never ranked, finalized or paid. Null = nobody competes in it.
 */
export async function periodSeasonId(q: Queryable, kind: PeriodKind, start: string): Promise<string | null> {
  const [r] = await q.query<{ id: string | null }>("select public.period_season($1::text, $2::date) as id", [kind, start]);
  return r?.id ?? null;
}

async function aggregatePeriod(q: Queryable, kind: PeriodKind, start: string, seasonId: string): Promise<AggRow[]> {
  return q.query<AggRow>(
    `select s.telegram_user_id, c.id as character_id, coalesce(c.name_override, c.name) as name, c.class_id,
            coalesce(sum(s.points), 0)::int as points, count(*)::int as picks, (count(*) filter (where s.correct))::int as correct
       from public.arena_pick_scores s left join public.characters c on c.telegram_user_id = s.telegram_user_id
      where ${scoreColumn(kind)} = $1::date and s.season_id = $2::uuid group by s.telegram_user_id, c.id, c.name_override, c.name, c.class_id`,
    [start, seasonId],
  );
}

/** Current / best streak of consecutive CORRECT picks over a member's picks of the period, in the order they were scored. */
function streaksOf(rows: Array<{ telegram_user_id: number; correct: boolean }>): Map<number, { current: number; best: number }> {
  const out = new Map<number, { current: number; best: number }>();
  for (const r of rows) {
    const s = out.get(Number(r.telegram_user_id)) ?? { current: 0, best: 0 };
    s.current = r.correct ? s.current + 1 : 0; // a wrong pick resets the streak
    s.best = Math.max(s.best, s.current);
    out.set(Number(r.telegram_user_id), s);
  }
  return out;
}

async function pickStreaks(q: Queryable, kind: PeriodKind, start: string, userIds: number[]): Promise<Map<number, { current: number; best: number }>> {
  const seasonId = userIds.length === 0 ? null : await periodSeasonId(q, kind, start);
  if (!seasonId) return new Map();
  const rows = await q.query<{ telegram_user_id: number; correct: boolean }>(
    `select telegram_user_id, correct from public.arena_pick_scores s where ${scoreColumn(kind)} = $1::date and s.season_id = $3::uuid and telegram_user_id in (select (jsonb_array_elements_text($2::jsonb))::bigint) order by telegram_user_id, id`,
    [start, json(userIds.map(String)), seasonId],
  );
  return streaksOf(rows);
}

interface Standing {
  ranked: Array<RankedRow<Input>>;
  eligible: Array<RankedRow<Input>>;
  pool: bigint;
  prizeOf: Map<number, bigint>;
  /** Pool not awarded to a position (unfilled positions, tie-split remainders). */
  returned: bigint;
}

async function computeStanding(q: Queryable, kind: PeriodKind, start: string, settings: GameSettings): Promise<Standing> {
  const seasonId = await periodSeasonId(q, kind, start);
  const agg = seasonId ? await aggregatePeriod(q, kind, start, seasonId) : [];
  const inputs: Input[] = agg.map((a) => ({ userId: Number(a.telegram_user_id), points: Number(a.points), picks: Number(a.picks), correct: Number(a.correct), agg: a }));
  const ranked = rankBoard(inputs, minimumPicksFor(settings, kind));
  const eligible = ranked.filter((r) => r.prizeEligible);
  // Prizes switched off = a zero pool is frozen with the period (it awards nothing, and says so).
  const pool = settings.arena_picks.enabled ? boardPoolMicro(settings, kind) : 0n;
  const prizes = distributePrizes(eligible.map((r) => ({ userId: r.row.userId, row: r.row })), pool, settings.arena_picks.prizeSplitBps);
  return { ranked, eligible, pool, prizeOf: new Map(prizes.awards.map((a) => [a.userId, a.prizeMicro])), returned: prizes.returnedMicro };
}

/** A member's own standing in the RUNNING period of one kind. Every valid pick counts — there is no daily cap. */
export interface MemberPeriodStats {
  kind: PeriodKind;
  start: string;
  endsAt: number;
  picks: number;
  correct: number;
  /** Percent correct, one decimal (null with no picks). */
  accuracy: number | null;
  points: number;
  /** Competition rank among everyone with at least one pick this period (null with none). */
  rank: number | null;
  prizeEligible: boolean;
  /** Picks still needed to be prize-eligible (0 once eligible). */
  picksToEligible: number;
  minimumPicks: number;
}

export async function getMemberPeriodStats(q: Queryable, userId: number, settings: GameSettings, kind: PeriodKind, nowMs: number): Promise<MemberPeriodStats> {
  const win = periodWindow(kind, nowMs);
  const standing = await computeStanding(q, kind, win.start, settings);
  const mine = standing.ranked.find((r) => r.row.userId === userId);
  const minimum = minimumPicksFor(settings, kind);
  const picks = mine?.row.picks ?? 0;
  return {
    kind,
    start: win.start,
    endsAt: win.endsAt,
    picks,
    correct: mine?.row.correct ?? 0,
    accuracy: mine ? accuracyPercent(mine.row.correct, mine.row.picks) : null,
    points: mine?.row.points ?? 0,
    rank: mine?.rank ?? null,
    prizeEligible: mine?.prizeEligible ?? false,
    picksToEligible: Math.max(minimum - picks, 0),
    minimumPicks: minimum,
  };
}

/** Adds the public profile id to rows whose hero is publicly visible (active, member not banned). A row with no public hero simply does not link. */
async function attachHeroLinks(q: Queryable, rows: BoardRowDto[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r.characterId).filter((x): x is string => typeof x === "string"))];
  if (ids.length === 0) return;
  const found = await q.query<{ id: string; public_id: string; rarity: BoardRowDto["rarity"] }>(
    `select c.id, c.public_id, ca.rarity from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.character_appearances ca on ca.character_id = c.id
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) and c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED')`,
    [JSON.stringify(ids)],
  );
  const byId = new Map(found.map((f) => [f.id, f]));
  for (const r of rows) {
    const hit = r.characterId ? byId.get(r.characterId) : undefined;
    r.heroPublicId = hit?.public_id ?? null;
    r.rarity = hit?.rarity ?? null;
  }
}

function liveRow(r: RankedRow<Input>, prizeMicro: bigint, streak: { current: number; best: number } | undefined): BoardRowDto {
  const decimals = LOGICAL_DECIMALS;
  const base = formatTokenAmount(prizeMicro, decimals);
  return {
    rank: r.rank,
    characterId: r.row.agg.character_id,
    heroPublicId: null,
    rarity: null,
    name: r.row.agg.name ?? "Unknown hero",
    classId: r.row.agg.class_id ?? "warrior",
    points: r.row.points,
    picks: r.row.picks,
    correctPicks: r.row.correct,
    accuracy: accuracyPercent(r.row.correct, r.row.picks),
    currentStreak: streak?.current ?? 0,
    bestStreak: streak?.best ?? 0,
    prizeEligible: r.prizeEligible,
    basePrize: base,
    holderBonus: "0",
    holderTier: null,
    bonusStatus: "NONE",
    totalReward: base,
    tied: r.tieSize > 1,
  };
}

/**
 * A period's standings computed LIVE from the valid picks: the running period (`CURRENT`, projected prizes), or an ENDED one
 * that is not frozen yet (`FINALIZING`). `viewerId` adds the signed-in member's own standing (their row may be outside the top).
 * Prizes shown are projections until the period is finalized; a holder bonus is never projected (it is decided at the close).
 */
export async function getLiveBoard(q: Queryable, ctx: { kind: PeriodKind; start?: string; nowMs: number; settings: GameSettings; viewerId?: number | null; limit?: number }): Promise<{ board: BoardDto; me: BoardMeDto | null }> {
  const { kind, nowMs, settings } = ctx;
  const win = ctx.start ? periodWindowOf(kind, ctx.start) : periodWindow(kind, nowMs);
  const limit = Math.min(Math.max(ctx.limit ?? 50, 1), 200);
  const standing = await computeStanding(q, kind, win.start, settings);
  const top = standing.ranked.slice(0, limit);
  const streaks = await pickStreaks(q, kind, win.start, top.map((r) => r.row.userId));
  const rows = top.map((r) => liveRow(r, standing.prizeOf.get(r.row.userId) ?? 0n, streaks.get(r.row.userId)));
  await attachHeroLinks(q, rows);

  let me: BoardMeDto | null = null;
  if (ctx.viewerId != null) {
    const mine = standing.ranked.find((r) => r.row.userId === ctx.viewerId);
    me = {
      rank: mine?.rank ?? null,
      points: mine?.row.points ?? 0,
      picks: mine?.row.picks ?? 0,
      correctPicks: mine?.row.correct ?? 0,
      accuracy: mine ? accuracyPercent(mine.row.correct, mine.row.picks) : null,
      prizeEligible: mine?.prizeEligible ?? false,
      picksToEligible: Math.max(minimumPicksFor(settings, kind) - (mine?.row.picks ?? 0), 0),
    };
  }
  return {
    board: {
      kind,
      state: win.endsAt > nowMs ? "CURRENT" : "FINALIZING",
      start: win.start,
      serverNow: nowMs,
      startsAt: win.startsAt,
      endsAt: win.endsAt,
      rules: boardRules(settings, kind),
      participants: standing.ranked.length,
      eligibleParticipants: standing.eligible.length,
      rows,
      finalizedAt: null,
    },
    me,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Frozen boards (history)
// ---------------------------------------------------------------------------------------------------------------------
interface FrozenRow {
  telegram_user_id: number;
  character_id: string | null;
  hero_name: string;
  class_id: string;
  rank: number;
  points: number;
  picks: number;
  correct_picks: number;
  accuracy_bps: number;
  current_streak: number;
  best_streak: number;
  prize_eligible: boolean;
  base_prize_micro: string;
  base_status: "NONE" | "CREDITED" | "HELD" | "FORFEITED";
  bonus_status: "NONE" | "PENDING_VERIFICATION" | "CREDITED" | "HELD" | "FORFEITED" | "EXPIRED";
  bonus_label: string | null;
  bonus_micro: string;
}

/** What a player may see of a bonus: the amount and tier of a bonus that was awarded, or that one is pending / expired. Held/forfeited read as awarded (review state is private). */
const publicBonus = (s: FrozenRow["bonus_status"]): BonusPublicStatus => (s === "CREDITED" || s === "HELD" || s === "FORFEITED" ? "CREDITED" : s === "PENDING_VERIFICATION" ? "PENDING" : s === "EXPIRED" ? "EXPIRED" : "NONE");

/** A FINALIZED period, read from its frozen rows (never recomputed). Null when that period has not been finalized. */
export async function getFinalBoard(q: Queryable, kind: PeriodKind, start: string, ctx: { nowMs: number; viewerId?: number | null; limit?: number }): Promise<{ board: BoardDto; me: BoardMeDto | null } | null> {
  const [w] = await q.query<{ prize_pool_micro: string; prize_split_bps: number[]; minimum_picks: number; points_per_correct_pick: number; holder_bonus_tiers: Array<{ minimum: string; bonusBps: number }>; participants: number; eligible_participants: number; finalized_at: Date }>(
    `select l.prize_pool_micro::text, l.prize_split_bps, l.minimum_picks, l.points_per_correct_pick, l.holder_bonus_tiers, l.participants, l.eligible_participants, l.finalized_at
       from public.arena_leaderboards l where l.kind = $1 and l.period_start = $2::date and ${COUNTING_SEASON_BOARD}`,
    [kind, start],
  );
  if (!w) return null;
  const dec = LOGICAL_DECIMALS; // a finished board is in LOGICAL units — no contract decimals are frozen into it
  const pool = BigInt(w.prize_pool_micro);
  const win = periodWindowOf(kind, start);
  const split = (Array.isArray(w.prize_split_bps) ? w.prize_split_bps : []).map(Number);
  const rules: BoardRuleView = {
    kind,
    minimumPicks: Number(w.minimum_picks),
    pointsPerCorrectPick: Number(w.points_per_correct_pick),
    prizePool: formatTokenAmount(pool, dec),
    prizePoolPlain: formatTokenPlain(pool, dec),
    symbol: REWARD_SYMBOL,
    topRewarded: split.length,
    prizes: split.map((bps, i) => ({ position: i + 1, share: `${bps / 100}%`, amount: formatTokenAmount((pool * BigInt(bps)) / 10_000n, dec) })),
    prizesPaused: pool === 0n,
    holderBonuses: (Array.isArray(w.holder_bonus_tiers) ? w.holder_bonus_tiers : [])
      .filter((t) => Number(t.bonusBps) > 0)
      .map((t) => ({ label: compactWholeTokens(parseTokenAmount(t.minimum, dec) / 10n ** BigInt(dec)), minimum: formatTokenAmount(parseTokenAmount(t.minimum, dec), dec), bonus: bonusPercentLabel(Number(t.bonusBps)) })),
  };
  const limit = Math.min(Math.max(ctx.limit ?? 50, 1), 200);
  const cols = "telegram_user_id, character_id, hero_name, class_id, rank, points, picks, correct_picks, accuracy_bps, current_streak, best_streak, prize_eligible, base_prize_micro::text, base_status, bonus_status, bonus_label, bonus_micro::text";
  const rows = await q.query<FrozenRow>(`select ${cols} from public.arena_leaderboard_results where kind = $1 and period_start = $2::date order by rank, telegram_user_id limit $3`, [kind, start, limit]);
  const tieCounts = await q.query<{ rank: number }>("select rank from public.arena_leaderboard_results where kind = $1 and period_start = $2::date group by rank having count(*) > 1", [kind, start]);
  const tied = new Set(tieCounts.map((t) => Number(t.rank)));
  const out: BoardRowDto[] = rows.map((r) => {
    const base = BigInt(r.base_prize_micro);
    const bonusAwarded = r.bonus_status === "CREDITED" || r.bonus_status === "HELD" || r.bonus_status === "FORFEITED";
    const bonus = bonusAwarded ? BigInt(r.bonus_micro) : 0n;
    return {
      rank: Number(r.rank),
      characterId: r.character_id,
      heroPublicId: null,
      rarity: null,
      name: r.hero_name,
      classId: r.class_id,
      points: Number(r.points),
      picks: Number(r.picks),
      correctPicks: Number(r.correct_picks),
      accuracy: bpsToPercent(Number(r.accuracy_bps)),
      currentStreak: Number(r.current_streak),
      bestStreak: Number(r.best_streak),
      prizeEligible: r.prize_eligible,
      basePrize: formatTokenAmount(base, dec),
      holderBonus: formatTokenAmount(bonus, dec),
      holderTier: bonusAwarded ? r.bonus_label : null,
      bonusStatus: publicBonus(r.bonus_status),
      totalReward: formatTokenAmount(base + bonus, dec),
      tied: tied.has(Number(r.rank)),
    };
  });
  await attachHeroLinks(q, out);
  let me: BoardMeDto | null = null;
  if (ctx.viewerId != null) {
    const [m] = await q.query<FrozenRow>(`select ${cols} from public.arena_leaderboard_results where kind = $1 and period_start = $2::date and telegram_user_id = $3`, [kind, start, ctx.viewerId]);
    const bonusAwarded = m && (m.bonus_status === "CREDITED" || m.bonus_status === "HELD" || m.bonus_status === "FORFEITED");
    const base = BigInt(m?.base_prize_micro ?? "0");
    const bonus = bonusAwarded && m ? BigInt(m.bonus_micro) : 0n;
    me = {
      rank: m ? Number(m.rank) : null,
      points: Number(m?.points ?? 0),
      picks: Number(m?.picks ?? 0),
      correctPicks: Number(m?.correct_picks ?? 0),
      accuracy: m ? bpsToPercent(Number(m.accuracy_bps)) : null,
      prizeEligible: m?.prize_eligible ?? false,
      picksToEligible: 0,
      ...(m ? { prize: { base: formatTokenAmount(base, dec), bonus: formatTokenAmount(bonus, dec), total: formatTokenAmount(base + bonus, dec), status: m.base_status, bonusStatus: publicBonus(m.bonus_status) } } : {}),
    };
  }
  return {
    board: { kind, state: "FINAL", start, serverNow: ctx.nowMs, startsAt: win.startsAt, endsAt: win.endsAt, rules, participants: Number(w.participants), eligibleParticipants: Number(w.eligible_participants), rows: out, finalizedAt: new Date(w.finalized_at).getTime() },
    me,
  };
}

/** Finalized periods of one kind, newest first — the history selector. */
export async function listFinalizedPeriods(q: Queryable, kind: PeriodKind, limit = 30): Promise<PeriodListItem[]> {
  const rows = await q.query<{ period_start: string; participants: number; prize_pool_micro: string }>(
    `select l.period_start::text, l.participants, l.prize_pool_micro::text from public.arena_leaderboards l where l.kind = $1 and ${COUNTING_SEASON_BOARD} order by l.period_start desc limit $2`,
    [kind, Math.min(Math.max(limit, 1), 120)],
  );
  return rows.map((r) => ({ start: r.period_start, participants: Number(r.participants), prizePool: formatTokenAmount(BigInt(r.prize_pool_micro), LOGICAL_DECIMALS) }));
}

/** The most recent period that has ENDED, has scores and is not frozen yet (shown as FINALIZING for the few seconds it takes), or null. */
export async function findFinalizingPeriod(q: Queryable, kind: PeriodKind, nowMs: number): Promise<string | null> {
  const [r] = await q.query<{ start: string }>(
    `select distinct ${scoreColumn(kind)}::text as start from public.arena_pick_scores s
      where ${scoreColumn(kind)} < $1::date and not exists (select 1 from public.arena_leaderboards l where l.kind = $2 and l.period_start = ${scoreColumn(kind)})
        and ${COUNTING_SEASON_SCORE}
      order by 1 desc limit 1`,
    [periodWindow(kind, nowMs).start, kind],
  );
  return r?.start ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// FINALIZATION — idempotent; freezes the ranking, the scores and the prizes; credits through the SAME reward ledger
// ---------------------------------------------------------------------------------------------------------------------
export type FinalizeResult =
  | { status: "FINALIZED"; kind: PeriodKind; start: string; participants: number; eligible: number; credited: number; held: number; bonusesCredited: number; bonusesPending: number; baseAwardedMicro: bigint; returnedMicro: bigint }
  | { status: "ALREADY_FINALIZED" | "NOT_ENDED" | "WAITING_FOR_SETTLEMENT" | "NO_PARTICIPANTS"; kind: PeriodKind; start: string };

export interface BoardCtx {
  now: () => Date;
  settings: GameSettings;
  /**
   * The chain reader used for the final close verification. `undefined` = the configured one (NONE when the token has not launched: no
   * bonus is evaluated and every bonus is 0 %); an explicit `null` = a launched token whose chain cannot be read (bonuses wait as PENDING VERIFICATION).
   */
  reader?: RewardChainReader | null;
}

const asTerms = (win: { startsAt: number; endsAt: number }, requiredHours: number, maxGapHours: number): PeriodTerms => ({ startsAtMs: win.startsAt, endsAtMs: win.endsAt, requiredMs: requiredHours * HOUR, maxGapMs: maxGapHours * HOUR });
const qualifyHours = (settings: GameSettings, kind: PeriodKind): number => (kind === "DAILY" ? settings.arena_picks.holderDailyQualifyHours : settings.arena_picks.holderWeeklyQualifyHours);

/**
 * The bonus tiers as FROZEN on a board (so a later settings change never reinterprets a finished period): whole-token minimums as text,
 * never a balance in some token's raw units. They become raw thresholds only HERE, at the CONTRACT's decimals, to compare with chain balances.
 */
function frozenTiers(raw: unknown, contractDecimals: number): BonusTier[] {
  const list = Array.isArray(raw) ? (raw as Array<{ index: number; minimum: string; bonusBps: number }>) : [];
  return list.map((t) => {
    const minimumRaw = parseTokenAmount(t.minimum, contractDecimals);
    return { index: Number(t.index), minimumRaw, bonusBps: Number(t.bonusBps), label: minimumRaw === 0n ? "FREE" : compactWholeTokens(minimumRaw / 10n ** BigInt(contractDecimals)) };
  });
}

const frozenTierTerms = (cfg: { holderBonusTiers: ReadonlyArray<{ minimum: string; bonusBps: number }> }) => cfg.holderBonusTiers.map((t, index) => ({ index, minimum: t.minimum, bonusBps: t.bonusBps }));

const evidenceJson = (d: BonusDecision, wallet: string | null, contractDecimals: number) => json({ wallet, decision: d.kind, tokenDecimals: contractDecimals, ...d.evidence });

/** Prize winners with a verified holder wallet: the only members whose bonus needs evidence. */
async function walletsOf(q: Queryable, userIds: number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await q.query<{ telegram_user_id: number; w: string }>(
    "select telegram_user_id, holder_wallet_address as w from public.arena_reward_accounts where holder_wallet_address is not null and wallet_verified_at is not null and telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)",
    [json(userIds.map(String))],
  );
  return new Map(rows.map((r) => [Number(r.telegram_user_id), r.w]));
}

/**
 * Finalizes ONE ended period in one transaction: the board row + every participant's frozen result + the prize credits (base and
 * holder bonus as separate ledger entries). Safe to run any number of times and concurrently (the first insert wins; the rest
 * see ALREADY_FINALIZED). A period waits until every battle that settled in it has been scored, so no late settlement can ever
 * change a frozen result.
 *
 * BEFORE the transaction — never inside it, a network call must not hold row locks — every prize winner with a verified holder
 * wallet gets a FRESH authoritative balance read (the final close verification). If that read fails the base prize is still
 * paid and the bonus stays PENDING VERIFICATION for a limited window; it is never granted blindly.
 */
export async function finalizePeriod(db: Db, ctx: BoardCtx, kind: PeriodKind, start: string): Promise<FinalizeResult> {
  const nowMs = ctx.now().getTime();
  if (!isPeriodStart(kind, start)) return { status: "NOT_ENDED", kind, start };
  const win = periodWindowOf(kind, start);
  if (win.endsAt > nowMs) return { status: "NOT_ENDED", kind, start };
  const { settings } = ctx;
  const cfg = settings.arena_picks;
  const startIso = new Date(win.startsAt).toISOString();
  const endIso = new Date(win.endsAt).toISOString();

  const frozen = async (q: Queryable): Promise<boolean> => (await q.query("select 1 from public.arena_leaderboards where kind = $1 and period_start = $2::date", [kind, start])).length > 0;
  const waiting = async (q: Queryable): Promise<boolean> => {
    const [pending] = await q.query<{ n: number }>(
      `select count(*)::int as n from public.arena_battles b
        where b.status in ('SETTLED', 'VOID') and coalesce(b.settled_at, b.created_at) >= $1::timestamptz and coalesce(b.settled_at, b.created_at) < $2::timestamptz
          and exists (select 1 from public.arena_picks p where p.battle_id = b.id and p.reward_eligible)
          and not exists (select 1 from public.arena_pick_settlements s where s.battle_id = b.id)`,
      [startIso, endIso],
    );
    return Number(pending?.n ?? 0) > 0;
  };
  if (await frozen(db)) return { status: "ALREADY_FINALIZED", kind, start };
  if (await waiting(db)) return { status: "WAITING_FOR_SETTLEMENT", kind, start };

  // ---- 1. the final close verification of every prize winner that has a holder wallet (outside any transaction) ----
  const preview = await computeStanding(db, kind, start, settings);
  if (preview.ranked.length === 0) return { status: "NO_PARTICIPANTS", kind, start };
  const reader = ctx.reader === undefined ? await getChainReader() : ctx.reader;
  // NOT LAUNCHED (no official address configured): nothing can be verified, so no bonus is evaluated — every bonus is NONE (0 %).
  // Launched but unverifiable (reader missing / contract metadata unreadable): a bonus that could still qualify WAITS as PENDING VERIFICATION.
  const notLaunched = ctx.reader === undefined && !getTokenStatus().launched;
  const meta = reader && !notLaunched ? await verifiedTokenMetadata(db, reader, ctx.now().getTime()) : null;
  if (cfg.enabled && reader && meta) {
    const winners = preview.ranked.filter((r) => (preview.prizeOf.get(r.row.userId) ?? 0n) > 0n).map((r) => r.row.userId);
    const wallets = await walletsOf(db, winners);
    for (const userId of wallets.keys()) {
      await verifyForClose(db, { now: ctx.now }, { userId, reader, settings }).catch(() => undefined); // a failed read is recorded; the bonus then waits
    }
  }

  // ---- 2. freeze ----
  const tiers = meta ? buildBonusTiers(cfg, meta.decimals) : [];
  return db.transaction(async (tx): Promise<FinalizeResult> => {
    // A finalization runs SIDE BY SIDE with other finalizations but never through a lifecycle action (launch / reset / end season): it waits for it
    // and then sees which season owns the period — so no prize is credited after a launch looked for reward obligations (services/lifecycleLock.ts).
    await lockLifecycleShared(tx);
    if (await frozen(tx)) return { status: "ALREADY_FINALIZED", kind, start };
    if (await waiting(tx)) return { status: "WAITING_FOR_SETTLEMENT", kind, start };
    const ownerSeason = await periodSeasonId(tx, kind, start);
    if (!ownerSeason) return { status: "NO_PARTICIPANTS", kind, start }; // only archived development picks: never finalized, never paid
    const standing = await computeStanding(tx, kind, start, settings);
    if (standing.ranked.length === 0) return { status: "NO_PARTICIPANTS", kind, start };
    const { ranked, eligible, pool, prizeOf } = standing;
    const streaks = await pickStreaks(tx, kind, start, ranked.map((r) => r.row.userId));

    // Accounts under review do NOT lose their place (nobody shifts up silently): a prize position they hold is HELD for an admin.
    const heldRows = await tx.query<{ telegram_user_id: number; reason: string }>(
      `select tu.telegram_user_id,
              case when ra.review_state = 'SUSPENDED' then 'SUSPENDED' when ra.review_state = 'REVIEW' or tu.status = 'FLAGGED' then 'REVIEW' when tu.status = 'BANNED' then 'BANNED' end as reason
         from public.telegram_users tu left join public.arena_reward_accounts ra on ra.telegram_user_id = tu.telegram_user_id
        where tu.telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)
          and (coalesce(ra.review_state, 'NORMAL') <> 'NORMAL' or tu.status in ('FLAGGED', 'BANNED'))`,
      [json(ranked.map((r) => String(r.row.userId)))],
    );
    const heldReason = new Map(heldRows.map((h) => [Number(h.telegram_user_id), h.reason]));
    const winnerIds = ranked.filter((r) => (prizeOf.get(r.row.userId) ?? 0n) > 0n).map((r) => r.row.userId);
    const wallets = cfg.enabled && !notLaunched ? await walletsOf(tx, winnerIds) : new Map<number, string>();

    let awarded = 0n;
    for (const id of winnerIds) awarded += prizeOf.get(id) as bigint;
    const returned = pool - awarded;
    const terms = asTerms(win, qualifyHours(settings, kind), cfg.holderMaxAgeHours);
    const reconcileUntil = new Date(nowMs + cfg.holderReconcileHours * HOUR).toISOString();

    // The first insert wins. A concurrent finalizer that lost the race (the winner committed between our check and this insert) stops here, cleanly.
    const won = await tx.query(
      `insert into public.arena_leaderboards
         (kind, period_start, prize_pool_micro, prize_split_bps, minimum_picks, points_per_correct_pick, holder_bonus_tiers, holder_qualification_hours, holder_max_gap_hours,
          bonus_reconcile_until, participants, eligible_participants, base_awarded_micro, returned_to_reserve_micro, finalized_at, season_id)
       values ($1, $2::date, $3::numeric, $4::jsonb, $5, $6, $7::jsonb, $8, $9, $10::timestamptz, $11, $12, $13::numeric, $14::numeric, $15::timestamptz, $16::uuid) on conflict (kind, period_start) do nothing returning period_start`,
      [
        kind, start, pool.toString(), json(cfg.prizeSplitBps), minimumPicksFor(settings, kind), cfg.pointsPerCorrectPick,
        json(frozenTierTerms(cfg)), qualifyHours(settings, kind), cfg.holderMaxAgeHours,
        reconcileUntil, ranked.length, eligible.length, awarded.toString(), returned.toString(), ctx.now().toISOString(), ownerSeason,
      ],
    );
    if (won.length === 0) return { status: "ALREADY_FINALIZED", kind, start };

    let credited = 0;
    let held = 0;
    let bonusesCredited = 0;
    let bonusesPending = 0;
    for (const r of ranked) {
      const a = r.row.agg;
      const userId = r.row.userId;
      const base = prizeOf.get(userId) ?? 0n;
      const hold = base > 0n ? heldReason.get(userId) : undefined;
      const baseStatus = base === 0n ? "NONE" : hold ? "HELD" : "CREDITED";
      const st = streaks.get(userId);

      // THE HOLDER BONUS — only on an earned prize, only for a member with a verified holder wallet, only from the evidence.
      let bonusStatus: "NONE" | "PENDING_VERIFICATION" | "CREDITED" | "HELD" = "NONE";
      let bonusTier: BonusTier | null = null;
      let bonusMicro = 0n;
      let evidence: string | null = null;
      const wallet = wallets.get(userId) ?? null;
      if (base > 0n && wallet) {
        if (!meta) {
          // The token exists but its contract cannot be verified right now: balances cannot be compared (that needs the contract's decimals), so
          // nothing is assumed — the bonus waits (the base prize never does). A winner whose verified history is too recent to qualify ANY tier,
          // whatever the balances, is settled NONE at once: there is nothing to wait for.
          const history = await loadObservations(tx, userId, { sinceMs: terms.startsAtMs - terms.requiredMs - terms.maxGapMs });
          if (cannotHaveQualified(history, terms)) evidence = json({ wallet, decision: "NONE", reason: "NO_HISTORY_LONG_ENOUGH", tokenDecimals: null });
          else {
            evidence = json({ wallet, decision: "PENDING_VERIFICATION", reason: "TOKEN_METADATA_UNVERIFIED", tokenDecimals: null });
            bonusStatus = "PENDING_VERIFICATION";
          }
        } else {
          const obs = await loadObservations(tx, userId, { sinceMs: terms.startsAtMs - terms.requiredMs - terms.maxGapMs });
          const decision = decideBonus({ tiers, observations: obs, terms });
          evidence = evidenceJson(decision, wallet, meta.decimals);
          if (decision.kind === "QUALIFIED") {
            bonusTier = decision.tier;
            bonusMicro = applyBonus(base, decision.tier.bonusBps);
            bonusStatus = baseStatus === "HELD" ? "HELD" : "CREDITED";
          } else if (decision.kind === "PENDING_VERIFICATION") bonusStatus = "PENDING_VERIFICATION";
        }
      }
      const hasBonus = bonusStatus === "CREDITED" || bonusStatus === "HELD";

      await tx.query(
        `insert into public.arena_leaderboard_results
           (kind, period_start, telegram_user_id, character_id, hero_name, class_id, rank, points, picks, correct_picks, accuracy_bps, current_streak, best_streak, prize_eligible, prize_rank, tie_size,
            base_prize_micro, base_status, hold_reason, bonus_status, bonus_tier_index, bonus_label, bonus_bps, bonus_micro, bonus_evidence, bonus_resolved_at)
         values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::numeric, $18, $19, $20, $21, $22, $23, $24::numeric, $25::jsonb, $26::timestamptz)`,
        [
          kind, start, userId, a.character_id, a.name ?? "Unknown hero", a.class_id ?? "warrior", r.rank, r.row.points, r.row.picks, r.row.correct, accuracyBps(r.row.correct, r.row.picks), st?.current ?? 0, st?.best ?? 0,
          r.prizeEligible, r.prizeRank, r.tieSize, base.toString(), baseStatus, hold ?? null, bonusStatus, hasBonus ? (bonusTier as BonusTier).index : null, hasBonus ? (bonusTier as BonusTier).label : null,
          hasBonus ? (bonusTier as BonusTier).bonusBps : 0, bonusMicro.toString(), evidence, bonusStatus === "NONE" && evidence === null ? null : ctx.now().toISOString(),
        ],
      );
      if (baseStatus === "CREDITED") {
        await lockRewardAccount(tx, userId);
        await postRewardLedger(tx, {
          userId, kind: leaderboardKind(kind, "BASE"), claimableDelta: base, earnedDelta: base, periodKind: kind, periodStart: start,
          meta: { rank: r.rank, prizeRank: r.prizeRank, tieSize: r.tieSize, points: r.row.points, picks: r.row.picks, correctPicks: r.row.correct, accuracyBps: accuracyBps(r.row.correct, r.row.picks) },
          idempotencyKey: `lb-base:${kind}:${start}:${userId}`,
        });
        credited++;
        if (bonusStatus === "CREDITED" && bonusTier) {
          await postRewardLedger(tx, {
            userId, kind: leaderboardKind(kind, "BONUS"), claimableDelta: bonusMicro, earnedDelta: bonusMicro, periodKind: kind, periodStart: start,
            meta: { rank: r.rank, tier: bonusTier.label, tierIndex: bonusTier.index, bonusBps: bonusTier.bonusBps, base: base.toString() },
            idempotencyKey: `lb-bonus:${kind}:${start}:${userId}`,
          });
          bonusesCredited++;
        }
      } else if (baseStatus === "HELD") held++;
      if (bonusStatus === "PENDING_VERIFICATION") bonusesPending++;
    }
    return { status: "FINALIZED", kind, start, participants: ranked.length, eligible: eligible.length, credited, held, bonusesCredited, bonusesPending, baseAwardedMicro: awarded, returnedMicro: returned };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// RECONCILIATION of a bonus whose close verification failed
// ---------------------------------------------------------------------------------------------------------------------
export type ReconcileOutcome = "CREDITED" | "HELD" | "NONE" | "EXPIRED" | "STILL_PENDING" | "NOT_PENDING";

interface PendingRow {
  kind: PeriodKind;
  period_start: string;
  telegram_user_id: number;
  base_prize_micro: string;
  base_status: "CREDITED" | "HELD";
  holder_bonus_tiers: unknown;
  holder_qualification_hours: number;
  holder_max_gap_hours: number;
  bonus_reconcile_until: Date;
  rank: number;
}

/**
 * Re-checks ONE pending bonus: a fresh verification (when a reader exists and the window is open), then the SAME decision rule as
 * at finalization against the board's FROZEN terms. Qualified → the bonus is credited (or held with its base prize); not
 * qualified → NONE; still no close observation → it waits until the window ends, then EXPIRES. Never credits blindly.
 */
export async function reconcileBonus(db: Db, ctx: Pick<BoardCtx, "now" | "settings"> & { reader?: RewardChainReader | null }, kind: PeriodKind, start: string, userId: number): Promise<ReconcileOutcome> {
  const load = (q: Queryable) =>
    q.query<PendingRow>(
      `select r.kind, r.period_start::text, r.telegram_user_id, r.base_prize_micro::text, r.base_status, l.holder_bonus_tiers, l.holder_qualification_hours, l.holder_max_gap_hours, l.bonus_reconcile_until, r.rank
         from public.arena_leaderboard_results r join public.arena_leaderboards l on l.kind = r.kind and l.period_start = r.period_start
        where r.kind = $1 and r.period_start = $2::date and r.telegram_user_id = $3 and r.bonus_status = 'PENDING_VERIFICATION'`,
      [kind, start, userId],
    );
  const [pre] = await load(db);
  if (!pre) return "NOT_PENDING";
  const nowMs = ctx.now().getTime();
  const windowOpen = nowMs <= new Date(pre.bonus_reconcile_until).getTime();
  const reader = ctx.reader === undefined ? await getChainReader() : ctx.reader;
  if (windowOpen && reader) await verifyForClose(db, { now: ctx.now }, { userId, reader, settings: ctx.settings }).catch(() => undefined);
  // The CONTRACT's decimals turn the board's frozen whole-token tier minimums into balance thresholds; without a verified contract nothing can be decided.
  const meta = reader ? await verifiedTokenMetadata(db, reader, ctx.now().getTime()) : null;

  return db.transaction(async (tx): Promise<ReconcileOutcome> => {
    await lockRewardAccount(tx, userId);
    const [row] = await tx.query<PendingRow>(
      `select r.kind, r.period_start::text, r.telegram_user_id, r.base_prize_micro::text, r.base_status, l.holder_bonus_tiers, l.holder_qualification_hours, l.holder_max_gap_hours, l.bonus_reconcile_until, r.rank
         from public.arena_leaderboard_results r join public.arena_leaderboards l on l.kind = r.kind and l.period_start = r.period_start
        where r.kind = $1 and r.period_start = $2::date and r.telegram_user_id = $3 and r.bonus_status = 'PENDING_VERIFICATION' for update of r`,
      [kind, start, userId],
    );
    if (!row) return "NOT_PENDING";
    const win = periodWindowOf(kind, start);
    const terms = asTerms(win, Number(row.holder_qualification_hours), Number(row.holder_max_gap_hours));
    const [acct] = await tx.query<{ w: string | null }>("select holder_wallet_address as w from public.arena_reward_accounts where telegram_user_id = $1", [userId]);
    const nowIso = ctx.now().toISOString();
    const base = BigInt(row.base_prize_micro);
    // No verified contract: STILL PENDING until the window ends, then EXPIRED — never credited blindly.
    const observations = await loadObservations(tx, userId, { sinceMs: terms.startsAtMs - terms.requiredMs - terms.maxGapMs });
    const decision = meta ? decideBonus({ tiers: frozenTiers(row.holder_bonus_tiers, meta.decimals), observations, terms }) : null;
    const noHistory = !decision && cannotHaveQualified(observations, terms); // contract unverifiable, but no tier could ever have qualified: NONE, decimals-free
    const evidence = decision && meta ? evidenceJson(decision, acct?.w ?? null, meta.decimals) : json({ wallet: acct?.w ?? null, decision: noHistory ? "NONE" : "PENDING_VERIFICATION", reason: noHistory ? "NO_HISTORY_LONG_ENOUGH" : "TOKEN_METADATA_UNVERIFIED", tokenDecimals: null });

    if (noHistory || (decision && decision.kind === "NONE")) {
      await tx.query("update public.arena_leaderboard_results set bonus_status = 'NONE', bonus_evidence = $4::jsonb, bonus_resolved_at = $5::timestamptz where kind = $1 and period_start = $2::date and telegram_user_id = $3", [kind, start, userId, evidence, nowIso]);
      return "NONE";
    }
    if (!decision || decision.kind === "PENDING_VERIFICATION") {
      if (new Date(row.bonus_reconcile_until).getTime() >= nowMs) return "STILL_PENDING";
      await tx.query("update public.arena_leaderboard_results set bonus_status = 'EXPIRED', bonus_evidence = $4::jsonb, bonus_resolved_at = $5::timestamptz where kind = $1 and period_start = $2::date and telegram_user_id = $3", [kind, start, userId, evidence, nowIso]);
      return "EXPIRED";
    }
    const bonus = applyBonus(base, decision.tier.bonusBps);
    const status = row.base_status === "HELD" ? "HELD" : "CREDITED";
    await tx.query(
      `update public.arena_leaderboard_results set bonus_status = $4, bonus_tier_index = $5, bonus_label = $6, bonus_bps = $7, bonus_micro = $8::numeric, bonus_evidence = $9::jsonb, bonus_resolved_at = $10::timestamptz
        where kind = $1 and period_start = $2::date and telegram_user_id = $3`,
      [kind, start, userId, status, decision.tier.index, decision.tier.label, decision.tier.bonusBps, bonus.toString(), evidence, nowIso],
    );
    if (status === "CREDITED") {
      await postRewardLedger(tx, {
        userId, kind: leaderboardKind(kind, "BONUS"), claimableDelta: bonus, earnedDelta: bonus, periodKind: kind, periodStart: start,
        meta: { rank: Number(row.rank), tier: decision.tier.label, tierIndex: decision.tier.index, bonusBps: decision.tier.bonusBps, base: base.toString(), reconciled: true },
        idempotencyKey: `lb-bonus:${kind}:${start}:${userId}`,
      });
    }
    return status;
  });
}

/** Reconciles up to `limit` pending bonuses, oldest first. Never throws into the caller. */
export async function reconcilePendingBonuses(db: Db, ctx: Pick<BoardCtx, "now" | "settings"> & { reader?: RewardChainReader | null }, limit = 25): Promise<{ checked: number; credited: number; expired: number }> {
  const out = { checked: 0, credited: 0, expired: 0 };
  let rows: Array<{ kind: PeriodKind; period_start: string; telegram_user_id: number }>;
  try {
    rows = await db.query("select kind, period_start::text, telegram_user_id from public.arena_leaderboard_results where bonus_status = 'PENDING_VERIFICATION' order by period_start, telegram_user_id limit $1", [limit]);
  } catch (error) {
    if (/does not exist/i.test(error instanceof Error ? error.message : String(error))) return out;
    throw error;
  }
  for (const r of rows) {
    const o = await reconcileBonus(db, ctx, r.kind, r.period_start, Number(r.telegram_user_id)).catch(() => "STILL_PENDING" as const);
    out.checked++;
    if (o === "CREDITED" || o === "HELD") out.credited++;
    else if (o === "EXPIRED") out.expired++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The sweep (tick / worker / right after a settlement)
// ---------------------------------------------------------------------------------------------------------------------
export interface BoardSweepResult {
  finalized: number;
  waiting: number;
  failed: number;
  periods: string[];
  reconciled: { checked: number; credited: number; expired: number };
}

const MISSING = /relation .*(arena_pick_scores|arena_leaderboards|arena_leaderboard_results|arena_holder_observations|arena_reward_[a-z_]+).* does not exist/i;

/**
 * Finalizes every ended Daily and Weekly period that has scores and no frozen result yet, oldest first, then reconciles pending
 * bonuses. Cheap when idle (indexed queries), safe to call as often as you like and from many workers, a quiet no-op before the
 * migration, and it never throws into the caller.
 */
export async function finalizeDueBoards(db: Db, ctx: BoardCtx, onError: (label: string, error: unknown) => void = defaultOnError): Promise<BoardSweepResult> {
  const out: BoardSweepResult = { finalized: 0, waiting: 0, failed: 0, periods: [], reconciled: { checked: 0, credited: 0, expired: 0 } };
  if (!(await rewardsReady(db, ctx.now().getTime()))) return out;
  const nowMs = ctx.now().getTime();
  for (const kind of PERIOD_KINDS) {
    let due: Array<{ start: string }>;
    try {
      due = await db.query<{ start: string }>(
        `select distinct ${scoreColumn(kind)}::text as start from public.arena_pick_scores s
          where ${scoreColumn(kind)} < $1::date and not exists (select 1 from public.arena_leaderboards l where l.kind = $2 and l.period_start = ${scoreColumn(kind)})
            and ${COUNTING_SEASON_SCORE} order by 1 limit 8`,
        [periodWindow(kind, nowMs).start, kind],
      );
    } catch (error) {
      if (MISSING.test(error instanceof Error ? error.message : String(error))) return out;
      throw error;
    }
    for (const d of due) {
      try {
        const r = await finalizePeriod(db, ctx, kind, d.start);
        if (r.status === "FINALIZED") {
          out.finalized++;
          out.periods.push(`${kind}:${d.start}`);
        } else if (r.status === "WAITING_FOR_SETTLEMENT") out.waiting++;
      } catch (error) {
        out.failed++;
        onError(`${kind}:${d.start}`, error);
      }
    }
  }
  try {
    out.reconciled = await reconcilePendingBonuses(db, ctx);
  } catch (error) {
    out.failed++;
    onError("bonus reconciliation", error);
  }
  return out;
}

/** The old name of the sweep (it used to finalize weeks only). Kept so existing call sites keep working; it finalizes both boards. */
export const finalizeDueWeeks = finalizeDueBoards;

function defaultOnError(label: string, error: unknown): void {
  console.error(`[rewards] finalizing ${label} failed (will retry):`, error instanceof Error ? error.message : error);
}

// ---------------------------------------------------------------------------------------------------------------------
// A prize held for review is resolved by an admin (audited by the caller): release it to the member, or forfeit it to the reserve
// ---------------------------------------------------------------------------------------------------------------------
export type ResolvePrizeResult = { ok: true; status: "CREDITED" | "FORFEITED"; baseMicro: bigint; bonusMicro: bigint } | { ok: false; reason: "NOT_FOUND" | "NOT_HELD" | "REASON_REQUIRED" };

/** Releasing credits the base prize and — when its bonus was decided and held with it — the bonus too (separate ledger entry). Forfeiting returns both to the reserve. */
export async function resolveHeldPrize(db: Db, ctx: { now: () => Date }, input: { kind: PeriodKind; start: string; userId: number; action: "release" | "forfeit"; reason: string; actor: string }): Promise<ResolvePrizeResult> {
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 3) return { ok: false, reason: "REASON_REQUIRED" };
  return db.transaction(async (tx): Promise<ResolvePrizeResult> => {
    await lockRewardAccount(tx, input.userId);
    const [row] = await tx.query<{ base_prize_micro: string; base_status: string; bonus_status: string; bonus_micro: string; bonus_tier_index: number | null; bonus_bps: number }>(
      "select base_prize_micro::text, base_status, bonus_status, bonus_micro::text, bonus_tier_index, bonus_bps from public.arena_leaderboard_results where kind = $1 and period_start = $2::date and telegram_user_id = $3 for update",
      [input.kind, input.start, input.userId],
    );
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (row.base_status !== "HELD") return { ok: false, reason: "NOT_HELD" };
    const base = BigInt(row.base_prize_micro);
    const bonus = row.bonus_status === "HELD" ? BigInt(row.bonus_micro) : 0n;
    const next = input.action === "release" ? "CREDITED" : "FORFEITED";
    // The bonus follows its prize: HELD → same fate; a still-PENDING one is released as pending (it can still be reconciled) or, on forfeit, expires with the prize.
    const nextBonus = row.bonus_status === "HELD" ? next : row.bonus_status === "PENDING_VERIFICATION" && next === "FORFEITED" ? "EXPIRED" : row.bonus_status;
    const nowIso = ctx.now().toISOString();
    await tx.query(
      `update public.arena_leaderboard_results set base_status = $4, bonus_status = $5, bonus_resolved_at = case when bonus_status is distinct from $5 then $6::timestamptz else bonus_resolved_at end,
              resolved_at = $6::timestamptz, resolved_by = $7, resolution_reason = $8
        where kind = $1 and period_start = $2::date and telegram_user_id = $3 and base_status = 'HELD'`,
      [input.kind, input.start, input.userId, next, nextBonus, nowIso, input.actor, reason],
    );
    if (next === "CREDITED") {
      await postRewardLedger(tx, { userId: input.userId, kind: leaderboardKind(input.kind, "BASE"), claimableDelta: base, earnedDelta: base, periodKind: input.kind, periodStart: input.start, meta: { releasedBy: input.actor, reason }, idempotencyKey: `lb-base:${input.kind}:${input.start}:${input.userId}` });
      if (bonus > 0n) await postRewardLedger(tx, { userId: input.userId, kind: leaderboardKind(input.kind, "BONUS"), claimableDelta: bonus, earnedDelta: bonus, periodKind: input.kind, periodStart: input.start, meta: { releasedBy: input.actor, reason, tierIndex: row.bonus_tier_index, bonusBps: row.bonus_bps }, idempotencyKey: `lb-bonus:${input.kind}:${input.start}:${input.userId}` });
    }
    return { ok: true, status: next, baseMicro: base, bonusMicro: bonus };
  });
}

/** Admin: give up on a bonus that is still PENDING VERIFICATION (audited by the caller). The base prize is untouched. */
export async function expirePendingBonus(db: Db, ctx: { now: () => Date }, input: { kind: PeriodKind; start: string; userId: number; reason: string; actor: string }): Promise<{ ok: true } | { ok: false; reason: "NOT_PENDING" | "REASON_REQUIRED" }> {
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 3) return { ok: false, reason: "REASON_REQUIRED" };
  const rows = await db.query(
    "update public.arena_leaderboard_results set bonus_status = 'EXPIRED', bonus_resolved_at = $4::timestamptz, bonus_evidence = coalesce(bonus_evidence, '{}'::jsonb) || $5::jsonb where kind = $1 and period_start = $2::date and telegram_user_id = $3 and bonus_status = 'PENDING_VERIFICATION' returning telegram_user_id",
    [input.kind, input.start, input.userId, ctx.now().toISOString(), json({ expiredBy: input.actor, reason })],
  );
  return rows.length > 0 ? { ok: true } : { ok: false, reason: "NOT_PENDING" };
}
