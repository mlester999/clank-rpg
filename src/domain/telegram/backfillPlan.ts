import { ACCESSORIES, EYE_STYLE_COUNT, HAIR_COLORS, HAIR_STYLE_COUNT, MOUTH_STYLE_COUNT, RARITIES, SKIN_TONES, type AppearanceParts } from "../character/appearance";
import { generateCharacter, type GeneratedCharacter } from "../character/generate";
import { isLegacyGenerator } from "../hero/heroVersion";
import { statsMatchTier } from "../hero/statBudget";
import type { ClassDef } from "../rules";
import type { GameSettings } from "../settings";
import { spriteConfigSchema, type SpriteConfig } from "../sprites/config";
import { STAT_KEYS } from "../stats";

import { computeActivityScore } from "./activity";
import { scoreUserHistory, type UserHistory } from "./history";
import type { BehaviorCounters, MessageFeatures, UserStatus } from "./types";

/**
 * Re-evaluation of Telegram history that is ALREADY STORED in the database (pure, deterministic, no I/O).
 *
 * The bulk importer only ever plans the members it still has to write, so against a database that already holds the
 * history its report is empty. This planner starts from the stored rows instead: it re-scores every member's stored
 * message features chronologically with the SAME pure function the importer and the live webhook use, derives every
 * counter again, compares it with what is stored, and decides who is eligible for a hero and what that hero would be.
 */

export interface StoredMessage {
  messageId: number;
  features: MessageFeatures;
  qualifies: boolean;
  weight: number;
  reason: string | null;
  replyToUserId: number | null;
}

export interface StoredCounters {
  total: number;
  qualifying: number;
  activeDays: number;
  replyCount: number;
  repliesReceived: number;
  reactionsReceived: number;
  qualitySum: number;
  activityScore: number;
}

export interface StoredMember {
  userId: number;
  displayName: string;
  username: string | null;
  status: UserStatus;
  flagReason: string | null;
  counters: StoredCounters;
  behavior: Partial<BehaviorCounters>;
  /** Stored messages ordered by (sent_at, message_id). */
  messages: StoredMessage[];
  daily: ReadonlyMap<string, { messages: number; qualifying: number }>;
  /** Rows in telegram_reactions where this member is the author (the source of truth for reactions_received). */
  reactionRows: number;
  /** The member's existing hero, if any. */
  hero: { id: string; classId: string } | null;
}

export interface BackfillInput {
  members: readonly StoredMember[];
  settings: GameSettings;
  /** Never create a hero for these Telegram ids (operator decision). */
  excludeIds?: ReadonlySet<number>;
  /** Telegram ids the operator confirmed are people although their name looks like a bot. */
  confirmedHumanIds?: ReadonlySet<number>;
  /** Without a secret no class can be rolled, so no hero preview is produced. */
  preview?: { classes: readonly ClassDef[]; classRollSecret: string };
}

export type BlockedReason = "OPERATOR_EXCLUDED" | "BOT_LIKE_NAME_UNCONFIRMED";

export interface MemberDrift {
  /** Stored messages whose qualifies / weight / reject reason differ from the re-scored value. */
  messages: number;
  /** Names of the stored counters that differ from the re-derived ones. */
  counters: string[];
  daily: boolean;
  behavior: boolean;
}

export interface BackfillHeroPreview {
  userId: number;
  name: string;
  qualifying: number;
  activityScore: number;
  classId: string;
  classValid: boolean;
  rarity: string;
  rarityValid: boolean;
  sprite: SpriteConfig;
  appearanceSeed: string;
  statsValid: boolean;
  /** The authoritative PWR the hero is generated with (inside its rarity's band). */
  power: number;
  appearanceValid: boolean;
  spriteValid: boolean;
  deterministic: boolean;
  nameFromFallback: boolean;
}

function validAppearance(a: AppearanceParts): boolean {
  const index = (n: number, length: number) => Number.isInteger(n) && n >= 0 && n < length;
  return index(a.skin, SKIN_TONES.length) && index(a.hairStyle, HAIR_STYLE_COUNT) && index(a.hairColor, HAIR_COLORS.length)
    && index(a.eyes, EYE_STYLE_COUNT) && index(a.mouth, MOUTH_STYLE_COUNT) && index(a.accessory, ACCESSORIES.length)
    && typeof a.cape === "boolean" && (["none", "ring", "sparks", "flame"] as const).includes(a.aura) && Number.isInteger(a.outfitHue) && a.outfitHue >= 0 && a.outfitHue < 360;
}

/**
 * A generated hero is valid when its stats are whole positive numbers that equal class base + variation, and (hero generator 2) its PWR
 * is the authoritative POWER of those stats AND lies inside its rarity's band — stats, PWR and rarity must agree.
 */
function validGeneratedStats(g: GeneratedCharacter, classDef: ClassDef | undefined): boolean {
  if (!classDef) return false;
  const statsAreValid = STAT_KEYS.every((key) => Number.isInteger(g.stats[key]) && g.stats[key] >= 1
    && Number.isFinite(g.variation[key]) && Number.isFinite(g.telegramBonus[key])
    && Math.round(classDef.base[key] + g.variation[key] + g.telegramBonus[key]) === g.stats[key]);
  if (!statsAreValid) return false;
  if (isLegacyGenerator(g.generatorVersion)) return true;
  return statsMatchTier(g.rarity, g.classId, g.stats, g.power);
}

export interface BackfillMember {
  userId: number;
  displayName: string;
  status: UserStatus;
  stored: StoredCounters;
  expected: StoredCounters & { behavior: BehaviorCounters };
  drift: MemberDrift;
  hasDrift: boolean;
  eligible: boolean;
  eligibleByStoredCounters: boolean;
  hasHero: boolean;
  botLike: boolean;
  blocked: BlockedReason | null;
  wouldCreate: boolean;
  preview: BackfillHeroPreview | null;
}

export interface BackfillPlan {
  threshold: number;
  members: BackfillMember[];
  heroes: BackfillHeroPreview[];
  totals: {
    membersConsidered: number;
    messagesConsidered: number;
    storedQualifying: number;
    rescoredQualifying: number;
    storedRejected: number;
    rejectedByReason: Record<string, number>;
    eligible: number;
    eligibleByStoredCounters: number;
    eligibilitySetsMatch: boolean;
    heroesPresent: number;
    heroesNoLongerEligible: number;
    wouldCreate: number;
    nearMiss: number;
    nonOkMembers: number;
    driftMembers: number;
    driftMessages: number;
    blockedOperator: number;
    blockedBotLike: number;
  };
  distribution: Array<{ atLeast: number; users: number }>;
  nonOk: Array<{ userId: number; name: string; status: UserStatus; total: number; storedQualifying: number; reason: string | null }>;
  ambiguous: {
    botLike: Array<{ userId: number; name: string; total: number; qualifying: number; eligible: boolean; hasHero: boolean }>;
    duplicateEligibleNames: Array<{ name: string; userIds: number[] }>;
    fallbackNames: Array<{ userId: number; displayName: string; heroName: string }>;
  };
}

const DISTRIBUTION_STEPS = [1, 10, 25, 50, 75, 100, 150, 250, 500, 1000, 2000];

/** Deliberately broad: it only ever asks a human to look, it never removes anyone. */
export const BOT_LIKE_NAME = /bot/i;

/** Postgres `real` columns hold float32. */
const sameReal = (stored: number, derived: number) => Math.fround(derived) === Math.fround(stored);

function behaviorEqual(stored: Partial<BehaviorCounters>, derived: BehaviorCounters): boolean {
  const keys = Object.keys(derived) as Array<keyof BehaviorCounters>;
  return keys.every((k) => Number(stored[k] ?? 0) === derived[k]);
}

function dailyEqual(stored: ReadonlyMap<string, { messages: number; qualifying: number }>, derived: UserHistory["daily"]): boolean {
  if (stored.size !== derived.size) return false;
  for (const [day, d] of derived) {
    const s = stored.get(day);
    if (!s || s.messages !== d.messages || s.qualifying !== d.qualifying) return false;
  }
  return true;
}

export function planBackfill(input: BackfillInput): BackfillPlan {
  const { settings } = input;
  const threshold = settings.telegram.qualifyingThreshold;

  // Pass 1: re-score every member's stored history. Content-based on purpose (status 'OK'), so a flagged member's
  // evidence is judged exactly as it was when it was imported; their status still blocks eligibility below.
  const histories = new Map<number, UserHistory>();
  for (const m of input.members) histories.set(m.userId, scoreUserHistory(m.messages.map((x) => x.features), "OK", settings.telegram));

  // Pass 2: replies received = qualifying replies by OTHER members (same rule as the importer's derivation).
  const repliesReceived = new Map<number, number>();
  for (const m of input.members) {
    const h = histories.get(m.userId) as UserHistory;
    m.messages.forEach((msg, i) => {
      if (h.scored[i]?.qualifies && msg.replyToUserId !== null && msg.replyToUserId !== m.userId) {
        repliesReceived.set(msg.replyToUserId, (repliesReceived.get(msg.replyToUserId) ?? 0) + 1);
      }
    });
  }

  const members: BackfillMember[] = [];
  const rejectedByReason: Record<string, number> = {};
  let storedQualifying = 0;
  let rescoredQualifying = 0;
  let messagesConsidered = 0;

  for (const m of input.members) {
    const h = histories.get(m.userId) as UserHistory;
    messagesConsidered += m.messages.length;
    storedQualifying += m.messages.filter((x) => x.qualifies).length;
    rescoredQualifying += h.qualifyingMessages;
    m.messages.forEach((_, i) => {
      const r = h.scored[i]?.reason;
      if (r) rejectedByReason[r] = (rejectedByReason[r] ?? 0) + 1;
    });

    const driftedMessages = m.messages.reduce((n, msg, i) => {
      const s = h.scored[i];
      return s && s.qualifies === msg.qualifies && (s.reason ?? null) === (msg.reason ?? null) && sameReal(msg.weight, s.weight) ? n : n + 1;
    }, 0);

    const received = repliesReceived.get(m.userId) ?? 0;
    const reactionsReceived = m.reactionRows;
    const activityScore = computeActivityScore(
      { totalMessages: h.totalMessages, qualifyingMessages: h.qualifyingMessages, activeDays: h.activeDays, repliesSent: h.repliesSent, repliesReceived: received, reactionsReceived, qualitySum: h.qualitySum },
      settings.telegram,
    );
    const expected = {
      total: h.totalMessages, qualifying: h.qualifyingMessages, activeDays: h.activeDays, replyCount: h.repliesSent,
      repliesReceived: received, reactionsReceived, qualitySum: h.qualitySum, activityScore, behavior: h.behavior,
    };
    const counterDrift: string[] = [];
    if (m.counters.total !== expected.total) counterDrift.push("total_message_count");
    if (m.counters.qualifying !== expected.qualifying) counterDrift.push("qualifying_message_count");
    if (m.counters.activeDays !== expected.activeDays) counterDrift.push("active_days");
    if (m.counters.replyCount !== expected.replyCount) counterDrift.push("reply_count");
    if (m.counters.repliesReceived !== expected.repliesReceived) counterDrift.push("replies_received");
    if (m.counters.reactionsReceived !== expected.reactionsReceived) counterDrift.push("reactions_received");
    if (!sameReal(m.counters.qualitySum, expected.qualitySum)) counterDrift.push("quality_sum");
    if (!sameReal(m.counters.activityScore, expected.activityScore)) counterDrift.push("activity_score");
    const drift: MemberDrift = { messages: driftedMessages, counters: counterDrift, daily: !dailyEqual(m.daily, h.daily), behavior: !behaviorEqual(m.behavior, h.behavior) };
    const hasDrift = drift.messages > 0 || drift.counters.length > 0 || drift.daily || drift.behavior;

    const botLike = BOT_LIKE_NAME.test(m.displayName);
    const eligible = m.status === "OK" && expected.qualifying >= threshold;
    const eligibleByStoredCounters = m.status === "OK" && m.counters.qualifying >= threshold;
    const hasHero = m.hero !== null;
    const blocked: BlockedReason | null = !eligible || hasHero
      ? null
      : input.excludeIds?.has(m.userId)
        ? "OPERATOR_EXCLUDED"
        : botLike && !input.confirmedHumanIds?.has(m.userId)
          ? "BOT_LIKE_NAME_UNCONFIRMED"
          : null;
    const wouldCreate = eligible && !hasHero && blocked === null;

    let preview: BackfillHeroPreview | null = null;
    if (input.preview && eligible && !hasHero) {
      const gen = () => generateCharacter({
        telegramUserId: m.userId, displayName: m.displayName || m.username || "", behavior: h.behavior, activityScore,
        classes: input.preview!.classes, settings, secret: input.preview!.classRollSecret,
      });
      const a = gen();
      const b = gen();
      const heroName = a.name;
      preview = {
        userId: m.userId, name: heroName, qualifying: expected.qualifying, activityScore, classId: a.classId,
        classValid: input.preview.classes.some((c) => c.id === a.classId), rarity: a.rarity, rarityValid: RARITIES.includes(a.rarity),
        sprite: a.sprite, appearanceSeed: a.appearanceSeed,
        statsValid: validGeneratedStats(a, input.preview!.classes.find((c) => c.id === a.classId)), power: a.power, appearanceValid: validAppearance(a.appearance),
        spriteValid: spriteConfigSchema.safeParse(a.sprite).success,
        deterministic: JSON.stringify(a) === JSON.stringify(b),
        nameFromFallback: /^Wanderer \d{4}$/.test(heroName) && heroName !== m.displayName,
      };
    }

    members.push({
      userId: m.userId, displayName: m.displayName, status: m.status, stored: m.counters, expected, drift, hasDrift,
      eligible, eligibleByStoredCounters, hasHero, botLike, blocked, wouldCreate, preview,
    });
  }

  const eligibleIds = members.filter((x) => x.eligible).map((x) => x.userId).sort((a, b) => a - b);
  const eligibleStoredIds = members.filter((x) => x.eligibleByStoredCounters).map((x) => x.userId).sort((a, b) => a - b);
  const heroes = members.filter((x) => x.wouldCreate && x.preview).map((x) => x.preview as BackfillHeroPreview).sort((a, b) => b.qualifying - a.qualifying || a.userId - b.userId);
  const okMembers = members.filter((x) => x.status === "OK");

  const byName = new Map<string, number[]>();
  for (const x of members) if (x.eligible) byName.set(x.displayName.trim().toLowerCase(), [...(byName.get(x.displayName.trim().toLowerCase()) ?? []), x.userId]);

  return {
    threshold,
    members,
    heroes,
    totals: {
      membersConsidered: members.length,
      messagesConsidered,
      storedQualifying,
      rescoredQualifying,
      storedRejected: messagesConsidered - storedQualifying,
      rejectedByReason,
      eligible: eligibleIds.length,
      eligibleByStoredCounters: eligibleStoredIds.length,
      eligibilitySetsMatch: eligibleIds.length === eligibleStoredIds.length && eligibleIds.every((id, i) => id === eligibleStoredIds[i]),
      heroesPresent: members.filter((x) => x.hasHero).length,
      heroesNoLongerEligible: members.filter((x) => x.hasHero && !x.eligible).length,
      wouldCreate: members.filter((x) => x.wouldCreate).length,
      nearMiss: okMembers.filter((x) => x.expected.qualifying >= threshold - 10 && x.expected.qualifying < threshold).length,
      nonOkMembers: members.length - okMembers.length,
      driftMembers: okMembers.filter((x) => x.hasDrift).length,
      driftMessages: okMembers.reduce((n, x) => n + x.drift.messages, 0),
      blockedOperator: members.filter((x) => x.blocked === "OPERATOR_EXCLUDED").length,
      blockedBotLike: members.filter((x) => x.blocked === "BOT_LIKE_NAME_UNCONFIRMED").length,
    },
    distribution: DISTRIBUTION_STEPS.map((atLeast) => ({ atLeast, users: members.filter((x) => x.expected.qualifying >= atLeast).length })),
    nonOk: members
      .filter((x) => x.status !== "OK")
      .map((x) => ({ userId: x.userId, name: x.displayName, status: x.status, total: x.expected.total, storedQualifying: x.stored.qualifying, reason: input.members.find((s) => s.userId === x.userId)?.flagReason ?? null }))
      .sort((a, b) => a.userId - b.userId),
    ambiguous: {
      botLike: members
        .filter((x) => x.botLike)
        .map((x) => ({ userId: x.userId, name: x.displayName, total: x.expected.total, qualifying: x.expected.qualifying, eligible: x.eligible, hasHero: x.hasHero }))
        .sort((a, b) => b.qualifying - a.qualifying),
      duplicateEligibleNames: [...byName].filter(([, ids]) => ids.length > 1).map(([name, userIds]) => ({ name, userIds })),
      fallbackNames: members
        .filter((x) => x.eligible && !x.hasHero && x.preview?.nameFromFallback)
        .map((x) => ({ userId: x.userId, displayName: x.displayName, heroName: (x.preview as BackfillHeroPreview).name })),
    },
  };
}
