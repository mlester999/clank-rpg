"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { lookFor } from "@/components/hero/look";
import { RarityBadge } from "@/components/hero/rarity";
import { BoardCountdown, ExactTimes } from "@/components/leaderboard/rewardParts";
import { EmptyState, SkeletonBlock } from "@/components/ui/bits";
import type { RecordMetric } from "@/domain/heroArena";
import type { HeroBoardDto, HeroBoardPayload, HeroRecordsPayload, HeroRowDto, HeroRulesView, LeaderboardSeasonView } from "@/domain/heroArenaDto";
import { api, friendly, isTransient } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { Chip, EmptyRows, PrizeLadder, SeasonChip, SeasonPicker, StatusChip } from "./boardParts";
import { periodLabel } from "./periodLabel";

const CURRENT = "CURRENT";

/**
 * HERO ARENA — the HERO competition. Heroes are ranked by ARENA WINS over the SETTLED battles of the period and of one season; PWR, rarity, wallet and Telegram
 * activity play no part. DAILY (one UTC day) and WEEKLY (Monday → Monday, UTC) are REWARDED — the prize goes to the hero's owner, and waits for them if the hero
 * has not been claimed; SEASON is standings only. The pool, the boundaries and "now" come from the server.
 */
export function HeroArenaBoard({ scope }: { scope: "daily" | "weekly" | "season" }) {
  const [selected, setSelected] = useState<string>(CURRENT);
  const [season, setSeason] = useState<string | null>(null);
  const [lastScope, setLastScope] = useState(scope);
  if (lastScope !== scope) {
    // A different scope starts from its own default (today / this week / the current season).
    setLastScope(scope);
    setSelected(CURRENT);
    setSeason(null);
  }
  const query = `scope=${scope}${scope !== "season" && selected !== CURRENT ? `&start=${selected}` : ""}${scope === "season" && season ? `&season=${season}` : ""}`;
  const { data, error, loading, reload } = useRemote<HeroBoardPayload>(() => api<HeroBoardPayload>(`/api/leaderboard/hero-arena?${query}`), `hero-arena:${query}`);
  if (!data) return loading ? <BoardSkeleton /> : <BoardError code={error?.error} onRetry={reload} />;
  return <HeroBoardView payload={data} kind="arena" selected={selected} onSelect={setSelected} season={season} onSeason={setSeason} onReload={reload} />;
}

/** HERO RECORDS — Top-2, KOs and current PWR. Statistics: no prize ladder, no pool, no rules. */
export function HeroRecordsBoard({ metric, scope }: { metric: RecordMetric; scope: "daily" | "weekly" | "season" }) {
  const [season, setSeason] = useState<string | null>(null);
  const query = `metric=${metric.toLowerCase()}&scope=${scope}${season && scope === "season" ? `&season=${season}` : ""}`;
  const { data, error, loading, reload } = useRemote<HeroRecordsPayload>(() => api<HeroRecordsPayload>(`/api/leaderboard/records?${query}`), `records:${query}`);
  if (!data) return loading ? <BoardSkeleton /> : <BoardError code={error?.error} onRetry={reload} />;
  const payload: HeroBoardPayload = { board: data.board, periods: [], finalizing: null, seasons: data.seasons };
  return <HeroBoardView payload={payload} kind={metric} selected={CURRENT} onSelect={() => undefined} season={season} onSeason={setSeason} onReload={reload} />;
}

export function BoardSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" data-testid="board-loading">
      {Array.from({ length: 6 }, (_, i) => <SkeletonBlock key={i} className="h-16" />)}
    </div>
  );
}

export function BoardError({ code, onRetry }: { code: string | undefined; onRetry: () => void }) {
  return (
    <EmptyState
      title={code && isTransient(code) ? "This board is temporarily unavailable" : "Couldn't load this board"}
      body={code ? friendly(code) : "Please try again in a moment."}
      action={<button className="btn btn-sm" type="button" onClick={onRetry} data-testid="board-retry">Retry</button>}
    />
  );
}

type View = "arena" | RecordMetric;

const TITLE: Record<View, string> = { arena: "Hero Arena", TOP2: "Top-2 finishes", KOS: "KOs", PWR: "Current PWR" };
const KICKER: Record<"DAILY" | "WEEKLY" | "SEASON", string> = { DAILY: "Daily", WEEKLY: "Weekly", SEASON: "Season" };

/** The pure view of one Hero Arena / Hero Records payload (exported for server-rendered tests). `kind` is `arena` (wins) or the record metric. */
export function HeroBoardView({ payload, kind, selected, onSelect, season, onSeason, onReload }: { payload: HeroBoardPayload; kind: "arena" | RecordMetric | Lowercase<RecordMetric>; selected: string; onSelect: (start: string) => void; season: string | null; onSeason: (id: string | null) => void; onReload: () => void }) {
  const { board, periods, finalizing, seasons } = payload;
  const view = (kind === "arena" ? "arena" : (kind.toUpperCase() as RecordMetric)) as View;
  const daily = board.scope === "DAILY";
  const isPeriod = board.scope !== "SEASON";
  const isCurrent = isPeriod && board.state === "CURRENT" && selected === CURRENT;
  const finalizingNow = board.state === "FINALIZING";
  const rewarded = board.rewarded && view === "arena" && board.rules !== null;
  const word = view === "PWR" ? "" : KICKER[board.scope];

  // The running period rolls over by itself: when its countdown reaches zero the server is already in the next one. The countdown is a leaf on the shared
  // clock (the board does not re-render every second); this only asks the server again, every 1.5 s, until it has moved on.
  const [elapsedFor, setElapsedFor] = useState<number | null>(null);
  const waiting = isCurrent && board.endsAt !== null && elapsedFor === board.endsAt;
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(onReload, 1500);
    return () => window.clearInterval(id);
  }, [waiting, onReload]);
  const seasonEnd = board.scope === "SEASON" && view !== "PWR" ? (board.season?.endsAt ?? null) : null;

  const sub = subtitle(view, board, selected, finalizingNow);
  return (
    <div data-testid="hero-board" data-view={view} data-scope={board.scope} data-state={board.state} data-rewarded={rewarded ? "true" : "false"}>
      <header className="plate plate-flat mb-3 p-3.5 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h2 className="font-display text-lg tracking-wider text-paper uppercase sm:text-xl" data-testid="board-title">{view === "arena" ? `${word} ${TITLE.arena}` : view === "PWR" ? TITLE.PWR : `${TITLE[view]} · ${word}`}</h2>
              <StatusChip rewarded={rewarded} scope={board.scope} stats={view !== "arena"} />
              <SeasonChip season={board.season} />
            </div>
            {sub && <p className="mt-1 text-xs text-steel-300" data-testid="board-subtitle">{sub}</p>}
          </div>
          {rewarded && board.rules && <PoolCard rules={board.rules} word={word} />}
        </div>

        {isPeriod && view !== "PWR" && (
          <>
            <div className="mt-3 grid gap-2.5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
              <BoardCountdown
                word={word}
                state={isCurrent ? "LIVE" : finalizingNow ? "FINALIZING" : "FINAL"}
                serverNow={board.serverNow}
                endsAt={board.endsAt ?? board.serverNow}
                allowDays={!daily}
                onElapsed={() => { setElapsedFor(board.endsAt); onReload(); }}
                waiting={waiting}
                completedLabel={board.start ? (daily ? periodLabel(board.start) : `Week of ${periodLabel(board.start)}`) : undefined}
                finalizedAt={board.finalizedAt}
              />
              <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <p className="label">How it works</p>
                <p className="mt-0.5 text-[0.72rem] leading-snug text-steel-300" data-testid="board-how-short">{howItWorks(view, rewarded)}</p>
              </div>
            </div>
            {board.startsAt !== null && board.endsAt !== null && <ExactTimes startsAt={board.startsAt} endsAt={board.endsAt} recurs={daily ? "every day" : "every Monday"} />}
          </>
        )}

        {/* A season countdown exists ONLY when the database holds a real, upcoming end time for the season being played — an end date is never invented. */}
        {seasonEnd !== null && (
          <div className="mt-3 max-w-md">
            <BoardCountdown word="Season" state="LIVE" serverNow={board.serverNow} endsAt={seasonEnd} allowDays onElapsed={onReload} />
          </div>
        )}

        {isPeriod && view === "arena" && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label={daily ? "Days" : "Weeks"} data-testid="board-period-select">
            <Chip active={selected === CURRENT} onClick={() => onSelect(CURRENT)} testId="period-current">{daily ? "Today" : "Current week"}</Chip>
            {finalizing && <Chip active={selected === finalizing} onClick={() => onSelect(finalizing)} testId={`period-${finalizing}`}>{periodLabel(finalizing)} · finalizing</Chip>}
            {periods.slice(0, daily ? 14 : 12).map((p) => (
              <Chip key={p.start} active={selected === p.start} onClick={() => onSelect(p.start)} testId={`period-${p.start}`}>{periodLabel(p.start)}</Chip>
            ))}
          </div>
        )}
        {board.scope === "SEASON" && view !== "PWR" && <SeasonPicker seasons={seasons} selected={season} onSelect={onSeason} />}
        {rewarded && board.rules && <PrizeLadder rules={board.rules} />}
      </header>

      <HeroRows board={board} view={view} />
    </div>
  );
}

function subtitle(view: View, board: HeroBoardDto, selected: string, finalizing: boolean): string | null {
  if (view === "PWR") return "The current PWR of every active hero. PWR is a live figure — there is no daily or weekly PWR.";
  if (board.scope === "SEASON") return `${board.season?.label ?? "Season"} · every settled Arena battle of the season`;
  const day = board.scope === "DAILY";
  const label = board.start ? periodLabel(board.start) : "";
  // The running period's window is the countdown card's business (its exact times are one tap away) — no raw "00:00 UTC → 00:00 UTC" line.
  if (selected === CURRENT && board.state === "CURRENT") return null;
  return finalizing ? `Final results are being frozen · ${day ? label : `week of ${label}`}` : `Final results · ${day ? label : `week of ${label}`} · read-only`;
}

function howItWorks(view: View, rewarded: boolean): string {
  if (view === "arena") return rewarded ? "Most Arena Wins in the period. Ties split the prizes of the positions they share. Prizes go to the hero's owner." : "Most Arena Wins in the season.";
  if (view === "TOP2") return "Finished 1st or 2nd in an Arena battle. A statistic — it carries no prize.";
  if (view === "KOS") return "Opponents knocked out. A statistic — it carries no prize.";
  return "";
}

function PoolCard({ rules, word }: { rules: HeroRulesView; word: string }) {
  return (
    <div className="text-right" data-testid="board-prize-pool">
      {rules.poolSet ? (
        <>
          <p className="font-display text-xl text-clank-200 tnum sm:text-2xl">{rules.prizePool} <span className="text-sm">{rules.symbol}</span></p>
          <p className="label">{word} prize pool</p>
          <p className="mt-0.5 font-display text-[0.68rem] tracking-wider text-clank-300 uppercase" data-testid="board-top-rewarded">Top {rules.topRewarded} rewarded</p>
        </>
      ) : (
        <>
          <p className="font-display text-sm tracking-wider text-steel-200 uppercase" data-testid="board-pool-not-set">Reward pool not set</p>
          <p className="label mt-0.5">{word} prize pool</p>
        </>
      )}
      {rules.prizesPaused && <p className="mt-1 text-[0.66rem] text-ember" data-testid="board-paused">Prizes are paused. Rankings continue.</p>}
    </div>
  );
}

function HeroRows({ board, view }: { board: HeroBoardDto; view: View }) {
  if (board.rows.length === 0) {
    const text = view === "arena" || view === "TOP2" || view === "KOS" ? "No settled Arena battles in this period yet." : "No heroes to show yet.";
    return <EmptyRows text={board.scope === "SEASON" && view !== "PWR" ? "No settled Arena battles in this season yet." : text} hint={view === "PWR" ? "Heroes appear here as soon as they exist." : "Rankings appear as soon as the first battle is settled."} />;
  }
  return (
    <>
      {board.state === "CURRENT" && board.rewarded && board.rules?.poolSet && <p className="mb-2 text-[0.72rem] text-steel-400">Prizes shown are a projection from the current standings — final only when the {board.scope === "DAILY" ? "day" : "week"} ends.</p>}
      <ol className="space-y-2" data-testid="board-rows">
        {board.rows.map((r) => <HeroRow key={r.characterId} row={r} board={board} view={view} />)}
      </ol>
    </>
  );
}

const PRIMARY: Record<View, { label: string; value: (r: HeroRowDto) => number }> = {
  arena: { label: "wins", value: (r) => r.wins },
  TOP2: { label: "top-2", value: (r) => r.top2 },
  KOS: { label: "KOs", value: (r) => r.kos },
  PWR: { label: "PWR", value: (r) => r.power },
};

function HeroRow({ row: r, board, view }: { row: HeroRowDto; board: HeroBoardDto; view: View }) {
  const primary = PRIMARY[view];
  const classVisual = board.classes[r.classId];
  const showPrize = board.rewarded && view === "arena";
  const final = board.state === "FINAL";
  const body = (
    <>
      <span className={`w-9 shrink-0 text-center font-display text-lg tnum ${r.rank === 1 ? "text-clank-300" : r.rank === 2 ? "text-paper" : r.rank === 3 ? "text-ember" : "text-steel-400"}`} data-testid="row-rank">
        {r.rank}
        {r.tied && <span className="block text-[0.55rem] leading-none tracking-wider text-steel-400" title="Tied: exactly the same number — nothing breaks a tie">TIE</span>}
      </span>
      {r.appearance && <HeroAvatar avatarUrl={r.avatarUrl} look={lookFor(r.appearance, classVisual)} size={r.rank <= 3 ? 48 : 40} className="shrink-0 rounded-md" label={r.name} />}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="block max-w-full min-w-0 truncate text-sm font-bold text-paper sm:text-base" title={r.name} data-testid="row-name">{r.name}</span>
          {r.rarity && <RarityBadge rarity={r.rarity} size="xs" />}
        </span>
        <span className="block truncate text-[0.7rem] text-steel-300" data-testid="row-sub">
          {classVisual?.name ?? r.classId}
          {r.seasonRank ? ` · ${r.seasonRank.name}` : ""}
          {view !== "PWR" ? ` · PWR ${r.power.toLocaleString()}` : ""}
          {r.isDemo ? " · Demo" : ""}
        </span>
        {/* The compact line phones read; wider screens get the columns on the right instead. */}
        {view !== "PWR" && <span className="mt-0.5 block text-[0.68rem] text-steel-300 tnum sm:hidden" data-testid="row-stats-compact">{r.matches} matches · {r.wins} wins{board.scope === "SEASON" || view !== "arena" ? ` · ${r.top2} top-2 · ${r.kos} KOs` : ""} · {r.winRate.toFixed(1)}%</span>}
        {showPrize && r.prizeStatus === "RESERVED" && <span className="mt-0.5 block text-[0.66rem] text-steel-400" data-testid="row-reserved">Reserved — this hero hasn&apos;t been claimed yet</span>}
        {showPrize && !r.prizeEligible && r.wins === 0 && final && <span className="mt-0.5 inline-block rounded border border-white/15 px-1.5 py-px text-[0.6rem] tracking-wider text-steel-300 uppercase">No wins</span>}
      </span>
      {view !== "PWR" && (
        <dl className="hidden shrink-0 grid-cols-[repeat(3,3.6rem)] gap-1 text-center sm:grid" data-testid="row-stats">
          <Stat label="Matches" value={r.matches} />
          {board.scope === "SEASON" || view !== "arena" ? <Stat label="Top-2" value={r.top2} /> : <Stat label="Wins" value={r.wins} />}
          {board.scope === "SEASON" || view !== "arena" ? <Stat label="KOs" value={r.kos} /> : <Stat label="Win rate" value={`${r.winRate.toFixed(0)}%`} />}
        </dl>
      )}
      <span className="shrink-0 text-right">
        <span className="block font-display text-lg text-clank-300 tnum sm:text-xl" data-testid="row-primary">{primary.value(r).toLocaleString()}</span>
        <span className="block text-[0.65rem] text-steel-300">{primary.label}</span>
        {showPrize && r.prize !== "0" && <span className="mt-0.5 block text-[0.7rem] font-bold text-teal tnum" data-testid="row-prize">{final ? <>+{r.prize}</> : <>+{r.prize} <span className="font-normal text-steel-400">projected</span></>}</span>}
      </span>
    </>
  );
  const cls = `plate flex items-center gap-2.5 p-2.5 pr-3 sm:gap-3 sm:pr-4 ${r.rank === 1 ? "plate-clank" : "plate-flat"}`;
  return (
    <li className="rise" data-testid="hero-row" data-rank={r.rank}>
      {r.heroPublicId ? <Link href={`/heroes/${r.heroPublicId}`} className={`${cls} transition hover:brightness-125`}>{body}</Link> : <div className={cls}>{body}</div>}
    </li>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.55rem] tracking-wider text-steel-400 uppercase">{label}</dt>
      <dd className="font-display text-sm text-paper tnum">{typeof value === "number" ? value.toLocaleString() : value}</dd>
    </div>
  );
}

export type { LeaderboardSeasonView };
