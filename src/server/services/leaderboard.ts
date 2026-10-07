import type { AppearanceParts, Rarity } from "@/domain/character/appearance";
import { avatarUrlOrNull } from "@/domain/media/avatarUrl";
import { seasonRankFor } from "@/domain/progression/seasonRank";
import type { SeasonRankTier } from "@/domain/settings";
import type { Queryable } from "../db/types";

/**
 * Leaderboards. Wins, Top-2 and KOs are CURRENT-SEASON figures (a new season — or the Season 1 launch — starts every hero at zero; the hero itself
 * and its lifetime career counters are untouched). Deliberately NO board ranks by wallet wealth or holdings — wallet-derived
 * strength only ever shows up inside a hero's POWER, and POWER itself is one board among several.
 * There is also NO board for XP / level / lifetime grinding: heroes have no permanent level.
 */
export const BOARDS = {
  WINS: { label: "Arena Wins", season: true },
  TOP2: { label: "Top-2 Finishes", season: true },
  KOS: { label: "KOs", season: true },
  POWER: { label: "Power", season: false },
  COMMUNITY: { label: "Community Activity", season: false },
  SEASON_POINTS: { label: "Season Rank", season: true },
  SEASON_WINS: { label: "Season Wins", season: true },
} as const;
export type BoardId = keyof typeof BOARDS;
export const BOARD_IDS = Object.keys(BOARDS) as BoardId[];

export interface LeaderboardRow {
  rank: number;
  characterId: string;
  /** Stable public hero id (the profile URL). */
  publicId: string;
  name: string;
  classId: string;
  claimed: boolean;
  isDemo: boolean;
  title: string | null;
  /** Summary POWER (display only). */
  power: number;
  /** Seasonal ladder tier — present on the season boards only. */
  seasonRank: { id: string; name: string } | null;
  appearance: { rarity: Rarity; parts: AppearanceParts; sprite?: unknown; overrides?: unknown };
  /** Profile photo, or null → the UI draws the generated class portrait. */
  avatarUrl: string | null;
  value: number;
  secondary: number;
  battles: number;
}

interface Spec {
  /** SQL fragments over alias c (characters), tu (telegram_users), ss (the ACTIVE season's season_character_stats, LEFT-joined). */
  value: string;
  secondary: string;
  battles: string;
  order: string;
  join: string;
  where: string;
}

function spec(board: BoardId): Spec {
  // Every board joins the ACTIVE season's per-hero stats ($3): the season boards rank by them, the others show a season figure beside theirs.
  const join = "left join public.season_character_stats ss on ss.character_id = c.id and ss.season_id = $3::uuid";
  const battles = "coalesce(ss.battles, 0)";
  const wins = "coalesce(ss.wins, 0)";
  switch (board) {
    case "WINS":
      return { value: wins, secondary: "coalesce(ss.top2, 0)", battles, order: `${wins} desc, coalesce(ss.top2, 0) desc, ${battles} asc, c.power desc`, join, where: `${battles} > 0` };
    case "TOP2":
      return { value: "coalesce(ss.top2, 0)", secondary: wins, battles, order: `coalesce(ss.top2, 0) desc, ${wins} desc, ${battles} asc, c.power desc`, join, where: `${battles} > 0` };
    case "KOS":
      return { value: "coalesce(ss.eliminations, 0)", secondary: wins, battles, order: `coalesce(ss.eliminations, 0) desc, ${wins} desc, ${battles} asc, c.power desc`, join, where: `${battles} > 0` };
    case "POWER":
      return { value: "c.power", secondary: wins, battles, order: `c.power desc, ${wins} desc`, join, where: "true" };
    case "COMMUNITY":
      return { value: "coalesce(tu.activity_score, 0)", secondary: "coalesce(tu.qualifying_message_count, 0)", battles, order: "coalesce(tu.activity_score, 0) desc, coalesce(tu.qualifying_message_count, 0) desc, c.power desc", join, where: "c.kind = 'COMMUNITY'" };
    case "SEASON_POINTS":
      return { value: "ss.points", secondary: "ss.wins", battles: "ss.battles", order: "ss.points desc, ss.wins desc, ss.battles asc, c.power desc", join, where: "ss.battles > 0" };
    case "SEASON_WINS":
      return { value: "ss.wins", secondary: "ss.points", battles: "ss.battles", order: "ss.wins desc, ss.points desc, ss.battles asc, c.power desc", join, where: "ss.battles > 0" };
  }
}

function seasonTier(points: number | null, tiers: readonly SeasonRankTier[] | undefined): { id: string; name: string } | null {
  if (points === null || !tiers?.length) return null;
  const { tier } = seasonRankFor(Number(points), tiers);
  return { id: tier.id, name: tier.name };
}

export async function getLeaderboard(
  q: Queryable,
  board: BoardId,
  opts: { limit?: number; offset?: number; seasonId?: string | null; allowDemo: boolean; seasonRanks?: readonly SeasonRankTier[] },
): Promise<LeaderboardRow[]> {
  const sp = spec(board);
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  if (BOARDS[board].season && !opts.seasonId) return [];
  const rows = await q.query<{
    id: string; public_id: string; name: string; class_id: string; claimed: boolean; is_demo: boolean; title: string | null; power: number; season_points: number | null;
    rarity: Rarity; parts: AppearanceParts; sprite: unknown; overrides: unknown; value: string; secondary: string; battles: number; rank: string; avatar_version: string | null;
  }>(
    `select c.id, c.public_id, coalesce(c.name_override, c.name) as name, c.class_id, (cl.character_id is not null) as claimed, c.is_demo, c.title, c.power,
            ${BOARDS[board].season ? "ss.points" : "null::int"} as season_points,
            ca.rarity, ca.parts, ca.sprite, ca.cosmetic_overrides as overrides, hp.version as avatar_version, (${sp.value})::float as value, (${sp.secondary})::float as secondary, (${sp.battles})::int as battles,
            row_number() over (order by ${sp.order}, c.created_at, c.id) as rank
       from public.characters c
       join public.character_appearances ca on ca.character_id = c.id
       left join public.character_claims cl on cl.character_id = c.id
       left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.hero_profile_photos hp on hp.character_id = c.id
       ${sp.join}
      where c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED') and (not c.is_demo or $1::boolean) and (${sp.where})
      order by rank limit $2 offset ${offset}`,
    [opts.allowDemo, limit, opts.seasonId ?? null],
  );
  return rows.map((r) => ({
    rank: Number(r.rank),
    characterId: r.id,
    publicId: r.public_id,
    name: r.name,
    classId: r.class_id,
    claimed: r.claimed,
    isDemo: r.is_demo,
    title: r.title,
    power: Number(r.power),
    seasonRank: seasonTier(r.season_points, opts.seasonRanks),
    appearance: { rarity: r.rarity, parts: r.parts, sprite: r.sprite ?? undefined, overrides: r.overrides },
    avatarUrl: avatarUrlOrNull(r.id, r.avatar_version),
    value: Number(r.value),
    secondary: Number(r.secondary),
    battles: r.battles,
  }));
}
