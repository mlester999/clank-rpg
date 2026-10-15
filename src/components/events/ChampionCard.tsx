"use client";

import Link from "next/link";

import { HeroAvatar } from "@/components/hero/HeroAvatar";
import { HeroName } from "@/components/hero/HeroName";
import { lookFor } from "@/components/hero/look";
import { RarityBadge } from "@/components/hero/rarity";
import { TrophyIcon } from "@/components/ui/Icons";
import type { EventRowDto, HeroRowDto, PeriodDto, PicksRowDto } from "@/domain/events";
import type { ClassVisual } from "@/lib/dto";

import { CrownIcon } from "./CrownIcon";
import { championTitle, dayLabel, outcomeHeadline, periodLabelOf } from "./eventsModel";

/**
 * THE CHAMPION CARDS of the Events page. Every figure is a FROZEN result (the period's final standings and the hero as it was when the period closed) — never a
 * live number, never a guess. First place gets the visual weight: a gold edge, a crown and the largest portrait; everything else stays compact so the page does
 * not grow into a wall of cards.
 *
 *   FEATURED   the latest completed period of the selected competition
 *   COMPACT    the periods before it
 *   OUTCOME    a period with no champion — said plainly (NO ELIGIBLE WINNER / NO COMPLETED RESULTS / FINALIZING), never filled with an invented winner
 */
export type Classes = Record<string, ClassVisual>;

const fmt = (n: number): string => n.toLocaleString("en-US");
const pct = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)}%`);

/** A portrait from the snapshot, or — when the period closed before snapshots existed — a quiet placeholder (never a made-up hero). */
export function ChampionPortrait({ row, classes, size }: { row: EventRowDto; classes: Classes; size: number }) {
  if (!row.art) {
    return (
      <span className="grid shrink-0 place-items-center rounded-md border border-white/10 bg-white/[0.04] text-steel-400" style={{ width: size, height: size }} aria-hidden data-testid="champion-placeholder">
        <TrophyIcon size={Math.round(size * 0.45)} />
      </span>
    );
  }
  return <HeroAvatar avatarUrl={null} look={lookFor(row.art, classes[row.classId])} size={size} label={row.name} className="rounded-md" />;
}

function NameLink({ row, children }: { row: EventRowDto; children: React.ReactNode }) {
  return row.heroPublicId ? (
    <Link href={`/heroes/${row.heroPublicId}`} className="min-w-0 hover:text-clank-200 focus-visible:text-clank-200">
      {children}
    </Link>
  ) : (
    <>{children}</>
  );
}

function Tile({ label, value, sub, gold = false }: { label: string; value: string; sub?: string; gold?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-white/10 bg-ink-950/50 px-2.5 py-2">
      <p className="text-[0.56rem] tracking-[0.14em] text-steel-400 uppercase">{label}</p>
      <p className={`font-display text-lg leading-tight tnum sm:text-xl ${gold ? "text-gold" : "text-paper"}`}>{value}</p>
      {sub && <p className="truncate text-[0.62rem] text-steel-300 tnum">{sub}</p>}
    </div>
  );
}

/** The champion's headline numbers: Picks → Points / correct Picks / accuracy; Hero Arena → Wins / KOs / matches. */
export function ChampionStats({ row }: { row: EventRowDto }) {
  if (row.program === "picks") {
    const r: PicksRowDto = row;
    return (
      <div className="grid grid-cols-3 gap-1.5" data-testid="champion-stats">
        <Tile label="Points" value={fmt(r.points)} gold />
        <Tile label="Correct" value={fmt(r.correctPicks)} sub={`of ${fmt(r.picks)} Picks`} />
        <Tile label="Accuracy" value={pct(r.accuracy)} />
      </div>
    );
  }
  const r: HeroRowDto = row;
  return (
    <div className="grid grid-cols-3 gap-1.5" data-testid="champion-stats">
      <Tile label="Wins" value={fmt(r.wins)} gold />
      <Tile label="KOs" value={fmt(r.kos)} />
      <Tile label="Matches" value={fmt(r.matches)} sub={r.winRate === null ? undefined : `${Math.round(r.winRate)}% won`} />
    </div>
  );
}

/**
 * A prize is a separate fact from the title. It reads "ALLOCATED": an amount added to the winner's reward balance — never "paid" (a payment is a per-account fact that is
 * not published here), and never shown for a winner who was not allocated one. `tokenLaunched` only decides the honest line about claiming.
 */
export function AllocationLine({ row, tokenLaunched, recognitionOnly }: { row: EventRowDto; tokenLaunched: boolean; recognitionOnly: boolean }) {
  const a = row.allocation;
  if (a.status === "ALLOCATED" && a.amount) {
    return (
      <p className="text-[0.7rem] leading-snug text-steel-300" data-testid="champion-allocation" data-status="ALLOCATED">
        <span className="font-display text-teal tnum">{a.amount} {a.symbol}</span> <span className="tracking-wider text-teal uppercase">allocated</span>
        {a.bonusPart ? <span className="text-steel-400"> · incl. {a.bonusPart} holder bonus</span> : null}
        <span className="block text-steel-400">{tokenLaunched ? "Added to the winner's reward balance." : "Added to the winner's reward balance · claimable once $CLANKRPG launches."}</span>
      </p>
    );
  }
  return (
    <p className="text-[0.7rem] leading-snug text-steel-400" data-testid="champion-allocation" data-status="NONE">
      {recognitionOnly ? "Recognition only — no prize pool for this period." : "No prize allocated."}
    </p>
  );
}

interface CardProps {
  period: PeriodDto;
  classes: Classes;
  tokenLaunched: boolean;
  onOpen: (start: string) => void;
}

const EDGE = "plate-gold";
const BG = "radial-gradient(120% 130% at 0% 0%, rgba(255, 176, 32, 0.17), transparent 56%), radial-gradient(90% 110% at 100% 100%, rgba(150, 99, 218, 0.24), transparent 62%), linear-gradient(180deg, #1c1531 0%, #100d20 100%)";

function OpenButton({ period, onOpen, label = "View full results" }: { period: PeriodDto; onOpen: (s: string) => void; label?: string }) {
  return (
    <button type="button" className="btn btn-sm" onClick={() => onOpen(period.start)} data-testid="champion-open" aria-label={`${label} — ${periodLabelOf(period.kind, period.start)}`}>
      {label}
    </button>
  );
}

/** A period with no champion. */
export function OutcomeCard({ period, onOpen, compact = false }: { period: PeriodDto; onOpen: (s: string) => void; compact?: boolean }) {
  const headline = outcomeHeadline(period.outcome);
  const body =
    period.outcome === "NO_ELIGIBLE_WINNER"
      ? period.program === "picks"
        ? `${fmt(period.participants)} player${period.participants === 1 ? "" : "s"} made Picks, but none reached the ${period.rules?.minimum ?? ""}-Pick minimum.${period.leader ? ` The board's leader, ${period.leader.name}, had ${fmt(period.leader.picks)} valid Picks — below the minimum, so not a prize winner.` : ""}`
        : "Heroes fought, but none won a battle in this period."
      : period.outcome === "FINALIZING"
        ? "The period has closed. Its final results are being frozen and will appear here."
        : "Nothing was settled in this period, so there is nothing to rank.";
  return (
    <article className={`plate plate-flat min-w-0 ${compact ? "p-3" : "p-4"}`} data-testid="champion-outcome" data-outcome={period.outcome}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-display text-[0.7rem] tracking-[0.16em] text-steel-300 uppercase">{periodLabelOf(period.kind, period.start)}</p>
        <span className="chip uppercase" data-testid="champion-outcome-chip">{period.outcome === "FINALIZING" ? "Finalizing" : period.outcome === "NO_ELIGIBLE_WINNER" ? "No winner" : "No results"}</span>
      </div>
      <p className="mt-2 font-display text-base tracking-wider text-paper uppercase sm:text-lg" data-testid="champion-outcome-headline">{headline}</p>
      <p className="mt-1 text-xs leading-snug text-steel-300">{body}</p>
      {period.outcome === "NO_ELIGIBLE_WINNER" && period.finalizedAt !== null && (
        <div className="mt-3"><OpenButton period={period} onOpen={onOpen} /></div>
      )}
    </article>
  );
}

function JointList({ period, classes }: Pick<CardProps, "period" | "classes">) {
  return (
    <ul className="mt-3 space-y-1.5" data-testid="champion-joint-list">
      {period.champions.map((c, i) => (
        <li key={`${c.name}-${i}`} className="flex items-center gap-2.5 rounded-md border border-white/10 bg-ink-950/40 p-2">
          <ChampionPortrait row={c} classes={classes} size={44} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-bold text-paper" data-testid="champion-name">
              <NameLink row={c}>{c.name}</NameLink>
            </span>
            <span className="block truncate text-[0.68rem] text-steel-300 tnum">{c.program === "picks" ? `${fmt(c.points)} points · ${fmt(c.correctPicks)} correct` : `${fmt(c.wins)} wins · ${fmt(c.kos)} KOs`}</span>
          </span>
          <span className="shrink-0 text-right text-[0.66rem] text-teal tnum">{c.allocation.status === "ALLOCATED" ? c.allocation.amount : ""}</span>
        </li>
      ))}
      {period.moreChampions > 0 && <li className="text-center text-[0.68rem] text-steel-400">+{period.moreChampions} more with the same result</li>}
    </ul>
  );
}

/** "9 players · 4 prize-eligible · frozen 15 Oct" — the field the champion beat, and when the result was fixed. */
function metaLine(period: PeriodDto): string {
  const field = period.program === "picks" ? `${fmt(period.participants)} player${period.participants === 1 ? "" : "s"} · ${fmt(period.eligibleParticipants)} prize-eligible` : `${fmt(period.participants)} hero${period.participants === 1 ? "" : "es"} fought`;
  return period.finalizedAt ? `${field} · frozen ${dayLabel(new Date(period.finalizedAt).toISOString().slice(0, 10))}` : field;
}

/** The latest completed period: the champion at full size. */
export function FeaturedChampion({ period, classes, tokenLaunched, onOpen }: CardProps) {
  if (period.champions.length === 0) return <OutcomeCard period={period} onOpen={onOpen} />;
  const joint = period.champions.length > 1;
  const top = period.champions[0] as EventRowDto;
  const title = championTitle(period.program, period.kind, joint);
  return (
    <article className={`plate ${EDGE} p-3.5 sm:p-5`} style={{ ["--plate-bg" as string]: BG, ["--chamfer" as string]: "14px" }} data-testid="champion-featured" data-outcome={period.outcome} data-program={period.program} data-kind={period.kind}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex min-w-0 items-center gap-2 font-display text-[0.72rem] tracking-[0.16em] text-gold uppercase sm:text-sm" data-testid="champion-title">
          <TrophyIcon size={18} className="shrink-0 text-gold" />
          <span className="truncate">{title}</span>
        </p>
        <p className="font-display text-xs tracking-[0.14em] text-steel-200 uppercase" data-testid="champion-period">{periodLabelOf(period.kind, period.start)}</p>
      </header>

      {joint ? (
        <>
          <p className="mt-2 text-xs text-steel-300">Exactly tied for first — nobody is picked arbitrarily.</p>
          <JointList period={period} classes={classes} />
        </>
      ) : (
        <div className="mt-7 flex gap-3.5 sm:gap-5">
          <div className="relative shrink-0 self-start">
            <span className="pointer-events-none absolute -inset-6 rounded-full" style={{ background: "radial-gradient(closest-side, rgba(255,176,32,0.30), rgba(150,99,218,0.12) 62%, transparent)" }} aria-hidden />
            <span className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 text-gold drop-shadow-[0_2px_0_#4d2d87]" aria-hidden><CrownIcon size={30} float /></span>
            <span className="relative block sm:hidden"><ChampionPortrait row={top} classes={classes} size={92} /></span>
            <span className="relative hidden sm:block"><ChampionPortrait row={top} classes={classes} size={148} /></span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="min-w-0" data-testid="champion-name">
              <NameLink row={top}>
                <HeroName name={top.name} as="h3" max="1.85rem" wrapCap="1.35rem" min="0.85rem" className="uppercase" />
              </NameLink>
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.72rem] text-steel-200" data-testid="champion-identity">
              {top.rarity && <RarityBadge rarity={top.rarity} size="xs" />}
              <span className="truncate">{classes[top.classId]?.name ?? top.classId}</span>
              {top.power !== null && <span className="tnum text-steel-300">· PWR {fmt(top.power)}</span>}
              {top.tied && <span className="tracking-wider text-gold uppercase">· tied</span>}
            </p>
            <div className="mt-3 hidden sm:block"><ChampionStats row={top} /></div>
            <p className="mt-2 hidden text-[0.68rem] text-steel-400 tnum sm:block" data-testid="champion-meta">{metaLine(period)}</p>
          </div>
        </div>
      )}

      {!joint && <div className="mt-3 sm:hidden"><ChampionStats row={top} /><p className="mt-2 text-[0.68rem] text-steel-400 tnum" data-testid="champion-meta-mobile">{metaLine(period)}</p></div>}

      <footer className="mt-3.5 flex flex-wrap items-end justify-between gap-x-4 gap-y-2.5">
        <div className="min-w-0 flex-1"><AllocationLine row={top} tokenLaunched={tokenLaunched} recognitionOnly={period.rules?.recognitionOnly ?? false} /></div>
        <OpenButton period={period} onOpen={onOpen} />
      </footer>
    </article>
  );
}

/** A previous period: smaller, still the real champion. */
export function CompactChampion({ period, classes, onOpen }: Omit<CardProps, "tokenLaunched">) {
  if (period.champions.length === 0) return <OutcomeCard period={period} onOpen={onOpen} compact />;
  const top = period.champions[0] as EventRowDto;
  const joint = period.champions.length > 1;
  const line = joint
    ? `${period.champions.length + period.moreChampions} tied for first`
    : top.program === "picks"
      ? `${fmt(top.points)} points · ${fmt(top.correctPicks)}/${fmt(top.picks)} correct`
      : `${fmt(top.wins)} wins · ${fmt(top.kos)} KOs${top.power !== null ? ` · PWR ${fmt(top.power)}` : ""}`;
  return (
    <article className="plate plate-flat min-w-0 p-3" data-testid="champion-card" data-outcome={period.outcome}>
      <p className="flex items-center justify-between gap-2 font-display text-[0.62rem] tracking-[0.16em] text-steel-300 uppercase">
        <span className="flex min-w-0 items-center gap-1.5"><CrownIcon size={14} className="text-gold" /><span className="truncate">{championTitle(period.program, period.kind, joint)}</span></span>
        <span className="shrink-0 text-steel-200">{periodLabelOf(period.kind, period.start)}</span>
      </p>
      <div className="mt-2 flex items-center gap-2.5">
        <ChampionPortrait row={top} classes={classes} size={52} />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 font-display text-sm leading-tight tracking-wide break-words text-paper uppercase" title={top.name} data-testid="champion-name">{joint ? `${top.name} +${period.champions.length - 1 + period.moreChampions}` : <NameLink row={top}>{top.name}</NameLink>}</p>
          <p className="truncate text-[0.7rem] text-steel-300 tnum">{line}</p>
          {top.allocation.status === "ALLOCATED" && <p className="truncate text-[0.66rem] text-teal tnum">{top.allocation.amount} {top.allocation.symbol} allocated</p>}
        </div>
      </div>
      <div className="mt-2.5 flex justify-end"><OpenButton period={period} onOpen={onOpen} label="Results" /></div>
    </article>
  );
}
