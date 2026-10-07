import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { picksWindow, type WindowBattle, type WindowPredecessor } from "@/domain/arena/picksWindow";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, settleBattle } from "@/server/services/arena";
import { arenaAdmin } from "@/server/services/admin";
import { listPickHistory } from "@/server/rewards/summary";
import { getMyPick, submitPick } from "@/server/services/picks";
import { getArenaState, type ArenaStateDto } from "@/server/services/views";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedEligibleMember, seedHeroes } from "../support/db";

/**
 * ARENA PICKS LIFECYCLE — picks are made on the UPCOMING battle while the current one is fought:
 *
 *   A on stage / picks for B OPEN → A decided → B LOCKED → A's results → 3·2·1 → B on stage / picks for C OPEN → …
 *
 * These tests drive a real arena (real queue, real simulation, real settlement, in-memory Postgres) on a fake clock.
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

interface BattleRow {
  id: string;
  sequence: number;
  status: string;
  starts_at: Date;
  combat_starts_at: Date;
  combat_ends_at: Date;
  slot_ends_at: Date;
  winner_id: string | null;
  picks_locked_at: Date | null;
  picks_lock_reason: string | null;
}
const battles = () =>
  db.query<BattleRow>("select id, sequence, status, starts_at, combat_starts_at, combat_ends_at, slot_ends_at, winner_id, picks_locked_at, picks_lock_reason from public.arena_battles order by sequence");
const ms = (d: Date | null) => (d ? new Date(d).getTime() : 0);
const roster = async (battleId: string) => (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 order by character_id", [battleId])).map((r) => r.character_id);
const stateAt = async (t: number): Promise<ArenaStateDto> => getArenaState(db, t, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
const at = (t: number) => ({ now: () => new Date(t), allowDemo: true });

let nextMember = 910_000;
const member = () => seedEligibleMember(db, { id: nextMember++ });
const pickOn = (who: number, battleId: string, characterId: string, t: number = clock.ms) => submitPick(db, at(t), { telegramUserId: who, battleId, characterId, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold });
const stepNames = (r: { steps: string[] }) => r.steps.map((s) => s.split(":")[0]);

describe("the exact rolling sequence", () => {
  it("A on stage / B OPEN → A decided → B LOCKED → B on stage / C OPEN → B settles against the member's pick on B", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B, C] = await battles();
    const me = await member();

    // 1. Battle A is on stage, battle B is prepared: the Arena shows A, the Picks panel shows B, and B's picks are OPEN.
    const s1 = await stateAt(ms(A!.starts_at));
    expect(s1.current!.id).toBe(A!.id);
    expect(s1.upcoming!.id).toBe(B!.id);
    expect(s1.upcoming!.picks.status).toBe("OPEN");
    expect(s1.upcoming!.fighters.map((f) => f.characterId).sort()).toEqual(await roster(B!.id)); // exactly who will fight
    expect(s1.upcoming!.fighters.some((f) => s1.current!.fighters.some((g) => g.characterId === f.characterId))).toBe(false); // never the fighters on stage
    // The member picks B's (server-known) winner.
    const choice = B!.winner_id!;
    expect(await pickOn(me, B!.id, choice, ms(A!.starts_at) + 1000)).toMatchObject({ ok: true });
    expect(await count(db, "arena_picks", `battle_id = '${B!.id}'`)).toBe(1);
    expect(await count(db, "arena_picks", `battle_id = '${A!.id}'`)).toBe(0); // never credited against the battle on stage

    // 2. A reaches its authoritative result: B's picks LOCK — on the clock first, then as a persisted, stamped fact.
    expect((await stateAt(ms(A!.combat_ends_at) - 1)).upcoming!.picks.status).toBe("OPEN");
    expect((await stateAt(ms(A!.combat_ends_at))).upcoming!.picks.status).toBe("LOCKED");
    clock.ms = ms(A!.combat_ends_at) + 10;
    expect(stepNames(await advanceArena(db, ctx))).toEqual(["locked", "settled"]);
    const afterA = await battles();
    expect(afterA[0]!.status).toBe("SETTLED");
    expect(ms(afterA[1]!.picks_locked_at)).toBe(ms(A!.combat_ends_at)); // the deciding instant
    expect(afterA[1]!.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
    expect(afterA[2]!.picks_locked_at).toBeNull(); // C is not even the next fight yet
    // The pick is highlighted and locked; nobody can change it or add one.
    const locked = (await stateAt(clock.ms)).upcoming!;
    expect(locked.id).toBe(B!.id);
    expect(locked.picks).toMatchObject({ status: "LOCKED", lockReason: "PREDECESSOR_DECIDED", lockedAt: ms(A!.combat_ends_at) });
    expect(await getMyPick(db, me, B!.id)).toMatchObject({ characterId: choice, locked: true, result: null });
    expect(await pickOn(me, B!.id, (await roster(B!.id)).find((id) => id !== choice)!)).toEqual({ ok: false, reason: "LOCKED" });
    expect(await pickOn(await member(), B!.id, choice)).toEqual({ ok: false, reason: "LOCKED" });
    // …and nothing about C's picks has opened early.
    expect(await pickOn(await member(), C!.id, (await roster(C!.id))[0]!)).toEqual({ ok: false, reason: "NOT_OPEN" });

    // 3. A's results, then 3·2·1: the panel keeps showing the same LOCKED battle B, the arena keeps showing A's results.
    for (const t of [ms(A!.combat_ends_at) + 1200, ms(A!.combat_ends_at) + 3000, ms(A!.slot_ends_at) - 1]) {
      const s = await stateAt(t);
      expect(s.current!.id).toBe(A!.id);
      expect(s.upcoming!.id).toBe(B!.id);
      expect(s.upcoming!.picks.status).toBe("LOCKED");
    }

    // 4. B takes the stage: in the SAME snapshot the panel moves to C, whose picks are OPEN.
    const T = ms(B!.starts_at);
    expect(T).toBe(ms(A!.slot_ends_at));
    const s4 = await stateAt(T);
    expect(s4.current!.id).toBe(B!.id);
    expect(s4.upcoming!.id).toBe(C!.id);
    expect(s4.upcoming!.picks.status).toBe("OPEN");
    expect(s4.upcoming!.picks.locksAt).toBe(ms(B!.combat_ends_at));
    clock.ms = T;
    const lineup = await advanceArena(db, ctx);
    expect(stepNames(lineup)).toEqual(["scheduled", "simulated"]); // B's window was stamped when A was decided; only the battle lined up behind C is new
    // The pick that used to be allowed on B is refused now: B is on stage.
    expect(await pickOn(await member(), B!.id, choice, T)).toEqual({ ok: false, reason: "LOCKED" });
    const meOnC = (await roster(C!.id)).find((id) => id !== C!.winner_id)!;
    expect(await pickOn(me, C!.id, meOnC, T + 500)).toMatchObject({ ok: true });

    // 5. B settles: the member's pick on B is judged against B's own authoritative #1 (not A's, not C's).
    clock.ms = ms(B!.combat_ends_at) + 10;
    await advanceArena(db, ctx);
    const afterB = await battles();
    expect(afterB[1]!.status).toBe("SETTLED");
    expect(await getMyPick(db, me, B!.id)).toMatchObject({ battleId: B!.id, characterId: choice, result: "CORRECT", locked: true });
    expect(afterB[1]!.winner_id).toBe(choice);
    // The pick on C is untouched: locked now (B decided), unresolved until C settles.
    expect(await getMyPick(db, me, C!.id)).toMatchObject({ battleId: C!.id, characterId: meOnC, result: null, locked: true });
    expect(afterB[2]!.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
    expect(ms(afterB[2]!.picks_locked_at)).toBe(ms(B!.combat_ends_at));
  });

  it("repeats forever without a mismatch: ten consecutive transitions, every one with the right current / upcoming / state", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const trace: string[] = [];
    let previousUpcoming: string | null = null;
    for (let i = 0; i < 10; i++) {
      const all = await battles();
      const current = all.filter((b) => ms(b.starts_at) <= clock.ms).at(-1)!;
      const upcoming = all.find((b) => ms(b.starts_at) > clock.ms && b.status === "SIMULATED")!;
      // (a) at the moment the current battle takes the stage: A / B OPEN
      let s = await stateAt(clock.ms);
      expect(s.current!.id).toBe(current.id);
      expect(s.upcoming!.id).toBe(upcoming.id);
      expect(s.upcoming!.picks.status).toBe("OPEN");
      if (previousUpcoming !== null) expect(s.current!.id).toBe(previousUpcoming); // what was the panel's battle IS now the arena's — no skip, no repeat
      trace.push(`${i}: arena=${s.current!.id.slice(0, 4)} picks=${s.upcoming!.id.slice(0, 4)} OPEN`);
      // (b) the current battle is decided: B LOCKED
      clock.ms = ms(current.combat_ends_at) + 10;
      await advanceArena(db, ctx);
      s = await stateAt(clock.ms);
      expect(s.current!.id).toBe(current.id);
      expect(s.upcoming!.id).toBe(upcoming.id);
      expect(s.upcoming!.picks.status).toBe("LOCKED");
      trace.push(`${i}: arena=${s.current!.id.slice(0, 4)} picks=${s.upcoming!.id.slice(0, 4)} LOCKED`);
      // (c) the next battle takes the stage
      previousUpcoming = upcoming.id;
      clock.ms = ms(upcoming.starts_at);
      await advanceArena(db, ctx);
    }
    expect(trace).toHaveLength(20);
    expect(await count(db, "arena_battles", "status = 'SETTLED'")).toBeGreaterThanOrEqual(10);
    // Every battle's window was stamped exactly once, at the instant the battle before it was decided (the very first has no predecessor).
    const all = await battles();
    for (let i = 1; i < all.length; i++) {
      const b = all[i]!;
      if (b.picks_locked_at === null) continue; // still queued behind the upcoming one
      expect(b.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
      expect(ms(b.picks_locked_at)).toBe(ms(all[i - 1]!.combat_ends_at));
    }
    expect(all[0]!.picks_lock_reason).toBe("OWN_START");
  });
});

describe("the lock is a database transition, enforced once, with exact ordering", () => {
  async function setup() {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B] = await battles();
    return { ctx, A: A!, B: B!, fighters: await roster(B!.id) };
  }

  it("a pick one millisecond before the deciding instant is accepted and counts; at / after it is refused and writes nothing", async () => {
    const { ctx, A, B, fighters } = await setup();
    const early = await member();
    const exact = await member();
    const late = await member();
    expect(await pickOn(early, B.id, fighters[0]!, ms(A.combat_ends_at) - 1)).toMatchObject({ ok: true });
    expect(await pickOn(exact, B.id, fighters[0]!, ms(A.combat_ends_at))).toEqual({ ok: false, reason: "LOCKED" });
    clock.ms = ms(A.combat_ends_at) + 1;
    await advanceArena(db, ctx);
    expect(await pickOn(late, B.id, fighters[0]!, ms(A.combat_ends_at) + 1)).toEqual({ ok: false, reason: "LOCKED" });
    expect(await count(db, "arena_picks")).toBe(1);
    expect((await getMyPick(db, early, B.id))!.locked).toBe(true); // the early pick was frozen at the lock
    expect(await count(db, "arena_picks", "locked_at is null")).toBe(0);
  });

  it("the stamp — not the submitter's clock — is the authority: a request that arrives after the lock is refused even with an earlier clock", async () => {
    const { ctx, A, B, fighters } = await setup();
    clock.ms = ms(A.combat_ends_at) + 1;
    await advanceArena(db, ctx);
    // A "slow browser" whose request was timestamped before the deciding instant but only reached the server now.
    expect(await pickOn(await member(), B.id, fighters[0]!, ms(A.combat_ends_at) - 500)).toEqual({ ok: false, reason: "LOCKED" });
    expect(await count(db, "arena_picks")).toBe(0);
  });

  it("racing the lock: every pick either committed before it (and counts) or is refused — never a pick that slipped in after", async () => {
    const { ctx, A, B, fighters } = await setup();
    const members = await Promise.all(Array.from({ length: 24 }, () => member()));
    // 24 picks submitted CONCURRENTLY with the lock step; their clocks are all before the deciding instant, so only the database
    // ordering (the shared row lock vs. the lock stamp) decides which side of it each lands on.
    clock.ms = ms(A.combat_ends_at) + 1;
    const results = await Promise.all([
      ...members.slice(0, 12).map((m, i) => pickOn(m, B.id, fighters[i % 8]!, ms(A.combat_ends_at) - 1)),
      advanceArena(db, ctx),
      ...members.slice(12).map((m, i) => pickOn(m, B.id, fighters[i % 8]!, ms(A.combat_ends_at) - 1)),
    ]);
    const picks = results.filter((r): r is Exclude<typeof r, { steps: string[] }> => "ok" in r);
    const accepted = picks.filter((r) => r.ok).length;
    const refused = picks.filter((r) => !r.ok);
    expect(accepted + refused.length).toBe(24);
    expect(refused.every((r) => !r.ok && r.reason === "LOCKED")).toBe(true);
    expect(await count(db, "arena_picks")).toBe(accepted); // refused picks wrote nothing
    // Everything that was accepted is frozen at the one stamp; the stamp exists exactly once.
    expect(await count(db, "arena_picks", "locked_at is null")).toBe(0);
    const [stamp] = await db.query<{ picks_locked_at: Date; picks_lock_reason: string }>("select picks_locked_at, picks_lock_reason from public.arena_battles where id = $1", [B.id]);
    expect(ms(stamp!.picks_locked_at)).toBe(ms(A.combat_ends_at));
    expect(await count(db, "arena_picks", `locked_at <> '${new Date(ms(A.combat_ends_at)).toISOString()}'`)).toBe(0);
    // Both sides of the race happened (the lock step ran in the middle of the batch) …
    expect(accepted).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  it("settlement closes the window too, in its own transaction, even if the lock step never ran — and only once", async () => {
    const { ctx, A, B, fighters } = await setup();
    const me = await member();
    await pickOn(me, B.id, fighters[0]!, ms(A.combat_starts_at));
    clock.ms = ms(A.combat_ends_at) + 5;
    const settings = await loadSettings(db);
    expect(await db.transaction((tx) => settleBattle(tx, ctx, A.id, settings))).toBe(true); // the lock step has NOT run
    const [afterSettle] = await db.query<{ picks_locked_at: Date; picks_lock_reason: string }>("select picks_locked_at, picks_lock_reason from public.arena_battles where id = $1", [B.id]);
    expect(ms(afterSettle!.picks_locked_at)).toBe(ms(A.combat_ends_at));
    expect(afterSettle!.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
    expect(await pickOn(await member(), B.id, fighters[1]!, ms(A.combat_ends_at) - 1)).toEqual({ ok: false, reason: "LOCKED" });
    // Running the arena afterwards neither re-stamps nor re-settles.
    await advanceArena(db, ctx);
    const [again] = await db.query<{ picks_locked_at: Date }>("select picks_locked_at from public.arena_battles where id = $1", [B.id]);
    expect(ms(again!.picks_locked_at)).toBe(ms(afterSettle!.picks_locked_at));
    expect(await db.transaction((tx) => settleBattle(tx, ctx, A.id, settings))).toBe(false);
  });

  it("the arena advancing many times at the deciding instant closes the window exactly once", async () => {
    const { ctx, A, B } = await setup();
    clock.ms = ms(A.combat_ends_at) + 3;
    const runs = await Promise.all(Array.from({ length: 6 }, () => advanceArena(db, ctx)));
    expect(runs.flatMap(stepNames).filter((n) => n === "locked")).toHaveLength(1);
    expect(runs.flatMap(stepNames).filter((n) => n === "settled")).toHaveLength(1);
    expect(await count(db, "arena_battles", `id = '${B.id}' and picks_locked_at is not null`)).toBe(1);
  });
});

describe("the rule, in isolation (domain/arena/picksWindow.ts)", () => {
  const battle = (over: Partial<WindowBattle> = {}): WindowBattle => ({ status: "SIMULATED", startsAt: 100_000, picksLockedAt: null, picksLockReason: null, ...over });
  const onStage = (over: Partial<WindowPredecessor> = {}): WindowPredecessor => ({ status: "SIMULATED", startsAt: 60_000, combatEndsAt: 90_000, slotEndsAt: 100_000, ...over });

  it("OPEN while the battle in front is undecided; LOCKED from its decision; LOCKED from the battle's own start; never reopens", () => {
    expect(picksWindow(battle(), onStage(), 70_000)).toMatchObject({ state: "OPEN", mode: "PREDECESSOR", locksAt: 90_000 });
    expect(picksWindow(battle(), onStage(), 89_999).state).toBe("OPEN");
    expect(picksWindow(battle(), onStage(), 90_000)).toMatchObject({ state: "LOCKED", reason: "PREDECESSOR_DECIDED" });
    expect(picksWindow(battle(), onStage({ status: "SETTLED" }), 91_000)).toMatchObject({ state: "LOCKED", reason: "PREDECESSOR_DECIDED" });
    expect(picksWindow(battle(), onStage(), 100_000)).toMatchObject({ state: "LOCKED", reason: "PREDECESSOR_DECIDED" }); // the battle in front decided first: that is the reason on record
    expect(picksWindow(battle({ picksLockedAt: 90_000, picksLockReason: "PREDECESSOR_DECIDED" }), onStage(), 10)).toMatchObject({ state: "LOCKED" }); // a stamp wins
  });

  it("not open for a battle that is not prepared, or that is not the next fight", () => {
    expect(picksWindow(battle({ status: "SCHEDULED" }), onStage(), 70_000).state).toBe("NOT_OPEN");
    expect(picksWindow(battle(), onStage({ startsAt: 80_000 }), 70_000).state).toBe("NOT_OPEN"); // the one in front has not taken the stage yet
    expect(picksWindow(battle({ status: "SETTLED" }), onStage(), 70_000).state).toBe("RESOLVED");
    expect(picksWindow(battle({ status: "VOID" }), onStage(), 70_000).state).toBe("VOID");
  });

  it("FALLBACK: with nothing on stage in front, the pre-fight window is open until the battle's own start", () => {
    expect(picksWindow(battle(), null, 90_000)).toMatchObject({ state: "OPEN", mode: "FALLBACK", locksAt: 100_000 });
    expect(picksWindow(battle(), onStage({ status: "SETTLED", slotEndsAt: 80_000 }), 90_000)).toMatchObject({ state: "OPEN", mode: "FALLBACK" }); // its slot is over: nothing holds the stage
    expect(picksWindow(battle(), null, 100_000)).toMatchObject({ state: "LOCKED", reason: "OWN_START" });
  });
});

describe("first battle, restarts and outages", () => {
  it("the very first battle has no predecessor: it never takes picks, and the next battle's picks open right away", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B] = await battles();
    expect(A!.picks_lock_reason).toBe("OWN_START"); // stamped at its own start: nothing before it
    const s = await stateAt(clock.ms);
    expect(s.upcoming!.id).toBe(B!.id);
    expect(s.upcoming!.picks).toMatchObject({ status: "OPEN", mode: "PREDECESSOR" });
    expect(await pickOn(await member(), A!.id, (await roster(A!.id))[0]!)).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("FALLBACK: a prepared battle with nothing on stage in front of it uses the pre-fight window, then LOCKS at its own start — and the panel moves on, never stuck", async () => {
    await seedHeroes(db, 40);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B] = await battles();
    // The battle that was on stage is voided (an operator, or an outage): B is prepared and waiting, but nothing holds the stage in front of it.
    await db.query("update public.arena_battles set status = 'VOID' where id = $1", [A!.id]);
    const t = ms(B!.starts_at) - 3000;
    const s = await stateAt(t);
    expect(s.current).toBeNull();
    expect(s.upcoming!.id).toBe(B!.id);
    expect(s.upcoming!.picks).toMatchObject({ status: "OPEN", mode: "FALLBACK", locksAt: ms(B!.starts_at) });
    const me = await member();
    expect(await pickOn(me, B!.id, (await roster(B!.id))[0]!, t)).toMatchObject({ ok: true });
    // It takes the stage: picks LOCK (own start) and the panel is on the battle after it.
    clock.ms = ms(B!.starts_at);
    await advanceArena(db, ctx);
    const s2 = await stateAt(clock.ms);
    expect(s2.current!.id).toBe(B!.id);
    expect(s2.upcoming!.id).not.toBe(B!.id);
    expect(s2.upcoming!.picks.status).toBe("OPEN");
    expect(await pickOn(await member(), B!.id, (await roster(B!.id))[1]!)).toEqual({ ok: false, reason: "LOCKED" });
    const [row] = await db.query<{ picks_lock_reason: string }>("select picks_lock_reason from public.arena_battles where id = $1", [B!.id]);
    expect(row!.picks_lock_reason).toBe("OWN_START");
    expect(await getMyPick(db, me, B!.id)).toMatchObject({ locked: true });
  });

  it("a worker restart in the middle of a fight changes nothing: the prepared upcoming battle and its OPEN window survive, and advancing again is a no-op", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const [A, B] = await battles();
    clock.ms = ms(A!.combat_starts_at) + 4000;
    const before = await stateAt(clock.ms);
    const restarted = arenaCtx(clock, { secureSeed: () => "a-different-process" });
    expect((await advanceArena(db, restarted)).steps).toEqual([]);
    const after = await stateAt(clock.ms);
    expect(after.upcoming).toEqual(before.upcoming);
    expect(after.upcoming!.id).toBe(B!.id);
    expect(after.upcoming!.picks.status).toBe("OPEN");
    expect(await pickOn(await member(), B!.id, (await roster(B!.id))[0]!)).toMatchObject({ ok: true });
  });

  it("an outage past the whole slot does not reopen or extend anything: the waiting battle is shifted with its picks already locked", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B] = await battles();
    const me = await member();
    await pickOn(me, B!.id, (await roster(B!.id))[0]!);
    clock.ms = ms(A!.slot_ends_at) + 90_000; // down for 90 s past the end of A's slot
    expect((await pickOn(await member(), B!.id, (await roster(B!.id))[1]!)).ok).toBe(false); // the server clock closes it even though nothing advanced
    await advanceArena(db, ctx);
    const [, b] = await battles();
    expect(b!.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
    expect(ms(b!.picks_locked_at)).toBe(ms(A!.combat_ends_at)); // the deciding instant of A, 90 s ago — not "now"
    expect(await getMyPick(db, me, B!.id)).toMatchObject({ locked: true });
  });
});

describe("fast battles", () => {
  it("the upcoming roster is exposed the moment the battle in front takes the stage, so even a very short fight leaves the whole pre-fight time", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const [A, B] = await battles();
    // Force a very fast fight: it ends 1.5 s after the bell.
    await db.query("update public.arena_battles set combat_ends_at = combat_starts_at + interval '1500 milliseconds' where id = $1", [A!.id]);
    const [fast] = await db.query<{ combat_ends_at: Date }>("select combat_ends_at from public.arena_battles where id = $1", [A!.id]);
    const startsAt = ms(A!.starts_at);
    const s = await stateAt(startsAt); // the very first instant of the fight in front
    expect(s.upcoming!.id).toBe(B!.id);
    expect(s.upcoming!.fighters).toHaveLength(8);
    expect(s.upcoming!.picks).toMatchObject({ status: "OPEN", locksAt: ms(fast!.combat_ends_at) });
    expect(ms(fast!.combat_ends_at) - startsAt).toBe(2500 + 3000 + 1500); // intro + 3·2·1 + the short fight: 7 s of pick time
    expect((await pickOn(await member(), B!.id, (await roster(B!.id))[0]!, ms(fast!.combat_ends_at) - 1)).ok).toBe(true);
    expect(await pickOn(await member(), B!.id, (await roster(B!.id))[0]!, ms(fast!.combat_ends_at))).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("every battle in a long run keeps at least the intro + countdown as pick time, because the roster is committed before the previous fight starts", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    for (let i = 0; i < 1400 && (await count(db, "arena_battles", "status = 'SETTLED'")) < 8; i++) {
      await advanceArena(db, ctx);
      const [cur] = (await battles()).filter((b) => ms(b.starts_at) <= clock.ms).slice(-1);
      if (cur) {
        const s = await stateAt(clock.ms);
        // Whenever a battle is on stage and unsettled, the upcoming battle's roster is already in the snapshot.
        expect(s.upcoming, `no upcoming battle at +${i * 0.5}s`).not.toBeNull();
        expect(s.upcoming!.fighters).toHaveLength(8);
      }
      clock.advance(500);
    }
    expect(await count(db, "arena_battles", "status = 'SETTLED'")).toBeGreaterThanOrEqual(8);
  });
});

describe("a cancelled pick period is VOID, explicitly", () => {
  it("voiding the upcoming battle resolves its picks as VOID (stamped VOID, nothing earned) and the next prepared battle becomes the target", async () => {
    await seedHeroes(db, 40);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [, B] = await battles();
    const me = await member();
    await pickOn(me, B!.id, (await roster(B!.id))[0]!);
    await arenaAdmin(db, "void_unsettled", "test");
    const [row] = await db.query<{ status: string; picks_lock_reason: string; picks_locked_at: Date }>("select status, picks_lock_reason, picks_locked_at from public.arena_battles where id = $1", [B!.id]);
    expect(row).toMatchObject({ status: "VOID", picks_lock_reason: "VOID" });
    expect(await getMyPick(db, me, B!.id)).toMatchObject({ result: "VOID", locked: true, rewardGold: 0 });
    expect(await pickOn(await member(), B!.id, (await roster(B!.id))[1]!)).toEqual({ ok: false, reason: "RESOLVED" });
    expect((await stateAt(clock.ms)).upcoming).toBeNull(); // nothing is prepared any more — never a stale roster
    // The arena recovers: a fresh battle is prepared and becomes the target, with new rosters (the voided heroes kept their turn).
    clock.advance(60_000);
    await advanceArena(db, ctx);
    const s = await stateAt(clock.ms);
    expect(s.upcoming).not.toBeNull();
    expect(s.upcoming!.id).not.toBe(B!.id);
  });
});

describe("every pick references the battle that was PREDICTED — no off-by-one anywhere", () => {
  it("six consecutive picks: each names the upcoming battle at the time, resolves against THAT battle's winner, and never touches its neighbours", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const me = await member();
    const made: Array<{ battleId: string; characterId: string }> = [];
    for (let i = 0; i < 6; i++) {
      const all = await battles();
      const current = all.filter((b) => ms(b.starts_at) <= clock.ms).at(-1)!;
      const upcoming = all.find((b) => ms(b.starts_at) > clock.ms && b.status === "SIMULATED")!;
      const fighters = await roster(upcoming.id);
      // alternate: the real winner (CORRECT) / someone else (INCORRECT)
      const characterId = i % 2 === 0 ? upcoming.winner_id! : fighters.find((f) => f !== upcoming.winner_id)!;
      expect(await pickOn(me, upcoming.id, characterId)).toMatchObject({ ok: true, pick: { battleId: upcoming.id } });
      made.push({ battleId: upcoming.id, characterId });
      // while the CURRENT battle plays out, the only unresolved pick is the one on the upcoming battle
      clock.ms = ms(current.combat_ends_at) + 10;
      await advanceArena(db, ctx);
      expect(await count(db, "arena_picks", `battle_id = '${current.id}' and result is null`)).toBe(0);
      expect(await count(db, "arena_picks", `battle_id = '${upcoming.id}' and result is null and locked_at is not null`)).toBe(1);
      clock.ms = ms(upcoming.starts_at);
      await advanceArena(db, ctx);
    }
    // settle the last upcoming battle too
    const last = (await battles()).find((b) => b.id === made[5]!.battleId)!;
    clock.ms = ms(last.combat_ends_at) + 10;
    await advanceArena(db, ctx);

    const rows = await db.query<{ battle_id: string; character_id: string; result: string; winner_id: string; status: string }>(
      "select p.battle_id, p.character_id, p.result, b.winner_id, b.status from public.arena_picks p join public.arena_battles b on b.id = p.battle_id where p.telegram_user_id = $1 order by b.sequence",
      [me],
    );
    expect(rows.map((r) => r.battle_id)).toEqual(made.map((m) => m.battleId)); // one pick per battle, the right battles, in order
    for (const [i, r] of rows.entries()) {
      expect(r.status).toBe("SETTLED");
      expect(r.character_id).toBe(made[i]!.characterId);
      expect(r.result).toBe(r.character_id === r.winner_id ? "CORRECT" : "INCORRECT"); // against ITS OWN battle's authoritative #1
      expect(r.result).toBe(i % 2 === 0 ? "CORRECT" : "INCORRECT");
    }

    // PICK HISTORY (what the member sees on their profile): every row names the battle that was PREDICTED, the hero they picked and the
    // winner of THAT battle — "your pick Rin → winner Rin → CORRECT", never the neighbouring battle's result.
    const history = await listPickHistory(db, me);
    expect(history.map((h) => h.battleId)).toEqual(made.map((m) => m.battleId).reverse()); // newest first
    for (const h of history) {
      const index = made.findIndex((m) => m.battleId === h.battleId);
      const [b] = await db.query<{ winner_id: string }>("select winner_id from public.arena_battles where id = $1", [h.battleId]);
      expect(h.picked.characterId).toBe(made[index]!.characterId);
      expect(h.winner!.characterId).toBe(b!.winner_id);
      expect(h.result).toBe(h.picked.characterId === h.winner!.characterId ? "CORRECT" : "INCORRECT");
      expect(h.result).toBe(index % 2 === 0 ? "CORRECT" : "INCORRECT");
    }
  });
});

describe("pick history follows the battle the member predicted", () => {
  it("UPCOMING PICK → (locked, still upcoming) → FIGHTING NOW → RESULT with THAT battle's winner — the outcome is never shown early", async () => {
    await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [A, B, C] = await battles();
    const me = await member();
    const history = (t: number) => listPickHistory(db, me, 25, t);
    expect(await history(clock.ms)).toEqual([]);

    // A is on stage; the member picks B's real (server-known) winner.
    const choice = B!.winner_id!;
    expect(await pickOn(me, B!.id, choice, ms(A!.starts_at) + 500)).toMatchObject({ ok: true });
    const first = await history(ms(A!.starts_at) + 600);
    expect(first).toHaveLength(1);
    let row = first[0];
    expect(row).toMatchObject({ battleId: B!.id, phase: "UPCOMING", result: null, winner: null, points: 0, leaderboard: null });
    expect(row!.picked.characterId).toBe(choice);
    expect(JSON.stringify(row)).not.toContain(A!.winner_id!); // never the battle on stage
    expect(row!.winner).toBeNull(); // B's winner is already persisted in the database — and must not leave it before the fight is over

    // A is decided: B's picks lock, but the pick is still an UPCOMING one.
    clock.ms = ms(A!.combat_ends_at) + 10;
    await advanceArena(db, ctx);
    [row] = await history(clock.ms);
    expect(row).toMatchObject({ battleId: B!.id, phase: "UPCOMING", result: null, winner: null });

    // B takes the stage: FIGHTING NOW (and a new pick, on C, is listed first as the new UPCOMING one).
    clock.ms = ms(B!.starts_at);
    await advanceArena(db, ctx);
    const meOnC = (await roster(C!.id)).find((id) => id !== C!.winner_id)!;
    expect(await pickOn(me, C!.id, meOnC, clock.ms + 100)).toMatchObject({ ok: true });
    const midway = await history(clock.ms + 200);
    expect(midway.map((h) => [h.battleId, h.phase, h.result])).toEqual([
      [C!.id, "UPCOMING", null],
      [B!.id, "FIGHTING", null],
    ]);

    // B settles: its row becomes the RESULT against B's own winner; C's is still waiting and still first.
    clock.ms = ms(B!.combat_ends_at) + 10;
    await advanceArena(db, ctx);
    const after = await history(clock.ms);
    expect(after.map((h) => [h.battleId, h.result])).toEqual([
      [C!.id, null],
      [B!.id, "CORRECT"],
    ]);
    expect(after[1]).toMatchObject({ battleId: B!.id, winner: { characterId: B!.winner_id }, picked: { characterId: choice } });
    expect(after[1]!.phase).toBeUndefined();
    expect(after[0]).toMatchObject({ phase: "UPCOMING", winner: null });
  });
});
