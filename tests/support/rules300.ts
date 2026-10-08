import { PRE_ENGAGEMENT_RULES_VERSION, validateRuleset, type Ruleset } from "@/domain/rules";
import { OVERTIME_300 } from "@/domain/settings";

/**
 * A ruleset exactly as rules 3.0.0 stored it with a battle: WITHOUT the 3.1.0 `combat.engagement` block (it did not exist), with the 3.0.0 overtime
 * (28 s · 0.16/s — 3.1.0 keeps it; pinned here so this stays the 3.0.0 snapshot whatever today's default), version "3.0.0". Every battle fought
 * under 3.0.0 carries such a snapshot, and must keep producing its pinned event hash forever. (Classes and skills did not change between 3.0.0
 * and 3.1.0.)
 */
export function rules300Stored(r: Ruleset): Record<string, unknown> {
  const { engagement: _engagement, ...combat } = r.combat;
  void _engagement;
  return JSON.parse(JSON.stringify({ ...r, rulesVersion: PRE_ENGAGEMENT_RULES_VERSION, combat: { ...combat, overtime: { ...OVERTIME_300 } } })) as Record<string, unknown>;
}

/** Loaded the way a replay loads it (`loadRulesetSnapshot` → `validateRuleset`). */
export const rules300Ruleset = (r: Ruleset): Ruleset => validateRuleset(rules300Stored(r));
