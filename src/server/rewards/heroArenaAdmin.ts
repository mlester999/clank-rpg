import { periodWindow } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS } from "@/domain/rewards/tokens";
import type { GameSettings } from "@/domain/settings";
import type { PeriodKind } from "@/domain/rewards/time";

import type { Db, Queryable } from "../db/types";
import { audit } from "../services/auditLog";

import { heroArenaReady, heroPoolMicro, resolveHeldHeroPrize } from "./heroArena";
import { boardPoolMicro } from "./pool";

/**
 * ADMIN · REWARD PROGRAMS — Arena Picks and Hero Arena side by side, each with its OWN pools, so neither can be mistaken for (or silently copied from) the other.
 * Read-only except one audited action: releasing or forfeiting a Hero Arena prize that is HELD for review. Nothing here can credit a hero, pick a recipient or move
 * a prize anywhere else; the pools themselves are the `arena_picks` / `hero_arena` settings (Balance & config — audited like every settings change).
 */
const fmt = (micro: bigint | string): string => formatTokenAmount(BigInt(micro), LOGICAL_DECIMALS);

export interface ProgramView {
  id: "ARENA_PICKS" | "HERO_ARENA";
  label: string;
  /** What it rewards. */
  rewards: string;
  enabled: boolean;
  dailyPool: string | null;
  weeklyPool: string | null;
  ladderBps: number[];
  /** The one-line rule of eligibility. */
  minimum: string;
  /** Hero Arena only: pools unset on purpose ("REWARD POOL NOT SET"). */
  notSet: Array<"daily" | "weekly">;
  setting: "arena_picks" | "hero_arena";
}

export interface HeroArenaAdminOverview {
  programs: ProgramView[];
  ledger: Array<{ source: "ARENA_PICKS_DAILY" | "ARENA_PICKS_WEEKLY" | "HERO_ARENA_DAILY" | "HERO_ARENA_WEEKLY"; credits: number; total: string }>;
  hero: {
    migrated: boolean;
    boards: number;
    credited: { count: number; total: string };
    reserved: { count: number; total: string };
    held: { count: number; total: string };
    returnedToReserve: string;
    running: { daily: string; weekly: string };
  };
  recentBoards: Array<{ kind: PeriodKind; start: string; season: string; poolSet: boolean; pool: string; participants: number; eligible: number; awarded: string; returned: string }>;
  open: Array<{ kind: PeriodKind; start: string; characterId: string; hero: string; ownerUserId: number | null; prize: string; status: "RESERVED" | "HELD"; holdReason: string | null }>;
  notices: string[];
}

export async function heroArenaAdminOverview(q: Queryable, settings: GameSettings, nowMs = Date.now()): Promise<HeroArenaAdminOverview> {
  const picks = settings.arena_picks;
  const hero = settings.hero_arena;
  const daily = heroPoolMicro(settings, "DAILY");
  const weekly = heroPoolMicro(settings, "WEEKLY");
  const programs: ProgramView[] = [
    {
      id: "ARENA_PICKS", label: "Arena Picks", rewards: "Players — most correct Picks", enabled: picks.enabled,
      dailyPool: fmt(boardPoolMicro(settings, "DAILY")), weeklyPool: fmt(boardPoolMicro(settings, "WEEKLY")), ladderBps: picks.prizeSplitBps,
      minimum: `${picks.dailyMinimumPicks} valid Picks a day · ${picks.weeklyMinimumPicks} a week`, notSet: [], setting: "arena_picks",
    },
    {
      id: "HERO_ARENA", label: "Hero Arena", rewards: "Hero owners — most Arena Wins", enabled: hero.enabled,
      dailyPool: daily === null ? null : fmt(daily), weeklyPool: weekly === null ? null : fmt(weekly), ladderBps: hero.prizeSplitBps,
      minimum: `${hero.minimumWins} Arena win${hero.minimumWins === 1 ? "" : "s"} in the period`, notSet: [...(daily === null ? (["daily"] as const) : []), ...(weekly === null ? (["weekly"] as const) : [])], setting: "hero_arena",
    },
  ];

  // Every credit, by program and period — the generated reward source of the ledger (computed from the kind here, so it reads the same before and after the migration).
  const ledger = await q.query<{ source: HeroArenaAdminOverview["ledger"][number]["source"]; credits: number; total: string }>(
    `select case kind when 'DAILY_LEADERBOARD_BASE_REWARD' then 'ARENA_PICKS_DAILY' when 'DAILY_LEADERBOARD_HOLDER_BONUS' then 'ARENA_PICKS_DAILY'
                      when 'WEEKLY_LEADERBOARD_BASE_REWARD' then 'ARENA_PICKS_WEEKLY' when 'WEEKLY_LEADERBOARD_HOLDER_BONUS' then 'ARENA_PICKS_WEEKLY'
                      when 'HERO_ARENA_DAILY_REWARD' then 'HERO_ARENA_DAILY' when 'HERO_ARENA_WEEKLY_REWARD' then 'HERO_ARENA_WEEKLY' end as source,
            count(*)::int as credits, coalesce(sum(claimable_delta), 0)::text as total
       from public.arena_reward_ledger
      where kind in ('DAILY_LEADERBOARD_BASE_REWARD', 'DAILY_LEADERBOARD_HOLDER_BONUS', 'WEEKLY_LEADERBOARD_BASE_REWARD', 'WEEKLY_LEADERBOARD_HOLDER_BONUS', 'HERO_ARENA_DAILY_REWARD', 'HERO_ARENA_WEEKLY_REWARD')
      group by 1 order by 1`,
  );

  const out: HeroArenaAdminOverview = {
    programs,
    ledger: ledger.map((l) => ({ source: l.source, credits: Number(l.credits), total: fmt(l.total) })),
    hero: { migrated: false, boards: 0, credited: { count: 0, total: "0" }, reserved: { count: 0, total: "0" }, held: { count: 0, total: "0" }, returnedToReserve: "0", running: { daily: periodWindow("DAILY", nowMs).start, weekly: periodWindow("WEEKLY", nowMs).start } },
    recentBoards: [],
    open: [],
    notices: [],
  };
  if (daily === null || weekly === null) {
    const unset = [daily === null ? "Daily" : null, weekly === null ? "Weekly" : null].filter(Boolean).join(" and ");
    out.notices.push(`Hero Arena ${unset} reward pool is NOT SET: the boards rank and freeze, and pay nothing until a pool is set in Balance & config → hero_arena.`);
  }
  if (!hero.enabled) out.notices.push("Hero Arena prizes are switched OFF (hero_arena.enabled): periods that finalize now award nothing.");
  if (!(await heroArenaReady(q, nowMs))) {
    out.notices.push("The Hero Arena migration (20261007002200) has not been applied yet: boards rank live, but nothing can be finalized or paid.");
    return out;
  }
  out.hero.migrated = true;
  const [t] = await q.query<{ boards: number; returned: string; c_n: number; c_m: string; r_n: number; r_m: string; h_n: number; h_m: string }>(
    `select (select count(*)::int from public.hero_arena_boards) as boards, (select coalesce(sum(returned_to_reserve_micro), 0)::text from public.hero_arena_boards) as returned,
            (count(*) filter (where prize_status = 'CREDITED'))::int as c_n, (coalesce(sum(prize_micro) filter (where prize_status = 'CREDITED'), 0))::text as c_m,
            (count(*) filter (where prize_status = 'RESERVED'))::int as r_n, (coalesce(sum(prize_micro) filter (where prize_status = 'RESERVED'), 0))::text as r_m,
            (count(*) filter (where prize_status = 'HELD'))::int as h_n, (coalesce(sum(prize_micro) filter (where prize_status = 'HELD'), 0))::text as h_m
       from public.hero_arena_results`,
  );
  out.hero.boards = Number(t?.boards ?? 0);
  out.hero.returnedToReserve = fmt(t?.returned ?? "0");
  out.hero.credited = { count: Number(t?.c_n ?? 0), total: fmt(t?.c_m ?? "0") };
  out.hero.reserved = { count: Number(t?.r_n ?? 0), total: fmt(t?.r_m ?? "0") };
  out.hero.held = { count: Number(t?.h_n ?? 0), total: fmt(t?.h_m ?? "0") };
  if (out.hero.reserved.count > 0) out.notices.push(`${out.hero.reserved.count} Hero Arena prize(s) (${out.hero.reserved.total} $CLANKRPG) are reserved for heroes whose owners have not claimed them yet. They are credited automatically when the owner claims the hero; they cannot be moved to anyone else.`);
  if (out.hero.held.count > 0) out.notices.push(`${out.hero.held.count} Hero Arena prize(s) (${out.hero.held.total} $CLANKRPG) are held for review — release or forfeit them below.`);

  const boards = await q.query<{ kind: PeriodKind; period_start: string; season: string; pool_set: boolean; pool: string; participants: number; eligible: number; awarded: string; returned: string }>(
    `select b.kind, b.period_start::text, coalesce(s.name, b.season_id::text) as season, b.pool_set, b.prize_pool_micro::text as pool, b.participants, b.eligible_participants as eligible,
            b.awarded_micro::text as awarded, b.returned_to_reserve_micro::text as returned
       from public.hero_arena_boards b left join public.seasons s on s.id = b.season_id order by b.period_start desc, b.kind limit 14`,
  );
  out.recentBoards = boards.map((b) => ({ kind: b.kind, start: b.period_start, season: b.season, poolSet: b.pool_set, pool: b.pool_set ? fmt(b.pool) : "not set", participants: Number(b.participants), eligible: Number(b.eligible), awarded: fmt(b.awarded), returned: fmt(b.returned) }));

  const open = await q.query<{ kind: PeriodKind; period_start: string; character_id: string; hero_name: string; owner_user_id: number | null; prize_micro: string; prize_status: "RESERVED" | "HELD"; hold_reason: string | null }>(
    "select kind, period_start::text, character_id, hero_name, owner_user_id, prize_micro::text, prize_status, hold_reason from public.hero_arena_results where prize_status in ('RESERVED', 'HELD') order by period_start desc, prize_status, rank limit 100",
  );
  out.open = open.map((o) => ({ kind: o.kind, start: o.period_start, characterId: o.character_id, hero: o.hero_name, ownerUserId: o.owner_user_id === null ? null : Number(o.owner_user_id), prize: fmt(o.prize_micro), status: o.prize_status, holdReason: o.hold_reason }));
  return out;
}

/** Releases (credits its owner) or forfeits (returns to the reserve) a prize that is HELD for review. Audited. The only way an admin moves a Hero Arena prize. */
export async function adminResolveHeroPrize(db: Db, ctx: { now: () => Date }, input: { kind: PeriodKind; start: string; characterId: string; action: "release" | "forfeit"; reason: string }, actor: string) {
  const result = await resolveHeldHeroPrize(db, ctx, { ...input, actor });
  await audit(db, actor, `rewards.hero_arena_prize_${input.action}`, "hero_arena_result", `${input.kind}:${input.start}:${input.characterId}`, { source: `HERO_ARENA_${input.kind}`, ok: result.ok, reason: input.reason.slice(0, 300), prizeMicro: result.ok ? result.prizeMicro.toString() : null });
  return result;
}
