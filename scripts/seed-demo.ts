/**
 * LOCAL DEMO HEROES — clearly labelled, never mistaken for community data.
 *
 *  - Telegram ids are NEGATIVE (real ids are positive, a CHECK constraint enforces the split).
 *  - Heroes have origin DEV_SEED / is_demo = true; the UI shows a DEMO badge and the arena only
 *    queues them when demo heroes are allowed (local dev, or CLANK_ALLOW_DEMO_HEROES=true).
 *  - No fake message counts are written: their Telegram activity is zero.
 *
 * Refuses to run in production or against a configured DATABASE_URL unless explicitly confirmed.
 *   pnpm db:seed:demo -- --count 40 [--start-arena]
 */
import { loadClasses, loadSettings } from "../src/server/config/settingsRepo";
import { getEnv } from "../src/server/env";
import { migrate } from "../src/server/db/migrate";
import { seedReferenceData } from "../src/server/seed/reference";
import { createCharacterForUser, type TelegramUserRow } from "../src/server/services/characters";

import { run } from "./lib/context";

const NAMES = [
  "Gearbox Gus", "Rivet", "Sprocket Sue", "Piston Pete", "Cog Cadet", "Lady Lathe", "Boltcutter", "Dynamo Dan", "Torque Tina", "Welder Wren",
  "Flywheel", "Crankshaft Kai", "Pinion Pia", "Ratchet Rex", "Grease Monkey", "Anvil Ada", "Bellows Bo", "Turbine Tess", "Clutch", "Gantry Gil",
  "Furnace Finn", "Soldier Sol", "Hammer Hana", "Lever Lou", "Vice Vera", "Steamfitter", "Chisel Chen", "Axle Axel", "Brass Bruno", "Copper Cleo",
  "Ember Ellis", "Forge Fay", "Gasket Gale", "Hinge Hugo", "Ironclad Ivy", "Jack Jolt", "Kettle Kit", "Lathe Lars", "Mallet Mae", "Nozzle Nia",
  "Oil Otto", "Plate Pax", "Quench Quin", "Rotor Rue", "Spindle", "Tong Teo", "Union Uma", "Valve Val", "Winch Wes", "Yoke Yara",
];

void run(async ({ db, target }) => {
  const env = getEnv();
  if (env.isProduction) throw new Error("Refusing to seed demo heroes with NODE_ENV=production.");
  const confirmed = process.argv.includes("--yes-this-is-not-production");
  if (env.DATABASE_URL && !confirmed) {
    throw new Error(`Refusing to seed demo heroes into ${target}. Re-run with --yes-this-is-not-production if this is a disposable database.`);
  }
  const idx = process.argv.indexOf("--count");
  const count = Math.min(Math.max(Number(idx >= 0 ? process.argv[idx + 1] : 40) || 40, 8), 400);

  await migrate(db);
  await seedReferenceData(db);
  const settings = await loadSettings(db);
  const classes = await loadClasses(db);
  let created = 0;
  for (let i = 0; i < count; i++) {
    const id = -(9_000_000 + i); // negative = demo, can never collide with a real Telegram id
    const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : "");
    await db.query(
      `insert into public.telegram_users (telegram_user_id, display_name, is_demo, behavior) values ($1, $2, true, $3::jsonb) on conflict do nothing`,
      [id, name, JSON.stringify({ msgs: 0 })],
    );
    const [user] = await db.query<TelegramUserRow>("select * from public.telegram_users where telegram_user_id = $1", [id]);
    if (!user) throw new Error("demo telegram user missing");
    const result = await createCharacterForUser(db, user, { settings, classes, secret: "demo-seed-only-not-a-real-secret-0000", origin: "DEV_SEED" });
    if (!result.created) continue;
    created++;
  }
  console.log(`created ${created} DEMO heroes (existing demo heroes were left untouched).`);
  // A database that has not been started does NOT run by itself (the Arena's runtime status is persisted): START is an Admin action. For a disposable local
  // database, `--start-arena` presses it for you (NOT_STARTED → PREPARING; the next advance prepares Battle #1).
  if (process.argv.includes("--start-arena")) {
    const moved = await db.query("update public.arena_state set status = 'PREPARING' where id = 1 and status = 'NOT_STARTED' and exists (select 1 from public.seasons where status = 'ACTIVE') returning id");
    console.log(moved.length ? "Arena started (PREPARING): Battle #1 is prepared by the first advance." : "Arena was already started (or has no active season) — nothing to do.");
  } else {
    console.log("The Arena is NOT STARTED: open Admin → Game control → Start Arena (or re-run this with --start-arena on a disposable database).");
  }
  console.log("Start the app (pnpm dev). The heroes are labelled DEMO in the UI.");
});
