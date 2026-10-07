import "server-only";

import type { ClassDef } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";

import { ClankTradeClient } from "./chain/clankTrade";
import { createRobinhoodReader } from "./chain/robinhood";
import type { BalanceReader, CatalogProvider, TradeProvider } from "./chain/types";
import { loadClasses, loadSettings } from "./config/settingsRepo";
import { classVisuals, type ClassVisual } from "./services/views";
import { makeTextHasher, secureSeed } from "./crypto";
import { getDb, type Db } from "./db";
import { demoHeroesAllowed, getEnv, getSecret, viewerAdvanceEnabled } from "./env";
import { seedReferenceData } from "./seed/reference";
import { advanceArena, replayBattle, type ArenaAdvanceResult, type ArenaCtx } from "./services/arena";
import type { IngestDeps } from "./services/telegramIngest";

/**
 * The composition root for API routes: one place that wires the database, settings cache,
 * providers and secrets together. Everything is created lazily and reused per server process.
 */
interface Cache<T> {
  value: T;
  at: number;
}

const g = globalThis as unknown as {
  __clankSeeded?: Promise<void>;
  __clankSettings?: Cache<GameSettings>;
  __clankClasses?: Cache<ClassDef[]>;
  __clankAllClasses?: Cache<ClassDef[]>;
  __clankAdvance?: { promise: Promise<ArenaAdvanceResult> | null; at: number; last: ArenaAdvanceResult | null };
  __clankRewardSweep?: { at: number; running: boolean };
};

const SETTINGS_TTL_MS = 2000;

export async function getReadyDb(): Promise<Db> {
  const db = await getDb();
  // One seed per process — but a FAILED (or timed-out) seed is forgotten, so the next request tries again instead of every request failing forever.
  const seeding = (g.__clankSeeded ??= seedReferenceData(db).then(
    () => undefined,
    (error: unknown) => {
      g.__clankSeeded = undefined;
      throw error;
    },
  ));
  await seeding;
  return db;
}

export async function getSettings(): Promise<GameSettings> {
  const hit = g.__clankSettings;
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = await loadSettings(await getReadyDb());
  g.__clankSettings = { value, at: Date.now() };
  return value;
}

export async function getEnabledClasses(): Promise<ClassDef[]> {
  const hit = g.__clankClasses;
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = await loadClasses(await getReadyDb());
  g.__clankClasses = { value, at: Date.now() };
  return value;
}

/** Every class, disabled ones included (existing heroes keep theirs), cached briefly: the arena state reads it on every build. */
export async function getAllClasses(): Promise<ClassDef[]> {
  const hit = g.__clankAllClasses;
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = await loadClasses(await getReadyDb(), false);
  g.__clankAllClasses = { value, at: Date.now() };
  return value;
}

/** Visual identity of every class (including disabled ones, so existing heroes still render). */
export async function getClassVisuals(): Promise<Record<string, ClassVisual>> {
  return classVisuals(await loadClasses(await getReadyDb(), false));
}

/** Call after any admin change to settings / classes so the next request sees it immediately. */
export function invalidateConfigCache(): void {
  g.__clankSettings = undefined;
  g.__clankClasses = undefined;
  g.__clankAllClasses = undefined;
}

/**
 * Forget the in-process arena snapshots (the last advance result and the cached public state). Called after every lifecycle action (launch, start, pause,
 * resume, reset, end / create season): the database already holds the new state, and no viewer of THIS process may be answered from a snapshot that predates it.
 * (Other processes see the change through the persisted rows within a poll — their caches live a quarter second.)
 */
export function invalidateArenaCaches(): void {
  g.__clankAdvance = undefined;
  const shared = globalThis as unknown as { __clankStateCache?: unknown; __clankStateAhead?: unknown };
  shared.__clankStateCache = undefined;
  shared.__clankStateAhead = undefined;
}

export function arenaContext(): ArenaCtx {
  return { now: () => new Date(), secureSeed, allowDemo: demoHeroesAllowed() };
}

/**
 * Lazily advances the arena. Many viewers polling at once coalesce into a single advance
 * (in-process), and cross-process safety comes from the database row lock inside advanceArena.
 *
 * A recent result may be reused for `minIntervalMs`, but NEVER across a due transition: if the last advance
 * reported that something falls due (combat start/end) and that moment has passed, the next call runs again.
 * (Reusing a 300 ms-old "nothing to do" at the moment a battle ends is how viewers used to be served a
 * pre-transition snapshot.)
 */
export async function ensureArenaAdvanced(minIntervalMs = 400): Promise<ArenaAdvanceResult> {
  for (let attempt = 0; ; attempt++) {
    const r = await advanceOnce(minIntervalMs);
    // If we joined an advance that started before a transition fell due, go once more so the caller sees it applied.
    if (attempt >= 1 || r.dueAtMs === null || Date.now() < r.dueAtMs) return r;
  }
}

/** How long the arena may go un-advanced before a state READ stops trusting the persisted rows and recovers first. */
const READ_ADVANCE_MAX_AGE_MS = 10_000;
/** A cold process waits at most this long for its first advance before answering from what is persisted. */
const COLD_READ_WAIT_CAP_MS = 1500;

/**
 * Advance for a state READ — and the rule that keeps reads fast: **a read never waits for work that is merely in
 * progress, and in particular never for a settlement.** Settlement is bookkeeping (rewards, season points, loot);
 * how long it takes depends on the database (≈ 77 statements) and the machine, and it is written to the database
 * either way. The battle on stage, the next battle and the results placements are already persisted, so a read can
 * answer immediately. (The first version of this made reads wait for a due settlement; once settlement outlasted the
 * results window — a slower database, a loaded host — the viewers' own requests were stuck behind it at the very
 * moment the next battle was due.) Clients learn settlement is still pending from `current.status` and look again.
 *
 * A read waits only where it cannot answer correctly otherwise:
 *   · a cold process (nothing known yet) — capped at COLD_READ_WAIT_CAP_MS, after which it answers from the rows;
 *   · an arena nobody has advanced for READ_ADVANCE_MAX_AGE_MS with nothing in flight (an outage): recover first.
 * Every read still kicks the advance off in the background (coalesced) so the arena keeps moving.
 *
 * `neverWait`: a snapshot built for a FUTURE instant does not depend on anything in flight right now.
 */
export async function advanceForRead(opts: { neverWait?: boolean } = {}): Promise<Pick<ArenaAdvanceResult, "status"> | null> {
  // ARENA_VIEWER_ADVANCE=off: a viewer's read is strictly READ-ONLY — the worker (or the scheduler tick) is the only thing that moves the Arena.
  if (!viewerAdvanceEnabled()) return null;
  const st = g.__clankAdvance;
  const last = st?.last ?? null;
  const inFlight = Boolean(st?.promise);
  const now = Date.now();
  const run = ensureArenaAdvanced().catch((error) => {
    console.error("[arena] advance failed", error);
    return null;
  });
  if (opts.neverWait) return last ?? { status: "LIVE" as const };
  if (!last) return Promise.race([run, new Promise<null>((resolve) => setTimeout(() => resolve(null), COLD_READ_WAIT_CAP_MS))]);
  if (!inFlight && now - (st?.at ?? 0) > READ_ADVANCE_MAX_AGE_MS) return run;
  return last;
}

/** The home page's server render: advances the Arena like a state read does — and, like it, not at all when viewers are read-only. */
export async function advanceForPage(): Promise<void> {
  if (viewerAdvanceEnabled()) await ensureArenaAdvanced().catch(() => null);
}

/**
 * NOTHING CAN ADVANCE while the persisted status is NOT_STARTED or PAUSED — stepArena's gate returns at once for both. Every viewer's state read
 * comes through here, so in those two states (the whole of the DEVELOPMENT period, and any pause) answer from ONE plain read instead of a
 * BEGIN / SELECT … FOR UPDATE / COMMIT: three round trips and a row lock on arena_state per poll, for nothing. Every state that CAN advance
 * (PREPARING, RUNNING, PAUSE_REQUESTED) still goes through the locked gate in advanceArena, unchanged — as does an arena without a state row, the
 * worker and the scheduler tick. A START / RESUME that commits just after this read is picked up by the very next advance (the lifecycle action
 * kicks one itself, and viewers and the worker keep polling).
 */
async function advanceForViewers(db: Db): Promise<ArenaAdvanceResult> {
  const [persisted] = await db.query<{ status: string }>("select status from public.arena_state where id = 1");
  if (persisted?.status === "NOT_STARTED" || persisted?.status === "PAUSED") return { status: persisted.status, steps: [], dueAtMs: null };
  return advanceArena(db, arenaContext());
}

async function advanceOnce(minIntervalMs: number): Promise<ArenaAdvanceResult> {
  const state = (g.__clankAdvance ??= { promise: null, at: 0, last: null });
  if (state.promise) return state.promise;
  const overdue = state.last !== null && state.last.dueAtMs !== null && Date.now() >= state.last.dueAtMs;
  if (state.last && !overdue && Date.now() - state.at < minIntervalMs) return state.last;
  const db = await getReadyDb();
  state.promise = advanceForViewers(db)
    .then((r) => {
      state.last = r;
      state.at = Date.now();
      // The replay is withheld until picks lock, then everyone asks for it at once: build it now (best effort).
      for (const step of r.steps) {
        if (step.startsWith("simulated:")) void replayBattle(db, step.slice("simulated:".length)).catch(() => undefined);
      }
      sweepRewards(db, r.steps.some((step) => step.startsWith("settled:")));
      return r;
    })
    .finally(() => {
      state.promise = null;
    });
  return state.promise;
}

/**
 * Arena Pick rewards are credited AFTER the arena has settled (or voided) the battle, in their own transaction, and
 * strictly off the request path: this is fire-and-forget, so no viewer's request ever waits for it and a reward problem
 * (token RPC down, treasury empty, claims paused, a bug) can never hold up or fail an arena transition. The sweep is one
 * indexed query when nothing is pending, runs right after a settlement, and otherwise at most every 5 s; the scheduler
 * tick and the arena worker run it too (and they re-verify due holder wallets). It also finalizes an ended weekly leaderboard.
 */
function sweepRewards(db: Db, justSettled: boolean): void {
  const state = (g.__clankRewardSweep ??= { at: 0, running: false });
  if (state.running || (!justSettled && Date.now() - state.at < 5000)) return;
  state.running = true;
  state.at = Date.now();
  // The reward modules are loaded LAZILY, only when a sweep actually runs: the public Arena state route (the hottest read in the app) imports this
  // file, and it must not depend on — or pay the cold-start cost of — the scoring, finalization, holder-verification or chain code.
  void import("./rewards/settlement")
    .then(({ settleDueRewards }) => settleDueRewards(db, { now: () => new Date() }))
    // After the battles are scored, freeze any ended Daily / Weekly board (idempotent; a no-op except in the first seconds of a new day / week).
    .then(async () => (await import("./rewards/leaderboard")).finalizeDueBoards(db, { now: () => new Date(), settings: await getSettings() }))
    .catch((error) => console.error("[rewards] settlement sweep failed", error))
    .finally(() => {
      state.running = false;
    });
  // HERO ARENA is a separate reward program: its own sweep, its own failure domain (a problem in one never touches the other).
  void import("./rewards/heroArena")
    .then(async ({ finalizeDueHeroBoards }) => finalizeDueHeroBoards(db, { now: () => new Date(), settings: await getSettings(), allowDemo: demoHeroesAllowed() }))
    .catch((error) => console.error("[hero-arena] sweep failed", error));
}

export async function getIngestDeps(): Promise<IngestDeps> {
  const env = getEnv();
  return {
    settings: await getSettings(),
    classes: await getEnabledClasses(),
    hash: makeTextHasher(getSecret("TELEGRAM_HASH_PEPPER", env)),
    classRollSecret: getSecret("CLASS_ROLL_SECRET", env),
  };
}

export function getProviders(): { catalog: CatalogProvider & TradeProvider; reader: BalanceReader } {
  const env = getEnv();
  return {
    catalog: new ClankTradeClient({ baseUrl: env.CLANK_TRADE_API_URL, chainId: env.ROBINHOOD_CHAIN_ID }),
    reader: createRobinhoodReader({ rpcUrl: env.ROBINHOOD_RPC_URL, chainId: env.ROBINHOOD_CHAIN_ID }),
  };
}

const flagCache: { at: number; map: Map<string, boolean> } = { at: 0, map: new Map() };
let flagLoad: Promise<void> | null = null;
/** Feature flags (admin-togglable) with a short cache. Unknown flags are OFF. Concurrent callers share one refill. */
export async function isFlagOn(key: string): Promise<boolean> {
  if (Date.now() - flagCache.at > SETTINGS_TTL_MS) {
    flagLoad ??= (async () => {
      const db = await getReadyDb();
      const rows = await db.query<{ key: string; enabled: boolean }>("select key, enabled from public.feature_flags");
      flagCache.map = new Map(rows.map((r) => [r.key, r.enabled]));
      flagCache.at = Date.now();
    })().finally(() => {
      flagLoad = null;
    });
    await flagLoad;
  }
  return flagCache.map.get(key) ?? false;
}
export function invalidateFlagCache(): void {
  flagCache.at = 0;
}

/** Test hook: drop every in-process cache (settings, classes, flags, arena-advance coalescing). */
export function resetRuntimeCaches(): void {
  g.__clankSettings = undefined;
  g.__clankClasses = undefined;
  g.__clankAllClasses = undefined;
  g.__clankAdvance = undefined;
  g.__clankRewardSweep = undefined;
  (globalThis as unknown as { __clankStateCache?: unknown }).__clankStateCache = undefined;
  flagCache.at = 0;
}
