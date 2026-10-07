/**
 * THE DOCS REGISTRY — the order, grouping, titles and section anchors of every documentation page. Metadata only (no JSX), so the sidebar,
 * the mobile menu, the search, the "on this page" list, breadcrumbs and previous / next links all read the same list. The page BODIES live in
 * `pages/*.tsx`; a test renders every body and fails if it is missing a section declared here (or has one that is not declared).
 *
 * All numbers a page states come from `@/domain/gameRules`, never from this file.
 */

export interface DocSection {
  /** The anchor id (the `id` of the `<h2>` in the page body). */
  id: string;
  title: string;
}

export type DocGroup = "Start" | "Heroes" | "Arena" | "Rewards" | "Help";

export interface DocPageMeta {
  /** URL slug under /docs ("" is the docs home). */
  slug: string;
  title: string;
  /** One sentence: shown on the docs home, in search results and as the page description. */
  summary: string;
  group: DocGroup;
  sections: DocSection[];
  /** Extra words people might search for. */
  keywords: string[];
}

export const DOC_GROUPS: readonly DocGroup[] = ["Start", "Heroes", "Arena", "Rewards", "Help"];

export const DOC_PAGES: readonly DocPageMeta[] = [
  {
    slug: "",
    title: "Clank RPG Docs",
    summary: "What Clank RPG is and where to find everything.",
    group: "Start",
    sections: [
      { id: "what-is-clank-rpg", title: "What is Clank RPG?" },
      { id: "where-to-start", title: "Where to start" },
      { id: "the-short-version", title: "The short version" },
    ],
    keywords: ["welcome", "overview", "introduction", "idle arena", "clank.trade"],
  },
  {
    slug: "getting-started",
    title: "Getting started",
    summary: "How you become eligible, and how your hero is created.",
    group: "Start",
    sections: [
      { id: "the-community", title: "The community" },
      { id: "becoming-eligible", title: "Becoming eligible" },
      { id: "qualifying-messages", title: "Qualifying messages" },
      { id: "your-hero-appears", title: "Your hero appears" },
      { id: "fair-play", title: "Fair play" },
    ],
    keywords: ["telegram", "eligible", "qualifying", "messages", "sign in", "hero created", "moderation"],
  },
  {
    slug: "heroes",
    title: "Heroes",
    summary: "What a hero is: class, rarity, stats, PWR and look.",
    group: "Heroes",
    sections: [
      { id: "one-member-one-hero", title: "One member, one hero" },
      { id: "what-defines-a-hero", title: "What defines a hero" },
      { id: "appearance", title: "Appearance" },
      { id: "fighting-automatically", title: "Fighting automatically" },
    ],
    keywords: ["hero", "character", "identity", "appearance", "automatic"],
  },
  {
    slug: "classes",
    title: "Classes",
    summary: "The six classes — their roles, strongest stats and trade-offs.",
    group: "Heroes",
    sections: [
      { id: "overview", title: "The six classes" },
      { id: "warrior", title: "Warrior" },
      { id: "mage", title: "Mage" },
      { id: "rogue", title: "Rogue" },
      { id: "ranger", title: "Ranger" },
      { id: "tank", title: "Tank" },
      { id: "cleric", title: "Cleric" },
      { id: "matchups", title: "Matchups" },
    ],
    keywords: ["warrior", "mage", "rogue", "ranger", "tank", "cleric", "role", "class"],
  },
  {
    slug: "rarity",
    title: "Rarity",
    summary: "Common, Rare, Epic and Legendary — a real strength tier, with exact PWR ranges.",
    group: "Heroes",
    sections: [
      { id: "four-tiers", title: "Four tiers" },
      { id: "pwr-ranges", title: "PWR ranges" },
      { id: "how-rarity-is-decided", title: "How rarity is decided" },
      { id: "what-rarity-looks-like", title: "What rarity looks like" },
      { id: "not-a-guarantee", title: "Not a guarantee" },
      { id: "what-rarity-does-not-touch", title: "What rarity does not touch" },
    ],
    keywords: ["common", "rare", "epic", "legendary", "tier", "odds", "pwr range", "power"],
  },
  {
    slug: "power-and-stats",
    title: "Power & stats",
    summary: "What PWR means and what each of the seven stats does.",
    group: "Heroes",
    sections: [
      { id: "what-is-pwr", title: "What is PWR?" },
      { id: "the-seven-stats", title: "The seven stats" },
      { id: "classes-spend-stats-differently", title: "Classes spend stats differently" },
      { id: "what-pwr-is-not", title: "What PWR is not" },
    ],
    keywords: ["pwr", "power", "hp", "str", "def", "int", "agi", "cha", "luck", "stats"],
  },
  {
    slug: "hero-profiles",
    title: "Hero profiles",
    summary: "The public hero page and card: share it, download it, link it.",
    group: "Heroes",
    sections: [
      { id: "the-public-page", title: "The public page" },
      { id: "seasons-and-records", title: "Seasons and records" },
      { id: "the-hero-card", title: "The hero card" },
      { id: "share-and-download", title: "Share and download" },
      { id: "the-heroes-directory", title: "The heroes directory" },
    ],
    keywords: ["profile", "card", "share", "x", "twitter", "download", "link", "directory", "season", "record", "wins", "win rate", "unranked", "reset"],
  },
  {
    slug: "arena",
    title: "The Arena",
    summary: "How battles run: eight heroes, one global stage, decided on the server.",
    group: "Arena",
    sections: [
      { id: "eight-heroes-one-survivor", title: "Eight heroes, one survivor" },
      { id: "the-flow", title: "The flow of a battle" },
      { id: "the-time-limit", title: "The time limit" },
      { id: "one-global-arena", title: "One global Arena" },
      { id: "decided-on-the-server", title: "Decided on the server" },
    ],
    keywords: ["battle", "fight", "arena", "combat", "countdown", "60 seconds", "replay", "deterministic"],
  },
  {
    slug: "arena-picks",
    title: "Arena Picks",
    summary: "Predict the winner of the next battle. Free, unlimited, no wallet.",
    group: "Arena",
    sections: [
      { id: "what-a-pick-is", title: "What a Pick is" },
      { id: "how-a-round-flows", title: "How a round flows" },
      { id: "scoring", title: "Scoring" },
      { id: "who-can-pick", title: "Who can Pick" },
      { id: "what-picks-are-not", title: "What Picks are not" },
    ],
    keywords: ["pick", "predict", "winner", "points", "upcoming", "lock", "free"],
  },
  {
    slug: "leaderboards",
    title: "Leaderboards",
    summary: "The Hall of Champions: Arena Picks, Hero Arena and Hero Records — how each ranks, and what the prizes are.",
    group: "Arena",
    sections: [
      { id: "the-hall", title: "The Hall of Champions" },
      { id: "daily", title: "Daily leaderboard" },
      { id: "weekly", title: "Weekly leaderboard" },
      { id: "ranking-and-ties", title: "Ranking and ties" },
      { id: "prize-eligibility", title: "Prize eligibility" },
      { id: "hero-arena", title: "Hero Arena" },
      { id: "hero-records", title: "Hero Records" },
      { id: "seasons", title: "Seasons" },
    ],
    keywords: ["daily", "weekly", "season", "leaderboard", "rank", "utc", "top 10", "prize pool", "minimum", "hero arena", "arena wins", "hero records", "hall of champions", "ties"],
  },
  {
    slug: "rewards",
    title: "Rewards",
    summary: "What you can earn, where it comes from, and what it never depends on.",
    group: "Rewards",
    sections: [
      { id: "points-and-prizes", title: "Points and prizes" },
      { id: "the-prize-ladder", title: "The prize ladder" },
      { id: "before-the-token-launches", title: "Before the token launches" },
      { id: "what-rewards-never-depend-on", title: "What rewards never depend on" },
    ],
    keywords: ["reward", "prize", "pool", "clankrpg", "points", "ladder", "token"],
  },
  {
    slug: "holder-bonus",
    title: "Holder bonus",
    summary: "An optional bonus on a prize you already earned — never power, never rank.",
    group: "Rewards",
    sections: [
      { id: "what-it-is", title: "What it is" },
      { id: "the-tiers", title: "The tiers" },
      { id: "what-it-never-does", title: "What it never does" },
      { id: "before-launch", title: "Before the token launches" },
    ],
    keywords: ["holder", "bonus", "tier", "wallet", "100k", "pay to win", "clankrpg"],
  },
  {
    slug: "claims",
    title: "Claims",
    summary: "How earned rewards are claimed, and why claims are not open yet.",
    group: "Rewards",
    sections: [
      { id: "how-claims-work", title: "How claims work" },
      { id: "manual-verified-payout", title: "Manual, verified payout" },
      { id: "claims-before-launch", title: "Claims before launch" },
    ],
    keywords: ["claim", "payout", "wallet", "manual", "verified", "launch"],
  },
  {
    slug: "faq",
    title: "FAQ",
    summary: "Quick answers to the questions people ask most.",
    group: "Help",
    sections: [
      { id: "getting-a-hero", title: "Getting a hero" },
      { id: "power-and-rarity", title: "Power and rarity" },
      { id: "picks-and-leaderboards", title: "Picks and leaderboards" },
      { id: "tokens-and-claims", title: "Tokens and claims" },
      { id: "the-game", title: "The game" },
    ],
    keywords: ["help", "questions", "why", "how", "can i"],
  },
];

export const DOCS_ROOT = "/docs";

export const docHref = (slug: string): string => (slug ? `${DOCS_ROOT}/${slug}` : DOCS_ROOT);
export const findDocPage = (slug: string): DocPageMeta | undefined => DOC_PAGES.find((p) => p.slug === slug);

/** The previous / next page in reading order (null at either end). */
export function neighbours(slug: string): { prev: DocPageMeta | null; next: DocPageMeta | null } {
  const i = DOC_PAGES.findIndex((p) => p.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: DOC_PAGES[i - 1] ?? null, next: DOC_PAGES[i + 1] ?? null };
}

export interface DocSearchEntry {
  slug: string;
  /** The page, or "Page › Section". */
  title: string;
  href: string;
  summary: string;
  /** Lower-cased haystack. */
  haystack: string;
}

/** A tiny client-side search index over titles, summaries, section titles and keywords. */
export function buildSearchIndex(): DocSearchEntry[] {
  const out: DocSearchEntry[] = [];
  for (const p of DOC_PAGES) {
    out.push({ slug: p.slug, title: p.title, href: docHref(p.slug), summary: p.summary, haystack: [p.title, p.summary, ...p.keywords, ...p.sections.map((s) => s.title)].join(" ").toLowerCase() });
    for (const s of p.sections) {
      out.push({ slug: p.slug, title: `${p.title} › ${s.title}`, href: `${docHref(p.slug)}#${s.id}`, summary: p.summary, haystack: [s.title, p.title, ...p.keywords].join(" ").toLowerCase() });
    }
  }
  return out;
}

/** Entries matching every word of `query` (case-insensitive), best (page-level, then earliest match) first. At most `limit`. */
export function searchDocs(index: readonly DocSearchEntry[], query: string, limit = 8): DocSearchEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return index
    .filter((e) => words.every((w) => e.haystack.includes(w)))
    .map((e) => ({ e, score: (e.title.toLowerCase().includes(words[0]!) ? 0 : 10) + (e.title.includes("›") ? 5 : 0) + e.haystack.indexOf(words[0]!) / 1000 }))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((x) => x.e);
}
