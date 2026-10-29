import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BoardRulesList } from "@/components/leaderboard/BoardInfo";
import { BoardView, periodLabel } from "@/components/leaderboard/ArenaPicksBoard";
import type { BoardDto, BoardPayload, BoardRowDto, BoardRuleView } from "@/domain/rewards/leaderboardDto";

/** The Daily / Weekly Arena Picks boards, server-rendered from fixtures: what a player is shown, in the spec's words. */
// Bold / italic are inline (no whitespace appears around them in a browser); every other tag separates words.
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<\/?(b|strong|em|i)(\s[^>]*)?>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const T = (iso: string) => Date.parse(iso);

const LADDER = [["30%", "150,000"], ["20%", "100,000"], ["15%", "75,000"], ["10%", "50,000"], ["8%", "40,000"], ["6%", "30,000"], ["4%", "20,000"], ["3%", "15,000"], ["2%", "10,000"], ["2%", "10,000"]];
const WEEKLY_LADDER = [["30%", "300,000"], ["20%", "200,000"], ["15%", "150,000"], ["10%", "100,000"], ["8%", "80,000"], ["6%", "60,000"], ["4%", "40,000"], ["3%", "30,000"], ["2%", "20,000"], ["2%", "20,000"]];
const BONUSES = [{ label: "100K", minimum: "100,000", bonus: "+5%" }, { label: "500K", minimum: "500,000", bonus: "+10%" }, { label: "1M", minimum: "1,000,000", bonus: "+15%" }, { label: "5M", minimum: "5,000,000", bonus: "+20%" }, { label: "10M", minimum: "10,000,000", bonus: "+25%" }];
const rules = (kind: "DAILY" | "WEEKLY"): BoardRuleView => ({
  kind, minimumPicks: kind === "DAILY" ? 20 : 100, pointsPerCorrectPick: 10, prizePool: kind === "DAILY" ? "500,000" : "1,000,000", prizePoolPlain: kind === "DAILY" ? "500000" : "1000000", symbol: "$CLANKRPG", topRewarded: 10,
  prizes: (kind === "DAILY" ? LADDER : WEEKLY_LADDER).map(([share, amount], i) => ({ position: i + 1, share: share!, amount: amount! })), prizesPaused: false, holderBonuses: BONUSES,
});
const row = (rank: number, name: string, over: Partial<BoardRowDto> = {}): BoardRowDto => ({
  rank, characterId: null, heroPublicId: null, rarity: null, name, classId: "warrior", points: 200 - rank * 10, picks: 20, correctPicks: 20 - rank, accuracy: 100 - rank * 5, currentStreak: 3, bestStreak: 7, prizeEligible: true,
  basePrize: LADDER[rank - 1]?.[1] ?? "0", holderBonus: "0", holderTier: null, bonusStatus: "NONE", totalReward: LADDER[rank - 1]?.[1] ?? "0", tied: false, ...over,
});
const board = (over: Partial<BoardDto> = {}): BoardDto => ({
  kind: "DAILY", state: "CURRENT", start: "2026-10-07", serverNow: T("2026-10-07T09:36:42Z"), startsAt: T("2026-10-07T00:00:00Z"), endsAt: T("2026-10-08T00:00:00Z"), rules: rules("DAILY"),
  participants: 3, eligibleParticipants: 2, rows: [row(1, "Celsius"), row(2, "Leon"), row(3, "Mia", { prizeEligible: false, basePrize: "0", totalReward: "0" })], finalizedAt: null, ...over,
});
const payload = (b: BoardDto, over: Partial<BoardPayload> = {}): BoardPayload => ({
  board: b, me: { rank: 2, points: 120, picks: 17, correctPicks: 12, accuracy: 70.6, prizeEligible: true, picksToEligible: 0 },
  periods: [{ start: "2026-10-06", participants: 40, prizePool: "100,000" }, { start: "2026-10-05", participants: 33, prizePool: "100,000" }, { start: "2026-10-04", participants: 28, prizePool: "100,000" }],
  current: { kind: b.kind, start: b.start, startsAt: b.startsAt, endsAt: b.endsAt }, finalizing: null, serverNow: b.serverNow, ...over,
});
const view = (p: BoardPayload, selected = "CURRENT") => renderToStaticMarkup(createElement(BoardView, { payload: p, selected, onSelect: () => undefined, onReload: () => undefined, officialAddress: null }));

describe("DAILY ARENA PICKS — the header", () => {
  it("shows the title, the 500,000 pool, TOP 10 REWARDED, a daily countdown with NO days (14H 23M 18S), my score, and the unlimited-picks stats (Picks, Correct, Accuracy, Points, Current rank) — never a 17 / 20 counter", () => {
    const html = view(payload(board()));
    const t = text(html);
    expect(t).toMatch(/Daily Arena Picks/i);
    expect(t).toMatch(/500,000 \$CLANKRPG Daily prize pool/);
    expect(t).toMatch(/Top 10 rewarded/i);
    expect(t).toMatch(/Ends in 14H 23M 18S/);
    expect(t).not.toMatch(/\dD \d\dH/); // a day never shows days
    expect(t).toMatch(/Picks 17 Correct 12 Accuracy 70\.6% Points 120 Current rank #2/);
    expect(t).not.toMatch(/\d+ \/ 20|scored picks today|first 20/i); // the old per-day cap is gone from every word on the page
    expect(html).toContain('data-testid="board-countdown"');
    expect(html).toContain(`data-remaining-ms="${T("2026-10-08T00:00:00Z") - T("2026-10-07T09:36:42Z")}"`);
    expect(html).toContain('data-kind="DAILY"');
  });

  it("one second into a new day the countdown reads 23H 59M 59S and the player's stats are back to zero (no cap counter)", () => {
    const b = board({ start: "2026-10-08", serverNow: T("2026-10-08T00:00:01Z"), startsAt: T("2026-10-08T00:00:00Z"), endsAt: T("2026-10-09T00:00:00Z"), rows: [] });
    const t = text(view(payload(b, { me: { rank: null, points: 0, picks: 0, correctPicks: 0, accuracy: null, prizeEligible: false, picksToEligible: 20 } })));
    expect(t).toMatch(/Ends in 23H 59M 59S/);
    expect(t).toMatch(/Picks 0 Correct 0 Accuracy — Points 0 Current rank — Not ranked yet/);
    expect(t).toMatch(/Not yet prize eligible — make 20 more picks this day \(20 needed\)/);
    expect(t).toMatch(/No ranked players yet\. Make an Arena Pick to enter today's standings\./); // a compact, intentional state — not a large awkward card
  });

  it("WEEKLY reads 06D 23H 59M one second into the week (days, hours, minutes), with the 1,000,000 pool", () => {
    const b = board({ kind: "WEEKLY", start: "2026-10-12", serverNow: T("2026-10-12T00:00:01Z"), startsAt: T("2026-10-12T00:00:00Z"), endsAt: T("2026-10-19T00:00:00Z"), rules: rules("WEEKLY"), rows: [] });
    const t = text(view(payload(b)));
    expect(t).toMatch(/Weekly Arena Picks/i);
    expect(t).toMatch(/1,000,000 \$CLANKRPG Weekly prize pool/);
    expect(t).toMatch(/Weekly leaderboard Ends in 06D 23H 59M/);
    expect(t).not.toMatch(/06D 23H 59M \d\dS/); // with days the seconds are not shown
  });

  it("the signed-out view invites sign-in instead of showing a score", () => {
    const t = text(view(payload(board(), { me: null })));
    expect(t).toMatch(/Picks — Correct — Accuracy — Points — Current rank — Sign in to see yours/);
  });
});

describe("the Top 10 ladder and the rows", () => {
  it("lists all ten prizes from the server's rules — daily and weekly — in order", () => {
    const d = text(view(payload(board())));
    expect(d).toMatch(/Prize ladder · Top 10 #1 30% 150,000 #2 20% 100,000 #3 15% 75,000 #4 10% 50,000 #5 8% 40,000 #6 6% 30,000 #7 4% 20,000 #8 3% 15,000 #9 2% 10,000 #10 2% 10,000/);
    const w = text(view(payload(board({ kind: "WEEKLY", rules: rules("WEEKLY") }))));
    expect(w).toMatch(/#1 30% 300,000 #2 20% 200,000 #3 15% 150,000 #4 10% 100,000 #5 8% 80,000 #6 6% 60,000 #7 4% 40,000 #8 3% 30,000 #9 2% 20,000 #10 2% 20,000/);
  });

  it("a phone gets three tiles to a row (five from sm up), so a six-figure prize is never cut to \"150,0…\" — the same ladder serves both programs", () => {
    const w = view(payload(board({ kind: "WEEKLY", rules: rules("WEEKLY") })));
    const ladder = w.slice(w.indexOf('data-testid="board-ladder"'));
    expect(ladder).toContain("grid-cols-3");
    expect(ladder).toContain("sm:grid-cols-5");
    expect(ladder).not.toContain("grid-cols-5 gap-1 "); // the old phone-width five-up that clipped the amounts
    expect(text(w)).toContain("300,000");
  });

  it("a RUNNING board shows prizes as projections and says holder bonuses are decided at the close; a member under the minimum is marked NOT YET PRIZE ELIGIBLE (never hidden)", () => {
    const html = view(payload(board()));
    const t = text(html);
    expect(t).toMatch(/Prizes shown are a projection from the current standings/);
    expect(t).toMatch(/Holder bonuses are decided at the close/);
    expect(t).toMatch(/Celsius[\s\S]*\+150,000 projected/);
    expect(t).toMatch(/Mia[\s\S]*Not yet prize eligible/i);
    expect(html.match(/data-testid="not-prize-eligible"/g)).toHaveLength(1);
    expect(t).toMatch(/Mia/);
  });

  it("a FINAL board shows base prize, the holder bonus with its tier label and the total; a pending bonus is stated; ineligible reads NOT PRIZE ELIGIBLE", () => {
    const final = board({
      state: "FINAL", finalizedAt: T("2026-10-08T00:00:06Z"), serverNow: T("2026-10-08T01:00:00Z"),
      rows: [
        row(1, "Celsius", { basePrize: "30,000", holderBonus: "7,500", holderTier: "10M", bonusStatus: "CREDITED", totalReward: "37,500" }),
        row(2, "Leon", { bonusStatus: "PENDING" }),
        row(3, "Mia", { prizeEligible: false, basePrize: "0", totalReward: "0" }),
      ],
    });
    const html = view(payload(final, { me: { rank: 1, points: 200, picks: 20, correctPicks: 20, accuracy: 100, prizeEligible: true, picksToEligible: 0, prize: { base: "30,000", bonus: "7,500", total: "37,500", status: "CREDITED", bonusStatus: "CREDITED" } } }), "2026-10-07");
    const t = text(html);
    expect(t).toMatch(/Final results · OCT 7 · read-only/);
    expect(t).toMatch(/Celsius[\s\S]*10M holder[\s\S]*\+37,500 \$CLANKRPG 30,000 \+ 7,500 bonus/);
    expect(t).toMatch(/Leon[\s\S]*Holder bonus pending verification/);
    expect(t).toMatch(/Mia[\s\S]*Not prize eligible/i);
    expect(t).toMatch(/My reward 37,500 Includes a holder bonus of 7,500/);
    expect(t).not.toMatch(/Ends in/);
    expect(html).toContain('data-state="FINAL"');
    expect(t).not.toMatch(/wallet|balance|0x[0-9a-f]{6}/i); // a published result never carries a wallet or balance
  });

  it("a board with prizes switched off says so, and a held prize is only ever described gently to its owner", () => {
    expect(text(view(payload(board({ rules: { ...rules("DAILY"), prizesPaused: true } }))))).toMatch(/Prizes are paused\. Picks and Points continue\./);
    const final = board({ state: "FINAL", finalizedAt: 1, rows: [row(1, "Celsius")] });
    const held = text(view(payload(final, { me: { rank: 1, points: 200, picks: 20, correctPicks: 20, accuracy: 100, prizeEligible: true, picksToEligible: 0, prize: { base: "30,000", bonus: "0", total: "30,000", status: "HELD", bonusStatus: "NONE" } } }), "2026-10-07"));
    expect(held).toMatch(/My reward 30,000 Held for a quick review/);
    expect(held).not.toMatch(/fraud|suspicious|flag|ban/i);
  });
});

describe("history: today, previous days and the board that is being frozen", () => {
  it("shows TODAY then the finished days newest first (OCT 6, OCT 5, OCT 4); the selected one is highlighted", () => {
    const html = view(payload(board()));
    const t = text(html);
    expect(t).toMatch(/Today OCT 6 OCT 5 OCT 4/);
    expect(html).toMatch(/aria-selected="true"[^>]*data-testid="period-current"/);
    const picked = view(payload(board({ state: "FINAL", finalizedAt: 1 })), "2026-10-06");
    expect(picked).toMatch(/aria-selected="true"[^>]*data-testid="period-2026-10-06"/);
  });
  it("the day that just ended shows as FINALIZING until its board is frozen", () => {
    const html = view(payload(board(), { finalizing: "2026-10-06", periods: [{ start: "2026-10-05", participants: 33, prizePool: "100,000" }] }));
    expect(text(html)).toMatch(/Today OCT 6 · finalizing OCT 5/);
    const live = view(payload(board({ state: "FINALIZING" }), { finalizing: "2026-10-06" }), "2026-10-06");
    expect(text(live)).toMatch(/Final results are being frozen/);
    expect(text(live)).toMatch(/Status FINALIZING/);
  });
  it("labels are calendar dates in UTC, never shifted by the viewer's timezone", () => {
    expect(periodLabel("2026-10-06")).toBe("OCT 6");
    expect(periodLabel("2026-01-01")).toBe("JAN 1");
    expect(periodLabel("2026-12-28")).toBe("DEC 28");
  });
  it("no client-side reset exists anywhere in the board: no reset / clear / restart control", () => {
    expect(view(payload(board()))).not.toMatch(/reset|restart|clear board/i);
  });
});

describe("the (i) info popover — HOW DAILY / WEEKLY ARENA PICKS WORKS", () => {
  const info = (kind: "DAILY" | "WEEKLY") => text(renderToStaticMarkup(createElement(BoardRulesList, { rules: rules(kind), officialToken: null })));

  it("DAILY says exactly what the spec says, with every number from the rules", () => {
    const t = info("DAILY");
    expect(t).toMatch(/How Daily Arena Picks works/i);
    expect(t).toContain("Pick the winner of upcoming Arena fights.");
    expect(t).toContain("Every valid Pick counts.");
    expect(t).toMatch(/Correct Pick = \+10 Points\./);
    expect(t).toContain("The leaderboard is a race for the most correct Picks.");
    expect(t).toMatch(/Minimum 20 Picks required for Daily prize eligibility\./);
    expect(t).toMatch(/Top 10 receive \$CLANKRPG — Daily prize pool 500,000\./);
    expect(t).toContain("Holder bonuses increase rewards, never your rank.");
    expect(t).toMatch(/Qualified holders can receive up to \+25%\./);
    expect(t).toContain("Buying tokens during the active leaderboard does not grant an instant bonus.");
    expect(t).not.toMatch(/first 20|scored Picks|Maximum 20|per day cap|Unlimited Arena Picks/i); // no trace of the retired cap
  });
  it("WEEKLY says exactly what the spec says", () => {
    const t = info("WEEKLY");
    expect(t).toMatch(/How Weekly Arena Picks works/i);
    expect(t).toContain("Every valid Pick throughout the week counts.");
    expect(t).toMatch(/Correct Pick = \+10 Points\./);
    expect(t).toMatch(/Minimum 100 Picks required for Weekly prize eligibility\./);
    expect(t).toMatch(/Top 10 rewarded — Weekly prize pool 1,000,000 \$CLANKRPG\./);
    expect(t).toContain("Qualified holder bonus requires verified holding continuity before AND throughout the week.");
    expect(t).toContain("Holder tier never affects leaderboard score.");
    expect(t).toContain("Exact prize-boundary ties share affected prize positions fairly.");
    expect(t).not.toMatch(/first 20|scored Picks|Maximum 20|\/day/i);
    expect(t).toMatch(/Resets every Monday at 00:00 UTC/);
  });
  it("states the bonus ladder as a bonus ON an earned prize, and the official contract only when the server provides it", () => {
    expect(info("DAILY")).toMatch(/Holder prize bonus: 100K \+5% · 500K \+10% · 1M \+15% · 5M \+20% · 10M \+25% — added on top of a prize you earned\./);
    expect(info("DAILY")).not.toMatch(/Official \$CLANKRPG contract/);
    const withToken = text(renderToStaticMarkup(createElement(BoardRulesList, { rules: rules("DAILY"), officialToken: { address: "0x52908400098527886e0f7030069857d2e4169ee7" } })));
    expect(withToken).toContain("Official $CLANKRPG contract: 0x52908400098527886e0f7030069857d2e4169ee7");
  });
});
