import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeroName } from "@/components/hero/HeroName";
import { glyphEm, nameFit } from "@/domain/character/nameFit";

/**
 * A hero's name is fitted to its box: ONE line at the largest size that fits, a balanced wrap only between words for a long name, a shrinking long word — and an
 * ordinary 11-letter name is never broken as "MARKYYEST / ER". The widths are the display face's REAL advances, measured in Chrome at 100 px (Bungee).
 */
const MEASURED_EM: Record<string, number> = {
  MARKYYESTER: 7.8, Markyyester: 7.8, Jayson: 4.24, Alex: 2.82, "Spammer McSpamface": 12.34, "Wanderer 4821": 8.74, Supercalifragilisticexpialidocious: 22.92,
  "Maximilian Bartholomew Fitzwilliam-Smyth": 27.27, WWWWWWWWWWWWWWWW: 13.3, iiiiiiiiiiiiiiii: 9.68, "Dr. J. R. R. T.": 7.07, "Nyx_Void99": 7.11, "Fay O'Neil": 6.02,
  "Sir Bartholomew Maximilian Featherstonehaugh-Smythe III": 36.56,
};

describe("the width estimate is the face's own (never smaller than what is drawn, never much larger)", () => {
  it("is 0–8 % over the measured width for every sample — so the type fitted from it can never overflow because of the estimate", () => {
    for (const [name, measured] of Object.entries(MEASURED_EM)) {
      const ratio = nameFit(name).totalEm / measured;
      expect(ratio, name).toBeGreaterThanOrEqual(1.01);
      expect(ratio, name).toBeLessThanOrEqual(1.08);
    }
  });

  it("knows the face is unicase (a letter is as wide in either case), narrow I/i/./',', wide W/M/@/%", () => {
    expect(glyphEm("a")).toBe(glyphEm("A"));
    expect(glyphEm("w")).toBe(glyphEm("W"));
    expect(glyphEm("i")).toBeLessThan(glyphEm("m"));
    expect(glyphEm(".")).toBeLessThan(0.4);
    expect(glyphEm("%")).toBeGreaterThan(glyphEm("M"));
    expect(glyphEm(" ")).toBeLessThan(0.3);
  });

  it("gives emoji, CJK and other scripts (drawn in a fallback face) generous widths, and combining marks none", () => {
    expect(glyphEm("😀")).toBeGreaterThan(1.1);
    expect(glyphEm(String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467))).toBeGreaterThan(1.1); // one grapheme: the whole ZWJ family
    expect(glyphEm("勇")).toBeGreaterThan(1.1);
    expect(glyphEm("Ж")).toBeGreaterThan(0.85);
    expect(glyphEm(String.fromCodePoint(0x0301))).toBe(0);
    expect(Math.abs(nameFit("Zalgo\u0301\u0302\u0303\u0304").totalEm - nameFit("Zalgo").totalEm)).toBeLessThan(0.2); // stacked marks add (almost) no width
  });

  it("separates the whole name from its widest unbreakable run: words break at spaces and after hyphens", () => {
    const f = nameFit("Sir Bartholomew Maximilian Featherstonehaugh-Smythe III");
    expect(f.totalEm).toBeGreaterThan(30);
    expect(f.wordEm).toBeLessThan(14);
    expect(nameFit("Maximilian Bartholomew Fitzwilliam-Smyth").wordEm).toBeLessThan(10);
    expect(nameFit("MARKYYESTER").wordEm).toBe(nameFit("MARKYYESTER").totalEm); // one word: they are the same
  });

  it("never returns 0 or NaN, for an empty name, a space, or only marks", () => {
    for (const n of ["", " ", "́", "   "]) {
      const f = nameFit(n);
      expect(f.totalEm).toBeGreaterThan(0);
      expect(f.wordEm).toBeGreaterThan(0);
      expect(Number.isFinite(f.totalEm + f.wordEm)).toBe(true);
    }
  });
});

describe("the component and its stylesheet", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const render = (name: string, props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HeroName, { name, ...props }));

  it("renders the full name as plain text in a heading, with a title, inside a size container; nothing is cut off", () => {
    const html = render("MARKYYESTER", { testId: "hero-name" });
    expect(html).toContain('class="hero-name-box"');
    expect(html).toMatch(/<h1 class="hero-name font-display text-paper "[^>]*title="MARKYYESTER" data-testid="hero-name">MARKYYESTER<\/h1>/);
    expect(html).not.toMatch(/truncate|line-clamp|ellipsis/);
    expect(render("<img src=x onerror=alert(1)>")).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("passes the name's widths and the size limits as custom properties (the same HTML on server and client — no measuring script)", () => {
    const html = render("MARKYYESTER", { max: "1.5rem", min: "0.85rem", wrapCap: "1.35rem" });
    const f = nameFit("MARKYYESTER");
    expect(html).toContain(`--name-total-em:${f.totalEm}`);
    expect(html).toContain(`--name-word-em:${f.wordEm}`);
    expect(html).toContain("--name-max:1.5rem");
    expect(html).toContain("--name-min:0.85rem");
    expect(html).toContain("--name-cap:1.35rem");
    expect(html).not.toMatch(/<script/);
  });

  it("supports other heading levels and centring (the hero card)", () => {
    expect(render("Fay", { as: "h2", align: "center" })).toMatch(/data-align="center"[\s\S]*<h2 /);
  });

  it("the fit is clamp(min, max(box ÷ whole name, min(box ÷ widest word, wrap cap)), max) in container units — one line when it fits, balanced wrap between words, a shrinking long word", () => {
    const i = css.indexOf(".hero-name {");
    const rule = css.slice(i, css.indexOf("\n}", i));
    expect(css).toMatch(/\.hero-name-box \{ container-type: inline-size; min-width: 0; \}/);
    expect(rule).toMatch(/clamp\(\s*var\(--name-min, 0\.8rem\),\s*max\(calc\(100cqw \/ var\(--name-total-em, 8\)\), min\(calc\(100cqw \/ var\(--name-word-em, 8\)\), var\(--name-cap, 1\.6rem\)\)\),\s*var\(--name-max, 1\.875rem\)\s*\)/);
    expect(rule).toContain("text-wrap: balance");
    expect(rule).toContain("overflow-wrap: anywhere"); // the LAST resort, below the minimum size only
    expect(rule).not.toMatch(/white-space: nowrap|text-overflow|line-clamp/);
  });
});

/** The arithmetic the stylesheet performs, in plain numbers (16 px root): which size does a name get in a box of a given width? */
const sizePx = (name: string, boxPx: number, o: { min?: number; max?: number; cap?: number } = {}): number => {
  const { min = 12.8, max = 30, cap = 25.6 } = o;
  const f = nameFit(name);
  return Math.min(max, Math.max(min, Math.max(boxPx / f.totalEm, Math.min(boxPx / f.wordEm, cap))));
};
const lines = (name: string, boxPx: number, o?: { min?: number; max?: number; cap?: number }): "ONE LINE" | "WRAPS BETWEEN WORDS" | "MAY BREAK A WORD" => {
  const px = sizePx(name, boxPx, o);
  const f = nameFit(name);
  if (f.totalEm * px <= boxPx + 0.5) return "ONE LINE";
  return f.wordEm * px <= boxPx + 0.5 ? "WRAPS BETWEEN WORDS" : "MAY BREAK A WORD";
};

describe("what that arithmetic gives, at the widths the hero page really has (identity column 215 px on a phone … 270 px in the rail)", () => {
  it("MARKYYESTER is ONE line at every width — at 219 px (the screenshot that showed 'ER' on a second line) it is ~27 px, still large", () => {
    for (const box of [180, 200, 219, 260, 300, 400]) expect(lines("MARKYYESTER", box), `${box}px`).toBe("ONE LINE");
    expect(sizePx("MARKYYESTER", 219)).toBeGreaterThan(24);
    expect(sizePx("MARKYYESTER", 300)).toBe(30); // as large as the design allows when there is room
  });

  it("short names stay at the largest size; ordinary names never break a word (one line, or a balanced wrap between the words of a longer one)", () => {
    expect(sizePx("Alex", 219)).toBe(30);
    expect(sizePx("Jayson", 219)).toBe(30);
    for (const n of ["Spammer McSpamface", "Wanderer 4821", "Fay O'Neil", "Nyx_Void99", "Dr. J. R. R. T.", "Zoë Müller"]) {
      for (const box of [190, 219, 260, 300]) expect(lines(n, box), `${n} @ ${box}`).not.toBe("MAY BREAK A WORD");
    }
    for (const n of ["Wanderer 4821", "Nyx_Void99", "Fay O'Neil"]) expect(lines(n, 260), n).toBe("ONE LINE");
  });

  it("a long multi-word name wraps only BETWEEN words, at a size its widest word allows — never mid-word", () => {
    for (const n of ["Sir Bartholomew Maximilian Featherstonehaugh-Smythe III", "Maximilian Bartholomew Fitzwilliam-Smyth"]) {
      for (const box of [190, 219, 270]) expect(lines(n, box), `${n} @ ${box}`).toBe("WRAPS BETWEEN WORDS");
    }
  });

  it("one long word shrinks to fit instead of breaking — an 18-letter handle still fits one line at 219 px; only an extreme unbroken name (about 24+ letters) reaches the floor, where it may wrap inside the word rather than be cut off", () => {
    expect(lines("DarkLordOfTheNight", 219)).toBe("ONE LINE");
    expect(sizePx("DarkLordOfTheNight", 219)).toBeGreaterThan(14);
    expect(lines("Supercalifragilisticexpialidocious", 300)).toBe("MAY BREAK A WORD"); // 34 letters: the floor (12.8 px) is reached; overflow-wrap keeps every letter visible
    expect(sizePx("Supercalifragilisticexpialidocious", 219)).toBe(12.8);
  });

  it("the hero card (centred, 400 px of text, max 24 px) fits a 16-letter name on one line and wraps long names between words", () => {
    expect(lines("MARKYYESTER", 360, { max: 24, min: 13.6, cap: 21.6 })).toBe("ONE LINE");
    expect(lines("Sir Bartholomew Maximilian Featherstonehaugh-Smythe III", 360, { max: 24, min: 13.6, cap: 21.6 })).toBe("WRAPS BETWEEN WORDS");
  });
});
