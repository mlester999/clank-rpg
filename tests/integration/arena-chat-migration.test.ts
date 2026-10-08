import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPgliteDb } from "@/server/db/pglite";
import { migrate, MIGRATIONS_DIR, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";

import { SUPABASE_ROLE_SHIM } from "../support/db";

const PREVIOUS = "20261007002300";
const NEW = "20261008002400";
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await db.exec(SUPABASE_ROLE_SHIM);
  await migrate(db, undefined, { upTo: PREVIOUS });
  await seedReferenceData(db);
});
afterEach(async () => {
  await db.close();
});

const counts = async () => {
  const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename not like 'arena_chat_%' order by 1");
  const out: Record<string, number> = {};
  for (const t of tables) out[t.tablename] = (await db.query<{ n: number }>(`select count(*)::int as n from public.${t.tablename}`))[0]!.n;
  return out;
};

describe("migration 2400 — Arena Chat (ONE focused migration)", () => {
  it("is the highest migration, directly after 2300, and the only new file for the chat", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.at(-1)).toBe(NEW);
    expect(all.at(-2)).toBe(PREVIOUS);
    expect(all.filter((v) => v > PREVIOUS)).toEqual([NEW]);
    expect((await readFile(path.join(MIGRATIONS_DIR, `${NEW}_arena_chat.sql`), "utf8")).trimEnd().endsWith("select public.clank_harden_schema();")).toBe(true);
  });

  it("adds the chat on top of a database that has the earlier migrations, and changes nothing that already exists", async () => {
    await db.query("insert into public.telegram_users (telegram_user_id, display_name) values (4242, 'Existing member')");
    const before = await counts();
    const result = await migrate(db);
    expect(result.applied).toEqual([NEW]);
    expect(await counts()).toEqual(before); // no existing table gained or lost a row
    expect((await db.query("select 1 from public.telegram_users where telegram_user_id = 4242")).length).toBe(1);
    const created = (await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename like 'arena_chat_%' order by 1")).map((t) => t.tablename);
    expect(created).toEqual(["arena_chat_messages", "arena_chat_mutes"]);
    // running it again is a no-op (the runner skips what is recorded)
    expect((await migrate(db)).applied).toEqual([]);
  });

  it("does not touch the hero, Arena, reward or season data in any way (it only adds tables, an index and a policy)", async () => {
    const sql = await readFile(path.join(MIGRATIONS_DIR, `${NEW}_arena_chat.sql`), "utf8");
    const statements = sql.split("\n").filter((l) => !l.trimStart().startsWith("--"));
    const code = statements.join("\n").toLowerCase();
    for (const forbidden of [/\bdrop\s+table\b/, /\balter\s+table\s+public\.(?!arena_chat_)/, /\bupdate\s+public\./, /\bdelete\s+from\b/, /\btruncate\b/, /\binsert\s+into\s+public\.(?!arena_chat_)/]) expect(code).not.toMatch(forbidden);
    expect(code).toMatch(/create\s+table\s+public\.arena_chat_messages/);
    expect(code).toMatch(/create\s+table\s+public\.arena_chat_mutes/);
  });

  it("does not need a Supabase project: on plain Postgres (no realtime schema) it applies and creates no policy", async () => {
    expect((await db.query("select 1 from pg_namespace where nspname = 'realtime'")).length).toBe(0);
    await migrate(db);
    expect((await db.query("select 1 from pg_policies where tablename = 'messages'")).length).toBe(0);
    expect(await db.query("select 1 from pg_policies where schemaname = 'public'")).toEqual([]);
  });
});

describe("migration 2400 — the Realtime policy on a Supabase project", () => {
  /** What a Supabase project has: `realtime.messages` with RLS on, `realtime.topic()` reading the channel being joined. */
  const supabaseRealtime = `
    create schema realtime;
    create table realtime.messages (id bigint generated always as identity, topic text not null, extension text not null, payload jsonb);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    grant usage on schema realtime to anon, authenticated, service_role;
    grant select, insert on realtime.messages to anon, authenticated;
  `;
  const as = async <T>(role: string, topic: string, fn: () => Promise<T>): Promise<T> => {
    await db.exec(`set role ${role}`);
    await db.exec(`select set_config('realtime.topic', '${topic}', false)`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role");
      await db.exec("select set_config('realtime.topic', '', false)");
    }
  };

  it("lets anyone LISTEN to the chat topic (broadcast only), and nobody — signed in or not — PUBLISH from a browser", async () => {
    await db.exec(supabaseRealtime);
    await migrate(db);
    const policies = await db.query<{ policyname: string; cmd: string; roles: string[] }>("select policyname, cmd, roles from pg_policies where schemaname = 'realtime' and tablename = 'messages'");
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ cmd: "SELECT" });
    expect([...policies[0]!.roles].sort()).toEqual(["anon", "authenticated"]);

    await db.query("insert into realtime.messages (topic, extension, payload) values ('realtime:arena-chat', 'broadcast', '{}'), ('realtime:arena-chat', 'presence', '{}')");
    for (const role of ["anon", "authenticated"]) {
      const listen = await as(role, "arena-chat", () => db.query<{ extension: string }>("select extension from realtime.messages order by 1"));
      expect(listen.map((r) => r.extension), `${role} may listen to the chat`).toEqual(["broadcast"]); // presence is not offered
      expect(await as(role, "some-other-room", () => db.query("select 1 from realtime.messages")), `${role} may not listen to another topic`).toEqual([]);
      expect(await as(role, "", () => db.query("select 1 from realtime.messages"))).toEqual([]);
      const publish = await as(role, "arena-chat", () => db.query("insert into realtime.messages (topic, extension, payload) values ('realtime:arena-chat', 'broadcast', '{\"forged\":true}')").then(() => "published", (e: Error) => e.message));
      expect(publish, `${role} must not publish`).toMatch(/row-level security/);
    }
    expect((await db.query<{ n: number }>("select count(*)::int as n from realtime.messages"))[0]!.n).toBe(2);
  });

  it("is repeatable (running the policy statement again replaces it) and never blocks the migration if the policy cannot be created", async () => {
    // a `realtime.messages` that cannot carry a policy (a view): the migration must still complete, saying what to do by hand
    await db.exec("create schema realtime; create view realtime.messages as select 1 as id;");
    const result = await migrate(db);
    expect(result.applied).toEqual([NEW]);
    expect((await db.query("select 1 from supabase_migrations.schema_migrations where version = $1", [NEW])).length).toBe(1);
    expect((await db.query("select 1 from pg_tables where tablename = 'arena_chat_messages'")).length).toBe(1);
  });
});
