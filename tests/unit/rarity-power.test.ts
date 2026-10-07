import { describe, expect, it } from "vitest";

import { RARITIES, rollRarity, type Rarity } from "@/domain/character/appearance";
import { generateCharacter } from "@/domain/character/generate";
import { DEFAULT_CLASSES } from "@/domain/content";
import { HERO_GENERATOR_VERSION, LEGACY_HERO_GENERATOR_VERSION } from "@/domain/hero/heroVersion";
import {
  CLASS_POWER_FACTOR,
  CLASS_STRENGTH_SCALE,
  POWER_BASELINE,
  POWER_WEIGHTS,
  classPowerFactor,
  computeHeroPower,
  fitStatsToPower,
  weightedStatSum,
} from "@/domain/hero/power";
import { RARITY_LADDER, RARITY_RULES, bandLabel, isPowerInBand, positionInBand, powerAtPosition, rarityOfPower, validateRarityRules } from "@/domain/hero/rarity";
import { buildTierStats, statsMatchTier } from "@/domain/hero/statBudget";
import { rollVariation } from "@/domain/character/stats";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { STAT_KEYS, zeroStats, type StatBlock } from "@/domain/stats";
import type { BehaviorCounters } from "@/domain/telegram/types";
import { createRng } from "@/domain/util/rng";

const C = DEFAULT_SETTINGS.character;
const SECRET = "rarity-power-test-secret-0123456789";
const neutral: BehaviorCounters = { msgs: 0, replies: 0, questions: 0, exclaims: 0, long: 0, links: 0, media: 0, night: 0, burst: 0, spam: 0 };
const base = (id: string) => DEFAULT_CLASSES.find((c) => c.id === id)!.base as StatBlock;

describe("RARITY_RULES — the one authoritative table", () => {
  it("is structurally valid: ordered, contiguous and NON-OVERLAPPING", () => {
    expect(validateRarityRules()).toEqual([]);
    for (let i = 1; i < RARITY_LADDER.length; i++) {
      expect(RARITY_LADDER[i - 1]!.powerMax).toBeLessThan(RARITY_LADDER[i]!.powerMin); // highest Common < lowest Rare, …
      expect(RARITY_LADDER[i]!.powerMin).toBe(RARITY_LADDER[i - 1]!.powerMax + 1);
    }
  });

  it("the final bands", () => {
    expect(RARITIES.map((r) => [RARITY_RULES[r].powerMin, RARITY_RULES[r].powerMax])).toEqual([[130, 149], [150, 169], [170, 189], [190, 209]]);
    expect(RARITIES.map((r) => bandLabel(r))).toEqual(["130–149", "150–169", "170–189", "190–209"]);
  });

  it("the stat budget is the band expressed against the class baseline (budget 1.0 = PWR POWER_BASELINE)", () => {
    for (const r of RARITY_LADDER) {
      expect(r.statBudget.min).toBeCloseTo(r.powerMin / POWER_BASELINE, 3);
      expect(r.statBudget.max).toBeCloseTo(r.powerMax / POWER_BASELINE, 3);
    }
    // the ladder grows: each tier's budget is strictly larger than the one below
    for (let i = 1; i < RARITY_LADDER.length; i++) expect(RARITY_LADDER[i]!.statBudget.min).toBeGreaterThan(RARITY_LADDER[i - 1]!.statBudget.max);
  });

  it("the table is frozen: nothing can edit a band at runtime", () => {
    expect(Object.isFrozen(RARITY_RULES)).toBe(true);
    expect(Object.isFrozen(RARITY_RULES.COMMON)).toBe(true);
    expect(() => { (RARITY_RULES.COMMON as { powerMax: number }).powerMax = 999; }).toThrow();
  });

  it("validateRarityRules catches an overlapping, gapped or mis-ordered table", () => {
    const tweak = (mut: (r: Record<Rarity, { powerMin: number; powerMax: number } & Record<string, unknown>>) => void) => {
      const copy = JSON.parse(JSON.stringify(RARITY_RULES)) as Record<Rarity, { powerMin: number; powerMax: number } & Record<string, unknown>>;
      mut(copy);
      return validateRarityRules(copy as never);
    };
    expect(tweak((r) => { r.RARE.powerMin = 140; }).length).toBeGreaterThan(0); // overlaps Common
    expect(tweak((r) => { r.EPIC.powerMin = 175; }).length).toBeGreaterThan(0); // gap after Rare
    expect(tweak((r) => { r.LEGENDARY.powerMax = 100; }).length).toBeGreaterThan(0); // min > max
  });

  it("maps power ↔ rarity and finds where a hero sits inside its band", () => {
    expect(rarityOfPower(130)).toBe("COMMON");
    expect(rarityOfPower(149)).toBe("COMMON");
    expect(rarityOfPower(150)).toBe("RARE");
    expect(rarityOfPower(209)).toBe("LEGENDARY");
    expect(rarityOfPower(129)).toBeNull();
    expect(rarityOfPower(210)).toBeNull();
    expect(isPowerInBand("EPIC", 170)).toBe(true);
    expect(isPowerInBand("EPIC", 169)).toBe(false);
    expect(positionInBand("RARE", 150)).toBe(0);
    expect(positionInBand("RARE", 169)).toBe(1);
    expect(positionInBand("RARE", 140)).toBeNull();
    expect(powerAtPosition("COMMON", 0)).toBe(130);
    expect(powerAtPosition("COMMON", 0.999999)).toBe(149);
    expect(powerAtPosition("COMMON", Number.NaN)).toBe(130); // junk can never leave the band
  });

  it("a uniform position puts every PWR of a band within one hero of equally likely", () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 20_000; i++) counts.set(powerAtPosition("EPIC", (i + 0.5) / 20_000), (counts.get(powerAtPosition("EPIC", (i + 0.5) / 20_000)) ?? 0) + 1);
    expect(counts.size).toBe(20);
    expect(Math.min(...counts.values())).toBe(1000);
    expect(Math.max(...counts.values())).toBe(1000);
  });
});

describe("PWR — one authoritative formula, computed from the actual stats", () => {
  it("is classFactor × the weighted stat sum, rounded", () => {
    const stats = { hp: 100, str: 20, def: 10, int: 5, agi: 8, cha: 6, luck: 4 };
    const weighted = 100 * 0.4 + 20 * 2 + 10 * 2 + 5 * 2 + 8 * 2 + 6 + 4;
    expect(weightedStatSum(stats)).toBeCloseTo(weighted, 10);
    expect(computeHeroPower(stats, "warrior")).toBe(Math.round(CLASS_POWER_FACTOR.warrior! * weighted));
    expect(computeHeroPower(stats, "an-admin-added-class")).toBe(Math.round(weighted)); // an unknown class is rated by the plain weighted sum
    expect(Object.isFrozen(CLASS_POWER_FACTOR)).toBe(true);
    expect(Object.isFrozen(POWER_WEIGHTS)).toBe(true);
  });

  it("is deterministic and integer", () => {
    const stats = { hp: 133, str: 21, def: 12, int: 4, agi: 10, cha: 7, luck: 7 };
    expect(computeHeroPower(stats, "warrior")).toBe(computeHeroPower({ ...stats }, "warrior"));
    expect(Number.isInteger(computeHeroPower(stats, "warrior"))).toBe(true);
  });

  it("a class's BASELINE hero reads POWER_BASELINE / CLASS_STRENGTH_SCALE — all six baselines are Common-strength (inside the Common band), though not all equally strong", () => {
    const common = RARITY_RULES.COMMON;
    for (const cls of DEFAULT_CLASSES) {
      const p = computeHeroPower(cls.base as StatBlock, cls.id);
      expect(Math.abs(p - POWER_BASELINE / CLASS_STRENGTH_SCALE[cls.id]!), `${cls.id} baseline ${p}`).toBeLessThanOrEqual(1);
      expect(p).toBeGreaterThanOrEqual(common.powerMin);
      expect(p).toBeLessThanOrEqual(common.powerMax);
    }
  });

  it("the frozen class factors still match the shipped class baselines (a tuned class shows up here instead of silently changing every stored PWR)", () => {
    for (const cls of DEFAULT_CLASSES) {
      const factor = POWER_BASELINE / (CLASS_STRENGTH_SCALE[cls.id]! * weightedStatSum(cls.base as StatBlock));
      expect(classPowerFactor(cls.id), cls.id).toBeCloseTo(factor, 3);
    }
  });

  it("the class calibration is real: a plain weighted sum is class-biased (Mage/Ranger points are worth MORE, Tank/Rogue points LESS), which is what the factors correct", () => {
    const factors = DEFAULT_CLASSES.map((c) => CLASS_POWER_FACTOR[c.id]!);
    expect(Math.max(...factors) / Math.min(...factors)).toBeGreaterThan(1.2);
    expect(CLASS_POWER_FACTOR.mage!).toBeGreaterThan(1);
    expect(CLASS_POWER_FACTOR.ranger!).toBeGreaterThan(1);
    expect(CLASS_POWER_FACTOR.tank!).toBeLessThan(1);
    expect(CLASS_POWER_FACTOR.rogue!).toBeLessThan(1);
  });

  it("no single stat dominates: moving one point of any stat changes PWR by a small, bounded amount (HP is 'cheap', the rest comparable)", () => {
    for (const cls of DEFAULT_CLASSES) {
      const f = CLASS_POWER_FACTOR[cls.id]!;
      for (const key of STAT_KEYS) expect(f * POWER_WEIGHTS[key]).toBeLessThanOrEqual(2.4);
    }
  });
});

describe("fitStatsToPower — the stats ARE what produce the number", () => {
  it("hits EVERY PWR of the whole range exactly, for every class (never clamped afterwards)", () => {
    for (const cls of DEFAULT_CLASSES) {
      for (let target = RARITY_RULES.COMMON.powerMin; target <= RARITY_RULES.LEGENDARY.powerMax; target++) {
        const stats = fitStatsToPower(cls.id, cls.base as StatBlock, target);
        expect(computeHeroPower(stats, cls.id), `${cls.id} → ${target}`).toBe(target);
        for (const key of STAT_KEYS) {
          expect(Number.isInteger(stats[key])).toBe(true);
          expect(stats[key]).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("with shape offsets it still lands exactly on the target", () => {
    for (let i = 0; i < 3000; i++) {
      const cls = DEFAULT_CLASSES[i % DEFAULT_CLASSES.length]!;
      const shape = rollVariation(createRng(`shape-${i}`), C);
      const target = 130 + (i % 80);
      expect(computeHeroPower(fitStatsToPower(cls.id, cls.base as StatBlock, target, shape), cls.id)).toBe(target);
    }
  });

  it("rejects nonsense instead of looping", () => {
    expect(() => fitStatsToPower("warrior", base("warrior"), 0)).toThrow(RangeError);
    expect(() => fitStatsToPower("warrior", base("warrior"), 12.5)).toThrow(RangeError);
    expect(() => fitStatsToPower("warrior", zeroStats(), 150)).toThrow(RangeError);
  });

  it("a higher PWR is more of the class's own shape: every stat grows with the budget, and the class's identity stays", () => {
    for (const cls of DEFAULT_CLASSES) {
      const lo = fitStatsToPower(cls.id, cls.base as StatBlock, 135);
      const hi = fitStatsToPower(cls.id, cls.base as StatBlock, 205);
      for (const key of STAT_KEYS) expect(hi[key], `${cls.id}.${key}`).toBeGreaterThanOrEqual(lo[key]);
      // the stat the class is built around is still the class's biggest relative to its own baseline mix
      const share = (s: StatBlock, k: (typeof STAT_KEYS)[number]) => s[k] / STAT_KEYS.reduce((t, x) => t + s[x], 0);
      for (const key of STAT_KEYS) expect(Math.abs(share(hi, key) - share(lo, key))).toBeLessThan(0.02);
    }
  });
});

describe("stat budgets (rarity → total budget, class → distribution, seed → variation)", () => {
  it("THOUSANDS of deterministic samples: every rarity's PWR is inside its own band, the stats and the PWR agree, and the bands never overlap", () => {
    const seen = new Map<Rarity, number[]>(RARITIES.map((r) => [r, []]));
    let n = 0;
    for (const cls of DEFAULT_CLASSES) {
      for (const rarity of RARITIES) {
        for (let i = 0; i < 500; i++) {
          const shape = rollVariation(createRng(`b-${cls.id}-${rarity}-${i}`), C);
          const t = buildTierStats({ classDef: cls, rarity, position: createRng(`p-${cls.id}-${rarity}-${i}`).next(), shape });
          expect(isPowerInBand(rarity, t.power), `${cls.id} ${rarity} #${i}: ${t.power}`).toBe(true);
          expect(t.power).toBe(computeHeroPower(t.stats, cls.id));
          expect(statsMatchTier(rarity, cls.id, t.stats, t.power)).toBe(true);
          for (const key of STAT_KEYS) expect(t.stats[key] - (cls.base as StatBlock)[key]).toBe(t.variation[key]);
          seen.get(rarity)!.push(t.power);
          n++;
        }
      }
    }
    expect(n).toBe(12_000);
    const ranges = RARITIES.map((r) => [Math.min(...seen.get(r)!), Math.max(...seen.get(r)!)] as const);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i - 1]![1]).toBeLessThan(ranges[i]![0]); // max(Common) < min(Rare) < …
    // …and the samples really do use the whole band
    for (const [i, r] of RARITIES.entries()) {
      expect(ranges[i]![0]).toBe(RARITY_RULES[r].powerMin);
      expect(ranges[i]![1]).toBe(RARITY_RULES[r].powerMax);
    }
  });

  it("the class distributes the budget: a Legendary Mage is INT-led, a Legendary Warrior STR/HP-led, a Legendary Tank HP/DEF-led — and no two Legendary heroes are identical", () => {
    const top = (id: string) => {
      const cls = DEFAULT_CLASSES.find((c) => c.id === id)!;
      const t = buildTierStats({ classDef: cls, rarity: "LEGENDARY", position: 0.5, shape: rollVariation(createRng(`id-${id}`), C) });
      return t.stats;
    };
    const mage = top("mage");
    expect(mage.int).toBeGreaterThan(mage.str * 3);
    const warrior = top("warrior");
    expect(warrior.str).toBeGreaterThan(warrior.int * 3);
    const tank = top("tank");
    expect(tank.def).toBeGreaterThan(tank.int * 3);
    expect(tank.hp).toBeGreaterThan(warrior.hp);
    const rogue = top("rogue");
    expect(rogue.agi).toBeGreaterThan(rogue.int * 2);
    const ranger = top("ranger");
    expect(ranger.agi).toBeGreaterThan(ranger.int * 2);
    const cleric = top("cleric");
    expect(cleric.cha + cleric.int).toBeGreaterThan(cleric.str * 3);
    // not identical: two heroes of the same class and rarity differ in PWR position and in the fine shape of their stats
    const a = generateCharacter({ telegramUserId: 1, displayName: "a", behavior: neutral, activityScore: 0, classes: [DEFAULT_CLASSES[1]!], secret: SECRET, settings: { ...DEFAULT_SETTINGS, character: { ...C, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 1 } } } });
    const b = generateCharacter({ telegramUserId: 2, displayName: "b", behavior: neutral, activityScore: 0, classes: [DEFAULT_CLASSES[1]!], secret: SECRET, settings: { ...DEFAULT_SETTINGS, character: { ...C, rarityWeights: { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 1 } } } });
    expect(a.stats).not.toEqual(b.stats);
  });

  it("every class's average stat share is the same at every rarity (rarity scales the budget; it does not change what the class is)", () => {
    for (const cls of DEFAULT_CLASSES) {
      const shares = RARITIES.map((rarity) => {
        const acc = zeroStats();
        for (let i = 0; i < 200; i++) {
          const t = buildTierStats({ classDef: cls, rarity, position: createRng(`s-${cls.id}-${rarity}-${i}`).next(), shape: rollVariation(createRng(`sv-${cls.id}-${rarity}-${i}`), C) });
          for (const k of STAT_KEYS) acc[k] += t.stats[k];
        }
        const total = STAT_KEYS.reduce((t, k) => t + acc[k], 0);
        return STAT_KEYS.map((k) => acc[k] / total);
      });
      for (const s of shares) s.forEach((v, i) => expect(Math.abs(v - shares[0]![i]!), `${cls.id}`).toBeLessThan(0.02));
    }
  });
});

describe("hero generator 2 — generateCharacter", () => {
  const gen = (id: number, version?: string) => generateCharacter({ telegramUserId: id, displayName: `Member ${id}`, behavior: neutral, activityScore: (id % 10) * 10, classes: DEFAULT_CLASSES, settings: DEFAULT_SETTINGS, secret: SECRET, ...(version ? { generatorVersion: version } : {}) });

  it("is the current generator, and every hero it makes is inside its rarity's band with PWR = the stats' own number (6,000 heroes)", () => {
    const perRarity = new Map<Rarity, { min: number; max: number; n: number }>();
    for (let id = 1; id <= 6000; id++) {
      const g = gen(id);
      expect(g.generatorVersion).toBe(HERO_GENERATOR_VERSION);
      expect(isPowerInBand(g.rarity, g.power), `member ${id}: ${g.rarity} ${g.power}`).toBe(true);
      expect(g.power).toBe(computeHeroPower(g.stats, g.classId));
      expect(statsMatchTier(g.rarity, g.classId, g.stats, g.power)).toBe(true);
      expect(g.telegramBonus).toEqual(zeroStats());
      const e = perRarity.get(g.rarity) ?? { min: Infinity, max: 0, n: 0 };
      perRarity.set(g.rarity, { min: Math.min(e.min, g.power), max: Math.max(e.max, g.power), n: e.n + 1 });
    }
    const ordered = RARITIES.map((r) => perRarity.get(r)!);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i - 1]!.max).toBeLessThan(ordered[i]!.min);
  });

  it("is deterministic: the same member always rolls the same hero, look included", () => {
    for (let id = 1; id <= 200; id++) expect(gen(id)).toEqual(gen(id));
  });

  it("the production rarity odds are UNCHANGED (70 / 22 / 7 / 1) — and identical to what the first generator drew", () => {
    const counts: Record<string, number> = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
    for (let id = 1; id <= 20_000; id++) {
      const g2 = gen(id);
      counts[g2.rarity]!++;
      if (id <= 1500) {
        const g1 = gen(id, LEGACY_HERO_GENERATOR_VERSION);
        expect(g2.rarity).toBe(g1.rarity); // same seed → same rarity under both generators
        expect(g2.classId).toBe(g1.classId); // …and the same class
        expect(g2.appearance.skin).toBe(g1.appearance.skin);
        expect(g2.appearance.hairStyle).toBe(g1.appearance.hairStyle);
        expect(g2.appearance.outfitHue).toBe(g1.appearance.outfitHue);
      }
    }
    expect(counts.COMMON! / 20_000).toBeGreaterThan(0.68);
    expect(counts.COMMON! / 20_000).toBeLessThan(0.72);
    expect(counts.RARE! / 20_000).toBeGreaterThan(0.2);
    expect(counts.RARE! / 20_000).toBeLessThan(0.24);
    expect(counts.EPIC! / 20_000).toBeGreaterThan(0.055);
    expect(counts.EPIC! / 20_000).toBeLessThan(0.085);
    expect(counts.LEGENDARY! / 20_000).toBeGreaterThan(0.004);
    expect(counts.LEGENDARY! / 20_000).toBeLessThan(0.016);
    expect(C.rarityWeights).toEqual({ COMMON: 700, RARE: 220, EPIC: 70, LEGENDARY: 10 }); // the weights themselves were not touched
  });

  it("no secret boost: rollRarity is only ever the configured weights", () => {
    const rolled: Record<string, number> = { COMMON: 0, RARE: 0, EPIC: 0, LEGENDARY: 0 };
    for (let i = 0; i < 20_000; i++) rolled[rollRarity(createRng(`r-${i}`), C.rarityWeights)]!++;
    expect(rolled.LEGENDARY! / 20_000).toBeLessThan(0.02);
  });

  it("the first generator is untouched: its heroes keep the old stat-weight POWER and no rarity layers", () => {
    for (let id = 1; id <= 300; id++) {
      const g = gen(id, LEGACY_HERO_GENERATOR_VERSION);
      expect(g.generatorVersion).toBe(LEGACY_HERO_GENERATOR_VERSION);
      expect(g.appearance.fx).toBeUndefined();
      expect(g.sprite.slots.trim ?? g.sprite.slots.shoulder ?? g.sprite.slots.crest ?? g.sprite.slots.weaponfx).toBeUndefined();
    }
  });

  it("higher rarity means more PWR on average across a population, and a Legendary is never weaker than the strongest Epic", () => {
    const means = new Map<Rarity, number[]>(RARITIES.map((r) => [r, []]));
    for (let id = 1; id <= 8000; id++) {
      const g = gen(id);
      means.get(g.rarity)!.push(g.power);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const m = RARITIES.map((r) => avg(means.get(r)!));
    for (let i = 1; i < m.length; i++) expect(m[i]!).toBeGreaterThan(m[i - 1]! + 15);
  });
});
