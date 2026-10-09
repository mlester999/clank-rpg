import { readFileSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PrizePools } from "@/components/arena/PrizePools";
import { amountWidthEm, dailyResetText, groupDigits, PICKS_FREE, PICKS_HOW, prizeFinePrint, prizePlaques, resetText, ROLLING_OVER, weeklyResetText } from "@/components/arena/prizeView";
import { pickCopy } from "@/components/arena/picksView";
import { countdownParts } from "@/domain/rewards/leaderboard";
import type { PicksRewardDto } from "@/domain/rewards/picksDto";
import { GAME_RULES } from "@/domain/gameRules";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { getPicksRewardDto } from "@/server/rewards/pool";
import type { Queryable } from "@/server/db/types";

/**
 * The Arena Picks PRIZE PLAQUES: what they say (numbers, token, Top 10, minimums, the launch note), where the numbers come from (the server's reward DTO — nothing
 * is typed twice), how they behave at every width (container-sized type, a two-column grid that never stacks into overflow) and that motion respects the viewer.
 */
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const MON_OCT_5 = Date.UTC(2026, 9, 5, 12, 0, 0); // a Monday, noon UTC
const REWARD: PicksRewardDto = {
  status: "ACTIVE",
  symbol: "$CLANKRPG",
  pointsPerCorrectPick: 10,
  dailyMinimumPicks: 20,
  weeklyMinimumPicks: 100,
  daily: { prizePool: "100,000", topRewarded: 10, endsAt: Date.UTC(2026, 9, 6, 0, 0, 0) },
  weekly: { prizePool: "500,000", topRewarded: 10, endsAt: Date.UTC(2026, 9, 12, 0, 0, 0) },
};
const render = (reward: PicksRewardDto | undefined, serverNow = MON_OCT_5) => renderToStaticMarkup(createElement(PrizePools, { reward, serverNow }));

describe("what the plaques say", () => {
  it("shows the DAILY and WEEKLY pools as totals — 100,000 and 500,000 — in $CLANKRPG, for the Top 10", () => {
    const html = render(REWARD);
    const t = text(html);
    expect(html).toContain('data-testid="prize-daily"');
    expect(html).toContain('data-testid="prize-weekly"');
    expect(t).toContain("Daily Prize pool");
    expect(t).toContain("Weekly Prize pool");
    expect(t).toMatch(/Daily Prize pool 100,000 \$CLANKRPG Top 10 winners/);
    expect(t).toMatch(/Weekly Prize pool 500,000 \$CLANKRPG Top 10 winners/);
    expect(html).toMatch(/data-testid="prize-daily-amount"[^>]*>100,000</);
    expect(html).toMatch(/data-testid="prize-weekly-amount"[^>]*>500,000</);
    expect(html).toMatch(/data-testid="prize-daily-symbol"[^>]*>\$CLANKRPG</);
    expect(html).toMatch(/data-testid="prize-weekly-symbol"[^>]*>\$CLANKRPG</);
  });

  it("never implies each winner receives the whole amount: the pool is said to be SHARED by the Top 10, by rank", () => {
    const t = text(render(REWARD));
    expect(t).toContain("Each pool is shared by the Top 10, by rank.");
    expect(t).not.toMatch(/each winner|every winner|per winner|winner (gets|receives|takes)|guarantee|you will (win|receive|earn \d)|win up to|up to 100,000/i);
    expect(t).not.toMatch(/\b(bet|wager|odds|jackpot|casino|stake)\b/i);
  });

  it("states the REAL prize minimums (20 valid Picks a day · 100 a week) — one correct Pick does not qualify anyone", () => {
    const t = text(render(REWARD));
    expect(t).toContain("Prizes need 20 valid Picks in a day (Daily) or 100 in a week (Weekly).");
    expect(t).not.toMatch(/one correct pick|any correct pick|a single (correct )?pick|1 correct pick/i);
    // …and they are the game's own numbers
    expect(GAME_RULES.picks.dailyMinimumPicks).toBe(20);
    expect(GAME_RULES.picks.weeklyMinimumPicks).toBe(100);
    expect(REWARD.dailyMinimumPicks).toBe(GAME_RULES.picks.dailyMinimumPicks);
    expect(REWARD.weeklyMinimumPicks).toBe(GAME_RULES.picks.weeklyMinimumPicks);
  });

  it("the game explanation is two plain lines: pick the winner, +10 Points per correct Pick, free, no wallet", () => {
    const c = pickCopy(REWARD);
    expect(c.lead).toBe("Pick the winner. Earn +10 Points for every correct Pick.");
    expect(c.free).toBe("Free to play · No wallet required");
    expect(c.lead).toBe(PICKS_HOW(10));
    expect(c.free).toBe(PICKS_FREE);
    expect(c.scoring).toBeNull();
    // with the programme off it falls back to the calm no-prize wording
    const off = pickCopy({ ...REWARD, status: "OFF" });
    expect(off.lead).toBe("Pick who wins the next fight.");
    expect(off.scoring).toBe("Correct Picks earn Clank Points toward the Daily and Weekly leaderboards.");
  });
});

describe("the numbers come from the server's reward configuration — nothing is typed twice", () => {
  it("shows whatever pools, rank count and minimums the configuration says", () => {
    const custom: PicksRewardDto = { ...REWARD, dailyMinimumPicks: 15, weeklyMinimumPicks: 80, daily: { ...REWARD.daily, prizePool: "250,000", topRewarded: 5 }, weekly: { ...REWARD.weekly, prizePool: "1,250,000", topRewarded: 5 } };
    const html = render(custom);
    const t = text(html);
    expect(html).toMatch(/data-testid="prize-daily-amount"[^>]*>250,000</);
    expect(html).toMatch(/data-testid="prize-weekly-amount"[^>]*>1,250,000</);
    expect(t).toContain("Top 5 winners");
    expect(t).not.toContain("Top 10 winners");
    expect(t).toContain("Each pool is shared by the Top 5, by rank. Prizes need 15 valid Picks in a day (Daily) or 80 in a week (Weekly).");
    expect(t).not.toMatch(/100,000|500,000/);
  });

  it("different rank counts for the two boards are stated for each", () => {
    const p = prizePlaques({ ...REWARD, weekly: { ...REWARD.weekly, topRewarded: 20 } })!;
    expect(p.daily.topLabel).toBe("Top 10 winners");
    expect(p.weekly.topLabel).toBe("Top 20 winners");
    expect(prizeFinePrint(p)).toContain("the Top 10 (Daily) and Top 20 (Weekly)");
  });

  it("is built from the very DTO the server sends: the real settings produce exactly the plaques' 100,000 and 500,000 and the leaderboards' own period ends", async () => {
    const noDb: Queryable = { query: async () => [{ ok: true }] as never, exec: async () => undefined };
    const live = await getPicksRewardDto(noDb, DEFAULT_SETTINGS, MON_OCT_5);
    expect(live.status).toBe("ACTIVE");
    expect(live.daily.prizePool).toBe("100,000");
    expect(live.weekly.prizePool).toBe("500,000");
    expect(live.daily.endsAt).toBe(Date.UTC(2026, 9, 6, 0, 0, 0)); // the next 00:00 UTC
    expect(live.weekly.endsAt).toBe(Date.UTC(2026, 9, 12, 0, 0, 0)); // the next Monday 00:00 UTC
    const p = prizePlaques(live)!;
    expect([p.daily.amount, p.weekly.amount, p.daily.symbol, p.daily.top, p.daily.minimumPicks, p.weekly.minimumPicks]).toEqual(["100,000", "500,000", "$CLANKRPG", 10, 20, 100]);
    // an admin changes the setting → the plaque follows (no hard-coded amount anywhere in the plaque code)
    const admin = { ...DEFAULT_SETTINGS, arena_picks: { ...DEFAULT_SETTINGS.arena_picks, dailyPrizePool: "75000", weeklyPrizePool: "300000" } };
    const changed = prizePlaques(await getPicksRewardDto(noDb, admin, MON_OCT_5))!;
    expect([changed.daily.amount, changed.weekly.amount]).toEqual(["75,000", "300,000"]);
    for (const file of ["src/components/arena/PrizePools.tsx", "src/components/arena/prizeView.ts"]) {
      const code = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // (examples in comments are not amounts in code)
      expect(code, file).not.toMatch(/100,?000|500,?000/);
    }
  });

  it("promises nothing when there is nothing to promise: programme off, a zero pool, no rewarded rank, or no reward data at all", () => {
    expect(prizePlaques(undefined)).toBeNull();
    expect(prizePlaques({ ...REWARD, status: "OFF" })).toBeNull();
    expect(prizePlaques({ ...REWARD, daily: { ...REWARD.daily, prizePool: "0" } })).toBeNull();
    expect(prizePlaques({ ...REWARD, weekly: { ...REWARD.weekly, prizePool: "0.00" } })).toBeNull();
    expect(prizePlaques({ ...REWARD, daily: { ...REWARD.daily, topRewarded: 0 } })).toBeNull();
    expect(prizePlaques({ ...REWARD, pointsPerCorrectPick: 0 })).toBeNull();
    for (const r of [undefined, { ...REWARD, status: "OFF" as const }]) expect(render(r)).toBe("");
  });
});

describe("number formatting", () => {
  it("groups thousands with commas, keeps an already-grouped number, and never invents a number from text", () => {
    expect(groupDigits("100000")).toBe("100,000");
    expect(groupDigits("100,000")).toBe("100,000");
    expect(groupDigits("500000")).toBe("500,000");
    expect(groupDigits("1234567")).toBe("1,234,567");
    expect(groupDigits("1234567.5")).toBe("1,234,567.5");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("soon")).toBe("soon");
    expect(groupDigits("")).toBe("");
  });

  it("estimates an amount's width so the type can always be fitted to the plaque (longer pool → smaller type)", () => {
    expect(amountWidthEm("100,000")).toBeCloseTo(4.82, 2);
    expect(amountWidthEm("500,000")).toBe(amountWidthEm("100,000"));
    expect(amountWidthEm("12,500,000")).toBeGreaterThan(amountWidthEm("500,000"));
    expect(amountWidthEm("1,000,000,000")).toBeGreaterThan(amountWidthEm("12,500,000"));
    // the plaque sets the font from `80cqw / amountWidthEm`: 132 px plaque (the narrowest phone) × 80 % ÷ 4.82 em ≈ 22 px → readable; a 10-character pool still ≥ 14 px
    expect((0.8 * 132) / amountWidthEm("500,000")).toBeGreaterThan(20);
    expect((0.8 * 132) / amountWidthEm("12,500,000")).toBeGreaterThan(14);
  });
});

describe("no launch disclaimer on the plaques", () => {
  it("says nothing about the token launch (the note was removed): no 'claimable after launch', no claim or payout words", () => {
    const t = text(render(REWARD));
    expect(t).not.toMatch(/launch|claimable|claim now|claim your|\b(paid|payout|you won|congratulations)\b/i);
    expect(render(REWARD)).not.toContain("prize-launch-note");
  });
});

describe("the countdowns are the leaderboard's own", () => {
  it("formats Daily as HH:MM:SS and Weekly as Xd HHh MMm from the same countdown parts the leaderboards use", () => {
    const at = (h: number, m: number, s: number, d = 0) => ((d * 24 + h) * 3600 + m * 60 + s) * 1000;
    expect(dailyResetText(countdownParts(at(14, 23, 18)))).toBe("14:23:18");
    expect(dailyResetText(countdownParts(at(0, 0, 5)))).toBe("00:00:05");
    expect(dailyResetText(countdownParts(at(23, 59, 59)))).toBe("23:59:59");
    expect(weeklyResetText(countdownParts(at(23, 41, 9, 6)))).toBe("6d 23h 41m");
    expect(weeklyResetText(countdownParts(at(3, 7, 0, 2)))).toBe("2d 03h 07m");
    expect(weeklyResetText(countdownParts(at(23, 41, 0)))).toBe("23h 41m"); // the last day
    expect(resetText("DAILY", at(1, 2, 3))).toBe("01:02:03");
    expect(resetText("WEEKLY", at(1, 2, 3, 4))).toBe("4d 01h 02m");
    expect(resetText("DAILY", 0)).toBe(ROLLING_OVER);
    expect(resetText("WEEKLY", -5000)).toBe(ROLLING_OVER);
  });

  it("renders the time left to each board's UTC end, measured from the SERVER's clock (noon Monday → 12:00:00 to midnight, 6d 12h 00m to next Monday)", () => {
    const html = render(REWARD);
    expect(html).toMatch(/data-testid="prize-daily-reset"[^>]*>.*?<b class="tnum">12:00:00<\/b>/);
    expect(html).toMatch(/data-testid="prize-weekly-reset"[^>]*>.*?<b class="tnum">6d 12h 00m<\/b>/);
    expect(text(html)).toContain("Resets in 12:00:00");
    expect(text(html)).toContain("Resets in 6d 12h 00m");
    // one minute before the Daily boundary
    expect(text(render(REWARD, REWARD.daily.endsAt - 61_000))).toContain("Resets in 00:01:01");
    // after the boundary the board is rolling over — never a negative time
    const over = text(render(REWARD, REWARD.daily.endsAt + 1000));
    expect(over).toContain("Rolling over…");
    expect(over).not.toMatch(/-\d/);
  });
});

describe("accessibility and structure", () => {
  const html = render(REWARD);

  it("each plaque is a labelled region with a real heading ('Daily Prize pool'); the pictures are decorative", () => {
    expect(html).toMatch(/<article[^>]*aria-labelledby="prize-daily-title"/);
    expect(html).toMatch(/<article[^>]*aria-labelledby="prize-weekly-title"/);
    expect(html).toMatch(/<h3 id="prize-daily-title"[^>]*><b>Daily<\/b> <span>Prize pool<\/span><\/h3>/);
    expect(html).toMatch(/<h3 id="prize-weekly-title"[^>]*><b>Weekly<\/b> <span>Prize pool<\/span><\/h3>/);
    expect((html.match(/<svg[^>]*aria-hidden/g) ?? []).length).toBe(2);
    expect(html).toContain('aria-label="Arena Picks prize pools"');
  });

  it("plays no sound and loads no media: no audio element, no media file, no script", () => {
    expect(html).not.toMatch(/<audio|<video|<source|\.mp3|\.ogg|\.wav|<script/i);
    for (const file of ["src/components/arena/PrizePools.tsx", "src/components/arena/prizeView.ts"]) expect(readFileSync(path.join(process.cwd(), file), "utf8"), file).not.toMatch(/AudioContext|getArenaAudio|useArenaAudio|\.play\(/);
  });

  it("is two columns at EVERY width (compact side-by-side, never an overflowing stack): the grid has no breakpoint that changes it", () => {
    expect(html).toContain('class="prize-grid"');
    expect(html).not.toMatch(/grid-cols-1|sm:grid-cols|md:grid-cols|flex-col"[^>]*data-testid="prize-pools"/);
  });
});

describe("the stylesheet: mobile-safe sizing and respectful motion", () => {
  const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  const block = (name: string): string => {
    const i = css.indexOf(`${name} {`);
    expect(i, name).toBeGreaterThan(-1);
    return css.slice(i, css.indexOf("}", i));
  };

  it("sizes the type from the plaque's own width (container query units) so a number can neither overflow nor shrink to nothing", () => {
    expect(block(".prize-grid")).toContain("container-type: inline-size");
    expect(block(".prize-grid")).toMatch(/--cu: calc\(\(100cqw - 0\.5rem\) \/ 200\)/); // 1 % of one plaque's width
    expect(block(".prize-amount")).toMatch(/calc\(var\(--cu\) \* 80 \/ var\(--amount-em/);
    expect(block(".prize-amount")).toContain("white-space: nowrap");
    expect(css).toMatch(/\.prize-weekly \.prize-amount \{[^}]*calc\(var\(--cu\) \* 86/); // Weekly: a little stronger
    for (const sel of [".prize-title b", ".prize-symbol", ".prize-top", ".prize-reset"]) expect(block(sel), sel).toMatch(/clamp\([^)]*var\(--cu\)/);
  });

  it("the two plaques are subgrids of one grid, so their rows (and both amounts) always line up", () => {
    expect(block(".prize-card")).toContain("grid-template-rows: subgrid");
    expect(block(".prize-card")).toContain("grid-row: span 6");
    expect(block(".prize-grid")).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
  });

  it("every plaque animation lives inside prefers-reduced-motion: no-preference; the rest is static", () => {
    const start = css.indexOf("@media (prefers-reduced-motion: no-preference) {\n  /* a gentle reveal");
    expect(start).toBeGreaterThan(-1);
    // find the matching close of that media block
    let depth = 0;
    let end = start;
    for (let i = css.indexOf("{", start); i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    const inside = css.slice(start, end);
    const outside = css.slice(0, start) + css.slice(end);
    expect(inside).toContain("animation: prize-in");
    expect(inside).toContain("animation: prize-sheen 10s");
    expect(outside).not.toMatch(/animation:\s*prize-(in|sheen)/);
    // the sheen is a single soft pass every several seconds, never a continuous flash
    expect(css).toMatch(/@keyframes prize-sheen \{\s*0%, 74% \{/);
    // hover lift only where there is a real pointer
    expect(css).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*\.prize-card \{ transition/);
  });
});
