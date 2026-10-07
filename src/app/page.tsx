import { loadClasses } from "@/server/config/settingsRepo";
import { demoHeroesAllowed } from "@/server/env";
import { getPicksRewardDto } from "@/server/rewards/pool";
import { advanceForPage, getReadyDb, getSettings, isFlagOn } from "@/server/runtime";
import { getArenaState, type ArenaStateDto } from "@/server/services/views";

import { ArenaScreen } from "@/components/arena/ArenaScreen";

export const dynamic = "force-dynamic";

async function initialState(): Promise<ArenaStateDto | null> {
  try {
    await advanceForPage();
    const db = await getReadyDb();
    const settings = await getSettings();
    return await getArenaState(db, Date.now(), settings, { allowDemo: demoHeroesAllowed(), classes: await loadClasses(db, false), picksEnabled: await isFlagOn("arena.picks"), reward: await getPicksRewardDto(db, settings, Date.now()) });
  } catch (error) {
    console.error("[home] could not load arena state", error);
    return null;
  }
}

export default async function ArenaPage() {
  return <ArenaScreen initial={await initialState()} />;
}
