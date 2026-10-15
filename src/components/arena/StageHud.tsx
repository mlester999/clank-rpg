import type { ReactNode } from "react";
import type { HeaderStatus } from "./stageMode";

import type { ArenaPhase } from "./ArenaRenderer";

/**
 * The player-facing overlays on the arena stage, as plain presentational pieces (so every phase can be rendered and
 * checked on its own). What is deliberately NOT here: a fight timer, a battle / round / cycle number, anything about the
 * queue. The 60-second limit is enforced by the server and shown to nobody; the 3 · 2 · 1 before each fight is.
 */

/**
 * Top-left plate while a battle is on stage: how many are still standing. It shrinks on a small stage (sized from the stage's own width) and is a
 * MEASURED safe zone: the arena renderer keeps name plates and floating numbers out from under it (`data-stage-reserve`).
 */
export function SurvivorsHud({ alive, total }: { alive: number; total: number }) {
  return (
    <div className="pointer-events-none absolute top-2 left-2 @xl:top-3 @xl:left-3">
      <div data-stage-reserve data-testid="survivors-hud" className="plate plate-flat min-w-[5.25rem] px-2.5 py-1 @sm:min-w-[6.5rem] @sm:px-3 @sm:py-1.5 @xl:min-w-[7.5rem]" style={{ ["--chamfer" as string]: "6px" }}>
        <p className="label !text-[0.54rem] @sm:!text-[0.58rem]">Survivors</p>
        <p className="font-display text-base leading-none tnum text-paper @sm:text-lg">
          {alive}/{total}
        </p>
      </div>
    </div>
  );
}

/**
 * The 3 · 2 · 1 before every fight, for ASSISTIVE TECHNOLOGY. The big digits you see are drawn by the arena canvas in the same frame as the fight
 * (ArenaRenderer.drawStageCall), so they can never linger over combat while React catches up; this live region announces the same numbers.
 */
export function CountdownOverlay({ phase, countdown }: { phase: ArenaPhase; countdown: number | null }) {
  if (phase !== "COUNTDOWN" || countdown === null) return null;
  return (
    <div className="sr-only" data-testid="countdown" role="timer" aria-live="assertive">
      <span key={countdown}>{countdown}</span>
    </div>
  );
}

/**
 * Guidance while the eight stand idle / count down, centred along the foot of the stage. It keeps 3.25 rem clear on BOTH sides — the speaker lives in
 * the bottom-right corner and the guidance never touches it (nor does the left side look lopsided).
 */
export function StageHint({ phase, children }: { phase: ArenaPhase; children?: ReactNode }) {
  if (phase !== "INTRO" && phase !== "COUNTDOWN") return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center px-[3.25rem] @xl:bottom-3" data-testid="stage-hint">
      {typeof children === "string" ? <span className="chip max-w-full bg-ink-950/85 text-center text-clank-300">{children}</span> : children}
    </div>
  );
}

/**
 * "Picks are open for the next fight — go and pick." Two deliberate lines on a narrow stage (a short title over one line of guidance), one line on
 * a wide one (42 rem and up, measured on the stage) — never a sentence that wraps into fragments. Each line is `whitespace-nowrap` so it cannot break in the middle; the stage width, not
 * the copy, chooses the layout. (Under the 1280 px page layout the picks panel is below the stage; at 1280+ it is to the right.)
 */
export function PicksOpenHint() {
  return (
    <div
      className="flex max-w-full flex-col items-center rounded-lg border border-clank-400/45 bg-ink-950/88 px-3 py-1.5 text-center leading-tight shadow-[0_2px_10px_rgba(0,0,0,.45)] @2xl:flex-row @2xl:gap-2.5 @2xl:px-4"
      data-testid="picks-open-hint"
    >
      <p className="text-[0.64rem] font-bold tracking-[0.1em] whitespace-nowrap text-clank-300 uppercase @sm:text-[0.7rem] @2xl:font-display @2xl:text-xs @2xl:tracking-[0.14em]">
        <span className="@2xl:hidden">Next fight picks open</span>
        <span className="hidden @2xl:inline">Picks open for the next fight</span>
      </p>
      <span aria-hidden className="hidden h-3 w-px bg-clank-400/40 @2xl:block" />
      <p className="mt-0.5 text-[0.68rem] whitespace-nowrap text-steel-300 @sm:text-xs @2xl:mt-0">
        <span className="hidden xl:inline">Choose a winner on the right</span>
        <span className="xl:hidden">Scroll down to pick your hero</span>
      </p>
    </div>
  );
}

/** FIGHT! as the bell rings (≈ 0.9 s — drawn by the canvas; announced here) and Victory! once the last hero falls. */
export function PhaseBanner({ phase, sinceCombatStartMs }: { phase: ArenaPhase; sinceCombatStartMs: number }) {
  if (phase === "COMBAT" && sinceCombatStartMs < 900) {
    return (
      <div className="sr-only" aria-live="assertive">
        <span>FIGHT!</span>
      </div>
    );
  }
  if (phase === "VICTORY") {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-[38%] grid place-items-center">
        <span className="slide-up font-display text-[clamp(2rem,8vw,4.5rem)] text-clank-300 [text-shadow:0_4px_0_#4d2d87,0_0_30px_rgba(202,148,249,.65)]">Victory!</span>
      </div>
    );
  }
  return null;
}

/**
 * The public page header: nothing about queues, cycles, rounds or scheduling. While the game is still pre-season it says so, always — a pre-season run's
 * battles are practice and must never be mistaken for an official Season. "Reconnecting…" is only for a REAL failure to reach the server.
 */
export function ArenaHeader({ status, season, phase, online, connection, demo }: { status: HeaderStatus; season: { kind: "DEVELOPMENT" | "COMPETITIVE"; label: string } | null; phase: "DEVELOPMENT" | "LIVE" | undefined; online: boolean; connection?: "live" | "syncing" | "reconnecting"; demo: boolean }) {
  const tone = status.tone === "live" ? "border-teal/30 bg-teal/10 text-teal" : status.tone === "warn" ? "border-danger/40 bg-danger/10 text-danger" : "border-clank-400/40 bg-clank-500/10 text-clank-300";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="arena-header">
      <h1 className="font-display text-xl tracking-wide text-paper uppercase sm:text-2xl">
        Global <span className="text-shine">Idle Arena</span>
      </h1>
      {(online || status.tone !== "warn") && (
        <span className={`chip uppercase ${tone}`} data-testid="arena-status-chip">
          {status.tone === "live" && <span className="live-dot" />} {status.label}
        </span>
      )}
      {phase === "DEVELOPMENT" ? (
        <span className="chip border-gold/40 bg-gold/10 text-gold uppercase" data-testid="arena-phase-chip" title="Pre-season battles are practice — not official records. Season 1 is coming soon.">
          Pre-season
        </span>
      ) : (
        season && <span className="chip uppercase" data-testid="arena-season-chip">{season.label}</span>
      )}
      {!online && <span className="chip border-danger/40 bg-danger/10 text-danger" data-testid="arena-reconnecting">Reconnecting…</span>}
      {online && connection === "syncing" && <span className="chip border-clank-400/40 bg-clank-500/10 text-clank-300" data-testid="arena-syncing">Syncing…</span>}
      {demo && (
        <span className="chip border-violet/40 bg-violet/10 text-violet" title="Local preview heroes — not real community members">
          Demo heroes
        </span>
      )}
    </div>
  );
}
