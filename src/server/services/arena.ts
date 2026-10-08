import { lockDue, lockMoment, type WindowPredecessor } from "@/domain/arena/picksWindow";
import { layoutBattle } from "@/domain/arena/timeline";
import { planCycle } from "@/domain/arena/queue";
import { simulateBattle } from "@/domain/combat/engine";
import type { BattleOutcome, CombatUnitInput } from "@/domain/combat/types";
import { computeRewards } from "@/domain/progression/rewards";
import type { Ruleset } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import { createRng } from "@/domain/util/rng";
import type { ArenaRuntimeStatus } from "@/domain/lifecycle";
import { json, type Db, type Queryable } from "../db/types";

import { evaluateAchievements } from "./achievements";
import { audit } from "./auditLog";
import { eligibleHeroIds, lockForRoster, verifyEligible } from "./arenaEligibility";
import { committedBattles } from "./arenaRuntime";
import { applyLedger } from "./economy";
import { fighterToUnit, loadFighters, type Fighter } from "./characters";
import { closePicksWindow, loadPredecessor, settlePicks, toWindowBattle, toWindowPredecessor } from "./picks";
import { ensureRulesetSnapshot, loadRuleset, loadRulesetSnapshot, loadSettings } from "../config/settingsRepo";

export interface ArenaCtx {
  now: () => Date;
  /** CSPRNG seed source for cycle shuffles and battle seeds. */
  secureSeed: () => string;
  /** Whether DEV_SEED demo heroes may be queued (never true by accident in production). */
  allowDemo: boolean;
}

/**
 * What an advance reports. NOT_STARTED / PREPARING / PAUSED mirror the persisted Arena runtime status (see domain/lifecycle.ts); LIVE = battles are
 * being made; GATHERING = running with fewer eligible heroes than a battle needs; NO_SEASON = no ACTIVE season to schedule into.
 */
export type ArenaAdvanceStatus = "LIVE" | "GATHERING" | "PAUSED" | "NO_SEASON" | "NOT_STARTED" | "PREPARING";

export interface ArenaAdvanceResult {
  status: ArenaAdvanceStatus;
  steps: string[];
  eligibleHeroes?: number;
  /**
   * The next wall-clock instant at which advancing the arena will have something to do (a prepared battle takes the stage;
   * the battle on stage is decided → the next battle's picks lock, then it settles). `null` when only a state change (new heroes,
   * resume) can unblock it. Callers use it to avoid both polling blindly and sleeping through a due transition.
   */
  dueAtMs: number | null;
}

const MAX_STEPS_PER_ADVANCE = 14;

/**
 * How many battles are kept PREPARED (rosters committed, outcome persisted, invisible except the first) beyond the one on stage.
 * Two, because the picks panel always shows the UPCOMING battle: when the next battle takes the stage, the one after it must
 * already exist so the panel switches over in the same snapshot — never an empty "preparing" frame, never work on the boundary.
 */
export const AHEAD_TARGET = 2;

interface BattleRow {
  id: string;
  sequence: number;
  season_id: string;
  cycle_id: string;
  status: "SCHEDULED" | "SIMULATED" | "SETTLED" | "VOID";
  starts_at: Date;
  combat_starts_at: Date | null;
  combat_ends_at: Date | null;
  slot_ends_at: Date | null;
  seed: string | null;
  snapshot: BattleSnapshot | null;
  events_hash: string | null;
  ruleset_hash: string | null;
  picks_locked_at: Date | null;
  picks_lock_reason: "PREDECESSOR_DECIDED" | "OWN_START" | "VOID" | null;
}

export interface BattleSnapshot {
  maxCombatMs: number;
  units: CombatUnitInput[];
  display: Array<{
    characterId: string;
    name: string;
    classId: string;
    tactic: string;
    title: string | null;
    isDemo: boolean;
    claimed: boolean;
    power: number;
    appearance: Fighter["appearance"];
  }>;
}

const ms = (d: Date | null): number => (d ? d.getTime() : 0);

// ---------------------------------------------------------------------------------------
// Eligibility + cycles
// ---------------------------------------------------------------------------------------

// Who may fight is decided in ONE place (./arenaEligibility); it is re-exported here for existing callers.
export { eligibleHeroIds };

async function activeSeasonId(q: Queryable): Promise<string | null> {
  const rows = await q.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE' limit 1");
  return rows[0]?.id ?? null;
}

interface CycleRow {
  id: string;
  number: number;
  season_id: string;
}

async function createCycle(tx: Queryable, ctx: ArenaCtx, groupSize: number, carried: string[]): Promise<CycleRow | "NO_SEASON" | null> {
  const eligible = await eligibleHeroIds(tx, ctx.allowDemo);
  if (eligible.length < groupSize) return null;
  const seasonId = await activeSeasonId(tx);
  if (!seasonId) return "NO_SEASON";
  const seed = ctx.secureSeed();
  const plan = planCycle(eligible, carried, groupSize, createRng(seed));
  const [{ next } = { next: 1 }] = await tx.query<{ next: number }>("select coalesce(max(number), 0) + 1 as next from public.arena_cycles");
  const [cycle] = await tx.query<CycleRow>(
    `insert into public.arena_cycles (number, season_id, seed, hero_count, carried_in_count)
     values ($1, $2, $3, $4, $5) returning id, number, season_id`,
    [next, seasonId, seed, eligible.length, plan.carriedIn.length],
  );
  const carriedSet = new Set(plan.carriedIn);
  await tx.query(
    `insert into public.arena_queue_entries (cycle_id, character_id, position, carried_in)
     select $1, (x->>'id')::uuid, (x->>'pos')::int, (x->>'carried')::boolean
       from jsonb_array_elements($2::jsonb) as x`,
    [(cycle as CycleRow).id, json(plan.order.map((id, pos) => ({ id, pos, carried: carriedSet.has(id) })))],
  );
  return cycle as CycleRow;
}

interface EntryRow {
  id: string;
  character_id: string;
  position: number;
}

/**
 * Takes the next full group from the persisted queue. Heroes who became ineligible since the
 * cycle was planned (suspended, deactivated, their member banned) are SKIPPED — eligibility is decided HERE, at the moment a roster is made, not
 * when the cycle was shuffled. If fewer than a full group remains, those heroes are CARRIED FORWARD to the front of a freshly planned cycle —
 * never padded with duplicates.
 *
 * The check is made UNDER LOCK: the member and hero rows of each candidate batch are locked until this transaction ends, and eligibility is read
 * after the locks are held. A suspension therefore either committed before we looked (the hero is skipped) or waits for this transaction (and
 * then only keeps the hero out of LATER rosters — the roster being written here was legitimately formed). No hero that is not eligible at the
 * instant its roster is committed can be in it; the database refuses such a roster too (trigger `arena_participants_eligible`).
 */
async function assembleNextGroup(
  tx: Queryable,
  ctx: ArenaCtx,
  groupSize: number,
): Promise<{ kind: "GROUP"; cycle: CycleRow; heroIds: string[] } | { kind: "GATHERING" } | { kind: "NO_SEASON" }> {
  let cycle: CycleRow | null =
    (await tx.query<CycleRow>("select id, number, season_id from public.arena_cycles where status = 'ACTIVE' for update"))[0] ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cycle) {
      const created = await createCycle(tx, ctx, groupSize, []);
      if (created === "NO_SEASON") return { kind: "NO_SEASON" };
      if (!created) return { kind: "GATHERING" };
      cycle = created;
    }
    // Walk the persisted queue in order: take eligible heroes until the group is full and
    // mark anyone who became ineligible since planning as SKIPPED.
    const group: string[] = [];
    const skipped: string[] = [];
    let lastPosition = -1;
    scan: while (group.length < groupSize) {
      const batch = await tx.query<EntryRow>(
        `select e.id, e.character_id, e.position from public.arena_queue_entries e
          where e.cycle_id = $1 and e.status = 'PENDING' and e.position > $2
          order by e.position limit $3`,
        [cycle.id, lastPosition, groupSize * 2],
      );
      if (batch.length === 0) break;
      const ids = batch.map((e) => e.character_id);
      await lockForRoster(tx, ids);
      const eligible = await verifyEligible(tx, ids, ctx.allowDemo);
      for (const e of batch) {
        lastPosition = e.position;
        if (!eligible.has(e.character_id)) skipped.push(e.id);
        else group.push(e.character_id);
        if (group.length === groupSize) break scan;
      }
    }
    if (skipped.length) {
      await tx.query("update public.arena_queue_entries set status = 'SKIPPED' where id in (select (jsonb_array_elements_text($1::jsonb))::uuid)", [json(skipped)]);
    }
    if (group.length === groupSize) return { kind: "GROUP", cycle, heroIds: group };

    // Remainder: carry forward and open a new cycle.
    if (group.length) {
      await tx.query(
        "update public.arena_queue_entries set status = 'CARRIED_FORWARD' where cycle_id = $1 and character_id in (select (jsonb_array_elements_text($2::jsonb))::uuid)",
        [cycle.id, json(group)],
      );
    }
    await tx.query("update public.arena_cycles set status = 'COMPLETED', completed_at = now(), carried_out_count = $2 where id = $1", [cycle.id, group.length]);
    const next = await createCycle(tx, ctx, groupSize, group);
    if (next === "NO_SEASON") return { kind: "NO_SEASON" };
    if (!next) return { kind: "GATHERING" };
    cycle = next;
  }
  return { kind: "GATHERING" };
}

/** The battle's season is fixed here, at scheduling time — so a season rollover mid-cycle takes effect on the very next battle. */
async function scheduleBattle(tx: Queryable, cycle: CycleRow, seasonId: string, heroIds: string[], startsAt: Date): Promise<string> {
  const [battle] = await tx.query<{ id: string }>(
    "insert into public.arena_battles (season_id, cycle_id, status, starts_at) values ($1, $2, 'SCHEDULED', $3::timestamptz) returning id",
    [seasonId, cycle.id, startsAt.toISOString()],
  );
  const battleId = (battle as { id: string }).id;
  await tx.query(
    `insert into public.arena_participants (battle_id, character_id)
     select $1, (jsonb_array_elements_text($2::jsonb))::uuid`,
    [battleId, json(heroIds)],
  );
  const claimed = await tx.query(
    `update public.arena_queue_entries set status = 'IN_BATTLE', battle_id = $3
      where cycle_id = $1 and status = 'PENDING' and character_id in (select (jsonb_array_elements_text($2::jsonb))::uuid)
      returning id`,
    [cycle.id, json(heroIds), battleId],
  );
  if (claimed.length !== heroIds.length) throw new Error("queue entries changed while scheduling a battle");
  return battleId;
}

// ---------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------

async function simulateScheduled(tx: Queryable, ctx: ArenaCtx, battle: BattleRow, settings: GameSettings): Promise<void> {
  const parts = await tx.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 order by character_id", [battle.id]);
  // A hero in this roster cannot be changed by an Admin reroll / rollback between here and the commit: the roster rows reference `characters`,
  // so scheduling the battle took a key-share lock on every fighter's row, which conflicts with the `FOR UPDATE` every hero-version change takes
  // first — the two serialise on the hero's row, and whichever commits second sees the other (the Admin check refuses a rostered hero; a roster
  // is never built around a hero whose change is still in flight). Proven on real Postgres: tests/integration/hero-versions-postgres.test.ts.
  const { ruleset, hash } = await loadRuleset(tx, settings);
  await ensureRulesetSnapshot(tx, ruleset, hash);
  const fighters = await loadFighters(tx, parts.map((p) => p.character_id), ruleset, settings);
  const snapshot: BattleSnapshot = {
    maxCombatMs: settings.arena.maxCombatMs,
    units: fighters.map(fighterToUnit),
    display: fighters.map((f) => ({
      characterId: f.characterId, name: f.name, classId: f.classId, tactic: f.tactic, title: f.title,
      isDemo: f.isDemo, claimed: f.claimed, power: f.power, appearance: f.appearance,
    })),
  };
  const seed = ctx.secureSeed();
  const outcome = simulateBattle({ seed, ruleset, units: snapshot.units, maxCombatMs: snapshot.maxCombatMs });
  const times = layoutBattle(ms(battle.starts_at), outcome.durationMs, settings.arena);

  const winner = outcome.participants[outcome.ranking[0] as number];
  const runnerUp = outcome.participants[outcome.ranking[1] as number];
  const gate = await tx.query(
    `update public.arena_battles set status = 'SIMULATED', rules_version = $2, ruleset_hash = $3, seed = $4, snapshot = $5::jsonb,
            events = $6::jsonb, events_hash = $7, result = $8::jsonb, duration_ms = $9, ended_by = $10,
            combat_starts_at = $11::timestamptz, combat_ends_at = $12::timestamptz, slot_ends_at = $13::timestamptz,
            simulated_at = $14::timestamptz, winner_id = $15, runner_up_id = $16
      where id = $1 and status = 'SCHEDULED' returning id`,
    [
      battle.id, outcome.rulesVersion, hash, seed, json(snapshot), json(outcome.events), outcome.eventsHash,
      json({ ranking: outcome.ranking.map((slot) => ({ slot, characterId: (outcome.participants[slot] as { characterId: string }).characterId })), skillIds: outcome.skillIds }),
      outcome.durationMs, outcome.endedBy,
      new Date(times.combatStartsAtMs).toISOString(), new Date(times.combatEndsAtMs).toISOString(), new Date(times.slotEndsAtMs).toISOString(),
      ctx.now().toISOString(), winner?.characterId ?? null, runnerUp?.characterId ?? null,
    ],
  );
  if (gate.length === 0) return; // already simulated by a concurrent caller

  await tx.query(
    `update public.arena_participants p set slot = x.slot, placement = x.placement, eliminations = x.elims,
            damage_dealt = x.dealt, damage_taken = x.taken, healing_done = x.healed, survived_ms = x.survived,
            final_hp = x.hp, max_hp = x.max_hp,
            killed_by = (select o.character_id from jsonb_to_recordset($2::jsonb) as o(slot int, character_id uuid) where o.slot = x.killed_by_slot)
       from jsonb_to_recordset($2::jsonb) as x(slot int, character_id uuid, placement int, elims int, dealt int, taken int, healed int, survived int, hp int, max_hp int, killed_by_slot int)
      where p.battle_id = $1 and p.character_id = x.character_id`,
    [
      battle.id,
      json(outcome.participants.map((p) => ({
        slot: p.slot, character_id: p.characterId, placement: p.placement, elims: p.eliminations, dealt: p.damageDealt,
        taken: p.damageTaken, healed: p.healingDone, survived: p.survivedMs, hp: p.finalHp, max_hp: p.maxHp, killed_by_slot: p.killedBySlot,
      }))),
    ],
  );
}

// ---------------------------------------------------------------------------------------
// Settlement (idempotent: guarded by the SIMULATED → SETTLED transition + unique keys)
// ---------------------------------------------------------------------------------------

/** Closes the pick window of the battle queued right after `predecessor` once the predecessor's result is decided (see domain/arena/picksWindow.ts). */
async function closeSuccessorWindow(
  tx: Queryable,
  predecessor: { sequence: number; status: "SIMULATED" | "SETTLED"; starts_at: Date; combat_ends_at: Date | null; slot_ends_at: Date | null },
  nowMs: number,
): Promise<boolean> {
  const [next] = await tx.query<BattleRow>(
    `select id, sequence, season_id, cycle_id, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, seed, snapshot, events_hash, ruleset_hash, picks_locked_at, picks_lock_reason
       from public.arena_battles where status in ('SCHEDULED', 'SIMULATED') and sequence > $1::bigint order by sequence limit 1 for update`,
    [predecessor.sequence],
  );
  if (!next || next.status !== "SIMULATED" || next.picks_locked_at !== null) return false;
  const window = toWindowBattle(next);
  const pred = toWindowPredecessor(predecessor);
  const reason = lockDue(window, pred, nowMs);
  if (!reason) return false;
  return closePicksWindow(tx, next.id, reason, lockMoment(reason, window, pred, nowMs));
}

interface ParticipantRow {
  character_id: string;
  placement: number;
  eliminations: number;
  damage_dealt: number;
  class_id: string;
}

interface TemplateRow {
  id: string;
  rarity: string;
  class_restriction: string[] | null;
}

/**
 * Settles one finished battle exactly once: Arena record, season points, Clank Gold, loot, picks.
 * It never touches `characters.xp` / `characters.level` (retired columns) and never changes a
 * hero's stats or POWER — fighting more does not make anyone permanently stronger.
 */
export async function settleBattle(tx: Queryable, ctx: ArenaCtx, battleId: string, settings: GameSettings): Promise<boolean> {
  const gate = await tx.query<{ seed: string; season_id: string; cycle_id: string; sequence: number; starts_at: Date; combat_ends_at: Date | null; slot_ends_at: Date | null }>(
    `update public.arena_battles set status = 'SETTLED', settled_at = $2::timestamptz
      where id = $1 and status = 'SIMULATED' returning seed, season_id, cycle_id, sequence, starts_at, combat_ends_at, slot_ends_at`,
    [battleId, ctx.now().toISOString()],
  );
  if (gate.length === 0) return false; // someone else settled it already
  const settled = gate[0] as { seed: string; season_id: string; sequence: number; starts_at: Date; combat_ends_at: Date | null; slot_ends_at: Date | null };
  const { seed, season_id: seasonId } = settled;

  // This battle's result is final: close the pick window of the battle that comes next (the upcoming battle) — in THIS transaction and
  // as the very first write after the gate, so a pick racing the settlement either already committed (and counts) or waits for
  // this transaction and then sees the stamp. Normally the arena's lock step stamped it a moment earlier (at `combat_ends_at`);
  // this makes the guarantee independent of that step. Idempotent: the stamp is written once.
  await closeSuccessorWindow(tx, { sequence: Number(settled.sequence), status: "SETTLED", starts_at: settled.starts_at, combat_ends_at: settled.combat_ends_at, slot_ends_at: settled.slot_ends_at }, ctx.now().getTime());

  const parts = await tx.query<ParticipantRow>(
    `select p.character_id, p.placement, p.eliminations, p.damage_dealt, c.class_id
       from public.arena_participants p join public.characters c on c.id = p.character_id
      where p.battle_id = $1 order by p.character_id for update of c`,
    [battleId],
  );
  const templates = settings.progression.drops.enabled
    ? await tx.query<TemplateRow>("select id, rarity, class_restriction from public.item_templates where enabled order by id")
    : [];
  const prog = settings.progression;
  const nowIso = ctx.now().toISOString();

  for (const p of parts) {
    const rewards = computeRewards(p.placement, p.eliminations, prog);
    const win = p.placement === 1 ? 1 : 0;
    const top2 = p.placement <= 2 ? 1 : 0;
    await tx.query(
      `update public.characters set arena_battles = arena_battles + 1, arena_wins = arena_wins + $2,
              arena_top2 = arena_top2 + $3, arena_eliminations = arena_eliminations + $4, arena_damage = arena_damage + $5,
              last_arena_at = $6::timestamptz where id = $1`,
      [p.character_id, win, top2, p.eliminations, p.damage_dealt, nowIso],
    );
    await tx.query(
      `insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations, damage)
       values ($1, $2, $3, 1, $4, $5, $6, $7)
       on conflict (season_id, character_id) do update set
         points = public.season_character_stats.points + excluded.points, battles = public.season_character_stats.battles + 1,
         wins = public.season_character_stats.wins + excluded.wins, top2 = public.season_character_stats.top2 + excluded.top2,
         eliminations = public.season_character_stats.eliminations + excluded.eliminations,
         damage = public.season_character_stats.damage + excluded.damage, updated_at = now()`,
      [seasonId, p.character_id, rewards.seasonPoints, win, top2, p.eliminations, p.damage_dealt],
    );
    if (rewards.gold > 0) {
      await applyLedger(tx, {
        characterId: p.character_id, amount: rewards.gold, reason: "arena_reward", refType: "arena_battle", refId: battleId,
        idempotencyKey: `arena:${battleId}:${p.character_id}:reward`,
      });
    }

    // Deterministic loot roll: derived from the battle seed so it is auditable and replayable.
    let dropId: string | null = null;
    if (templates.length) {
      const rng = createRng(`${seed}/drop/${p.character_id}`);
      const chance = prog.drops.chanceByPlacement[Math.min(p.placement, 8) - 1] ?? 0;
      if (rng.chance(chance)) {
        const usable = templates.filter((t) => !t.class_restriction || t.class_restriction.includes(p.class_id));
        const rarities = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"] as const;
        let rarity: string = rng.weighted(rarities, (r) => prog.drops.rarityWeights[r]);
        let pool = usable.filter((t) => t.rarity === rarity);
        for (let i = rarities.indexOf(rarity as (typeof rarities)[number]); pool.length === 0 && i > 0; i--) {
          rarity = rarities[i - 1] as string;
          pool = usable.filter((t) => t.rarity === rarity);
        }
        if (pool.length) {
          const picked = rng.pick(pool);
          const ins = await tx.query<{ id: string }>(
            `insert into public.inventory_items (character_id, template_id, slot, acquired_via, source_ref)
             values ($1, $2, 'WEAPON', 'ARENA_DROP', $3) on conflict do nothing returning id`,
            [p.character_id, picked.id, `arena:${battleId}`],
          );
          dropId = ins[0]?.id ?? null;
        }
      }
    }
    await tx.query(
      "update public.arena_participants set gold_awarded = $3, season_points = $4, item_drop_id = $5 where battle_id = $1 and character_id = $2",
      [battleId, p.character_id, rewards.gold, rewards.seasonPoints, dropId],
    );
    await evaluateAchievements(tx, p.character_id);
  }

  // The picks that NAMED this battle (made while it was the upcoming battle) resolve in the SAME transaction as the battle, so
  // they settle exactly once, against this battle's own authoritative #1.
  await settlePicks(tx, battleId, settings.picks.rewardGold, nowIso);

  await tx.query("update public.arena_queue_entries set status = 'COMPLETED' where battle_id = $1 and status = 'IN_BATTLE'", [battleId]);
  return true;
}

// ---------------------------------------------------------------------------------------
// The advance loop (lazy: callable from viewers, a cron route, or a long-running worker)
// ---------------------------------------------------------------------------------------

interface StepResult {
  progressed: boolean;
  status: ArenaAdvanceStatus;
  step?: string;
  eligible?: number;
  dueAtMs?: number | null;
  /** For a `simulated:` step: how far BEFORE its planned start the battle was made ready (negative = already late). */
  leadMs?: number;
}

/**
 * Earliest future instant at which the arena needs attention: the battle that is next in line takes the stage (→ line up another),
 * or the battle on stage is decided (→ the next battle's picks lock, then it settles).
 */
function dueAt(live: BattleRow | undefined, nowMs: number): { dueAtMs: number | null } {
  if (!live) return { dueAtMs: null };
  const future = [ms(live.starts_at), ms(live.combat_ends_at)].filter((t) => t > nowMs);
  return { dueAtMs: future.length ? Math.min(...future) : null };
}

/**
 * Simulates the SCHEDULED battle with a frozen snapshot and persists it. If the planned start is already too close (or
 * past) for the battle to be committed before its first second — an outage, a very slow database — the start is moved to
 * just after the commit, so every viewer still gets the whole opening (roster → 3·2·1 → first combat frame) instead of
 * joining a fight that is already underway. It is the SERVER's schedule that moves, once, for everyone: no viewer is
 * ever shown a battle "as if" it had started later, and no two viewers see different battles.
 *
 * `rttMs` is the measured cost of one database statement in this step; the remaining writes plus the commit take about
 * three of them, which is the margin used.
 */
async function prepareScheduled(tx: Queryable, ctx: ArenaCtx, scheduled: BattleRow, settings: GameSettings, now: Date, rttMs: number): Promise<Date> {
  let prepared = scheduled;
  const margin = Math.min(Math.max(0, Math.round(rttMs * 3)), 3000);
  if (ms(scheduled.starts_at) - now.getTime() < margin) {
    const startsAt = new Date(now.getTime() + margin);
    await tx.query("update public.arena_battles set starts_at = $2::timestamptz where id = $1 and status = 'SCHEDULED'", [scheduled.id, startsAt.toISOString()]);
    prepared = { ...scheduled, starts_at: startsAt };
  }
  await simulateScheduled(tx, ctx, prepared, settings);
  return prepared.starts_at;
}

async function stepArena(tx: Queryable, ctx: ArenaCtx): Promise<StepResult> {
  const probeStart = ctx.now().getTime();
  // THE GATE. Every way the Arena can advance — a viewer's request, the scheduler tick, the long-running worker — comes through this step, and
  // this is the first thing it reads (under the row lock that also serialises every Admin lifecycle action): the PERSISTED runtime status.
  // Nothing in the process, the browser or the worker's own memory can start the Arena; only START ARENA (services/lifecycle.ts) does.
  const [state] = await tx.query<{ status: ArenaRuntimeStatus }>("select status from public.arena_state where id = 1 for update");
  const rttMs = Math.max(0, ctx.now().getTime() - probeStart);
  const runtime: ArenaRuntimeStatus = state?.status ?? "NOT_STARTED";
  if (runtime === "NOT_STARTED") return { progressed: false, status: "NOT_STARTED", dueAtMs: null };
  if (runtime === "PAUSED") return { progressed: false, status: "PAUSED", dueAtMs: null };
  const preparing = runtime === "PREPARING";
  // PAUSE_REQUESTED: finish the battles that are already committed (on stage, announced as the upcoming battle, prepared behind it — their rosters
  // are frozen and people may have picked on them) but make NO new roster; when none is left the Arena is PAUSED.
  const pausing = runtime === "PAUSE_REQUESTED";
  const settings = await loadSettings(tx);
  const now = ctx.now();

  const cols = "id, sequence, season_id, cycle_id, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, seed, snapshot, events_hash, ruleset_hash, picks_locked_at, picks_lock_reason";
  // Every unsettled battle, oldest first. (Healthy operation holds the one on stage — plus the previous one for the moment its settlement
  // is still running — and up to AHEAD_TARGET prepared battles waiting for their slot.) The invariants below are decided over ALL of
  // them, never a window.
  const simulated = await tx.query<BattleRow>(`select ${cols} from public.arena_battles where status = 'SIMULATED' order by sequence limit 20`);
  const live = simulated[0];
  // Battles made ready AHEAD of their slot (invisible to the public state except the first, which is the picks target: a battle is
  // only ever shown once `starts_at` has passed, apart from its roster, which is final the moment it is prepared).
  const nowMs = now.getTime();
  const preparedAhead = simulated.filter((b) => ms(b.starts_at) > nowMs);
  const onStage = simulated.filter((b) => ms(b.starts_at) <= nowMs);
  const [scheduled] = await tx.query<BattleRow>(`select ${cols} from public.arena_battles where status = 'SCHEDULED' order by sequence limit 1`);

  const dueToSettle = live !== undefined && nowMs >= ms(live.combat_ends_at);

  // A requested pause completes at the first moment nothing is committed any more: no battle on stage, none prepared, none waiting to be prepared —
  // and the last battle's own screen (its results) has finished, so viewers are never cut off mid-celebration.
  if (pausing && simulated.length === 0 && !scheduled) {
    const held = await committedBattles(tx, nowMs);
    if (held.total === 0) {
      await tx.query("update public.arena_state set status = 'PAUSED' where id = 1 and status = 'PAUSE_REQUESTED'");
      await audit(tx, "system", "ARENA_PAUSED", "arena", null, { previous: { arenaStatus: "PAUSE_REQUESTED" }, next: { arenaStatus: "PAUSED" }, at: now.toISOString() });
      return { progressed: false, status: "PAUSED", step: "paused", dueAtMs: null };
    }
    return { progressed: false, status: "LIVE", dueAtMs: held.screenEndsAt };
  }
  // PREPARING ends as soon as Battle #1 is made ready (also recovers a start that was interrupted after the battle had been prepared).
  if (preparing && simulated.length > 0) {
    await tx.query("update public.arena_state set status = 'RUNNING' where id = 1 and status = 'PREPARING'");
    return { progressed: true, status: "LIVE", step: "running" };
  }

  // NO RE-TIMING OF A BATTLE THAT HAS BEEN PUBLIC. A battle's timeline is authoritative and IMMUTABLE once its fight has started: the state
  // endpoint shows a battle as soon as `starts_at` passes and serves its replay from `combat_starts_at` — reads keep answering while the arena
  // is not advancing — so any viewer may have watched it. Moving such a battle to "now" (as an earlier outage recovery did for a prepared battle
  // whose slot had passed behind a stalled predecessor) made everyone who watched it see the SAME battle count down 3 · 2 · 1 again over a fight
  // that had already happened. After an outage the overdue battles are therefore settled IN ORDER (R1, one per step), and the next battle that is
  // lined up is anchored to "now" (R3, `staleAnchorMs`) — a fresh, complete opening for everyone. Only a battle that has never been public
  // (SCHEDULED, see `prepareScheduled`) ever has its start moved. (tests/integration/arena-countdown.test.ts)

  // R-0: CLOSE DUE PICK WINDOWS. Picks are made on the UPCOMING battle; its window closes the instant the battle in front of it is
  // decided (or, as the fallback, when it takes the stage itself). That moment is persisted here as a tiny transaction of its own,
  // BEFORE the heavy settlement — so the lock is committed within a round trip of the deciding instant, never held up behind
  // bookkeeping, and every viewer's next snapshot already says LOCKED. (The window rule in code applies the same clock whether or not
  // this step has run yet; this step is what makes it a persisted, once-only, database-guarded fact.)
  const lockedNow: string[] = [];
  let settledBefore: WindowPredecessor | null | undefined;
  for (const [i, b] of simulated.entries()) {
    if (b.picks_locked_at !== null) continue;
    let pred: WindowPredecessor | null;
    if (i > 0) pred = toWindowPredecessor(simulated[i - 1] as BattleRow);
    else if (ms(b.starts_at) > nowMs) pred = settledBefore === undefined ? (settledBefore = await loadPredecessor(tx, Number(b.sequence))) : settledBefore;
    else pred = null; // already on stage: its own start closes the window, whatever came before
    const window = toWindowBattle(b);
    const reason = lockDue(window, pred, nowMs);
    if (reason && (await closePicksWindow(tx, b.id, reason, lockMoment(reason, window, pred, nowMs)))) lockedNow.push(b.id);
  }
  if (lockedNow.length > 0) return { progressed: true, status: "LIVE", step: `locked:${lockedNow.join(",")}` };

  // R0: PREPARE EARLY. The moment a battle exists (it is lined up as soon as there is room ahead — see R3) it is simulated and
  // persisted, a whole battle's worth of time before its slot, NOT in the few seconds between the previous
  // fight ending and the results screen ending. That window used to hold the preparation (≈ 12 statements) AND, whenever
  // a hero was in both rosters, the entire settlement (≈ 77 statements) in front of it: on a database 120 ms away that is
  // ~9 s of work against a 6.2 s window, so the next battle appeared up to ~5 s after its planned start and viewers joined
  // mid-fight. Nothing here depends on the previous battle's settlement: a fighter is built from stat rows, equipped gear,
  // claim and tactic, none of which settlement touches (loot arrives unequipped; achievements grant badges/titles/gold).
  // Prepared first, then settled: the order is unchanged for whoever is due.
  if (scheduled && live) {
    const startsAt = await prepareScheduled(tx, ctx, scheduled, settings, now, rttMs);
    return { progressed: true, status: "LIVE", step: `simulated:${scheduled.id}`, leadMs: ms(startsAt) - ctx.now().getTime() };
  }
  // R1: results are due → settle (Arena record, Clank Gold, season points, loot, picks).
  if (live && dueToSettle) {
    await settleBattle(tx, ctx, live.id, settings);
    await tx.query("update public.arena_state set last_advance_at = $1::timestamptz, updated_at = now() where id = 1", [now.toISOString()]);
    return { progressed: true, status: "LIVE", step: `settled:${live.id}` };
  }
  // R2: nothing is on stage or unsettled (the very first battle, or after an outage) → make the scheduled battle ready.
  if (scheduled && !live) {
    const startsAt = await prepareScheduled(tx, ctx, scheduled, settings, now, rttMs);
    // Battle #1 is ready: the Arena is RUNNING (same transaction — nobody sees a prepared battle under a PREPARING status).
    if (preparing) await tx.query("update public.arena_state set status = 'RUNNING' where id = 1 and status = 'PREPARING'");
    return { progressed: true, status: "LIVE", step: `simulated:${scheduled.id}`, leadMs: ms(startsAt) - ctx.now().getTime() };
  }
  // R3: keep AHEAD_TARGET battles lined up behind the one on stage — as soon as there is room (a battle takes the stage, or the arena
  // starts), never while one is already waiting to be prepared (SCHEDULED), and never while TWO battles are on stage at once (an
  // overdue or shifted one: queueing behind that is how a runaway chain of battles once got through).
  // The queue itself is the persisted cycle: every hero once per cycle, full groups of eight, leftovers carried forward; a
  // battle's roster is fixed here, when it is scheduled, and never re-drawn.
  if (!scheduled && !pausing && preparedAhead.length < AHEAD_TARGET && onStage.length <= 1) {
    const [last] = simulated.length
      ? [simulated[simulated.length - 1] as BattleRow]
      : await tx.query<BattleRow>(`select ${cols} from public.arena_battles where status = 'SETTLED' order by sequence desc limit 1`);
    let startsAt = last?.slot_ends_at ? new Date(ms(last.slot_ends_at)) : now;
    if (nowMs - startsAt.getTime() > settings.arena.staleAnchorMs) startsAt = now; // re-anchor after an outage
    const seasonId = await activeSeasonId(tx);
    if (!seasonId) return { progressed: false, status: "NO_SEASON", ...dueAt(live, nowMs) };
    const assembled = await assembleNextGroup(tx, ctx, settings.arena.groupSize);
    if (assembled.kind === "NO_SEASON") return { progressed: false, status: "NO_SEASON", ...dueAt(live, nowMs) };
    if (assembled.kind === "GATHERING") {
      const eligible = (await eligibleHeroIds(tx, ctx.allowDemo)).length;
      return { progressed: false, status: live ? "LIVE" : preparing ? "PREPARING" : "GATHERING", eligible, ...dueAt(live, nowMs) };
    }
    const id = await scheduleBattle(tx, assembled.cycle, seasonId, assembled.heroIds, startsAt);
    return { progressed: true, status: "LIVE", step: `scheduled:${id}` };
  }
  return { progressed: false, status: "LIVE", ...dueAt(live, nowMs) };
}

/**
 * Brings the arena up to date with the wall clock. Every step runs in its own transaction
 * and takes a row lock on arena_state, so concurrent callers (many viewers, cron, worker)
 * serialize and each transition happens exactly once.
 */
export async function advanceArena(db: Db, ctx: ArenaCtx): Promise<ArenaAdvanceResult> {
  const steps: string[] = [];
  let status: ArenaAdvanceStatus = "LIVE";
  let eligible: number | undefined;
  let dueAtMs: number | null = null;
  for (let i = 0; i < MAX_STEPS_PER_ADVANCE; i++) {
    const t0 = ctx.now().getTime();
    const r = await db.transaction((tx) => stepArena(tx, ctx));
    if (r.step && process.env.CLANK_ARENA_TIMING_LOG === "true") {
      console.info(`[arena-timing] ${new Date().toISOString()} step=${r.step.split(":")[0]} took=${ctx.now().getTime() - t0}ms${r.leadMs !== undefined ? ` leadBeforeStart=${r.leadMs}ms` : ""}`);
    }
    status = r.status;
    dueAtMs = r.dueAtMs ?? null;
    if (r.eligible !== undefined) eligible = r.eligible;
    if (r.step) steps.push(r.step);
    if (!r.progressed) break;
  }
  return { status, steps, dueAtMs, ...(eligible !== undefined ? { eligibleHeroes: eligible } : {}) };
}

// ---------------------------------------------------------------------------------------
// Replay (deterministic re-simulation from the persisted snapshot + seed + ruleset)
// ---------------------------------------------------------------------------------------

export class BattleIntegrityError extends Error {}

const replayCache = new Map<string, { outcome: BattleOutcome; ruleset: Ruleset }>();

export async function replayBattle(q: Queryable, battleId: string, options: { frames: boolean } = { frames: true }): Promise<{ outcome: BattleOutcome; snapshot: BattleSnapshot; ruleset: Ruleset } | null> {
  const [b] = await q.query<BattleRow>(
    "select id, sequence, season_id, cycle_id, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, seed, snapshot, events_hash, ruleset_hash from public.arena_battles where id = $1",
    [battleId],
  );
  if (!b || !b.snapshot || !b.seed || !b.ruleset_hash || (b.status !== "SIMULATED" && b.status !== "SETTLED")) return null;
  const cacheKey = `${b.id}:${options.frames}`;
  let hit = replayCache.get(cacheKey);
  if (!hit) {
    const ruleset: Ruleset = await loadRulesetSnapshot(q, b.ruleset_hash);
    const outcome = simulateBattle({ seed: b.seed, ruleset, units: b.snapshot.units, maxCombatMs: b.snapshot.maxCombatMs, recordFrames: options.frames });
    if (outcome.eventsHash !== b.events_hash) {
      throw new BattleIntegrityError(`battle ${b.id} no longer reproduces (expected ${b.events_hash}, got ${outcome.eventsHash})`);
    }
    if (replayCache.size >= 16) replayCache.delete(replayCache.keys().next().value as string);
    hit = { outcome, ruleset };
    replayCache.set(cacheKey, hit);
  }
  return { outcome: hit.outcome, snapshot: b.snapshot, ruleset: hit.ruleset };
}

export function clearReplayCache(): void {
  replayCache.clear();
}
