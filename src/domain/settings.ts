import { z } from "zod";

import { STAT_KEYS } from "./stats";

/**
 * Every tunable number in the game. Stored in `game_settings` (one row per top-level key),
 * edited through the admin API (validated by these schemas, versioned, audit-logged) and
 * seeded from DEFAULT_SETTINGS. Nothing in the engines hard-codes balance values.
 */

/** Drops a retired key from a parsed settings object (see the `@deprecated` fields below). */
function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

const statWeights = z.strictObject(Object.fromEntries(STAT_KEYS.map((k) => [k, z.number().min(0).max(1000)])) as Record<(typeof STAT_KEYS)[number], z.ZodNumber>);

export const telegramSettingsSchema = z.strictObject({
  qualifyingThreshold: z.number().int().min(1).max(10000),
  minWords: z.number().int().min(1).max(50),
  minChars: z.number().int().min(1).max(500),
  shortMessageWords: z.number().int().min(1).max(100),
  maxQualifyingPerDay: z.number().int().min(1).max(1000),
  minGapMs: z.number().int().min(0).max(120000),
  burstWindowMs: z.number().int().min(1000).max(3600000),
  burstMax: z.number().int().min(1).max(500),
  duplicateWindowHours: z.number().min(0).max(24 * 365),
  lowValueRatioMax: z.number().min(0).max(1),
  minUniqueWordRatio: z.number().min(0).max(1),
  lowValueTokens: z.array(z.string().min(1).max(30)).max(500),
  weights: z.strictObject({
    base: z.number().min(0).max(5),
    short: z.number().min(0).max(5),
    replyBonus: z.number().min(0).max(2),
    questionBonus: z.number().min(0).max(2),
    max: z.number().min(0).max(5),
  }),
  reactionsPerReactorPerDay: z.number().int().min(0).max(1000),
  autoFlag: z.strictObject({
    enabled: z.boolean(),
    minMessages: z.number().int().min(5).max(100000),
    spamRatio: z.number().min(0.1).max(1),
  }),
  activity: z.strictObject({
    weights: z.strictObject({
      messages: z.number().min(0).max(1),
      days: z.number().min(0).max(1),
      conversation: z.number().min(0).max(1),
      engagement: z.number().min(0).max(1),
      quality: z.number().min(0).max(1),
    }),
    saturation: z.strictObject({
      messages: z.number().positive(),
      days: z.number().positive(),
      conversation: z.number().positive(),
      engagement: z.number().positive(),
    }),
  }),
});

export const characterSettingsSchema = z.strictObject({
  /** @deprecated Permanent character levels were removed. Tolerated so stored settings rows still parse; always stripped. */
  levelCap: z.unknown().optional(),
  classInfluence: z.number().min(0).max(0.5),
  classAffinityScale: z.number().min(0).max(10),
  variation: z.strictObject({
    stat: z.number().int().min(0).max(10),
    hp: z.number().int().min(0).max(40),
    maxNetShift: z.number().int().min(0).max(30),
    /** Hard bound on |Δ POWER| the roll may cause, so no hero starts meaningfully stronger than a peer. */
    maxPowerShift: z.number().min(0).max(100),
  }),
  telegramBonus: z.strictObject({
    maxPoints: z.number().min(0).max(30),
    hpPerPoint: z.number().min(0).max(20),
    curve: z.number().min(0.1).max(3),
  }),
  rarityWeights: z.strictObject({
    COMMON: z.number().min(0),
    RARE: z.number().min(0),
    EPIC: z.number().min(0),
    LEGENDARY: z.number().min(0),
  }),
  power: statWeights,
  nameMaxLength: z.number().int().min(6).max(40),
}).transform((v) => without(v, "levelCap"));

export const holdingsSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxBonusPoints: z.number().min(0).max(60),
  hpPerPoint: z.number().min(0).max(20),
  weights: z.strictObject({ value: z.number().min(0), supply: z.number().min(0), count: z.number().min(0) }),
  saturation: z.strictObject({
    valueQuote: z.number().positive(),
    supplyFraction: z.number().positive().max(1),
    count: z.number().positive(),
  }),
  distribution: z.strictObject({ hp: z.number().min(0), def: z.number().min(0), luck: z.number().min(0), primary: z.number().min(0) }),
  /** Balances below this fraction of supply are treated as dust. */
  dustSupplyFraction: z.number().min(0).max(0.01),
  syncMinIntervalSeconds: z.number().int().min(0).max(86400),
});

export const loyaltySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** A streak survives as long as balance stays >= retainFraction * peak balance. */
  retainFraction: z.number().min(0.01).max(1),
  /** If no verified snapshot exists for longer than this, the streak restarts (history unknown). */
  maxVerifyGapHours: z.number().min(1).max(24 * 60),
  maxPoints: z.number().min(0).max(30),
  milestones: z
    .array(z.strictObject({ days: z.number().int().min(1).max(3650), points: z.number().min(0).max(30), badge: z.string().min(1).max(40) }))
    .max(20),
  distribution: z.strictObject({ hp: z.number().min(0), def: z.number().min(0) }),
});

export const tradingSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxPoints: z.number().min(0).max(10),
  /** Counting distinct trade DAYS (not raw trade count) resists wash-trading. */
  saturation: z.strictObject({ tradeDays: z.number().positive(), volumeQuote: z.number().positive(), tokens: z.number().positive() }),
  weights: z.strictObject({ tradeDays: z.number().min(0), volume: z.number().min(0), tokens: z.number().min(0) }),
  minTradeQuote: z.number().min(0),
  distribution: z.strictObject({ luck: z.number().min(0), agi: z.number().min(0) }),
});

/**
 * Seasonal ladder tiers. Status only: a tier is derived from the points a hero has earned THIS
 * season (points reset with the season), and it never feeds stats, POWER or combat.
 * Names and thresholds are data — admins can retune them without a deploy.
 */
export const seasonRankTierSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,23}$/),
  name: z.string().min(1).max(24),
  minPoints: z.number().int().min(0).max(10_000_000),
});
export type SeasonRankTier = z.infer<typeof seasonRankTierSchema>;

export const DEFAULT_SEASON_RANKS: SeasonRankTier[] = [
  { id: "bronze", name: "Bronze", minPoints: 0 },
  { id: "silver", name: "Silver", minPoints: 200 },
  { id: "gold", name: "Gold", minPoints: 600 },
  { id: "diamond", name: "Diamond", minPoints: 1500 },
  { id: "clanker", name: "Clanker", minPoints: 3000 },
];

export const progressionSettingsSchema = z
  .strictObject({
    /** @deprecated Permanent XP was removed. Tolerated so stored settings rows still parse; always stripped. */
    xp: z.unknown().optional(),
    gold: z.strictObject({
      participation: z.number().int().min(0),
      placement: z.array(z.number().int().min(0)).length(8),
      elimination: z.number().int().min(0),
    }),
    /** Season points per placement (1st → 8th). Seasonal only — they reset with the season. */
    seasonPoints: z.array(z.number().int().min(0)).length(8),
    seasonRanks: z
      .array(seasonRankTierSchema)
      .min(1)
      .max(12)
      .default(() => DEFAULT_SEASON_RANKS.map((t) => ({ ...t })))
      .superRefine((tiers, ctx) => {
        if (tiers[0] && tiers[0].minPoints !== 0) ctx.addIssue({ code: "custom", message: "the lowest season rank must start at 0 points" });
        for (let i = 1; i < tiers.length; i++) {
          if ((tiers[i] as SeasonRankTier).minPoints <= (tiers[i - 1] as SeasonRankTier).minPoints) ctx.addIssue({ code: "custom", message: "season rank thresholds must strictly increase" });
        }
        if (new Set(tiers.map((t) => t.id)).size !== tiers.length) ctx.addIssue({ code: "custom", message: "season rank ids must be unique" });
      }),
    drops: z.strictObject({
      enabled: z.boolean(),
      chanceByPlacement: z.array(z.number().min(0).max(1)).length(8),
      rarityWeights: z.strictObject({
        COMMON: z.number().min(0),
        UNCOMMON: z.number().min(0),
        RARE: z.number().min(0),
        EPIC: z.number().min(0),
        LEGENDARY: z.number().min(0),
      }),
    }),
  })
  .transform((v) => without(v, "xp"));

export const arenaSettingsSchema = z.strictObject({
  groupSize: z.number().int().min(2).max(16),
  introMs: z.number().int().min(0).max(30000),
  countdownMs: z.number().int().min(0).max(30000),
  maxCombatMs: z.number().int().min(1000).max(120000),
  victoryHoldMs: z.number().int().min(0).max(30000),
  resultsMs: z.number().int().min(0).max(60000),
  /** If the schedule is later than this, the next battle is re-anchored to "now". */
  staleAnchorMs: z.number().int().min(0).max(3600000),
  battleHistoryKeep: z.number().int().min(10).max(100000),
});

/**
 * Free arena picks. A pick is "who do you think wins this battle?" — no stake, no loss, no
 * custody. A correct pick can pay a SMALL off-chain Clank Gold reward (0 disables rewards; the
 * on/off switch itself is the `arena.picks` feature flag).
 */
export const picksSettingsSchema = z.strictObject({
  rewardGold: z.number().int().min(0).max(1000),
});

/**
 * ARENA PICKS rewards ($CLANKRPG). Picks are FREE and UNLIMITED — nothing is staked, deposited or wagered, and a wrong pick
 * costs nothing. NO token is emitted per battle. EVERY valid pick counts: a correct pick earns leaderboard POINTS, there is no
 * daily cap, and the DAILY and WEEKLY leaderboards are a race for the most correct picks that pays their Top 10 a fixed
 * prize pool. Holding $CLANKRPG changes exactly one thing: a BONUS (a percentage) on a leaderboard prize the member actually
 * earned, and only with verified holding continuity from BEFORE the period began (see `holderBonusTiers`).
 *
 * Token amounts are DECIMAL STRINGS of whole tokens ("100000", never a float): the server converts them to integer base
 * units with the token's real decimals (BigInt) and never lets a JavaScript number touch a token quantity. This is the
 * ONE authoritative place the prize sizes, the ladder and the bonus tiers live — the UI and the server both read it.
 *
 * Whether on-chain claims can be PAID is a manual admin process (see server/rewards/claims.ts); these numbers alone never move
 * a token. Prizes keep accumulating as claimable balances either way.
 */
const tokenAmount = z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/, "a decimal amount of whole tokens, e.g. \"10000\"");

/** Settings keys of the superseded per-battle / holder-allowance design. A stored row that still has any of them is UPGRADED (see below). */
const RETIRED_ARENA_PICKS_KEYS = ["rewardPerBattle", "dailyEmissionCap", "holderTiers", "holderTierActivationHours", "weeklyScoredPicksPerDay", "weeklyPrizeSplitBps", "scoredPicksPerDay", "dailyMinimumScoredPicks", "weeklyMinimumScoredPicks"] as const;

const arenaPicksBaseSchema = z.strictObject({
  /** Leaderboard PRIZES on/off. Off = picks and scoring continue and the boards show, but a finalized period awards no prize (a zero pool is frozen with it). */
  enabled: z.boolean(),
  /** Smallest balance that can be claimed. Below it the reward keeps accumulating (it is never discarded). */
  minimumClaim: tokenAmount,
  /** Leaderboard Points a CORRECT SCORED pick earns (never multiplied by holdings). 0 disables scoring. */
  pointsPerCorrectPick: z.number().int().min(0).max(100_000),
  /** Whole $CLANKRPG paid by the DAILY leaderboard (UTC day). Fixed; never rolls over. */
  dailyPrizePool: tokenAmount,
  /** Whole $CLANKRPG paid by the WEEKLY leaderboard (Monday 00:00 UTC → next Monday). Fixed; never rolls over. */
  weeklyPrizePool: tokenAmount,
  /** The payout ladder by prize position, in basis points of a pool (3000 = 30%). ONE ladder serves both boards. Positions beyond the list win nothing; the total may not exceed 10000. */
  prizeSplitBps: z
    .array(z.number().int().min(1).max(10_000))
    .min(1)
    .max(10)
    .refine((a) => a.reduce((x, y) => x + y, 0) <= 10_000, "the prize ladder cannot exceed 100%"),
  /** Valid picks a member needs in the UTC day to be prize-eligible (below it they still appear on the board, marked NOT YET PRIZE ELIGIBLE). */
  dailyMinimumPicks: z.number().int().min(0).max(100_000),
  /** Valid picks a member needs in the UTC week to be prize-eligible. */
  weeklyMinimumPicks: z.number().int().min(0).max(100_000),
  /**
   * Holder PRIZE BONUS tiers: the verified balance → a bonus (basis points) ADDED on top of a leaderboard prize the member
   * earned (30,000 + 25% = 37,500). The bonus is extra: it never reduces anyone else's base prize, and tiers change nothing else
   * — not picks, scored picks, Points, accuracy, rank, tie-breaks or combat. The first tier must start at "0" with a 0% bonus (FREE).
   */
  holderBonusTiers: z
    .array(z.strictObject({ minimum: tokenAmount, bonusBps: z.number().int().min(0).max(10_000) }))
    .min(1)
    .max(12)
    .superRefine((tiers, ctx) => {
      const first = tiers[0];
      if (!first || Number(first.minimum) !== 0 || first.bonusBps !== 0) ctx.addIssue({ code: "custom", message: "the first tier must start at 0 with a 0% bonus (FREE)" });
      for (let i = 1; i < tiers.length; i++) {
        const prev = tiers[i - 1] as (typeof tiers)[number];
        const cur = tiers[i] as (typeof tiers)[number];
        if (!(Number(cur.minimum) > Number(prev.minimum))) ctx.addIssue({ code: "custom", message: "tier minimums must be strictly increasing" });
        if (cur.bonusBps < prev.bonusBps) ctx.addIssue({ code: "custom", message: "a higher tier cannot pay a smaller bonus" });
      }
    }),
  /** DAILY bonus: the wallet must have shown VERIFIED holding continuity for this many hours BEFORE the UTC day starts, and keep it until the day is finalized. */
  holderDailyQualifyHours: z.number().int().min(0).max(720),
  /** WEEKLY bonus: the same, before the week starts (default 168 h = 7 days) and throughout the week. */
  holderWeeklyQualifyHours: z.number().int().min(0).max(2160),
  /** The background verification re-reads a connected wallet's balance about this often (the 1-minute tick only processes wallets whose `next_check_at` is due). */
  holderRefreshMinutes: z.number().int().min(5).max(1440),
  /** ± percent of random jitter on each wallet's next check, so every wallet does not refresh in the same minute. */
  holderRefreshJitterPct: z.number().int().min(0).max(50),
  /** At most this many wallets are re-verified per tick (a bounded batch — never every wallet every minute). */
  holderCheckBatchSize: z.number().int().min(1).max(500),
  /**
   * Freshness window. Two verifications further apart than this CANNOT prove the wallet held in between: continuity restarts
   * (the member is NEEDS VERIFICATION until the next check, and the clock starts again). A stale verification never grants a bonus.
   */
  holderMaxAgeHours: z.number().int().min(1).max(168),
  /** Minimum seconds between two manual "Refresh holdings" requests of one member. */
  holderManualRefreshSeconds: z.number().int().min(5).max(3600),
  /** If the final close verification of a prize winner fails, the bonus stays PENDING VERIFICATION this long (the base prize is never delayed); then it expires. */
  holderReconcileHours: z.number().int().min(1).max(720),
  /** Confirmations a claim transfer needs before it counts as claimed. */
  minConfirmations: z.number().int().min(1).max(64),
  /** A signed-in session older than this may not change the holder wallet (fresh Telegram sign-in required). */
  walletChangeFreshMinutes: z.number().int().min(1).max(1440),
  /** Admin PLANNING metrics only (nothing is minted or reserved by them): the length of Season 1 in weeks and the reward allocation it must fit in. */
  seasonPlanWeeks: z.number().int().min(1).max(104),
  seasonRewardAllocation: tokenAmount,
});

type ArenaPicksInput = z.input<typeof arenaPicksBaseSchema>;

/**
 * A stored `arena_picks` row written by the superseded design (per-battle pool, tiered daily token wins, a 100,000 weekly pool) is
 * upgraded on read: the retired keys are dropped, and the economy numbers that belonged to it (pools, ladder, minimums) take the
 * FINAL defaults instead of silently surviving. Operational knobs the admin may have tuned (refresh cadence, freshness, claim
 * minimum, confirmations) carry over. The migration (…001400) performs the same rewrite on the stored row.
 */
export function upgradeLegacyArenaPicks(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const stored = raw as Record<string, unknown>;
  if (!RETIRED_ARENA_PICKS_KEYS.some((k) => k in stored)) return raw;
  const d = DEFAULT_ARENA_PICKS;
  const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => !(RETIRED_ARENA_PICKS_KEYS as readonly string[]).includes(k)));
  return {
    ...d,
    ...kept,
    dailyPrizePool: d.dailyPrizePool,
    weeklyPrizePool: d.weeklyPrizePool,
    prizeSplitBps: d.prizeSplitBps,
    dailyMinimumPicks: d.dailyMinimumPicks,
    weeklyMinimumPicks: d.weeklyMinimumPicks,
  };
}

export const arenaPicksSettingsSchema = z.preprocess(
  upgradeLegacyArenaPicks,
  arenaPicksBaseSchema.superRefine((v, ctx) => {
    // There is NO per-day scoring cap, so a minimum is only a participation bar: any number a member can reach by picking is valid.
    // Verifications that are legitimately ~refresh minutes apart must not look like a gap.
    if (v.holderMaxAgeHours * 60 < v.holderRefreshMinutes * 2) ctx.addIssue({ code: "custom", path: ["holderMaxAgeHours"], message: "must be at least twice the refresh interval, or every wallet's continuity would break on its own" });
  }),
) as z.ZodType<z.output<typeof arenaPicksBaseSchema>, ArenaPicksInput | Record<string, unknown>>;

/** Visual configuration: which sprite set the clients load and which cosmetics are switched off. */
export const visualSettingsSchema = z.strictObject({
  spriteSet: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
  disabledCosmetics: z.array(z.string().min(3).max(60)).max(500),
});

const tacticTuning = z.strictObject({
  lowHpTargeting: z.number().min(-2).max(2),
  retreatHp: z.number().min(0).max(1),
  defensiveSkillHp: z.number().min(0).max(1),
  engageBonus: z.number().min(-1).max(1),
});

/**
 * @deprecated The shrinking "storm ring" was removed from the Arena (combat rules 2.0.0: a STATIC arena boundary, no
 * zone damage, no forced movement toward the centre). The shape survives ONLY so that battles stored under rules 1.0.0
 * keep replaying byte-for-byte: their ruleset snapshots still carry it, and the engine reads it solely for those.
 * New battles never have it (see `combatSettingsSchema`, which strips it from stored/edited settings).
 */
const legacyRingSchema = z.strictObject({
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(1),
  minRadius: z.number().positive(),
  damagePctPerSec: z.number().min(0),
  damageRampPerSec: z.number().min(0),
});

const combatBaseSchema = z.strictObject({
  tickMs: z.number().int().min(20).max(1000),
  arenaRadius: z.number().positive(),
  startRadius: z.number().positive(),
  unitRadius: z.number().positive(),
  retargetTicks: z.number().int().min(1).max(100),
  hpScale: z.number().positive(),
  derive: z.strictObject({
    atkPerStr: z.number().positive(),
    atkPerInt: z.number().positive(),
    defK: z.number().positive(),
    maxDamageReduction: z.number().min(0).max(0.95),
    magicPenetration: z.number().min(0).max(1),
    critPerLuck: z.number().min(0),
    maxCrit: z.number().min(0).max(1),
    critMultiplier: z.number().min(1).max(5),
    dodgePerAgi: z.number().min(0),
    dodgePerLuck: z.number().min(0),
    maxDodge: z.number().min(0).max(0.9),
    attackSpeedPerAgi: z.number().min(0),
    moveSpeedPerAgi: z.number().min(0),
    cooldownReductionPerCha: z.number().min(0),
    maxCooldownReduction: z.number().min(0).max(0.9),
    damageVariance: z.number().min(0).max(0.5),
  }),
  /**
   * Plant-to-fire: a RANGED fighter cannot move for this long after loosing a basic attack (shots are not free while running).
   * It is what keeps spacing a skill rather than free damage now that there is no shrinking ring — kiting costs uptime, and
   * the finite wall does the rest. Applies to every ranged class equally; 0 turns it off. Rules 2.0.0+.
   */
  rangedPlantMs: z.number().int().min(0).max(1000).default(100),
  /**
   * PACE (rules 3.0.0+): global slow-motion multipliers that lengthen fights WITHOUT editing a single class or skill. `time`
   * stretches every duration the classes define — basic-attack interval, skill cooldowns and cast times, stun / slow / shield /
   * buff / taunt / empower durations, the ranged plant — and divides regeneration, so every class keeps its relation to every
   * other class while everything simply takes `time`× longer. `move` slows walking and projectile flight. 1 / 1 is the rules
   * exactly as before: every ruleset stored before 3.0.0 has no `pace` and replays with this default, bit for bit.
   */
  pace: z.strictObject({ time: z.number().min(0.25).max(4), move: z.number().min(0.25).max(4) }).default({ time: 1, move: 1 }),
  /** @deprecated see `legacyRingSchema`. Optional, ignored by every ruleset newer than 1.0.0. */
  ring: legacyRingSchema.optional(),
  overtime: z.strictObject({ startMs: z.number().int().min(0), damageRampPerSec: z.number().min(0) }),
  tactics: z.strictObject({ AGGRESSIVE: tacticTuning, BALANCED: tacticTuning, DEFENSIVE: tacticTuning }),
});

/** Stored / edited combat SETTINGS: a retired `ring` (from an old settings row) is accepted and always stripped. */
export const combatSettingsSchema = combatBaseSchema.transform((v) => without(v, "ring"));
/** The combat block of a ruleset SNAPSHOT: keeps `ring`, so old battles still replay exactly. */
export const rulesetCombatSchema = combatBaseSchema;

export const settingsSchemas = {
  telegram: telegramSettingsSchema,
  character: characterSettingsSchema,
  holdings: holdingsSettingsSchema,
  loyalty: loyaltySettingsSchema,
  trading: tradingSettingsSchema,
  progression: progressionSettingsSchema,
  arena: arenaSettingsSchema,
  combat: combatSettingsSchema,
  picks: picksSettingsSchema,
  arena_picks: arenaPicksSettingsSchema,
  visuals: visualSettingsSchema,
} as const;

export type SettingsKey = keyof typeof settingsSchemas;
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;
export type CharacterSettings = z.infer<typeof characterSettingsSchema>;
export type HoldingsSettings = z.infer<typeof holdingsSettingsSchema>;
export type LoyaltySettings = z.infer<typeof loyaltySettingsSchema>;
export type TradingSettings = z.infer<typeof tradingSettingsSchema>;
export type ProgressionSettings = z.infer<typeof progressionSettingsSchema>;
export type ArenaSettings = z.infer<typeof arenaSettingsSchema>;
export type CombatSettings = z.infer<typeof combatBaseSchema>;
export type PicksSettings = z.infer<typeof picksSettingsSchema>;
export type ArenaPicksSettings = z.infer<typeof arenaPicksSettingsSchema>;
export type VisualSettings = z.infer<typeof visualSettingsSchema>;

export interface GameSettings {
  telegram: TelegramSettings;
  character: CharacterSettings;
  holdings: HoldingsSettings;
  loyalty: LoyaltySettings;
  trading: TradingSettings;
  progression: ProgressionSettings;
  arena: ArenaSettings;
  combat: CombatSettings;
  picks: PicksSettings;
  arena_picks: ArenaPicksSettings;
  visuals: VisualSettings;
}

/** The FINAL reward economy defaults (see the schema above for what each number means). */
export const DEFAULT_ARENA_PICKS: z.output<typeof arenaPicksBaseSchema> = {
  enabled: true,
  minimumClaim: "10000",
  pointsPerCorrectPick: 10,
  dailyPrizePool: "100000",
  weeklyPrizePool: "500000",
  // #1 30% · #2 20% · #3 15% · #4 10% · #5 8% · #6 6% · #7 4% · #8 3% · #9 2% · #10 2%
  prizeSplitBps: [3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200],
  dailyMinimumPicks: 20,
  weeklyMinimumPicks: 100,
  holderBonusTiers: [
    { minimum: "0", bonusBps: 0 },
    { minimum: "100000", bonusBps: 500 },
    { minimum: "500000", bonusBps: 1000 },
    { minimum: "1000000", bonusBps: 1500 },
    { minimum: "5000000", bonusBps: 2000 },
    { minimum: "10000000", bonusBps: 2500 },
  ],
  holderDailyQualifyHours: 24,
  holderWeeklyQualifyHours: 168,
  holderRefreshMinutes: 30,
  holderRefreshJitterPct: 20,
  holderCheckBatchSize: 25,
  holderMaxAgeHours: 6,
  holderManualRefreshSeconds: 300,
  holderReconcileHours: 24,
  minConfirmations: 2,
  walletChangeFreshMinutes: 15,
  seasonPlanWeeks: 12,
  seasonRewardAllocation: "20000000",
};

export const DEFAULT_SETTINGS: GameSettings = {
  telegram: {
    qualifyingThreshold: 50,
    minWords: 3,
    minChars: 12,
    shortMessageWords: 8,
    maxQualifyingPerDay: 40,
    minGapMs: 3000,
    burstWindowMs: 60_000,
    burstMax: 8,
    duplicateWindowHours: 24,
    lowValueRatioMax: 0.6,
    minUniqueWordRatio: 0.4,
    lowValueTokens: [
      "gm", "gn", "gmgm", "gngn", "lfg", "wen", "lol", "lmao", "ok", "okay", "yes", "no", "nice", "based",
      "wagmi", "hi", "hello", "yo", "fr", "true", "same", "up", "bump", "this", "moon", "pump", "lets", "go",
      "ser", "fren", "lfgg", "good", "morning", "night", "thanks", "thx", "ty", "w", "l", "bro", "bruh", "haha",
    ],
    weights: { base: 1, short: 0.7, replyBonus: 0.1, questionBonus: 0.05, max: 1.2 },
    reactionsPerReactorPerDay: 5,
    autoFlag: { enabled: true, minMessages: 40, spamRatio: 0.8 },
    activity: {
      weights: { messages: 0.35, days: 0.25, conversation: 0.15, engagement: 0.1, quality: 0.15 },
      saturation: { messages: 400, days: 45, conversation: 120, engagement: 80 },
    },
  },
  character: {
    classInfluence: 0.18,
    classAffinityScale: 2.2,
    variation: { stat: 2, hp: 5, maxNetShift: 3, maxPowerShift: 5 },
    telegramBonus: { maxPoints: 6, hpPerPoint: 3, curve: 0.8 },
    rarityWeights: { COMMON: 700, RARE: 220, EPIC: 70, LEGENDARY: 10 },
    power: { hp: 0.4, str: 2, def: 2, int: 2, agi: 2, cha: 1, luck: 1 },
    nameMaxLength: 24,
  },
  holdings: {
    enabled: true,
    maxBonusPoints: 10,
    hpPerPoint: 3,
    weights: { value: 0.4, supply: 0.35, count: 0.25 },
    saturation: { valueQuote: 2, supplyFraction: 0.02, count: 3 },
    distribution: { hp: 0.3, def: 0.3, luck: 0.1, primary: 0.3 },
    dustSupplyFraction: 0.0000001,
    syncMinIntervalSeconds: 300,
  },
  loyalty: {
    enabled: true,
    retainFraction: 0.8,
    maxVerifyGapHours: 48,
    maxPoints: 4,
    milestones: [
      { days: 1, points: 0.5, badge: "diamond_1d" },
      { days: 7, points: 1, badge: "diamond_7d" },
      { days: 30, points: 2, badge: "diamond_30d" },
      { days: 90, points: 3, badge: "diamond_90d" },
    ],
    distribution: { hp: 0.5, def: 0.5 },
  },
  trading: {
    enabled: true,
    maxPoints: 1.5,
    saturation: { tradeDays: 20, volumeQuote: 2, tokens: 3 },
    weights: { tradeDays: 0.5, volume: 0.3, tokens: 0.2 },
    minTradeQuote: 0.0005,
    distribution: { luck: 0.6, agi: 0.4 },
  },
  progression: {
    gold: { participation: 2, placement: [25, 15, 8, 4, 0, 0, 0, 0], elimination: 2 },
    seasonPoints: [10, 7, 5, 4, 3, 2, 1, 0],
    seasonRanks: DEFAULT_SEASON_RANKS,
    drops: {
      enabled: true,
      chanceByPlacement: [0.3, 0.18, 0.1, 0.06, 0.04, 0.03, 0.02, 0.02],
      rarityWeights: { COMMON: 700, UNCOMMON: 200, RARE: 80, EPIC: 18, LEGENDARY: 2 },
    },
  },
  arena: {
    groupSize: 8,
    introMs: 2500,
    countdownMs: 3000,
    maxCombatMs: 60_000,
    victoryHoldMs: 1200,
    resultsMs: 5000,
    staleAnchorMs: 20_000,
    battleHistoryKeep: 2000,
  },
  combat: {
    tickMs: 100,
    arenaRadius: 300,
    startRadius: 215,
    unitRadius: 16,
    retargetTicks: 6,
    hpScale: 1.55,
    derive: {
      atkPerStr: 0.925,
      atkPerInt: 0.925,
      defK: 55,
      maxDamageReduction: 0.7,
      magicPenetration: 0.5,
      critPerLuck: 0.006,
      maxCrit: 0.4,
      critMultiplier: 1.6,
      dodgePerAgi: 0.003,
      dodgePerLuck: 0.002,
      maxDodge: 0.25,
      attackSpeedPerAgi: 0.008,
      moveSpeedPerAgi: 0.6,
      cooldownReductionPerCha: 0.006,
      maxCooldownReduction: 0.4,
      damageVariance: 0.1,
    },
    rangedPlantMs: 100,
    pace: { time: 1.95, move: 1.1 },
    overtime: { startMs: 28_000, damageRampPerSec: 0.16 },
    tactics: {
      AGGRESSIVE: { lowHpTargeting: 0.6, retreatHp: 0, defensiveSkillHp: 0.25, engageBonus: 0.3 },
      BALANCED: { lowHpTargeting: 0, retreatHp: 0.12, defensiveSkillHp: 0.5, engageBonus: 0 },
      DEFENSIVE: { lowHpTargeting: -0.2, retreatHp: 0.35, defensiveSkillHp: 0.75, engageBonus: -0.3 },
    },
  },
  picks: { rewardGold: 2 },
  arena_picks: DEFAULT_ARENA_PICKS,
  visuals: { spriteSet: "clank-dev-v1", disabledCosmetics: [] },
};

export function parseSettings<K extends SettingsKey>(key: K, value: unknown): GameSettings[K] {
  return settingsSchemas[key].parse(value) as GameSettings[K];
}
