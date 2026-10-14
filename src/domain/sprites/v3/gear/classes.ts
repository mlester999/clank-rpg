import type { ClassRig } from "../anatomy";

import { clericLoadout } from "./cleric";
import type { ClassLoadout } from "./loadout";
import { mageLoadout } from "./mage";
import { rangerLoadout } from "./ranger";
import { rogueLoadout } from "./rogue";
import { tankLoadout } from "./tank";
import { warriorLoadout } from "./warrior";

/** Each class's loadout builder (its design pools per tier). */
export const CLASS_LOADOUTS: Record<ClassRig, ClassLoadout> = {
  warrior: warriorLoadout,
  tank: tankLoadout,
  rogue: rogueLoadout,
  ranger: rangerLoadout,
  mage: mageLoadout,
  cleric: clericLoadout,
};
