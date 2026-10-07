"use client";

import { Card } from "./adminUi";

// =========================================================================================== Arena operations
export interface ArenaOpsData {
  now: number;
  paused: boolean;
  status: "NOT_STARTED" | "PREPARING" | "RUNNING" | "PAUSE_REQUESTED" | "PAUSED";
  phase: "DEVELOPMENT" | "LIVE";
  worker: { status: "HEALTHY" | "STALE" | "IDLE" | "PAUSED" | "NOT_STARTED"; lastAdvanceAt: number | null; ageMs: number | null };
  season: { kind: "DEVELOPMENT" | "COMPETITIVE"; number: number | null; name: string; label: string } | null;
  eligibleHeroes: number;
  groupSize: number;
  cycle: { number: number; heroCount: number; carriedIn: number; fought: number; remaining: number; skipped: number; inBattle: number; battlesDone: number; startedAt: number } | null;
  queuedGroups: Array<{ index: number; heroes: string[] }>;
  current: { id: string; sequence: number; number: number; status: string; startsAt: number; combatStartsAt: number | null; combatEndsAt: number | null; slotEndsAt: number | null } | null;
  next: { id: string; sequence: number; number: number; status: string; startsAt: number } | null;
  nextTransition: { at: number; what: string } | null;
  integrity: Array<{ check: string; ok: boolean; detail: string }>;
  alerts: Array<{ severity: "critical" | "warning" | "info"; type: string; detail: string }>;
}

const tone = { critical: "border-danger/40 bg-danger/10 text-danger", warning: "border-clank-400/40 bg-clank-500/10 text-clank-300", info: "border-white/10 bg-white/[0.04] text-steel-300" } as const;
const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString() : "–");

export function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-white/5 p-3">
      <p className="label">{label}</p>
      <p className="mt-1 font-display text-lg text-paper tnum">{value}</p>
      {sub && <p className="text-[0.68rem] text-steel-400">{sub}</p>}
    </div>
  );
}

/** Everything the public pages deliberately do NOT show: cycle, queue, groups, worker, timing, integrity, alerts. */
export function ArenaOpsPanel({ ops }: { ops: ArenaOpsData }) {
  const c = ops.cycle;
  return (
    <>
      <Card title="Operations (admin only — never shown to players)">
        {ops.alerts.length === 0 ? (
          <p className="mb-3 rounded-md border border-teal/30 bg-teal/10 px-3 py-2 text-sm text-teal">No alerts: worker healthy, queue consistent.</p>
        ) : (
          <ul className="mb-3 space-y-1.5" aria-label="Arena alerts">
            {ops.alerts.map((a, i) => (
              <li key={i} className={`rounded-md border px-3 py-1.5 text-sm ${tone[a.severity]}`}><b>{a.type.replaceAll("_", " ")}</b> — {a.detail}</li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Worker" value={ops.worker.status} sub={ops.worker.ageMs !== null ? `last settle ${Math.round(ops.worker.ageMs / 1000)} s ago` : "nothing settled yet"} />
          <Stat label="Season" value={ops.season ? ops.season.label : "none"} sub={`${ops.phase === "LIVE" ? "LIVE" : "DEVELOPMENT"} · Arena ${ops.status.replaceAll("_", " ").toLowerCase()}`} />
          <Stat label="Eligible heroes" value={ops.eligibleHeroes.toLocaleString()} sub={`group size ${ops.groupSize}`} />
          <Stat label="Next transition" value={time(ops.nextTransition?.at)} sub={ops.nextTransition?.what} />
          <Stat label="Active cycle" value={c ? `#${c.number}` : "none"} sub={c ? `${c.heroCount.toLocaleString()} heroes · ${c.carriedIn} carried in` : undefined} />
          <Stat label="Fought" value={c ? c.fought.toLocaleString() : "–"} sub={c ? `${c.battlesDone} battles settled` : undefined} />
          <Stat label="Remaining" value={c ? c.remaining.toLocaleString() : "–"} sub={c ? `${c.inBattle} on stage / lined up · ${c.skipped} skipped` : undefined} />
          <Stat label="Current battle" value={ops.current ? `#${ops.current.number}` : "–"} sub={ops.current ? `${ops.current.status} · slot ends ${time(ops.current.slotEndsAt)}` : undefined} />
        </div>
        <p className="mt-3 text-sm text-steel-300">
          Next scheduled battle: {ops.next ? <b className="text-paper">#{ops.next.number} ({ops.next.status}) at {time(ops.next.startsAt)}</b> : "none yet"}
        </p>
      </Card>
      <Card title={`Queued groups (next ${ops.queuedGroups.length})`}>
        {ops.queuedGroups.length === 0 ? <p className="text-sm text-steel-400">No full group is waiting in the queue.</p> : (
          <ol className="space-y-1.5 text-sm">
            {ops.queuedGroups.map((g) => <li key={g.index}><b className="text-clank-300">Group {g.index}:</b> <span className="text-steel-300">{g.heroes.join(", ")}</span></li>)}
          </ol>
        )}
      </Card>
      <Card title="Queue integrity">
        <ul className="space-y-1 text-sm">
          {ops.integrity.map((i) => <li key={i.check} className="flex items-baseline justify-between gap-3"><span className="text-steel-300">{i.check}</span><span className={`text-xs font-bold ${i.ok ? "text-teal" : "text-danger"}`}>{i.ok ? "OK" : i.detail}</span></li>)}
        </ul>
      </Card>
    </>
  );
}

