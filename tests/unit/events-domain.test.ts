import { readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_EVENTS, championTitle, eventsQuery, longPeriodLabel, outcomeHeadline, parseEvents, periodLabelOf } from "@/components/events/eventsModel";
import { firstPeriodOfSeason, lastCompletedPeriod, periodOutcome, periodPage } from "@/domain/events";
import { BACKUP_MAX_AGE_HOURS, REQUIRED_SCHEMA_VERSION, backupVerdict, evaluateLaunch, type LaunchContext, type LaunchFacts } from "@/domain/launchPreflight";
import { eventsTitle, footerNote, leaderboardsTitle, publicStage, stageBadge, type PublicSeasonDto } from "@/domain/publicPresentation";

const T = (iso: string): number => Date.parse(iso);

describe("the last COMPLETED period of a season (the same UTC clock as the live boards)", () => {
  const start = T("2026-10-15T07:55:00Z"); // a Thursday, launched in the morning

  it("a daily period is complete only once its midnight has passed — to the millisecond", () => {
    expect(lastCompletedPeriod("DAILY", T("2026-10-15T20:00:00Z"), start, null)).toBeNull(); // day 1 is still running
    expect(lastCompletedPeriod("DAILY", T("2026-10-15T23:59:59.999Z"), start, null)).toBeNull();
    expect(lastCompletedPeriod("DAILY", T("2026-10-16T00:00:00.000Z"), start, null)).toBe("2026-10-15");
    expect(lastCompletedPeriod("DAILY", T("2026-10-16T09:00:00Z"), start, null)).toBe("2026-10-15");
    expect(lastCompletedPeriod("DAILY", T("2026-10-18T00:00:00Z"), start, null)).toBe("2026-10-17");
  });

  it("a weekly period closes on the Monday boundary, and the season's first week is the one containing its start", () => {
    expect(firstPeriodOfSeason("WEEKLY", start)).toBe("2026-10-12"); // the Monday of that week
    expect(lastCompletedPeriod("WEEKLY", T("2026-10-18T23:59:59Z"), start, null)).toBeNull();
    expect(lastCompletedPeriod("WEEKLY", T("2026-10-19T00:00:00Z"), start, null)).toBe("2026-10-12");
    expect(lastCompletedPeriod("WEEKLY", T("2026-10-26T00:00:00Z"), start, null)).toBe("2026-10-19");
  });

  it("an ENDED season's history stops at the period that contains its end", () => {
    const ended = T("2026-10-20T10:00:00Z");
    expect(lastCompletedPeriod("DAILY", T("2026-10-30T00:00:00Z"), start, ended)).toBe("2026-10-20");
    expect(lastCompletedPeriod("WEEKLY", T("2026-10-30T00:00:00Z"), start, ended)).toBe("2026-10-19");
    // ...unless that period has not closed yet: then it is not complete either
    expect(lastCompletedPeriod("DAILY", T("2026-10-20T12:00:00Z"), start, ended)).toBe("2026-10-19");
  });
});

describe("pages of periods are bounded by the page size, never by the length of the season", () => {
  it("walks newest → oldest in exact pages and ends cleanly", () => {
    const a = periodPage("DAILY", "2026-10-10", "2026-10-20", null, 4);
    expect(a).toEqual({ starts: ["2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17"], next: "2026-10-17" });
    const b = periodPage("DAILY", "2026-10-10", "2026-10-20", a.next, 4);
    expect(b.starts).toEqual(["2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"]);
    const c = periodPage("DAILY", "2026-10-10", "2026-10-20", b.next, 4);
    expect(c).toEqual({ starts: ["2026-10-12", "2026-10-11", "2026-10-10"], next: null });
  });
  it("weekly steps by seven days; a cursor in the future is clamped; the size is clamped", () => {
    expect(periodPage("WEEKLY", "2026-10-05", "2026-10-26", null, 2)).toEqual({ starts: ["2026-10-26", "2026-10-19"], next: "2026-10-19" });
    expect(periodPage("DAILY", "2026-10-10", "2026-10-12", "2027-01-01", 5).starts).toEqual(["2026-10-12", "2026-10-11", "2026-10-10"]);
    expect(periodPage("DAILY", "2026-01-01", "2026-12-31", null, 9_999).starts).toHaveLength(60);
    expect(periodPage("DAILY", "2026-10-10", "2026-10-12", null, 0).starts).toHaveLength(1);
  });
  it("a season with one period is one page", () => {
    expect(periodPage("DAILY", "2026-10-15", "2026-10-15", null, 8)).toEqual({ starts: ["2026-10-15"], next: null });
  });
});

describe("how a period ended", () => {
  it("never invents a winner: no board → FINALIZING or NO COMPLETED RESULTS; a board without a champion → NO ELIGIBLE WINNER", () => {
    expect(periodOutcome({ frozen: false, finalizing: false, champions: 0 })).toBe("NO_COMPLETED_RESULTS");
    expect(periodOutcome({ frozen: false, finalizing: true, champions: 0 })).toBe("FINALIZING");
    expect(periodOutcome({ frozen: true, finalizing: false, champions: 0 })).toBe("NO_ELIGIBLE_WINNER");
    expect(periodOutcome({ frozen: true, finalizing: false, champions: 1 })).toBe("CHAMPION");
    expect(periodOutcome({ frozen: true, finalizing: false, champions: 3 })).toBe("JOINT_CHAMPIONS");
    expect(outcomeHeadline("NO_ELIGIBLE_WINNER")).toBe("NO ELIGIBLE WINNER");
    expect(outcomeHeadline("NO_COMPLETED_RESULTS")).toBe("NO COMPLETED RESULTS");
  });
});

describe("the Events page as a linkable state", () => {
  it("round-trips; the plain URL is the default; anything unknown falls back", () => {
    expect(eventsQuery(DEFAULT_EVENTS)).toBe("");
    const s = parseEvents(new URLSearchParams("program=hero&kind=weekly&period=2026-10-12"));
    expect(s).toEqual({ program: "hero", kind: "weekly", period: "2026-10-12" });
    expect(eventsQuery(s)).toBe("?program=hero&kind=weekly&period=2026-10-12");
    expect(parseEvents({ program: "nope", kind: ["daily"], period: "tomorrow" })).toEqual(DEFAULT_EVENTS);
    expect(parseEvents({ period: "2026-13-45" }).period).toBeNull();
  });
  it("labels periods as calendar dates in UTC, in the spec's words", () => {
    expect(periodLabelOf("daily", "2026-10-14")).toBe("OCT 14");
    expect(periodLabelOf("weekly", "2026-10-12")).toBe("WEEK OF OCT 12");
    expect(longPeriodLabel("daily", "2026-10-14")).toBe("Wednesday 14 October 2026");
    expect(longPeriodLabel("weekly", "2026-10-12")).toBe("12 October – 18 October 2026");
    expect(longPeriodLabel("weekly", "2026-12-28")).toBe("28 December 2026 – 3 January 2027");
    expect(championTitle("picks", "daily", false)).toBe("#1 DAILY CHAMPION");
    expect(championTitle("picks", "weekly", false)).toBe("#1 WEEKLY CHAMPION");
    expect(championTitle("hero", "weekly", false)).toBe("#1 WEEKLY HERO");
    expect(championTitle("hero", "daily", true)).toBe("JOINT DAILY HEROES");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the Season 1 launch preflight — the pure rules", () => {
  const NOW = T("2026-10-15T09:00:00Z");
  const good: LaunchFacts = {
    schema: { latestApplied: REQUIRED_SCHEMA_VERSION, missingObjects: [] },
    season: { id: "s", label: "Development / Beta" },
    heroes: { total: 139, eligible: 121, suspended: 18, versions: 139 },
    members: 300,
    battles: { settled: 500, voided: 2, open: 0 },
    picks: { submitted: 4000, scored: 3900, settledBattlesAwaitingScoring: 0, voidBattlesAwaitingScoring: 0 },
    boards: { picksBoards: 6, picksResults: 120, heroBoards: 6, heroResults: 130 },
    heroRecords: { heroesWithRecords: 130, careerCounters: 130 },
    economy: { goldAccounts: 100, goldTotal: "50000", lootItems: 400, arenaAchievements: 200, goldFromPermanentAchievements: "0", lootNotFromBattles: 0 },
    jobs: { activeCycle: false, lifecycleLockBusy: false, unfinalizedPeriods: 0 },
    chatMessages: 900,
    archivedRuns: 0,
    backup: { id: "b", attestedBy: "admin", attestedAt: NOW - 2 * 3_600_000, reference: "supabase pitr 2026-10-15T07:00Z", verified: true, schemaVersion: REQUIRED_SCHEMA_VERSION },
  };
  const ctx: LaunchContext = { phase: "DEVELOPMENT", arenaStatus: "PAUSED", actionBlockers: [], warnings: [], nowMs: NOW, requireBackup: true };
  const blockingFailures = (f: LaunchFacts, c: LaunchContext = ctx) => evaluateLaunch(f, c).checks.filter((x) => x.blocking && x.status === "FAIL").map((x) => x.id);

  it("is READY only when every blocking condition holds — and says so with real numbers", () => {
    const pf = evaluateLaunch(good, ctx);
    expect(pf.ready).toBe(true);
    expect(pf.unsafe).toEqual([]);
    expect(pf.facts.heroes.total).toBe(139);
    expect(pf.checks.find((c) => c.id === "HEROES")?.detail).toMatch(/139 hero\(es\), 139 version\(s\)/);
  });

  it("each unsafe condition blocks, by name", () => {
    // (an old schema also makes the attested backup stale — it was taken at the newer one — so the backup is checked separately below)
    expect(blockingFailures({ ...good, schema: { latestApplied: "20261014002600", missingObjects: [] }, backup: { ...good.backup!, schemaVersion: "20261014002600" } })).toEqual(["SCHEMA"]);
    expect(blockingFailures({ ...good, schema: { latestApplied: "20261014002600", missingObjects: [] } })).toEqual(["SCHEMA", "BACKUP"]);
    expect(blockingFailures({ ...good, schema: { latestApplied: REQUIRED_SCHEMA_VERSION, missingObjects: ["launch_backup_attestations"] } })).toEqual(["SCHEMA"]);
    expect(blockingFailures(good, { ...ctx, arenaStatus: "RUNNING" })).toEqual(["ARENA_STOPPED"]);
    expect(blockingFailures(good, { ...ctx, actionBlockers: [{ code: "REWARD_LIABILITIES", message: "Leaderboard prizes have been credited." }] })).toEqual(["REWARDS"]);
    expect(blockingFailures({ ...good, picks: { ...good.picks, settledBattlesAwaitingScoring: 3 } })).toEqual(["PICK_SETTLEMENTS"]);
    expect(blockingFailures({ ...good, jobs: { ...good.jobs, lifecycleLockBusy: true } })).toEqual(["NO_COMPETING_ACTION"]);
    expect(blockingFailures(good, { ...ctx, phase: "LIVE" })).toEqual(["PHASE"]);
    expect(blockingFailures({ ...good, backup: null })).toEqual(["BACKUP"]);
  });

  it("an open battle is only a warning (the launch voids it, as designed); a void battle with unscored Picks never blocks", () => {
    const pf = evaluateLaunch({ ...good, battles: { ...good.battles, open: 2 }, picks: { ...good.picks, voidBattlesAwaitingScoring: 4 } }, ctx);
    expect(pf.ready).toBe(true);
    expect(pf.checks.find((c) => c.id === "OPEN_BATTLES")).toMatchObject({ status: "WARN", blocking: false });
    expect(pf.checks.find((c) => c.id === "VOID_SETTLEMENTS")).toMatchObject({ status: "WARN", blocking: false });
  });

  it("a backup counts only when attested, VERIFIED, recent and taken at the CURRENT schema", () => {
    const b = good.backup!;
    expect(backupVerdict(b, REQUIRED_SCHEMA_VERSION, NOW).ok).toBe(true);
    expect(backupVerdict(null, REQUIRED_SCHEMA_VERSION, NOW).ok).toBe(false);
    expect(backupVerdict({ ...b, verified: false }, REQUIRED_SCHEMA_VERSION, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/NOT verified/) });
    expect(backupVerdict({ ...b, attestedAt: NOW - (BACKUP_MAX_AGE_HOURS + 1) * 3_600_000 }, REQUIRED_SCHEMA_VERSION, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/h old/) });
    expect(backupVerdict({ ...b, schemaVersion: "20261014002600" }, REQUIRED_SCHEMA_VERSION, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/Take a fresh backup/) });
  });

  it("a deployment that does not require a backup (automated suites) only warns", () => {
    const pf = evaluateLaunch({ ...good, backup: null }, { ...ctx, requireBackup: false });
    expect(pf.ready).toBe(true);
    expect(pf.checks.find((c) => c.id === "BACKUP")).toMatchObject({ status: "WARN", blocking: false });
  });

  it("flags the economy policy decisions instead of deciding them silently", () => {
    const pf = evaluateLaunch({ ...good, economy: { ...good.economy, goldFromPermanentAchievements: "1200", lootNotFromBattles: 3 } }, ctx);
    expect(pf.ready).toBe(true); // a decision to confirm, not a blocker
    expect(pf.checks.find((c) => c.id === "POLICY_PERMANENT_GOLD")?.detail).toMatch(/1,200 Clank Gold/);
    expect(pf.checks.find((c) => c.id === "POLICY_NON_BATTLE_LOOT")?.detail).toMatch(/3 inventory item/);
  });

  it("REQUIRED_SCHEMA_VERSION is exactly the newest migration file (it can never drift)", () => {
    const files = readdirSync(path.join(process.cwd(), "supabase", "migrations")).filter((n) => /^\d{14}_.+\.sql$/.test(n)).sort();
    expect(files.at(-1)?.slice(0, 14)).toBe(REQUIRED_SCHEMA_VERSION);
  });
});

describe("what the public is told, before and after the launch", () => {
  const pre: PublicSeasonDto = { phase: "DEVELOPMENT", season: { kind: "DEVELOPMENT", number: null, label: "Pre-season" } };
  const live: PublicSeasonDto = { phase: "LIVE", season: { kind: "COMPETITIVE", number: 1, label: "Season 1" } };
  const between: PublicSeasonDto = { phase: "LIVE", season: null };

  it("PRE-SEASON before the launch, SEASON 1 after it — and nothing says Season 1 is live before it exists", () => {
    expect(publicStage(pre)).toBe("PRE_SEASON");
    expect(stageBadge(pre)).toEqual({ text: "Pre-season", tone: "pre" });
    expect(stageBadge(live)).toEqual({ text: "Season 1", tone: "live" });
    expect(stageBadge(between)?.text).toBe("Between seasons");
    expect(stageBadge(null)).toBeNull(); // unknown → no chip rather than a wrong one
    expect(eventsTitle(pre).sub).toMatch(/Season 1 coming soon/);
    expect(eventsTitle(live).title).toBe("Season 1 Events");
    expect(leaderboardsTitle(live)).toBe("Season 1 Leaderboards");
    expect(leaderboardsTitle(pre)).toBe("Pre-season Leaderboards");
  });

  it("no public sentence says development, test, beta or local — before or after", () => {
    const words = [eventsTitle(pre).title, eventsTitle(pre).sub, eventsTitle(live).title, eventsTitle(live).sub, leaderboardsTitle(pre), leaderboardsTitle(live), footerNote(pre), footerNote(live), footerNote(null)].join(" | ");
    expect(words).not.toMatch(/development|\btests?\b|beta|local|\bdev\b/i);
    expect(footerNote(live)).not.toMatch(/pre-season/i);
    expect(footerNote(pre)).toMatch(/records reset to zero when Season 1 launches/i);
  });
});
