import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ArenaPhase } from "@/components/arena/ArenaRenderer";
import { ArenaHeader, CountdownOverlay, PhaseBanner, StageHint, SurvivorsHud } from "@/components/arena/StageHud";
import type { HeaderStatus } from "@/components/arena/stageMode";

/**
 * What a viewer sees ON the stage, phase by phase. The 3 · 2 · 1 stays; the fight timer, battle number and every
 * queue / cycle / scheduler detail do not exist anywhere in the public markup.
 */
const LIVE: HeaderStatus = { label: "Live", tone: "live" };
const SEASON_1 = { kind: "COMPETITIVE", label: "Season 1" } as const;
const PHASES: ArenaPhase[] = ["IDLE", "INTRO", "COUNTDOWN", "COMBAT", "VICTORY", "RESULTS", "DONE"];
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Everything the stage can show in one phase, rendered together. */
function stage(phase: ArenaPhase, countdown: number | null = null, sinceCombatStartMs = 100): string {
  return renderToStaticMarkup(
    createElement(
      "div",
      null,
      createElement(ArenaHeader, { status: LIVE, season: SEASON_1, phase: "LIVE", online: true, demo: false }),
      phase !== "IDLE" ? createElement(SurvivorsHud, { alive: 5, total: 8 }) : null,
      createElement(CountdownOverlay, { phase, countdown }),
      createElement(StageHint, { phase }, "Heroes entering the arena…"),
      createElement(PhaseBanner, { phase, sinceCombatStartMs }),
    ),
  );
}

describe("no public combat timer, battle number or queue detail", () => {
  it.each(PHASES)("%s: no timer, no battle/round/cycle/queue wording", (phase) => {
    const t = text(stage(phase, phase === "COUNTDOWN" ? 2 : null));
    expect(t).not.toMatch(/\bTIME\b/i);
    expect(t).not.toMatch(/\b\d{1,2}:\d{2}\b/); // 0:17 and friends
    expect(t).not.toMatch(/battle\s*#?\s*\d/i);
    expect(t).not.toMatch(/#\s*\d/);
    expect(t).not.toMatch(/\b(round|cycle|queue|scheduler|fought)\b/i);
    expect(stage(phase)).not.toMatch(/progressbar|aria-valuenow/); // no timer / progress bar either
  });

  it("the header is simply GLOBAL IDLE ARENA · LIVE · SEASON n", () => {
    const t = text(renderToStaticMarkup(createElement(ArenaHeader, { status: LIVE, season: SEASON_1, phase: "LIVE", online: true, demo: false })));
    expect(t).toBe("Global Idle Arena Live Season 1");
  });

  it("only the optional operational chips appear, and only when they apply (offline / demo / paused)", () => {
    expect(text(renderToStaticMarkup(createElement(ArenaHeader, { status: { label: "Paused", tone: "wait" }, season: null, phase: "LIVE", online: false, demo: true })))).toBe("Global Idle Arena Paused Reconnecting… Demo heroes");
  });

  it("a DEVELOPMENT run is always labelled as test battles, never as a season", () => {
    const t = text(renderToStaticMarkup(createElement(ArenaHeader, { status: LIVE, season: { kind: "DEVELOPMENT", label: "Development" }, phase: "DEVELOPMENT", online: true, demo: false })));
    expect(t).toBe("Global Idle Arena Live Development · test battles");
    expect(t).not.toMatch(/Season/);
  });

  it("a real connection failure with nothing to show says Reconnecting… once, and no status chip", () => {
    const t = text(renderToStaticMarkup(createElement(ArenaHeader, { status: { label: "Offline", tone: "warn" }, season: null, phase: undefined, online: false, demo: false })));
    expect(t).toBe("Global Idle Arena Reconnecting…");
  });

  it("the survivors plate is the only number on the stage while fighting", () => {
    expect(text(renderToStaticMarkup(createElement(SurvivorsHud, { alive: 3, total: 8 })))).toBe("Survivors 3/8");
  });
});

describe("the 3 · 2 · 1 remains", () => {
  it.each([3, 2, 1])("shows %i during the countdown", (n) => {
    const html = stage("COUNTDOWN", n);
    expect(html).toContain('data-testid="countdown"');
    expect(text(renderToStaticMarkup(createElement(CountdownOverlay, { phase: "COUNTDOWN", countdown: n })))).toBe(String(n));
  });

  it("appears only in the COUNTDOWN phase", () => {
    for (const phase of PHASES.filter((p) => p !== "COUNTDOWN")) {
      expect(renderToStaticMarkup(createElement(CountdownOverlay, { phase, countdown: 3 }))).toBe("");
    }
    expect(renderToStaticMarkup(createElement(CountdownOverlay, { phase: "COUNTDOWN", countdown: null }))).toBe("");
  });

  it("FIGHT! flashes as combat begins and is gone after about a second; Victory! follows the last fall", () => {
    expect(text(renderToStaticMarkup(createElement(PhaseBanner, { phase: "COMBAT", sinceCombatStartMs: 100 })))).toBe("FIGHT!");
    expect(renderToStaticMarkup(createElement(PhaseBanner, { phase: "COMBAT", sinceCombatStartMs: 1500 }))).toBe("");
    expect(text(renderToStaticMarkup(createElement(PhaseBanner, { phase: "VICTORY", sinceCombatStartMs: 20_000 })))).toBe("Victory!");
  });
});
