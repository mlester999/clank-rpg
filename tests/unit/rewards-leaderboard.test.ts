import { describe, expect, it } from "vitest";

import { failureBackoffMs, isVerificationStale, nextCheckDelayMs } from "@/domain/rewards/holderSchedule";
import { accuracyBps, accuracyPercent, anchorServerClock, compareBoard, countdownParts, distributePrizes, formatCountdown, positionPrizes, rankBoard, serverNowFrom, type BoardRowInput } from "@/domain/rewards/leaderboard";
import { firstPeriodStartAtOrAfter, isPeriodStart, periodHasEnded, periodWindow, periodWindowOf, previousPeriodStart, utcWeekStart } from "@/domain/rewards/time";
import { DEFAULT_SETTINGS } from "@/domain/settings";

const E18 = 10n ** 18n;
const T = (iso: string) => Date.parse(iso);
/** A board row: `picks` valid picks of which `correct` were right; Points are 10 per correct pick (the display score). */
const row = (userId: number, picks: number, correct: number): BoardRowInput => ({ userId, points: correct * 10, picks, correct });
const LADDER = DEFAULT_SETTINGS.arena_picks.prizeSplitBps;

describe("the canonical DAY: 00:00:00 UTC → next 00:00:00 UTC (never the viewer's timezone)", () => {
  it("23:59:59.999 is still the OLD day; 00:00:00.000 starts the new one; the window is exactly 24 h, end-exclusive", () => {
    expect(periodWindow("DAILY", T("2026-10-06T23:59:59.999Z")).start).toBe("2026-10-06");
    expect(periodWindow("DAILY", T("2026-10-07T00:00:00.000Z")).start).toBe("2026-10-07");
    const w = periodWindow("DAILY", T("2026-10-07T13:45:00Z"));
    expect(w).toEqual({ kind: "DAILY", start: "2026-10-07", startsAt: T("2026-10-07T00:00:00Z"), endsAt: T("2026-10-08T00:00:00Z") });
    expect(w.endsAt - w.startsAt).toBe(86_400_000);
    expect(periodWindow("DAILY", w.endsAt).start).toBe("2026-10-08");
  });
  it("is stable across month/year boundaries and a leap day", () => {
    expect(periodWindow("DAILY", T("2026-12-31T23:59:59Z")).endsAt).toBe(T("2027-01-01T00:00:00Z"));
    expect(periodWindow("DAILY", T("2028-02-29T12:00:00Z")).start).toBe("2028-02-29");
    expect(previousPeriodStart("DAILY", "2026-10-07")).toBe("2026-10-06");
    expect(previousPeriodStart("DAILY", "2026-03-01")).toBe("2026-02-28");
  });
  it("any real date is a valid daily identifier; garbage and impossible dates are not", () => {
    expect(isPeriodStart("DAILY", "2026-10-07")).toBe(true);
    expect(isPeriodStart("DAILY", "2026-02-30")).toBe(false);
    expect(isPeriodStart("DAILY", "2026-13-01")).toBe(false);
    expect(isPeriodStart("DAILY", "nope")).toBe(false);
  });
});

describe("the canonical WEEK: Monday 00:00:00 UTC → next Monday 00:00:00 UTC", () => {
  // 2026-10-05 is a Monday.
  it("Sunday 23:59:59.999 is still the OLD week; Monday 00:00:00.000 starts the new one", () => {
    expect(utcWeekStart(T("2026-10-04T23:59:59.999Z"))).toBe("2026-09-28");
    expect(utcWeekStart(T("2026-10-05T00:00:00.000Z"))).toBe("2026-10-05");
  });
  it("the window is exactly 7 days, end-exclusive, and the next window starts where it ends", () => {
    const w = periodWindow("WEEKLY", T("2026-10-07T13:45:00Z"));
    expect(w).toEqual({ kind: "WEEKLY", start: "2026-10-05", startsAt: T("2026-10-05T00:00:00Z"), endsAt: T("2026-10-12T00:00:00Z") });
    expect(w.endsAt - w.startsAt).toBe(7 * 86_400_000);
    expect(periodWindow("WEEKLY", w.endsAt).start).toBe("2026-10-12");
    expect(previousPeriodStart("WEEKLY", "2026-10-05")).toBe("2026-09-28");
  });
  it("only a Monday is a valid weekly identifier", () => {
    expect(isPeriodStart("WEEKLY", "2026-10-05")).toBe(true);
    expect(isPeriodStart("WEEKLY", "2026-10-06")).toBe(false);
  });
  it("a period has ended exactly at its end instant, never before", () => {
    expect(periodHasEnded("DAILY", "2026-10-07", T("2026-10-08T00:00:00Z") - 1)).toBe(false);
    expect(periodHasEnded("DAILY", "2026-10-07", T("2026-10-08T00:00:00Z"))).toBe(true);
    expect(periodHasEnded("WEEKLY", "2026-10-05", T("2026-10-12T00:00:00Z"))).toBe(true);
    expect(periodWindowOf("WEEKLY", "2026-10-05").endsAt).toBe(T("2026-10-12T00:00:00Z"));
  });
  it("the first period that can count a requirement ending at `ms`: the boundary itself when exact, otherwise the next one", () => {
    expect(firstPeriodStartAtOrAfter("DAILY", T("2026-10-08T20:00:00Z"))).toBe(T("2026-10-09T00:00:00Z"));
    expect(firstPeriodStartAtOrAfter("DAILY", T("2026-10-09T00:00:00Z"))).toBe(T("2026-10-09T00:00:00Z"));
    expect(firstPeriodStartAtOrAfter("WEEKLY", T("2026-10-12T00:00:00Z"))).toBe(T("2026-10-12T00:00:00Z"));
    expect(firstPeriodStartAtOrAfter("WEEKLY", T("2026-10-12T00:00:01Z"))).toBe(T("2026-10-19T00:00:00Z"));
  });
});

describe("countdowns roll over exactly at the boundary (server time, never the browser's wall clock)", () => {
  it("WEEKLY: a fresh week reads 6D 23H 59M 59S one second in; at the end 00D 00H 00M 00S, and the next instant is a whole new week", () => {
    const monday = T("2026-10-12T00:00:00Z");
    const remaining = (now: number) => periodWindow("WEEKLY", now).endsAt - now;
    expect(formatCountdown(countdownParts(remaining(monday + 1000)))).toBe("6D 23H 59M 59S");
    expect(formatCountdown(countdownParts(7 * 86_400_000))).toBe("7D 00H 00M 00S");
    expect(formatCountdown(countdownParts(remaining(monday - 1000)))).toBe("00D 00H 00M 01S");
    const zero = countdownParts(0);
    expect(formatCountdown(zero)).toBe("00D 00H 00M 00S");
    expect(zero.done).toBe(true);
    expect(remaining(monday)).toBe(7 * 86_400_000); // 00:00:00.000 Monday is already the NEW week
  });
  it("DAILY: shows hours without days — 14H 23M 18S, 23H 59M 59S one second into a new day, 00H 00M 00S at the end", () => {
    const remaining = (now: number) => periodWindow("DAILY", now).endsAt - now;
    const at = (iso: string) => formatCountdown(countdownParts(remaining(T(iso))), { withDays: false });
    expect(at("2026-10-07T09:36:42Z")).toBe("14H 23M 18S");
    expect(at("2026-10-07T00:00:01Z")).toBe("23H 59M 59S");
    expect(at("2026-10-07T23:59:59Z")).toBe("00H 00M 01S");
    expect(formatCountdown(countdownParts(0), { withDays: false })).toBe("00H 00M 00S");
    // 00:00:00.000 is the new day with a full 24 h left (never 0, never negative): the UI resets to 23H 59M 59S one second later.
    expect(remaining(T("2026-10-08T00:00:00Z"))).toBe(86_400_000);
  });
  it("never goes negative, and a partial second rounds UP so the display never reads 0 while time remains", () => {
    expect(countdownParts(-5000)).toEqual({ days: 0, hours: 0, minutes: 0, seconds: 0, done: true });
    expect(countdownParts(1)).toMatchObject({ seconds: 1, done: false });
    expect(countdownParts(999)).toMatchObject({ seconds: 1, done: false });
  });
  it("CLOCK SKEW: the displayed time follows the SERVER clock plus a monotonic delta — the user's wall clock is irrelevant", () => {
    const serverNow = T("2026-10-07T23:59:50Z"); // 10 s before the boundary, per the SERVER
    const clock = anchorServerClock(serverNow, 1_000_000);
    const nowAt = (monotonic: number) => serverNowFrom(clock, monotonic);
    expect(periodWindow("DAILY", serverNow).endsAt - nowAt(1_000_000)).toBe(10_000);
    expect(periodWindow("DAILY", serverNow).endsAt - nowAt(1_004_000)).toBe(6_000);
    expect(countdownParts(periodWindow("DAILY", serverNow).endsAt - nowAt(1_010_000)).done).toBe(true);
  });
});

describe("ranking: CORRECT PICKS, then accuracy; ties are never broken by anything else", () => {
  it("more correct picks always wins — a perfect small sample cannot beat a bigger correct count", () => {
    expect(compareBoard(row(1, 10, 10), row(2, 20, 19))).toBe(1); // 10/10 = 100% still ranks below 19 correct
    expect(compareBoard(row(1, 80, 45), row(2, 60, 44))).toBe(-1);
  });
  it("equal correct picks → the higher ACCURACY (correct ÷ picks, cross-multiplied — no float error) ranks first", () => {
    expect(compareBoard(row(1, 50, 40), row(2, 60, 40))).toBe(-1); // 80 % beats 66.7 %
    expect(compareBoard(row(1, 3, 1), row(2, 3, 1))).toBe(0); // identical correct AND picks is the only exact tie
    expect(compareBoard(row(1, 7, 0), row(2, 5, 0))).toBe(0); // nobody correct: accuracy 0 either way
    expect(compareBoard(row(1, 0, 0), row(2, 5, 1))).toBe(1);
    expect(accuracyBps(1, 3)).toBe(3333);
    expect(accuracyBps(0, 0)).toBe(0);
  });
  it("accuracy displays rounded to ONE decimal exactly as specified: 28/47 → 59.6 %, 188/321 → 58.6 %, 15/18 → 83.3 %", () => {
    expect(accuracyPercent(28, 47)).toBe(59.6);
    expect(accuracyPercent(188, 321)).toBe(58.6);
    expect(accuracyPercent(15, 18)).toBe(83.3);
    expect(accuracyPercent(0, 0)).toBe(0);
    expect(accuracyPercent(1, 3)).toBe(33.3);
  });
  it("orders by correct desc then accuracy desc; equal members get the SAME competition rank (1, 1, 3)", () => {
    const ranked = rankBoard([row(10, 30, 25), row(11, 30, 25), row(12, 32, 25), row(13, 31, 26)], 20);
    expect(ranked.map((r) => [r.row.userId, r.rank])).toEqual([[13, 1], [10, 2], [11, 2], [12, 4]]);
    expect(ranked.find((r) => r.row.userId === 10)!.tieSize).toBe(2);
    expect(ranked.find((r) => r.row.userId === 13)!.tieSize).toBe(1);
  });
  it("the example race: 52 correct (520 Points) beats 48 (480) beats 45 (450)", () => {
    const ranked = rankBoard([row(3, 80, 45), row(1, 90, 52), row(2, 85, 48)], 20);
    expect(ranked.map((r) => [r.row.userId, r.rank, r.row.correct, r.row.points])).toEqual([[1, 1, 52, 520], [2, 2, 48, 480], [3, 3, 45, 450]]);
  });
  it("the order is deterministic and independent of input order, and NOTHING else (no balance, tier, wallet or account age) enters it", () => {
    const rows = [row(5, 20, 5), row(3, 20, 5), row(9, 20, 8)];
    expect(rankBoard(rows, 20).map((r) => r.row.userId)).toEqual(rankBoard([...rows].reverse(), 20).map((r) => r.row.userId));
    // The shape of the input is the whole truth: there is no field a holding could ride in on.
    expect(Object.keys(rows[0]!).sort()).toEqual(["correct", "picks", "points", "userId"]);
  });
  it("minimum participation: below it a member stays on the board but is NOT prize-eligible and takes no prize position", () => {
    const ranked = rankBoard([row(1, 1, 1) /* 100% on one pick */, row(2, 40, 20), row(3, 30, 15)], 20);
    expect(ranked.map((r) => [r.row.userId, r.rank, r.prizeEligible, r.prizeRank])).toEqual([[2, 1, true, 1], [3, 2, true, 2], [1, 3, false, null]]);
    // 1 pick, 1 correct, 100% accuracy cannot game eligibility, nor win a tie-break against a real participant:
    const tie = rankBoard([row(1, 1, 1), row(2, 25, 20)], 20);
    expect(tie.find((r) => r.row.userId === 1)!.prizeEligible).toBe(false);
    expect(tie.find((r) => r.row.userId === 2)!.prizeRank).toBe(1);
  });
  it("DAILY minimum 20 picks: 19 picks are not prize-eligible, 20 are (whatever the accuracy)", () => {
    const [nineteen, twenty] = [rankBoard([row(1, 19, 19)], 20)[0]!, rankBoard([row(2, 20, 1)], 20)[0]!];
    expect([nineteen.prizeEligible, nineteen.prizeRank]).toEqual([false, null]);
    expect([twenty.prizeEligible, twenty.prizeRank]).toEqual([true, 1]);
  });
  it("WEEKLY minimum 100 picks: 99 are not prize-eligible, 100 are", () => {
    expect(rankBoard([row(1, 99, 90)], 100)[0]!.prizeEligible).toBe(false);
    expect(rankBoard([row(1, 100, 10)], 100)[0]!.prizeEligible).toBe(true);
  });
  it("a NOT-ELIGIBLE member may rank above eligible ones on the board without taking a prize position", () => {
    const r = rankBoard([row(1, 5, 5), row(2, 12, 4), row(3, 12, 3)], 10);
    expect(r.map((x) => [x.row.userId, x.rank, x.prizeRank])).toEqual([[1, 1, null], [2, 2, 1], [3, 3, 2]]);
  });
  it("the minimum is configurable: 0 makes everyone with at least one pick eligible", () => {
    expect(rankBoard([row(1, 1, 1)], 0)[0]!.prizeEligible).toBe(true);
    expect(rankBoard([row(1, 0, 0)], 0)[0]!.prizeEligible).toBe(false);
  });
  it("there is NO per-day cap anywhere in the rules: 200 picks in a day rank by all of them", () => {
    expect(rankBoard([row(1, 200, 120), row(2, 20, 20)], 20).map((r) => r.row.userId)).toEqual([1, 2]);
  });
});

describe("the payout ladder: ONE configured ladder, two pools", () => {
  const eligible = (rows: BoardRowInput[]) => rankBoard(rows, 0).filter((r) => r.prizeEligible).map((r) => ({ userId: r.row.userId, row: r.row }));
  const byUser = (res: ReturnType<typeof distributePrizes>) => Object.fromEntries(res.awards.map((a) => [a.userId, a.prizeMicro]));
  const DAILY = 100_000n * E18;
  const WEEKLY = 500_000n * E18;
  const tenWinners = Array.from({ length: 12 }, (_, i) => row(i + 1, 40, 30 - i));

  it("ships the FINAL defaults as settings: daily 500,000, weekly 1,000,000, Top 10 at 30/20/15/10/8/6/4/3/2/2 %", () => {
    const c = DEFAULT_SETTINGS.arena_picks;
    expect([c.dailyPrizePool, c.weeklyPrizePool]).toEqual(["500000", "1000000"]);
    expect(c.prizeSplitBps).toEqual([3000, 2000, 1500, 1000, 800, 600, 400, 300, 200, 200]);
    expect(c.prizeSplitBps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect([c.pointsPerCorrectPick, c.dailyMinimumPicks, c.weeklyMinimumPicks]).toEqual([10, 20, 100]);
    expect("scoredPicksPerDay" in c).toBe(false); // the per-day scoring cap is gone from the configuration entirely
  });
  it("DAILY 100,000: 30,000 / 20,000 / 15,000 / 10,000 / 8,000 / 6,000 / 4,000 / 3,000 / 2,000 / 2,000", () => {
    expect(positionPrizes(DAILY, LADDER).map((p) => p / E18)).toEqual([30_000n, 20_000n, 15_000n, 10_000n, 8_000n, 6_000n, 4_000n, 3_000n, 2_000n, 2_000n]);
  });
  it("WEEKLY 500,000: 150,000 / 100,000 / 75,000 / 50,000 / 40,000 / 30,000 / 20,000 / 15,000 / 10,000 / 10,000 — the SAME percentages", () => {
    expect(positionPrizes(WEEKLY, LADDER).map((p) => p / E18)).toEqual([150_000n, 100_000n, 75_000n, 50_000n, 40_000n, 30_000n, 20_000n, 15_000n, 10_000n, 10_000n]);
  });
  it("twelve eligible players: exactly the Top 10 are paid, #11 and #12 get nothing, and the whole pool is awarded", () => {
    const res = distributePrizes(eligible(tenWinners), DAILY, LADDER);
    expect(res.awards.filter((a) => a.prizeMicro > 0n)).toHaveLength(10);
    expect(byUser(res)[11] ?? 0n).toBe(0n);
    expect(res.awards.reduce((a, x) => a + x.prizeMicro, 0n)).toBe(DAILY);
    expect(res.returnedMicro).toBe(0n);
  });
  it("TIE EXAMPLE: two exactly tied for #2 share positions 2+3 (20,000 + 15,000 = 35,000) → 17,500 each, and the next player occupies #4 (10,000)", () => {
    const res = distributePrizes(eligible([row(1, 20, 15), row(2, 20, 10), row(3, 20, 10), row(4, 20, 8), row(5, 20, 5)]), DAILY, LADDER);
    expect(byUser(res)).toEqual({ 1: 30_000n * E18, 2: 17_500n * E18, 3: 17_500n * E18, 4: 10_000n * E18, 5: 8_000n * E18 });
    expect(res.returnedMicro).toBe(DAILY - (30_000n + 17_500n + 17_500n + 10_000n + 8_000n) * E18);
  });
  it("a tie that reaches past the last rewarded position: everyone tied for a rewarded rank shares the positions that exist", () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(i + 1, 40, 30 - i));
    const res = distributePrizes(eligible([...rows, row(10, 40, 20), row(11, 40, 20), row(12, 40, 20)]), DAILY, LADDER);
    // positions 10 only exists once; three players tied for #10 split its 2,000: each 666.66…, remainder to the reserve.
    expect(res.awards.filter((a) => a.userId >= 10).map((a) => a.prizeMicro)).toEqual([(2_000n * E18) / 3n, (2_000n * E18) / 3n, (2_000n * E18) / 3n]);
    expect(res.awards.reduce((a, x) => a + x.prizeMicro, 0n) + res.returnedMicro).toBe(DAILY);
  });
  it("fewer eligible players than positions: unfilled prizes return to the reserve — never rolled over, never reassigned", () => {
    const res = distributePrizes(eligible([row(1, 20, 15)]), DAILY, LADDER);
    expect(byUser(res)).toEqual({ 1: 30_000n * E18 });
    expect(res.returnedMicro).toBe(70_000n * E18);
    expect(distributePrizes([], DAILY, LADDER)).toMatchObject({ awards: [], returnedMicro: DAILY });
  });
  it("integer remainders are deterministic and CONSERVE the pool for any pool, ladder and tie shape; an exact tie always pays identical amounts", () => {
    for (const pool of [1n, 7n, DAILY, WEEKLY, 123_456_789_012_345_678_901n]) {
      for (const ladder of [LADDER, [5000, 3000, 2000], [10000], [3333, 3333, 3334], [4000, 2000]]) {
        for (const shape of [[1], [2], [3], [1, 1, 1, 1], [2, 2], [1, 3], [4, 4, 4]]) {
          let id = 0;
          const rows: BoardRowInput[] = [];
          shape.forEach((size, g) => { for (let i = 0; i < size; i++) rows.push(row(++id, 40, 30 - g)); });
          const res = distributePrizes(eligible(rows), pool, ladder);
          expect(res.awards.reduce((a, x) => a + x.prizeMicro, 0n) + res.returnedMicro, `pool ${pool} ladder ${ladder} ties ${shape}`).toBe(pool);
          let i = 0;
          for (const size of shape) {
            const group = res.awards.slice(i, i + size).map((a) => a.prizeMicro);
            if (group.length) expect(new Set(group).size).toBe(1);
            i += size;
          }
        }
      }
    }
  });
});

describe("the holder verification schedule", () => {
  it("a successful check is rescheduled ~interval away, spread by ± jitter so wallets don't all fall due together", () => {
    const min = 60_000;
    expect(nextCheckDelayMs(30, 20, 0)).toBe(24 * min);
    expect(nextCheckDelayMs(30, 20, 0.5)).toBe(30 * min);
    expect(nextCheckDelayMs(30, 20, 0.999999)).toBeLessThanOrEqual(36 * min);
    expect(nextCheckDelayMs(30, 0, 0.9)).toBe(30 * min);
    for (let i = 0; i < 200; i++) {
      const d = nextCheckDelayMs(30, 20, i / 200);
      expect(d).toBeGreaterThanOrEqual(24 * min);
      expect(d).toBeLessThanOrEqual(36 * min);
    }
  });
  it("failures back off 5 → 10 → 20 minutes and never beyond the normal interval", () => {
    const min = 60_000;
    expect([1, 2, 3, 4, 5, 9].map((n) => failureBackoffMs(n, 30) / min)).toEqual([5, 10, 20, 30, 30, 30]);
    expect(failureBackoffMs(1, 3) / min).toBe(3);
  });
  it("a verification older than holderMaxAgeHours (6 h) is stale; a never-verified wallet is stale", () => {
    const h = 3_600_000;
    expect(isVerificationStale(1_000_000, 1_000_000 + 6 * h, 6)).toBe(false);
    expect(isVerificationStale(1_000_000, 1_000_000 + 6 * h + 1, 6)).toBe(true);
    expect(isVerificationStale(null, 5, 6)).toBe(true);
  });
});
