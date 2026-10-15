import type { Rarity } from "@/domain/character/appearance";
import {
  eventPeriodKind,
  firstPeriodOfSeason,
  lastCompletedPeriod,
  MAX_CHAMPIONS_SHOWN,
  periodOutcome,
  periodPage,
  STANDINGS_RANK_LIMIT,
  STANDINGS_ROW_CAP,
  type AllocationDto,
  type EventArt,
  type EventKind,
  type EventProgram,
  type EventRowDto,
  type EventsListDto,
  type EventsSeasonView,
  type EventsStateDto,
  type HeroRowDto,
  type PeriodDetailDto,
  type PeriodDto,
  type PeriodRulesDto,
  type PicksRowDto,
} from "@/domain/events";
import { winRatePercent } from "@/domain/heroArena";
import { bpsToPercent } from "@/domain/rewards/leaderboard";
import { isPeriodStart, periodWindowOf, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS } from "@/domain/rewards/tokens";

import { json, type Queryable } from "../db/types";
import { REWARD_SYMBOL } from "../rewards/pool";

/**
 * EVENTS — the read side of the champions history.
 *
 *   · OFFICIAL SEASONS ONLY. Every query is scoped to a COMPETITIVE season (`seasons.kind = 'COMPETITIVE'`): before Season 1 launches there is nothing to show, and
 *     the development run's boards — finalized or not — are never listed, never backfilled and never reachable by guessing a date.
 *   · FROZEN RESULTS ONLY. A winner is read from the immutable result rows the finalizers wrote (and the hero snapshot written beside them); nothing is recomputed from
 *     mutable hero stats, so a reroll or a later battle can never change a past champion. A period that closed but is not frozen yet is FINALIZING — never a guess.
 *   · SET-BASED. One page of periods costs a constant number of indexed queries (boards, champions, leaders, visibility, finalizing) whatever the season's length:
 *     no per-row lookups, nothing scans the battle table for a winner.
 *   · PRIVATE THINGS STAY PRIVATE. No Telegram id, wallet, owner id or review state is ever returned; a held prize reads as allocated and a forfeited one as none —
 *     the same convention as the live boards.
 */

const readiness = { at: 0, ready: false };
/** Test hook: forget the cached answer. */
export function resetEventsReadiness(): void {
  readiness.at = 0;
  readiness.ready = false;
}

/** True once the tables Events reads exist (migration 20261015002700). Before it, Events simply has nothing to show — no error. */
export async function eventsReady(q: Queryable, nowMs = Date.now()): Promise<boolean> {
  if (readiness.at !== 0 && nowMs - readiness.at < 30_000) return readiness.ready;
  const [r] = await q.query<{ ok: boolean }>(
    `select to_regclass('public.arena_leaderboard_result_snapshots') is not null and to_regclass('public.hero_arena_result_snapshots') is not null
        and to_regclass('public.arena_leaderboards') is not null and to_regclass('public.hero_arena_boards') is not null
        and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'seasons' and column_name = 'kind') as ok`,
  );
  readiness.at = nowMs;
  readiness.ready = Boolean(r?.ok);
  return readiness.ready;
}

// ---------------------------------------------------------------------------------------------------------------------
// State: which official season is shown
// ---------------------------------------------------------------------------------------------------------------------
interface SeasonRow {
  id: string;
  number: number;
  status: "ACTIVE" | "ENDED" | "UPCOMING";
  starts_at: Date;
  ends_at: Date | null;
}

const ms = (d: Date | string): number => new Date(d).getTime();

export async function getEventsState(q: Queryable, nowMs: number, requestedSeasonId?: string | null): Promise<EventsStateDto> {
  const empty: EventsStateDto = { phase: "PRE_SEASON", season: null, seasons: [], serverNow: nowMs };
  if (!(await eventsReady(q, nowMs))) return empty;
  const rows = await q.query<SeasonRow>("select id, number, status, starts_at, ends_at from public.seasons where kind = 'COMPETITIVE' and number is not null and status <> 'UPCOMING' order by number desc limit 12");
  if (rows.length === 0) return empty;
  const active = rows.find((s) => s.status === "ACTIVE") ?? null;
  const currentId = (active ?? (rows[0] as SeasonRow)).id;
  const view = (s: SeasonRow): EventsSeasonView => ({
    id: s.id,
    label: `Season ${s.number}`,
    number: Number(s.number),
    status: s.status === "ACTIVE" ? "ACTIVE" : "ENDED",
    startsAt: ms(s.starts_at),
    endsAt: s.ends_at && s.status !== "ACTIVE" ? ms(s.ends_at) : null,
    current: s.id === currentId,
  });
  const seasons = rows.map(view);
  const selected = seasons.find((s) => s.id === requestedSeasonId) ?? (seasons.find((s) => s.current) as EventsSeasonView);
  return { phase: active ? "SEASON_ACTIVE" : "BETWEEN_SEASONS", season: selected, seasons, serverNow: nowMs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------------------------------
interface SnapshotCols {
  s_public_id: string | null;
  s_version: number | null;
  s_rarity: Rarity | null;
  s_power: number | null;
  s_look: { rarity?: Rarity; parts?: unknown; sprite?: unknown; overrides?: unknown } | null;
}

const artOf = (s: SnapshotCols): EventArt | null => {
  const look = s.s_look;
  if (!look || !look.parts || !(look.rarity ?? s.s_rarity)) return null;
  return { rarity: (look.rarity ?? s.s_rarity) as Rarity, parts: look.parts as EventArt["parts"], ...(look.sprite ? { sprite: look.sprite } : {}), ...(look.overrides ? { overrides: look.overrides } : {}) };
};

const money = (micro: bigint): string => formatTokenAmount(micro, LOGICAL_DECIMALS);

const NO_ALLOCATION: AllocationDto = { status: "NONE", amount: null, symbol: REWARD_SYMBOL, bonusPart: null };

interface PicksResultRow extends SnapshotCols {
  start: string;
  character_id: string | null;
  rank: number;
  tie_size: number;
  hero_name: string;
  class_id: string;
  points: number;
  picks: number;
  correct_picks: number;
  accuracy_bps: number;
  prize_eligible: boolean;
  prize_rank: number | null;
  base_prize_micro: string;
  base_status: "NONE" | "CREDITED" | "HELD" | "FORFEITED";
  bonus_status: string;
  bonus_micro: string;
}

function picksAllocation(r: PicksResultRow): AllocationDto {
  const base = BigInt(r.base_prize_micro);
  // CREDITED and HELD both read as allocated (review state is private); a FORFEITED prize was taken back and reads as none.
  if (base === 0n || (r.base_status !== "CREDITED" && r.base_status !== "HELD")) return NO_ALLOCATION;
  const bonus = r.bonus_status === "CREDITED" || r.bonus_status === "HELD" ? BigInt(r.bonus_micro) : 0n;
  return { status: "ALLOCATED", amount: money(base + bonus), symbol: REWARD_SYMBOL, bonusPart: bonus > 0n ? money(bonus) : null };
}

const picksRow = (r: PicksResultRow, visible: Set<string>): PicksRowDto => ({
  program: "picks",
  rank: Number(r.rank),
  tied: Number(r.tie_size) > 1,
  name: r.hero_name,
  classId: r.class_id,
  rarity: r.s_rarity,
  power: r.s_power === null ? null : Number(r.s_power),
  heroVersion: r.s_version === null ? null : Number(r.s_version),
  heroPublicId: r.character_id && visible.has(r.character_id) ? r.s_public_id : null,
  art: artOf(r),
  allocation: picksAllocation(r),
  points: Number(r.points),
  picks: Number(r.picks),
  correctPicks: Number(r.correct_picks),
  accuracy: Number(r.picks) > 0 ? bpsToPercent(Number(r.accuracy_bps)) : null,
  prizeEligible: r.prize_eligible,
  prizeRank: r.prize_rank === null ? null : Number(r.prize_rank),
});

interface HeroResultRow extends SnapshotCols {
  start: string;
  character_id: string;
  rank: number;
  tie_size: number;
  hero_name: string;
  class_id: string;
  frozen_rarity: Rarity | null;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
  prize_micro: string;
  prize_status: "NONE" | "CREDITED" | "RESERVED" | "HELD" | "FORFEITED";
}

function heroAllocation(r: HeroResultRow): AllocationDto {
  const prize = BigInt(r.prize_micro);
  if (prize === 0n || r.prize_status === "NONE" || r.prize_status === "FORFEITED") return NO_ALLOCATION;
  return { status: "ALLOCATED", amount: money(prize), symbol: REWARD_SYMBOL, bonusPart: null };
}

const heroRow = (r: HeroResultRow, visible: Set<string>): HeroRowDto => ({
  program: "hero",
  rank: Number(r.rank),
  tied: Number(r.tie_size) > 1,
  name: r.hero_name,
  classId: r.class_id,
  rarity: r.s_rarity ?? r.frozen_rarity,
  power: r.s_power === null ? null : Number(r.s_power),
  heroVersion: r.s_version === null ? null : Number(r.s_version),
  heroPublicId: visible.has(r.character_id) ? r.s_public_id : null,
  art: artOf(r),
  allocation: heroAllocation(r),
  matches: Number(r.matches),
  wins: Number(r.wins),
  top2: Number(r.top2),
  kos: Number(r.kos),
  winRate: Number(r.matches) > 0 ? winRatePercent(Number(r.wins), Number(r.matches)) : null,
});

/** The heroes that may be LINKED today (active, member not banned). History keeps the name either way; only the link depends on today's standing. */
async function visibleHeroes(q: Queryable, ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Set();
  const rows = await q.query<{ id: string }>(
    `select c.id from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) and c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED')`,
    [json(unique)],
  );
  return new Set(rows.map((r) => r.id));
}

const SNAP_COLS = "s.public_id as s_public_id, s.version_number as s_version, s.rarity as s_rarity, s.power as s_power, s.look as s_look";

// ---------------------------------------------------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------------------------------------------------
interface BoardRow {
  start: string;
  participants: number;
  eligible: number;
  finalized_at: Date;
  minimum: number;
  pool: string;
  pool_set: boolean;
}

interface Source {
  program: EventProgram;
  kind: PeriodKind;
  seasonId: string;
}

async function loadBoards(q: Queryable, src: Source, starts: string[]): Promise<Map<string, BoardRow>> {
  const rows =
    src.program === "picks"
      ? await q.query<BoardRow>(
          `select b.period_start::text as start, b.participants, b.eligible_participants as eligible, b.finalized_at, b.minimum_picks as minimum, b.prize_pool_micro::text as pool, true as pool_set
             from public.arena_leaderboards b
            where b.season_id = $1::uuid and b.kind = $2 and b.period_start in (select (jsonb_array_elements_text($3::jsonb))::date)`,
          [src.seasonId, src.kind, json(starts)],
        )
      : await q.query<BoardRow>(
          `select b.period_start::text as start, b.participants, b.eligible_participants as eligible, b.finalized_at, b.minimum_wins as minimum, b.prize_pool_micro::text as pool, b.pool_set
             from public.hero_arena_boards b
            where b.season_id = $1::uuid and b.kind = $2 and b.period_start in (select (jsonb_array_elements_text($3::jsonb))::date)`,
          [src.seasonId, src.kind, json(starts)],
        );
  return new Map(rows.map((b) => [b.start, b]));
}

/** Closed periods of the season that have results but no frozen board yet (the finalizer has not run / is waiting for a settlement): FINALIZING, not "empty". */
async function loadFinalizing(q: Queryable, src: Source, starts: string[]): Promise<Set<string>> {
  if (starts.length === 0) return new Set();
  const rows =
    src.program === "picks"
      ? await q.query<{ start: string }>(
          `select c.start::text as start from (select (jsonb_array_elements_text($3::jsonb))::date as start) c
            where public.period_season($2::text, c.start) = $1::uuid`,
          [src.seasonId, src.kind, json(starts)],
        )
      : await q.query<{ start: string }>(
          `select c.start::text as start from (select (jsonb_array_elements_text($2::jsonb))::date as start) c
            where (select b.season_id from public.arena_battles b
                    where b.status = 'SETTLED' and b.settled_at >= (c.start::timestamp at time zone 'UTC') and b.settled_at < ((c.start + $3::int)::timestamp at time zone 'UTC') and public.season_counts(b.season_id)
                    order by b.settled_at desc, b.sequence desc limit 1) = $1::uuid`,
          [src.seasonId, json(starts), src.kind === "DAILY" ? 1 : 7],
        );
  return new Set(rows.map((r) => r.start));
}

async function loadChampions(q: Queryable, src: Source, starts: string[]): Promise<Map<string, EventRowDto[]>> {
  const out = new Map<string, EventRowDto[]>();
  if (src.program === "picks") {
    const rows = await q.query<PicksResultRow>(
      `select r.period_start::text as start, r.character_id, r.rank, r.tie_size, r.hero_name, r.class_id, r.points, r.picks, r.correct_picks, r.accuracy_bps, r.prize_eligible, r.prize_rank,
              r.base_prize_micro::text as base_prize_micro, r.base_status, r.bonus_status, r.bonus_micro::text as bonus_micro, ${SNAP_COLS}
         from public.arena_leaderboard_results r
         left join public.arena_leaderboard_result_snapshots s on s.kind = r.kind and s.period_start = r.period_start and s.telegram_user_id = r.telegram_user_id
        where r.kind = $1 and r.period_start in (select (jsonb_array_elements_text($2::jsonb))::date) and r.prize_eligible and r.prize_rank = 1
        order by r.period_start desc, r.hero_name, r.telegram_user_id`,
      [src.kind, json(starts)],
    );
    const visible = await visibleHeroes(q, rows.map((r) => r.character_id).filter((x): x is string => x !== null));
    for (const r of rows) (out.get(r.start) ?? out.set(r.start, []).get(r.start))!.push(picksRow(r, visible));
    return out;
  }
  const rows = await q.query<HeroResultRow>(
    `select r.period_start::text as start, r.character_id, r.rank, r.tie_size, r.hero_name, r.class_id, r.rarity as frozen_rarity, r.matches, r.wins, r.top2, r.kos,
            r.prize_micro::text as prize_micro, r.prize_status, ${SNAP_COLS}
       from public.hero_arena_results r
       left join public.hero_arena_result_snapshots s on s.kind = r.kind and s.period_start = r.period_start and s.character_id = r.character_id
      where r.kind = $1 and r.period_start in (select (jsonb_array_elements_text($2::jsonb))::date) and r.rank = 1 and r.wins >= 1
      order by r.period_start desc, r.hero_name, r.character_id`,
    [src.kind, json(starts)],
  );
  const visible = await visibleHeroes(q, rows.map((r) => r.character_id));
  for (const r of rows) (out.get(r.start) ?? out.set(r.start, []).get(r.start))!.push(heroRow(r, visible));
  return out;
}

/** Arena Picks: the board's leader when that leader was NOT prize-eligible (never shown as a champion — said plainly instead). */
async function loadIneligibleLeaders(q: Queryable, kind: PeriodKind, starts: string[]): Promise<Map<string, { name: string; picks: number; correctPicks: number }>> {
  const rows = await q.query<{ start: string; hero_name: string; picks: number; correct_picks: number }>(
    `select distinct on (r.period_start) r.period_start::text as start, r.hero_name, r.picks, r.correct_picks
       from public.arena_leaderboard_results r
      where r.kind = $1 and r.period_start in (select (jsonb_array_elements_text($2::jsonb))::date) and r.rank = 1 and not r.prize_eligible
      order by r.period_start, r.hero_name, r.telegram_user_id`,
    [kind, json(starts)],
  );
  return new Map(rows.map((r) => [r.start, { name: r.hero_name, picks: Number(r.picks), correctPicks: Number(r.correct_picks) }]));
}

function rulesOf(program: EventProgram, b: BoardRow): PeriodRulesDto {
  const pool = BigInt(b.pool);
  return {
    minimum: Number(b.minimum),
    minimumUnit: program === "picks" ? "Picks" : "wins",
    prizePool: b.pool_set && pool > 0n ? money(pool) : null,
    symbol: REWARD_SYMBOL,
    recognitionOnly: !b.pool_set || pool === 0n,
  };
}

function periodDto(src: Source, kind: EventKind, start: string, board: BoardRow | undefined, finalizing: boolean, champions: EventRowDto[], leader: { name: string; picks: number; correctPicks: number } | undefined): PeriodDto {
  const win = periodWindowOf(src.kind, start);
  const shown = champions.slice(0, MAX_CHAMPIONS_SHOWN);
  const rules = board ? rulesOf(src.program, board) : null;
  return {
    program: src.program,
    kind,
    start,
    startsAt: win.startsAt,
    endsAt: win.endsAt,
    outcome: periodOutcome({ frozen: Boolean(board), finalizing, champions: champions.length }),
    finalizedAt: board ? ms(board.finalized_at) : null,
    participants: board ? Number(board.participants) : 0,
    eligibleParticipants: board ? Number(board.eligible) : 0,
    champions: shown,
    moreChampions: champions.length - shown.length,
    leader: src.program === "picks" && leader && rules ? { ...leader, minimum: rules.minimum } : null,
    rules,
  };
}

/** One page of a season's COMPLETED periods, newest first — champions only (the Top 10 is `getPeriodDetail`). */
export async function listEventPeriods(
  q: Queryable,
  input: { program: EventProgram; kind: EventKind; nowMs: number; before?: string | null; limit?: number; seasonId?: string | null },
): Promise<EventsListDto> {
  const state = await getEventsState(q, input.nowMs, input.seasonId);
  const base: EventsListDto = { state, program: input.program, kind: input.kind, periods: [], nextBefore: null, classes: {} };
  const season = state.season;
  if (!season) return base;
  const kind = eventPeriodKind(input.kind);
  const last = lastCompletedPeriod(kind, input.nowMs, season.startsAt, season.endsAt);
  if (last === null) return base;
  const before = input.before && isPeriodStart(kind, input.before) ? input.before : null;
  const { starts, next } = periodPage(kind, firstPeriodOfSeason(kind, season.startsAt), last, before, input.limit ?? 8);
  if (starts.length === 0) return base;

  const src: Source = { program: input.program, kind, seasonId: season.id };
  const boards = await loadBoards(q, src, starts);
  const missing = starts.filter((s) => !boards.has(s));
  const [champions, finalizing, leaders] = await Promise.all([
    loadChampions(q, src, [...boards.keys()]),
    loadFinalizing(q, src, missing),
    input.program === "picks" ? loadIneligibleLeaders(q, kind, [...boards.keys()]) : Promise.resolve(new Map<string, { name: string; picks: number; correctPicks: number }>()),
  ]);
  base.periods = starts.map((s) => periodDto(src, input.kind, s, boards.get(s), finalizing.has(s), champions.get(s) ?? [], leaders.get(s)));
  base.nextBefore = next;
  return base;
}

/** The full final standings (Top 10) of ONE completed period of an official season. Null when the period is not one the Events page may show. */
export async function getPeriodDetail(
  q: Queryable,
  input: { program: EventProgram; kind: EventKind; start: string; nowMs: number; seasonId?: string | null },
): Promise<PeriodDetailDto | null> {
  const kind = eventPeriodKind(input.kind);
  if (!isPeriodStart(kind, input.start)) return null;
  const state = await getEventsState(q, input.nowMs, input.seasonId);
  const season = state.season;
  if (!season) return null;
  const last = lastCompletedPeriod(kind, input.nowMs, season.startsAt, season.endsAt);
  if (last === null || input.start > last || input.start < firstPeriodOfSeason(kind, season.startsAt)) return null;

  const src: Source = { program: input.program, kind, seasonId: season.id };
  const [list] = (await listEventPeriods(q, { program: input.program, kind: input.kind, nowMs: input.nowMs, before: nextPeriodAfter(kind, input.start), limit: 1, seasonId: season.id })).periods;
  if (!list || list.start !== input.start) return null;
  const frozen = list.finalizedAt !== null;
  if (!frozen) return { ...list, standings: [], standingsCut: 0 };

  let standings: EventRowDto[];
  let total: number;
  if (src.program === "picks") {
    const rows = await q.query<PicksResultRow>(
      `select r.period_start::text as start, r.character_id, r.rank, r.tie_size, r.hero_name, r.class_id, r.points, r.picks, r.correct_picks, r.accuracy_bps, r.prize_eligible, r.prize_rank,
              r.base_prize_micro::text as base_prize_micro, r.base_status, r.bonus_status, r.bonus_micro::text as bonus_micro, ${SNAP_COLS}
         from public.arena_leaderboard_results r
         left join public.arena_leaderboard_result_snapshots s on s.kind = r.kind and s.period_start = r.period_start and s.telegram_user_id = r.telegram_user_id
        where r.kind = $1 and r.period_start = $2::date and r.rank <= $3
        order by r.rank, r.hero_name, r.telegram_user_id limit $4`,
      [kind, input.start, STANDINGS_RANK_LIMIT, STANDINGS_ROW_CAP],
    );
    const visible = await visibleHeroes(q, rows.map((r) => r.character_id).filter((x): x is string => x !== null));
    standings = rows.map((r) => picksRow(r, visible));
    const [c] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_leaderboard_results where kind = $1 and period_start = $2::date and rank <= $3", [kind, input.start, STANDINGS_RANK_LIMIT]);
    total = c?.n ?? rows.length;
  } else {
    const rows = await q.query<HeroResultRow>(
      `select r.period_start::text as start, r.character_id, r.rank, r.tie_size, r.hero_name, r.class_id, r.rarity as frozen_rarity, r.matches, r.wins, r.top2, r.kos,
              r.prize_micro::text as prize_micro, r.prize_status, ${SNAP_COLS}
         from public.hero_arena_results r
         left join public.hero_arena_result_snapshots s on s.kind = r.kind and s.period_start = r.period_start and s.character_id = r.character_id
        where r.kind = $1 and r.period_start = $2::date and r.rank <= $3
        order by r.rank, r.hero_name, r.character_id limit $4`,
      [kind, input.start, STANDINGS_RANK_LIMIT, STANDINGS_ROW_CAP],
    );
    const visible = await visibleHeroes(q, rows.map((r) => r.character_id));
    standings = rows.map((r) => heroRow(r, visible));
    const [c] = await q.query<{ n: number }>("select count(*)::int as n from public.hero_arena_results where kind = $1 and period_start = $2::date and rank <= $3", [kind, input.start, STANDINGS_RANK_LIMIT]);
    total = c?.n ?? rows.length;
  }
  return { ...list, standings, standingsCut: Math.max(0, total - standings.length) };
}

/** The period after `start` — used to ask `listEventPeriods` for exactly `start` (its `before` is exclusive). */
function nextPeriodAfter(kind: PeriodKind, start: string): string {
  const w = periodWindowOf(kind, start);
  return new Date(w.endsAt).toISOString().slice(0, 10);
}
