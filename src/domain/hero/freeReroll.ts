import { RARITIES, type Rarity } from "../character/appearance";
import { nextUtcMidnight, utcDate } from "../rewards/time";
import type { ClassDef } from "../rules";
import type { CharacterSettings } from "../settings";
import { STAT_KEYS } from "../stats";

import type { HeroCardModel } from "./card";
import { HERO_GENERATOR_VERSION, statBounds, type HeroVersionState } from "./heroVersion";
import { computeHeroPower } from "./power";
import { isPowerInBand, rarityLabel, rarityRank, RARITY_RULES } from "./rarity";
import { rarityOdds } from "./rerollFairness";

/**
 * THE FREE DAILY HERO REROLL — the pure rules (docs/HERO_FREE_REROLL.md).
 *
 * One free reroll per member per UTC CALENDAR DAY: the allowance resets at 00:00 UTC, never 24 hours after the last use. A reroll draws a brand-new
 * hero from the SAME generator that creates every hero (same class odds, same rarity weights, same PWR bands — nothing is boosted, nothing is hidden),
 * and it can land lower as easily as higher. The server decides everything here; a browser only ever asks "reroll my hero" with an idempotency key.
 */

/** The feature flag. A missing flag is OFF. */
export const FREE_REROLL_FLAG = "hero.free_reroll";

/** The UTC day an instant belongs to ("2026-10-09") and the instant the NEXT allowance arrives (the next 00:00 UTC). */
export const rerollDay = (ms: number): string => utcDate(ms);
export const nextRerollAt = (ms: number): number => nextUtcMidnight(ms);

export type FreeRerollState =
  /** The feature is switched off (flag) — a truthful "not open yet", never a clickable button. */
  | "DISABLED"
  /** The feature is on but cannot run right now (the database migration is not applied yet / the server could not be reached). */
  | "UNAVAILABLE"
  /** Today's free reroll is available. */
  | "AVAILABLE"
  /** Today's free reroll has been used: a countdown to the next 00:00 UTC. */
  | "USED"
  /** The member has no hero they can reroll right now (see `block`). */
  | "BLOCKED";

/** Why a reroll cannot be done now. None of these consumes the allowance. */
export type FreeRerollBlock =
  | "NOT_SIGNED_IN"
  | "NO_HERO"
  /** The hero exists but has not been claimed by its member yet: claim it first (a Telegram sign-in proves the member, the claim proves ownership of the hero). */
  | "NOT_CLAIMED"
  /** Suspended / inactive hero, or a member whose account is under review: told as one plain sentence, never with a reason. */
  | "HERO_UNAVAILABLE"
  /** The hero is part of a committed Arena roster (the fight on stage, the upcoming one, or the prepared one). It frees up when those fights settle. */
  | "HERO_IN_ARENA";

export const BLOCK_MESSAGE: Record<FreeRerollBlock, string> = {
  NOT_SIGNED_IN: "Sign in with Telegram to use your free reroll.",
  NO_HERO: "You don't have a hero yet.",
  NOT_CLAIMED: "Claim your hero to use your free reroll.",
  HERO_UNAVAILABLE: "Your hero can't be rerolled right now.",
  HERO_IN_ARENA: "Your hero is lined up for a live Arena fight. Try again once the upcoming fights have finished — your free reroll is still waiting.",
};

/** Machine codes the API returns (stable; the UI maps them to words). */
export type FreeRerollErrorCode =
  | "UNAUTHENTICATED"
  | "FREE_REROLL_DISABLED"
  | "FREE_REROLL_UNAVAILABLE"
  | "ALREADY_USED_TODAY"
  | "REQUEST_CONFLICT"
  | "INVALID_ROLL"
  | FreeRerollBlock;

/** A client's idempotency key for one reroll attempt: a random UUID the browser makes when the confirmation is opened. */
export const REROLL_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The actor written on a member-made version and in the audit log. */
export const memberActor = (telegramUserId: number): string => `member:${telegramUserId}`;

// ---------------------------------------------------------------------------------------------------------------------
// What a reroll did — the honest comparison the result screen shows
// ---------------------------------------------------------------------------------------------------------------------
export type RarityChange = "HIGHER" | "LOWER" | "SAME";

export interface RerollComparison {
  powerBefore: number;
  powerAfter: number;
  /** after − before: negative when the new hero is weaker. */
  powerDelta: number;
  rarityBefore: Rarity;
  rarityAfter: Rarity;
  rarityChange: RarityChange;
  classChanged: boolean;
  /** One plain word for the headline: a reroll is never presented as an upgrade unless it was one. */
  verdict: "STRONGER" | "WEAKER" | "SAME_POWER";
}

export function compareRerolled(before: Pick<HeroCardModel, "power" | "rarity" | "classId">, after: Pick<HeroCardModel, "power" | "rarity" | "classId">): RerollComparison {
  const powerDelta = after.power - before.power;
  const r = rarityRank(after.rarity) - rarityRank(before.rarity);
  return {
    powerBefore: before.power,
    powerAfter: after.power,
    powerDelta,
    rarityBefore: before.rarity,
    rarityAfter: after.rarity,
    rarityChange: r > 0 ? "HIGHER" : r < 0 ? "LOWER" : "SAME",
    classChanged: before.classId !== after.classId,
    verdict: powerDelta > 0 ? "STRONGER" : powerDelta < 0 ? "WEAKER" : "SAME_POWER",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The wire shapes (display strings only: no Telegram id, no seed, no database id)
// ---------------------------------------------------------------------------------------------------------------------
export interface FreeRerollResultDto {
  /** The idempotency key this reroll was made with. */
  requestId: string;
  /** True when this exact request had already been applied (a double click / a retry): nothing new was written this time. */
  alreadyApplied: boolean;
  /** When the reroll happened (server clock, ms). */
  rerolledAt: number;
  /** The hero BEFORE and AFTER, drawn from the two stored versions — so a retry or a refresh shows the same pair, never a mixture. */
  before: HeroCardModel;
  after: HeroCardModel;
  comparison: RerollComparison;
}

/** The odds of ONE roll, as the server's generator uses them (the same for a reroll and for a brand-new hero), for the confirmation to state plainly. */
export interface RerollOddsView {
  rarity: Rarity;
  label: string;
  /** Whole-number percent for display ("70"); a fraction only when the odds are not whole ("0.5"). */
  percent: string;
}

export function rerollOddsView(weights: Readonly<Record<Rarity, number>>): RerollOddsView[] {
  const odds = rarityOdds(weights);
  return RARITIES.map((rarity) => {
    const p = odds[rarity] * 100;
    return { rarity, label: rarityLabel(rarity), percent: Math.abs(p - Math.round(p)) < 0.05 ? String(Math.round(p)) : p.toFixed(1) };
  });
}

export interface FreeRerollStatusDto {
  state: FreeRerollState;
  /** The server's clock when this was built — the browser anchors every countdown to it, never to its own wall clock. */
  serverNow: number;
  /** The UTC day the allowance counts for ("2026-10-09"), for the exact-time details only. */
  utcDay: string;
  /** The next 00:00 UTC (ms): when a used allowance comes back. */
  nextResetAt: number;
  block: FreeRerollBlock | null;
  message: string | null;
  /** The hero as it is NOW (public-safe card model), when the member has one. */
  current: HeroCardModel | null;
  /** Today's reroll, when the allowance has been used (so a refresh, a second tab or an uncertain network answer can show what really happened). */
  today: FreeRerollResultDto | null;
  /** The rarity odds of one roll (the generator's own, unchanged). */
  odds: RerollOddsView[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation of a freshly rolled state — the generator is trusted, but a bad roll must never become a version
// ---------------------------------------------------------------------------------------------------------------------

/** Returns the reason a rolled state is not a valid hero-gen/2 hero, or null when it is. */
export function rolledStateProblem(state: HeroVersionState, classes: readonly ClassDef[], settings: CharacterSettings): string | null {
  if (state.generatorVersion !== HERO_GENERATOR_VERSION) return `generator ${state.generatorVersion} is not the current generator`;
  const classDef = classes.find((c) => c.id === state.classId);
  if (!classDef) return `class ${state.classId} is not an enabled class`;
  if (!(RARITIES as readonly string[]).includes(state.rarity) || !RARITY_RULES[state.rarity]) return `rarity ${String(state.rarity)} does not exist`;
  if (!Number.isInteger(state.power)) return "PWR is not a whole number";
  if (!isPowerInBand(state.rarity, state.power)) return `PWR ${state.power} is outside the ${state.rarity} band ${RARITY_RULES[state.rarity].powerMin}–${RARITY_RULES[state.rarity].powerMax}`;
  for (const key of STAT_KEYS) if (!Number.isFinite(state.stats[key]) || state.stats[key] < 1) return `stat ${key} is not a positive number`;
  if (computeHeroPower(state.stats, state.classId) !== state.power) return "PWR is not the power of the rolled stats";
  const { min, max } = statBounds(classDef, settings, state.rarity, state.generatorVersion);
  for (const key of STAT_KEYS) if (state.stats[key] < min[key] || state.stats[key] > max[key]) return `stat ${key} (${state.stats[key]}) is outside the generator's bounds ${min[key]}–${max[key]}`;
  if (state.sprite === null) return "the roll has no sprite";
  return null;
}
