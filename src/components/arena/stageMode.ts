import type { ArenaStateDto } from "@/lib/dto";

/**
 * WHAT THE PUBLIC ARENA STAGE IS SHOWING — one pure decision, shared by the page, its header and the Picks panel, so every part of the screen
 * agrees and the states can be tested without a browser.
 *
 * The states that come from the SERVER (the persisted Arena status + the game phase) are deliberate, designed screens. "Reconnecting" is not one of
 * them: it is the browser's own state, shown ONLY when the state endpoint cannot be reached and there is nothing to show yet — never for "the Arena has
 * not started", "preparing" or "paused", and never next to a "0 / 8 heroes" counter that would make a healthy Arena look broken.
 */
export type StageMode =
  | "STAGE" // battles are made and fought: the arena canvas plays
  | "LOADING" // the first state has not arrived yet
  | "RECONNECTING" // a REAL failure to reach the server, with nothing to show
  | "DEVELOPMENT_IDLE" // phase DEVELOPMENT and the Arena is not running: test battles are not on
  | "NOT_STARTED" // phase LIVE, Season launched, nobody pressed START ARENA yet
  | "PREPARING" // START was pressed: the first battle is being made ready
  | "PAUSED" // paused by the team
  | "GATHERING" // running, but fewer eligible heroes than a battle needs
  | "NO_SEASON"; // between seasons

export function stageMode(input: { state: ArenaStateDto | null; loaded: boolean; online: boolean }): StageMode {
  const { state, loaded, online } = input;
  if (!state) return loaded && !online ? "RECONNECTING" : "LOADING";
  switch (state.status) {
    case "NOT_STARTED":
      return state.phase === "LIVE" ? "NOT_STARTED" : "DEVELOPMENT_IDLE";
    case "PAUSED":
      return "PAUSED";
    case "PREPARING":
      return "PREPARING";
    case "NO_SEASON":
      return "NO_SEASON";
    case "GATHERING":
      return "GATHERING";
    case "LIVE":
      // Running, no battle in the snapshot yet (the very first fight is still being lined up): same calm "preparing" screen.
      return state.current || state.upcoming || state.next ? "STAGE" : "PREPARING";
  }
}

export interface StageCopy {
  title: string;
  lines: string[];
}

/** The words of each intentional waiting screen (the page renders them in the Clank RPG style; tests read them from here). */
export function stageCopy(mode: Exclude<StageMode, "STAGE" | "LOADING" | "GATHERING">, state: ArenaStateDto | null): StageCopy {
  const season = state?.season?.kind === "COMPETITIVE" ? state.season.label : null;
  switch (mode) {
    case "NOT_STARTED":
      return { title: "Arena preparing", lines: [`${season ?? "Season 1"} battles will begin soon.`, "The Arena has not started yet."] };
    case "DEVELOPMENT_IDLE":
      return { title: "Arena in development", lines: ["Clank RPG is still being built — test battles are not running right now.", "Nothing here is an official record. Season 1 has not started."] };
    case "PREPARING":
      return { title: "Preparing arena", lines: ["The first battle is being made ready.", "Heroes are taking their places…"] };
    case "PAUSED":
      return { title: "Arena paused", lines: ["Battles are temporarily paused.", "The Arena will continue when the next session resumes."] };
    case "RECONNECTING":
      return { title: "Reconnecting…", lines: ["We can't reach the Arena right now.", "Trying again automatically."] };
    case "NO_SEASON":
      return { title: "Between seasons", lines: ["The next season will begin soon.", "Every hero keeps their identity, rarity and PWR."] };
  }
}

export interface HeaderStatus {
  /** The chip beside the title. */
  label: string;
  tone: "live" | "wait" | "warn";
}

export function headerStatus(mode: StageMode, state: ArenaStateDto | null): HeaderStatus {
  if (state?.pausing && mode === "STAGE") return { label: "Pausing after this battle", tone: "wait" };
  switch (mode) {
    case "STAGE":
      return { label: "Live", tone: "live" };
    case "GATHERING":
      return { label: "Gathering heroes", tone: "wait" };
    case "PAUSED":
      return { label: "Paused", tone: "wait" };
    case "PREPARING":
    case "NOT_STARTED":
      return { label: "Preparing", tone: "wait" };
    case "DEVELOPMENT_IDLE":
      return { label: "Not running", tone: "wait" };
    case "NO_SEASON":
      return { label: "Between seasons", tone: "wait" };
    case "RECONNECTING":
      return { label: "Offline", tone: "warn" };
    case "LOADING":
      return { label: "Opening", tone: "wait" };
  }
}
