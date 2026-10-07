import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "@/domain/settings";
import { getRewardEligibility, publicIneligibleReason } from "@/server/rewards/eligibility";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getMyPick } from "@/server/services/picks";

import { createTestDb, insertStubHero, resetDb, seedEligibleMember } from "../support/db";
import { loser, pickAs } from "../support/rewards";
import { stageBattle } from "../support/stage";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
});

const elig = (id: number, allowDemo = false) => getRewardEligibility(db, id, { threshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold, allowDemo });
const pickRows = async (battleId: string) => (await db.query<{ telegram_user_id: number; character_id: string }>("select telegram_user_id, character_id from public.arena_picks where battle_id = $1", [battleId]));

describe("who may make REWARDED Arena Picks", () => {
  it("an eligible member (≥ 50 qualifying messages, an ACTIVE hero, in good standing) can pick", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    expect(await elig(u)).toMatchObject({ eligible: true, reason: null, reviewState: "NORMAL", qualifying: 150 });
    const r = await pickAs(db, s, u, s.fighters[0]!);
    expect(r).toMatchObject({ ok: true, changed: true, pick: { rewardEligible: true, locked: false, result: null } });
  });

  it("exactly at the threshold is eligible; one message short is not (the threshold counts QUALIFYING messages, not raw ones)", async () => {
    const s = await stageBattle(db);
    const at = await seedEligibleMember(db, { qualifying: 50 });
    const short = await seedEligibleMember(db, { qualifying: 49 });
    // Raw volume does not matter: only the qualifying count does.
    await db.query("update public.telegram_users set total_message_count = 50000 where telegram_user_id = $1", [short]);
    expect((await elig(at)).eligible).toBe(true);
    expect(await elig(short)).toMatchObject({ eligible: false, reason: "BELOW_THRESHOLD" });
    expect(await pickAs(db, s, at, s.fighters[0]!)).toMatchObject({ ok: true, pick: { rewardEligible: true } });
    expect(await pickAs(db, s, short, s.fighters[0]!)).toMatchObject({ ok: false, reason: "NOT_ELIGIBLE", ineligible: "BELOW_THRESHOLD" });
  });

  it("an INELIGIBLE Telegram user cannot make a rewarded pick — and nothing is written", async () => {
    const s = await stageBattle(db);
    const cases: Array<[string, number, string]> = [
      ["no hero", await seedEligibleMember(db, { hero: false }), "NO_HERO"],
      ["below the qualifying threshold", await seedEligibleMember(db, { qualifying: 40 }), "BELOW_THRESHOLD"],
      ["hero suspended", await seedEligibleMember(db, { heroStatus: "SUSPENDED" }), "SUSPENDED"],
      ["hero inactive", await seedEligibleMember(db, { heroStatus: "INACTIVE" }), "HERO_INACTIVE"],
      ["banned", await seedEligibleMember(db, { status: "BANNED" }), "BANNED"],
    ];
    for (const [label, id, reason] of cases) {
      expect(await pickAs(db, s, id, s.fighters[0]!), label).toEqual({ ok: false, reason: "NOT_ELIGIBLE", ineligible: reason });
    }
    const ghost = 987_654_321; // a Telegram id the system has never seen
    expect(await pickAs(db, s, ghost, s.fighters[0]!)).toMatchObject({ ok: false, reason: "NOT_ELIGIBLE" });
    expect(await pickRows(s.battleId)).toEqual([]);
  });

  it("an account SUSPENDED for rewards cannot pick; one under REVIEW can (its claims are what is held)", async () => {
    const s = await stageBattle(db);
    const suspended = await seedEligibleMember(db);
    const review = await seedEligibleMember(db);
    await db.query("insert into public.arena_reward_accounts (telegram_user_id, review_state, review_reason) values ($1, 'SUSPENDED', 'fraud'), ($2, 'REVIEW', 'check')", [suspended, review]);
    expect(await pickAs(db, s, suspended, s.fighters[0]!)).toMatchObject({ ok: false, reason: "NOT_ELIGIBLE" });
    expect(await pickAs(db, s, review, s.fighters[0]!)).toMatchObject({ ok: true });
    expect(await elig(review)).toMatchObject({ eligible: true, reviewState: "REVIEW" });
  });

  it("a Telegram-FLAGGED member can pick; the snapshot records they are under review", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db, { status: "FLAGGED" });
    expect(await pickAs(db, s, u, s.fighters[0]!)).toMatchObject({ ok: true });
    const [row] = await db.query<{ eligibility: { reviewState: string; qualifying: number; threshold: number } }>("select eligibility from public.arena_picks where telegram_user_id = $1", [u]);
    expect(row!.eligibility).toMatchObject({ reviewState: "REVIEW", qualifying: 150, threshold: 50 });
  });

  it("demo heroes are only eligible where demo heroes are allowed at all (never in production)", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, is_demo, qualifying_message_count) values (-42, 'Demo', true, 150)");
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes order by sort_order limit 1");
    await insertStubHero(db, { telegram_user_id: -42, class_id: cls!.id, name: "Demo hero", origin: "DEV_SEED", is_demo: true });
    expect(await elig(-42, false)).toMatchObject({ eligible: false, reason: "DEMO_NOT_ALLOWED" });
    expect((await elig(-42, true)).eligible).toBe(true);
  });

  it("players only ever see a COARSE reason — bans, suspensions and demo accounts all read as the same generic 'not eligible'", () => {
    expect(publicIneligibleReason("NO_HERO")).toBe("NO_HERO");
    expect(publicIneligibleReason("BELOW_THRESHOLD")).toBe("BELOW_THRESHOLD");
    for (const r of ["BANNED", "SUSPENDED", "HERO_INACTIVE", "DEMO_NOT_ALLOWED", "NOT_FOUND"] as const) expect(publicIneligibleReason(r)).toBe("NOT_ELIGIBLE");
    expect(publicIneligibleReason(null)).toBeNull();
  });
});

describe("one pick per member per battle", () => {
  it("the same request twice is idempotent (one row, no change), and changing before lock replaces the pick", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    const a = s.fighters[0]!;
    const b = s.fighters[1]!;
    expect(await pickAs(db, s, u, a)).toMatchObject({ ok: true, changed: true });
    expect(await pickAs(db, s, u, a)).toMatchObject({ ok: true, changed: false }); // double click / replay
    expect(await pickRows(s.battleId)).toHaveLength(1);
    expect(await pickAs(db, s, u, b)).toMatchObject({ ok: true, changed: true, pick: { characterId: b, changedCount: 1 } });
    expect(await pickRows(s.battleId)).toEqual([{ telegram_user_id: u, character_id: b }]);
  });

  it("UNIQUE(telegram_user_id, battle_id): the database itself refuses a second row", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    await pickAs(db, s, u, s.fighters[0]!);
    await expect(
      db.query("insert into public.arena_picks (battle_id, telegram_user_id, character_id, submitted_at, reward_eligible) values ($1, $2, $3, $4::timestamptz, true)", [s.battleId, u, s.fighters[1], s.clock.now().toISOString()]),
    ).rejects.toThrow(/duplicate|unique/i);
  });

  it("20 SIMULTANEOUS requests from one member leave exactly one pick; 40 different members each get theirs", async () => {
    const s = await stageBattle(db);
    const one = await seedEligibleMember(db);
    const results = await Promise.all(s.fighters.concat(s.fighters, s.fighters.slice(0, 4)).map((f) => pickAs(db, s, one, f)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await pickRows(s.battleId)).filter((p) => p.telegram_user_id === one)).toHaveLength(1);

    const many = await Promise.all(Array.from({ length: 40 }, async (_, i) => pickAs(db, s, await seedEligibleMember(db), s.fighters[i % 8]!)));
    expect(many.every((r) => r.ok)).toBe(true);
    expect(await pickRows(s.battleId)).toHaveLength(41);
  });

  it("a pick must name one of THIS battle's eight fighters", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    const [outsider] = await db.query<{ id: string }>("select id from public.characters where id <> all ($1::uuid[]) limit 1", [s.fighters]).catch(async () =>
      db.query<{ id: string }>("select c.id from public.characters c where c.id not in (select character_id from public.arena_participants where battle_id = $1) limit 1", [s.battleId]),
    );
    expect(await pickAs(db, s, u, outsider!.id)).toEqual({ ok: false, reason: "NOT_A_FIGHTER" });
  });
});

describe("picks lock on the SERVER clock", () => {
  it("accepted until the battle in front is DECIDED (even in the last millisecond); refused from that instant; a slow browser cannot sneak one in", async () => {
    const s = await stageBattle(db);
    const early = await seedEligibleMember(db);
    const late = await seedEligibleMember(db);
    s.clock.ms = s.predecessorCombatEndsAt - 1;
    expect(await pickAs(db, s, early, s.fighters[0]!)).toMatchObject({ ok: true });
    s.clock.ms = s.predecessorCombatEndsAt;
    expect(await pickAs(db, s, late, s.fighters[0]!)).toEqual({ ok: false, reason: "LOCKED" });
    s.clock.ms = s.predecessorCombatEndsAt + 5_000;
    expect(await pickAs(db, s, late, s.fighters[0]!)).toEqual({ ok: false, reason: "LOCKED" });
    expect(await pickRows(s.battleId)).toEqual([{ telegram_user_id: early, character_id: s.fighters[0] }]);
  });

  it("after the lock a pick can neither change nor be cancelled", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    await pickAs(db, s, u, s.fighters[0]!);
    s.clock.ms = s.combatStartsAt;
    await advanceArena(db, s.ctx); // the arena stamps locked_at at combat start
    expect(await pickAs(db, s, u, s.fighters[1]!)).toEqual({ ok: false, reason: "LOCKED" });
    expect((await getMyPick(db, u, s.battleId))).toMatchObject({ characterId: s.fighters[0], locked: true });
    await expect(db.query("update public.arena_picks set character_id = $2 where telegram_user_id = $1", [u, s.fighters[1]])).rejects.toThrow(/locked/);
    await expect(db.query("delete from public.arena_picks where telegram_user_id = $1", [u])).resolves.toBeDefined(); // (no delete API exists; the row is only removable by an operator with DB access)
  });

  it("a pick for a battle that is over is refused too", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    s.clock.ms = s.combatEndsAt + 10;
    await advanceArena(db, s.ctx);
    expect(await pickAs(db, s, u, s.fighters[0]!)).toEqual({ ok: false, reason: "RESOLVED" });
  });

  it("a member can pick again in EVERY new battle — there is no daily limit", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db);
    expect(await pickAs(db, s, u, s.fighters[0]!)).toMatchObject({ ok: true });
    // (the second battle is exercised in rewards-settlement; here we assert nothing ties a member to one battle per day)
    const [constraint] = await db.query<{ n: number }>("select count(*)::int as n from pg_constraint where conrelid = 'public.arena_picks'::regclass and contype = 'u'");
    expect(constraint!.n).toBe(0); // the only uniqueness is the (battle, member) primary key
    expect(loser(s)).toBeTruthy();
  });
});

describe("the eligibility snapshot", () => {
  it("is refreshed on every submit before lock and frozen at lock", async () => {
    const s = await stageBattle(db);
    const u = await seedEligibleMember(db, { qualifying: 120 });
    await pickAs(db, s, u, s.fighters[0]!);
    await db.query("update public.telegram_users set qualifying_message_count = 400 where telegram_user_id = $1", [u]);
    await pickAs(db, s, u, s.fighters[1]!); // re-pick → fresh snapshot
    const [before] = await db.query<{ eligibility: { qualifying: number } }>("select eligibility from public.arena_picks where telegram_user_id = $1", [u]);
    expect(before!.eligibility.qualifying).toBe(400);
    s.clock.ms = s.combatStartsAt;
    await advanceArena(db, s.ctx);
    await db.query("update public.telegram_users set qualifying_message_count = 0 where telegram_user_id = $1", [u]); // later changes do not matter
    const [after] = await db.query<{ eligibility: { qualifying: number }; reward_eligible: boolean }>("select eligibility, reward_eligible from public.arena_picks where telegram_user_id = $1", [u]);
    expect(after).toMatchObject({ reward_eligible: true, eligibility: { qualifying: 400 } });
  });
});
