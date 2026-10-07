/** Deletes the local embedded database (.data/pglite). Refuses if DATABASE_URL is set. */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

import { loadLocalEnv } from "./lib/context";

loadLocalEnv();
if (process.env.DATABASE_URL) {
  console.error("DATABASE_URL is set — refusing to touch a remote database. Unset it to reset the local store.");
  process.exit(1);
}
const dir = path.join(process.cwd(), ".data", "pglite");
if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true });
  console.log(`removed ${dir}`);
} else {
  console.log("nothing to remove");
}
