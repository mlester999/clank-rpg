import { DEFAULT_SETTINGS, type GameSettings } from "@/domain/settings";
import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { withLatency } from "@/server/db/latency";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate } from "@/server/db/migrate";
import type { Db, Queryable } from "@/server/db/types";
import type { ArenaCtx } from "@/server/services/arena";
import { createCharacterForUser } from "@/server/services/characters";
import { seedReferenceData } from "@/server/seed/reference";

import { seedLegacyHeroes } from "./legacyHeroes";

/** Supabase ships these roles; plain Postgres (PGlite) doesn't, so create them BEFORE migrating. */
export const SUPABASE_ROLE_SHIM = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

/**
 * A DEVELOPMENT database in which the Arena is RUNNING — what an operator has after pressing START. Most tests exercise the running Arena (battles,
 * picks, settlement), so the helpers hand them that; a freshly migrated database is NOT_STARTED (nothing may run until the Admin starts it) and the
 * lifecycle tests ask for exactly that with `factoryArenaState`.
 */
export async function runArena(q: Queryable): Promise<void> {
  const [col] = await q.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'arena_state' and column_name = 'status'");
  if (!col) return; // a database from before the lifecycle migration: the Arena always ran
  const [row] = await q.query<{ status: string }>("select status from public.arena_state where id = 1");
  if (row?.status === "NOT_STARTED") await q.query("update public.arena_state set status = 'PREPARING' where id = 1");
  const [now] = await q.query<{ status: string }>("select status from public.arena_state where id = 1");
  if (now?.status === "PREPARING" || now?.status === "PAUSED" || now?.status === "PAUSE_REQUESTED") await q.query("update public.arena_state set status = 'RUNNING' where id = 1");
}

/** Puts the Arena back in the state a freshly migrated database has: NOT_STARTED, never advanced. (Only valid while nothing has been scheduled.) */
export async function factoryArenaState(q: Queryable): Promise<void> {
  const [row] = await q.query<{ status: string }>("select status from public.arena_state where id = 1");
  if (row?.status === "RUNNING") await q.query("update public.arena_state set status = 'PAUSED' where id = 1");
  if (row?.status === "PREPARING" || row?.status === "PAUSE_REQUESTED") await q.query("update public.arena_state set status = 'PAUSED' where id = 1");
  await q.query("update public.arena_state set status = 'NOT_STARTED', last_advance_at = null, started_at = null where id = 1");
}

export async function createTestDb(): Promise<Db> {
  const db = await createPgliteDb();
  await db.exec(SUPABASE_ROLE_SHIM);
  await migrate(db);
  await seedReferenceData(db);
  await runArena(db);
  return db;
}

/** A database migrated only up to (and including) `version` — e.g. "what LIVE holds before a pending migration". Reference data is seeded as at that schema. */
export async function createTestDbUpTo(version: string): Promise<Db> {
  const db = await createPgliteDb();
  await db.exec(SUPABASE_ROLE_SHIM);
  await migrate(db, undefined, { upTo: version });
  await seedReferenceData(db);
  await runArena(db); // (a no-op below the lifecycle migration: the Arena always ran there)
  return db;
}

/** Wipe all game state (including reference data) and re-seed — fast per-test isolation. */
export async function resetDb(db: Db): Promise<void> {
  const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
  await db.exec(`truncate table ${tables.map((t) => `public."${t.tablename}"`).join(", ")} restart identity cascade`);
  await db.exec("insert into public.arena_state (id) values (1)");
  await seedReferenceData(db);
  await runArena(db);
}

export class FakeClock {
  constructor(public ms = Date.UTC(2026, 9, 4, 12, 0, 0)) {}
  now = (): Date => new Date(this.ms);
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export function arenaCtx(clock: FakeClock, over: Partial<ArenaCtx> = {}): ArenaCtx {
  let n = 0;
  return { now: clock.now, secureSeed: () => `test-seed-${++n}`, allowDemo: true, ...over };
}

let nextTelegramId = 1000;
/** Creates `count` heroes directly (bypassing message ingestion) for arena-focused tests. */
export async function seedHeroes(db: Db, count: number, opts: { settings?: GameSettings; startId?: number; legacy?: boolean } = {}): Promise<string[]> {
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  if (opts.legacy) {
    // Heroes exactly as the FIRST generator made them (what the live database holds today): hero-gen/1 stats, cached stat-weight POWER, v1 INITIAL.
    const start = opts.startId ?? nextTelegramId;
    if (opts.startId === undefined) nextTelegramId += count;
    return (await seedLegacyHeroes(db, count, { startId: start, settings, origin: "TELEGRAM", secret: "test-secret-value-1234567890" })).map((h) => h.id);
  }
  const ids: string[] = [];
  const classes = await loadClasses(db);
  for (let i = 0; i < count; i++) {
    const tid = (opts.startId ?? nextTelegramId++) + (opts.startId ? i : 0);
    await db.query(
      `insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, activity_score, behavior)
       values ($1, $2, 120, $3, '{}'::jsonb) on conflict do nothing`,
      [tid, `Hero ${tid}`, (tid % 7) * 12],
    );
    const user = (await db.query("select * from public.telegram_users where telegram_user_id = $1", [tid]))[0] as never;
    const r = await createCharacterForUser(db, user, { settings, classes, secret: "test-secret-value-1234567890", origin: "TELEGRAM" });
    ids.push(r.characterId);
  }
  return ids;
}

const STUB_PARTS = { skin: 0, hairStyle: 0, hairColor: 0, eyes: 0, mouth: 0, accessory: 0, cape: false, aura: "none", outfitHue: 0 };

/**
 * Inserts a hero row with ANY columns a test needs (kind, telegram_user_id, class_id, name, status, origin, is_demo, level …) — plus what the
 * schema now demands of every hero: a stats row, an appearance row and the INITIAL v1, all in ONE transaction (the database refuses to commit a
 * hero without its version). Returns the hero id. Pass a `Db` (own transaction) or a transaction (joins it).
 */
export async function insertStubHero(q: Queryable | Db, columns: Record<string, unknown>): Promise<string> {
  const run = async (tx: Queryable): Promise<string> => {
    const names = Object.keys(columns);
    const [row] = await tx.query<{ id: string }>(
      `insert into public.characters (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      names.map((n) => columns[n]),
    );
    const id = (row as { id: string }).id;
    await tx.query("insert into public.character_stats (character_id, variation) values ($1, '{}'::jsonb)", [id]);
    await tx.query("insert into public.character_appearances (character_id, rarity, parts, seed) values ($1, 'COMMON', $2::jsonb, 'stub')", [id, JSON.stringify(STUB_PARTS)]);
    await tx.query("select public.hero_snapshot_initial_version($1, 'system:test')", [id]);
    return id;
  };
  return "transaction" in q ? q.transaction(run) : run(q);
}

export async function count(q: Queryable, table: string, where = "true"): Promise<number> {
  const rows = await q.query<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`);
  return rows[0]?.n ?? 0;
}

export { loadSettings, withLatency };

let nextEligible = 700_000;
/**
 * A REAL (non-demo) Telegram member for Arena Picks tests: `qualifying` messages and, by default, an ACTIVE hero — i.e. someone
 * who is eligible for rewarded picks. Options make them ineligible / flagged in exactly the ways the rules care about.
 */
export async function seedEligibleMember(
  db: Db,
  opts: { id?: number; qualifying?: number; hero?: boolean; heroStatus?: "ACTIVE" | "INACTIVE" | "SUSPENDED"; status?: "OK" | "FLAGGED" | "BANNED" } = {},
): Promise<number> {
  const id = opts.id ?? ++nextEligible;
  await db.query(
    "insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count, status) values ($1, $2, $3, $4) on conflict (telegram_user_id) do nothing",
    [id, `Member ${id}`, opts.qualifying ?? 150, opts.status ?? "OK"],
  );
  if (opts.hero !== false) {
    const [cls] = await db.query<{ id: string }>("select id from public.character_classes order by sort_order limit 1");
    const [existing] = await db.query<{ id: string }>("select id from public.characters where telegram_user_id = $1", [id]);
    if (!existing) await insertStubHero(db, { telegram_user_id: id, class_id: cls!.id, name: `Hero ${id}`, origin: "TELEGRAM", status: opts.heroStatus ?? "ACTIVE" });
  }
  return id;
}
