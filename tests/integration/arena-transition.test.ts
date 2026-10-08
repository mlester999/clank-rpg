import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { phaseNow } from "@/components/arena/phase";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { submitPick } from "@/server/services/picks";
import { getArenaState, getReplayDto, type ArenaStateDto } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedEligibleMember, seedHeroes } from "../support/db";

/**
 * The seam between two battles. The next TWO battles are prepared (simulated + persisted) as soon as there is room — the first is
 * the UPCOMING battle (the Arena Picks target), the second is the one the picks panel moves on to — so that when the previous
 * results timer ends the flip is a pure clock read: no simulation, no scheduling, nothing left to wait for, however far away the
 * database is, and the picks panel never has an empty frame.
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

async function stateAt(ms: number): Promise<ArenaStateDto> {
  const settings = await loadSettings(db);
  return getArenaState(db, ms, settings, { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
}

interface BattleRow {
  id: string;
  sequence: number;
  status: string;
  starts_at: Date;
  slot_ends_at: Date | null;
  combat_starts_at: Date | null;
  combat_ends_at: Date | null;
  winner_id: string | null;
}
const battles = () =>
  db.query<BattleRow>("select id, sequence, status, starts_at, slot_ends_at, combat_starts_at, combat_ends_at, winner_id from public.arena_battles order by sequence");
const ms = (d: Date | null) => (d ? new Date(d).getTime() : 0);
/** Every object key anywhere in a JSON-able value. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}
const participants = async (battleId: string) =>
  (await db.query<{ character_id: string; name: string }>("select p.character_id, c.name from public.arena_participants p join public.characters c on c.id = p.character_id where p.battle_id = $1", [battleId]));

/** Starts battle #1 and returns its row once it has been settled and #2/#3 prepared (clock parked just after combat end). */
async function reachResultsOfFirstBattle(heroes = 16) {
  await seedHeroes(db, heroes);
  const ctx = arenaCtx(clock);
  await advanceArena(db, ctx);
  const [b1] = await battles();
  clock.ms = ms(b1!.combat_ends_at) + 10;
  const r = await advanceArena(db, ctx);
  return { ctx, b1: b1!, r };
}

describe("the next battle is prepared before the results screen ends", () => {
  it("prepares the next TWO battles as soon as they exist — a whole battle ahead of their slots, long before the previous fight ends", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    const r = await advanceArena(db, ctx);
    // One advance: #1 scheduled + simulated (and its own pick window stamped — nothing precedes it), then #2 and #3 lined up AND
    // simulated; nothing is left to do until the battle on stage is decided.
    expect(r.steps.map((s) => s.split(":")[0])).toEqual(["scheduled", "simulated", "locked", "scheduled", "simulated", "scheduled", "simulated"]);
    const [b1, b2, b3] = await battles();
    expect([b1!.status, b2!.status, b3!.status]).toEqual(["SIMULATED", "SIMULATED", "SIMULATED"]);
    expect(ms(b2!.starts_at)).toBe(ms(b1!.slot_ends_at)); // gapless
    expect(ms(b3!.starts_at)).toBe(ms(b2!.slot_ends_at));
    // The upcoming battle was ready (30 s here) before its slot — not in the few seconds between the previous fight and its results.
    expect(ms(b2!.starts_at) - clock.ms).toBeGreaterThan(ms(b1!.combat_ends_at) - ms(b1!.combat_starts_at));
    // At combat end the only work left is the lock stamp of the upcoming battle and bookkeeping.
    clock.ms = ms(b1!.combat_ends_at) + 10;
    expect((await advanceArena(db, ctx)).steps.map((s) => s.split(":")[0])).toEqual(["locked", "settled"]);
    expect((await battles()).map((b) => b.status)).toEqual(["SETTLED", "SIMULATED", "SIMULATED"]);
  });

  it("settlement never gates preparation: even when a hero is in both rosters the next battle is ready before the first one ends", async () => {
    await seedHeroes(db, 12); // 8 fight, 4 are carried into the next cycle, which re-draws 4 of the 8 who just fought
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [first, second] = await battles();
    expect(second!.status).toBe("SIMULATED"); // prepared at once…
    const overlap = await db.query("select 1 from public.arena_participants a join public.arena_participants b on b.character_id = a.character_id where a.battle_id = $1 and b.battle_id = $2", [first!.id, second!.id]);
    expect(overlap.length).toBeGreaterThan(0); // …although the same hero is in both
    clock.ms = ms(first!.combat_ends_at) + 10;
    expect((await advanceArena(db, ctx)).steps.map((s) => s.split(":")[0])).toEqual(["locked", "settled"]);
  });

  it("a battle that could not be made ready before its planned start moves its OWN start to just after it is ready, so no viewer joins mid-fight", async () => {
    await seedHeroes(db, 40);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1, b2, b3] = await battles();
    // Drop the prepared battles (as an operator voiding them would), then let the arena come back 2 s AFTER the slot they should have filled.
    for (const b of [b2!, b3!]) {
      await db.query("update public.arena_battles set status = 'VOID' where id = $1", [b.id]);
      await db.query("update public.arena_queue_entries set status = 'PENDING', battle_id = null where battle_id = $1 and status = 'IN_BATTLE'", [b.id]);
    }
    clock.ms = ms(b1!.slot_ends_at) + 2000;
    await advanceArena(db, ctx);
    const next = (await battles()).find((b) => b.sequence === 4)!;
    expect(next.status).toBe("SIMULATED");
    // Its planned start (the previous slot's end) was already 2 s gone — so it did NOT keep it: it starts now, with its whole opening.
    expect(ms(next.starts_at)).toBe(clock.ms);
    const s = await stateAt(clock.ms);
    expect(s.current!.id).toBe(next.id);
    expect(phaseNow(s.current!, clock.ms, 3000, 30_000)).toMatchObject({ phase: "INTRO", sinceStart: 0 });
  });

  it("the result phase lasts 5 s and the next battle is ready for its whole length", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const resultsStart = ms(b1.combat_ends_at) + 1200;
    expect(ms(b1.slot_ends_at) - resultsStart).toBe(5000);
    for (const t of [resultsStart, resultsStart + 2500, ms(b1.slot_ends_at) - 1]) {
      const s = await stateAt(t);
      expect(s.current!.id).toBe(b1.id); // results still on screen
      expect(s.current!.results).toHaveLength(8);
      expect(s.next).not.toBeNull(); // …and the next battle is already known to exist
      expect(s.next!.startsAt).toBe(ms(b1.slot_ends_at));
      // The picks panel already shows the UPCOMING eight, locked since the winner on stage was decided.
      expect(s.upcoming!.id).toBe(s.next!.id);
      expect(s.upcoming!.fighters).toHaveLength(8);
      expect(s.upcoming!.picks.status).toBe("LOCKED");
      expect(s.upcoming!.picks.lockReason).toBe("PREDECESSOR_DECIDED");
    }
    expect(phaseNow(((await stateAt(resultsStart)).current)!, resultsStart, 3000, 30_000).phase).toBe("RESULTS");
  });

  it("zero-second transition: at the instant the slot ends the next eight are on stage — a pure clock read, no advance needed", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const [, b2, b3] = await battles();
    const T = ms(b1.slot_ends_at);
    expect((await stateAt(T - 1)).current!.id).toBe(b1.id);
    expect((await stateAt(T - 1)).upcoming!.id).toBe(b2!.id);
    const before = await count(db, "arena_battles");
    const s = await stateAt(T); // NOTE: advanceArena is deliberately not called
    expect(await count(db, "arena_battles")).toBe(before);
    expect(s.current!.id).toBe(b2!.id);
    expect(s.current!.fighters).toHaveLength(8);
    expect(s.current!.results).toBeNull();
    expect(new Set(s.current!.fighters.map((f) => f.characterId)).size).toBe(8);
    // In the SAME snapshot the picks panel has already moved on to the battle after it — never an empty frame, never the battle on stage.
    expect(s.upcoming!.id).toBe(b3!.id);
    expect(s.upcoming!.id).not.toBe(s.current!.id);
    expect(s.upcoming!.fighters).toHaveLength(8);
    expect(s.upcoming!.picks.status).toBe("OPEN");
    expect(phaseNow(s.current!, T, 3000, 30_000).phase).toBe("INTRO");
    // The 8 on stage are NOT the 8 who just fought.
    const prev = new Set((await participants(b1.id)).map((p) => p.character_id));
    expect(s.current!.fighters.some((f) => prev.has(f.characterId))).toBe(false);
  });

  it("keeps two battles prepared ahead: the moment the upcoming one takes the stage the next is lined up behind it (off the boundary's path)", async () => {
    const { ctx, b1 } = await reachResultsOfFirstBattle();
    expect(await count(db, "arena_battles")).toBe(3); // #1 settled, #2 upcoming, #3 behind it
    clock.ms = ms(b1.slot_ends_at) + 5;
    const r = await advanceArena(db, ctx);
    expect(r.steps.filter((s) => s.startsWith("scheduled:"))).toHaveLength(1);
    expect(await count(db, "arena_battles")).toBe(4);
  });
});

describe("what is published about the upcoming battle — and what never is", () => {
  it("publishes the upcoming roster (identity + POWER only) but never its outcome, slots, hit points, ranking or replay — and nothing at all about the battle behind it", async () => {
    const { b1 } = await reachResultsOfFirstBattle(24); // 24 heroes: #1, #2 and #3 are three disjoint groups
    const [, b2, b3] = await battles();
    const behind = await participants(b3!.id);
    const T = ms(b1.slot_ends_at);
    for (const t of [clock.ms, ms(b1.combat_ends_at) + 1200, T - 1]) {
      const s = await stateAt(t);
      expect(s.upcoming!.id).toBe(b2!.id);
      expect(Object.keys(s.upcoming!).sort()).toEqual(["fighters", "id", "number", "picks", "startsAt"]);
      expect(Object.keys(s.upcoming!.picks).sort()).toEqual(["lockReason", "lockedAt", "locksAt", "mode", "status"]);
      for (const f of s.upcoming!.fighters) expect(Object.keys(f).sort()).toEqual(["appearance", "avatarUrl", "characterId", "claimed", "classId", "isDemo", "name", "power", "publicId", "title"]); // publicId = the public profile link, nothing about the fight
      const roster = new Set((await participants(b2!.id)).map((p) => p.character_id));
      expect(new Set(s.upcoming!.fighters.map((f) => f.characterId))).toEqual(roster); // exactly who will fight
      const upcomingWire = JSON.stringify(s.upcoming);
      const keys = allKeys(s.upcoming);
      for (const forbidden of ["ranking", "placement", "winner", "winnerId", "slot", "maxHp", "startPosition", "events", "eventsHash", "seed", "result", "results", "replay", "hasReplay", "sequence", "finalHp"]) expect(keys.has(forbidden), forbidden).toBe(false);
      expect(upcomingWire.includes(b2!.winner_id as string) && !roster.has(b2!.winner_id as string)).toBe(false);
      // The battle BEHIND the upcoming one is not published at all (only the upcoming and the current battle ever are).
      const wire = JSON.stringify(s);
      for (const p of behind) {
        expect(wire.includes(p.character_id)).toBe(false);
        expect(wire.includes(`"${p.name}"`)).toBe(false);
      }
      expect(s.recent.some((x) => x.id === b2!.id)).toBe(false);
    }
  });

  it("the roster shown is the roster that fights: it is final once prepared and the database refuses to change it", async () => {
    await reachResultsOfFirstBattle(30); // 30 heroes: #1–#3 are on stage / prepared, six more wait in the queue
    const [, b2] = await battles();
    const [member] = await participants(b2!.id);
    const [stranger] = await db.query<{ id: string }>("select id from public.characters where id <> all (select character_id from public.arena_participants) limit 1");
    await expect(db.query("insert into public.arena_participants (battle_id, character_id) values ($1, $2)", [b2!.id, stranger!.id])).rejects.toThrow(/roster of a prepared battle is final/);
    await expect(db.query("delete from public.arena_participants where battle_id = $1 and character_id = $2", [b2!.id, member!.character_id])).rejects.toThrow(/roster of a prepared battle is final/);
    expect(await participants(b2!.id)).toHaveLength(8);
  });

  it("only the UPCOMING battle is open for picks: the battle on stage and the one behind the upcoming one both refuse — even to someone who knows a real fighter's id", async () => {
    const { b1 } = await reachResultsOfFirstBattle(24);
    const [, b2, b3] = await battles();
    const T = ms(b1.slot_ends_at);
    // Put the clock where #2 is on stage (decided #1, settled) and #3 is the upcoming battle: picks on #3 are open.
    const at = (t: number) => ({ now: () => new Date(t), allowDemo: true });
    const [b3Fighter] = await participants(b3!.id);
    const [b2Fighter] = await participants(b2!.id);
    await seedEligibleMember(db, { id: 424242 });
    clock.ms = T + 100;
    await advanceArena(db, arenaCtx(clock));
    expect(await submitPick(db, at(T + 100), { telegramUserId: 424242, battleId: b2!.id, characterId: b2Fighter!.character_id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).toEqual({ ok: false, reason: "LOCKED" }); // on stage
    expect((await submitPick(db, at(T + 100), { telegramUserId: 424242, battleId: b3!.id, characterId: b3Fighter!.character_id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).ok).toBe(true); // upcoming
    // A hero that is NOT in the battle is refused as such.
    const outsider = (await db.query<{ id: string }>("select id from public.characters where id <> all (select character_id from public.arena_participants where battle_id = $1) limit 1", [b3!.id]))[0]!;
    expect(await submitPick(db, at(T + 100), { telegramUserId: 424242, battleId: b3!.id, characterId: outsider.id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).toEqual({ ok: false, reason: "NOT_A_FIGHTER" });
  });

  it("the battle BEHIND the upcoming one cannot be picked on (NOT_OPEN) — it is not the next fight", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [, , b3] = await battles();
    const [f] = await participants(b3!.id);
    await seedEligibleMember(db, { id: 424250 });
    expect(await submitPick(db, { now: clock.now, allowDemo: true }, { telegramUserId: 424250, battleId: b3!.id, characterId: f!.character_id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).toEqual({ ok: false, reason: "NOT_OPEN" });
  });

  it("opens picks on the upcoming battle the instant the previous one takes the stage and closes them when that battle is decided", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const [, b2] = await battles();
    const [first] = await participants(b2!.id);
    await seedEligibleMember(db, { id: 424243 });
    const at = (t: number) => ({ now: () => new Date(t), allowDemo: true });
    // b2 is locked since b1 was decided …
    expect(await submitPick(db, at(ms(b1.combat_ends_at) + 10), { telegramUserId: 424243, battleId: b2!.id, characterId: first!.character_id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).toEqual({ ok: false, reason: "LOCKED" });
    // … and nothing about its OWN combat start matters any more.
    expect(await submitPick(db, at(ms(b2!.combat_starts_at)), { telegramUserId: 424243, battleId: b2!.id, characterId: first!.character_id, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold })).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("withholds the replay (which contains the whole outcome) from before the slot until combat starts", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const [, b2] = await battles();
    const T = ms(b1.slot_ends_at);
    expect(await getReplayDto(db, b2!.id, clock.ms)).toBeNull(); // prepared, waiting (its picks are already locked)
    expect(await getReplayDto(db, b2!.id, T - 1)).toBeNull();
    expect(await getReplayDto(db, b2!.id, T + 1)).toBeNull(); // on stage, intro
    expect(await getReplayDto(db, b2!.id, ms(b2!.combat_starts_at) - 1)).toBeNull(); // last ms before the fight
    expect(await getReplayDto(db, b2!.id, ms(b2!.combat_starts_at))).not.toBeNull();
  });
});

describe("a continuous run: no duplicate, no skipped, no overlapping battle", () => {
  it("every battle is seen on stage exactly once, back to back, with no gap and nobody fighting twice at once", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    const seen: Array<{ id: string; sequence: number }> = [];
    for (let i = 0; i < 1800 && seen.length < 7; i++) {
      await advanceArena(db, ctx);
      const cur = (await stateAt(clock.ms)).current;
      if (cur && seen[seen.length - 1]?.id !== cur.id) seen.push({ id: cur.id, sequence: cur.sequence });
      clock.advance(500);
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen.map((s) => s.id)).size).toBe(7); // no duplicates
    expect(seen.map((s) => s.sequence)).toEqual(Array.from({ length: 7 }, (_, i) => seen[0]!.sequence + i)); // no skips
    const all = await battles();
    for (let i = 1; i < all.length; i++) expect(ms(all[i]!.starts_at)).toBe(ms(all[i - 1]!.slot_ends_at)); // gapless, never overlapping
    // Nothing is queued more than two battles beyond what is on stage.
    expect(all.length - seen.length).toBeLessThanOrEqual(2);
    expect(await db.query("select 1 from public.arena_participants group by battle_id, character_id having count(*) > 1")).toHaveLength(0);
  });

  it("many callers at the seam (viewers, a cron tick and a worker at once) still produce exactly one next battle", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const ctx = arenaCtx(clock);
    clock.ms = ms(b1.slot_ends_at) + 5;
    const before = await count(db, "arena_battles");
    await Promise.all(Array.from({ length: 6 }, () => advanceArena(db, ctx)));
    expect(await count(db, "arena_battles")).toBe(before + 1);
    const sequences = (await battles()).map((b) => b.sequence);
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => sequences[0]! + i));
  });
});

describe("the queue scales to the 139-hero post-backfill roster", () => {
  it("keeps two battles prepared, recovers after restart, and carries the 3-of-139 remainder fairly", async () => {
    const roster = await seedHeroes(db, 139);
    const ctx = arenaCtx(clock);
    const startedAt = performance.now();
    await advanceArena(db, ctx);
    const initialLineupMs = performance.now() - startedAt;

    const cycleOne = (await db.query<{ id: string; status: string; hero_count: number }>(
      "select id, status, hero_count from public.arena_cycles where number = 1",
    ))[0]!;
    expect(cycleOne.hero_count).toBe(139);
    const firstLineup = await battles();
    expect(firstLineup.filter((battle) => battle.status === "SIMULATED")).toHaveLength(3); // current + two prepared ahead
    expect(firstLineup.filter((battle) => ms(battle.starts_at) > clock.ms)).toHaveLength(2);
    const beforeRestart = await count(db, "arena_battles");
    expect((await advanceArena(db, arenaCtx(clock, { secureSeed: () => "restart-seed" }))).steps).toEqual([]);
    expect(await count(db, "arena_battles")).toBe(beforeRestart);

    // Run through the first 17 full groups. The 18th group causes the 3-person remainder to move into cycle 2.
    for (let i = 0; i < 120 && await count(db, "arena_cycles", "number >= 2") === 0; i++) {
      const simulated = await db.query<{ starts_at: Date; combat_ends_at: Date | null }>(
        "select starts_at, combat_ends_at from public.arena_battles where status = 'SIMULATED' order by sequence",
      );
      const onStage = simulated.find((battle) => ms(battle.starts_at) <= clock.ms);
      const nextAt = onStage ? ms(onStage.combat_ends_at) + 10 : ms(simulated[0]?.starts_at ?? null) + 10;
      if (nextAt > clock.ms) clock.ms = nextAt;
      await advanceArena(db, ctx);
    }
    const cycleTwo = (await db.query<{ id: string; status: string; hero_count: number; carried_in_count: number }>(
      "select id, status, hero_count, carried_in_count from public.arena_cycles where number = 2",
    ))[0];
    expect(cycleTwo).toMatchObject({ hero_count: 139, carried_in_count: 3 });

    const firstEntries = await db.query<{ character_id: string; status: string }>(
      "select character_id, status from public.arena_queue_entries where cycle_id = $1 order by position",
      [cycleOne.id],
    );
    expect(firstEntries).toHaveLength(139);
    expect(new Set(firstEntries.map((entry) => entry.character_id)).size).toBe(139);
    const carry = firstEntries.filter((entry) => entry.status === "CARRIED_FORWARD").map((entry) => entry.character_id);
    expect(carry).toHaveLength(3);
    const foughtInCycleOne = await db.query<{ character_id: string }>(
      "select p.character_id from public.arena_participants p join public.arena_battles b on b.id = p.battle_id where b.cycle_id = $1",
      [cycleOne.id],
    );
    expect(foughtInCycleOne).toHaveLength(136);
    expect(new Set(foughtInCycleOne.map((entry) => entry.character_id)).size).toBe(136);
    expect(new Set([...carry, ...foughtInCycleOne.map((entry) => entry.character_id)])).toEqual(new Set(firstEntries.map((entry) => entry.character_id)));

    const secondCycleEntries = await db.query<{ character_id: string; carried_in: boolean }>(
      "select character_id, carried_in from public.arena_queue_entries where cycle_id = $1 order by position",
      [cycleTwo!.id],
    );
    expect(secondCycleEntries).toHaveLength(139);
    expect(secondCycleEntries.slice(0, 3).every((entry) => entry.carried_in)).toBe(true);
    expect(secondCycleEntries.slice(0, 3).map((entry) => entry.character_id).sort()).toEqual([...carry].sort());
    expect(new Set(secondCycleEntries.map((entry) => entry.character_id))).toEqual(new Set(roster));

    const maxAhead = await db.query<{ n: number }>(
      "select count(*)::int as n from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz",
      [new Date(clock.ms).toISOString()],
    );
    expect(maxAhead[0]!.n).toBeLessThanOrEqual(2);
    expect(await db.query("select 1 from public.arena_participants group by battle_id, character_id having count(*) > 1")).toHaveLength(0);
    console.info(`[arena-capacity] 139 heroes: initial queue and three-battle lineup ${initialLineupMs.toFixed(1)}ms; cycle 1 → cycle 2 rollover carried 3, no missing or duplicate heroes`);
  });
});

describe("the queue ahead stays bounded — through outages, restarts and a clock that jumps", () => {
  it("never holds more than two battles ahead, never two battles with the same start, and drains an outage backlog in order", async () => {
    await seedHeroes(db, 24);
    // A clock that TICKS while the arena works (every read of it costs 40 ms), like a database a round trip away: time passes
    // between the steps of one advance, which is what exposed the runaway queue against a real server.
    const ctx = arenaCtx(clock, { now: () => { clock.advance(40); return new Date(clock.ms); } });
    const offsets = [0, 500, 4_000, 31_000, 5 * 60_000, 20_000, 90_000, 600_000, 7_000, 45_000, 3_000, 3_000, 60_000];
    for (const off of offsets) {
      clock.advance(off);
      // A burst of callers, as after a restart (viewers + worker + cron).
      await Promise.all([advanceArena(db, ctx), advanceArena(db, ctx), advanceArena(db, ctx)]);
      const all = await battles();
      const unsettled = all.filter((b) => b.status === "SIMULATED" || b.status === "SCHEDULED");
      const ahead = unsettled.filter((b) => ms(b.starts_at) > clock.ms);
      expect(ahead.length, `battles queued ahead after +${off} ms`).toBeLessThanOrEqual(2);
      expect(unsettled.length, `unsettled battles after +${off} ms`).toBeLessThanOrEqual(4);
      const starts = all.map((b) => ms(b.starts_at));
      expect(new Set(starts).size, "two battles share a start time").toBe(starts.length);
      // Nobody is in two battles that are on stage at once.
      expect(await db.query("select 1 from public.arena_participants p join public.arena_battles b on b.id = p.battle_id where b.status = 'SIMULATED' and b.starts_at <= $1::timestamptz and b.slot_ends_at > $1::timestamptz group by p.character_id having count(*) > 1", [new Date(clock.ms).toISOString()])).toHaveLength(0);
    }
    // And after all of that the arena is healthy: advance in small steps and watch it flow on stage.
    const seen = new Set<string>();
    for (let i = 0; i < 400 && seen.size < 4; i++) {
      await advanceArena(db, ctx);
      const cur = (await stateAt(clock.ms)).current;
      if (cur) seen.add(cur.id);
      clock.advance(500);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    const final = await battles();
    expect(final.filter((b) => b.status === "SIMULATED" && ms(b.starts_at) > clock.ms).length).toBeLessThanOrEqual(2);
  });
});

describe("the queue gate", () => {
  it("queues nothing while two battles are unsettled and none is waiting ahead (the state that once let a runaway chain of battles through)", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1, b2] = await battles();
    // #1 is on stage and NOT due; #2 has already started too (e.g. a shifted/overdue battle): two unsettled, nothing prepared ahead.
    await db.query("update public.arena_battles set starts_at = $2::timestamptz where id = $1", [b2!.id, new Date(clock.ms - 1000).toISOString()]);
    expect(ms(b1!.combat_ends_at)).toBeGreaterThan(clock.ms);
    const before = await count(db, "arena_battles");
    clock.advance(200);
    for (let i = 0; i < 4; i++) await advanceArena(db, ctx);
    expect(await count(db, "arena_battles")).toBe(before); // nothing further was lined up or prepared
  });
});

describe("worker restart recovery", () => {
  it("a fresh worker process continues exactly where the old one stopped, and advancing twice is a no-op", async () => {
    const { b1 } = await reachResultsOfFirstBattle();
    const restarted = arenaCtx(clock, { secureSeed: () => "a-different-process" }); // new process, new seed source
    const again = await advanceArena(db, restarted);
    expect(again.steps).toEqual([]);
    clock.ms = ms(b1.slot_ends_at) + 5;
    const r = await advanceArena(db, restarted);
    expect(r.steps.some((s) => s.startsWith("scheduled:"))).toBe(true);
    expect((await battles()).map((b) => b.status)).toEqual(["SETTLED", "SIMULATED", "SIMULATED", "SIMULATED"]); // …and two battles are prepared ahead again
  });

  it("an outage while a battle is on stage never re-times a battle that has been public: the overdue ones settle in order and the arena continues on its own clock", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx); // #1 on stage, #2 (upcoming) and #3 prepared ahead, waiting for their slots
    const [b1, b2, b3] = await battles();
    expect(b2!.status).toBe("SIMULATED");
    clock.ms = ms(b1!.slot_ends_at) + 90_000; // the worker was down for 90 s past the end of the slot (reads kept answering: #2 was on stage)
    await advanceArena(db, ctx);
    const all = await battles();
    expect(all[0]!.status).toBe("SETTLED");
    expect(all[1]!.id).toBe(b2!.id);
    // #2's whole slot passed while it was the battle on stage — its fight was public — so it keeps its timeline and is settled in order,
    // never shown counting down 3 · 2 · 1 again (tests/integration/arena-countdown.test.ts).
    expect(all[1]!.status).toBe("SETTLED");
    expect(ms(all[1]!.starts_at)).toBe(ms(b2!.starts_at));
    expect(ms(all[1]!.combat_starts_at)).toBe(ms(b2!.combat_starts_at));
    // #3 keeps its place in the chain too, at the moment its own timeline says; the chain stays gapless.
    expect(all[2]!.id).toBe(b3!.id);
    expect(ms(all[2]!.starts_at)).toBe(ms(b3!.starts_at));
    expect(ms(all[2]!.starts_at)).toBe(ms(all[1]!.slot_ends_at));
    // (A battle lined up AFTER the outage may start fresh at "now" instead — R3's stale-anchor rule — when #3's slot is already long over.)
    // On stage is whichever battle has started by now (#3 mid-fight, or the next one if the fights were short) — at its stored time.
    const s = await stateAt(clock.ms);
    const onStage = all.filter((b) => ms(b.starts_at) <= clock.ms).at(-1)!;
    expect(s.current!.id).toBe(onStage.id);
    expect(s.current!.combatStartsAt).toBe(ms(onStage.combat_starts_at));
    // A longer outage: every overdue battle settles, and the next battle is anchored to "now" — a fresh, complete opening for everyone.
    clock.ms += 10 * 60_000;
    await advanceArena(db, ctx);
    await advanceArena(db, ctx);
    const later = await battles();
    for (const b of later.filter((x) => ms(x.slot_ends_at) < clock.ms)) expect(b.status, `battle ${b.id}`).toBe("SETTLED");
    const fresh = later.find((b) => b.status === "SIMULATED" && ms(b.starts_at) >= clock.ms - 5);
    expect(fresh).toBeDefined();
    expect(ms(fresh!.combat_starts_at) - ms(fresh!.starts_at)).toBe(5500); // the opening is intact: 2.5 s intro + 3·2·1
  });

  it("reports when the next transition falls due, so a worker sleeps until then instead of ticking blindly", async () => {
    await seedHeroes(db, 16);
    const ctx = arenaCtx(clock);
    const first = await advanceArena(db, ctx);
    const [b1] = await battles();
    expect(first.dueAtMs).toBe(ms(b1!.combat_ends_at)); // the battle on stage is decided → the upcoming battle's picks lock, then settle
    clock.ms = ms(b1!.combat_ends_at) + 10;
    const settled = await advanceArena(db, ctx);
    const [, b2] = await battles();
    expect(settled.dueAtMs).toBe(ms(b2!.starts_at)); // the prepared battle takes the stage
  });
});
