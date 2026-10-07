import { LEGACY_RING_RULES_VERSION, validateRuleset, type Ruleset } from "@/domain/rules";

import { rules200Stored } from "./rules200";

/** The retired storm ring, exactly as rules 1.0.0 shipped it. Used ONLY to prove old stored battles still replay. */
export const LEGACY_RING = { startMs: 6000, endMs: 18_000, minRadius: 80, damagePctPerSec: 0.06, damageRampPerSec: 0.02 } as const;

/** A ruleset as it was stored with a battle under rules 1.0.0 (ring included, with the pre-3.0.0 combat numbers it was pinned with). */
export function legacyRingRuleset(r: Ruleset): Ruleset {
  const stored = rules200Stored(r);
  return validateRuleset({ ...stored, rulesVersion: LEGACY_RING_RULES_VERSION, combat: { ...(stored.combat as object), ring: { ...LEGACY_RING } } });
}
