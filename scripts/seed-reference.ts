import { seedReferenceData } from "../src/server/seed/reference";

import { run } from "./lib/context";

void run(async ({ db }) => {
  console.log("reference data inserted:", (await seedReferenceData(db)).inserted);
});
