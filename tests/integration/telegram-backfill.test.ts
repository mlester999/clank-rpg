import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateCharacter } from "@/domain/character/generate";
import { spriteConfigSchema } from "@/domain/sprites/config";
import { planImport } from "@/domain/telegram/importPlan";
import type { IngestMessage } from "@/domain/telegram/types";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { makeTextHasher } from "@/server/crypto";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { applyBackfill, buildBackfillPlan, buildBackfillPlanBatched, previousImportExpectation, summarizeStored, type BackfillDeps } from "@/server/services/telegramBackfill";
import { applyImportPlan, refreshDerivedCounters } from "@/server/services/telegramImport";
import { verifyTelegramBackfillScratch } from "../../scripts/lib/telegram-backfill-scratch";

import { arenaCtx, count, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

const CHAT = -1002494847180;
const T0 = Date.UTC(2025, 2, 1, 9, 0, 0);
const DAY = 86_400_000;
const SECRET = "backfill-test-class-secret-0123456789";

let db: Db;
let deps: BackfillDeps & { classRollSecret: string };
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

let nextId = 1;
function msgs(author: number, n: number, name = `Member ${author}`, replyTo: number | null = null): IngestMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    chatId: CHAT, messageId: nextId++, authorId: author, username: null, displayName: name,
    sentAtMs: T0 + Math.floor(i / 30) * DAY + (i % 30) * 90_000,
    text: `substantive contribution ${i} from member ${author} about launch mechanics number ${i * 7 + author}`,
    isReply: replyTo !== null, replyToUserId: replyTo, isForwarded: false, mediaKind: "none", source: "IMPORT",
  }) satisfies IngestMessage);
}

/** Stores history the way the bulk importer does when heroes are deferred: members, messages, daily rows, counters — NO heroes. */
async function storeHistory(messages: IngestMessage[]) {
  const settings = await loadSettings(db);
  const plan = planImport({ messages, settings, hash: makeTextHasher("backfill-test-pepper-value") });
  await applyImportPlan(db, plan);
  await refreshDerivedCounters(db, plan.users.map((u) => u.userId), settings);
}

/** Exact content of everything the backfill must NEVER change. */
async function fingerprint() {
  const q = async (sql: string) => JSON.stringify((await db.query(sql))[0]);
  return [
    await q("select count(*)::int n, md5(string_agg(chat_id||':'||message_id||':'||qualifies||':'||coalesce(reject_reason,'-')||':'||weight||':'||features::text, ',' order by message_id)) h from public.telegram_messages"),
    await q("select count(*)::int n, md5(string_agg(telegram_user_id||':'||total_message_count||':'||qualifying_message_count||':'||active_days||':'||replies_received||':'||reactions_received||':'||activity_score||':'||status||':'||display_name, ',' order by telegram_user_id)) h from public.telegram_users"),
    await q("select count(*)::int n, md5(string_agg(telegram_user_id||':'||day||':'||message_count||':'||qualifying_count, ',' order by telegram_user_id, day)) h from public.telegram_daily_activity"),
    await q("select count(*)::int n from public.telegram_reactions"),
    await q("select (select count(*) from public.currency_ledger)::int ledger, (select count(*) from public.currency_accounts)::int accts, (select coalesce(sum(xp),0) from public.characters)::int xp, (select coalesce(max(level),0) from public.characters)::int lvl"),
  ].join("|");
}

const plan = async (over: Partial<BackfillDeps> = {}) => (await buildBackfillPlan(db, { ...deps, ...over })).plan;
const heroFor = async (id: number) => (await db.query<{ class_id: string; name: string; sprite: unknown; rarity: string; seed: string }>(
  "select c.class_id, c.name, a.sprite, a.rarity, a.seed from public.characters c join public.character_appearances a on a.character_id = c.id where c.telegram_user_id = $1", [id]))[0];

beforeEach(async () => {
  await resetDb(db);
  deps = { chatId: CHAT, settings: await loadSettings(db), classes: await loadClasses(db), classRollSecret: SECRET };
  nextId = 1;
  await storeHistory([
    ...msgs(301, 130, "Ada Quill"), // eligible
    ...msgs(302, 105, "Bram Stone", 301), // eligible, replies to 301
    ...msgs(303, 49, "Cleo Near"), // one short
    ...msgs(304, 200, "Dax Banned"), // eligible by content, but banned below
    ...msgs(305, 50, "Gus Regular"), // eligible at the new boundary
    ...msgs(306, 30, "Eve Small"),
    ...msgs(307, 140, "Finn Existing"), // already has a hero
  ]);
  await db.exec("update public.telegram_users set status = 'BANNED' where telegram_user_id = 304");
  // Heroes that exist before the rarity power system were drawn by the FIRST generator (that is what the live database holds): hero-gen/1 stats + a v1 INITIAL snapshot.
  await seedHeroes(db, 1, { startId: 307, legacy: true });
});

describe("telegram hero backfill from stored history", () => {
  it("batched production-style preview matches the full planner and leaves every source row unchanged", async () => {
    const before = await fingerprint();
    const progress: Array<[number, number]> = [];
    const reads: Array<[number, number, number]> = [];
    let reconnects = 0;
    const batched = await buildBackfillPlanBatched(db, deps, {
      batchSize: 2, messagePageSize: 200,
      onBatch: ({ done, total }) => progress.push([done, total]),
      onRead: ({ batch, page, rows }) => reads.push([batch, page, rows]),
      reconnect: async () => { reconnects++; },
    });
    const direct = await plan();

    expect(batched.plan).toEqual(direct);
    expect(progress).toEqual([[2, 7], [4, 7], [6, 7], [7, 7]]);
    expect(reads.filter(([, page]) => page > 0).every(([, , rows]) => rows <= 200)).toBe(true);
    expect(reads.filter(([, page]) => page > 0).some(([, , rows]) => rows === 200)).toBe(true);
    expect(reconnects).toBe(4);
    expect(await fingerprint()).toBe(before);
  });

  it("reassembles stable pages when many messages share one timestamp", async () => {
    const sameTime = msgs(308, 205, "Equal-Time Member").map((message) => ({ ...message, sentAtMs: T0 }));
    const reverseTime = msgs(309, 205, "Reverse-Time Member").map((message, index) => ({ ...message, sentAtMs: T0 + (204 - index) * DAY }));
    await storeHistory([...sameTime, ...reverseTime]);
    const direct = await buildBackfillPlan(db, deps);
    const paged = await buildBackfillPlanBatched(db, deps, { batchSize: 3, messagePageSize: 17 });

    expect(paged).toEqual(direct);
    expect(paged.stored.find((member) => member.userId === 308)?.messages.map((message) => message.messageId)).toEqual(
      direct.stored.find((member) => member.userId === 308)?.messages.map((message) => message.messageId),
    );
    const sortedByFeatureTime = paged.stored.find((member) => member.userId === 309)?.messages ?? [];
    expect(sortedByFeatureTime.map((message) => message.features.sentAtMs)).toEqual([...sortedByFeatureTime.map((message) => message.features.sentAtMs)].sort((a, b) => a - b));
  });

  it("dry run: reports the stored history exactly and never writes (Postgres-enforced READ ONLY)", async () => {
    const before = await fingerprint();
    const p = await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION READ ONLY");
      return (await buildBackfillPlan(tx, deps)).plan;
    });
    await expect(
      db.transaction(async (tx) => {
        await tx.exec("SET TRANSACTION READ ONLY");
        await tx.query("insert into public.characters (kind, telegram_user_id, class_id, name, origin) values ('COMMUNITY', 306, 'mage', 'x', 'ADMIN')");
      }),
    ).rejects.toThrow(/read-only/i);
    expect(await fingerprint()).toBe(before);
    expect(await count(db, "characters")).toBe(1);

    const t = p.totals;
    expect(t.membersConsidered).toBe(7);
    expect(t.messagesConsidered).toBe(130 + 105 + 49 + 200 + 50 + 30 + 140);
    expect(t.storedQualifying).toBe(t.rescoredQualifying);
    expect(t.driftMembers).toBe(0);
    expect(t.eligible).toBe(4); // 301, 302, 305, 307 — the banned member is excluded, 303 is one short
    expect(t.eligibilitySetsMatch).toBe(true);
    expect(t.heroesPresent).toBe(1); // 307
    expect(t.nearMiss).toBe(1);
    expect(t.nonOkMembers).toBe(1);
    expect(p.nonOk.map((x) => x.userId)).toEqual([304]);
    expect(p.heroes.map((x) => x.userId).sort()).toEqual([301, 302, 305]);
    expect(t.wouldCreate).toBe(3);
    expect(t.blockedBotLike).toBe(0);
    expect(p.ambiguous.botLike).toEqual([]);
  });

  it("previews exactly what apply creates: class, rarity, name, appearance seed and a valid deterministic sprite", async () => {
    const preview = (await plan()).heroes;
    await applyBackfill(db, deps, { expectNewHeroes: 3 });
    for (const pv of preview) {
      const hero = await heroFor(pv.userId);
      expect(hero?.class_id).toBe(pv.classId);
      expect(hero?.rarity).toBe(pv.rarity);
      expect(hero?.name).toBe(pv.name);
      expect(hero?.seed).toBe(pv.appearanceSeed);
      expect(spriteConfigSchema.safeParse(hero?.sprite).success).toBe(true);
      expect(pv.classValid && pv.rarityValid && pv.statsValid && pv.appearanceValid).toBe(true);
      expect(pv.spriteValid && pv.deterministic).toBe(true);
    }
  });

  it("class and look come from the secret and the Telegram id only (permanent, reproducible)", async () => {
    await applyBackfill(db, deps);
    const [u] = await db.query<{ behavior: object; activity_score: number; display_name: string }>("select behavior, activity_score, display_name from public.telegram_users where telegram_user_id = 301");
    const g = generateCharacter({ telegramUserId: 301, displayName: u!.display_name, behavior: u!.behavior, activityScore: Number(u!.activity_score), classes: deps.classes, settings: deps.settings, secret: SECRET });
    const hero = await heroFor(301);
    expect(hero?.class_id).toBe(g.classId);
    expect(hero?.seed).toBe(g.appearanceSeed);
    await expect(db.query("update public.characters set class_id = $1 where telegram_user_id = 301", [g.classId === "mage" ? "tank" : "mage"])).rejects.toThrow(/permanent/);
  });

  it("is idempotent: a second and third run create nothing and change nothing", async () => {
    const first = await applyBackfill(db, deps);
    expect(first.heroesCreated).toBe(3);
    const afterFirst = await fingerprint();
    const heroes = await count(db, "characters");
    const second = await applyBackfill(db, deps);
    const third = await applyBackfill(db, deps);
    expect(second.heroesCreated).toBe(0);
    expect(third.heroesCreated).toBe(0);
    expect(await count(db, "characters")).toBe(heroes);
    expect(await fingerprint()).toBe(afterFirst);
    expect(second.after.totals.wouldCreate).toBe(0);
  });

  it("satisfies the scratch invariants after filling every newly eligible member", async () => {
    await applyBackfill(db, deps);

    expect(await count(db, "telegram_users", "status = 'OK' and not is_demo and qualifying_message_count >= 50 and not exists (select 1 from public.characters c where c.telegram_user_id = telegram_users.telegram_user_id)")).toBe(0);
    expect((await db.query<{ n: number }>("select count(*)::int as n from (select telegram_user_id from public.characters where telegram_user_id is not null group by telegram_user_id having count(*) > 1) d"))[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>(
      `select count(*)::int as n from public.characters c
         left join public.telegram_users u on u.telegram_user_id = c.telegram_user_id
         left join public.character_classes cc on cc.id = c.class_id
         left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo
          and (u.status <> 'OK' or u.qualifying_message_count < 50 or cc.id is null or s.character_id is null or a.character_id is null)`,
    ))[0]!.n).toBe(0);
  });

  it("replays a captured history and existing heroes into an isolated PGlite scratch database", async () => {
    await seedHeroes(db, 8, { startId: 910_000, legacy: true });
    const depsWithExclusion = { ...deps, excludeIds: new Set([305]) };
    const { plan: capturedPlan, stored } = await buildBackfillPlan(db, depsWithExclusion);
    const heroes = await db.query<{ character: Record<string, unknown>; stats: Record<string, unknown> | null; appearance: Record<string, unknown> | null }>(
      `select to_jsonb(c) as character, to_jsonb(s) as stats, to_jsonb(a) as appearance
         from public.characters c left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo order by c.telegram_user_id`,
    );
    const heroUsers = await db.query<Record<string, unknown>>(
      "select * from public.telegram_users where telegram_user_id = any($1::bigint[]) order by telegram_user_id",
      [heroes.map((hero) => Number(hero.character.telegram_user_id))],
    );
    const classRows = await db.query<Record<string, unknown>>("select id, name, description, enabled, sort_order, definition from public.character_classes order by sort_order, id");
    const skillRows = await db.query<Record<string, unknown>>("select id, name, enabled, definition from public.skills order by id");

    const result = await verifyTelegramBackfillScratch({
      chatId: CHAT, settings: deps.settings, classes: deps.classes, classRollSecret: SECRET, excludeIds: depsWithExclusion.excludeIds!,
      confirmedHumanIds: new Set(), stored, heroes, heroUsers, classRows, skillRows, plan: capturedPlan,
    });
    expect(result).toMatchObject({ existingHeroes: 9, createdHeroes: 2, totalHeroes: 11, duplicateTelegramIdentities: 0, completeGeneratedRows: 2, preExistingHeroRowsPreserved: true, preExistingArenaHistoryPreserved: true, missingEligibleHeroes: 0, idempotentSecondRun: true });
    expect(result.heroVersions).toMatchObject({ existingWithInitialV1: 9, newWithInitialV1: 2, totalInitialVersions: 11, totalVersions: 11, existingChanged: 0, existingSnapshotMismatches: 0, secondRunVersionsCreated: 0, auditViolations: 0 });
    expect(result.arena).toMatchObject({ eligibleHeroes: 11, initialBattles: 3, preparedAhead: 2 });
  });

  it("creates the 69-new / 139-total scratch case and preserves all 70 existing heroes", async () => {
    const candidateIds = Array.from({ length: 69 }, (_, i) => 800_000 + i);
    await db.query("update public.telegram_users set status = 'BANNED' where telegram_user_id = any($1::bigint[])", [[301, 302, 305]]);
    await seedHeroes(db, 69, { startId: 900_000, legacy: true });
    await storeHistory(candidateIds.flatMap((id, i) => msgs(id, 50, `Scale Member ${i + 1}`)));
    // Live is not pristine: a moderator has SUSPENDED some heroes (they exist, they are just not queued), and the cached POWER of heroes created before the
    // level / XP removal is stale. Neither may fail the proof, and neither may be hidden: total and arena-eligible are reported as the different numbers they are.
    const existing70 = (await db.query<{ id: string }>("select id from public.characters where kind = 'COMMUNITY' and not is_demo order by telegram_user_id limit 8")).map((r) => r.id);
    await db.query("update public.characters set status = 'SUSPENDED' where id = any($1::uuid[])", [existing70.slice(0, 3)]);
    await db.query("update public.characters set power = power + 9 where id = any($1::uuid[])", [existing70.slice(3, 8)]);

    const beforeSource = await fingerprint();
    const beforeExisting = await db.query<Record<string, unknown>>(
      `select c.id, c.telegram_user_id, c.class_id, c.name, c.name_override, c.level, c.xp, c.status, c.origin, c.is_demo, c.tactic, c.power,
              s.variation, s.telegram_bonus, s.holdings_bonus, s.loyalty_bonus, s.trading_bonus,
              a.rarity, a.parts, a.seed, a.sprite
         from public.characters c
         left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo order by c.telegram_user_id`,
    );
    expect(beforeExisting).toHaveLength(70);

    const captured = await buildBackfillPlan(db, deps);
    const preview = captured.plan;
    expect(preview.totals.driftMembers).toBe(0);
    expect(preview.totals.wouldCreate).toBe(69);
    expect(preview.heroes.map((hero) => hero.userId).sort((a, b) => a - b)).toEqual(candidateIds);

    const existingHeroRows = await db.query<{
      character: Record<string, unknown>; stats: Record<string, unknown> | null; appearance: Record<string, unknown> | null;
    }>(
      `select to_jsonb(c) as character, to_jsonb(s) as stats, to_jsonb(a) as appearance
         from public.characters c left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo order by c.telegram_user_id`,
    );
    const existingHeroUsers = await db.query<Record<string, unknown>>(
      "select * from public.telegram_users where telegram_user_id = any($1::bigint[]) order by telegram_user_id",
      [existingHeroRows.map((hero) => Number(hero.character.telegram_user_id))],
    );
    const classRows = await db.query<Record<string, unknown>>("select id, name, description, enabled, sort_order, definition from public.character_classes order by sort_order, id");
    const skillRows = await db.query<Record<string, unknown>>("select id, name, enabled, definition from public.skills order by id");
    const scratch = await verifyTelegramBackfillScratch({
      chatId: CHAT, settings: deps.settings, classes: deps.classes, classRollSecret: SECRET, excludeIds: new Set(),
      confirmedHumanIds: new Set(), stored: captured.stored, heroes: existingHeroRows, heroUsers: existingHeroUsers,
      classRows, skillRows, plan: preview,
    });
    expect(scratch).toMatchObject({
      existingHeroes: 70, createdHeroes: 69, totalHeroes: 139, duplicateTelegramIdentities: 0, completeGeneratedRows: 69,
      preExistingHeroRowsPreserved: true, preExistingArenaHistoryPreserved: true, missingEligibleHeroes: 0, idempotentSecondRun: true,
      arenaEligibleHeroes: 136, ineligibleHeroes: 3, // 3 suspended heroes EXIST (total 139) but do not fight
      arena: { eligibleHeroes: 136, initialBattles: 3, preparedAhead: 2 },
      // The release sequence: copies of the 70 existing heroes → hero-version migration → guarded backfill (69) → a second run.
      heroVersions: {
        existingWithInitialV1: 70, newWithInitialV1: 69, totalInitialVersions: 139, totalVersions: 139, missingInitialVersions: 0, duplicateCurrentVersions: 0,
        existingChanged: 0, existingSnapshotMismatches: 0, secondRunVersionsCreated: 0, auditViolations: 0, staleCachedPower: 5,
      },
    });

    const users = await db.query<{ telegram_user_id: number; display_name: string; behavior: object; activity_score: number }>(
      "select telegram_user_id, display_name, behavior, activity_score from public.telegram_users where telegram_user_id = any($1::bigint[]) order by telegram_user_id",
      [candidateIds],
    );
    const generated = new Map(users.map((user) => [Number(user.telegram_user_id), generateCharacter({
      telegramUserId: Number(user.telegram_user_id), displayName: user.display_name, behavior: user.behavior, activityScore: Number(user.activity_score),
      classes: deps.classes, settings: deps.settings, secret: SECRET,
    })]));

    const created = await applyBackfill(db, deps, { expectNewHeroes: 69 });
    expect(created.heroesCreated).toBe(69);
    expect(created.heroIds).toHaveLength(69);
    expect(new Set(created.heroIds).size).toBe(69);
    expect(await count(db, "characters", "kind = 'COMMUNITY' and not is_demo")).toBe(139);
    expect(await fingerprint()).toBe(beforeSource);

    const afterExisting = await db.query<Record<string, unknown>>(
      `select c.id, c.telegram_user_id, c.class_id, c.name, c.name_override, c.level, c.xp, c.status, c.origin, c.is_demo, c.tactic, c.power,
              s.variation, s.telegram_bonus, s.holdings_bonus, s.loyalty_bonus, s.trading_bonus,
              a.rarity, a.parts, a.seed, a.sprite
         from public.characters c
         left join public.character_stats s on s.character_id = c.id
         left join public.character_appearances a on a.character_id = c.id
        where c.kind = 'COMMUNITY' and not c.is_demo and c.telegram_user_id <> all($1::bigint[]) order by c.telegram_user_id`,
      [candidateIds],
    );
    expect(afterExisting).toEqual(beforeExisting);

    const actual = await db.query<{
      telegram_user_id: number; class_id: string; name: string; rarity: string; parts: object; seed: string; sprite: object;
      variation: object; telegram_bonus: object;
    }>(
      `select c.telegram_user_id, c.class_id, c.name, a.rarity, a.parts, a.seed, a.sprite, s.variation, s.telegram_bonus
         from public.characters c join public.character_appearances a on a.character_id = c.id join public.character_stats s on s.character_id = c.id
        where c.telegram_user_id = any($1::bigint[]) order by c.telegram_user_id`,
      [candidateIds],
    );
    expect(actual).toHaveLength(69);
    for (const row of actual) {
      const value = generated.get(Number(row.telegram_user_id))!;
      expect(row).toMatchObject({
        class_id: value.classId, name: value.name, rarity: value.rarity, parts: value.appearance, seed: value.appearanceSeed,
        sprite: value.sprite, variation: value.variation, telegram_bonus: value.telegramBonus,
      });
      expect(spriteConfigSchema.safeParse(row.sprite).success).toBe(true);
    }

    const second = await applyBackfill(db, deps, { expectNewHeroes: 0 });
    expect(second.heroesCreated).toBe(0);
    expect(await count(db, "characters", "kind = 'COMMUNITY' and not is_demo")).toBe(139);
  });

  it("places newly backfilled heroes into the ordinary Arena cycle with the existing roster", async () => {
    const result = await applyBackfill(db, deps);
    await seedHeroes(db, 20);

    const state = await advanceArena(db, arenaCtx(new FakeClock()));
    expect(state).toMatchObject({ status: "LIVE" });
    expect(await count(db, "arena_cycles", "status = 'ACTIVE' and hero_count = 24")).toBe(1);
    const queued = await db.query<{ character_id: string }>(
      "select character_id from public.arena_queue_entries where character_id = any($1::uuid[]) and cycle_id is not null",
      [result.heroIds],
    );
    expect(queued.map((x) => x.character_id).sort()).toEqual([...result.heroIds].sort());
  });

  it("never duplicates a hero, even when two runs overlap", async () => {
    const [a, b] = await Promise.all([applyBackfill(db, deps), applyBackfill(db, deps)]);
    expect(a.heroesCreated + b.heroesCreated).toBe(3);
    expect(await count(db, "characters", "kind = 'COMMUNITY'")).toBe(4); // 301, 302, 305 + the pre-existing 307
    expect((await db.query<{ n: number }>("select count(*)::int n from (select telegram_user_id from public.characters group by 1 having count(*) > 1) d"))[0]?.n).toBe(0);
  });

  it("never touches messages, members, reactions, daily rows, XP, levels or Gold; does not disturb an existing hero", async () => {
    const before = await fingerprint();
    const existing = await db.query(`select c.id, c.telegram_user_id, c.class_id, c.name, c.name_override, c.power, c.level, c.xp, c.tactic,
      cs.variation, cs.telegram_bonus, ca.rarity, ca.parts, ca.seed, ca.sprite
      from public.characters c join public.character_stats cs on cs.character_id = c.id
      join public.character_appearances ca on ca.character_id = c.id where c.telegram_user_id = 307`);
    await applyBackfill(db, deps);
    const [b, a] = [before.split("|").slice(0, 4), (await fingerprint()).split("|").slice(0, 4)];
    expect(a).toEqual(b); // messages, members, daily, reactions byte-identical
    expect(await count(db, "currency_ledger")).toBe(0);
    expect(await count(db, "characters", "xp <> 0 or level <> 1")).toBe(0);
    expect(await db.query(`select c.id, c.telegram_user_id, c.class_id, c.name, c.name_override, c.power, c.level, c.xp, c.tactic,
      cs.variation, cs.telegram_bonus, ca.rarity, ca.parts, ca.seed, ca.sprite
      from public.characters c join public.character_stats cs on cs.character_id = c.id
      join public.character_appearances ca on ca.character_id = c.id where c.telegram_user_id = 307`)).toEqual(existing);
  });

  it("never creates a hero for banned/flagged members, whatever their stored counts", async () => {
    await db.exec("update public.telegram_users set status = 'FLAGGED' where telegram_user_id = 302");
    await applyBackfill(db, deps);
    expect(await count(db, "characters", "telegram_user_id in (302, 304)")).toBe(0);
    expect(await count(db, "characters", "telegram_user_id in (301, 305)")).toBe(2);
  });

  describe("a bot-like display name on an eligible member", () => {
    beforeEach(async () => {
      await db.exec("update public.telegram_users set display_name = 'Helper Bot' where telegram_user_id = 305");
    });

    it("is listed as ambiguous in the dry run (kept, not removed) and is not previewed as a hero", async () => {
      const p = await plan();
      expect(p.ambiguous.botLike).toEqual([expect.objectContaining({ userId: 305, eligible: true, hasHero: false })]);
      expect(p.totals.blockedBotLike).toBe(1);
      expect(p.members.find((m) => m.userId === 305)?.blocked).toBe("BOT_LIKE_NAME_UNCONFIRMED");
      expect(p.heroes.map((x) => x.userId).sort()).toEqual([301, 302]);
    });

    it("fails closed: --apply refuses (and writes nothing) until a person decides", async () => {
      const before = await fingerprint();
      await expect(applyBackfill(db, deps)).rejects.toThrow(/bot-like name.*--confirm-human-ids.*--exclude-ids/);
      expect(await fingerprint()).toBe(before);
      expect(await count(db, "characters")).toBe(1);
    });

    it("--confirm-human-ids lets the member through", async () => {
      const r = await applyBackfill(db, { ...deps, confirmedHumanIds: new Set([305]) });
      expect(r.heroesCreated).toBe(3);
      expect(await count(db, "characters", "telegram_user_id = 305")).toBe(1);
    });

    it("--exclude-ids keeps them hero-less without blocking everyone else", async () => {
      const r = await applyBackfill(db, { ...deps, excludeIds: new Set([305]) });
      expect(r.heroesCreated).toBe(2);
      expect(await count(db, "characters", "telegram_user_id = 305")).toBe(0);
      expect((await plan({ excludeIds: new Set([305]) })).totals.blockedOperator).toBe(1);
    });
  });

  it("operator exclusions are honoured for anyone, not just bot-like names", async () => {
    const r = await applyBackfill(db, { ...deps, excludeIds: new Set([302]) });
    expect(r.heroesCreated).toBe(2);
    expect(await count(db, "characters", "telegram_user_id = 302")).toBe(0);
  });

  it("--expect-new-heroes pins the run to the reviewed dry run", async () => {
    const before = await fingerprint();
    await expect(applyBackfill(db, deps, { expectNewHeroes: 70 })).rejects.toThrow(/3 hero\(es\) are due/);
    expect(await fingerprint()).toBe(before);
    expect(await count(db, "characters")).toBe(1);
  });

  describe("when stored scores no longer match a fresh evaluation", () => {
    it("reports the drift, refuses to apply silently, and --rescore repairs it without double counting", async () => {
      await db.exec("update public.telegram_messages set qualifies = false, reject_reason = 'TOO_SHORT', weight = 0 where telegram_user_id = 302 and message_id in (select message_id from public.telegram_messages where telegram_user_id = 302 order by message_id limit 10)");
      await db.exec("update public.telegram_users set qualifying_message_count = 49 where telegram_user_id = 301");
      const p = await plan();
      expect(p.totals.driftMembers).toBe(2);
      expect(p.totals.driftMessages).toBe(10);
      expect(p.members.find((m) => m.userId === 301)?.drift.counters).toContain("qualifying_message_count");
      expect(p.totals.eligibilitySetsMatch).toBe(false); // 301 looks ineligible by its stored counter but is eligible when re-scored

      await expect(applyBackfill(db, deps)).rejects.toThrow(/--rescore/);
      expect(await count(db, "characters")).toBe(1);

      const r = await applyBackfill(db, deps, { rescore: true });
      expect(r.rescoredMembers).toBe(2);
      expect(r.heroesCreated).toBe(3);
      const after = await plan();
      expect(after.totals.driftMembers).toBe(0);
      expect(after.totals.eligibilitySetsMatch).toBe(true);
      const [u301] = await db.query<{ qualifying_message_count: number; total_message_count: number }>("select qualifying_message_count, total_message_count from public.telegram_users where telegram_user_id = 301");
      expect(u301).toMatchObject({ qualifying_message_count: 130, total_message_count: 130 });
      expect(await count(db, "telegram_messages")).toBe(130 + 105 + 49 + 200 + 50 + 30 + 140); // no message added or removed
    });
  });

  it("refuses with a clear message when stored features are not readable objects", async () => {
    await db.exec("update public.telegram_messages set features = to_jsonb(features::text) where message_id = (select min(message_id) from public.telegram_messages)");
    await expect(buildBackfillPlan(db, deps)).rejects.toThrow(/db:repair-jsonb/);
  });

  it("without CLASS_ROLL_SECRET the dry run still reports counts but offers no class preview", async () => {
    const p = (await buildBackfillPlan(db, { ...deps, classRollSecret: null })).plan;
    expect(p.totals.eligible).toBe(4);
    expect(p.heroes).toEqual([]);
  });

  it("summarises stored state for the importer report and reads the earlier import expectation from the audit log", async () => {
    const s = await summarizeStored(db, CHAT, deps.settings.telegram.qualifyingThreshold);
    expect(s).toMatchObject({ members: 7, eligible: 4, eligibleWithoutHero: 3 }); // 301, 302, 305 are due (304 is banned, 307 has its hero)
    await db.query("insert into public.admin_audit_log (actor, action, entity_type, entity_id, detail) values ('cli', 'telegram.import.bulk', 'chat', $1, $2::jsonb)", [String(CHAT), JSON.stringify({ totals: { eligibleUsers: 4 } })]);
    await db.query("insert into public.admin_audit_log (actor, action, entity_type, entity_id, detail) values ('cli', 'telegram.import.bulk', 'chat', $1, $2::jsonb)", [String(CHAT), JSON.stringify({ totals: { eligibleUsers: 0 } })]);
    expect(await previousImportExpectation(db, CHAT)).toEqual({ runs: 2, expectedEligible: 4 }); // a later all-skipped run (0) must not erase the expectation
  });
});
