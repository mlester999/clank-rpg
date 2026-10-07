import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Db } from "./types";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

export async function readMigrations(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => /^\d{14}_.+\.sql$/.test(n)).sort();
  const files: MigrationFile[] = [];
  for (const file of names) {
    const match = /^(\d{14})_(.+)\.sql$/.exec(file);
    if (!match) continue;
    files.push({ version: match[1]!, name: match[2]!, sql: await readFile(path.join(dir, file), "utf8") });
  }
  return files;
}

/**
 * Applies supabase/migrations/*.sql in order. It records progress in the SAME table the
 * Supabase CLI uses (`supabase_migrations.schema_migrations`), so `supabase db push` and
 * this runner can be mixed safely. Each migration runs in its own transaction.
 */
export interface MigrateOptions {
  /** Stop after this 14-digit version: later migrations are left pending (reported as `pending`). */
  upTo?: string;
  /** Report what would be applied without running anything (no DDL, no writes). */
  dryRun?: boolean;
}

export async function migrate(db: Db, dir = MIGRATIONS_DIR, opts: MigrateOptions = {}): Promise<{ applied: string[]; skipped: string[]; pending: string[] }> {
  if (opts.upTo !== undefined && !/^\d{14}$/.test(opts.upTo)) throw new Error(`--up-to needs a 14-digit migration version, got "${opts.upTo}".`);
  if (!opts.dryRun) {
    await db.exec(`
      create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (
        version text primary key,
        statements text[],
        name text
      );
    `);
  }
  // A dry run must not create the bookkeeping table: if it does not exist yet, nothing has been applied.
  const done = new Set(
    (await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations").catch(() => [])).map(
      (r) => r.version,
    ),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  const pending: string[] = [];
  for (const migration of await readMigrations(dir)) {
    if (done.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    if (opts.dryRun || (opts.upTo !== undefined && migration.version > opts.upTo)) {
      pending.push(migration.version);
      continue;
    }
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query(
        "insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)",
        [migration.version, migration.name],
      );
    });
    applied.push(migration.version);
  }
  return { applied, skipped, pending };
}
