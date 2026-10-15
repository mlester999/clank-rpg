import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import { rankByMetric, rankHeroArena, winRatePercent, type HeroRanked, type HeroScope, type HeroStat, type RecordMetric } from "@/domain/heroArena";
import type { HeroBoardDto, HeroBoardPayload, HeroPrizeStatus, HeroRecordsPayload, HeroRowDto, LeaderboardSeasonView, PicksSeasonPayload, PicksSeasonRowDto } from "@/domain/heroArenaDto";
import { avatarUrlOrNull } from "@/domain/media/avatarUrl";
import { seasonRankFor } from "@/domain/progression/seasonRank";
import { accuracyPercent, rankBoard } from "@/domain/rewards/leaderboard";
import { isPeriodStart, periodWindow, periodWindowOf, type PeriodKind } from "@/domain/rewards/time";
import { formatTokenAmount, LOGICAL_DECIMALS } from "@/domain/rewards/tokens";
import { publicSeasonLabel } from "@/domain/lifecycle";
import type { GameSettings, SeasonRankTier } from "@/domain/settings";
import type { ClassVisual } from "@/lib/dto";

import { json, type Queryable } from "../db/types";
import {
  aggregateHeroPeriod, computeHeroStanding, findFinalizingHeroPeriod, getFrozenHeroBoard, getFrozenHeroRows, heroArenaReady, heroPeriodSeason, heroRules, listFinalizedHeroPeriods, type HeroPeriodStat,
} from "../rewards/heroArena";

/**
 * THE READ SIDE of the Hall of Champions' HERO boards:
 *   HERO ARENA   Daily / Weekly (rewarded) and Season (standings) — ranked by ARENA WINS;
 *   HERO RECORDS Top-2, KOs (Daily / Weekly / Season) and current PWR — statistics, no prizes;
 *   ARENA PICKS  Season standings (the Daily / Weekly boards live in rewards/leaderboard.ts).
 *
 * Everything is season-aware: a period is ranked over the battles (or Picks) of ONE season, a season view over that season's own per-hero totals, so the next
 * season starts from zero and every past season stays exactly as it finished. Every query is set-based (one aggregate, then one batched lookup for the rows
 * that are shown) — nothing runs per row. Display only: nothing here is a ranking input except the metric itself.
 */
const DEFAULT_LIMIT = 50;
const clampLimit = (n: number | undefined): number => Math.min(Math.max(n ?? DEFAULT_LIMIT, 1), 100);

// ---------------------------------------------------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------------------------------------------------
interface SeasonRow {
  id: string;
  kind: "DEVELOPMENT" | "COMPETITIVE";
  number: number | null;
  name: string;
  status: "ACTIVE" | "ENDED";
  ends_at: Date | null;
}

/** The season being played now first, then the official seasons newest first (an ended development run is archived and not offered). */
export async function listLeaderboardSeasons(q: Queryable, nowMs: number = Date.now()): Promise<LeaderboardSeasonView[]> {
  const rows = await q.query<SeasonRow>(
    `select id, kind, number, name, status, ends_at from public.seasons where status = 'ACTIVE' or kind = 'COMPETITIVE' order by (status = 'ACTIVE') desc, starts_at desc, created_at desc limit 12`,
  );
  return rows.map((s) => {
    const endsAt = s.ends_at ? new Date(s.ends_at).getTime() : null;
    return {
      id: s.id,
      label: publicSeasonLabel({ kind: s.kind, number: s.number, name: s.name }),
      kind: s.kind,
      status: s.status,
      current: s.status === "ACTIVE",
      // Only a real, upcoming end of the season being played. An ended season's `ends_at` is when it ENDED (history), never a countdown.
      endsAt: s.status === "ACTIVE" && endsAt !== null && endsAt > nowMs ? endsAt : null,
    };
  });
}

/** The requested season if it is one we offer, otherwise the current one (null when there is none at all). */
export function pickSeason(seasons: readonly LeaderboardSeasonView[], requested: string | null | undefined): LeaderboardSeasonView | null {
  return seasons.find((s) => s.id === requested) ?? seasons.find((s) => s.current) ?? seasons[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Hero cards (name / link / look of the rows that are SHOWN) — one batched query
// ---------------------------------------------------------------------------------------------------------------------
interface MetaRow {
  id: string;
  public_id: string;
  name: string;
  class_id: string;
  hero_status: string;
  member_status: string | null;
  is_demo: boolean;
  power: number;
  claimed: boolean;
  rarity: Rarity;
  parts: AppearanceParts;
  sprite: unknown;
  overrides: unknown;
  avatar_version: string | null;
  season_points: number | null;
}

async function loadMeta(q: Queryable, ids: string[], seasonId: string | null): Promise<Map<string, MetaRow>> {
  if (ids.length === 0) return new Map();
  const rows = await q.query<MetaRow>(
    `select c.id, c.public_id, coalesce(c.name_override, c.name) as name, c.class_id, c.status as hero_status, tu.status as member_status, c.is_demo, c.power,
            (cl.character_id is not null) as claimed, ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides as overrides, hp.version as avatar_version, ss.points as season_points
       from public.characters c
       join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.hero_profile_photos hp on hp.character_id = c.id
       left join public.season_character_stats ss on ss.character_id = c.id and ss.season_id = $2::uuid
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid)`,
    [json(ids), seasonId],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

const isPublic = (m: MetaRow): boolean => m.hero_status === "ACTIVE" && m.member_status !== "BANNED";
const tierOf = (points: number | null, tiers: readonly SeasonRankTier[] | undefined): { id: string; name: string } | null => {
  if (points === null || !tiers?.length) return null;
  const { tier } = seasonRankFor(Number(points), tiers);
  return { id: tier.id, name: tier.name };
};

interface ShownStat {
  rank: number;
  tied: boolean;
  characterId: string;
  name: string;
  classId: string;
  matches: number;
  wins: number;
  top2: number;
  kos: number;
  prizeEligible: boolean;
  prize: bigint;
  prizeStatus: HeroPrizeStatus;
  /** The hero's rarity as FROZEN (history) — the current one is used for the badge when the hero can still be read. */
  frozenRarity?: Rarity | null;
}

/** What the PUBLIC may see of a prize: review state is private (a held prize reads as awarded, a forfeited one as none) — exactly as on the Arena Picks boards. */
const publicPrize = (status: HeroPrizeStatus, prize: bigint): { status: HeroPrizeStatus; prize: bigint } =>
  status === "HELD" ? { status: "CREDITED", prize } : status === "FORFEITED" ? { status: "NONE", prize: 0n } : { status, prize };

function toRows(shown: ShownStat[], meta: Map<string, MetaRow>, tiers: readonly SeasonRankTier[] | undefined, showTier: boolean): HeroRowDto[] {
  return shown.map((s0) => {
    const { status: prizeStatus, prize } = publicPrize(s0.prizeStatus, s0.prize);
    const s = { ...s0, prize, prizeStatus };
    const m = meta.get(s.characterId);
    const rarity = m?.rarity ?? s.frozenRarity ?? null;
    return {
      rank: s.rank,
      tied: s.tied,
      characterId: s.characterId,
      heroPublicId: m && isPublic(m) ? m.public_id : null,
      name: m?.name ?? s.name,
      classId: m?.class_id ?? s.classId,
      rarity,
      power: Number(m?.power ?? 0),
      matches: s.matches,
      wins: s.wins,
      top2: s.top2,
      kos: s.kos,
      winRate: winRatePercent(s.wins, s.matches),
      seasonRank: showTier ? tierOf(m?.season_points ?? null, tiers) : null,
      appearance: m ? { rarity: m.rarity, parts: m.parts, sprite: m.sprite ?? undefined, overrides: m.overrides } : null,
      avatarUrl: m ? avatarUrlOrNull(m.id, m.avatar_version) : null,
      claimed: Boolean(m?.claimed),
      isDemo: Boolean(m?.is_demo),
      prizeEligible: s.prizeEligible,
      prize: s.prize === 0n ? "0" : formatTokenAmount(s.prize, LOGICAL_DECIMALS),
      prizeStatus: s.prizeStatus,
    };
  });
}

const fromRanked = (r: HeroRanked<HeroPeriodStat>, prize: bigint): ShownStat => ({
  rank: r.rank, tied: r.tieSize > 1, characterId: r.row.characterId, name: r.row.name, classId: "", matches: r.row.matches, wins: r.row.wins, top2: r.row.top2, kos: r.row.kos,
  prizeEligible: r.prizeEligible, prize, prizeStatus: "NONE",
});

// ---------------------------------------------------------------------------------------------------------------------
// Season totals (per hero, one season) — from season_character_stats
// ---------------------------------------------------------------------------------------------------------------------
async function seasonStats(q: Queryable, seasonId: string, allowDemo: boolean): Promise<HeroPeriodStat[]> {
  const rows = await q.query<{ character_id: string; name: string; hero_status: string; matches: number; wins: number; top2: number; kos: number }>(
    `select ss.character_id, coalesce(c.name_override, c.name) as name, c.status as hero_status, ss.battles as matches, ss.wins, ss.top2, ss.eliminations as kos
       from public.season_character_stats ss join public.characters c on c.id = ss.character_id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where ss.season_id = $1::uuid and ss.battles > 0 and (tu.status is null or tu.status <> 'BANNED') and (not c.is_demo or $2::boolean)`,
    [seasonId, allowDemo],
  );
  return rows.map((r) => ({ characterId: r.character_id, name: r.name, heroStatus: r.hero_status, matches: Number(r.matches), wins: Number(r.wins), top2: Number(r.top2), kos: Number(r.kos) }));
}

export interface BoardCtx {
  nowMs: number;
  settings: GameSettings;
  allowDemo: boolean;
  classes: Record<string, ClassVisual>;
  limit?: number;
  /** The season to show for the SEASON scope (default: the current one). */
  seasonId?: string | null;
  /** DAILY / WEEKLY: a past period (YYYY-MM-DD); default the running one. */
  start?: string | null;
}

const emptyBoard = (scope: HeroScope, rewarded: boolean, ctx: BoardCtx, season: LeaderboardSeasonView | null): HeroBoardDto => ({
  scope, rewarded, state: scope === "SEASON" ? "SEASON" : "CURRENT", start: null, serverNow: ctx.nowMs, startsAt: null, endsAt: null, season, rules: null, participants: 0, rows: [], finalizedAt: null, classes: ctx.classes,
});

// ---------------------------------------------------------------------------------------------------------------------
// HERO ARENA — Daily / Weekly (rewarded) and Season (standings)
// ---------------------------------------------------------------------------------------------------------------------
export async function getHeroArenaPayload(q: Queryable, scope: HeroScope, ctx: BoardCtx): Promise<HeroBoardPayload> {
  const seasons = await listLeaderboardSeasons(q);
  const limit = clampLimit(ctx.limit);
  if (scope === "SEASON") {
    const season = pickSeason(seasons, ctx.seasonId);
    const board = emptyBoard("SEASON", false, ctx, season);
    if (season) {
      const ranked = rankHeroArena(await seasonStats(q, season.id, ctx.allowDemo), Number.POSITIVE_INFINITY);
      const top = ranked.slice(0, limit);
      const meta = await loadMeta(q, top.map((r) => r.row.characterId), season.id);
      board.participants = ranked.length;
      board.rows = toRows(top.map((r) => fromRanked(r, 0n)), meta, ctx.settings.progression.seasonRanks, true);
    }
    return { board, periods: [], finalizing: null, seasons };
  }

  const kind: PeriodKind = scope;
  const ready = await heroArenaReady(q, ctx.nowMs);
  const start = ctx.start && isPeriodStart(kind, ctx.start) && Date.parse(`${ctx.start}T00:00:00Z`) <= ctx.nowMs ? ctx.start : null;
  const win = start ? periodWindowOf(kind, start) : periodWindow(kind, ctx.nowMs);
  const rules = heroRules(ctx.settings, kind);
  const periods = ready ? await listFinalizedHeroPeriods(q, kind, kind === "DAILY" ? 30 : 12) : [];
  const finalizing = ready ? await findFinalizingHeroPeriod(q, kind, ctx.nowMs) : null;
  const base = { scope, rewarded: true, serverNow: ctx.nowMs, start: win.start, startsAt: win.startsAt, endsAt: win.endsAt, classes: ctx.classes };

  // A FINALIZED period is read from its frozen rows (never recomputed).
  const frozen = ready ? await getFrozenHeroBoard(q, kind, win.start) : null;
  if (frozen) {
    const rows = await getFrozenHeroRows(q, kind, win.start, limit);
    const meta = await loadMeta(q, rows.map((r) => r.character_id), frozen.seasonId);
    const season = seasons.find((s) => s.id === frozen.seasonId) ?? null;
    const frozenRules = {
      ...rules,
      minimumWins: frozen.minimumWins,
      poolSet: frozen.poolSet,
      prizePool: frozen.poolSet ? formatTokenAmount(frozen.poolMicro, LOGICAL_DECIMALS) : null,
      topRewarded: frozen.splitBps.length,
      prizes: frozen.splitBps.map((bps, i) => ({ position: i + 1, share: `${bps / 100}%`, amount: frozen.poolSet ? formatTokenAmount((frozen.poolMicro * BigInt(bps)) / 10_000n, LOGICAL_DECIMALS) : null })),
      prizesPaused: frozen.poolSet && frozen.poolMicro === 0n,
    };
    const shown: ShownStat[] = rows.map((r) => ({
      rank: Number(r.rank), tied: Number(r.tie_size) > 1, characterId: r.character_id, name: r.hero_name, classId: r.class_id, matches: Number(r.matches), wins: Number(r.wins), top2: Number(r.top2), kos: Number(r.kos),
      prizeEligible: r.prize_eligible, prize: BigInt(r.prize_micro), prizeStatus: r.prize_status as HeroPrizeStatus, frozenRarity: (r.rarity as Rarity | null) ?? null,
    }));
    return {
      board: { ...base, state: "FINAL", season, rules: frozenRules, participants: frozen.participants, rows: toRows(shown, meta, undefined, false), finalizedAt: frozen.finalizedAt },
      periods, finalizing, seasons,
    };
  }

  // LIVE: the running period (projected prizes), or an ended one that is not frozen yet.
  const standing = await computeHeroStanding(q, kind, win.start, ctx.settings, ctx.allowDemo);
  const top = standing.ranked.slice(0, limit);
  const meta = await loadMeta(q, top.map((r) => r.row.characterId), standing.seasonId);
  const season = seasons.find((s) => s.id === standing.seasonId) ?? null;
  return {
    board: {
      ...base, state: win.endsAt > ctx.nowMs ? "CURRENT" : "FINALIZING", season, rules, participants: standing.ranked.length, finalizedAt: null,
      rows: toRows(top.map((r) => fromRanked(r, standing.prizeOf.get(r.row.characterId) ?? 0n)), meta, undefined, false),
    },
    periods, finalizing, seasons,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// HERO RECORDS — Top-2 / KOs (Daily / Weekly / Season) and current PWR. Statistics: no rules, no prizes, ever.
// ---------------------------------------------------------------------------------------------------------------------
export async function getHeroRecordsPayload(q: Queryable, metric: RecordMetric, scope: HeroScope, ctx: BoardCtx): Promise<HeroRecordsPayload> {
  const seasons = await listLeaderboardSeasons(q);
  const limit = clampLimit(ctx.limit);
  const tiers = ctx.settings.progression.seasonRanks;

  if (metric === "PWR") {
    // CURRENT power only: a hero's power is not an event that accumulates, and no per-day history of it is kept — nothing here pretends otherwise.
    const season = pickSeason(seasons, null);
    const rows = await q.query<{ id: string; name: string; power: number }>(
      `select c.id, coalesce(c.name_override, c.name) as name, c.power from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
        where c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED') and (not c.is_demo or $1::boolean) order by c.power desc, c.id`,
      [ctx.allowDemo],
    );
    // Competition ranking on the exact power value (heroes with the same PWR share a rank; display order inside a tie is by name).
    const ranked = rankByMetric(rows.map((r) => ({ characterId: r.id, name: r.name, matches: 0, wins: 0, top2: 0, kos: 0, power: Number(r.power) })), (r) => r.power);
    const top = ranked.slice(0, limit);
    const meta = await loadMeta(q, top.map((r) => r.row.characterId), season?.id ?? null);
    const board = emptyBoard("SEASON", false, ctx, season);
    board.participants = ranked.length;
    board.rows = toRows(top.map((r) => ({ rank: r.rank, tied: r.tieSize > 1, characterId: r.row.characterId, name: r.row.name, classId: "", matches: 0, wins: 0, top2: 0, kos: 0, prizeEligible: false, prize: 0n, prizeStatus: "NONE" })), meta, tiers, false);
    return { metric, board, seasons };
  }

  const by = (r: HeroStat): number => (metric === "TOP2" ? r.top2 : r.kos);
  if (scope === "SEASON") {
    const season = pickSeason(seasons, ctx.seasonId);
    const board = emptyBoard("SEASON", false, ctx, season);
    if (season) {
      const ranked = rankByMetric(await seasonStats(q, season.id, ctx.allowDemo), by);
      const top = ranked.slice(0, limit);
      const meta = await loadMeta(q, top.map((r) => r.row.characterId), season.id);
      board.participants = ranked.length;
      board.rows = toRows(top.map((r) => fromRanked(r, 0n)), meta, tiers, true);
    }
    return { metric, board, seasons };
  }

  // DAILY / WEEKLY: the running period of the season that owns it.
  const kind: PeriodKind = scope;
  const win = periodWindow(kind, ctx.nowMs);
  const iso = (ms: number) => new Date(ms).toISOString();
  const seasonId = await heroPeriodSeason(q, iso(win.startsAt), iso(win.endsAt));
  const season = seasons.find((s) => s.id === seasonId) ?? null;
  const board = { ...emptyBoard(scope, false, ctx, season), start: win.start, startsAt: win.startsAt, endsAt: win.endsAt };
  if (seasonId) {
    const ranked = rankByMetric(await aggregateHeroPeriod(q, seasonId, iso(win.startsAt), iso(win.endsAt), ctx.allowDemo), by);
    const top = ranked.slice(0, limit);
    const meta = await loadMeta(q, top.map((r) => r.row.characterId), seasonId);
    board.participants = ranked.length;
    board.rows = toRows(top.map((r) => fromRanked(r, 0n)), meta, undefined, false);
  }
  return { metric, board, seasons };
}

// ---------------------------------------------------------------------------------------------------------------------
// ARENA PICKS — Season standings (cumulative; standings only, no payout)
// ---------------------------------------------------------------------------------------------------------------------
export async function getPicksSeasonPayload(q: Queryable, ctx: { nowMs: number; seasonId?: string | null; viewerId?: number | null; limit?: number }): Promise<PicksSeasonPayload> {
  const seasons = await listLeaderboardSeasons(q);
  const season = pickSeason(seasons, ctx.seasonId);
  const empty: PicksSeasonPayload = { rewarded: false, season, serverNow: ctx.nowMs, participants: 0, rows: [], me: ctx.viewerId != null ? { rank: null, picks: 0, correctPicks: 0, accuracy: null, points: 0 } : null, seasons };
  const [ready] = await q.query<{ ok: boolean }>("select to_regclass('public.arena_pick_scores') is not null as ok");
  if (!season || !ready?.ok) return empty;
  const agg = await q.query<{ telegram_user_id: number; character_id: string | null; name: string | null; class_id: string | null; points: number; picks: number; correct: number }>(
    `select s.telegram_user_id, c.id as character_id, coalesce(c.name_override, c.name) as name, c.class_id,
            coalesce(sum(s.points), 0)::int as points, count(*)::int as picks, (count(*) filter (where s.correct))::int as correct
       from public.arena_pick_scores s left join public.characters c on c.telegram_user_id = s.telegram_user_id
      where s.season_id = $1::uuid group by s.telegram_user_id, c.id, c.name_override, c.name, c.class_id`,
    [season.id],
  );
  const inputs = agg.map((a) => ({ userId: Number(a.telegram_user_id), points: Number(a.points), picks: Number(a.picks), correct: Number(a.correct), agg: a }));
  const ranked = rankBoard(inputs, 0);
  const top = ranked.slice(0, clampLimit(ctx.limit));
  const ids = top.map((r) => r.row.agg.character_id).filter((x): x is string => typeof x === "string");
  const meta = await loadMeta(q, ids, null);
  const rows: PicksSeasonRowDto[] = top.map((r) => {
    const m = r.row.agg.character_id ? meta.get(r.row.agg.character_id) : undefined;
    return {
      rank: r.rank, tied: r.tieSize > 1, characterId: r.row.agg.character_id, heroPublicId: m && isPublic(m) ? m.public_id : null, rarity: m?.rarity ?? null,
      name: r.row.agg.name ?? "Unknown hero", classId: r.row.agg.class_id ?? "warrior", picks: r.row.picks, correctPicks: r.row.correct, accuracy: accuracyPercent(r.row.correct, r.row.picks), points: r.row.points,
    };
  });
  const mine = ctx.viewerId != null ? ranked.find((r) => r.row.userId === ctx.viewerId) : undefined;
  return {
    rewarded: false, season, serverNow: ctx.nowMs, participants: ranked.length, rows, seasons,
    me: ctx.viewerId != null ? { rank: mine?.rank ?? null, picks: mine?.row.picks ?? 0, correctPicks: mine?.row.correct ?? 0, accuracy: mine ? accuracyPercent(mine.row.correct, mine.row.picks) : null, points: mine?.row.points ?? 0 } : null,
  };
}
