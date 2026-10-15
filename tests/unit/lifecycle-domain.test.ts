import { describe, expect, it } from "vitest";

import {
  ARENA_ACTIVE_STATUSES,
  ARENA_STATUSES,
  CONFIRM,
  GAME_PHASES,
  UNRANKED,
  arenaIsActive,
  arenaIsStopped,
  canMoveArena,
  confirmationMatches,
  isArenaStatus,
  publicArenaMode,
  publicSeasonLabel,
  recordsLabel,
  seasonChipLabel,
} from "@/domain/lifecycle";
import { formatWinRate, seasonRankView, winRatePercent } from "@/domain/progression/seasonRecord";
import { DEFAULT_SETTINGS } from "@/domain/settings";

describe("the game lifecycle — pure rules", () => {
  it("has exactly the documented phases and Arena statuses", () => {
    expect([...GAME_PHASES]).toEqual(["DEVELOPMENT", "LIVE"]);
    expect([...ARENA_STATUSES]).toEqual(["NOT_STARTED", "PREPARING", "RUNNING", "PAUSE_REQUESTED", "PAUSED"]);
    expect(isArenaStatus("RUNNING")).toBe(true);
    expect(isArenaStatus("running")).toBe(false);
    expect(isArenaStatus(null)).toBe(false);
  });

  it("allows exactly the legal Arena moves (the database enforces the same table)", () => {
    const legal = new Set([
      "NOT_STARTED>PREPARING",
      "PREPARING>RUNNING", "PREPARING>PAUSE_REQUESTED", "PREPARING>PAUSED",
      "RUNNING>PAUSE_REQUESTED", "RUNNING>PAUSED",
      "PAUSE_REQUESTED>PAUSED", "PAUSE_REQUESTED>RUNNING",
      "PAUSED>RUNNING", "PAUSED>NOT_STARTED",
    ]);
    for (const from of ARENA_STATUSES) for (const to of ARENA_STATUSES) expect(canMoveArena(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}>${to}`));
    // Nothing starts without START, and START is the only way out of NOT_STARTED.
    expect(ARENA_STATUSES.filter((s) => canMoveArena("NOT_STARTED", s))).toEqual(["PREPARING"]);
    expect(canMoveArena("NOT_STARTED", "RUNNING")).toBe(false);
  });

  it("classifies statuses: active (making battles) vs stopped (safe for a launch / reset)", () => {
    expect(ARENA_ACTIVE_STATUSES.every((s) => arenaIsActive(s) && !arenaIsStopped(s))).toBe(true);
    expect(ARENA_STATUSES.filter(arenaIsStopped)).toEqual(["NOT_STARTED", "PAUSED"]);
  });

  it("typed confirmations must match exactly (whitespace around is ignored; case and inner spacing are not)", () => {
    expect(CONFIRM).toEqual({ LAUNCH: "LAUNCH SEASON 1", RESET: "RESET ARENA", END_SEASON: "END SEASON" });
    expect(confirmationMatches("LAUNCH", "LAUNCH SEASON 1")).toBe(true);
    expect(confirmationMatches("LAUNCH", "  LAUNCH SEASON 1  ")).toBe(true);
    for (const wrong of ["launch season 1", "LAUNCH SEASON", "LAUNCH  SEASON 1", "LAUNCH SEASON 1!", "", "RESET ARENA", 1, null, undefined, {}]) expect(confirmationMatches("LAUNCH", wrong), String(wrong)).toBe(false);
    expect(confirmationMatches("RESET", "RESET ARENA")).toBe(true);
    expect(confirmationMatches("RESET", "LAUNCH SEASON 1")).toBe(false);
    expect(confirmationMatches("END_SEASON", "END SEASON")).toBe(true);
  });

  it("maps the persisted status to the public mode — and none of them is 'reconnecting'", () => {
    expect(publicArenaMode({ status: "NOT_STARTED", gathering: false })).toBe("NOT_STARTED");
    expect(publicArenaMode({ status: "PREPARING", gathering: false })).toBe("PREPARING");
    expect(publicArenaMode({ status: "PAUSED", gathering: false })).toBe("PAUSED");
    expect(publicArenaMode({ status: "RUNNING", gathering: false })).toBe("RUNNING");
    expect(publicArenaMode({ status: "RUNNING", gathering: true })).toBe("GATHERING");
    expect(publicArenaMode({ status: "PAUSE_REQUESTED", gathering: false })).toBe("RUNNING"); // the committed battles are still being shown
  });

  it("labels seasons: official seasons are 'Season n'; a development run is never called a season", () => {
    expect(seasonChipLabel({ kind: "COMPETITIVE", number: 1, name: "Season 1" })).toBe("Season 1");
    expect(seasonChipLabel({ kind: "DEVELOPMENT", number: null, name: "Development / Beta" })).toBe("Development");
    expect(recordsLabel({ kind: "DEVELOPMENT", number: null, name: "x" })).toBe("Pre-season"); // the PUBLIC word: nothing public says development
    expect(publicSeasonLabel({ kind: "DEVELOPMENT", number: null, name: "x" })).toBe("Pre-season");
    expect(publicSeasonLabel({ kind: "COMPETITIVE", number: 3, name: "x" })).toBe("Season 3");
    expect(recordsLabel({ kind: "COMPETITIVE", number: 2, name: "x" })).toBe("Season 2");
    expect(recordsLabel(null)).toBe("Records");
  });
});

describe("a hero's current-season record", () => {
  const tiers = DEFAULT_SETTINGS.progression.seasonRanks;

  it("win rate is '—' with no matches, never 0%", () => {
    expect(winRatePercent(0, 0)).toBeNull();
    expect(formatWinRate(0, 0)).toBe("—");
    expect(formatWinRate(80, 50)).toBe("63%");
    expect(formatWinRate(1, 0)).toBe("0%");
    expect(formatWinRate(3, 3)).toBe("100%");
  });

  it("a hero with no matches this season is Unranked whatever its points; the first match earns a tier", () => {
    expect(UNRANKED).toBe("Unranked");
    const none = seasonRankView(0, 0, tiers);
    expect(none).toMatchObject({ id: "unranked", name: "Unranked", index: -1, next: null, pointsToNext: null, progress: 0, tierCount: tiers.length });
    expect(seasonRankView(500, 0, tiers).name).toBe("Unranked"); // stale points cannot rank a hero that has not fought
    const first = seasonRankView(0, 1, tiers);
    expect(first.name).toBe(tiers[0]!.name);
    expect(first.index).toBe(0);
    expect(seasonRankView(0, 5, []).name).toBe("Unranked"); // no ladder configured
  });
});
