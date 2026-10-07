import type { ArenaPopulation } from "@/domain/lifecycleDto";

import { json, type Queryable } from "../db/types";

export type { ArenaPopulation };

/**
 * WHO MAY FIGHT. The one definition of Arena eligibility on the server — used by the scheduler, the queue planner, the Admin overview, the public
 * state, the leaderboards and the hero pages, so "eligible" can never mean two different things.
 *
 *   A hero may enter a NEW roster when it is ACTIVE (not SUSPENDED / INACTIVE), its Telegram member is not BANNED, and — only where demo heroes
 *   are allowed (local previews) — demo heroes count too.
 *
 * This is about FUTURE scheduling only. A hero that is suspended after it was committed to a battle that is already on stage, announced as the
 * upcoming battle (people may have placed Picks on it) or prepared behind it still fights that battle — a roster that has been exposed is never
 * rewritten. A suspended hero simply never enters a roster that is made afterwards; reactivating it makes it eligible for FUTURE rosters (it is
 * never injected into one that exists).
 *
 * TOTAL heroes and ARENA-ELIGIBLE heroes are different numbers (see `arenaPopulation`): a suspended hero is not missing, deleted or in need of
 * regeneration — it exists, with all its history, and is merely not fighting.
 */

/** SQL predicate over `characters` (alias `c`) and `telegram_users` (alias `tu`, LEFT JOINed). `demoParam` is a boolean parameter placeholder such as "$1". */
export function arenaEligibleSql(demoParam: string, c = "c", tu = "tu"): string {
  return `${c}.status = 'ACTIVE' and (${tu}.status is null or ${tu}.status <> 'BANNED') and (not ${c}.is_demo or ${demoParam}::boolean)`;
}

export async function eligibleHeroIds(q: Queryable, allowDemo: boolean): Promise<string[]> {
  const rows = await q.query<{ id: string }>(
    `select c.id from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where ${arenaEligibleSql("$1")} order by c.id`,
    [allowDemo],
  );
  return rows.map((r) => r.id);
}

export async function countEligibleHeroes(q: Queryable, allowDemo: boolean): Promise<number> {
  const [row] = await q.query<{ n: number }>(
    `select count(*)::int as n from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id where ${arenaEligibleSql("$1")}`,
    [allowDemo],
  );
  return row?.n ?? 0;
}

export async function arenaPopulation(q: Queryable, allowDemo: boolean): Promise<ArenaPopulation> {
  const [row] = await q.query<{ total: number; eligible: number; suspended: number; inactive: number; banned_member: number }>(
    `select count(*)::int as total,
            (count(*) filter (where ${arenaEligibleSql("$1")}))::int as eligible,
            (count(*) filter (where c.status = 'SUSPENDED'))::int as suspended,
            (count(*) filter (where c.status = 'INACTIVE'))::int as inactive,
            (count(*) filter (where c.status = 'ACTIVE' and tu.status = 'BANNED'))::int as banned_member
       from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where (not c.is_demo or $1::boolean)`,
    [allowDemo],
  );
  return { total: row?.total ?? 0, eligible: row?.eligible ?? 0, suspended: row?.suspended ?? 0, inactive: row?.inactive ?? 0, bannedMember: row?.banned_member ?? 0 };
}

/**
 * Holds the rows that decide eligibility of `characterIds` until the surrounding transaction ends, so a suspension / ban cannot commit between
 * "checked" and "written": it waits for the scheduling transaction (and then only affects LATER rosters), or it committed first and the check
 * that follows sees it. Order is fixed — members first (a ban holds the member row, then updates the hero), then heroes, each in id order — so
 * the scheduler can never deadlock with an admin action or with another scheduler.
 */
export async function lockForRoster(tx: Queryable, characterIds: readonly string[]): Promise<void> {
  if (characterIds.length === 0) return;
  const ids = json([...new Set(characterIds)].sort());
  await tx.query(
    `select tu.telegram_user_id from public.telegram_users tu
      where tu.telegram_user_id in (select c.telegram_user_id from public.characters c where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid))
      order by tu.telegram_user_id for key share`,
    [ids],
  );
  await tx.query("select c.id from public.characters c where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) order by c.id for share", [ids]);
}

/** Which of `characterIds` are eligible RIGHT NOW. Call it AFTER `lockForRoster` (its statement then sees every committed suspension). */
export async function verifyEligible(tx: Queryable, characterIds: readonly string[], allowDemo: boolean): Promise<Set<string>> {
  if (characterIds.length === 0) return new Set();
  const rows = await tx.query<{ id: string }>(
    `select c.id from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id
      where c.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) and ${arenaEligibleSql("$2")}`,
    [json([...new Set(characterIds)]), allowDemo],
  );
  return new Set(rows.map((r) => r.id));
}
