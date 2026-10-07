/**
 * Balance simulation library (pure domain code — no database, no argv, no console). Used by `scripts/balance-sim.ts` and by the
 * pacing regression test. Common random numbers: battle `b` always uses the same lineup rolls and seed, so two rulesets compare
 * the SAME fights (differences are the rules, not luck).
 */
import { computeEffectiveStats, computePower, rollVariation } from "../../src/domain/character/stats";
import { buildDefaultRuleset } from "../../src/domain/content";
import { simulateBattle } from "../../src/domain/combat/engine";
import { EV, type CombatUnitInput, type Tactic } from "../../src/domain/combat/types";
import { validateRuleset, type Ruleset } from "../../src/domain/rules";
import { DEFAULT_SETTINGS } from "../../src/domain/settings";
import { zeroStats } from "../../src/domain/stats";
import { createRng } from "../../src/domain/util/rng";

/** Applies `path=number` overrides to a COPY of the ruleset (re-validated, so a typo fails loudly). */
export function applyOverrides(base: Ruleset, specs: readonly string[]): Ruleset {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const spec of specs) {
    const [path, raw] = spec.split("=");
    const value = Number(raw);
    if (!path || raw === undefined || !Number.isFinite(value)) throw new Error(`--set expects path=number, got "${spec}"`);
    const keys = path.split(".");
    let node = draft as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      if (typeof node[k] !== "object" || node[k] === null) throw new Error(`--set ${path}: "${k}" is not an object in the ruleset`);
      node = node[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1] as string;
    if (!(last in node)) throw new Error(`--set ${path}: no such ruleset field`);
    node[last] = value;
  }
  return validateRuleset(draft);
}

export interface SimOptions {
  battles: number;
  maxCombatMs: number;
  ruleset?: Ruleset;
  label?: string;
}

const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
const quantile = (xs: number[], q: number) => {
  const s = sorted(xs);
  return s.length ? (s[Math.min(s.length - 1, Math.floor(q * s.length))] as number) : 0;
};
const sec = (ms: number) => Math.round(ms / 100) / 10;

export interface SimSummary {
  label: string;
  rulesVersion: string;
  battles: number;
  maxCombatMs: number;
  duration: { p10: number; p25: number; median: number; p75: number; p90: number; p95: number; p99: number; max: number };
  histogram: Record<string, number>;
  singleSurvivorPct: number;
  timeoutPct: number;
  wipePct: number;
  pacing: { firstKillMedianS: number; longestQuietMedianS: number; longestQuietP95S: number; quietSecondsSharePct: number; hitsPerSecondMedian: number };
  classes: Record<string, { appearances: number; winPct: number; top2Pct: number; avgPlace: number; avgSurvivalS: number; medianSurvivalS: number; dealt: number; taken: number; elims: number; power: number }>;
  aliveAtTimeLimit: Record<string, number>;
  wallClockMs: number;
}

export function runBalanceSim(opts: SimOptions): SimSummary {
  const ruleset = opts.ruleset ?? buildDefaultRuleset();
  const { battles, maxCombatMs } = opts;
  const classIds = Object.keys(ruleset.classes);
  const makeUnit = (rng: ReturnType<typeof createRng>, classId: string, idx: number): CombatUnitInput => {
    const cls = ruleset.classes[classId]!;
    const stats = computeEffectiveStats({ classDef: cls, variation: rollVariation(rng, DEFAULT_SETTINGS.character), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() });
    return { characterId: `c${idx}`, name: `${classId}-${idx}`, classId, tactic: "BALANCED" as Tactic, stats: stats.total };
  };

  const wins: Record<string, number> = {};
  const top2: Record<string, number> = {};
  const appearances: Record<string, number> = {};
  const placementSum: Record<string, number> = {};
  const survivals: Record<string, number[]> = {};
  const dealtSum: Record<string, number> = {};
  const takenSum: Record<string, number> = {};
  const elimSum: Record<string, number> = {};
  const durations: number[] = [];
  const longestQuietMs: number[] = [];
  const firstKillMs: number[] = [];
  const quietShare: number[] = [];
  const hitsPerSecond: number[] = [];
  let lastStanding = 0;
  let timeLimit = 0;
  let simultaneousDeaths = 0;
  const timeLimitAlive: Record<string, number> = {};
  const t0 = performance.now();

  for (let b = 0; b < battles; b++) {
    const rng = createRng(`balance-${b}`);
    const units: CombatUnitInput[] = [];
    for (let i = 0; i < 8; i++) units.push(makeUnit(rng, rng.pick(classIds), i));
    const out = simulateBattle({ seed: `seed-${b}`, ruleset, units, maxCombatMs });
    durations.push(out.durationMs);
    if (out.endedBy === "LAST_STANDING") lastStanding++;
    else {
      timeLimit++;
      for (const p of out.participants) if (p.alive) {
        const cls = units.find((u) => u.characterId === p.characterId)!.classId;
        timeLimitAlive[cls] = (timeLimitAlive[cls] ?? 0) + 1;
      }
    }
    if (out.participants.filter((p) => p.alive).length === 0) simultaneousDeaths++;

    // pacing, from the event stream (HIT = damage landed, ELIM = a fighter fell)
    const tick = out.tickMs;
    const hitTicks: number[] = [];
    let firstKill = -1;
    for (const e of out.events) {
      if (e[1] === EV.HIT) hitTicks.push(e[0]);
      else if (e[1] === EV.ELIM && firstKill < 0) firstKill = e[0] * tick;
    }
    let gap = 0;
    let prev = 0;
    for (const h of hitTicks) {
      gap = Math.max(gap, (h - prev) * tick);
      prev = h;
    }
    gap = Math.max(gap, out.durationMs - prev * tick);
    longestQuietMs.push(gap);
    if (firstKill >= 0) firstKillMs.push(firstKill);
    const seconds = Math.max(1, Math.ceil(out.durationMs / 1000));
    const active = new Set<number>();
    for (const h of hitTicks) active.add(Math.floor((h * tick) / 1000));
    quietShare.push((seconds - active.size) / seconds);
    hitsPerSecond.push(hitTicks.length / (out.durationMs / 1000));

    for (const p of out.participants) {
      const cls = units.find((u) => u.characterId === p.characterId)!.classId;
      appearances[cls] = (appearances[cls] ?? 0) + 1;
      placementSum[cls] = (placementSum[cls] ?? 0) + p.placement;
      (survivals[cls] ??= []).push(p.survivedMs);
      dealtSum[cls] = (dealtSum[cls] ?? 0) + p.damageDealt;
      takenSum[cls] = (takenSum[cls] ?? 0) + p.damageTaken;
      elimSum[cls] = (elimSum[cls] ?? 0) + p.eliminations;
      if (p.placement === 1) wins[cls] = (wins[cls] ?? 0) + 1;
      if (p.placement <= 2) top2[cls] = (top2[cls] ?? 0) + 1;
    }
  }

  const share = (n: number) => Math.round((n / battles) * 1000) / 10;
  const dur = (q: number) => sec(quantile(durations, q));
  return {
    label: opts.label ?? "default",
    rulesVersion: ruleset.rulesVersion,
    battles,
    maxCombatMs,
    duration: { p10: dur(0.1), p25: dur(0.25), median: dur(0.5), p75: dur(0.75), p90: dur(0.9), p95: dur(0.95), p99: dur(0.99), max: dur(1) },
    histogram: Object.fromEntries(
      ([[0, 15], [15, 25], [25, 35], [35, 45], [45, 55], [55, Infinity]] as Array<[number, number]>).map(([lo, hi]) => [
        `${lo}-${hi === Infinity ? "+" : hi}s`,
        share(durations.filter((d) => d >= lo * 1000 && d < hi * 1000).length),
      ]),
    ),
    singleSurvivorPct: share(lastStanding),
    timeoutPct: share(timeLimit),
    wipePct: share(simultaneousDeaths),
    pacing: {
      firstKillMedianS: sec(quantile(firstKillMs, 0.5)),
      longestQuietMedianS: sec(quantile(longestQuietMs, 0.5)),
      longestQuietP95S: sec(quantile(longestQuietMs, 0.95)),
      quietSecondsSharePct: Math.round(quantile(quietShare, 0.5) * 1000) / 10,
      hitsPerSecondMedian: Math.round(quantile(hitsPerSecond, 0.5) * 10) / 10,
    },
    classes: Object.fromEntries(
      classIds.map((c) => {
        const a = appearances[c] ?? 0;
        const power = computePower(computeEffectiveStats({ classDef: ruleset.classes[c]!, variation: zeroStats(), telegram: zeroStats(), holdings: zeroStats(), loyalty: zeroStats(), trading: zeroStats() }).total, DEFAULT_SETTINGS.character);
        return [c, {
          appearances: a,
          winPct: Math.round(((wins[c] ?? 0) / a) * 1000) / 10,
          top2Pct: Math.round(((top2[c] ?? 0) / a) * 1000) / 10,
          avgPlace: Math.round(((placementSum[c] ?? 0) / a) * 100) / 100,
          avgSurvivalS: Math.round(((survivals[c] ?? []).reduce((x, y) => x + y, 0) / a / 1000) * 10) / 10,
          medianSurvivalS: sec(quantile(survivals[c] ?? [], 0.5)),
          dealt: Math.round((dealtSum[c] ?? 0) / a),
          taken: Math.round((takenSum[c] ?? 0) / a),
          elims: Math.round(((elimSum[c] ?? 0) / a) * 100) / 100,
          power,
        }];
      }),
    ),
    aliveAtTimeLimit: timeLimitAlive,
    wallClockMs: Math.round(performance.now() - t0),
  };
}

/**
 * WHAT-IF (research): the same fights in slow motion, by scaling every time constant of a COPY of the ruleset — attack
 * intervals, cooldowns, cast and status durations, regeneration (by `k`), movement and projectile speeds (by `m`).
 * The shipped implementation is the engine's `combat.pace`; this transform remains to cross-check it.
 */
export function dilateRuleset(rs: Ruleset, k: number, m: number): Ruleset {
  const out = JSON.parse(JSON.stringify(rs)) as Ruleset;
  const c = out.combat;
  c.derive.moveSpeedPerAgi /= m;
  c.rangedPlantMs = Math.round(c.rangedPlantMs * k);
  for (const cls of Object.values(out.classes)) {
    cls.attack.intervalMs = Math.round(cls.attack.intervalMs * k);
    cls.attack.projectileSpeed /= m;
    cls.moveSpeed /= m;
    for (const t of cls.traits) if (t.type === "regen_pct") t.perSec /= k;
  }
  for (const sk of Object.values(out.skills)) {
    sk.cooldownMs = Math.round(sk.cooldownMs * k);
    sk.castMs = Math.round(sk.castMs * k);
    for (const e of sk.effects) {
      if (e.type === "damage") {
        if (e.stunMs) e.stunMs = Math.round(e.stunMs * k);
        if (e.slow) e.slow = { amount: e.slow.amount, ms: Math.round(e.slow.ms * k) };
      } else if (e.type === "shield" || e.type === "buff" || e.type === "taunt" || e.type === "empower") e.ms = Math.round(e.ms * k);
    }
  }
  return validateRuleset(out);
}
