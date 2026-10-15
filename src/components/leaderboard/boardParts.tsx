"use client";

import type { ReactNode } from "react";

import type { LeaderboardSeasonView } from "@/domain/heroArenaDto";

/** The small pieces every board of the Hall of Champions shares (so Picks, Hero Arena and Records look and read like one system). */

export function Chip({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} data-testid={testId}
      className={`rounded-md px-3 py-1.5 font-display text-[0.68rem] tracking-wider uppercase ring-1 transition ${active ? "bg-clank-500 text-white ring-clank-300" : "bg-white/[0.04] text-steel-200 ring-white/10 hover:bg-white/10"}`}>
      {children}
    </button>
  );
}

/**
 * REWARDED / STANDINGS ONLY / STAT LEADERBOARD — one subtle label per view, so it is always clear whether a board pays. Never a banner.
 */
export function StatusChip({ rewarded, scope, stats }: { rewarded: boolean; scope: "DAILY" | "WEEKLY" | "SEASON"; stats: boolean }) {
  if (rewarded) return <span className="chip border-teal/40 bg-teal/10 text-teal uppercase" data-testid="status-rewarded">Rewarded</span>;
  if (stats) return <span className="chip uppercase" data-testid="status-stats" title="A statistic: it carries no prize">Stat leaderboard · no prize</span>;
  return <span className="chip uppercase" data-testid="status-standings" title={scope === "SEASON" ? "Season standings pay nothing: the Daily and Weekly boards are the rewarded ones" : undefined}>Standings only</span>;
}

/** PRE-SEASON is said plainly on every board before Season 1 launches: those records are practice, not official Season records. */
export function SeasonChip({ season }: { season: { label: string; kind: "DEVELOPMENT" | "COMPETITIVE" } | null | undefined }) {
  if (!season) return null;
  if (season.kind === "DEVELOPMENT") return <span className="chip border-gold/40 bg-gold/10 text-gold uppercase" data-testid="season-chip" data-kind="DEVELOPMENT" title="Practice battles and Picks — not official Season records. Season 1 starts every hero at zero.">Pre-season</span>;
  return <span className="chip uppercase" data-testid="season-chip" data-kind="COMPETITIVE">{season.label}</span>;
}

/** Past seasons are one tap away; the season being played is the default. Hidden while there is only one. */
export function SeasonPicker({ seasons, selected, onSelect }: { seasons: readonly LeaderboardSeasonView[]; selected: string | null; onSelect: (id: string | null) => void }) {
  if (seasons.length < 2) return null;
  const effective = selected ?? seasons.find((s) => s.current)?.id ?? seasons[0]?.id;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Season" data-testid="season-select">
      {seasons.map((s) => (
        <Chip key={s.id} active={effective === s.id} onClick={() => onSelect(s.current ? null : s.id)} testId={`season-${s.id}`}>{s.label}{s.current ? " · current" : ""}</Chip>
      ))}
    </div>
  );
}

/** A compact, intentional empty state that sits where the rows would be (not a large card). */
export function EmptyRows({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="plate plate-flat px-4 py-5 text-center" data-testid="board-empty" role="status">
      <p className="text-sm text-steel-200">{text}</p>
      {hint && <p className="mt-1 text-[0.72rem] text-steel-400">{hint}</p>}
    </div>
  );
}

export interface LadderRules {
  topRewarded: number;
  symbol: string;
  prizes: Array<{ position: number; share: string; amount: string | null }>;
}

/**
 * The Top-N prize ladder — straight from the server's rules (one setting), never hard-coded here. Shown ONLY on rewarded views. Three tiles to a row on a phone, five from
 * `sm` up: a tile always has room for the FULL amount (a prize figure is never cut to "150,0…"). With no pool set there are no amounts to show, so it collapses to one line
 * of shares. Used by both rewarded programs.
 */
export function PrizeLadder({ rules }: { rules: LadderRules }) {
  const noAmounts = rules.prizes.every((p) => p.amount === null);
  if (noAmounts) {
    return (
      <p className="mt-3 text-[0.72rem] leading-snug text-steel-400" data-testid="board-ladder">
        <span className="label">Prize ladder · Top {rules.topRewarded}</span> — once a pool is set: {rules.prizes.map((p) => `#${p.position} ${p.share}`).join(" · ")}
      </p>
    );
  }
  return (
    <div className="mt-3.5" data-testid="board-ladder">
      <p className="label">Prize ladder · Top {rules.topRewarded}</p>
      <ol className="mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-5">
        {rules.prizes.map((p) => (
          <li key={p.position} className="min-w-0 rounded-md bg-white/[0.04] px-2 py-1.5 ring-1 ring-white/10" data-position={p.position}>
            <p className="flex items-baseline justify-between gap-1 font-display text-[0.7rem] text-steel-300"><span>#{p.position}</span><span className="text-[0.62rem] text-steel-400">{p.share}</span></p>
            <p className="truncate font-display text-sm text-clank-200 tnum" title={p.amount ? `${p.amount} ${rules.symbol}` : "Pool not set"}>{p.amount ?? "—"}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
