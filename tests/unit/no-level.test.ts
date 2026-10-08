import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { computeEffectiveStats, computePower, rollVariation } from "@/domain/character/stats";
import { buildDefaultRuleset, DEFAULT_CLASSES } from "@/domain/content";
import { simulateBattle } from "@/domain/combat/engine";
import type { CombatUnitInput } from "@/domain/combat/types";
import { COMBAT_RULES_VERSION, validateRuleset } from "@/domain/rules";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { zeroStats } from "@/domain/stats";
import { createRng } from "@/domain/util/rng";

import { legacyRingRuleset } from "../support/legacyRing";
import { rules200Ruleset, rules200Stored } from "../support/rules200";
import { rules300Ruleset, rules300Stored } from "../support/rules300";

/**
 * Permanent XP and character levels were REMOVED from Clank RPG (a hero's strength must never depend on how
 * long it has idled in the Arena, or members who qualify later would be permanently behind).
 * These tests pin that: combat is unchanged for existing heroes, old stored battles still replay, and no
 * hidden level input remains anywhere in the combat / stat code.
 */

const ruleset = buildDefaultRuleset();
const classIds = Object.keys(ruleset.classes);

function lineup(seed: string): CombatUnitInput[] {
  return Array.from({ length: 8 }, (_, i) => {
    const cls = ruleset.classes[classIds[i % classIds.length]!]!;
    const stats = computeEffectiveStats({
      classDef: cls,
      variation: rollVariation(createRng(`gv-${seed}-${i}`), DEFAULT_SETTINGS.character),
      telegram: zeroStats(),
      holdings: zeroStats(),
      loyalty: zeroStats(),
      trading: zeroStats(),
    }).total;
    return { characterId: `g${i}`, name: `g${i}`, classId: cls.id, tactic: "BALANCED" as const, stats };
  });
}

/**
 * eventsHash values produced by the engine BEFORE levels were removed (level-1 heroes, same seeds and stats), under rules
 * 1.0.0 — the ones that still had the shrinking ring. They are replayed through the engine's isolated LEGACY path (the
 * ruleset a stored battle carries), so they prove old stored battles still verify byte-for-byte after the ring was removed.
 * If one of these changes, a battle stored before the removal no longer replays.
 */
const GOLDEN: Record<string, string> = {
  "golden-1": "278e0970bddd2cbd19d788c92efa85697e7c0d8ca09ce9ecc1b96fcafbc9dfba",
  "golden-2": "1fc4812e77dd7bf4d8b150bd9c981cc9cd97b4641b5c04976a865892a210f238",
  "golden-3": "d20af9a6be12b4e36f72819f59e42fac05fa8aa52c14ba83516ea3ebca83947e",
};

/**
 * The same lineups under rules 2.0.0 (static arena, 30 s cap) AS A 2.0.0 BATTLE STORED THEM — frozen numbers, no `pace` key. These
 * hashes were pinned while 2.0.0 was the current ruleset; they must keep verifying after the 3.0.0 retune, because a stored battle
 * replays with the ruleset it carries (never with today's defaults).
 */
const GOLDEN_V2: Record<string, string> = {
  "golden-1": "86a5c968f47c992f19c7516bce2a81fab0a67f72cb5f07a38aed26c82ab2586a",
  "golden-2": "0cfdce452d8d45a71ad82aedab3f0f0e7a73a0df0c4f0b3ff1648c47235f7795",
  "golden-3": "ca66f8c09008728cbe71dd04e625428f99d9527c628abdb80d1d5c9bb10f6574",
};

/**
 * The same lineups under rules 3.0.0 (longer fights, 60 s cap) AS A 3.0.0 BATTLE STORED THEM — no `engagement` key. Pinned while 3.0.0 was the
 * current ruleset; they must keep verifying after 3.1.0, because a stored battle replays with the ruleset it carries.
 */
const GOLDEN_V3: Record<string, string> = {
  "golden-1": "d45a7097fda00f6decbe2758e50e72291d9cd0361aee608bc6cc0722c5cfb5c7",
  "golden-2": "90e7cbdaa171ce993fb6202638fdda23e5ec470adf9ba2aa5aa0cf3b82fe9811", // runs to the 60 s cap (deterministic time-limit result)
  "golden-3": "ead85aa0499c1bfaa5f58480aa8b3af516cc9ee96dd4a2fd3777c3fd99c6b346",
};

/** The same lineups under the CURRENT rules (3.1.0: engagement on top of the 3.0.0 pacing). Pinned so current behaviour cannot drift unnoticed. */
const GOLDEN_V31: Record<string, string> = {
  "golden-1": "720405ec7f92f4db0da0835914ce2feea69d010d5b3c2af555234a9d0b0cd9ad",
  "golden-2": "840f69f0e8834896864ffc89c8d5eb9ea351b8243f7faed11f4991ea0d579208",
  "golden-3": "64927f2362acb932923d20da16283736e2b1c98c61dcff666aa52e2f51456780",
};

describe("replay determinism is unchanged by the level removal", () => {
  for (const [seed, hash] of Object.entries(GOLDEN)) {
    it(`${seed} (rules 1.0.0, as stored) still produces the exact pre-removal event hash`, () => {
      expect(simulateBattle({ seed, ruleset: legacyRingRuleset(ruleset), units: lineup(seed), maxCombatMs: 30_000 }).eventsHash).toBe(hash);
    });
  }
  for (const [seed, hash] of Object.entries(GOLDEN_V2)) {
    it(`${seed} (rules 2.0.0, as stored — no pace key, 30 s cap) still produces its pinned event hash`, () => {
      const stored = JSON.stringify(rules200Stored(ruleset));
      expect(stored).not.toContain('"pace"'); // a 2.0.0 snapshot never had one …
      const replayed = validateRuleset(JSON.parse(stored)); // … and loads exactly like loadRulesetSnapshot does
      expect(replayed.combat.pace).toEqual({ time: 1, move: 1 }); // pace defaults to the exact no-op
      const out = simulateBattle({ seed, ruleset: replayed, units: lineup(seed), maxCombatMs: 30_000 });
      expect(out.eventsHash).toBe(hash);
      expect(out.rulesVersion).toBe("2.0.0");
      expect(simulateBattle({ seed, ruleset: rules200Ruleset(ruleset), units: lineup(seed), maxCombatMs: 30_000 }).eventsHash).toBe(hash);
    });
  }
  for (const [seed, hash] of Object.entries(GOLDEN_V3)) {
    it(`${seed} (rules 3.0.0, as stored — no engagement key, 60 s cap) still produces its pinned event hash`, () => {
      const stored = JSON.stringify(rules300Stored(ruleset));
      expect(stored).not.toContain('"engagement"'); // a 3.0.0 snapshot never had one …
      const replayed = validateRuleset(JSON.parse(stored)); // … and loads exactly like loadRulesetSnapshot does
      expect(replayed.combat.engagement).toBeUndefined(); // no engagement → the 3.0.0 code path, untouched
      const out = simulateBattle({ seed, ruleset: replayed, units: lineup(seed), maxCombatMs: 60_000 });
      expect(out.eventsHash).toBe(hash);
      expect(out.rulesVersion).toBe("3.0.0");
      expect(simulateBattle({ seed, ruleset: rules300Ruleset(ruleset), units: lineup(seed), maxCombatMs: 60_000 }).eventsHash).toBe(hash);
    });
  }
  it("the 3.0.0 retune produces NEW hashes only: the same seed under 2.0.0 and 3.0.0 differs, and each ruleset keeps its own result", () => {
    for (const seed of Object.keys(GOLDEN_V3)) expect(GOLDEN_V3[seed]).not.toBe(GOLDEN_V2[seed]);
  });
  for (const [seed, hash] of Object.entries(GOLDEN_V31)) {
    it(`${seed} (rules 3.1.0, the current rules) produces its pinned event hash`, () => {
      const out = simulateBattle({ seed, ruleset, units: lineup(seed), maxCombatMs: 60_000 });
      expect(out.rulesVersion).toBe(COMBAT_RULES_VERSION);
      expect(out.eventsHash).toBe(hash);
    });
  }
  it("rules 3.1.0 produces NEW hashes only: the same seed under 3.0.0 and 3.1.0 differs, and each ruleset keeps its own result", () => {
    for (const seed of Object.keys(GOLDEN_V31)) expect(GOLDEN_V31[seed]).not.toBe(GOLDEN_V3[seed]);
  });

  it("a battle stored BEFORE the removal (units carrying `level`, classes carrying `growth`) replays to the same hash", () => {
    const stored = legacyRingRuleset(ruleset);
    const legacyRuleset = validateRuleset({
      rulesVersion: stored.rulesVersion,
      combat: stored.combat,
      classes: Object.fromEntries(
        DEFAULT_CLASSES.map((c) => [c.id, { ...c, growth: { hp: 3.4, str: 0.62, def: 0.34, int: 0.1, agi: 0.28, cha: 0.15, luck: 0.18 } }]),
      ),
      skills: ruleset.skills,
    });
    for (const seed of Object.keys(GOLDEN)) {
      const legacyUnits = lineup(seed).map((u) => ({ ...u, level: 17 })) as CombatUnitInput[];
      expect(simulateBattle({ seed, ruleset: legacyRuleset, units: legacyUnits, maxCombatMs: 30_000 }).eventsHash).toBe(GOLDEN[seed]);
    }
  });
});

describe("level / XP cannot influence combat", () => {
  it("whatever level or XP a caller attaches to a unit, the fight is byte-identical", () => {
    const units = lineup("golden-1");
    const base = simulateBattle({ seed: "golden-1", ruleset, units, maxCombatMs: 30_000, recordFrames: true });
    for (const level of [1, 7, 30, 500]) {
      const tainted = units.map((u) => ({ ...u, level, xp: 987_654 })) as CombatUnitInput[];
      const out = simulateBattle({ seed: "golden-1", ruleset, units: tainted, maxCombatMs: 30_000, recordFrames: true });
      expect(out.eventsHash).toBe(base.eventsHash);
      expect(out.frames).toEqual(base.frames);
      expect(out.participants).toEqual(base.participants);
    }
  });

  it("stats and POWER ignore level, XP and any legacy class growth table", () => {
    const zero = { variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() };
    for (const cls of DEFAULT_CLASSES) {
      const clean = computeEffectiveStats({ classDef: cls, ...zero });
      const tainted = computeEffectiveStats({ classDef: { ...cls, growth: { hp: 50, str: 5, def: 5, int: 5, agi: 5, cha: 5, luck: 5 } }, ...zero, level: 400, xp: 5e9 } as never);
      expect(tainted.total).toEqual(clean.total);
      expect(computePower(tainted.total, DEFAULT_SETTINGS.character)).toBe(computePower(clean.total, DEFAULT_SETTINGS.character));
    }
  });

  it("the default classes no longer ship a per-level growth table", () => {
    for (const cls of DEFAULT_CLASSES) expect(cls).not.toHaveProperty("growth");
  });
});

/** Strips comments so a doc comment that merely EXPLAINS the removal is not mistaken for a code dependency. */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
}
function walk(dir: string, accept: (f: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, accept) : accept(p) ? [p] : [];
  });
}
const SRC = join(__dirname, "..", "..", "src");

describe("no hidden level scaling is left in the combat or stat code", () => {
  const files = [
    ...walk(join(SRC, "domain", "combat"), (f) => f.endsWith(".ts")),
    join(SRC, "domain", "character", "stats.ts"),
    join(SRC, "domain", "character", "generate.ts"),
    join(SRC, "domain", "holdings", "holdingPower.ts"),
    join(SRC, "domain", "holdings", "streaks.ts"),
    join(SRC, "domain", "holdings", "trading.ts"),
    join(SRC, "server", "services", "characters.ts"),
  ];
  it("combat engine, stat pipeline and fighter loading never read a level, XP or growth value", () => {
    for (const f of files) {
      expect(code(f), f).not.toMatch(/\blevel\b|\bxp\b|\bgrowth\b|minLevel|min_level|\.level\b/i);
    }
  });
  it("the XP / level progression module is gone", () => {
    expect(() => readFileSync(join(SRC, "domain", "progression", "levels.ts"))).toThrow();
  });
});

describe("player-facing UI carries no XP / level language", () => {
  const FORBIDDEN = /\bXP\b|\bexperience\b|\blevel(?:s|ling|ing)?\b|\blvl\b|\bLv\b|level[- ]?up|next level|xpAwarded|xpIntoLevel|xpForNextLevel/i;
  const uiFiles = [
    ...walk(join(SRC, "components"), (f) => /\.(ts|tsx)$/.test(f)),
    ...walk(join(SRC, "app"), (f) => /\.(ts|tsx)$/.test(f) && !f.includes(`${join("app", "api")}`)),
    join(SRC, "lib", "api.ts"),
    join(SRC, "content", "features.ts"),
    join(SRC, "content", "heroEligibility.ts"),
  ];
  it("no component, page or message mentions XP, levels or levelling", () => {
    expect(uiFiles.length).toBeGreaterThan(25); // guards against the scan silently matching nothing
    const offenders = uiFiles
      .map((f) => ({ f, m: code(f).match(FORBIDDEN) }))
      .filter((x) => x.m)
      .map((x) => `${x.f.replace(SRC, "src")}: "${x.m![0]}"`);
    expect(offenders).toEqual([]);
  });
  it("the Arena, results, Current Round, hero page and leaderboards have no level/XP markup at all", () => {
    for (const rel of [
      "components/arena/ArenaScreen.tsx", "components/arena/ArenaRenderer.ts", "components/arena/ArenaPicks.tsx", "components/arena/RecentWinners.tsx",
      "components/arena/SpectatorStrip.tsx", "components/character/HeroView.tsx", "components/leaderboard/HallOfChampions.tsx", "components/leaderboard/HeroBoards.tsx", "components/leaderboard/PicksSeasonBoard.tsx", "components/character/InventoryView.tsx",
    ]) {
      expect(code(join(SRC, rel)), rel).not.toMatch(FORBIDDEN);
    }
  });
});
