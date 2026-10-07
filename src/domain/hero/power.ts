import { STAT_KEYS, type StatBlock } from "../stats";

/**
 * PWR — the ONE authoritative hero POWER formula (power formula 2, introduced with hero generator 2).
 *
 * PWR is a derived SUMMARY of a hero's seven generated stats. The combat engine never reads it — individual stats, classes and
 * skills decide fights (asserted in tests) — but rarity bands, the stat budget a hero is generated with, the hero card and every
 * list are all expressed in it, so it is computed in exactly one place, on the server, from the stats themselves. A figure sent
 * by a browser is never trusted and an arbitrary PWR is never stored: a version's `power` is always `computeHeroPower(stats, class)`.
 *
 *     PWR = round( classFactor × (0.4·HP + 2·STR + 2·DEF + 2·INT + 2·AGI + 1·CHA + 1·LUCK) )
 *
 *  · the weights are the long-standing stat weights (HP is a big number, so it counts for less per point);
 *  · `classFactor` calibrates the classes against each other. The six archetypes spend their points very differently — a Tank's
 *    strength is HP and DEF, a Cleric's is CHA and INT, a Mage's is burst — so a plain weighted sum rates the same fighting strength very
 *    differently per class (on the live heroes under the old formula Rogues averaged ~162 while Mages averaged ~137, though the two win about
 *    equally often). The factors were fitted with the real combat engine (8-hero Arena battles, `pnpm rarity:sim`) so that EQUAL PWR MEANS EQUAL
 *    EXPECTED STRENGTH whichever class carries it: when every fighter has the same PWR, every class wins about the same share of battles. That
 *    is what keeps Tank and Cleric from being rated below their worth, and what keeps every class competitive inside every rarity
 *    (asserted by the balance simulation test — see docs/RARITY_POWER.md).
 *
 *    A class's own BASELINE hero (its stat shape at budget 1.0) is a different matter: the six baselines are not equally strong, so they do not
 *    read the same PWR (they read POWER_BASELINE / CLASS_STRENGTH_SCALE — between 130 and 150, i.e. all Common-strength). That is correct: PWR
 *    measures strength, not "how many points were spent".
 *
 * The factors are FROZEN CONSTANTS, deliberately not derived from the (admin-editable) class definitions: a stored PWR must never
 * change because somebody tuned a class. If the formula or a factor ever has to change, that is a new POWER_FORMULA_VERSION and a new
 * hero generator version — old hero versions keep the numbers they were made with. (A unit test recomputes the factors from the
 * shipped class bases and fails loudly if the classes drift away from what the factors were calibrated for.)
 */
export const POWER_FORMULA_VERSION = 2;

/** What one point of each stat is worth before the class calibration. */
export const POWER_WEIGHTS: Readonly<StatBlock> = Object.freeze({ hp: 0.4, str: 2, def: 2, int: 2, agi: 2, cha: 1, luck: 1 });

/** The reference PWR (stat budget 1.0 for a reference-strength class). Rarity bands are expressed around it; see CLASS_STRENGTH_SCALE for each class. */
export const POWER_BASELINE = 140;

/**
 * Per-class calibration (see above). `CLASS_STRENGTH_SCALE[c]` is the fitted multiple of its baseline stats a class needs to match the
 * reference hero's strength (below 1 = the baseline shape is already stronger than the reference, above 1 = weaker); equal PWR therefore means equal
 * strength. `CLASS_POWER_FACTOR[c] = POWER_BASELINE / (CLASS_STRENGTH_SCALE[c] × weightedSum(default base of c))`, rounded to four decimals.
 */
export const CLASS_STRENGTH_SCALE: Readonly<Record<string, number>> = Object.freeze({
  warrior: 0.955,
  mage: 0.95,
  rogue: 1.025,
  ranger: 0.965,
  tank: 1.05,
  cleric: 1.055,
});

export const CLASS_POWER_FACTOR: Readonly<Record<string, number>> = Object.freeze({
  warrior: 0.9826,
  mage: 1.1215,
  rogue: 0.8755,
  ranger: 1.0875,
  tank: 0.883,
  cleric: 0.9729,
});

/** A class the formula was not calibrated for (an admin-added class) is rated by the plain weighted sum. */
export const NEUTRAL_CLASS_POWER_FACTOR = 1;

export const classPowerFactor = (classId: string): number => CLASS_POWER_FACTOR[classId] ?? NEUTRAL_CLASS_POWER_FACTOR;

/** Σ weight × stat, before the class calibration. */
export function weightedStatSum(stats: Readonly<StatBlock>): number {
  let sum = 0;
  for (const key of STAT_KEYS) sum += stats[key] * POWER_WEIGHTS[key];
  return sum;
}

/** The authoritative PWR of a hero's generated stats. Deterministic, pure, integer. */
export function computeHeroPower(stats: Readonly<StatBlock>, classId: string): number {
  return Math.round(classPowerFactor(classId) * weightedStatSum(stats));
}

/**
 * Scales a class's stat SHAPE to a target PWR, then nudges single stat points until the integer stats read EXACTLY that PWR.
 *
 * `shape` is the class's base stat block (what the class is good at), `offsets` are optional per-stat shape variations in "points at
 * budget 1.0" (they scale with the budget so a Legendary's wobble is proportionally the same as a Common's). The result is a full
 * integer stat block, every stat ≥ 1, whose PWR is `targetPower` — never clamped afterwards: the stats ARE what produce the number.
 *
 * Termination: each correction step strictly reduces |exact PWR − target| (a step of ±0.4·factor on HP is always smaller than twice
 * the remaining distance once the rounded PWR differs from the target), so the loop ends in a handful of steps; a hard cap turns a
 * bug into an error instead of a hang.
 */
export function fitStatsToPower(classId: string, shape: Readonly<StatBlock>, targetPower: number, offsets?: Partial<StatBlock> | null, factorOverride?: number): StatBlock {
  if (!Number.isInteger(targetPower) || targetPower < 1) throw new RangeError(`fitStatsToPower: target PWR must be a positive integer, got ${targetPower}`);
  const shapeSum = weightedStatSum(shape);
  if (!(shapeSum > 0)) throw new RangeError("fitStatsToPower: the class shape has no weight");
  // `factorOverride` exists for the calibration tooling only (scripts/lib/raritySim.ts fits the class factors against the real combat engine);
  // production code never passes it — a stored PWR is always `computeHeroPower`, i.e. the frozen factor.
  const factor = factorOverride ?? classPowerFactor(classId);
  const powerOf = (s: Readonly<StatBlock>): number => factor * weightedStatSum(s);
  const scale = targetPower / factor / shapeSum; // the stat budget actually applied to this class's shape
  const ideal = {} as Record<(typeof STAT_KEYS)[number], number>;
  const stats = {} as StatBlock;
  for (const key of STAT_KEYS) {
    ideal[key] = shape[key] * scale + (offsets?.[key] ?? 0) * scale;
    stats[key] = Math.max(1, Math.round(ideal[key]));
  }
  for (let guard = 0; Math.round(powerOf(stats)) !== targetPower; guard++) {
    if (guard > 400) throw new Error(`fitStatsToPower: no exact fit for PWR ${targetPower} (${classId})`);
    const direction = Math.round(powerOf(stats)) < targetPower ? 1 : -1;
    const before = Math.abs(powerOf(stats) - targetPower);
    let best: (typeof STAT_KEYS)[number] | null = null;
    let bestAfter = Infinity;
    let bestDrift = Infinity;
    for (const key of STAT_KEYS) {
      if (direction < 0 && stats[key] <= 1) continue;
      stats[key] += direction;
      const after = Math.abs(powerOf(stats) - targetPower);
      const drift = Math.abs(stats[key] - ideal[key]) / Math.max(1, ideal[key]);
      stats[key] -= direction;
      if (after >= before) continue; // only steps that get strictly closer
      // Prefer the step that lands closest to the target; among near-equal landings keep the shape (least relative drift from the ideal).
      if (after < bestAfter - 0.25 || (Math.abs(after - bestAfter) <= 0.25 && drift < bestDrift)) {
        best = key;
        bestAfter = after;
        bestDrift = drift;
      }
    }
    if (best === null) throw new Error(`fitStatsToPower: stuck at PWR ${Math.round(powerOf(stats))} (target ${targetPower}, ${classId})`);
    stats[best] += direction;
  }
  return stats;
}
