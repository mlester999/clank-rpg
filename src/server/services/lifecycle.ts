import {
  ARENA_STATUS_LABEL,
  CONFIRM,
  arenaIsStopped,
  confirmationMatches,
  seasonChipLabel,
  type ArenaRuntimeStatus,
  type ConfirmAction,
  type GamePhase,
  type SeasonKind,
} from "@/domain/lifecycle";
import type { ActionAvailability, Blocker, GameControl, RewardLiabilities, SeasonView } from "@/domain/lifecycleDto";
import { json, type Db, type Queryable } from "../db/types";
import { loadSettings } from "../config/settingsRepo";

import { AdminError } from "./adminError";
import { arenaPopulation } from "./arenaEligibility";
import { committedBattles } from "./arenaRuntime";
import { archiveDevelopmentEconomy, type DevelopmentEconomyArchive } from "./developmentEconomy";
import { audit } from "./auditLog";
import { lockLifecycleExclusive } from "./lifecycleLock";

/**
 * THE GAME LIFECYCLE SERVICE — every Admin action that changes where the game is: LAUNCH SEASON 1, START / PAUSE / RESUME the Arena, RESET the
 * development run, END a season and CREATE the next one. Read-only state for the Admin "Game control" panel comes from `getGameControl`.
 *
 * Rules every action here follows:
 *  · ONE transaction, and the FIRST thing it does is lock `arena_state` (then `game_state`, then the season rows — the same order the Arena's own
 *    step uses). That serialises it against the Arena worker / viewers' advances, against every other lifecycle action and against itself, so a
 *    double click, two Admin windows, a retry, a launch racing a tick or a start racing a reset can never both win. The loser sees the state the
 *    winner left and is refused with a clear message (compare-and-set by construction: the checks run AFTER the lock).
 *  · The state machines are the ones in domain/lifecycle.ts, which the database enforces as well (migration 20261006002000).
 *  · HEROES ARE NEVER TOUCHED. Nothing here reads a hero into memory, rerolls, rebalances or writes a hero, a hero version or an appearance —
 *    competitive records live in season tables layered around the permanent hero. A launch also fingerprints every hero before and after, inside the
 *    transaction, and rolls back if a single byte of identity, class, rarity, stats, PWR, look or version changed.
 *  · History is archived, never deleted: an ended season keeps its battles, snapshots, hashes, results, stats and picks (replays still verify).
 *  · Every action is written to the admin audit log in the same transaction (GAME_LAUNCH, ARENA_START, ARENA_PAUSE_REQUEST, ARENA_PAUSED,
 *    ARENA_RESUME, SEASON_RESET, SEASON_END, SEASON_CREATE) with the previous and the new state. No secrets are logged.
 */

export type { ActionAvailability, Blocker, GameControl, LifecycleActionId, RewardLiabilities, SeasonView } from "@/domain/lifecycleDto";

export interface LifecycleDeps {
  actor: string;
  /** Whether demo heroes count as Arena-eligible here (local previews only). */
  allowDemo: boolean;
  /** The Arena's clock (tests drive a fake one); defaults to the wall clock. */
  now?: () => Date;
}

const clock = (deps: { now?: () => Date }): Date => (deps.now ? deps.now() : new Date());

// ---------------------------------------------------------------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------------------------------------------------------------

interface SeasonRow {
  id: string;
  kind: SeasonKind;
  number: number | null;
  run_number: number | null;
  name: string;
  status: "UPCOMING" | "ACTIVE" | "ENDED";
  starts_at: Date;
  ends_at: Date | null;
  battle_counter: number | string;
  ended_reason: string | null;
  archive: Record<string, unknown> | null;
}

const SEASON_COLS = "id, kind, number, run_number, name, status, starts_at, ends_at, battle_counter, ended_reason, archive";
const ms = (d: Date | string | null | undefined): number | null => (d ? new Date(d).getTime() : null);

const toSeasonView = (s: SeasonRow): SeasonView => ({
  id: s.id,
  kind: s.kind,
  number: s.number,
  name: s.name,
  label: seasonChipLabel({ kind: s.kind, number: s.number, name: s.name }),
  status: s.status,
  startsAt: ms(s.starts_at),
  endsAt: ms(s.ends_at),
  lastBattleNumber: Number(s.battle_counter),
  endedReason: s.ended_reason,
  archive: s.archive,
});

/**
 * What the reward programme owes RIGHT NOW. A launch / reset refuses when any prize has been credited (it would sit in the ledger as claimable
 * after the token launches), a claim is pending or has been paid, or a prize is held for review — those are real obligations that must be
 * resolved on purpose (reverse them with the audited adjustment tool in Admin → Arena Picks) before competitive state is reset. Picks and scores of
 * periods that were never finalized are NOT a liability: they were never paid, and the archived development run is never finalized afterwards.
 */
export async function rewardLiabilities(q: Queryable): Promise<RewardLiabilities> {
  const [tables] = await q.query<{ accounts: boolean; claims: boolean; results: boolean; boards: boolean }>(
    `select to_regclass('public.arena_reward_accounts') is not null as accounts, to_regclass('public.arena_reward_claims') is not null as claims,
            to_regclass('public.arena_leaderboard_results') is not null as results, to_regclass('public.arena_leaderboards') is not null as boards`,
  );
  const out: RewardLiabilities = { checked: false, blocking: false, earnedMicro: "0", claimableMicro: "0", reservedMicro: "0", claimedMicro: "0", pendingOrSentClaims: 0, heldPrizes: 0, finalizedBoards: 0, reasons: [] };
  if (!tables?.accounts) return out;
  out.checked = true;
  const [t] = await q.query<{ c: string; r: string; k: string; e: string }>(
    "select coalesce(sum(claimable), 0)::text as c, coalesce(sum(reserved), 0)::text as r, coalesce(sum(claimed_total), 0)::text as k, coalesce(sum(earned_total), 0)::text as e from public.arena_reward_accounts",
  );
  out.claimableMicro = t?.c ?? "0";
  out.reservedMicro = t?.r ?? "0";
  out.claimedMicro = t?.k ?? "0";
  out.earnedMicro = t?.e ?? "0";
  if (tables.claims) {
    const [c] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_reward_claims where status in ('PENDING', 'SENT')");
    out.pendingOrSentClaims = c?.n ?? 0;
  }
  if (tables.results) {
    const [h] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_leaderboard_results where base_status = 'HELD'");
    out.heldPrizes = h?.n ?? 0;
  }
  if (tables.boards) {
    const [b] = await q.query<{ n: number }>("select count(*)::int as n from public.arena_leaderboards");
    out.finalizedBoards = b?.n ?? 0;
  }
  if (BigInt(out.earnedMicro) > 0n) out.reasons.push("Leaderboard prizes have been credited (they would stay claimable after the token launches).");
  if (BigInt(out.reservedMicro) > 0n) out.reasons.push("A claim is reserved (a payout is in flight).");
  if (BigInt(out.claimedMicro) > 0n) out.reasons.push("Rewards have already been paid out.");
  if (out.pendingOrSentClaims > 0) out.reasons.push(`${out.pendingOrSentClaims} claim(s) are pending or sent.`);
  if (out.heldPrizes > 0) out.reasons.push(`${out.heldPrizes} prize(s) are held for review.`);
  out.blocking = out.reasons.length > 0;
  return out;
}

async function gameRow(q: Queryable): Promise<{ phase: GamePhase; launched_at: Date | null }> {
  const [row] = await q.query<{ phase: GamePhase; launched_at: Date | null }>("select phase, launched_at from public.game_state where id = 1");
  if (!row) throw new AdminError("NO_GAME_STATE", 500, "The game state row is missing (is migration 20261006002000 applied?).");
  return row;
}

interface ArenaRow {
  status: ArenaRuntimeStatus;
  status_changed_at: Date;
  started_at: Date | null;
  last_advance_at: Date | null;
}
async function arenaRow(q: Queryable, lock: boolean): Promise<ArenaRow> {
  const [row] = await q.query<ArenaRow>(`select status, status_changed_at, started_at, last_advance_at from public.arena_state where id = 1${lock ? " for update" : ""}`);
  if (!row) throw new AdminError("NO_ARENA_STATE", 500, "The arena state row is missing.");
  return row;
}

async function activeSeason(q: Queryable, lock: boolean): Promise<SeasonRow | null> {
  const [row] = await q.query<SeasonRow>(`select ${SEASON_COLS} from public.seasons where status = 'ACTIVE'${lock ? " for update" : ""}`);
  return row ?? null;
}

/** Daily / weekly boards of the season that have picks but are not finalized yet (their prizes would be skipped by ending the season now). */
async function unfinalizedPeriods(q: Queryable, seasonId: string): Promise<number> {
  const [ready] = await q.query<{ ok: boolean }>("select to_regclass('public.arena_pick_scores') is not null and to_regclass('public.arena_leaderboards') is not null as ok");
  if (!ready?.ok) return 0;
  const [r] = await q.query<{ n: number }>(
    `select (
        (select count(distinct s.utc_date) from public.arena_pick_scores s where s.season_id = $1
           and not exists (select 1 from public.arena_leaderboards l where l.kind = 'DAILY' and l.period_start = s.utc_date))
      + (select count(distinct s.week_start) from public.arena_pick_scores s where s.season_id = $1
           and not exists (select 1 from public.arena_leaderboards l where l.kind = 'WEEKLY' and l.period_start = s.week_start))
     )::int as n`,
    [seasonId],
  );
  return r?.n ?? 0;
}

async function battleLabels(q: Queryable, nowIso: string, seasonId: string | null): Promise<GameControl["battles"]> {
  const cur = seasonId
    ? (await q.query<{ n: number; status: string }>(
        "select season_sequence as n, status from public.arena_battles where season_id = $1 and status in ('SIMULATED', 'SETTLED') and starts_at <= $2::timestamptz order by sequence desc limit 1",
        [seasonId, nowIso],
      ))[0]
    : undefined;
  const nxt = seasonId
    ? (await q.query<{ n: number; status: string }>(
        "select season_sequence as n, status from public.arena_battles where season_id = $1 and (status = 'SCHEDULED' or (status = 'SIMULATED' and starts_at > $2::timestamptz)) order by sequence limit 1",
        [seasonId, nowIso],
      ))[0]
    : undefined;
  const [last] = seasonId ? await q.query<{ n: number }>("select battle_counter::int as n from public.seasons where id = $1", [seasonId]) : [];
  const lastNumber = last?.n ?? 0;
  return {
    current: cur ? { number: Number(cur.n), status: cur.status } : null,
    next: nxt ? { number: Number(nxt.n), status: nxt.status } : null,
    last: lastNumber,
    nextToIssue: lastNumber + 1,
  };
}

const ok = (over: Partial<ActionAvailability> = {}): ActionAvailability => ({ allowed: true, blockers: [], warnings: [], phrase: null, ...over });
const blocked = (...blockers: Blocker[]): ActionAvailability => ({ allowed: false, blockers, warnings: [], phrase: null });

/** What each Admin action may do RIGHT NOW. The actions re-run this inside their own (locked) transaction and refuse on the first blocker. */
export async function evaluateActions(q: Queryable, deps: { allowDemo: boolean; now?: () => Date }): Promise<{ control: Omit<GameControl, "now" | "actions">; actions: GameControl["actions"] }> {
  const nowDate = clock(deps);
  const [game, arena, season, heroes, held, rewards, settings, seasons] = await Promise.all([
    gameRow(q),
    arenaRow(q, false),
    activeSeason(q, false),
    arenaPopulation(q, deps.allowDemo),
    committedBattles(q, nowDate.getTime()),
    rewardLiabilities(q),
    loadSettings(q),
    q.query<SeasonRow>(`select ${SEASON_COLS} from public.seasons order by starts_at desc, created_at desc limit 12`),
  ]);
  const groupSize = settings.arena.groupSize;
  const live = game.phase === "LIVE";
  const stopped = arenaIsStopped(arena.status);
  const status = arena.status;
  const seasonView = season ? toSeasonView(season) : null;
  const open = held.unsettled;
  const battles = await battleLabels(q, nowDate.toISOString(), season?.id ?? null);

  const actions = {} as GameControl["actions"];

  // LAUNCH SEASON 1 — DEVELOPMENT only; the Arena must be stopped; real reward obligations block it.
  {
    const b: Blocker[] = [];
    if (live) b.push({ code: "ALREADY_LIVE", message: "The game is already LIVE: Season 1 has been launched." });
    if (!live && !stopped) b.push({ code: "ARENA_NOT_STOPPED", message: `The Arena is ${ARENA_STATUS_LABEL[status].toLowerCase()}. Pause it and let it finish its battles before launching.` });
    if (!live && rewards.blocking) b.push({ code: "REWARD_LIABILITIES", message: `Reward obligations exist: ${rewards.reasons.join(" ")} Resolve them in Admin → Arena Picks first.` });
    const warnings: string[] = [];
    if (!live && heroes.eligible < groupSize) warnings.push(`Only ${heroes.eligible} hero(es) are Arena-eligible; the Arena needs ${groupSize} to start.`);
    if (!live && open > 0) warnings.push(`${open} unsettled development battle(s) will be voided when the run is archived.`);
    if (!live && settings.arena_picks.enabled) warnings.push("Leaderboard prizes are ON during development: a finalized Daily / Weekly board credits prizes, and a credited prize blocks the launch until it is reversed. Pause prizes in Arena Picks while testing.");
    actions.launch = b.length ? { ...blocked(...b), warnings } : ok({ warnings, phrase: CONFIRM.LAUNCH });
  }
  // START ARENA
  {
    const b: Blocker[] = [];
    if (status !== "NOT_STARTED") b.push({ code: "ARENA_ALREADY_STARTED", message: `The Arena is already ${ARENA_STATUS_LABEL[status].toLowerCase()}.` });
    if (!season) b.push({ code: "NO_ACTIVE_SEASON", message: "There is no active season to run battles in." });
    if (heroes.eligible < groupSize) b.push({ code: "NOT_ENOUGH_HEROES", message: `${heroes.eligible} Arena-eligible hero(es): a battle needs ${groupSize}.` });
    actions.startArena = b.length ? blocked(...b) : ok();
  }
  // PAUSE ARENA
  {
    const can = status === "RUNNING" || status === "PREPARING";
    actions.pauseArena = can ? ok({ warnings: held.total > 0 ? ["The Arena finishes the battles already committed (on stage, announced, prepared) and then pauses; no new battle is made."] : [] }) : blocked({ code: "INVALID_STATE", message: `The Arena is ${ARENA_STATUS_LABEL[status].toLowerCase()}: there is nothing to pause.` });
  }
  // RESUME ARENA
  {
    const can = status === "PAUSED" || status === "PAUSE_REQUESTED";
    const b: Blocker[] = [];
    if (!can) b.push({ code: "INVALID_STATE", message: `The Arena is ${ARENA_STATUS_LABEL[status].toLowerCase()}: only a paused Arena can resume.` });
    if (can && !season) b.push({ code: "NO_ACTIVE_SEASON", message: "There is no active season to resume." });
    actions.resumeArena = b.length ? blocked(...b) : ok();
  }
  // RESET THE DEVELOPMENT RUN — development only (a live season is ended, never reset)
  {
    const b: Blocker[] = [];
    if (live) b.push({ code: "LIVE_RESET_FORBIDDEN", message: "The game is LIVE: a season is never reset. End the season and create the next one." });
    if (!live && !stopped) b.push({ code: "ARENA_NOT_STOPPED", message: `The Arena is ${ARENA_STATUS_LABEL[status].toLowerCase()}. Pause it and let it finish its battles before resetting.` });
    if (!live && rewards.blocking) b.push({ code: "REWARD_LIABILITIES", message: `Reward obligations exist: ${rewards.reasons.join(" ")} Resolve them in Admin → Arena Picks first.` });
    actions.resetDevelopment = b.length ? blocked(...b) : ok({ phrase: CONFIRM.RESET, warnings: open > 0 ? [`${open} unsettled development battle(s) will be voided.`] : [] });
  }
  // END SEASON — LIVE only
  {
    const b: Blocker[] = [];
    if (!live) b.push({ code: "NOT_LIVE", message: "The game is still in DEVELOPMENT: reset the development run, or launch Season 1." });
    if (live && !season) b.push({ code: "NO_ACTIVE_SEASON", message: "There is no active season to end." });
    if (live && season && !stopped) b.push({ code: "ARENA_NOT_STOPPED", message: `The Arena is ${ARENA_STATUS_LABEL[status].toLowerCase()}. Pause it and let it finish its battles first.` });
    if (live && season && open > 0) b.push({ code: "OPEN_BATTLES", message: `${open} battle(s) are committed but not settled.` });
    if (live && season) {
      const periods = await unfinalizedPeriods(q, season.id);
      if (periods > 0) b.push({ code: "UNFINALIZED_PERIODS", message: `${periods} Daily/Weekly board(s) of this season have picks but are not finalized yet; ending now would skip their prizes. Wait for the period to end and finalize.` });
    }
    actions.endSeason = b.length ? blocked(...b) : ok({ phrase: CONFIRM.END_SEASON });
  }
  // CREATE THE NEXT SEASON — LIVE, between seasons
  {
    const b: Blocker[] = [];
    if (!live) b.push({ code: "NOT_LIVE", message: "Seasons are created after the launch." });
    if (live && season) b.push({ code: "SEASON_ACTIVE", message: `${seasonView?.label ?? "A season"} is still active: end it first.` });
    actions.createSeason = b.length ? blocked(...b) : ok();
  }

  return {
    control: {
      phase: game.phase,
      launchedAt: ms(game.launched_at),
      season: seasonView,
      arena: { status, label: ARENA_STATUS_LABEL[status], statusChangedAt: ms(arena.status_changed_at), startedAt: ms(arena.started_at), lastAdvanceAt: ms(arena.last_advance_at), openBattles: open, committedBattles: held.total },
      heroes,
      battles,
      rewards,
      seasons: seasons.map(toSeasonView),
      groupSize,
    },
    actions,
  };
}

export async function getGameControl(q: Queryable, deps: { allowDemo: boolean; now?: () => Date }): Promise<GameControl> {
  const { control, actions } = await evaluateActions(q, deps);
  return { now: clock(deps).getTime(), ...control, actions };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Helpers shared by the actions
// ---------------------------------------------------------------------------------------------------------------------------------

function refuse(a: ActionAvailability): never {
  const first = a.blockers[0] as Blocker;
  throw new AdminError(first.code, 409, first.message);
}

function requirePhrase(action: ConfirmAction, typed: unknown): void {
  if (!confirmationMatches(action, typed)) throw new AdminError("CONFIRMATION_REQUIRED", 422, `Type ${CONFIRM[action]} exactly to confirm.`);
}

/**
 * A fingerprint of every hero's IMMUTABLE identity: id, public id, Telegram link, kind, origin, the current hero version, the stored look (rarity,
 * parts, sprite, seed) and stats, and every hero version ever written (class, rarity, stats, PWR, generator — append-only rows) — plus how many versions
 * exist. A lifecycle action must leave it byte-identical: rarity, class and stats are a hero VERSION, so "the hero did not change" and "no version was
 * written" are the same statement. (It deliberately leaves out what other actors may legitimately change while a launch is running — status, RPG name,
 * title, notes, the cached power, the lifetime counters — so a concurrent Admin edit can never abort a launch by accident.)
 */
export interface HeroFingerprint {
  heroes: number;
  versions: number;
  hash: string;
}
export async function heroFingerprint(q: Queryable): Promise<HeroFingerprint> {
  const cols = await q.query<{ table_name: string; column_name: string }>(
    "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name in ('characters', 'character_appearances', 'character_stats', 'hero_versions')",
  );
  const has = (t: string, c: string) => cols.some((x) => x.table_name === t && x.column_name === c);
  const hasVersions = cols.some((x) => x.table_name === "hero_versions");
  const parts = [
    "c.id::text", "coalesce(c.public_id, '')", "c.kind", "c.origin", "c.is_demo::text", "coalesce(c.telegram_user_id::text, '')", "c.class_id",
    has("characters", "current_hero_version_id") ? "coalesce(c.current_hero_version_id::text, '')" : "''",
    "coalesce(ca.rarity, '')", "coalesce(ca.parts::text, '')", has("character_appearances", "sprite") ? "coalesce(ca.sprite::text, '')" : "''", "coalesce(ca.seed, '')",
    "coalesce(cs.variation::text, '')", "coalesce(cs.telegram_bonus::text, '')",
    hasVersions ? "coalesce((select string_agg(to_jsonb(v)::text, '|' order by v.version_number) from public.hero_versions v where v.character_id = c.id), '')" : "''",
  ];
  const [row] = await q.query<{ heroes: number; hash: string }>(
    `select count(*)::int as heroes, md5(coalesce(string_agg(concat_ws('|', ${parts.join(", ")}), E'\n' order by c.id), '')) as hash
       from public.characters c left join public.character_appearances ca on ca.character_id = c.id left join public.character_stats cs on cs.character_id = c.id`,
  );
  let versions = 0;
  if (hasVersions) {
    const [v] = await q.query<{ n: number }>("select count(*)::int as n from public.hero_versions");
    versions = v?.n ?? 0;
  }
  return { heroes: row?.heroes ?? 0, versions, hash: row?.hash ?? "" };
}

function sameHeroes(a: HeroFingerprint, b: HeroFingerprint): boolean {
  return a.heroes === b.heroes && a.versions === b.versions && a.hash === b.hash;
}

interface ArchiveSummary {
  seasonId: string;
  label: string;
  reason: "LAUNCH" | "DEVELOPMENT_RESET" | "SEASON_END";
  battlesSettled: number;
  battlesVoided: number;
  lastBattleNumber: number;
  heroesWithRecords: number;
  pickScores: number;
  cyclesAborted: number;
  queueEntriesReleased: number;
}

/**
 * ARCHIVES the active season: voids the battles that were never settled (their picks resolve as VOID, exactly as an Admin "void" does), aborts the
 * cycle that was running (its queue entries are released: SKIPPED, so the queue-integrity checks stay clean), and marks the season ENDED with a
 * summary. Nothing is deleted: settled battles, snapshots, seeds, hashes, results, per-hero season stats and pick scores all stay and stay
 * replayable. Must be called with the arena_state lock held and the Arena stopped.
 */
async function archiveSeason(tx: Queryable, season: SeasonRow, reason: ArchiveSummary["reason"]): Promise<ArchiveSummary> {
  const voided = await tx.query<{ id: string }>(
    "update public.arena_battles set status = 'VOID' where season_id = $1 and status in ('SCHEDULED', 'SIMULATED') returning id",
    [season.id],
  );
  const cycles = await tx.query<{ id: string }>("update public.arena_cycles set status = 'ABORTED', completed_at = now() where status = 'ACTIVE' returning id");
  let released = 0;
  if (cycles.length > 0 || voided.length > 0) {
    const r = await tx.query(
      `update public.arena_queue_entries set status = 'SKIPPED', battle_id = null
        where status in ('PENDING', 'IN_BATTLE')
          and (cycle_id in (select (jsonb_array_elements_text($1::jsonb))::uuid) or battle_id in (select (jsonb_array_elements_text($2::jsonb))::uuid))
        returning id`,
      [json(cycles.map((c) => c.id)), json(voided.map((v) => v.id))],
    );
    released = r.length;
  }
  const [counts] = await tx.query<{ settled: number; void: number; heroes: number; scores: number }>(
    `select (select count(*)::int from public.arena_battles where season_id = $1 and status = 'SETTLED') as settled,
            (select count(*)::int from public.arena_battles where season_id = $1 and status = 'VOID') as void,
            (select count(*)::int from public.season_character_stats where season_id = $1 and battles > 0) as heroes,
            (select case when to_regclass('public.arena_pick_scores') is null then 0 else (select count(*)::int from public.arena_pick_scores where season_id = $1) end) as scores`,
    [season.id],
  );
  const [counter] = await tx.query<{ n: number }>("select battle_counter::int as n from public.seasons where id = $1", [season.id]);
  const summary: ArchiveSummary = {
    seasonId: season.id,
    label: seasonChipLabel({ kind: season.kind, number: season.number, name: season.name }),
    reason,
    battlesSettled: counts?.settled ?? 0,
    battlesVoided: counts?.void ?? 0,
    lastBattleNumber: counter?.n ?? 0,
    heroesWithRecords: counts?.heroes ?? 0,
    pickScores: counts?.scores ?? 0,
    cyclesAborted: cycles.length,
    queueEntriesReleased: released,
  };
  await tx.query(
    "update public.seasons set status = 'ENDED', ends_at = greatest(now(), starts_at + interval '1 millisecond'), ended_reason = $2, archive = $3::jsonb where id = $1",
    [season.id, reason, json({ ...summary, archivedAt: new Date().toISOString() })],
  );
  return summary;
}

async function setArena(tx: Queryable, from: ArenaRuntimeStatus, to: ArenaRuntimeStatus, extra = ""): Promise<void> {
  const rows = await tx.query(`update public.arena_state set status = $2${extra} where id = 1 and status = $1 returning id`, [from, to]);
  if (rows.length === 0) throw new AdminError("INVALID_STATE", 409, "The Arena changed state while this action was running; refresh and look again.");
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------------------------------------------------------------

export interface LaunchResult {
  seasonId: string;
  seasonNumber: number;
  archived: ArchiveSummary | null;
  /** What was archived from the development economy (Gold, loot, achievements, titles, career counters). */
  economy: DevelopmentEconomyArchive;
  heroes: HeroFingerprint;
}

/**
 * LAUNCH SEASON 1: archives the development run and creates a clean Season 1 — and leaves the Arena NOT STARTED. One-way (DEVELOPMENT → LIVE).
 * Heroes are untouched (fingerprinted before and after). Public records of Season 1 begin at zero because they are read from Season 1's own rows.
 */
export async function launchSeason1(db: Db, deps: LifecycleDeps, input: { confirmation: string }): Promise<LaunchResult> {
  requirePhrase("LAUNCH", input.confirmation);
  return db.transaction(async (tx) => {
    const arena = await arenaRow(tx, true); // lock order: arena_state → game_state → seasons
    const game = await tx.query<{ phase: GamePhase }>("select phase from public.game_state where id = 1 for update");
    if (!game[0]) throw new AdminError("NO_GAME_STATE", 500, "The game state row is missing.");
    await lockLifecycleExclusive(tx); // reward finalizations in flight finish first; later ones wait for this action (services/lifecycleLock.ts)
    const { actions } = await evaluateActions(tx, deps);
    if (!actions.launch.allowed) refuse(actions.launch);

    const before = await heroFingerprint(tx);
    const dev = await activeSeason(tx, true);
    const heroes = await arenaPopulation(tx, deps.allowDemo);
    const archived = dev ? await archiveSeason(tx, dev, "LAUNCH") : null;

    const [existing] = await tx.query<{ n: number }>("select coalesce(max(number), 0)::int as n from public.seasons where kind = 'COMPETITIVE'");
    if ((existing?.n ?? 0) > 0) throw new AdminError("SEASON_EXISTS", 409, "A competitive season already exists.");
    const [season] = await tx.query<{ id: string }>(
      "insert into public.seasons (kind, number, name, status, starts_at, created_by) values ('COMPETITIVE', 1, 'Season 1', 'ACTIVE', now(), $1) returning id",
      [deps.actor],
    );
    const seasonId = (season as { id: string }).id;
    // The Arena starts NOT_STARTED in Season 1: nothing runs until START ARENA, even with a worker process running.
    if (arena.status === "PAUSED") await setArena(tx, "PAUSED", "NOT_STARTED", ", last_advance_at = null, started_at = null");
    else await tx.query("update public.arena_state set last_advance_at = null, started_at = null where id = 1");
    // Development progress (arena achievements, Clank Gold, loot, career counters) is archived so nothing earned in testing carries into Season 1 (the hero itself is untouched).
    const economy = await archiveDevelopmentEconomy(tx, { launchSeasonId: seasonId, developmentSeasonId: dev?.id ?? null });
    if (dev) await tx.query("update public.seasons set archive = coalesce(archive, '{}'::jsonb) || $2::jsonb where id = $1", [dev.id, json({ economy })]);
    await tx.query("update public.game_state set phase = 'LIVE', launched_at = now(), launch_season_id = $1, launched_by = $2 where id = 1 and phase = 'DEVELOPMENT'", [seasonId, deps.actor]);

    const after = await heroFingerprint(tx);
    if (!sameHeroes(before, after)) throw new AdminError("HERO_FINGERPRINT_CHANGED", 500, "Launching changed a hero. Nothing was applied.");
    await audit(tx, deps.actor, "GAME_LAUNCH", "game", "state", {
      previous: { phase: "DEVELOPMENT", arenaStatus: arena.status, season: archived ? { label: archived.label, seasonId: archived.seasonId, lastBattleNumber: archived.lastBattleNumber } : null },
      next: { phase: "LIVE", arenaStatus: "NOT_STARTED", season: { label: "Season 1", seasonId } },
      archived,
      economy,
      heroes: { total: heroes.total, eligible: heroes.eligible, suspended: heroes.suspended, fingerprint: after.hash, versions: after.versions },
    });
    return { seasonId, seasonNumber: 1, archived, economy, heroes: after };
  });
}

/** START ARENA: NOT_STARTED → PREPARING. The Arena then prepares Battle #1 (the next advance does it) and runs on its own — no click per battle. */
export async function startArena(db: Db, deps: LifecycleDeps): Promise<{ status: ArenaRuntimeStatus; nextBattleNumber: number }> {
  return db.transaction(async (tx) => {
    await arenaRow(tx, true);
    const { control, actions } = await evaluateActions(tx, deps);
    if (!actions.startArena.allowed) refuse(actions.startArena);
    await setArena(tx, "NOT_STARTED", "PREPARING", ", started_at = coalesce(started_at, now())");
    await audit(tx, deps.actor, "ARENA_START", "arena", null, {
      previous: { arenaStatus: "NOT_STARTED" },
      next: { arenaStatus: "PREPARING" },
      phase: control.phase,
      season: control.season ? { seasonId: control.season.id, label: control.season.label } : null,
      nextBattleNumber: control.battles.nextToIssue,
      eligibleHeroes: control.heroes.eligible,
    });
    return { status: "PREPARING" as const, nextBattleNumber: control.battles.nextToIssue };
  });
}

/**
 * PAUSE ARENA. If nothing is committed the Arena pauses at once; otherwise it moves to PAUSE_REQUESTED: no NEW roster is made, the battles that are
 * already committed (on stage, announced as the upcoming battle with Picks open, prepared behind it) are fought and settled exactly as planned —
 * their rosters are frozen and players have seen them — and the Arena becomes PAUSED the moment none is left. Nothing visible is ever cancelled.
 */
export async function pauseArena(db: Db, deps: LifecycleDeps): Promise<{ status: ArenaRuntimeStatus; openBattles: number }> {
  return db.transaction(async (tx) => {
    const arena = await arenaRow(tx, true);
    const { actions, control } = await evaluateActions(tx, deps);
    if (!actions.pauseArena.allowed) refuse(actions.pauseArena);
    const open = control.arena.committedBattles;
    const detail = { previous: { arenaStatus: arena.status }, openBattles: open, season: control.season ? { seasonId: control.season.id, label: control.season.label } : null, lastBattleNumber: control.battles.last };
    await audit(tx, deps.actor, "ARENA_PAUSE_REQUEST", "arena", null, { ...detail, next: { arenaStatus: open === 0 ? "PAUSED" : "PAUSE_REQUESTED" } });
    if (open === 0) {
      await setArena(tx, arena.status, "PAUSED");
      await audit(tx, deps.actor, "ARENA_PAUSED", "arena", null, { ...detail, immediate: true, next: { arenaStatus: "PAUSED" } });
      return { status: "PAUSED" as const, openBattles: 0 };
    }
    await setArena(tx, arena.status, "PAUSE_REQUESTED");
    return { status: "PAUSE_REQUESTED" as const, openBattles: open };
  });
}

/** RESUME ARENA: continues the SAME season — battle numbers, the persisted queue and every record carry on (after #25 comes #26). */
export async function resumeArena(db: Db, deps: LifecycleDeps): Promise<{ status: ArenaRuntimeStatus; nextBattleNumber: number }> {
  return db.transaction(async (tx) => {
    const arena = await arenaRow(tx, true);
    const { actions, control } = await evaluateActions(tx, deps);
    if (!actions.resumeArena.allowed) refuse(actions.resumeArena);
    await setArena(tx, arena.status, "RUNNING");
    await audit(tx, deps.actor, "ARENA_RESUME", "arena", null, {
      previous: { arenaStatus: arena.status },
      next: { arenaStatus: "RUNNING" },
      season: control.season ? { seasonId: control.season.id, label: control.season.label } : null,
      lastBattleNumber: control.battles.last,
      nextBattleNumber: control.battles.nextToIssue,
    });
    return { status: "RUNNING" as const, nextBattleNumber: control.battles.nextToIssue };
  });
}

/**
 * RESET ARENA (development only): archives the current development run and starts the next one — heroes untouched, history kept. In a LIVE game
 * this is refused: a season is ended and the next created, never reset.
 */
export async function resetDevelopment(db: Db, deps: LifecycleDeps, input: { confirmation: string }): Promise<{ seasonId: string; runNumber: number; archived: ArchiveSummary | null }> {
  requirePhrase("RESET", input.confirmation);
  return db.transaction(async (tx) => {
    const arena = await arenaRow(tx, true);
    await tx.query("select phase from public.game_state where id = 1 for update");
    await lockLifecycleExclusive(tx);
    const { actions } = await evaluateActions(tx, deps);
    if (!actions.resetDevelopment.allowed) refuse(actions.resetDevelopment);

    const before = await heroFingerprint(tx);
    const dev = await activeSeason(tx, true);
    const archived = dev ? await archiveSeason(tx, dev, "DEVELOPMENT_RESET") : null;
    const [next] = await tx.query<{ n: number }>("select coalesce(max(run_number), 0)::int + 1 as n from public.seasons where kind = 'DEVELOPMENT'");
    const runNumber = next?.n ?? 1;
    const [season] = await tx.query<{ id: string }>(
      "insert into public.seasons (kind, run_number, name, status, starts_at, created_by) values ('DEVELOPMENT', $1, $2, 'ACTIVE', now(), $3) returning id",
      [runNumber, `Development run ${runNumber}`, deps.actor],
    );
    if (arena.status === "PAUSED") await setArena(tx, "PAUSED", "NOT_STARTED", ", last_advance_at = null, started_at = null");
    else await tx.query("update public.arena_state set last_advance_at = null, started_at = null where id = 1");
    const after = await heroFingerprint(tx);
    if (!sameHeroes(before, after)) throw new AdminError("HERO_FINGERPRINT_CHANGED", 500, "Resetting changed a hero. Nothing was applied.");
    await audit(tx, deps.actor, "SEASON_RESET", "season", (season as { id: string }).id, {
      previous: { arenaStatus: arena.status, season: archived ? { label: archived.label, seasonId: archived.seasonId, lastBattleNumber: archived.lastBattleNumber } : null },
      next: { arenaStatus: "NOT_STARTED", season: { label: `Development run ${runNumber}`, seasonId: (season as { id: string }).id } },
      archived,
      heroFingerprint: after.hash,
    });
    return { seasonId: (season as { id: string }).id, runNumber, archived };
  });
}

/** END SEASON (live): archives the active season and leaves the game between seasons; the Arena is NOT_STARTED. The next season is created separately. */
export async function endSeason(db: Db, deps: LifecycleDeps, input: { confirmation: string }): Promise<{ archived: ArchiveSummary }> {
  requirePhrase("END_SEASON", input.confirmation);
  return db.transaction(async (tx) => {
    const arena = await arenaRow(tx, true);
    await tx.query("select phase from public.game_state where id = 1 for update");
    await lockLifecycleExclusive(tx);
    const { actions } = await evaluateActions(tx, deps);
    if (!actions.endSeason.allowed) refuse(actions.endSeason);
    const season = (await activeSeason(tx, true)) as SeasonRow;
    const archived = await archiveSeason(tx, season, "SEASON_END");
    if (arena.status === "PAUSED") await setArena(tx, "PAUSED", "NOT_STARTED", ", last_advance_at = null, started_at = null");
    else await tx.query("update public.arena_state set last_advance_at = null, started_at = null where id = 1");
    await audit(tx, deps.actor, "SEASON_END", "season", season.id, {
      previous: { arenaStatus: arena.status, season: { label: archived.label, seasonId: season.id, lastBattleNumber: archived.lastBattleNumber } },
      next: { arenaStatus: "NOT_STARTED", season: null },
      archived,
    });
    return { archived };
  });
}

/** CREATE the next competitive season (live, between seasons): Season N+1, ACTIVE, battle numbers from #1 — and the Arena stays NOT_STARTED until START. */
export async function createNextSeason(db: Db, deps: LifecycleDeps): Promise<{ seasonId: string; number: number }> {
  return db.transaction(async (tx) => {
    await arenaRow(tx, true);
    await tx.query("select phase from public.game_state where id = 1 for update");
    await lockLifecycleExclusive(tx);
    const { actions } = await evaluateActions(tx, deps);
    if (!actions.createSeason.allowed) refuse(actions.createSeason);
    const [next] = await tx.query<{ n: number }>("select coalesce(max(number), 0)::int + 1 as n from public.seasons where kind = 'COMPETITIVE'");
    const number = next?.n ?? 1;
    const [season] = await tx.query<{ id: string }>(
      "insert into public.seasons (kind, number, name, status, starts_at, created_by) values ('COMPETITIVE', $1, $2, 'ACTIVE', now(), $3) returning id",
      [number, `Season ${number}`, deps.actor],
    );
    const seasonId = (season as { id: string }).id;
    await audit(tx, deps.actor, "SEASON_CREATE", "season", seasonId, { previous: { season: null }, next: { season: { label: `Season ${number}`, seasonId }, arenaStatus: "NOT_STARTED" } });
    return { seasonId, number };
  });
}
