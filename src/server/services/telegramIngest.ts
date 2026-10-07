import { applyBehavior, computeActivityScore, emptyBehavior } from "@/domain/telegram/activity";
import { extractFeatures, utcDay } from "@/domain/telegram/features";
import { scoreMessage } from "@/domain/telegram/scoring";
import { scoreUserHistory } from "@/domain/telegram/history";
import { SPAM_REASONS, type BehaviorCounters, type IngestMessage, type MessageFeatures, type RejectReason, type ScoreResult } from "@/domain/telegram/types";
import type { ParsedUpdate } from "@/domain/telegram/updates";
import type { GameSettings } from "@/domain/settings";
import type { ClassDef } from "@/domain/rules";
import { json, type Db, type Queryable } from "../db/types";

import { evaluateAchievements } from "./achievements";
import { createCharacterForUser, type CharacterOrigin, type TelegramUserRow } from "./characters";

export interface IngestDeps {
  settings: GameSettings;
  classes: ClassDef[];
  /** Keyed text hasher (HMAC with a server pepper). */
  hash: (normalized: string) => string;
  classRollSecret: string;
  now?: () => Date;
}

export type IngestResult =
  | { status: "PROCESSED"; qualifies: boolean; reason: RejectReason | null; characterId?: string; characterCreated: boolean }
  | { status: "DUPLICATE_UPDATE" | "DUPLICATE_MESSAGE" }
  | { status: "IGNORED"; reason: string }
  | { status: "REACTION"; applied: boolean };

interface UserCountersRow extends TelegramUserRow {
  total_message_count: number;
  qualifying_message_count: number;
  active_days: number;
  reply_count: number;
  replies_received: number;
  reactions_received: number;
  quality_sum: number;
  first_message_at: Date | null;
  last_message_at: Date | null;
}

const USER_COLUMNS = `telegram_user_id, username, display_name, status, is_demo, activity_score, behavior,
  total_message_count, qualifying_message_count, active_days, reply_count, replies_received, reactions_received,
  quality_sum, first_message_at, last_message_at`;

/** Entry point for one parsed Telegram update (idempotent per update_id). */
export async function ingestUpdate(db: Db, update: ParsedUpdate, deps: IngestDeps): Promise<IngestResult> {
  if (update.kind === "ignored") return { status: "IGNORED", reason: update.reason };
  return db.transaction(async (tx) => {
    const fresh = await tx.query("insert into public.telegram_updates (update_id) values ($1) on conflict do nothing returning update_id", [update.updateId]);
    if (fresh.length === 0) return { status: "DUPLICATE_UPDATE" } as IngestResult;
    if (update.kind === "reaction") {
      const applied = await processReaction(tx, update, deps);
      return { status: "REACTION", applied } as IngestResult;
    }
    return processMessage(tx, update.message, deps);
  });
}

export function buildFeatures(msg: IngestMessage, deps: Pick<IngestDeps, "settings" | "hash">): MessageFeatures {
  return extractFeatures(msg, deps.settings.telegram, deps.hash);
}

async function upsertUser(q: Queryable, msg: Pick<IngestMessage, "authorId" | "username" | "displayName" | "sentAtMs">): Promise<UserCountersRow> {
  const rows = await q.query<UserCountersRow>(
    `insert into public.telegram_users (telegram_user_id, username, display_name, last_seen_at)
     values ($1, $2, $3, now())
     on conflict (telegram_user_id) do update set
       username = coalesce(excluded.username, public.telegram_users.username),
       display_name = case when excluded.display_name <> '' then excluded.display_name else public.telegram_users.display_name end,
       last_seen_at = now()
     returning ${USER_COLUMNS}`,
    [msg.authorId, msg.username ?? null, msg.displayName],
  );
  return rows[0] as UserCountersRow;
}

/** Live path: score ONE message against context read from the database, then apply counters. */
export async function processMessage(tx: Queryable, msg: IngestMessage, deps: IngestDeps): Promise<IngestResult> {
  const s = deps.settings.telegram;
  const user = await upsertUser(tx, msg);
  const features = buildFeatures(msg, deps);
  const day = utcDay(msg.sentAtMs);
  const sentAt = new Date(msg.sentAtMs).toISOString();

  const before = "(sent_at, message_id) < ($2::timestamptz, $3::bigint)";
  const [last] = await tx.query<{ sent_at: Date }>(
    `select sent_at from public.telegram_messages where telegram_user_id = $1 and ${before} order by sent_at desc, message_id desc limit 1`,
    [msg.authorId, sentAt, msg.messageId],
  );
  const [burst] = await tx.query<{ n: number }>(
    `select count(*)::int as n from public.telegram_messages
      where telegram_user_id = $1 and ${before} and sent_at > $2::timestamptz - ($4::float * interval '1 millisecond')`,
    [msg.authorId, sentAt, msg.messageId, s.burstWindowMs],
  );
  const [dups] = features.textHash
    ? await tx.query<{ n: number }>(
        `select count(*)::int as n from public.telegram_messages
          where telegram_user_id = $1 and ${before} and text_hash = $4
            and sent_at >= $2::timestamptz - ($5::float * interval '1 hour')`,
        [msg.authorId, sentAt, msg.messageId, features.textHash, s.duplicateWindowHours],
      )
    : [{ n: 0 }];
  const [today] = await tx.query<{ qualifying_count: number }>(
    "select qualifying_count from public.telegram_daily_activity where telegram_user_id = $1 and day = $2::date",
    [msg.authorId, day],
  );

  const result = scoreMessage(
    features,
    {
      userStatus: user.status,
      sinceLastMs: last ? msg.sentAtMs - new Date(last.sent_at).getTime() : null,
      messagesInBurstWindow: burst?.n ?? 0,
      duplicatesInWindow: dups?.n ?? 0,
      qualifyingToday: today?.qualifying_count ?? 0,
    },
    s,
  );

  const inserted = await tx.query(
    `insert into public.telegram_messages
       (chat_id, message_id, telegram_user_id, sent_at, day, text_hash, char_count, word_count, features, is_reply, reply_to_user_id, source, qualifies, weight, reject_reason)
     values ($1, $2, $3, $4::timestamptz, $5::date, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)
     on conflict (chat_id, message_id) do nothing returning message_id`,
    [msg.chatId, msg.messageId, msg.authorId, sentAt, day, features.textHash, features.charCount, features.wordCount, json(features), msg.isReply, msg.replyToUserId ?? null, msg.source, result.qualifies, result.weight, result.reason],
  );
  if (inserted.length === 0) return { status: "DUPLICATE_MESSAGE" };

  // Daily counters + active days (a day is "active" once it has a qualifying message).
  const dayRow = await tx.query<{ qualifying_count: number }>(
    `insert into public.telegram_daily_activity (telegram_user_id, day, message_count, qualifying_count)
     values ($1, $2::date, 1, $3) on conflict (telegram_user_id, day) do update set
       message_count = public.telegram_daily_activity.message_count + 1,
       qualifying_count = public.telegram_daily_activity.qualifying_count + $3
     returning qualifying_count`,
    [msg.authorId, day, result.qualifies ? 1 : 0],
  );
  const becameActiveDay = result.qualifies && dayRow[0]?.qualifying_count === 1;

  const behavior = applyBehavior(
    { ...emptyBehavior(), ...user.behavior },
    features,
    result.qualifies,
    result.reason !== null && SPAM_REASONS.has(result.reason),
    last ? msg.sentAtMs - new Date(last.sent_at).getTime() : null,
  );
  const counters = {
    totalMessages: user.total_message_count + 1,
    qualifyingMessages: user.qualifying_message_count + (result.qualifies ? 1 : 0),
    activeDays: user.active_days + (becameActiveDay ? 1 : 0),
    repliesSent: user.reply_count + (result.qualifies && features.isReply && !features.replyToSelf ? 1 : 0),
    repliesReceived: user.replies_received,
    reactionsReceived: user.reactions_received,
    qualitySum: Number(user.quality_sum) + (result.qualifies ? result.weight : 0),
  };
  const activityScore = computeActivityScore(counters, s);
  await tx.query(
    `update public.telegram_users set
       total_message_count = $2, qualifying_message_count = $3, active_days = $4, reply_count = $5,
       quality_sum = $6, activity_score = $7, behavior = $8::jsonb,
       first_message_at = least(coalesce(first_message_at, $9::timestamptz), $9::timestamptz),
       last_message_at = greatest(coalesce(last_message_at, $9::timestamptz), $9::timestamptz)
     where telegram_user_id = $1`,
    [msg.authorId, counters.totalMessages, counters.qualifyingMessages, counters.activeDays, counters.repliesSent, counters.qualitySum, activityScore, json(behavior), sentAt],
  );

  // Conversations: a qualifying reply is engagement for the person replied to.
  if (result.qualifies && features.isReply && msg.replyToUserId && msg.replyToUserId !== msg.authorId) {
    await tx.query(
      "update public.telegram_users set replies_received = replies_received + 1 where telegram_user_id = $1",
      [msg.replyToUserId],
    );
  }

  await maybeAutoFlag(tx, msg.authorId, counters.totalMessages, behavior, user.status, deps.settings);

  const refreshed: UserCountersRow = {
    ...user,
    activity_score: activityScore,
    behavior,
    qualifying_message_count: counters.qualifyingMessages,
  };
  const origin: CharacterOrigin = msg.source === "IMPORT" ? "HISTORICAL_IMPORT" : "TELEGRAM";
  const created = await ensureEligibleCharacter(tx, refreshed, deps, origin);
  return {
    status: "PROCESSED",
    qualifies: result.qualifies,
    reason: result.reason,
    ...(created.characterId ? { characterId: created.characterId } : {}),
    characterCreated: created.created,
  };
}

async function maybeAutoFlag(tx: Queryable, id: number, total: number, behavior: BehaviorCounters, status: string, settings: GameSettings): Promise<void> {
  const f = settings.telegram.autoFlag;
  if (!f.enabled || status !== "OK" || total < f.minMessages) return;
  if (behavior.spam / total < f.spamRatio) return;
  await tx.query(
    "update public.telegram_users set status = 'FLAGGED', flag_reason = 'AUTO: spam-like message ratio' where telegram_user_id = $1 and status = 'OK'",
    [id],
  );
}

/** Creates the hero the moment a member reaches the qualifying threshold. */
export async function ensureEligibleCharacter(
  tx: Queryable,
  user: Pick<UserCountersRow, "telegram_user_id" | "qualifying_message_count"> & UserCountersRow,
  deps: Pick<IngestDeps, "settings" | "classes" | "classRollSecret">,
  origin: CharacterOrigin,
): Promise<{ characterId?: string; created: boolean }> {
  const status = (await tx.query<{ status: string }>("select status from public.telegram_users where telegram_user_id = $1", [user.telegram_user_id]))[0]?.status;
  if (status !== "OK") return { created: false };
  if (user.qualifying_message_count < deps.settings.telegram.qualifyingThreshold) {
    const existing = await tx.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [user.telegram_user_id]);
    return existing[0] ? { characterId: existing[0].id, created: false } : { created: false };
  }
  const fresh = (await tx.query<UserCountersRow>(`select ${USER_COLUMNS} from public.telegram_users where telegram_user_id = $1`, [user.telegram_user_id]))[0] as UserCountersRow;
  const result = await createCharacterForUser(tx, fresh, { settings: deps.settings, classes: deps.classes, secret: deps.classRollSecret, origin });
  if (result.created) await evaluateAchievements(tx, result.characterId);
  return { characterId: result.characterId, created: result.created };
}

/** Reaction add/remove → engagement counter for the AUTHOR (never self, capped per reactor per day). */
async function processReaction(tx: Queryable, r: Extract<ParsedUpdate, { kind: "reaction" }>, deps: IngestDeps): Promise<boolean> {
  const [msg] = await tx.query<{ telegram_user_id: number }>(
    "select telegram_user_id from public.telegram_messages where chat_id = $1 and message_id = $2",
    [r.chatId, r.messageId],
  );
  if (!msg || msg.telegram_user_id === r.reactorId) return false;
  const authorId = msg.telegram_user_id;
  let delta = 0;
  if (r.added) {
    const [{ n } = { n: 0 }] = await tx.query<{ n: number }>(
      "select count(*)::int as n from public.telegram_reactions where reactor_user_id = $1 and created_at >= date_trunc('day', now())",
      [r.reactorId],
    );
    if (n >= deps.settings.telegram.reactionsPerReactorPerDay) return false;
    const ins = await tx.query(
      `insert into public.telegram_reactions (chat_id, message_id, reactor_user_id, author_user_id) values ($1, $2, $3, $4)
       on conflict do nothing returning message_id`,
      [r.chatId, r.messageId, r.reactorId, authorId],
    );
    delta = ins.length;
  } else {
    const del = await tx.query(
      "delete from public.telegram_reactions where chat_id = $1 and message_id = $2 and reactor_user_id = $3 returning message_id",
      [r.chatId, r.messageId, r.reactorId],
    );
    delta = -del.length;
  }
  if (delta === 0) return false;
  const row = (
    await tx.query<UserCountersRow>(
      `update public.telegram_users set reactions_received = greatest(0, reactions_received + $2) where telegram_user_id = $1 returning ${USER_COLUMNS}`,
      [authorId, delta],
    )
  )[0];
  if (row) await refreshActivityScore(tx, row, deps.settings);
  return true;
}

async function refreshActivityScore(tx: Queryable, u: UserCountersRow, settings: GameSettings): Promise<void> {
  const score = computeActivityScore(
    {
      totalMessages: u.total_message_count,
      qualifyingMessages: u.qualifying_message_count,
      activeDays: u.active_days,
      repliesSent: u.reply_count,
      repliesReceived: u.replies_received,
      reactionsReceived: u.reactions_received,
      qualitySum: Number(u.quality_sum),
    },
    settings.telegram,
  );
  await tx.query("update public.telegram_users set activity_score = $2 where telegram_user_id = $1", [u.telegram_user_id, score]);
}

// ---------------------------------------------------------------------------------------
// Recompute + historical import
// ---------------------------------------------------------------------------------------

interface StoredMessage {
  chat_id: number;
  message_id: number;
  sent_at: Date;
  features: MessageFeatures;
}

/**
 * Rebuilds a member's counters from stored message FEATURES (no text needed) in strict
 * chronological order. Used after historical imports (which can arrive out of order), after
 * changing scoring rules, and when an admin clears or applies a flag. Deterministic.
 */
export async function recomputeTelegramUser(tx: Queryable, telegramUserId: number, deps: IngestDeps, origin: CharacterOrigin = "TELEGRAM"): Promise<{ qualifying: number; characterCreated: boolean }> {
  const userRows = await tx.query<UserCountersRow>(`select ${USER_COLUMNS} from public.telegram_users where telegram_user_id = $1 for update`, [telegramUserId]);
  const user = userRows[0];
  if (!user) return { qualifying: 0, characterCreated: false };

  const messages = await tx.query<StoredMessage>(
    "select chat_id, message_id, sent_at, features from public.telegram_messages where telegram_user_id = $1 order by sent_at, message_id",
    [telegramUserId],
  );
  const history = scoreUserHistory(messages.map((m) => m.features), user.status, deps.settings.telegram);
  const { behavior, repliesSent, qualitySum } = history;
  const qualifying = history.qualifyingMessages;
  const daily = history.daily;
  const updates = messages.map((m, i) => ({ chat: m.chat_id, id: m.message_id, r: history.scored[i] as ScoreResult }));

  if (updates.length) {
    await tx.query(
      `update public.telegram_messages m set qualifies = x.qualifies, weight = x.weight, reject_reason = x.reason
         from jsonb_to_recordset($1::jsonb) as x(chat bigint, id bigint, qualifies boolean, weight real, reason text)
        where m.chat_id = x.chat and m.message_id = x.id`,
      [json(updates.map((u) => ({ chat: u.chat, id: u.id, qualifies: u.r.qualifies, weight: u.r.weight, reason: u.r.reason })))],
    );
  }
  await tx.query("delete from public.telegram_daily_activity where telegram_user_id = $1", [telegramUserId]);
  if (daily.size) {
    await tx.query(
      `insert into public.telegram_daily_activity (telegram_user_id, day, message_count, qualifying_count)
       select $1, (x.day)::date, x.m, x.q from jsonb_to_recordset($2::jsonb) as x(day text, m int, q int)`,
      [telegramUserId, json([...daily.entries()].map(([day, v]) => ({ day, m: v.messages, q: v.qualifying })))],
    );
  }
  const activeDays = [...daily.values()].filter((d) => d.qualifying > 0).length;
  const counters = {
    totalMessages: messages.length,
    qualifyingMessages: qualifying,
    activeDays,
    repliesSent,
    repliesReceived: user.replies_received,
    reactionsReceived: user.reactions_received,
    qualitySum,
  };
  const activityScore = computeActivityScore(counters, deps.settings.telegram);
  const first = messages[0] ? new Date(messages[0].features.sentAtMs) : null;
  const lastMsg = messages[messages.length - 1];
  const last = lastMsg ? new Date(lastMsg.features.sentAtMs) : null;
  await tx.query(
    `update public.telegram_users set total_message_count = $2, qualifying_message_count = $3, active_days = $4, reply_count = $5,
       quality_sum = $6, activity_score = $7, behavior = $8::jsonb, first_message_at = $9, last_message_at = $10
     where telegram_user_id = $1`,
    [telegramUserId, counters.totalMessages, counters.qualifyingMessages, activeDays, repliesSent, qualitySum, activityScore, json(behavior), first, last],
  );
  const created = await ensureEligibleCharacter(
    tx,
    { ...user, qualifying_message_count: qualifying, activity_score: activityScore, behavior },
    deps,
    origin,
  );
  return { qualifying, characterCreated: created.created };
}

export interface ImportSummary {
  messagesRead: number;
  messagesInserted: number;
  duplicatesSkipped: number;
  usersAffected: number;
  charactersCreated: number;
}

/**
 * Historical import: stores message features (idempotent on chat+message id), then recomputes
 * every affected member from scratch. Counts are derived from messages — never typed in —
 * so nothing here can fabricate history. Chunked to bound transaction size.
 */
export async function importMessages(db: Db, messages: readonly IngestMessage[], deps: IngestDeps, chunkSize = 400): Promise<ImportSummary> {
  const summary: ImportSummary = { messagesRead: messages.length, messagesInserted: 0, duplicatesSkipped: 0, usersAffected: 0, charactersCreated: 0 };
  const affected = new Set<number>();
  for (let i = 0; i < messages.length; i += chunkSize) {
    const chunk = messages.slice(i, i + chunkSize);
    await db.transaction(async (tx) => {
      for (const msg of chunk) {
        await upsertUser(tx, msg);
        const features = buildFeatures(msg, deps);
        const rows = await tx.query(
          `insert into public.telegram_messages
             (chat_id, message_id, telegram_user_id, sent_at, day, text_hash, char_count, word_count, features, is_reply, reply_to_user_id, source)
           values ($1, $2, $3, $4::timestamptz, $5::date, $6, $7, $8, $9::jsonb, $10, $11, 'IMPORT')
           on conflict (chat_id, message_id) do nothing returning message_id`,
          [msg.chatId, msg.messageId, msg.authorId, new Date(msg.sentAtMs).toISOString(), utcDay(msg.sentAtMs), features.textHash, features.charCount, features.wordCount, json(features), msg.isReply, msg.replyToUserId ?? null],
        );
        if (rows.length) {
          summary.messagesInserted++;
          affected.add(msg.authorId);
        } else {
          summary.duplicatesSkipped++;
        }
      }
    });
  }
  const ids = [...affected];
  for (let i = 0; i < ids.length; i += 25) {
    await db.transaction(async (tx) => {
      for (const id of ids.slice(i, i + 25)) {
        const r = await recomputeTelegramUser(tx, id, deps, "HISTORICAL_IMPORT");
        if (r.characterCreated) summary.charactersCreated++;
      }
    });
  }
  summary.usersAffected = ids.length;
  return summary;
}
