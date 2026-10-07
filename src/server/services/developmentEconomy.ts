import { ARENA_ACHIEVEMENT_METRICS } from "@/domain/content/achievements";

import type { Queryable } from "../db/types";

/**
 * DEVELOPMENT PROGRESS DOES NOT CARRY INTO SEASON 1.
 *
 * What a hero did while the game was in DEVELOPMENT — its arena achievements, the Clank Gold it earned, the loot it was dropped — is test data. At the
 * Season 1 launch this step (run INSIDE the launch transaction, after the development season is archived) puts every one of those systems back to a clean
 * start, **without touching the hero** (identity, class, rarity, stats, PWR, look, versions, moderation) and **without deleting any history**:
 *
 *   · ACHIEVEMENTS  an unlock earned from ARENA metrics (battles / wins / top-2 / KOs) is archived (`archived_at`): not counted, not shown, no longer blocking —
 *                   so it is earned again, officially, from Season 1's own record. Permanent ones stay: community / chain metrics (Telegram activity, holding
 *                   streaks, bonded coins) come from real members, not from test battles, and an achievement an admin granted is the admin's decision.
 *                   A title that exists only because an archived achievement granted it is cleared (a title an admin typed is kept).
 *   · CLANK GOLD    every positive balance gets ONE offsetting ledger entry (`season_launch_reset`): the append-only ledger stays complete and reconciled,
 *                   the balance is 0, and Season 1 Gold is exactly what is earned after the launch.
 *   · LOOT          every item in an inventory is archived and unequipped (`archived_at`): it stays inspectable, is not in the inventory, cannot be
 *                   equipped and adds nothing to combat stats. (Equipped development gear would otherwise be a Season 1 advantage.)
 *   · CAREER COUNTERS  the lifetime arena counters on the hero row are zeroed — the development totals live on in the development season's own
 *                   per-hero stats (`season_character_stats`), which settlement maintains next to them; nothing reads them for a public record or an achievement.
 *                   (`last_arena_at` — the admin "last activity" stamp — is a fact about the hero, not progression, and is kept.)
 *
 * It never touches real-value records (reward ledger, claims, prizes): the launch refuses before it gets here if any of those exist.
 */
export interface DevelopmentEconomyArchive {
  goldAccountsReset: number;
  goldReset: string;
  lootArchived: number;
  lootUnequipped: number;
  achievementsArchived: number;
  achievementHeroes: number;
  titlesCleared: number;
  careerCountersReset: number;
}

export async function archiveDevelopmentEconomy(tx: Queryable, input: { launchSeasonId: string; developmentSeasonId: string | null }): Promise<DevelopmentEconomyArchive> {
  // ── Clank Gold: one offsetting entry per account that holds a balance (the ledger trigger keeps balance and audit consistent) ──────────────────────────
  const gold = await tx.query<{ character_id: string; delta: string }>(
    `insert into public.currency_ledger (character_id, delta, reason, ref_type, ref_id, idempotency_key)
     select a.character_id, -a.balance, 'season_launch_reset', 'season', $1, 'season-launch-reset:' || $1 || ':' || a.character_id::text
       from public.currency_accounts a where a.balance > 0 order by a.character_id
     returning character_id, delta::text`,
    [input.launchSeasonId],
  );
  const goldReset = gold.reduce((n, r) => n + -BigInt(r.delta), 0n);

  // ── Loot: archived + unequipped (equipped development gear would be a combat advantage) ───────────────────────────────────────────────────────────────
  const loot = await tx.query<{ equipped: boolean }>(
    `with archived as (select i.id, i.equipped from public.inventory_items i where i.archived_at is null for update),
          done as (update public.inventory_items i set equipped = false, archived_at = now(), archived_season_id = $1
                     from archived a where a.id = i.id returning a.equipped)
     select equipped from done`,
    [input.developmentSeasonId],
  );

  // ── Achievements earned from development ARENA activity (never admin grants, never community / chain metrics) ─────────────────────────────────────────
  const achievements = await tx.query<{ character_id: string; title: string | null }>(
    `update public.character_achievements ca set archived_at = now()
       from public.achievements a
      where a.id = ca.achievement_id and ca.archived_at is null
        and a.criteria->>'metric' = any($1::text[])
        and coalesce(ca.context->>'granted', '') <> 'admin'
        and (ca.season_id is null or ca.season_id in (select s.id from public.seasons s where s.kind = 'DEVELOPMENT'))
      returning ca.character_id, a.reward->>'title' as title`,
    [`{${ARENA_ACHIEVEMENT_METRICS.join(",")}}`],
  );
  let titlesCleared = 0;
  for (const row of achievements) {
    if (!row.title) continue;
    const cleared = await tx.query("update public.characters set title = null where id = $1 and title = $2 returning id", [row.character_id, row.title]);
    titlesCleared += cleared.length;
  }

  // ── Career counters (the development totals stay in the development season's own stats rows) ─────────────────────────────────────────────────────────
  const counters = await tx.query(
    `update public.characters set arena_battles = 0, arena_wins = 0, arena_top2 = 0, arena_eliminations = 0, arena_damage = 0
      where arena_battles <> 0 or arena_wins <> 0 or arena_top2 <> 0 or arena_eliminations <> 0 or arena_damage <> 0 returning id`,
  );

  return {
    goldAccountsReset: gold.length,
    goldReset: goldReset.toString(),
    lootArchived: loot.length,
    lootUnequipped: loot.filter((l) => l.equipped).length,
    achievementsArchived: achievements.length,
    achievementHeroes: new Set(achievements.map((a) => a.character_id)).size,
    titlesCleared,
    careerCountersReset: counters.length,
  };
}
