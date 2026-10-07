/**
 * Repairs jsonb columns that hold a JSON *string* instead of an object (written by the old postgres.js adapter).
 * Dry run by default (read-only transaction); --apply repairs in ONE transaction, all-or-nothing, and records an
 * audit entry. Safe to run repeatedly.
 *
 *   pnpm db:repair-jsonb            # report only
 *   pnpm db:repair-jsonb --apply
 */
import { audit } from "../src/server/services/admin";
import { repairDoubleEncodedJsonb, scanDoubleEncodedJsonb } from "../src/server/services/repairJsonb";

import { run } from "./lib/context";

void run(async ({ db, target }) => {
  const apply = process.argv.includes("--apply");
  const found = await db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    return scanDoubleEncodedJsonb(tx);
  });
  if (found.length === 0) {
    console.log("nothing to repair — no double-encoded jsonb values.");
    return;
  }
  for (const f of found) console.log(`  ${`${f.table}.${f.column}`.padEnd(40)} ${f.affected} row(s)`);
  if (!apply) {
    console.log(`\nDRY RUN against ${target} — nothing changed. Re-run with --apply to repair.`);
    return;
  }
  const done = await repairDoubleEncodedJsonb(db);
  await audit(db, "cli", "db.repair_jsonb", "database", "public", { repaired: done });
  console.log(`\nrepaired ${done.reduce((n, f) => n + f.affected, 0)} value(s) in ${done.length} column(s).`);
});
