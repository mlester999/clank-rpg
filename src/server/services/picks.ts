import { picksWindow, type PicksLockReason, type PicksWindow, type WindowBattle, type WindowPredecessor } from "@/domain/arena/picksWindow";

import { json, type Db, type Queryable } from "../db/types";
import { getRewardEligibility, type IneligibleReason } from "../rewards/eligibility";

import { applyLedger } from "./economy";

/**
 * ARENA PICKS — "who do you think wins the NEXT fight?" Picks are FREE: there is no stake, no deposit, no balance to lose, no
 * pool and no custody anywhere in this module, and a wrong pick costs nothing. Picks feed Clank Points and the Daily / Weekly
 * leaderboards (credited after settlement by server/rewards/settlement.ts — never in here). A correct pick MAY also pay the
 * small off-chain Clank Gold reward from the existing ledger (setting `picks.rewardGold`, 0 disables).
 *
 * THE LIFECYCLE (all enforced here or in the database, never in the browser):
 *
 *     battle A on stage ─ picks for B OPEN ─ A's result is DECIDED ─ B's picks LOCK ─ A's results ─ 3·2·1 ─ B on stage ─ picks for C OPEN …
 *
 *  · a pick names the UPCOMING battle B (`arena_picks.battle_id` is always the battle that was PREDICTED, never the one on
 *    stage) and one of B's eight fighters (FK) — the eight who will actually fight: B's roster is final once prepared;
 *  · B's window is open while it is prepared, unstamped and its predecessor's result is not decided; the rule is the single
 *    pure function in domain/arena/picksWindow.ts (also used by the public state, so display and enforcement agree);
 *  · "decided" is the server clock reaching the predecessor's persisted `combat_ends_at` OR the predecessor leaving SIMULATED;
 *    the arena stamps `arena_battles.picks_locked_at` on B in the transition's own transaction (exactly once, trigger-guarded),
 *    and every pick of B is frozen (`locked_at`) at that instant;
 *  · the check and the write are ONE transaction holding a shared row lock on B, which the stamp (an UPDATE of B) must wait for:
 *    a pick either commits before the lock — and counts — or sees it and is refused. A slow or manipulated browser cannot
 *    sneak in after it, and nothing the browser sends (clock, status text) is ever consulted;
 *  · a member (the immutable Telegram id of the signed session) has at most ONE pick per battle (primary key); until the lock
 *    they may change it;
 *  · only a member ELIGIBLE for rewarded picks can pick (see rewards/eligibility.ts); that eligibility is snapshotted on the pick
 *    on every submit and frozen when the window closes;
 *  · settlement of a pick happens inside ITS battle's SIMULATED → SETTLED transition — the battle the pick named — so it runs
 *    exactly once and always against that battle's own authoritative Arena #1.
 */

export type PickRejection = "NOT_FOUND" | "NOT_OPEN" | "LOCKED" | "RESOLVED" | "NOT_A_FIGHTER" | "NOT_ELIGIBLE";

export interface PickView {
  /** The battle that was PREDICTED (the upcoming battle at the time of the pick). */
  battleId: string;
  characterId: string;
  submittedAt: number;
  changedCount: number;
  /** True once the pick window closed (the pick can no longer change). */
  locked: boolean;
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  rewardGold: number;
  /** Whether this pick counts for rewards (snapshotted at the last submit before lock). */
  rewardEligible: boolean;
}

export type SubmitPickResult = { ok: true; pick: PickView; changed: boolean } | { ok: false; reason: PickRejection; ineligible?: IneligibleReason };

interface PickRow {
  battle_id: string;
  character_id: string;
  submitted_at: Date;
  changed_count: number;
  locked_at: Date | null;
  result: "CORRECT" | "INCORRECT" | "VOID" | null;
  reward_gold: number;
  reward_eligible: boolean;
}

const PICK_COLS = "battle_id, character_id, submitted_at, changed_count, locked_at, result, reward_gold, reward_eligible";

function view(r: PickRow, locked: boolean): PickView {
  return {
    battleId: r.battle_id,
    characterId: r.character_id,
    submittedAt: new Date(r.submitted_at).getTime(),
    changedCount: r.changed_count,
    locked: locked || r.locked_at !== null || r.result !== null,
    result: r.result,
    rewardGold: r.reward_gold,
    rewardEligible: r.reward_eligible,
  };
}

const ms = (d: Date | null): number => (d ? new Date(d).getTime() : 0);
const msOrNull = (d: Date | string | null): number | null => (d ? new Date(d).getTime() : null);

interface WindowRow {
  id: string;
  sequence: number;
  status: WindowBattle["status"];
  starts_at: Date;
  combat_ends_at: Date | null;
  slot_ends_at: Date | null;
  picks_locked_at: Date | null;
  picks_lock_reason: PicksLockReason | null;
}

export const toWindowBattle = (r: WindowRow): WindowBattle => ({ status: r.status, startsAt: ms(r.starts_at), picksLockedAt: msOrNull(r.picks_locked_at), picksLockReason: r.picks_lock_reason });
export const toWindowPredecessor = (r: Pick<WindowRow, "status" | "starts_at" | "combat_ends_at" | "slot_ends_at">): WindowPredecessor => ({
  status: r.status,
  startsAt: ms(r.starts_at),
  combatEndsAt: msOrNull(r.combat_ends_at),
  slotEndsAt: msOrNull(r.slot_ends_at),
});

const WINDOW_COLS = "id, sequence, status, starts_at, combat_ends_at, slot_ends_at, picks_locked_at, picks_lock_reason";

/** The battle immediately before `sequence` in the queue (settled battles included, voided ones skipped). */
export async function loadPredecessor(q: Queryable, sequence: number): Promise<WindowPredecessor | null> {
  const [p] = await q.query<WindowRow>(
    `select ${WINDOW_COLS} from public.arena_battles where sequence < $1 and status in ('SIMULATED', 'SETTLED') order by sequence desc limit 1`,
    [sequence],
  );
  return p ? toWindowPredecessor(p) : null;
}

/**
 * The server's verdict on a battle's pick window right now. The shared row lock (`lock: true`) is how submitPick makes
 * "check, then write" atomic against the transition that closes the window.
 */
export async function getPicksWindow(q: Queryable, battleId: string, nowMs: number, opts: { lock?: boolean } = {}): Promise<{ window: PicksWindow; battle: WindowBattle; sequence: number } | null> {
  const [b] = await q.query<WindowRow>(`select ${WINDOW_COLS} from public.arena_battles where id = $1${opts.lock ? " for share" : ""}`, [battleId]);
  if (!b) return null;
  const battle = toWindowBattle(b);
  const pred = b.status === "SIMULATED" ? await loadPredecessor(q, Number(b.sequence)) : null;
  return { window: picksWindow(battle, pred, nowMs), battle, sequence: Number(b.sequence) };
}

export async function submitPick(
  db: Db,
  ctx: { now: () => Date; allowDemo?: boolean },
  input: { telegramUserId: number; battleId: string; characterId: string; /** Qualifying messages needed (setting telegram.qualifyingThreshold). */ threshold: number },
): Promise<SubmitPickResult> {
  return db.transaction(async (tx): Promise<SubmitPickResult> => {
    // A shared row lock on the battle makes "check the window, then write" atomic against the transition that closes it
    // (stamping the lock UPDATEs this row, so it waits for us — or we wait for it and then see the stamp).
    const found = await getPicksWindow(tx, input.battleId, ctx.now().getTime(), { lock: true });
    if (!found) return { ok: false, reason: "NOT_FOUND" };
    switch (found.window.state) {
      case "RESOLVED":
      case "VOID":
        return { ok: false, reason: "RESOLVED" };
      case "NOT_OPEN":
        return { ok: false, reason: "NOT_OPEN" };
      case "LOCKED":
        return { ok: false, reason: "LOCKED" };
      case "OPEN":
        break;
    }

    const fighter = await tx.query("select 1 from public.arena_participants where battle_id = $1 and character_id = $2", [input.battleId, input.characterId]);
    if (fighter.length === 0) return { ok: false, reason: "NOT_A_FIGHTER" };

    // Reward eligibility, decided by the SERVER from the member's own record and snapshotted on the pick.
    const eligibility = await getRewardEligibility(tx, input.telegramUserId, { threshold: input.threshold, allowDemo: Boolean(ctx.allowDemo) });
    if (!eligibility.eligible) return { ok: false, reason: "NOT_ELIGIBLE", ...(eligibility.reason ? { ineligible: eligibility.reason } : {}) };

    const before = await tx.query<PickRow>(`select ${PICK_COLS} from public.arena_picks where battle_id = $1 and telegram_user_id = $2`, [input.battleId, input.telegramUserId]);
    const snapshot = json({ qualifying: eligibility.qualifying, threshold: eligibility.threshold, heroId: eligibility.heroId, reviewState: eligibility.reviewState });
    const rows = await tx.query<PickRow>(
      `insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at, reward_eligible, eligibility)
       values ($1, $2, $3, $4::timestamptz, true, $5::jsonb)
       on conflict (battle_id, telegram_user_id) do update
         set character_id = excluded.character_id,
             submitted_at = excluded.submitted_at,
             reward_eligible = excluded.reward_eligible,
             eligibility = excluded.eligibility,
             changed_count = public.arena_picks.changed_count + (case when public.arena_picks.character_id <> excluded.character_id then 1 else 0 end)
       where public.arena_picks.result is null and public.arena_picks.locked_at is null
       returning ${PICK_COLS}`,
      [input.battleId, input.telegramUserId, input.characterId, ctx.now().toISOString(), snapshot],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: before[0]?.result ? "RESOLVED" : "LOCKED" };
    return { ok: true, pick: view(row, false), changed: before[0] ? before[0].character_id !== input.characterId : true };
  });
}

/** The crowd: picks per fighter. Served only AFTER the window closed (nobody should be able to copy the crowd while picks are open). */
export async function getPickCrowd(q: Queryable, battleId: string): Promise<{ total: number; byCharacter: Record<string, number> }> {
  const rows = await q.query<{ character_id: string; n: number }>("select character_id, count(*)::int as n from public.arena_picks where battle_id = $1 group by character_id", [battleId]);
  return { total: rows.reduce((a, r) => a + Number(r.n), 0), byCharacter: Object.fromEntries(rows.map((r) => [r.character_id, Number(r.n)])) };
}

export async function getMyPick(q: Queryable, telegramUserId: number, battleId: string): Promise<PickView | null> {
  const [row] = await q.query<PickRow>(`select ${PICK_COLS} from public.arena_picks where battle_id = $1 and telegram_user_id = $2`, [battleId, telegramUserId]);
  return row ? view(row, false) : null;
}

/**
 * Freezes every open pick of a battle (`locked_at`) — idempotent. The service already refuses a late pick by the window rule;
 * this records the moment and arms the database guard.
 */
export async function lockPicks(q: Queryable, battleId: string, lockedAtMs: number): Promise<number> {
  const rows = await q.query("update public.arena_picks set locked_at = $2::timestamptz where battle_id = $1 and locked_at is null and result is null returning battle_id", [battleId, new Date(lockedAtMs).toISOString()]);
  return rows.length;
}

/**
 * CLOSES a battle's pick window — exactly once. Stamps `arena_battles.picks_locked_at` / `picks_lock_reason` (a trigger refuses to
 * move or clear them) and freezes the battle's picks in the same transaction. The close moment is the DECIDING instant (the
 * predecessor's `combat_ends_at`, the battle's own start), never "whenever the arena got round to it", so every writer agrees
 * on it. Returns false when it was already closed.
 */
export async function closePicksWindow(tx: Queryable, battleId: string, reason: PicksLockReason, atMs: number): Promise<boolean> {
  const stamped = await tx.query(
    "update public.arena_battles set picks_locked_at = $2::timestamptz, picks_lock_reason = $3 where id = $1 and picks_locked_at is null and status = 'SIMULATED' returning id",
    [battleId, new Date(atMs).toISOString(), reason],
  );
  if (stamped.length === 0) return false;
  await lockPicks(tx, battleId, atMs);
  return true;
}

export interface PickSettlement {
  resolved: number;
  correct: number;
  rewarded: number;
  goldPaid: number;
}

/**
 * Resolves every open pick of a battle. MUST be called inside the settlement transaction
 * (right after the SIMULATED → SETTLED gate), which is what makes it run exactly once.
 * Idempotent regardless: already-resolved picks are untouched and the ledger key is unique.
 *
 * Order matters: rewards are paid first (idempotent ledger entries), then each pick is resolved
 * with its reward in ONE update — the database freezes a pick the moment it has a result.
 */
export async function settlePicks(tx: Queryable, battleId: string, rewardGold: number, nowIso: string): Promise<PickSettlement> {
  const out: PickSettlement = { resolved: 0, correct: 0, rewarded: 0, goldPaid: 0 };
  const [battle] = await tx.query<{ winner_id: string | null; combat_starts_at: Date | null }>("select winner_id, combat_starts_at from public.arena_battles where id = $1", [battleId]);
  if (!battle) return out;
  const lockedAt = (battle.combat_starts_at ? new Date(battle.combat_starts_at) : new Date(nowIso)).toISOString();

  // telegram id → hero that received the reward
  const paid: Record<string, string> = {};
  if (battle.winner_id && rewardGold > 0) {
    // Clank Gold lives on CHARACTERS, so only a member who owns a claimed hero can receive the reward.
    const owners = await tx.query<{ telegram_user_id: number; character_id: string }>(
      `select cl.telegram_user_id, cl.character_id
         from public.arena_picks p
         join public.character_claims cl on cl.telegram_user_id = p.telegram_user_id
         join public.characters c on c.id = cl.character_id
        where p.battle_id = $1 and p.result is null and p.character_id = $2 and c.status <> 'SUSPENDED'
        order by p.telegram_user_id`,
      [battleId, battle.winner_id],
    );
    for (const owner of owners) {
      const entry = await applyLedger(tx, {
        characterId: owner.character_id,
        amount: rewardGold,
        reason: "arena_pick_reward",
        refType: "arena_battle",
        refId: battleId,
        idempotencyKey: `pick:${battleId}:${owner.telegram_user_id}:reward`,
      });
      paid[String(owner.telegram_user_id)] = owner.character_id;
      if (entry.applied) {
        out.rewarded++;
        out.goldPaid += rewardGold;
      }
    }
  }

  const resolved = await tx.query<{ result: string }>(
    `update public.arena_picks p
        set locked_at = coalesce(p.locked_at, $2::timestamptz),
            result = case when $3::uuid is null then 'VOID' when p.character_id = $3::uuid then 'CORRECT' else 'INCORRECT' end,
            settled_at = $4::timestamptz,
            reward_gold = case when ($5::jsonb ->> p.telegram_user_id::text) is not null then $6::int else 0 end,
            rewarded_character_id = ($5::jsonb ->> p.telegram_user_id::text)::uuid
      where p.battle_id = $1 and p.result is null
      returning p.result`,
    [battleId, lockedAt, battle.winner_id, nowIso, json(paid), rewardGold],
  );
  out.resolved = resolved.length;
  out.correct = resolved.filter((r) => r.result === "CORRECT").length;
  return out;
}
