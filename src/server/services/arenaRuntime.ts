import type { Queryable } from "../db/types";

/**
 * What is still "in the Arena's hands" at `nowMs` — the thing a PAUSE has to wait for.
 *
 *   · `unsettled`  battles that are committed but not settled: on stage and still fighting, announced as the upcoming battle (people may have
 *                  picked on it), or prepared behind it. Their rosters are frozen and are never cancelled by a pause.
 *   · `onScreen`   1 while the LAST settled battle's own slot (fight → victory → results) is still being shown to viewers. A battle settles the moment
 *                  its fight is decided, a few seconds BEFORE its results screen ends, so "nothing unsettled" is not yet a safe place to stop: the
 *                  Arena is PAUSED only once the screen the viewers are watching has finished.
 *
 * Both the pause action (immediate PAUSED vs PAUSE_REQUESTED) and the Arena step (when PAUSE_REQUESTED completes) use this one definition.
 */
export interface CommittedBattles {
  unsettled: number;
  onScreen: number;
  /** When the battle still on screen ends its slot (epoch ms), or null. */
  screenEndsAt: number | null;
  /** `unsettled + onScreen`: zero means the Arena can be paused (or archived) right now. */
  total: number;
}

export async function committedBattles(q: Queryable, nowMs: number): Promise<CommittedBattles> {
  const [row] = await q.query<{ unsettled: number; slot_ends_at: Date | null }>(
    `select (select count(*)::int from public.arena_battles where status in ('SCHEDULED', 'SIMULATED')) as unsettled,
            (select b.slot_ends_at from public.arena_battles b where b.status = 'SETTLED' order by b.sequence desc limit 1) as slot_ends_at`,
  );
  const unsettled = row?.unsettled ?? 0;
  const endsAt = row?.slot_ends_at ? new Date(row.slot_ends_at).getTime() : null;
  const onScreen = endsAt !== null && endsAt > nowMs ? 1 : 0;
  return { unsettled, onScreen, screenEndsAt: onScreen ? endsAt : null, total: unsettled + onScreen };
}
