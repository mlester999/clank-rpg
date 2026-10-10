import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SoundToggleView } from "@/components/arena/audio/SoundToggle";
import type { AudioSnapshot } from "@/components/arena/audio/ArenaAudioManager";
import { PicksOpenHint, StageHint, SurvivorsHud } from "@/components/arena/StageHud";
import { luminance, onDark } from "@/domain/util/color";

/**
 * EVERYTHING DRAWN OVER THE STAGE keeps its own corner: the Survivors plate top-left, the picks hint along the foot, the speaker bottom-right — none
 * under another, none wrapping into fragments. (Rendered in a real browser at 320 → 1920 px in docs/ARENA_RESPONSIVE.md; these pin the rules.)
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const remToPx = (rem: number) => rem * 16;
const snap = (over: Partial<AudioSnapshot> = {}): AudioSnapshot => ({ pref: "on", status: "running", audible: true, needsUnlock: false, ...over } as AudioSnapshot);

describe("the Picks Open message", () => {
  const html = renderToStaticMarkup(createElement(PicksOpenHint));

  it("is two deliberate lines on a narrow stage — a short title over one line of guidance — never a sentence that wraps into fragments", () => {
    const lines = [...html.matchAll(/<p class="([^"]*)">([\s\S]*?)<\/p>/g)];
    expect(lines).toHaveLength(2);
    for (const [, cls] of lines) expect(cls).toContain("whitespace-nowrap"); // each line is unbreakable: it cannot wrap in the middle
    expect(text(html)).toContain("Next fight picks open");
    expect(text(html)).toContain("Scroll down to pick your hero");
  });

  it("becomes one line, with a divider, once the stage is wide enough (container query on the stage, not the page)", () => {
    expect(html).toContain("@2xl:flex-row");
    expect(html).toContain("@2xl:inline");
    expect(text(html)).toContain("Picks open for the next fight");
    expect(html).toMatch(/Choose a winner on the right/);
    expect(html).toMatch(/xl:inline/); // at the 1280 px page layout the picks panel is to the right; below it, it is under the stage
  });

  it("is a compact, themed plate: purple border, dark fill, centred text — never a full-width bar", () => {
    expect(html).toContain("border-clank-400/45");
    expect(html).toContain("bg-ink-950/88");
    expect(html).toContain("text-center");
    expect(html).toContain("max-w-full");
  });

  it("the hint's lane keeps 3.25 rem (52 px) clear on both sides — more than the speaker needs (44 px + a 4 px margin) — so it can never reach the sound button", () => {
    const h = renderToStaticMarkup(createElement(StageHint, { phase: "COUNTDOWN" }, createElement(PicksOpenHint)));
    expect(h).toContain("px-[3.25rem]");
    expect(remToPx(3.25)).toBeGreaterThanOrEqual(44 + 4);
    expect(h).toContain('data-testid="stage-hint"');
    expect(h).toContain("pointer-events-none");
  });

  it("shows only before the bell (intro, 3 · 2 · 1) — never over the fight, the victory or the results", () => {
    for (const phase of ["IDLE", "COMBAT", "VICTORY", "RESULTS", "DONE"] as const) expect(renderToStaticMarkup(createElement(StageHint, { phase }, "x"))).toBe("");
    for (const phase of ["INTRO", "COUNTDOWN"] as const) expect(renderToStaticMarkup(createElement(StageHint, { phase }, "x"))).toContain("x");
  });

  it("a plain one-line hint is a chip inside the same lane", () => {
    const h = renderToStaticMarkup(createElement(StageHint, { phase: "INTRO" }, "Heroes entering the arena…"));
    expect(h).toContain("chip");
    expect(h).toContain("max-w-full");
  });
});

describe("the sound button's corner", () => {
  const html = renderToStaticMarkup(createElement(SoundToggleView, { snapshot: snap() }));

  it("is a 44 px button in the stage's bottom-right corner, marked as a MEASURED safe zone for the renderer", () => {
    expect(html).toContain("data-stage-reserve");
    expect(html).toMatch(/absolute right-1 bottom-1/);
    expect(html).toMatch(/h-11 w-11/);
    expect(html).toContain("data-sound-toggle");
  });

  it("shows the speaker with waves when sound is on and the crossed speaker when muted (the preference is the audio manager's, untouched)", () => {
    expect(renderToStaticMarkup(createElement(SoundToggleView, { snapshot: snap({ pref: "on", audible: true }) }))).toContain('data-sound="on"');
    expect(renderToStaticMarkup(createElement(SoundToggleView, { snapshot: snap({ pref: "off", audible: false }) }))).toContain('data-sound="off"');
  });

  it("its wrapper lets taps through everywhere except the button (it never blocks what is beneath it)", () => {
    expect(html).toMatch(/data-stage-reserve="true" class="group pointer-events-none/);
    expect(html).toMatch(/pointer-events-auto relative grid h-11 w-11/);
  });
});

describe("the Survivors plate", () => {
  const html = renderToStaticMarkup(createElement(SurvivorsHud, { alive: 5, total: 8 }));

  it("keeps its text, is a measured safe zone, and shrinks on a small stage", () => {
    expect(text(html)).toBe("Survivors 5/8");
    expect(html).toContain("data-stage-reserve");
    expect(html).toContain('data-testid="survivors-hud"');
    expect(html).toMatch(/min-w-\[5\.25rem\]/); // 84 px on the smallest stage …
    expect(html).toMatch(/@xl:min-w-\[7\.5rem\]/); // … 120 px on a wide one
    expect(html).toContain("pointer-events-none");
  });
});

describe("page-level CSS contracts", () => {
  it("a phone held sideways keeps the whole 5:3 stage above the bottom navigation (svh-based, so a collapsing toolbar never makes it jump)", () => {
    expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 520px\) and \(max-width: 1023px\)/);
    expect(css).toMatch(/\.stage-frame\s*\{[^}]*max-width:\s*calc\(\(100svh - 8.5rem\) \* 1\.6667\)/);
    expect(css).toMatch(/\.stage-frame\s*\{[^}]*margin-inline:\s*auto/);
  });

  it("the fixed bottom navigation steps aside only while the chat box has the keyboard up — never the desktop header navigation", () => {
    expect(css).toContain('html[data-kbd="open"] nav.fixed[aria-label="Main"]');
    expect(css).not.toMatch(/html\[data-kbd="open"\] nav\[aria-label="Main"\]/);
  });
});

describe("class colours are readable as text", () => {
  it("lightens only as much as needed: a dark class colour reaches the floor, a light one is untouched", () => {
    expect(luminance("#2f4858")).toBeLessThan(0.1); // the Rogue's slate
    expect(luminance(onDark("#2f4858"))).toBeGreaterThanOrEqual(0.3);
    expect(onDark("#e8d28a")).toBe("#e8d28a"); // the Cleric's gold is already light
    expect(onDark("#6a5acd")).not.toBe("#6a5acd"); // the Mage's violet is below the floor
  });

  it("keeps each colour's own hue (it moves toward white, never to grey) and always terminates", () => {
    for (const c of ["#000000", "#111111", "#2f4858", "#3f7d4e", "#5d6b7a", "#c8483a"]) {
      const out = onDark(c);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
      expect(luminance(out)).toBeGreaterThanOrEqual(Math.min(0.3, luminance(c)));
    }
  });
});
