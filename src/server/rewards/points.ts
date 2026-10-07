import { periodWindow } from "@/domain/rewards/time";

import type { Queryable } from "../db/types";

/**
 * POINTS — off-chain, non-transferable, not cryptocurrency, not withdrawable, server-authoritative.
 *
 *  · LEADERBOARD points (`today`, `weekly`): EVERY valid correct pick adds `pointsPerCorrectPick` (`arena_pick_scores`) — there is no
 *    daily cap, so the boards are a race for the most correct picks. `today` is the DAILY board's score, `weekly` the WEEKLY
 *    board's; each resets by period identifier (00:00 UTC / Monday 00:00 UTC) — lifetime records are never touched.
 *  · LIFETIME Clank Points: every valid correct pick earns `pointsPerCorrectPick`, unlimited, never reset, never multiplied by
 *    holdings (the append-only `arena_points_ledger`, one row per pick). Separate from the leaderboards.
 */
export interface PointsSummary {
  /** The running DAILY / WEEKLY period (UTC dates) and when each ends (server time, ms). */
  dayStart: string;
  dayEndsAt: number;
  weekStart: string;
  weekEndsAt: number;
  /** Today's leaderboard score (the Daily board ranks this). */
  today: number;
  /** This week's leaderboard score (the Weekly board ranks this). */
  weekly: number;
  /** Every correct pick ever (unlimited, never reset). */
  lifetime: number;
}

export async function getPointsSummary(q: Queryable, userId: number, nowMs: number): Promise<PointsSummary> {
  const day = periodWindow("DAILY", nowMs);
  const week = periodWindow("WEEKLY", nowMs);
  // Points earned in an ARCHIVED development run were test points: they never count (public.season_counts). Manual adjustments carry no season and always count.
  const [life] = await q.query<{ lifetime: number }>(
    "select coalesce(sum(points), 0)::int as lifetime from public.arena_points_ledger where telegram_user_id = $1 and (season_id is null or public.season_counts(season_id))",
    [userId],
  );
  const [s] = await q.query<{ today: number; weekly: number }>(
    `select coalesce(sum(points) filter (where utc_date = $2::date), 0)::int as today, coalesce(sum(points) filter (where week_start = $3::date), 0)::int as weekly
       from public.arena_pick_scores where telegram_user_id = $1 and week_start = $3::date and season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)`,
    [userId, day.start, week.start],
  );
  return { dayStart: day.start, dayEndsAt: day.endsAt, weekStart: week.start, weekEndsAt: week.endsAt, today: Number(s?.today ?? 0), weekly: Number(s?.weekly ?? 0), lifetime: Number(life?.lifetime ?? 0) };
}
