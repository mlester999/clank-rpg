import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HallOfChampions } from "@/components/leaderboard/HallOfChampions";
import { HeroBoardView } from "@/components/leaderboard/HeroBoards";
import { PicksSeasonView } from "@/components/leaderboard/PicksSeasonBoard";
import { DEFAULT_HALL, hallQuery, isRewardedView, parseHall, scopesOf } from "@/components/leaderboard/hallModel";
import type { HeroBoardDto, HeroBoardPayload, HeroRowDto, HeroRulesView, PicksSeasonPayload } from "@/domain/heroArenaDto";

/**
 * THE HALL OF CHAMPIONS, as a visitor reads it: three clearly separate sections, one scope selector, a prize ladder ONLY on rewarded Daily / Weekly views,
 * "REWARD POOL NOT SET" instead of an invented amount, DEVELOPMENT / BETA stated plainly, compact empty states, and none of the old clutter.
 */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
const NOW = Date.parse("2026-10-07T09:36:42Z");
const dev = { id: "s0", label: "Development", kind: "DEVELOPMENT" as const, status: "ACTIVE" as const, current: true };
const s1 = { id: "s1", label: "Season 1", kind: "COMPETITIVE" as const, status: "ACTIVE" as const, current: true };

const row = (over: Partial<HeroRowDto> = {}): HeroRowDto => ({
  rank: 1, tied: false, characterId: "c1", heroPublicId: "hero-one", name: "Gearbox Gus", classId: "warrior", rarity: "EPIC", power: 1234, matches: 10, wins: 8, top2: 9, kos: 14, winRate: 80, seasonRank: null,
  appearance: null, avatarUrl: null, claimed: true, isDemo: false, prizeEligible: true, prize: "0", prizeStatus: "NONE", ...over,
});
const rules = (over: Partial<HeroRulesView> = {}): HeroRulesView => ({
  kind: "DAILY", minimumWins: 1, poolSet: true, prizePool: "100,000", symbol: "$CLANKRPG", topRewarded: 10, prizesPaused: false,
  prizes: [3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200].map((bps, i) => ({ position: i + 1, share: `${bps / 100}%`, amount: `${(100_000 * bps) / 10_000}`.replace(/\B(?=(\d{3})+$)/, ",") })), ...over,
});
const board = (over: Partial<HeroBoardDto> = {}): HeroBoardDto => ({
  scope: "DAILY", rewarded: true, state: "CURRENT", start: "2026-10-07", serverNow: NOW, startsAt: Date.parse("2026-10-07T00:00:00Z"), endsAt: Date.parse("2026-10-08T00:00:00Z"), season: dev, rules: rules(),
  participants: 3, rows: [row({ prize: "25,000", tied: true }), row({ rank: 1, tied: true, characterId: "c2", name: "Rivet", prize: "25,000" }), row({ rank: 3, characterId: "c3", name: "Cog Cadet", wins: 6, prize: "15,000" })], finalizedAt: null, classes: {}, ...over,
});
const payload = (b: HeroBoardDto, over: Partial<HeroBoardPayload> = {}): HeroBoardPayload => ({ board: b, periods: [], finalizing: null, seasons: [dev], ...over });
const view = (p: HeroBoardPayload, kind: "arena" | "top2" | "kos" | "pwr" = "arena") => renderToStaticMarkup(createElement(HeroBoardView, { payload: p, kind, selected: "CURRENT", onSelect: () => undefined, season: null, onSeason: () => undefined, onReload: () => undefined }));

describe("the navigation model", () => {
  it("opens on Arena Picks · Daily; every unknown value falls back safely", () => {
    expect(parseHall({})).toEqual(DEFAULT_HALL);
    expect(parseHall({ section: "nonsense", scope: "yearly", metric: "xp" })).toEqual(DEFAULT_HALL);
    expect(parseHall(new URLSearchParams("section=hero-arena&scope=weekly"))).toEqual({ section: "hero-arena", scope: "weekly", metric: "top2" });
    expect(parseHall({ section: ["records", "x"], metric: "kos" })).toMatchObject({ section: "records", metric: "kos" });
  });

  it("Hero Records opens on its season view (a record is a season's story); the rewarded sections open on today", () => {
    expect(parseHall({ section: "records" }).scope).toBe("season");
    expect(parseHall({ section: "hero-arena" }).scope).toBe("daily");
    expect(parseHall({ section: "records", scope: "daily" }).scope).toBe("daily");
  });

  it("a state round-trips through a shareable query string, and the default view keeps the URL clean", () => {
    expect(hallQuery(DEFAULT_HALL)).toBe("");
    for (const state of [parseHall({ section: "hero-arena", scope: "season" }), parseHall({ section: "records", scope: "weekly", metric: "kos" }), parseHall({ section: "records", metric: "pwr" }), parseHall({ section: "picks", scope: "weekly" })]) {
      expect(parseHall(new URLSearchParams(hallQuery(state)))).toEqual(state);
    }
  });

  it("only Daily and Weekly of the two competitions pay; Season and every record never do; PWR has no scope at all", () => {
    expect(isRewardedView(parseHall({ section: "picks", scope: "daily" }))).toBe(true);
    expect(isRewardedView(parseHall({ section: "hero-arena", scope: "weekly" }))).toBe(true);
    expect(isRewardedView(parseHall({ section: "picks", scope: "season" }))).toBe(false);
    expect(isRewardedView(parseHall({ section: "hero-arena", scope: "season" }))).toBe(false);
    for (const metric of ["top2", "kos", "pwr"]) for (const scope of ["daily", "weekly", "season"]) expect(isRewardedView(parseHall({ section: "records", metric, scope }))).toBe(false);
    expect(scopesOf(parseHall({ section: "records", metric: "pwr" }))).toEqual([]);
    expect(scopesOf(parseHall({ section: "hero-arena" })).map((s) => s.id)).toEqual(["daily", "weekly", "season"]);
  });
});

describe("the page", () => {
  const page = (query: Record<string, string> = {}) => renderToStaticMarkup(createElement(HallOfChampions, { initial: parseHall(query) }));

  it("three sections — Arena Picks and Hero Arena marked REWARDED, Hero Records marked STATS — and none of the old metric buttons", () => {
    const html = page();
    const t = text(html);
    expect(t).toMatch(/Hall of Champions/);
    for (const id of ["picks", "hero-arena", "records"]) expect(html).toContain(`data-testid="section-${id}"`);
    expect(text(html.slice(html.indexOf('data-testid="section-tag-picks"'), html.indexOf('data-testid="section-tag-picks"') + 80))).toMatch(/REWARDED/);
    expect(html).toMatch(/data-testid="section-tag-hero-arena"[^>]*>REWARDED/);
    expect(html).toMatch(/data-testid="section-tag-records"[^>]*>STATS/);
    expect(t).toMatch(/Player competition/);
    expect(t).toMatch(/Hero competition/);
    expect(t).toMatch(/Predict the winner\. Earn from good Picks\./);
    expect(t).toMatch(/Win Arena fights\. Your hero earns\./);
    // the clutter is gone from the navigation
    expect(t).not.toMatch(/Community|Season Rank/);
    expect(html).not.toContain('data-testid="metric-');
  });

  it("one scope selector — Daily · Weekly · Season — in every section", () => {
    for (const section of ["picks", "hero-arena", "records"]) {
      const html = page({ section });
      for (const s of ["daily", "weekly", "season"]) expect(html, `${section}/${s}`).toContain(`data-testid="scope-${s}"`);
    }
  });

  it("Hero Records shows its metric tabs (Top-2 · KOs · PWR) — and no Wins tab: Wins live on the rewarded Hero Arena", () => {
    const html = page({ section: "records" });
    expect(html).toContain('data-testid="metric-top2"');
    expect(html).toContain('data-testid="metric-kos"');
    expect(html).toContain('data-testid="metric-pwr"');
    expect(html).not.toContain('data-testid="metric-wins"');
  });

  it("PWR offers no Daily / Weekly / Season: power is a live figure", () => {
    const html = page({ section: "records", metric: "pwr" });
    expect(html).not.toContain('data-testid="scope-daily"');
    expect(html).not.toContain('data-testid="hall-scopes"');
  });
});

describe("HERO ARENA — Daily / Weekly are rewarded", () => {
  it("shows the Rewarded label, the prize pool, the Top-10 ladder, the countdown, ties and projected prizes", () => {
    const html = view(payload(board()));
    const t = text(html);
    expect(t).toMatch(/Daily Hero Arena/);
    expect(html).toContain('data-testid="status-rewarded"');
    expect(t).toMatch(/100,000 \$CLANKRPG Daily prize pool Top 10 rewarded/);
    expect(t).toMatch(/Prize ladder · Top 10/);
    expect(html).toContain('data-testid="board-ladder"');
    expect(t).toMatch(/Ends in 14H 23M 18S/);
    expect(t).not.toMatch(/\dD \d\dH/); // a day never shows days
    expect((html.match(/>TIE</g) ?? []).length).toBe(2); // the two heroes tied for first
    expect(t).toMatch(/\+25,000 projected/);
    expect(t).toMatch(/Prizes shown are a projection/);
    expect(t).toMatch(/Most Arena Wins in the period\. Ties split the prizes of the positions they share\. Prizes go to the hero's owner\./);
    expect(html).toContain('href="/heroes/hero-one"'); // every row links to the stable public profile
  });

  it("NO POOL SET: 'Reward pool not set' — no amount, no 100k / 500k borrowed from Arena Picks, ladder shares only", () => {
    const html = view(payload(board({ rules: rules({ poolSet: false, prizePool: null, prizes: rules().prizes.map((p) => ({ ...p, amount: null })) }), rows: [row({ prize: "0" })] })));
    const t = text(html);
    expect(t).toMatch(/Reward pool not set/);
    expect(html).toContain('data-testid="board-pool-not-set"');
    expect(t).not.toMatch(/100,000|500,000|\$CLANKRPG Daily prize pool/);
    expect(t).toMatch(/Prize ladder · Top 10/);
    expect(t).toMatch(/30%/);
    expect(html).not.toContain('data-testid="row-prize"');
    expect(t).not.toMatch(/projection/);
  });

  it("a FINAL board is read-only and shows what each owner got; a reserved prize says its hero is not claimed yet", () => {
    const b = board({ state: "FINAL", finalizedAt: Date.parse("2026-10-08T00:01:00Z"), rows: [row({ prize: "25,000", prizeStatus: "CREDITED" }), row({ rank: 1, tied: true, characterId: "c2", name: "Rivet", prize: "25,000", prizeStatus: "RESERVED", claimed: false })] });
    const t = text(view(payload(b)));
    expect(t).toMatch(/Final results · OCT 7 · read-only/);
    expect(t).toMatch(/Finalized 2026-10-08/);
    expect(t).toMatch(/\+25,000/);
    expect(t).not.toMatch(/projected/);
    expect(t).toMatch(/Reserved — this hero hasn't been claimed yet/);
    expect(t).not.toMatch(/Ends in/);
  });

  it("paused prizes are said plainly while rankings continue", () => {
    expect(text(view(payload(board({ rules: rules({ prizesPaused: true }) }))))).toMatch(/Prizes are paused\. Rankings continue\./);
  });

  it("the empty state is compact and intentional, not a large card", () => {
    const html = view(payload(board({ rows: [], participants: 0 })));
    expect(text(html)).toMatch(/No settled Arena battles in this period yet\./);
    expect(html).toContain('data-testid="board-empty"');
    expect(html).not.toContain("max-w-lg"); // EmptyState's big card
  });

  it("every row stays inside its width: the name truncates, the layout wraps, and the phone gets a compact stats line instead of columns", () => {
    const html = view(payload(board({ rows: [row({ name: "An Extremely Long Hero Name That Should Never Push The Page Wider Than The Screen" })] })));
    expect(html).toContain("truncate");
    expect(html).toContain("min-w-0");
    expect(html).toContain('data-testid="row-stats-compact"');
    expect(html).toContain("sm:hidden"); // compact line for phones…
    expect(html).toContain("hidden shrink-0"); // …columns only from sm up
  });
});

describe("HERO ARENA — Season is standings only", () => {
  const season = board({ scope: "SEASON", rewarded: false, state: "SEASON", start: null, startsAt: null, endsAt: null, rules: null, season: s1, rows: [row({ seasonRank: { id: "gold", name: "Gold" } })] });

  it("no pool, no ladder, no prize, no countdown — 'Standings only', the season named, Top-2 and KOs shown", () => {
    const html = view(payload(season, { seasons: [s1, { ...s1, id: "s0b", label: "Season 0", current: false, status: "ENDED" }] }));
    const t = text(html);
    expect(t).toMatch(/Season Hero Arena/);
    expect(html).toContain('data-testid="status-standings"');
    expect(html).not.toContain('data-testid="board-ladder"');
    expect(html).not.toContain('data-testid="board-prize-pool"');
    expect(html).not.toContain('data-testid="row-prize"');
    expect(t).not.toMatch(/Prize ladder|prize pool|projection|Ends in/i);
    expect(t).toMatch(/Season 1 · every settled Arena battle of the season/);
    expect(t).toMatch(/Gold/); // the season tier lives on the season standings
    expect(t).toMatch(/Top-2/);
    expect(t).toMatch(/KOs/);
    expect(html).toContain('data-testid="season-select"'); // past seasons are selectable
    expect(t).toMatch(/Season 1 · current/);
    expect(t).toMatch(/Season 0/);
  });

  it("the empty season says so in one line", () => {
    expect(text(view(payload({ ...season, rows: [], participants: 0 })))).toMatch(/No settled Arena battles in this season yet\./);
  });
});

describe("HERO RECORDS — statistics only", () => {
  const records = (over: Partial<HeroBoardDto> = {}) => board({ rewarded: false, rules: null, scope: "SEASON", state: "SEASON", start: null, startsAt: null, endsAt: null, season: s1, ...over });

  it("Top-2 / KOs: 'Stat leaderboard · no prize', never a ladder, a pool or a prize", () => {
    for (const kind of ["top2", "kos"] as const) {
      const html = view(payload(records()), kind);
      expect(html).toContain('data-testid="status-stats"');
      expect(text(html)).toMatch(/Stat leaderboard · no prize/);
      expect(html).not.toContain('data-testid="board-ladder"');
      expect(html).not.toContain('data-testid="row-prize"');
      expect(text(html)).not.toMatch(/Rewarded|prize pool|Prize ladder/i);
    }
    expect(text(view(payload(records()), "top2"))).toMatch(/Top-2 finishes · Season/);
    expect(text(view(payload(records()), "kos"))).toMatch(/KOs · Season/);
  });

  it("PWR is the current figure — and says there is no daily or weekly PWR", () => {
    const t = text(view(payload(records({ rows: [row({ power: 4321 })] })), "pwr"));
    expect(t).toMatch(/Current PWR/);
    expect(t).toMatch(/there is no daily or weekly PWR/);
    expect(t).toMatch(/4,321/);
  });
});

describe("ARENA PICKS — Season standings", () => {
  const picks: PicksSeasonPayload = {
    rewarded: false, season: s1, serverNow: NOW, participants: 2, seasons: [s1],
    rows: [{ rank: 1, tied: false, characterId: "p1", heroPublicId: "hero-one", rarity: "RARE", name: "Gearbox Gus", classId: "warrior", picks: 400, correctPicks: 400, accuracy: 100, points: 4000 }],
    me: { rank: 1, picks: 400, correctPicks: 400, accuracy: 100, points: 4000 },
  };
  const render = (p: PicksSeasonPayload) => renderToStaticMarkup(createElement(PicksSeasonView, { payload: p, season: null, onSeason: () => undefined }));

  it("Rank · Player · Picks · Correct · Accuracy · Points, standings only, no prize ladder, no payout", () => {
    const html = render(picks);
    const t = text(html);
    expect(t).toMatch(/Season Arena Picks/);
    expect(html).toContain('data-testid="status-standings"');
    expect(t).toMatch(/400 picks · 400 correct · 100\.0%/);
    expect(t).toMatch(/4,000 points/);
    expect(t).toMatch(/Picks 400 Correct 400 Accuracy 100\.0% Points 4,000 Season rank #1/);
    expect(t).toMatch(/Daily and Weekly are the rewarded boards/);
    expect(html).not.toContain('data-testid="board-ladder"');
    expect(t).not.toMatch(/prize pool|Prize ladder|projected/i);
  });

  it("a fresh season is an empty, compact state", () => {
    const t = text(render({ ...picks, rows: [], participants: 0, me: { rank: null, picks: 0, correctPicks: 0, accuracy: null, points: 0 } }));
    expect(t).toMatch(/No ranked players yet\. Make an Arena Pick to enter this season's standings\./);
    expect(t).toMatch(/Picks 0 Correct 0 Accuracy — Points 0 Season rank —/);
  });
});

describe("PRE-SEASON is stated plainly on every board", () => {
  it("the pre-season run is labelled on Hero Arena, Records and Picks — Season 1 is just named, and nothing public says development / beta / test", () => {
    const html = view(payload(board()));
    expect(html).toContain('data-kind="DEVELOPMENT"');
    expect(text(html)).toMatch(/Pre-season/);
    expect(text(html)).not.toMatch(/Development|Beta|test (battles|Picks)/);
    expect(text(view(payload(board({ season: s1 }))))).not.toMatch(/Pre-season/);
    expect(text(view(payload(board({ season: s1 }))))).toMatch(/Season 1/);
  });
});
