"use client";

import Link from "next/link";
import { useState } from "react";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { RarityBadge } from "@/components/hero/rarity";
import type { Rarity } from "@/domain/character/appearance";
import { ArenaPicksBoard } from "@/components/leaderboard/ArenaPicksBoard";
import { lookFor } from "@/components/hero/look";
import { EmptyState, PageHeader, SkeletonBlock } from "@/components/ui/bits";
import { api } from "@/lib/api";
import type { ClassVisual, LeaderboardRow } from "@/lib/dto";
import { useRemote } from "@/lib/useRemote";

const BOARDS = [
  { id: "WINS", label: "Arena Wins", unit: "wins", second: "top-2" },
  { id: "TOP2", label: "Top-2", unit: "top-2", second: "wins" },
  { id: "KOS", label: "KOs", unit: "KOs", second: "wins" },
  { id: "POWER", label: "Power", unit: "power", second: "wins" },
  { id: "COMMUNITY", label: "Community", unit: "activity", second: "messages" },
  { id: "SEASON_POINTS", label: "Season Rank", unit: "pts", second: "wins" },
] as const;

interface BoardResponse {
  label: string;
  seasonal: boolean;
  season: { number: number | null; name: string; label: string; kind: "DEVELOPMENT" | "COMPETITIVE" } | null;
  rows: LeaderboardRow[];
  classes: Record<string, ClassVisual>;
}

type StatBoardId = (typeof BOARDS)[number]["id"];
const WEEKLY = "WEEKLY_PICKS" as const;

export function LeaderboardView() {
  const [tab, setTab] = useState<StatBoardId | typeof WEEKLY>("WINS");
  return (
    <div className="mx-auto w-full max-w-[1000px] px-3 py-6 sm:px-6">
      <PageHeader title="Hall of" accent="Champions" subtitle="Ranked by what heroes do — never by how much money is in a wallet." right={undefined} />
      <div role="tablist" aria-label="Leaderboards" className="mb-4 flex gap-1.5 overflow-x-auto pb-1">
        {[...BOARDS.map((b) => ({ id: b.id as StatBoardId | typeof WEEKLY, label: b.label })), { id: WEEKLY as StatBoardId | typeof WEEKLY, label: "Arena Picks" }].map((b) => (
          <button key={b.id} role="tab" aria-selected={tab === b.id} type="button" onClick={() => setTab(b.id)} className={`shrink-0 rounded-md px-3.5 py-2 font-display text-[0.7rem] tracking-wider uppercase ring-1 transition ${tab === b.id ? "bg-clank-500 text-ink-900 ring-clank-400" : "bg-white/[0.03] text-steel-300 ring-white/10 hover:bg-white/[0.06]"}`}>
            {b.label}
          </button>
        ))}
      </div>
      {tab === WEEKLY ? <ArenaPicksBoard /> : <StatBoard board={tab} />}
    </div>
  );
}

function StatBoard({ board }: { board: StatBoardId }) {
  const { data: fetched, error, loading, reload } = useRemote<BoardResponse>(() => api<BoardResponse>(`/api/leaderboard?board=${board}&limit=50`), board);
  // Never show another board's rows while this one is loading.
  const data = !loading ? fetched : null;
  const state: "loading" | "ready" | "error" = loading ? "loading" : error && !data ? "error" : "ready";

  const meta = BOARDS.find((b) => b.id === board)!;
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1));

  return (
    <div>
      {data?.season && <p className="mb-3 flex flex-wrap items-center gap-2"><span className="chip" data-testid="board-season">{data.season.label}</span>{data.season.kind === "DEVELOPMENT" && <span className="chip border-gold/40 bg-gold/10 text-gold">Test battles — not official records</span>}</p>}
      {state === "loading" && <div className="space-y-2" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <SkeletonBlock key={i} className="h-14" />)}</div>}
      {state === "error" && <EmptyState title="Couldn't load this board" body="Please try again in a moment." action={<button className="btn btn-sm" type="button" onClick={reload}>Retry</button>} />}
      {state === "ready" && data && data.rows.length === 0 && (
        <EmptyState title="Nobody on the board yet" body={meta.id === "POWER" || meta.id === "COMMUNITY" ? "As soon as heroes exist, they'll appear here." : "The season is just getting started — the first battles will fill this in."} />
      )}
      {state === "ready" && data && data.rows.length > 0 && (
        <ol className="space-y-2">
          {data.rows.map((r) => (
            <li key={r.characterId} className="rise">
              <Link href={`/heroes/${r.publicId}`} className={`plate flex items-center gap-3 p-2 pr-4 transition hover:brightness-125 sm:gap-4 ${r.rank === 1 ? "plate-clank" : r.rank <= 3 ? "" : "plate-flat"}`} style={{ ["--chamfer" as string]: "8px" }}>
                <span className={`w-9 text-center font-display text-lg tnum ${r.rank === 1 ? "text-clank-300" : r.rank === 2 ? "text-paper" : r.rank === 3 ? "text-ember" : "text-steel-400"}`}>{r.rank}</span>
                <HeroAvatar avatarUrl={r.avatarUrl} look={lookFor(r.appearance, data.classes[r.classId])} size={r.rank <= 3 ? 52 : 44} className="rounded-md" label={r.name} />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="block max-w-full min-w-0 truncate text-sm font-bold text-paper sm:text-base" title={r.name}>{r.name}</span>
                    <RarityBadge rarity={r.appearance.rarity as Rarity} size="xs" />
                  </span>
                  <span className="block truncate text-xs text-steel-300">
                    {data.classes[r.classId]?.name ?? ""}
                    {r.seasonRank ? ` · ${r.seasonRank.name}` : ""}
                    {r.title ? ` · ${r.title}` : ""}
                    {r.isDemo ? " · Demo" : ""}
                    {!r.claimed ? "" : " · Claimed"}
                  </span>
                </span>
                <span className="text-right">
                  <span className="block font-display text-lg text-clank-300 tnum sm:text-xl">{fmt(r.value)}</span>
                  <span className="block text-[0.65rem] text-steel-300 tnum">{meta.unit} · {fmt(r.secondary)} {meta.second}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
