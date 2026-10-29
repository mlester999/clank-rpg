import { arenaIsStopped, type ArenaRuntimeStatus, type GamePhase } from "@/domain/lifecycle";

/**
 * THE SEASON 1 LAUNCH PREFLIGHT — the pure rules (no database, no clock, no browser).
 *
 * Before the (one-way) launch the Admin sees what is about to happen, in real numbers, and a list of conditions that must hold. The numbers are read by
 * `services/launchPreflight.ts`; this module only decides what they mean. The same decision runs again INSIDE the launch transaction, under the locks, so a
 * green screen that went stale can never launch anything the state forbids.
 */

/**
 * The newest migration this version of the application needs. A test pins it to the highest file in supabase/migrations, so it can never drift. (The runner
 * cannot read that folder on a serverless deployment, so the version the code needs is a constant.)
 */
export const REQUIRED_SCHEMA_VERSION = "20261029002900";

/** The database objects the launch and the Events page rely on: if one is missing the schema is not the one this code expects, whatever the version table says. */
export const REQUIRED_SCHEMA_OBJECTS = [
  "public.game_state",
  "public.arena_leaderboard_result_snapshots",
  "public.hero_arena_result_snapshots",
  "public.launch_backup_attestations",
  "public.audit_launch_isolation()",
  "public.audit_event_champions()",
  "public.audit_development_economy()",
  "public.audit_game_lifecycle()",
] as const;

/** A backup attestation older than this does not count: the launch should follow the backup closely. */
export const BACKUP_MAX_AGE_HOURS = 24;

export type CheckStatus = "PASS" | "FAIL" | "WARN";

export interface PreflightCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** A FAIL on a blocking check refuses the launch. */
  blocking: boolean;
  detail: string;
}

export interface BackupFact {
  id: string;
  attestedBy: string;
  attestedAt: number;
  reference: string;
  verified: boolean;
  schemaVersion: string;
}

/** Everything measured about the pre-season, as counts read from the database. Nothing here is estimated. */
export interface LaunchFacts {
  schema: { latestApplied: string | null; missingObjects: string[] };
  /** The pre-season (development) run being archived. */
  season: { id: string | null; label: string | null };
  heroes: { total: number; eligible: number; suspended: number; versions: number };
  members: number;
  battles: { settled: number; voided: number; open: number };
  picks: { submitted: number; scored: number; settledBattlesAwaitingScoring: number; voidBattlesAwaitingScoring: number };
  boards: { picksBoards: number; picksResults: number; heroBoards: number; heroResults: number };
  heroRecords: { heroesWithRecords: number; careerCounters: number };
  economy: {
    goldAccounts: number;
    goldTotal: string;
    lootItems: number;
    arenaAchievements: number;
    /** POLICY FLAGS (the launch archives every Gold balance and every item): Gold that came from PERMANENT achievements (community / chain / admin-granted), and loot that was not a battle drop. */
    goldFromPermanentAchievements: string;
    lootNotFromBattles: number;
  };
  jobs: { activeCycle: boolean; lifecycleLockBusy: boolean; unfinalizedPeriods: number };
  chatMessages: number;
  archivedRuns: number;
  backup: BackupFact | null;
}

export interface LaunchContext {
  phase: GamePhase;
  arenaStatus: ArenaRuntimeStatus;
  /** Blockers `evaluateActions` already found for the launch action (arena running, reward obligations, already live…). */
  actionBlockers: Array<{ code: string; message: string }>;
  warnings: string[];
  nowMs: number;
  requireBackup: boolean;
}

export interface LaunchPreflight {
  checkedAt: number;
  phase: GamePhase;
  /** Every blocking check passes: the launch may proceed (the typed confirmation is still required). */
  ready: boolean;
  facts: LaunchFacts;
  checks: PreflightCheck[];
  /** The failing blocking checks, in plain words — what must be fixed first. */
  unsafe: string[];
  /** The backup state the launch will rely on. */
  backup: { required: boolean; satisfied: boolean; maxAgeHours: number; latest: BackupFact | null; reason: string | null };
}

const n = (x: number): string => x.toLocaleString("en-US");

export function backupVerdict(backup: BackupFact | null, applied: string | null, nowMs: number): { ok: boolean; reason: string | null } {
  if (!backup) return { ok: false, reason: "No backup has been attested. Take a backup, verify it, then record it here." };
  if (!backup.verified) return { ok: false, reason: "The latest backup attestation says the backup was taken but NOT verified. Verify it, then record that." };
  const ageH = (nowMs - backup.attestedAt) / 3_600_000;
  if (ageH > BACKUP_MAX_AGE_HOURS) return { ok: false, reason: `The latest backup attestation is ${Math.floor(ageH)} h old (the launch needs one from the last ${BACKUP_MAX_AGE_HOURS} h).` };
  if (applied !== null && backup.schemaVersion !== applied) return { ok: false, reason: `The backup was taken at schema ${backup.schemaVersion}; the database is now at ${applied}. Take a fresh backup.` };
  return { ok: true, reason: null };
}

/** Turns the measured facts into the checklist. Blocking checks decide `ready`; warnings inform. */
export function evaluateLaunch(facts: LaunchFacts, ctx: LaunchContext): LaunchPreflight {
  const checks: PreflightCheck[] = [];
  const add = (id: string, label: string, ok: boolean, detail: string, opts: { blocking?: boolean; warnWhenNotOk?: boolean } = {}) =>
    checks.push({ id, label, status: ok ? "PASS" : opts.warnWhenNotOk ? "WARN" : "FAIL", blocking: opts.blocking ?? true, detail });

  add("PHASE", "The game is still pre-season", ctx.phase === "DEVELOPMENT", ctx.phase === "DEVELOPMENT" ? "Phase DEVELOPMENT: Season 1 has not been launched." : "The game is already LIVE: Season 1 has been launched. Nothing more can be launched.");

  const schemaOk = facts.schema.latestApplied !== null && facts.schema.latestApplied >= REQUIRED_SCHEMA_VERSION && facts.schema.missingObjects.length === 0;
  add(
    "SCHEMA",
    "The database schema is the one this version needs",
    schemaOk,
    schemaOk
      ? `Latest applied migration ${facts.schema.latestApplied}; every required object exists.`
      : `Applied ${facts.schema.latestApplied ?? "none"}, required ${REQUIRED_SCHEMA_VERSION}${facts.schema.missingObjects.length ? `; missing: ${facts.schema.missingObjects.join(", ")}` : ""}. Apply the pending migrations first.`,
  );

  const stopped = arenaIsStopped(ctx.arenaStatus);
  add(
    "ARENA_STOPPED",
    "The Arena is stopped, so no worker can write into the pre-season",
    stopped,
    stopped
      ? `Arena ${ctx.arenaStatus.replaceAll("_", " ").toLowerCase()}: the database itself refuses to schedule a battle in this state, whichever process asks.`
      : `The Arena is ${ctx.arenaStatus.replaceAll("_", " ").toLowerCase()}. Pause it and let it finish its battles first.`,
  );

  add(
    "OPEN_BATTLES",
    "No battle is committed but unsettled",
    facts.battles.open === 0,
    facts.battles.open === 0 ? "Nothing is waiting to be settled." : `${n(facts.battles.open)} unsettled pre-season battle(s) will be voided (their Picks resolve VOID) when the run is archived.`,
    { blocking: false, warnWhenNotOk: true },
  );

  const rewardBlocker = ctx.actionBlockers.find((b) => b.code === "REWARD_LIABILITIES");
  add("REWARDS", "No reward is owed that archiving would orphan", !rewardBlocker, rewardBlocker ? rewardBlocker.message : "Nothing is credited, reserved, claimed or held. Real value is never touched by the launch.");

  add(
    "PICK_SETTLEMENTS",
    "Every settled battle's Picks have been scored",
    facts.picks.settledBattlesAwaitingScoring === 0,
    facts.picks.settledBattlesAwaitingScoring === 0 ? "No settled battle is waiting for its Picks to be scored." : `${n(facts.picks.settledBattlesAwaitingScoring)} settled battle(s) still have Picks waiting to be scored. Let the settlement finish, then run the check again.`,
  );
  if (facts.picks.voidBattlesAwaitingScoring > 0) {
    checks.push({ id: "VOID_SETTLEMENTS", label: "Voided battles with unscored Picks", status: "WARN", blocking: false, detail: `${n(facts.picks.voidBattlesAwaitingScoring)} voided battle(s) have eligible Picks with no scoring row. They never count (a void battle scores nothing) and are archived with the run.` });
  }

  add(
    "NO_COMPETING_ACTION",
    "No other launch, reset or reward finalization is running",
    !facts.jobs.lifecycleLockBusy,
    facts.jobs.lifecycleLockBusy ? "Another lifecycle action or a leaderboard finalization is holding the lifecycle lock. Wait a moment and check again." : "The lifecycle lock is free.",
  );

  const bv = backupVerdict(facts.backup, facts.schema.latestApplied, ctx.nowMs);
  add("BACKUP", "A verified backup of this schema exists", bv.ok, bv.ok ? `Attested by ${facts.backup?.attestedBy} (${facts.backup?.reference}).` : (bv.reason as string), { blocking: ctx.requireBackup, warnWhenNotOk: !ctx.requireBackup });

  add(
    "HEROES",
    "Heroes will be preserved exactly",
    true,
    `${n(facts.heroes.total)} hero(es), ${n(facts.heroes.versions)} version(s): identity, class, rarity, PWR, stats and look are fingerprinted before and after; the launch rolls back if a byte differs.`,
    { blocking: false },
  );
  if (facts.heroes.eligible < 8) checks.push({ id: "ELIGIBLE_HEROES", label: "Enough Arena-eligible heroes to start", status: "WARN", blocking: false, detail: `${facts.heroes.eligible} Arena-eligible hero(es); a battle needs 8 before START ARENA can be used.` });
  if (facts.jobs.unfinalizedPeriods > 0) {
    checks.push({ id: "UNFINALIZED_PERIODS", label: "Pre-season periods still open", status: "WARN", blocking: false, detail: `${n(facts.jobs.unfinalizedPeriods)} closed pre-season Daily/Weekly period(s) were never finalized. They stay unfinalized and unpaid; nothing from them carries into Season 1.` });
  }
  if (BigInt(facts.economy.goldFromPermanentAchievements) > 0n) {
    checks.push({
      id: "POLICY_PERMANENT_GOLD",
      label: "Policy decision: Gold from permanent achievements",
      status: "WARN",
      blocking: false,
      detail: `${n(Number(facts.economy.goldFromPermanentAchievements))} Clank Gold was paid by achievements that are KEPT at the launch (community / chain / admin-granted). The established launch policy resets ALL pre-season Gold to 0 through an offsetting ledger entry, so that Gold is reset too, and those achievements will not pay it again. Confirm that is intended.`,
    });
  }
  if (facts.economy.lootNotFromBattles > 0) {
    checks.push({
      id: "POLICY_NON_BATTLE_LOOT",
      label: "Policy decision: loot that was not a battle drop",
      status: "WARN",
      blocking: false,
      detail: `${n(facts.economy.lootNotFromBattles)} inventory item(s) were not battle drops (for example granted by an admin). The launch archives every item. Confirm that is intended, or exclude them before launching.`,
    });
  }
  for (const w of ctx.warnings) checks.push({ id: "NOTE", label: "Note", status: "WARN", blocking: false, detail: w });

  const unsafe = checks.filter((c) => c.blocking && c.status === "FAIL").map((c) => `${c.label}: ${c.detail}`);
  return {
    checkedAt: ctx.nowMs,
    phase: ctx.phase,
    ready: unsafe.length === 0,
    facts,
    checks,
    unsafe,
    backup: { required: ctx.requireBackup, satisfied: bv.ok, maxAgeHours: BACKUP_MAX_AGE_HOURS, latest: facts.backup, reason: bv.reason },
  };
}

/**
 * What the launch resets and what it keeps — the policy, in words. One list serves the Admin preview, the confirmation dialog and the audit entry, so they can
 * never disagree with each other (the tests check each line against the database).
 */
export const LAUNCH_RESETS: readonly string[] = [
  "Arena matches, wins, losses, Top-2 finishes, KOs, damage and streaks — every hero's Season 1 record starts at 0 (shown as Unranked until its first battle)",
  "Battle numbers — Season 1 starts at Battle #1",
  "Arena Picks — submitted, correct, incorrect and Points; Daily/Weekly standings; eligibility counters; community totals",
  "Daily and Weekly boards of Arena Picks and Hero Arena, and the champions history — no pre-season winner is ever shown as official",
  "Hero Records (Top-2, KOs, season rank)",
  "Pre-season Clank Gold (an offsetting ledger entry takes each balance to 0), loot, and achievements earned from pre-season battles",
  "Career counters kept on the hero row",
];

export const LAUNCH_KEEPS: readonly string[] = [
  "Every hero: id, public id and URL, name, Telegram link and ownership, claimed status, class, rarity, PWR, base stats, appearance seed and look, hero version history, suspension and moderation state",
  "Members, Telegram authentication, admin roles and settings, token configuration, character art",
  "Arena Chat history (chat is separate from competition)",
  "Every pre-season battle, snapshot, seed, hash and result — archived and replayable, never deleted or rewritten",
  "Reward ledger, claims and prizes (a launch refuses while any is owed), the append-only Gold ledger, community/chain achievements and anything an admin granted",
];

/** The warning the owner approved, word for word — shown on the explanation AND again next to the typed confirmation. */
export const LAUNCH_WARNING =
  "This will archive pre-season competition and reset official battle, Picks, leaderboard, and beta-earned progression records. Existing heroes, their class, rarity, PWR, base stats and identity will remain. This operation cannot be undone through the normal admin interface.";
