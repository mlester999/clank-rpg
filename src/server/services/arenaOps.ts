import type { ArenaRuntimeStatus, GamePhase, SeasonKind } from "@/domain/lifecycle";
import { ARENA_STATUS_LABEL, arenaIsActive, seasonChipLabel } from "@/domain/lifecycle";

import type { Queryable } from "../db/types";

import { countEligibleHeroes } from "./arenaEligibility";

/**
 * Admin-only Arena OPERATIONS view: the queue, cycle progress, upcoming groups, worker health, transition timing,
 * queue integrity and alerts. None of this belongs on the public pages — players see eight fighters, 3·2·1, the fight,
 * the results and the next eight; they never see the machinery that picks them. (The public state payload carries no
 * cycle / queue information at all; this is its only home.)
 */
export interface ArenaOps {
  now: number;
  /** Legacy flag: true only while the Arena is PAUSED (see `status` for the full runtime state). */
  paused: boolean;
  /** The persisted runtime status — the same value every process, worker and restart sees. */
  status: ArenaRuntimeStatus;
  phase: GamePhase;
  worker: { status: "HEALTHY" | "STALE" | "IDLE" | "PAUSED" | "NOT_STARTED"; lastAdvanceAt: number | null; ageMs: number | null };
  season: { kind: SeasonKind; number: number | null; name: string; label: string } | null;
  eligibleHeroes: number;
  groupSize: number;
  cycle: { number: number; heroCount: number; carriedIn: number; fought: number; remaining: number; skipped: number; inBattle: number; battlesDone: number; startedAt: number } | null;
  /** The next groups waiting in the persisted queue (names only — admin eyes). */
  queuedGroups: Array<{ index: number; heroes: string[] }>;
  current: BattleBrief | null;
  next: BattleBrief | null;
  /** Earliest upcoming transition on the server clock. */
  nextTransition: { at: number; what: string } | null;
  integrity: Array<{ check: string; ok: boolean; detail: string }>;
  alerts: Array<{ severity: "critical" | "warning" | "info"; type: string; detail: string }>;
}

interface BattleBrief {
  id: string;
  sequence: number;
  /** The public (season) battle number. */
  number: number;
  status: string;
  startsAt: number;
  combatStartsAt: number | null;
  combatEndsAt: number | null;
  slotEndsAt: number | null;
}

const t = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);
/** The worker settles one battle per slot (~40–45 s); a gap of several slots means nothing is advancing the arena. */
const STALE_AFTER_MS = 3 * 60_000;

export async function arenaOps(q: Queryable, opts: { now: number; allowDemo: boolean; groupSize: number }): Promise<ArenaOps> {
  const nowIso = new Date(opts.now).toISOString();
  const [state] = await q.query<{ status: ArenaRuntimeStatus; last_advance_at: Date | null }>("select status, last_advance_at from public.arena_state where id = 1");
  const [game] = await q.query<{ phase: GamePhase }>("select phase from public.game_state where id = 1");
  const [seasonRow] = await q.query<{ id: string; kind: SeasonKind; number: number | null; name: string }>("select id, kind, number, name from public.seasons where status = 'ACTIVE' limit 1");
  const season = seasonRow ? { kind: seasonRow.kind, number: seasonRow.number, name: seasonRow.name, label: seasonChipLabel(seasonRow) } : null;
  const runtime: ArenaRuntimeStatus = state?.status ?? "NOT_STARTED";
  const eligibleHeroes = await countEligibleHeroes(q, opts.allowDemo);
  const [cyc] = await q.query<{ id: string; number: number; hero_count: number; carried_in_count: number; created_at: Date }>(
    "select id, number, hero_count, carried_in_count, created_at from public.arena_cycles where status = 'ACTIVE' limit 1",
  );

  const brief = (b: Record<string, unknown> | undefined): BattleBrief | null =>
    b
      ? { id: b.id as string, sequence: Number(b.sequence), number: Number(b.season_sequence), status: b.status as string, startsAt: t(b.starts_at as Date) as number, combatStartsAt: t(b.combat_starts_at as Date | null), combatEndsAt: t(b.combat_ends_at as Date | null), slotEndsAt: t(b.slot_ends_at as Date | null) }
      : null;
  const cols = "id, sequence, season_sequence, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at";
  // The ACTIVE season's battles only: after a launch / reset the archived run's last battle is not "current" any more.
  const inSeason = "season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)";
  const [cur] = await q.query<Record<string, unknown>>(`select ${cols} from public.arena_battles where ${inSeason} and status in ('SIMULATED', 'SETTLED') and starts_at <= $1::timestamptz order by sequence desc limit 1`, [nowIso]);
  const [nxt] = await q.query<Record<string, unknown>>(`select ${cols} from public.arena_battles where ${inSeason} and (status = 'SCHEDULED' or (status = 'SIMULATED' and starts_at > $1::timestamptz)) order by sequence limit 1`, [nowIso]);
  const current = brief(cur);
  const next = brief(nxt);

  let cycle: ArenaOps["cycle"] = null;
  let queuedGroups: ArenaOps["queuedGroups"] = [];
  if (cyc) {
    const [p] = await q.query<{ done: number; pending: number; skipped: number; in_battle: number; battles: number }>(
      `select count(*) filter (where status = 'COMPLETED')::int as done, count(*) filter (where status = 'PENDING')::int as pending,
              count(*) filter (where status = 'SKIPPED')::int as skipped, count(*) filter (where status = 'IN_BATTLE')::int as in_battle,
              count(distinct battle_id) filter (where status = 'COMPLETED')::int as battles
         from public.arena_queue_entries where cycle_id = $1`,
      [cyc.id],
    );
    cycle = {
      number: cyc.number, heroCount: cyc.hero_count, carriedIn: cyc.carried_in_count, fought: p?.done ?? 0, remaining: (p?.pending ?? 0) + (p?.in_battle ?? 0),
      skipped: p?.skipped ?? 0, inBattle: p?.in_battle ?? 0, battlesDone: p?.battles ?? 0, startedAt: t(cyc.created_at) as number,
    };
    const pending = await q.query<{ name: string }>(
      `select coalesce(c.name_override, c.name) as name from public.arena_queue_entries e join public.characters c on c.id = e.character_id
        where e.cycle_id = $1 and e.status = 'PENDING' order by e.position limit $2`,
      [cyc.id, opts.groupSize * 6],
    );
    for (let i = 0; i < pending.length; i += opts.groupSize) queuedGroups.push({ index: i / opts.groupSize + 1, heroes: pending.slice(i, i + opts.groupSize).map((r) => r.name) });
    queuedGroups = queuedGroups.filter((g) => g.heroes.length === opts.groupSize);
  }

  const lastAdvanceAt = t(state?.last_advance_at);
  const ageMs = lastAdvanceAt === null ? null : opts.now - lastAdvanceAt;
  // A stopped Arena (not started / paused) is not a stale worker: nothing is supposed to advance.
  const worker: ArenaOps["worker"] = {
    status: runtime === "PAUSED" ? "PAUSED" : runtime === "NOT_STARTED" ? "NOT_STARTED" : lastAdvanceAt === null ? "IDLE" : (ageMs as number) > STALE_AFTER_MS ? "STALE" : "HEALTHY",
    lastAdvanceAt,
    ageMs,
  };

  const upcoming = [
    current?.combatEndsAt != null && current.combatEndsAt > opts.now ? { at: current.combatEndsAt, what: "combat ends (the next battle's picks lock, then settle)" } : null,
    current?.slotEndsAt != null && current.slotEndsAt > opts.now ? { at: current.slotEndsAt, what: "next battle takes the stage" } : null,
  ].filter((x): x is { at: number; what: string } => x !== null);
  const nextTransition = upcoming.sort((a, b) => a.at - b.at)[0] ?? (next && next.startsAt > opts.now ? { at: next.startsAt, what: "next battle takes the stage" } : null);

  // --- integrity: the persisted queue must be consistent with the battles it claims to feed -------------------------------
  const integrity: ArenaOps["integrity"] = [];
  const check = async (name: string, sql: string, params: unknown[] = []) => {
    const rows = await q.query<{ n: number }>(sql, params);
    const n = rows[0]?.n ?? 0;
    integrity.push({ check: name, ok: n === 0, detail: n === 0 ? "ok" : `${n} violation${n === 1 ? "" : "s"}` });
  };
  await check("Every IN_BATTLE queue entry belongs to a live battle", "select count(*)::int as n from public.arena_queue_entries e left join public.arena_battles b on b.id = e.battle_id where e.status = 'IN_BATTLE' and (b.id is null or b.status not in ('SCHEDULED', 'SIMULATED'))");
  await check("Every COMPLETED queue entry belongs to a settled battle", "select count(*)::int as n from public.arena_queue_entries e left join public.arena_battles b on b.id = e.battle_id where e.status = 'COMPLETED' and (b.id is null or b.status <> 'SETTLED')");
  // (A hero may sit in two QUEUED battles — the next cycle redraws everyone — but never in two that are on stage at the same time.)
  await check("No hero is on stage in two battles at once", `select count(*)::int as n from (
      select p.character_id from public.arena_participants p join public.arena_battles b on b.id = p.battle_id
       where b.status = 'SIMULATED' and b.starts_at <= $1::timestamptz and b.slot_ends_at > $1::timestamptz group by p.character_id having count(*) > 1) x`, [nowIso]);
  // On stage + the previous one still settling + the two prepared ahead (the upcoming battle and the one behind it).
  await check("At most one SCHEDULED and four SIMULATED battles are open", "select (greatest((select count(*) from public.arena_battles where status = 'SCHEDULED') - 1, 0) + greatest((select count(*) from public.arena_battles where status = 'SIMULATED') - 4, 0))::int as n");
  await check("Settled battles all have a winner and a full set of placements", `select count(*)::int as n from public.arena_battles b where b.status = 'SETTLED' and (b.winner_id is null or exists (select 1 from public.arena_participants p where p.battle_id = b.id and p.placement is null))`);
  await check("Battle slots never overlap (latest 200 battles)", `select count(*)::int as n from (
      select b.starts_at, lead(b.slot_ends_at) over (order by b.sequence desc) as earlier_end
        from (select starts_at, slot_ends_at, sequence from public.arena_battles where status in ('SIMULATED', 'SETTLED') order by sequence desc limit 200) b) x
     where earlier_end is not null and earlier_end > starts_at`);

  // The database's own lifecycle auditor (one active season, phase/season/arena consistency, no battle in an ended season …): every row is a finding.
  {
    const rows = await q.query<{ n: number }>("select (case when to_regprocedure('public.audit_game_lifecycle()') is null then 0 else (select count(*) from public.audit_game_lifecycle()) end)::int as n");
    const n = rows[0]?.n ?? 0;
    integrity.push({ check: "Game lifecycle is consistent (phase, seasons, Arena status)", ok: n === 0, detail: n === 0 ? "ok" : `${n} finding${n === 1 ? "" : "s"}` });
  }

  // --- alerts ---------------------------------------------------------------------------------------------------------
  const alerts: ArenaOps["alerts"] = [];
  if (runtime === "PAUSED") alerts.push({ severity: "warning", type: "ARENA_PAUSED", detail: "The Arena is paused: no battles advance. Resume it in Game control." });
  if (runtime === "PAUSE_REQUESTED") alerts.push({ severity: "info", type: "ARENA_PAUSING", detail: "A pause was requested: the battles already committed are finishing, then the Arena pauses." });
  if (runtime === "NOT_STARTED") alerts.push({ severity: "info", type: "ARENA_NOT_STARTED", detail: `The Arena has not been started (${ARENA_STATUS_LABEL.NOT_STARTED.toLowerCase()}): no battle is made until START ARENA is pressed in Game control.` });
  if (!season) alerts.push({ severity: "critical", type: "NO_ACTIVE_SEASON", detail: "There is no active season, so no battle can be scheduled." });
  if (worker.status === "STALE") alerts.push({ severity: "critical", type: "WORKER_STALE", detail: `Nothing has settled a battle for ${Math.round((ageMs as number) / 1000)} s — is the worker / scheduler running?` });
  if (arenaIsActive(runtime) && eligibleHeroes < opts.groupSize) alerts.push({ severity: "warning", type: "NOT_ENOUGH_HEROES", detail: `${eligibleHeroes} eligible hero(es); a battle needs ${opts.groupSize}.` });
  const [overdue] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'SIMULATED' and combat_ends_at < $1::timestamptz - interval '30 seconds'", [nowIso]);
  if ((overdue?.n ?? 0) > 0) alerts.push({ severity: "critical", type: "SETTLEMENT_OVERDUE", detail: `${overdue?.n} battle(s) finished combat more than 30 s ago and are still unsettled.` });
  const [voided] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_battles where status = 'VOID' and created_at > $1::timestamptz - interval '24 hours'", [nowIso]);
  if ((voided?.n ?? 0) > 0) alerts.push({ severity: "warning", type: "BATTLES_VOIDED", detail: `${voided?.n} battle(s) were voided in the last 24 h (their heroes kept their turn; no picks from a voided battle earn Points or tokens).` });
  if (cycle && cycle.skipped > 0) alerts.push({ severity: "info", type: "HEROES_SKIPPED", detail: `${cycle.skipped} queued hero(es) were skipped this cycle (became ineligible).` });
  for (const i of integrity) if (!i.ok) alerts.push({ severity: "critical", type: "QUEUE_INTEGRITY", detail: `${i.check}: ${i.detail}` });

  return {
    now: opts.now,
    paused: runtime === "PAUSED",
    status: runtime,
    phase: game?.phase ?? "DEVELOPMENT",
    worker,
    season,
    eligibleHeroes,
    groupSize: opts.groupSize,
    cycle,
    queuedGroups,
    current,
    next,
    nextTransition,
    integrity,
    alerts,
  };
}
