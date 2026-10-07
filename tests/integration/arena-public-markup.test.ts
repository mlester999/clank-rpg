import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ArenaScreen } from "@/components/arena/ArenaScreen";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getArenaState, getReplayDto } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * The real Arena page, server-rendered from a real state: the Current Round panel keeps avatar / RPG name / class / POWER,
 * and nothing operational leaks into the public markup (no battle number, cycle, queue, round count, timer).
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
  clock = new FakeClock();
});

const stateNow = async (ms = clock.ms) => getArenaState(db, ms, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("public Arena page markup", () => {
  it("shows the upcoming eight (name, class, PWR) in Arena Picks, the eight on stage in the arena, and none of the machinery", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const state = await stateNow();
    const html = renderToStaticMarkup(createElement(ArenaScreen, { initial: state }));
    const text = visible(html);

    // Header: GLOBAL IDLE ARENA · LIVE · and — because the game is still in DEVELOPMENT — an explicit "test battles" chip, never a season.
    expect(text).toMatch(/Global\s+Idle Arena/);
    expect(text).toMatch(/Live/);
    expect(text).toMatch(/Development · test battles/);
    expect(text).not.toMatch(/Season 1/);

    // Arena Picks lists the UPCOMING eight: every fighter, their class and PWR …
    expect(state.upcoming).not.toBeNull();
    for (const f of state.upcoming!.fighters) {
      expect(text).toContain(f.name);
      expect(text).toContain(state.classes[f.classId]!.name);
      expect(text).toContain(`PWR ${f.power!.toLocaleString()}`);
    }
    // … while the eight on stage are shown by the arena itself (spectator strip), not by the picks panel.
    for (const f of state.current!.fighters) expect(text).toContain(f.name);

    // Nothing operational, anywhere in the document.
    expect(text).not.toMatch(/battle\s*#?\s*\d/i);
    expect(text).not.toMatch(/#\s*\d{2,}/); // no battle / round counter (the "#1 winner" placement copy is fine)
    expect(text).not.toMatch(/\b(cycle|queue|round count|scheduler)\b/i);
    expect(text).not.toMatch(/heroes fought|\d+\s*\/\s*\d+\s*heroes/i);
    expect(text).not.toMatch(/\bTIME\b\s*\d?:?\d*/);
    expect(html).not.toMatch(/Battle #|aria-label="Arena battle/i);
    expect(html).not.toContain('role="progressbar"');
  });

  it("the state that feeds the page carries no battle counter, cycle or queue data either", async () => {
    await seedHeroes(db, 24);
    await advanceArena(db, arenaCtx(clock));
    const wire = JSON.stringify(await stateNow());
    expect(wire).not.toMatch(/"cycle"|battlesDone|carriedIn|totalHeroes|"fought"|queue/i);
  });

  it("the internal 60 s limit (rules 3.0.0) still exists on the server and in the timing contract, just never shown", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    expect(s.timing.maxCombatMs).toBe(60_000);
    expect(s.current!.combatEndsAt! - s.current!.combatStartsAt!).toBeLessThanOrEqual(60_000);
    expect(s.current!.endedBy === null || ["LAST_STANDING", "TIME_LIMIT"].includes(s.current!.endedBy!)).toBe(true);
  });

  it("the replay payload describes a static arena: three radii, no zone parameters", async () => {
    await seedHeroes(db, 16);
    await advanceArena(db, arenaCtx(clock));
    const s = await stateNow();
    const replay = await getReplayDto(db, s.current!.id, s.current!.combatStartsAt! + 10);
    expect(replay).not.toBeNull();
    expect(Object.keys(replay!.combat).sort()).toEqual(["arenaRadius", "startRadius", "unitRadius"]);
    expect(replay!.rulesVersion).toBe("3.0.0");
    expect(JSON.stringify(replay)).not.toMatch(/ring|storm|zone/i);
  });
});
