/**
 * Re-simulates stored battles from their frozen snapshot + seed + ruleset snapshot and checks
 * the result hash — the integrity guarantee the reward settlement depends on.
 *
 *   pnpm battle:verify -- --last 50
 *   pnpm battle:verify -- <battle-uuid>
 */
import { replayBattle } from "../src/server/services/arena";

import { run } from "./lib/context";

void run(async ({ db }) => {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const lastIdx = args.indexOf("--last");
  const ids =
    lastIdx >= 0
      ? (await db.query<{ id: string }>("select id from public.arena_battles where status in ('SIMULATED','SETTLED') order by sequence desc limit $1", [Number(args[lastIdx + 1]) || 20])).map((r) => r.id)
      : args.filter((a) => /^[0-9a-f-]{36}$/i.test(a));
  if (!ids.length) throw new Error("no battles selected (pass --last N or a battle id)");
  let bad = 0;
  for (const id of ids) {
    try {
      const r = await replayBattle(db, id, { frames: false });
      console.log(`${r ? "OK  " : "SKIP"} ${id}${r ? `  hash ${r.outcome.eventsHash.slice(0, 16)}…  ${r.outcome.durationMs}ms  ${r.outcome.endedBy}` : ""}`);
    } catch (error) {
      bad++;
      console.log(`FAIL ${id}  ${error instanceof Error ? error.message : error}`);
    }
  }
  if (bad) {
    process.exitCode = 1;
    console.log(`${bad} battle(s) failed verification`);
  } else {
    console.log(`all ${ids.length} battle(s) reproduced exactly`);
  }
});
