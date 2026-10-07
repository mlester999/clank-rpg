import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { phaseNow } from "@/components/arena/phase";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * Characterization of the PUBLIC arena contract that the UI is built on. These pin the core loop
 * (8 fighters → 3·2·1 → ≤60 s combat → 5 s #1/#2 results → next group) so the sprite and layout
 * work can never silently change it.
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

async function stateNow() {
  const settings = await loadSettings(db);
  return getArenaState(db, clock.ms, settings, { allowDemo: true, classes: await loadClasses(db, false) });
}

describe("arena state — the on-stage battle", () => {
  it("shows exactly the 8 current heroes, each with a slot, a start position and frozen HP", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s.current).not.toBeNull();
    const f = s.current!.fighters;
    expect(f).toHaveLength(8);
    expect(f.map((x) => x.slot).sort()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(f.map((x) => x.characterId)).size).toBe(8);
    for (const x of f) {
      expect(x.startPosition).toHaveLength(2);
      expect(x.maxHp).toBeGreaterThan(0);
      expect(x).not.toHaveProperty("level"); // Arena fighters carry no permanent level
      expect(s.classes[x.classId]).toBeDefined();
      expect(x.appearance.rarity).toMatch(/^(COMMON|RARE|EPIC|LEGENDARY)$/);
    }
    expect(s.groupSize).toBe(8);
  });

  it("each fighter carries what the new Current Round panel shows: power, class look, and a resolved sprite config", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    for (const f of s.current!.fighters) {
      expect(f.power).toBeGreaterThan(0);
      expect(f.appearance.sprite).toMatchObject({ v: 1 });
      expect(s.classes[f.classId]).toMatchObject({ weapon: expect.any(String), body: expect.any(String), colors: expect.any(Array) });
    }
    expect(s.visuals).toEqual({ spriteSet: "clank-dev-v1", disabledCosmetics: [] });
  });

  it("keeps the timing contract: intro → 3·2·1 → ≤60 s combat → victory beat → 5 s results", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s.timing).toMatchObject({ introMs: 2500, countdownMs: 3000, maxCombatMs: 60_000, victoryHoldMs: 1200, resultsMs: 5000 });
    const b = s.current!;
    expect(b.combatStartsAt! - b.startsAt).toBe(2500 + 3000); // combat begins the instant the countdown ends
    expect(b.combatEndsAt! - b.combatStartsAt!).toBeLessThanOrEqual(60_000);
    expect(b.resultsStartAt! - b.combatEndsAt!).toBe(1200);
    expect(b.slotEndsAt! - b.resultsStartAt!).toBe(5000);
  });

  it("withholds results until combat has ended on the server clock, then shows #1…#8", async () => {
    await seedHeroes(db, 16);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    expect((await stateNow()).current!.results).toBeNull();
    const b = (await stateNow()).current!;
    clock.ms = b.combatEndsAt! + 10;
    await advanceArena(db, ctx);
    const after = (await stateNow()).current!;
    expect(after.status).toBe("SETTLED");
    expect(after.results).toHaveLength(8);
    expect(after.results!.map((r) => r.placement)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const [first, second] = after.results!;
    expect(after.fighters.find((x) => x.characterId === first!.characterId)).toBeDefined();
    expect(first!.characterId).not.toBe(second!.characterId);
  });

  it("publishes NO queue / cycle / scheduler internals — players only see the battle on stage (operations live in Admin)", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s).not.toHaveProperty("cycle");
    expect(Object.keys(s).sort()).toEqual(["classes", "current", "demo", "eligibleHeroes", "groupSize", "heroThreshold", "next", "pausing", "phase", "picks", "recent", "season", "serverTime", "status", "timing", "upcoming", "visuals"]);
    const wire = JSON.stringify(s);
    expect(wire).not.toMatch(/cycle|battlesDone|carriedIn|totalHeroes|"fought"|queue/i);
  });

  it("builds the snapshot in a handful of sequential round trips — the independent reads run together (it is built the instant a battle starts)", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    // Count SEQUENTIAL waves: a wave is a stretch during which at least one statement is in flight. Reads issued together
    // share a wave; a read that waits for another opens a new one. (Wall-clock free, so it cannot flake on a busy machine.)
    let inflight = 0;
    let waves = 0;
    let statements = 0;
    const counted = {
      query: async (text: string, params?: readonly unknown[]) => {
        if (inflight++ === 0) waves++;
        statements++;
        try {
          await new Promise((r) => setTimeout(r, 1));
          return await db.query(text, params);
        } finally {
          inflight--;
        }
      },
      exec: (text: string) => db.exec(text),
    };
    const settings = await loadSettings(db);
    const classes = await loadClasses(db, false);
    const state = await getArenaState(counted as never, clock.ms, settings, { allowDemo: true, classes, picksEnabled: true });
    expect(state.current!.fighters).toHaveLength(8);
    expect(statements).toBeGreaterThanOrEqual(5);
    expect(waves, `${statements} statements in ${waves} sequential waves`).toBeLessThanOrEqual(3);
  });

  it("lists recent winners with their runner-up once a battle has settled", async () => {
    await seedHeroes(db, 16);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    expect((await stateNow()).recent).toEqual([]);
    clock.ms = (await stateNow()).current!.combatEndsAt! + 10;
    await advanceArena(db, ctx);
    const s = await stateNow();
    expect(s.recent).toHaveLength(1);
    expect(s.recent[0]!.winner).not.toBeNull();
    expect(s.recent[0]!.runnerUp).not.toBeNull();
    expect(s.recent[0]!.winner!.characterId).not.toBe(s.recent[0]!.runnerUp!.characterId);
  });

  it("still lines the next battle up, starting the moment the current slot ends (no extra wait)", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s.next).not.toBeNull();
    expect(s.next!.startsAt).toBe(s.current!.slotEndsAt);
  });

  it("publishes only the next battle's TIMING — never its roster (heroes are discovered when they appear)", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    // The PUBLIC (season) battle number is part of the timing; the roster, outcome and internal sequence are not.
    expect(Object.keys(s.next!).sort()).toEqual(["id", "number", "startsAt"]);
  });

  it("never publishes the outcome while picks are open: no winner/ranking in state, and the replay is withheld until combat starts", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s.current!.results).toBeNull();
    expect(JSON.stringify(s)).not.toMatch(/ranking|winner_id|winnerId/);
    const { getReplayDto } = await import("@/server/services/views");
    const b = s.current!;
    expect(await getReplayDto(db, b.id, b.startsAt)).toBeNull(); // slot just started: picks are open
    expect(await getReplayDto(db, b.id, b.combatStartsAt! - 1)).toBeNull(); // last ms before the lock
    const released = await getReplayDto(db, b.id, b.combatStartsAt!);
    expect(released).not.toBeNull(); // the instant picks lock, the verified replay is served
    expect(released!.eventsHash).toBe(b.eventsHash);
  });
});

describe("client phase clock (phaseNow) mirrors the server timeline", () => {
  const battle = {
    startsAt: 1_000_000, combatStartsAt: 1_005_500, combatEndsAt: 1_035_500, resultsStartAt: 1_036_700, slotEndsAt: 1_041_700,
  } as never;
  const at = (t: number) => phaseNow(battle, t, 3000, 30_000);

  it("walks INTRO → COUNTDOWN(3,2,1) → COMBAT → VICTORY → RESULTS → DONE", () => {
    expect(at(1_000_000).phase).toBe("INTRO");
    expect(at(1_002_499).phase).toBe("INTRO");
    expect(at(1_002_500)).toMatchObject({ phase: "COUNTDOWN", countdown: 3 });
    expect(at(1_003_600)).toMatchObject({ phase: "COUNTDOWN", countdown: 2 });
    expect(at(1_004_700)).toMatchObject({ phase: "COUNTDOWN", countdown: 1 });
    expect(at(1_005_500)).toMatchObject({ phase: "COMBAT", combatMs: 0 });
    expect(at(1_035_499).phase).toBe("COMBAT");
    expect(at(1_035_500).phase).toBe("VICTORY");
    expect(at(1_036_700).phase).toBe("RESULTS");
    expect(at(1_041_700).phase).toBe("DONE");
  });

  it("is IDLE when there is no battle", () => {
    expect(phaseNow(null, 0, 3000, 30_000).phase).toBe("IDLE");
  });
});

describe("arena invariants the redesign must not break", () => {
  it("never schedules a hero twice in one battle and always fields 8", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    for (let i = 0; i < 400 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 3; i++) {
      await advanceArena(db, ctx);
      clock.advance(1000);
    }
    const sizes = await db.query<{ n: number }>("select count(*)::int as n from public.arena_participants group by battle_id");
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(sizes.every((x) => x.n === 8)).toBe(true);
    expect(await db.query("select 1 from public.arena_participants group by battle_id, character_id having count(*) > 1")).toHaveLength(0);
  });
});
