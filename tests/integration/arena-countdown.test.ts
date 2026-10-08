import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { phaseNow } from "@/components/arena/phase";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getArenaState, getReplayDto, type ArenaStateDto } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * THE 3 · 2 · 1 IS A REAL PRE-FIGHT STATE — the server side of it.
 *
 * A battle's public timeline is authoritative and IMMUTABLE once its fight has been public: the moment `combat_starts_at` has passed, the replay
 * is served and any viewer may have watched the fight. Moving that battle's start afterwards (to "now") would make every viewer who watched it see
 * the same battle count down 3 · 2 · 1 AGAIN over a fight that already happened — heroes already hurt or knocked out under the countdown.
 */

let db: Db;
let clock: FakeClock;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock();
});

async function stateAt(t: number): Promise<ArenaStateDto> {
  return getArenaState(db, t, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
}
interface Row {
  id: string;
  status: string;
  starts_at: Date;
  combat_starts_at: Date | null;
  combat_ends_at: Date | null;
  slot_ends_at: Date | null;
}
const battles = () => db.query<Row>("select id, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at from public.arena_battles order by sequence");
const ms = (d: Date | null) => (d ? new Date(d).getTime() : 0);

describe("a battle whose fight has been public is never re-timed (no second 3 · 2 · 1 over a fight that already happened)", () => {
  it("an outage AFTER the waiting battle's fight became public settles it in order instead of moving its start to 'now'", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx); // #1 on stage, #2 and #3 prepared ahead
    const [b1, b2] = await battles();
    // The arena stops advancing (worker down / every advance failing) — but the state endpoint is read-only and keeps answering.
    // A viewer reads it while #2 fights: #2 IS the battle on stage, and its replay (the fight) is public.
    const midFight = ms(b2!.combat_starts_at) + 4000;
    const seen = await stateAt(midFight);
    expect(seen.current!.id).toBe(b2!.id);
    expect(phaseNow(seen.current!, midFight, 3000, 60_000).phase).toBe("COMBAT");
    expect(await getReplayDto(db, b2!.id, midFight)).not.toBeNull();

    clock.ms = ms(b1!.slot_ends_at) + 90_000; // …and the arena resumes 90 s later
    await advanceArena(db, ctx);
    await advanceArena(db, ctx);
    const after = (await battles()).find((b) => b.id === b2!.id)!;
    // The fight that was public keeps its timeline: it is never shown counting down again.
    expect(ms(after.starts_at)).toBe(ms(b2!.starts_at));
    expect(ms(after.combat_starts_at)).toBe(ms(b2!.combat_starts_at));
    for (const t of [clock.ms, clock.ms + 2500, clock.ms + 4000]) {
      const s = await stateAt(t);
      if (s.current?.id === b2!.id) expect(["INTRO", "COUNTDOWN"]).not.toContain(phaseNow(s.current, t, 3000, 60_000).phase);
    }
  });
});

describe("the server is the authority on the 3 · 2 · 1 (two viewers, the persisted battle)", () => {
  it("at 3 · 2 · 1 both viewers get the same eight fighters at their start positions; the fight (replay) is refused until the bell, served after; every stored event is at tick ≥ 1 and tick 0 is everyone at full HP", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1] = await battles();
    const bell = ms(b1!.combat_starts_at);
    expect(bell - ms(b1!.starts_at)).toBeGreaterThanOrEqual(3000); // the intro + countdown really precede the fight
    for (const [label, t] of [["3", bell - 2500], ["2", bell - 1500], ["1", bell - 500], ["just before FIGHT", bell - 1]] as const) {
      const [a, c] = [await stateAt(t), await stateAt(t)]; // two viewers, the same server instant
      expect(a.current!.id, label).toBe(b1!.id);
      expect(c).toEqual(a);
      expect(phaseNow(a.current!, t, 3000, 60_000).phase, label).toBe("COUNTDOWN");
      expect(a.current!.fighters, label).toHaveLength(8);
      for (const f of a.current!.fighters) {
        expect(f.startPosition, label).not.toBeNull();
        expect(f.maxHp, label).toBeGreaterThan(0);
      }
      expect(a.current!.results, label).toBeNull(); // no outcome before the fight
      expect(await getReplayDto(db, b1!.id, t), `${label}: the fight is withheld until the bell`).toBeNull();
    }
    const replay = await getReplayDto(db, b1!.id, bell);
    expect(replay).not.toBeNull();
    expect(replay!.events.length).toBeGreaterThan(0);
    for (const e of replay!.events) expect(e[0]).toBeGreaterThanOrEqual(1); // nothing happens AT or before the bell
    const s = await stateAt(bell - 500);
    const n = replay!.startPositions.length;
    for (const f of s.current!.fighters) {
      // tick 0 of the stored fight = exactly what the countdown showed: the start position and full HP
      const o = f.slot! * replay!.stride;
      expect([replay!.frames[o]! / 10, replay!.frames[o + 1]! / 10]).toEqual(f.startPosition);
      expect(replay!.frames[o + 2]).toBe(f.maxHp);
    }
    expect(n).toBe(8);
  });
});
