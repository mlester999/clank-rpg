/**
 * RELEASE AUDIT — strictly READ ONLY. Every statement runs in a `SET TRANSACTION READ ONLY` transaction (Postgres refuses any write), so it can be
 * pointed at the LIVE database at any time: before the release (Stage 0) and after each stage.
 *
 *   pnpm release:audit                                  state of the database the app is configured for (the printed `→ database:` line says which)
 *   pnpm release:audit -- --excluded-ids 123,456        also report the moderation state / hero of members that must NOT get a hero
 *   pnpm release:audit -- --json <path>                 write the machine-readable result as well
 *
 * It reports: applied migrations vs the files in supabase/migrations (with sha256 prefixes, so a stage can be approved BY HASH), the exact pending
 * list in order, the destructive statements each pending file contains, the preconditions those migrations check, hero / version / Arena state,
 * and — when hero versions exist — `public.audit_hero_versions()` (it must be empty). It never prints a secret.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { computePower } from "../src/domain/character/stats";
import { generatedStats } from "../src/domain/hero/heroVersion";
import { addStats } from "../src/domain/stats";
import { loadClasses, loadSettings } from "../src/server/config/settingsRepo";
import { readMigrations } from "../src/server/db/migrate";
import { createPostgresDb } from "../src/server/db/postgres";
import type { Db, Queryable } from "../src/server/db/types";
import { getEnv } from "../src/server/env";
import { arenaPopulation } from "../src/server/services/arenaEligibility";
import { rewardLiabilities } from "../src/server/services/lifecycle";

import { run } from "./lib/context";

const args = process.argv.slice(2).filter((a) => a !== "--");
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const excludedIds = (opt("excluded-ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isSafeInteger);

const h = (title: string) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 74 - title.length))}`);
const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(58)} ${String(value)}`);

const DESTRUCTIVE = [
  [/\bdrop\s+table\b/gi, "DROP TABLE"],
  [/\bdrop\s+column\b/gi, "DROP COLUMN"],
  [/\btruncate\b/gi, "TRUNCATE"],
  [/\bdelete\s+from\b/gi, "DELETE FROM"],
  [/\bdrop\s+constraint\b/gi, "DROP CONSTRAINT"],
  [/\balter\s+column\b[^;]*\btype\b/gi, "ALTER COLUMN TYPE"],
  [/\bdrop\s+trigger\b/gi, "DROP TRIGGER"],
  [/\bdrop\s+function\b/gi, "DROP FUNCTION"],
] as const;

async function ro<T>(db: Db, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.exec("SET TRANSACTION READ ONLY");
    return fn(tx);
  });
}

/** A query that may reference a table that does not exist yet (pre-migration): null instead of an error. */
async function tryQuery<T extends object>(db: Db, sql: string, params: unknown[] = []): Promise<T[] | null> {
  try {
    return await ro(db, (tx) => tx.query<T>(sql, params));
  } catch (e) {
    if (/does not exist/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

void run(async (ctx) => {
  let db = ctx.db;
  const env = getEnv();
  if (env.DATABASE_URL) {
    const u = new URL(env.DATABASE_URL);
    // Short read-only transactions work best through Supabase's transaction pooler (the same adjustment the backfill script makes).
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "5432") u.port = "6543";
    await db.close();
    db = createPostgresDb(u.toString(), { maxConnections: 1 });
    ctx.close = () => db.close();
  }
  console.log("READ ONLY: every statement below runs in a read-only transaction.");
  const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), target: ctx.target };

  // ── migrations ────────────────────────────────────────────────────────────────────────────────────
  h("Migrations");
  const files = await readMigrations();
  const applied = new Set((await tryQuery<{ version: string }>(db, "select version from supabase_migrations.schema_migrations") ?? []).map((r) => r.version));
  const hashOf = (sql: string) => createHash("sha256").update(sql).digest("hex");
  const rows = files.map((f) => ({ version: f.version, name: f.name, applied: applied.has(f.version), sha256: hashOf(f.sql), sql: f.sql }));
  const unknownApplied = [...applied].filter((v) => !files.some((f) => f.version === v));
  line("applied on this database", `${rows.filter((r) => r.applied).length} of ${rows.length} files`);
  if (unknownApplied.length) line("APPLIED BUT NOT IN supabase/migrations", unknownApplied.join(", "));
  for (const r of rows.filter((x) => x.applied)) console.log(`    applied  ${r.version}_${r.name}  sha256 ${r.sha256.slice(0, 8)}`);
  const pending = rows.filter((r) => !r.applied);
  console.log(`  PENDING, in the order they would apply (${pending.length}):`);
  for (const r of pending) {
    const destructive = DESTRUCTIVE.map(([re, label]) => [label, (r.sql.match(re) ?? []).length] as const).filter(([, n]) => n > 0);
    const guards = (r.sql.match(/raise exception '[^']+'/g) ?? []).length;
    console.log(`    pending  ${r.version}_${r.name}  sha256 ${r.sha256.slice(0, 8)}  (${r.sql.length.toLocaleString()} bytes, ${guards} refusal guard(s))`);
    console.log(`             destructive statements: ${destructive.length ? destructive.map(([l, n]) => `${l}×${n}`).join(", ") : "none"}`);
  }
  result.migrations = { applied: rows.filter((r) => r.applied).map((r) => ({ version: r.version, sha256: r.sha256 })), pending: pending.map((r) => ({ version: r.version, name: r.name, sha256: r.sha256 })), unknownApplied };

  // ── heroes ────────────────────────────────────────────────────────────────────────────────────────
  h("Heroes");
  const [heroes] = await ro(db, (tx) => tx.query<{ total: number; community: number; demo: number; special: number; active: number; suspended: number; inactive: number; no_sprite: number; overrides: number }>(
    `select count(*)::int as total, count(*) filter (where c.kind = 'COMMUNITY' and not c.is_demo)::int as community, count(*) filter (where c.is_demo)::int as demo,
            count(*) filter (where c.kind = 'SPECIAL_CHARACTER')::int as special, count(*) filter (where c.status = 'ACTIVE')::int as active,
            count(*) filter (where c.status = 'SUSPENDED')::int as suspended, count(*) filter (where c.status = 'INACTIVE')::int as inactive,
            count(*) filter (where a.sprite is null)::int as no_sprite, count(*) filter (where a.cosmetic_overrides <> '{}'::jsonb)::int as overrides
       from public.characters c left join public.character_appearances a on a.character_id = c.id`));
  // The ONE definition of Arena eligibility (services/arenaEligibility.ts), the same the scheduler and the Admin overview use: TOTAL and ELIGIBLE are different numbers.
  const population = await ro(db, (tx) => arenaPopulation(tx, false));
  const eligible = { n: population.eligible };
  line("characters (total)", heroes?.total);
  line("  community (non-demo) / special / demo", `${heroes?.community} / ${heroes?.special} / ${heroes?.demo}`);
  line("  ACTIVE / SUSPENDED / INACTIVE", `${heroes?.active} / ${heroes?.suspended} / ${heroes?.inactive}`);
  line("  ARENA-ELIGIBLE right now (active, member not banned)", `${eligible?.n}   (total ${population.total}, suspended ${population.suspended}, inactive ${population.inactive}, ACTIVE but member banned ${population.bannedMember})`);
  line("  legacy rows without a stored sprite (derived on read)", heroes?.no_sprite);
  line("  heroes with player cosmetic overrides (not versioned)", heroes?.overrides);
  const settingsRows = await ro(db, (tx) => tx.query<{ key: string; value: Record<string, unknown> }>("select key, value from public.game_settings where key in ('telegram', 'arena', 'combat', 'arena_picks')"));
  const setting = (k: string) => settingsRows.find((r) => r.key === k)?.value as Record<string, unknown> | undefined;
  line("telegram.qualifyingThreshold (stored)", setting("telegram")?.qualifyingThreshold);
  line("arena.maxCombatMs (stored)", setting("arena")?.maxCombatMs);
  line("combat.pace (stored; absent before 1700)", JSON.stringify(setting("combat")?.pace ?? null));
  result.heroes = { ...heroes, arenaEligible: eligible?.n };

  // The cached `characters.power` is derived data that only some events refresh. A hero whose cache differs from the arithmetic on its stored components has a
  // STALE cache (nothing here changes it; the hero-version migration never touches it, and the public pages show the freshly computed figure).
  const settings = await ro(db, (tx) => loadSettings(tx));
  const classes = await ro(db, (tx) => loadClasses(tx, false));
  const powerRows = await ro(db, (tx) => tx.query<{ power: number; class_id: string; variation: Record<string, number>; telegram_bonus: Record<string, number>; fixed_stats: Record<string, number> | null; dynamic: boolean }>(
    `select c.power, c.class_id, s.variation, s.telegram_bonus, s.fixed_stats,
            (s.holdings_bonus <> '{}'::jsonb or s.loyalty_bonus <> '{}'::jsonb or s.trading_bonus <> '{}'::jsonb or exists (select 1 from public.inventory_items i where i.character_id = c.id and i.equipped)) as dynamic
       from public.characters c join public.character_stats s on s.character_id = c.id`));
  let stale = 0;
  let withDynamic = 0;
  for (const r of powerRows) {
    if (r.dynamic) { withDynamic++; continue; }
    const cls = classes.find((c) => c.id === r.class_id);
    if (cls && computePower(generatedStats(cls, addStats(r.variation), addStats(r.telegram_bonus), r.fixed_stats), settings.character) !== Number(r.power)) stale++;
  }
  line("heroes whose CACHED characters.power is stale (no wallet / gear bonus)", `${stale} of ${powerRows.length - withDynamic}${withDynamic ? ` (+${withDynamic} with a wallet / gear component, not compared)` : ""}`);
  result.stalePower = { stale, compared: powerRows.length - withDynamic, withDynamic };

  const versions = await tryQuery<{ n: number; initial: number; heroes_without: number }>(
    db,
    `select count(*)::int as n, count(*) filter (where action = 'INITIAL')::int as initial,
            (select count(*)::int from public.characters c where not exists (select 1 from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL')) as heroes_without
       from public.hero_versions`,
  );
  if (versions === null) {
    line("hero versions", "NOT PRESENT (the hero-version migration is pending)");
  } else {
    line("hero versions (all / INITIAL / heroes WITHOUT an INITIAL)", `${versions[0]?.n} / ${versions[0]?.initial} / ${versions[0]?.heroes_without}`);
    const violations = await ro(db, (tx) => tx.query<{ character_id: string; problem: string }>("select character_id, problem from public.audit_hero_versions() limit 20"));
    line("audit_hero_versions() violations (must be 0)", violations.length);
    result.heroVersions = { ...versions[0], violations: violations.length };

    // RARITY POWER (hero generator 2): where the heroes stand relative to the rarity bands. Only meaningful once the rarity-power migration exists.
    const power = await tryQuery<{ generator_version: string; n: number }>(
      db,
      `select v.generator_version, count(*)::int as n from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id where c.kind = 'COMMUNITY' and not c.is_demo group by 1 order by 1`,
    );
    const rarityAudit = await tryQuery<{ problem: string; n: number }>(db, "select problem, count(*)::int as n from public.audit_hero_rarity_power() group by 1");
    if (rarityAudit === null) {
      line("rarity power", "NOT PRESENT (the rarity-power migration is pending)");
    } else {
      line("current versions by generator", JSON.stringify(Object.fromEntries((power ?? []).map((r) => [r.generator_version, r.n]))));
      line("audit_hero_rarity_power(): not yet rebalanced / outside band", `${rarityAudit.find((r) => r.problem === "NOT_REBALANCED")?.n ?? 0} / ${rarityAudit.find((r) => r.problem === "POWER_OUTSIDE_RARITY_BAND")?.n ?? 0}`);
    }
    result.rarityPower = { generators: power, audit: rarityAudit };
  }

  // ── members that must stay out ────────────────────────────────────────────────────────────────────
  if (excludedIds.length) {
    h("Members that must NOT get a hero (moderation mechanism, nothing hard-coded)");
    const members = await ro(db, (tx) => tx.query<{ telegram_user_id: number; status: string; flag_reason: string | null; qualifying_message_count: number; hero: string | null }>(
      `select tu.telegram_user_id, tu.status, tu.flag_reason, tu.qualifying_message_count, c.id as hero
         from public.telegram_users tu left join public.characters c on c.telegram_user_id = tu.telegram_user_id where tu.telegram_user_id = any($1::bigint[])`, [excludedIds]));
    for (const id of excludedIds) {
      const m = members.find((r) => Number(r.telegram_user_id) === id);
      if (!m) line(String(id), "no such member");
      else line(String(id), `status ${m.status}${m.flag_reason ? ` ("${m.flag_reason}")` : ""} · ${m.qualifying_message_count} qualifying · ${m.hero ? "HAS A HERO" : "no hero"}${m.status === "OK" ? "  ← NOT blocked: the live webhook WOULD create its hero once the threshold allows it. Flag or ban it in Admin → Telegram first." : "  (blocked)"}`);
    }
    result.excluded = members;
  }

  // ── reward + arena preconditions ──────────────────────────────────────────────────────────────────
  h("Preconditions of the pending migrations");
  const count = async (label: string, sql: string) => {
    const r = await tryQuery<{ n: number }>(db, sql);
    line(label, r === null ? "(table not present)" : r[0]?.n);
    return r?.[0]?.n ?? null;
  };
  await count("1400: reward ledger rows", "select count(*)::int as n from public.arena_reward_ledger");
  await count("1400: reward claims", "select count(*)::int as n from public.arena_reward_claims");
  await count("1400: reward accounts with any balance", "select count(*)::int as n from public.arena_reward_accounts where earned_total <> 0 or claimable <> 0 or reserved <> 0 or claimed_total <> 0");
  await count("1400: weekly pick scores left unscored by the old cap", "select count(*)::int as n from public.arena_weekly_pick_scores where not scored");
  await count("arena_picks rows", "select count(*)::int as n from public.arena_picks");
  const [arena] = await ro(db, (tx) => tx.query<{ paused: boolean; last_advance_at: Date | null }>("select paused, last_advance_at from public.arena_state where id = 1"));
  const unsettled = await ro(db, (tx) => tx.query<{ status: string; n: number }>("select status, count(*)::int as n from public.arena_battles where status in ('SCHEDULED', 'SIMULATED') group by status"));
  line("arena paused (legacy flag) / last advance", `${arena?.paused} / ${arena?.last_advance_at ? new Date(arena.last_advance_at).toISOString() : "never"}`);
  line("unsettled battles (SCHEDULED / SIMULATED)", unsettled.length ? unsettled.map((u) => `${u.status} ${u.n}`).join(", ") : "none (the arena is idle — no worker is advancing it)");
  result.arena = { paused: arena?.paused, lastAdvanceAt: arena?.last_advance_at, unsettled };

  // ── GAME LIFECYCLE (migration 2000): phase, seasons, the Arena's runtime status, reward liabilities, launch preconditions ─────────────
  h("Game lifecycle (migration 20261006002000) — READ ONLY; nothing here launches, resets or starts anything");
  const lifecycleApplied = rows.find((r) => r.version === "20261006002000")?.applied ?? false;
  const game = await tryQuery<{ phase: string; launched_at: Date | null; launch_season_id: string | null }>(db, "select phase, launched_at, launch_season_id from public.game_state where id = 1");
  const arenaRuntime = await tryQuery<{ status: string; started_at: Date | null; status_changed_at: Date }>(db, "select status, started_at, status_changed_at from public.arena_state where id = 1");
  const seasons = await tryQuery<{ kind: string; number: number | null; run_number: number | null; name: string; status: string; battle_counter: string }>(
    db, "select kind, number, run_number, name, status, battle_counter::text from public.seasons order by starts_at, created_at",
  );
  if (game === null) {
    line("lifecycle migration", "NOT PRESENT (pending) — the Arena has no persisted status yet; after it is applied the DEFAULT is DEVELOPMENT (never LIVE, nothing reset or started)");
    const mapped = arena?.paused ? "PAUSED" : (unsettled.length || (await ro(db, (tx) => tx.query<{ n: number }>("select count(*)::int as n from public.arena_battles")))[0]!.n > 0) ? "RUNNING" : "NOT_STARTED";
    line("  status the migration would give the Arena (paused→PAUSED, has run→RUNNING, never ran→NOT_STARTED)", mapped);
    const nSeasons = await tryQuery<{ n: number; battles: number }>(db, "select (select count(*)::int from public.seasons) as n, (select count(*)::int from public.arena_battles) as battles");
    line("  seasons that would become DEVELOPMENT runs / battles that would be numbered per season", `${nSeasons?.[0]?.n ?? "?"} / ${nSeasons?.[0]?.battles ?? "?"}`);
    result.lifecycle = { present: false, wouldMapArenaTo: mapped };
  } else {
    line("game phase", `${game[0]?.phase}${game[0]?.launched_at ? ` (launched ${new Date(game[0].launched_at).toISOString()})` : ""}`);
    line("arena runtime status", `${arenaRuntime?.[0]?.status}${arenaRuntime?.[0]?.started_at ? ` · started ${new Date(arenaRuntime[0].started_at).toISOString()}` : ""}`);
    for (const x of seasons ?? []) line(`  season ${x.kind === "COMPETITIVE" ? `#${x.number}` : `dev run ${x.run_number}`} "${x.name}"`, `${x.status} · last public battle number ${x.battle_counter}`);
    const findings = await tryQuery<{ problem: string; detail: string }>(db, "select problem, detail from public.audit_game_lifecycle()");
    line("audit_game_lifecycle() findings (must be 0)", findings?.length ?? "n/a");
    result.lifecycle = { present: true, phase: game[0]?.phase, arena: arenaRuntime?.[0]?.status, seasons, findings: findings?.length ?? null };
  }
  // ── what a launch would archive (development progress must not carry into Season 1) — counts only, read-only ──────────────────────────
  const econApplied = rows.find((r) => r.version === "20261006002100")?.applied ?? false;
  const econ = await tryQuery<{ unlocks: number; permanent: number; loot: number; equipped: number; gold_accounts: number; gold: string }>(
    db,
    `select (select count(*)::int from public.character_achievements ca join public.achievements a on a.id = ca.achievement_id
              where a.criteria->>'metric' in ('battles', 'wins', 'top2', 'eliminations') and coalesce(ca.context->>'granted', '') <> 'admin') as unlocks,
            (select count(*)::int from public.character_achievements ca join public.achievements a on a.id = ca.achievement_id
              where not (a.criteria->>'metric' in ('battles', 'wins', 'top2', 'eliminations')) or coalesce(ca.context->>'granted', '') = 'admin') as permanent,
            (select count(*)::int from public.inventory_items) as loot,
            (select count(*)::int from public.inventory_items where equipped) as equipped,
            (select count(*)::int from public.currency_accounts where balance > 0) as gold_accounts,
            (select coalesce(sum(balance), 0)::text from public.currency_accounts where balance > 0) as gold`,
  );
  line("development economy a launch would ARCHIVE (arena achievement unlocks / loot items (equipped) / Gold accounts → total Gold)", econ ? `${econ[0]?.unlocks} / ${econ[0]?.loot} (${econ[0]?.equipped}) / ${econ[0]?.gold_accounts} → ${econ[0]?.gold}` : "n/a");
  line("  permanent achievements kept (community / chain metrics + admin grants)", econ?.[0]?.permanent ?? "n/a");
  const econFindings = econApplied ? await tryQuery<{ problem: string }>(db, "select problem from public.audit_development_economy()") : null;
  line("  audit_development_economy() findings (must be 0; only meaningful once LIVE)", econApplied ? (econFindings?.length ?? "n/a") : "NOT PRESENT (pending 20261006002100)");
  result.developmentEconomy = { wouldArchive: econ?.[0] ?? null, migrationApplied: econApplied, findings: econFindings?.length ?? null };
  const liabilities = await ro(db, (tx) => rewardLiabilities(tx));
  line("reward liabilities (credited / reserved / claimed / pending claims / held prizes)", liabilities.checked ? `${liabilities.earnedMicro} / ${liabilities.reservedMicro} / ${liabilities.claimedMicro} / ${liabilities.pendingOrSentClaims} / ${liabilities.heldPrizes}` : "(reward tables not present: nothing can be owed)");
  line("  would a launch / reset be BLOCKED by them?", liabilities.blocking ? `YES — ${liabilities.reasons.join(" ")}` : "no");
  const pickScores = await tryQuery<{ n: number; finalized: number }>(db, "select (select count(*)::int from public.arena_pick_scores) as n, (select count(*)::int from public.arena_leaderboards) as finalized");
  line("  pick scores (test data) / finalized boards", pickScores ? `${pickScores[0]?.n} / ${pickScores[0]?.finalized}` : "(not present)");
  console.log("  LAUNCH PRECONDITIONS (all must hold; the launch itself re-checks them under a lock):");
  const pre: Array<[string, boolean]> = [
    ["every migration through 20261006002100 is applied", pending.length === 0 && lifecycleApplied && econApplied],
    // (before the lifecycle migration the Arena has no status yet: its legacy `paused` flag is what the migration will map to PAUSED)
    ["the Arena is stopped (NOT_STARTED / PAUSED) — pause it and let it finish its battles", arenaRuntime ? ["NOT_STARTED", "PAUSED"].includes(arenaRuntime[0]?.status ?? "") : Boolean(arena?.paused)],
    ["no battle is committed (SCHEDULED / SIMULATED)", unsettled.length === 0],
    [`at least a battle's worth of Arena-eligible heroes (8; now ${eligible?.n})`, (eligible?.n ?? 0) >= 8],
    ["no reward liability would be orphaned", !liabilities.blocking],
    ["the game is still in DEVELOPMENT", game === null || game[0]?.phase === "DEVELOPMENT"],
  ];
  for (const [label, ok] of pre) console.log(`    [${ok ? "ok" : "NOT YET"}] ${label}`);
  result.launchPreconditions = Object.fromEntries(pre);
  result.rewardLiabilities = liabilities;

  console.log("\nREAD ONLY — nothing was changed.");
  const jsonPath = opt("json");
  if (jsonPath) {
    await writeFile(jsonPath, JSON.stringify(result, null, 2));
    console.log(`result written to ${jsonPath}`);
  }
});
