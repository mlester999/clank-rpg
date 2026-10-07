import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { adminOverview, patchHero } from "@/server/services/admin";
import { arenaPopulation } from "@/server/services/arenaEligibility";
import { startArena } from "@/server/services/lifecycle";
import { getArenaState } from "@/server/services/views";
import { createRng } from "@/domain/util/rng";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { adminDeps, freshDevelopment, runUntil } from "../support/lifecycle";

/**
 * A suspended / banned hero never enters a NEWLY made roster — enforced on the server, in the scheduler and in the database — while a roster that has
 * already been exposed (on stage, announced as the upcoming battle with Picks open, prepared behind it) is never rewritten.
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
  await freshDevelopment(db);
  clock = new FakeClock();
});

const suspend = (id: string) => patchHero(db, id, { status: "SUSPENDED" }, "test-admin");
const reactivate = (id: string) => patchHero(db, id, { status: "ACTIVE" }, "test-admin");
const roster = async (battleId: string): Promise<string[]> => (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 order by character_id", [battleId])).map((r) => r.character_id);
const battles = () => db.query<{ id: string; sequence: number; status: string; cycle_id: string; snapshot_hash: string | null }>("select id, sequence, status, cycle_id, md5(snapshot::text) as snapshot_hash from public.arena_battles order by sequence");
const stateNow = async () => getArenaState(db, clock.ms, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });

/** 24 heroes, the Arena started: battle #1 on stage, #2 (the Picks target) and #3 prepared behind it — three disjoint rosters. */
async function runningWith(n = 24): Promise<{ heroes: string[]; b: Awaited<ReturnType<typeof battles>> }> {
  const heroes = await seedHeroes(db, n);
  await startArena(db, adminDeps(clock));
  await advanceArena(db, arenaCtx(clock));
  return { heroes, b: await battles() };
}

describe("A) a hero who is not queued", () => {
  it("suspended before it ever entered a roster: never enters one — across cycle after cycle", async () => {
    const { heroes } = await runningWith(24);
    const [extra] = await seedHeroes(db, 1); // joins after the first cycle was planned (so it is not queued)
    await suspend(extra!);
    expect(heroes).not.toContain(extra);
    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= 3);
    expect(await count(db, "arena_participants", `character_id = '${extra}'`)).toBe(0);
    expect(await count(db, "arena_queue_entries", `character_id = '${extra}'`)).toBe(0);
    // the cycles were planned from the eligible set only (24, not 25)
    const cycles = await db.query<{ hero_count: number }>("select hero_count from public.arena_cycles order by number");
    expect(cycles.map((c) => Number(c.hero_count))).toEqual(cycles.map(() => 24));
  });
});

describe("B) a hero in the CURRENT battle", () => {
  it("keeps its place in the frozen battle (snapshot, roster, result), finishes the fight, and is excluded from every roster made afterwards", async () => {
    const { b } = await runningWith(24);
    const current = b[0]!;
    const x = (await roster(current.id))[0]!;
    const rosterBefore = await roster(current.id);
    const snapshotBefore = current.snapshot_hash;
    await suspend(x);
    expect(await roster(current.id)).toEqual(rosterBefore);
    expect((await battles())[0]!.snapshot_hash).toBe(snapshotBefore);

    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= 3 && (await count(db, "arena_battles", "status = 'SETTLED'")) >= 7);
    const first = (await db.query<{ status: string; winner_id: string | null }>("select status, winner_id from public.arena_battles where id = $1", [current.id]))[0]!;
    expect(first.status).toBe("SETTLED");
    expect(await roster(current.id)).toEqual(rosterBefore);
    // its own placement was recorded (it fought), but it is in no roster created after the suspension
    expect((await db.query<{ placement: number | null }>("select placement from public.arena_participants where battle_id = $1 and character_id = $2", [current.id, x]))[0]!.placement).not.toBeNull();
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBe(1);
    // the second cycle was planned from the 23 who may fight
    const cycles = await db.query<{ number: number; hero_count: number }>("select number, hero_count from public.arena_cycles order by number");
    expect(Number(cycles[1]!.hero_count)).toBe(23);
  });
});

describe("C) a hero in the UPCOMING battle (the Arena Picks target)", () => {
  it("the announced roster is NOT rewritten — players may already have picked on it — the hero fights that frozen appearance, then is excluded", async () => {
    const { b } = await runningWith(24);
    const upcoming = b[1]!;
    const x = (await roster(upcoming.id))[0]!;
    const before = await stateNow();
    expect(before.upcoming!.id).toBe(upcoming.id);
    expect(before.upcoming!.fighters.map((f) => f.characterId)).toContain(x);
    const fightersBefore = before.upcoming!.fighters.map((f) => f.characterId);

    await suspend(x);
    const after = await stateNow();
    expect(after.upcoming!.fighters.map((f) => f.characterId)).toEqual(fightersBefore); // the public roster did not change by a single name
    expect((await battles())[1]!.snapshot_hash).toBe(upcoming.snapshot_hash);

    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= 3 && (await count(db, "arena_battles", "status = 'SETTLED'")) >= 7);
    expect((await db.query<{ placement: number | null }>("select placement from public.arena_participants where battle_id = $1 and character_id = $2", [upcoming.id, x]))[0]!.placement).not.toBeNull(); // it fought
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBe(1); // …once, and never again
  });
});

describe("D) a hero in the SECOND prepared roster", () => {
  it("the frozen snapshot is preserved; the hero is excluded after it", async () => {
    const { b } = await runningWith(24);
    const second = b[2]!;
    expect(second.status).toBe("SIMULATED");
    const x = (await roster(second.id))[0]!;
    const rosterBefore = await roster(second.id);
    await suspend(x);
    expect(await roster(second.id)).toEqual(rosterBefore);
    expect((await battles())[2]!.snapshot_hash).toBe(second.snapshot_hash);
    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= 3 && (await count(db, "arena_battles", "status = 'SETTLED'")) >= 7);
    expect(await roster(second.id)).toEqual(rosterBefore);
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBe(1);
  });
});

describe("E) reactivation returns FUTURE eligibility — it never injects a hero into a roster that exists", () => {
  it("suspended before the next cycle is planned → back in the cycle after it is planned from the eligible set", async () => {
    const { b } = await runningWith(24);
    const x = (await roster(b[0]!.id))[0]!;
    await suspend(x);
    await reactivate(x); // reactivated before anything was planned without it
    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= 3);
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBeGreaterThanOrEqual(2); // fought again in a later cycle
  });

  it("reactivated AFTER cycles were planned without it: not inserted into those cycles' battles — it takes its place in the NEXT cycle that is planned", async () => {
    const heroes = await seedHeroes(db, 24);
    const x = heroes[0]!;
    await suspend(x);
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock)); // the first cycle (and, with a leftover of seven, the second) are planned from the 23 eligible heroes
    const plannedBefore = await db.query<{ id: string; number: number; hero_count: number }>("select id, number, hero_count from public.arena_cycles order by number");
    expect(plannedBefore.length).toBeGreaterThanOrEqual(1);
    expect(Number(plannedBefore[0]!.hero_count)).toBe(23);
    const rostersBefore = new Map<string, string[]>();
    for (const bt of await battles()) rostersBefore.set(bt.id, await roster(bt.id));
    await reactivate(x); // eligible again — but those cycles are planned and their rosters frozen
    await runUntil(db, clock, async () => (await count(db, "arena_cycles")) >= plannedBefore.length + 2 && (await count(db, "arena_battles", "status = 'SETTLED'")) >= 8);
    for (const [id, was] of rostersBefore) expect(await roster(id), "a roster that existed is never changed").toEqual(was);
    for (const c of plannedBefore) expect(await count(db, "arena_queue_entries", `cycle_id = '${c.id}' and character_id = '${x}'`), `cycle ${c.number} was planned without it`).toBe(0);
    // the first cycle planned after the reactivation includes it — once
    const next = (await db.query<{ id: string; hero_count: number }>("select id, hero_count from public.arena_cycles where number > $1 order by number limit 1", [Math.max(...plannedBefore.map((c) => Number(c.number)))]))[0]!;
    expect(Number(next.hero_count)).toBe(24);
    expect(await count(db, "arena_queue_entries", `cycle_id = '${next.id}' and character_id = '${x}'`)).toBe(1);
  });
});

describe("F) a restarted worker", () => {
  it("still excludes the suspended hero: the exclusion is read from the database, not remembered by the process", async () => {
    const { b } = await runningWith(24);
    const x = (await roster(b[0]!.id))[0]!;
    await suspend(x);
    for (let restart = 0; restart < 4; restart++) {
      const settled = await count(db, "arena_battles", "status = 'SETTLED'");
      await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= settled + 2); // each loop is a new "process"
    }
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBe(1);
  });
});

describe("a BANNED member is excluded exactly like a suspended hero", () => {
  it("even when the hero row itself is still ACTIVE (the predicate reads the member too) — and the database refuses to roster them", async () => {
    const heroes = await seedHeroes(db, 24);
    const x = heroes[0]!;
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = (select telegram_user_id from public.characters where id = $1)", [x]);
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await count(db, "arena_battles", "status = 'SETTLED'")) >= 4);
    expect(await count(db, "arena_participants", `character_id = '${x}'`)).toBe(0);
    const pop = await arenaPopulation(db, true);
    expect(pop).toMatchObject({ total: 24, eligible: 23, suspended: 0, bannedMember: 1 });
    // the database itself: a roster cannot be INSERTED for a hero that is not ACTIVE or whose member is banned
    const [bt] = await db.query<{ id: string }>("select id from public.arena_battles where status = 'SIMULATED' order by sequence limit 1");
    await expect(db.query("insert into public.arena_participants (battle_id, character_id) values ($1, $2)", [bt!.id, x])).rejects.toThrow(/banned cannot enter a new roster|cannot enter a new roster/);
    await db.query("update public.telegram_users set status = 'OK'");
    const y = heroes[1]!;
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [y]);
    await expect(db.query("insert into public.arena_participants (battle_id, character_id) values ($1, $2)", [bt!.id, y])).rejects.toThrow(/suspended cannot enter a new roster/);
  });
});

describe("TOTAL heroes and ARENA-ELIGIBLE heroes are different numbers", () => {
  it("a suspended hero is not missing, deleted or in need of regeneration: it still exists, with everything intact", async () => {
    const heroes = await seedHeroes(db, 20);
    for (const id of heroes.slice(0, 5)) await suspend(id);
    expect(await arenaPopulation(db, true)).toMatchObject({ total: 20, eligible: 15, suspended: 5, inactive: 0, bannedMember: 0 });
    const overview = await adminOverview(db, true);
    expect(overview.counts).toMatchObject({ heroes: 20, arena_eligible_heroes: 15, suspended_heroes: 5 });
    expect(await count(db, "characters")).toBe(20);
    expect(await count(db, "hero_versions")).toBe(20);
    expect(await count(db, "character_appearances")).toBe(20);
  });
});

describe("every scheduling path, against a random timeline of suspensions and reactivations", () => {
  it("no battle made while a hero is suspended contains it; every roster is eight different heroes; every cycle holds each hero at most once", async () => {
    const heroes = await seedHeroes(db, 27); // three full groups and a leftover of three each cycle → carried leftovers are exercised
    await startArena(db, adminDeps(clock));
    const rng = createRng("suspension-timeline");
    const ctx = arenaCtx(clock);
    const suspended = new Set<string>();
    const violations: string[] = [];
    let seen = 0;
    for (let step = 0; step < 4200; step++) {
      // every ~15 s of fake time, flip a random hero
      if (step % 15 === 0) {
        const id = rng.pick(heroes);
        if (suspended.has(id)) {
          await reactivate(id);
          suspended.delete(id);
        } else if (suspended.size < 6) {
          await suspend(id);
          suspended.add(id);
        }
      }
      const frozen = new Set(suspended);
      await advanceArena(db, ctx);
      const fresh = await db.query<{ id: string; sequence: number; fighters: string[] }>(
        `select b.id, b.sequence, array_agg(p.character_id::text) as fighters from public.arena_battles b join public.arena_participants p on p.battle_id = b.id where b.sequence > $1 group by b.id, b.sequence order by b.sequence`,
        [seen],
      );
      for (const bt of fresh) {
        seen = Math.max(seen, Number(bt.sequence));
        for (const f of bt.fighters) if (frozen.has(f)) violations.push(`battle #${bt.sequence} made while ${f} was suspended`);
        if (new Set(bt.fighters).size !== 8) violations.push(`battle #${bt.sequence} has ${bt.fighters.length} fighters / ${new Set(bt.fighters).size} distinct`);
      }
      clock.advance(1000);
      if ((await count(db, "arena_battles", "status = 'SETTLED'")) >= 40) break;
    }
    expect(violations).toEqual([]);
    expect(await count(db, "arena_battles", "status = 'SETTLED'")).toBeGreaterThanOrEqual(40);
    const dupes = await db.query<{ cycle_id: string; character_id: string }>("select cycle_id, character_id from public.arena_queue_entries group by cycle_id, character_id having count(*) > 1");
    expect(dupes).toEqual([]);
    const inTwo = await db.query<{ battle_id: string }>("select battle_id from public.arena_participants group by battle_id having count(*) <> 8");
    expect(inTwo).toEqual([]);
    expect((await db.query("select * from public.audit_game_lifecycle()")).length).toBe(0);
  });
});
