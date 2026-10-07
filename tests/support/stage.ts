import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";

import { arenaCtx, FakeClock, seedHeroes } from "./db";

/**
 * A "stage" for Arena Picks tests. Picks are made on the UPCOMING battle while the battle on stage is being fought, so this
 * describes the battle a member picks on — `battleId`, the one every pick and every settlement in these tests is about — together
 * with the battle on stage in front of it (`predecessor*`), whose decision closes the pick window.
 *
 * At the moment `stageBattle` returns, the clock sits where picks for `battleId` are OPEN: the predecessor has just taken the stage.
 */
export interface Stage {
  clock: FakeClock;
  ctx: ReturnType<typeof arenaCtx>;
  /** The UPCOMING battle: the one picks are made on and the one that settles. */
  battleId: string;
  fighters: string[];
  /** When `battleId` takes the stage / starts fighting / is decided. */
  startsAt: number;
  combatStartsAt: number;
  combatEndsAt: number;
  /** The authoritative Arena #1 of `battleId` (set when it was prepared; public only after its fight). */
  winnerId: string;
  /** The battle on stage while `battleId` is picked, and the instant its result is decided (= when `battleId`'s picks lock). */
  predecessorId: string;
  predecessorCombatEndsAt: number;
}

/** Puts the arena in the state where picks for the upcoming battle (#2) are OPEN while battle #1 is on stage. */
export async function stageBattle(db: Db, heroes = 16): Promise<Stage> {
  await seedHeroes(db, heroes);
  const clock = new FakeClock();
  const ctx = arenaCtx(clock);
  await advanceArena(db, ctx);
  return describeStage(db, clock, ctx);
}

/** Describes the upcoming battle (the picks target) and the battle on stage in front of it, at the clock's current instant. */
export async function describeStage(db: Db, clock: FakeClock, ctx: ReturnType<typeof arenaCtx>): Promise<Stage> {
  const find = () =>
    db.query<{ id: string; starts_at: Date; combat_starts_at: Date; combat_ends_at: Date; winner_id: string }>(
      "select id, starts_at, combat_starts_at, combat_ends_at, winner_id from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz order by sequence limit 1",
      [clock.now().toISOString()],
    );
  let [b] = await find();
  for (let i = 0; !b && i < 3; i++) {
    await advanceArena(db, ctx); // the next battle is prepared a moment after the previous one takes the stage
    [b] = await find();
  }
  const [p] = await db.query<{ id: string; combat_ends_at: Date }>(
    "select id, combat_ends_at from public.arena_battles where status in ('SIMULATED', 'SETTLED') and starts_at <= $1::timestamptz order by sequence desc limit 1",
    [clock.now().toISOString()],
  );
  const fighters = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 order by slot", [b!.id])).map((r) => r.character_id);
  return {
    clock, ctx, battleId: b!.id, fighters,
    startsAt: new Date(b!.starts_at).getTime(), combatStartsAt: new Date(b!.combat_starts_at).getTime(), combatEndsAt: new Date(b!.combat_ends_at).getTime(), winnerId: b!.winner_id,
    predecessorId: p!.id, predecessorCombatEndsAt: new Date(p!.combat_ends_at).getTime(),
  };
}

/**
 * Plays the whole lifecycle of `s.battleId`: the battle on stage is decided (the pick window closes), the battle takes the stage,
 * is fought, and is decided and settled by the arena (rewards settle separately). Leaves the clock just after its combat ended.
 */
export async function finishBattle(db: Db, s: Stage): Promise<void> {
  s.clock.ms = Math.max(s.clock.ms, s.predecessorCombatEndsAt + 10);
  await advanceArena(db, s.ctx);
  s.clock.ms = Math.max(s.clock.ms, s.startsAt);
  await advanceArena(db, s.ctx);
  s.clock.ms = Math.max(s.clock.ms, s.combatEndsAt + 10);
  await advanceArena(db, s.ctx);
}
