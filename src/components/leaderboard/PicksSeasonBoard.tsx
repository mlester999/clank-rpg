"use client";

import Link from "next/link";
import { useState } from "react";

import { RarityBadge } from "@/components/hero/rarity";
import type { PicksSeasonPayload } from "@/domain/heroArenaDto";
import { api } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { BoardError, BoardSkeleton } from "./HeroBoards";
import { EmptyRows, SeasonChip, SeasonPicker, StatusChip } from "./boardParts";

/**
 * ARENA PICKS · SEASON — the cumulative prediction standings of one season (Rank · Player · Picks · Correct · Accuracy · Points). STANDINGS ONLY: there is no season
 * payout, and no prize ladder is shown here — the Daily and Weekly boards are the rewarded ones. A new season starts at zero; past seasons stay selectable.
 */
export function PicksSeasonBoard() {
  const [season, setSeason] = useState<string | null>(null);
  const query = season ? `period=season&season=${season}` : "period=season";
  const { data, error, loading, reload } = useRemote<PicksSeasonPayload>(() => api<PicksSeasonPayload>(`/api/leaderboard/picks?${query}`), `picks-season:${query}`);
  if (!data) return loading ? <BoardSkeleton /> : <BoardError code={error?.error} onRetry={reload} />;
  return <PicksSeasonView payload={data} season={season} onSeason={setSeason} />;
}

/** The pure view (exported for server-rendered tests). */
export function PicksSeasonView({ payload, season, onSeason }: { payload: PicksSeasonPayload; season: string | null; onSeason: (id: string | null) => void }) {
  const { me, rows } = payload;
  return (
    <div data-testid="picks-season-board" data-rewarded="false">
      <header className="plate plate-flat mb-3 p-3.5 sm:p-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <h2 className="font-display text-lg tracking-wider text-paper uppercase sm:text-xl" data-testid="board-title">Season Arena Picks</h2>
          <StatusChip rewarded={false} scope="SEASON" stats={false} />
          <SeasonChip season={payload.season} />
        </div>
        <p className="mt-1 text-xs text-steel-300" data-testid="board-subtitle">{payload.season?.label ?? "Season"} · every valid Pick of the season. Daily and Weekly are the rewarded boards.</p>
        <SeasonPicker seasons={payload.seasons} selected={season} onSelect={onSeason} />
        {me && (
          <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="board-my-stats" aria-label="My season stats">
            <Me label="Picks" value={me.picks.toLocaleString()} />
            <Me label="Correct" value={me.correctPicks.toLocaleString()} />
            <Me label="Accuracy" value={me.accuracy !== null ? `${me.accuracy.toFixed(1)}%` : "—"} />
            <Me label="Points" value={me.points.toLocaleString()} />
            <Me label="Season rank" value={me.rank !== null ? `#${me.rank}` : "—"} />
          </dl>
        )}
      </header>
      {rows.length === 0 ? (
        <EmptyRows text="No ranked players yet." hint="Make an Arena Pick to enter this season's standings." />
      ) : (
        <ol className="space-y-2" data-testid="board-rows">
          {rows.map((r) => {
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
                  <span className="block text-[0.68rem] leading-snug text-steel-300 tnum" data-testid="row-stats-compact">{r.picks.toLocaleString()} picks · {r.correctPicks.toLocaleString()} correct · {r.accuracy.toFixed(1)}%</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-display text-lg text-clank-300 tnum sm:text-xl" data-testid="row-primary">{r.points.toLocaleString()}</span>
                  <span className="block text-[0.65rem] text-steel-300">points</span>
                </span>
              </>
            );
            const cls = `plate flex items-center gap-3 p-2.5 pr-3 sm:pr-4 ${r.rank === 1 ? "plate-clank" : "plate-flat"}`;
            return (
              <li key={`${r.rank}-${r.characterId ?? r.name}`} className="rise" data-testid="picks-row">
                {r.heroPublicId ? <Link href={`/heroes/${r.heroPublicId}`} className={`${cls} transition hover:brightness-125`}>{body}</Link> : <div className={cls}>{body}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Me({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
      <dt className="label">{label}</dt>
      <dd className="font-display text-lg break-words text-paper tnum">{value}</dd>
    </div>
  );
}
