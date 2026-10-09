import { describe, expect, it } from "vitest";

import { RARITIES, type Rarity } from "@/domain/character/appearance";
import { generateCharacter } from "@/domain/character/generate";
import { DEFAULT_CLASSES } from "@/domain/content";
import { BLOCK_MESSAGE, compareRerolled, memberActor, nextRerollAt, REROLL_REQUEST_ID, rerollDay, rolledStateProblem } from "@/domain/hero/freeReroll";
import { versionStateFromGenerated } from "@/domain/hero/heroVersion";
import { RARITY_RULES } from "@/domain/hero/rarity";
import { chanceAtLeast, chanceToReach, expectedRerollsTo, medianRerollsTo, meanPower, populationAfter, rarityOdds } from "@/domain/hero/rerollFairness";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { formatResetCountdown, spokenResetCountdown } from "@/domain/time/resetCountdown";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("the UTC day is the allowance's boundary (never a rolling 24 hours)", () => {
  it("rerollDay / nextRerollAt follow UTC midnight exactly, whatever the machine's timezone", () => {
    expect(rerollDay(Date.UTC(2026, 9, 9, 0, 0, 0))).toBe("2026-10-09");
    expect(rerollDay(Date.UTC(2026, 9, 9, 23, 59, 59, 999))).toBe("2026-10-09");
    expect(rerollDay(Date.UTC(2026, 9, 10, 0, 0, 0, 0))).toBe("2026-10-10");
    expect(nextRerollAt(Date.UTC(2026, 9, 9, 23, 50))).toBe(Date.UTC(2026, 9, 10));
    expect(nextRerollAt(Date.UTC(2026, 9, 10, 0, 0, 0, 0))).toBe(Date.UTC(2026, 9, 11)); // exactly at midnight the NEXT reset is a full day away
    // month / year / leap-day rollovers
    expect(rerollDay(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12-31");
    expect(nextRerollAt(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1));
    expect(nextRerollAt(Date.UTC(2028, 1, 28, 12))).toBe(Date.UTC(2028, 1, 29));
    expect(nextRerollAt(Date.UTC(2028, 1, 29, 12))).toBe(Date.UTC(2028, 2, 1));
  });

  it("used at 23:50 UTC → available again 10 minutes later, at 00:00 UTC", () => {
    const usedAt = Date.UTC(2026, 9, 9, 23, 50);
    expect(nextRerollAt(usedAt) - usedAt).toBe(10 * M);
  });
});

describe("the countdown text — one formatter for every 'resets / ends in' label", () => {
  it("under a day: 23H 59M 59S, zero-padded; at zero 00H 00M 00S", () => {
    expect(formatResetCountdown(23 * H + 59 * M + 59 * S)).toBe("23H 59M 59S");
    expect(formatResetCountdown(8 * H + 24 * M + 12 * S)).toBe("08H 24M 12S");
    expect(formatResetCountdown(9 * S)).toBe("00H 00M 09S");
    expect(formatResetCountdown(0)).toBe("00H 00M 00S");
    expect(formatResetCountdown(-5 * S)).toBe("00H 00M 00S");
  });

  it("a Daily timer never shows days: even exactly 24 hours reads 24H 00M 00S", () => {
    expect(formatResetCountdown(D)).toBe("24H 00M 00S");
    expect(formatResetCountdown(D - 1)).toBe("24H 00M 00S"); // ceil to the second: 23:59:59.999 left reads 24H until the first whole second passes… (never 23H 59M 60S)
    expect(formatResetCountdown(D - S)).toBe("23H 59M 59S");
  });

  it("with days allowed (the Weekly board): 06D 23H 59M / 02D 14H 09M while a whole day is left, then back to hours", () => {
    expect(formatResetCountdown(6 * D + 23 * H + 59 * M + 30 * S, { allowDays: true })).toBe("06D 23H 59M");
    expect(formatResetCountdown(2 * D + 14 * H + 9 * M + 1, { allowDays: true })).toBe("02D 14H 09M"); // with days the seconds are not shown (minutes never round up)
    expect(formatResetCountdown(2 * D + 14 * H + 9 * M, { allowDays: true })).toBe("02D 14H 09M");
    expect(formatResetCountdown(D, { allowDays: true })).toBe("01D 00H 00M");
    expect(formatResetCountdown(D - S, { allowDays: true })).toBe("23H 59M 59S");
    expect(formatResetCountdown(7 * D, { allowDays: true })).toBe("07D 00H 00M");
  });

  it("is a pure function of the milliseconds left (no clock, no locale, no timezone)", () => {
    const a = formatResetCountdown(12345678);
    expect(a).toBe(formatResetCountdown(12345678));
    expect(a).toMatch(/^\d{2,}H \d{2}M \d{2}S$/);
  });

  it("has a screen-reader form that says the same thing in words", () => {
    expect(spokenResetCountdown(23 * H + 59 * M + 59 * S)).toBe("23 hours 59 minutes 59 seconds");
    expect(spokenResetCountdown(H + M + S)).toBe("1 hour 1 minute 1 second");
    expect(spokenResetCountdown(2 * D + 14 * H + 9 * M, { allowDays: true })).toBe("2 days 14 hours 9 minutes");
  });
});

describe("what a reroll did — never presented as an upgrade unless it was one", () => {
  const hero = (rarity: Rarity, power: number, classId = "mage") => ({ rarity, power, classId });
  it("STRONGER / WEAKER / SAME_POWER, the rarity direction and whether the class changed", () => {
    expect(compareRerolled(hero("EPIC", 185), hero("RARE", 162, "warrior"))).toEqual({
      powerBefore: 185, powerAfter: 162, powerDelta: -23, rarityBefore: "EPIC", rarityAfter: "RARE", rarityChange: "LOWER", classChanged: true, verdict: "WEAKER",
    });
    expect(compareRerolled(hero("COMMON", 140), hero("LEGENDARY", 195))).toMatchObject({ powerDelta: 55, rarityChange: "HIGHER", classChanged: false, verdict: "STRONGER" });
    expect(compareRerolled(hero("RARE", 160), hero("RARE", 160))).toMatchObject({ powerDelta: 0, rarityChange: "SAME", verdict: "SAME_POWER" });
    // the same rarity can still be weaker (the PWR inside the band decides)
    expect(compareRerolled(hero("EPIC", 188), hero("EPIC", 171))).toMatchObject({ rarityChange: "SAME", verdict: "WEAKER", powerDelta: -17 });
  });
});

describe("the idempotency key and the actor", () => {
  it("accepts a random UUID, rejects anything else", () => {
    expect(REROLL_REQUEST_ID.test(crypto.randomUUID())).toBe(true);
    for (const bad of ["", "abc", "123", "00000000-0000-0000-0000-000000000000", "' or 1=1 --", `${crypto.randomUUID()} `, "g".repeat(36)]) expect(REROLL_REQUEST_ID.test(bad)).toBe(false);
  });
  it("names the member as the actor — never an admin", () => {
    expect(memberActor(123456)).toBe("member:123456");
  });
  it("the plain refusal copy never reveals a moderation reason", () => {
    expect(BLOCK_MESSAGE.HERO_UNAVAILABLE).not.toMatch(/suspend|ban|flag|review|moderat/i);
    for (const message of Object.values(BLOCK_MESSAGE)) expect(message).not.toMatch(/gold|token|pay|wallet|cost/i);
  });
});

describe("validation of a rolled state — the generator is trusted, a bad roll never becomes a version", () => {
  const classes = [...DEFAULT_CLASSES];
  const settings = DEFAULT_SETTINGS;
  const roll = (i: number) => {
    const g = generateCharacter({ telegramUserId: 700 + (i % 13), displayName: "Tester", behavior: {}, activityScore: (i % 7) * 12, classes, settings, secret: "unit-secret-0123456789abcdef", seedSalt: `v-${i}` });
    return versionStateFromGenerated(g, classes.find((c) => c.id === g.classId)!, settings.character, settings.visuals.spriteSet);
  };

  it("2,000 real rolls are all valid, in their band, for every class and rarity", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const s = roll(i);
      expect(rolledStateProblem(s, classes, settings.character), `roll ${i}`).toBeNull();
      seen.add(`${s.classId}/${s.rarity}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(20); // 6 classes × 4 rarities = 24; 1 % Legendary × 6 classes needs the long tail
  });

  it("refuses: another generator, an unknown class, an out-of-band PWR, a PWR that is not the stats' power, broken stats, no sprite", () => {
    const good = roll(1);
    expect(rolledStateProblem({ ...good, generatorVersion: "hero-gen/1" }, classes, settings.character)).toMatch(/generator/);
    expect(rolledStateProblem({ ...good, classId: "necromancer" }, classes, settings.character)).toMatch(/class/);
    const other: Rarity = good.rarity === "LEGENDARY" ? "COMMON" : "LEGENDARY";
    expect(rolledStateProblem({ ...good, rarity: other }, classes, settings.character)).toMatch(/band/);
    expect(rolledStateProblem({ ...good, power: good.power + 1 }, classes, settings.character)).toMatch(/PWR/);
    expect(rolledStateProblem({ ...good, power: 12.5 }, classes, settings.character)).toMatch(/whole number/);
    expect(rolledStateProblem({ ...good, stats: { ...good.stats, hp: Number.NaN } }, classes, settings.character)).toMatch(/hp/);
    expect(rolledStateProblem({ ...good, stats: { ...good.stats, str: 0 } }, classes, settings.character)).toMatch(/str/);
    expect(rolledStateProblem({ ...good, sprite: null }, classes, settings.character)).toMatch(/sprite/);
  });
});

describe("the long-run maths of one free reroll a day (docs/HERO_FREE_REROLL.md §4)", () => {
  const odds = rarityOdds(DEFAULT_SETTINGS.character.rarityWeights);

  it("a reroll uses the production odds, unchanged: 70 / 22 / 7 / 1", () => {
    expect(RARITIES.map((r) => Math.round(odds[r] * 1000) / 10)).toEqual([70, 22, 7, 1]);
  });

  it("the generator itself, over 20,000 fresh-salt rolls, matches those odds and stays in its bands (nothing is boosted, nothing hidden)", () => {
    const classes = [...DEFAULT_CLASSES];
    const n = 20_000;
    const count: Record<string, number> = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
    for (let i = 0; i < n; i++) {
      const g = generateCharacter({ telegramUserId: 9000 + (i % 211), displayName: "Odds", behavior: {}, activityScore: (i % 7) * 12, classes, settings: DEFAULT_SETTINGS, secret: "unit-secret-0123456789abcdef", seedSalt: `odds-${i}` });
      count[g.rarity]!++;
      expect(g.power).toBeGreaterThanOrEqual(RARITY_RULES[g.rarity].powerMin);
      expect(g.power).toBeLessThanOrEqual(RARITY_RULES[g.rarity].powerMax);
    }
    for (const r of RARITIES) expect(Math.abs(count[r]! / n - odds[r])).toBeLessThan(0.012);
  });

  it("the ratchet: a member who stops when they like a roll reaches Legendary in 99 rerolls on average (median 68), Epic+ in 11.5 (median 8)", () => {
    expect(chanceAtLeast(odds, "LEGENDARY")).toBeCloseTo(0.01, 10);
    expect(chanceAtLeast(odds, "EPIC")).toBeCloseTo(0.08, 10);
    expect(chanceAtLeast(odds, "RARE")).toBeCloseTo(0.3, 10);
    expect(expectedRerollsTo(odds, "LEGENDARY")).toBeCloseTo(99, 8);
    expect(expectedRerollsTo(odds, "EPIC")).toBeCloseTo(11.5, 8);
    expect(medianRerollsTo(odds, "LEGENDARY")).toBe(68);
    expect(medianRerollsTo(odds, "EPIC")).toBe(8);
    expect(chanceToReach(odds, "LEGENDARY", 30)).toBeCloseTo(1 - 0.99 ** 31, 10);
    expect(chanceToReach(odds, "LEGENDARY", 365)).toBeGreaterThan(0.97);
    expect(chanceToReach(odds, "EPIC", 30)).toBeGreaterThan(0.92);
  });

  it("populations are proper distributions; never/always rerolling is exactly today's odds; stopping at a target piles mass at and above it", () => {
    for (const days of [0, 1, 7, 30, 365]) {
      for (const s of [{ kind: "NEVER" }, { kind: "ALWAYS" }, { kind: "STOP_AT", target: "RARE" }, { kind: "STOP_AT", target: "EPIC" }, { kind: "STOP_AT", target: "LEGENDARY" }] as const) {
        const p = populationAfter(odds, s, days);
        expect(RARITIES.reduce((sum, r) => sum + p[r], 0)).toBeCloseTo(1, 10);
        for (const r of RARITIES) expect(p[r]).toBeGreaterThanOrEqual(0);
      }
    }
    expect(populationAfter(odds, { kind: "NEVER" }, 365)).toEqual(odds);
    expect(populationAfter(odds, { kind: "ALWAYS" }, 365)).toEqual(odds);
    const day0 = populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 0); // day 0 = the starting hero
    for (const r of RARITIES) expect(day0[r]).toBeCloseTo(odds[r], 12);
    const day365 = populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 365);
    expect(day365.LEGENDARY).toBeGreaterThan(0.97);
    expect(day365.COMMON).toBeLessThan(0.02);
    const epic = populationAfter(odds, { kind: "STOP_AT", target: "EPIC" }, 365);
    expect(epic.EPIC).toBeCloseTo(0.875, 3);
    expect(epic.LEGENDARY).toBeCloseTo(0.125, 3);
  });

  it("mean PWR climbs with the ratchet (bands are fixed): ≈147 today → ≈198 if everyone farms Legendary for a year", () => {
    const means = { COMMON: 139.2, RARE: 159.3, EPIC: 179.1, LEGENDARY: 199.2 };
    expect(meanPower(odds, means)).toBeCloseTo(147.0, 0);
    expect(meanPower(populationAfter(odds, { kind: "STOP_AT", target: "LEGENDARY" }, 365), means)).toBeGreaterThan(197);
  });
});
