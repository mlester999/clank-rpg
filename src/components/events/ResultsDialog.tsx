"use client";

import Link from "next/link";

import { BoardError } from "@/components/leaderboard/HeroBoards";
import { RarityBadge } from "@/components/hero/rarity";
import { Modal } from "@/components/ui/Modal";
import { SkeletonBlock } from "@/components/ui/bits";
import type { EventKind, EventProgram, EventRowDto, PeriodDetailDto } from "@/domain/events";
import { programWord } from "@/domain/events";
import { api } from "@/lib/api";
import type { ClassVisual } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

import { ChampionPortrait } from "./ChampionCard";
import { CrownIcon } from "./CrownIcon";
import { longPeriodLabel, outcomeHeadline, periodLabelOf } from "./eventsModel";

const fmt = (n: number): string => n.toLocaleString("en-US");
const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);

/** FULL RESULTS: the final Top 10 of ONE completed period, read from its frozen rows. */
export function ResultsDialog({ program, kind, start, tokenLaunched, onClose }: { program: EventProgram; kind: EventKind; start: string; tokenLaunched: boolean; onClose: () => void }) {
  const { data, error, loading, reload } = useRemote<{ period: PeriodDetailDto; classes: Record<string, ClassVisual> }>(
    () => api<{ period: PeriodDetailDto; classes: Record<string, ClassVisual> }>(`/api/events/results?program=${program}&kind=${kind}&start=${start}`),
    `events-results:${program}:${kind}:${start}`,
  );
  return (
    <Modal title={`${programWord(program)} · ${kind === "daily" ? "Daily" : "Weekly"} results`} onClose={onClose} wide>
      {!data ? (
        loading ? (
          <div className="space-y-2" aria-busy="true" data-testid="results-loading">{Array.from({ length: 6 }, (_, i) => <SkeletonBlock key={i} className="h-14" />)}</div>
        ) : error?.error === "NOT_FOUND" ? (
          <p className="text-sm text-steel-300" data-testid="results-missing">These results are not available: the period is not a completed period of an official season.</p>
        ) : (
          <BoardError code={error?.error} onRetry={reload} />
        )
      ) : (
        <ResultsBody period={data.period} classes={data.classes} tokenLaunched={tokenLaunched} />
      )}
    </Modal>
  );
}

/** The pure view of one period's final results (exported for server-rendered tests). */
export function ResultsBody({ period, classes, tokenLaunched }: { period: PeriodDetailDto; classes: Record<string, ClassVisual>; tokenLaunched: boolean }) {
  const hero = period.program === "hero";
  const rules = period.rules;
  return (
    <div data-testid="results-dialog" data-program={period.program} data-kind={period.kind} data-outcome={period.outcome}>
      <p className="font-display text-sm tracking-[0.14em] text-paper uppercase" data-testid="results-period">{periodLabelOf(period.kind, period.start)}</p>
      <p className="text-xs text-steel-300">
        {longPeriodLabel(period.kind, period.start)} · UTC{period.finalizedAt ? <> · Final results · Finalized <span className="tnum">{new Date(period.finalizedAt).toISOString().slice(0, 10)}</span></> : null}
      </p>

      {period.standings.length === 0 ? (
        <div className="plate plate-flat mt-3 p-4" data-testid="results-empty">
          <p className="font-display tracking-wider text-paper uppercase">{outcomeHeadline(period.outcome) || "NO COMPLETED RESULTS"}</p>
          <p className="mt-1 text-xs text-steel-300">{period.outcome === "FINALIZING" ? "The final standings are being frozen." : "Nothing was ranked in this period."}</p>
        </div>
      ) : (
        <>
          {period.leader && period.champions.length > 0 && (
            <p className="mt-3 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-steel-200" data-testid="results-leader-note">
              <b className="font-display tracking-wider text-paper uppercase">{period.leader.name}</b> led the board with {fmt(period.leader.correctPicks)} correct of {fmt(period.leader.picks)} Picks but did not reach the {period.leader.minimum}-Pick minimum, so the champion is the first <i>prize-eligible</i> player: {period.champions.map((c) => c.name).join(", ")}.
            </p>
          )}
          {period.outcome === "NO_ELIGIBLE_WINNER" && (
            <p className="mt-3 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-steel-200" data-testid="results-no-winner">
              <b className="font-display tracking-wider text-paper uppercase">No eligible winner.</b>{" "}
              {hero ? "No hero won a battle in this period." : `Nobody reached the ${rules?.minimum ?? ""}-Pick minimum for a prize. The standings below are still the real ones.`}
            </p>
          )}
          <ol className="mt-3 space-y-1.5" data-testid="results-standings">
            {period.standings.map((r, i) => (
              <StandingRow key={`${r.rank}-${r.name}-${i}`} row={r} classes={classes} champion={period.champions.some((c) => c.rank === r.rank && c.name === r.name)} />
            ))}
          </ol>
          {period.standingsCut > 0 && <p className="mt-1.5 text-center text-[0.68rem] text-steel-400">+{period.standingsCut} more tied inside the Top 10</p>}
        </>
      )}

      {rules && (
        <div className="mt-4 space-y-1.5 border-t border-white/10 pt-3 text-[0.72rem] leading-snug text-steel-300" data-testid="results-rules">
          <p>
            {hero
              ? "Ranked by Arena wins in the period. Heroes with the same number of wins share a rank — nothing else breaks a tie."
              : "Ranked by correct Picks, then accuracy. Members tied on both share a rank — nothing else breaks a tie."}{" "}
            A prize needs at least {rules.minimum} {rules.minimumUnit === "wins" ? (rules.minimum === 1 ? "win" : "wins") : "valid Picks"}.
          </p>
          <p data-testid="results-pool">
            {rules.prizePool ? <>Prize pool for this period: <span className="font-display text-teal tnum">{rules.prizePool} {rules.symbol}</span>, shared down the ranks.</> : "No prize pool applied to this period: recognition only."}
          </p>
          <p className="text-steel-400">A champion title is recognition. An allocation is an amount added to a reward balance — it is not a payment{tokenLaunched ? "" : ", and claims open once $CLANKRPG launches"}.</p>
        </div>
      )}
      <div className="mt-3 flex justify-end">
        <Link href="/leaderboard" className="btn btn-ghost btn-sm" data-testid="results-live-link">Live leaderboards</Link>
      </div>
    </div>
  );
}

function StandingRow({ row, classes, champion }: { row: EventRowDto; classes: Record<string, ClassVisual>; champion: boolean }) {
  const hero = row.program === "hero";
  const below = row.program === "picks" && !row.prizeEligible;
  return (
    <li className={`flex items-center gap-2.5 rounded-md border p-2 sm:gap-3 sm:p-2.5 ${champion ? "border-gold/40 bg-gold/[0.07]" : "border-white/10 bg-white/[0.03]"}`} data-testid="standing-row" data-rank={row.rank}>
      <span className="w-8 shrink-0 text-center font-display text-base tnum sm:text-lg" data-testid="standing-rank">
        {champion ? <CrownIcon size={20} className="mx-auto text-gold" /> : null}
        <span className={champion ? "text-gold" : row.rank === 2 ? "text-paper" : row.rank === 3 ? "text-ember" : "text-steel-300"}>{row.rank}</span>
        {row.tied && <span className="block text-[0.5rem] leading-none tracking-wider text-steel-400">TIE</span>}
      </span>
      <ChampionPortrait row={row} classes={classes} size={40} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="block max-w-full min-w-0 truncate text-sm font-bold text-paper" title={row.name} data-testid="standing-name">{row.name}</span>
          {row.rarity && <RarityBadge rarity={row.rarity} size="xs" />}
        </span>
        <span className="block truncate text-[0.68rem] text-steel-300 tnum">
          {classes[row.classId]?.name ?? row.classId}
          {row.power !== null ? ` · PWR ${fmt(row.power)}` : ""}
        </span>
        <span className="mt-0.5 block text-[0.68rem] text-steel-300 tnum sm:hidden">
          {row.program === "picks" ? `${fmt(row.correctPicks)}/${fmt(row.picks)} correct · ${pct(row.accuracy)}` : `${fmt(row.matches)} matches · ${fmt(row.kos)} KOs`}
        </span>
        {below && <span className="mt-0.5 inline-block rounded border border-white/15 px-1.5 py-px text-[0.58rem] tracking-wider text-steel-300 uppercase" data-testid="standing-ineligible">Below minimum Picks</span>}
        {row.allocation.status === "ALLOCATED" && <span className="mt-0.5 block text-[0.66rem] text-teal tnum" data-testid="standing-allocation">{row.allocation.amount} {row.allocation.symbol} allocated{row.allocation.bonusPart ? ` · incl. ${row.allocation.bonusPart} holder bonus` : ""}</span>}
      </span>
      <dl className="hidden shrink-0 grid-cols-[repeat(3,3.7rem)] gap-1 text-center sm:grid">
        {row.program === "picks" ? (
          <>
            <Stat label="Points" value={fmt(row.points)} />
            <Stat label="Correct" value={`${fmt(row.correctPicks)}/${fmt(row.picks)}`} />
            <Stat label="Accuracy" value={pct(row.accuracy)} />
          </>
        ) : (
          <>
            <Stat label="Wins" value={fmt(row.wins)} />
            <Stat label="KOs" value={fmt(row.kos)} />
            <Stat label="Matches" value={fmt(row.matches)} />
          </>
        )}
      </dl>
      <span className="shrink-0 text-right">
        <span className="block font-display text-lg text-clank-300 tnum sm:text-xl" data-testid="standing-score">{hero ? fmt((row as { wins: number }).wins) : fmt((row as { points: number }).points)}</span>
        <span className="block text-[0.6rem] text-steel-300">{hero ? "wins" : "points"}</span>
      </span>
    </li>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.52rem] tracking-wider text-steel-400 uppercase">{label}</dt>
      <dd className="truncate font-display text-xs text-paper tnum">{value}</dd>
    </div>
  );
}

