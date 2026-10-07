/**
 * THE GAME LIFECYCLE — the pure rules (no database, no clock, no browser).
 *
 * Three independent pieces of persisted, server-side state describe where the game is:
 *
 *   GAME PHASE     DEVELOPMENT → LIVE.  Product state — not NODE_ENV, not Vercel, not Supabase. DEVELOPMENT = testing before the official launch
 *                  (its battles, records and Picks are test data); LIVE = official competitive seasons. One way: there is no "back to development".
 *   SEASON         A development run ("Development / Beta") or an official, numbered season (Season 1, 2, …). Exactly one is ACTIVE at a time.
 *                  Public records — wins, matches, rank, battle numbers — belong to the ACTIVE season.
 *   ARENA STATUS   NOT_STARTED → PREPARING → RUNNING ⇄ PAUSE_REQUESTED → PAUSED. Whether battles are being made. Launching a season does NOT start
 *                  the Arena: those are two separate Admin actions.
 *
 * The database enforces the same tables (see migration 20261006002000); this module is what the services, the Admin console and the tests
 * share, so a transition can never be allowed in one place and refused in another.
 */

export const GAME_PHASES = ["DEVELOPMENT", "LIVE"] as const;
export type GamePhase = (typeof GAME_PHASES)[number];

export const ARENA_STATUSES = ["NOT_STARTED", "PREPARING", "RUNNING", "PAUSE_REQUESTED", "PAUSED"] as const;
export type ArenaRuntimeStatus = (typeof ARENA_STATUSES)[number];

export const SEASON_KINDS = ["DEVELOPMENT", "COMPETITIVE"] as const;
export type SeasonKind = (typeof SEASON_KINDS)[number];

export const isArenaStatus = (v: unknown): v is ArenaRuntimeStatus => (ARENA_STATUSES as readonly unknown[]).includes(v);

/** The legal status moves (the database's `guard_arena_state` trigger enforces exactly this table). */
const MOVES: Record<ArenaRuntimeStatus, readonly ArenaRuntimeStatus[]> = {
  NOT_STARTED: ["PREPARING"],
  PREPARING: ["RUNNING", "PAUSE_REQUESTED", "PAUSED"],
  RUNNING: ["PAUSE_REQUESTED", "PAUSED"],
  PAUSE_REQUESTED: ["PAUSED", "RUNNING"],
  PAUSED: ["RUNNING", "NOT_STARTED"],
};
export const canMoveArena = (from: ArenaRuntimeStatus, to: ArenaRuntimeStatus): boolean => MOVES[from].includes(to);

/** Statuses in which the Arena is making battles (and so must not be reset, launched over or ended). */
export const ARENA_ACTIVE_STATUSES: readonly ArenaRuntimeStatus[] = ["PREPARING", "RUNNING", "PAUSE_REQUESTED"];
export const arenaIsActive = (s: ArenaRuntimeStatus): boolean => ARENA_ACTIVE_STATUSES.includes(s);
/** Statuses in which nothing is in flight and a lifecycle change (launch, reset, end season) is safe. */
export const arenaIsStopped = (s: ArenaRuntimeStatus): boolean => s === "NOT_STARTED" || s === "PAUSED";

// --- typed confirmations ---------------------------------------------------------------------------------------------
/** The phrase an operator must type to confirm each destructive competitive action. The server checks it too — the console only enables the button. */
export const CONFIRM = {
  LAUNCH: "LAUNCH SEASON 1",
  RESET: "RESET ARENA",
  END_SEASON: "END SEASON",
} as const;
export type ConfirmAction = keyof typeof CONFIRM;

/** Exact match (surrounding whitespace ignored, case and inner spacing are not). */
export const confirmationMatches = (action: ConfirmAction, typed: unknown): boolean => typeof typed === "string" && typed.trim() === CONFIRM[action];

// --- what the public sees --------------------------------------------------------------------------------------------
/**
 * The public Arena states. Each is a deliberate, designed screen — and none of them is "reconnecting": that word is reserved for a REAL failure to
 * reach the server (the browser's own state, not something the server reports).
 */
export type PublicArenaMode =
  | "RUNNING" // battles are being made / fought
  | "GATHERING" // running, but fewer heroes than a battle needs
  | "PREPARING" // Battle #1 is being made ready
  | "NOT_STARTED" // the Arena has not been started
  | "PAUSED"; // paused by the team

export function publicArenaMode(input: { status: ArenaRuntimeStatus; gathering: boolean }): PublicArenaMode {
  switch (input.status) {
    case "NOT_STARTED":
      return "NOT_STARTED";
    case "PAUSED":
      return "PAUSED";
    case "PREPARING":
      return "PREPARING";
    case "PAUSE_REQUESTED":
    case "RUNNING":
      return input.gathering ? "GATHERING" : "RUNNING";
  }
}

export interface SeasonLabelInput {
  kind: SeasonKind;
  number: number | null;
  name: string;
}

/** "Season 1" / "Development". Short enough for a chip. */
export function seasonChipLabel(s: SeasonLabelInput): string {
  return s.kind === "COMPETITIVE" && s.number !== null ? `Season ${s.number}` : "Development";
}

/** What a public record is called: the official season, or the test run (never confused with it). */
export function recordsLabel(s: SeasonLabelInput | null): string {
  if (!s) return "Records";
  return s.kind === "COMPETITIVE" && s.number !== null ? `Season ${s.number}` : "Development run";
}

/** The ladder tier shown for a hero with no battles this season: "Unranked" — whatever the lowest tier of the ladder is called. */
export const UNRANKED = "Unranked";

export const ARENA_STATUS_LABEL: Record<ArenaRuntimeStatus, string> = {
  NOT_STARTED: "Not started",
  PREPARING: "Preparing",
  RUNNING: "Running",
  PAUSE_REQUESTED: "Pausing after the current battles",
  PAUSED: "Paused",
};
