import type { ReactNode } from "react";
import type { HeaderStatus } from "./stageMode";

import type { ArenaPhase } from "./ArenaRenderer";

/**
 * The player-facing overlays on the arena stage, as plain presentational pieces (so every phase can be rendered and
 * checked on its own). What is deliberately NOT here: a fight timer, a battle / round / cycle number, anything about the
 * queue. The 60-second limit is enforced by the server and shown to nobody; the 3 · 2 · 1 before each fight is.
 */

/** Top-left plate while a battle is on stage: how many are still standing. */
export function SurvivorsHud({ alive, total }: { alive: number; total: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2 sm:p-3">
      <div className="plate plate-flat min-w-[7.5rem] px-3 py-1.5" style={{ ["--chamfer" as string]: "6px" }}>
        <p className="label !text-[0.58rem]">Survivors</p>
        <p className="font-display text-lg leading-none tnum text-paper">
          {alive}/{total}
        </p>
      </div>
      <div className="flex min-w-0 flex-1 justify-center" />
      <div className="min-w-[7.5rem]" />
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

/** One line of guidance while the eight stand idle / count down. */
export function StageHint({ phase, children }: { phase: ArenaPhase; children?: ReactNode }) {
  if (phase !== "INTRO" && phase !== "COUNTDOWN") return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 grid place-items-center">
      <span className="chip bg-ink-950/85 text-clank-300">{children}</span>
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
 * The public page header: nothing about queues, cycles, rounds or scheduling. While the game is in DEVELOPMENT it says so, always — a development run's
 * battles are test data and must never be mistaken for an official Season. "Reconnecting…" is only for a REAL failure to reach the server.
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
        <span className="chip border-gold/40 bg-gold/10 text-gold uppercase" data-testid="arena-phase-chip" title="Test battles — not official records. Season 1 has not started.">
          Development · test battles
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
