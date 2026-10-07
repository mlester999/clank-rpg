import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { advanceArena, replayBattle } from "@/server/services/arena";
import type { Db } from "@/server/db/types";
import { auditLedger } from "@/server/services/economy";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

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

/** Advance the fake clock in 1 s steps (like many viewers polling) until `until()` is true. */
async function runUntil(until: () => Promise<boolean>, maxSeconds = 3000) {
  const ctx = arenaCtx(clock);
  for (let s = 0; s < maxSeconds; s++) {
    await advanceArena(db, ctx);
    if (await until()) return;
    clock.advance(1000);
  }
  throw new Error("condition not reached");
}

describe("Global Idle Arena — end to end", () => {
  it("waits (GATHERING) while there are fewer than 8 eligible heroes", async () => {
    await seedHeroes(db, 7);
    const r = await advanceArena(db, arenaCtx(clock));
    expect(r.status).toBe("GATHERING");
    expect(r.eligibleHeroes).toBe(7);
    expect(await count(db, "arena_battles")).toBe(0);
    expect(await count(db, "arena_cycles")).toBe(0);
  });

  it("starts a persisted cycle, schedules the first group and simulates it with a frozen snapshot", async () => {
    await seedHeroes(db, 24);
    const r = await advanceArena(db, arenaCtx(clock));
    expect(r.status).toBe("LIVE");
    const battles = await db.query<{ status: string; seed: string; events_hash: string; ruleset_hash: string; duration_ms: number }>(
      "select status, seed, events_hash, ruleset_hash, duration_ms from public.arena_battles order by sequence",
    );
    // on stage + the UPCOMING battle (the picks target) + the one behind it: all three prepared, with a frozen snapshot
    expect(battles.map((b) => b.status)).toEqual(["SIMULATED", "SIMULATED", "SIMULATED"]);
    expect(battles[0]!.seed).toBeTruthy();
    expect(battles[0]!.duration_ms).toBeLessThanOrEqual(60_000);
    expect(await count(db, "ruleset_snapshots")).toBe(1);
    expect(await count(db, "arena_queue_entries", "cycle_id is not null")).toBe(24);
    expect(await count(db, "arena_participants", "battle_id is not null")).toBe(24);
    const cycle = await db.query<{ seed: string; status: string; hero_count: number }>("select seed, status, hero_count from public.arena_cycles");
    expect(cycle[0]).toMatchObject({ status: "ACTIVE", hero_count: 24 });
  });

  it("every hero gets exactly ONE appearance per cycle before the pool is reshuffled", async () => {
    const heroes = await seedHeroes(db, 24); // 3 full groups
    await runUntil(async () => (await count(db, "arena_cycles", "status = 'COMPLETED'")) >= 1);
    const firstCycle = (await db.query<{ id: string }>("select id from public.arena_cycles order by number limit 1"))[0]!.id;
    const appearances = await db.query<{ character_id: string; n: number }>(
      `select e.character_id, count(*)::int as n from public.arena_queue_entries e
         join public.arena_participants p on p.battle_id = e.battle_id and p.character_id = e.character_id
        where e.cycle_id = $1 group by e.character_id`,
      [firstCycle],
    );
    expect(appearances).toHaveLength(24);
    expect(appearances.every((a) => a.n === 1)).toBe(true);
    expect(new Set(appearances.map((a) => a.character_id))).toEqual(new Set(heroes));
    // a second cycle with a NEW shuffle was created
    const seeds = await db.query<{ seed: string }>("select distinct seed from public.arena_cycles");
    expect(seeds.length).toBeGreaterThanOrEqual(2);
  });

  it("carries a final partial group forward instead of duplicating fighters", async () => {
    const heroes = await seedHeroes(db, 11);
    await runUntil(async () => (await count(db, "arena_cycles")) >= 2);
    const cycles = await db.query<{ id: string; number: number; status: string; carried_out_count: number; carried_in_count: number }>(
      "select id, number, status, carried_out_count, carried_in_count from public.arena_cycles order by number",
    );
    expect(cycles[0]).toMatchObject({ number: 1, status: "COMPLETED", carried_out_count: 3 });
    expect(cycles[1]).toMatchObject({ number: 2, carried_in_count: 3 });
    const carried = await db.query<{ character_id: string }>(
      "select character_id from public.arena_queue_entries where cycle_id = $1 and status = 'CARRIED_FORWARD'", [cycles[0]!.id],
    );
    expect(carried).toHaveLength(3);
    const front = await db.query<{ character_id: string; carried_in: boolean }>(
      "select character_id, carried_in from public.arena_queue_entries where cycle_id = $1 order by position limit 3", [cycles[1]!.id],
    );
    expect(new Set(front.map((f) => f.character_id))).toEqual(new Set(carried.map((c) => c.character_id)));
    expect(front.every((f) => f.carried_in)).toBe(true);
    // No battle ever contains the same hero twice.
    const dup = await db.query("select battle_id, character_id from public.arena_participants group by 1, 2 having count(*) > 1");
    expect(dup).toHaveLength(0);
    expect(new Set(heroes).size).toBe(11);
  });

  it("runs continuously: battles settle, Gold posts to the ledger, the Arena record grows — and nothing permanent (XP/level/stats/POWER) does", async () => {
    await seedHeroes(db, 16);
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 4);
    const wins = await db.query<{ n: number }>("select sum(arena_wins)::int as n from public.characters");
    expect(wins[0]!.n).toBe(await count(db, "arena_battles", "status = 'SETTLED'"));
    const battles = await db.query<{ n: number }>("select sum(arena_battles)::int as n from public.characters");
    expect(battles[0]!.n).toBe(8 * (await count(db, "arena_battles", "status = 'SETTLED'")));
    expect(await auditLedger(db)).toEqual([]);
    expect(await count(db, "currency_ledger")).toBeGreaterThan(0);
    // No permanent XP / level: the retired columns stay at their defaults for everyone who fought.
    expect(await count(db, "characters", "arena_battles > 0 and (xp <> 0 or level <> 1)")).toBe(0);
    expect(await count(db, "arena_participants", "xp_awarded <> 0")).toBe(0);
  });

  it("battle timing follows intro → 3·2·1 → combat (≤60 s) → victory → 5 s results, back to back", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const [a, b] = await db.query<{ starts_at: Date; combat_starts_at: Date | null; combat_ends_at: Date | null; slot_ends_at: Date | null }>(
      "select starts_at, combat_starts_at, combat_ends_at, slot_ends_at from public.arena_battles order by sequence",
    );
    expect(a!.combat_starts_at!.getTime() - a!.starts_at.getTime()).toBe(2500 + 3000);
    expect(a!.combat_ends_at!.getTime() - a!.combat_starts_at!.getTime()).toBeLessThanOrEqual(60_000);
    expect(a!.slot_ends_at!.getTime() - a!.combat_ends_at!.getTime()).toBe(1200 + 5000);
    expect(b!.starts_at.getTime()).toBe(a!.slot_ends_at!.getTime()); // next group starts immediately after results
  });

  it("is restart-safe: a fresh advance() resumes the persisted cycle without reshuffling", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const cycle1 = (await db.query<{ id: string; seed: string }>("select id, seed from public.arena_cycles where number = 1"))[0]!;
    const orderOf = () =>
      db.query<{ character_id: string; position: number }>("select character_id, position from public.arena_queue_entries where cycle_id = $1 order by position", [cycle1.id]);
    const before = await orderOf();
    // "Restart" several times mid-cycle with brand-new contexts (different seed source):
    // the persisted order and seed must never change, and no second cycle may be opened early.
    for (let i = 0; i < 4; i++) {
      clock.advance(7_000);
      await advanceArena(db, arenaCtx(clock, { secureSeed: () => `totally-different-seed-${i}` }));
    }
    expect(await orderOf()).toEqual(before);
    expect((await db.query<{ seed: string }>("select seed from public.arena_cycles where id = $1", [cycle1.id]))[0]!.seed).toBe(cycle1.seed);
    expect(await count(db, "arena_cycles", "status = 'ACTIVE'")).toBe(1);
  });

  it("battle settlement is idempotent and concurrent advance() calls never double-apply", async () => {
    await seedHeroes(db, 16);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    // A WORST-CASE slot, derived from the settings (intro + 3·2·1 + the full combat cap + victory beat + results), so the first battle is
    // certainly over whatever its seed made it last: under rules 3.0.0 a fight can run to 60 s, and a fixed 45 s made this test depend on luck.
    const a = DEFAULT_SETTINGS.arena;
    clock.advance(a.introMs + a.countdownMs + a.maxCombatMs + a.victoryHoldMs + a.resultsMs + 1000);
    await Promise.all(Array.from({ length: 8 }, () => advanceArena(db, ctx)));
    const settled = await count(db, "arena_battles", "status = 'SETTLED'");
    expect(settled).toBeGreaterThanOrEqual(1);
    const sumBattles = (await db.query<{ n: number }>("select sum(arena_battles)::int as n from public.characters"))[0]!.n;
    expect(sumBattles).toBe(8 * settled);
    const goldRows = await count(db, "currency_ledger", "reason = 'arena_reward'");
    expect(goldRows).toBeLessThanOrEqual(8 * settled);
    expect(await auditLedger(db)).toEqual([]);
    // Replaying the settle transition directly is a no-op
    const { settleBattle } = await import("@/server/services/arena");
    const { loadSettings } = await import("@/server/config/settingsRepo");
    const id = (await db.query<{ id: string }>("select id from public.arena_battles where status = 'SETTLED' limit 1"))[0]!.id;
    const again = await db.transaction(async (tx) => settleBattle(tx, ctx, id, await loadSettings(tx)));
    expect(again).toBe(false);
    const after = (await db.query<{ n: number }>("select sum(arena_battles)::int as n from public.characters"))[0]!.n;
    expect(after).toBe(sumBattles);
  });

  it("stored battles reproduce exactly from snapshot + seed + ruleset (replay integrity)", async () => {
    await seedHeroes(db, 16);
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 2);
    const rows = await db.query<{ id: string; events_hash: string; winner_id: string }>("select id, events_hash, winner_id from public.arena_battles where status = 'SETTLED'");
    for (const row of rows) {
      const replay = await replayBattle(db, row.id);
      expect(replay!.outcome.eventsHash).toBe(row.events_hash);
      expect(replay!.outcome.participants[replay!.outcome.ranking[0]!]!.characterId).toBe(row.winner_id);
      expect(replay!.outcome.frames!.length).toBeGreaterThan(0);
    }
  });

  it("frozen results: a settled battle cannot be rewritten", async () => {
    await seedHeroes(db, 16);
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 1);
    const id = (await db.query<{ id: string }>("select id from public.arena_battles where status = 'SETTLED' limit 1"))[0]!.id;
    await expect(db.query("update public.arena_battles set winner_id = runner_up_id where id = $1", [id])).rejects.toThrow(/frozen/);
    await expect(db.query("update public.arena_battles set seed = 'x' where id = $1", [id])).rejects.toThrow(/frozen/);
    await expect(db.query("update public.arena_battles set status = 'SCHEDULED' where id = $1", [id])).rejects.toThrow(/illegal battle transition/);
    await expect(db.query("update public.arena_participants set placement = 1 where battle_id = $1 and placement = 5", [id])).rejects.toThrow(/frozen/);
  });

  it("season separation: results are recorded against the season active when the battle ran", async () => {
    await seedHeroes(db, 16);
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 2);
    const s1 = (await db.query<{ id: string }>("select id from public.seasons where status = 'ACTIVE'"))[0]!.id;
    const s1Points = (await db.query<{ p: number }>("select coalesce(sum(points),0)::int as p from public.season_character_stats where season_id = $1", [s1]))[0]!.p;
    expect(s1Points).toBeGreaterThan(0);

    // Admin rolls the season over; permanent progression must be untouched, seasonal stats start fresh.
    const permanentBefore = (await db.query<{ n: number }>("select sum(arena_wins)::int as n from public.characters"))[0]!.n;
    await db.query("update public.seasons set status = 'ENDED', ends_at = now() + interval '1 day' where id = $1", [s1]);
    await db.query("insert into public.seasons (kind, run_number, name, status) values ('DEVELOPMENT', 2, 'Development run 2', 'ACTIVE')");
    // Two battles are always prepared ahead, so the battles already queued under season 1 settle first (one more than before).
    await runUntil(async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 6);
    const s2 = (await db.query<{ id: string }>("select id from public.seasons where run_number = 2"))[0]!.id;
    const s2Battles = (await db.query<{ n: number }>("select coalesce(sum(battles),0)::int as n from public.season_character_stats where season_id = $1", [s2]))[0]!.n;
    expect(s2Battles).toBeGreaterThan(0);
    const s1After = (await db.query<{ p: number }>("select coalesce(sum(points),0)::int as p from public.season_character_stats where season_id = $1", [s1]))[0]!.p;
    // Battles already scheduled under season 1 may still settle there; nothing new accrues after the rollover completes.
    expect(s1After).toBeGreaterThanOrEqual(s1Points);
    const permanentAfter = (await db.query<{ n: number }>("select sum(arena_wins)::int as n from public.characters"))[0]!.n;
    expect(permanentAfter).toBeGreaterThan(permanentBefore); // permanent progression keeps accruing
    // Every season's stats sum to exactly the settled battles that belong to THAT season.
    const perSeason = await db.query<{ season_id: string; stat_battles: number; settled: number }>(
      `select s.id as season_id,
              coalesce((select sum(battles)::int from public.season_character_stats x where x.season_id = s.id), 0) as stat_battles,
              (select count(*)::int from public.arena_battles b where b.season_id = s.id and b.status = 'SETTLED') as settled
         from public.seasons s`,
    );
    for (const row of perSeason) expect(row.stat_battles).toBe(row.settled * 8);
  });

  it("a paused Arena stops all progression", async () => {
    await seedHeroes(db, 16);
    await db.exec("update public.arena_state set status = 'PAUSED'");
    const r = await advanceArena(db, arenaCtx(clock));
    expect(r.status).toBe("PAUSED");
    expect(await count(db, "arena_battles")).toBe(0);
  });

  it("an Arena that has not been started makes no battle, however many heroes and however long the wait", async () => {
    await seedHeroes(db, 24);
    await db.exec("update public.arena_state set status = 'PAUSED'");
    await db.exec("update public.arena_state set status = 'NOT_STARTED'");
    for (let i = 0; i < 120; i++) {
      const r = await advanceArena(db, arenaCtx(clock));
      expect(r.status).toBe("NOT_STARTED");
      clock.advance(5000);
    }
    expect(await count(db, "arena_battles")).toBe(0);
    expect(await count(db, "arena_cycles")).toBe(0);
  });

  it("skips heroes who are banned after the cycle was planned (no empty slot, no duplicate)", async () => {
    const heroes = await seedHeroes(db, 40); // five groups: three are on stage / prepared at once, two are still waiting in the persisted queue
    await advanceArena(db, arenaCtx(clock));
    const banned = (await db.query<{ character_id: string }>("select character_id from public.arena_queue_entries where status = 'PENDING' order by position limit 2")).map((r) => r.character_id);
    await db.query("update public.characters set status = 'SUSPENDED' where id in (select (jsonb_array_elements_text($1::jsonb))::uuid)", [JSON.stringify(banned)]);
    await runUntil(async () => (await count(db, "arena_cycles", "status = 'COMPLETED'")) >= 1);
    const first = (await db.query<{ id: string }>("select id from public.arena_cycles order by number limit 1"))[0]!.id;
    expect(await count(db, "arena_queue_entries", `cycle_id = '${first}' and status = 'SKIPPED'`)).toBe(2);
    const sizes = await db.query<{ n: number }>("select count(*)::int as n from public.arena_participants group by battle_id");
    expect(sizes.every((s) => s.n === 8)).toBe(true);
    for (const id of banned) expect(await count(db, "arena_participants", `character_id = '${id}'`)).toBe(0);
    expect(heroes).toHaveLength(40);
  });
});
