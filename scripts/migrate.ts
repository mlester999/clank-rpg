/**
 * Applies supabase/migrations/*.sql, then seeds reference data (idempotent, never overwrites
 * admin edits). Records progress in supabase_migrations.schema_migrations, so it interoperates
 * with `supabase db push`. Works against DATABASE_URL (Supabase) or the local PGlite store.
 * No Docker involved.
 *
 *   pnpm db:migrate                                  every pending migration, then reference data
 *   pnpm db:migrate -- --dry-run                     list what WOULD be applied; changes nothing
 *   pnpm db:migrate -- --up-to 20261005000800        apply pending migrations up to and including that version
 *                                                    ONLY, leave later ones pending, skip reference data
 */
import { migrate, readMigrations } from "../src/server/db/migrate";
import { seedReferenceData } from "../src/server/seed/reference";

import { run } from "./lib/context";

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

void run(async ({ db }) => {
  const dryRun = process.argv.includes("--dry-run");
  const upTo = flag("--up-to");
  if (process.argv.includes("--up-to") && !upTo) throw new Error("--up-to needs a version, e.g. --up-to 20261005000800");

  const result = await migrate(db, undefined, { ...(upTo ? { upTo } : {}), dryRun });
  const due = upTo ? result.pending.filter((v) => v <= upTo) : result.pending;
  const left = upTo ? result.pending.filter((v) => v > upTo) : [];
  if (dryRun) {
    const files = new Map((await readMigrations()).map((m) => [m.version, `${m.version}_${m.name}.sql`]));
    const names = (versions: string[]) => versions.map((v) => files.get(v) ?? v);
    console.log("DRY RUN — nothing was changed.");
    console.log(`Would apply in order (${due.length}): ${names(due).length ? names(due).join(", ") : "none (up to date)"}`);
    console.log(`Already applied (${result.skipped.length}): ${names(result.skipped).join(", ") || "none"}`);
    if (left.length) console.log(`Would leave pending (beyond --up-to): ${names(left).join(", ")}`);
    return;
  }
  console.log(`migrations applied: ${result.applied.length ? result.applied.join(", ") : "none (up to date)"}  (already applied: ${result.skipped.length})`);
  if (left.length) console.log(`left pending on purpose (beyond --up-to): ${left.join(", ")}`);
  if (upTo) {
    console.log("reference data NOT seeded (--up-to applies migrations only).");
    return;
  }
  const seeded = await seedReferenceData(db);
  console.log("reference data inserted:", seeded.inserted);
});
