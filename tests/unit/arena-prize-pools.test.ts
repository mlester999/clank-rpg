import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrizePools } from "@/components/arena/PrizePools";
import { amountWidthEm, groupDigits, PICKS_FREE, PICKS_HOW, prizeTiles, PRIZE_RULES_LINK } from "@/components/arena/prizeView";
import { pickCopy } from "@/components/arena/picksView";
import type { PicksRewardDto } from "@/domain/rewards/picksDto";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { getPicksRewardDto } from "@/server/rewards/pool";
import type { Queryable } from "@/server/db/types";

/**
 * The Arena Picks PRIZE TILES — a compact QUICK SUMMARY: the two pools and the token, nothing else. What they say, where the numbers come from (the server's reward DTO —
 * nothing is typed twice), what is deliberately NOT here any more (the Top 10 banner, the countdown, the fine print — those live on the Leaderboards page), how the
 * type behaves at every width, and that nothing moves.
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const MON_OCT_5 = Date.UTC(2026, 9, 5, 12, 0, 0);
const REWARD: PicksRewardDto = {
  status: "ACTIVE",
  symbol: "$CLANKRPG",
  pointsPerCorrectPick: 10,
  dailyMinimumPicks: 20,
  weeklyMinimumPicks: 100,
  daily: { prizePool: "100,000", topRewarded: 10, endsAt: Date.UTC(2026, 9, 6, 0, 0, 0) },
  weekly: { prizePool: "500,000", topRewarded: 10, endsAt: Date.UTC(2026, 9, 12, 0, 0, 0) },
};
const render = (reward: PicksRewardDto | undefined) => renderToStaticMarkup(createElement(PrizePools, { reward }));
const cssFile = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

describe("what the tiles say", () => {
  it("shows the DAILY and WEEKLY pools — 100,000 and 500,000 $CLANKRPG — and nothing else", () => {
    const html = render(REWARD);
    expect(html).toContain('data-testid="prize-daily"');
    expect(html).toContain('data-testid="prize-weekly"');
    expect(html).toMatch(/data-testid="prize-daily-label"[^>]*>Daily pool</);
    expect(html).toMatch(/data-testid="prize-weekly-label"[^>]*>Weekly pool</);
    expect(html).toMatch(/data-testid="prize-daily-amount"[^>]*>100,000</);
    expect(html).toMatch(/data-testid="prize-weekly-amount"[^>]*>500,000</);
    expect(html).toMatch(/data-testid="prize-daily-symbol"[^>]*>\$CLANKRPG</);
    expect(html).toMatch(/data-testid="prize-weekly-symbol"[^>]*>\$CLANKRPG</);
    expect(text(html)).toMatch(/^Daily pool 100,000 \$CLANKRPG Weekly pool 500,000 \$CLANKRPG /);
  });

  it("REMOVED from the Arena: the TOP 10 banner, the reset countdown, the fine print and every repeated explanation", () => {
    const html = render(REWARD);
    const t = text(html);
    expect(t).not.toMatch(/top 10|top \d+ winners|winners/i);
    expect(t).not.toMatch(/resets|rolling over|ends in|\d{1,2}[:hH] ?\d{2}/i);
    expect(t).not.toMatch(/each pool|shared by|valid picks|minimum|holder|launch|claim/i);
    for (const hook of ["prize-top", "prize-reset", "prize-fineprint", "prize-launch-note", "prize-sheen", "prize-art-box"]) expect(html, hook).not.toContain(hook);
    expect(html).not.toContain("<time");
    expect(html).not.toContain('role="timer"');
  });

  it("says POOL, never 'per winner': nothing implies one player receives the whole amount", () => {
    const t = text(render(REWARD));
    expect(t).not.toMatch(/each winner|every winner|per winner|guarantee|you will (win|receive|earn \d)|win up to|up to 100,000/i);
    expect(t).not.toMatch(/\b(bet|wager|odds|jackpot|casino|stake)\b/i);
  });

  it("has ONE link to the rules — the Leaderboards page, where Top-N, minimum Picks, holder bonus and the countdowns live", () => {
    const html = render(REWARD);
    expect(PRIZE_RULES_LINK.href).toBe("/leaderboard");
    expect(html).toMatch(/<a [^>]*href="\/leaderboard"[^>]*>Prize rules &amp; countdowns →<\/a>/);
    expect((html.match(/<a /g) ?? []).length).toBe(1);
  });

  it("the game explanation is two short lines: 'Correct Pick = +10 Points' and 'Free to play'", () => {
    const c = pickCopy(REWARD);
    expect(c.lead).toBe("Correct Pick = +10 Points");
    expect(c.free).toBe("Free to play");
    expect(c.lead).toBe(PICKS_HOW(10));
    expect(c.free).toBe(PICKS_FREE);
    expect(c.scoring).toBeNull();
    expect(`${c.lead} ${c.free}`.length).toBeLessThan(45);
    const off = pickCopy({ ...REWARD, status: "OFF" }); // programme off → the calm no-prize wording
    expect(off.lead).toBe("Pick who wins the next fight.");
    expect(off.scoring).toBe("Correct Picks earn Clank Points toward the Daily and Weekly leaderboards.");
  });
});

describe("the numbers come from the server's reward configuration — nothing is typed twice", () => {
  it("shows whatever pools the configuration says", () => {
    const html = render({ ...REWARD, daily: { ...REWARD.daily, prizePool: "250,000" }, weekly: { ...REWARD.weekly, prizePool: "1,250,000" } });
    expect(html).toMatch(/data-testid="prize-daily-amount"[^>]*>250,000</);
    expect(html).toMatch(/data-testid="prize-weekly-amount"[^>]*>1,250,000</);
    expect(text(html)).not.toMatch(/100,000|500,000/);
  });

  it("is built from the very DTO the server sends: the real settings produce exactly 500,000 and 1,000,000; an admin change follows", async () => {
    const noDb: Queryable = { query: async () => [{ ok: true }] as never, exec: async () => undefined };
    const live = await getPicksRewardDto(noDb, DEFAULT_SETTINGS, MON_OCT_5);
    const p = prizeTiles(live)!;
    expect([p.daily.amount, p.weekly.amount, p.daily.symbol, p.daily.label, p.weekly.label]).toEqual(["500,000", "1,000,000", "$CLANKRPG", "Daily pool", "Weekly pool"]);
    const admin = { ...DEFAULT_SETTINGS, arena_picks: { ...DEFAULT_SETTINGS.arena_picks, dailyPrizePool: "75000", weeklyPrizePool: "300000" } };
    const changed = prizeTiles(await getPicksRewardDto(noDb, admin, MON_OCT_5))!;
    expect([changed.daily.amount, changed.weekly.amount]).toEqual(["75,000", "300,000"]);
    for (const file of ["src/components/arena/PrizePools.tsx", "src/components/arena/prizeView.ts"]) {
      const code = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/100,?000|500,?000/);
    }
  });

  it("promises nothing when there is nothing to promise: programme off, a zero pool, no rewarded rank, or no reward data at all", () => {
    expect(prizeTiles(undefined)).toBeNull();
    expect(prizeTiles({ ...REWARD, status: "OFF" })).toBeNull();
    expect(prizeTiles({ ...REWARD, daily: { ...REWARD.daily, prizePool: "0" } })).toBeNull();
    expect(prizeTiles({ ...REWARD, weekly: { ...REWARD.weekly, prizePool: "0.00" } })).toBeNull();
    expect(prizeTiles({ ...REWARD, daily: { ...REWARD.daily, topRewarded: 0 } })).toBeNull();
    expect(prizeTiles({ ...REWARD, pointsPerCorrectPick: 0 })).toBeNull();
    for (const r of [undefined, { ...REWARD, status: "OFF" as const }]) expect(render(r)).toBe("");
  });
});

describe("number formatting", () => {
  it("groups thousands with commas, keeps an already-grouped number, and never invents a number from text", () => {
    expect(groupDigits("100000")).toBe("100,000");
    expect(groupDigits("100,000")).toBe("100,000");
    expect(groupDigits("1234567.5")).toBe("1,234,567.5");
    expect(groupDigits("soon")).toBe("soon");
    expect(groupDigits("")).toBe("");
  });

  it("estimates an amount's width so the type can always be fitted to the tile (longer pool → smaller type)", () => {
    expect(amountWidthEm("100,000")).toBeCloseTo(4.82, 2);
    expect(amountWidthEm("12,500,000")).toBeGreaterThan(amountWidthEm("500,000"));
    expect(amountWidthEm("1,000,000,000")).toBeGreaterThan(amountWidthEm("12,500,000"));
    // the tile sets the font from `90cqw / amountWidthEm`: the narrowest tile (≈ 120 px of content at 320 px) still gets a readable size
    expect((0.9 * 120) / amountWidthEm("500,000")).toBeGreaterThan(20);
    expect((0.9 * 120) / amountWidthEm("12,500,000")).toBeGreaterThan(13);
  });
});

describe("compact and restrained", () => {
  const html = render(REWARD);

  it("each tile is a labelled article ('Daily pool: 100,000 $CLANKRPG'); the pictures are decorative; one labelled region", () => {
    expect(html).toContain('aria-label="Daily pool: 100,000 $CLANKRPG"');
    expect(html).toContain('aria-label="Weekly pool: 500,000 $CLANKRPG"');
    expect(html).toContain('aria-label="Arena Picks prize pools"');
    expect((html.match(/<svg[^>]*aria-hidden/g) ?? []).length).toBe(2);
  });

  it("is two tiles side by side at EVERY width (no breakpoint changes the grid), and far shorter than the old plaques", () => {
    expect(html).toContain('class="prize-pair"');
    expect(html).not.toMatch(/grid-cols-1|sm:grid-cols|md:grid-cols/);
    expect(html.length).toBeLessThan(4500); // the old plaque pair rendered ~14 kB of markup (picture box, title, ribbon, countdown, sheen, fine print, a <rect> per pixel run)
  });

  it("plays no sound and loads no media", () => {
    expect(html).not.toMatch(/<audio|<video|<source|\.mp3|\.ogg|\.wav|<script/i);
    for (const file of ["src/components/arena/PrizePools.tsx", "src/components/arena/prizeView.ts"]) expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toMatch(/AudioContext|getArenaAudio|useArenaAudio|\.play\(/);
  });

  it("has no client code at all: no hook, no timer, no 'use client' — nothing on the Arena re-renders because of it", () => {
    const code = readFileSync(path.join(process.cwd(), "src/components/arena/PrizePools.tsx"), "utf8");
    expect(code).not.toMatch(/"use client"|useState|useEffect|setInterval|useServerCountdown/);
  });
});

describe("the stylesheet: mobile-safe sizing, no glow, no looping motion", () => {
  const block = (name: string): string => {
    const i = cssFile.indexOf(`${name} {`);
    expect(i, name).toBeGreaterThan(-1);
    return cssFile.slice(i, cssFile.indexOf("}", i));
  };

  it("sizes the amount from the tile's own width (container query units) divided by the number's width, on one line", () => {
    expect(block(".prize-tile")).toContain("container-type: inline-size");
    expect(block(".prize-tile-amount")).toMatch(/calc\(90cqw \/ var\(--amount-em/);
    expect(block(".prize-tile-amount")).toContain("white-space: nowrap");
    expect(cssFile).toMatch(/\.prize-tile-weekly \.prize-tile-amount \{[^}]*calc\(94cqw/); // the Weekly is a little more prestigious, not dramatically larger
    expect(block(".prize-pair")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  it("the amount's type never exceeds a heading size (compact): max 1.75 rem Daily, 1.9 rem Weekly", () => {
    expect(block(".prize-tile-amount")).toMatch(/clamp\(0\.85rem, calc\(.*\), 1\.75rem\)/);
    expect(cssFile).toMatch(/\.prize-tile-weekly \.prize-tile-amount \{ font-size: clamp\(0\.85rem, calc\(.*\), 1\.9rem\)/);
  });

  it("is restrained: no glow filter, no animation, no sheen, no entrance — and the old plaque styles are gone", () => {
    const region = cssFile.slice(cssFile.indexOf("/* ---------- Arena Picks prize tiles"), cssFile.indexOf("/* scrollbars */"));
    expect(region).not.toMatch(/animation:|@keyframes|drop-shadow|box-shadow|text-shadow|filter: blur/);
    for (const gone of [".prize-grid", ".prize-card", ".prize-sheen", ".prize-art-box", ".prize-top", ".prize-reset", "prize-in", "prize-sheen"]) expect(cssFile, gone).not.toContain(gone);
    // hover brightness only where there is a real pointer
    expect(region).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.prize-tile \{ transition/);
  });
});
