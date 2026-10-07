import { RARITIES, type Rarity } from "./character/appearance";
import { DEFAULT_CLASSES } from "./content/classes";
import { BUY_LABEL, CLANK_TRADE_URL } from "./rewards/buyLink";
import { DEFAULT_ARENA_PICKS, DEFAULT_HERO_ARENA, DEFAULT_SETTINGS } from "./settings";
import { POWER_RANGE, RARITY_LADDER } from "./hero/rarity";
import { RARITY_VISUALS } from "./hero/rarityVisuals";
import { STAT_KEYS, STAT_LABELS, type StatKey } from "./stats";

/**
 * THE PUBLIC GAME RULES — the one place the public pages (the docs, the FAQ, the Arena explainer) read the game's numbers from.
 *
 * Nothing here is typed in a second time: every figure is DERIVED from the same authoritative values the game itself runs on — the default
 * settings (`DEFAULT_SETTINGS`, `DEFAULT_ARENA_PICKS`), the rarity table (`RARITY_RULES`), the shared rarity visuals and the class catalogue —
 * so a documented number can never disagree with the number the game uses. If a rule changes in one of those places, every page that reads
 * this module changes with it (and a test fails if a docs page stops showing a value from here).
 *
 * PUBLIC-SAFE by construction: only things a visitor is meant to know. No seeds, no secrets, no moderation or anti-abuse thresholds, no
 * contract address (the token address is never invented — see `token`).
 *
 * The values describe the game's LAUNCH CONFIGURATION (the defaults the database is seeded with). Operators can retune settings later in the
 * Admin console; the docs describe the configuration the game ships with.
 */

const en = new Intl.NumberFormat("en-US");
export const formatWhole = (n: number | string): string => en.format(typeof n === "string" ? Number(n) : n);

/** 100000 → "100K", 5000000 → "5M". */
export function compactNumber(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}K`;
  return formatWhole(n);
}

const pct = (bps: number): number => bps / 100;

const weights = DEFAULT_SETTINGS.character.rarityWeights;
const weightTotal = RARITIES.reduce((sum, r) => sum + weights[r], 0);

const picks = DEFAULT_ARENA_PICKS;
const arena = DEFAULT_SETTINGS.arena;

export interface RarityRuleView {
  id: Rarity;
  label: string;
  rank: number;
  powerMin: number;
  powerMax: number;
  /** "130–149" */
  band: string;
  /** Share of heroes drawn at this rarity, in percent (70 · 22 · 7 · 1). */
  oddsPercent: number;
  /** What the rarity looks like, in words (the shared visual table, described). */
  visual: { frame: string; badge: string; effect: string };
}

const VISUAL_WORDS: Record<Rarity, { frame: string; badge: string; effect: string }> = {
  COMMON: { frame: "Simple, clean frame", badge: "● dot", effect: "A thin ring on the ground. Nothing more." },
  RARE: { frame: "Bevelled frame with a soft glow", badge: "◆ diamond", effect: "Blue accents, a light aura and a glowing ring, plus trim and a glint on the weapon." },
  EPIC: { frame: "Double frame with gem corners", badge: "✦ star", effect: "Violet accents, a brighter aura, runes around the ring, rising sparks, pauldrons and a glowing weapon." },
  LEGENDARY: { frame: "Ornate crowned frame", badge: "♛ crown", effect: "Gold accents, three rings, drifting embers, a crest, pauldrons, ornate trim and a blazing weapon." },
};

export interface ClassRuleView {
  id: string;
  name: string;
  role: string;
  tagline: string;
  /** The two stats the class is built around, strongest first. */
  strongest: Array<{ key: StatKey; label: string }>;
  /** "Melee" or "Ranged" — from the class's attack range. */
  reach: "Melee" | "Ranged";
}

function strongestStats(base: Record<StatKey, number>): Array<{ key: StatKey; label: string }> {
  // HP is a big number by nature, so rank it against its own scale: a class's "strongest" stats are the ones where it leads the other classes' average.
  const avg = (k: StatKey) => DEFAULT_CLASSES.reduce((s, c) => s + c.base[k], 0) / DEFAULT_CLASSES.length;
  return [...STAT_KEYS]
    .filter((k) => k !== "luck")
    .map((k) => ({ key: k, lead: base[k] / avg(k) }))
    .sort((a, b) => b.lead - a.lead)
    .slice(0, 2)
    .map(({ key }) => ({ key, label: STAT_LABELS[key] }));
}

export const GAME_RULES = Object.freeze({
  name: "Clank RPG",
  community: { name: "Clank.trade", telegramThreshold: DEFAULT_SETTINGS.telegram.qualifyingThreshold },
  hero: {
    stats: STAT_KEYS.map((k) => ({ key: k, label: STAT_LABELS[k] })),
    classCount: DEFAULT_CLASSES.length,
  },
  classes: DEFAULT_CLASSES.map<ClassRuleView>((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    tagline: c.tagline,
    strongest: strongestStats(c.base as Record<StatKey, number>),
    reach: c.attack.range >= 100 ? "Ranged" : "Melee",
  })),
  rarity: {
    ladder: RARITY_LADDER.map<RarityRuleView>((r) => ({
      id: r.id,
      label: r.label,
      rank: r.rank,
      powerMin: r.powerMin,
      powerMax: r.powerMax,
      band: `${r.powerMin}–${r.powerMax}`,
      oddsPercent: Math.round((weights[r.id] / weightTotal) * 1000) / 10,
      visual: { ...VISUAL_WORDS[r.id], badge: `${VISUAL_WORDS[r.id].badge} ${RARITY_VISUALS[r.id].label}`.trim() },
    })),
    powerMin: POWER_RANGE.min,
    powerMax: POWER_RANGE.max,
  },
  /**
   * MEASURED, not configured: facts about how the shipped rarity bands play out, taken from the balance simulation (`pnpm rarity:sim`, 10,000
   * battles per scenario, heroes of every rarity mixed together). A test re-runs a smaller simulation and fails if these drift out of tolerance,
   * so the docs can't quietly go stale when the bands or the combat rules are retuned.
   */
  balance: {
    /** In a battle with both present, how often the Legendary finishes ahead of the Common (percent). */
    legendaryOutplacesCommonPercent: 71,
  },
  arena: {
    heroesPerBattle: arena.groupSize,
    maxCombatSeconds: arena.maxCombatMs / 1000,
    countdownSeconds: arena.countdownMs / 1000,
    resultsSeconds: arena.resultsMs / 1000,
    /** The range most fights finish in on their own (measured with the balance simulation; the cap is above). */
    typicalFightSeconds: { from: 30, to: 50 },
  },
  picks: {
    pointsPerCorrectPick: picks.pointsPerCorrectPick,
    dailyMinimumPicks: picks.dailyMinimumPicks,
    weeklyMinimumPicks: picks.weeklyMinimumPicks,
    daily: { pool: picks.dailyPrizePool, poolLabel: formatWhole(picks.dailyPrizePool) },
    weekly: { pool: picks.weeklyPrizePool, poolLabel: formatWhole(picks.weeklyPrizePool) },
    /** Prize shares by position, in percent (30, 20, 15, …) — one ladder for both boards. */
    prizeLadderPercent: picks.prizeSplitBps.map(pct),
    topRewarded: picks.prizeSplitBps.length,
    /** The smallest balance a claim can be made for, in whole tokens. */
    minimumClaim: picks.minimumClaim,
    minimumClaimLabel: formatWhole(picks.minimumClaim),
  },
  /** The HERO competition (Daily / Weekly rewarded, Season standings only). Its pools are NOT a rule: they are set by the team, so none is stated anywhere. */
  heroArena: {
    minimumWins: DEFAULT_HERO_ARENA.minimumWins,
    /** Prize shares by position, in percent — the same shape of ladder as the Picks boards. */
    prizeLadderPercent: DEFAULT_HERO_ARENA.prizeSplitBps.map(pct),
    topRewarded: DEFAULT_HERO_ARENA.prizeSplitBps.length,
  },
  holderBonus: {
    /** How long before a period starts a holding must be verified for the bonus to apply (hours). */
    dailyQualifyHours: picks.holderDailyQualifyHours,
    weeklyQualifyHours: picks.holderWeeklyQualifyHours,
    tiers: picks.holderBonusTiers.map((t) => {
      const min = Number(t.minimum);
      return { minimum: min, label: min === 0 ? "FREE" : `${compactNumber(min)}+`, bonusPercent: pct(t.bonusBps) };
    }),
  },
  token: {
    symbol: "$CLANKRPG",
    buyLabel: BUY_LABEL,
    /** The exact wording the game shows while claims are closed (kept in step with the claim panel). */
    claimsClosedNotice: "CLAIMS WILL OPEN AFTER $CLANKRPG LAUNCH",
    /** The public Clank.trade site. The contract address is NEVER stated here: it appears in the BUY link only once the operator configures it. */
    siteUrl: CLANK_TRADE_URL,
  },
});

export type GameRules = typeof GAME_RULES;

/** "30%" → used by the docs prize table. */
export function prizeShare(position: number, pool: string): { percent: number; amount: number } {
  const percent = GAME_RULES.picks.prizeLadderPercent[position - 1] ?? 0;
  return { percent, amount: Math.floor((Number(pool) * percent) / 100) };
}
