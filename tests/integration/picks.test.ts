import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { loadSettings, saveSetting } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, settleBattle } from "@/server/services/arena";
import { auditLedger, getBalance } from "@/server/services/economy";
import { getMyPick, settlePicks, submitPick } from "@/server/services/picks";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedEligibleMember, seedHeroes } from "../support/db";

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

let nextMember = 800_000;
/** A signed-in member who IS eligible for rewarded picks (≥ 50 qualifying messages and an active hero). */
async function member(): Promise<number> {
  return seedEligibleMember(db, { id: nextMember++ });
}
async function claim(characterId: string): Promise<number> {
  const [c] = await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [characterId]);
  await db.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, $2, now())", [characterId, c!.telegram_user_id]);
  return c!.telegram_user_id;
}

interface Upcoming {
  heroes: string[];
  /** The UPCOMING battle — the one picks name. */
  id: string;
  fighters: string[];
  winner: string;
  loser: string;
  /** When it takes the stage / fights / is decided. */
  startsAt: number;
  lockAt: number;
  endsAt: number;
  /** The battle on stage in front of it, and when ITS winner is decided — the instant this battle's picks lock. */
  predecessorId: string;
  predecessorStartsAt: number;
  predecessorCombatStartsAt: number;
  decidedAt: number;
}

/** Describes the upcoming battle (the picks target) at the clock's current instant. */
async function upcomingNow(heroes: string[]): Promise<Upcoming> {
  const [b] = await db.query<{ id: string; winner_id: string; starts_at: Date; combat_starts_at: Date; combat_ends_at: Date }>(
    "select id, winner_id, starts_at, combat_starts_at, combat_ends_at from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz order by sequence limit 1",
    [clock.now().toISOString()],
  );
  const [p] = await db.query<{ id: string; starts_at: Date; combat_starts_at: Date; combat_ends_at: Date }>(
    "select id, starts_at, combat_starts_at, combat_ends_at from public.arena_battles where status in ('SIMULATED', 'SETTLED') and starts_at <= $1::timestamptz order by sequence desc limit 1",
    [clock.now().toISOString()],
  );
  const fighters = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 order by slot", [b!.id])).map((r) => r.character_id);
  const loser = fighters.find((f) => f !== b!.winner_id)!;
  return {
    heroes, id: b!.id, fighters, winner: b!.winner_id, loser,
    startsAt: b!.starts_at.getTime(), lockAt: b!.combat_starts_at.getTime(), endsAt: b!.combat_ends_at.getTime(),
    predecessorId: p!.id, predecessorStartsAt: p!.starts_at.getTime(), predecessorCombatStartsAt: p!.combat_starts_at.getTime(), decidedAt: p!.combat_ends_at.getTime(),
  };
}

/** 24 heroes: battle #1 on stage (clock at its start), battle #2 is the UPCOMING battle with picks OPEN, #3 is prepared behind it. */
async function onStage(): Promise<Upcoming> {
  const heroes = await seedHeroes(db, 24);
  await advanceArena(db, arenaCtx(clock));
  return upcomingNow(heroes);
}

async function pick(tg: number, battleId: string, characterId: string) {
  return submitPick(db, { now: clock.now, allowDemo: true }, { telegramUserId: tg, battleId, characterId, threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold });
}

/** Plays the whole lifecycle of the upcoming battle: the battle in front is decided, it takes the stage, is fought, decided and settled. */
async function settleNow(s: Upcoming) {
  const ctx = arenaCtx(clock);
  clock.ms = Math.max(clock.ms, s.decidedAt + 10);
  await advanceArena(db, ctx);
  clock.ms = Math.max(clock.ms, s.startsAt);
  await advanceArena(db, ctx);
  clock.ms = Math.max(clock.ms, s.endsAt + 10);
  await advanceArena(db, ctx);
  expect(await count(db, "arena_battles", `id = '${s.id}' and status = 'SETTLED'`)).toBe(1);
}

describe("free picks — window (picks are made on the UPCOMING battle)", () => {
  it("accepts picks from the moment the battle in front takes the stage until its winner is decided — through its intro, 3·2·1 and combat", async () => {
    const s = await onStage();
    const a = await member();
    const b = await member();
    expect((await pick(a, s.id, s.fighters[0]!)).ok).toBe(true); // right as the battle in front takes the stage
    clock.ms = s.predecessorStartsAt + 2500 + 1500; // mid countdown of the battle in front
    expect((await pick(b, s.id, s.fighters[1]!)).ok).toBe(true);
    clock.ms = Math.floor((s.predecessorCombatStartsAt + s.decidedAt) / 2); // mid combat of the battle in front — where the old window was already shut
    expect(clock.ms).toBeGreaterThan(s.predecessorCombatStartsAt);
    expect((await pick(a, s.id, s.fighters[2]!)).ok).toBe(true);
    clock.ms = s.decidedAt - 1; // the last millisecond before the winner is decided
    expect((await pick(b, s.id, s.fighters[3]!)).ok).toBe(true);
  });

  it("locks the instant the battle in front is decided — a late pick is refused, an existing pick cannot change, nothing is written", async () => {
    const s = await onStage();
    const a = await member();
    const late = await member();
    expect((await pick(a, s.id, s.fighters[0]!)).ok).toBe(true);
    clock.ms = s.decidedAt;
    expect(await pick(late, s.id, s.fighters[0]!)).toEqual({ ok: false, reason: "LOCKED" });
    expect(await pick(a, s.id, s.fighters[1]!)).toEqual({ ok: false, reason: "LOCKED" });
    expect((await getMyPick(db, a, s.id))!.characterId).toBe(s.fighters[0]);
    expect(await count(db, "arena_picks")).toBe(1);
  });

  it("stamps the close moment once — at the DECIDING instant, not when the arena got round to it — and freezes the picks (even if nobody polls during the fight)", async () => {
    const s = await onStage();
    const a = await member();
    await pick(a, s.id, s.fighters[0]!);
    clock.ms = s.decidedAt + 5000; // a slow worker
    await advanceArena(db, arenaCtx(clock));
    const [battle] = await db.query<{ picks_locked_at: Date; picks_lock_reason: string }>("select picks_locked_at, picks_lock_reason from public.arena_battles where id = $1", [s.id]);
    expect(battle!.picks_locked_at.getTime()).toBe(s.decidedAt);
    expect(battle!.picks_lock_reason).toBe("PREDECESSOR_DECIDED");
    const [row] = await db.query<{ locked_at: Date | null }>("select locked_at from public.arena_picks");
    expect(row!.locked_at!.getTime()).toBe(s.decidedAt);
    // And even though the stamp was written 5 s late, the 5 s did not extend the window: the rule is the deciding instant.
    expect(await pick(await member(), s.id, s.fighters[1]!)).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("never depends on the battle's OWN combat start any more: once the battle in front is decided, its combat start changes nothing", async () => {
    const s = await onStage();
    const a = await member();
    clock.ms = s.decidedAt - 1;
    expect((await pick(a, s.id, s.fighters[0]!)).ok).toBe(true);
    for (const t of [s.decidedAt, s.startsAt - 1, s.startsAt, s.lockAt - 1, s.lockAt, s.endsAt]) {
      clock.ms = t;
      expect(await pick(await member(), s.id, s.fighters[0]!), `at +${t - s.decidedAt} ms`).toEqual({ ok: false, reason: "LOCKED" });
    }
  });

  it("the battle ON STAGE is never a pick target", async () => {
    const s = await onStage();
    clock.ms = s.predecessorStartsAt + 100;
    const onStageFighter = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 limit 1", [s.predecessorId]))[0]!.character_id;
    expect(await pick(await member(), s.predecessorId, onStageFighter)).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("the battle behind the upcoming one is not open yet", async () => {
    const s = await onStage();
    const [behind] = await db.query<{ id: string }>("select id from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz order by sequence limit 1", [new Date(s.startsAt).toISOString()]);
    const f = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 limit 1", [behind!.id]))[0]!.character_id;
    expect(await pick(await member(), behind!.id, f)).toEqual({ ok: false, reason: "NOT_OPEN" });
  });

  it("a resolved (settled) battle rejects new picks and changes", async () => {
    const s = await onStage();
    const a = await member();
    await pick(a, s.id, s.fighters[0]!);
    await settleNow(s);
    expect(await pick(await member(), s.id, s.fighters[0]!)).toEqual({ ok: false, reason: "RESOLVED" });
    expect(await pick(a, s.id, s.fighters[1]!)).toEqual({ ok: false, reason: "RESOLVED" });
  });

  it("unknown battles are 404-style; a hero who is not one of the eight is refused", async () => {
    const s = await onStage();
    expect(await pick(await member(), crypto.randomUUID(), s.fighters[0]!)).toEqual({ ok: false, reason: "NOT_FOUND" });
    const outsider = s.heroes.find((h) => !s.fighters.includes(h))!;
    expect(await pick(await member(), s.id, outsider)).toEqual({ ok: false, reason: "NOT_A_FIGHTER" });
  });
});

describe("free picks — one per member per battle", () => {
  it("a second submission replaces the first (still ONE row), counting the change", async () => {
    const s = await onStage();
    const a = await member();
    const first = await pick(a, s.id, s.fighters[0]!);
    expect(first).toMatchObject({ ok: true, changed: true });
    const same = await pick(a, s.id, s.fighters[0]!);
    expect(same).toMatchObject({ ok: true, changed: false });
    const second = await pick(a, s.id, s.fighters[3]!);
    expect(second).toMatchObject({ ok: true, changed: true });
    expect(await count(db, "arena_picks", `telegram_user_id = ${a}`)).toBe(1);
    expect((await getMyPick(db, a, s.id))).toMatchObject({ characterId: s.fighters[3], changedCount: 1, locked: false, result: null });
  });

  it("different members pick independently", async () => {
    const s = await onStage();
    const [a, b] = [await member(), await member()];
    await pick(a, s.id, s.fighters[0]!);
    await pick(b, s.id, s.fighters[0]!);
    expect(await count(db, "arena_picks")).toBe(2);
    expect((await getMyPick(db, a, s.id))!.characterId).toBe((await getMyPick(db, b, s.id))!.characterId);
  });

  it("concurrent double-submits can never create two picks", async () => {
    const s = await onStage();
    const a = await member();
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => pick(a, s.id, s.fighters[i % 3]!)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await count(db, "arena_picks", `telegram_user_id = ${a}`)).toBe(1);
  });

  it("the database itself refuses a duplicate or a pick for a non-fighter, whatever the code does", async () => {
    const s = await onStage();
    const a = await member();
    await pick(a, s.id, s.fighters[0]!);
    await expect(db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, $4::timestamptz)", [s.id, a, s.fighters[1], clock.now().toISOString()])).rejects.toThrow(/duplicate|unique/i);
    const outsider = s.heroes.find((h) => !s.fighters.includes(h))!;
    await expect(db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, $4::timestamptz)", [s.id, await member(), outsider, clock.now().toISOString()])).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("free picks — settlement and rewards", () => {
  it("detects the winner: correct picks resolve CORRECT, everything else INCORRECT", async () => {
    const s = await onStage();
    const [right, wrong] = [await member(), await member()];
    await pick(right, s.id, s.winner);
    await pick(wrong, s.id, s.loser);
    await settleNow(s);
    expect(await getMyPick(db, right, s.id)).toMatchObject({ result: "CORRECT", locked: true });
    expect(await getMyPick(db, wrong, s.id)).toMatchObject({ result: "INCORRECT", rewardGold: 0 });
    expect(await count(db, "arena_picks", "result is null")).toBe(0);
  });

  it("pays the configured Clank Gold to a correct picker's claimed hero; wrong picks cost and earn nothing", async () => {
    const s = await onStage();
    const owner = await claim(s.heroes[0]!);
    const owner2 = await claim(s.heroes[1]!);
    const before = [await getBalance(db, s.heroes[0]!), await getBalance(db, s.heroes[1]!)];
    await pick(owner, s.id, s.winner);
    await pick(owner2, s.id, s.loser);
    await settleNow(s);
    const reward = (await loadSettings(db)).picks.rewardGold;
    expect(reward).toBeGreaterThan(0);
    // Heroes may also earn arena rewards for fighting (the battles played on the way), so compare the pick-specific ledger rows.
    const ledger = await db.query<{ character_id: string; delta: number }>("select character_id, delta from public.currency_ledger where reason = 'arena_pick_reward'");
    expect(ledger).toEqual([{ character_id: s.heroes[0], delta: reward }]);
    expect(await getMyPick(db, owner, s.id)).toMatchObject({ result: "CORRECT", rewardGold: reward });
    expect((await getMyPick(db, owner2, s.id))!.rewardGold).toBe(0);
    expect(await getBalance(db, s.heroes[0]!)).toBeGreaterThanOrEqual(before[0]! + reward);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("a correct picker without a claimed hero is CORRECT but receives nothing (Clank Gold lives on heroes)", async () => {
    const s = await onStage();
    const lurker = await member();
    await pick(lurker, s.id, s.winner);
    await settleNow(s);
    expect(await getMyPick(db, lurker, s.id)).toMatchObject({ result: "CORRECT", rewardGold: 0 });
    expect(await count(db, "currency_ledger", "reason = 'arena_pick_reward'")).toBe(0);
  });

  it("settling twice never pays twice (ledger key + one-way resolution)", async () => {
    const s = await onStage();
    const owner = await claim(s.heroes[0]!);
    await pick(owner, s.id, s.winner);
    await settleNow(s);
    const paid = await count(db, "currency_ledger", "reason = 'arena_pick_reward'");
    expect(paid).toBe(1);
    // replay the whole settlement transition, and the pick settlement on its own
    const settings = await loadSettings(db);
    expect(await db.transaction((tx) => settleBattle(tx, arenaCtx(clock), s.id, settings))).toBe(false);
    const again = await db.transaction((tx) => settlePicks(tx, s.id, settings.picks.rewardGold, clock.now().toISOString()));
    expect(again).toMatchObject({ resolved: 0, rewarded: 0, goldPaid: 0 });
    // resolved picks are frozen outright (even a no-op write is refused), and the ledger key is unique,
    // so a hand-forged re-run of the reward cannot double-pay either
    await expect(db.exec(`update public.arena_picks set reward_gold = reward_gold`)).rejects.toThrow(/frozen/);
    const [mine] = await db.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [owner]);
    await expect(db.query("insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ($1, 5, 'arena_pick_reward', $2)", [mine!.id, `pick:${s.id}:${owner}:reward`])).rejects.toThrow(/duplicate|unique/i);
    expect(await count(db, "currency_ledger", "reason = 'arena_pick_reward'")).toBe(1);
    expect(await auditLedger(db)).toEqual([]);
  });

  it("the reward is configurable and 0 disables it", async () => {
    const settings = await loadSettings(db);
    await saveSetting(db, "picks", { ...settings.picks, rewardGold: 0 }, "test");
    const s = await onStage();
    const owner = await claim(s.heroes[0]!);
    await pick(owner, s.id, s.winner);
    await settleNow(s);
    expect(await getMyPick(db, owner, s.id)).toMatchObject({ result: "CORRECT", rewardGold: 0 });
    expect(await count(db, "currency_ledger", "reason = 'arena_pick_reward'")).toBe(0);

    await saveSetting(db, "picks", { ...settings.picks, rewardGold: 7 }, "test");
    // The next battle takes the stage; picks are open on the one after it.
    const [following] = await db.query<{ starts_at: Date }>("select starts_at from public.arena_battles where status = 'SIMULATED' order by sequence limit 1");
    clock.ms = following!.starts_at.getTime();
    await advanceArena(db, arenaCtx(clock));
    const s2 = await upcomingNow(s.heroes);
    const owner2 = await claim(s.heroes.find((h) => h !== s.heroes[0])!);
    await pick(owner2, s2.id, s2.winner); // the (server-known) winner of that battle
    await settleNow(s2);
    expect(await getMyPick(db, owner2, s2.id)).toMatchObject({ result: "CORRECT", rewardGold: 7 });
    expect((await db.query<{ delta: number }>("select delta from public.currency_ledger where reason = 'arena_pick_reward'")).map((r) => r.delta)).toEqual([7]);
  });
});

describe("free picks — database guards (defence in depth)", () => {
  it("a resolved pick is frozen; a locked pick cannot change its choice; a settled battle accepts no new pick", async () => {
    const s = await onStage();
    const a = await member();
    await pick(a, s.id, s.fighters[0]!);
    clock.ms = s.decidedAt + 1;
    await advanceArena(db, arenaCtx(clock)); // stamps the lock on the battle and locked_at on its picks
    await expect(db.query("update public.arena_picks set character_id = $1 where telegram_user_id = $2", [s.fighters[1], a])).rejects.toThrow(/locked/);
    await settleNow(s);
    await expect(db.query("update public.arena_picks set result = 'CORRECT' where telegram_user_id = $1", [a])).rejects.toThrow(/frozen/);
    await expect(db.query("update public.arena_picks set reward_gold = 99 where telegram_user_id = $1", [a])).rejects.toThrow();
    await expect(db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, $4::timestamptz)", [s.id, await member(), s.fighters[0], clock.now().toISOString()])).rejects.toThrow(/prepared upcoming battle/);
  });

  it("the database refuses a pick once the window is stamped closed, or at/after the battle's own start — whatever the service does", async () => {
    const s = await onStage();
    const early = await member();
    await pick(early, s.id, s.fighters[0]!);
    clock.ms = s.decidedAt + 1;
    await advanceArena(db, arenaCtx(clock)); // the arena stamps B's window closed
    const insert = (who: number, at: number) => db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, $4::timestamptz)", [s.id, who, s.fighters[0], new Date(at).toISOString()]);
    await expect(insert(await member(), s.decidedAt - 5_000)).rejects.toThrow(/locked/); // even a back-dated submit: the stamp is the authority
    // A battle whose window was never stamped (e.g. prepared by an older build) still cannot take a pick at/after its start.
    const [behind] = await db.query<{ id: string; starts_at: Date }>("select id, starts_at from public.arena_battles where status = 'SIMULATED' and starts_at > $1::timestamptz order by sequence limit 1", [new Date(s.startsAt).toISOString()]);
    const f = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1 limit 1", [behind!.id]))[0]!.character_id;
    await expect(db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at) values ($1, $2, $3, $4::timestamptz)", [behind!.id, await member(), f, behind!.starts_at.toISOString()])).rejects.toThrow(/locked/);
  });

  it("a window closes exactly once: the stamp can never be moved or cleared", async () => {
    const s = await onStage();
    clock.ms = s.decidedAt + 1;
    await advanceArena(db, arenaCtx(clock));
    await expect(db.query("update public.arena_battles set picks_locked_at = now() where id = $1", [s.id])).rejects.toThrow(/closes exactly once/);
    await expect(db.query("update public.arena_battles set picks_locked_at = null, picks_lock_reason = null where id = $1", [s.id])).rejects.toThrow(/closes exactly once/);
    expect(await count(db, "arena_battles", `id = '${s.id}' and picks_lock_reason = 'PREDECESSOR_DECIDED'`)).toBe(1);
  });

  it("identity is immutable and a new pick can never arrive pre-resolved", async () => {
    const s = await onStage();
    const a = await member();
    await pick(a, s.id, s.fighters[0]!);
    await expect(db.query("update public.arena_picks set telegram_user_id = $1 where telegram_user_id = $2", [await member(), a])).rejects.toThrow(/immutable/);
    await expect(db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, result, settled_at, submitted_at) values ($1, $2, $3, 'CORRECT', now(), $4::timestamptz)", [s.id, await member(), s.fighters[0], clock.now().toISOString()])).rejects.toThrow(/resolved/);
  });

  it("there is no money anywhere: no stake, balance or custody columns exist on picks", async () => {
    const cols = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'arena_picks'")).map((c) => c.column_name);
    expect(cols.filter((c) => /stake|amount|wager|bet|deposit|balance|token|usdc|eth/.test(c))).toEqual([]);
  });
});
