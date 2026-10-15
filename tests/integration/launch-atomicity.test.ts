import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Db } from "@/server/db/types";
import { applyLedger } from "@/server/services/economy";
import { launchSeason1 } from "@/server/services/lifecycle";

import { count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { activeSeason, adminDeps, battleHistoryHash, freshDevelopment, heroIdentityHash } from "../support/lifecycle";

/**
 * THE LAUNCH IS ALL OR NOTHING. Whatever goes wrong inside it — a failing write, a database that refuses the last step, a Season 1 that would not start from zero —
 * the pre-season is exactly as it was, no half-reset exists, and the launch can simply be run again. And nothing but the explicit Admin action can reach it.
 */
const LAUNCH = { confirmation: "LAUNCH SEASON 1" };
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

/** Everything the launch could touch, as one comparable value. */
async function world() {
  return {
    heroes: await heroIdentityHash(db),
    history: await battleHistoryHash(db),
    phase: (await db.query("select phase, launched_at, launch_season_id from public.game_state"))[0],
    seasons: await db.query("select id, kind, number, status, ended_reason, archive from public.seasons order by created_at, id"),
    arena: (await db.query("select status from public.arena_state"))[0],
    gold: await db.query("select character_id, balance from public.currency_accounts order by character_id"),
    ledger: await count(db, "currency_ledger"),
    loot: await db.query("select id, equipped, archived_at from public.inventory_items order by id"),
    achievements: await db.query("select character_id, achievement_id, archived_at from public.character_achievements order by character_id, achievement_id"),
    career: await db.query("select id, arena_battles, arena_wins from public.characters order by id"),
    audit: await count(db, "admin_audit_log"),
  };
}

async function playSome(): Promise<string[]> {
  const heroes = await seedHeroes(db, 16);
  await applyLedger(db, { characterId: heroes[0]!, amount: 400, reason: "arena", idempotencyKey: "atomic-gold-0" });
  await applyLedger(db, { characterId: heroes[1]!, amount: 90, reason: "arena", idempotencyKey: "atomic-gold-1" });
  const [cls] = await db.query<{ class_id: string }>("select class_id from public.characters where id = $1", [heroes[0]]);
  await db.query("insert into public.inventory_items (character_id, template_id, slot, equipped) values ($1, $2, 'WEAPON', true)", [heroes[0], `${cls!.class_id}_weapon_rare`]);
  await db.query("update public.characters set arena_battles = 12, arena_wins = 7 where id = $1", [heroes[0]]);
  return heroes;
}

const run = async () => launchSeason1(db, adminDeps(clock), LAUNCH);

describe("a failure anywhere inside the launch rolls the whole thing back", () => {
  it("the database refuses the very last step (the phase flip): no Season 1, no archived run, no Gold reset — then the launch simply succeeds when run again", async () => {
    await playSome();
    const before = await world();
    await db.exec(`
      create function public.test_refuse_live() returns trigger language plpgsql as $$ begin raise exception 'simulated database failure at the last step' using errcode = '23000'; end; $$;
      create trigger test_refuse_live before update on public.game_state for each row when (new.phase = 'LIVE') execute function public.test_refuse_live();
    `);
    await expect(run()).rejects.toThrow(/simulated database failure/);
    expect(await world()).toEqual(before); // nothing at all moved: every table, every counter, every audit row

    await db.exec("drop trigger test_refuse_live on public.game_state; drop function public.test_refuse_live();");
    const ok = await run();
    expect(ok).toMatchObject({ alreadyLaunched: false, seasonNumber: 1 });
    expect(await count(db, "currency_accounts", "balance <> 0")).toBe(0);
    expect(await count(db, "admin_audit_log", "action = 'GAME_LAUNCH'")).toBe(1);
  });

  it("a Season 1 that would NOT start from zero is never launched (the post-launch verification rolls the whole launch back)", async () => {
    await playSome();
    const before = await world();
    // something writes a record into the brand-new season during the launch: exactly the contamination the verification exists to catch
    await db.exec(`
      create function public.test_contaminate() returns trigger language plpgsql as $$
      begin
        insert into public.season_character_stats (season_id, character_id, points, battles, wins, top2, eliminations, damage)
          select new.launch_season_id, c.id, 0, 3, 1, 1, 0, 0 from public.characters c limit 1;
        return new;
      end; $$;
      create trigger test_contaminate after update on public.game_state for each row when (new.phase = 'LIVE') execute function public.test_contaminate();
    `);
    await expect(run()).rejects.toMatchObject({ code: "LAUNCH_NOT_CLEAN" });
    expect(await world()).toEqual(before);
    expect((await activeSeason(db))!.kind).toBe("DEVELOPMENT");
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(0);
    await db.exec("drop trigger test_contaminate on public.game_state; drop function public.test_contaminate();");
    expect((await run()).alreadyLaunched).toBe(false);
  });

  it("a hero that changed during the launch aborts it (nothing applied)", async () => {
    const heroes = await playSome();
    const before = await world();
    await db.exec(`
      create function public.test_tamper() returns trigger language plpgsql as $$
      begin update public.character_appearances set seed = seed || '-tampered' where character_id = '${heroes[0]}'; return new; end; $$;
      create trigger test_tamper after update on public.game_state for each row when (new.phase = 'LIVE') execute function public.test_tamper();
    `);
    await expect(run()).rejects.toMatchObject({ code: "HERO_FINGERPRINT_CHANGED" });
    expect(await world()).toEqual(before);
  });
});

describe("only the explicit Admin action can launch", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));

  it("is called from the admin route and nowhere else — no script, hook, cron, worker, startup or deployment path reaches it", () => {
    const root = process.cwd();
    const callers = [...files(path.join(root, "src")), ...files(path.join(root, "scripts"))].filter((f) => /\blaunchSeason1\s*\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(root, f));
    // The one other caller is the SCRATCH QA seed (it builds disposable databases for screenshots). It is not a deployment path: it refuses any database that is not local and named clank_qa*.
    expect(callers.sort()).toEqual(["scripts/qa-events-seed.ts", "src/app/api/admin/[...path]/route.ts", "src/server/services/lifecycle.ts"]);
    const qa = readFileSync(path.join(root, "scripts/qa-events-seed.ts"), "utf8");
    expect(qa).toMatch(/\^\(127\\\.0\\\.0\\\.1\|localhost\|\\\[::1\\\]\)\$/);
    expect(qa).toMatch(/clank_qa/);
    expect(qa).toMatch(/Refusing/);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts ?? {}).not.toHaveProperty("qa:events");
    const wired = Object.values(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts as Record<string, string>).filter((s) => /qa-events-seed/.test(s));
    expect(wired).toEqual([]); // no npm script, hook or CI step runs it
    const route = readFileSync(path.join(root, "src/app/api/admin/[...path]/route.ts"), "utf8");
    expect(route).toMatch(/route\("POST", "game\/launch"/);
  });

  it("the lifecycle service and its preflight never look at NODE_ENV, VERCEL_ENV or any deployment setting", () => {
    const root = process.cwd();
    for (const f of ["src/server/services/lifecycle.ts", "src/server/services/launchPreflight.ts", "src/domain/launchPreflight.ts", "src/server/services/developmentEconomy.ts"]) {
      const src = readFileSync(path.join(root, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(src, f).not.toMatch(/NODE_ENV|VERCEL|isProduction|process\.env|getEnv/);
    }
  });

  it("starting the application, migrating and re-running the seed change nothing about the phase", async () => {
    await seedHeroes(db, 8);
    const { migrate } = await import("@/server/db/migrate");
    const { seedReferenceData } = await import("@/server/seed/reference");
    await migrate(db);
    await seedReferenceData(db);
    expect((await db.query<{ phase: string }>("select phase from public.game_state"))[0]!.phase).toBe("DEVELOPMENT");
    expect(await count(db, "seasons", "kind = 'COMPETITIVE'")).toBe(0);
  });
});
