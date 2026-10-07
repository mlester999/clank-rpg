import { validateRuleset, type Ruleset } from "@/domain/rules";

/**
 * The combat numbers of rules 2.0.0 (static arena, 30 s cap), frozen exactly as they shipped BEFORE the longer-fight retune that
 * became rules 3.0.0. A battle stores the ruleset it was simulated with, so these are what an old stored battle carries — and
 * they must keep producing the pinned event hashes forever. They are deliberately NOT derived from `DEFAULT_SETTINGS`.
 * (Classes and skills did not change between 2.0.0 and 3.0.0, so the current ones complete the ruleset.)
 */
export const RULES_200_COMBAT_NUMBERS = {
  hpScale: 1.5,
  atkPerStr: 1.0,
  atkPerInt: 1.0,
  overtime: { startMs: 10_000, damageRampPerSec: 0.08 },
} as const;

/** The raw JSON a 2.0.0 battle stored: NO `pace` key at all (it did not exist), the 2.0.0 numbers, version "2.0.0". */
export function rules200Stored(r: Ruleset): Record<string, unknown> {
  const { pace: _pace, ...combat } = r.combat;
  void _pace;
  return JSON.parse(
    JSON.stringify({
      ...r,
      rulesVersion: "2.0.0",
      combat: {
        ...combat,
        hpScale: RULES_200_COMBAT_NUMBERS.hpScale,
        derive: { ...r.combat.derive, atkPerStr: RULES_200_COMBAT_NUMBERS.atkPerStr, atkPerInt: RULES_200_COMBAT_NUMBERS.atkPerInt },
        overtime: { ...RULES_200_COMBAT_NUMBERS.overtime },
      },
    }),
  ) as Record<string, unknown>;
}

/** The same ruleset loaded the way a replay loads it (`loadRulesetSnapshot` → `validateRuleset`): pace is restored to its 1 / 1 default. */
export const rules200Ruleset = (r: Ruleset): Ruleset => validateRuleset(rules200Stored(r));
