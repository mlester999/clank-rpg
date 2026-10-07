/**
 * The roadmap, as shown to players. Locked features are advertised as exciting previews —
 * what exists today is the honest foundation (data model / engine), never a fake working UI.
 */
export type FeatureId = "bosses" | "expeditions" | "pvp" | "guilds" | "world";

export interface FeatureInfo {
  id: FeatureId;
  nav: string;
  title: string;
  tagline: string;
  icon: "skull" | "map" | "swords" | "banner" | "tower";
  accent: string;
  pitch: string;
  bullets: string[];
  foundation: string;
  teaser?: { title: string; body: string };
}

export const FEATURES: Record<FeatureId, FeatureInfo> = {
  bosses: {
    id: "bosses",
    nav: "Bosses",
    title: "Coin Bosses",
    tagline: "Every bonded coin has a monster waiting inside it.",
    icon: "skull",
    accent: "#ff5c7a",
    pitch: "When a Clank.trade coin graduates, the Foundry stirs. Its boss rises — with its own stats, abilities and lore — and the whole community can raid it for themed loot, badges and cosmetics.",
    bullets: [
      "Bosses are drafted automatically from bonded coins, then approved by the team before anything goes live",
      "Themed relics, artifacts and badges drop from each boss",
      "Holding the matching coin grants a small synergy with its themed gear",
      "Boss Slayer achievements and season trophies",
    ],
    foundation: "Boss drafts, loot tables and approval gates already exist behind the scenes. Nothing goes live without a human sign-off.",
  },
  expeditions: {
    id: "expeditions",
    nav: "Expeditions",
    title: "Expeditions",
    tagline: "Send your hero out. Come back richer.",
    icon: "map",
    accent: "#2ee6c8",
    pitch: "Idle journeys with risk and reward. Choose a route, pick your tactics, and let your hero run the gauntlet while you do something else.",
    bullets: [
      "Timed expeditions with branching events",
      "Equipment, Clank Gold and rare cosmetics as rewards",
      "Quests built around gameplay — not spam",
      "Daily and weekly objectives",
    ],
    foundation: "The reward ledger, inventory and equipment systems that expeditions will pay into are live today.",
  },
  pvp: {
    id: "pvp",
    nav: "PvP",
    title: "Ranked Arena & Challenges",
    tagline: "Pick your fights. Climb the ladder.",
    icon: "swords",
    accent: "#4aa8ff",
    pitch: "Beyond the Global Arena: ranked matchmaking, random duels, and direct challenges to the hero who talked trash in chat.",
    bullets: [
      "Ranked ladder with seasonal rewards",
      "Direct challenges between members",
      "Claimed owners tune tactics: Aggressive, Balanced or Defensive",
      "Every fight is deterministic and replayable — provably fair",
    ],
    foundation: "The battle engine is already server-authoritative, seeded and verifiable. PvP reuses it as-is.",
  },
  guilds: {
    id: "guilds",
    nav: "Guilds",
    title: "Guilds & Community Wars",
    tagline: "Pick a coin. Fight for it.",
    icon: "banner",
    accent: "#b366ff",
    pitch: "Hold several bonded coins? Choose ONE to champion each season. Your allegiance locks, your coin's guild gains your points, and the seasons end in a massive team battle.",
    bullets: [
      "One primary coin per season — locked once chosen",
      "Individual matchups, guild scoring, then a huge final team battle",
      "Guild banners and cosmetics",
      "Community-wide seasonal events",
    ],
    foundation: "Seasons, seasonal stats and bonded-coin tracking are in place and running.",
  },
  world: {
    id: "world",
    nav: "World",
    title: "The World",
    tagline: "The Foundry is bigger than the arena.",
    icon: "tower",
    accent: "#5fd38d",
    pitch: "Clank RPG stays fast and menu-driven, but special places will open up to explore: hubs, markets and secrets for those who look.",
    bullets: [
      "Explorable hubs, not an endless open world",
      "Hidden events and limited-time areas",
      "Community-driven discoveries",
      "Everything still playable in a couple of taps",
    ],
    foundation: "Feature flags and content tables are ready so new areas can ship without touching the core game.",
  },
};

export const FEATURE_ORDER: FeatureId[] = ["bosses", "expeditions", "pvp", "guilds", "world"];
