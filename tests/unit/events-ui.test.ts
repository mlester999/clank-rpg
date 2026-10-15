import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventsBody, type EventsBodyProps } from "@/components/events/EventsView";
import { ResultsBody } from "@/components/events/ResultsDialog";
import { DEFAULT_EVENTS } from "@/components/events/eventsModel";
import type { AllocationDto, EventsListDto, EventsStateDto, HeroRowDto, PeriodDetailDto, PeriodDto, PicksRowDto } from "@/domain/events";
import type { ClassVisual } from "@/lib/dto";

/** The Events page, server-rendered from fixtures: what a player is shown, in the spec's words — champion cards, empty states, Top 10, the honest prize wording. */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<\/?(b|strong|em|i)(\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const CLASSES: Record<string, ClassVisual> = {
  ranger: { name: "Ranger", role: "", tagline: "", colors: ["#2a6", "#bfe", "#143"], weapon: "bow", headgear: "hood", body: "medium", attackStyle: "shoot" },
  warrior: { name: "Warrior", role: "", tagline: "", colors: ["#a33", "#eca", "#511"], weapon: "sword", headgear: "helm", body: "heavy", attackStyle: "slash" },
};
const PARTS = { head: 0, hair: 0, face: 0, torso: 0, legs: 0, accessory: 0, palette: 0 } as never;
const art = { rarity: "EPIC" as const, parts: PARTS };
const NONE: AllocationDto = { status: "NONE", amount: null, symbol: "$CLANKRPG", bonusPart: null };
const ALLOC = (amount: string, bonusPart: string | null = null): AllocationDto => ({ status: "ALLOCATED", amount, symbol: "$CLANKRPG", bonusPart });

const picks = (over: Partial<PicksRowDto> = {}): PicksRowDto => ({
  program: "picks", rank: 1, tied: false, name: "MARKYYESTER", classId: "ranger", rarity: "EPIC", power: 185, heroVersion: 1, heroPublicId: "abc234def567", art,
  allocation: ALLOC("30,000"), points: 250, picks: 27, correctPicks: 25, accuracy: 92.6, prizeEligible: true, prizeRank: 1, ...over,
});
const hero = (over: Partial<HeroRowDto> = {}): HeroRowDto => ({
  program: "hero", rank: 1, tied: false, name: "Epic Ranger", classId: "ranger", rarity: "EPIC", power: 185, heroVersion: 2, heroPublicId: "hhh234def567", art,
  allocation: NONE, matches: 58, wins: 42, top2: 50, kos: 17, winRate: 72.4, ...over,
});

const period = (over: Partial<PeriodDto> = {}): PeriodDto => ({
  program: "picks", kind: "daily", start: "2026-10-14", startsAt: Date.parse("2026-10-14T00:00:00Z"), endsAt: Date.parse("2026-10-15T00:00:00Z"), outcome: "CHAMPION",
  finalizedAt: Date.parse("2026-10-15T00:05:00Z"), participants: 40, eligibleParticipants: 31, champions: [picks()], moreChampions: 0, leader: null,
  rules: { minimum: 20, minimumUnit: "Picks", prizePool: "100,000", symbol: "$CLANKRPG", recognitionOnly: false }, ...over,
});
const state = (over: Partial<EventsStateDto> = {}): EventsStateDto => ({
  phase: "SEASON_ACTIVE", season: { id: "s1", label: "Season 1", number: 1, status: "ACTIVE", startsAt: Date.parse("2026-10-10T12:00:00Z"), endsAt: null, current: true }, seasons: [], serverNow: Date.parse("2026-10-15T09:00:00Z"), ...over,
});
const list = (periods: PeriodDto[], over: Partial<EventsListDto> = {}): EventsListDto => ({ state: state(), program: "picks", kind: "daily", periods, nextBefore: null, classes: CLASSES, ...over });

const body = (over: Partial<EventsBodyProps> = {}): EventsBodyProps => {
  const data = over.data === undefined ? list([period()]) : over.data;
  return {
    view: DEFAULT_EVENTS, onProgram: () => undefined, onKind: () => undefined, data, periods: data?.periods ?? [], nextBefore: data?.nextBefore ?? null, loading: false, loadingMore: false, moreFailed: false,
    error: null, tokenLaunched: false, onOpen: () => undefined, onLoadMore: () => undefined, onReload: () => undefined, ...over,
  };
};
const render = (over: Partial<EventsBodyProps> = {}) => renderToStaticMarkup(createElement(EventsBody, body(over)));

describe("the page structure", () => {
  it("is EVENTS › RECENT CHAMPIONS › [Arena Picks | Hero Arena] › [Daily | Weekly], with PAST RESULTS below", () => {
    const html = render({ data: list([period(), period({ start: "2026-10-13" }), period({ start: "2026-10-12" }), period({ start: "2026-10-11" })], { nextBefore: "2026-10-11" }) });
    const t = text(html);
    expect(t).toMatch(/Season 1 Events/);
    expect(t).toMatch(/Recent Champions/);
    expect(t).toMatch(/Celebrate the community's latest winners/);
    expect(t).toMatch(/Arena Picks/);
    expect(t).toMatch(/Hero Arena/);
    expect(t).toMatch(/Daily/);
    expect(t).toMatch(/Weekly/);
    expect(t).toMatch(/Past Results/);
    expect(html).toContain('data-testid="events-program-picks"');
    expect(html).toContain('data-testid="events-kind-weekly"');
    expect(html).toContain('aria-selected="true"'); // the active tabs say so
    // the latest at full size, the two before it compact, the rest as rows
    expect((html.match(/data-testid="champion-featured"/g) ?? []).length).toBe(1);
    expect((html.match(/data-testid="champion-card"/g) ?? []).length).toBe(2);
    expect((html.match(/data-testid="past-row"/g) ?? []).length).toBe(1);
    // pagination: an older page exists
    expect(html).toContain('data-testid="events-load-more"');
  });

  it("shows no load-more at the end of the history, and a retry note when an older page failed", () => {
    expect(render({ data: list([period()], { nextBefore: null }) })).not.toContain("events-load-more");
    const html = render({ data: list([period()], { nextBefore: "2026-10-13" }), moreFailed: true });
    expect(html).toContain("events-load-more-error");
  });

  it("keeps the live countdown-first design on the running period and shows a DATE — never a countdown — on a past result", () => {
    const html = render({ view: { ...DEFAULT_EVENTS, kind: "daily" } });
    expect(html).toContain('data-testid="events-countdown"');
    expect(text(html)).toMatch(/Daily ends in/);
    const t = text(html);
    expect(t).toMatch(/OCT 14/); // the completed period is labelled by its date
    expect(t).not.toMatch(/00:00 UTC\s*→\s*00:00 UTC/); // no raw range as primary text
    expect(text(render({ view: { ...DEFAULT_EVENTS, kind: "weekly" } }))).toMatch(/Weekly ends in/);
  });
});

describe("champion cards", () => {
  it("ARENA PICKS DAILY: #1 DAILY CHAMPION · name · POINTS · correct of Picks · accuracy · the date — all from the frozen result", () => {
    const t = text(render());
    expect(t).toMatch(/#1 DAILY CHAMPION/);
    expect(t).toMatch(/MARKYYESTER/);
    expect(t).toMatch(/Points\s+250/);
    expect(t).toMatch(/Correct\s+25\s+of 27 Picks/);
    expect(t).toMatch(/Accuracy\s+92\.6%/);
    expect(t).toMatch(/Epic/i);
    expect(t).toMatch(/PWR 185/);
    expect(t).toMatch(/OCT 14/);
    expect(t).toMatch(/View full results/);
  });

  it("ARENA PICKS WEEKLY and the two Hero Arena views use their own titles and figures", () => {
    expect(text(render({ data: list([period({ kind: "weekly", start: "2026-10-12" })], { kind: "weekly" }), view: { ...DEFAULT_EVENTS, kind: "weekly" } }))).toMatch(/#1 WEEKLY CHAMPION[\s\S]*WEEK OF OCT 12/);
    const heroDaily = text(render({ data: list([period({ program: "hero", champions: [hero()], rules: { minimum: 1, minimumUnit: "wins", prizePool: null, symbol: "$CLANKRPG", recognitionOnly: true } })], { program: "hero" }), view: { ...DEFAULT_EVENTS, program: "hero" } }));
    expect(heroDaily).toMatch(/#1 DAILY HERO/);
    expect(heroDaily).toMatch(/Epic Ranger/);
    expect(heroDaily).toMatch(/PWR 185/);
    expect(heroDaily).toMatch(/Wins\s+42/);
    expect(heroDaily).toMatch(/KOs\s+17/);
    expect(heroDaily).toMatch(/Matches\s+58/);
    const heroWeekly = text(render({ data: list([period({ program: "hero", kind: "weekly", start: "2026-10-12", champions: [hero()] })], { program: "hero", kind: "weekly" }), view: { program: "hero", kind: "weekly", period: null } }));
    expect(heroWeekly).toMatch(/#1 WEEKLY HERO/);
    expect(heroWeekly).toMatch(/WEEK OF OCT 12/);
  });

  it("links the champion to its public hero page only when the hero may be linked", () => {
    expect(render()).toContain('href="/heroes/abc234def567"');
    expect(render({ data: list([period({ champions: [picks({ heroPublicId: null })] })]) })).not.toContain("/heroes/");
  });

  it("separates recognition from prize: an allocation is 'allocated', never 'paid' — and says claims wait for the token until it exists", () => {
    const pre = text(render({ tokenLaunched: false }));
    expect(pre).toMatch(/30,000 \$CLANKRPG allocated/);
    expect(pre).toMatch(/claimable once \$CLANKRPG launches/);
    expect(pre).not.toMatch(/\bpaid\b|payout sent|received/i);
    const post = text(render({ tokenLaunched: true }));
    expect(post).toMatch(/allocated/);
    expect(post).not.toMatch(/claimable once/);
    expect(post).not.toMatch(/\bpaid\b/i);
    // a champion whose prize was not allocated says so; with no pool it is recognition only
    expect(text(render({ data: list([period({ champions: [picks({ allocation: NONE })] })]) }))).toMatch(/No prize allocated/);
    expect(text(render({ data: list([period({ champions: [picks({ allocation: NONE })], rules: { minimum: 20, minimumUnit: "Picks", prizePool: null, symbol: "$CLANKRPG", recognitionOnly: true } })]) }))).toMatch(/Recognition only/);
    // the holder bonus rides on the prize and is kept apart
    expect(text(render({ data: list([period({ champions: [picks({ allocation: ALLOC("31,500", "1,500") })] })]) }))).toMatch(/31,500 \$CLANKRPG allocated · incl\. 1,500 holder bonus/);
  });

  it("an exact tie is JOINT: nobody is picked arbitrarily", () => {
    const t = text(render({ data: list([period({ outcome: "JOINT_CHAMPIONS", champions: [picks({ name: "Alpha", tied: true }), picks({ name: "Bravo", tied: true })] })]) }));
    expect(t).toMatch(/JOINT DAILY CHAMPIONS/);
    expect(t).toMatch(/Exactly tied for first/);
    expect(t).toMatch(/Alpha/);
    expect(t).toMatch(/Bravo/);
    expect(t).not.toMatch(/#1 DAILY CHAMPION/);
  });

  it("a very long name stays inside its box (fitted, never an ellipsis cut of the champion) and a hero with no snapshot gets a quiet placeholder, not an invented portrait", () => {
    const longName = "SIR BARNABY THE MAGNIFICENT DEFENDER OF THE REALM";
    const html = render({ data: list([period({ champions: [picks({ name: longName, art: null })] })]) });
    expect(html).toContain(longName);
    expect(html).toContain("hero-name-box");
    expect(html).toContain('data-testid="champion-placeholder"');
  });
});

describe("periods with no champion are said plainly — nothing is invented to fill the card", () => {
  it("NO ELIGIBLE WINNER names the minimum and the ineligible leader, who is not a prize winner", () => {
    const t = text(render({ data: list([period({ outcome: "NO_ELIGIBLE_WINNER", champions: [], leader: { name: "Sprinter", picks: 12, correctPicks: 12, minimum: 20 } })]) }));
    expect(t).toMatch(/NO ELIGIBLE WINNER/);
    expect(t).toMatch(/none reached the 20-Pick minimum/);
    expect(t).toMatch(/Sprinter, had 12 valid Picks — below the minimum, so not a prize winner/);
    expect(t).not.toMatch(/CHAMPION/);
  });
  it("NO COMPLETED RESULTS and FINALIZING", () => {
    expect(text(render({ data: list([period({ outcome: "NO_COMPLETED_RESULTS", champions: [], finalizedAt: null, rules: null })]) }))).toMatch(/NO COMPLETED RESULTS/);
    expect(text(render({ data: list([period({ outcome: "FINALIZING", champions: [], finalizedAt: null, rules: null })]) }))).toMatch(/FINALIZING[\s\S]*being frozen/);
  });
  it("Hero Arena with no winner", () => {
    expect(text(render({ data: list([period({ program: "hero", outcome: "NO_ELIGIBLE_WINNER", champions: [] })], { program: "hero" }), view: { ...DEFAULT_EVENTS, program: "hero" } }))).toMatch(/NO ELIGIBLE WINNER[\s\S]*none won a battle/);
  });
});

describe("the empty states are truthful", () => {
  it("before Season 1: SEASON 1 COMING SOON — no champion, no countdown, pre-season results never offered as winners", () => {
    const html = render({ data: list([], { state: state({ phase: "PRE_SEASON", season: null }) }) });
    const t = text(html);
    expect(html).toContain('data-reason="PRE_SEASON"');
    expect(t).toMatch(/Season 1 coming soon/i);
    expect(t).toMatch(/Pre-season results are practice: they are never shown as official champions/);
    expect(t).not.toMatch(/CHAMPION\b.*#1|DAILY CHAMPION/);
    expect(html).not.toContain("events-countdown");
    expect(html).not.toContain("events-past");
    expect(t).not.toMatch(/development|beta|test battles|local/i);
  });
  it("once Season 1 is running but nothing has closed: NO CHAMPIONS YET with the exact promise", () => {
    const html = render({ data: list([]) });
    expect(html).toContain('data-reason="NO_CHAMPIONS_YET"');
    expect(text(html)).toMatch(/NO CHAMPIONS YET/i);
    expect(text(html)).toMatch(/The first Season 1 winners will appear after the first eligible day is finalized/);
    expect(html).toContain("events-countdown"); // the running period's countdown stays
  });
  it("a loading page shows a skeleton; a failing page offers a retry", () => {
    expect(render({ data: null, loading: true })).toContain('data-testid="board-loading"');
    expect(render({ data: null, loading: false, error: { error: "NETWORK" } })).toContain('data-testid="board-retry"');
  });
});

describe("FULL RESULTS (Top 10)", () => {
  const detail = (over: Partial<PeriodDetailDto> = {}): PeriodDetailDto => ({
    ...period(),
    standings: [
      picks({ rank: 1, name: "Sprinter", picks: 19, correctPicks: 19, points: 190, accuracy: 100, prizeEligible: false, prizeRank: null, allocation: NONE }),
      picks({ rank: 2, name: "MARKYYESTER", prizeRank: 1 }),
      picks({ rank: 3, tied: true, name: "Tie A", points: 120, correctPicks: 12, picks: 20, accuracy: 60, prizeRank: 2, allocation: ALLOC("17,500") }),
      picks({ rank: 3, tied: true, name: "Tie B", points: 120, correctPicks: 12, picks: 20, accuracy: 60, prizeRank: 2, allocation: ALLOC("17,500") }),
    ],
    standingsCut: 0,
    ...over,
  });
  const view = (d: PeriodDetailDto) => renderToStaticMarkup(createElement(ResultsBody, { period: d, classes: CLASSES, tokenLaunched: false }));

  it("lists Rank · Player · Points · Correct · Eligibility · Reward — the below-minimum leader is marked and gets no prize", () => {
    const html = view(detail());
    const t = text(html);
    expect(t).toMatch(/OCT 14/);
    expect(t).toMatch(/Wednesday 14 October 2026/);
    expect(t).toMatch(/Final results · Finalized 2026-10-15/);
    expect((html.match(/data-testid="standing-row"/g) ?? []).length).toBe(4);
    expect(t).toMatch(/Sprinter[\s\S]*Below minimum Picks/);
    expect(t).toMatch(/MARKYYESTER[\s\S]*30,000 \$CLANKRPG allocated/);
    expect((html.match(/>TIE</g) ?? []).length).toBe(2);
    expect(t).toMatch(/Ranked by correct Picks, then accuracy/);
    expect(t).toMatch(/A prize needs at least 20 valid Picks/);
    expect(t).toMatch(/Prize pool for this period: 100,000 \$CLANKRPG/);
    expect(t).toMatch(/not a payment, and claims open once \$CLANKRPG launches/);
    expect(html).toContain('href="/leaderboard"');
  });

  it("Hero Arena: wins-only ranking, no Picks eligibility wording, and 'recognition only' when no pool was set", () => {
    const d: PeriodDetailDto = { ...period({ program: "hero", champions: [hero()], rules: { minimum: 1, minimumUnit: "wins", prizePool: null, symbol: "$CLANKRPG", recognitionOnly: true } }), standings: [hero(), hero({ rank: 2, name: "Second", wins: 30, tied: false })], standingsCut: 0 };
    const t = text(view(d));
    expect(t).toMatch(/Ranked by Arena wins in the period/);
    expect(t).toMatch(/nothing else breaks a tie/);
    expect(t).toMatch(/A prize needs at least 1 win\./);
    expect(t).toMatch(/No prize pool applied to this period: recognition only/);
    expect(t).not.toMatch(/Below minimum Picks|valid Picks/);
    expect(t).toMatch(/Epic Ranger[\s\S]*Epic|PWR 185/);
  });

  it("a period with no eligible winner still shows the real standings, with the reason", () => {
    const d = detail({ outcome: "NO_ELIGIBLE_WINNER", champions: [], standings: [picks({ rank: 1, name: "Sprinter", picks: 12, correctPicks: 12, prizeEligible: false, prizeRank: null, allocation: NONE })] });
    const t = text(view(d));
    expect(t).toMatch(/No eligible winner\./);
    expect(t).toMatch(/Nobody reached the 20-Pick minimum/);
    expect(t).toMatch(/Sprinter/);
  });

  it("says how many tied entries the cap cut off, and shows the honest empty state for an unfrozen period", () => {
    expect(text(view(detail({ standingsCut: 6 })))).toMatch(/\+6 more tied inside the Top 10/);
    const t = text(view({ ...period({ outcome: "FINALIZING", champions: [], finalizedAt: null, rules: null }), standings: [], standingsCut: 0 }));
    expect(t).toMatch(/FINALIZING/);
    expect(t).toMatch(/being frozen/);
  });
});

describe("mobile and responsive structure", () => {
  it("is built to shrink: one column below sm, tabs that wrap, names that truncate or fit, no fixed widths that can overflow a 320 px screen", () => {
    const html = render({ data: list([period(), period({ start: "2026-10-13" }), period({ start: "2026-10-12" }), period({ start: "2026-10-11" })]) });
    expect(html).toContain("max-w-[1000px]");
    expect(html).toContain("grid-cols-2"); // the two competition tabs share the row on a phone
    expect(html).toContain("sm:grid-cols-2"); // previous champions: 1 column on a phone, 2 from sm
    expect(html).toContain("sm:hidden"); // the compact stat grid only on phones; the roomy one from sm
    expect(html).toMatch(/min-w-0/);
    expect(html).not.toMatch(/style="[^"]*width:\s*(3[3-9]\d|[4-9]\d\d)px/); // no pixel width wider than a 320 px viewport minus gutters on any card
  });
});

describe("details that are easy to get wrong", () => {
  it("the heading never repeats itself before the launch (EVENTS, not EVENTS EVENTS) and carries the season name after it", () => {
    const pre = text(render({ data: list([], { state: state({ phase: "PRE_SEASON", season: null }) }) }));
    expect(pre).toMatch(/^\s*Events Pre-season/);
    expect(pre).not.toMatch(/Events Events/i);
    expect(text(render())).toMatch(/^\s*Season 1 Events Season 1/);
  });
  it("tells the reader when the board's leader is NOT the champion (the leader was below the Pick minimum)", () => {
    const d: PeriodDetailDto = {
      ...period({ leader: { name: "Sprinter", picks: 19, correctPicks: 19, minimum: 20 } }),
      standings: [picks({ rank: 1, name: "Sprinter", picks: 19, correctPicks: 19, prizeEligible: false, prizeRank: null, allocation: NONE }), picks({ rank: 2, name: "MARKYYESTER" })],
      standingsCut: 0,
    };
    const t = text(renderToStaticMarkup(createElement(ResultsBody, { period: d, classes: CLASSES, tokenLaunched: false })));
    expect(t).toMatch(/Sprinter led the board with 19 correct of 19 Picks but did not reach the 20-Pick minimum, so the champion is the first prize-eligible player: MARKYYESTER/);
  });
});
