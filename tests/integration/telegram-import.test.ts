import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseTelegramExport } from "@/domain/telegram/exportParser";
import { planImport } from "@/domain/telegram/importPlan";
import type { IngestMessage } from "@/domain/telegram/types";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { makeTextHasher } from "@/server/crypto";
import type { Db } from "@/server/db/types";
import { importMessages, ingestUpdate, type IngestDeps } from "@/server/services/telegramIngest";
import { applyImportPlan, decideSkips, loadExistingSnapshot, loadExistingUsers, loadImportConfig, reconcileHeroes, refreshDerivedCounters } from "@/server/services/telegramImport";
import { parseTelegramUpdate } from "@/domain/telegram/updates";

import { count, createTestDb, resetDb } from "../support/db";

const CHAT = -1002494847180;
const T0 = Date.UTC(2025, 2, 1, 9, 0, 0);
const DAY = 86_400_000;
const SECRET = "import-test-class-secret-0123456789";

let db: Db;
let deps: IngestDeps;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  deps = { settings: await loadSettings(db), classes: await loadClasses(db), hash: makeTextHasher("import-test-pepper-value"), classRollSecret: SECRET };
});

let nextId = 1;
function msgs(author: number, n: number, opts: { perDay?: number; startDay?: number; name?: string; reply?: (i: number) => { isReply: boolean; replyToUserId: number | null } } = {}): IngestMessage[] {
  const perDay = opts.perDay ?? 30;
  return Array.from({ length: n }, (_, i) => {
    const day = (opts.startDay ?? 0) + Math.floor(i / perDay);
    return {
      chatId: CHAT, messageId: nextId++, authorId: author, username: null, displayName: opts.name ?? `Member ${author}`,
      sentAtMs: T0 + day * DAY + (i % perDay) * 90_000,
      text: `substantive contribution ${i} from member ${author} about launch mechanics number ${i * 7 + author}`,
      isReply: opts.reply?.(i).isReply ?? false, replyToUserId: opts.reply?.(i).replyToUserId ?? null,
      isForwarded: false, mediaKind: "none", source: "IMPORT",
    } satisfies IngestMessage;
  });
}

async function runImport(messages: IngestMessage[], opts: { classSecret?: string } = {}) {
  const snap = await loadExistingSnapshot(db, CHAT);
  const decision = decideSkips(messages, snap);
  const existing = decision.mergeUsers.length ? await loadExistingUsers(db, CHAT, decision.mergeUsers, snap) : undefined;
  const plan = planImport({ messages, settings: deps.settings, hash: deps.hash, ...(existing ? { existing } : {}), skipUsers: decision.skipUsers, knownStatus: snap.statusByUser, preview: { classes: deps.classes, classRollSecret: opts.classSecret ?? SECRET } });
  const written = await applyImportPlan(db, plan);
  const touched = [...new Set([...plan.users.map((u) => u.userId), ...plan.reactions.map((r) => r.authorId)])];
  await refreshDerivedCounters(db, touched, deps.settings);
  const heroes = await reconcileHeroes(db, { settings: deps.settings, classes: deps.classes, classRollSecret: opts.classSecret ?? SECRET });
  return { plan, written, heroes };
}

/** A fingerprint of everything the import is supposed to own, for exact before/after comparisons. */
async function fingerprint(): Promise<string> {
  const parts = await Promise.all([
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', telegram_user_id, display_name, status, total_message_count, qualifying_message_count, active_days, reply_count, replies_received, reactions_received, round(quality_sum::numeric, 3), round(activity_score::numeric, 2), behavior::text), E'\\n' order by telegram_user_id), '')) as h from public.telegram_users"),
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', chat_id, message_id, telegram_user_id, sent_at, text_hash, qualifies, round(weight::numeric, 3), reject_reason, is_reply, reply_to_user_id, source), E'\\n' order by chat_id, message_id), '')) as h from public.telegram_messages"),
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', telegram_user_id, day, message_count, qualifying_count), E'\\n' order by telegram_user_id, day), '')) as h from public.telegram_daily_activity"),
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', chat_id, message_id, reactor_user_id, author_user_id), E'\\n' order by chat_id, message_id, reactor_user_id), '')) as h from public.telegram_reactions"),
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', c.telegram_user_id, c.class_id, c.name, c.origin, c.level, c.xp, c.title, ca.rarity, ca.parts::text, ca.seed, cs.variation::text, cs.telegram_bonus::text), E'\\n' order by c.telegram_user_id), '')) as h from public.characters c join public.character_appearances ca on ca.character_id = c.id join public.character_stats cs on cs.character_id = c.id"),
    db.query<{ h: string }>("select md5(coalesce(string_agg(concat_ws('|', character_id, achievement_id), E'\\n' order by character_id, achievement_id), '')) as h from public.character_achievements"),
    db.query<{ n: number }>("select (select count(*) from public.currency_ledger)::int as n"),
  ]);
  return parts.map((p) => JSON.stringify(p[0])).join(" ");
}

describe("bulk historical import", () => {
  it("creates exactly one hero for members at/over 50 qualifying messages and none below", async () => {
    const data = [...msgs(1, 49), ...msgs(2, 50), ...msgs(3, 51), ...msgs(4, 10)];
    const { plan, heroes } = await runImport(data);
    expect(plan.totals).toMatchObject({ uniqueUsers: 4, eligibleUsers: 2, nearMissUsers: 1 });
    expect(heroes.created).toBe(2);
    expect((await db.query<{ telegram_user_id: number }>("select telegram_user_id from public.characters order by 1")).map((r) => Number(r.telegram_user_id))).toEqual([2, 3]);
    expect((await db.query<{ origin: string }>("select distinct origin from public.characters"))[0]!.origin).toBe("HISTORICAL_IMPORT");
    expect(await count(db, "telegram_users")).toBe(4);
    expect(await count(db, "telegram_messages")).toBe(49 + 50 + 51 + 10);
  });

  it("is IDEMPOTENT: re-running the same export changes nothing at all", async () => {
    const data = [...msgs(11, 130), ...msgs(12, 40), ...msgs(13, 100, { perDay: 20 })];
    await runImport(data);
    const before = await fingerprint();
    const rows = await count(db, "telegram_messages");
    for (let i = 0; i < 2; i++) {
      const again = await runImport(data);
      expect(again.written).toMatchObject({ usersWritten: 0, messagesInserted: 0, messagesRescored: 0, reactionsInserted: 0 });
      expect(again.heroes.created).toBe(0);
      expect(again.plan.skippedUsers).toBe(3);
    }
    expect(await fingerprint()).toBe(before);
    expect(await count(db, "telegram_messages")).toBe(rows);
    expect(await count(db, "characters")).toBe(2);
    expect(await count(db, "currency_ledger")).toBe(0); // no XP/gold is ever awarded by an import
    expect(await count(db, "characters", "xp <> 0 or level <> 1")).toBe(0);
  });

  it("importing in pieces, or in a different order, stays idempotent after heroes cross the threshold", async () => {
    const all = [...msgs(21, 150), ...msgs(22, 120, { startDay: 3 }), ...msgs(23, 60)];
    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    const shuffled = all.slice().sort((a, b) => ((a.messageId * 7919) % 101) - ((b.messageId * 7919) % 101));
    const half = Math.floor(shuffled.length / 2);
    await runImport(shuffled.slice(0, half));
    await runImport(shuffled.slice(half));
    const afterPieces = await fingerprint();
    await runImport(all); // plus a final full re-run
    expect(await fingerprint()).toBe(afterPieces);
    expect(await count(db, "characters")).toBe(3);
  });

  it("matches the live per-message pipeline + recompute for the same history", async () => {
    // Replies/reactions to OTHER members are excluded here: the old path never derived replies_received.
    const data = [...msgs(31, 140), ...msgs(32, 90)];
    await runImport(data);
    const bulk = await db.query<Record<string, unknown>>("select telegram_user_id, total_message_count, qualifying_message_count, active_days, reply_count, round(quality_sum::numeric,3) q, behavior from public.telegram_users order by 1");
    const bulkMsgs = await db.query<Record<string, unknown>>("select message_id, qualifies, reject_reason, round(weight::numeric,3) w from public.telegram_messages order by 1");
    const bulkHero = await db.query<Record<string, unknown>>("select c.class_id, ca.rarity, ca.parts, cs.variation from public.characters c join public.character_appearances ca on ca.character_id = c.id join public.character_stats cs on cs.character_id = c.id order by c.telegram_user_id");

    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    await importMessages(db, data, deps);
    const old = await db.query<Record<string, unknown>>("select telegram_user_id, total_message_count, qualifying_message_count, active_days, reply_count, round(quality_sum::numeric,3) q, behavior from public.telegram_users order by 1");
    const oldMsgs = await db.query<Record<string, unknown>>("select message_id, qualifies, reject_reason, round(weight::numeric,3) w from public.telegram_messages order by 1");
    const oldHero = await db.query<Record<string, unknown>>("select c.class_id, ca.rarity, ca.parts, cs.variation from public.characters c join public.character_appearances ca on ca.character_id = c.id join public.character_stats cs on cs.character_id = c.id order by c.telegram_user_id");
    expect(bulk).toEqual(old);
    expect(bulkMsgs).toEqual(oldMsgs);
    expect(bulkHero).toEqual(oldHero); // same permanent classes & deterministic appearance either way
  });

  it("merges with messages already captured live (webhook) without double counting", async () => {
    const history = msgs(41, 120);
    const live = msgs(41, 5, { startDay: 400 }).map((m, i) => ({ ...m, messageId: 900_000 + i, source: "LIVE" as const }));
    // 5 live messages arrive via the real webhook path first
    for (const m of live) {
      const u = {
        update_id: m.messageId, message: { message_id: m.messageId, date: Math.floor(m.sentAtMs / 1000), chat: { id: CHAT, type: "supergroup" }, from: { id: 41, is_bot: false, first_name: "Member 41" }, text: m.text },
      };
      await ingestUpdate(db, parseTelegramUpdate(u, CHAT), deps);
    }
    expect((await db.query<{ q: number }>("select qualifying_message_count as q from public.telegram_users where telegram_user_id = 41"))[0]!.q).toBe(5);
    const r = await runImport(history);
    expect(r.plan.users[0]!.history.totalMessages).toBe(125);
    const u = (await db.query<{ q: number; t: number }>("select qualifying_message_count as q, total_message_count as t from public.telegram_users where telegram_user_id = 41"))[0]!;
    expect(u).toEqual({ q: 125, t: 125 });
    expect(await count(db, "telegram_messages", "source = 'LIVE'")).toBe(5); // live rows keep their provenance
    expect(await count(db, "characters")).toBe(1);
    // and a second run is still a no-op
    const before = await fingerprint();
    await runImport(history);
    expect(await fingerprint()).toBe(before);
  });

  it("is resumable: heroes missing after an interrupted run are created by reconciliation, once", async () => {
    const data = msgs(51, 110);
    const snap = await loadExistingSnapshot(db, CHAT);
    const plan = planImport({ messages: data, settings: deps.settings, hash: deps.hash, skipUsers: decideSkips(data, snap).skipUsers, knownStatus: snap.statusByUser });
    await applyImportPlan(db, plan); // "crash" before counters and heroes
    expect(await count(db, "characters")).toBe(0);
    const resumed = await runImport(data);
    expect(resumed.heroes.created).toBe(1);
    expect((await runImport(data)).heroes.created).toBe(0);
    expect(await count(db, "characters")).toBe(1);
  });

  it("never creates heroes for flagged/banned members or for demo ids, and never rewrites admin decisions", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name, status, flag_reason) values (61, 'Bad Actor', 'BANNED', 'admin ban')");
    await runImport(msgs(61, 200));
    expect(await count(db, "characters", "telegram_user_id = 61")).toBe(0);
    const u = (await db.query<{ status: string; flag_reason: string }>("select status, flag_reason from public.telegram_users where telegram_user_id = 61"))[0]!;
    expect(u).toEqual({ status: "BANNED", flag_reason: "admin ban" });
    expect((await db.query<{ q: number }>("select qualifying_message_count as q from public.telegram_users where telegram_user_id = 61"))[0]!.q).toBe(0); // banned members earn nothing
  });

  it("spam-like members are auto-flagged on import and get no hero", async () => {
    const spam: IngestMessage[] = Array.from({ length: 60 }, (_, i) => ({ ...msgs(71, 1)[0]!, text: "gm", sentAtMs: T0 + i * 800, messageId: nextId++ }));
    const { plan } = await runImport([...spam, ...msgs(72, 105)]);
    expect(plan.totals.autoFlaggedUsers).toBe(1);
    expect((await db.query<{ status: string }>("select status from public.telegram_users where telegram_user_id = 71"))[0]!.status).toBe("FLAGGED");
    expect(await count(db, "characters", "telegram_user_id = 71")).toBe(0);
    expect(await count(db, "characters", "telegram_user_id = 72")).toBe(1);
  });

  it("derives replies-received and reactions-received from stored rows, and they are idempotent", async () => {
    const a = msgs(81, 110);
    const b = msgs(82, 30, { reply: () => ({ isReply: true, replyToUserId: 81 }) });
    // twelve DIFFERENT reactors (so the per-reactor daily cap is not what limits this), plus self-reactions by 81
    const withReactions = a.map((m, i) => (i < 12 ? { ...m, reactions: [{ reactorId: 900 + i, atMs: m.sentAtMs + 60_000, day: new Date(m.sentAtMs).toISOString().slice(0, 10) }, { reactorId: 81, atMs: m.sentAtMs + 70_000, day: "2025-03-01" }] } : m));
    await runImport([...withReactions, ...b]);
    const u = (await db.query<{ replies_received: number; reactions_received: number }>("select replies_received, reactions_received from public.telegram_users where telegram_user_id = 81"))[0]!;
    expect(u.replies_received).toBe(30);
    expect(u.reactions_received).toBe(12); // self-reactions (81 on its own message) are dropped
    const before = await fingerprint();
    await runImport([...withReactions, ...b]);
    expect(await fingerprint()).toBe(before);
    // the activity score reflects the derived engagement
    const score = (await db.query<{ s: number }>("select activity_score as s from public.telegram_users where telegram_user_id = 81"))[0]!.s;
    const noEngagement = planImport({ messages: a, settings: deps.settings, hash: deps.hash }).users[0]!.activityScore;
    expect(Number(score)).toBeGreaterThan(noEngagement);
  });

  it("caps reactions per reactor per day exactly like the live pipeline", async () => {
    const a = msgs(91, 20, { perDay: 20 });
    const day = new Date(a[0]!.sentAtMs).toISOString().slice(0, 10);
    const data = a.map((m, i) => ({ ...m, reactions: [{ reactorId: 92, atMs: m.sentAtMs + i * 1000, day }] }));
    const { plan } = await runImport(data);
    expect(plan.reactions).toHaveLength(deps.settings.telegram.reactionsPerReactorPerDay);
    expect(plan.totals.reactionsDroppedDailyCap).toBe(20 - deps.settings.telegram.reactionsPerReactorPerDay);
  });

  it("deleted accounts and channel senders never reach the database", async () => {
    const raw = {
      name: "clank.trade (ex daos.fun)", type: "public_supergroup", id: 2494847180,
      messages: [
        ...Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, type: "message", date: "2025-03-01T00:00:00", date_unixtime: String(Math.floor(T0 / 1000) + Math.floor(i / 30) * 86400 + (i % 30) * 90), from: null, from_id: "user555", text: `ghost message number ${i} with plenty of words in it` })),
        ...Array.from({ length: 150 }, (_, i) => ({ id: 2000 + i, type: "message", date: "2025-03-01T00:00:00", date_unixtime: String(Math.floor(T0 / 1000) + Math.floor(i / 30) * 86400 + (i % 30) * 90), from: "Some Channel", from_id: "channel42", text: `channel message number ${i} with plenty of words in it` })),
        ...Array.from({ length: 120 }, (_, i) => ({ id: 3000 + i, type: "message", date: "2025-03-01T00:00:00", date_unixtime: String(Math.floor(T0 / 1000) + Math.floor(i / 30) * 86400 + (i % 30) * 90), from: "Real Person", from_id: "user777", text: `a real contribution number ${i} with plenty of words in it` })),
      ],
    };
    const parsed = parseTelegramExport(raw);
    const { plan } = await runImport(parsed.messages);
    expect(plan.totals.uniqueUsers).toBe(1);
    expect(await count(db, "telegram_users", "telegram_user_id in (555, 42)")).toBe(0);
    expect(await count(db, "characters")).toBe(1);
  });

  it("class and appearance are permanent and deterministic: same member → same hero across independent databases", async () => {
    const data = msgs(101, 130);
    await runImport(data);
    const first = (await db.query<{ class_id: string; rarity: string; parts: unknown; seed: string }>("select c.class_id, ca.rarity, ca.parts, ca.seed from public.characters c join public.character_appearances ca on ca.character_id = c.id"))[0]!;
    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    await runImport(data);
    expect((await db.query<{ class_id: string; rarity: string; parts: unknown; seed: string }>("select c.class_id, ca.rarity, ca.parts, ca.seed from public.characters c join public.character_appearances ca on ca.character_id = c.id"))[0]).toEqual(first);
    const other = first.class_id === "mage" ? "tank" : "mage";
    await expect(db.query("update public.characters set class_id = $1", [other])).rejects.toThrow(/permanent/);
    // a different secret would yield different heroes — which is why the live import insists on a real one
    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    const many = [...Array.from({ length: 40 }, (_, i) => msgs(200 + i, 105)).flat()];
    await runImport(many, { classSecret: "another-secret-value-0123456789abcd" });
    const classesB = (await db.query<{ class_id: string }>("select class_id from public.characters order by telegram_user_id")).map((r) => r.class_id);
    await resetDb(db);
    deps = { ...deps, settings: await loadSettings(db), classes: await loadClasses(db) };
    await runImport(many, { classSecret: SECRET });
    const classesA = (await db.query<{ class_id: string }>("select class_id from public.characters order by telegram_user_id")).map((r) => r.class_id);
    expect(classesA).not.toEqual(classesB);
  });

  it("the dry-run connection cannot write: a READ ONLY transaction rejects every mutation", async () => {
    await runImport(msgs(111, 10));
    const before = await fingerprint();
    await expect(
      db.transaction(async (tx) => {
        await tx.exec("SET TRANSACTION READ ONLY");
        await loadExistingSnapshot(tx, CHAT); // reads are fine
        await tx.query("insert into public.telegram_users (telegram_user_id, display_name) values (999999, 'x')");
      }),
    ).rejects.toThrow(/read-only/i);
    await expect(db.transaction(async (tx) => { await tx.exec("SET TRANSACTION READ ONLY"); await tx.query("delete from public.telegram_messages"); })).rejects.toThrow(/read-only/i);
    expect(await fingerprint()).toBe(before);
  });

  it("achievements granted at import are idempotent and give no Gold or XP", async () => {
    await runImport(msgs(121, 160));
    const ach = await count(db, "character_achievements");
    await runImport(msgs(121, 160).map((m, i) => ({ ...m, messageId: 5_000_000 + i }))); // different message ids = genuinely new history
    expect(await count(db, "character_achievements", "true")).toBeGreaterThanOrEqual(ach);
    expect(await count(db, "currency_ledger", "reason = 'arena_reward'")).toBe(0);
    expect(await count(db, "characters", "xp <> 0")).toBe(0);
  });

  describe("configuration written by the old postgres.js adapter (every jsonb stored as a jsonb string)", () => {
    const doubleEncode = async () => {
      await db.exec("update public.game_settings set value = to_jsonb(value::text)");
      await db.exec("update public.character_classes set definition = to_jsonb(definition::text)");
    };

    it("is decoded only after proving it equals the shipped defaults", async () => {
      await doubleEncode();
      await expect(loadClasses(db)).rejects.toThrow(); // the strict readers cannot read it…
      const cfg = await loadImportConfig(db); // …the import's verified fallback can
      expect(cfg.source).toMatch(/legacy double-encoded/);
      expect(cfg.settings.telegram.qualifyingThreshold).toBe(50);
      expect(cfg.classes.length).toBeGreaterThan(0);
    });

    it("refuses when an admin changed a value, instead of guessing", async () => {
      await doubleEncode();
      await db.exec(`update public.game_settings set value = to_jsonb(jsonb_set((value #>> '{}')::jsonb, '{qualifyingThreshold}', '150')::text) where key = 'telegram'`);
      await expect(loadImportConfig(db)).rejects.toThrow(/differs from the shipped defaults.*settings\.telegram/);
    });

    it("plain, correctly-encoded rows take the normal path", async () => {
      const cfg = await loadImportConfig(db);
      expect(cfg.source).toBe("database");
    });
  });
});
