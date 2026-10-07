import { clamp } from "../util/math";
import type { TelegramSettings } from "../settings";

import type { MessageFeatures, ScoreResult, ScoringContext } from "./types";

const reject = (reason: NonNullable<ScoreResult["reason"]>): ScoreResult => ({ qualifies: false, weight: 0, reason });

/**
 * Deterministic message-quality filter. Pure: same (features, context, settings) → same result.
 * Rules are evaluated in a fixed order; the first failing rule is the recorded reason.
 * No AI is involved. A future classifier can adjust `weight` after this function qualifies a
 * message but must never be required for the pipeline to function.
 */
export function scoreMessage(f: MessageFeatures, ctx: ScoringContext, s: TelegramSettings): ScoreResult {
  if (ctx.userStatus === "BANNED") return reject("USER_BANNED");
  if (ctx.userStatus === "FLAGGED") return reject("USER_FLAGGED");
  if (f.isForwarded) return reject("FORWARDED");
  if (f.linkOnly) return reject("LINK_ONLY");
  if (f.wordCount === 0) return reject("NO_TEXT");
  if (ctx.sinceLastMs !== null && ctx.sinceLastMs < s.minGapMs) return reject("TOO_FAST");
  if (ctx.messagesInBurstWindow >= s.burstMax) return reject("BURST");
  if (ctx.duplicatesInWindow >= 1) return reject("DUPLICATE");
  if (f.repeatedCharRun || (f.wordCount >= 4 && f.uniqueWordRatio < s.minUniqueWordRatio)) return reject("GIBBERISH");
  if (f.wordCount < s.minWords || f.charCount < s.minChars) return reject("TOO_SHORT");
  if (f.lowValueRatio >= s.lowValueRatioMax) return reject("LOW_VALUE");
  if (ctx.qualifyingToday >= s.maxQualifyingPerDay) return reject("DAILY_CAP");

  let weight = f.wordCount >= s.shortMessageWords ? s.weights.base : s.weights.short;
  if (f.isReply && !f.replyToSelf) weight += s.weights.replyBonus;
  if (f.hasQuestion) weight += s.weights.questionBonus;
  return { qualifies: true, weight: clamp(weight, 0, s.weights.max), reason: null };
}

/**
 * Stateful scorer for a chronologically-ordered stream of one user's messages. Used by
 * recomputation and imports; the live webhook path builds the same context from the database.
 * A test asserts both paths agree.
 */
export class SequenceScorer {
  private readonly times: number[] = [];
  private readonly hashes: Array<{ hash: string; at: number }> = [];
  private readonly qualifyingByDay = new Map<string, number>();
  private lastAt: number | null = null;

  constructor(
    private readonly settings: TelegramSettings,
    private readonly userStatus: ScoringContext["userStatus"] = "OK",
  ) {}

  push(f: MessageFeatures): ScoreResult & { day: string } {
    const day = new Date(f.sentAtMs).toISOString().slice(0, 10);
    const burstFrom = f.sentAtMs - this.settings.burstWindowMs;
    const dupFrom = f.sentAtMs - this.settings.duplicateWindowHours * 3_600_000;
    const ctx: ScoringContext = {
      userStatus: this.userStatus,
      sinceLastMs: this.lastAt === null ? null : f.sentAtMs - this.lastAt,
      messagesInBurstWindow: this.times.filter((t) => t > burstFrom && t <= f.sentAtMs).length,
      duplicatesInWindow: f.textHash
        ? this.hashes.filter((h) => h.hash === f.textHash && h.at >= dupFrom && h.at <= f.sentAtMs).length
        : 0,
      qualifyingToday: this.qualifyingByDay.get(day) ?? 0,
    };
    const result = scoreMessage(f, ctx, this.settings);
    this.times.push(f.sentAtMs);
    if (f.textHash) this.hashes.push({ hash: f.textHash, at: f.sentAtMs });
    this.lastAt = f.sentAtMs;
    if (result.qualifies) this.qualifyingByDay.set(day, (this.qualifyingByDay.get(day) ?? 0) + 1);
    return { ...result, day };
  }
}
