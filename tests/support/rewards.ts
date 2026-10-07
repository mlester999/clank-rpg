import { buildBonusTiers } from "@/domain/rewards/holderBonus";
import { LOGICAL_DECIMALS, parseTokenAmount } from "@/domain/rewards/tokens";
import { utcWeekStart } from "@/domain/rewards/time";
import { DEFAULT_SETTINGS, type GameSettings } from "@/domain/settings";
import type { Db } from "@/server/db/types";
import type { ClaimTarget } from "@/server/rewards/claims";
import { createSimulatedChainReader, type RewardChainReader, type SimulatedChainReader } from "@/server/rewards/chain";
import { finalizePeriod } from "@/server/rewards/leaderboard";
import { lockRewardAccount, postRewardLedger } from "@/server/rewards/ledger";
import { settleBattleRewards } from "@/server/rewards/settlement";
import { advanceArena } from "@/server/services/arena";
import { submitPick } from "@/server/services/picks";

import { seedEligibleMember } from "./db";
import { describeStage, finishBattle, type Stage } from "./stage";

/** The simulated token CONTRACT's own decimals() — CHAIN amounts (balances, transfers) are in this scale. The contract is the only authority for it. */
export const DECIMALS = 18;
/** LOGICAL reward amounts (prizes, bonuses, ledger, claims, pools): micro-tokens, independent of any contract. `tokens(30000)` is "30,000 $CLANKRPG". */
export const tokens = (n: number | string): bigint => parseTokenAmount(String(n), LOGICAL_DECIMALS);
/** CHAIN amounts (balances, transfer values) at the simulated contract's decimals — what `balanceOf` / a Transfer event carries. */
export const chainTokens = (n: number | string, decimals = DECIMALS): bigint => parseTokenAmount(String(n), decimals);

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number => Date.UTC(y, m - 1, d, h, min, s);

export const settingsWith = (over: Partial<GameSettings["arena_picks"]> = {}): GameSettings => ({ ...DEFAULT_SETTINGS, arena_picks: { ...DEFAULT_SETTINGS.arena_picks, ...over } });

export const TOKEN = "0x00000000000000000000000000000000000c1a4c";
export const TREASURY = "0x0000000000000000000000000000000000007ea5";
export const CHAIN_ID = 4663;
export const WALLET_A = "0x52908400098527886e0f7030069857d2e4169ee7";
export const WALLET_B = "0x8617e340b3d01fa5f11f306f4090fd50e238070d";
export const WALLET_C = "0xde709f2102306220921060314715629080e2fb77";

/** A fresh in-memory chain (balances + transfers) for the configured test token. Read-only for the app: payouts are simulated by the TEST, as an admin would pay by hand. */
export function newChain(opts: { decimals?: number } = {}): SimulatedChainReader {
  return createSimulatedChainReader({ tokenAddress: TOKEN, decimals: opts.decimals ?? DECIMALS, chainId: CHAIN_ID });
}

/** The claim target for a (verified) simulated chain at its contract decimals (default 18; pass `{ tokenDecimals }` for another scale), or "not launched" for `null`. */
export const targetFor = (chain: SimulatedChainReader | null, over: Partial<ClaimTarget> = {}): ClaimTarget => ({
  enabled: chain !== null,
  reason: chain ? null : "NOT_LAUNCHED",
  tokenAddress: chain ? TOKEN : null,
  chainId: chain ? CHAIN_ID : null,
  tokenDecimals: chain ? DECIMALS : null,
  forbiddenRecipients: [TOKEN, TREASURY],
  ...over,
});

/** Submit a free pick as a member (eligible by default via seedEligibleMember). */
export const pickAs = (db: Db, s: Stage, userId: number, characterId: string) =>
  submitPick(db, { now: s.clock.now, allowDemo: true }, { telegramUserId: userId, battleId: s.battleId, characterId, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold });

/** N eligible members who pick `characterId` before the lock. */
export async function pickers(db: Db, s: Stage, characterId: string, n: number): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = await seedEligibleMember(db);
    const r = await pickAs(db, s, id, characterId);
    if (!r.ok) throw new Error(`pick failed: ${r.reason}`);
    ids.push(id);
  }
  return ids;
}

export const loser = (s: Stage, n = 0): string => s.fighters.filter((f) => f !== s.winnerId)[n]!;

/** After the previous battle settled: put the NEXT battle on stage (clock at the moment its eight appear). */
export async function stageNext(db: Db, s: Stage): Promise<Stage> {
  const [next] = await db.query<{ starts_at: Date }>("select starts_at from public.arena_battles where status = 'SIMULATED' order by sequence limit 1");
  s.clock.ms = new Date(next!.starts_at).getTime();
  await advanceArena(db, s.ctx);
  return describeStage(db, s.clock, s.ctx);
}

/** Scores the settled battle's picks (the reward module's only per-battle job: nothing is credited). */
export const settle = (db: Db, s: Stage, settings: GameSettings = settingsWith(), battleId = s.battleId) =>
  settleBattleRewards(db, { now: s.clock.now, settings }, battleId);

/** Credit a member through the ledger exactly as an admin adjustment would (claim tests that are not about leaderboards). */
export async function credit(db: Db, userId: number, amount: bigint, key = `test-credit-${userId}-${Math.random().toString(36).slice(2)}`): Promise<void> {
  await postRewardLedger(db, { userId, kind: "ADMIN_ADJUSTMENT", claimableDelta: amount, earnedDelta: amount, meta: { test: true }, idempotencyKey: `admin:${key}` });
}

export async function balanceOf(db: Db, userId: number): Promise<{ claimable: bigint; reserved: bigint; claimed: bigint; earned: bigint }> {
  const [r] = await db.query<{ claimable: string; reserved: string; claimed_total: string; earned_total: string }>(
    "select claimable::text, reserved::text, claimed_total::text, earned_total::text from public.arena_reward_accounts where telegram_user_id = $1",
    [userId],
  );
  return r ? { claimable: BigInt(r.claimable), reserved: BigInt(r.reserved), claimed: BigInt(r.claimed_total), earned: BigInt(r.earned_total) } : { claimable: 0n, reserved: 0n, claimed: 0n, earned: 0n };
}

export async function ledgerCount(db: Db, kind?: string): Promise<number> {
  return (await db.query<{ n: number }>(kind ? "select count(*)::int as n from public.arena_reward_ledger where kind = $1" : "select count(*)::int as n from public.arena_reward_ledger", kind ? [kind] : []))[0]!.n;
}

/** A valid, unique-per-member EVM address (never zero / burn / precompile). */
export const walletFor = (userId: number): string => `0x${(0x1000000 + userId).toString(16).padStart(40, "0")}`;

/** One battle: `userId` picks the winner (everyone else is a bystander), the arena settles it, the picks are scored. */
export async function winRound(db: Db, s: Stage, userId: number, extraWinners: number[] = [], losers: number[] = []): Promise<void> {
  for (const u of [userId, ...extraWinners]) {
    const r = await pickAs(db, s, u, s.winnerId);
    if (!r.ok) throw new Error(`pick failed: ${r.reason}`);
  }
  for (const u of losers) {
    const r = await pickAs(db, s, u, loser(s));
    if (!r.ok) throw new Error(`pick failed: ${r.reason}`);
  }
  await finishBattle(db, s);
  await settle(db, s);
}

/** Moves the arena clock forward by `ms` (e.g. across a UTC midnight / Monday) and puts the next battle on stage. */
export async function stageAfterJump(db: Db, s: Stage, ms: number): Promise<Stage> {
  s.clock.ms += ms;
  for (let i = 0; i < 6; i++) {
    await advanceArena(db, s.ctx);
    const [b] = await db.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'SIMULATED' and starts_at <= $1::timestamptz", [s.clock.now().toISOString()]);
    if (b!.n > 0) return describeStage(db, s.clock, s.ctx);
    s.clock.ms += 1_000;
  }
  throw new Error("no battle came on stage after the clock jump");
}

// ---------------------------------------------------------------------------------------------------------------------
// SYNTHETIC SCORED PICKS — leaderboard maths without playing hundreds of arena battles
// ---------------------------------------------------------------------------------------------------------------------
export interface ScoreSpec {
  user: number;
  /** The UTC day, "YYYY-MM-DD". */
  day: string;
  /** How many valid picks the member made that day — EVERY one counts (there is no daily cap). */
  picks: number;
  /** Of those picks, how many were correct (the first `correct` of the day, so streaks are predictable). */
  correct: number;
}

/** One COMPLETED cycle to hang synthetic battles on (never fought, never on stage). */
async function syntheticCycle(db: Db, seasonId?: string): Promise<{ season: string; cycle: string }> {
  // The battles (and so the scores) belong to `seasonId`, or to the ACTIVE season.
  const [season] = await db.query<{ id: string }>("select id from public.seasons where ($1::uuid is null and status = 'ACTIVE') or id = $1::uuid limit 1", [seasonId ?? null]);
  const [existing] = await db.query<{ id: string }>("select id from public.arena_cycles where seed = 'synthetic' limit 1");
  if (existing) return { season: season!.id, cycle: existing.id };
  const [made] = await db.query<{ id: string }>("insert into public.arena_cycles (number, season_id, status, seed, hero_count, completed_at) values (900000 + (select count(*)::int from public.arena_cycles), $1, 'COMPLETED', 'synthetic', 0, now()) returning id", [season!.id]);
  return { season: season!.id, cycle: made!.id };
}

/**
 * Writes picks straight into the scoring tables (through the same database guards the real settlement hits), one synthetic
 * VOID-status battle + settlement per "pick slot" of a day, shared by every member who has a pick in that slot. Members are created
 * eligible. Correct picks come first in a member's day, so streaks are predictable.
 */
export async function seedScores(db: Db, specs: ScoreSpec[], opts: { points?: number; seasonId?: string } = {}): Promise<void> {
  const points = opts.points ?? DEFAULT_SETTINGS.arena_picks.pointsPerCorrectPick;
  const { season, cycle } = await syntheticCycle(db, opts.seasonId);
  const days = [...new Set(specs.map((s) => s.day))];
  for (const day of days) {
    const daySpecs = specs.filter((s) => s.day === day);
    for (const sp of daySpecs) await seedEligibleMember(db, { id: sp.user });
    const slots = Math.max(...daySpecs.map((s) => s.picks));
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    for (let k = 0; k < slots; k++) {
      const atIso = new Date(dayMs + 12 * HOUR + k * 1000).toISOString();
      const rows = daySpecs.filter((s) => k < s.picks);
      const [battle] = await db.query<{ id: string }>("insert into public.arena_battles (season_id, cycle_id, status, starts_at, settled_at) values ($1, $2, 'VOID', $3::timestamptz, $3::timestamptz) returning id", [season, cycle, atIso]);
      const correctCount = rows.filter((s) => k < s.correct).length;
      const [settlement] = await db.query<{ id: string }>(
        `insert into public.arena_pick_settlements (battle_id, status, picks_total, correct_picks, correct_pickers, points_awarded, valid_picks, config, settled_at)
         values ($1, 'SCORED', $2, $3, $3, $4, $2, '{}'::jsonb, $5::timestamptz) returning id`,
        [battle!.id, rows.length, correctCount, correctCount * points, atIso],
      );
      for (const s of rows) {
        const correct = k < s.correct;
        await db.query(
          `insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points)
           values ($1, $2, $3, $4::date, $5::date, $6, $7)`,
          [s.user, battle!.id, settlement!.id, utcWeekStart(dayMs), day, correct, correct ? points : 0],
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// HOLDER EVIDENCE — authoritative balance reads with explicit timestamps
// ---------------------------------------------------------------------------------------------------------------------
/** Binds a verified holder wallet as of `verifiedAtMs` (the account row only; observations are separate). */
export async function bindWallet(db: Db, userId: number, opts: { wallet?: string; verifiedAtMs: number }): Promise<string> {
  await lockRewardAccount(db, userId);
  const wallet = opts.wallet ?? walletFor(userId);
  await db.query("update public.arena_reward_accounts set holder_wallet_address = $2, wallet_verified_at = $3::timestamptz where telegram_user_id = $1", [userId, wallet, new Date(opts.verifiedAtMs).toISOString()]);
  return wallet;
}

export const TIERS = buildBonusTiers(DEFAULT_SETTINGS.arena_picks, DECIMALS);

/**
 * Gives a member a VERIFIED holder wallet with a long, steady verification history at tier `tierIndex`'s minimum balance (tier 0 = FREE:
 * the wallet only). For tests that are about wallets and claims, not about continuity.
 */
export async function makeHolder(db: Db, userId: number, tierIndex: number, opts: { wallet?: string } = {}): Promise<string> {
  const now = Date.now();
  const wallet = await bindWallet(db, userId, { ...(opts.wallet ? { wallet: opts.wallet } : {}), verifiedAtMs: now - 14 * DAY });
  if (tierIndex > 0) await observeSteady(db, userId, now - 14 * DAY, now - 1000, TIERS[tierIndex]!.minimumRaw, 5 * HOUR);
  return wallet;
}

/** Appends observations (an authoritative read of the CURRENT wallet) at the given instants. */
export async function observe(db: Db, userId: number, reads: Array<{ at: number; balance: bigint; source?: "CONNECT" | "MANUAL" | "BACKGROUND" | "CLOSE" }>): Promise<void> {
  const [acc] = await db.query<{ w: string }>("select holder_wallet_address as w from public.arena_reward_accounts where telegram_user_id = $1", [userId]);
  for (const r of reads) {
    await db.query("insert into public.arena_holder_observations (telegram_user_id, wallet_address, balance_raw, observed_at, source) values ($1, $2, $3::numeric, $4::timestamptz, $5)", [userId, acc!.w, r.balance.toString(), new Date(r.at).toISOString(), r.source ?? "BACKGROUND"]);
  }
}

/** Observations every `stepMs` from `fromMs` to `toMs` (inclusive) at a constant balance — a wallet verified on schedule. */
export async function observeSteady(db: Db, userId: number, fromMs: number, toMs: number, balance: bigint, stepMs = 30 * 60_000): Promise<void> {
  const reads: Array<{ at: number; balance: bigint }> = [];
  for (let t = fromMs; t <= toMs; t += stepMs) reads.push({ at: t, balance });
  await observe(db, userId, reads);
}

// ---------------------------------------------------------------------------------------------------------------------
// FINALIZATION SHORTCUTS
// ---------------------------------------------------------------------------------------------------------------------
/** Finalizes a period "as of" `nowMs` with the given chain (null = no close verification possible). */
export const finalize = (db: Db, kind: "DAILY" | "WEEKLY", start: string, nowMs: number, over: { settings?: GameSettings; reader?: RewardChainReader | null } = {}) =>
  finalizePeriod(db, { now: () => new Date(nowMs), settings: over.settings ?? settingsWith(), reader: over.reader === undefined ? null : over.reader }, kind, start);

export interface ResultRow {
  rank: number;
  points: number;
  picks: number;
  correct_picks: number;
  accuracy_bps: number;
  prize_eligible: boolean;
  prize_rank: number | null;
  tie_size: number;
  base_prize_micro: string;
  base_status: string;
  bonus_status: string;
  bonus_tier_index: number | null;
  bonus_label: string | null;
  bonus_bps: number;
  bonus_micro: string;
  bonus_evidence: unknown;
}

export async function resultOf(db: Db, kind: "DAILY" | "WEEKLY", start: string, userId: number): Promise<ResultRow | undefined> {
  return (
    await db.query<ResultRow>(
      `select rank, points, picks, correct_picks, accuracy_bps, prize_eligible, prize_rank, tie_size, base_prize_micro::text, base_status, bonus_status, bonus_tier_index, bonus_label, bonus_bps, bonus_micro::text, bonus_evidence
         from public.arena_leaderboard_results where kind = $1 and period_start = $2::date and telegram_user_id = $3`,
      [kind, start, userId],
    )
  )[0];
}

export const allResults = (db: Db, kind: "DAILY" | "WEEKLY", start: string): Promise<Array<ResultRow & { telegram_user_id: number }>> =>
  db.query(
    `select telegram_user_id, rank, points, picks, correct_picks, accuracy_bps, prize_eligible, prize_rank, tie_size, base_prize_micro::text, base_status, bonus_status, bonus_tier_index, bonus_label, bonus_bps, bonus_micro::text, bonus_evidence
       from public.arena_leaderboard_results where kind = $1 and period_start = $2::date order by rank, telegram_user_id`,
    [kind, start],
  );
