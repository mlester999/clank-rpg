import { describe, expect, it } from "vitest";

import { RARITIES } from "@/domain/character/appearance";
import { generateCharacter } from "@/domain/character/generate";
import { DEFAULT_CLASSES } from "@/domain/content";
import { LEGACY_HERO_GENERATOR_VERSION, HERO_GENERATOR_VERSION, versionStateFromGenerated, type HeroVersionState } from "@/domain/hero/heroVersion";
import { computeHeroPower } from "@/domain/hero/power";
import { isPowerInBand } from "@/domain/hero/rarity";
import { rebalanceHeroState } from "@/domain/hero/rebalance";
import { standingPosition } from "@/domain/hero/statBudget";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import type { BehaviorCounters } from "@/domain/telegram/types";

const neutral: BehaviorCounters = { msgs: 0, replies: 0, questions: 0, exclaims: 0, long: 0, links: 0, media: 0, night: 0, burst: 0, spam: 0 };
const SECRET = "rebalance-test-secret-0123456789";
const C = DEFAULT_SETTINGS.character;

/** A hero exactly as the FIRST generator made it (what the live database holds): hero-gen/1 stats, stat-weight POWER, no rarity layers. */
function legacyHero(id: number): { state: HeroVersionState; classId: string } {
  const g = generateCharacter({ telegramUserId: id, displayName: `Hero ${id}`, behavior: neutral, activityScore: (id % 10) * 10, classes: DEFAULT_CLASSES, settings: DEFAULT_SETTINGS, secret: SECRET, generatorVersion: LEGACY_HERO_GENERATOR_VERSION });
  const classDef = DEFAULT_CLASSES.find((c) => c.id === g.classId)!;
  return { state: versionStateFromGenerated(g, classDef, C, "clank-dev-v1"), classId: g.classId };
}

describe("SYSTEM REBALANCE of a hero made by the first generator", () => {
  it("THOUSANDS of heroes: every rebalanced hero lands inside ITS OWN rarity's band, keeps class / rarity / seed / identity, and is on the current generator", () => {
    const perRarity = new Map<string, { min: number; max: number }>();
    for (let id = 1; id <= 4000; id++) {
      const { state: previous, classId } = legacyHero(id);
      const classDef = DEFAULT_CLASSES.find((c) => c.id === classId)!;
      const next = rebalanceHeroState({ previous, classDef, settings: C });
      expect(next.generatorVersion).toBe(HERO_GENERATOR_VERSION);
      expect(next.classId).toBe(previous.classId); // class kept
      expect(next.rarity).toBe(previous.rarity); // rarity kept — a rebalance never re-rolls
      expect(next.generationSeed).toBe(previous.generationSeed);
      expect(next.appearanceSeed).toBe(previous.appearanceSeed);
      for (const k of ["skin", "hairStyle", "hairColor", "eyes", "mouth", "accessory", "cape", "aura", "outfitHue"] as const) expect(next.appearance[k], k).toBe(previous.appearance[k]);
      expect(isPowerInBand(next.rarity, next.power), `hero ${id}: ${next.rarity} ${next.power}`).toBe(true);
      expect(next.power).toBe(computeHeroPower(next.stats, next.classId)); // PWR is the new stats' own number
      expect(next.telegramBonus).toEqual({}); // from generator 2 on the whole generated offset lives in `variation`
      const e = perRarity.get(next.rarity) ?? { min: Infinity, max: 0 };
      perRarity.set(next.rarity, { min: Math.min(e.min, next.power), max: Math.max(e.max, next.power) });
    }
    expect([...perRarity.keys()].sort()).toEqual([...RARITIES].sort());
    const ordered = RARITIES.map((r) => perRarity.get(r)!);
    for (let i = 1; i < ordered.length; i++) expect(ordered[i - 1]!.max).toBeLessThan(ordered[i]!.min);
  });

  it("is DETERMINISTIC: the same legacy version always yields the byte-identical rebalanced version (here, in a scratch copy, or live)", () => {
    for (let id = 1; id <= 500; id++) {
      const { state: previous, classId } = legacyHero(id);
      const classDef = DEFAULT_CLASSES.find((c) => c.id === classId)!;
      const a = rebalanceHeroState({ previous, classDef, settings: C });
      const b = rebalanceHeroState({ previous: JSON.parse(JSON.stringify(previous)), classDef, settings: C });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it("adds the rarity layers by the same rule new heroes use, keeps everything the hero already wore, and Common gets none", () => {
    let layered = 0;
    for (let id = 1; id <= 1500; id++) {
      const { state: previous, classId } = legacyHero(id);
      const classDef = DEFAULT_CLASSES.find((c) => c.id === classId)!;
      const next = rebalanceHeroState({ previous, classDef, settings: C });
      const slots = next.sprite!.slots;
      const extra = [slots.trim, slots.shoulder, slots.crest, slots.weaponfx].filter(Boolean);
      if (previous.rarity === "COMMON") expect(extra).toEqual([]);
      else {
        expect(extra.length, `${previous.rarity} hero ${id}`).toBeGreaterThanOrEqual(2);
        layered++;
      }
      for (const [slot, item] of Object.entries(previous.sprite!.slots)) if (!["trim", "shoulder", "crest", "weaponfx"].includes(slot)) expect(slots[slot as keyof typeof slots], slot).toBe(item);
      // class identity: the class kit (weapon / outfit / headgear) is untouched
      expect(slots.weapon).toBe(previous.sprite!.slots.weapon);
      expect(slots.outfit).toBe(previous.sprite!.slots.outfit);
    }
    expect(layered).toBeGreaterThan(100);
  });

  it("a hero keeps its STANDING among class peers: a stronger legacy hero never lands lower in its band than a weaker one of the same class and rarity", () => {
    expect(standingPosition(140, 140, 0.5)).toBeLessThan(standingPosition(150, 140, 0.5));
    expect(standingPosition(130, 140, 0.0)).toBeLessThan(standingPosition(158, 140, 0.0));
    for (const u of [0, 0.3, 0.7, 1]) {
      let previous = -1;
      for (let delta = -10; delta <= 25; delta += 1) {
        const p = standingPosition(140 + delta, 140, u);
        expect(p).toBeGreaterThanOrEqual(previous);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(1);
        previous = p;
      }
    }
  });

  it("refuses a hero that is already on the current generator, or a class mismatch — it never runs twice or on the wrong class", () => {
    const { state, classId } = legacyHero(7);
    const classDef = DEFAULT_CLASSES.find((c) => c.id === classId)!;
    const once = rebalanceHeroState({ previous: state, classDef, settings: C });
    expect(() => rebalanceHeroState({ previous: once, classDef, settings: C })).toThrow(/already on the rarity power system/);
    const other = DEFAULT_CLASSES.find((c) => c.id !== classId)!;
    expect(() => rebalanceHeroState({ previous: state, classDef: other, settings: C })).toThrow(/does not match/);
  });

  it("the historical version object is never mutated", () => {
    const { state, classId } = legacyHero(11);
    const frozen = JSON.stringify(state);
    rebalanceHeroState({ previous: state, classDef: DEFAULT_CLASSES.find((c) => c.id === classId)!, settings: C });
    expect(JSON.stringify(state)).toBe(frozen);
  });
});
