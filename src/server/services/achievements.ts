import { isRetiredAchievement, type AchievementCriteria, type AchievementReward } from "@/domain/content/achievements";
import { applyLedger } from "./economy";
import { json, type Queryable } from "../db/types";

interface AchievementRow {
  id: string;
  criteria: AchievementCriteria;
  reward: AchievementReward;
}

/**
 * Pays an unlock's one-off Clank Gold. The idempotency key names the UNLOCK ROW (`character_achievements.id`), so a replay, a retry or the one-off backfill in
 * migration 20261015002900 (which uses the very same key) can never pay the same unlock twice. A reward without Gold pays nothing.
 */
async function payUnlockGold(q: Queryable, characterId: string, achievementId: string, unlockId: string, reward: AchievementReward): Promise<void> {
  if (!reward.gold || reward.gold <= 0) return;
  await applyLedger(q, { characterId, amount: reward.gold, reason: "achievement", refType: "achievement", refId: achievementId, idempotencyKey: `achv:${characterId}:${achievementId}:${unlockId}` });
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
    // The title is NOT put on the hero automatically: it joins the member's collection, and they choose which one to show (`setDisplayTitle`).
    await payUnlockGold(q, characterId, def.id, inserted[0]!.id, def.reward);
  }
  return unlocked;
}

/** Admin-granted achievement (OG Clanker, Seasonal Champion, …). Pays the achievement's Gold like any other unlock. */
export async function grantAchievement(q: Queryable, characterId: string, achievementId: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    `insert into public.character_achievements (character_id, achievement_id, context) values ($1, $2, '{"granted":"admin"}'::jsonb)
     on conflict do nothing returning id`,
    [characterId, achievementId],
  );
  const unlock = rows[0];
  if (!unlock) return false;
  const [def] = await q.query<{ reward: AchievementReward }>("select reward from public.achievements where id = $1", [achievementId]);
  if (def) await payUnlockGold(q, characterId, achievementId, unlock.id, def.reward);
  return true;
}

export type DisplayTitleResult =
  | { ok: true; title: string | null }
  | { ok: false; reason: "NOT_FOUND" | "NOT_CLAIMED" | "NOT_UNLOCKED" | "NO_TITLE" };

/**
 * Chooses the ONE title shown above the hero's name (the Arena's name plate, the Current Round list, the results and the hero page). `achievementId` names an
 * achievement the hero has UNLOCKED (an archived unlock — one from the development run — no longer counts) and the title is read from that achievement's own
 * reward, never from the request. `null` removes the title. Only the claimed owner manages it, like every other piece of hero management.
 *
 * `characters.title` stays the single place the title lives (every read path and the Season 1 reset already use it); which achievement it came from is
 * simply the achievement whose reward carries that text.
 */
export async function setDisplayTitle(q: Queryable, characterId: string, achievementId: string | null): Promise<DisplayTitleResult> {
  const [hero] = await q.query<{ claimed: boolean }>(
    "select (cl.character_id is not null) as claimed from public.characters c left join public.character_claims cl on cl.character_id = c.id where c.id = $1 for update of c",
    [characterId],
  );
  if (!hero) return { ok: false, reason: "NOT_FOUND" };
  if (!hero.claimed) return { ok: false, reason: "NOT_CLAIMED" };
  if (achievementId === null) {
    await q.query("update public.characters set title = null where id = $1", [characterId]);
    return { ok: true, title: null };
  }
  const [row] = await q.query<{ title: string | null }>(
    `select a.reward->>'title' as title from public.achievements a
      where a.id = $2 and a.enabled and exists (select 1 from public.character_achievements ca where ca.character_id = $1 and ca.achievement_id = a.id and ca.archived_at is null)`,
    [characterId, achievementId],
  );
  if (!row) return { ok: false, reason: "NOT_UNLOCKED" };
  const title = row.title?.trim();
  if (!title) return { ok: false, reason: "NO_TITLE" };
  await q.query("update public.characters set title = $2 where id = $1", [characterId, title]);
  return { ok: true, title };
}
