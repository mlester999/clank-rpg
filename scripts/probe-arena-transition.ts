/**
 * Read-only arena transition probe. It behaves like a fleet of viewers (same polling rules as the
 * browser hook) against a RUNNING server and measures the one thing players feel at a battle boundary:
 *
 *   dead time = (moment a viewer first receives the next battle) − (previous battle's slotEndsAt)
 *
 * During that window the results screen is sitting on "NEXT BATTLE IN 0 SEC". Healthy: well under a
 * second. It only issues GET /api/arena/state — safe to point at production, but be a good neighbour
 * (keep --viewers small there).
 *
 *   pnpm arena:probe -- --url http://localhost:3711 --rounds 5 --viewers 12
 */
import { bestOffset, clockSample, planNextPoll, typicalServerMs, type ClockSample, type PollState } from "../src/components/arena/pollSchedule";

interface StateDto extends PollState {
  serverTime: number;
  current: (NonNullable<PollState["current"]> & { id: string; sequence: number }) | null;
}

interface Boundary {
  viewer: number;
  fromSeq: number;
  toSeq: number;
  deadMs: number;
  fetchMs: number;
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
};

const base = arg("url", "http://localhost:3711").replace(/\/$/, "");
const rounds = Number(arg("rounds", "5"));
const viewers = Number(arg("viewers", "12"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const boundaries: Boundary[] = [];
const staleReads: Array<{ viewer: number; seq: number; afterSlotEndMs: number; nextPollMs: number }> = [];
/** Viewers whose own timer fired more than 8 s late — the probe process itself was suspended (e.g. a sleeping laptop). */
const frozenAt: number[] = [];
let stop = false;

async function viewer(id: number): Promise<void> {
  await sleep(Math.random() * 4000); // viewers arrive at random moments, like real traffic
  const samples: ClockSample[] = [];
  const dwells: number[] = [];
  let offset = 0;
  let prev: StateDto | null = null;
  let failures = 0;
  let overdueStreak = 0;
  let heldFor: number | null = null;
  let pendingHold: number | null = null;
  while (!stop) {
    const t0 = Date.now();
    const hold = pendingHold;
    pendingHold = null;
    if (hold !== null) heldFor = hold;
    let ok = false;
    let state: StateDto | null = null;
    let fetchMs = 0;
    try {
      const res = await fetch(`${base}/api/arena/state${hold === null ? "" : `?hold=${Math.round(hold)}`}`, { cache: "no-store" });
      const t1 = Date.now();
      const body = (await res.json()) as { ok: boolean; state?: StateDto };
      if (res.ok && body.ok && body.state) {
        state = body.state;
        fetchMs = t1 - t0;
        const sample = clockSample(state.serverTime, t0, t1, (state as { serverReceivedAt?: number }).serverReceivedAt);
        if (hold === null && sample.serverMs !== undefined) dwells.push(sample.serverMs);
        samples.push(sample);
        if (samples.length > 6) samples.shift();
        offset = bestOffset(samples);
        ok = true;
      }
    } catch {
      ok = false;
    }
    failures = ok ? 0 : Math.min(failures + 1, 5);
    const nowServer = Date.now() + offset;
    if (state) {
      // A response received AFTER the previous battle's slot ended that still shows the old battle is a stale read.
      if (prev?.current && state.current && prev.current.id === state.current.id && state.current.slotEndsAt !== null && nowServer > state.current.slotEndsAt + 50) {
        const recent = samples.slice(-3);
        const rttMs = recent.length ? recent.reduce((a, x) => a + x.rtt, 0) / recent.length : 120;
        staleReads.push({ viewer: id, seq: state.current.sequence, afterSlotEndMs: Math.round(nowServer - state.current.slotEndsAt), nextPollMs: planNextPoll({ state, now: nowServer, ok, failures, overdueStreak: overdueStreak + 1, rttMs, heldFor }).delayMs });
      }
      if (prev?.current && state.current && prev.current.id !== state.current.id && prev.current.slotEndsAt !== null) {
        boundaries.push({ viewer: id, fromSeq: prev.current.sequence, toSeq: state.current.sequence, deadMs: Math.round(nowServer - prev.current.slotEndsAt), fetchMs });
      }
      prev = state;
    }
    overdueStreak = ok && state?.current?.slotEndsAt != null && nowServer >= state.current.slotEndsAt ? overdueStreak + 1 : 0;
    const recent = samples.slice(-3);
    const rttMs = recent.length ? recent.reduce((a, x) => a + x.rtt, 0) / recent.length : 120;
    const plan = planNextPoll({ state, now: nowServer, ok, failures, overdueStreak, rttMs, serverMs: typicalServerMs(dwells), heldFor });
    pendingHold = plan.holdUntil;
    const slept = Date.now();
    await sleep(plan.delayMs);
    if (Date.now() - slept > plan.delayMs + 8000) frozenAt.push(slept);
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

async function main(): Promise<void> {
  console.log(`probing ${base} with ${viewers} viewers until ${rounds} battle boundaries have been crossed…`);
  const fleet = Array.from({ length: viewers }, (_, i) => viewer(i));
  const started = Date.now();
  // A boundary counts once most viewers have seen it, so wait for `rounds` distinct toSeq values.
  while (Date.now() - started < (rounds + 2) * 70_000) {
    await sleep(1000);
    const seqs = new Set(boundaries.filter((b) => b.deadMs < 600_000).map((b) => b.toSeq));
    if (seqs.size >= rounds && boundaries.filter((b) => b.toSeq === [...seqs].sort((a, c) => a - c)[rounds - 1]).length >= Math.ceil(viewers * 0.8)) break;
  }
  stop = true;
  await sleep(1500);
  void fleet;

  const bySeq = new Map<number, Boundary[]>();
  for (const b of boundaries) bySeq.set(b.toSeq, [...(bySeq.get(b.toSeq) ?? []), b]);
  console.log("\nboundary    viewers   dead-time ms (min / p50 / max)   boundary fetch ms (p50 / max)");
  const all: number[] = [];
  for (const [seq, rows] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    const dead = rows.map((r) => r.deadMs).sort((a, b) => a - b);
    const fetches = rows.map((r) => r.fetchMs).sort((a, b) => a - b);
    all.push(...dead);
    console.log(`#${seq - 1} → #${seq}`.padEnd(12) + String(rows.length).padEnd(10) + `${dead[0]} / ${percentile(dead, 50)} / ${dead[dead.length - 1]}`.padEnd(34) + `${percentile(fetches, 50)} / ${fetches[fetches.length - 1]}`);
  }
  all.sort((a, b) => a - b);
  console.log(`\nALL viewers × boundaries: n=${all.length}  p50=${percentile(all, 50)} ms  p95=${percentile(all, 95)} ms  max=${all[all.length - 1] ?? 0} ms`);
  const over1s = all.filter((d) => d > 1000).length;
  console.log(`viewers that sat on "0 SEC" for more than 1 s: ${over1s} of ${all.length}`);
  if (frozenAt.length) console.log(`NOTE: ${frozenAt.length} viewer timer(s) fired >8 s late — the probe host was suspended; rows spanning that pause are not meaningful.`);
  console.log(`stale reads (response AFTER the slot ended that still showed the old battle): ${staleReads.length}`);
  const staleBySeq = new Map<number, number[]>();
  for (const s of staleReads) staleBySeq.set(s.seq, [...(staleBySeq.get(s.seq) ?? []), s.nextPollMs]);
  for (const [seq, polls] of [...staleBySeq.entries()].sort((a, b) => a[0] - b[0])) console.log(`  after battle #${seq}: ${polls.length} stale response(s); each viewer then waited ${[...new Set(polls)].join("/")} ms before asking again`);
  process.exit(0);
}

void main();
