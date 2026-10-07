import { stageCopy, type StageMode } from "./stageMode";
import type { ArenaStateDto } from "@/lib/dto";

/**
 * The intentional waiting screens of the public Arena — shown INSIDE the stage while there is no battle to watch: the Arena has not started
 * (launch happened, nobody pressed START yet), is preparing its first battle, is paused, is between seasons, or a development run is idle.
 * Each is a designed screen in the Clank RPG style; none of them is "reconnecting" and none carries a "0 / 8 heroes" counter.
 * (Only a real failure to reach the server — mode RECONNECTING — says so.)
 */
type Waiting = Exclude<StageMode, "STAGE" | "LOADING" | "GATHERING">;

const EMBLEM: Record<Waiting, string> = {
  NOT_STARTED: "◆",
  DEVELOPMENT_IDLE: "⚒",
  PREPARING: "◆",
  PAUSED: "❚❚",
  RECONNECTING: "↻",
  NO_SEASON: "◆",
};

export function StageStatusCard({ mode, state }: { mode: Waiting; state: ArenaStateDto | null }) {
  const copy = stageCopy(mode, state);
  const busy = mode === "PREPARING" || mode === "RECONNECTING";
  return (
    <div
      className="plate plate-clank w-full max-w-[22rem] p-4 text-center sm:max-w-md sm:p-6"
      role="status"
      aria-live="polite"
      aria-busy={busy || undefined}
      data-testid="stage-status"
      data-mode={mode}
    >
      <span
        aria-hidden
        className={`mx-auto grid h-12 w-12 place-items-center rounded-full border border-clank-400/50 bg-clank-500/10 font-display text-lg text-clank-300 shadow-[0_0_24px_rgba(183,121,245,.35)] ${mode === "PAUSED" ? "" : "trophy-float"}`}
      >
        {EMBLEM[mode]}
      </span>
      <h2 className="mt-3 font-display text-lg tracking-[0.12em] text-shine uppercase sm:text-2xl" data-testid="stage-status-title">
        {copy.title}
      </h2>
      {copy.lines.map((line, i) => (
        <p key={line} className={`mt-2 text-sm ${i === 0 ? "text-paper" : "text-steel-300"}`}>
          {line}
        </p>
      ))}
      {(mode === "PREPARING" || mode === "NOT_STARTED") && (
        <div className="mt-4 flex items-center justify-center gap-1.5" aria-hidden>
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="h-2.5 w-2.5 rotate-45 bg-clank-400/70 motion-safe:animate-pulse" style={{ animationDelay: `${i * 140}ms` }} />
          ))}
        </div>
      )}
    </div>
  );
}
