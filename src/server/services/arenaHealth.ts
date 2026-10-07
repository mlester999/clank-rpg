import type { Queryable } from "../db/types";

/**
 * Is the Arena being advanced? With ARENA_VIEWER_ADVANCE=off nothing but the worker (or the scheduler tick) moves it, so "the worker died" has to be visible
 * from outside. Read-only, one statement, no schema: how long ago something that was DUE should have happened and has not.
 *
 *   settleOverdueMs — a battle whose combat has ended is still unsettled (the worker settles within about a second of the end)
 *   queueDryMs      — a RUNNING Arena whose last prepared battle's slot ended already: no battle covers "now" (the worker prepares the next one ahead of time)
 *
 * `stalled` = either has been true for more than `thresholdMs`. A stopped Arena (NOT_STARTED / PAUSED) is never stalled — nothing is due.
 */
export interface ArenaHealth {
  status: string;
  settleOverdueMs: number;
  queueDryMs: number;
  stalled: boolean;
}

export async function arenaHealth(q: Queryable, nowMs: number, thresholdMs = 30_000): Promise<ArenaHealth> {
  const [row] = await q.query<{ status: string; settle_overdue_ms: number | string | null; queue_dry_ms: number | string | null }>(
    `select a.status,
            (select floor(extract(epoch from ($1::timestamptz - min(b.combat_ends_at))) * 1000)::bigint
               from public.arena_battles b where b.status = 'SIMULATED' and b.combat_ends_at < $1::timestamptz) as settle_overdue_ms,
            (select floor(extract(epoch from ($1::timestamptz - max(b.slot_ends_at))) * 1000)::bigint
               from public.arena_battles b where b.status in ('SCHEDULED', 'SIMULATED', 'SETTLED')
              having max(b.slot_ends_at) < $1::timestamptz) as queue_dry_ms
       from public.arena_state a where a.id = 1`,
    [new Date(nowMs).toISOString()],
  );
  const status = row?.status ?? "UNKNOWN";
  const running = status === "RUNNING" || status === "PAUSE_REQUESTED" || status === "PREPARING";
  const settleOverdueMs = running ? Math.max(0, Number(row?.settle_overdue_ms ?? 0)) : 0;
  const queueDryMs = status === "RUNNING" ? Math.max(0, Number(row?.queue_dry_ms ?? 0)) : 0;
  return { status, settleOverdueMs, queueDryMs, stalled: settleOverdueMs > thresholdMs || queueDryMs > thresholdMs };
}
