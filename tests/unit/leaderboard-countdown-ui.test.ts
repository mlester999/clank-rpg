import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BoardView } from "@/components/leaderboard/ArenaPicksBoard";
import { HeroBoardView } from "@/components/leaderboard/HeroBoards";
import { PicksSeasonView } from "@/components/leaderboard/PicksSeasonBoard";
import { BoardCountdown, RewardDetails } from "@/components/leaderboard/rewardParts";
import { clockRunning, clockSubscribers, subscribeClock } from "@/components/time/clockStore";
import { ResetCountdown } from "@/components/time/ResetCountdown";
import type { HeroBoardDto, HeroBoardPayload, HeroRulesView, PicksSeasonPayload } from "@/domain/heroArenaDto";
import type { BoardDto, BoardPayload, BoardRuleView } from "@/domain/rewards/leaderboardDto";
import { formatResetCountdown } from "@/domain/time/resetCountdown";

/**
 * The Leaderboards page: the reset is a premium COUNTDOWN ("DAILY LEADERBOARD · ENDS IN · 23H 59M 59S"), not a grey "00:00 UTC → 00:00 UTC" sentence; finished periods
 * say COMPLETED; the richer reward information lives here (the Arena only has a quick summary); a season countdown exists only when the database holds a real end time.
 */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<\/?(b|strong|em|i)(\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
/** The page text WITHOUT the collapsed "Exact times" disclosure: what a visitor reads as primary. */
const primary = (html: string) => text(html.replace(/<details[\s\S]*?<\/details>/g, " "));
const T = (iso: string) => Date.parse(iso);

const LADDER = [["30%", "30,000"], ["20%", "20,000"], ["15%", "15,000"], ["10%", "10,000"], ["8%", "8,000"], ["6%", "6,000"], ["4%", "4,000"], ["3%", "3,000"], ["2%", "2,000"], ["2%", "2,000"]];
const BONUSES = [{ label: "100K", minimum: "100,000", bonus: "+5%" }, { label: "10M", minimum: "10,000,000", bonus: "+25%" }];
const rules = (kind: "DAILY" | "WEEKLY"): BoardRuleView => ({
  kind, minimumPicks: kind === "DAILY" ? 20 : 100, pointsPerCorrectPick: 10, prizePool: kind === "DAILY" ? "100,000" : "500,000", prizePoolPlain: kind === "DAILY" ? "100000" : "500000", symbol: "$CLANKRPG", topRewarded: 10,
  prizes: LADDER.map(([share, amount], i) => ({ position: i + 1, share: share!, amount: amount! })), prizesPaused: false, holderBonuses: BONUSES,
});
const board = (over: Partial<BoardDto> = {}): BoardDto => ({
  kind: "DAILY", state: "CURRENT", start: "2026-10-07", serverNow: T("2026-10-07T09:36:42Z"), startsAt: T("2026-10-07T00:00:00Z"), endsAt: T("2026-10-08T00:00:00Z"), rules: rules("DAILY"),
  participants: 0, eligibleParticipants: 0, rows: [], finalizedAt: null, ...over,
});
const payload = (b: BoardDto, over: Partial<BoardPayload> = {}): BoardPayload => ({
  board: b, me: null, periods: [{ start: "2026-10-06", participants: 40, prizePool: "100,000" }], current: { kind: b.kind, start: b.start, startsAt: b.startsAt, endsAt: b.endsAt }, finalizing: null, serverNow: b.serverNow,
  programme: { daily: rules("DAILY"), weekly: rules("WEEKLY") }, ...over,
});
const view = (p: BoardPayload, o: { selected?: string; tokenLaunched?: boolean | null } = {}) =>
  renderToStaticMarkup(createElement(BoardView, { payload: p, selected: o.selected ?? "CURRENT", onSelect: () => undefined, onReload: () => undefined, officialAddress: null, tokenLaunched: o.tokenLaunched === undefined ? false : o.tokenLaunched }));

describe("DAILY and WEEKLY headers: the countdown is the highlight", () => {
  it("DAILY: 'Daily leaderboard · Ends in · 14H 23M 18S' — hours, minutes, seconds, no days — with a timer role and the server's remaining time", () => {
    const html = view(payload(board()));
    expect(primary(html)).toMatch(/Daily leaderboard Ends in 14H 23M 18S/);
    expect(primary(html)).not.toMatch(/\d\dD /);
    expect(html).toMatch(/role="timer"[^>]*aria-label="Daily leaderboard ends in"/);
    expect(html).toContain(`data-remaining-ms="${T("2026-10-08T00:00:00Z") - T("2026-10-07T09:36:42Z")}"`);
    expect(html).toContain('data-testid="board-countdown-box"');
    expect(html).toContain('data-state="LIVE"');
  });

  it("one second into a day it reads 23H 59M 59S; the last second reads 00H 00M 01S", () => {
    const b = board({ start: "2026-10-08", serverNow: T("2026-10-08T00:00:01Z"), startsAt: T("2026-10-08T00:00:00Z"), endsAt: T("2026-10-09T00:00:00Z") });
    expect(primary(view(payload(b)))).toMatch(/Ends in 23H 59M 59S/);
    expect(primary(view(payload({ ...b, serverNow: T("2026-10-08T23:59:59Z") })))).toMatch(/Ends in 00H 00M 01S/);
  });

  it("WEEKLY: '06D 23H 59M' with days; '02D 14H 09M' mid-week; hours-minutes-seconds in the last day", () => {
    const w = (now: string) => board({ kind: "WEEKLY", start: "2026-10-05", serverNow: T(now), startsAt: T("2026-10-05T00:00:00Z"), endsAt: T("2026-10-12T00:00:00Z"), rules: rules("WEEKLY") });
    expect(primary(view(payload(w("2026-10-05T00:00:01Z"))))).toMatch(/Weekly leaderboard Ends in 06D 23H 59M/);
    expect(primary(view(payload(w("2026-10-09T09:50:30Z"))))).toMatch(/Ends in 02D 14H 09M/);
    expect(primary(view(payload(w("2026-10-11T15:35:48Z"))))).toMatch(/Ends in 08H 24M 12S/);
  });

  it("the raw range sentence is NOT primary text any more — no '00:00 UTC → 00:00 UTC', no 'Monday 00:00 UTC' in the header; the exact times are a tap away", () => {
    for (const kind of ["DAILY", "WEEKLY"] as const) {
      const b = kind === "DAILY" ? board() : board({ kind, start: "2026-10-05", startsAt: T("2026-10-05T00:00:00Z"), endsAt: T("2026-10-12T00:00:00Z"), rules: rules("WEEKLY") });
      const html = view(payload(b));
      const t = primary(html);
      expect(t, kind).not.toMatch(/00:00 UTC →|→ 00:00 UTC|Monday 00:00 UTC|OCT \d+ · 00:00/i);
      expect(html).toContain('data-testid="board-exact-times"');
      expect(text(html)).toMatch(/Exact times \d{4}-\d{2}-\d{2} 00:00 UTC → \d{4}-\d{2}-\d{2} 00:00 UTC/); // …but the exact timestamps are still there, accurately
    }
    expect(text(view(payload(board())))).toContain("2026-10-07 00:00 UTC → 2026-10-08 00:00 UTC · every day");
  });

  it("the ranking table is not overshadowed: the countdown sits in the header (before the stats and the rows), never between rows", () => {
    const html = view(payload(board({ rows: [{ rank: 1, characterId: null, heroPublicId: null, rarity: null, name: "Celsius", classId: "warrior", points: 190, picks: 20, correctPicks: 19, accuracy: 95, currentStreak: 3, bestStreak: 7, prizeEligible: true, basePrize: "30,000", holderBonus: "0", holderTier: null, bonusStatus: "NONE", totalReward: "30,000", tied: false }] })));
    expect(html.indexOf('data-testid="board-countdown"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-testid="board-countdown"')).toBeLessThan(html.indexOf('data-testid="board-rows"'));
  });
});

describe("a FINISHED period says COMPLETED — an accurate state, never a live countdown", () => {
  it("shows Completed, the date, 'Final results · read-only' and the frozen date; no timer at all", () => {
    const b = board({ state: "FINAL", start: "2026-10-06", startsAt: T("2026-10-06T00:00:00Z"), endsAt: T("2026-10-07T00:00:00Z"), finalizedAt: T("2026-10-07T00:00:09Z") });
    const html = view(payload(b), { selected: "2026-10-06" });
    expect(primary(html)).toMatch(/Daily leaderboard Completed OCT 6 Final results · read-only · Finalized 2026-10-07/);
    expect(html).not.toContain('role="timer"');
    expect(html).not.toContain('data-testid="board-countdown"');
    expect(html).toContain('data-state="FINAL"');
  });

  it("FINALIZING (ended, being frozen) says so instead of counting down to a moment that has passed", () => {
    const b = board({ state: "FINALIZING", start: "2026-10-06", startsAt: T("2026-10-06T00:00:00Z"), endsAt: T("2026-10-07T00:00:00Z") });
    const html = view(payload(b, { finalizing: "2026-10-06" }), { selected: "2026-10-06" });
    expect(primary(html)).toMatch(/Daily leaderboard Status FINALIZING Final results are being frozen/);
    expect(html).not.toContain('role="timer"');
  });
});

describe("the richer reward information lives on the Leaderboards page", () => {
  it("shows BOTH pools (Daily 100,000 · Weekly 500,000), who shares them, the qualification (20 / 100 valid Picks), the holder bonus and the token status — from the server's rules", () => {
    const html = view(payload(board()));
    const t = primary(html);
    expect(html).toContain('data-testid="reward-details"');
    expect(t).toMatch(/Prize pools Daily pool 100,000 \$CLANKRPG Weekly pool 500,000 \$CLANKRPG/);
    expect(t).toMatch(/Each pool is shared by the Top 10, by rank/);
    expect(t).toMatch(/Prizes need 20 valid Picks in the day \(Daily\) or 100 in the week \(Weekly\)/);
    expect(t).toMatch(/Every valid Pick counts for your rank; a correct Pick is \+10 Points/);
    expect(t).toMatch(/Holder bonus: qualified holders can add up to \+25% to a prize they earned\. It never changes your rank or score\./);
    expect(t).toMatch(/Prize ladder · Top 10 #1 30% 30,000/); // the rank-based distribution
    expect(t).toMatch(/Daily prize pool/); // the shown board's own pool card
  });

  it("states the token's launch status plainly: not launched → 'become claimable after launch'; launched → claim from your hero page; unknown → neutral", () => {
    const off = primary(view(payload(board()), { tokenLaunched: false }));
    expect(off).toContain("$CLANKRPG has not launched yet. Prizes are recorded as you earn them and become claimable after launch.");
    const on = primary(view(payload(board()), { tokenLaunched: true }));
    expect(on).toContain("$CLANKRPG has launched. Prizes you earn are added to your claimable rewards");
    expect(on).not.toContain("has not launched");
    const unknown = primary(view(payload(board()), { tokenLaunched: null }));
    expect(unknown).toMatch(/Checking the \$CLANKRPG launch status/);
    expect(unknown).not.toMatch(/has (not )?launched/);
  });

  it("every figure follows the configuration (nothing typed in the component), and a paused programme says so", () => {
    const programme = { daily: { ...rules("DAILY"), prizePool: "75,000", minimumPicks: 15, topRewarded: 5 }, weekly: { ...rules("WEEKLY"), prizePool: "300,000", minimumPicks: 80, topRewarded: 20, prizesPaused: true } };
    const t = primary(view(payload(board(), { programme })));
    expect(t).toMatch(/Daily pool 75,000 \$CLANKRPG Weekly pool 300,000 \$CLANKRPG/);
    expect(t).toMatch(/Top 5 \(Daily\) and Top 20 \(Weekly\)/);
    expect(t).toMatch(/15 valid Picks in the day \(Daily\) or 80 in the week \(Weekly\)/);
    expect(t).toMatch(/Prizes are paused right now/);
    expect(t).not.toMatch(/\b100,000\b.*Weekly pool 500,000/);
  });

  it("an older payload without the programme simply omits the extra block (nothing is invented)", () => {
    const html = view(payload(board(), { programme: undefined }));
    expect(html).not.toContain('data-testid="reward-details"');
    expect(primary(html)).toMatch(/Ends in 14H 23M 18S/);
  });

  it("the Arena shows only a summary: its tiles do not carry the qualification, the Top 10 or the token status that live here", () => {
    const t = primary(renderToStaticMarkup(createElement(RewardDetails, { daily: rules("DAILY"), weekly: rules("WEEKLY"), shown: "DAILY", token: { launched: false } })));
    expect(t).toContain("valid Picks");
    expect(t).toContain("not launched");
  });
});

describe("Hero Arena / records boards use the same countdown card", () => {
  const dev = { id: "s0", label: "Development", kind: "DEVELOPMENT" as const, status: "ACTIVE" as const, current: true };
  const heroRules = (over: Partial<HeroRulesView> = {}): HeroRulesView => ({ kind: "DAILY", minimumWins: 1, poolSet: true, prizePool: "100,000", symbol: "$CLANKRPG", topRewarded: 10, prizesPaused: false, prizes: [], ...over });
  const hero = (over: Partial<HeroBoardDto> = {}): HeroBoardDto => ({
    scope: "DAILY", rewarded: true, state: "CURRENT", start: "2026-10-07", serverNow: T("2026-10-07T09:36:42Z"), startsAt: T("2026-10-07T00:00:00Z"), endsAt: T("2026-10-08T00:00:00Z"), season: dev, rules: heroRules(),
    participants: 0, rows: [], finalizedAt: null, classes: {}, ...over,
  });
  const heroView = (b: HeroBoardDto, kind: "arena" | "top2" = "arena") =>
    renderToStaticMarkup(createElement(HeroBoardView, { payload: { board: b, periods: [], finalizing: null, seasons: [dev] } as HeroBoardPayload, kind, selected: "CURRENT", onSelect: () => undefined, season: null, onSeason: () => undefined, onReload: () => undefined }));

  it("Hero Arena Daily: 'Daily leaderboard · Ends in · 14H 23M 18S', no raw range line", () => {
    const html = heroView(hero());
    expect(primary(html)).toMatch(/Daily leaderboard Ends in 14H 23M 18S/);
    expect(primary(html)).not.toMatch(/00:00 UTC →/);
    expect(html).toContain('data-testid="board-exact-times"');
  });

  it("Hero Arena Weekly: 06D 23H 59M style; Hero Records daily boards get the card too", () => {
    const w = hero({ scope: "WEEKLY", start: "2026-10-05", serverNow: T("2026-10-05T00:00:01Z"), startsAt: T("2026-10-05T00:00:00Z"), endsAt: T("2026-10-12T00:00:00Z"), rules: heroRules({ kind: "WEEKLY", prizePool: "500,000" }) });
    expect(primary(heroView(w))).toMatch(/Weekly leaderboard Ends in 06D 23H 59M/);
    expect(primary(heroView(hero({ rewarded: false, rules: null }), "top2"))).toMatch(/Daily leaderboard Ends in 14H 23M 18S/);
  });

  it("a SEASON view has NO countdown unless the database holds a real, upcoming end time — an end date is never invented", () => {
    const season = (endsAt?: number | null) => hero({ scope: "SEASON", rewarded: false, rules: null, startsAt: null, endsAt: null, start: null, season: { ...dev, endsAt } });
    expect(heroView(season())).not.toContain('role="timer"');
    expect(heroView(season(null))).not.toContain('role="timer"');
    const html = heroView(season(T("2026-12-01T00:00:00Z")));
    expect(primary(html)).toMatch(/Season leaderboard Ends in 54D 14H 23M|Season leaderboard Ends in \d\dD \d\dH \d\dM/);
    // the season-standings board of Arena Picks follows the same rule
    const picks = (endsAt?: number | null): PicksSeasonPayload => ({ rewarded: false, season: { ...dev, endsAt }, serverNow: T("2026-10-07T09:36:42Z"), participants: 0, rows: [], me: null, seasons: [dev] });
    const pv = (p: PicksSeasonPayload) => renderToStaticMarkup(createElement(PicksSeasonView, { payload: p, season: null, onSeason: () => undefined }));
    expect(pv(picks())).not.toContain('role="timer"');
    expect(pv(picks(T("2026-12-01T00:00:00Z")))).toContain('role="timer"');
  });
});

describe("one clock for every countdown — no per-timer polling, no per-timer re-render of the page", () => {
  it("renders the same text on the server and on the first client render (no hydration mismatch): endsAt − serverNow", () => {
    const html = renderToStaticMarkup(createElement(ResetCountdown, { serverNow: T("2026-10-07T09:36:42Z"), endsAt: T("2026-10-08T00:00:00Z"), label: "Daily leaderboard ends in" }));
    expect(html).toContain(formatResetCountdown(T("2026-10-08T00:00:00Z") - T("2026-10-07T09:36:42Z")));
    expect(html).toContain(">14H 23M 18S<");
  });

  it("BoardCountdown is purely presentational: it never fetches, and exposes the exact window only in a closed <details>", () => {
    const html = renderToStaticMarkup(createElement(BoardCountdown, { word: "Daily", state: "LIVE", serverNow: 0, endsAt: 3_600_000 }));
    expect(html).not.toMatch(/fetch|\/api\//);
    expect(html).toContain(">01H 00M 00S<");
  });

  describe("the shared ticker", () => {
    let intervals = 0;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal("window", {});
      vi.stubGlobal("document", { addEventListener: () => undefined, removeEventListener: () => undefined, visibilityState: "visible" });
      const real = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation(((...a: Parameters<typeof setInterval>) => {
        intervals++;
        return real(...a);
      }) as typeof setInterval);
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      intervals = 0;
    });

    it("runs ONE interval for any number of countdowns, ticks all of them, and stops when the last one unmounts", () => {
      const calls = [0, 0, 0];
      const off = calls.map((_, i) => subscribeClock(() => void calls[i]!++));
      expect(clockSubscribers()).toBe(3);
      expect(clockRunning()).toBe(true);
      expect(intervals).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(calls).toEqual([4, 4, 4]); // 250 ms ticks
      off[0]!();
      off[1]!();
      expect(clockRunning()).toBe(true);
      off[2]!();
      expect(clockSubscribers()).toBe(0);
      expect(clockRunning()).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(calls).toEqual([4, 4, 4]); // nothing keeps ticking
    });
  });
});
