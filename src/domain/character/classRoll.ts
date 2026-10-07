import { BEHAVIOR_FEATURES, type BehaviorFeature, type ClassDef } from "../rules";
import type { CharacterSettings } from "../settings";
import { behaviorRatios } from "../telegram/activity";
import type { BehaviorCounters } from "../telegram/types";
import type { Rng } from "../util/rng";

/**
 * [low, high] ratio cut-offs per behaviour feature. Behaviour is bucketed COARSELY into
 * {-1, 0, +1} so tiny changes in habits cannot be tuned to steer the roll.
 */
export const BEHAVIOR_BUCKETS: Record<BehaviorFeature, readonly [number, number]> = {
  replyRatio: [0.15, 0.45],
  questionRatio: [0.05, 0.2],
  exclaimRatio: [0.08, 0.3],
  longRatio: [0.03, 0.15],
  linkRatio: [0.02, 0.12],
  mediaRatio: [0.02, 0.12],
  nightRatio: [0.1, 0.35],
  burstRatio: [0.05, 0.25],
};

/** Behaviour profiles with fewer qualifying messages than this are treated as neutral. */
const MIN_MESSAGES_FOR_PROFILE = 25;

export function behaviorBuckets(behavior: Partial<BehaviorCounters>): Record<BehaviorFeature, -1 | 0 | 1> {
  const ratios = behaviorRatios(behavior);
  const neutral = (behavior.msgs ?? 0) < MIN_MESSAGES_FOR_PROFILE;
  const out = {} as Record<BehaviorFeature, -1 | 0 | 1>;
  for (const feature of BEHAVIOR_FEATURES) {
    const [low, high] = BEHAVIOR_BUCKETS[feature];
    const ratio = ratios[feature] ?? 0;
    out[feature] = neutral ? 0 : ratio <= low ? -1 : ratio >= high ? 1 : 0;
  }
  return out;
}

export interface ClassProbability {
  classId: string;
  probability: number;
}

/**
 * Class assignment is MOSTLY RANDOM. Probability for class c:
 *     p_c = (1 - λ)/n  +  λ · softmax(β · affinity_c)
 * With λ = classInfluence (0.18 default) and n = 6, every class keeps at least 13.7% and no
 * class can exceed ~31.7% (vs. 16.7% uniform) no matter what the member does — behaviour can
 * nudge the odds but never guarantee a class. These bounds are asserted in tests.
 */
export function classProbabilities(
  classes: readonly ClassDef[],
  behavior: Partial<BehaviorCounters>,
  settings: CharacterSettings,
): ClassProbability[] {
  const n = classes.length;
  if (n === 0) throw new Error("No enabled classes");
  const buckets = behaviorBuckets(behavior);
  const affinity = classes.map((c) => {
    let score = 0;
    for (const feature of BEHAVIOR_FEATURES) score += (c.affinity[feature] ?? 0) * buckets[feature];
    return settings.classAffinityScale * score;
  });
  const max = Math.max(...affinity);
  const exps = affinity.map((a) => Math.exp(a - max));
  const total = exps.reduce((a, b) => a + b, 0);
  const lambda = settings.classInfluence;
  return classes.map((c, i) => ({
    classId: c.id,
    probability: (1 - lambda) / n + (lambda * (exps[i] as number)) / total,
  }));
}

export function rollClass(classes: readonly ClassDef[], behavior: Partial<BehaviorCounters>, settings: CharacterSettings, rng: Rng): ClassDef {
  const probabilities = classProbabilities(classes, behavior, settings);
  const picked = rng.weighted(probabilities, (p) => p.probability);
  return classes.find((c) => c.id === picked.classId) as ClassDef;
}
