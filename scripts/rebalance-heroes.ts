/**
 * SYSTEM REBALANCE of existing heroes onto the rarity power system (hero generator 2).
 *
 *   pnpm exec tsx scripts/rebalance-heroes.ts                         # DRY RUN (default): computes every hero's rebalanced version, writes nothing
 *   pnpm exec tsx scripts/rebalance-heroes.ts --apply --expect-heroes N   # appends one SYSTEM_REBALANCE version per hero due
 *
 * What it does to a hero (see src/domain/hero/rebalance.ts): same hero, owner, public URL, class, RARITY and identity; stats/PWR fitted
 * into the hero's rarity band, rarity layers added — appended as a NEW version. It never re-rolls, never changes rarity or class, never
 * touches a historical version (v1 stays byte-identical), never reads or writes Arena results.
 *
 * DRY RUN reads in `SET TRANSACTION READ ONLY` transactions (enforced by Postgres), so it is safe against any database, live included.
 * It also proves the rebalance is DETERMINISTIC (every hero is computed twice and compared) and that every result is inside its band.
 *
 * --apply additionally requires: migration 20261006001900 applied, `--expect-heroes N` equal to the number of heroes due (pins the run to
 * the dry run you reviewed), and no hero left outside its band. Heroes sitting in an unsettled Arena roster are DEFERRED (reported, not
 * touched) — run again later; the run is idempotent (a rebalanced hero is skipped).
 *
 * Flags: --apply · --expect-heroes <n> · --report <path.json> · --include-demo (demo heroes are skipped by default)
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { isPowerInBand, RARITY_RULES } from "../src/domain/hero/rarity";
import { isLegacyGenerator } from "../src/domain/hero/heroVersion";
import { rebalanceHeroState } from "../src/domain/hero/rebalance";
import { RARITIES, type Rarity } from "../src/domain/character/appearance";
import { createPostgresDb } from "../src/server/db/postgres";
import { getEnv } from "../src/server/env";
import { loadClasses, loadSettings } from "../src/server/config/settingsRepo";
import { rowToState, VERSION_COLUMNS, type HeroVersionRow } from "../src/server/services/heroVersionStore";
import { HeroVersionError, rebalanceHero, type RebalanceResult } from "../src/server/services/heroVersions";

import { run } from "./lib/context";

const MIGRATION_VERSION = "20261006001900";
const args = process.argv.slice(2).filter((a) => a !== "--");
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const h = (title: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 70 - title.length))}`);
const line = (label: string, value: string | number) => console.log(`  ${label.padEnd(54)} ${value}`);
const q = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};

interface PlanRow {
  characterId: string;
  publicId: string;
  classId: string;
  rarity: Rarity;
  fromVersion: number;
  fromPower: number;
  toPower: number;
  inBand: boolean;
  deterministic: boolean;
  keepsIdentity: boolean;
}

void run(async (ctx) => {
  const env = getEnv();
  let db = ctx.db;
  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL);
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "5432") u.port = "6543"; // short transactions → the transaction pooler
    await db.close();
    db = createPostgresDb(u.toString(), { maxConnections: 1 });
    ctx.close = () => db.close();
    console.log(`→ LIVE postgres://…@${u.host}${u.pathname} (short transactions)`);
  }
  const apply = flag("apply");
  const includeDemo = flag("include-demo");
  const ro = <T>(fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(async (tx) => { await tx.exec("SET TRANSACTION READ ONLY"); return fn(tx); });

  h(apply ? "APPLY (appends SYSTEM_REBALANCE versions)" : "DRY RUN (read-only: nothing is written)");

  const migrations = await ro((tx) => tx.query<{ version: string }>("select version from supabase_migrations.schema_migrations").catch(() => [] as Array<{ version: string }>));
  const migrationApplied = migrations.some((m) => m.version === MIGRATION_VERSION);
  line(`migration ${MIGRATION_VERSION} (rarity power) applied`, migrationApplied ? "yes" : "NO — the SYSTEM_REBALANCE action does not exist yet");

  const settings = await ro((tx) => loadSettings(tx));
  const classes = await ro((tx) => loadClasses(tx, false));
  const rows = await ro((tx) =>
    tx.query<HeroVersionRow & { hero_id: string; public_id: string; hero_kind: string; is_demo: boolean }>(
      `select c.id as hero_id, c.public_id, c.kind as hero_kind, c.is_demo, ${VERSION_COLUMNS.split(", ").map((col) => `v.${col}`).join(", ")}
         from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id
        order by c.created_at, c.id`,
    ),
  );

  const community = rows.filter((r) => r.hero_kind === "COMMUNITY" && (includeDemo || !r.is_demo));
  const legacy = community.filter((r) => isLegacyGenerator(r.generator_version));
  const already = community.length - legacy.length;
  line("heroes (current versions) read", rows.length);
  line("community heroes in scope", community.length);
  line("already on the rarity power system (skipped)", already);
  line("due for rebalance (current version = hero-gen/1)", legacy.length);

  const plan: PlanRow[] = [];
  for (const r of legacy) {
    const classDef = classes.find((c) => c.id === r.class_id);
    if (!classDef) throw new Error(`hero ${r.public_id}: class ${r.class_id} is not defined`);
    const previous = rowToState(r);
    const a = rebalanceHeroState({ previous, classDef, settings: settings.character });
    const b = rebalanceHeroState({ previous, classDef, settings: settings.character });
    plan.push({
      characterId: r.hero_id,
      publicId: r.public_id,
      classId: r.class_id,
      rarity: r.rarity,
      fromVersion: Number(r.version_number),
      fromPower: Number(r.power),
      toPower: a.power,
      inBand: a.rarity === r.rarity && isPowerInBand(a.rarity, a.power),
      deterministic: JSON.stringify(a) === JSON.stringify(b),
      keepsIdentity: a.classId === previous.classId && a.rarity === previous.rarity && a.generationSeed === previous.generationSeed && a.appearanceSeed === previous.appearanceSeed
        && (["skin", "hairStyle", "hairColor", "eyes", "mouth", "accessory", "cape", "aura", "outfitHue"] as const).every((k) => a.appearance[k] === previous.appearance[k]),
    });
  }

  h("Plan");
  for (const rarity of RARITIES) {
    const xs = plan.filter((p) => p.rarity === rarity);
    const band = RARITY_RULES[rarity];
    line(`${rarity.padEnd(9)} band ${band.powerMin}–${band.powerMax}`, xs.length ? `${xs.length} heroes: PWR ${q(xs.map((p) => p.fromPower), 0)}–${q(xs.map((p) => p.fromPower), 1)} (median ${q(xs.map((p) => p.fromPower), 0.5)}) → ${q(xs.map((p) => p.toPower), 0)}–${q(xs.map((p) => p.toPower), 1)} (median ${q(xs.map((p) => p.toPower), 0.5)})` : "none");
  }
  const outside = plan.filter((p) => !p.inBand).length;
  const nonDeterministic = plan.filter((p) => !p.deterministic).length;
  const identityChanged = plan.filter((p) => !p.keepsIdentity).length;
  line("results outside their rarity band", outside);
  line("results that differ between two runs (non-deterministic)", nonDeterministic);
  line("results that change class / rarity / seed / identity parts", identityChanged);
  if (outside || nonDeterministic || identityChanged) throw new Error("The rebalance plan is not clean — refusing to continue.");

  const results: RebalanceResult[] = [];
  const deferred: string[] = [];
  if (apply) {
    if (!migrationApplied) throw new Error(`Migration ${MIGRATION_VERSION} is not applied: refusing to --apply.`);
    const expected = opt("expect-heroes");
    if (expected === undefined || Number(expected) !== plan.length) throw new Error(`--apply needs --expect-heroes ${plan.length} (the number due in this dry run); got ${expected ?? "nothing"}.`);
    h("Applying");
    for (const p of plan) {
      try {
        results.push(await rebalanceHero(db, p.characterId, "system:rebalance", { settings, classes, secret: "" }));
      } catch (e) {
        if (e instanceof HeroVersionError && e.code === "HERO_IN_ARENA") deferred.push(p.publicId);
        else throw e;
      }
    }
    line("heroes rebalanced", results.filter((r) => r.status === "REBALANCED").length);
    line("deferred (hero in an unsettled Arena roster — run again later)", deferred.length);
  } else {
    line("written", "NOTHING (dry run)");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: apply ? "APPLY" : "DRY_RUN",
    migrationApplied,
    dueHeroes: plan.length,
    alreadyRebalanced: already,
    outsideBand: outside,
    nonDeterministic,
    identityChanged,
    deferredArena: deferred.length,
    applied: results.filter((r) => r.status === "REBALANCED").length,
    heroes: plan.map((p) => ({ publicId: p.publicId, classId: p.classId, rarity: p.rarity, fromVersion: p.fromVersion, fromPower: p.fromPower, toPower: p.toPower, inBand: p.inBand, deterministic: p.deterministic, keepsIdentity: p.keepsIdentity })),
  };
  const reportPath = opt("report");
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nreport → ${reportPath}`);
  }
});
