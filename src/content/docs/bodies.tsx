import type { ComponentType } from "react";

import Arena from "./pages/arena";
import ArenaPicks from "./pages/arena-picks";
import Claims from "./pages/claims";
import Classes from "./pages/classes";
import Faq from "./pages/faq";
import GettingStarted from "./pages/getting-started";
import HeroProfiles from "./pages/hero-profiles";
import Heroes from "./pages/heroes";
import GoldAndGear from "./pages/gold-and-gear";
import HolderBonus from "./pages/holder-bonus";
import Home from "./pages/home";
import Leaderboards from "./pages/leaderboards";
import PowerAndStats from "./pages/power-and-stats";
import Rarity from "./pages/rarity";
import Rewards from "./pages/rewards";

/** slug → page body. A test renders every entry and checks it against the registry (sections, ids, links). */
export const DOC_BODIES: Readonly<Record<string, ComponentType>> = {
  "": Home,
  "getting-started": GettingStarted,
  heroes: Heroes,
  classes: Classes,
  rarity: Rarity,
  "power-and-stats": PowerAndStats,
  "gold-and-gear": GoldAndGear,
  "hero-profiles": HeroProfiles,
  arena: Arena,
  "arena-picks": ArenaPicks,
  leaderboards: Leaderboards,
  rewards: Rewards,
  "holder-bonus": HolderBonus,
  claims: Claims,
  faq: Faq,
};
