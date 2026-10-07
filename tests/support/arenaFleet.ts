import { appendFileSync } from "node:fs";

import { expect } from "vitest";

import { bestOffset, clockSample, planNextPoll, typicalServerMs, type ClockSample } from "@/components/arena/pollSchedule";
import { MAX_HOLD_MS } from "@/domain/arena/boundary";
import { DEFAULT_SETTINGS, type ArenaSettings } from "@/domain/settings";
import { saveSetting } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { resetEnvCache } from "@/server/env";
import { resetRuntimeCaches } from "@/server/runtime";
import type { ArenaStateDto } from "@/server/services/views";

import { createTestDb, seedHeroes, withLatency } from "./db";

/**
 * Real-time harness for the battle seam: a fleet of viewers running the BROWSER's polling plan against the real
 * `/api/arena/state` handler, over a database that costs a fixed time per statement (a hosted Postgres seen from a
 * serverless function). The slot is shrunk so several boundaries fit in a test.
 *
 * Set ARENA_FLEET_LOG=<file> to append one JSON line per run (p50 / max dead time, longest held request) — used to
 * compare repeated runs without turning assertions into guesses.
 */

const ORIGIN = "http://localhost:3700";
const ENV = { NODE_ENV: "test", SESSION_SECRET: "x".repeat(40), CLANK_DEV_LOGIN: "true", NEXT_PUBLIC_APP_URL: ORIGIN };

export interface BoundaryEnv {
  GET: (req: Request) => Promise<Response>;
  /** The database WITHOUT the simulated network (for end-of-run integrity checks). */
  raw: Db;
  /** Per-statement "network" time; may be changed while running. */
  net: { ms: number };
  close(): Promise<void>;
}

export async function startBoundaryEnv(opts: { latencyMs: number; arena: Partial<ArenaSettings>; heroes?: number }): Promise<BoundaryEnv> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  delete process.env.DATABASE_URL;
  resetEnvCache();
  const raw = await createTestDb();
  await seedHeroes(raw, opts.heroes ?? 24); // seeding at full speed; the "network" is switched on afterwards
  await saveSetting(raw, "arena", { ...DEFAULT_SETTINGS.arena, ...opts.arena }, "test");
  const net = { ms: opts.latencyMs };
  const db = withLatency(raw, net);
  (globalThis as unknown as { __clankDb: { promise: Promise<Db> } }).__clankDb = { promise: Promise.resolve(db) };
  resetRuntimeCaches();
  const GET = ((await import("@/app/api/arena/state/route")) as unknown as { GET: (req: Request) => Promise<Response> }).GET;
  return {
    GET,
    raw,
    net,
    async close() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
      await db.close();
    },
  };
}

export interface Seen {
  viewer: number;
  id: string;
  sequence: number;
  deadMs: number;
  roster: string;
  /** Was the battle that just ended already settled in the snapshot the viewer received? */
  prevSettled: boolean;
  /** What the Arena Picks panel showed BEFORE the boundary (the upcoming battle) and what it shows in the very first snapshot AFTER it. */
  prevUpcomingId: string | null;
  upcomingId: string | null;
  upcomingFighters: number;
  upcomingStatus: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One viewer: exactly the browser hook's loop (useArena), against the route handler instead of fetch. */
async function viewer(env: BoundaryEnv, id: number, boundariesWanted: number, seen: Seen[], heldHits: { n: number }, held: number[], early: number[]): Promise<void> {
  const samples: ClockSample[] = [];
  const dwells: number[] = [];
  let offset = 0;
  let prev: ArenaStateDto | null = null;
  let overdueStreak = 0;
  let heldFor: number | null = null;
  let pendingHold: number | null = null;
  let boundaries = 0;
  await sleep(id * 137); // staggered arrival
  while (boundaries < boundariesWanted) {
    const hold = pendingHold;
    pendingHold = null;
    if (hold !== null) heldFor = hold;
    const t0 = Date.now();
    const res = await env.GET(new Request(`${ORIGIN}/api/arena/state${hold === null ? "" : `?hold=${Math.round(hold)}`}`));
    const t1 = Date.now();
    const state = ((await res.json()) as { state: ArenaStateDto }).state;
    const sample = clockSample(state.serverTime, t0, t1, state.serverReceivedAt);
    samples.push(sample);
    offset = bestOffset(samples.slice(-6));
    if (hold === null && sample.serverMs !== undefined) dwells.push(sample.serverMs);
    if (hold !== null) held.push(t1 - t0);
    if (hold !== null && t1 - t0 > 50) heldHits.n++;
    const now = Date.now() + offset;
    // A held answer is only ever sent AT the boundary: how many ms BEFORE it did this one arrive (by the viewer's clock)?
    if (hold !== null && state.current?.startsAt === hold) early.push(hold - now);
    if (prev?.current && state.current && prev.current.id !== state.current.id) {
      boundaries++;
      const ended = prev.current.id;
      seen.push({
        viewer: id,
        id: state.current.id,
        sequence: state.current.sequence,
        deadMs: now - prev.current.slotEndsAt!,
        roster: state.current.fighters.map((f) => f.characterId).join(","),
        prevSettled: state.recent.some((r) => r.id === ended),
        prevUpcomingId: prev.upcoming?.id ?? null,
        upcomingId: state.upcoming?.id ?? null,
        upcomingFighters: state.upcoming?.fighters.length ?? 0,
        upcomingStatus: state.upcoming?.picks.status ?? null,
      });
    }
    prev = state;
    overdueStreak = state.current?.slotEndsAt != null && now >= state.current.slotEndsAt ? overdueStreak + 1 : 0;
    const recent = samples.slice(-3);
    const rttMs = recent.length ? recent.reduce((a, x) => a + x.rtt, 0) / recent.length : 120;
    const plan = planNextPoll({ state, now, ok: true, failures: 0, overdueStreak, rttMs, serverMs: typicalServerMs(dwells), heldFor });
    pendingHold = plan.holdUntil;
    await sleep(plan.delayMs);
  }
}

/** Runs a fleet and checks everything that must hold at EVERY boundary, however slow the database is. */
export async function runFleet(env: BoundaryEnv, viewers: number, boundaries: number) {
  const seen: Seen[] = [];
  const heldHits = { n: 0 };
  const held: number[] = [];
  const early: number[] = [];
  await Promise.all(Array.from({ length: viewers }, (_, i) => viewer(env, i, boundaries, seen, heldHits, held, early)));

  expect(seen).toHaveLength(viewers * boundaries);
  const dead = seen.map((s) => s.deadMs).sort((a, b) => a - b);
  const p50 = dead[Math.floor(dead.length / 2)]!;
  if (process.env.ARENA_FLEET_LOG) {
    appendFileSync(process.env.ARENA_FLEET_LOG, `${JSON.stringify({ n: dead.length, p50: Math.round(p50), max: Math.round(dead[dead.length - 1]!), longestHeldMs: Math.round(Math.max(...held)), heldRequests: held.length })}\n`);
  }
  // Healthy operation is effectively immediate. (Generous bounds for loaded CI machines; the old code was 7000+ ms.)
  expect(p50).toBeLessThan(250);
  expect(dead[dead.length - 1]!).toBeLessThan(800);
  expect(heldHits.n).toBeGreaterThan(0); // the held-request path really was exercised
  // A held request is parked for at most MAX_HOLD_MS (plus the server's own work) — never an unbounded wait.
  expect(Math.max(...held)).toBeLessThan(MAX_HOLD_MS + 600);

  // Nothing is revealed early: no held answer carrying the NEXT battle arrived before its start (25 ms = clock-estimate slack).
  expect(early.length).toBeGreaterThan(0);
  expect(Math.max(...early)).toBeLessThanOrEqual(25);

  // The books are clean: contiguous sequences, back-to-back slots, no duplicate scheduling, at most one battle queued ahead.
  const books = await env.raw.query<{ sequence: number; status: string; starts_at: Date; slot_ends_at: Date | null }>("select sequence, status, starts_at, slot_ends_at from public.arena_battles order by sequence");
  expect(books.map((b) => Number(b.sequence))).toEqual(books.map((_, i) => Number(books[0]!.sequence) + i));
  expect(new Set(books.map((b) => new Date(b.starts_at).getTime())).size).toBe(books.length);
  for (let i = 1; i < books.length; i++) expect(new Date(books[i]!.starts_at).getTime()).toBe(new Date(books[i - 1]!.slot_ends_at as Date).getTime());
  expect(books.filter((b) => b.status === "SCHEDULED").length).toBeLessThanOrEqual(1);
  expect(books.filter((b) => b.status === "SIMULATED").length).toBeLessThanOrEqual(4); // the one on stage + the one still settling + the two prepared ahead
  expect(await env.raw.query("select 1 from public.arena_participants group by battle_id, character_id having count(*) > 1")).toHaveLength(0);

  // THE PICKS PANEL AT EVERY BOUNDARY: the battle it listed before the boundary IS the battle now on stage, and the very first snapshot
  // after it already carries the NEXT battle's final eight, OPEN — never an empty panel, never the battle that just started.
  for (const s of seen) {
    expect(s.prevUpcomingId, "the picks panel showed a different battle than the one that took the stage").toBe(s.id);
    expect(s.upcomingId, "no upcoming battle in the first snapshot after the boundary").not.toBeNull();
    expect(s.upcomingId).not.toBe(s.id);
    expect(s.upcomingFighters).toBe(8);
    expect(s.upcomingStatus).toBe("OPEN");
  }

  // Everyone saw the SAME battles, in the same order, with the same eight fighters — no duplicate, no skipped battle.
  const byViewer = new Map<number, Seen[]>();
  for (const s of seen) byViewer.set(s.viewer, [...(byViewer.get(s.viewer) ?? []), s]);
  const reference = byViewer.get(0)!.map((s) => s.id);
  for (const rows of byViewer.values()) {
    expect(rows.map((s) => s.sequence)).toEqual(rows.map((_, i) => rows[0]!.sequence + i));
    expect(new Set(rows.map((s) => s.id)).size).toBe(rows.length);
    expect(rows.filter((s) => reference.includes(s.id)).length).toBeGreaterThanOrEqual(boundaries - 1);
  }
  const rosters = new Map<string, Set<string>>();
  for (const s of seen) rosters.set(s.id, (rosters.get(s.id) ?? new Set()).add(s.roster));
  for (const set of rosters.values()) expect(set.size).toBe(1);
  return { seen, dead };
}
