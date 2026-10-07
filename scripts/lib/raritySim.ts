/**
 * Rarity balance simulation (pure domain code — no database, no argv, no console). Fighters are drawn exactly like hero generator 2 draws
 * a hero's stats (rarity band → position → class shape fitted to PWR, plus the seed's bounded shape variation), then fight in the real
 * combat engine. Common random numbers: battle `b` always uses the same lineup rolls and the same combat seed, so two rulesets/bands
 * compare the SAME fights.
 *
 * Scenarios (who is in the 8 slots):
 *   production   rarity per slot from the production odds (70 / 22 / 7 / 1 %) — what the live Arena looks like
 *   uniform      every slot a uniformly random rarity — the fair test of "does rarity win", with plenty of Epics and Legendaries
 *   per-rarity   all eight slots the same rarity, rotating through the four — class balance INSIDE each rarity
 *   duel         slot 0 is the rarity under test, the other seven are Common — "how much does one Legendary beat a field of Commons"
 */
import { rollVariation } from "../../src/domain/character/stats";
import { RARITIES, type Rarity } from "../../src/domain/character/appearance";
import { buildDefaultRuleset } from "../../src/domain/content";
import { simulateBattle } from "../../src/domain/combat/engine";
import type { CombatUnitInput, Tactic } from "../../src/domain/combat/types";
import { computeHeroPower, fitStatsToPower } from "../../src/domain/hero/power";
import { RARITY_RULES } from "../../src/domain/hero/rarity";
import { buildTierStats } from "../../src/domain/hero/statBudget";
import type { ClassDef, Ruleset } from "../../src/domain/rules";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { createRng, type Rng } from "../../src/domain/util/rng";

export type RaritySimScenario = "production" | "uniform" | "per-rarity" | "duel";

export interface RaritySimOptions {
  battles: number;
  scenario: RaritySimScenario;
  maxCombatMs?: number;
  ruleset?: Ruleset;
  /** Replaces the band table for a what-if (defaults to the shipped RARITY_RULES). Only powerMin/powerMax are read. */
  bands?: Readonly<Record<Rarity, { powerMin: number; powerMax: number }>>;
  label?: string;
  /** Seed namespace so independent runs do not share rolls. */
  salt?: string;
  /** CALIBRATION ONLY: fit each class with this PWR factor instead of the frozen one (see scripts/calibrate-class-factors.ts). */
  classFactors?: Readonly<Record<string, number>>;
}

const PRODUCTION_WEIGHTS = DEFAULT_SETTINGS.character.rarityWeights;

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const quantile = (xs: number[], q: number) => {
  const s = sorted(xs);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number) : 0;
};
const sec = (ms: number) => Math.round(ms / 100) / 10;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

interface Tally {
  appearances: number;
  wins: number;
  top2: number;
  placementSum: number;
}
const tally = (): Tally => ({ appearances: 0, wins: 0, top2: 0, placementSum: 0 });
const record = (t: Tally, placement: number) => {
  t.appearances++;
  t.placementSum += placement;
  if (placement === 1) t.wins++;
  if (placement <= 2) t.top2++;
};
const view = (t: Tally) => ({ appearances: t.appearances, winPct: pct(t.wins, t.appearances), top2Pct: pct(t.top2, t.appearances), avgPlace: t.appearances ? Math.round((t.placementSum / t.appearances) * 100) / 100 : 0 });

export interface RaritySimSummary {
  label: string;
  scenario: RaritySimScenario;
  rulesVersion: string;
  battles: number;
  fighters: number;
  duration: { median: number; p90: number; p95: number; max: number };
  timeoutPct: number;
  /** Win rate expected from luck alone for a fighter of any kind (1 of 8). */
  baselineWinPct: number;
  byClass: Record<string, ReturnType<typeof view>>;
  byRarity: Record<string, ReturnType<typeof view>>;
  byClassRarity: Record<string, Record<string, ReturnType<typeof view>>>;
  /** PWR of every fighter drawn, per rarity. */
  powerByRarity: Record<string, { n: number; min: number; p25: number; median: number; p75: number; max: number; mean: number }>;
  /** Pairwise: in battles with both present, how often the higher rarity out-placed the lower. */
  pairwise: Record<string, { pairs: number; higherOutplacesPct: number }>;
  /** Share of battles won by each rarity (sums to 100): who actually takes the Arena. */
  winnerRarityShare: Record<string, number>;
  wallClockMs: number;
}

function rollRarityBy(rng: Rng): Rarity {
  return rng.weighted(RARITIES, (r) => PRODUCTION_WEIGHTS[r]);
}

/** One fighter exactly as hero generator 2 would roll its stats (optionally against what-if bands or what-if class factors). */
export function rollFighter(rng: Rng, classDef: ClassDef, rarity: Rarity, bands?: RaritySimOptions["bands"], classFactors?: RaritySimOptions["classFactors"]): { stats: CombatUnitInput["stats"]; power: number } {
  const position = rng.next();
  const shape = rollVariation(rng.fork("shape"), DEFAULT_SETTINGS.character);
  const factor = classFactors?.[classDef.id];
  if (!bands && factor === undefined) {
    const t = buildTierStats({ classDef, rarity, position, shape });
    return { stats: t.stats, power: t.power };
  }
  // What-if: the same fitting routine, aimed at a power inside the alternative band and/or with an alternative class factor.
  const { powerMin, powerMax } = bands ? bands[rarity] : RARITY_RULES[rarity];
  const target = powerMin + Math.floor(Math.min(0.999999999, position) * (powerMax - powerMin + 1));
  const stats = fitStatsToPower(classDef.id, classDef.base as CombatUnitInput["stats"], target, shape, factor);
  return { stats, power: factor === undefined ? computeHeroPower(stats, classDef.id) : target };
}

export function runRaritySim(opts: RaritySimOptions): RaritySimSummary {
  const ruleset = opts.ruleset ?? buildDefaultRuleset();
  const maxCombatMs = opts.maxCombatMs ?? DEFAULT_SETTINGS.arena.maxCombatMs;
  const classIds = Object.keys(ruleset.classes);
  const salt = opts.salt ?? "rs";
  const byClass: Record<string, Tally> = {};
  const byRarity: Record<string, Tally> = {};
  const byClassRarity: Record<string, Record<string, Tally>> = {};
  const powers: Record<string, number[]> = {};
  const pair: Record<string, { pairs: number; higher: number }> = {};
  const winnerRarity: Record<string, number> = {};
  const durations: number[] = [];
  let timeouts = 0;
  let fighters = 0;
  const t0 = performance.now();

  for (let b = 0; b < opts.battles; b++) {
    const rng = createRng(`${salt}-${opts.scenario}-${b}`);
    const units: CombatUnitInput[] = [];
    const rarities: Rarity[] = [];
    const classes: string[] = [];
    const rotating = RARITIES[b % RARITIES.length] as Rarity;
    for (let i = 0; i < 8; i++) {
      const classId = rng.pick(classIds);
      let rarity: Rarity;
      switch (opts.scenario) {
        case "production": rarity = rollRarityBy(rng); break;
        case "uniform": rarity = rng.pick(RARITIES as unknown as Rarity[]); break;
        case "per-rarity": rarity = rotating; break;
        case "duel": rarity = i === 0 ? rotating : "COMMON"; break;
      }
      const f = rollFighter(rng.fork(`fighter-${i}`), ruleset.classes[classId]!, rarity, opts.bands, opts.classFactors);
      (powers[rarity] ??= []).push(f.power);
      units.push({ characterId: `c${i}`, name: `${classId}-${i}`, classId, tactic: "BALANCED" as Tactic, stats: f.stats });
      rarities.push(rarity);
      classes.push(classId);
    }
    const out = simulateBattle({ seed: `seed-${salt}-${b}`, ruleset, units, maxCombatMs });
    durations.push(out.durationMs);
    if (out.endedBy !== "LAST_STANDING") timeouts++;
    const placeOf = new Map(out.participants.map((p) => [p.characterId, p.placement]));
    const idxOf = (id: string) => Number(id.slice(1));
    for (const p of out.participants) {
      const i = idxOf(p.characterId);
      const cls = classes[i]!;
      const rar = rarities[i]!;
      record((byClass[cls] ??= tally()), p.placement);
      record((byRarity[rar] ??= tally()), p.placement);
      record(((byClassRarity[cls] ??= {})[rar] ??= tally()), p.placement);
      fighters++;
      if (p.placement === 1) winnerRarity[rar] = (winnerRarity[rar] ?? 0) + 1;
    }
    // pairwise rarity comparisons within the battle (different rarities only)
    for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
      const ri = RARITIES.indexOf(rarities[i]!);
      const rj = RARITIES.indexOf(rarities[j]!);
      if (ri === rj) continue;
      const hi = ri > rj ? i : j;
      const lo = ri > rj ? j : i;
      const key = `${rarities[hi]}>${rarities[lo]}`;
      const e = (pair[key] ??= { pairs: 0, higher: 0 });
      e.pairs++;
      if ((placeOf.get(`c${hi}`) ?? 9) < (placeOf.get(`c${lo}`) ?? 9)) e.higher++;
    }
  }

  const stat = (xs: number[]) => ({
    n: xs.length,
    min: Math.min(...xs),
    p25: quantile(xs, 0.25),
    median: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    max: Math.max(...xs),
    mean: Math.round((xs.reduce((a, c) => a + c, 0) / xs.length) * 10) / 10,
  });
  const totalWins = Object.values(winnerRarity).reduce((a, c) => a + c, 0) || 1;
  return {
    label: opts.label ?? "default",
    scenario: opts.scenario,
    rulesVersion: ruleset.rulesVersion,
    battles: opts.battles,
    fighters,
    duration: { median: sec(quantile(durations, 0.5)), p90: sec(quantile(durations, 0.9)), p95: sec(quantile(durations, 0.95)), max: sec(quantile(durations, 1)) },
    timeoutPct: pct(timeouts, opts.battles),
    baselineWinPct: 12.5,
    byClass: Object.fromEntries(Object.entries(byClass).map(([k, v]) => [k, view(v)])),
    byRarity: Object.fromEntries(RARITIES.filter((r) => byRarity[r]).map((r) => [r, view(byRarity[r]!)])),
    byClassRarity: Object.fromEntries(Object.entries(byClassRarity).map(([c, m]) => [c, Object.fromEntries(RARITIES.filter((r) => m[r]).map((r) => [r, view(m[r]!)]))])),
    powerByRarity: Object.fromEntries(RARITIES.filter((r) => powers[r]?.length).map((r) => [r, stat(powers[r]!)])),
    pairwise: Object.fromEntries(Object.entries(pair).map(([k, v]) => [k, { pairs: v.pairs, higherOutplacesPct: pct(v.higher, v.pairs) }])),
    winnerRarityShare: Object.fromEntries(RARITIES.filter((r) => winnerRarity[r]).map((r) => [r, pct(winnerRarity[r]!, totalWins)])),
    wallClockMs: Math.round(performance.now() - t0),
  };
}
