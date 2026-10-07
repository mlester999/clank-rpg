import { describe, expect, it } from "vitest";

import { applyBonus, bonusPercentLabel, buildBonusTiers, decideBonus, liveBonus, maxBonusBps, runEndingAt, tierForBalance, tierName, type BonusTier, type Observation, type PeriodTerms } from "@/domain/rewards/holderBonus";
import { periodWindow, type PeriodKind } from "@/domain/rewards/time";
import { DEFAULT_SETTINGS } from "@/domain/settings";

const E18 = 10n ** 18n;
const H = 3_600_000;
const MIN = 60_000;
const T = (iso: string) => Date.parse(iso);
const tok = (n: number) => BigInt(n) * E18;
const TIERS = buildBonusTiers(DEFAULT_SETTINGS.arena_picks, 18);
const FREE_IDX = 0;
const idx = (label: string): number => TIERS.find((t) => t.label === label)!.index;

/** Observations every 30 min from `from` to `to` (inclusive) at a constant balance. */
const steady = (from: string, to: string, balance: bigint, step = 30 * MIN): Observation[] => {
  const out: Observation[] = [];
  for (let t = T(from); t <= T(to); t += step) out.push({ atMs: t, balanceRaw: balance });
  return out;
};
const cat = (...parts: Observation[][]): Observation[] => parts.flat().sort((a, b) => a.atMs - b.atMs);
const one = (at: string, balance: bigint): Observation[] => [{ atMs: T(at), balanceRaw: balance }];

const terms = (kind: PeriodKind, onDate: string): PeriodTerms => {
  const w = periodWindow(kind, T(`${onDate}T12:00:00Z`));
  return { startsAtMs: w.startsAt, endsAtMs: w.endsAt, requiredMs: (kind === "DAILY" ? 24 : 168) * H, maxGapMs: 6 * H };
};
const DAILY_OCT7 = terms("DAILY", "2026-10-07"); // Oct 7 00:00 → Oct 8 00:00
const WEEKLY_OCT12 = terms("WEEKLY", "2026-10-12"); // Mon Oct 12 → Mon Oct 19
const decide = (observations: Observation[], t: PeriodTerms) => decideBonus({ tiers: TIERS, observations, terms: t });
const tierOf = (d: ReturnType<typeof decide>): string => (d.kind === "QUALIFIED" ? d.tier.label : d.kind);

describe("the bonus tiers and the exact bonus arithmetic", () => {
  it("FREE 0%, 100K +5%, 500K +10%, 1M +15%, 5M +20%, 10M +25% — from the ONE setting, in raw units", () => {
    expect(TIERS.map((t) => [t.label, t.bonusBps])).toEqual([["FREE", 0], ["100K", 500], ["500K", 1000], ["1M", 1500], ["5M", 2000], ["10M", 2500]]);
    expect(TIERS[3]!.minimumRaw).toBe(tok(1_000_000));
    expect(maxBonusBps(TIERS)).toBe(2500);
    expect(tierName(TIERS[0]!)).toBe("FREE");
    expect(tierName(TIERS[5]!)).toBe("10M HOLDER");
    expect(bonusPercentLabel(2500)).toBe("+25%");
    expect(bonusPercentLabel(750)).toBe("+7.5%");
  });
  it("tierForBalance picks the highest threshold reached (exactly at the threshold counts; one unit below does not)", () => {
    expect(tierForBalance(TIERS, 0n).index).toBe(FREE_IDX);
    expect(tierForBalance(TIERS, tok(100_000) - 1n).index).toBe(FREE_IDX);
    expect(tierForBalance(TIERS, tok(100_000)).label).toBe("100K");
    expect(tierForBalance(TIERS, tok(10_000_000)).label).toBe("10M");
    expect(tierForBalance(TIERS, tok(999_999_999)).label).toBe("10M");
  });
  it("30,000 base: FREE 30,000 · 1M +15% = 34,500 · 10M +25% = 37,500 — the bonus is EXTRA, never carved out of anyone else's prize", () => {
    const base = tok(30_000);
    expect(base + applyBonus(base, 0)).toBe(tok(30_000));
    expect(base + applyBonus(base, 1500)).toBe(tok(34_500));
    expect(base + applyBonus(base, 2500)).toBe(tok(37_500));
    expect(applyBonus(base, 2500)).toBe(tok(7_500));
  });
  it("floors to a whole base unit (exact integer maths — no float) and a zero bonus is zero", () => {
    expect(applyBonus(3n, 2500)).toBe(0n);
    expect(applyBonus(7n, 2500)).toBe(1n);
    expect(applyBonus(33_333_333_333_333_333_333n, 500)).toBe(1_666_666_666_666_666_666n);
    expect(applyBonus(0n, 2500)).toBe(0n);
  });
});

describe("verified holding continuity — the evidence rules", () => {
  it("a run is the unbroken stretch of observations, at/above the threshold, with no gap over the freshness window", () => {
    const obs = cat(steady("2026-10-06T00:00:00Z", "2026-10-06T10:00:00Z", tok(2_000_000)), steady("2026-10-06T10:30:00Z", "2026-10-07T00:00:00Z", tok(50_000)));
    expect(runEndingAt(obs, 0, tok(1_000_000), 6 * H)?.observations).toBe(1);
    const last = obs.length - 1;
    expect(runEndingAt(obs, last, tok(1_000_000), 6 * H)).toBeNull(); // below the threshold at the end
    expect(runEndingAt(obs, last, tok(10_000), 6 * H)?.sinceMs).toBe(T("2026-10-06T00:00:00Z")); // ≥ 10K the whole time
  });
  it("a gap longer than the freshness window breaks the run; exactly the window does not", () => {
    const ok = [...one("2026-10-06T00:00:00Z", tok(2_000_000)), ...one("2026-10-06T06:00:00Z", tok(2_000_000))];
    expect(runEndingAt(ok, 1, tok(1_000_000), 6 * H)?.sinceMs).toBe(T("2026-10-06T00:00:00Z"));
    const bad = [...one("2026-10-06T00:00:00Z", tok(2_000_000)), ...one("2026-10-06T06:00:00.001Z", tok(2_000_000))];
    expect(runEndingAt(bad, 1, tok(1_000_000), 6 * H)).toMatchObject({ sinceMs: T("2026-10-06T06:00:00.001Z"), endedBy: "GAP" });
  });
});

describe("DAILY holder loophole tests (period Oct 7 00:00 → Oct 8 00:00 UTC; 24 h before AND until the close)", () => {
  it("CASE A — the #1 player buys 10M five minutes before the Daily closes: the BASE prize is theirs, the 10M bonus is NOT", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T23:30:00Z", tok(1_000)), one("2026-10-07T23:55:00Z", tok(10_250_000)), one("2026-10-08T00:00:20Z", tok(10_250_000)));
    const d = decide(obs, DAILY_OCT7);
    expect(d.kind).toBe("NONE");
    const ten = d.evidence.tiers.find((t) => t.tierIndex === idx("10M"))!;
    expect(ten).toMatchObject({ qualifies: false, reason: "RUN_TOO_RECENT" });
    expect(ten.sinceMs).toBe(T("2026-10-07T23:55:00Z"));
  });
  it("CASE B — held 10M for the previous 24 h and all day: the +25% Daily bonus", () => {
    const obs = steady("2026-10-06T00:00:00Z", "2026-10-08T00:00:30Z", tok(10_250_000));
    const d = decide(obs, DAILY_OCT7);
    expect(d.kind).toBe("QUALIFIED");
    expect(tierOf(d)).toBe("10M");
    if (d.kind === "QUALIFIED") expect(applyBonus(tok(30_000), d.tier.bonusBps)).toBe(tok(7_500));
  });
  it("exactly 24 h of proven continuity before the day starts is enough; one minute short is not", () => {
    const enough = steady("2026-10-06T00:00:00Z", "2026-10-08T00:00:00Z", tok(10_000_000));
    expect(tierOf(decide(enough, DAILY_OCT7))).toBe("10M");
    const short = steady("2026-10-06T00:01:00Z", "2026-10-08T00:00:00Z", tok(10_000_000), 30 * MIN).filter((o) => o.atMs >= T("2026-10-06T00:01:00Z"));
    expect(decide(short, DAILY_OCT7).kind).toBe("NONE");
  });
  it("buying DURING the day grants nothing for that day — but the same holding qualifies for the NEXT-next daily board", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T19:30:00Z", 0n), steady("2026-10-07T20:00:00Z", "2026-10-10T00:00:30Z", tok(10_250_000)));
    expect(decide(obs, DAILY_OCT7).kind).toBe("NONE"); // Oct 7: bought at 20:00 during it
    expect(decide(obs, terms("DAILY", "2026-10-08")).kind).toBe("NONE"); // Oct 8: still not 24 h before its start (since Oct 7 20:00 > Oct 7 00:00)
    expect(tierOf(decide(obs, terms("DAILY", "2026-10-09")))).toBe("10M"); // Oct 9: since Oct 7 20:00 ≤ Oct 8 00:00 ✔
  });
  it("CASE C — qualified, then the balance drops before the close: base prize stays, the 10M bonus is removed and the highest tier still held is kept", () => {
    // Held 10M for days, sold down to 1.2M at 14:00 on the day, stayed there through the close.
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T13:30:00Z", tok(10_250_000)), steady("2026-10-07T14:00:00Z", "2026-10-08T00:00:30Z", tok(1_200_000)));
    const d = decide(obs, DAILY_OCT7);
    expect(tierOf(d)).toBe("1M"); // every check was ≥ 1M → +15%, not FREE
    // Sold everything: no bonus at all.
    const dumped = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T13:30:00Z", tok(10_250_000)), steady("2026-10-07T14:00:00Z", "2026-10-08T00:00:30Z", 0n));
    expect(decide(dumped, DAILY_OCT7).kind).toBe("NONE");
  });
  it("a momentary dip below a threshold at ANY observed check breaks that tier even if the balance came back before the close", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T11:30:00Z", tok(10_250_000)), one("2026-10-07T12:00:00Z", tok(4_000_000)), steady("2026-10-07T12:30:00Z", "2026-10-08T00:00:30Z", tok(10_250_000)));
    const d = decide(obs, DAILY_OCT7);
    expect(tierOf(d)).toBe("1M"); // 10M and 5M broke at 12:00 (4M); 1M held throughout
    expect(d.evidence.tiers.find((t) => t.tierIndex === idx("10M"))).toMatchObject({ qualifies: false, reason: "RUN_TOO_RECENT" });
  });
  it("CASE F — the same 10M moved between wallets/accounts: a wallet with no history of its own (or a freshly bound one) earns nothing", () => {
    // Account B's wallet was only bound and observed at 22:00 on Oct 7, when the tokens arrived from account A's wallet.
    const b = cat(steady("2026-10-07T22:00:00Z", "2026-10-08T00:00:30Z", tok(10_250_000)));
    expect(decide(b, DAILY_OCT7).kind).toBe("NONE");
    // …and Account A, which just moved its tokens away, drops out at the next check.
    const a = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T21:30:00Z", tok(10_250_000)), steady("2026-10-07T22:00:00Z", "2026-10-08T00:00:30Z", 0n));
    expect(decide(a, DAILY_OCT7).kind).toBe("NONE");
  });
  it("TIER FALLBACK — a 10M holder who falls to 6M keeps the 5M (+20%) bonus when every check stayed ≥ 5M, and not 10M", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T09:30:00Z", tok(10_000_000)), steady("2026-10-07T10:00:00Z", "2026-10-08T00:00:30Z", tok(6_000_000)));
    const d = decide(obs, DAILY_OCT7);
    expect(tierOf(d)).toBe("5M");
    if (d.kind === "QUALIFIED") expect(d.tier.bonusBps).toBe(2000);
  });
  it("a bigger wallet that only just crossed a higher threshold gets the HIGHEST tier it has held long enough, not the one it holds now", () => {
    // 600K for days, topped up to 12M at 02:00 on the day: 500K (+10%) qualifies, 10M does not.
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T01:30:00Z", tok(600_000)), steady("2026-10-07T02:00:00Z", "2026-10-08T00:00:30Z", tok(12_000_000)));
    expect(tierOf(decide(obs, DAILY_OCT7))).toBe("500K");
  });
  it("VERIFICATION GAPS — a stretch of more than 6 h without a successful check breaks continuity (never granted from stale data); 5 h 50 m is tolerated", () => {
    const gappy = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T04:00:00Z", tok(10_250_000)), steady("2026-10-07T11:00:00Z", "2026-10-08T00:00:30Z", tok(10_250_000))); // 7 h hole
    expect(decide(gappy, DAILY_OCT7).kind).toBe("NONE");
    const fine = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T04:00:00Z", tok(10_250_000)), steady("2026-10-07T09:50:00Z", "2026-10-07T23:50:00Z", tok(10_250_000)), one("2026-10-08T00:00:20Z", tok(10_250_000))); // 5 h 50 m hole
    expect(tierOf(decide(fine, DAILY_OCT7))).toBe("10M");
  });
  it("the CLOSE must itself be fresh: a last good read 8 h before the end, then one after the end, is a gap — no bonus", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T16:00:00Z", tok(10_250_000)), one("2026-10-08T00:00:10Z", tok(10_250_000)));
    expect(decide(obs, DAILY_OCT7).kind).toBe("NONE");
  });
  it("no close verification yet: a wallet that WOULD qualify waits (PENDING VERIFICATION); one that could not qualify anyway gets NONE straight away", () => {
    const would = steady("2026-10-05T00:00:00Z", "2026-10-07T23:50:00Z", tok(10_250_000));
    expect(decide(would, DAILY_OCT7).kind).toBe("PENDING_VERIFICATION");
    const never = steady("2026-10-07T18:00:00Z", "2026-10-07T23:50:00Z", tok(10_250_000));
    expect(decide(never, DAILY_OCT7).kind).toBe("NONE");
    expect(decide([], DAILY_OCT7).kind).toBe("NONE");
  });
  it("whatever happens AFTER the close verification cannot take a bonus back (the period is decided at its close)", () => {
    const obs = cat(steady("2026-10-06T00:00:00Z", "2026-10-08T00:00:30Z", tok(10_250_000)), steady("2026-10-08T01:00:00Z", "2026-10-08T06:00:00Z", 0n));
    expect(tierOf(decide(obs, DAILY_OCT7))).toBe("10M");
  });
  it("a FREE balance and a balance under 100K never earn a bonus", () => {
    expect(decide(steady("2026-10-05T00:00:00Z", "2026-10-08T00:00:30Z", tok(99_999)), DAILY_OCT7).kind).toBe("NONE");
    expect(decide(steady("2026-10-05T00:00:00Z", "2026-10-08T00:00:30Z", 0n), DAILY_OCT7).kind).toBe("NONE");
  });
});

describe("WEEKLY holder loophole tests (week Mon Oct 12 → Mon Oct 19; 7 days before AND throughout)", () => {
  it("CASE D — buys 10M on Sunday night while already #1: NO instant +25% for that week", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-11T21:30:00Z", 0n), steady("2026-10-11T22:00:00Z", "2026-10-19T00:00:30Z", tok(10_250_000)));
    expect(decide(obs, WEEKLY_OCT12).kind).toBe("NONE");
  });
  it("CASE E — satisfied the 7-day pre-week requirement and the entire week: +25% Weekly bonus", () => {
    const obs = steady("2026-10-05T00:00:00Z", "2026-10-19T00:00:30Z", tok(10_250_000));
    expect(tierOf(decide(obs, WEEKLY_OCT12))).toBe("10M");
  });
  it("one hour short of 7 days is not enough; the weekly bar is harder than the daily one", () => {
    const obs = steady("2026-10-05T01:00:00Z", "2026-10-19T00:00:30Z", tok(10_250_000));
    expect(decide(obs, WEEKLY_OCT12).kind).toBe("NONE");
    // The same holding clears a DAILY bar (24 h) easily:
    expect(tierOf(decide(steady("2026-10-05T01:00:00Z", "2026-10-09T00:00:30Z", tok(10_250_000)), terms("DAILY", "2026-10-07")))).toBe("10M");
  });
  it("selling below the threshold during the active week breaks that tier for the week (rank and base prize are untouched elsewhere)", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-14T09:30:00Z", tok(10_250_000)), steady("2026-10-14T10:00:00Z", "2026-10-19T00:00:30Z", tok(300_000)));
    expect(tierOf(decide(obs, WEEKLY_OCT12))).toBe("100K"); // fell to 300K: only the 100K tier stayed continuous
  });
});

describe("what the member sees right now (the live card)", () => {
  const live = (obs: Observation[], kind: PeriodKind, now: string, onDate: string) =>
    liveBonus({ tiers: TIERS, observations: obs, kind, terms: terms(kind, onDate), nowMs: T(now) });

  it("QUALIFIED: continuity proven from before the period began and unbroken until now", () => {
    const obs = steady("2026-10-05T00:00:00Z", "2026-10-07T15:00:00Z", tok(1_284_500));
    const r = live(obs, "DAILY", "2026-10-07T15:10:00Z", "2026-10-07");
    expect(r.status).toBe("QUALIFIED");
    expect(TIERS[r.tierIndex]!.label).toBe("1M");
  });
  it("QUALIFYING (buying during the day): 10M held since 20:00 — eligible for a FUTURE daily bonus, with the first eligible board named", () => {
    const obs = cat(steady("2026-10-07T20:00:00Z", "2026-10-07T21:00:00Z", tok(10_250_000)));
    const r = live(obs, "DAILY", "2026-10-07T21:10:00Z", "2026-10-07");
    expect(r.status).toBe("QUALIFYING");
    expect(TIERS[r.tierIndex]!.label).toBe("10M");
    expect(r.eligibleFromMs).toBe(T("2026-10-09T00:00:00Z")); // 20:00 + 24 h = Oct 8 20:00 → the Oct 9 board
    expect(r.heldMs).toBe(70 * MIN);
  });
  it("WEEKLY progress: 5 d 7 h of the 7 d required before the next eligible week", () => {
    const obs = steady("2026-10-07T17:00:00Z", "2026-10-13T00:00:00Z", tok(1_284_500));
    const r = live(obs, "WEEKLY", "2026-10-13T00:10:00Z", "2026-10-12");
    expect(r.status).toBe("QUALIFYING");
    expect(Math.floor(r.heldMs / H)).toBe(5 * 24 + 7);
    expect(r.requiredMs).toBe(7 * 24 * H);
    expect(r.eligibleFromMs).toBe(T("2026-10-19T00:00:00Z"));
  });
  it("QUALIFIED at a lower tier while a higher one is still accumulating (paying 100K while 1M qualifies later)", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T11:30:00Z", tok(150_000)), steady("2026-10-07T12:00:00Z", "2026-10-07T15:00:00Z", tok(1_500_000)));
    const r = live(obs, "DAILY", "2026-10-07T15:10:00Z", "2026-10-07");
    expect(r.status).toBe("QUALIFIED");
    expect(TIERS[r.tierIndex]!.label).toBe("100K");
    expect(TIERS[r.upgradingToIndex!]!.label).toBe("1M");
  });
  it("BROKEN: qualified when the day began, then sold below the threshold during it", () => {
    const obs = cat(steady("2026-10-05T00:00:00Z", "2026-10-07T13:30:00Z", tok(10_250_000)), steady("2026-10-07T14:00:00Z", "2026-10-07T15:00:00Z", 0n));
    const r = live(obs, "DAILY", "2026-10-07T15:10:00Z", "2026-10-07");
    expect(r.status).toBe("BROKEN");
    expect(TIERS[r.tierIndex]!.label).toBe("10M");
    expect(r.brokenAtMs).toBe(T("2026-10-07T14:00:00Z"));
    expect(r.brokenBy).toBe("BELOW_THRESHOLD");
  });
  it("NEEDS VERIFICATION: the last verification is older than the freshness window — nothing is assumed from stale data", () => {
    const obs = steady("2026-10-05T00:00:00Z", "2026-10-07T04:00:00Z", tok(10_250_000));
    const r = live(obs, "DAILY", "2026-10-07T11:00:00Z", "2026-10-07"); // 7 h since the last read
    expect(r.status).toBe("NEEDS_VERIFICATION");
  });
  it("NONE: no wallet / nothing observed / FREE balance", () => {
    expect(live([], "DAILY", "2026-10-07T12:00:00Z", "2026-10-07").status).toBe("NONE");
    expect(live(steady("2026-10-05T00:00:00Z", "2026-10-07T12:00:00Z", tok(1_000)), "DAILY", "2026-10-07T12:05:00Z", "2026-10-07").status).toBe("NONE");
  });
  it("the card and the close agree: whatever the card says would PAY is what the close then pays", () => {
    const obs = steady("2026-10-05T00:00:00Z", "2026-10-08T00:00:30Z", tok(5_500_000));
    const card = live(steady("2026-10-05T00:00:00Z", "2026-10-07T23:59:00Z", tok(5_500_000)), "DAILY", "2026-10-07T23:59:30Z", "2026-10-07");
    const closed = decide(obs, DAILY_OCT7);
    expect(card.status).toBe("QUALIFIED");
    expect(closed.kind === "QUALIFIED" ? closed.tier.index : -1).toBe(card.tierIndex);
  });
});

describe("tiers are data-driven", () => {
  it("custom tiers change the percentages and thresholds — nothing is hard-coded", () => {
    const custom = buildBonusTiers({ holderBonusTiers: [{ minimum: "0", bonusBps: 0 }, { minimum: "1000", bonusBps: 300 }] }, 18);
    const obs = steady("2026-10-05T00:00:00Z", "2026-10-08T00:00:30Z", tok(2_000));
    const d = decideBonus({ tiers: custom, observations: obs, terms: DAILY_OCT7 });
    expect(d.kind === "QUALIFIED" ? (d.tier as BonusTier).bonusBps : 0).toBe(300);
  });
});
