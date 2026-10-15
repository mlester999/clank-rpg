import { ARENA_ACHIEVEMENT_METRICS } from "@/domain/content/achievements";
import { REQUIRED_SCHEMA_OBJECTS, type BackupFact, type LaunchFacts } from "@/domain/launchPreflight";

import type { Queryable } from "../db/types";

import { LIFECYCLE_LOCK_KEY } from "./lifecycleLock";

/**
 * READS THE FACTS the Season 1 launch preflight reasons about (domain/launchPreflight.ts). Read-only: no row is written, no lock is kept. Every number is a real
 * count taken now — and the pre-season is the ACTIVE development season, the run the launch would archive.
 *
 * Tolerant of an older schema on purpose: the preflight is what tells an operator that a migration is missing, so it must be able to answer on a database
 * that does not have every table yet (a table that does not exist reads as zero, and the SCHEMA check fails).
 */
const exists = async (q: Queryable, name: string): Promise<boolean> => (await q.query<{ ok: boolean }>("select to_regclass($1) is not null as ok", [`public.${name}`]))[0]?.ok === true;
const procExists = async (q: Queryable, signature: string): Promise<boolean> => (await q.query<{ ok: boolean }>("select to_regprocedure($1) is not null as ok", [signature]))[0]?.ok === true;
const num = async (q: Queryable, sql: string, params: readonly unknown[] = []): Promise<number> => Number(((await q.query<{ n: number | string }>(sql, params))[0] as { n: number | string } | undefined)?.n ?? 0);

async function missingObjects(q: Queryable): Promise<string[]> {
  const missing: string[] = [];
  for (const obj of REQUIRED_SCHEMA_OBJECTS) {
    const name = obj.replace("public.", "");
    const ok = name.endsWith("()") ? await procExists(q, obj) : await exists(q, name);
    if (!ok) missing.push(name);
  }
  return missing;
}

async function latestApplied(q: Queryable): Promise<string | null> {
  const rows = await q.query<{ v: string | null }>("select max(version) as v from supabase_migrations.schema_migrations").catch(() => []);
  return (rows[0] as { v: string | null } | undefined)?.v ?? null;
}

/** True when a lifecycle action or a reward finalization currently holds the lifecycle lock. (An exclusive try that cannot be granted means someone holds it.) */
async function lifecycleLockBusy(q: Queryable): Promise<boolean> {
  const [r] = await q.query<{ got: boolean }>("select pg_try_advisory_xact_lock($1::bigint) as got", [LIFECYCLE_LOCK_KEY]);
  return r?.got === false;
}

export async function loadLaunchBackup(q: Queryable): Promise<BackupFact | null> {
  if (!(await exists(q, "launch_backup_attestations"))) return null;
  const [r] = await q.query<{ id: string; attested_by: string; attested_at: Date; reference: string; verified: boolean; schema_version: string }>(
    "select id, attested_by, attested_at, reference, verified, schema_version from public.launch_backup_attestations order by attested_at desc, id desc limit 1",
  );
  return r ? { id: r.id, attestedBy: r.attested_by, attestedAt: new Date(r.attested_at).getTime(), reference: r.reference, verified: r.verified, schemaVersion: r.schema_version } : null;
}

export async function loadLaunchFacts(q: Queryable, allowDemo: boolean): Promise<LaunchFacts> {
  const [applied, missing] = await Promise.all([latestApplied(q), missingObjects(q)]);
  const hasLifecycle = await exists(q, "game_state");
  const [season] = hasLifecycle ? await q.query<{ id: string; name: string }>("select id, name from public.seasons where status = 'ACTIVE' limit 1") : [];
  const sid = season?.id ?? null;

  const [pop] = await q.query<{ total: number; eligible: number; suspended: number }>(
    `select count(*)::int as total,
            (count(*) filter (where c.status = 'ACTIVE' and (tu.status is null or tu.status <> 'BANNED')))::int as eligible,
            (count(*) filter (where c.status = 'SUSPENDED'))::int as suspended
       from public.characters c left join public.telegram_users tu on tu.telegram_user_id = c.telegram_user_id where (not c.is_demo or $1::boolean)`,
    [allowDemo],
  );
  const versions = (await exists(q, "hero_versions")) ? await num(q, "select count(*)::int as n from public.hero_versions") : 0;
  const members = await num(q, "select count(*)::int as n from public.telegram_users");

  const battles = sid
    ? (
        await q.query<{ settled: number; voided: number; open: number }>(
          `select (count(*) filter (where status = 'SETTLED'))::int as settled, (count(*) filter (where status = 'VOID'))::int as voided,
                  (count(*) filter (where status in ('SCHEDULED', 'SIMULATED')))::int as open from public.arena_battles where season_id = $1`,
          [sid],
        )
      )[0]
    : undefined;

  const hasScores = await exists(q, "arena_pick_scores");
  const hasSettlements = await exists(q, "arena_pick_settlements");
  const picksSubmitted = sid ? await num(q, "select count(*)::int as n from public.arena_picks p join public.arena_battles b on b.id = p.battle_id where b.season_id = $1", [sid]) : 0;
  const scored = sid && hasScores ? await num(q, "select count(*)::int as n from public.arena_pick_scores where season_id = $1", [sid]) : 0;
  const awaiting = async (status: "SETTLED" | "VOID") =>
    sid && hasSettlements
      ? num(
          q,
          `select count(*)::int as n from public.arena_battles b
            where b.season_id = $1 and b.status = $2
              and exists (select 1 from public.arena_picks p where p.battle_id = b.id and p.reward_eligible)
              and not exists (select 1 from public.arena_pick_settlements s where s.battle_id = b.id)`,
          [sid, status],
        )
      : 0;

  const hasBoards = await exists(q, "arena_leaderboards");
  const hasHeroBoards = await exists(q, "hero_arena_boards");
  const picksBoards = hasBoards && sid ? await num(q, "select count(*)::int as n from public.arena_leaderboards where season_id = $1", [sid]) : 0;
  const picksResults = hasBoards && sid ? await num(q, "select count(*)::int as n from public.arena_leaderboard_results r join public.arena_leaderboards b on b.kind = r.kind and b.period_start = r.period_start where b.season_id = $1", [sid]) : 0;
  const heroBoards = hasHeroBoards && sid ? await num(q, "select count(*)::int as n from public.hero_arena_boards where season_id = $1", [sid]) : 0;
  const heroResults = hasHeroBoards && sid ? await num(q, "select count(*)::int as n from public.hero_arena_results r join public.hero_arena_boards b on b.kind = r.kind and b.period_start = r.period_start where b.season_id = $1", [sid]) : 0;

  const withRecords = sid ? await num(q, "select count(*)::int as n from public.season_character_stats where season_id = $1 and battles > 0", [sid]) : 0;
  const career = await num(q, "select count(*)::int as n from public.characters where arena_battles <> 0 or arena_wins <> 0 or arena_top2 <> 0 or arena_eliminations <> 0 or arena_damage <> 0");

  const [gold] = await q.query<{ accounts: number; total: string }>("select count(*)::int as accounts, coalesce(sum(balance), 0)::text as total from public.currency_accounts where balance > 0");
  const hasArchivable = await q.query<{ ok: boolean }>("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'archived_at') as ok");
  const archivable = hasArchivable[0]?.ok === true;
  const loot = await num(q, `select count(*)::int as n from public.inventory_items${archivable ? " where archived_at is null" : ""}`);
  const lootNotBattle = await num(q, `select count(*)::int as n from public.inventory_items where acquired_via <> 'ARENA_DROP'${archivable ? " and archived_at is null" : ""}`);
  const achievementsArchivable = (await q.query<{ ok: boolean }>("select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'character_achievements' and column_name = 'archived_at') as ok"))[0]?.ok === true;
  const metrics = `{${ARENA_ACHIEVEMENT_METRICS.join(",")}}`;
  const arenaAchievements = await num(
    q,
    `select count(*)::int as n from public.character_achievements ca join public.achievements a on a.id = ca.achievement_id
      where ${achievementsArchivable ? "ca.archived_at is null and" : ""} a.criteria->>'metric' = any($1::text[]) and coalesce(ca.context->>'granted', '') <> 'admin'`,
    [metrics],
  );
  const [permGold] = await q.query<{ total: string }>(
    `select coalesce(sum(l.delta), 0)::text as total from public.currency_ledger l join public.achievements a on a.id = l.ref_id
      where l.reason = 'achievement' and l.delta > 0 and not (a.criteria->>'metric' = any($1::text[]))`,
    [metrics],
  );

  const activeCycle = (await exists(q, "arena_cycles")) ? (await num(q, "select count(*)::int as n from public.arena_cycles where status = 'ACTIVE'")) > 0 : false;
  const unfinalized =
    sid && hasScores && hasBoards
      ? await num(
          q,
          `select ((select count(distinct s.utc_date) from public.arena_pick_scores s where s.season_id = $1 and s.utc_date < (now() at time zone 'UTC')::date
                       and not exists (select 1 from public.arena_leaderboards l where l.kind = 'DAILY' and l.period_start = s.utc_date))
                 + (select count(distinct s.week_start) from public.arena_pick_scores s where s.season_id = $1 and s.week_start < date_trunc('week', now() at time zone 'UTC')::date
                       and not exists (select 1 from public.arena_leaderboards l where l.kind = 'WEEKLY' and l.period_start = s.week_start)))::int as n`,
          [sid],
        )
      : 0;
  const chat = (await exists(q, "arena_chat_messages")) ? await num(q, "select count(*)::int as n from public.arena_chat_messages") : 0;
  const archivedRuns = hasLifecycle ? await num(q, "select count(*)::int as n from public.seasons where status = 'ENDED'") : 0;

  return {
    schema: { latestApplied: applied, missingObjects: missing },
    season: { id: sid, label: season?.name ?? null },
    heroes: { total: pop?.total ?? 0, eligible: pop?.eligible ?? 0, suspended: pop?.suspended ?? 0, versions },
    members,
    battles: { settled: battles?.settled ?? 0, voided: battles?.voided ?? 0, open: battles?.open ?? 0 },
    picks: { submitted: picksSubmitted, scored, settledBattlesAwaitingScoring: await awaiting("SETTLED"), voidBattlesAwaitingScoring: await awaiting("VOID") },
    boards: { picksBoards, picksResults, heroBoards, heroResults },
    heroRecords: { heroesWithRecords: withRecords, careerCounters: career },
    economy: { goldAccounts: gold?.accounts ?? 0, goldTotal: gold?.total ?? "0", lootItems: loot, arenaAchievements, goldFromPermanentAchievements: permGold?.total ?? "0", lootNotFromBattles: lootNotBattle },
    jobs: { activeCycle, lifecycleLockBusy: await lifecycleLockBusy(q), unfinalizedPeriods: unfinalized },
    chatMessages: chat,
    archivedRuns,
    backup: await loadLaunchBackup(q),
  };
}
