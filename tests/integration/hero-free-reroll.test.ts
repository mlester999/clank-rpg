import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateCharacter, type GenerateCharacterInput } from "@/domain/character/generate";
import { FREE_REROLL_FLAG, rerollDay } from "@/domain/hero/freeReroll";
import { computeHeroPower } from "@/domain/hero/power";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, replayBattle } from "@/server/services/arena";
import { freeRerollReady, getFreeRerollStatus, rerollOwnHero, type FreeRerollDeps, type FreeRerollError } from "@/server/services/heroFreeReroll";
import { heroArenaLock } from "@/server/services/heroVersionStore";
import { claimCharacter } from "@/server/services/identity";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

const SECRET = "test-secret-value-1234567890";
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0); // 2026-10-09 12:00 UTC
let db: Db;
let clock: FakeClock;
let deps: FreeRerollDeps;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock(T0);
  deps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: SECRET, now: clock.now, allowDemo: true };
});

const uuid = () => crypto.randomUUID();
const refusal = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as FreeRerollError | null;
let nextMember = 880_000;

/** A claimed member with a hero. */
async function member(opts: { claim?: boolean } = {}): Promise<{ tid: number; hero: string }> {
  const tid = nextMember++;
  const [hero] = await seedHeroes(db, 1, { startId: tid });
  if (opts.claim !== false) await claimCharacter(db, tid, clock.now());
  return { tid, hero: hero! };
}
const versionRows = (hero: string) =>
  db.query<{ id: string; version_number: number; action: string; created_by: string; request_id: string | null; previous_version_id: string | null; class_id: string; rarity: string; power: number; stats: Record<string, number> }>(
    "select id, version_number, action, created_by, request_id, previous_version_id, class_id, rarity, power, stats from public.hero_versions where character_id = $1 order by version_number", [hero]);
const allowanceRows = (tid: number) => db.query<{ utc_day: string; request_id: string; character_id: string }>("select utc_day::text as utc_day, request_id, character_id from public.hero_free_rerolls where telegram_user_id = $1 order by utc_day", [tid]);
const heroState = async (hero: string) =>
  (await db.query<Record<string, unknown>>(
    `select c.class_id, c.current_hero_version_id, c.power, a.rarity, a.parts, a.seed, a.sprite, s.variation, s.telegram_bonus from public.characters c
       join public.character_stats s on s.character_id = c.id join public.character_appearances a on a.character_id = c.id where c.id = $1`, [hero]))[0]!;
const auditsClean = async () => {
  expect(await db.query("select * from public.audit_hero_versions()")).toEqual([]);
  expect(await db.query("select * from public.audit_hero_free_rerolls()")).toEqual([]);
};

describe("the first free reroll of the day", () => {
  it("appends exactly one REROLL version made by the member, moves the hero, consumes today's allowance and writes an audit entry — hero identity untouched", async () => {
    const { tid, hero } = await member();
    const before = await heroState(hero);
    const [identityBefore] = await db.query<Record<string, unknown>>("select id, kind, telegram_user_id, public_id, name, status, origin, created_at from public.characters where id = $1", [hero]);
    const key = uuid();
    const r = await rerollOwnHero(db, tid, key, deps);

    expect(r.alreadyApplied).toBe(false);
    expect(r.requestId).toBe(key);
    expect(r.rerolledAt).toBe(T0);
    const v = await versionRows(hero);
    expect(v.map((x) => [x.version_number, x.action, x.created_by])).toEqual([[1, "INITIAL", "system:telegram"], [2, "REROLL", `member:${tid}`]]);
    expect(v[1]).toMatchObject({ request_id: key, previous_version_id: v[0]!.id });
    expect((await heroState(hero)).current_hero_version_id).toBe(v[1]!.id);
    expect(await allowanceRows(tid)).toEqual([{ utc_day: "2026-10-09", request_id: key, character_id: hero }]);

    // the result shows BEFORE and AFTER from the two stored versions
    expect(r.before.classId).toBe(before.class_id);
    expect(r.before.rarity).toBe(before.rarity);
    expect(r.after.classId).toBe(v[1]!.class_id);
    expect(r.after.rarity).toBe(v[1]!.rarity);
    expect(r.after.power).toBe(Number(v[1]!.power));
    expect(r.comparison.powerDelta).toBe(r.after.power - r.before.power);

    // identity, owner, claim, public id: untouched
    const [identityAfter] = await db.query<Record<string, unknown>>("select id, kind, telegram_user_id, public_id, name, status, origin, created_at from public.characters where id = $1", [hero]);
    expect(identityAfter).toEqual(identityBefore);
    expect(await count(db, "characters")).toBe(1);
    expect(await count(db, "character_claims")).toBe(1);
    const log = await db.query<{ actor: string; action: string; detail: Record<string, unknown> }>("select actor, action, detail from public.admin_audit_log where action = 'hero.free_reroll'");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: `member:${tid}`, detail: { heroId: hero, utcDay: "2026-10-09", requestId: key, previousVersion: 1, newVersion: 2 } });
    expect(JSON.stringify(log[0]!.detail)).not.toMatch(/seed|nonce/i);
    await auditsClean();
  });

  it("the result and the new hero are a valid hero-gen/2 roll: PWR inside the rarity's band, equal to the power of the stats", async () => {
    const { tid, hero } = await member();
    const r = await rerollOwnHero(db, tid, uuid(), deps);
    const [v] = (await versionRows(hero)).slice(-1);
    expect(v!.power).toBeGreaterThanOrEqual(RARITY_RULES[v!.rarity as "COMMON"].powerMin);
    expect(v!.power).toBeLessThanOrEqual(RARITY_RULES[v!.rarity as "COMMON"].powerMax);
    expect(computeHeroPower(v!.stats as never, v!.class_id)).toBe(Number(v!.power));
    expect(JSON.stringify(r)).not.toMatch(/generationSeed|telegram_user_id|nonce/);
  });
});

describe("ONE per UTC calendar day — enforced by the server and the database", () => {
  it("a second reroll the same UTC day is refused, writes nothing and the hero stays as the first reroll left it", async () => {
    const { tid, hero } = await member();
    await rerollOwnHero(db, tid, uuid(), deps);
    const after1 = await heroState(hero);
    clock.advance(3 * 3_600_000);
    const e = await refusal(rerollOwnHero(db, tid, uuid(), deps));
    expect(e).toMatchObject({ code: "ALREADY_USED_TODAY", status: 409 });
    expect(e!.detail.nextResetAt).toBe(Date.UTC(2026, 9, 10));
    expect(await versionRows(hero)).toHaveLength(2);
    expect(await heroState(hero)).toEqual(after1);
    expect(await allowanceRows(tid)).toHaveLength(1);
  });

  it("the allowance comes back at 00:00 UTC — NOT 24 hours later: a reroll at 23:50 UTC is allowed again at 00:00:00 the next day", async () => {
    const { tid, hero } = await member();
    clock.ms = Date.UTC(2026, 9, 9, 23, 50, 0);
    await rerollOwnHero(db, tid, uuid(), deps);
    clock.ms = Date.UTC(2026, 9, 9, 23, 59, 59, 999);
    expect((await refusal(rerollOwnHero(db, tid, uuid(), deps)))?.code).toBe("ALREADY_USED_TODAY"); // one millisecond before midnight: still used
    clock.ms = Date.UTC(2026, 9, 10, 0, 0, 0, 0);
    await rerollOwnHero(db, tid, uuid(), deps); // exactly at midnight: a new day, 10 minutes after the last reroll — a rolling 24-hour cooldown would refuse this
    expect((await allowanceRows(tid)).map((a) => a.utc_day)).toEqual(["2026-10-09", "2026-10-10"]);
    expect(await versionRows(hero)).toHaveLength(3);
    clock.ms = Date.UTC(2026, 9, 10, 0, 0, 1);
    expect((await refusal(rerollOwnHero(db, tid, uuid(), deps)))?.code).toBe("ALREADY_USED_TODAY");
    await auditsClean();
  });

  it("a reroll just AFTER midnight is a fresh day's allowance; the next reset is the following midnight, however late in the day it was used", async () => {
    const { tid } = await member();
    clock.ms = Date.UTC(2026, 9, 10, 0, 0, 0, 1);
    await rerollOwnHero(db, tid, uuid(), deps);
    const s = await getFreeRerollStatus(db, tid, true, deps);
    expect(s.state).toBe("USED");
    expect(s.nextResetAt).toBe(Date.UTC(2026, 9, 11));
    expect(s.utcDay).toBe("2026-10-10");
  });

  it("the day is the SERVER's UTC day: no timezone, device clock or browser countdown is an input anywhere", async () => {
    expect(rerollDay(Date.UTC(2026, 9, 9, 23, 59, 59))).toBe("2026-10-09");
    expect(rerollDay(Date.UTC(2026, 9, 10, 0, 0, 0))).toBe("2026-10-10");
    const { tid } = await member();
    const status = await getFreeRerollStatus(db, tid, true, deps);
    expect(status).toMatchObject({ serverNow: T0, utcDay: "2026-10-09" }); // everything the browser anchors its countdown to comes from here
    await rerollOwnHero(db, tid, uuid(), deps);
    expect((await refusal(rerollOwnHero(db, tid, uuid(), deps)))?.code).toBe("ALREADY_USED_TODAY");
  });

  it("the DATABASE refuses a second allowance for the same member and UTC day even when the application is bypassed", async () => {
    const { tid, hero } = await member();
    await rerollOwnHero(db, tid, uuid(), deps);
    const [row] = await db.query<Record<string, unknown>>("select * from public.hero_free_rerolls where telegram_user_id = $1", [tid]);
    await expect(
      db.query(
        `insert into public.hero_free_rerolls (telegram_user_id, utc_day, character_id, request_id, hero_version_id, previous_version_id, from_class_id, from_rarity, from_power, to_class_id, to_rarity, to_power, created_at)
         select telegram_user_id, utc_day, character_id, request_id, hero_version_id, previous_version_id, from_class_id, from_rarity, from_power, to_class_id, to_rarity, to_power, created_at from public.hero_free_rerolls`,
      ),
    ).rejects.toThrow(/hero_free_rerolls_pkey|duplicate key/);
    expect(row).toBeTruthy();
    expect(await versionRows(hero)).toHaveLength(2);
  });

  it("a day that disagrees with the instant cannot be written (utc_day is derived from created_at by a CHECK)", async () => {
    const { tid } = await member();
    await rerollOwnHero(db, tid, uuid(), deps);
    await expect(db.query("update public.hero_free_rerolls set utc_day = '2026-10-01'")).rejects.toThrow(/immutable|update rejected/);
    await expect(db.exec(`alter table public.hero_free_rerolls disable trigger hero_free_rerolls_immutable; update public.hero_free_rerolls set utc_day = '2026-10-01'`)).rejects.toThrow(/day_matches_instant/);
    await db.exec("alter table public.hero_free_rerolls enable trigger hero_free_rerolls_immutable").catch(() => undefined);
  });
});

describe("concurrency, retries and replays", () => {
  it("two tabs at once (different keys): exactly ONE reroll succeeds, the other is refused, one version exists", async () => {
    const { tid, hero } = await member();
    const results = await Promise.allSettled([rerollOwnHero(db, tid, uuid(), deps), rerollOwnHero(db, tid, uuid(), deps), rerollOwnHero(db, tid, uuid(), deps), rerollOwnHero(db, tid, uuid(), deps)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect((r.reason as FreeRerollError).code).toBe("ALREADY_USED_TODAY");
    expect(await versionRows(hero)).toHaveLength(2);
    expect(await allowanceRows(tid)).toHaveLength(1);
    await auditsClean();
  });

  it("a double click / a retry after a lost answer (same key, also concurrently) returns the SAME result and creates ONE version", async () => {
    const { tid, hero } = await member();
    const key = uuid();
    const [a, b, c] = await Promise.all([rerollOwnHero(db, tid, key, deps), rerollOwnHero(db, tid, key, deps), rerollOwnHero(db, tid, key, deps)]);
    expect(await versionRows(hero)).toHaveLength(2);
    expect([a.alreadyApplied, b.alreadyApplied, c.alreadyApplied].filter(Boolean)).toHaveLength(2);
    for (const r of [a, b, c]) {
      expect(r.requestId).toBe(key);
      expect(r.after).toEqual(a.after);
      expect(r.before).toEqual(a.before);
    }
    // a later retry — even on another day, even after another reroll — still shows what THAT request did
    clock.advance(26 * 3_600_000);
    await rerollOwnHero(db, tid, uuid(), deps);
    const again = await rerollOwnHero(db, tid, key, deps);
    expect(again).toMatchObject({ alreadyApplied: true, requestId: key });
    expect(again.after).toEqual(a.after);
    expect(await versionRows(hero)).toHaveLength(3);
  });

  it("another member cannot reuse or replay someone else's key", async () => {
    const a = await member();
    const b = await member();
    const key = uuid();
    await rerollOwnHero(db, a.tid, key, deps);
    expect((await refusal(rerollOwnHero(db, b.tid, key, deps)))?.code).toBe("REQUEST_CONFLICT");
    expect(await versionRows(b.hero)).toHaveLength(1);
    expect(await allowanceRows(b.tid)).toHaveLength(0);
  });

  it("members are independent: two members reroll in parallel and each gets exactly their own allowance and version", async () => {
    const ms = await Promise.all([member(), member(), member(), member()]);
    await Promise.all(ms.map((m) => rerollOwnHero(db, m.tid, uuid(), deps)));
    for (const m of ms) {
      expect(await versionRows(m.hero)).toHaveLength(2);
      expect(await allowanceRows(m.tid)).toHaveLength(1);
    }
    await auditsClean();
  });
});

describe("who may reroll", () => {
  it("a member with no hero, and a hero that is not claimed yet, are refused (nothing consumed)", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values (881001, 'Heroless', 5)");
    expect((await refusal(rerollOwnHero(db, 881001, uuid(), deps)))?.code).toBe("NO_HERO");
    const unclaimed = await member({ claim: false });
    expect(await refusal(rerollOwnHero(db, unclaimed.tid, uuid(), deps))).toMatchObject({ code: "NOT_CLAIMED", status: 403 });
    expect(await versionRows(unclaimed.hero)).toHaveLength(1);
    expect(await allowanceRows(unclaimed.tid)).toHaveLength(0);
    expect((await getFreeRerollStatus(db, unclaimed.tid, true, deps)).block).toBe("NOT_CLAIMED");
  });

  it("a member can only ever change THEIR OWN hero — the body carries no hero id, and another member's hero is never touched", async () => {
    const a = await member();
    const b = await member();
    const bBefore = await heroState(b.hero);
    await rerollOwnHero(db, a.tid, uuid(), deps);
    expect(await heroState(b.hero)).toEqual(bBefore);
    expect(await versionRows(b.hero)).toHaveLength(1);
    // and the database itself refuses an allowance row that points at somebody else's hero
    const [v] = (await versionRows(a.hero)).slice(-1);
    await expect(
      db.query(
        `insert into public.hero_free_rerolls (telegram_user_id, utc_day, character_id, request_id, hero_version_id, previous_version_id, from_class_id, from_rarity, from_power, to_class_id, to_rarity, to_power, created_at)
         values ($1, '2026-10-20', $2, $3, $4, $5, 'x', 'COMMON', 1, 'x', 'COMMON', 1, '2026-10-20T10:00:00Z')`,
        [b.tid, a.hero, uuid(), v!.id, v!.previous_version_id],
      ),
    ).rejects.toThrow(/own member|same hero|does not match/);
  });

  it("a SUSPENDED hero, an inactive hero, a flagged member, a banned member and a special character are refused — the same plain answer, no reason", async () => {
    const s = await member();
    await db.query("update public.characters set status = 'SUSPENDED' where id = $1", [s.hero]);
    const i = await member();
    await db.query("update public.characters set status = 'INACTIVE' where id = $1", [i.hero]);
    const f = await member();
    await db.query("update public.telegram_users set status = 'FLAGGED' where telegram_user_id = $1", [f.tid]);
    const b = await member();
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = $1", [b.tid]);
    for (const m of [s, i, f, b]) {
      const e = await refusal(rerollOwnHero(db, m.tid, uuid(), deps));
      expect(e).toMatchObject({ code: "HERO_UNAVAILABLE", status: 409 });
      expect(e!.message).toBe("Your hero can't be rerolled right now.");
      expect(await versionRows(m.hero)).toHaveLength(1);
      expect(await allowanceRows(m.tid)).toHaveLength(0);
    }
    const status = await getFreeRerollStatus(db, s.tid, true, deps);
    expect(status).toMatchObject({ state: "BLOCKED", block: "HERO_UNAVAILABLE" });
  });
});

describe("Arena safety — a committed roster is never changed, and nothing is consumed by the refusal", () => {
  it("a hero in the on-stage, upcoming or prepared roster is refused with HERO_IN_ARENA and keeps its allowance; once those fights settle it can reroll", async () => {
    const ids = await seedHeroes(db, 30, { startId: 890_000 });
    for (let i = 0; i < 30; i++) await claimCharacter(db, 890_000 + i, clock.now());
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const battles = await db.query<{ id: string }>("select id from public.arena_battles order by sequence");
    expect(battles).toHaveLength(3);
    const rostered = (await db.query<{ character_id: string }>("select distinct character_id from public.arena_participants")).map((r) => r.character_id);
    expect(rostered).toHaveLength(24);
    const tidOf = async (hero: string) => (await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [hero]))[0]!.telegram_user_id;

    const locked = rostered[0]!;
    const lockedTid = await tidOf(locked);
    const snapshotsBefore = JSON.stringify(await db.query("select id, snapshot, events_hash from public.arena_battles order by sequence"));
    const e = await refusal(rerollOwnHero(db, lockedTid, uuid(), deps));
    expect(e).toMatchObject({ code: "HERO_IN_ARENA", status: 409 });
    expect(await versionRows(locked)).toHaveLength(1);
    expect(await allowanceRows(lockedTid)).toHaveLength(0);
    expect(await getFreeRerollStatus(db, lockedTid, true, deps)).toMatchObject({ state: "BLOCKED", block: "HERO_IN_ARENA" });
    expect(JSON.stringify(await db.query("select id, snapshot, events_hash from public.arena_battles order by sequence"))).toBe(snapshotsBefore);

    // a hero in NO unsettled roster is free
    const free = ids.find((id) => !rostered.includes(id))!;
    expect((await heroArenaLock(db, free)).locked).toBe(false);
    await rerollOwnHero(db, await tidOf(free), uuid(), deps);

    // the locked hero's fights settle → the allowance it never spent is still there
    for (let s = 0; s < 800 && (await heroArenaLock(db, locked)).locked; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    if ((await heroArenaLock(db, locked)).locked) return; // lined up again by a fresh cycle: protected, correctly
    await rerollOwnHero(db, lockedTid, uuid(), deps);
    expect(await versionRows(locked)).toHaveLength(2);
  });

  it("historic battles are untouched: snapshot, events hash, replay, placements — and the new version is only used by NEW battles", async () => {
    await seedHeroes(db, 24, { startId: 895_000 });
    for (let i = 0; i < 24; i++) await claimCharacter(db, 895_000 + i, clock.now());
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1] = await db.query<{ id: string }>("select id from public.arena_battles order by sequence limit 1");
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [b1!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const parts = (await db.query<{ character_id: string; telegram_user_id: number }>("select p.character_id, c.telegram_user_id from public.arena_participants p join public.characters c on c.id = p.character_id where p.battle_id = $1", [b1!.id]));
    const fingerprint = async () => JSON.stringify([
      (await db.query<{ snapshot: unknown }>("select snapshot from public.arena_battles where id = $1", [b1!.id]))[0]!.snapshot,
      await db.query("select events_hash, ruleset_hash, seed, winner_id, runner_up_id, result, duration_ms from public.arena_battles where id = $1", [b1!.id]),
      await db.query("select character_id, placement, eliminations, damage_dealt from public.arena_participants where battle_id = $1 order by character_id", [b1!.id]),
      await db.query("select * from public.season_character_stats order by character_id"),
    ]);
    const replayBefore = await replayBattle(db, b1!.id);
    const before = await fingerprint();
    let rerolled = 0;
    for (const p of parts) {
      if ((await heroArenaLock(db, p.character_id)).locked) continue;
      await rerollOwnHero(db, Number(p.telegram_user_id), uuid(), deps);
      rerolled++;
    }
    expect(rerolled).toBeGreaterThan(0);
    expect(await fingerprint()).toBe(before);
    const replayAfter = await replayBattle(db, b1!.id);
    expect(replayAfter!.outcome.eventsHash).toBe(replayBefore!.outcome.eventsHash);
    expect(replayAfter!.outcome.ranking).toEqual(replayBefore!.outcome.ranking);
    await auditsClean();
  });
});

describe("account assets and the hero's career survive a reroll", () => {
  it("Gold, items, achievements, XP, Arena record, Season stats, Picks, rewards, claim and name are all exactly as they were; only class · rarity · PWR · look change", async () => {
    const { tid, hero } = await member();
    await db.query("insert into public.currency_accounts (character_id, balance, lifetime_earned) values ($1, 777, 900)", [hero]);
    await db.query("insert into public.currency_ledger (character_id, delta, reason, idempotency_key) values ($1, 777, 'test', 'test-gold-0001')", [hero]).catch(() => undefined);
    await db.query("update public.characters set xp = 4321, arena_battles = 12, arena_wins = 5, arena_top2 = 7, arena_eliminations = 19, arena_damage = 12345, title = 'Veteran', name_override = 'Renamed Hero', tactic = 'AGGRESSIVE' where id = $1", [hero]);
    await db.query("insert into public.item_templates (id, name, slot, rarity, stat_mods) values ('qa_ring', 'QA Ring', 'TRINKET', 'RARE', '{\"luck\":2}'::jsonb) on conflict do nothing");
    await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, 'qa_ring', 'TRINKET', true)", [hero]);
    const [ach] = await db.query<{ id: string }>("select id from public.achievements limit 1");
    await db.query("insert into public.character_achievements (character_id, achievement_id) values ($1, $2)", [hero, ach!.id]);
    const [season] = await db.query<{ id: string }>("select id from public.seasons limit 1");
    await db.query("insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations, damage) values ($1, $2, 55, 12, 5, 7, 19, 12345)", [season!.id, hero]);

    const snap = async () =>
      JSON.stringify({
        career: (await db.query("select id, kind, telegram_user_id, public_id, name, name_override, status, origin, level, xp, tactic, title, arena_battles, arena_wins, arena_top2, arena_eliminations, arena_damage, created_at from public.characters where id = $1", [hero]))[0],
        gold: await db.query("select * from public.currency_accounts where character_id = $1", [hero]),
        ledger: await db.query("select delta, reason, idempotency_key, balance_after from public.currency_ledger where character_id = $1 order by id", [hero]),
        items: await db.query("select template_id, slot, equipped, acquired_at from public.inventory_items where character_id = $1", [hero]),
        achievements: await db.query("select achievement_id, unlocked_at from public.character_achievements where character_id = $1", [hero]),
        season: await db.query("select season_id, points, battles, wins, top2, eliminations, damage from public.season_character_stats where character_id = $1", [hero]),
        claim: await db.query("select character_id, telegram_user_id, claimed_at from public.character_claims where character_id = $1", [hero]),
        member: await db.query("select telegram_user_id, display_name, qualifying_message_count, status from public.telegram_users where telegram_user_id = $1", [tid]),
        rewards: [await count(db, "arena_reward_ledger"), await count(db, "arena_points_ledger"), await count(db, "arena_picks")],
      });
    const before = await snap();
    await rerollOwnHero(db, tid, uuid(), deps);
    expect(await snap()).toBe(before);
    const [row] = await db.query<{ name: string }>("select coalesce(name_override, name) as name from public.characters where id = $1", [hero]);
    expect(row!.name).toBe("Renamed Hero");
  });
});

describe("a bad roll or a failed write consumes NOTHING", () => {
  const generateWith = (patch: (g: ReturnType<typeof generateCharacter>) => ReturnType<typeof generateCharacter>) => (input: GenerateCharacterInput) => patch(generateCharacter(input));

  it("an INVALID generated hero (PWR outside its rarity's band, an unknown class, broken stats) is refused: no version, no allowance, hero unchanged", async () => {
    const { tid, hero } = await member();
    const before = await heroState(hero);
    const bad = [
      generateWith((g) => ({ ...g, power: g.power + 500 })), // generator and version arithmetic disagree
      generateWith((g) => ({ ...g, classId: "necromancer" })), // not an enabled class
      generateWith((g) => ({ ...g, variation: { ...g.variation, str: 9999 } })), // stats that no longer add up to the stated PWR
      generateWith((g) => ({ ...g, sprite: null as never })), // a hero with no drawable look
    ];
    for (const generate of bad) {
      const e = await refusal(rerollOwnHero(db, tid, uuid(), { ...deps, generate }));
      expect(e).toMatchObject({ code: "INVALID_ROLL", status: 500 });
    }
    // a rarity whose band the (otherwise consistent) stats do not fit
    const wrongRarity = generateWith((g) => ({ ...g, rarity: g.rarity === "LEGENDARY" ? "COMMON" : "LEGENDARY" }));
    expect((await refusal(rerollOwnHero(db, tid, uuid(), { ...deps, generate: wrongRarity })))?.code).toBe("INVALID_ROLL");
    expect(await versionRows(hero)).toHaveLength(1);
    expect(await allowanceRows(tid)).toHaveLength(0);
    expect(await heroState(hero)).toEqual(before);
    // …and the allowance is still there for a real roll
    await rerollOwnHero(db, tid, uuid(), deps);
    expect(await allowanceRows(tid)).toHaveLength(1);
  });

  it("if any write fails after the version was appended, the WHOLE transaction rolls back — never a version without its allowance, never an allowance without a version", async () => {
    const { tid, hero } = await member();
    const before = await heroState(hero);
    await db.exec("alter table public.hero_free_rerolls add constraint force_failure check (to_power < 0) not valid");
    try {
      await expect(rerollOwnHero(db, tid, uuid(), deps)).rejects.toThrow(/force_failure/);
    } finally {
      await db.exec("alter table public.hero_free_rerolls drop constraint force_failure");
    }
    expect(await versionRows(hero)).toHaveLength(1);
    expect(await allowanceRows(tid)).toHaveLength(0);
    expect(await heroState(hero)).toEqual(before);
    expect(await count(db, "admin_audit_log", "action = 'hero.free_reroll'")).toBe(0);
    await rerollOwnHero(db, tid, uuid(), deps); // the same member can still use today's reroll
    expect(await versionRows(hero)).toHaveLength(2);
    await auditsClean();
  });

  it("the database refuses a member-made version without its allowance row at COMMIT (a reroll that is not counted cannot exist)", async () => {
    const { tid, hero } = await member();
    const [v1] = await versionRows(hero);
    await expect(
      db.transaction(async (tx) => {
        await tx.query(
          `insert into public.hero_versions (character_id, version_number, action, previous_version_id, request_id, generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, sprite, render, created_by)
           select character_id, 2, 'REROLL', id, gen_random_uuid(), generation_seed, generator_version, class_id, rarity, variation, telegram_bonus, stats, power, appearance_seed, appearance, sprite, render, $2 from public.hero_versions where id = $1`,
          [v1!.id, `member:${tid}`],
        );
      }),
    ).rejects.toThrow(/must consume a free reroll/);
    expect(await versionRows(hero)).toHaveLength(1);
  });
});

describe("the distribution is the generator's — and the status DTO tells the truth", () => {
  it("over hundreds of real rerolls (a new UTC day each) every result is inside its band and class/rarity are the generator's; no hero is ever duplicated", async () => {
    const { tid, hero } = await member();
    const seen = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 } as Record<string, number>;
    for (let day = 0; day < 120; day++) {
      clock.ms = T0 + day * 86_400_000;
      const r = await rerollOwnHero(db, tid, uuid(), deps);
      seen[r.after.rarity]!++;
      expect(r.after.power).toBeGreaterThanOrEqual(RARITY_RULES[r.after.rarity].powerMin);
      expect(r.after.power).toBeLessThanOrEqual(RARITY_RULES[r.after.rarity].powerMax);
    }
    expect(await count(db, "characters")).toBe(1);
    expect(await versionRows(hero)).toHaveLength(121);
    expect(seen.COMMON! + seen.RARE! + seen.EPIC! + seen.LEGENDARY!).toBe(120);
    expect(seen.COMMON!).toBeGreaterThan(50); // 70 % of 120 ≈ 84
    expect(await allowanceRows(tid)).toHaveLength(120);
    await auditsClean();
  });

  it("status: DISABLED when the flag is off (nothing read), UNAVAILABLE without the table, AVAILABLE → USED with the server's clock and the next 00:00 UTC", async () => {
    const { tid } = await member();
    expect(FREE_REROLL_FLAG).toBe("hero.free_reroll");
    const off = await getFreeRerollStatus(db, tid, false, deps);
    expect(off).toMatchObject({ state: "DISABLED", serverNow: T0, nextResetAt: Date.UTC(2026, 9, 10), current: null, today: null });
    const on = await getFreeRerollStatus(db, tid, true, deps);
    expect(on).toMatchObject({ state: "AVAILABLE", serverNow: T0, utcDay: "2026-10-09", nextResetAt: Date.UTC(2026, 9, 10), block: null });
    expect(on.current).toBeTruthy();
    expect(JSON.stringify(on)).not.toMatch(/telegram|seed|nonce/i);
    const done = await rerollOwnHero(db, tid, uuid(), deps);
    const used = await getFreeRerollStatus(db, tid, true, deps);
    expect(used.state).toBe("USED");
    expect(used.today?.requestId).toBe(done.requestId);
    expect(used.today?.after).toEqual(done.after);
    expect(used.current).toEqual(done.after); // refresh shows the authoritative CURRENT hero
    expect(used.nextResetAt).toBe(Date.UTC(2026, 9, 10));
    // the flag is a server-side gate for the status too
    expect((await getFreeRerollStatus(db, tid, false, deps)).state).toBe("DISABLED");
    // no migration → unavailable, never a crash
    await db.exec("alter table public.hero_free_rerolls rename to hero_free_rerolls_hidden");
    try {
      expect(await freeRerollReady(db)).toBe(false);
      expect((await getFreeRerollStatus(db, tid, true, deps)).state).toBe("UNAVAILABLE");
    } finally {
      await db.exec("alter table public.hero_free_rerolls_hidden rename to hero_free_rerolls");
    }
    expect(await freeRerollReady(db)).toBe(true);
  });
});
