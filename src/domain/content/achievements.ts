export type AchievementCriteria =
  | { metric: AchievementMetric; gte: number }
  /** Awarded by an admin / system event, never by metrics. */
  | { type: "manual" }
  /** Defined so the badge can be previewed, but cannot be earned until its system ships. */
  | { type: "locked" };

export type AchievementMetric =
  | "battles"
  | "wins"
  | "top2"
  | "eliminations"
  | "telegram_qualifying"
  | "telegram_active_days"
  | "diamond_days"
  | "bonded_tokens_held";

/**
 * The metrics that come from ARENA battles. They are counted in the ACTIVE SEASON (never from a hero's lifetime counters), and an unlock earned from
 * them during DEVELOPMENT is archived at the Season 1 launch. The other metrics (Telegram activity, holding streaks, bonded coins) come from the real
 * community and chain, not from test battles, and are permanent — as are achievements an admin granted.
 */
export const ARENA_ACHIEVEMENT_METRICS: readonly AchievementMetric[] = ["battles", "wins", "top2", "eliminations"];

/**
 * Metrics that no longer exist. Achievement rows stored before their removal can still reference
 * them (reference seeding never overwrites or deletes rows), so they are skipped when evaluating
 * and hidden from profiles instead of being left as permanently locked, unexplainable badges.
 */
export const RETIRED_ACHIEVEMENT_METRICS: readonly string[] = ["level"];

export function isRetiredAchievement(criteria: unknown): boolean {
  const metric = (criteria as { metric?: unknown } | null)?.metric;
  return typeof metric === "string" && RETIRED_ACHIEVEMENT_METRICS.includes(metric);
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  category: "ARENA" | "COMMUNITY" | "DIAMOND_HANDS" | "COLLECTION" | "SPECIAL";
  criteria: AchievementCriteria;
  /** Rewards are cosmetic: badge/title, plus an optional tiny one-off Clank Gold grant. */
  reward: { badge: string; title?: string; gold?: number };
  hidden?: boolean;
  sortOrder: number;
}

export const DEFAULT_ACHIEVEMENTS: AchievementDef[] = [
  { id: "arena_debut", name: "Arena Debut", description: "Fight your first Global Arena battle.", category: "ARENA", criteria: { metric: "battles", gte: 1 }, reward: { badge: "debut" }, sortOrder: 10 },
  { id: "arena_regular", name: "Arena Regular", description: "Fight 25 Global Arena battles.", category: "ARENA", criteria: { metric: "battles", gte: 25 }, reward: { badge: "regular", gold: 25 }, sortOrder: 11 },
  { id: "arena_veteran", name: "Arena Veteran", description: "Fight 150 Global Arena battles.", category: "ARENA", criteria: { metric: "battles", gte: 150 }, reward: { badge: "veteran", title: "Veteran", gold: 100 }, sortOrder: 12 },
  { id: "first_blood", name: "First Blood", description: "Eliminate an opponent.", category: "ARENA", criteria: { metric: "eliminations", gte: 1 }, reward: { badge: "first_blood" }, sortOrder: 20 },
  { id: "reaper", name: "Reaper", description: "Eliminate 50 opponents.", category: "ARENA", criteria: { metric: "eliminations", gte: 50 }, reward: { badge: "reaper", title: "Reaper" }, sortOrder: 21 },
  { id: "victor", name: "Victor", description: "Win a Global Arena battle.", category: "ARENA", criteria: { metric: "wins", gte: 1 }, reward: { badge: "victor", gold: 10 }, sortOrder: 30 },
  { id: "champion", name: "Champion", description: "Win 10 Global Arena battles.", category: "ARENA", criteria: { metric: "wins", gte: 10 }, reward: { badge: "champion", title: "Champion", gold: 50 }, sortOrder: 31 },
  { id: "legend_of_the_pit", name: "Legend of the Pit", description: "Win 50 Global Arena battles.", category: "ARENA", criteria: { metric: "wins", gte: 50 }, reward: { badge: "legend", title: "Legend of the Pit", gold: 250 }, sortOrder: 32 },
  { id: "podium_regular", name: "Podium Regular", description: "Finish in the top two 10 times.", category: "ARENA", criteria: { metric: "top2", gte: 10 }, reward: { badge: "podium" }, sortOrder: 33 },
  { id: "voice_of_clank", name: "Voice of Clank", description: "500 qualifying messages in the official community.", category: "COMMUNITY", criteria: { metric: "telegram_qualifying", gte: 500 }, reward: { badge: "voice500" }, sortOrder: 50 },
  { id: "pillar_of_clank", name: "Pillar of Clank", description: "2,000 qualifying messages in the official community.", category: "COMMUNITY", criteria: { metric: "telegram_qualifying", gte: 2000 }, reward: { badge: "voice2000", title: "Pillar" }, sortOrder: 51 },
  { id: "steady_presence", name: "Steady Presence", description: "Active in the community on 60 different days.", category: "COMMUNITY", criteria: { metric: "telegram_active_days", gte: 60 }, reward: { badge: "days60" }, sortOrder: 52 },
  { id: "og_clanker", name: "OG Clanker", description: "Recognised by the team as an early community member.", category: "COMMUNITY", criteria: { type: "manual" }, reward: { badge: "og", title: "OG Clanker" }, sortOrder: 55 },
  { id: "diamond_1d", name: "Diamond Hands I", description: "Hold a bonded Clank.trade coin for 1 verified day.", category: "DIAMOND_HANDS", criteria: { metric: "diamond_days", gte: 1 }, reward: { badge: "diamond1" }, sortOrder: 60 },
  { id: "diamond_7d", name: "Diamond Hands II", description: "Hold a bonded Clank.trade coin for 7 verified days.", category: "DIAMOND_HANDS", criteria: { metric: "diamond_days", gte: 7 }, reward: { badge: "diamond7" }, sortOrder: 61 },
  { id: "diamond_30d", name: "Diamond Hands III", description: "Hold a bonded Clank.trade coin for 30 verified days.", category: "DIAMOND_HANDS", criteria: { metric: "diamond_days", gte: 30 }, reward: { badge: "diamond30", title: "Diamond Hands" }, sortOrder: 62 },
  { id: "diamond_90d", name: "Diamond Hands IV", description: "Hold a bonded Clank.trade coin for 90 verified days.", category: "DIAMOND_HANDS", criteria: { metric: "diamond_days", gte: 90 }, reward: { badge: "diamond90", title: "Unbreakable Grip" }, sortOrder: 63 },
  { id: "bonded_collector", name: "Bonded Collector", description: "Hold three different bonded Clank.trade coins.", category: "COLLECTION", criteria: { metric: "bonded_tokens_held", gte: 3 }, reward: { badge: "collector" }, sortOrder: 70 },
  { id: "boss_slayer", name: "Boss Slayer", description: "Defeat a coin boss. (Bosses are coming soon.)", category: "SPECIAL", criteria: { type: "locked" }, reward: { badge: "boss_slayer", title: "Boss Slayer" }, sortOrder: 80 },
  { id: "seasonal_champion", name: "Seasonal Champion", description: "Finish a season at the top of the ladder.", category: "SPECIAL", criteria: { type: "manual" }, reward: { badge: "season_champion", title: "Seasonal Champion" }, sortOrder: 81 },
];
