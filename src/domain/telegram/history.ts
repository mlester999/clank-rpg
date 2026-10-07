import type { TelegramSettings } from "../settings";

import { applyBehavior, emptyBehavior } from "./activity";
import { SequenceScorer } from "./scoring";
import { SPAM_REASONS, type BehaviorCounters, type MessageFeatures, type RejectReason, type UserStatus } from "./types";
import { utcDay } from "./features";

export interface ScoredHistoryMessage {
  qualifies: boolean;
  weight: number;
  reason: RejectReason | null;
  day: string;
}

export interface UserHistory {
  scored: ScoredHistoryMessage[];
  totalMessages: number;
  qualifyingMessages: number;
  activeDays: number;
  repliesSent: number;
  qualitySum: number;
  spamRejects: number;
  behavior: BehaviorCounters;
  daily: Map<string, { messages: number; qualifying: number }>;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

/**
 * Scores ONE member's complete message history in chronological order. Pure and deterministic.
 * This is the single implementation behind both `recomputeTelegramUser` (live DB) and the bulk
 * historical import / dry run — so a dry run predicts the live result exactly.
 * `messages` MUST already be sorted by (time, message id).
 */
export function scoreUserHistory(messages: readonly MessageFeatures[], status: UserStatus, settings: TelegramSettings): UserHistory {
  const scorer = new SequenceScorer(settings, status);
  let behavior = emptyBehavior();
  const scored: ScoredHistoryMessage[] = [];
  const daily = new Map<string, { messages: number; qualifying: number }>();
  let qualifying = 0;
  let qualitySum = 0;
  let repliesSent = 0;
  let spamRejects = 0;
  let prevAt: number | null = null;
  for (const f of messages) {
    const r = scorer.push(f);
    scored.push({ qualifies: r.qualifies, weight: r.weight, reason: r.reason, day: r.day });
    const d = daily.get(utcDay(f.sentAtMs)) ?? { messages: 0, qualifying: 0 };
    d.messages += 1;
    if (r.qualifies) d.qualifying += 1;
    daily.set(utcDay(f.sentAtMs), d);
    const spam = r.reason !== null && SPAM_REASONS.has(r.reason);
    if (spam) spamRejects += 1;
    behavior = applyBehavior(behavior, f, r.qualifies, spam, prevAt === null ? null : f.sentAtMs - prevAt);
    prevAt = f.sentAtMs;
    if (r.qualifies) {
      qualifying += 1;
      qualitySum += r.weight;
      if (f.isReply && !f.replyToSelf) repliesSent += 1;
    }
  }
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    scored,
    totalMessages: messages.length,
    qualifyingMessages: qualifying,
    activeDays: [...daily.values()].filter((d) => d.qualifying > 0).length,
    repliesSent,
    qualitySum,
    spamRejects,
    behavior,
    daily,
    firstAtMs: first ? first.sentAtMs : null,
    lastAtMs: last ? last.sentAtMs : null,
  };
}

/** True when the member's pattern is overwhelmingly spam-like (same rule as the live webhook auto-flag). */
export function shouldAutoFlag(history: Pick<UserHistory, "totalMessages" | "spamRejects">, settings: TelegramSettings): boolean {
  const f = settings.autoFlag;
  return f.enabled && history.totalMessages >= f.minMessages && history.spamRejects / history.totalMessages >= f.spamRatio;
}
