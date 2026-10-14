import type { ClassDef } from "../../src/domain/rules";
import type { GameSettings } from "../../src/domain/settings";
import { generateCharacter } from "../../src/domain/character/generate";
import { computePower } from "../../src/domain/character/stats";
import { generatedStats } from "../../src/domain/hero/heroVersion";
import { computeHeroPower } from "../../src/domain/hero/power";
import { addStats } from "../../src/domain/stats";
import type { BackfillPlan, StoredMember } from "../../src/domain/telegram/backfillPlan";
import { json, type Db } from "../../src/server/db/types";
import { createPgliteDb } from "../../src/server/db/pglite";
import { migrate, readMigrations } from "../../src/server/db/migrate";
import { seedReferenceData } from "../../src/server/seed/reference";
import { applyBackfill, buildBackfillPlan, type BackfillDeps } from "../../src/server/services/telegramBackfill";
import { advanceArena } from "../../src/server/services/arena";
import { rebalanceHero } from "../../src/server/services/heroVersions";
import { RARITIES, type Rarity } from "../../src/domain/character/appearance";
import { isPowerInBand } from "../../src/domain/hero/rarity";
import { HERO_GENERATOR_VERSION } from "../../src/domain/hero/heroVersion";
import { planLayers } from "../../src/domain/sprites/plan";
import { parseManifest } from "../../src/domain/sprites/spec";
import { isProceduralSet } from "../../src/domain/sprites/v3/set";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface ScratchBackfillInput {
  chatId: number;
  settings: GameSettings;
  classes: ClassDef[];
  classRollSecret: string;
  excludeIds: ReadonlySet<number>;
  confirmedHumanIds: ReadonlySet<number>;
  stored: StoredMember[];
  heroes: Array<{ character: Record<string, unknown>; stats: Record<string, unknown> | null; appearance: Record<string, unknown> | null }>;
  heroUsers: Array<Record<string, unknown>>;
  classRows: Array<Record<string, unknown>>;
  skillRows: Array<Record<string, unknown>>;
  plan: BackfillPlan;
}

/** The migration that introduces hero versions. The scratch replays the LIVE path: everything BEFORE it is applied, the existing heroes are copied in, then this one runs. */
export const HERO_VERSIONS_MIGRATION = "20261005001800";

export interface ScratchHeroVersionResult {
  /** Existing heroes (copied in before the migration) that carry exactly one INITIAL v1 after it. */
  existingWithInitialV1: number;
  /** Heroes created by the guarded backfill that carry exactly one INITIAL v1. */
  newWithInitialV1: number;
  totalInitialVersions: number;
  totalVersions: number;
  missingInitialVersions: number;
  duplicateCurrentVersions: number;
  /** Existing heroes whose pre-existing columns / stat / appearance rows differ before vs after the migration + backfill (must be 0). */
  existingChanged: number;
  /** v1 snapshot figures that differ from what the hero is stored with — class, rarity, seed, parts, sprite, components, and the stats / POWER recomputed in TypeScript from those components — must be 0. */
  existingSnapshotMismatches: number;
  /**
   * INFORMATION, not a failure: heroes whose cached `characters.power` differs from the arithmetic on their stored components. The migration never touches that cache
   * (it is a pre-existing column), so on a database whose cache went stale (e.g. heroes created before the level / XP removal) this counts them.
   */
  staleCachedPower: number;
  /** Versions created by the SECOND backfill run (must be 0). */
  secondRunVersionsCreated: number;
  /** Rows reported by public.audit_hero_versions() (must be 0). */
  auditViolations: number;
}

export interface PowerSummary { count: number; min: number; p25: number; median: number; p75: number; p90: number; max: number; mean: number }

/** The rarity power system, proven on the scratch copy of the real heroes: the 70 existing ones are rebalanced, the new ones were born on generator 2. */
export interface ScratchRarityPowerResult {
  generator: string;
  heroes: number;
  /** Heroes whose CURRENT version was made by the current generator. */
  onCurrentGenerator: number;
  /** The existing heroes BEFORE the rebalance, under the first generator's stat-weight POWER (read from the copied rows). */
  legacyBefore: { overall: PowerSummary; byRarity: Record<string, PowerSummary>; byClass: Record<string, PowerSummary> };
  /** The existing heroes AFTER the rebalance, and the new heroes, under the authoritative PWR (current versions). */
  afterExisting: { overall: PowerSummary; byRarity: Record<string, PowerSummary> };
  afterNew: { overall: PowerSummary; byRarity: Record<string, PowerSummary> };
  /** All heroes. */
  all: { byRarity: Record<string, PowerSummary>; byClass: Record<string, number>; rarityCounts: Record<string, number> };
  rebalance: {
    attempted: number;
    rebalanced: number;
    deferredInArena: number;
    /** Heroes that carry exactly one SYSTEM_REBALANCE version, as version 2, directly after their untouched v1. */
    withRebalanceV2: number;
    /** v1 rows that differ (field by field) before vs after the rebalance — must be 0. */
    v1Changed: number;
    /** Rebalanced heroes whose class / rarity / public id / seed / identity parts changed — must be 0. */
    identityChanged: number;
    /** Versions created by running the rebalance a second time — must be 0. */
    secondRunCreated: number;
    /** Heroes whose cached characters.power differs from their current version's power after the rebalance — must be 0. */
    cachedPowerMismatch: number;
  };
  /** Current versions whose PWR is not computeHeroPower(stats) or is not an integer in [1, ∞). */
  invalidPower: number;
  /** Current gen-2 versions whose PWR lies outside their rarity's band. */
  outsideTier: number;
  /** max(Common) < min(Rare) < … over the whole population. */
  nonOverlapping: boolean;
  /** Layer references a hero's sprite needs that the sprite set does not provide. */
  missingAssets: number;
  /** Rows of public.audit_hero_rarity_power() — must be 0 after the rebalance. */
  auditRarityViolations: number;
}

export interface ScratchBackfillResult {
  heroVersions: ScratchHeroVersionResult;
  rarityPower: ScratchRarityPowerResult;
  existingHeroes: number;
  createdHeroes: number;
  /** Heroes that EXIST — suspended, inactive and banned ones included. */
  totalHeroes: number;
  /** Heroes that can fight right now (active, member not banned). TOTAL minus the ineligible: a suspended hero is not "missing". */
  arenaEligibleHeroes: number;
  /** Heroes that exist but are not arena-eligible — every one of them must be an EXISTING hero (a moderation decision), never a newly created one. */
  ineligibleHeroes: number;
  duplicateTelegramIdentities: number;
  completeGeneratedRows: number;
  preExistingHeroRowsPreserved: boolean;
  preExistingArenaHistoryPreserved: boolean;
  missingEligibleHeroes: number;
  idempotentSecondRun: boolean;
  scratchMembersRescored: number;
  arena: { eligibleHeroes: number; initialBattles: number; preparedAhead: number; lineupMs: number };
}

const ROLE_SHIM = `
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

const stableValue = (value: unknown): unknown => value && typeof value === "object"
  ? Array.isArray(value) ? value.map(stableValue) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stableValue(v)]))
  : value;
const canonical = (value: unknown): string => JSON.stringify(stableValue(value));

const ARENA_HISTORY_TABLES = [
  "arena_state",
  "arena_cycles",
  "arena_battles",
  "arena_queue_entries",
  "arena_participants",
  "season_character_stats",
] as const;

async function arenaHistoryFingerprint(db: Db): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of ARENA_HISTORY_TABLES) {
    const rows = await db.query<{ row: unknown }>(`select to_jsonb(t) as row from public.${table} t`);
    result[table] = rows.map(({ row }) => row).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  return result;
}

/**
 * The scratch copy is a DEVELOPMENT database whose Arena has been STARTED — what an operator's running Arena is. (The lifecycle migration leaves a
 * database that never ran NOT_STARTED, and nothing makes battles until it is started.) This only ever touches the PGlite scratch database.
 */
async function startScratchArena(db: Db): Promise<void> {
  const [state] = await db.query<{ status: string }>("select status from public.arena_state where id = 1");
  if (state?.status === "NOT_STARTED") await db.query("update public.arena_state set status = 'PREPARING' where id = 1");
  await db.query("update public.arena_state set status = 'RUNNING' where id = 1 and status in ('PREPARING', 'PAUSE_REQUESTED', 'PAUSED')");
}

async function clearScratchArena(db: Db): Promise<void> {
  await db.query("delete from public.arena_queue_entries");
  // Deleting the parent battle cascades the participants and is allowed by the
  // prepared-roster guard; deleting its participants directly is intentionally blocked.
  await db.query("delete from public.arena_battles");
  await db.query("delete from public.arena_cycles");
  await db.query("update public.arena_state set last_advance_at = null where id = 1");
  await startScratchArena(db);
}

async function insertRecordset(db: Db, table: string, values: Array<Record<string, unknown>>): Promise<void> {
  for (let offset = 0; offset < values.length; offset += 500) {
    await db.query(`insert into public.${table} select * from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`, [json(values.slice(offset, offset + 500))]);
  }
}

async function existingHeroFingerprint(db: Db) {
  // `public_id` / `current_hero_version_id` exist only after the hero-version migration: they are NEW columns, never a change to an existing one.
  return db.query<Record<string, unknown>>(
    `select to_jsonb(c) - 'public_id' - 'current_hero_version_id' as character, to_jsonb(s) as stats, to_jsonb(a) as appearance
       from public.characters c
       left join public.character_stats s on s.character_id = c.id
       left join public.character_appearances a on a.character_id = c.id
      where c.kind = 'COMMUNITY' and not c.is_demo order by c.telegram_user_id`,
  );
}

export async function verifyTelegramBackfillScratch(input: ScratchBackfillInput): Promise<ScratchBackfillResult> {
  const scratch = await createPgliteDb();
  try {
    await scratch.exec(ROLE_SHIM);
    // The LIVE path: everything BEFORE the hero-version migration is applied first, the existing heroes are copied in as they are, and only then
    // does the hero-version migration run (it must turn every one of them into a hero with exactly one INITIAL v1 without changing anything).
    const preVersion = (await readMigrations()).map((m) => m.version).filter((v) => v < HERO_VERSIONS_MIGRATION).at(-1);
    await migrate(scratch, undefined, preVersion ? { upTo: preVersion } : {});
    await seedReferenceData(scratch);

    for (const [i, c] of input.classRows.entries()) {
      await scratch.query(
        `insert into public.character_classes (id, name, description, enabled, sort_order, definition)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set name = excluded.name, description = excluded.description, enabled = excluded.enabled,
           sort_order = excluded.sort_order, definition = excluded.definition`,
        [c.id, c.name, c.description, c.enabled, c.sort_order ?? (i + 1) * 10, json(c.definition)],
      );
    }
    for (const s of input.skillRows) {
      await scratch.query(
        `insert into public.skills (id, name, enabled, definition) values ($1, $2, $3, $4::jsonb)
         on conflict (id) do update set name = excluded.name, enabled = excluded.enabled, definition = excluded.definition`,
        [s.id, s.name, s.enabled, json(s.definition)],
      );
    }
    for (const [key, value] of Object.entries(input.settings)) {
      await scratch.query(
        `insert into public.game_settings (key, value, updated_by) values ($1, $2::jsonb, 'scratch-verification')
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by`,
        [key, json(value)],
      );
    }

    const userRows = new Map<number, Record<string, unknown>>();
    for (const member of input.stored) {
      userRows.set(member.userId, {
        telegram_user_id: member.userId, username: member.username, display_name: member.displayName, status: member.status,
        flag_reason: member.flagReason, total_message_count: member.counters.total, qualifying_message_count: member.counters.qualifying,
        active_days: member.counters.activeDays, reply_count: member.counters.replyCount, replies_received: member.counters.repliesReceived,
        reactions_received: member.counters.reactionsReceived, quality_sum: member.counters.qualitySum, activity_score: member.counters.activityScore,
        behavior: member.behavior,
      });
    }
    for (const user of input.heroUsers) {
      userRows.set(Number(user.telegram_user_id), {
        telegram_user_id: user.telegram_user_id, username: user.username, display_name: user.display_name, status: user.status,
        flag_reason: user.flag_reason, total_message_count: user.total_message_count, qualifying_message_count: user.qualifying_message_count,
        active_days: user.active_days, reply_count: user.reply_count, replies_received: user.replies_received, reactions_received: user.reactions_received,
        quality_sum: user.quality_sum, activity_score: user.activity_score, behavior: user.behavior,
      });
    }
    const users = [...userRows.values()];
    for (let offset = 0; offset < users.length; offset += 500) {
      await scratch.query(
        `insert into public.telegram_users
           (telegram_user_id, username, display_name, status, flag_reason, total_message_count, qualifying_message_count, active_days,
            reply_count, replies_received, reactions_received, quality_sum, activity_score, behavior)
         select x.telegram_user_id, x.username, x.display_name, x.status, x.flag_reason, x.total_message_count, x.qualifying_message_count,
                x.active_days, x.reply_count, x.replies_received, x.reactions_received, x.quality_sum, x.activity_score, x.behavior
           from jsonb_to_recordset($1::jsonb) as x(telegram_user_id bigint, username text, display_name text, status text, flag_reason text,
             total_message_count integer, qualifying_message_count integer, active_days integer, reply_count integer, replies_received integer,
             reactions_received integer, quality_sum real, activity_score real, behavior jsonb)`,
        [json(users.slice(offset, offset + 500))],
      );
    }

    const messages = input.stored.flatMap((member) => member.messages.map((message) => ({
      chat_id: input.chatId, message_id: message.messageId, telegram_user_id: member.userId, sent_at_ms: message.features.sentAtMs,
      text_hash: message.features.textHash ?? null, char_count: message.features.charCount, word_count: message.features.wordCount,
      features: message.features, is_reply: message.features.isReply, reply_to_user_id: message.replyToUserId, source: "IMPORT",
      qualifies: message.qualifies, weight: message.weight, reject_reason: message.reason,
    })));
    for (let offset = 0; offset < messages.length; offset += 500) {
      await scratch.query(
        `insert into public.telegram_messages
           (chat_id, message_id, telegram_user_id, sent_at, day, text_hash, char_count, word_count, features, is_reply, reply_to_user_id, source, qualifies, weight, reject_reason)
         select x.chat_id, x.message_id, x.telegram_user_id, to_timestamp(x.sent_at_ms / 1000.0),
                (to_timestamp(x.sent_at_ms / 1000.0) at time zone 'UTC')::date, x.text_hash, x.char_count, x.word_count,
                x.features, x.is_reply, x.reply_to_user_id, x.source, x.qualifies, x.weight, x.reject_reason
           from jsonb_to_recordset($1::jsonb) as x(chat_id bigint, message_id bigint, telegram_user_id bigint, sent_at_ms bigint, text_hash text,
             char_count integer, word_count integer, features jsonb, is_reply boolean, reply_to_user_id bigint, source text, qualifies boolean, weight real, reject_reason text)`,
        [json(messages.slice(offset, offset + 500))],
      );
    }

    const daily = input.stored.flatMap((member) => [...member.daily].map(([day, counts]) => ({ telegram_user_id: member.userId, day, message_count: counts.messages, qualifying_count: counts.qualifying })));
    for (let offset = 0; offset < daily.length; offset += 500) {
      await scratch.query(
        `insert into public.telegram_daily_activity (telegram_user_id, day, message_count, qualifying_count)
         select telegram_user_id, day::date, message_count, qualifying_count
           from jsonb_to_recordset($1::jsonb) as x(telegram_user_id bigint, day text, message_count integer, qualifying_count integer)`,
        [json(daily.slice(offset, offset + 500))],
      );
    }

    const reactions: Array<Record<string, unknown>> = [];
    let reactionId = 1;
    for (const member of input.stored) {
      for (let i = 0; i < member.reactionRows; i++) {
        reactions.push({ chat_id: input.chatId, message_id: -900_000_000_000_000 - reactionId, reactor_user_id: -800_000_000_000_000 - reactionId, author_user_id: member.userId });
        reactionId++;
      }
    }
    for (let offset = 0; offset < reactions.length; offset += 500) {
      await scratch.query(
        `insert into public.telegram_reactions (chat_id, message_id, reactor_user_id, author_user_id)
         select x.chat_id, x.message_id, x.reactor_user_id, x.author_user_id
           from jsonb_to_recordset($1::jsonb) as x(chat_id bigint, message_id bigint, reactor_user_id bigint, author_user_id bigint)`,
        [json(reactions.slice(offset, offset + 500))],
      );
    }

    const heroRows = input.heroes.map((h) => h.character);
    await insertRecordset(scratch, "characters", heroRows);
    await insertRecordset(scratch, "character_stats", input.heroes.flatMap((h) => h.stats ? [h.stats] : []));
    await insertRecordset(scratch, "character_appearances", input.heroes.flatMap((h) => h.appearance ? [h.appearance] : []));

    const deps: BackfillDeps & { classRollSecret: string } = {
      chatId: input.chatId, settings: input.settings, classes: input.classes, classRollSecret: input.classRollSecret,
      excludeIds: input.excludeIds, confirmedHumanIds: input.confirmedHumanIds,
    };
    const beforeHeroRows = await existingHeroFingerprint(scratch);
    if (beforeHeroRows.length !== input.heroes.length) throw new Error(`Scratch seeded ${beforeHeroRows.length} old heroes; expected ${input.heroes.length}.`);
    const preMigrationVersionsTable = (await scratch.query<{ t: string | null }>("select to_regclass('public.hero_versions')::text as t"))[0]?.t ?? null;

    // STAGE E of the release: apply the hero-version migration (and anything after it) to the copies of the existing heroes.
    await migrate(scratch);
    const afterMigrationRows = await existingHeroFingerprint(scratch);
    const existingChangedByMigration = JSON.stringify(beforeHeroRows) === JSON.stringify(afterMigrationRows) ? 0 : 1;
    const verbatimMismatches = Number((await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.characters c
         join public.hero_versions v on v.id = c.current_hero_version_id
         join public.character_stats s on s.character_id = c.id join public.character_appearances a on a.character_id = c.id
        where v.action <> 'INITIAL' or v.version_number <> 1 or v.class_id <> c.class_id or v.rarity <> a.rarity or v.appearance <> a.parts or v.appearance_seed <> a.seed
           or v.sprite is distinct from a.sprite or v.variation <> s.variation or v.telegram_bonus <> s.telegram_bonus`,
    ))[0]?.n ?? 0);
    // The two summary figures (stats, POWER) are computed by the migration in SQL: verify them against the application's own TypeScript arithmetic
    // from the stored components — NOT against the cached `characters.power`, which is a pre-existing column the migration never touches and which can be stale.
    const snapshotRows = await scratch.query<{ class_id: string; variation: Record<string, number>; telegram_bonus: Record<string, number>; fixed_stats: Record<string, number> | null; vstats: Record<string, number>; vpower: number; cached: number }>(
      `select c.class_id, s.variation, s.telegram_bonus, s.fixed_stats, v.stats as vstats, v.power as vpower, c.power as cached
         from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id join public.character_stats s on s.character_id = c.id`,
    );
    let figureMismatches = 0;
    let staleCachedPower = 0;
    for (const r of snapshotRows) {
      const cls = input.classes.find((c) => c.id === r.class_id) ?? input.classRows.map((x) => x.definition as ClassDef).find((c) => c.id === r.class_id);
      if (!cls) { figureMismatches++; continue; }
      const stats = generatedStats(cls, addStats(r.variation), addStats(r.telegram_bonus), r.fixed_stats);
      const power = computePower(stats, input.settings.character);
      const statsOk = (Object.keys(stats) as Array<keyof typeof stats>).every((k) => stats[k] === r.vstats[k]);
      if (!statsOk || power !== Number(r.vpower)) figureMismatches++;
      if (Number(r.cached) !== Number(r.vpower)) staleCachedPower++;
    }
    const snapshotMismatches = verbatimMismatches + figureMismatches;
    const existingWithInitialV1 = Number((await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.characters c where (select count(*) from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL') = 1 and c.current_hero_version_id is not null`,
    ))[0]?.n ?? 0);

    // Give the old roster real persisted Arena records before the backfill, then prove the
    // operation leaves the whole Arena/season-history surface byte-for-byte unchanged.
    const clockMs = Date.UTC(2026, 9, 5, 12, 0, 0);
    let seed = 0;
    await startScratchArena(scratch);
    await advanceArena(scratch, { now: () => new Date(clockMs), secureSeed: () => `scratch-existing-arena-${++seed}`, allowDemo: false });
    const beforeArenaHistory = await arenaHistoryFingerprint(scratch);
    const arenaHistoryIsSeeded = beforeArenaHistory.arena_cycles!.length > 0 && beforeArenaHistory.arena_battles!.length > 0 &&
      beforeArenaHistory.arena_queue_entries!.length > 0 && beforeArenaHistory.arena_participants!.length > 0;

    const scratchPlan = (await buildBackfillPlan(scratch, deps)).plan;
    if (scratchPlan.totals.wouldCreate !== input.plan.totals.wouldCreate) {
      throw new Error(`Scratch preview differs from live preview: ${scratchPlan.totals.wouldCreate} due vs ${input.plan.totals.wouldCreate} due.`);
    }
    const run = await applyBackfill(scratch, deps, { rescore: true, expectNewHeroes: input.plan.totals.wouldCreate });
    const afterHeroRows = await existingHeroFingerprint(scratch);
    const preserved = JSON.stringify(beforeHeroRows) === JSON.stringify(afterHeroRows.filter((row) => !run.heroIds.includes(String((row.character as Record<string, unknown>).id))));
    const preExistingArenaHistoryPreserved = arenaHistoryIsSeeded &&
      canonical(beforeArenaHistory) === canonical(await arenaHistoryFingerprint(scratch));
    const totalHeroes = Number((await scratch.query<{ n: number }>("select count(*)::int as n from public.characters where kind = 'COMMUNITY' and not is_demo"))[0]?.n ?? 0);
    const duplicateTelegramIdentities = Number((await scratch.query<{ n: number }>(
      "select count(*)::int as n from (select telegram_user_id from public.characters where telegram_user_id is not null group by telegram_user_id having count(*) > 1) d",
    ))[0]?.n ?? 0);
    const missingEligibleHeroes = Number((await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.telegram_users u
        where u.status = 'OK' and not u.is_demo and u.qualifying_message_count >= $1
          and u.telegram_user_id <> all($2::bigint[])
          and not exists (select 1 from public.characters c where c.telegram_user_id = u.telegram_user_id)`,
      [input.settings.telegram.qualifyingThreshold, [...input.excludeIds]],
    ))[0]?.n ?? 0);

    const newHeroRows = await scratch.query<{
      telegram_user_id: number; class_id: string; name: string; rarity: string; parts: unknown; seed: string; sprite: unknown;
      variation: unknown; telegram_bonus: unknown;
    }>(
      `select c.telegram_user_id, c.class_id, c.name, a.rarity, a.parts, a.seed, a.sprite, s.variation, s.telegram_bonus
         from public.characters c join public.character_appearances a on a.character_id = c.id
         join public.character_stats s on s.character_id = c.id where c.id = any($1::uuid[])`,
      [run.heroIds],
    );
    const newUsers = await scratch.query<{ telegram_user_id: number; display_name: string; behavior: object; activity_score: number }>(
      "select telegram_user_id, display_name, behavior, activity_score from public.telegram_users where telegram_user_id = any($1::bigint[])",
      [input.plan.heroes.map((hero) => hero.userId)],
    );
    const newMembers = new Map(newUsers.map((user) => [Number(user.telegram_user_id), user]));
    let completeGeneratedRows = 0;
    for (const hero of newHeroRows) {
      const user = newMembers.get(Number(hero.telegram_user_id));
      if (!user) continue;
      const generated = generateCharacter({
        telegramUserId: Number(user.telegram_user_id), displayName: user.display_name, behavior: user.behavior, activityScore: Number(user.activity_score),
        classes: input.classes, settings: input.settings, secret: input.classRollSecret,
      });
      if (hero.class_id === generated.classId && hero.name === generated.name && hero.rarity === generated.rarity && hero.parts &&
          canonical(hero.parts) === canonical(generated.appearance) && hero.seed === generated.appearanceSeed &&
          canonical(hero.sprite) === canonical(generated.sprite) && canonical(hero.variation) === canonical(generated.variation) &&
          canonical(hero.telegram_bonus) === canonical(generated.telegramBonus)) completeGeneratedRows++;
    }
    const versionCount = async () => Number((await scratch.query<{ n: number }>("select count(*)::int as n from public.hero_versions"))[0]?.n ?? 0);
    const versionsBeforeSecondRun = await versionCount();
    const secondFingerprint = JSON.stringify(await existingHeroFingerprint(scratch));
    const secondRun = await applyBackfill(scratch, deps, { expectNewHeroes: 0 });
    const idempotentSecondRun = secondRun.heroesCreated === 0 && secondFingerprint === JSON.stringify(await existingHeroFingerprint(scratch));
    const secondRunVersionsCreated = (await versionCount()) - versionsBeforeSecondRun;
    const count = async (sql: string) => Number((await scratch.query<{ n: number }>(sql))[0]?.n ?? 0);
    const heroVersions: ScratchHeroVersionResult = {
      existingWithInitialV1,
      newWithInitialV1: Number((await scratch.query<{ n: number }>(
        `select count(*)::int as n from public.characters c where c.id = any($1::uuid[]) and (select count(*) from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL' and v.version_number = 1) = 1 and c.current_hero_version_id is not null`,
        [run.heroIds],
      ))[0]?.n ?? 0),
      totalInitialVersions: await count("select count(*)::int as n from public.hero_versions where action = 'INITIAL'"),
      totalVersions: await versionCount(),
      missingInitialVersions: await count("select count(*)::int as n from public.characters c where not exists (select 1 from public.hero_versions v where v.character_id = c.id and v.action = 'INITIAL')"),
      duplicateCurrentVersions: await count("select count(*)::int as n from (select current_hero_version_id from public.characters where current_hero_version_id is not null group by 1 having count(*) > 1) d"),
      existingChanged: existingChangedByMigration + (preserved ? 0 : 1),
      existingSnapshotMismatches: snapshotMismatches,
      staleCachedPower,
      secondRunVersionsCreated,
      auditViolations: await count("select count(*)::int as n from public.audit_hero_versions()"),
    };

    await clearScratchArena(scratch);

    // ── RARITY POWER: the 70 existing heroes move onto the rarity power system by an appended SYSTEM_REBALANCE version (migration 1900 is applied above). ──
    const existingIds = (await scratch.query<{ id: string }>(
      `select c.id from public.characters c where c.kind = 'COMMUNITY' and not c.is_demo and not (c.id = any($1::uuid[])) order by c.telegram_user_id`, [run.heroIds],
    )).map((r) => r.id);
    const v1Fingerprint = async () => canonical((await scratch.query<{ row: unknown }>(
      "select to_jsonb(v) as row from public.hero_versions v where v.version_number = 1 and v.character_id = any($1::uuid[]) order by v.character_id", [existingIds],
    )).map((r) => r.row));
    const identityOf = async () => canonical(await scratch.query(
      `select c.id, c.public_id, c.telegram_user_id, c.class_id, a.rarity, a.seed, a.parts->>'skin' as skin, a.parts->>'hairStyle' as hair, a.parts->>'hairColor' as hair_color,
              a.parts->>'eyes' as eyes, a.parts->>'mouth' as mouth, a.parts->>'outfitHue' as hue
         from public.characters c join public.character_appearances a on a.character_id = c.id where c.id = any($1::uuid[]) order by c.id`, [existingIds],
    ));
    const legacyOfInput = input.heroes.map((h) => {
      const cls = input.classes.find((c) => c.id === (h.character as { class_id: string }).class_id)!;
      const st = (h.stats ?? {}) as { variation?: Record<string, number>; telegram_bonus?: Record<string, number>; fixed_stats?: Record<string, number> | null };
      const stats = generatedStats(cls, addStats(st.variation ?? {}), addStats(st.telegram_bonus ?? {}), st.fixed_stats ?? null);
      return { classId: cls.id, rarity: String((h.appearance as { rarity: string }).rarity), power: computePower(stats, input.settings.character) };
    });
    const v1Before = await v1Fingerprint();
    const identityBefore = await identityOf();
    const rebalanceDeps = { settings: input.settings, classes: input.classes, secret: input.classRollSecret };
    const tallyStatus: Record<string, number> = {};
    for (const id of existingIds) {
      const r = await rebalanceHero(scratch, id, "system:scratch-rebalance", rebalanceDeps).catch((e: { code?: string }) => ({ status: e?.code === "HERO_IN_ARENA" ? "DEFERRED" : `ERROR:${String(e?.code ?? e)}` }));
      tallyStatus[r.status] = (tallyStatus[r.status] ?? 0) + 1;
    }
    const v1After = await v1Fingerprint();
    const identityAfter = await identityOf();
    const versionsAfterFirst = await versionCount();
    for (const id of existingIds) await rebalanceHero(scratch, id, "system:scratch-rebalance", rebalanceDeps);
    const secondRunCreated = (await versionCount()) - versionsAfterFirst;

    const current = await scratch.query<{ id: string; is_new: boolean; class_id: string; rarity: string; power: number; stats: Record<string, number>; generator_version: string; action: string; version_number: number; sprite: unknown; cached: number }>(
      `select c.id, (c.id = any($1::uuid[])) as is_new, v.class_id, v.rarity, v.power, v.stats, v.generator_version, v.action, v.version_number, v.sprite, c.power as cached
         from public.characters c join public.hero_versions v on v.id = c.current_hero_version_id where c.kind = 'COMMUNITY' and not c.is_demo`, [run.heroIds],
    );
    const summ = (xs: number[]): PowerSummary => {
      const a = [...xs].sort((x, y) => x - y);
      const q = (p: number) => (a.length ? (a[Math.min(a.length - 1, Math.floor(p * a.length))] as number) : 0);
      return { count: a.length, min: a[0] ?? 0, p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: a[a.length - 1] ?? 0, mean: a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0 };
    };
    const groupBy = <T,>(xs: T[], key: (x: T) => string, val: (x: T) => number) => Object.fromEntries([...new Set(xs.map(key))].sort().map((k) => [k, summ(xs.filter((x) => key(x) === k).map(val))]));
    let invalidPower = 0;
    let outsideTier = 0;
    let cachedPowerMismatch = 0;
    for (const r of current) {
      const stats = r.stats as never;
      if (!Number.isInteger(Number(r.power)) || Number(r.power) < 1 || (r.generator_version === HERO_GENERATOR_VERSION && computeHeroPower(stats, r.class_id) !== Number(r.power))) invalidPower++;
      if (r.generator_version === HERO_GENERATOR_VERSION && !isPowerInBand(r.rarity as Rarity, Number(r.power))) outsideTier++;
      if (Number(r.cached) !== Number(r.power)) cachedPowerMismatch++;
    }
    // a procedural set (hero renderer v3) generates every catalogue item: nothing can be missing; an atlas set is checked against its manifest
    const setId = input.settings.visuals.spriteSet;
    const manifest = isProceduralSet(setId) ? null : parseManifest(JSON.parse(await readFile(path.resolve(process.cwd(), "public", "sprites", setId, "manifest.json"), "utf8")) as unknown);
    const missingAssets = manifest ? current.reduce((n, r) => n + (r.sprite ? planLayers(r.sprite as never, manifest).missing.length : 0), 0) : 0;
    const byRarityMax = (r: Rarity) => Math.max(0, ...current.filter((x) => x.rarity === r).map((x) => Number(x.power)));
    const byRarityMin = (r: Rarity) => Math.min(Infinity, ...current.filter((x) => x.rarity === r).map((x) => Number(x.power)));
    let nonOverlapping = true;
    for (let i = 0; i + 1 < RARITIES.length; i++) if (!(byRarityMax(RARITIES[i]!) < byRarityMin(RARITIES[i + 1]!))) nonOverlapping = false;
    const rarityPower: ScratchRarityPowerResult = {
      generator: HERO_GENERATOR_VERSION,
      heroes: current.length,
      onCurrentGenerator: current.filter((r) => r.generator_version === HERO_GENERATOR_VERSION).length,
      legacyBefore: { overall: summ(legacyOfInput.map((x) => x.power)), byRarity: groupBy(legacyOfInput, (x) => x.rarity, (x) => x.power), byClass: groupBy(legacyOfInput, (x) => x.classId, (x) => x.power) },
      afterExisting: { overall: summ(current.filter((x) => !x.is_new).map((x) => Number(x.power))), byRarity: groupBy(current.filter((x) => !x.is_new), (x) => x.rarity, (x) => Number(x.power)) },
      afterNew: { overall: summ(current.filter((x) => x.is_new).map((x) => Number(x.power))), byRarity: groupBy(current.filter((x) => x.is_new), (x) => x.rarity, (x) => Number(x.power)) },
      all: {
        byRarity: groupBy(current, (x) => x.rarity, (x) => Number(x.power)),
        byClass: Object.fromEntries([...new Set(current.map((x) => x.class_id))].sort().map((c) => [c, current.filter((x) => x.class_id === c).length])),
        rarityCounts: Object.fromEntries(RARITIES.map((r) => [r, current.filter((x) => x.rarity === r).length])),
      },
      rebalance: {
        attempted: existingIds.length,
        rebalanced: tallyStatus.REBALANCED ?? 0,
        deferredInArena: tallyStatus.DEFERRED ?? 0,
        withRebalanceV2: current.filter((r) => !r.is_new && r.action === "SYSTEM_REBALANCE" && Number(r.version_number) === 2).length,
        v1Changed: v1Before === v1After ? 0 : 1,
        identityChanged: identityBefore === identityAfter ? 0 : 1,
        secondRunCreated,
        cachedPowerMismatch,
      },
      invalidPower,
      outsideTier,
      nonOverlapping,
      missingAssets,
      auditRarityViolations: await count("select count(*)::int as n from public.audit_hero_rarity_power()"),
    };
    seed = 0;
    const started = performance.now();
    await advanceArena(scratch, { now: () => new Date(clockMs), secureSeed: () => `scratch-capacity-${++seed}`, allowDemo: false });
    const lineupMs = performance.now() - started;
    const battles = await scratch.query<{ status: string; starts_at: Date }>("select status, starts_at from public.arena_battles order by sequence");
    const initialBattles = battles.length;
    const preparedAhead = battles.filter((battle) => battle.status === "SIMULATED" && new Date(battle.starts_at).getTime() > clockMs).length;
    const eligibleHeroes = Number((await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.characters c left join public.telegram_users u on u.telegram_user_id = c.telegram_user_id
        where c.status = 'ACTIVE' and (u.status is null or u.status <> 'BANNED') and not c.is_demo`,
    ))[0]?.n ?? 0);
    // TOTAL heroes and ARENA-ELIGIBLE heroes are different numbers: a hero a moderator suspended (or whose member is banned) exists, owns its history and is simply not queued.
    // The ones that are not eligible must all be EXISTING heroes — a newly created hero is always eligible.
    const ineligibleNew = Number((await scratch.query<{ n: number }>(
      `select count(*)::int as n from public.characters c left join public.telegram_users u on u.telegram_user_id = c.telegram_user_id
        where c.id = any($1::uuid[]) and not (c.status = 'ACTIVE' and (u.status is null or u.status <> 'BANNED'))`, [run.heroIds],
    ))[0]?.n ?? 0);

    const v = heroVersions;
    const versionsOk = preMigrationVersionsTable === null && v.existingWithInitialV1 === input.heroes.length && v.newWithInitialV1 === run.heroesCreated &&
      v.totalInitialVersions === totalHeroes && v.totalVersions === totalHeroes && v.missingInitialVersions === 0 && v.duplicateCurrentVersions === 0 &&
      v.existingChanged === 0 && v.existingSnapshotMismatches === 0 && v.secondRunVersionsCreated === 0 && v.auditViolations === 0;
    const rp = rarityPower;
    const rarityOk = rp.rebalance.attempted === input.heroes.length && rp.rebalance.rebalanced === input.heroes.length && rp.rebalance.deferredInArena === 0 && rp.rebalance.withRebalanceV2 === input.heroes.length &&
      rp.rebalance.v1Changed === 0 && rp.rebalance.identityChanged === 0 && rp.rebalance.secondRunCreated === 0 && rp.rebalance.cachedPowerMismatch === 0 &&
      rp.onCurrentGenerator === totalHeroes && rp.invalidPower === 0 && rp.outsideTier === 0 && rp.nonOverlapping && rp.missingAssets === 0 && rp.auditRarityViolations === 0;
    if (!rarityOk || !versionsOk || run.heroesCreated !== input.plan.totals.wouldCreate || totalHeroes !== input.heroes.length + input.plan.totals.wouldCreate ||
        duplicateTelegramIdentities !== 0 || !preserved || !preExistingArenaHistoryPreserved || missingEligibleHeroes !== 0 || !idempotentSecondRun ||
        completeGeneratedRows !== run.heroesCreated || ineligibleNew !== 0 || eligibleHeroes > totalHeroes || initialBattles < 3 || preparedAhead !== 2) {
      throw new Error(`Scratch verification failed: ${JSON.stringify({
        heroVersions, rarityPower: { ...rarityPower, legacyBefore: undefined, afterExisting: undefined, afterNew: undefined, all: undefined }, preMigrationVersionsTable, oldHeroes: input.heroes.length, created: run.heroesCreated, totalHeroes, duplicateTelegramIdentities, completeGeneratedRows,
        preserved, preExistingArenaHistoryPreserved, missingEligibleHeroes, idempotentSecondRun, eligibleHeroes, ineligibleNew, initialBattles, preparedAhead,
      })}`);
    }
    return {
      heroVersions,
      rarityPower,
      existingHeroes: input.heroes.length, createdHeroes: run.heroesCreated, totalHeroes, arenaEligibleHeroes: eligibleHeroes, ineligibleHeroes: totalHeroes - eligibleHeroes, duplicateTelegramIdentities, completeGeneratedRows,
      preExistingHeroRowsPreserved: preserved, preExistingArenaHistoryPreserved, missingEligibleHeroes, idempotentSecondRun, scratchMembersRescored: run.rescoredMembers,
      arena: { eligibleHeroes, initialBattles, preparedAhead, lineupMs },
    };
  } finally {
    await scratch.close();
  }
}
