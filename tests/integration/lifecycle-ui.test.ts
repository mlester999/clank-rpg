import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ArenaScreen } from "@/components/arena/ArenaScreen";
import { StageStatusCard } from "@/components/arena/StageStatusCard";
import { headerStatus, stageCopy, stageMode, type StageMode } from "@/components/arena/stageMode";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { launchSeason1, pauseArena, startArena } from "@/server/services/lifecycle";
import { getArenaState, type ArenaStateDto } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";
import { adminDeps, freshDevelopment, runUntil } from "../support/lifecycle";

/**
 * THE PUBLIC ARENA IN EVERY LIFECYCLE STATE. Each is a deliberate screen; "Reconnecting…" belongs to a REAL failure to reach the server and nothing else;
 * "0 / 8 heroes" belongs to a RUNNING Arena that really has too few heroes and nothing else.
 */
let db: Db;
let clock: FakeClock;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await resetDb(db);
  await freshDevelopment(db);
  clock = new FakeClock();
});

const state = async (): Promise<ArenaStateDto> => getArenaState(db, clock.ms, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const page = (s: ArenaStateDto) => renderToStaticMarkup(createElement(ArenaScreen, { initial: s }));
const modeOf = (s: ArenaStateDto, over: { loaded?: boolean; online?: boolean } = {}): StageMode => stageMode({ state: s, loaded: over.loaded ?? true, online: over.online ?? true });

/** What must never appear on a page that is not reporting a real connection failure, nor on a page that is not a running-but-short Arena. */
function expectNoBrokenLooks(html: string, opts: { allowCounter?: boolean } = {}) {
  const t = visible(html);
  expect(t).not.toMatch(/reconnecting/i);
  if (!opts.allowCounter) expect(t).not.toMatch(/\d+\s*\/\s*\d+\s*heroes/i);
}

describe("DEVELOPMENT, the Arena not running", () => {
  it("says the Arena is in development — never a season, never 'reconnecting', never '0 / 8 heroes'", async () => {
    await seedHeroes(db, 3); // fewer than a battle needs: the old screen would have shown "0 / 8"-style counters
    const s = await state();
    expect(s).toMatchObject({ status: "NOT_STARTED", phase: "DEVELOPMENT", current: null, upcoming: null, next: null });
    expect(modeOf(s)).toBe("DEVELOPMENT_IDLE");
    const html = page(s);
    const t = visible(html);
    expect(html).toContain('data-mode="DEVELOPMENT_IDLE"');
    expect(t).toMatch(/Arena in development/i);
    expect(t).toMatch(/not an official record|Nothing here is an official record/i);
    expect(t).toMatch(/Development · test battles/);
    expect(html).not.toContain('data-testid="arena-season-chip"'); // a development run is not a season chip
    expectNoBrokenLooks(html);
  });

  it("while test battles RUN, the page still says they are test battles (a development run is never presented as a season)", async () => {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    const s = await state();
    expect(s).toMatchObject({ status: "LIVE", phase: "DEVELOPMENT", season: { kind: "DEVELOPMENT", label: "Development" } });
    expect(modeOf(s)).toBe("STAGE");
    const t = visible(page(s));
    expect(t).toMatch(/Live/);
    expect(t).toMatch(/Development · test battles/);
    expect(t).not.toMatch(/Season 1/);
  });
});

describe("LIVE, Season 1 launched, the Arena NOT STARTED", () => {
  it("shows a premium 'Arena preparing — Season 1 battles will begin soon' screen: no battle, no counter, no reconnect", async () => {
    await seedHeroes(db, 16);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    const s = await state();
    expect(s).toMatchObject({ status: "NOT_STARTED", phase: "LIVE", season: { kind: "COMPETITIVE", label: "Season 1" } });
    expect(modeOf(s)).toBe("NOT_STARTED");
    const html = page(s);
    const t = visible(html);
    expect(html).toContain('data-mode="NOT_STARTED"');
    expect(t).toMatch(/Arena preparing/i);
    expect(t).toMatch(/Season 1 battles will begin soon/);
    expect(t).toMatch(/The Arena has not started yet/);
    expect(t).toMatch(/Season 1/); // the season chip
    expect(t).not.toMatch(/Development · test battles/);
    expect(t).toMatch(/Picks open as soon as the first battle is announced/); // the Picks panel is calm too, not eight empty skeleton rows
    expect(html).not.toContain('class="skeleton h-[4rem]"');
    expectNoBrokenLooks(html);
  });
});

describe("PREPARING, RUNNING, PAUSING, PAUSED", () => {
  it("PREPARING (START pressed, the first battle is being made ready) → 'Preparing arena'", async () => {
    await seedHeroes(db, 16);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    await startArena(db, adminDeps(clock));
    const s = await state();
    expect(s).toMatchObject({ status: "PREPARING", phase: "LIVE", current: null });
    expect(modeOf(s)).toBe("PREPARING");
    const html = page(s);
    expect(visible(html)).toMatch(/Preparing arena/i);
    expect(visible(html)).toMatch(/first battle is being made ready/i);
    expectNoBrokenLooks(html);
  });

  it("RUNNING → the arena itself (the eight on stage, Arena Picks for the next eight), 'Live' and 'Season 1'", async () => {
    await seedHeroes(db, 24);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    const s = await state();
    expect(s).toMatchObject({ status: "LIVE", phase: "LIVE", pausing: false });
    expect(modeOf(s)).toBe("STAGE");
    const html = page(s);
    const t = visible(html);
    expect(html).toContain('data-mode="STAGE"');
    expect(html).not.toContain('data-testid="stage-status"');
    expect(t).toMatch(/Live/);
    expect(t).toMatch(/Season 1/);
    for (const f of s.upcoming!.fighters) expect(t).toContain(f.name);
    expectNoBrokenLooks(html);
  });

  it("PAUSE_REQUESTED → the committed battles still play, the header says it is pausing after them", async () => {
    await seedHeroes(db, 24);
    await startArena(db, adminDeps(clock));
    await advanceArena(db, arenaCtx(clock));
    await pauseArena(db, adminDeps(clock));
    const s = await state();
    expect(s).toMatchObject({ pausing: true, status: "LIVE" });
    expect(modeOf(s)).toBe("STAGE");
    expect(visible(page(s))).toMatch(/Pausing after this battle/i);
  });

  it("PAUSED → 'Arena paused', no stage content, no fake countdown, no counter, no reconnect", async () => {
    await seedHeroes(db, 24);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    await startArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => s0Settled(await state()) >= 2);
    await pauseArena(db, adminDeps(clock));
    await runUntil(db, clock, async () => (await state()).status === "PAUSED");
    const s = await state();
    expect(s).toMatchObject({ status: "PAUSED", phase: "LIVE", pausing: false, current: null, upcoming: null, next: null });
    expect(s.recent.length).toBeGreaterThan(0); // the season's winners stay visible
    expect(modeOf(s)).toBe("PAUSED");
    const html = page(s);
    const t = visible(html);
    expect(html).toContain('data-mode="PAUSED"');
    expect(t).toMatch(/Arena paused/i);
    expect(t).toMatch(/Battles are temporarily paused/);
    expect(t).toMatch(/continue when the next session resumes/);
    expect(t).toMatch(/Picks are paused with the Arena/);
    expect(t).not.toMatch(/Next battle (in|starting)|Preparing next battle/i);
    expectNoBrokenLooks(html);
  });

  it("a RUNNING Arena with too few heroes is the ONLY place a heroes counter appears (the Foundry warming up)", async () => {
    await seedHeroes(db, 3);
    // an Arena that WAS started and then lost heroes (e.g. suspensions): running, nothing to make a battle from
    await db.exec("update public.arena_state set status = 'PREPARING'");
    await db.exec("update public.arena_state set status = 'RUNNING'");
    const s = await state();
    expect(s).toMatchObject({ status: "GATHERING", eligibleHeroes: 3 });
    expect(modeOf(s)).toBe("GATHERING");
    const t = visible(page(s));
    expect(t).toMatch(/3 \/ 8 heroes/);
    expect(t).toMatch(/Gathering heroes/);
    expect(t).not.toMatch(/reconnecting/i);
  });
});

const s0Settled = (s: ArenaStateDto) => s.recent.length;

describe("the one real error: the state endpoint cannot be reached", () => {
  it("with nothing to show: 'Reconnecting…' — not a counter, not 'not started'", () => {
    expect(stageMode({ state: null, loaded: true, online: false })).toBe("RECONNECTING");
    const html = renderToStaticMarkup(createElement(StageStatusCard, { mode: "RECONNECTING", state: null }));
    expect(visible(html)).toMatch(/Reconnecting…/);
    expect(visible(html)).toMatch(/Trying again automatically/);
    expect(visible(html)).not.toMatch(/\d+\s*\/\s*\d+\s*heroes/);
    expect(html).toContain('aria-busy="true"');
    expect(headerStatus("RECONNECTING", null)).toEqual({ label: "Offline", tone: "warn" });
  });

  it("before the first answer it is 'opening', not an error; with a state in hand a failed poll keeps showing that state (the header carries the chip)", async () => {
    expect(stageMode({ state: null, loaded: false, online: true })).toBe("LOADING");
    expect(stageMode({ state: null, loaded: false, online: false })).toBe("LOADING");
    await seedHeroes(db, 16);
    await launchSeason1(db, adminDeps(clock), { confirmation: "LAUNCH SEASON 1" });
    const s = await state();
    expect(stageMode({ state: s, loaded: true, online: false })).toBe("NOT_STARTED"); // the screen does not flip to "reconnecting" over a state we know
  });

  it("every waiting copy is intentional text, and only RECONNECTING says 'reconnecting'", () => {
    for (const mode of ["NOT_STARTED", "DEVELOPMENT_IDLE", "PREPARING", "PAUSED", "NO_SEASON"] as const) {
      const copy = stageCopy(mode, null);
      expect(copy.title.length).toBeGreaterThan(5);
      expect(JSON.stringify(copy)).not.toMatch(/reconnect|0 \/ 8|\d \/ \d/i);
    }
    expect(stageCopy("RECONNECTING", null).title).toMatch(/Reconnecting/);
  });
});
