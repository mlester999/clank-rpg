import { describe, expect, it } from "vitest";

import { classProbabilities, rollClass } from "@/domain/character/classRoll";
import { generateCharacter } from "@/domain/character/generate";
import { sanitizeDisplayName } from "@/domain/character/identity";
import { computeEffectiveStats, computePower, rollVariation, telegramStatBonus, walletPowerShare } from "@/domain/character/stats";
import { rollRarity, RARITIES } from "@/domain/character/appearance";
import { DEFAULT_CLASSES } from "@/domain/content";
import { computeHeroPower } from "@/domain/hero/power";
import { isPowerInBand } from "@/domain/hero/rarity";
import { STAT_KEYS, sumStats, zeroStats } from "@/domain/stats";
import type { BehaviorCounters } from "@/domain/telegram/types";
import { createRng } from "@/domain/util/rng";
import { computeHoldingScore, holdingStatBonus } from "@/domain/holdings/holdingPower";
import { telegramBonusPoints } from "@/domain/telegram/activity";

import { classIds, ruleset, settings } from "../support/fixtures";

const C = settings.character;
const neutral: BehaviorCounters = { msgs: 0, replies: 0, questions: 0, exclaims: 0, long: 0, links: 0, media: 0, night: 0, burst: 0, spam: 0 };

describe("class assignment", () => {
  it("is uniform for members with no behaviour profile", () => {
    const probs = classProbabilities(DEFAULT_CLASSES, neutral, C);
    for (const p of probs) expect(p.probability).toBeCloseTo(1 / DEFAULT_CLASSES.length, 10);
  });

  it("probabilities always sum to 1", () => {
    const loud: BehaviorCounters = { ...neutral, msgs: 400, exclaims: 300, burst: 200, long: 0 };
    const sum = classProbabilities(DEFAULT_CLASSES, loud, C).reduce((a, p) => a + p.probability, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("behaviour only NUDGES: no class can be guaranteed, none is ever excluded", () => {
    const n = DEFAULT_CLASSES.length;
    const maxBound = (1 - C.classInfluence) / n + C.classInfluence;
    const minBound = (1 - C.classInfluence) / n;
    const profiles: BehaviorCounters[] = DEFAULT_CLASSES.flatMap((_, i) => {
      // Extreme profiles: every ratio pinned to one end, tried for several shapes.
      const hi = (k: keyof BehaviorCounters) => ({ ...neutral, msgs: 1000, [k]: 1000 }) as BehaviorCounters;
      return [hi("exclaims"), hi("replies"), hi("long"), hi("night"), hi("links"), hi("media"), hi("questions"), hi("burst")].slice(i, i + 1);
    });
    profiles.push({ ...neutral, msgs: 1000, exclaims: 1000, burst: 1000 }, { ...neutral, msgs: 1000, night: 1000, replies: 0 });
    for (const profile of profiles) {
      for (const p of classProbabilities(DEFAULT_CLASSES, profile, C)) {
        expect(p.probability).toBeLessThanOrEqual(maxBound + 1e-12);
        expect(p.probability).toBeGreaterThanOrEqual(minBound - 1e-12);
      }
    }
    expect(maxBound).toBeLessThan(0.33);
  });

  it("the roll for a given hero is deterministic given the seed", () => {
    const a = rollClass(DEFAULT_CLASSES, neutral, C, createRng("hero-x").fork("class"));
    const b = rollClass(DEFAULT_CLASSES, neutral, C, createRng("hero-x").fork("class"));
    expect(a.id).toBe(b.id);
  });

  it("empirical distribution matches the computed probabilities", () => {
    const loud: BehaviorCounters = { ...neutral, msgs: 500, exclaims: 400, burst: 300 };
    const probs = classProbabilities(DEFAULT_CLASSES, loud, C);
    const counts = new Map<string, number>();
    const N = 12_000;
    for (let i = 0; i < N; i++) {
      const c = rollClass(DEFAULT_CLASSES, loud, C, createRng(`emp-${i}`));
      counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
    }
    for (const p of probs) expect((counts.get(p.classId) ?? 0) / N).toBeGreaterThan(p.probability - 0.02);
    for (const p of probs) expect((counts.get(p.classId) ?? 0) / N).toBeLessThan(p.probability + 0.02);
  });

  it("the class system is data-driven: a newly added class is rolled and statted with no code change", () => {
    const extra = { ...DEFAULT_CLASSES[0]!, id: "bard", name: "Bard", affinity: {} };
    const classes = [...DEFAULT_CLASSES, extra];
    const probs = classProbabilities(classes, neutral, C);
    expect(probs).toHaveLength(7);
    expect(probs.find((p) => p.classId === "bard")!.probability).toBeCloseTo(1 / 7, 10);
  });
});

describe("hero generation", () => {
  const input = (id: number, over = {}) => ({
    telegramUserId: id, displayName: "Ada Lovelace", behavior: neutral, activityScore: 40, classes: DEFAULT_CLASSES, settings, secret: "test-secret-value-123456", ...over,
  });

  it("is idempotent per Telegram id and secret", () => {
    expect(generateCharacter(input(42))).toEqual(generateCharacter(input(42)));
  });
  it("differs between members and between secrets", () => {
    expect(generateCharacter(input(42))).not.toEqual(generateCharacter(input(43)));
    expect(generateCharacter(input(42)).appearanceSeed).not.toBe(generateCharacter(input(42, { secret: "another-secret-value-9999" })).appearanceSeed);
  });
  it("covers every class over many members (mostly random)", () => {
    const seen = new Set<string>();
    for (let id = 1; id <= 400; id++) seen.add(generateCharacter(input(id)).classId);
    expect([...seen].sort()).toEqual([...classIds].sort());
  });
});

describe("stat generation is bounded", () => {
  it("random variation is small and net-bounded over 20k rolls", () => {
    const v = C.variation;
    for (let i = 0; i < 20_000; i++) {
      const roll = rollVariation(createRng(`v-${i}`), C);
      for (const k of STAT_KEYS) expect(Math.abs(roll[k])).toBeLessThanOrEqual(k === "hp" ? v.hp : v.stat);
      expect(Math.abs(sumStats(roll, ["hp"]))).toBeLessThanOrEqual(v.maxNetShift);
      const powerShift = STAT_KEYS.reduce((sum, k) => sum + roll[k] * C.power[k], 0);
      expect(Math.abs(powerShift)).toBeLessThanOrEqual(v.maxPowerShift);
    }
  });

  it("a lucky creation roll never makes a hero dramatically stronger than an equivalent one", () => {
    for (const cls of DEFAULT_CLASSES) {
      const powers: number[] = [];
      for (let i = 0; i < 4000; i++) {
        const stats = computeEffectiveStats({ classDef: cls, variation: rollVariation(createRng(`p-${cls.id}-${i}`), C), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
        powers.push(computePower(stats.total, C));
      }
      const min = Math.min(...powers);
      const max = Math.max(...powers);
      expect(max / min).toBeLessThan(1.09);
    }
  });

  it("class baselines have comparable summary power", () => {
    const powers = DEFAULT_CLASSES.map((cls) => computePower(computeEffectiveStats({ classDef: cls, variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() }).total, C));
    expect(Math.max(...powers) / Math.min(...powers)).toBeLessThan(1.25);
  });

  it("rarity is a STRENGTH tier: the same member under a higher rarity keeps its class and gets a higher PWR inside that rarity's band", () => {
    const rolled = (rarity: (typeof RARITIES)[number]) => generateCharacter({
      telegramUserId: 7, displayName: "x", behavior: neutral, activityScore: 50, classes: DEFAULT_CLASSES, secret: "s".repeat(24),
      settings: { ...settings, character: { ...settings.character, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0, [rarity]: 1 } } },
    });
    const byRarity = RARITIES.map(rolled);
    expect(byRarity.map((g) => g.rarity)).toEqual([...RARITIES]);
    expect(new Set(byRarity.map((g) => g.classId)).size).toBe(1); // class comes from its own stream — rarity never changes it
    byRarity.forEach((g, i) => {
      expect(isPowerInBand(RARITIES[i]!, g.power)).toBe(true);
      expect(g.power).toBe(computeHeroPower(g.stats, g.classId)); // PWR is the stats' own number, never a separate figure
      if (i > 0) expect(g.power).toBeGreaterThan(byRarity[i - 1]!.power);
    });
  });

  it("(legacy) the first generator still treats rarity as a look only — its versions stay reproducible", () => {
    const a = generateCharacter({ telegramUserId: 7, displayName: "x", behavior: neutral, activityScore: 50, classes: DEFAULT_CLASSES, settings, secret: "s".repeat(24), generatorVersion: "hero-gen/1" });
    const forced = generateCharacter({ telegramUserId: 7, displayName: "x", behavior: neutral, activityScore: 50, classes: DEFAULT_CLASSES, generatorVersion: "hero-gen/1", settings: { ...settings, character: { ...settings.character, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 1 } } }, secret: "s".repeat(24) });
    expect(forced.rarity).toBe("LEGENDARY");
    expect(forced.classId).toBe(a.classId);
    expect(forced.variation).toEqual(a.variation);
    expect(forced.telegramBonus).toEqual(a.telegramBonus);
  });

  it("rarity frequencies follow the configured weights", () => {
    const counts = Object.fromEntries(RARITIES.map((r) => [r, 0])) as Record<string, number>;
    for (let i = 0; i < 20_000; i++) counts[rollRarity(createRng(`r-${i}`), C.rarityWeights)]!++;
    expect(counts.COMMON! / 20_000).toBeGreaterThan(0.66);
    expect(counts.LEGENDARY! / 20_000).toBeLessThan(0.02);
    expect(counts.LEGENDARY!).toBeGreaterThan(0);
  });

  it("telegram influence is subtle and bounded", () => {
    expect(telegramBonusPoints(0, C)).toBe(0);
    expect(telegramBonusPoints(100, C)).toBe(C.telegramBonus.maxPoints);
    const cls = ruleset.classes.warrior!;
    const max = telegramStatBonus(C.telegramBonus.maxPoints, cls, C);
    const base = computeEffectiveStats({ classDef: cls, variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
    const boosted = computeEffectiveStats({ classDef: cls, variation: zeroStats(), telegram: max, holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
    expect(computePower(boosted.total, C) / computePower(base.total, C)).toBeLessThan(1.1);
  });
});

describe("POWER is a summary, not the combat system", () => {
  it("is a weighted sum of stats", () => {
    const stats = { hp: 100, str: 10, def: 10, int: 10, agi: 10, cha: 10, luck: 10 };
    expect(computePower(stats, C)).toBe(Math.round(100 * 0.4 + 10 * 2 * 4 + 10 * 1 * 2));
  });
  it("there is no permanent level or XP: the class baseline is the whole base, whatever level/XP/growth a caller smuggles in", () => {
    const zero = { variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() };
    for (const cls of DEFAULT_CLASSES) {
      const clean = computeEffectiveStats({ classDef: cls, ...zero });
      expect(clean.breakdown.base).toEqual(cls.base);
      // Retired inputs (an old caller's level / XP, an old class row's growth table) must be inert.
      const growth = { hp: 9, str: 9, def: 9, int: 9, agi: 9, cha: 9, luck: 9 };
      for (const level of [1, 5, 30, 500]) {
        const tainted = computeEffectiveStats({ classDef: { ...cls, growth }, ...zero, level, xp: 123_456 } as never);
        expect(tainted.total).toEqual(clean.total);
        expect(computePower(tainted.total, C)).toBe(computePower(clean.total, C));
      }
    }
  });
  it("special characters use admin-authored fixed stats", () => {
    const fixed = { hp: 300, str: 40, def: 40, int: 40, agi: 40, cha: 40, luck: 40 };
    const stats = computeEffectiveStats({ classDef: ruleset.classes.mage!, variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats(), fixed });
    expect(stats.total).toEqual(fixed);
  });
});

describe("wallet power stays one bounded component of total strength", () => {
  it("even a maximal whale adds a limited share of total power", () => {
    for (const cls of DEFAULT_CLASSES) {
      const whale = holdingStatBonus(computeHoldingScore([1, 2, 3, 4, 5, 6].map((n) => ({ tokenId: `t${n}`, supplyFraction: 0.2, valueQuote: 500 })), settings.holdings).score, cls, settings.holdings);
      const share = walletPowerShare(
        { classDef: cls, variation: zeroStats(), telegram: zeroStats(), holdings: whale, loyalty: zeroStats(), trading: zeroStats() },
        C,
      );
      expect(share.fraction).toBeLessThan(0.2);
    }
  });
});

describe("display-name sanitising", () => {
  it("strips bidi/invisible characters and markup, caps length, and provides a fallback", () => {
    expect(sanitizeDisplayName("  Ada‮ Lovelace​  ", 24, 1)).toBe("Ada Lovelace");
    expect(sanitizeDisplayName("<script>alert(1)</script>", 40, 1)).toBe("scriptalert(1)/script");
    expect(Array.from(sanitizeDisplayName("x".repeat(100), 24, 1))).toHaveLength(24);
    expect(sanitizeDisplayName("​​", 24, 123456)).toBe("Wanderer 3456");
    expect(sanitizeDisplayName("🔥🔥🔥", 24, 99)).toBe("Wanderer 0099");
  });
});
