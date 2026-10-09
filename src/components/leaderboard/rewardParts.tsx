"use client";

import { PrizeTilePair } from "@/components/arena/PrizePools";
import { groupDigits } from "@/components/arena/prizeView";
import { ResetCountdown } from "@/components/time/ResetCountdown";
import { TimerIcon } from "@/components/ui/Icons";
import type { BoardRuleView } from "@/domain/rewards/leaderboardDto";

/**
 * The two things the Leaderboards page puts FIRST now that the Arena is only a quick summary:
 *
 *   BoardCountdown   the board's reset as a highlighted, premium countdown ("DAILY LEADERBOARD · ENDS IN · 23H 59M 59S"), or — for a finished period — an accurate
 *                    COMPLETED state with its date. Raw "00:00 UTC → 00:00 UTC" ranges are not primary text any more; the exact times are one tap away (ExactTimes).
 *   RewardDetails    the richer reward information: both pools, how many ranks share them, the qualification, the holder bonus and the token's launch status — every
 *                    figure from the server's rules (`boardRules`, built from the one authoritative setting), never typed here.
 *
 * UTC stays the source of truth for every boundary; this only changes how it is shown.
 */

const EXACT = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// ------------------------------------------------------------------------------------------------ the countdown card
export type CountdownState = "LIVE" | "FINALIZING" | "FINAL";

export interface BoardCountdownProps {
  /** "Daily" / "Weekly" / "Season". */
  word: string;
  state: CountdownState;
  serverNow: number;
  endsAt: number;
  /** A timer that can exceed a day (Weekly / Season) switches to "DD HH MM" while a whole day is left. */
  allowDays?: boolean;
  /** The countdown reached zero. */
  onElapsed?: () => void;
  /** The server has been asked after the end and has not moved on yet. */
  waiting?: boolean;
  /** A finished period's calendar label ("OCT 7" / "week of OCT 5") — a date, not a time range. */
  completedLabel?: string;
  /** When the finished period's results were frozen (ms) — shown as a plain date on the completed state. */
  finalizedAt?: number | null;
}

export function BoardCountdown({ word, state, serverNow, endsAt, allowDays = false, onElapsed, waiting = false, completedLabel, finalizedAt }: BoardCountdownProps) {
  const title = `${word} leaderboard`;
  return (
    <div
      className="plate flex items-center gap-3.5 p-3.5"
      style={{ ["--chamfer" as string]: "10px", ["--plate-bg" as string]: "radial-gradient(120% 130% at 0% 0%, rgba(150, 99, 218, 0.24), transparent 60%), linear-gradient(180deg, #181330 0%, #100d22 100%)" }}
      data-testid="board-countdown-box"
      data-state={state}
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-clank-400/40 bg-clank-500/15 text-clank-200" aria-hidden>
        <TimerIcon size={22} />
      </span>
      <div className="min-w-0">
        <p className="font-display text-[0.68rem] tracking-[0.18em] text-clank-200 uppercase" data-testid="board-countdown-title">{title}</p>
        {state === "LIVE" ? (
          <>
            <p className="label mt-1">{waiting ? "Updating…" : "Ends in"}</p>
            <ResetCountdown
              serverNow={serverNow}
              endsAt={endsAt}
              allowDays={allowDays}
              onElapsed={onElapsed}
              label={`${title} ends in`}
              className="block font-display text-[clamp(1.55rem,7.2vw,2.35rem)] leading-[1.05] text-paper"
              testId="board-countdown"
            />
          </>
        ) : state === "FINALIZING" ? (
          <>
            <p className="label mt-1">Status</p>
            <p className="font-display text-[clamp(1.3rem,6vw,1.9rem)] leading-[1.05] text-paper" data-testid="board-finalizing">FINALIZING</p>
            <p className="mt-0.5 text-[0.7rem] text-steel-300">Final results are being frozen{completedLabel ? ` · ${completedLabel}` : ""}</p>
          </>
        ) : (
          <>
            <p className="label mt-1">Completed</p>
            <p className="font-display text-[clamp(1.3rem,6vw,1.9rem)] leading-[1.05] text-paper" data-testid="board-completed">{completedLabel ?? "Final"}</p>
            <p className="mt-0.5 text-[0.7rem] text-steel-300" data-testid="board-finalized">Final results · read-only{finalizedAt ? <> · Finalized <span className="tnum">{new Date(finalizedAt).toISOString().slice(0, 10)}</span></> : null}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** The exact boundaries, for anyone who wants them — secondary on purpose (a tap away), never the headline. */
export function ExactTimes({ startsAt, endsAt, recurs }: { startsAt: number; endsAt: number; recurs: string }) {
  return (
    <details className="mt-2 text-[0.7rem] text-steel-400" data-testid="board-exact-times">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded text-steel-300 hover:text-paper">Exact times</summary>
      <p className="mt-1 leading-snug text-steel-300">
        <span className="tnum">{EXACT(startsAt)}</span> → <span className="tnum">{EXACT(endsAt)}</span> · {recurs}
      </p>
    </details>
  );
}

// ------------------------------------------------------------------------------------------------ reward details (Arena Picks)
export interface OfficialTokenStatus {
  /** `GET /api/rewards/token`: has $CLANKRPG launched? null = not known (yet). */
  launched: boolean | null;
  symbol?: string;
}

export function RewardDetails({ daily, weekly, shown, token }: { daily: BoardRuleView; weekly: BoardRuleView; shown: "DAILY" | "WEEKLY"; token: OfficialTokenStatus }) {
  const tile = (r: BoardRuleView, kind: "DAILY" | "WEEKLY") => ({ kind, label: kind === "DAILY" ? "Daily pool" : "Weekly pool", amount: groupDigits(r.prizePool), symbol: r.symbol });
  const maxBonus = (shown === "DAILY" ? daily : weekly).holderBonuses.at(-1)?.bonus ?? null;
  const paused = daily.prizesPaused || weekly.prizesPaused;
  return (
    <section className="mt-3.5 rounded-lg border border-clank-400/25 bg-clank-500/[0.05] p-3" aria-label="Reward details" data-testid="reward-details" data-shown={shown}>
      <h3 className="label">Prize pools</h3>
      <div className="mt-1.5">
        <PrizeTilePair daily={tile(daily, "DAILY")} weekly={tile(weekly, "WEEKLY")} />
      </div>
      <ul className="mt-2.5 space-y-1.5 text-[0.76rem] leading-snug text-steel-200" data-testid="reward-facts">
        <li data-testid="reward-top">
          Each pool is shared by the <b className="text-paper">Top {daily.topRewarded}</b>
          {daily.topRewarded === weekly.topRewarded ? "" : <> (Daily) and <b className="text-paper">Top {weekly.topRewarded}</b> (Weekly)</>}, by rank — the ladder is below.
        </li>
        <li data-testid="reward-qualify">
          Prizes need <b className="text-paper">{daily.minimumPicks} valid Picks</b> in the day (Daily) or <b className="text-paper">{weekly.minimumPicks}</b> in the week (Weekly).{" "}
          <span className="text-steel-300">Every valid Pick counts for your rank; a correct Pick is +{daily.pointsPerCorrectPick} Points.</span>
        </li>
        {maxBonus && (
          <li data-testid="reward-holder">
            <b className="text-paper">Holder bonus:</b> qualified holders can add up to <b className="text-paper">{maxBonus}</b> to a prize they earned. It never changes your rank or score.
          </li>
        )}
        <li data-testid="token-status" data-launched={token.launched === null ? "unknown" : String(token.launched)}>
          {token.launched === null ? (
            <span className="text-steel-300">Checking the {daily.symbol} launch status…</span>
          ) : token.launched ? (
            <>
              <b className="text-teal">{daily.symbol} has launched.</b> Prizes you earn are added to your claimable rewards — claim them from the Arena Picks tab on your hero page.
            </>
          ) : (
            <>
              <b className="text-paper">{daily.symbol} has not launched yet.</b> Prizes are recorded as you earn them and become claimable after launch.
            </>
          )}
        </li>
      </ul>
      {paused && <p role="status" className="mt-2 text-[0.72rem] text-ember" data-testid="reward-paused">Prizes are paused right now. Picks and Points continue.</p>}
    </section>
  );
}
