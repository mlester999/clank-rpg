import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ArenaScreen } from "@/components/arena/ArenaScreen";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import type { Db } from "@/server/db/types";
import { advanceArena } from "@/server/services/arena";
import { getArenaState } from "@/server/services/views";

import { arenaCtx, createTestDb, FakeClock, resetDb, seedHeroes } from "../support/db";

/**
 * THE ARENA PAGE ON A PHONE — one column, in this order: the page header, GLOBAL IDLE ARENA, the Live Arena, the fighter status cards, the compact Arena
 * Chat, then Arena Picks and the rest. (On a desktop, 1280 px and up, Arena Picks sits to the right; everywhere below that it follows the chat.)
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

async function page(): Promise<string> {
  await seedHeroes(db, 24);
  await advanceArena(db, arenaCtx(clock));
  const state = await getArenaState(db, clock.ms, await loadSettings(db), { allowDemo: true, classes: await loadClasses(db, false), picksEnabled: true });
  return renderToStaticMarkup(createElement(ArenaScreen, { initial: state }));
}

describe("the Arena page, in reading order", () => {
  it("title → stage → fighter status → Arena Chat → Arena Picks: the chat is directly under the Live Arena content, never beside it on a phone", async () => {
    const html = await page();
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [at('data-testid="arena-header"'), at('data-testid="arena-stage"'), at('aria-label="Live fighter status"'), at('data-testid="arena-chat"'), at("Arena Picks")];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("the chat is NOT a sidebar below the xl breakpoint: it shares the stage's column, and only the picks rail moves to a second column at xl", async () => {
    const html = await page();
    // the stage and the status + chat column both live in column 1 from xl; the picks aside is column 2
    expect(html).toMatch(/class="stage-frame plate[^"]*xl:col-start-1 xl:row-start-2/);
    expect(html).toMatch(/<div class="flex min-w-0 flex-col gap-3 xl:col-start-1 xl:row-start-3">[\s\S]*?aria-label="Live fighter status"[\s\S]*?data-testid="arena-chat"/);
    expect(html).toMatch(/<aside class="flex min-w-0 flex-col gap-3 xl:col-start-2/);
    // no grid column is defined below xl: it is a single column on a phone and a tablet
    const grid = /<div class="grid gap-3 ([^"]*)"/.exec(html)![1]!;
    expect(grid.split(" ").filter((c) => c.startsWith("grid-cols") || c.startsWith("sm:grid-cols") || c.startsWith("md:grid-cols") || c.startsWith("lg:grid-cols"))).toEqual([]);
  });

  it("the stage is a container for everything laid over it, and keeps the aspect ratio of the camera it uses (tall 800:780 under 640 px, wide 5:3 above)", async () => {
    const html = await page();
    const wrap = /<div class="(@container relative[^"]*)"/.exec(html);
    expect(wrap).not.toBeNull();
    expect(wrap![1]).toContain("aspect-[800/780]");
    expect(wrap![1]).toContain("sm:aspect-[5/3]");
    expect(wrap![1]).toContain("w-full");
    expect(html).toMatch(/class="stage-frame plate /);
  });

  it("the kill feed is drawn on the stage; the markup keeps only its screen-reader twin", async () => {
    const html = await page();
    expect(html).toContain('data-testid="kill-feed"');
    expect(html).toMatch(/class="sr-only" aria-live="polite" data-testid="kill-feed"/);
  });

  it("the page is not asked to scroll sideways by anything fixed-width: no w-[NNNpx] / min-w-[NNNpx] on the Arena column's own markup", async () => {
    const html = await page();
    const widths = [...html.matchAll(/(?:^|[\s"'])(?:[\w@:-]*:)?(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1]));
    for (const w of widths) expect(w, `a ${w}px fixed width`).toBeLessThanOrEqual(280); // anything wider than the narrowest stage would overflow a 320 px phone
  });
});
