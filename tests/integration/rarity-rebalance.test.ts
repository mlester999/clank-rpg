import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Rarity } from "@/domain/character/appearance";
import { HERO_GENERATOR_VERSION, LEGACY_HERO_GENERATOR_VERSION } from "@/domain/hero/heroVersion";
import { computeHeroPower } from "@/domain/hero/power";
import { isPowerInBand } from "@/domain/hero/rarity";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, replayBattle } from "@/server/services/arena";
import { searchHeroes } from "@/server/services/heroAdmin";
import {
  applyRerollPreview,
  getHeroVersioning,
  previewReroll,
  rebalanceHero,
  rollbackHero,
  versionCard,
  type HeroVersionError,
  type HeroVersioningDeps,
} from "@/server/services/heroVersions";
import { heroArenaLock } from "@/server/services/heroVersionStore";

import { arenaCtx, createTestDb, FakeClock, insertStubHero, resetDb, seedHeroes } from "../support/db";

const SECRET = "rebalance-it-secret-0123456789";
let db: Db;
let clock: FakeClock;
let deps: HeroVersioningDeps;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  clock = new FakeClock();
  deps = { settings: await loadSettings(db), classes: await loadClasses(db), secret: SECRET, now: clock.now };
});

const fails = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as HeroVersionError | null;
const versions = (id: string) =>
  db.query<{ id: string; version_number: number; action: string; generator_version: string; class_id: string; rarity: string; power: number; stats: Record<string, number>; created_by: string; request_id: string | null; source_version_id: string | null }>(
    "select id, version_number, action, generator_version, class_id, rarity, power, stats, created_by, request_id, source_version_id from public.hero_versions where character_id = $1 order by version_number", [id]);
const v1Row = async (id: string) => JSON.stringify((await db.query<{ row: unknown }>("select to_jsonb(v) as row from public.hero_versions v where v.character_id = $1 and v.version_number = 1", [id]))[0]!.row);
const identity = async (id: string) => JSON.stringify((await db.query(
  `select c.id, c.public_id, c.telegram_user_id, c.name, c.name_override, c.status, c.origin, c.created_at, c.class_id, a.rarity, a.seed, a.parts->>'skin' as skin, a.parts->>'hairStyle' as hair, a.parts->>'eyes' as eyes, a.parts->>'outfitHue' as hue
     from public.characters c join public.character_appearances a on a.character_id = c.id where c.id = $1`, [id]))[0]);
const auditRarity = () => db.query<{ character_id: string; problem: string }>("select character_id, problem from public.audit_hero_rarity_power()");
const auditVersions = () => db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()").then((r) => r[0]!.n);
const cachedPower = async (id: string) => Number((await db.query<{ power: number }>("select power from public.characters where id = $1", [id]))[0]!.power);

describe("SYSTEM_REBALANCE of heroes made by the first generator", () => {
  it("moves every legacy hero onto the rarity power system as a NEW version — same hero, owner, public URL, class, rarity, identity; v1 untouched byte for byte", async () => {
    const ids = await seedHeroes(db, 40, { legacy: true });
    // before: every hero is on generator 1 with exactly one INITIAL version, and the auditor says so
    expect((await auditRarity()).map((r) => r.problem)).toEqual(Array(40).fill("NOT_REBALANCED"));
    const before = new Map<string, { v1: string; identity: string }>();
    for (const id of ids) {
      const v = await versions(id);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ action: "INITIAL", generator_version: LEGACY_HERO_GENERATOR_VERSION });
      before.set(id, { v1: await v1Row(id), identity: await identity(id) });
    }

    const seen = new Set<string>();
    for (const id of ids) {
      const r = await rebalanceHero(db, id, "system:rebalance", deps);
      expect(r.status).toBe("REBALANCED");
      expect(r.fromVersion).toBe(1);
      expect(r.toVersion).toBe(2);
      expect(r.to.classId).toBe(r.from.classId);
      expect(r.to.rarity).toBe(r.from.rarity);
      expect(r.to.generatorVersion).toBe(HERO_GENERATOR_VERSION);
      const v = await versions(id);
      expect(v.map((x) => [x.version_number, x.action, x.generator_version])).toEqual([[1, "INITIAL", LEGACY_HERO_GENERATOR_VERSION], [2, "SYSTEM_REBALANCE", HERO_GENERATOR_VERSION]]);
      expect(v[1]).toMatchObject({ created_by: "system:rebalance", source_version_id: null });
      expect(v[1]!.request_id).toMatch(/^[0-9a-f-]{36}$/); // a deterministic key: a retry or a concurrent run can only ever write one row
      expect(isPowerInBand(v[1]!.rarity as Rarity, v[1]!.power)).toBe(true);
      expect(v[1]!.power).toBe(computeHeroPower(v[1]!.stats as never, v[1]!.class_id));
      expect(await cachedPower(id)).toBe(v[1]!.power); // the cached figure every list reads is the new PWR
      expect(await v1Row(id)).toBe(before.get(id)!.v1); // HISTORY: v1 is byte-for-byte what it was
      expect(await identity(id)).toBe(before.get(id)!.identity); // same hero: owner, public id, name, class, rarity, seed, face, hair
      seen.add(v[1]!.rarity);
    }
    expect(await auditRarity()).toEqual([]); // nothing left outside the new system
    expect(await auditVersions()).toBe(0);
    expect(await db.query("select 1 from public.admin_audit_log where action = 'hero.rebalance'")).toHaveLength(40);
    expect(seen.has("COMMON")).toBe(true);
  });

  it("is idempotent: a second run (or a concurrent one) writes nothing", async () => {
    const [id] = await seedHeroes(db, 1, { legacy: true });
    const [a, b] = await Promise.all([rebalanceHero(db, id!, "system:rebalance", deps), rebalanceHero(db, id!, "system:rebalance", deps)]);
    expect([a.status, b.status].sort()).toEqual(["ALREADY_ON_CURRENT_GENERATOR", "REBALANCED"]);
    expect((await versions(id!)).length).toBe(2);
    const again = await rebalanceHero(db, id!, "system:rebalance", deps);
    expect(again.status).toBe("ALREADY_ON_CURRENT_GENERATOR");
    expect((await versions(id!)).length).toBe(2);
    expect(await db.query("select 1 from public.admin_audit_log where action = 'hero.rebalance'")).toHaveLength(1);
  });

  it("a hero created by the CURRENT generator is never rebalanced; a hand-authored special character is left alone", async () => {
    const [fresh] = await seedHeroes(db, 1);
    expect((await rebalanceHero(db, fresh!, "system:rebalance", deps)).status).toBe("ALREADY_ON_CURRENT_GENERATOR");
    const special = await insertStubHero(db, { kind: "SPECIAL_CHARACTER", class_id: "warrior", name: "The Founder", origin: "ADMIN", status: "ACTIVE" });
    expect((await rebalanceHero(db, special, "system:rebalance", deps)).status).toBe("NOT_A_COMMUNITY_HERO");
    expect((await versions(special)).length).toBe(1);
  });

  it("the DATABASE refuses a generator-2 version whose PWR is outside its rarity's band (stats, PWR and rarity cannot disagree); generator-1 history is exempt", async () => {
    const [id] = await seedHeroes(db, 1);
    const [cur] = await db.query<{ id: string }>("select current_hero_version_id as id from public.characters where id = $1", [id]);
    const insertWith = (q: { query: Db["query"] }, power: number, generator: string) =>
      q.query(
        `insert into public.hero_versions
           select (jsonb_populate_record(null::public.hero_versions,
             to_jsonb(v) || jsonb_build_object('id', gen_random_uuid(), 'version_number', 2, 'action', 'REROLL', 'previous_version_id', v.id, 'request_id', gen_random_uuid(), 'power', $2::int, 'generator_version', $3::text))).*
           from public.hero_versions v where v.id = $1`,
        [cur!.id, power, generator],
      );
    const rolledBack = new Error("rollback");
    const attempt = (power: number, generator: string) =>
      db.transaction(async (tx) => {
        await insertWith(tx, power, generator);
        throw rolledBack; // never keep it: every attempt is rolled back
      }).then(() => null, (e: unknown) => e as Error);
    // out of band, current generator → refused by the CHECK constraint
    expect((await attempt(999, HERO_GENERATOR_VERSION))?.message ?? "").toMatch(/hero_versions_gen2_power_in_rarity_band/);
    expect((await attempt(5, HERO_GENERATOR_VERSION))?.message ?? "").toMatch(/hero_versions_gen2_power_in_rarity_band/);
    // the very same row under the first generator is accepted (legacy versions keep whatever they were stored with) — our sentinel proves the INSERT itself succeeded
    expect(await attempt(999, LEGACY_HERO_GENERATOR_VERSION)).toBe(rolledBack);
    // and an IN-band value under the current generator is accepted
    const v = (await versions(id!))[0]!;
    expect(await attempt(v.power, HERO_GENERATOR_VERSION)).toBe(rolledBack);
    expect((await versions(id!)).length).toBe(1); // nothing was kept
  });

  it("the admin list marks heroes that still need the rebalance, sorts by PWR both ways and filters by rarity", async () => {
    const legacy = await seedHeroes(db, 6, { legacy: true });
    await seedHeroes(db, 6);
    const list = await searchHeroes(db, { limit: 50 });
    expect(list.heroes.filter((h) => h.needsRebalance).length).toBe(6);
    const asc = await searchHeroes(db, { sort: "power_asc", limit: 50 });
    const desc = await searchHeroes(db, { sort: "power", limit: 50 });
    expect(asc.heroes.map((h) => h.power)).toEqual([...asc.heroes.map((h) => h.power)].sort((a, b) => a - b));
    expect(desc.heroes.map((h) => h.power)).toEqual([...desc.heroes.map((h) => h.power)].sort((a, b) => b - a));
    const commons = await searchHeroes(db, { rarity: "COMMON", limit: 50 });
    expect(commons.heroes.every((h) => h.rarity === "COMMON")).toBe(true);
    for (const id of legacy) await rebalanceHero(db, id, "system:rebalance", deps);
    expect((await searchHeroes(db, { limit: 50 })).heroes.some((h) => h.needsRebalance)).toBe(false);
  });
});

describe("history, the Arena and rollback", () => {
  it("HISTORICAL battles never change: snapshot, events hash, replay, winner and placements are identical after the rebalance; new battles use the new PWR", async () => {
    await seedHeroes(db, 24, { legacy: true });
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1] = await db.query<{ id: string }>("select id from public.arena_battles order by sequence limit 1");
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [b1!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const battleRows = async () => JSON.stringify(await db.query("select id, snapshot, events_hash, ruleset_hash, seed, winner_id, runner_up_id, result, duration_ms, status from public.arena_battles where status = 'SETTLED' order by sequence"));
    const placements = async () => JSON.stringify(await db.query("select battle_id, character_id, placement, eliminations, damage_dealt from public.arena_participants p where exists (select 1 from public.arena_battles b where b.id = p.battle_id and b.status = 'SETTLED') order by battle_id, character_id"));
    const settledBefore = await battleRows();
    const placementsBefore = await placements();
    const replayBefore = await replayBattle(db, b1!.id);
    const powerInSnapshotBefore = (await db.query<{ snapshot: { display: Array<{ characterId: string; power: number }> } }>("select snapshot from public.arena_battles where id = $1", [b1!.id]))[0]!.snapshot.display.map((d) => [d.characterId, d.power]);

    // rebalance every hero that is not in an unsettled roster right now; the others are REFUSED (frozen rosters stay authoritative)
    const ids = (await db.query<{ id: string }>("select id from public.characters order by created_at")).map((r) => r.id);
    let done = 0;
    let refused = 0;
    for (const id of ids) {
      if ((await heroArenaLock(db, id)).locked) {
        expect((await fails(rebalanceHero(db, id, "system:rebalance", deps)))?.code).toBe("HERO_IN_ARENA");
        refused++;
      } else {
        expect((await rebalanceHero(db, id, "system:rebalance", deps)).status).toBe("REBALANCED");
        done++;
      }
    }
    expect(done).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    expect(await battleRows()).toBe(settledBefore);
    expect(await placements()).toBe(placementsBefore);
    const replayAfter = await replayBattle(db, b1!.id);
    expect(replayAfter!.outcome.eventsHash).toBe(replayBefore!.outcome.eventsHash);
    expect(replayAfter!.outcome.ranking).toEqual(replayBefore!.outcome.ranking);
    const powerInSnapshotAfter = (await db.query<{ snapshot: { display: Array<{ characterId: string; power: number }> } }>("select snapshot from public.arena_battles where id = $1", [b1!.id]))[0]!.snapshot.display.map((d) => [d.characterId, d.power]);
    expect(powerInSnapshotAfter).toEqual(powerInSnapshotBefore); // the old battle still shows the old (legacy) PWR it was fought with

    // the NEXT battles use the new current versions: a rebalanced hero's frozen PWR is its new, in-band PWR
    for (const id of ids) if (!(await heroArenaLock(db, id)).locked) await rebalanceHero(db, id, "system:rebalance", deps).catch(() => undefined);
    for (let s = 0; s < 600; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const later = await db.query<{ snapshot: { display: Array<{ characterId: string; power: number; appearance: { rarity: string } }> } }>("select snapshot from public.arena_battles where status in ('SIMULATED','SETTLED') order by sequence desc limit 6");
    let checked = 0;
    for (const b of later) {
      for (const d of b.snapshot.display) {
        const [cur] = await db.query<{ power: number; rarity: string; generator_version: string }>("select v.power, v.rarity, v.generator_version from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id where c.id = $1", [d.characterId]);
        if (cur!.generator_version === HERO_GENERATOR_VERSION && isPowerInBand(d.appearance.rarity as Rarity, d.power)) checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("rollback after a rebalance: the system-rebalance version can be restored exactly; the legacy v1 stays viewable but cannot be restored", async () => {
    const [id] = await seedHeroes(db, 1, { legacy: true });
    await rebalanceHero(db, id!, "system:rebalance", deps); // v2 SYSTEM_REBALANCE
    const preview = await previewReroll(db, id!, "admin", deps);
    await applyRerollPreview(db, id!, preview.previewId, "admin", deps); // v3 REROLL
    const v = await versions(id!);
    expect(v.map((x) => x.action)).toEqual(["INITIAL", "SYSTEM_REBALANCE", "REROLL"]);
    const [v1, v2, v3] = v;
    // restoring v2 reproduces it exactly
    const rb = await rollbackHero(db, { characterId: id!, targetVersionId: v2!.id, expectedCurrentVersionId: v3!.id, requestId: crypto.randomUUID() }, "admin", deps);
    expect(rb.version.number).toBe(4);
    const after = (await versions(id!))[3]!;
    expect(after).toMatchObject({ action: "ROLLBACK", class_id: v2!.class_id, rarity: v2!.rarity, power: v2!.power, source_version_id: v2!.id });
    expect(after.stats).toEqual(v2!.stats);
    expect(await cachedPower(id!)).toBe(v2!.power);
    // v1 (generator 1) predates the rarity power system: viewable, never restorable
    const card = await versionCard(db, id!, v1!.id, deps);
    expect(card.version).toBe(1);
    const refused = await fails(rollbackHero(db, { characterId: id!, targetVersionId: v1!.id, expectedCurrentVersionId: after.id, requestId: crypto.randomUUID() }, "admin", deps));
    expect(refused?.code).toBe("LEGACY_VERSION");
    const view = await getHeroVersioning(db, id!, true);
    expect(view.onCurrentGenerator).toBe(true);
    expect(view.versions.find((x) => x.number === 1)!.legacy).toBe(true);
    expect(view.versions.find((x) => x.number === 2)!.generatorLabel).toBe("Hero generator 2.0.0");
    expect(await auditVersions()).toBe(0);
  });

  it("a reroll previews the SAME roll's rarity, class, stats, PWR and look — and may be stronger or weaker (nothing is boosted)", async () => {
    const ids = await seedHeroes(db, 4);
    let up = 0;
    let down = 0;
    for (let i = 0; i < 40; i++) {
      const id = ids[i % ids.length]!;
      const p = await previewReroll(db, id, "admin", deps);
      const cand = p.candidate;
      expect(isPowerInBand(cand.rarity, cand.power)).toBe(true);
      expect(cand.power).toBe(computeHeroPower(cand.stats, cand.classId));
      expect(cand.look.rarity).toBe(cand.rarity); // the look carries the candidate's rarity layers
      if (cand.power > p.current.power) up++;
      if (cand.power < p.current.power) down++;
      await applyRerollPreview(db, id, p.previewId, "admin", deps);
    }
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0); // an unlimited admin reroll can land LOWER as well as higher: no boost, no guaranteed upgrade
  });
});
