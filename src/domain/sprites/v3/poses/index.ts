import type { ArchetypeId } from "../anatomy";
import type { PoseLibrary } from "../clips";

import { BATTLEMAGE, MONK, PRIEST, SAGE, SCHOLAR, TEMPLAR } from "./casters";
import { SCOUT, SKIRMISHER, WARDEN } from "./ranger";
import { ASSASSIN, BRAWLER, CUTTHROAT } from "./rogue";
import { BULWARK, JUGGERNAUT, SENTINEL } from "./tank";
import { BRUTE, DUELIST, VANGUARD } from "./warrior";

/** The pose library of every archetype (each its own stance, gait, attack, cast, reactions, fall and victory). */
const LIBS: Record<ArchetypeId, PoseLibrary> = {
  warrior: VANGUARD,
  "warrior-brute": BRUTE,
  "warrior-duelist": DUELIST,
  tank: BULWARK,
  "tank-juggernaut": JUGGERNAUT,
  "tank-sentinel": SENTINEL,
  rogue: CUTTHROAT,
  "rogue-assassin": ASSASSIN,
  "rogue-brawler": BRAWLER,
  ranger: SCOUT,
  "ranger-warden": WARDEN,
  "ranger-skirmisher": SKIRMISHER,
  mage: SCHOLAR,
  "mage-battle": BATTLEMAGE,
  "mage-sage": SAGE,
  cleric: PRIEST,
  "cleric-templar": TEMPLAR,
  "cleric-monk": MONK,
};

export function libraryOf(a: ArchetypeId): PoseLibrary {
  return LIBS[a] ?? VANGUARD;
}
