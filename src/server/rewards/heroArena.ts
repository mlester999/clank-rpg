import { distributeHeroPrizes, poolIsSet, rankHeroArena, winRatePercent, type HeroRanked, type HeroStat } from "@/domain/heroArena";
import type { HeroRulesView } from "@/domain/heroArenaDto";
import { isPeriodStart, periodWindow, periodWindowOf, PERIOD_KINDS, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS, parseTokenAmount } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";

import { json, type Db, type Queryable } from "../db/types";
import { isCapacityError, isConnectionError } from "../db/postgres";
import { lockLifecycleShared } from "../services/lifecycleLock";

import { heroArenaKind, lockRewardAccount, postRewardLedger } from "./ledger";
import { REWARD_SYMBOL } from "./pool";

/**
 * HERO ARENA — the HERO reward program, completely separate from Arena Picks (its own pools, its own ladder, its own tables, its own ledger source).
 *
 *  DAILY   00:00:00 UTC → next 00:00:00 UTC        WEEKLY  Monday 00:00:00 UTC → next Monday       (a battle belongs to the period it SETTLED in — the rule Picks use)
 *
 * Heroes are ranked by ARENA WINS in the SETTLED battles of the period AND of ONE season (the season that owns the period — the season of the last battle
 * settled in it among the seasons that count; a new season's Tuesday never contains the old season's Tuesday). PWR, rarity, wallet and Telegram activity
 * never enter the ranking, not even as a tiebreaker. Tied heroes pool the prizes of the positions they occupy and split them equally (domain/heroArena.ts).
 *
 * A prize belongs to the hero's OWNER — the Telegram member the hero is bound to:
 *   · hero CLAIMED → credited to the owner's reward account (the one claimable balance every reward uses);
 *   · hero UNCLAIMED → RESERVED against that hero and owner. It is never redistributed to another hero, and the owner receives it when they claim the hero
 *     (a Telegram sign-in as THAT member — nobody else can claim it, and no admin path moves it to anyone else);
 *   · owner under review / flagged / banned → HELD until an admin releases or forfeits it (nobody shifts up silently);
 *   · a hero with no Telegram owner (a special character) keeps its rank and its position; its share returns to the reserve.
 * There is NO holder bonus on Hero Arena prizes, NO on-chain transfer and NO token amount invented here: the pools are the `hero_arena` setting, unset by
 * default ("REWARD POOL NOT SET" — the boards still rank and freeze, and pay nothing).
 */
const GRACE_MS = 10_000;

/** One hero's numbers for a period (the stats the ranking and the boards are made of). */
export interface HeroPeriodStat extends HeroStat {
  /** characters.status — a SUSPENDED hero keeps its settled wins on the board. */
  heroStatus: string;
}

interface StatRow {
  character_id: string;
  name: string;
  hero_status: string;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
}

/** True once the Hero Arena migration is applied. An outage is never cached as "not ready". */
const readiness = { at: 0, ready: false };
export async function heroArenaReady(q: Queryable, nowMs = Date.now()): Promise<boolean> {
  if (readiness.at !== 0 && nowMs - readiness.at < 30_000) return readiness.ready;
  try {
    const [r] = await q.query<{ ok: boolean }>("select to_regclass('public.hero_arena_boards') is not null and to_regclass('public.hero_arena_results') is not null as ok");
    readiness.ready = Boolean(r?.ok);
  } catch (error) {
    if (isConnectionError(error) || isCapacityError(error)) throw error;
    readiness.ready = false;
  }
  readiness.at = nowMs;
  return readiness.ready;
}
export function resetHeroArenaReadiness(): void {
  readiness.at = 0;
  readiness.ready = false;
  scan.deepAt = 0;
  scan.drain = false;
}

/**
 * How the sweep looks for periods that are due. EVERY pass probes only the last few ended periods (one index probe each — its cost does not grow with the history of the
 * game); the exact scan of ALL settled battles (a period stuck behind an unsettled battle, an outage longer than the window) runs on the first pass, every few minutes after that,
 * and straight away while a backlog is still draining. Same result as always scanning everything — only the idle cost is different (measured: 139 ms → 0.3 ms at 40,000 battles).
 */
const scan = { deepAt: 0, drain: false };
const RECENT_PERIODS = 8;
const DEEP_SCAN_MS = 5 * 60_000;

// ---------------------------------------------------------------------------------------------------------------------
// Rules (the display of the config)
// ---------------------------------------------------------------------------------------------------------------------
export const heroPoolMicro = (settings: GameSettings, kind: PeriodKind): bigint | null => {
  const raw = kind === "DAILY" ? settings.hero_arena.dailyPrizePool : settings.hero_arena.weeklyPrizePool;
  return poolIsSet(raw) ? parseTokenAmount(raw, LOGICAL_DECIMALS) : null;
};

export function heroRules(settings: GameSettings, kind: PeriodKind): HeroRulesView {
  const c = settings.hero_arena;
  const pool = heroPoolMicro(settings, kind);
  return {
    kind,
    minimumWins: c.minimumWins,
    poolSet: pool !== null,
    prizePool: pool === null ? null : formatTokenAmount(pool, LOGICAL_DECIMALS),
    symbol: REWARD_SYMBOL,
    topRewarded: c.prizeSplitBps.length,
    prizes: c.prizeSplitBps.map((bps, i) => ({ position: i + 1, share: `${bps / 100}%`, amount: pool === null ? null : formatTokenAmount((pool * BigInt(bps)) / 10_000n, LOGICAL_DECIMALS) })),
    prizesPaused: !c.enabled,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Standings (one set-based query per period; also what finalization freezes)
// ---------------------------------------------------------------------------------------------------------------------
/**
 * The season that OWNS a period: the season of the LAST battle settled in it among the seasons that count (official, or the active one — an ended development
 * run is archived and never ranked or paid). Null = nothing that counts was settled in it.
 */
export async function heroPeriodSeason(q: Queryable, startsAtIso: string, endsAtIso: string): Promise<string | null> {
  const [r] = await q.query<{ id: string }>(
    `select b.season_id as id from public.arena_battles b
      where b.status = 'SETTLED' and b.settled_at >= $1::timestamptz and b.settled_at < $2::timestamptz and public.season_counts(b.season_id)
      order by b.settled_at desc, b.sequence desc limit 1`,
    [startsAtIso, endsAtIso],
  );
  return r?.id ?? null;
}

/** Every hero's wins / top-2 / KOs in the SETTLED battles of one season inside [from, to) — a single aggregate, no per-hero queries. */
export async function aggregateHeroPeriod(q: Queryable, seasonId: string, fromIso: string, toIso: string, allowDemo: boolean): Promise<HeroPeriodStat[]> {
  const rows = await q.query<StatRow>(
    `select c.id as character_id, coalesce(c.name_override, c.name) as name, c.status as hero_status,
            a.matches, a.wins, a.top2, a.kos
       from (select p.character_id, count(*)::int as matches, (count(*) filter (where p.placement = 1))::int as wins,
                    (count(*) filter (where p.placement <= 2))::int as top2, coalesce(sum(p.eliminations), 0)::int as kos
               from public.arena_participants p join public.arena_battles b on b.id = p.battle_id
              where b.status = 'SETTLED' and b.season_id = $1::uuid and b.settled_at >= $2::timestamptz and b.settled_at < $3::timestamptz
              group by p.character_id) a
       join public.characters c on c.id = a.character_id
      where (not c.is_demo or $4::boolean)`,
    [seasonId, fromIso, toIso, allowDemo],
  );
  return rows.map((r) => ({ characterId: r.character_id, name: r.name, heroStatus: r.hero_status, matches: Number(r.matches), wins: Number(r.wins), top2: Number(r.top2), kos: Number(r.kos) }));
}

export interface HeroStanding {
  seasonId: string | null;
  ranked: Array<HeroRanked<HeroPeriodStat>>;
  eligible: Array<HeroRanked<HeroPeriodStat>>;
  poolSet: boolean;
  pool: bigint;
  /** The prize of each prize-eligible hero (a projection until the period is finalized; owner state is applied only at finalization). */
  prizeOf: Map<string, bigint>;
  returned: bigint;
}

export async function computeHeroStanding(q: Queryable, kind: PeriodKind, start: string, settings: GameSettings, allowDemo: boolean): Promise<HeroStanding> {
  const win = periodWindowOf(kind, start);
  const seasonId = await heroPeriodSeason(q, new Date(win.startsAt).toISOString(), new Date(win.endsAt).toISOString());
  const stats = seasonId ? await aggregateHeroPeriod(q, seasonId, new Date(win.startsAt).toISOString(), new Date(win.endsAt).toISOString(), allowDemo) : [];
  const ranked = rankHeroArena(stats, settings.hero_arena.minimumWins);
  const eligible = ranked.filter((r) => r.prizeEligible);
  const configured = heroPoolMicro(settings, kind);
  const pool = settings.hero_arena.enabled && configured !== null ? configured : 0n;
  const prizes = distributeHeroPrizes(ranked, pool, settings.hero_arena.prizeSplitBps);
  return { seasonId, ranked, eligible, poolSet: configured !== null, pool, prizeOf: prizes.prizeOf, returned: prizes.returnedMicro };
}

// ---------------------------------------------------------------------------------------------------------------------
// Frozen boards (history)
// ---------------------------------------------------------------------------------------------------------------------
export interface FrozenHeroRow {
  character_id: string;
  owner_user_id: number | null;
  hero_name: string;
  class_id: string;
  rarity: string | null;
  rank: number;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
  prize_eligible: boolean;
  prize_micro: string;
  prize_status: "NONE" | "CREDITED" | "RESERVED" | "HELD" | "FORFEITED";
  tie_size: number;
}

export interface FrozenHeroBoard {
  kind: PeriodKind;
  start: string;
  seasonId: string;
  poolSet: boolean;
  poolMicro: bigint;
  splitBps: number[];
  minimumWins: number;
  participants: number;
  eligibleParticipants: number;
  finalizedAt: number;
}

export async function getFrozenHeroBoard(q: Queryable, kind: PeriodKind, start: string): Promise<FrozenHeroBoard | null> {
  const [b] = await q.query<{ season_id: string; pool_set: boolean; prize_pool_micro: string; prize_split_bps: number[]; minimum_wins: number; participants: number; eligible_participants: number; finalized_at: Date }>(
    `select l.season_id, l.pool_set, l.prize_pool_micro::text, l.prize_split_bps, l.minimum_wins, l.participants, l.eligible_participants, l.finalized_at
       from public.hero_arena_boards l where l.kind = $1 and l.period_start = $2::date and l.season_id in (select z.id from public.seasons z where public.season_counts(z.id))`,
    [kind, start],
  );
  if (!b) return null;
  return {
    kind, start, seasonId: b.season_id, poolSet: b.pool_set, poolMicro: BigInt(b.prize_pool_micro), splitBps: (Array.isArray(b.prize_split_bps) ? b.prize_split_bps : []).map(Number),
    minimumWins: Number(b.minimum_wins), participants: Number(b.participants), eligibleParticipants: Number(b.eligible_participants), finalizedAt: new Date(b.finalized_at).getTime(),
  };
}

export async function getFrozenHeroRows(q: Queryable, kind: PeriodKind, start: string, limit: number): Promise<FrozenHeroRow[]> {
  return q.query<FrozenHeroRow>(
    `select character_id, owner_user_id, hero_name, class_id, rarity, rank, matches, wins, top2, kos, prize_eligible, prize_micro::text, prize_status, tie_size
       from public.hero_arena_results where kind = $1 and period_start = $2::date order by rank, hero_name, character_id limit $3`,
    [kind, start, limit],
  );
}

/** Finalized periods of one kind, newest first — the history selector. */
export async function listFinalizedHeroPeriods(q: Queryable, kind: PeriodKind, limit = 30): Promise<Array<{ start: string; participants: number }>> {
  // Only boards of a season that counts (an official season, or the one being played): the archived pre-season's boards are never listed as history.
  const rows = await q.query<{ period_start: string; participants: number }>(
    "select l.period_start::text, l.participants from public.hero_arena_boards l where l.kind = $1 and l.season_id in (select z.id from public.seasons z where public.season_counts(z.id)) order by l.period_start desc limit $2",
    [kind, Math.min(Math.max(limit, 1), 120)],
  );
  return rows.map((r) => ({ start: r.period_start, participants: Number(r.participants) }));
}

/** The most recent period that has ENDED, has settled battles of a counting season and is not frozen yet (FINALIZING for the few seconds it takes). */
export async function findFinalizingHeroPeriod(q: Queryable, kind: PeriodKind, nowMs: number): Promise<string | null> {
  return (await recentUnfrozenPeriods(q, kind, nowMs, kind === "DAILY" ? 30 : 12, "desc", 1))[0] ?? null;
}

/** The UTC date a battle's period starts on, from its settled_at (a Monday for WEEKLY). */
const startOf = (kind: PeriodKind): string => (kind === "DAILY" ? "date_trunc('day', b.settled_at at time zone 'UTC')::date" : "date_trunc('week', b.settled_at at time zone 'UTC')::date");

/** "This battle belongs to a season that counts" — evaluated against the few season rows ONCE (a hashed sub-select), never by a function call per battle row. */
const COUNTING_SEASON_BATTLE = "b.season_id in (select z.id from public.seasons z where public.season_counts(z.id))";
const STEP_DAYS: Record<PeriodKind, number> = { DAILY: 1, WEEKLY: 7 };

/**
 * Among the last `count` ENDED periods, those with a settled battle of a counting season and no frozen board — one index probe per candidate (`arena_battles_settled_idx`),
 * so the cost is the same with ten battles or ten million.
 */
async function recentUnfrozenPeriods(q: Queryable, kind: PeriodKind, nowMs: number, count: number, order: "asc" | "desc", limit: number): Promise<string[]> {
  const rows = await q.query<{ start: string }>(
    `select to_char(c.start, 'YYYY-MM-DD') as start
       from (select ($1::date - k * $3::int) as start from generate_series(1, $4::int) k) c
      where not exists (select 1 from public.hero_arena_boards h where h.kind = $2 and h.period_start = c.start)
        and exists (select 1 from public.arena_battles b
                     where b.status = 'SETTLED' and b.settled_at >= (c.start::timestamp at time zone 'UTC') and b.settled_at < ((c.start + $3::int)::timestamp at time zone 'UTC') and ${COUNTING_SEASON_BATTLE})
      order by c.start ${order} limit $5::int`,
    [periodWindow(kind, nowMs).start, kind, STEP_DAYS[kind], count, limit],
  );
  return rows.map((r) => r.start);
}

// ---------------------------------------------------------------------------------------------------------------------
// FINALIZATION — idempotent; freezes the ranking and the prizes; credits through the SAME reward ledger (its own kinds and source)
// ---------------------------------------------------------------------------------------------------------------------
export type HeroFinalizeResult =
  | { status: "FINALIZED"; kind: PeriodKind; start: string; participants: number; eligible: number; credited: number; reserved: number; held: number; awardedMicro: bigint; returnedMicro: bigint }
  | { status: "ALREADY_FINALIZED" | "NOT_ENDED" | "NO_PARTICIPANTS"; kind: PeriodKind; start: string };

export interface HeroCtx {
  now: () => Date;
  settings: GameSettings;
  allowDemo?: boolean;
}

interface OwnerRow {
  character_id: string;
  owner_user_id: number | null;
  claimed: boolean;
  class_id: string;
  rarity: string | null;
  hold_reason: string | null;
}

/** Who owns each hero, whether the owner has claimed it, and whether the owner's account is under review — one set-based query. */
async function loadOwners(q: Queryable, ids: string[]): Promise<Map<string, OwnerRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q.query<OwnerRow>(
    `select c.id as character_id, c.telegram_user_id as owner_user_id, (cl.character_id is not null and cl.telegram_user_id = c.telegram_user_id) as claimed, c.class_id, ca.rarity,
            case when ra.review_state = 'SUSPENDED' then 'SUSPENDED' when ra.review_state = 'REVIEW' or tu.status = 'FLAGGED' then 'REVIEW' when tu.status = 'BANNED' then 'BANNED' end as hold_reason
       from public.characters c
       left join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.arena_reward_accounts ra on ra.telegram_user_id = c.telegram_user_id
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [json(ids)],
  );
  return new Map(rows.map((r) => [r.character_id, r]));
}

export async function finalizeHeroPeriod(db: Db, ctx: HeroCtx, kind: PeriodKind, start: string): Promise<HeroFinalizeResult> {
  const nowMs = ctx.now().getTime();
  if (!isPeriodStart(kind, start)) return { status: "NOT_ENDED", kind, start };
  const win = periodWindowOf(kind, start);
  // A short grace after the boundary: a settlement stamped just before it by a process whose clock runs slightly behind must be visible before the freeze.
  if (win.endsAt + GRACE_MS > nowMs) return { status: "NOT_ENDED", kind, start };
  const { settings } = ctx;
  const allowDemo = ctx.allowDemo ?? false;
  const frozen = async (q: Queryable): Promise<boolean> => (await q.query("select 1 from public.hero_arena_boards where kind = $1 and period_start = $2::date", [kind, start])).length > 0;
  if (await frozen(db)) return { status: "ALREADY_FINALIZED", kind, start };

  return db.transaction(async (tx): Promise<HeroFinalizeResult> => {
    // Side by side with other finalizations, never through a lifecycle action (launch / reset / end season): see services/lifecycleLock.ts.
    await lockLifecycleShared(tx);
    if (await frozen(tx)) return { status: "ALREADY_FINALIZED", kind, start };
    const standing = await computeHeroStanding(tx, kind, start, settings, allowDemo);
    if (!standing.seasonId || standing.ranked.length === 0) return { status: "NO_PARTICIPANTS", kind, start };
    const { ranked, eligible, seasonId, pool, poolSet } = standing;
    const owners = await loadOwners(tx, ranked.map((r) => r.row.characterId));

    // A prize position held by a hero WITHOUT a Telegram owner keeps its place and pays nobody: its share returns to the reserve (never to another hero).
    let awarded = 0n;
    const payable = new Map<string, bigint>();
    for (const [id, amount] of standing.prizeOf) {
      if (owners.get(id)?.owner_user_id != null) {
        payable.set(id, amount);
        awarded += amount;
      }
    }
    const returned = pool - awarded;

    const won = await tx.query(
      `insert into public.hero_arena_boards
         (kind, period_start, season_id, pool_set, prize_pool_micro, prize_split_bps, minimum_wins, participants, eligible_participants, awarded_micro, returned_to_reserve_micro, finalized_at)
       values ($1, $2::date, $3::uuid, $4, $5::numeric, $6::jsonb, $7, $8, $9, $10::numeric, $11::numeric, $12::timestamptz) on conflict (kind, period_start) do nothing returning period_start`,
      [kind, start, seasonId, poolSet, pool.toString(), json(settings.hero_arena.prizeSplitBps), settings.hero_arena.minimumWins, ranked.length, eligible.length, awarded.toString(), returned.toString(), ctx.now().toISOString()],
    );
    if (won.length === 0) return { status: "ALREADY_FINALIZED", kind, start };

    // Reward accounts are locked in OWNER ORDER before any credit, so two finalizations running at once (a day and a week) can never deadlock on each other.
    const toCredit = [...new Set([...payable.keys()].map((id) => owners.get(id)).filter((o): o is OwnerRow => Boolean(o && o.owner_user_id !== null && o.claimed && !o.hold_reason)).map((o) => Number(o.owner_user_id)))].sort((a, b) => a - b);
    for (const ownerId of toCredit) await lockRewardAccount(tx, ownerId);

    let credited = 0;
    let reserved = 0;
    let held = 0;
    for (const r of ranked) {
      const o = owners.get(r.row.characterId);
      const prize = payable.get(r.row.characterId) ?? 0n;
      const claimed = Boolean(o?.claimed);
      const hold = prize > 0n ? (o?.hold_reason ?? null) : null;
      // CLAIMED + in good standing → credited now. UNCLAIMED → reserved against the hero and its owner. Under review → held for an admin.
      const status = prize === 0n ? "NONE" : hold ? "HELD" : claimed ? "CREDITED" : "RESERVED";
      await tx.query(
        `insert into public.hero_arena_results
           (kind, period_start, character_id, owner_user_id, hero_name, class_id, rarity, rank, matches, wins, top2, kos, prize_eligible, prize_rank, tie_size, prize_micro, prize_status, owner_claimed, hold_reason, settled_at)
         values ($1, $2::date, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::numeric, $17, $18, $19, $20::timestamptz)`,
        [
          kind, start, r.row.characterId, o?.owner_user_id ?? null, r.row.name, o?.class_id ?? "warrior", o?.rarity ?? null, r.rank, r.row.matches, r.row.wins, r.row.top2, r.row.kos, r.prizeEligible,
          r.prizeEligible ? prizeRankOf(eligible, r.row.characterId) : null, r.tieSize, prize.toString(), status, claimed, hold, status === "CREDITED" ? ctx.now().toISOString() : null,
        ],
      );
      if (status === "CREDITED") {
        await creditHeroPrize(tx, kind, start, r.row.characterId, o?.owner_user_id as number, prize, { rank: r.rank, wins: r.row.wins, tieSize: r.tieSize });
        credited++;
      } else if (status === "RESERVED") reserved++;
      else if (status === "HELD") held++;
    }
    return { status: "FINALIZED", kind, start, participants: ranked.length, eligible: eligible.length, credited, reserved, held, awardedMicro: awarded, returnedMicro: returned };
  });
}

/** Competition position among the prize-eligible heroes (ties share one). */
function prizeRankOf(eligible: ReadonlyArray<HeroRanked<HeroPeriodStat>>, characterId: string): number {
  const mine = eligible.find((e) => e.row.characterId === characterId);
  return mine ? eligible.filter((e) => e.row.wins > mine.row.wins).length + 1 : 0;
}

/** One ledger credit for one hero prize (idempotent per hero per period). */
async function creditHeroPrize(q: Queryable, kind: PeriodKind, start: string, characterId: string, ownerId: number, amount: bigint, meta: Record<string, unknown>): Promise<void> {
  await lockRewardAccount(q, ownerId);
  await postRewardLedger(q, {
    userId: ownerId, kind: heroArenaKind(kind), claimableDelta: amount, earnedDelta: amount, heroPeriodKind: kind, heroPeriodStart: start, heroCharacterId: characterId,
    meta: { program: "HERO_ARENA", ...meta }, idempotencyKey: `hero-arena:${kind}:${start}:${characterId}`,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The owner claims the hero → what was RESERVED for it is credited to THAT owner
// ---------------------------------------------------------------------------------------------------------------------
interface OpenRow {
  kind: PeriodKind;
  period_start: string;
  character_id: string;
  owner_user_id: number;
  prize_micro: string;
}

/**
 * Credits every prize RESERVED for `characterId` to its owner — only if `ownerUserId` really is the hero's owner and has claimed it (the row's owner is what
 * counts: nobody else can ever receive it). An owner whose account is under review gets the prize HELD instead. Idempotent; a no-op before the migration.
 * Called inside the claim's own transaction and by the sweep.
 */
export async function releaseReservedHeroPrizes(q: Queryable, ctx: { now: () => Date }, characterId: string, ownerUserId: number): Promise<{ credited: number; held: number }> {
  const out = { credited: 0, held: 0 };
  if (!(await heroArenaReady(q, ctx.now().getTime()))) return out;
  const rows = await q.query<OpenRow>(
    `select r.kind, r.period_start::text, r.character_id, r.owner_user_id, r.prize_micro::text
       from public.hero_arena_results r join public.character_claims cl on cl.character_id = r.character_id and cl.telegram_user_id = r.owner_user_id
      where r.character_id = $1::uuid and r.owner_user_id = $2 and r.prize_status = 'RESERVED' order by r.period_start for update of r`,
    [characterId, ownerUserId],
  );
  if (rows.length === 0) return out;
  await lockRewardAccount(q, ownerUserId);
  const [state] = await q.query<{ hold_reason: string | null }>(
    `select case when ra.review_state = 'SUSPENDED' then 'SUSPENDED' when ra.review_state = 'REVIEW' or tu.status = 'FLAGGED' then 'REVIEW' when tu.status = 'BANNED' then 'BANNED' end as hold_reason
       from public.telegram_users tu left join public.arena_reward_accounts ra on ra.telegram_user_id = tu.telegram_user_id where tu.telegram_user_id = $1`,
    [ownerUserId],
  );
  for (const r of rows) {
    if (state?.hold_reason) {
      await q.query("update public.hero_arena_results set prize_status = 'HELD', hold_reason = $4 where kind = $1 and period_start = $2::date and character_id = $3::uuid and prize_status = 'RESERVED'", [r.kind, r.period_start, r.character_id, state.hold_reason]);
      out.held++;
      continue;
    }
    await q.query("update public.hero_arena_results set prize_status = 'CREDITED', settled_at = $4::timestamptz, hold_reason = null where kind = $1 and period_start = $2::date and character_id = $3::uuid and prize_status = 'RESERVED'", [r.kind, r.period_start, r.character_id, ctx.now().toISOString()]);
    await creditHeroPrize(q, r.kind, r.period_start, r.character_id, ownerUserId, BigInt(r.prize_micro), { released: "ON_CLAIM" });
    out.credited++;
  }
  return out;
}

/** The sweep's safety net: any RESERVED prize whose hero has since been claimed by its owner (however the claim happened) is released. Bounded. */
export async function releaseClaimedReservations(db: Db, ctx: { now: () => Date }, limit = 25): Promise<number> {
  if (!(await heroArenaReady(db, ctx.now().getTime()))) return 0;
  const due = await db.query<{ character_id: string; owner_user_id: number }>(
    `select distinct r.character_id, r.owner_user_id from public.hero_arena_results r
       join public.character_claims cl on cl.character_id = r.character_id and cl.telegram_user_id = r.owner_user_id
      where r.prize_status = 'RESERVED' limit $1`,
    [limit],
  );
  let credited = 0;
  for (const d of due) credited += (await db.transaction((tx) => releaseReservedHeroPrizes(tx, ctx, d.character_id, Number(d.owner_user_id)))).credited;
  return credited;
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin: a prize HELD for review is released to its owner or forfeited to the reserve (audited by the caller). Nothing else can move a Hero Arena prize.
// ---------------------------------------------------------------------------------------------------------------------
export type ResolveHeroPrizeResult = { ok: true; status: "CREDITED" | "FORFEITED"; prizeMicro: bigint } | { ok: false; reason: "NOT_FOUND" | "NOT_HELD" | "REASON_REQUIRED" };

export async function resolveHeldHeroPrize(db: Db, ctx: { now: () => Date }, input: { kind: PeriodKind; start: string; characterId: string; action: "release" | "forfeit"; reason: string; actor: string }): Promise<ResolveHeroPrizeResult> {
  const reason = input.reason.trim().slice(0, 300);
  if (reason.length < 3) return { ok: false, reason: "REASON_REQUIRED" };
  return db.transaction(async (tx): Promise<ResolveHeroPrizeResult> => {
    const [row] = await tx.query<{ owner_user_id: number | null; prize_micro: string; prize_status: string }>(
      "select owner_user_id, prize_micro::text, prize_status from public.hero_arena_results where kind = $1 and period_start = $2::date and character_id = $3::uuid for update",
      [input.kind, input.start, input.characterId],
    );
    if (!row) return { ok: false, reason: "NOT_FOUND" };
    if (row.prize_status !== "HELD" || row.owner_user_id === null) return { ok: false, reason: "NOT_HELD" };
    const next = input.action === "release" ? "CREDITED" : "FORFEITED";
    const prize = BigInt(row.prize_micro);
    await tx.query(
      `update public.hero_arena_results set prize_status = $4, settled_at = $5::timestamptz, resolved_by = $6, resolution_reason = $7
        where kind = $1 and period_start = $2::date and character_id = $3::uuid and prize_status = 'HELD'`,
      [input.kind, input.start, input.characterId, next, ctx.now().toISOString(), input.actor, reason],
    );
    if (next === "CREDITED") await creditHeroPrize(tx, input.kind, input.start, input.characterId, Number(row.owner_user_id), prize, { releasedBy: input.actor, reason });
    return { ok: true, status: next, prizeMicro: prize };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The sweep (tick / worker / right after a settlement) — INDEPENDENT of the Arena Picks sweep: one program failing cannot touch the other
// ---------------------------------------------------------------------------------------------------------------------
export interface HeroSweepResult {
  finalized: number;
  failed: number;
  released: number;
  periods: string[];
}

/**
 * Finalizes every ended Daily and Weekly Hero Arena period that has settled battles and no frozen board yet (oldest first), then releases prizes whose hero
 * has been claimed. Cheap when idle, safe from many workers, a quiet no-op before the migration, and it never throws into the caller.
 */
export async function finalizeDueHeroBoards(db: Db, ctx: HeroCtx, onError: (label: string, error: unknown) => void = defaultOnError): Promise<HeroSweepResult> {
  const out: HeroSweepResult = { finalized: 0, failed: 0, released: 0, periods: [] };
  const nowMs = ctx.now().getTime();
  try {
    if (!(await heroArenaReady(db, nowMs))) return out;
    const deep = scan.drain || Math.abs(nowMs - scan.deepAt) >= DEEP_SCAN_MS;
    let backlog = false;
    for (const kind of PERIOD_KINDS) {
      const due: string[] = deep
        ? (
            await db.query<{ start: string }>(
              `select ${startOf(kind)}::text as start from public.arena_battles b
                where b.status = 'SETTLED' and b.settled_at < $1::timestamptz and ${COUNTING_SEASON_BATTLE}
                  and not exists (select 1 from public.hero_arena_boards h where h.kind = $2 and h.period_start = ${startOf(kind)})
                group by 1 order by 1 limit 8`,
              [new Date(periodWindow(kind, nowMs).startsAt).toISOString(), kind],
            )
          ).map((r) => r.start)
        : await recentUnfrozenPeriods(db, kind, nowMs, RECENT_PERIODS, "asc", 8);
      if (due.length >= 8) backlog = true;
      for (const start of due) {
        try {
          const r = await finalizeHeroPeriod(db, ctx, kind, start);
          if (r.status === "FINALIZED") {
            out.finalized++;
            out.periods.push(`HERO_ARENA_${kind}:${start}`);
          }
        } catch (error) {
          out.failed++;
          onError(`HERO_ARENA_${kind}:${start}`, error);
        }
      }
    }
    if (deep) scan.deepAt = nowMs;
    scan.drain = backlog;
    out.released = await releaseClaimedReservations(db, ctx);
  } catch (error) {
    out.failed++;
    onError("hero arena sweep", error);
  }
  return out;
}

function defaultOnError(label: string, error: unknown): void {
  console.error(`[rewards] finalizing ${label} failed (will retry):`, error instanceof Error ? error.message : error);
}

/** Win rate display for a stat row (re-exported so boards need only this module for the number format). */
export { winRatePercent };
