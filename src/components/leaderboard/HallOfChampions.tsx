"use client";

import Link from "next/link";
import { useState } from "react";

import { ArenaPicksBoard } from "@/components/leaderboard/ArenaPicksBoard";
import { HeroArenaBoard, HeroRecordsBoard } from "@/components/leaderboard/HeroBoards";
import { PicksSeasonBoard } from "@/components/leaderboard/PicksSeasonBoard";
import { Chip } from "@/components/leaderboard/boardParts";
import { HALL_METRICS, HALL_SECTIONS, hallQuery, scopesOf, type HallMetric, type HallScope, type HallSection, type HallState } from "@/components/leaderboard/hallModel";
import { usePublicSeason } from "@/components/nav/usePublicSeason";
import { PageHeader } from "@/components/ui/bits";
import { leaderboardsTitle, publicStage } from "@/domain/publicPresentation";
import type { RecordMetric } from "@/domain/heroArena";

/**
 * THE HALL OF CHAMPIONS. Three clearly separate things:
 *   ARENA PICKS   — the PLAYER competition: earn from good Picks (Daily / Weekly are rewarded; Season is standings)
 *   HERO ARENA    — the HERO competition: your hero earns from winning Arena fights (Daily / Weekly rewarded; Season standings)
 *   HERO RECORDS  — statistics, bragging rights: Top-2, KOs, PWR — no prizes
 * The rewarded competitions are visually highlighted and labelled; the records are plain. One scope selector (Daily · Weekly · Season) serves them all.
 */
export function HallOfChampions({ initial }: { initial: HallState }) {
  const [state, setState] = useState<HallState>(initial);
  const set = (patch: Partial<HallState>) => {
    const next = { ...state, ...patch };
    setState(next);
    // Shareable without navigating: the address bar always describes what is on screen.
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/leaderboard${hallQuery(next)}`);
  };
  const season = usePublicSeason();
  const stage = publicStage(season);
  const scopes = scopesOf(state);
  const scope = state.scope;

  return (
    <div className="mx-auto w-full max-w-[1000px] px-3 py-6 sm:px-6" data-testid="hall-of-champions" data-section={state.section} data-scope={state.scope}>
      <PageHeader
        title="Hall of"
        accent="Champions"
        subtitle="Ranked by what players predict and what heroes do — never by how much money is in a wallet."
        right={
          <div className="flex flex-wrap items-center gap-2">
            {season && <span className={`chip uppercase ${stage === "SEASON_LIVE" ? "border-teal/40 bg-teal/10 text-teal" : "border-clank-400/40 bg-clank-500/10 text-clank-300"}`} data-testid="hall-season-label">{leaderboardsTitle(season)}</span>}
            <Link href="/events" className="btn btn-ghost btn-sm" data-testid="hall-events-link">Past champions</Link>
          </div>
        }
      />

      <nav role="tablist" aria-label="Hall of Champions" className="grid grid-cols-1 gap-1.5 sm:grid-cols-3 sm:gap-2" data-testid="hall-sections">
        {HALL_SECTIONS.map((s) => {
          const active = state.section === s.id;
          const rewarded = s.tag === "REWARDED";
          return (
            <button key={s.id} type="button" role="tab" aria-selected={active} data-testid={`section-${s.id}`} onClick={() => set({ section: s.id as HallSection })}
              className={`min-w-0 rounded-md px-3 py-2 text-left ring-1 transition sm:px-3.5 sm:py-2.5 ${active ? (rewarded ? "bg-clank-500/20 ring-clank-300" : "bg-white/10 ring-white/30") : rewarded ? "bg-clank-500/[0.07] ring-clank-400/30 hover:bg-clank-500/[0.12]" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.07]"}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="label truncate">{s.kicker}</span>
                <span className={`shrink-0 rounded px-1.5 py-px text-[0.58rem] tracking-widest uppercase ${rewarded ? "bg-teal/15 text-teal" : "bg-white/10 text-steel-300"}`} data-testid={`section-tag-${s.id}`}>{s.tag}</span>
              </span>
              <span className="mt-0.5 block font-display text-base tracking-wider text-paper uppercase">{s.label}</span>
              {/* On a phone only the section you are in explains itself — three explanations would push the board off the first screen. */}
              <span className={`mt-0.5 text-[0.7rem] leading-snug text-steel-300 ${active ? "block" : "hidden sm:block"}`} data-testid={`section-blurb-${s.id}`}>{s.blurb}</span>
            </button>
          );
        })}
      </nav>

      {state.section === "records" && (
        <div role="tablist" aria-label="Hero Records" className="mt-3 flex flex-wrap gap-1.5" data-testid="hall-metrics">
          {HALL_METRICS.map((m) => (
            <Chip key={m.id} active={state.metric === m.id} onClick={() => set({ metric: m.id as HallMetric })} testId={`metric-${m.id}`}>{m.label}</Chip>
          ))}
        </div>
      )}

      {scopes.length > 0 ? (
        <div role="tablist" aria-label="Period" className="mt-3 mb-3 flex flex-wrap gap-1.5" data-testid="hall-scopes">
          {scopes.map((s) => (
            <Chip key={s.id} active={scope === s.id} onClick={() => set({ scope: s.id as HallScope })} testId={`scope-${s.id}`}>{s.label}</Chip>
          ))}
        </div>
      ) : (
        <div className="mt-3 mb-3 h-0" aria-hidden />
      )}

      <div data-testid="hall-board">
        {state.section === "picks" && (scope === "season" ? <PicksSeasonBoard /> : <ArenaPicksBoard kind={scope === "weekly" ? "WEEKLY" : "DAILY"} />)}
        {state.section === "hero-arena" && <HeroArenaBoard scope={scope} />}
        {state.section === "records" && <HeroRecordsBoard metric={state.metric.toUpperCase() as RecordMetric} scope={scope} />}
      </div>
    </div>
  );
}
