import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadClasses, loadSettings } from "@/server/config/settingsRepo";
import { createPgliteDb } from "@/server/db/pglite";
import { migrate, MIGRATIONS_DIR, readMigrations } from "@/server/db/migrate";
import type { Db } from "@/server/db/types";
import { seedReferenceData } from "@/server/seed/reference";
import { createCharacterForUser } from "@/server/services/characters";
import { HERO_SQL, rollNewHeroVersion, type MemberHero } from "@/server/services/heroFreeReroll";
import { claimCharacter } from "@/server/services/identity";

import { createTestDb, resetDb, seedHeroes, SUPABASE_ROLE_SHIM } from "../support/db";

/**
 * MIGRATION 3000 — the paid-reroll payment record. ONE forward-only file: a table, four guards and an auditor. It reads and rewrites nothing that exists.
 * What the database refuses by itself — whatever the application does — is pinned here with raw SQL.
 */
const PREVIOUS = "20261015002900";
const NEW = "20261015003000";
const FILE = `${NEW}_hero_paid_reroll.sql`;

describe("migration 3000 — placement and shape", () => {
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

  const snapshot = async () => {
    const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public' and tablename <> 'hero_paid_rerolls' order by 1");
    const out: Record<string, string> = {};
    for (const t of tables) out[t.tablename] = JSON.stringify(await db.query(`select * from public.${t.tablename} order by 1`));
    return out;
  };

  it("comes directly after 2900, ends by hardening the schema, and only ADDS (no drop, alter, update or delete of anything that exists)", async () => {
    const all = (await readMigrations()).map((m) => m.version);
    expect(all.indexOf(NEW)).toBe(all.indexOf(PREVIOUS) + 1);
    const sql = await readFile(path.join(MIGRATIONS_DIR, FILE), "utf8");
    expect(sql.trimEnd().endsWith("select public.clank_harden_schema();")).toBe(true);
    const code = sql.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    for (const forbidden of [/\bdrop\s+(table|column|constraint|trigger|function)\b/, /\balter\s+table\b/, /\bupdate\s+public\.(?!hero_paid_rerolls)/, /\bdelete\s+from\s+public\.(?!hero_paid_rerolls)/, /\btruncate\b/, /\binsert\s+into\s+public\.(?!hero_paid_rerolls)/]) expect(code).not.toMatch(forbidden);
    expect(code).toMatch(/create\s+table\s+public\.hero_paid_rerolls/);
    expect(code).toMatch(/unique \(tx_hash\)/);
    expect(sql).not.toMatch(/feature_flags/); // the flag is seeded by the reference data, disabled
  });

  it("applies on top of a database with heroes, changes no existing row, creates an empty table, and a second run is a no-op", async () => {
    const settings = await loadSettings(db);
    const classes = await loadClasses(db);
    for (const id of [201, 202, 203]) {
      await db.query("insert into public.telegram_users (telegram_user_id, display_name, qualifying_message_count) values ($1, $2, 120)", [id, `Member ${id}`]);
      const [user] = await db.query("select * from public.telegram_users where telegram_user_id = $1", [id]);
      await createCharacterForUser(db, user as never, { settings, classes, secret: "test-secret-value-1234567890", origin: "TELEGRAM" });
    }
    const before = await snapshot();
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([NEW]);
    expect(await snapshot()).toEqual(before);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls"))[0]!.n)).toBe(0);
    expect((await migrate(db, undefined, { upTo: NEW })).applied).toEqual([]);
    expect(await db.query("select * from public.audit_hero_paid_rerolls()")).toEqual([]);
  });

  it("the feature flag is seeded DISABLED by the reference data, never enabled by a migration", async () => {
    await migrate(db);
    await seedReferenceData(db);
    expect(await db.query<{ enabled: boolean }>("select enabled from public.feature_flags where key = 'hero.paid_reroll'")).toEqual([{ enabled: false }]);
  });
});

describe("migration 3000 — what the database refuses by itself", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await resetDb(db);
  });

  const uuid = () => crypto.randomUUID();
  const hash = () => `0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`;
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  let nextMember = 850_000;
  const member = async (): Promise<{ tid: number; hero: string }> => {
    const tid = nextMember++;
    const [hero] = await seedHeroes(db, 1, { startId: tid });
    await claimCharacter(db, tid, new Date());
    return { tid, hero: hero! };
  };
  /** A PAID credit row, inserted exactly as the service does. */
  const credit = (tid: number, hero: string, txHash = hash()) =>
    db.query(
      `insert into public.hero_paid_rerolls (telegram_user_id, character_id, tx_hash, payer_address, recipient_address, token_address, chain_id, amount_raw, price_tokens)
       values ($1, $2, $3, $4, $5, $6, 4663, 100000000000000000000000, '100000')`,
      [tid, hero, txHash, addr(1), addr(2), addr(3)],
    );
  const settings = async () => ({ settings: await loadSettings(db), classes: await loadClasses(db), secret: "test-secret-value-1234567890", allowDemo: true });

  it("has the single-use keys, the shape CHECK and the guards (insert · update · delete · the DEFERRED 'a paid version must have its payment' check on hero_versions)", async () => {
    const cons = await db.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.hero_paid_rerolls'::regclass order by conname");
    const byName = Object.fromEntries(cons.map((c) => [c.conname, c.def]));
    expect(byName.hero_paid_rerolls_tx_hash_key).toBe("UNIQUE (tx_hash)");
    expect(byName.hero_paid_rerolls_request_id_key).toBe("UNIQUE (request_id)");
    expect(byName.hero_paid_rerolls_hero_version_id_key).toBe("UNIQUE (hero_version_id)");
    expect(byName.hero_paid_rerolls_shape).toMatch(/status = 'PAID'/);
    const triggers = await db.query<{ tgname: string; tgrelid: string; deferrable: boolean; initdeferred: boolean }>(
      "select tgname, tgrelid::regclass::text as tgrelid, tgdeferrable as deferrable, tginitdeferred as initdeferred from pg_trigger where not tgisinternal and tgname like any (array['hero_paid_rerolls_%', 'hero_versions_member_paid_reroll_payment']) order by tgname",
    );
    expect(triggers.map((t) => t.tgname)).toEqual(["hero_paid_rerolls_guard_delete", "hero_paid_rerolls_guard_insert", "hero_paid_rerolls_guard_update", "hero_versions_member_paid_reroll_payment"]);
    expect(triggers.find((t) => t.tgname === "hero_versions_member_paid_reroll_payment")).toMatchObject({ tgrelid: "hero_versions", deferrable: true, initdeferred: true });
  });

  it("is hardened like every table: row-level security on, no policy, no browser-role privileges", async () => {
    const [t] = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where oid = 'public.hero_paid_rerolls'::regclass");
    expect(t!.relrowsecurity).toBe(true);
    expect(await db.query("select 1 from pg_policies where tablename = 'hero_paid_rerolls'")).toEqual([]);
    expect(await db.query("select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'hero_paid_rerolls' and grantee in ('anon', 'authenticated')")).toEqual([]);
  });

  it("one transaction hash is one payment: a second insert of it — by anyone — is refused", async () => {
    const a = await member();
    const b = await member();
    const h = hash();
    await credit(a.tid, a.hero, h);
    await expect(credit(a.tid, a.hero, h)).rejects.toThrow(/tx_hash|duplicate key/i);
    await expect(credit(b.tid, b.hero, h)).rejects.toThrow(/tx_hash|duplicate key/i);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls"))[0]!.n)).toBe(1);
  });

  it("a payment belongs to the hero's OWN member, is born PAID, and its facts are well-formed", async () => {
    const a = await member();
    const b = await member();
    await expect(credit(a.tid, b.hero)).rejects.toThrow(/own member/);
    await expect(db.query(`insert into public.hero_paid_rerolls (telegram_user_id, character_id, tx_hash, payer_address, recipient_address, token_address, chain_id, amount_raw, price_tokens, status) values ($1, $2, $3, $4, $4, $4, 1, 5, '1', 'APPLIED')`, [a.tid, a.hero, hash(), addr(1)])).rejects.toThrow();
    await expect(db.query(`insert into public.hero_paid_rerolls (telegram_user_id, character_id, tx_hash, payer_address, recipient_address, token_address, chain_id, amount_raw, price_tokens) values ($1, $2, '0xnothash', $3, $3, $3, 1, 5, '1')`, [a.tid, a.hero, addr(1)])).rejects.toThrow(/tx_hash/);
    await expect(db.query(`insert into public.hero_paid_rerolls (telegram_user_id, character_id, tx_hash, payer_address, recipient_address, token_address, chain_id, amount_raw, price_tokens) values ($1, $2, $3, $4, $4, $4, 1, 0, '1')`, [a.tid, a.hero, hash(), addr(1)])).rejects.toThrow(/amount_raw/);
  });

  it("a credit can only become APPLIED against a REAL paid reroll of its own hero: a free reroll's version, a made-up version and altered facts are all refused", async () => {
    const { tid, hero } = await member();
    const h = hash();
    await credit(tid, hero, h);
    const [v1] = await db.query<{ id: string }>("select id from public.hero_versions where character_id = $1 and version_number = 1", [hero]);
    // pointing at the INITIAL version (not a paid reroll)
    await expect(
      db.query(
        `update public.hero_paid_rerolls set status = 'APPLIED', request_id = $2, hero_version_id = $3, previous_version_id = $3, from_class_id = 'x', from_rarity = 'COMMON', from_power = 1, to_class_id = 'x', to_rarity = 'COMMON', to_power = 1, applied_at = now(), utc_day = (now() at time zone 'UTC')::date where tx_hash = $1`,
        [h, uuid(), v1!.id],
      ),
    ).rejects.toThrow();
    // the payment facts are immutable, even on a credit
    await expect(db.query("update public.hero_paid_rerolls set amount_raw = 1 where tx_hash = $1", [h])).rejects.toThrow(/PAID to APPLIED|immutable/);
    await expect(db.query("update public.hero_paid_rerolls set status = 'PAID', tx_hash = $2 where tx_hash = $1", [h, hash()])).rejects.toThrow();
    const [row] = await db.query<{ status: string }>("select status from public.hero_paid_rerolls where tx_hash = $1", [h]);
    expect(row!.status).toBe("PAID");
  });

  it("a payment record is never deleted by hand, but goes with its hero", async () => {
    const { tid, hero } = await member();
    await credit(tid, hero);
    await expect(db.query("delete from public.hero_paid_rerolls")).rejects.toThrow(/append-only/);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_paid_rerolls"))[0]!.n)).toBe(1);
  });

  it("a hero version made by a PAID reroll cannot commit without its applied payment — a reroll that is not paid for cannot exist", async () => {
    const { tid, hero } = await member();
    const deps = await settings();
    const before = Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1", [hero]))[0]!.n);
    await expect(
      db.transaction(async (tx) => {
        const [h] = await tx.query<MemberHero>(`${HERO_SQL} for update of c`, [tid]);
        await rollNewHeroVersion(tx, h!, uuid(), `member-paid:${tid}`, deps);
      }),
    ).rejects.toThrow(/must consume a verified payment/);
    expect(Number((await db.query<{ n: number }>("select count(*)::int as n from public.hero_versions where character_id = $1", [hero]))[0]!.n)).toBe(before);
    expect(await db.query("select * from public.audit_hero_paid_rerolls()")).toEqual([]);
  });

  it("the auditor reports a paid-looking version that has no payment", async () => {
    const { tid, hero } = await member();
    const deps = await settings();
    // Forge the violation by switching the triggers off for ONE transaction (`session_replication_role` is superuser-only, which is exactly why the application cannot).
    await db.transaction(async (tx) => {
      await tx.exec("set local session_replication_role = replica");
      const [h] = await tx.query<MemberHero>(`${HERO_SQL} for update of c`, [tid]);
      await rollNewHeroVersion(tx, h!, uuid(), `member-paid:${tid}`, deps);
    });
    const found = await db.query<{ ref: string; problem: string }>("select ref, problem from public.audit_hero_paid_rerolls()");
    expect(found.map((f) => f.problem)).toEqual(["PAID_VERSION_WITHOUT_PAYMENT"]);
    expect(found[0]!.ref.startsWith(hero)).toBe(true);
  });
});
