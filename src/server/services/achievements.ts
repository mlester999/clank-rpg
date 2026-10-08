import { isRetiredAchievement, type AchievementCriteria } from "@/domain/content/achievements";
import { applyLedger } from "./economy";
import { json, type Queryable } from "../db/types";

interface AchievementRow {
  id: string;
  criteria: AchievementCriteria;
  reward: { badge: string; title?: string; gold?: number };
}

export interface Metrics {
  battles: number;
  wins: number;
  top2: number;
  eliminations: number;
  telegram_qualifying: number;
  telegram_active_days: number;
  diamond_days: number;
  bonded_tokens_held: number;
}

/**
 * `atMs`: the instant the metrics are evaluated at — the caller's clock (the holdings sync passes the `now` it measured the streaks with, so the
 * two can never disagree). Omitted: the database clock, as before.
 */
export async function loadMetrics(q: Queryable, characterId: string, atMs?: number): Promise<Metrics | null> {
  const rows = await q.query<{
    battles: number; wins: number; top2: number; eliminations: number;
    qualifying: number | null; active_days: number | null; diamond_days: number | null; bonded: number;
  }>(
    // The ARENA metrics are the hero's record in the ACTIVE season (zero while no season is active) — development battles can never pre-complete an official
    // achievement, and a new season starts the counting again. The community / chain metrics are permanent facts and are read as they are.
    `select coalesce(ss.battles, 0) as battles, coalesce(ss.wins, 0) as wins, coalesce(ss.top2, 0) as top2, coalesce(ss.eliminations, 0) as eliminations,
            tu.qualifying_message_count as qualifying, tu.active_days,
            (select coalesce(max(floor(extract(epoch from (coalesce($2::timestamptz, now()) - s.started_at)) / 86400))::int, 0)
               from public.holding_streaks s where s.character_id = c.id and s.ended_at is null) as diamond_days,
            (select count(*)::int from public.token_holdings h join public.eligible_tokens t on t.id = h.token_id
              where h.character_id = c.id and h.balance > 0 and t.status = 'ELIGIBLE') as bonded
       from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
       left join public.season_character_stats ss on ss.character_id = c.id and ss.season_id = (select id from public.seasons where status = 'ACTIVE' limit 1)
      where c.id = $1`,
    [characterId, atMs === undefined ? null : new Date(atMs).toISOString()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    battles: r.battles,
    wins: r.wins,
    top2: r.top2,
    eliminations: r.eliminations,
    telegram_qualifying: r.qualifying ?? 0,
    telegram_active_days: r.active_days ?? 0,
    diamond_days: r.diamond_days ?? 0,
    bonded_tokens_held: r.bonded,
  };
}

/** Unlocks every metric-based achievement the hero now satisfies. Idempotent. Returns new ids. */
export async function evaluateAchievements(q: Queryable, characterId: string, atMs?: number): Promise<string[]> {
  const metrics = await loadMetrics(q, characterId, atMs);
  if (!metrics) return [];
  const defs = await q.query<AchievementRow>(
    `select id, criteria, reward from public.achievements a
      where enabled and not exists (select 1 from public.character_achievements ca where ca.character_id = $1 and ca.achievement_id = a.id and ca.archived_at is null)`,
    [characterId],
  );
  const unlocked: string[] = [];
  for (const def of defs) {
    const c = def.criteria;
    if (!("metric" in c)) continue; // manual / locked achievements are never auto-earned
    if (isRetiredAchievement(c)) continue; // e.g. the old level achievements: never awarded again
    if ((metrics[c.metric] ?? 0) < c.gte) continue;
    const inserted = await q.query<{ id: string }>(
      `insert into public.character_achievements (character_id, achievement_id, context) values ($1, $2, $3::jsonb)
       on conflict do nothing returning id`,
      [characterId, def.id, json({ metric: c.metric, value: metrics[c.metric] })],
    );
    if (inserted.length === 0) continue;
    unlocked.push(def.id);
    if (def.reward.title) {
      await q.query("update public.characters set title = coalesce(title, $2) where id = $1", [characterId, def.reward.title]);
    }
    if (def.reward.gold && def.reward.gold > 0) {
      await applyLedger(q, { characterId, amount: def.reward.gold, reason: "achievement", refType: "achievement", refId: def.id, idempotencyKey: `achv:${characterId}:${def.id}:${inserted[0]!.id}` });
    }
  }
  return unlocked;
}

/** Admin-granted achievement (OG Clanker, Seasonal Champion, …). */
export async function grantAchievement(q: Queryable, characterId: string, achievementId: string): Promise<boolean> {
  const rows = await q.query(
    `insert into public.character_achievements (character_id, achievement_id, context) values ($1, $2, '{"granted":"admin"}'::jsonb)
     on conflict do nothing returning achievement_id`,
    [characterId, achievementId],
  );
  return rows.length > 0;
}
