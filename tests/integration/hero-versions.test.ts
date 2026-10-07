import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RARITIES, type Rarity } from "@/domain/character/appearance";
import { generateCharacter } from "@/domain/character/generate";
import { statBounds, versionStateFromGenerated } from "@/domain/hero/heroVersion";
import { isPowerInBand } from "@/domain/hero/rarity";
import { STAT_KEYS } from "@/domain/stats";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena, replayBattle } from "@/server/services/arena";
import { createCharacterForUser } from "@/server/services/characters";
import { claimCharacter } from "@/server/services/identity";
import {
  applyRerollPreview,
  getHeroVersioning,
  previewReroll,
  REROLL_PREVIEW_TTL_MS,
  rollbackHero,
  versionCard,
  type HeroVersionError,
  type HeroVersioningDeps,
} from "@/server/services/heroVersions";
import { heroArenaLock } from "@/server/services/heroVersionStore";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

const SECRET = "test-secret-value-1234567890";
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

const uuid = () => crypto.randomUUID();
const rejects = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as HeroVersionError | null;

async function reroll(id: string, over: Partial<HeroVersioningDeps> = {}) {
  const d = { ...deps, ...over };
  const preview = await previewReroll(db, id, "admin", d);
  return { preview, applied: await applyRerollPreview(db, id, preview.previewId, "admin", d) };
}
const versions = (id: string) => db.query<{ id: string; version_number: number; action: string; class_id: string; rarity: string; source_version_id: string | null; previous_version_id: string | null; request_id: string | null; power: number; stats: Record<string, number> }>(
  "select id, version_number, action, class_id, rarity, source_version_id, previous_version_id, request_id, power, stats from public.hero_versions where character_id = $1 order by version_number", [id]);
const current = async (id: string) => (await db.query<{ n: number }>("select v.version_number as n from public.hero_versions v join public.characters c on c.current_hero_version_id = v.id where c.id = $1", [id]))[0]!.n;
const audit = () => db.query<{ n: number }>("select count(*)::int as n from public.audit_hero_versions()").then((r) => r[0]!.n);
const projection = async (id: string) =>
  (await db.query<Record<string, unknown>>(
    `select c.class_id, a.rarity, a.parts, a.seed, a.sprite, s.variation, s.telegram_bonus from public.characters c
       join public.character_stats s on s.character_id = c.id join public.character_appearances a on a.character_id = c.id where c.id = $1`, [id]))[0]!;
const identity = async (id: string) =>
  (await db.query<Record<string, unknown>>(
    `select id, kind, telegram_user_id, public_id, name, name_override, status, origin, is_demo, tactic, title, created_at, arena_battles, arena_wins from public.characters where id = $1`, [id]))[0]!;

describe("hero creation always creates v1 INITIAL — in the same transaction", () => {
  it("every creation path leaves exactly one INITIAL v1, current, equal to the stored hero", async () => {
    const ids = await seedHeroes(db, 6);
    for (const id of ids) {
      const v = await versions(id);
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ version_number: 1, action: "INITIAL", source_version_id: null, previous_version_id: null, request_id: null });
      expect(await current(id)).toBe(1);
      const p = await projection(id);
      expect(p.class_id).toBe(v[0]!.class_id);
      expect(p.rarity).toBe(v[0]!.rarity);
    }
    expect(await audit()).toBe(0);
    expect((await db.query<{ created_by: string; generator_version: string }>("select distinct created_by, generator_version from public.hero_versions"))).toEqual([{ created_by: "system:telegram", generator_version: "hero-gen/2" }]);
  });

  it("the INITIAL roll is the member's permanent roll: the version stores the SAME full seed the generator derives (not a new one), and creating again changes nothing", async () => {
    const [id] = await seedHeroes(db, 1, { startId: 424242 });
    const [row] = await db.query<{ generation_seed: string; appearance_seed: string }>("select generation_seed, appearance_seed from public.hero_versions where character_id = $1", [id]);
    const [u] = await db.query<{ display_name: string; behavior: object; activity_score: number }>("select display_name, behavior, activity_score from public.telegram_users where telegram_user_id = 424242");
    const g = generateCharacter({ telegramUserId: 424242, displayName: u!.display_name, behavior: u!.behavior, activityScore: Number(u!.activity_score), classes: deps.classes, settings: deps.settings, secret: SECRET });
    expect(row!.generation_seed).toBe(g.generationSeed);
    expect(row!.appearance_seed).toBe(g.appearanceSeed);
    expect(g.generationSeed.startsWith(g.appearanceSeed)).toBe(true);
    const user = (await db.query("select * from public.telegram_users where telegram_user_id = 424242"))[0] as never;
    expect(await createCharacterForUser(db, user, { settings: deps.settings, classes: deps.classes, secret: SECRET, origin: "TELEGRAM" })).toMatchObject({ characterId: id, created: false });
    expect(await count(db, "hero_versions", `character_id = '${id}'`)).toBe(1);
  });

  it("if the INITIAL version cannot be created the whole creation fails: no hero is left behind", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values (777001, 'Doomed', 120)");
    await db.exec("alter table public.hero_versions add constraint force_failure check (power < 0) not valid");
    try {
      const user = (await db.query("select * from public.telegram_users where telegram_user_id = 777001"))[0] as never;
      await expect(createCharacterForUser(db, user, { settings: deps.settings, classes: deps.classes, secret: SECRET, origin: "TELEGRAM" })).rejects.toThrow(/force_failure/);
      expect(await count(db, "characters")).toBe(0);
      expect(await count(db, "character_stats")).toBe(0);
      expect(await count(db, "character_appearances")).toBe(0);
    } finally {
      await db.exec("alter table public.hero_versions drop constraint force_failure");
    }
    const user = (await db.query("select * from public.telegram_users where telegram_user_id = 777001"))[0] as never;
    expect((await createCharacterForUser(db, user, { settings: deps.settings, classes: deps.classes, secret: SECRET, origin: "TELEGRAM" })).created).toBe(true); // …and it works once the fault is gone
  });
});

describe("PREVIEW is a candidate, not a change", () => {
  it("leaves the hero byte-identical, writes no version, and the browser supplies nothing", async () => {
    const [id] = await seedHeroes(db, 1);
    const before = JSON.stringify([await identity(id!), await projection(id!), await versions(id!)]);
    const p = await previewReroll(db, id!, "admin", deps);
    expect(JSON.stringify([await identity(id!), await projection(id!), await versions(id!)])).toBe(before);
    expect(await count(db, "hero_versions", `character_id = '${id}'`)).toBe(1);
    expect(p.baseVersion).toBe(1);
    expect(new Date(p.expiresAt).getTime()).toBe(clock.ms + REROLL_PREVIEW_TTL_MS);
    expect(p.current.publicId).toBe(p.candidate.publicId);
    expect(p.current.name).toBe(p.candidate.name);
    expect(await count(db, "admin_audit_log", "action like 'hero.%'")).toBe(0); // previews need no permanent audit
  });

  it("REROLL AGAIN draws a fresh candidate (different server seed) and still changes nothing", async () => {
    const [id] = await seedHeroes(db, 1);
    const a = await previewReroll(db, id!, "admin", deps);
    const b = await previewReroll(db, id!, "admin", deps);
    expect(a.previewId).not.toBe(b.previewId);
    const seeds = await db.query<{ generation_seed: string }>("select generation_seed from public.hero_reroll_previews where character_id = $1", [id]);
    expect(new Set(seeds.map((s) => s.generation_seed)).size).toBe(2);
    expect(await count(db, "hero_versions", `character_id = '${id}'`)).toBe(1);
    expect(await current(id!)).toBe(1);
  });

  it("the stored candidate is reproducible from its seed with the SAME generator (exactly what Apply will use — no second roll)", async () => {
    const [id] = await seedHeroes(db, 1);
    const nonce = "f".repeat(32);
    const p = await previewReroll(db, id!, "admin", { ...deps, nonce: () => nonce });
    const [row] = await db.query<{ candidate: { classId: string; rarity: string; stats: Record<string, number>; generationSeed: string } }>("select candidate from public.hero_reroll_previews where id = $1", [p.previewId]);
    const [u] = await db.query<{ telegram_user_id: number; display_name: string; behavior: object; activity_score: number }>("select telegram_user_id, display_name, behavior, activity_score from public.telegram_users limit 1");
    const g = generateCharacter({ telegramUserId: Number(u!.telegram_user_id), displayName: u!.display_name, behavior: u!.behavior, activityScore: Number(u!.activity_score), classes: deps.classes, settings: deps.settings, secret: SECRET, seedSalt: nonce });
    expect(row!.candidate).toMatchObject({ classId: g.classId, rarity: g.rarity, generationSeed: g.generationSeed });
    const state = versionStateFromGenerated(g, deps.classes.find((c) => c.id === g.classId)!, deps.settings.character, deps.settings.visuals.spriteSet);
    expect(row!.candidate.stats).toEqual(state.stats);
    expect(p.candidate.rarity).toBe(g.rarity);
    expect(p.candidate.classId).toBe(g.classId);
  });

  it("special (hand-authored) characters cannot be rerolled", async () => {
    const { createSpecialCharacter } = await import("@/server/services/admin");
    const { id } = await createSpecialCharacter(db, { name: "Team Rivet", classId: "tank", role: "Lead", rarity: "LEGENDARY", appearanceSeed: "rivet" }, "admin");
    expect((await rejects(previewReroll(db, id, "admin", deps)))?.code).toBe("NOT_REROLLABLE");
    expect((await getHeroVersioning(db, id)).rerollable).toBe(false);
    expect(await versions(id)).toHaveLength(1); // …but it is a hero too: it has its INITIAL v1
  });
});

describe("APPLY THIS REROLL", () => {
  it("appends exactly one REROLL version that IS the previewed candidate, and moves the hero — and nothing about its identity", async () => {
    const [id] = await seedHeroes(db, 1);
    await claimCharacter(db, Number((await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters where id = $1", [id]))[0]!.telegram_user_id), new Date(clock.ms));
    const ident0 = await identity(id!);
    const claims0 = await db.query("select * from public.character_claims");
    const p = await previewReroll(db, id!, "admin", deps);
    const r = await applyRerollPreview(db, id!, p.previewId, "admin", deps);
    expect(r.alreadyApplied).toBe(false);
    expect(r.version).toMatchObject({ number: 2, action: "REROLL", current: true, previousVersion: 1, sourceVersion: null });
    const v = await versions(id!);
    expect(v.map((x) => [x.version_number, x.action])).toEqual([[1, "INITIAL"], [2, "REROLL"]]);
    expect(v[1]).toMatchObject({ request_id: p.previewId, previous_version_id: v[0]!.id, source_version_id: null });
    // the hero now equals the candidate the admin was shown
    expect(r.card.classId).toBe(p.candidate.classId);
    expect(r.card.rarity).toBe(p.candidate.rarity);
    expect(r.card.power).toBe(p.candidate.power);
    expect(r.card.stats).toEqual(p.candidate.stats);
    expect(r.card.look.sprite).toEqual(p.candidate.look.sprite);
    expect((await projection(id!)).class_id).toBe(p.candidate.classId);
    // identity untouched (only updated_at moves with the rewrite)
    const ident1 = await identity(id!);
    expect(ident1).toEqual(ident0);
    expect(await db.query("select * from public.character_claims")).toEqual(claims0);
    expect(await audit()).toBe(0);
    // POWER: the cached effective power follows the new generated stats (no wallet / gear here)
    expect(Number((await db.query<{ power: number }>("select power from public.characters where id = $1", [id]))[0]!.power)).toBe(v[1]!.power);
  });

  it("writes an audit entry (hero, versions, action, actor, time) — and no seed", async () => {
    const [id] = await seedHeroes(db, 1);
    const { preview, applied } = await reroll(id!);
    const [a] = await db.query<{ actor: string; action: string; entity_id: string; detail: Record<string, unknown>; created_at: Date }>("select actor, action, entity_id, detail, created_at from public.admin_audit_log where action = 'hero.reroll'");
    expect(a).toMatchObject({ actor: "admin", action: "hero.reroll", entity_id: id });
    expect(a!.detail).toMatchObject({ heroId: id, action: "REROLL", previousVersion: 1, newVersion: 2, previewId: preview.previewId });
    const seed = (await db.query<{ generation_seed: string }>("select generation_seed from public.hero_versions where character_id = $1 and version_number = 2", [id]))[0]!.generation_seed;
    expect(JSON.stringify(a)).not.toContain(seed);
    expect(applied.version.number).toBe(2);
  });

  it("DOUBLE CLICK: applying the same preview again (also concurrently) is answered idempotently — one version, never two", async () => {
    const [id] = await seedHeroes(db, 1);
    const p = await previewReroll(db, id!, "admin", deps);
    const results = await Promise.all([applyRerollPreview(db, id!, p.previewId, "admin", deps), applyRerollPreview(db, id!, p.previewId, "admin", deps), applyRerollPreview(db, id!, p.previewId, "admin", deps)]);
    expect(results.filter((r) => !r.alreadyApplied)).toHaveLength(1);
    expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
    expect(await versions(id!)).toHaveLength(2);
    expect(await count(db, "admin_audit_log", "action = 'hero.reroll'")).toBe(1);
  });

  it("two previews of the same base: the first Apply wins, the other is STALE (one committed transition)", async () => {
    const [id] = await seedHeroes(db, 1);
    const a = await previewReroll(db, id!, "admin", deps);
    const b = await previewReroll(db, id!, "admin", deps);
    const [ra, rb] = await Promise.all([rejects(applyRerollPreview(db, id!, a.previewId, "admin", deps)), rejects(applyRerollPreview(db, id!, b.previewId, "admin", deps))]);
    expect([ra, rb].filter(Boolean)).toHaveLength(1);
    expect([ra, rb].find(Boolean)).toMatchObject({ code: "STALE_PREVIEW", status: 409 });
    expect(await versions(id!)).toHaveLength(2);
    expect(await current(id!)).toBe(2);
    expect(await audit()).toBe(0);
  });

  it("an expired preview, an unknown preview and another hero's preview are refused", async () => {
    const [h1, h2] = await seedHeroes(db, 2);
    const p = await previewReroll(db, h1!, "admin", deps);
    expect((await rejects(applyRerollPreview(db, h2!, p.previewId, "admin", deps)))?.code).toBe("PREVIEW_NOT_FOUND");
    expect((await rejects(applyRerollPreview(db, h1!, uuid(), "admin", deps)))?.code).toBe("PREVIEW_NOT_FOUND");
    clock.advance(REROLL_PREVIEW_TTL_MS + 1);
    expect(await rejects(applyRerollPreview(db, h1!, p.previewId, "admin", deps))).toMatchObject({ code: "PREVIEW_EXPIRED", status: 410 });
    expect(await versions(h1!)).toHaveLength(1);
  });

  it("a preview goes STALE when the hero changed after it was drawn (a rollback / another reroll)", async () => {
    const [id] = await seedHeroes(db, 1);
    const old = await previewReroll(db, id!, "admin", deps);
    await reroll(id!);
    expect((await rejects(applyRerollPreview(db, id!, old.previewId, "admin", deps)))?.code).toBe("STALE_PREVIEW");
  });

  it("is UNLIMITED — no cost, cooldown, daily limit or cap: 25 applied rerolls in a row, each valid and within the production bounds, with no corruption", async () => {
    const [id] = await seedHeroes(db, 1);
    const classOf = new Map(deps.classes.map((c) => [c.id, c]));
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { applied } = await reroll(id!); // the clock never moves: no cooldown could ever allow this
      expect(applied.version.number).toBe(i + 2);
      expect(RARITIES).toContain(applied.version.rarity);
      expect(classOf.has(applied.version.classId)).toBe(true);
      const { min, max } = statBounds(classOf.get(applied.version.classId)!, deps.settings.character, applied.version.rarity);
      for (const k of STAT_KEYS) {
        expect(applied.card.stats[k], `${k} of v${i + 2}`).toBeGreaterThanOrEqual(min[k]);
        expect(applied.card.stats[k], `${k} of v${i + 2}`).toBeLessThanOrEqual(max[k]);
      }
      expect(isPowerInBand(applied.version.rarity, applied.card.power), `PWR of v${i + 2} is inside its rarity's band`).toBe(true);
      seen.add(`${applied.version.classId}/${applied.version.rarity}`);
    }
    const v = await versions(id!);
    expect(v.map((x) => x.version_number)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1)); // no gaps, no duplicates
    expect(new Set(v.map((x) => x.id)).size).toBe(26);
    expect(await current(id!)).toBe(26);
    expect(await audit()).toBe(0);
    expect(await count(db, "admin_audit_log", "action = 'hero.reroll'")).toBe(25);
    expect(await count(db, "currency_ledger")).toBe(0); // costs nothing
    expect(seen.size).toBeGreaterThan(5); // it really does roll different classes / rarities
  });
});

describe("rarity is a STRENGTH tier (a reroll may go Common→Epic or Epic→Common — nothing is boosted, the production odds apply)", () => {
  it("the same roll under every rarity keeps the class and the look's identity; a higher rarity is a higher PWR inside its own band", async () => {
    const classes = await loadClasses(db);
    const base = await loadSettings(db);
    const out = RARITIES.map((r) => {
      const weights = Object.fromEntries(RARITIES.map((x) => [x, x === r ? 1 : 0])) as Record<Rarity, number>;
      const settings = { ...base, character: { ...base.character, rarityWeights: weights } };
      const g = generateCharacter({ telegramUserId: 99, displayName: "x", behavior: {}, activityScore: 40, classes, settings, secret: SECRET, seedSalt: "same-nonce" });
      return { r, g, state: versionStateFromGenerated(g, classes.find((c) => c.id === g.classId)!, base.character, "clank-dev-v1") };
    });
    expect(out.map((o) => o.g.rarity)).toEqual([...RARITIES]);
    out.forEach((o, i) => {
      expect(o.state.classId).toBe(out[0]!.state.classId); // class comes from its own seed stream, never from rarity
      expect(isPowerInBand(o.r, o.state.power)).toBe(true);
      if (i > 0) expect(o.state.power).toBeGreaterThan(out[i - 1]!.state.power);
      // identity parts of the look are the same under every rarity; only the rarity layers differ
      expect(o.g.appearance.skin).toBe(out[0]!.g.appearance.skin);
      expect(o.g.appearance.hairStyle).toBe(out[0]!.g.appearance.hairStyle);
    });
    expect(new Set(out.map((o) => JSON.stringify(o.g.appearance))).size).toBe(4); // …while the rarity layers make every tier look different
  });

  it("over thousands of rolls every rarity sits inside its own band, means climb with rarity, and the odds are still the normal ones", async () => {
    const classes = await loadClasses(db);
    const base = await loadSettings(db);
    const sums = new Map<Rarity, { n: number; power: number; min: number; max: number }>();
    for (let i = 0; i < 6000; i++) {
      const g = generateCharacter({ telegramUserId: 1000 + (i % 50), displayName: "x", behavior: {}, activityScore: 40, classes, settings: base, secret: SECRET, seedSalt: `n${i}` });
      const st = versionStateFromGenerated(g, classes.find((c) => c.id === g.classId)!, base.character, "clank-dev-v1");
      const s = sums.get(g.rarity) ?? { n: 0, power: 0, min: Infinity, max: 0 };
      sums.set(g.rarity, { n: s.n + 1, power: s.power + st.power, min: Math.min(s.min, st.power), max: Math.max(s.max, st.power) });
    }
    let previousMean = 0;
    for (const r of RARITIES) {
      const s = sums.get(r)!;
      expect(s.n, `${r} was rolled`).toBeGreaterThan(0);
      expect(isPowerInBand(r, s.min) && isPowerInBand(r, s.max), `${r} stays inside its band`).toBe(true);
      expect(s.power / s.n).toBeGreaterThan(previousMean);
      previousMean = s.power / s.n;
    }
    // 70 / 22 / 7 / 1 %: a reroll uses the configured weights — LEGENDARY is not boosted
    expect((sums.get("LEGENDARY")?.n ?? 0) / 6000).toBeLessThan(0.02);
    expect((sums.get("COMMON")?.n ?? 0) / 6000).toBeGreaterThan(0.64);
  });
});

describe("ROLLBACK", () => {
  async function history(n = 3) {
    const [id] = await seedHeroes(db, 1);
    for (let i = 0; i < n; i++) await reroll(id!); // v1 INITIAL, v2…v(n+1) REROLL
    return id!;
  }
  const rb = (id: string, target: string, expected: string, requestId = uuid()) => rollbackHero(db, { characterId: id, targetVersionId: target, expectedCurrentVersionId: expected, requestId }, "admin", deps);
  const idOf = async (id: string, n: number) => (await versions(id)).find((v) => v.version_number === n)!.id;

  it("v1 INITIAL · v2 · v3 · v4 REROLL → rollback to v2 appends v5 ROLLBACK (source v2) whose state is EXACTLY v2 — then a reroll is v6; nothing is ever deleted", async () => {
    const id = await history(3);
    const v2State = (await versions(id)).find((v) => v.version_number === 2)!;
    const v2Projection = await (async () => { const r = await rb(id, await idOf(id, 2), await idOf(id, 4)); return { r, p: await projection(id) }; })();
    expect(v2Projection.r.version).toMatchObject({ number: 5, action: "ROLLBACK", sourceVersion: 2, previousVersion: 4, current: true });
    const all = await versions(id);
    expect(all.map((v) => [v.version_number, v.action])).toEqual([[1, "INITIAL"], [2, "REROLL"], [3, "REROLL"], [4, "REROLL"], [5, "ROLLBACK"]]);
    const v5 = all[4]!;
    expect(v5.source_version_id).toBe(v2State.id);
    // the exact RPG state of v2 …
    const [cmp] = await db.query<{ same: boolean }>(
      `select (a.class_id = b.class_id and a.rarity = b.rarity and a.variation = b.variation and a.telegram_bonus = b.telegram_bonus and a.stats = b.stats and a.power = b.power
               and a.appearance = b.appearance and a.appearance_seed = b.appearance_seed and a.sprite is not distinct from b.sprite and a.generation_seed = b.generation_seed) as same
         from public.hero_versions a, public.hero_versions b where a.id = $1 and b.id = $2`, [v5.id, v2State.id]);
    expect(cmp!.same).toBe(true);
    expect(v2Projection.p.class_id).toBe(v2State.class_id);
    expect(v2Projection.p.rarity).toBe(v2State.rarity);
    expect(await audit()).toBe(0);
    // …and the history simply continues
    const { applied } = await reroll(id);
    expect(applied.version).toMatchObject({ number: 6, action: "REROLL" });
    expect((await versions(id)).map((v) => v.version_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(await count(db, "admin_audit_log", "action = 'hero.rollback'")).toBe(1);
  });

  it("can restore ANY earlier version, including the INITIAL one — and the hero's identity never moves", async () => {
    const id = await history(4);
    const ident = await identity(id);
    const v1 = (await versions(id))[0]!;
    await rb(id, v1.id, await idOf(id, 5));
    expect(await current(id)).toBe(6);
    expect((await projection(id)).class_id).toBe(v1.class_id);
    expect(await identity(id)).toEqual(ident);
    expect((await versions(id))[5]).toMatchObject({ action: "ROLLBACK", source_version_id: v1.id });
  });

  it("a retried click (same key) returns the same version; refuses a stale screen, a no-op, an unknown version and a reused key", async () => {
    const id = await history(3);
    const target = await idOf(id, 2);
    const expected = await idOf(id, 4);
    const key = uuid();
    const first = await rb(id, target, expected, key);
    const again = await rb(id, target, expected, key);
    expect(again.alreadyApplied).toBe(true);
    expect(again.version.id).toBe(first.version.id);
    expect(await versions(id)).toHaveLength(5);
    // the screen still says v4 but the hero is on v5 now
    expect((await rejects(rb(id, await idOf(id, 3), expected)))?.code).toBe("STALE_VERSION");
    // restoring the version that is already current
    expect((await rejects(rb(id, await idOf(id, 5), await idOf(id, 5))))?.code).toBe("ALREADY_CURRENT");
    expect((await rejects(rb(id, uuid(), await idOf(id, 5))))?.code).toBe("VERSION_NOT_FOUND");
    expect((await rejects(rb(id, await idOf(id, 1), await idOf(id, 5), key)))?.code).toBe("REQUEST_CONFLICT");
    expect(await versions(id)).toHaveLength(5);
  });

  it("another hero's version can never be restored", async () => {
    const [a, b] = await seedHeroes(db, 2);
    await reroll(a!);
    const bV1 = (await versions(b!))[0]!.id;
    expect((await rejects(rb(a!, bV1, await idOf(a!, 2))))?.code).toBe("VERSION_NOT_FOUND");
  });

  it("APPLY vs ROLLBACK race, and two rollbacks: exactly one committed transition each time", async () => {
    const id = await history(2); // v1 v2 v3
    const p = await previewReroll(db, id, "admin", deps); // drawn from v3
    const v3 = await idOf(id, 3);
    const results = await Promise.all([rejects(applyRerollPreview(db, id, p.previewId, "admin", deps)), rejects(rb(id, await idOf(id, 1), v3))]);
    expect(results.filter(Boolean)).toHaveLength(1); // the loser is refused as stale
    expect(await versions(id)).toHaveLength(4);
    expect(await audit()).toBe(0);
    const v4 = await idOf(id, 4);
    const two = await Promise.all([rejects(rb(id, await idOf(id, 2), v4)), rejects(rb(id, await idOf(id, 2), v4))]);
    expect(two.filter(Boolean)).toHaveLength(1);
    expect(await versions(id)).toHaveLength(5);
    expect(await audit()).toBe(0);
  });
});

describe("ARENA SAFETY: a hero in a prepared / frozen roster cannot be changed", () => {
  it("refuses Apply AND Rollback for heroes in the CURRENT, UPCOMING and the next prepared roster; frees them once those battles settle", async () => {
    const ids = await seedHeroes(db, 30);
    for (const id of ids) await reroll(id); // everyone has v1 + v2 (so a rollback target exists)
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const battles = await db.query<{ id: string; sequence: number; status: string }>("select id, sequence, status from public.arena_battles order by sequence");
    expect(battles.map((b) => b.status)).toEqual(["SIMULATED", "SIMULATED", "SIMULATED"]); // on stage + upcoming + one prepared behind it
    const rosters = await Promise.all(battles.map(async (b) => (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1", [b.id])).map((r) => r.character_id)));
    const frozen = new Set(rosters.flat());
    expect(frozen.size).toBe(24);

    for (const [i, roster] of rosters.entries()) {
      const hero = roster[0]!;
      expect((await heroArenaLock(db, hero)).locked, `battle ${i + 1}`).toBe(true);
      const p = await previewReroll(db, hero, "admin", deps); // looking is allowed…
      const apply = await rejects(applyRerollPreview(db, hero, p.previewId, "admin", deps));
      expect(apply, `apply, battle ${i + 1}`).toMatchObject({ code: "HERO_IN_ARENA", status: 409 });
      expect(apply!.message).toBe("Hero is currently queued in a live Arena fight. Try again after the prepared battle cycle completes.");
      const [v1, v2] = await versions(hero);
      expect((await rejects(rollbackHero(db, { characterId: hero, targetVersionId: v1!.id, expectedCurrentVersionId: v2!.id, requestId: uuid() }, "admin", deps)))?.code, `rollback, battle ${i + 1}`).toBe("HERO_IN_ARENA");
      expect(await current(hero)).toBe(2); // …but nothing changed
      expect((await getHeroVersioning(db, hero)).arenaLock).toMatchObject({ locked: true });
    }
    // a hero that is in NO unsettled roster is free
    const free = ids.find((id) => !frozen.has(id))!;
    expect((await getHeroVersioning(db, free)).arenaLock).toMatchObject({ locked: false, message: null });
    expect((await reroll(free)).applied.version.number).toBe(3);

    // the battle on stage settles → its heroes are free again (those not also in a later prepared roster)
    const first = new Set(rosters[0]);
    const later = new Set(rosters.slice(1).flat());
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [battles[0]!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const released = [...first].find((h) => !later.has(h) && true)!;
    // …unless the arena has meanwhile lined it up again (a fresh cycle) — in that case it is simply locked again, correctly
    const lock = await heroArenaLock(db, released);
    if (!lock.locked) expect((await reroll(released)).applied.version.number).toBe(3);
    else expect((await rejects(reroll(released).then(() => null)))?.code).toBe("HERO_IN_ARENA");
  });

  it("an Apply that the arena's frozen snapshot raced with cannot slip through: the roster share-lock + the hero row lock serialise them", async () => {
    // Sequential proof of the ordering the locks enforce: simulate FIRST (roster frozen), then try to change → refused;
    // change FIRST (hero not yet rostered) → the later snapshot simply contains the new version.
    const ids = await seedHeroes(db, 16);
    const target = ids[0]!;
    const { applied } = await reroll(target); // changed while in no roster
    await advanceArena(db, arenaCtx(clock));
    const [snap] = await db.query<{ snapshot: { display: Array<{ characterId: string; classId: string; appearance: { rarity: string } }> } }>(
      "select b.snapshot from public.arena_battles b join public.arena_participants p on p.battle_id = b.id where p.character_id = $1 and b.status = 'SIMULATED' order by b.sequence limit 1", [target]);
    const frozen = snap!.snapshot.display.find((d) => d.characterId === target)!;
    expect(frozen.classId).toBe(applied.card.classId);
    expect(frozen.appearance.rarity).toBe(applied.card.rarity);
  });
});

describe("HISTORICAL battles stay immutable", () => {
  it("rerolling a participant AFTER a battle leaves its snapshot, events hash, replay and winner untouched; new battles use the new version", async () => {
    const ids = await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1] = await db.query<{ id: string }>("select id from public.arena_battles order by sequence limit 1");
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [b1!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const parts = (await db.query<{ character_id: string }>("select character_id from public.arena_participants where battle_id = $1", [b1!.id])).map((r) => r.character_id);
    const snapshotBefore = JSON.stringify((await db.query<{ snapshot: unknown }>("select snapshot from public.arena_battles where id = $1", [b1!.id]))[0]!.snapshot);
    const rowBefore = JSON.stringify((await db.query("select events_hash, ruleset_hash, seed, winner_id, runner_up_id, result, duration_ms from public.arena_battles where id = $1", [b1!.id]))[0]);
    const replayBefore = await replayBattle(db, b1!.id);
    const placementsBefore = JSON.stringify(await db.query("select character_id, placement, eliminations, damage_dealt from public.arena_participants where battle_id = $1 order by character_id", [b1!.id]));

    // reroll every participant that is free right now (the others are in later prepared rosters)
    let rerolled = 0;
    for (const hero of parts) {
      if ((await heroArenaLock(db, hero)).locked) continue;
      await reroll(hero);
      rerolled++;
    }
    expect(rerolled).toBeGreaterThan(0);
    const replayAfter = await replayBattle(db, b1!.id);
    expect(replayAfter!.outcome.eventsHash).toBe(replayBefore!.outcome.eventsHash);
    expect(replayAfter!.outcome.ranking).toEqual(replayBefore!.outcome.ranking);
    expect(JSON.stringify((await db.query<{ snapshot: unknown }>("select snapshot from public.arena_battles where id = $1", [b1!.id]))[0]!.snapshot)).toBe(snapshotBefore);
    expect(JSON.stringify((await db.query("select events_hash, ruleset_hash, seed, winner_id, runner_up_id, result, duration_ms from public.arena_battles where id = $1", [b1!.id]))[0])).toBe(rowBefore);
    expect(JSON.stringify(await db.query("select character_id, placement, eliminations, damage_dealt from public.arena_participants where battle_id = $1 order by character_id", [b1!.id]))).toBe(placementsBefore);
    void ids;
  });

  it("the public 'recent winners' keeps showing the class and look the winner HAD in that battle, not the new ones", async () => {
    const ids = await seedHeroes(db, 24);
    const ctx = arenaCtx(clock);
    await advanceArena(db, ctx);
    const [b1] = await db.query<{ id: string; winner_id: string }>("select id, winner_id from public.arena_battles order by sequence limit 1");
    for (let s = 0; s < 400 && (await db.query("select 1 from public.arena_battles where id = $1 and status = 'SETTLED'", [b1!.id])).length === 0; s++) {
      clock.advance(1000);
      await advanceArena(db, ctx);
    }
    const { getArenaState } = await import("@/server/services/views");
    const stateOf = async () => getArenaState(db, clock.ms, deps.settings, { allowDemo: true, classes: deps.classes });
    const before = (await stateOf()).recent.find((r) => r.id === b1!.id)!;
    expect(before.winner!.characterId).toBe(b1!.winner_id);
    // reroll until the winner's class AND look differ from what it was (it must be free of any unsettled roster to be changeable)
    let changed = false;
    for (let i = 0; i < 30 && !changed && !(await heroArenaLock(db, b1!.winner_id)).locked; i++) {
      const { applied } = await reroll(b1!.winner_id);
      changed = applied.card.classId !== before.winner!.classId || applied.card.rarity !== before.winner!.appearance.rarity;
    }
    if (!changed) return void expect((await heroArenaLock(db, b1!.winner_id)).locked).toBe(true); // winner is queued again: protected, nothing to prove
    const after = (await stateOf()).recent.find((r) => r.id === b1!.id)!;
    expect(after.winner!.classId).toBe(before.winner!.classId);
    expect(after.winner!.appearance).toEqual(before.winner!.appearance);
    expect(after.winner!.power).toBe(before.winner!.power);
    void ids;
  });
});

describe("history and previews of old versions", () => {
  it("lists every version newest first with action, class, rarity, POWER and the version it relates to; PREVIEW draws any old version as a card", async () => {
    const [id] = await seedHeroes(db, 1);
    await reroll(id!);
    await reroll(id!);
    const v = await versions(id!);
    await rollbackHero(db, { characterId: id!, targetVersionId: v[1]!.id, expectedCurrentVersionId: v[2]!.id, requestId: uuid() }, "admin", deps);
    const view = await getHeroVersioning(db, id!);
    expect(view.versionCount).toBe(4);
    expect(view.currentVersion).toBe(4);
    expect(view.versions.map((x) => [x.number, x.action, x.current, x.sourceVersion, x.previousVersion])).toEqual([
      [4, "ROLLBACK", true, 2, 3], [3, "REROLL", false, null, 2], [2, "REROLL", false, null, 1], [1, "INITIAL", false, null, null],
    ]);
    expect(view.versions.every((x) => x.className && x.power > 0 && RARITIES.includes(x.rarity))).toBe(true);
    const old = await versionCard(db, id!, v[0]!.id, deps);
    expect(old.version).toBe(1);
    expect(old.card.classId).toBe(v[0]!.class_id);
    expect(old.card.rarity).toBe(v[0]!.rarity);
    expect(old.card.stats).toEqual(v[0]!.stats); // no wallet / gear bonus → effective == generated
    expect(await current(id!)).toBe(4); // looking changes nothing
  });
});
