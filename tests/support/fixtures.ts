import { computeEffectiveStats, rollVariation } from "@/domain/character/stats";
import { buildDefaultRuleset } from "@/domain/content";
import type { CombatUnitInput, Tactic } from "@/domain/combat/types";
import { DEFAULT_SETTINGS } from "@/domain/settings";
import { zeroStats } from "@/domain/stats";
import { createRng } from "@/domain/util/rng";

export const ruleset = buildDefaultRuleset();
export const settings = DEFAULT_SETTINGS;
export const classIds = Object.keys(ruleset.classes);

export function makeUnit(id: string, classId: string, tactic: Tactic = "BALANCED", seed = id): CombatUnitInput {
  const cls = ruleset.classes[classId]!;
  const stats = computeEffectiveStats({
    classDef: cls,
    variation: rollVariation(createRng(`var-${seed}`), settings.character),
    telegram: zeroStats(),
    holdings: zeroStats(),
    loyalty: zeroStats(),
    trading: zeroStats(),
  });
  return { characterId: id, name: id, classId, tactic, stats: stats.total };
}

export function makeLineup(prefix = "u", size = 8): CombatUnitInput[] {
  return Array.from({ length: size }, (_, i) => makeUnit(`${prefix}${i}`, classIds[i % classIds.length]!));
}
