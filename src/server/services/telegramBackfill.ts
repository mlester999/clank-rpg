import type { ClassDef } from "@/domain/rules";
import type { GameSettings } from "@/domain/settings";
import { planBackfill, type BackfillPlan, type StoredMember } from "@/domain/telegram/backfillPlan";
import { scoreUserHistory } from "@/domain/telegram/history";
import type { BehaviorCounters, MessageFeatures, UserStatus } from "@/domain/telegram/types";
import { json, type Db, type Queryable } from "../db/types";

import { reconcileHeroes, refreshDerivedCounters, type ApplyProgress } from "./telegramImport";

/**
 * Hero backfill for Telegram history that is ALREADY in the database.
 *
 * Reads the stored rows (never the export file), re-scores them with the same pure pipeline, and — only when
 * asked — creates the heroes that are due. It never inserts, duplicates or deletes a message, reaction or member,
 * and it can be run any number of times: a hero is keyed by the immutable Telegram id (unique constraint) and a
 * member who already has one is skipped.
 */

interface MemberRow {
  telegram_user_id: number;
  username: string | null;
  display_name: string;
  status: UserStatus;
  flag_reason: string | null;
  total_message_count: number;
  qualifying_message_count: number;
  active_days: number;
  reply_count: number;
  replies_received: number;
  reactions_received: number;
  quality_sum: number;
  activity_score: number;
  behavior: Partial<BehaviorCounters>;
}

interface MessageRow {
  telegram_user_id: number;
  message_id: number;
  features: MessageFeatures;
  qualifies: boolean;
  weight: number;
  reject_reason: string | null;
  reply_to_user_id: number | null;
}

/** Loads every official-chat member with their stored messages, daily rows, reaction count and hero. READ ONLY. */
export async function loadStoredMembers(q: Queryable, chatId: number, userIds?: readonly number[]): Promise<StoredMember[]> {
  if (userIds !== undefined && userIds.length === 0) return [];
  const userFilter = (column: string): string => userIds === undefined ? "" : ` and ${column} in (select (jsonb_array_elements_text($2::jsonb))::bigint)`;
  const scopedParams: readonly unknown[] = userIds === undefined ? [chatId] : [chatId, json(userIds)];
  const members = await q.query<MemberRow>(
    `select u.telegram_user_id, u.username, u.display_name, u.status, u.flag_reason, u.total_message_count, u.qualifying_message_count, u.active_days,
            u.reply_count, u.replies_received, u.reactions_received, u.quality_sum, u.activity_score, u.behavior
       from public.telegram_users u
      where not u.is_demo and exists (select 1 from public.telegram_messages m where m.chat_id = $1 and m.telegram_user_id = u.telegram_user_id)
        ${userFilter("u.telegram_user_id")}
      order by u.telegram_user_id`,
    scopedParams,
  );
  const messages = await q.query<MessageRow>(
    `select telegram_user_id, message_id, features, qualifies, weight, reject_reason, reply_to_user_id
       from public.telegram_messages where chat_id = $1 ${userFilter("telegram_user_id")} order by telegram_user_id, sent_at, message_id`,
    scopedParams,
  );
  const daily = await q.query<{ telegram_user_id: number; day: string; message_count: number; qualifying_count: number }>(
    `select telegram_user_id, day::text as day, message_count, qualifying_count from public.telegram_daily_activity ${userIds === undefined ? "" : "where telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)"}`,
    userIds === undefined ? [] : [json(userIds)],
  );
  const reactions = await q.query<{ author_user_id: number; n: number }>(
    `select author_user_id, count(*)::int as n from public.telegram_reactions where chat_id = $1 ${userFilter("author_user_id")} group by 1`,
    scopedParams,
  );
  const heroes = await q.query<{ telegram_user_id: number; id: string; class_id: string }>(
    `select telegram_user_id, id, class_id from public.characters where telegram_user_id is not null ${userIds === undefined ? "" : "and telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)"}`,
    userIds === undefined ? [] : [json(userIds)],
  );

  const msgByUser = new Map<number, MessageRow[]>();
  for (const m of messages) {
    if (typeof m.features !== "object" || m.features === null || typeof m.features.sentAtMs !== "number") {
      throw new Error(`Stored features of message ${m.message_id} are unreadable (not a jsonb object) — run pnpm db:repair-jsonb first.`);
    }
    const list = msgByUser.get(Number(m.telegram_user_id));
    if (list) list.push(m);
    else msgByUser.set(Number(m.telegram_user_id), [m]);
  }
  const dailyByUser = new Map<number, Map<string, { messages: number; qualifying: number }>>();
  for (const d of daily) {
    const id = Number(d.telegram_user_id);
    const map = dailyByUser.get(id) ?? new Map();
    map.set(d.day, { messages: Number(d.message_count), qualifying: Number(d.qualifying_count) });
    dailyByUser.set(id, map);
  }
  const reactionRows = new Map(reactions.map((r) => [Number(r.author_user_id), Number(r.n)]));
  const heroByUser = new Map(heroes.map((h) => [Number(h.telegram_user_id), { id: h.id, classId: h.class_id }]));

  return members.map((u) => {
    const id = Number(u.telegram_user_id);
    return {
      userId: id,
      displayName: u.display_name,
      username: u.username,
      status: u.status,
      flagReason: u.flag_reason,
      counters: {
        total: Number(u.total_message_count), qualifying: Number(u.qualifying_message_count), activeDays: Number(u.active_days), replyCount: Number(u.reply_count),
        repliesReceived: Number(u.replies_received), reactionsReceived: Number(u.reactions_received), qualitySum: Number(u.quality_sum), activityScore: Number(u.activity_score),
      },
      behavior: u.behavior,
      messages: (msgByUser.get(id) ?? []).map((m) => ({
        messageId: Number(m.message_id), features: m.features, qualifies: m.qualifies, weight: Number(m.weight), reason: m.reject_reason,
        replyToUserId: m.reply_to_user_id === null ? null : Number(m.reply_to_user_id),
      })),
      daily: dailyByUser.get(id) ?? new Map(),
      reactionRows: reactionRows.get(id) ?? 0,
      hero: heroByUser.get(id) ?? null,
    };
  });
}

async function loadStoredMemberShells(q: Queryable, chatId: number, userIds: readonly number[]): Promise<StoredMember[]> {
  if (userIds.length === 0) return [];
  const userFilter = (column: string) => " and " + column + " in (select (jsonb_array_elements_text($2::jsonb))::bigint)";
  const params = [chatId, json(userIds)];
  const members = await q.query<MemberRow>(
    "select u.telegram_user_id, u.username, u.display_name, u.status, u.flag_reason, u.total_message_count, u.qualifying_message_count, u.active_days, " +
      "u.reply_count, u.replies_received, u.reactions_received, u.quality_sum, u.activity_score, u.behavior " +
      "from public.telegram_users u where not u.is_demo and exists " +
      "(select 1 from public.telegram_messages m where m.chat_id = $1 and m.telegram_user_id = u.telegram_user_id) " +
      userFilter("u.telegram_user_id") + " order by u.telegram_user_id",
    params,
  );
  const daily = await q.query<{ telegram_user_id: number; day: string; message_count: number; qualifying_count: number }>(
    "select telegram_user_id, day::text as day, message_count, qualifying_count from public.telegram_daily_activity " +
      "where telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)", [json(userIds)],
  );
  const reactions = await q.query<{ author_user_id: number; n: number }>(
    "select author_user_id, count(*)::int as n from public.telegram_reactions where chat_id = $1 " + userFilter("author_user_id") + " group by 1",
    params,
  );
  const heroes = await q.query<{ telegram_user_id: number; id: string; class_id: string }>(
    "select telegram_user_id, id, class_id from public.characters where telegram_user_id is not null " +
      "and telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)", [json(userIds)],
  );

  const dailyByUser = new Map<number, Map<string, { messages: number; qualifying: number }>>();
  for (const row of daily) {
    const id = Number(row.telegram_user_id);
    const activity = dailyByUser.get(id) ?? new Map();
    activity.set(row.day, { messages: Number(row.message_count), qualifying: Number(row.qualifying_count) });
    dailyByUser.set(id, activity);
  }
  const reactionRows = new Map(reactions.map((row) => [Number(row.author_user_id), Number(row.n)]));
  const heroByUser = new Map(heroes.map((hero) => [Number(hero.telegram_user_id), { id: hero.id, classId: hero.class_id }]));
  return members.map((row): StoredMember => {
    const id = Number(row.telegram_user_id);
    return {
      userId: id, displayName: row.display_name, username: row.username, status: row.status, flagReason: row.flag_reason,
      counters: {
        total: Number(row.total_message_count), qualifying: Number(row.qualifying_message_count), activeDays: Number(row.active_days), replyCount: Number(row.reply_count),
        repliesReceived: Number(row.replies_received), reactionsReceived: Number(row.reactions_received), qualitySum: Number(row.quality_sum), activityScore: Number(row.activity_score),
      },
      behavior: row.behavior, messages: [], daily: dailyByUser.get(id) ?? new Map(), reactionRows: reactionRows.get(id) ?? 0, hero: heroByUser.get(id) ?? null,
    };
  });
}

export interface StoredMemberBatchProgress {
  done: number;
  total: number;
  batch: number;
  durationMs: number;
}

export interface StoredMemberReadProgress {
  batch: number;
  page: number;
  rows: number;
  durationMs: number;
}

export interface StoredMembersBatchedOptions {
  batchSize?: number;
  messagePageSize?: number;
  onBatch?: (progress: StoredMemberBatchProgress) => void;
  onRead?: (progress: StoredMemberReadProgress) => void;
  reconnectBeforeBatches?: () => Promise<void>;
  reconnect?: () => Promise<void>;
}

/**
 * Reads stored history through short, Postgres-enforced read-only transactions.
 * Each member and their messages are loaded together, while all scoring and planning happens locally after the reads.
 */
export async function loadStoredMembersBatched(
  db: Db,
  chatId: number,
  options: StoredMembersBatchedOptions = {},
): Promise<StoredMember[]> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error("batchSize must be an integer from 1 through 500.");
  const messagePageSize = options.messagePageSize ?? 1_000;
  if (!Number.isInteger(messagePageSize) || messagePageSize < 1 || messagePageSize > 10_000) throw new Error("messagePageSize must be an integer from 1 through 10,000.");

  const readSnapshot = () => db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return tx.query<Record<string, unknown>>(
      `select u.telegram_user_id, u.username, u.display_name, u.status, u.flag_reason,
              coalesce((select jsonb_agg(jsonb_build_array(c.id, c.class_id) order by c.id)
                          from public.characters c where c.telegram_user_id = u.telegram_user_id), '[]'::jsonb) as heroes,
              u.total_message_count, u.qualifying_message_count, u.active_days, u.reply_count, u.replies_received,
              u.reactions_received, u.quality_sum, u.activity_score, u.behavior
         from public.telegram_users u
        where not u.is_demo and exists (select 1 from public.telegram_messages m where m.chat_id = $1 and m.telegram_user_id = u.telegram_user_id)
        order by u.telegram_user_id`,
      [chatId],
    );
  });
  const beforeSnapshot = await readSnapshot();
  const ids = beforeSnapshot.map((r) => Number(r.telegram_user_id));
  if (new Set(ids).size !== ids.length) throw new Error("Live member snapshot contains duplicate Telegram identities; refuse to rescore an ambiguous history set.");
  await options.reconnectBeforeBatches?.();

  const stored: StoredMember[] = [];
  for (let offset = 0, batch = 1; offset < ids.length; offset += batchSize, batch++) {
    const userIds = ids.slice(offset, offset + batchSize);
    const startedAt = performance.now();
    const metadataStartedAt = performance.now();
    const members = await db.transaction(async (tx) => {
      await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return loadStoredMemberShells(tx, chatId, userIds);
    });
    if (members.length !== userIds.length) {
      throw new Error(`Telegram membership changed while reading batch ${batch}; rerun the read-only preview to get a coherent result.`);
    }
    options.onRead?.({ batch, page: 0, rows: members.length, durationMs: performance.now() - metadataStartedAt });

    // Page on immutable chat message ids. The history scorer's order is instead
    // feature timestamp + message id, so sort locally once all pages are reassembled.
    const membersById = new Map(members.map((member) => [member.userId, member]));
    let cursor: number | null = null;
    for (let page = 1; ; page++) {
      const pageStartedAt = performance.now();
      const messages = await db.transaction(async (tx) => {
        await tx.exec("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
        return tx.query<MessageRow>(
          "select telegram_user_id, message_id, features, qualifies, weight, reject_reason, reply_to_user_id " +
            "from public.telegram_messages where chat_id = $1 " +
            "and telegram_user_id in (select (jsonb_array_elements_text($2::jsonb))::bigint) " +
            "and ($3::bigint is null or message_id > $3::bigint) " +
            "order by message_id limit $4",
          [chatId, json(userIds), cursor, messagePageSize],
        );
      });
      for (const message of messages) {
        if (typeof message.features !== "object" || message.features === null || typeof message.features.sentAtMs !== "number") {
          throw new Error(`Stored features of message ${message.message_id} are unreadable (not a jsonb object) — run pnpm db:repair-jsonb first.`);
        }
        const member = membersById.get(Number(message.telegram_user_id));
        if (!member) throw new Error(`Telegram membership changed while reading message page ${page} of batch ${batch}; rerun the read-only preview.`);
        member.messages.push({
          messageId: Number(message.message_id), features: message.features, qualifies: message.qualifies, weight: Number(message.weight),
          reason: message.reject_reason, replyToUserId: message.reply_to_user_id === null ? null : Number(message.reply_to_user_id),
        });
      }
      options.onRead?.({ batch, page, rows: messages.length, durationMs: performance.now() - pageStartedAt });
      if (messages.length < messagePageSize) break;
      const last = messages.at(-1)!;
      cursor = Number(last.message_id);
    }
    if (members.some((member) => member.messages.length === 0)) {
      throw new Error(`Telegram history changed while reading batch ${batch}; at least one member lost its source messages.`);
    }
    for (const member of members) {
      member.messages.sort((a, b) => a.features.sentAtMs - b.features.sentAtMs || a.messageId - b.messageId);
    }
    stored.push(...members);
    options.onBatch?.({ done: stored.length, total: ids.length, batch, durationMs: performance.now() - startedAt });
    await options.reconnect?.();
  }
  const afterSnapshot = await readSnapshot();
  if (JSON.stringify(afterSnapshot) !== JSON.stringify(beforeSnapshot)) {
    throw new Error("Telegram membership, identity, status or counters changed while the batched history was being read; rerun the read-only preview for a coherent result.");
  }
  return stored;
}

/** What earlier bulk imports of this chat recorded as their plan — the "previously expected" number of heroes. */
export async function previousImportExpectation(q: Queryable, chatId: number): Promise<{ runs: number; expectedEligible: number | null }> {
  const rows = await q.query<{ eligible: string | null }>(
    `select detail->'totals'->>'eligibleUsers' as eligible from public.admin_audit_log
      where action = 'telegram.import.bulk' and entity_type = 'chat' and entity_id = $1 order by id`,
    [String(chatId)],
  );
  const values = rows.map((r) => (r.eligible === null ? null : Number(r.eligible))).filter((n): n is number => n !== null && n > 0);
  return { runs: rows.length, expectedEligible: values.length ? Math.max(...values) : null };
}

/** Cheap summary of what the database already holds for a chat (used by the importer's dry run). */
export async function summarizeStored(q: Queryable, chatId: number, threshold: number) {
  const [m] = await q.query<{ messages: number; qualifying: number; members: number }>(
    "select count(*)::int as messages, count(*) filter (where qualifies)::int as qualifying, count(distinct telegram_user_id)::int as members from public.telegram_messages where chat_id = $1",
    [chatId],
  );
  const [e] = await q.query<{ eligible: number; without_hero: number }>(
    `select count(*)::int as eligible, count(*) filter (where not exists (select 1 from public.characters c where c.telegram_user_id = u.telegram_user_id))::int as without_hero
       from public.telegram_users u where u.status = 'OK' and not u.is_demo and u.qualifying_message_count >= $1`,
    [threshold],
  );
  return { messages: Number(m?.messages ?? 0), qualifying: Number(m?.qualifying ?? 0), members: Number(m?.members ?? 0), eligible: Number(e?.eligible ?? 0), eligibleWithoutHero: Number(e?.without_hero ?? 0) };
}

export interface BackfillDeps {
  chatId: number;
  settings: GameSettings;
  classes: ClassDef[];
  /** Null = no class preview possible (dry run only). */
  classRollSecret: string | null;
  excludeIds?: ReadonlySet<number>;
  confirmedHumanIds?: ReadonlySet<number>;
}

export async function buildBackfillPlan(q: Queryable, deps: BackfillDeps): Promise<{ plan: BackfillPlan; stored: StoredMember[] }> {
  const stored = await loadStoredMembers(q, deps.chatId);
  const plan = planBackfill({
    members: stored,
    settings: deps.settings,
    ...(deps.excludeIds ? { excludeIds: deps.excludeIds } : {}),
    ...(deps.confirmedHumanIds ? { confirmedHumanIds: deps.confirmedHumanIds } : {}),
    ...(deps.classRollSecret ? { preview: { classes: deps.classes, classRollSecret: deps.classRollSecret } } : {}),
  });
  return { plan, stored };
}

/** Batched read-only counterpart for long production histories; planBackfill runs after all reads finish. */
export async function buildBackfillPlanBatched(
  db: Db,
  deps: BackfillDeps,
  options: StoredMembersBatchedOptions = {},
): Promise<{ plan: BackfillPlan; stored: StoredMember[] }> {
  const stored = await loadStoredMembersBatched(db, deps.chatId, options);
  const plan = planBackfill({
    members: stored,
    settings: deps.settings,
    ...(deps.excludeIds ? { excludeIds: deps.excludeIds } : {}),
    ...(deps.confirmedHumanIds ? { confirmedHumanIds: deps.confirmedHumanIds } : {}),
    ...(deps.classRollSecret ? { preview: { classes: deps.classes, classRollSecret: deps.classRollSecret } } : {}),
  });
  return { plan, stored };
}

export interface BackfillApplyOptions {
  /** Persist re-evaluated scores/counters for members whose stored values differ (otherwise drift refuses the run). */
  rescore?: boolean;
  /** Refuse unless exactly this many heroes are due — pins the run to the dry run the operator reviewed. */
  expectNewHeroes?: number;
  onProgress?: (p: ApplyProgress) => void;
}

export interface BackfillResult {
  rescoredMembers: number;
  heroesCreated: number;
  heroIds: string[];
  after: BackfillPlan;
}

/** Writes. Order: guards → (optional) re-score → heroes → re-plan to prove nothing is left to do. */
export async function applyBackfill(db: Db, deps: BackfillDeps & { classRollSecret: string }, opts: BackfillApplyOptions = {}): Promise<BackfillResult> {
  const progress = opts.onProgress ?? (() => undefined);
  const { plan, stored } = await buildBackfillPlan(db, deps);

  const bot = plan.members.filter((m) => m.blocked === "BOT_LIKE_NAME_UNCONFIRMED");
  if (bot.length) {
    throw new Error(`Refusing: ${bot.length} eligible member(s) have a bot-like name and are neither confirmed as human nor excluded: ${bot.map((m) => `${m.userId} "${m.displayName}"`).join(", ")}. Re-run with --confirm-human-ids <ids> or --exclude-ids <ids>.`);
  }
  const drifted = plan.members.filter((m) => m.status === "OK" && m.hasDrift);
  if (drifted.length && !opts.rescore) {
    throw new Error(`Refusing: stored scores/counters of ${drifted.length} member(s) differ from a fresh evaluation (first: ${drifted[0]?.userId} ${drifted[0]?.drift.counters.join(",") || `${drifted[0]?.drift.messages} message(s)`}). Review the dry run, then re-run with --rescore.`);
  }
  if (!plan.totals.eligibilitySetsMatch && !opts.rescore) {
    throw new Error("Refusing: the eligible set from stored counters differs from the freshly evaluated one. Review the dry run, then re-run with --rescore.");
  }
  if (opts.expectNewHeroes !== undefined && plan.totals.wouldCreate !== opts.expectNewHeroes) {
    throw new Error(`Refusing: ${plan.totals.wouldCreate} hero(es) are due, but --expect-new-heroes ${opts.expectNewHeroes} was given. Re-run the dry run and use its number.`);
  }

  // 1) optionally persist the re-evaluation (status-OK members only; an admin's decision on others is never touched)
  let rescored = 0;
  if (drifted.length) {
    const byId = new Map(stored.map((s) => [s.userId, s]));
    const touched = new Set<number>();
    for (const d of drifted) {
      const sm = byId.get(d.userId) as StoredMember;
      const h = scoreUserHistory(sm.messages.map((m) => m.features), "OK", deps.settings.telegram);
      await db.transaction(async (tx) => {
        const changed = sm.messages
          .map((m, i) => ({ id: m.messageId, s: h.scored[i], m }))
          .filter((x) => x.s && (x.s.qualifies !== x.m.qualifies || (x.s.reason ?? null) !== (x.m.reason ?? null) || Math.fround(x.s.weight) !== Math.fround(x.m.weight)));
        if (changed.length) {
          await tx.query(
            `update public.telegram_messages m set qualifies = x.q, weight = x.w, reject_reason = x.r
               from jsonb_to_recordset($1::jsonb) as x(id bigint, q boolean, w real, r text)
              where m.chat_id = $2 and m.message_id = x.id`,
            [json(changed.map((x) => ({ id: x.id, q: x.s?.qualifies, w: x.s?.weight, r: x.s?.reason ?? null }))), deps.chatId],
          );
        }
        await tx.query("delete from public.telegram_daily_activity where telegram_user_id = $1", [d.userId]);
        if (h.daily.size) {
          await tx.query(
            `insert into public.telegram_daily_activity (telegram_user_id, day, message_count, qualifying_count)
             select $1, (x.day)::date, x.m, x.q from jsonb_to_recordset($2::jsonb) as x(day text, m int, q int)`,
            [d.userId, json([...h.daily.entries()].map(([day, v]) => ({ day, m: v.messages, q: v.qualifying })))],
          );
        }
        await tx.query(
          `update public.telegram_users set total_message_count = $2, qualifying_message_count = $3, active_days = $4, reply_count = $5, quality_sum = $6, behavior = $7::jsonb where telegram_user_id = $1`,
          [d.userId, h.totalMessages, h.qualifyingMessages, h.activeDays, h.repliesSent, h.qualitySum, json(h.behavior)],
        );
      });
      touched.add(d.userId);
      for (const m of sm.messages) if (m.replyToUserId !== null) touched.add(m.replyToUserId);
      rescored += 1;
    }
    await refreshDerivedCounters(db, [...touched], deps.settings, progress);
  }

  // 2) heroes — everything blocked (operator exclusions) stays out; reconcileHeroes only ever creates, never changes
  const exclude = new Set(plan.members.filter((m) => m.blocked !== null).map((m) => m.userId));
  const heroes = await reconcileHeroes(db, { settings: deps.settings, classes: deps.classes, classRollSecret: deps.classRollSecret, exclude }, progress);

  // 3) prove the backfill is complete: re-plan from what is stored NOW
  const { plan: after } = await buildBackfillPlan(db, deps);
  return { rescoredMembers: rescored, heroesCreated: heroes.created, heroIds: heroes.ids, after };
}
