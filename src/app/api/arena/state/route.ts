import { holdDelayMs, isStaleAcrossBoundary } from "@/domain/arena/boundary";
import { demoHeroesAllowed } from "@/server/env";
import { fail, ok } from "@/server/http/guards";
import { getPicksRewardDto } from "@/server/rewards/pool";
import { advanceForRead, getAllClasses, getReadyDb, getSettings, isFlagOn } from "@/server/runtime";
import { getArenaState, type ArenaStateDto } from "@/server/services/views";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Thousands of viewers see the SAME arena, so one computation serves everyone for a quarter second —
 * with one hard rule: a snapshot is never served (or kept) across a phase boundary. The public state is a pure
 * function of the server clock, so a snapshot computed before the results timer ended is WRONG the instant it
 * ends. Without this rule the viewers who ask right at the boundary were handed the previous battle again and
 * then sat on "NEXT BATTLE IN 0 SEC" until their next poll.
 *
 * serverTime is always stamped fresh (clients use it to synchronise their clocks).
 */
const TTL_MS = 250;

interface Computed {
  state: ArenaStateDto;
  /** The clock reading the snapshot was built from. */
  computedAt: number;
}
interface Cached {
  at: number;
  promise: Promise<Computed>;
  /** Set once the computation has finished (lets a request peek without waiting on one still in flight). */
  value?: Computed;
}
const g = globalThis as unknown as { __clankStateCache?: Cached };

/** `asOfMs` (future) builds the snapshot for that instant ahead of time — see the hold path in GET. */
async function compute(asOfMs?: number): Promise<Computed> {
  // Kicks the (coalesced) advance and waits only where a read cannot answer correctly otherwise (see advanceForRead). The PUBLIC status is read from the
  // persisted runtime state inside getArenaState — never from this advance result, which can be a few seconds stale or belong to another process.
  await advanceForRead({ neverWait: asOfMs !== undefined });
  const db = await getReadyDb();
  // Settings, classes and flags are short-lived caches; when more than one has expired they refill together (one round trip, not three).
  const computedAt = asOfMs ?? Date.now();
  const [settings, classes, picksEnabled] = await Promise.all([getSettings(), getAllClasses(), isFlagOn("arena.picks")]);
  const reward = await getPicksRewardDto(db, settings, computedAt);
  const state = await getArenaState(db, computedAt, settings, { allowDemo: demoHeroesAllowed(), classes, picksEnabled, reward });
  return { state, computedAt };
}

function startCompute(): Cached {
  const entry: Cached = { at: Date.now(), promise: compute() };
  g.__clankStateCache = entry;
  entry.promise.then(
    (value) => {
      entry.value = value;
    },
    () => {
      if (g.__clankStateCache === entry) g.__clankStateCache = undefined;
    },
  );
  return entry;
}

/** A snapshot that is fresh enough AND does not predate a boundary that has already passed. */
async function load(): Promise<Computed> {
  const hit = g.__clankStateCache;
  let entry = hit && Date.now() - hit.at < TTL_MS ? hit : startCompute();
  let result = await entry.promise;
  for (let attempt = 0; attempt < 2 && isStaleAcrossBoundary(result.state, result.computedAt, Date.now()); attempt++) {
    // Someone else may already have rebuilt it; otherwise do it now.
    const latest = g.__clankStateCache;
    entry = latest && latest !== entry && Date.now() - latest.at < TTL_MS ? latest : startCompute();
    result = await entry.promise;
  }
  return result;
}

/** Snapshots built ahead of time for a boundary, shared by every viewer that asks to be held for it. */
const ahead = globalThis as unknown as { __clankStateAhead?: { asOf: number; promise: Promise<Computed> } };

function computeAhead(asOfMs: number): Promise<Computed> {
  const hit = ahead.__clankStateAhead;
  if (hit && hit.asOf === asOfMs) return hit.promise;
  const entry = { asOf: asOfMs, promise: compute(asOfMs) };
  ahead.__clankStateAhead = entry;
  entry.promise.catch(() => {
    if (ahead.__clankStateAhead === entry) ahead.__clankStateAhead = undefined;
  });
  return entry.promise;
}

export async function GET(req?: Request) {
  const receivedAt = Date.now();
  try {
    const stamp = (state: ArenaStateDto): ArenaStateDto => ({ ...state, serverTime: Date.now(), serverReceivedAt: receivedAt });
    // `?hold=<server epoch ms>`: a viewer whose results timer is about to end asks to be answered AT the boundary so
    // the next eight appear the instant it ends, with no second round trip. Honoured only when the target is a real
    // new-battle boundary of the last snapshot we hold, and for at most MAX_HOLD_MS (see holdDelayMs) — nothing is
    // revealed early: the response is sent AT the boundary. The snapshot is BUILT for that instant while we wait (the
    // state is a pure function of the clock, and the next battle was persisted when it was prepared), so its database
    // round trips are already done — and it never queues behind a settlement still running at the end of the slot.
    const holdParam = req ? new URL(req.url).searchParams.get("hold") : null;
    if (holdParam !== null) {
      const target = Number(holdParam);
      const known = g.__clankStateCache?.value;
      const wait = known ? holdDelayMs(target, known.state, Date.now()) : 0;
      if (wait > 0) {
        const built = await Promise.all([computeAhead(target), new Promise((resolve) => setTimeout(resolve, wait + 2))]).then(([r]) => r);
        const delay = target + 1 - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        // Only trust it if it really is the snapshot of the battle that starts at the boundary and nothing newer has passed since.
        if (built.state.current?.startsAt === target && !isStaleAcrossBoundary(built.state, built.computedAt, Date.now())) {
          // The new battle is on stage: line up the one after it now, off the response path.
          void advanceForRead();
          return ok({ state: stamp(built.state) });
        }
      }
    }
    return ok({ state: stamp((await load()).state) });
  } catch (error) {
    console.error("[arena/state]", error);
    return fail("ARENA_UNAVAILABLE", 503);
  }
}
