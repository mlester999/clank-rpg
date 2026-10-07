import { computeActivityScore } from "@/domain/telegram/activity";
import type { ExistingMessage, ExistingUser, ImportPlan, PlannedUser } from "@/domain/telegram/importPlan";
import type { IngestMessage, MessageFeatures, UserStatus } from "@/domain/telegram/types";
import type { ClassDef } from "@/domain/rules";
import { DEFAULT_CLASSES } from "@/domain/content";
import { DEFAULT_SETTINGS, parseSettings, settingsSchemas, type GameSettings, type SettingsKey } from "@/domain/settings";
import { isDeepStrictEqual } from "node:util";

import { loadClasses, loadSettings } from "../config/settingsRepo";
import { json, type Db, type Queryable } from "../db/types";

import { evaluateAchievements } from "./achievements";
import { createCharacterForUser, type TelegramUserRow } from "./characters";

/** What the database already knows about the chat being imported (used to skip / merge, never to guess). */
export interface ExistingSnapshot {
  /** Message ids already stored for this chat. */
  keys: Set<number>;
  storedPerUser: Map<number, number>;
  statusByUser: Map<number, UserStatus>;
}

export async function loadExistingSnapshot(q: Queryable, chatId: number): Promise<ExistingSnapshot> {
  const keys = new Set<number>();
  for (const r of await q.query<{ message_id: number }>("select message_id from public.telegram_messages where chat_id = $1", [chatId])) keys.add(Number(r.message_id));
  const storedPerUser = new Map<number, number>();
  for (const r of await q.query<{ telegram_user_id: number; n: number }>(
    "select telegram_user_id, count(*)::int as n from public.telegram_messages where chat_id = $1 group by 1",
    [chatId],
  )) {
    storedPerUser.set(Number(r.telegram_user_id), r.n);
  }
  const statusByUser = new Map<number, UserStatus>();
  for (const r of await q.query<{ telegram_user_id: number; status: UserStatus }>("select telegram_user_id, status from public.telegram_users where not is_demo")) {
    statusByUser.set(Number(r.telegram_user_id), r.status);
  }
  return { keys, storedPerUser, statusByUser };
}

/**
 * Decide, per member, whether the file adds anything. A member is SKIPPED when every message the file
 * has for them is already stored and nothing else is stored for them — so re-running an import is a
 * cheap no-op. Members with partial/other stored messages are loaded and merged chronologically.
 */
export function decideSkips(messages: readonly IngestMessage[], snap: ExistingSnapshot): { skipUsers: Set<number>; mergeUsers: number[] } {
  const perUser = new Map<number, Set<number>>();
  for (const m of messages) {
    const set = perUser.get(m.authorId) ?? new Set<number>();
    set.add(m.messageId);
    perUser.set(m.authorId, set);
  }
  const skipUsers = new Set<number>();
  const mergeUsers: number[] = [];
  for (const [uid, ids] of perUser) {
    const stored = snap.storedPerUser.get(uid) ?? 0;
    if (stored === 0) continue;
    let allPresent = true;
    for (const id of ids) {
      if (!snap.keys.has(id)) {
        allPresent = false;
        break;
      }
    }
    if (allPresent && stored === ids.size) skipUsers.add(uid);
    else mergeUsers.push(uid);
  }
  return { skipUsers, mergeUsers };
}

export async function loadExistingUsers(q: Queryable, chatId: number, userIds: readonly number[], snap: ExistingSnapshot): Promise<Map<number, ExistingUser>> {
  const out = new Map<number, ExistingUser>();
  for (let i = 0; i < userIds.length; i += 200) {
    const batch = userIds.slice(i, i + 200);
    const rows = await q.query<{ message_id: number; telegram_user_id: number; features: MessageFeatures; is_reply: boolean; reply_to_user_id: number | null }>(
      `select message_id, telegram_user_id, features, is_reply, reply_to_user_id from public.telegram_messages
        where chat_id = $1 and telegram_user_id in (select (jsonb_array_elements_text($2::jsonb))::bigint)`,
      [chatId, json(batch)],
    );
    for (const r of rows) {
      const uid = Number(r.telegram_user_id);
      const entry = out.get(uid) ?? { status: snap.statusByUser.get(uid) ?? "OK", messages: [] as ExistingMessage[] };
      entry.messages.push({ messageId: Number(r.message_id), features: r.features, isReply: r.is_reply, replyToUserId: r.reply_to_user_id === null ? null : Number(r.reply_to_user_id) });
      out.set(uid, entry);
    }
  }
  // Existing members with a non-default status keep it even if they have no stored messages yet.
  for (const uid of userIds) if (!out.has(uid)) out.set(uid, { status: snap.statusByUser.get(uid) ?? "OK", messages: [] });
  return out;
}

export interface ApplyProgress {
  phase: "messages" | "reactions" | "counters" | "heroes";
  done: number;
  total: number;
}

export interface ApplyResult {
  usersWritten: number;
  usersSkipped: number;
  messagesInserted: number;
  messagesRescored: number;
  reactionsInserted: number;
  countersRefreshed: number;
  heroes: { created: number; ids: string[] };
}

const USER_BATCH_MESSAGES = 2500;
const ROWS_PER_STATEMENT = 1000;

function messageRows(u: PlannedUser) {
  return u.messages.map((m) => ({
    chat: m.chatId, id: m.messageId, uid: u.userId, at: new Date(m.sentAtMs).toISOString(), day: m.day, hash: m.features.textHash,
    chars: m.features.charCount, words: m.features.wordCount, feat: m.features, reply: m.isReply, rto: m.replyToUserId,
    q: m.qualifies, w: m.weight, r: m.reason,
  }));
}

/**
 * Writes an import plan in bulk (a handful of set-based statements per ~2,500 messages instead of one
 * round-trip per message). Fully idempotent: messages are keyed by (chat_id, message_id), reactions by
 * (chat_id, message_id, reactor), members by telegram_user_id, heroes by telegram_user_id. Every batch
 * is its own transaction, so a crash leaves a consistent, resumable state.
 */
export async function applyImportPlan(
  db: Db,
  plan: ImportPlan,
  opts: { onProgress?: (p: ApplyProgress) => void } = {},
): Promise<Omit<ApplyResult, "heroes">> {
  const progress = opts.onProgress ?? (() => undefined);
  const result = { usersWritten: 0, usersSkipped: plan.skippedUsers, messagesInserted: 0, messagesRescored: 0, reactionsInserted: 0, countersRefreshed: 0 };

  // ---- phase 1: members + messages + daily activity, batched by message volume
  const totalMessages = plan.users.reduce((n, u) => n + u.messages.length, 0);
  let done = 0;
  let batch: PlannedUser[] = [];
  let batchSize = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const users = batch;
    await db.transaction(async (tx) => {
      await tx.query(
        `insert into public.telegram_users as t (telegram_user_id, display_name, first_message_at, last_message_at, last_seen_at, total_message_count,
                qualifying_message_count, active_days, reply_count, quality_sum, activity_score, behavior, status, flag_reason)
         select x.id, x.name, x.first_at, x.last_at, x.last_at, x.total, x.qual, x.days, x.replies, x.qsum, x.score, x.behavior, x.status, x.flag
           from jsonb_to_recordset($1::jsonb) as x(id bigint, name text, first_at timestamptz, last_at timestamptz, total int, qual int, days int, replies int, qsum real, score real, behavior jsonb, status text, flag text)
         on conflict (telegram_user_id) do update set
           display_name = case when excluded.display_name <> '' then excluded.display_name else t.display_name end,
           first_message_at = excluded.first_message_at, last_message_at = excluded.last_message_at,
           total_message_count = excluded.total_message_count, qualifying_message_count = excluded.qualifying_message_count,
           active_days = excluded.active_days, reply_count = excluded.reply_count, quality_sum = excluded.quality_sum,
           activity_score = excluded.activity_score, behavior = excluded.behavior,
           status = case when t.status = 'OK' and excluded.status = 'FLAGGED' then 'FLAGGED' else t.status end,
           flag_reason = case when t.status = 'OK' and excluded.status = 'FLAGGED' then excluded.flag_reason else t.flag_reason end`,
        [
          json(users.map((u) => ({
            id: u.userId, name: u.displayName, first_at: new Date(u.history.firstAtMs ?? 0).toISOString(), last_at: new Date(u.history.lastAtMs ?? 0).toISOString(),
            total: u.history.totalMessages, qual: u.history.qualifyingMessages, days: u.history.activeDays, replies: u.history.repliesSent, qsum: u.history.qualitySum,
            score: u.activityScore, behavior: u.history.behavior, status: u.status, flag: u.autoFlagged ? "AUTO: spam-like message ratio (historical import)" : null,
          }))),
        ],
      );
      const rows = users.flatMap(messageRows);
      for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
        const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
        const inserted = await tx.query<{ id: number; inserted: boolean }>(
          `insert into public.telegram_messages as m (chat_id, message_id, telegram_user_id, sent_at, day, text_hash, char_count, word_count, features, is_reply, reply_to_user_id, source, qualifies, weight, reject_reason)
           select x.chat, x.id, x.uid, x.at, x.day, x.hash, x.chars, x.words, x.feat, x.reply, x.rto, 'IMPORT', x.q, x.w, x.r
             from jsonb_to_recordset($1::jsonb) as x(chat bigint, id bigint, uid bigint, at timestamptz, day date, hash text, chars int, words int, feat jsonb, reply boolean, rto bigint, q boolean, w real, r text)
           on conflict (chat_id, message_id) do update set qualifies = excluded.qualifies, weight = excluded.weight, reject_reason = excluded.reject_reason
             where (m.qualifies, m.weight, m.reject_reason) is distinct from (excluded.qualifies, excluded.weight, excluded.reject_reason)
           returning message_id as id, (xmax = 0) as inserted`,
          [json(chunk)],
        );
        for (const r of inserted) {
          if (r.inserted) result.messagesInserted++;
          else result.messagesRescored++;
        }
      }
      await tx.query("delete from public.telegram_daily_activity where telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)", [json(users.map((u) => u.userId))]);
      const daily = users.flatMap((u) => [...u.history.daily.entries()].map(([day, v]) => ({ uid: u.userId, day, m: v.messages, q: v.qualifying })));
      for (let i = 0; i < daily.length; i += 4000) {
        await tx.query(
          `insert into public.telegram_daily_activity (telegram_user_id, day, message_count, qualifying_count)
           select x.uid, x.day, x.m, x.q from jsonb_to_recordset($1::jsonb) as x(uid bigint, day date, m int, q int)`,
          [json(daily.slice(i, i + 4000))],
        );
      }
    });
    result.usersWritten += users.length;
    done += users.reduce((n, u) => n + u.messages.length, 0);
    progress({ phase: "messages", done, total: totalMessages });
    batch = [];
    batchSize = 0;
  };
  for (const u of plan.users) {
    batch.push(u);
    batchSize += u.messages.length;
    if (batchSize >= USER_BATCH_MESSAGES) await flush();
  }
  await flush();

  // ---- phase 2: reactions (identified reactors only)
  let reactionDone = 0;
  for (let i = 0; i < plan.reactions.length; i += 2000) {
    const chunk = plan.reactions.slice(i, i + 2000);
    const rows = await db.query<{ message_id: number }>(
      `insert into public.telegram_reactions (chat_id, message_id, reactor_user_id, author_user_id, created_at)
       select x.chat, x.id, x.reactor, x.author, x.at from jsonb_to_recordset($1::jsonb) as x(chat bigint, id bigint, reactor bigint, author bigint, at timestamptz)
       where exists (select 1 from public.telegram_messages m where m.chat_id = x.chat and m.message_id = x.id and m.telegram_user_id = x.author)
       on conflict do nothing returning message_id`,
      [json(chunk.map((r) => ({ chat: r.chatId, id: r.messageId, reactor: r.reactorId, author: r.authorId, at: new Date(r.atMs).toISOString() })))],
    );
    result.reactionsInserted += rows.length;
    reactionDone += chunk.length;
    progress({ phase: "reactions", done: reactionDone, total: plan.reactions.length });
  }
  return result;
}

/**
 * Derived counters + activity score, recomputed from stored rows (so they are correct no matter how
 * many times, or in how many pieces, data was imported). replies_received = qualifying replies by others;
 * reactions_received = stored reaction rows.
 */
export async function refreshDerivedCounters(db: Db, userIds: readonly number[], settings: GameSettings, progress: (p: ApplyProgress) => void = () => undefined): Promise<number> {
  let n = 0;
  for (let i = 0; i < userIds.length; i += 1500) {
    const ids = userIds.slice(i, i + 1500);
    await db.transaction(async (tx) => {
      await tx.query(
        `with ids as (select (jsonb_array_elements_text($1::jsonb))::bigint as id),
              r as (select reply_to_user_id as id, count(*)::int as n from public.telegram_messages
                     where qualifies and reply_to_user_id is not null and reply_to_user_id <> telegram_user_id
                       and reply_to_user_id in (select id from ids) group by 1),
              x as (select author_user_id as id, count(*)::int as n from public.telegram_reactions where author_user_id in (select id from ids) group by 1)
         update public.telegram_users u set replies_received = coalesce(r.n, 0), reactions_received = coalesce(x.n, 0)
           from ids left join r on r.id = ids.id left join x on x.id = ids.id
          where u.telegram_user_id = ids.id`,
        [json(ids)],
      );
      const rows = await tx.query<{ telegram_user_id: number; total_message_count: number; qualifying_message_count: number; active_days: number; reply_count: number; replies_received: number; reactions_received: number; quality_sum: number }>(
        `select telegram_user_id, total_message_count, qualifying_message_count, active_days, reply_count, replies_received, reactions_received, quality_sum
           from public.telegram_users where telegram_user_id in (select (jsonb_array_elements_text($1::jsonb))::bigint)`,
        [json(ids)],
      );
      const scores = rows.map((r) => ({
        id: Number(r.telegram_user_id),
        score: computeActivityScore(
          { totalMessages: r.total_message_count, qualifyingMessages: r.qualifying_message_count, activeDays: r.active_days, repliesSent: r.reply_count, repliesReceived: r.replies_received, reactionsReceived: r.reactions_received, qualitySum: Number(r.quality_sum) },
          settings.telegram,
        ),
      }));
      await tx.query(
        `update public.telegram_users u set activity_score = x.score from jsonb_to_recordset($1::jsonb) as x(id bigint, score real) where u.telegram_user_id = x.id`,
        [json(scores)],
      );
      n += scores.length;
    });
    progress({ phase: "counters", done: Math.min(i + 1500, userIds.length), total: userIds.length });
  }
  return n;
}

/**
 * Creates the hero for every member who qualifies and does not have one yet. Idempotent (unique
 * telegram_user_id) and independent of how the counters got there — so it also repairs a run that was
 * interrupted between "messages written" and "heroes created".
 */
export async function reconcileHeroes(
  db: Db,
  deps: { settings: GameSettings; classes: ClassDef[]; classRollSecret: string; /** Telegram ids that must never get a hero from this run. */ exclude?: ReadonlySet<number> },
  progress: (p: ApplyProgress) => void = () => undefined,
): Promise<{ created: number; ids: string[] }> {
  const allPending = await db.query<TelegramUserRow & { telegram_user_id: number }>(
    `select telegram_user_id, username, display_name, status, is_demo, activity_score, behavior
       from public.telegram_users tu
      where tu.status = 'OK' and not tu.is_demo and tu.qualifying_message_count >= $1
        and not exists (select 1 from public.characters c where c.telegram_user_id = tu.telegram_user_id)
      order by tu.telegram_user_id`,
    [deps.settings.telegram.qualifyingThreshold],
  );
  const pending = allPending.filter((u) => !deps.exclude?.has(Number(u.telegram_user_id)));
  const ids: string[] = [];
  for (const [i, user] of pending.entries()) {
    await db.transaction(async (tx) => {
      const r = await createCharacterForUser(tx, user, { settings: deps.settings, classes: deps.classes, secret: deps.classRollSecret, origin: "HISTORICAL_IMPORT" });
      if (r.created) {
        ids.push(r.characterId);
        await evaluateAchievements(tx, r.characterId);
      }
    });
    if ((i + 1) % 25 === 0 || i + 1 === pending.length) progress({ phase: "heroes", done: i + 1, total: pending.length });
  }
  return { created: ids.length, ids };
}

/** A jsonb value that was stored as a jsonb STRING holding JSON text (the postgres.js double-encoding bug). */
const decodeLegacy = (value: unknown): unknown => (typeof value === "string" ? (JSON.parse(value) as unknown) : value);

/**
 * Settings and classes for scoring/preview. Normally a plain load. A database seeded through the old postgres.js
 * adapter holds every reference row double-encoded; those rows are decoded here ONLY after proving they equal the
 * shipped defaults — i.e. nobody edited them — so the import can never score with settings that differ from what the
 * app itself will use. If a row differs, this throws and the operator must repair the rows first (pnpm db:repair-jsonb).
 */
export async function loadImportConfig(q: Queryable): Promise<{ settings: GameSettings; classes: ClassDef[]; source: string }> {
  try {
    return { settings: await loadSettings(q), classes: await loadClasses(q), source: "database" };
  } catch (strictError) {
    const keys = Object.keys(settingsSchemas) as SettingsKey[];
    const settingRows = await q.query<{ key: string; value: unknown }>("select key, value from public.game_settings");
    const classRows = await q.query<{ definition: unknown }>("select definition from public.character_classes where enabled order by sort_order, id");
    const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
    const edited: string[] = [];
    for (const row of settingRows) {
      if (!keys.includes(row.key as SettingsKey)) continue;
      const parsed = parseSettings(row.key as SettingsKey, decodeLegacy(row.value));
      settings[row.key] = parsed;
      if (!isDeepStrictEqual(parsed, DEFAULT_SETTINGS[row.key as SettingsKey])) edited.push(`settings.${row.key}`);
    }
    const classes = classRows.map((r) => decodeLegacy(r.definition) as ClassDef);
    for (const c of classes) {
      const shipped = DEFAULT_CLASSES.find((d) => d.id === c.id);
      if (!shipped || !isDeepStrictEqual(c, shipped)) edited.push(`class.${c.id}`);
    }
    if (edited.length) {
      throw new Error(`Stored configuration is unreadable (${(strictError as Error).message.slice(0, 80)}) and differs from the shipped defaults (${edited.join(", ")}), so it cannot be decoded safely. Repair it first: pnpm db:repair-jsonb`);
    }
    return { settings: settings as unknown as GameSettings, classes, source: "database (legacy double-encoded jsonb rows, verified identical to the shipped defaults)" };
  }
}
