import { generateCharacter } from "../character/generate";
import type { ClassDef } from "../rules";
import type { GameSettings } from "../settings";

import { computeActivityScore } from "./activity";
import { extractFeatures, utcDay } from "./features";
import { scoreUserHistory, shouldAutoFlag, type UserHistory } from "./history";
import type { IngestMessage, MessageFeatures, ReactionRef, RejectReason, UserStatus } from "./types";

/**
 * Pure import planner. Turns parsed export messages into per-member scored histories, reactions,
 * derived counters and the list of members who cross the hero threshold. NO I/O.
 *
 * The dry run prints this plan; the live import writes exactly this plan. That is what makes the dry
 * run a faithful prediction rather than a separate estimate.
 */
export interface ExistingMessage {
  messageId: number;
  features: MessageFeatures;
  isReply: boolean;
  replyToUserId: number | null;
}

export interface ExistingUser {
  status: UserStatus;
  /** Messages already stored for this member in this chat (merged with the file, stored copy wins). */
  messages: ExistingMessage[];
}

export interface PlanInput {
  messages: readonly IngestMessage[];
  settings: GameSettings;
  hash: (normalizedText: string) => string;
  /** Members that already have stored messages (merged chronologically with the file). */
  existing?: ReadonlyMap<number, ExistingUser>;
  /** Members whose stored state already equals the file's — nothing to write. */
  skipUsers?: ReadonlySet<number>;
  /** Current status of every member the database already knows (an admin's BANNED/FLAGGED must be honoured). */
  knownStatus?: ReadonlyMap<number, UserStatus>;
  /** Hero preview inputs (optional): without a secret no class is rolled. */
  preview?: { classes: readonly ClassDef[]; classRollSecret: string };
}

export interface PlannedMessage {
  messageId: number;
  userId: number;
  chatId: number;
  sentAtMs: number;
  day: string;
  features: MessageFeatures;
  isReply: boolean;
  replyToUserId: number | null;
  qualifies: boolean;
  weight: number;
  reason: RejectReason | null;
  /** Not yet in the database. */
  isNew: boolean;
}

export interface PlannedUser {
  userId: number;
  displayName: string;
  status: UserStatus;
  autoFlagged: boolean;
  history: UserHistory;
  messages: PlannedMessage[];
  newMessages: number;
  repliesReceived: number;
  reactionsReceived: number;
  activityScore: number;
  eligible: boolean;
}

export interface PlannedReaction {
  chatId: number;
  messageId: number;
  authorId: number;
  reactorId: number;
  atMs: number;
}

export interface PlannedHeroPreview {
  userId: number;
  name: string;
  classId: string;
  rarity: string;
  qualifying: number;
}

export interface ImportPlan {
  users: PlannedUser[];
  reactions: PlannedReaction[];
  skippedUsers: number;
  totals: {
    importedMessages: number;
    newMessages: number;
    uniqueUsers: number;
    qualifyingMessages: number;
    rejectedByReason: Record<string, number>;
    noTextMessages: number;
    autoFlaggedUsers: number;
    eligibleUsers: number;
    nearMissUsers: number;
    reactionsImportable: number;
    reactionsDroppedSelf: number;
    reactionsDroppedAuthorNotImported: number;
    reactionsDroppedDailyCap: number;
  };
  distribution: Array<{ atLeast: number; users: number }>;
  topUsers: Array<{ userId: number; name: string; total: number; qualifying: number; eligible: boolean }>;
  heroes: PlannedHeroPreview[];
}

const DISTRIBUTION_STEPS = [1, 10, 25, 50, 75, 100, 150, 250, 500, 1000, 2000];

export function planImport(input: PlanInput): ImportPlan {
  const { settings } = input;
  const byUser = new Map<number, IngestMessage[]>();
  for (const m of input.messages) {
    const list = byUser.get(m.authorId);
    if (list) list.push(m);
    else byUser.set(m.authorId, [m]);
  }

  const users: PlannedUser[] = [];
  let skippedUsers = 0;
  const importedAuthors = new Set(byUser.keys());
  const rejectedByReason: Record<string, number> = {};
  let qualifyingMessages = 0;
  let newMessages = 0;
  let noText = 0;
  let autoFlagged = 0;

  for (const [userId, fileMessages] of byUser) {
    if (input.skipUsers?.has(userId)) {
      skippedUsers++;
      continue;
    }
    const existing = input.existing?.get(userId);
    const stored = new Map<number, ExistingMessage>((existing?.messages ?? []).map((m) => [m.messageId, m]));

    type Row = { messageId: number; chatId: number; sentAtMs: number; features: MessageFeatures; isReply: boolean; replyToUserId: number | null; isNew: boolean };
    const rows: Row[] = [];
    const seen = new Set<number>();
    for (const m of fileMessages) {
      if (seen.has(m.messageId)) continue; // duplicate entry inside the file itself
      seen.add(m.messageId);
      const prior = stored.get(m.messageId);
      if (prior) {
        rows.push({ messageId: m.messageId, chatId: m.chatId, sentAtMs: prior.features.sentAtMs, features: prior.features, isReply: prior.isReply, replyToUserId: prior.replyToUserId, isNew: false });
      } else {
        rows.push({ messageId: m.messageId, chatId: m.chatId, sentAtMs: m.sentAtMs, features: extractFeatures(m, settings.telegram, input.hash), isReply: m.isReply, replyToUserId: m.replyToUserId ?? null, isNew: true });
      }
    }
    // stored messages that the file does not contain (e.g. captured live) still count
    const chatId = fileMessages[0]!.chatId;
    for (const prior of stored.values()) {
      if (!seen.has(prior.messageId)) {
        rows.push({ messageId: prior.messageId, chatId, sentAtMs: prior.features.sentAtMs, features: prior.features, isReply: prior.isReply, replyToUserId: prior.replyToUserId, isNew: false });
      }
    }
    rows.sort((a, b) => a.sentAtMs - b.sentAtMs || a.messageId - b.messageId);

    let status: UserStatus = existing?.status ?? input.knownStatus?.get(userId) ?? "OK";
    const history = scoreUserHistory(rows.map((r) => r.features), status, settings.telegram);
    let autoFlag = false;
    if (status === "OK" && shouldAutoFlag(history, settings.telegram)) {
      autoFlag = true;
      status = "FLAGGED";
      autoFlagged++;
    }

    const messages: PlannedMessage[] = rows.map((r, i) => {
      const s = history.scored[i]!;
      return {
        messageId: r.messageId, userId, chatId: r.chatId, sentAtMs: r.sentAtMs, day: utcDay(r.sentAtMs), features: r.features,
        isReply: r.isReply, replyToUserId: r.replyToUserId, qualifies: s.qualifies, weight: s.weight, reason: s.reason, isNew: r.isNew,
      };
    });
    newMessages += messages.filter((m) => m.isNew).length;
    for (const m of messages) {
      if (m.isNew) {
        if (m.qualifies) qualifyingMessages++;
        else if (m.reason) rejectedByReason[m.reason] = (rejectedByReason[m.reason] ?? 0) + 1;
        if (m.reason === "NO_TEXT") noText++;
      }
    }

    const last = fileMessages[fileMessages.length - 1]!;
    users.push({
      userId,
      displayName: last.displayName,
      status,
      autoFlagged: autoFlag,
      history,
      messages,
      newMessages: messages.filter((m) => m.isNew).length,
      repliesReceived: 0,
      reactionsReceived: 0,
      activityScore: 0,
      eligible: false,
    });
  }

  // ---- reactions: identified reactors only, never self, capped per reactor per local day --------------
  const authorOf = new Map<number, number>(); // messageId → author (imported authors only)
  for (const [uid, list] of byUser) for (const m of list) authorOf.set(m.messageId, uid);
  const candidates: Array<{ chatId: number; messageId: number; authorId: number; ref: ReactionRef }> = [];
  let droppedSelf = 0;
  let droppedAuthor = 0;
  for (const m of input.messages) {
    for (const ref of m.reactions ?? []) {
      if (ref.reactorId === m.authorId) droppedSelf++;
      else if (!importedAuthors.has(m.authorId)) droppedAuthor++;
      else candidates.push({ chatId: m.chatId, messageId: m.messageId, authorId: m.authorId, ref });
    }
  }
  candidates.sort((a, b) => a.ref.atMs - b.ref.atMs || a.messageId - b.messageId || a.ref.reactorId - b.ref.reactorId);
  const perReactorDay = new Map<string, number>();
  const seenReaction = new Set<string>();
  const reactions: PlannedReaction[] = [];
  let droppedCap = 0;
  for (const c of candidates) {
    const key = `${c.messageId}:${c.ref.reactorId}`;
    if (seenReaction.has(key)) continue; // one reaction per (message, reactor), whatever the emoji
    const capKey = `${c.ref.reactorId}:${c.ref.day}`;
    const n = perReactorDay.get(capKey) ?? 0;
    if (n >= settings.telegram.reactionsPerReactorPerDay) {
      droppedCap++;
      continue;
    }
    perReactorDay.set(capKey, n + 1);
    seenReaction.add(key);
    reactions.push({ chatId: c.chatId, messageId: c.messageId, authorId: c.authorId, reactorId: c.ref.reactorId, atMs: c.ref.atMs });
  }

  // ---- derived counters + final activity score + eligibility --------------------------------------------
  const repliesReceived = new Map<number, number>();
  for (const u of users) {
    for (const m of u.messages) {
      if (m.qualifies && m.isReply && m.replyToUserId !== null && m.replyToUserId !== u.userId) {
        repliesReceived.set(m.replyToUserId, (repliesReceived.get(m.replyToUserId) ?? 0) + 1);
      }
    }
  }
  const reactionsReceived = new Map<number, number>();
  for (const r of reactions) reactionsReceived.set(r.authorId, (reactionsReceived.get(r.authorId) ?? 0) + 1);

  const threshold = settings.telegram.qualifyingThreshold;
  let eligible = 0;
  let nearMiss = 0;
  for (const u of users) {
    u.repliesReceived = repliesReceived.get(u.userId) ?? 0;
    u.reactionsReceived = reactionsReceived.get(u.userId) ?? 0;
    u.activityScore = computeActivityScore(
      {
        totalMessages: u.history.totalMessages,
        qualifyingMessages: u.history.qualifyingMessages,
        activeDays: u.history.activeDays,
        repliesSent: u.history.repliesSent,
        repliesReceived: u.repliesReceived,
        reactionsReceived: u.reactionsReceived,
        qualitySum: u.history.qualitySum,
      },
      settings.telegram,
    );
    u.eligible = u.status === "OK" && u.history.qualifyingMessages >= threshold;
    if (u.eligible) eligible++;
    else if (u.status === "OK" && u.history.qualifyingMessages >= Math.floor(threshold * 0.9)) nearMiss++;
  }

  const distribution = DISTRIBUTION_STEPS.map((atLeast) => ({ atLeast, users: users.filter((u) => u.history.qualifyingMessages >= atLeast).length }));
  const topUsers = users
    .slice()
    .sort((a, b) => b.history.totalMessages - a.history.totalMessages)
    .slice(0, 15)
    .map((u) => ({ userId: u.userId, name: u.displayName, total: u.history.totalMessages, qualifying: u.history.qualifyingMessages, eligible: u.eligible }));

  const heroes: PlannedHeroPreview[] = [];
  if (input.preview) {
    for (const u of users) {
      if (!u.eligible) continue;
      const g = generateCharacter({
        telegramUserId: u.userId,
        displayName: u.displayName,
        behavior: u.history.behavior,
        activityScore: u.activityScore,
        classes: input.preview.classes,
        settings,
        secret: input.preview.classRollSecret,
      });
      heroes.push({ userId: u.userId, name: g.name, classId: g.classId, rarity: g.rarity, qualifying: u.history.qualifyingMessages });
    }
  }

  return {
    users,
    reactions,
    skippedUsers,
    totals: {
      importedMessages: input.messages.length,
      newMessages,
      uniqueUsers: importedAuthors.size,
      qualifyingMessages,
      rejectedByReason,
      noTextMessages: noText,
      autoFlaggedUsers: autoFlagged,
      eligibleUsers: eligible,
      nearMissUsers: nearMiss,
      reactionsImportable: reactions.length,
      reactionsDroppedSelf: droppedSelf,
      reactionsDroppedAuthorNotImported: droppedAuthor,
      reactionsDroppedDailyCap: droppedCap,
    },
    distribution,
    topUsers,
    heroes,
  };
}
