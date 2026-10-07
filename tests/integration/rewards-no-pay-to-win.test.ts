import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadRuleset } from "@/server/config/settingsRepo";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { simulateBattle } from "@/domain/combat/engine";
import { getLiveBoard } from "@/server/rewards/leaderboard";
import { getPointsSummary } from "@/server/rewards/points";
import type { Db } from "@/server/db/types";
import { fighterToUnit, loadFighters } from "@/server/services/characters";

import { createTestDb, resetDb, seedEligibleMember, seedHeroes } from "../support/db";
import { bindWallet, observeSteady, pickAs, settle, stageNext, utc, chainTokens } from "../support/rewards";
import { finishBattle, stageBattle } from "../support/stage";

/**
 * $CLANKRPG holdings change exactly ONE thing: a percentage BONUS on a leaderboard prize the member already earned, and only with
 * verified holding continuity from before the period began. They must not reach POWER, HP, STR, DEF, INT, AGI, CHA, LUCK, class AI,
 * battle RNG, the pick result, how many picks score, the Points a correct pick earns, accuracy, rank or a tie-break. This file pins
 * that in independent ways: by construction (code), by behaviour (FREE vs a 10M holder, played out), and by data.
 */
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

const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : n.endsWith(".ts") || n.endsWith(".tsx") ? [path.join(dir, n)] : []));
const src = (rel: string) => path.join(process.cwd(), "src", rel);
const HOLDER_WORDS = /arena_holder_(status|observations)|holderBonus|BonusTier|bonusTier|tierForBalance|getHolderCard|rewards\/holders|domain\/rewards\/holderBonus|CLANKRPG_|verified_balance|tier_snapshot/;
/** The code of a file: comments removed (they say "holdings never…" on purpose). */
const code = (f: string) => readFileSync(src(f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("by CONSTRUCTION: nothing that computes stats, combat, scoring or ranking can even see holder data", () => {
  it("no combat / character / progression / sprite / rules domain file references holder tiers or the token", () => {
    // `domain/gameRules.ts` is the PUBLIC rules summary the docs read (it names the holder bonus tiers like it names the prize pools); it computes nothing — the next test pins that
    // nothing which does compute can import it.
    const files = walk(src("domain")).filter((f) => !f.includes(`${path.sep}domain${path.sep}rewards${path.sep}`) && !f.endsWith(`${path.sep}domain${path.sep}settings.ts`) && !f.endsWith(`${path.sep}domain${path.sep}gameRules.ts`));
    expect(files.length).toBeGreaterThan(20); // the scan really covered the domain
    expect(files.filter((f) => HOLDER_WORDS.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the public rules summary (domain/gameRules.ts) is imported ONLY by the docs — never by combat, stats, scoring, ranking or any service", () => {
    const importers = [...walk(src("")), ...walk(path.join(process.cwd(), "scripts"))].filter((f) => /from ["'][^"']*gameRules["']/.test(readFileSync(f, "utf8")));
    expect(importers.length).toBeGreaterThan(5); // the docs really do read it
    for (const f of importers) expect(f.replace(process.cwd(), ""), f).toMatch(/\/src\/(content\/docs|components\/docs)\//);
  });

  it("the services that build fighters, simulate battles and resolve picks never read holder state", () => {
    const files = ["server/services/characters.ts", "server/services/arena.ts", "server/services/picks.ts", "server/services/economy.ts", "server/services/leaderboard.ts"].map(src);
    expect(files.filter((f) => HOLDER_WORDS.test(readFileSync(f, "utf8")))).toEqual([]);
  });

  it("the pure RANKING / TIE / PRIZE-LADDER rules and the scoring code take no holder input: no tier, balance, wallet or token appears in their code", () => {
    const HOLDINGS = /holder|tier|balance|verified|wallet|CLANKRPG_|arena_holder|bonus/i;
    expect(code("domain/rewards/leaderboard.ts")).not.toMatch(HOLDINGS);
    expect(code("server/rewards/settlement.ts")).not.toMatch(HOLDINGS);
    expect(code("server/rewards/points.ts")).not.toMatch(HOLDINGS);
    // Ranking and prize computation inside the leaderboard module: from the aggregate query through computeStanding and the scored-today counter, no holder word.
    // (The row builder after it only fills constant "no bonus yet" placeholders into the wire shape: they are outputs, never inputs.)
    const lb = code("server/rewards/leaderboard.ts");
    const standings = lb.slice(lb.indexOf("interface AggRow"), lb.indexOf("function liveRow"));
    expect(standings.length).toBeGreaterThan(1500);
    expect(standings).not.toMatch(HOLDINGS);
    // The domain files for ranking and for holder bonuses do not import each other: a bonus can never feed a rank.
    expect(readFileSync(src("domain/rewards/leaderboard.ts"), "utf8")).not.toMatch(/holderBonus/);
    expect(readFileSync(src("domain/rewards/holderBonus.ts"), "utf8")).not.toMatch(/from "\.\/leaderboard"/);
  });

  it("scoring decides 'how many points does this pick earn' from the result and the points setting — nothing else: no daily count, no limit, no holdings", () => {
    const settlement = code("server/rewards/settlement.ts");
    expect(settlement).toMatch(/points: right \? cfg\.pointsPerCorrectPick : 0/);
    expect(settlement).not.toMatch(/scoredPicksPerDay|daily_limit|scored_index|dailyLimit/);
    // …and the database has no hidden counter either: the scoring guard only freezes a finished period, it never counts a member's picks.
    const migration = readFileSync(path.join(process.cwd(), "supabase/migrations/20261005001400_arena_picks_leaderboards.sql"), "utf8");
    const guard = migration.slice(migration.indexOf("create or replace function public.guard_arena_pick_score"), migration.indexOf("create trigger arena_pick_scores_guard"));
    expect(guard.length).toBeGreaterThan(200);
    expect(guard).not.toMatch(/count\(|used\b|limit/i);
  });

  it("the bonus is computed ONLY on an already-decided base prize, after ranking: the finalization takes the prize from the standings and never feeds the bonus back into them", () => {
    const lb = code("server/rewards/leaderboard.ts");
    const finalize = lb.slice(lb.indexOf("export async function finalizePeriod"), lb.indexOf("// RECONCILIATION"));
    const standingsAt = finalize.indexOf("computeStanding(tx");
    const bonusAt = finalize.indexOf("decideBonus(");
    expect(standingsAt).toBeGreaterThan(0);
    expect(bonusAt).toBeGreaterThan(standingsAt);
    expect(finalize).toMatch(/applyBonus\(base, decision\.tier\.bonusBps\)/);
    // The base prize inserted for a result is the standings' `prize`, never `base + bonus`.
    expect(finalize).toMatch(/base\.toString\(\), baseStatus/);
  });

  it("the bonded-coin holdings bonus (the only holdings → POWER path) explicitly ignores $CLANKRPG", () => {
    expect(readFileSync(src("server/services/holdings.ts"), "utf8")).toMatch(/CLANKRPG_TOKEN_ADDRESS[\s\S]*filter\(\(t\) => clankrpg === "" \|\| t\.address\.toLowerCase\(\) !== clankrpg\)/);
  });
});

describe("by BEHAVIOUR: a 10M holder's fighter is byte-for-byte the fighter a non-holder's would be", () => {
  it("POWER, every stat, and the whole combat unit are identical before and after the owner becomes a 10M holder — and so is the battle", async () => {
    const ids = await seedHeroes(db, 8);
    const owners = (await db.query<{ id: string; telegram_user_id: number }>("select id, telegram_user_id from public.characters where id = any($1::uuid[])", [ids]).catch(async () =>
      db.query<{ id: string; telegram_user_id: number }>("select id, telegram_user_id from public.characters order by created_at limit 8"))) as Array<{ id: string; telegram_user_id: number }>;
    const { ruleset } = await loadRuleset(db, DEFAULT_SETTINGS);
    const before = await loadFighters(db, owners.map((o) => o.id), ruleset, DEFAULT_SETTINGS);
    const powerBefore = (await db.query<{ id: string; power: number }>("select id, power from public.characters order by id")).map((r) => [r.id, r.power]);

    // Make half the field the richest, longest-verified holders possible.
    for (const o of owners.slice(0, 4)) {
      await bindWallet(db, o.telegram_user_id, { verifiedAtMs: utc(2026, 9, 1) });
      await observeSteady(db, o.telegram_user_id, utc(2026, 9, 1), utc(2026, 10, 4), chainTokens(999_999_999), 6 * 3_600_000);
    }

    const after = await loadFighters(db, owners.map((o) => o.id), ruleset, DEFAULT_SETTINGS);
    expect(after).toEqual(before);
    expect(after.map(fighterToUnit)).toEqual(before.map(fighterToUnit));
    expect((await db.query<{ id: string; power: number }>("select id, power from public.characters order by id")).map((r) => [r.id, r.power])).toEqual(powerBefore);

    const run = (units: ReturnType<typeof fighterToUnit>[]) => simulateBattle({ seed: "fixed-seed-for-parity", ruleset, units, maxCombatMs: DEFAULT_SETTINGS.arena.maxCombatMs });
    const a = run(before.map(fighterToUnit));
    const b = run(after.map(fighterToUnit));
    expect(b.eventsHash).toBe(a.eventsHash);
    expect(b.ranking).toEqual(a.ranking);
  });

  it("the pick RESULT, lifetime Points and the leaderboard points do not depend on holdings: a 10M holder and a non-holder who pick the same fighter get exactly the same", async () => {
    const s = await stageBattle(db);
    const free = await seedEligibleMember(db);
    const whale = await seedEligibleMember(db);
    await bindWallet(db, whale, { verifiedAtMs: utc(2026, 9, 1) });
    await observeSteady(db, whale, utc(2026, 9, 1), utc(2026, 10, 4), chainTokens(10_250_000), 6 * 3_600_000);
    const other = s.fighters.find((f) => f !== s.winnerId)!;
    const wrongFree = await seedEligibleMember(db);
    const wrongWhale = await seedEligibleMember(db);
    await bindWallet(db, wrongWhale, { verifiedAtMs: utc(2026, 9, 1) });
    await observeSteady(db, wrongWhale, utc(2026, 9, 1), utc(2026, 10, 4), chainTokens(10_250_000), 6 * 3_600_000);
    for (const [u, f] of [[free, s.winnerId], [whale, s.winnerId], [wrongFree, other], [wrongWhale, other]] as const) await pickAs(db, s, u, f);
    await finishBattle(db, s);
    await settle(db, s);
    const results = await db.query<{ telegram_user_id: number; result: string }>("select telegram_user_id, result from public.arena_picks where battle_id = $1", [s.battleId]);
    const res = (u: number) => results.find((r) => Number(r.telegram_user_id) === u)!.result;
    expect([res(free), res(whale)]).toEqual(["CORRECT", "CORRECT"]);
    expect([res(wrongFree), res(wrongWhale)]).toEqual(["INCORRECT", "INCORRECT"]);
    const score = async (u: number) => (await db.query<{ correct: boolean; points: number }>("select correct, points from public.arena_pick_scores where telegram_user_id = $1", [u]))[0];
    expect(await score(whale)).toEqual(await score(free));
    expect(await score(wrongWhale)).toEqual(await score(wrongFree));
    expect(await score(whale)).toEqual({ correct: true, points: 10 });
    const now = s.clock.ms;
    expect(await getPointsSummary(db, whale, now)).toEqual(await getPointsSummary(db, free, now));
  });

  it("FREE and a 10M holder get EXACTLY the same unlimited scoring: 22 battles, both pick the winner every time → both have 22 counted picks, 22 correct, 220 points — and the SAME rank on the Daily and the Weekly board", async () => {
    let s = await stageBattle(db);
    const free = await seedEligibleMember(db);
    const whale = await seedEligibleMember(db);
    await bindWallet(db, whale, { verifiedAtMs: utc(2026, 9, 1) });
    await observeSteady(db, whale, utc(2026, 9, 1), utc(2026, 10, 4), chainTokens(10_250_000), 6 * 3_600_000);
    for (let i = 0; i < 22; i++) {
      if (i > 0) s = await stageNext(db, s);
      expect((await pickAs(db, s, free, s.winnerId)).ok).toBe(true);
      expect((await pickAs(db, s, whale, s.winnerId)).ok).toBe(true);
      await finishBattle(db, s);
      await settle(db, s);
    }
    for (const u of [free, whale]) {
      const rows = await db.query<{ correct: boolean; points: number }>("select correct, points from public.arena_pick_scores where telegram_user_id = $1 order by id", [u]);
      expect(rows).toHaveLength(22); // unlimited picks: every one is valid, recorded and counted
      expect(rows.every((r) => r.correct && r.points === 10)).toBe(true); // #21 and #22 earn exactly what #1 did
      expect(rows.reduce((a, r) => a + r.points, 0)).toBe(220);
      expect((await getPointsSummary(db, u, s.clock.ms)).lifetime).toBe(220);
    }
    for (const kind of ["DAILY", "WEEKLY"] as const) {
      const standing = (u: number) => getLiveBoard(db, { kind, nowMs: s.clock.ms, settings: DEFAULT_SETTINGS, viewerId: u });
      const [f, w] = [await standing(free), await standing(whale)];
      expect(f.me, kind).toEqual(w.me); // identical picks / correct / accuracy / points / rank / eligibility
      expect(f.me).toMatchObject({ picks: 22, correctPicks: 22, accuracy: 100, points: 220, rank: 1 });
      const rows = f.board.rows.filter((r) => r.points === 220);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.rank === 1 && r.tied)).toBe(true); // an exact tie: holdings never break it
    }
  }, 120_000);
});
