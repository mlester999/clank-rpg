"use client";

import Link from "next/link";
import { useCallback, useState, useSyncExternalStore } from "react";

import { BoardError, BoardSkeleton } from "@/components/leaderboard/HeroBoards";
import { Chip } from "@/components/leaderboard/boardParts";
import { useTokenConfig } from "@/components/leaderboard/useTokenConfig";
import { ResetCountdown } from "@/components/time/ResetCountdown";
import { TimerIcon, TrophyIcon } from "@/components/ui/Icons";
import { eventPeriodKind, programWord, type EventKind, type EventProgram, type EventsListDto, type EventsStateDto, type PeriodDto } from "@/domain/events";
import { periodWindow } from "@/domain/rewards/time";
import { api } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

import { ChampionPortrait, CompactChampion, FeaturedChampion, type Classes } from "./ChampionCard";
import { CrownIcon } from "./CrownIcon";
import { KIND_TABS, PROGRAM_TABS, eventsQuery, outcomeHeadline, periodLabelOf, type EventsViewState } from "./eventsModel";
import { ResultsDialog } from "./ResultsDialog";

const PAGE = 8;

/**
 * EVENTS — who has been winning. RECENT CHAMPIONS (the latest completed period at full size, then the two before it) and PAST RESULTS (every earlier completed
 * period, newest first, a page at a time). Arena Picks and Hero Arena are two separate competitions with two separate winners; Daily and Weekly are the same
 * UTC periods as the live leaderboards. Everything shown is a FROZEN result of an official season — before Season 1 there is simply nothing to show, and the page
 * says so instead of filling the space.
 */
export function EventsView({ initial }: { initial: EventsViewState }) {
  const [view, setView] = useState<EventsViewState>(initial);
  const set = (patch: Partial<EventsViewState>) => {
    const next = { ...view, ...patch };
    setView(next);
    // Shareable without navigating: the address bar always describes what is on screen.
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/events${eventsQuery(next)}`);
  };
  const token = useTokenConfig();
  const list = useEventPeriods(view.program, view.kind);
  // The results dialog is a portal into <body>: it cannot exist on the server, so a deep link (?period=…) opens it only once the page has mounted (no hydration mismatch).
  const mounted = useSyncExternalStore(subscribeNever, () => true, () => false);

  return (
    <>
      <EventsBody
        view={view}
        onProgram={(program) => set({ program, period: null })}
        onKind={(kind) => set({ kind, period: null })}
        data={list.data}
        periods={list.periods}
        nextBefore={list.next}
        loading={list.loading}
        loadingMore={list.loadingMore}
        moreFailed={list.moreFailed}
        error={list.error}
        tokenLaunched={Boolean(token?.launched)}
        onOpen={(period) => set({ period })}
        onLoadMore={list.loadMore}
        onReload={list.reload}
      />
      {mounted && view.period && <ResultsDialog program={view.program} kind={view.kind} start={view.period} tokenLaunched={Boolean(token?.launched)} onClose={() => set({ period: null })} />}
    </>
  );
}

const subscribeNever = (): (() => void) => () => undefined;

/** One competition + period kind: the first page, then older pages on demand. Switching tabs starts over; a page that fails keeps what is already shown. */
function useEventPeriods(program: EventProgram, kind: EventKind) {
  const key = `${program}:${kind}`;
  const first = useRemote<EventsListDto>(() => api<EventsListDto>(`/api/events/champions?program=${program}&kind=${kind}&limit=${PAGE}`), `events:${key}`);
  const [more, setMore] = useState<{ key: string; periods: PeriodDto[]; next: string | null; busy: boolean; failed: boolean } | null>(null);
  const mine = more && more.key === key ? more : null;
  const data = first.data && first.data.program === program && first.data.kind === kind ? first.data : null;
  const next = mine ? mine.next : (data?.nextBefore ?? null);

  const loadMore = useCallback(async () => {
    const cursor = mine ? mine.next : (data?.nextBefore ?? null);
    if (!cursor || mine?.busy) return;
    setMore({ key, periods: mine?.periods ?? [], next: cursor, busy: true, failed: false });
    const r = await api<EventsListDto>(`/api/events/champions?program=${program}&kind=${kind}&limit=${PAGE}&before=${cursor}`);
    setMore((m) => {
      const prior = m && m.key === key ? m.periods : [];
      return r.ok ? { key, periods: [...prior, ...r.data.periods], next: r.data.nextBefore, busy: false, failed: false } : { key, periods: prior, next: cursor, busy: false, failed: true };
    });
  }, [data, key, kind, mine, program]);

  return {
    data,
    periods: [...(data?.periods ?? []), ...(mine?.periods ?? [])],
    next,
    loading: first.loading && !data,
    loadingMore: Boolean(mine?.busy),
    moreFailed: Boolean(mine?.failed),
    error: first.error,
    loadMore,
    reload: first.reload,
  };
}

export interface EventsBodyProps {
  view: EventsViewState;
  onProgram: (p: EventProgram) => void;
  onKind: (k: EventKind) => void;
  data: EventsListDto | null;
  periods: PeriodDto[];
  nextBefore: string | null;
  loading: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  error: { error: string } | null;
  tokenLaunched: boolean;
  onOpen: (start: string) => void;
  onLoadMore: () => void;
  onReload: () => void;
}

/** The pure view of the Events page (exported for server-rendered tests). */
export function EventsBody(p: EventsBodyProps) {
  const state = p.data?.state ?? null;
  const classes: Classes = p.data?.classes ?? {};
  const heading = headingOf(state);
  const [latest, ...rest] = p.periods;
  const recent = rest.slice(0, 2);
  const past = rest.slice(2);
  return (
    <div className="mx-auto w-full max-w-[1000px] px-3 py-6 sm:px-6" data-testid="events-page" data-phase={state?.phase ?? "LOADING"} data-program={p.view.program} data-kind={p.view.kind}>
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="font-display text-2xl tracking-wide text-paper uppercase sm:text-3xl" data-testid="events-title">
            {heading.title === "Events" ? null : <>{heading.title.replace(/ Events$/i, "")} </>}
            <span className="text-shine">Events</span>
          </h1>
          {heading.chip && <span className={`chip uppercase ${heading.chip.tone === "live" ? "border-teal/40 bg-teal/10 text-teal" : "border-clank-400/40 bg-clank-500/10 text-clank-300"}`} data-testid="events-stage-chip">{heading.chip.text}</span>}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-steel-300" data-testid="events-subtitle">{heading.sub}</p>
      </header>

      <section aria-labelledby="recent-champions">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="recent-champions" className="flex items-center gap-2 font-display text-lg tracking-[0.14em] text-gold uppercase sm:text-xl">
              <CrownIcon size={22} /> Recent Champions
            </h2>
            <p className="text-xs text-steel-300">Celebrate the community&apos;s latest winners.</p>
          </div>
          <Link href="/leaderboard" className="font-display text-[0.68rem] tracking-wider text-clank-300 uppercase hover:text-clank-200" data-testid="events-live-link">Live leaderboards →</Link>
        </div>

        <nav role="tablist" aria-label="Competition" className="mt-3 grid grid-cols-2 gap-1.5 sm:gap-2" data-testid="events-programs">
          {PROGRAM_TABS.map((t) => {
            const active = p.view.program === t.id;
            return (
              <button key={t.id} type="button" role="tab" aria-selected={active} data-testid={`events-program-${t.id}`} onClick={() => p.onProgram(t.id)}
                className={`min-w-0 rounded-md px-3 py-2 text-left ring-1 transition ${active ? "bg-clank-500/20 ring-clank-300" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.07]"}`}>
                <span className="label block truncate">{t.kicker}</span>
                <span className="block truncate font-display text-sm tracking-wider text-paper uppercase sm:text-base">{t.label}</span>
              </button>
            );
          })}
        </nav>
        <div role="tablist" aria-label="Period" className="mt-2.5 flex flex-wrap gap-1.5" data-testid="events-kinds">
          {KIND_TABS.map((t) => (
            <Chip key={t.id} active={p.view.kind === t.id} onClick={() => p.onKind(t.id)} testId={`events-kind-${t.id}`}>{t.label}</Chip>
          ))}
        </div>

        {state?.phase === "SEASON_ACTIVE" && <LiveStrip kind={p.view.kind} state={state} onElapsed={p.onReload} />}

        <div className="mt-3.5" data-testid="events-recent">
          {!p.data ? (
            p.loading ? <BoardSkeleton /> : <BoardError code={p.error?.error} onRetry={p.onReload} />
          ) : !latest ? (
            <NoChampions state={p.data.state} view={p.view} />
          ) : (
            <div className="space-y-3">
              <FeaturedChampion period={latest} classes={classes} tokenLaunched={p.tokenLaunched} onOpen={p.onOpen} />
              {recent.length > 0 && (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-2" data-testid="events-previous">
                  {recent.map((period) => <CompactChampion key={period.start} period={period} classes={classes} onOpen={p.onOpen} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {p.data && past.length > 0 && (
        <section aria-labelledby="past-results" className="mt-8" data-testid="events-past">
          <h2 id="past-results" className="font-display text-lg tracking-[0.14em] text-paper uppercase sm:text-xl">Past Results</h2>
          <p className="text-xs text-steel-300">Every completed {p.view.kind === "daily" ? "day" : "week"} of the season, newest first.</p>
          <ul className="mt-3 space-y-1.5" data-testid="events-past-list">
            {past.map((period) => <PastRow key={period.start} period={period} classes={classes} onOpen={p.onOpen} />)}
          </ul>
        </section>
      )}

      {p.data && p.nextBefore && (
        <div className="mt-4 flex flex-col items-center gap-1.5">
          <button type="button" className="btn btn-ghost btn-sm" onClick={p.onLoadMore} disabled={p.loadingMore} data-testid="events-load-more">{p.loadingMore ? "Loading…" : "Load older results"}</button>
          {p.moreFailed && <p className="text-xs text-danger" role="alert" data-testid="events-load-more-error">Couldn&apos;t load older results. Try again.</p>}
        </div>
      )}

      <p className="mt-8 text-[0.68rem] leading-snug text-steel-400" data-testid="events-footnote">
        A {p.view.program === "picks" ? "champion" : "hero title"} is recognition. Prizes are a separate fact: an allocation is an amount added to a reward balance — never a payment on its own. {programWord(p.view.program)} results use the same UTC {p.view.kind === "daily" ? "day" : "week"} as the live leaderboard, and are frozen once a period closes.
      </p>
    </div>
  );
}

interface Heading {
  title: string;
  sub: string;
  chip: { text: string; tone: "live" | "pre" } | null;
}

function headingOf(state: EventsStateDto | null): Heading {
  if (!state) return { title: "Events", sub: "Celebrate the community's latest winners.", chip: null };
  if (state.phase === "PRE_SEASON") return { title: "Events", sub: "Season 1 coming soon. Champions are crowned here once the first official period closes.", chip: { text: "Pre-season", tone: "pre" } };
  const label = state.season?.label ?? "Season";
  return { title: `${label} Events`, sub: state.phase === "SEASON_ACTIVE" ? "Every completed day and week of the season — frozen the moment it closes." : "Past champions stay on record between seasons.", chip: { text: state.phase === "SEASON_ACTIVE" ? label : `${label} · ended`, tone: "live" } };
}

function LiveStrip({ kind, state, onElapsed }: { kind: EventKind; state: EventsStateDto; onElapsed: () => void }) {
  const win = periodWindow(eventPeriodKind(kind), state.serverNow);
  const daily = kind === "daily";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-clank-400/25 bg-clank-500/[0.08] px-3 py-2" data-testid="events-live-strip">
      <TimerIcon size={18} className="text-clank-300" />
      <span className="font-display text-[0.64rem] tracking-[0.16em] text-clank-200 uppercase">{daily ? "Daily" : "Weekly"} ends in</span>
      <ResetCountdown serverNow={state.serverNow} endsAt={win.endsAt} allowDays={!daily} onElapsed={onElapsed} label={`${daily ? "Daily" : "Weekly"} period ends in`} className="font-display text-base text-paper sm:text-lg" testId="events-countdown" />
      <span className="text-[0.7rem] text-steel-400">The next champion is crowned when it closes.</span>
    </div>
  );
}

/** Nothing to celebrate yet — said truthfully for each reason. */
function NoChampions({ state, view }: { state: EventsStateDto; view: EventsViewState }) {
  const pre = state.phase === "PRE_SEASON";
  return (
    <div className="plate plate-flat px-5 py-7 text-center" data-testid="events-empty" data-reason={pre ? "PRE_SEASON" : "NO_CHAMPIONS_YET"}>
      <span className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-gold/30 bg-gold/10 text-gold" aria-hidden><TrophyIcon size={24} /></span>
      <h3 className="mt-3 font-display text-lg tracking-[0.14em] text-paper uppercase">{pre ? "Season 1 coming soon" : "No champions yet"}</h3>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-steel-300">
        {pre
          ? "The first official winners will appear here once Season 1 launches and its first period closes. Pre-season results are practice: they are never shown as official champions."
          : `The first ${state.season?.label ?? "Season"} winners will appear after the first eligible ${view.kind === "daily" ? "day" : "week"} is finalized.`}
      </p>
    </div>
  );
}

function PastRow({ period, classes, onOpen }: { period: PeriodDto; classes: Classes; onOpen: (start: string) => void }) {
  const top = period.champions[0];
  const joint = period.champions.length > 1;
  const headline = top ? (joint ? `${top.name} +${period.champions.length - 1 + period.moreChampions}` : top.name) : outcomeHeadline(period.outcome);
  const detail = !top ? null : top.program === "picks" ? `${top.points.toLocaleString("en-US")} points · ${top.correctPicks.toLocaleString("en-US")} correct` : `${top.wins.toLocaleString("en-US")} wins · ${top.kos.toLocaleString("en-US")} KOs`;
  return (
    <li data-testid="past-row" data-outcome={period.outcome} data-start={period.start}>
      <button type="button" onClick={() => onOpen(period.start)} className="plate plate-flat block w-full min-w-0 p-2.5 text-left transition hover:brightness-125 sm:flex sm:items-center sm:gap-3" aria-label={`${periodLabelOf(period.kind, period.start)} — ${headline}. View full results`}>
        <span className="flex items-baseline justify-between gap-2 sm:block sm:w-24 sm:shrink-0">
          <span className="font-display text-[0.7rem] leading-tight tracking-wider text-steel-200 uppercase sm:text-xs">{periodLabelOf(period.kind, period.start)}</span>
          <span className="font-display text-[0.62rem] tracking-wider text-clank-300 uppercase sm:hidden">Results →</span>
        </span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2.5 sm:mt-0 sm:flex-1 sm:gap-3">
          {top ? <ChampionPortrait row={top} classes={classes} size={36} /> : <span className="h-9 w-9 shrink-0 rounded-md border border-dashed border-white/15" aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className={`line-clamp-2 text-sm leading-tight break-words ${top ? "font-bold text-paper" : "font-display tracking-wider text-steel-300 uppercase"}`}>{headline}</span>
            {detail && <span className="block truncate text-[0.68rem] text-steel-300 tnum">{detail}</span>}
          </span>
        </span>
        <span className="hidden shrink-0 font-display text-[0.62rem] tracking-wider text-clank-300 uppercase sm:inline">Results →</span>
      </button>
    </li>
  );
}

