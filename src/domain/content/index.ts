import { rulesVersionFor, validateRuleset, type Ruleset } from "../rules";
import { DEFAULT_SETTINGS } from "../settings";

import { DEFAULT_CLASSES } from "./classes";
import { DEFAULT_SKILLS } from "./skills";

export { DEFAULT_CLASSES } from "./classes";
export { DEFAULT_SKILLS } from "./skills";
export { DEFAULT_ACHIEVEMENTS } from "./achievements";
export { generateDefaultItems } from "./items";

/** The ruleset assembled from the code defaults (used for seeding, tests and the balance harness). */
export function buildDefaultRuleset(): Ruleset {
  return validateRuleset({
    rulesVersion: rulesVersionFor(DEFAULT_SETTINGS.combat),
    combat: DEFAULT_SETTINGS.combat,
    classes: Object.fromEntries(DEFAULT_CLASSES.map((c) => [c.id, c])),
    skills: Object.fromEntries(DEFAULT_SKILLS.map((s) => [s.id, s])),
  });
}
