import { advanceArena } from "@/server/services/arena";
import type { LifecycleDeps } from "@/server/services/lifecycle";
import type { Db, Queryable } from "@/server/db/types";

import { arenaCtx, factoryArenaState, type FakeClock } from "./db";

/** Admin deps for the lifecycle service, driven by the test's fake clock. */
export const adminDeps = (clock: FakeClock, over: Partial<LifecycleDeps> = {}): LifecycleDeps => ({ actor: "test-admin", allowDemo: true, now: clock.now, requireBackup: false, ...over });

/** A development database in the state a freshly migrated one has: the Arena NOT_STARTED, nothing ever advanced. (resetDb leaves it RUNNING for the older suites.) */
export async function freshDevelopment(db: Db): Promise<void> {
  await factoryArenaState(db);
}

/** Advance the fake clock in 1 s steps (like many viewers polling) and the Arena with it, until `until()` holds. */
export async function runUntil(db: Db, clock: FakeClock, until: () => Promise<boolean>, opts: { maxSeconds?: number; stepMs?: number } = {}): Promise<void> {
  const ctx = arenaCtx(clock);
  const maxSeconds = opts.maxSeconds ?? 4000;
  for (let s = 0; s < maxSeconds; s++) {
    await advanceArena(db, ctx);
    if (await until()) return;
    clock.advance(opts.stepMs ?? 1000);
  }
  throw new Error(`condition not reached after ${maxSeconds} s of fake time`);
}

/** Advance for `seconds` of fake time, calling the Arena every second — what a worker does while nothing is supposed to happen. */
export async function idleFor(db: Db, clock: FakeClock, seconds: number): Promise<void> {
  const ctx = arenaCtx(clock);
  for (let s = 0; s < seconds; s++) {
    await advanceArena(db, ctx);
    clock.advance(1000);
  }
}

export const arenaStatus = async (q: Queryable): Promise<string> => (await q.query<{ status: string }>("select status from public.arena_state where id = 1"))[0]!.status;
export const gamePhase = async (q: Queryable): Promise<string> => (await q.query<{ phase: string }>("select phase from public.game_state where id = 1"))[0]!.phase;
export const activeSeason = async (q: Queryable) => (await q.query<{ id: string; kind: string; number: number | null; run_number: number | null; name: string; battle_counter: number }>("select id, kind, number, run_number, name, battle_counter from public.seasons where status = 'ACTIVE'"))[0];

/** Public battle numbers of a season, in order. */
export const battleNumbers = async (q: Queryable, seasonId: string): Promise<number[]> =>
  (await q.query<{ n: number }>("select season_sequence as n from public.arena_battles where season_id = $1 order by sequence", [seasonId])).map((r) => Number(r.n));

/**
 * A fingerprint of EVERYTHING that makes a hero that hero: the character row (minus the lifetime Arena counters, which battles legitimately move),
 * its appearance, stats and its whole version history. A lifecycle action must leave it byte-identical.
 */
export async function heroIdentityHash(q: Queryable): Promise<{ heroes: number; hash: string }> {
  const [row] = await q.query<{ heroes: number; hash: string }>(
    `select count(*)::int as heroes,
            md5(coalesce(string_agg(
              (to_jsonb(c) - 'arena_battles' - 'arena_wins' - 'arena_top2' - 'arena_eliminations' - 'arena_damage' - 'last_arena_at' - 'title' - 'updated_at')::text
              || coalesce((select to_jsonb(a)::text from public.character_appearances a where a.character_id = c.id), '')
              || coalesce((select (to_jsonb(s) - 'updated_at')::text from public.character_stats s where s.character_id = c.id), '')
              || coalesce((select string_agg(to_jsonb(v)::text, '|' order by v.version_number) from public.hero_versions v where v.character_id = c.id), ''),
              E'\n' order by c.id), '')) as hash
       from public.characters c`,
  );
  return { heroes: row!.heroes, hash: row!.hash };
}

/** The immutable parts of every battle (result, snapshot, hashes) — launching a season must not move a byte of any of it. */
export async function battleHistoryHash(q: Queryable, seasonId?: string): Promise<string> {
  const [row] = await q.query<{ hash: string }>(
    `select md5(coalesce(string_agg(concat_ws('|', b.id::text, b.season_id::text, b.season_sequence::text, b.sequence::text, b.seed, b.events_hash, b.ruleset_hash, b.snapshot::text, b.result::text, b.winner_id::text), E'\n' order by b.sequence), '')) as hash
       from public.arena_battles b where b.status = 'SETTLED' and ($1::uuid is null or b.season_id = $1::uuid)`,
    [seasonId ?? null],
  );
  return row!.hash;
}
