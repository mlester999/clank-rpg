import { clamp, round2, saturate } from "../util/math";
import type { CharacterSettings, TelegramSettings } from "../settings";

import type { BehaviorCounters, MessageFeatures, UserCounters } from "./types";

/**
 * Hybrid activity score in [0, 100]. Message QUANTITY matters, but each component saturates
 * (diminishing returns) and four other signals count too: active days, conversations,
 * engagement received, and average message quality. Spamming volume alone cannot max it out.
 */
export function computeActivityScore(c: UserCounters, s: TelegramSettings): number {
  const w = s.activity.weights;
  const sat = s.activity.saturation;
  const totalWeight = w.messages + w.days + w.conversation + w.engagement + w.quality || 1;
  const avgQuality = c.qualifyingMessages > 0 ? clamp(c.qualitySum / c.qualifyingMessages, 0, 1) : 0;
  const score =
    w.messages * saturate(c.qualifyingMessages, sat.messages) +
    w.days * saturate(c.activeDays, sat.days) +
    w.conversation * saturate(c.repliesSent + c.repliesReceived, sat.conversation) +
    w.engagement * saturate(c.reactionsReceived + c.repliesReceived, sat.engagement) +
    w.quality * avgQuality;
  return round2((100 * score) / totalWeight);
}

/** Points of Telegram-derived stat bonus (0..maxPoints), concave in the activity score. */
export function telegramBonusPoints(activityScore: number, s: CharacterSettings): number {
  const normalized = clamp(activityScore / 100, 0, 1);
  return round2(s.telegramBonus.maxPoints * Math.pow(normalized, s.telegramBonus.curve));
}

export const emptyBehavior = (): BehaviorCounters => ({
  msgs: 0, replies: 0, questions: 0, exclaims: 0, long: 0, links: 0, media: 0, night: 0, burst: 0, spam: 0,
});

/** Update behaviour counters for one scored message. `sinceLastMs` flags rapid-fire style. */
export function applyBehavior(
  b: BehaviorCounters,
  f: MessageFeatures,
  qualifies: boolean,
  isSpamReject: boolean,
  sinceLastMs: number | null,
): BehaviorCounters {
  const next = { ...b };
  if (isSpamReject) next.spam += 1;
  if (!qualifies) return next;
  next.msgs += 1;
  if (f.isReply) next.replies += 1;
  if (f.hasQuestion) next.questions += 1;
  if (f.hasExclaim) next.exclaims += 1;
  if (f.isLong) next.long += 1;
  if (f.hasLink) next.links += 1;
  if (f.mediaKind !== "none") next.media += 1;
  if (f.hourUtc < 6) next.night += 1;
  if (sinceLastMs !== null && sinceLastMs < 15_000) next.burst += 1;
  return next;
}

export function behaviorRatios(b: Partial<BehaviorCounters>): Record<string, number> {
  const n = Math.max(1, b.msgs ?? 0);
  return {
    replyRatio: (b.replies ?? 0) / n,
    questionRatio: (b.questions ?? 0) / n,
    exclaimRatio: (b.exclaims ?? 0) / n,
    longRatio: (b.long ?? 0) / n,
    linkRatio: (b.links ?? 0) / n,
    mediaRatio: (b.media ?? 0) / n,
    nightRatio: (b.night ?? 0) / n,
    burstRatio: (b.burst ?? 0) / n,
  };
}
