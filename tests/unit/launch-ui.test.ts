import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LaunchReadiness, type PreflightResponse } from "@/components/admin/LaunchReadiness";
import { OfficialSeasonCard } from "@/components/admin/OfficialSeasonCard";
import { LAUNCH_KEEPS, LAUNCH_RESETS, LAUNCH_WARNING, REQUIRED_SCHEMA_VERSION, evaluateLaunch, type LaunchFacts } from "@/domain/launchPreflight";
import { CONFIRM } from "@/domain/lifecycle";
import type { OfficialSeasonStatus } from "@/server/services/lifecycle";

/** The admin's launch readiness and official-season screens, server-rendered from fixtures: real counts, the approved warning, and no launch button after the launch. */
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const NOW = Date.parse("2026-10-15T09:00:00Z");
const facts = (over: Partial<LaunchFacts> = {}): LaunchFacts => ({
  schema: { latestApplied: REQUIRED_SCHEMA_VERSION, missingObjects: [] },
  season: { id: "s", label: "Development / Beta" },
  heroes: { total: 139, eligible: 121, suspended: 18, versions: 141 },
  members: 312,
  battles: { settled: 847, voided: 3, open: 0 },
  picks: { submitted: 5120, scored: 5000, settledBattlesAwaitingScoring: 0, voidBattlesAwaitingScoring: 0 },
  boards: { picksBoards: 7, picksResults: 150, heroBoards: 7, heroResults: 160 },
  heroRecords: { heroesWithRecords: 130, careerCounters: 128 },
  economy: { goldAccounts: 100, goldTotal: "52000", lootItems: 410, arenaAchievements: 220, goldFromPermanentAchievements: "0", lootNotFromBattles: 0 },
  jobs: { activeCycle: false, lifecycleLockBusy: false, unfinalizedPeriods: 0 },
  chatMessages: 905,
  archivedRuns: 1,
  backup: null,
  ...over,
});
const data = (f: LaunchFacts, requireBackup = true): PreflightResponse => ({
  preflight: evaluateLaunch(f, { phase: "DEVELOPMENT", arenaStatus: "PAUSED", actionBlockers: [], warnings: [], nowMs: NOW, requireBackup }),
  resets: LAUNCH_RESETS,
  keeps: LAUNCH_KEEPS,
});
const view = (d: PreflightResponse | null) => renderToStaticMarkup(createElement(LaunchReadiness, { data: d, onChanged: () => undefined }));

describe("the approved warning, word for word", () => {
  it("is exactly the owner's text and the typed phrase is exactly LAUNCH SEASON 1", () => {
    expect(LAUNCH_WARNING).toBe(
      "This will archive pre-season competition and reset official battle, Picks, leaderboard, and beta-earned progression records. Existing heroes, their class, rarity, PWR, base stats and identity will remain. This operation cannot be undone through the normal admin interface.",
    );
    expect(CONFIRM.LAUNCH).toBe("LAUNCH SEASON 1");
  });
});

describe("LAUNCH READINESS (pre-season)", () => {
  it("shows every count the owner asked for, from the facts — nothing invented — and blocks without a backup", () => {
    const html = view(data(facts()));
    const t = text(html);
    expect(t).toMatch(/Existing heroes\s+139/);
    expect(t).toMatch(/Hero versions\s+141/);
    expect(t).toMatch(/Pre-season battles\s+850/); // 847 settled + 3 void
    expect(t).toMatch(/Pre-season Picks\s+5,120/);
    expect(t).toMatch(/Pre-season leaderboard entries\s+310/); // 150 + 160
    expect(t).toMatch(/Pre-season economy entries\s+730/); // 100 + 410 + 220
    expect(t).toMatch(/Pending settlements\s+0/);
    expect(t).toMatch(/Active jobs\s+0/);
    expect(t).toMatch(/Unsafe conditions\s+1/); // the missing backup
    expect(t).toMatch(/Not ready/);
    expect(t).toMatch(/Backup readiness[\s\S]*No backup has been attested yet/);
    expect(html).toContain('data-testid="backup-submit"');
    expect(t).toMatch(/The app cannot look inside a backup/);
    // what survives is stated as plainly as what resets
    expect(t).toMatch(/Arena Chat messages \(kept\)\s+905/);
    expect(t).toMatch(/Resets for Season 1/);
    expect(t).toMatch(/Survives the launch/);
    expect(t).toMatch(/Every hero: id, public id and URL/);
  });

  it("is READY when a verified, recent backup of this schema is attested", () => {
    const f = facts({ backup: { id: "b", attestedBy: "admin", attestedAt: NOW - 3_600_000, reference: "pitr 2026-10-15T08:00Z", verified: true, schemaVersion: REQUIRED_SCHEMA_VERSION } });
    const t = text(view(data(f)));
    expect(t).toMatch(/Ready to launch/);
    expect(t).toMatch(/Unsafe conditions\s+0/);
    expect(t).toMatch(/Latest: pitr 2026-10-15T08:00Z · verified · by admin/);
  });

  it("surfaces pending settlements and open jobs as real numbers and failing conditions", () => {
    const f = facts({ picks: { submitted: 10, scored: 5, settledBattlesAwaitingScoring: 4, voidBattlesAwaitingScoring: 0 }, battles: { settled: 5, voided: 0, open: 2 }, jobs: { activeCycle: true, lifecycleLockBusy: true, unfinalizedPeriods: 1 } });
    const t = text(view(data(f)));
    expect(t).toMatch(/Pending settlements\s+4/);
    expect(t).toMatch(/Active jobs\s+4/); // 2 open battles + a cycle + the lock
    expect(t).toMatch(/Another lifecycle action or a leaderboard finalization is holding the lifecycle lock/);
    expect(t).toMatch(/4 settled battle\(s\) still have Picks waiting to be scored/);
  });

  it("flags the economy policy decisions for the owner instead of settling them silently", () => {
    const t = text(view(data(facts({ economy: { goldAccounts: 1, goldTotal: "100", lootItems: 2, arenaAchievements: 0, goldFromPermanentAchievements: "300", lootNotFromBattles: 2 } }))));
    expect(t).toMatch(/Policy decision: Gold from permanent achievements/);
    expect(t).toMatch(/Policy decision: loot that was not a battle drop/);
  });

  it("shows a loading state before the server answers", () => {
    expect(view(null)).toContain('data-testid="preflight-loading"');
  });
});

describe("SEASON 1 ACTIVE (after the launch)", () => {
  const status: OfficialSeasonStatus = {
    season: { id: "s1", label: "Season 1", startsAt: NOW },
    launchedAt: NOW,
    launchedBy: "admin",
    officialMatches: 42,
    officialPicks: 310,
    scoredPicks: 300,
    heroesWithRecords: 30,
    boards: { picks: 2, hero: 2 },
    events: { completedDaily: 2, completedWeekly: 0, champions: { picksDaily: 2, picksWeekly: 0, heroDaily: 2, heroWeekly: 0 } },
    auditFindings: [],
  };
  const render = (s: OfficialSeasonStatus | null) => renderToStaticMarkup(createElement(OfficialSeasonCard, { status: s }));

  it("reports the official start, matches, Picks, leaderboard and Events finalization status", () => {
    const t = text(render(status));
    expect(t).toMatch(/Season 1 status/);
    expect(t).toMatch(/Audit clean/);
    expect(t).toMatch(/Official matches\s+42/);
    expect(t).toMatch(/Official Picks\s+310/);
    expect(t).toMatch(/Leaderboard boards\s+4/);
    expect(t).toMatch(/Events finalization\s+2 day\(s\) · 0 week\(s\)/);
  });
  it("lists auditor findings loudly, and handles the between-seasons case", () => {
    expect(text(render({ ...status, auditFindings: ["OFFICIAL_BATTLE_BEFORE_LAUNCH abc"] }))).toMatch(/1 finding\(s\)[\s\S]*OFFICIAL_BATTLE_BEFORE_LAUNCH abc/);
    expect(text(render({ ...status, season: null }))).toMatch(/no season is active/);
  });
});
