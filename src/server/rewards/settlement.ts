import { utcDate, utcWeekStart } from "@/domain/rewards/time";
import type { GameSettings } from "@/domain/settings";

import { loadSettings } from "../config/settingsRepo";
import { json, type Db } from "../db/types";

import { rewardsReady } from "./pool";

/**
 * SCORES ONE finished battle's picks, exactly once, from the authoritative Arena result — the browser contributes nothing. It
 * runs in its OWN transaction after the arena settled the battle, never inside the arena's: a scoring problem fails loudly here
 * and is retried by the sweep without ever wedging the arena.
 *
 * NO TOKEN IS EVER CREDITED HERE. Arena Picks pay nothing per battle; a correct pick produces points, and tokens are paid only
 * by the Daily and Weekly leaderboards when they are finalized (see leaderboard.ts). What a settled pick produces:
 *
 *  LEADERBOARD SCORE — EVERY valid pick (right or wrong) is recorded once in `arena_pick_scores`, and a correct one is worth
 *  `pointsPerCorrectPick`. There is NO daily scoring cap: pick #1, #20, #21 and #100 of a UTC day all count, so the Daily and
 *  Weekly boards are a race for the most correct picks (the same row feeds both). Holder status changes none of this.
 *
 *  CLANK POINTS (lifetime) — every valid correct pick earns `pointsPerCorrectPick` in the append-only points ledger, once per
 *  pick (unique row), never reset, never multiplied by holdings. Separate from the leaderboards.
 *
 * A "valid" pick is one that was reward-eligible when picks locked (Telegram identity, configured qualifying-message minimum, active hero, not
 * banned/suspended — frozen on the pick). A void battle scores nothing.
 *
 * Idempotent: UNIQUE settlement per battle, UNIQUE score row and Points row per (member, battle).
 */
export interface SettleStats {
  picks: number;
  /** Valid (eligible) correct pickers. */
  correctPickers: number;
  /** Points awarded: every valid correct pick earns `pointsPerCorrectPick` (leaderboard AND lifetime Clank Points). */
  pointsAwarded: number;
  /** Valid picks that counted toward the Daily and Weekly boards (all of them, unless the period was already frozen). */
  validPicks: number;
}

export type RewardSettleOutcome =
  | { status: "NOOP" }
  | { status: "NOT_READY" }
  | ({ status: "SETTLED"; settlementId: string; result: "SCORED" | "VOID" } & SettleStats);

interface Ctx {
  now: () => Date;
  /** Test seam; production reads the stored settings. */
  settings?: GameSettings;
}

interface PickRow {
  telegram_user_id: number;
  character_id: string;
  reward_eligible: boolean;
}

export async function settleBattleRewards(db: Db, ctx: Ctx, battleId: string): Promise<RewardSettleOutcome> {
  return db.transaction(async (tx): Promise<RewardSettleOutcome> => {
    const [battle] = await tx.query<{ status: string; winner_id: string | null; settled_at: Date | null; created_at: Date }>("select status, winner_id, settled_at, created_at from public.arena_battles where id = $1 for share", [battleId]);
    if (!battle) return { status: "NOOP" };
    if (battle.status !== "SETTLED" && battle.status !== "VOID") return { status: "NOT_READY" };
    if ((await tx.query("select 1 from public.arena_pick_settlements where battle_id = $1", [battleId])).length > 0) return { status: "NOOP" };

    const settings = ctx.settings ?? (await loadSettings(tx));
    const cfg = settings.arena_picks;
    // The UTC day / week a battle's picks belong to is the moment IT settled — deterministic across retries and late sweeps.
    const atMs = new Date(battle.settled_at ?? battle.created_at).getTime();
    const day = utcDate(atMs);
    const week = utcWeekStart(atMs);

    const picks = await tx.query<PickRow>("select telegram_user_id, character_id, reward_eligible from public.arena_picks where battle_id = $1 order by telegram_user_id", [battleId]);
    const voided = battle.status === "VOID";
    // The winner is the AUTHORITATIVE Arena #1 recorded on the battle itself — a void battle has none.
    const winnerId = voided ? null : battle.winner_id;
    const valid = picks.filter((p) => p.reward_eligible);
    const isCorrect = (p: PickRow): boolean => winnerId !== null && p.character_id === winnerId;
    const correct = valid.filter(isCorrect);

    // A finalized day / week never changes: a (practically impossible) very late pick leaves the frozen board untouched.
    const [frozen] = await tx.query<{ day: boolean; week: boolean }>(
      "select exists (select 1 from public.arena_leaderboards where kind = 'DAILY' and period_start = $1::date) as day, exists (select 1 from public.arena_leaderboards where kind = 'WEEKLY' and period_start = $2::date) as week",
      [day, week],
    );
    const boardsOpen = !frozen?.day && !frozen?.week;

    // EVERY valid pick of a battle that was actually decided counts — no per-day cap, no per-member counting, nothing to serialise.
    interface Decision { userId: number; correct: boolean; points: number }
    const decisions: Decision[] = voided || !boardsOpen ? [] : valid.map((p) => {
      const right = isCorrect(p);
      return { userId: Number(p.telegram_user_id), correct: right, points: right ? cfg.pointsPerCorrectPick : 0 };
    });
    const lifetimeEach = voided ? 0 : cfg.pointsPerCorrectPick;
    const pointsTotal = lifetimeEach * correct.length;

    const [settlement] = await tx.query<{ id: string }>(
      `insert into public.arena_pick_settlements
         (battle_id, status, winner_character_id, picks_total, correct_picks, correct_pickers, points_awarded, valid_picks, config, settled_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)
       on conflict (battle_id) do nothing returning id`,
      [
        battleId, voided ? "VOID" : "SCORED", winnerId, picks.length, winnerId ? picks.filter(isCorrect).length : 0, correct.length, pointsTotal, decisions.length,
        json({ pointsPerCorrectPick: cfg.pointsPerCorrectPick }), ctx.now().toISOString(),
      ],
    );
    if (!settlement) return { status: "NOOP" }; // another settler won the race and committed first

    // One score row per valid pick (idempotent: unique per member+battle).
    for (const d of decisions) {
      await tx.query(
        `insert into public.arena_pick_scores (telegram_user_id, battle_id, settlement_id, week_start, utc_date, correct, points)
         values ($1, $2, $3, $4::date, $5::date, $6, $7) on conflict (telegram_user_id, battle_id) do nothing`,
        [d.userId, battleId, settlement.id, week, day, d.correct, d.points],
      );
    }
    // CLANK POINTS (lifetime): every valid correct pick. One row per pick (unique).
    if (lifetimeEach > 0) {
      for (const p of correct) {
        const userId = Number(p.telegram_user_id);
        await tx.query(
          `insert into public.arena_points_ledger (telegram_user_id, kind, points, battle_id, settlement_id, week_start, idempotency_key, meta)
           values ($1, 'ARENA_PICK_CORRECT', $2, $3, $4, $5::date, $6, $7::jsonb) on conflict (idempotency_key) do nothing`,
          [userId, lifetimeEach, battleId, settlement.id, week, `points:pick:${battleId}:${userId}`, json({ winner: winnerId })],
        );
      }
    }
    return { status: "SETTLED", settlementId: settlement.id, result: voided ? "VOID" : "SCORED", picks: picks.length, correctPickers: correct.length, pointsAwarded: pointsTotal, validPicks: decisions.length };
  });
}

export interface RewardSweepResult {
  settled: number;
  failed: number;
}

/**
 * Scores every finished battle that has reward-eligible picks and no settlement yet (historical picks from before this system
 * never qualify). Cheap when idle (one indexed query), safe to call from anywhere and as often as you like, and a QUIET NO-OP on a
 * database where the leaderboard migration has not been applied — so the code can deploy before the migration without ever
 * touching the arena. A failure on one battle is logged and retried on the next sweep; it never throws into the caller.
 */
export async function settleDueRewards(db: Db, ctx: Ctx, onError: (battleId: string, error: unknown) => void = defaultOnError): Promise<RewardSweepResult> {
  const out: RewardSweepResult = { settled: 0, failed: 0 };
  if (!(await rewardsReady(db, ctx.now().getTime()))) return out;
  const due = await db.query<{ id: string }>(
    `select b.id from public.arena_battles b
      where b.status in ('SETTLED', 'VOID') and coalesce(b.settled_at, b.created_at) > $1::timestamptz
        and exists (select 1 from public.arena_picks p where p.battle_id = b.id and p.reward_eligible)
        and not exists (select 1 from public.arena_pick_settlements s where s.battle_id = b.id)
      order by b.sequence limit 20`,
    [new Date(ctx.now().getTime() - 30 * 86_400_000).toISOString()],
  );
  for (const d of due) {
    try {
      const r = await settleBattleRewards(db, ctx, d.id);
      if (r.status === "SETTLED") out.settled++;
    } catch (error) {
      out.failed++;
      onError(d.id, error);
    }
  }
  return out;
}

function defaultOnError(battleId: string, error: unknown): void {
  console.error(`[rewards] scoring battle ${battleId} failed (will retry):`, error instanceof Error ? error.message : error);
}
