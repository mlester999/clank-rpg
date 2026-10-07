"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { BoardInfo } from "@/components/leaderboard/BoardInfo";
import { EmptyRows, PrizeLadder, SeasonChip, StatusChip } from "@/components/leaderboard/boardParts";
import { periodLabel } from "@/components/leaderboard/periodLabel";
import { useServerCountdown } from "@/components/leaderboard/useServerCountdown";
import { useTokenConfig } from "@/components/leaderboard/useTokenConfig";
import { EmptyState, SkeletonBlock } from "@/components/ui/bits";
import { RarityBadge } from "@/components/hero/rarity";
import type { BoardMeDto, BoardPayload, BoardRowDto } from "@/domain/rewards/leaderboardDto";
import type { PeriodKind } from "@/domain/rewards/time";
import { api, friendly, isTransient } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

const CURRENT = "CURRENT";
export { periodLabel };

/**
 * ARENA PICKS LEADERBOARDS — DAILY (00:00 UTC → 00:00 UTC) and WEEKLY (Monday 00:00 UTC → next Monday), ranked by points then
 * accuracy across valid picks. The prize pool, the boundaries and "now" all come from the SERVER; the countdown ticks locally
 * between fetches and the board moves to the new day / week by itself when it reaches zero (nobody can reset it). Finished
 * boards are read-only snapshots. Hero identities only; holdings never enter the ranking.
 */
export function ArenaPicksBoard({ kind: controlled }: { kind?: PeriodKind } = {}) {
  const [own, setKind] = useState<PeriodKind>("DAILY");
  // Inside the Hall of Champions the Daily / Weekly choice is the page's shared scope selector (kind is controlled); on its own the board keeps its own tabs.
  const kind = controlled ?? own;
  const [lastKind, setLastKind] = useState(kind);
  const [selected, setSelected] = useState<string>(CURRENT);
  if (lastKind !== kind) {
    setLastKind(kind);
    setSelected(CURRENT);
  }
  const query = `period=${kind.toLowerCase()}${selected === CURRENT ? "" : `&start=${selected}`}`;
  const { data, error, loading, reload } = useRemote<BoardPayload>(() => api<BoardPayload>(`/api/leaderboard/picks?${query}`), `picks-board:${query}`);
  const token = useTokenConfig();

  const pickKind = (k: PeriodKind) => {
    setKind(k);
    setSelected(CURRENT);
  };

  return (
    <div>
      {controlled === undefined && <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Arena Picks board" data-testid="board-kind">
        {(["DAILY", "WEEKLY"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => pickKind(k)} data-testid={`board-kind-${k.toLowerCase()}`}
            className={`rounded-md px-4 py-2 font-display text-xs tracking-wider uppercase ring-1 transition ${kind === k ? "bg-clank-500 text-white ring-clank-300" : "bg-white/5 text-steel-200 ring-white/10 hover:bg-white/10"}`}>
            {k === "DAILY" ? "Daily" : "Weekly"}
          </button>
        ))}
      </div>}
      {!data && loading ? (
        <div className="space-y-2" aria-busy="true" data-testid="board-loading">{Array.from({ length: 6 }, (_, i) => <SkeletonBlock key={i} className="h-16" />)}</div>
      ) : !data ? (
        <EmptyState title={error && isTransient(error.error) ? "The board is temporarily unavailable" : "Couldn't load the board"} body={error ? friendly(error.error) : "Please try again in a moment."} action={<button className="btn btn-sm" type="button" onClick={reload} data-testid="board-retry">Retry</button>} />
      ) : (
        <BoardView payload={data} selected={selected} onSelect={setSelected} onReload={reload} officialAddress={token?.address ?? null} />
      )}
    </div>
  );
}

/** The pure view of one board payload (the live board and any finished one). Exported for server-rendered tests. */
export function BoardView({ payload, selected, onSelect, onReload, officialAddress }: { payload: BoardPayload; selected: string; onSelect: (start: string) => void; onReload: () => void; officialAddress: string | null }) {
  const { board, me, periods, finalizing, season } = payload;
  const daily = board.kind === "DAILY";
  const isCurrent = board.state === "CURRENT" && selected === CURRENT;
  const word = daily ? "Daily" : "Weekly";

  // Rollover: when the running period's countdown reaches zero the server is already in the next one — fetch it right away (a user
  // can neither trigger nor prevent this), and keep asking every 1.5 s until the server reports the new period.
  const countdown = useServerCountdown({ serverNow: board.serverNow, endsAt: board.endsAt, active: isCurrent, onElapsed: onReload, withDays: !daily });
  const waitingForNext = isCurrent && countdown.parts.done;
  useEffect(() => {
    if (!waitingForNext) return;
    const id = window.setInterval(onReload, 1500);
    return () => window.clearInterval(id);
  }, [waitingForNext, onReload]);

  const finalizingNow = board.state === "FINALIZING";
  return (
    <div data-testid="arena-board" data-kind={board.kind} data-period={board.start} data-state={board.state}>
      <header className="plate plate-flat mb-4 p-3.5 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h2 className="font-display text-lg tracking-wider text-paper uppercase sm:text-xl" data-testid="board-title">{word} Arena Picks</h2>
              <BoardInfo rules={board.rules} officialToken={{ address: officialAddress }} />
              <StatusChip rewarded scope={board.kind} stats={false} />
              <SeasonChip season={season} />
            </div>
            <p className="mt-1 text-xs text-steel-300" data-testid="board-subtitle">
              {isCurrent
                ? daily ? <>{periodLabel(board.start)} · 00:00 UTC → 00:00 UTC</> : <>Week of <b className="text-paper">{periodLabel(board.start)}</b> · Monday 00:00 UTC → Monday 00:00 UTC</>
                : finalizingNow
                  ? <>Final results are being frozen · {daily ? periodLabel(board.start) : `week of ${periodLabel(board.start)}`}</>
                  : <>Final results · {daily ? <b className="text-paper">{periodLabel(board.start)}</b> : <>week of <b className="text-paper">{periodLabel(board.start)}</b></>} · read-only</>}
            </p>
          </div>
          <div className="text-right" data-testid="board-prize-pool">
            <p className="font-display text-xl text-clank-200 tnum sm:text-2xl">{board.rules.prizePool} <span className="text-sm">{board.rules.symbol}</span></p>
            <p className="label">{word} prize pool</p>
            <p className="mt-0.5 font-display text-[0.68rem] tracking-wider text-clank-300 uppercase" data-testid="board-top-rewarded">Top {board.rules.topRewarded} rewarded</p>
          </div>
        </div>

        {board.rules.prizesPaused && <p role="status" className="mt-3 rounded-md border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-ember" data-testid="board-paused">Prizes are paused. Picks and Points continue.</p>}

        <dl className="mt-3.5 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {isCurrent ? (
            <div className="rounded-md border border-clank-400/30 bg-clank-500/[0.07] px-3 py-2" data-testid="board-countdown-box">
              <dt className="label">Ends in</dt>
              <dd className="font-display text-lg text-paper tnum" role="timer" aria-label={`${word} leaderboard ends in ${countdown.text}`} data-testid="board-countdown" data-remaining-ms={Math.max(Math.round(countdown.remainingMs), 0)}>{countdown.text}</dd>
            </div>
          ) : (
            <div className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
              <dt className="label">{finalizingNow ? "Status" : "Finalized"}</dt>
              <dd className="font-display text-lg text-paper tnum">{finalizingNow ? "FINALIZING" : board.finalizedAt ? new Date(board.finalizedAt).toISOString().slice(0, 10) : "—"}</dd>
            </div>
          )}
          {isCurrent || finalizingNow ? (
            <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
              <dt className="label">How it works</dt>
              <dd className="text-[0.72rem] leading-snug text-steel-300" data-testid="board-how-short">Every valid Pick counts. A correct Pick is +{board.rules.pointsPerCorrectPick} Points — a race for the most correct Picks.</dd>
            </div>
          ) : (
            <MeStat label="My reward" value={me?.prize && me.prize.status !== "NONE" ? me.prize.total : "—"} testId="board-my-reward" sub={rewardNote(me)} />
          )}
        </dl>

        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="board-my-stats" aria-label={`My ${word.toLowerCase()} stats`}>
          <MeStat label="Picks" value={me ? me.picks.toLocaleString() : "—"} testId="board-my-picks" />
          <MeStat label="Correct" value={me ? me.correctPicks.toLocaleString() : "—"} testId="board-my-correct" />
          <MeStat label="Accuracy" value={me && me.accuracy !== null ? `${me.accuracy.toFixed(1)}%` : "—"} testId="board-my-accuracy" />
          <MeStat label="Points" value={me ? me.points.toLocaleString() : "—"} testId="board-my-points" />
          <MeStat label={isCurrent || finalizingNow ? "Current rank" : "Final rank"} value={me && me.rank !== null ? `#${me.rank}` : "—"} testId="board-my-rank" sub={me ? (me.rank === null ? "Not ranked yet" : undefined) : "Sign in to see yours"} />
        </dl>

        {(isCurrent || finalizingNow) && me && !me.prizeEligible && (
          <p className="mt-2.5 text-[0.72rem] text-steel-300" data-testid="board-eligibility-note">
            {me.picksToEligible > 0 ? <>Not yet prize eligible — make <b className="text-paper">{me.picksToEligible}</b> more pick{me.picksToEligible === 1 ? "" : "s"} this {daily ? "day" : "week"} ({board.rules.minimumPicks} needed).</> : <>Keep playing to stay on the board.</>}
          </p>
        )}

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5" role="tablist" aria-label={daily ? "Days" : "Weeks"} data-testid="board-period-select">
          <Chip active={selected === CURRENT} onClick={() => onSelect(CURRENT)} testId="period-current">{daily ? "Today" : "Current week"}</Chip>
          {finalizing && <Chip active={selected === finalizing} onClick={() => onSelect(finalizing)} testId={`period-${finalizing}`}>{periodLabel(finalizing)} · finalizing</Chip>}
          {periods.slice(0, daily ? 14 : 12).map((p) => (
            <Chip key={p.start} active={selected === p.start} onClick={() => onSelect(p.start)} testId={`period-${p.start}`}>{periodLabel(p.start)}</Chip>
          ))}
        </div>

        <PrizeLadder rules={board.rules} />
      </header>

      {board.rows.length === 0 ? (
        <EmptyRows text={isCurrent ? "No ranked players yet." : "Nobody played then."} hint={isCurrent ? `Make an Arena Pick to enter ${daily ? "today's" : "this week's"} standings.` : "There are no results to show."} />
      ) : (
        <>
          {isCurrent && <p className="mb-2 text-[0.72rem] text-steel-400">Prizes shown are a projection from the current standings — final only when the {daily ? "day" : "week"} ends. Holder bonuses are decided at the close.</p>}
          <ol className="space-y-2" data-testid="board-rows">
            {board.rows.map((r) => (
              <Row key={`${r.rank}-${r.characterId ?? r.name}`} row={r} final={board.state === "FINAL"} symbol={board.rules.symbol} />
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

function rewardNote(me: BoardMeDto | null): string {
  if (!me?.prize) return "";
  const { status, bonusStatus, bonus } = me.prize;
  if (status === "HELD") return "Held for a quick review";
  if (status === "FORFEITED") return "Not awarded";
  if (status === "NONE") return me.prizeEligible ? "No prize position" : "Not prize eligible";
  if (bonusStatus === "PENDING") return "Holder bonus pending verification";
  return bonus !== "0" ? `Includes a holder bonus of ${bonus}` : "Added to your claimable rewards";
}

function MeStat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <dt className="label">{label}</dt>
      <dd className="font-display text-lg break-words text-paper tnum" data-testid={testId}>{value}</dd>
      {sub && <p className="mt-0.5 text-[0.66rem] leading-snug text-steel-400">{sub}</p>}
    </div>
  );
}

function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} data-testid={testId} className={`rounded-md px-3 py-1.5 font-display text-[0.68rem] tracking-wider uppercase ring-1 transition ${active ? "bg-clank-500 text-white ring-clank-300" : "bg-white/5 text-steel-200 ring-white/10 hover:bg-white/10"}`}>
      {children}
    </button>
  );
}

function Row({ row: r, final, symbol }: { row: BoardRowDto; final: boolean; symbol: string }) {
  const hasBonus = r.holderBonus !== "0";
  const body = (
    <>
      <span className={`w-9 shrink-0 text-center font-display text-lg tnum ${r.rank === 1 ? "text-clank-300" : r.rank === 2 ? "text-paper" : r.rank === 3 ? "text-ember" : "text-steel-400"}`}>
        {r.rank}
        {r.tied && <span className="block text-[0.55rem] leading-none tracking-wider text-steel-400" title="Tied: same correct picks and accuracy">TIE</span>}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="block max-w-full min-w-0 truncate text-sm font-bold text-paper sm:text-base" title={r.name}>{r.name}</span>
          {r.rarity && <RarityBadge rarity={r.rarity} size="xs" />}
        </span>
        <span className="block text-[0.68rem] leading-snug text-steel-300 tnum">
          {r.correctPicks}/{r.picks} correct · {r.accuracy.toFixed(1)}% · streak {r.currentStreak} (best {r.bestStreak})
        </span>
        {!r.prizeEligible && <span className="mt-0.5 inline-block rounded border border-white/15 px-1.5 py-px text-[0.6rem] tracking-wider text-steel-300 uppercase" data-testid="not-prize-eligible">{final ? "Not prize eligible" : "Not yet prize eligible"}</span>}
        {final && r.holderTier && hasBonus && <span className="mt-0.5 ml-1 inline-block rounded border border-clank-400/40 bg-clank-500/10 px-1.5 py-px text-[0.6rem] tracking-wider text-clank-200 uppercase" data-testid="row-holder-tier">{r.holderTier} holder</span>}
        {final && r.bonusStatus === "PENDING" && <span className="mt-0.5 block text-[0.66rem] text-steel-400" data-testid="row-bonus-pending">Holder bonus pending verification</span>}
      </span>
      <span className="shrink-0 text-right">
        <span className="block font-display text-lg text-clank-300 tnum sm:text-xl">{r.points.toLocaleString()}</span>
        <span className="block text-[0.65rem] text-steel-300">points</span>
        {r.basePrize !== "0" && (
          <span className="mt-0.5 block text-[0.7rem] font-bold text-teal tnum" data-testid="row-prize">
            {final ? <>+{r.totalReward} <span className="font-normal text-steel-400">{symbol}</span></> : <>+{r.basePrize} <span className="font-normal text-steel-400">projected</span></>}
          </span>
        )}
        {final && hasBonus && <span className="block text-[0.62rem] text-steel-400 tnum" data-testid="row-bonus">{r.basePrize} + {r.holderBonus} bonus</span>}
      </span>
    </>
  );
  const cls = `plate flex items-center gap-3 p-2.5 pr-3 sm:pr-4 ${r.rank === 1 ? "plate-clank" : "plate-flat"}`;
  return (
    <li className="rise">
      {r.heroPublicId ? <Link href={`/heroes/${r.heroPublicId}`} className={`${cls} transition hover:brightness-125`}>{body}</Link> : <div className={cls}>{body}</div>}
    </li>
  );
}
