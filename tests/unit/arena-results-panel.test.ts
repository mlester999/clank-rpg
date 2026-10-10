import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DENSITY, NextBattleLine, PickResultLine, ResultsPanel, resultStats, type Density, type ResultEntry } from "@/components/arena/ResultsPanel";
import type { ArenaStateDto, FighterDto, ResultRowDto } from "@/lib/dto";

/**
 * THE RESULTS SCREEN — markup contracts. The browser-level proof (both cards fully inside the stage at 320 → 1920 px) is the QA run recorded in
 * docs/ARENA_RESPONSIVE.md; these tests pin the rules that make it hold: no fixed card widths, every grid track shrinkable, long names that wrap and clamp,
 * a footer that keeps clear of the sound button, and only authoritative figures.
 */
const LONG = "Sir Bartholomew Maximilian Featherstone";
const fighter = (slot: number, name: string, over: Partial<FighterDto> = {}): FighterDto => ({
  slot, characterId: `c${slot}`, publicId: `pub${slot}`, name, classId: "rogue", title: null, isDemo: false, claimed: false, power: 165,
  appearance: { rarity: "RARE", parts: {} } as never, avatarUrl: null, maxHp: 212, startPosition: [0, 0], ...over,
});
const row = (slot: number, over: Partial<ResultRowDto> = {}): ResultRowDto => ({ placement: slot + 1, characterId: `c${slot}`, slot, eliminations: 4, damageDealt: 793, survivedMs: 30000, finalHp: 16, maxHp: 212, goldAwarded: 35, ...over });
const classes = { rogue: { name: "Rogue", role: "", tagline: "", colors: ["#2f4858", "#8fd3c8", "#16242d"], weapon: "daggers", headgear: "hood", body: "light", attackStyle: "stab" } } as unknown as ArenaStateDto["classes"];
const entries = (a = fighter(0, "Markyyester"), b = fighter(1, "Jayson"), ra: ResultRowDto | null = row(0), rb: ResultRowDto | null = row(1, { eliminations: 1, damageDealt: 358, finalHp: 0, goldAwarded: 19 })): ResultEntry[] => [{ f: a, r: ra }, { f: b, r: rb }];
const html = (e: ResultEntry[] = entries(), pick = null, next = null, density?: Density) => renderToStaticMarkup(createElement(ResultsPanel, { entries: e, classes, disabled: undefined, pick, next, ...(density === undefined ? {} : { density }) }));
const text = (h: string) => h.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<canvas[\s\S]*?<\/canvas>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

describe("both cards are there, winner first", () => {
  it("#1 WINNER and #2 RUNNER-UP are both rendered, in that order, each a link to its hero", () => {
    const h = html();
    expect(h.match(/data-testid="result-card"/g)).toHaveLength(2);
    expect(h.indexOf('data-place="1"')).toBeLessThan(h.indexOf('data-place="2"'));
    expect(h).toContain("#1 WINNER");
    expect(h).toContain("#2 RUNNER-UP");
    expect(h).toContain('href="/heroes/pub0"');
    expect(h).toContain('href="/heroes/pub1"');
    expect(h).toContain("Markyyester");
    expect(h).toContain("Jayson");
  });

  it("the runner-up is shown even when the results rows have not arrived yet (replay-only): name, class, PWR — no invented figures", () => {
    const h = html(entries(undefined, undefined, null, null));
    expect(h.match(/data-testid="result-card"/g)).toHaveLength(2);
    expect(text(h)).toContain("Jayson");
    expect(text(h)).toContain("Rogue · PWR 165");
    expect(text(h)).not.toMatch(/\bKOs?\b|dmg|Gold/);
  });

  it("renders nothing for an empty result list, and at most two cards for a longer one", () => {
    expect(html([])).toBe("");
    expect(html([...entries(), { f: fighter(2, "Third"), r: row(2) }]).match(/data-testid="result-card"/g)).toHaveLength(2);
  });

  it("the winner carries the trophy; the runner-up does not", () => {
    const h = html();
    const winner = h.slice(h.indexOf('data-place="1"'), h.indexOf('data-place="2"'));
    const runner = h.slice(h.indexOf('data-place="2"'));
    expect(winner).toContain("trophy-float");
    expect(runner).not.toContain("trophy-float");
  });
});

describe("the layout cannot overflow the stage", () => {
  const h = html();

  it("stacked on a narrow stage, side by side from 36 rem of STAGE width (container query), every track shrinkable", () => {
    expect(h).toContain("grid-cols-[minmax(0,1fr)]");
    expect(h).toContain("@xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]");
    // the old, overflow-prone track list (1.2fr 1fr with min-content minimums) is gone
    expect(h).not.toMatch(/grid-cols-\[1\.2fr_1fr\]/);
  });

  it("no card, portrait box or text has a fixed pixel width", () => {
    expect(h).not.toMatch(/(?:^|[\s"'])(?:[\w@:-]*:)?w-\[\d+(?:\.\d+)?px\]/);
    expect(h).not.toMatch(/min-w-\[\d+px\]/);
    // the one inline pixel width is the portrait canvas's own backing size — every canvas is forced to fill its (rem-sized, container-scaled) box by !important classes
    const canvases = h.match(/<canvas[^>]*>/g) ?? [];
    expect(canvases).toHaveLength(2);
    for (const c of canvases) expect(c).toMatch(/class="[^"]*!h-full[^"]*!w-full|class="[^"]*!w-full[^"]*!h-full/);
    expect(h.replace(/<canvas[^>]*>/g, "")).not.toMatch(/style="[^"]*(?<![-\w])width:\s*\d+px/);
    expect(h).toMatch(/h-\[4\.5rem\] w-\[4\.5rem\]/);
  });

  it("every card and every text column can shrink (min-w-0) and long words break", () => {
    const cards = h.split('data-testid="result-card"').slice(1);
    for (const c of cards) expect(c).toContain("min-w-0");
    expect(h).toContain("[overflow-wrap:anywhere]");
  });

  it("a 40-character name wraps and clamps to two lines, with the full name in a tooltip — it can never push the card wider", () => {
    const long = html(entries(fighter(0, LONG), fighter(1, "x".repeat(40))));
    expect(long).toContain(`title="${LONG}"`);
    expect(long).toMatch(/class="line-clamp-2 @xl:line-clamp-2 [^"]*"[^>]*title="Sir Bartholomew/); // the winner: two lines at every size
    expect(long).toContain("[overflow-wrap:anywhere]");
    expect(long).not.toMatch(/whitespace-nowrap[^"]*data-testid="result-name"|data-testid="result-name"[^>]*whitespace-nowrap/);
    expect(long).toMatch(/class="line-clamp-1 @sm:line-clamp-2 @xl:line-clamp-2 [^"]*"[^>]*title="x{40}"/); // the runner-up: one line on a narrow stage, two from 24 rem
  });

  it("the footer keeps 3rem clear on BOTH sides: the sound button (bottom-right) can never sit over the 'next battle' line or the pick line", () => {
    expect(h).toMatch(/data-testid="results-footer"/);
    const footerClass = /class="([^"]*)"[^>]*data-testid="results-footer"/.exec(h)![1]!;
    expect(footerClass).toContain("min-h-12"); // at least 3 rem tall: no card ever reaches the speaker's corner
    expect(footerClass).toContain("pr-12");
    expect(footerClass).toContain("pl-12");
    // pr-12 = 3 rem = 48 px: the speaker is 44 px (h-11) plus a 4 px margin
    expect(48).toBeGreaterThanOrEqual(44 + 4);
  });

  it("the panel fills the stage and clips nothing it needs: title, centred cards, footer, in one column (no absolute positioning of cards)", () => {
    expect(h).toContain('data-testid="results-panel"');
    expect(h).toMatch(/class="absolute inset-0 flex flex-col overflow-hidden/);
    const cards = h.slice(h.indexOf('data-testid="results-cards"'));
    expect(cards.slice(0, cards.indexOf('data-place="1"'))).not.toMatch(/absolute/);
  });

  it("the pulsing glow is clipped in its own box, so nothing of it extends past the panel", () => {
    expect(h).toMatch(/pointer-events-none absolute inset-0 overflow-hidden[^>]*><div class="winner-glow/);
  });
});

describe("only authoritative figures, nothing invented", () => {
  it("shows the row's own KOs, damage, HP left and gold — and says nothing the row does not", () => {
    const t = text(html());
    expect(t).toContain("4 KOs");
    expect(t).toContain("793 dmg");
    expect(t).toContain("16 HP");
    expect(t).toContain("+35 Gold");
    expect(t).toContain("1 KO"); // the runner-up: singular
    expect(t).toContain("358 dmg");
    expect(t).toContain("+19 Gold");
  });

  it("resultStats: HP only while someone is left standing, gold only when it was awarded, KO(s) agrees with the count", () => {
    expect(resultStats(null)).toEqual([]);
    expect(resultStats(row(0, { finalHp: 0, goldAwarded: 0, eliminations: 1 })).map((s) => s.key)).toEqual(["ko", "dmg"]);
    expect(resultStats(row(0, { finalHp: null, goldAwarded: 0 })).map((s) => s.key)).toEqual(["ko", "dmg"]);
    expect(resultStats(row(0)).map((s) => s.key)).toEqual(["ko", "dmg", "hp", "gold"]);
    expect(resultStats(row(0, { eliminations: 1 }))[0]).toMatchObject({ value: "1", label: "KO" });
    expect(resultStats(row(0, { eliminations: 0 }))[0]).toMatchObject({ value: "0", label: "KOs" });
    expect(resultStats(row(0, { damageDealt: 12_345 }))[1]!.value).toBe((12_345).toLocaleString());
    expect(resultStats(row(0, { goldAwarded: 1200 })).find((s) => s.key === "gold")!.value).toBe(`+${(1200).toLocaleString()}`);
  });

  it("the class name carries its own hue but is lightened until it can be READ on the dark card (the Rogue's slate #2f4858 is not)", () => {
    const h = html();
    const m = /<b class="font-semibold" style="color:(#[0-9a-f]{6})">Rogue<\/b>/.exec(h);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe("#2f4858");
  });
});

describe("the lines under the cards", () => {
  it("next battle: a countdown, 'starting', or 'preparing' — as before", () => {
    expect(text(renderToStaticMarkup(createElement(NextBattleLine, { next: { kind: "countdown", seconds: 5 } })))).toBe("Next battle in 5 sec");
    expect(text(renderToStaticMarkup(createElement(NextBattleLine, { next: { kind: "starting" } })))).toBe("Next battle starting…");
    expect(text(renderToStaticMarkup(createElement(NextBattleLine, { next: { kind: "preparing" } })))).toBe("Preparing next battle…");
  });

  it("the viewer's pick: the name is truncated safely (full name never needed to fit), the outcome chip says what happened", () => {
    const line = (pick: Parameters<typeof PickResultLine>[0]["pick"]) => renderToStaticMarkup(createElement(PickResultLine, { pick }));
    expect(line({ name: LONG, outcome: "PENDING" })).toMatch(/truncate/);
    expect(text(line({ name: "Alex", outcome: "CORRECT", points: 10 }))).toBe("Your pick: Alex Correct pick +10 Points");
    expect(text(line({ name: "Alex", outcome: "CORRECT" }))).toBe("Your pick: Alex Correct pick");
    expect(text(line({ name: "Alex", outcome: "INCORRECT" }))).toBe("Your pick: Alex Not this time");
    expect(text(line({ name: "Alex", outcome: "VOID" }))).toBe("Your pick: Alex Battle cancelled");
    expect(text(line({ name: "Alex", outcome: "PENDING" }))).toBe("Your pick: Alex Settling…");
  });

  it("the panel puts the pick line above the next-battle line, both inside the footer", () => {
    const h = html(entries(), { name: "Alex", outcome: "PENDING" } as never, { kind: "countdown", seconds: 3 } as never);
    const footer = h.slice(h.indexOf('data-testid="results-footer"'));
    expect(footer.indexOf('data-testid="pick-overlay"')).toBeGreaterThan(-1);
    expect(footer.indexOf('data-testid="pick-overlay"')).toBeLessThan(footer.indexOf('data-testid="results-next"'));
  });
});

describe("measured height: the panel steps down a density tier until it fits (never clipped, never scrolling)", () => {
  it("starts at the roomiest tier and exposes the tier it is in", () => {
    expect(html()).toContain('data-density="0"');
    expect(html(entries(), null, null, 1)).toContain('data-density="1"');
    expect(html(entries(), null, null, 2)).toContain('data-density="2"');
  });

  it("tier 1 folds the title away and tightens the cards; tier 2 shrinks the portraits and puts every name on one line — both cards stay", () => {
    const d0 = html(entries(), null, null, 0);
    const d1 = html(entries(), null, null, 1);
    const d2 = html(entries(), null, null, 2);
    const folded = /<p class="(?:[^"]*\s)?sr-only(?:\s[^"]*)?">Results/;
    expect(d0).not.toMatch(folded);
    expect(d1).toMatch(folded);
    expect(d2).toMatch(folded);
    expect(d1).toContain("p-1.5");
    expect(d2).toContain("px-1.5 py-1");
    expect(d2).toMatch(/class="line-clamp-1 @xl:line-clamp-2 [^"]*"[^>]*title="Markyyester"/);
    for (const d of [d0, d1, d2]) expect(d.match(/data-testid="result-card"/g)).toHaveLength(2);
  });

  it("each tier is strictly smaller than the one before (portraits get smaller, never larger)", () => {
    const px = (c: string) => Number(/h-(\d+(?:\.\d+)?)\b/.exec(c)?.[1] ?? /h-\[(\d+(?:\.\d+)?)rem\]/.exec(c)?.[1]) * (c.includes("h-[") ? 16 : 4);
    for (const set of [DENSITY.winnerBox, DENSITY.runnerBox]) {
      expect(px(set[0])).toBeGreaterThan(px(set[1]));
      expect(px(set[1])).toBeGreaterThan(px(set[2]));
    }
  });

  it("the wide (side by side) layout keeps its sizes at every tier — only the narrow, stacked layout ever steps down", () => {
    for (const d of [0, 1, 2] as const) {
      const h = html(entries(), null, null, d);
      expect(h).toContain("@xl:h-[6.5rem] @xl:w-[6.5rem]");
      expect(h).toContain("@xl:h-20 @xl:w-20");
      expect(h).toContain("@xl:p-3");
    }
  });
});
