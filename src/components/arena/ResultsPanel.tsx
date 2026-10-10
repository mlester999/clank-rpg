"use client";

import Link from "next/link";
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { HeroPortrait } from "@/components/hero/HeroPortrait";
import { lookFor } from "@/components/hero/look";
import { RarityFrame } from "@/components/hero/rarity";
import { CheckIcon, TrophyIcon } from "@/components/ui/Icons";
import type { Rarity } from "@/domain/character/appearance";
import { onDark } from "@/domain/util/color";
import type { ArenaStateDto, FighterDto, ResultRowDto } from "@/lib/dto";

import type { NextBattleLabel } from "./pollSchedule";

/**
 * THE RESULTS SCREEN — #1 WINNER and #2 RUNNER-UP, shown over the stage for the ~5 s between a battle's end and the next one taking the stage.
 *
 * It lays itself out from the STAGE's own measured size, never the page's:
 *   · WIDTH (CSS container queries on the stage wrapper — `@container` there). Phones and narrow stages (< 36rem): two compact HORIZONTAL cards
 *     stacked in one column — a small portrait beside the name, class, PWR and stats; the winner is the larger card. Wide stages (≥ 36rem: tablets,
 *     laptops, desktops): two vertical cards side by side, the winner larger and taller.
 *   · HEIGHT (measured). The stage is a fixed shape, and what goes in it is not: a 40-character name takes three lines, a pick line adds one. After
 *     every render the panel checks whether its content overflows the stage and, if it does, steps down a density tier — title folded away, tighter
 *     cards, smaller portraits, one-line names — until it fits, before the browser paints. A taller stage starts again from the roomiest tier. The
 *     result is never clipped and never scrolls; the stage's own bottom-right corner (the sound button) is kept free by the footer's 3 rem.
 *
 * Nothing in here has a fixed width: every grid track is `minmax(0, …)` and every text node can shrink and wrap (names clamp to their lines, the full
 * name is in a tooltip) — a very long hero name can never push a card, or the other card, out of the stage. Every figure is the server's own result
 * row: nothing is computed or invented here.
 */

export interface ResultEntry {
  f: FighterDto;
  r: ResultRowDto | null;
}

/** 0 = roomy · 1 = tight (title folded away, tighter cards) · 2 = tightest (smallest portraits, one-line names). Only the narrow, stacked layout ever steps down. */
export type Density = 0 | 1 | 2;

/** The numbers a result card shows, in order — only the ones that exist (a runner-up has no HP left; gold appears only when it was awarded). */
export function resultStats(row: ResultRowDto | null | undefined): Array<{ key: "ko" | "dmg" | "hp" | "gold"; value: string; label: string; title?: string }> {
  if (!row) return [];
  const out: Array<{ key: "ko" | "dmg" | "hp" | "gold"; value: string; label: string; title?: string }> = [
    { key: "ko", value: row.eliminations.toLocaleString(), label: row.eliminations === 1 ? "KO" : "KOs", title: "Eliminations" },
    { key: "dmg", value: row.damageDealt.toLocaleString(), label: "dmg", title: "Damage dealt" },
  ];
  if (row.finalHp != null && row.finalHp > 0) out.push({ key: "hp", value: row.finalHp.toLocaleString(), label: "HP", title: "HP remaining" });
  if (row.goldAwarded > 0) out.push({ key: "gold", value: `+${row.goldAwarded.toLocaleString()}`, label: "Gold" });
  return out;
}

/** The classes that differ by density (everything else is the same at every tier). Wide-stage (@xl and up) sizes are the same at every tier. */
export const DENSITY = {
  winnerBox: [
    "h-[4.5rem] w-[4.5rem] @sm:h-[5.5rem] @sm:w-[5.5rem]",
    "h-14 w-14 @sm:h-16 @sm:w-16",
    "h-11 w-11 @sm:h-12 @sm:w-12",
  ],
  runnerBox: ["h-12 w-12 @sm:h-14 @sm:w-14", "h-10 w-10 @sm:h-12 @sm:w-12", "h-9 w-9 @sm:h-10 @sm:w-10"],
  winnerName: ["line-clamp-2", "line-clamp-2", "line-clamp-1"],
  runnerName: ["line-clamp-1 @sm:line-clamp-2", "line-clamp-1", "line-clamp-1"],
  cardPad: ["p-2", "p-1.5", "px-1.5 py-1"],
  title: ["", "sr-only", "sr-only"],
} as const;

const ResultCard = memo(function ResultCard({ fighter, place, visual, disabled, row, density }: { fighter: FighterDto; place: 1 | 2; visual: ArenaStateDto["classes"][string] | undefined; disabled: string[] | undefined; row: ResultRowDto | null; density: Density }) {
  const first = place === 1;
  const stats = resultStats(row);
  const power = fighter.power !== null ? `PWR ${fighter.power.toLocaleString()}` : null;
  // The portrait is drawn once at a fixed resolution and scaled by CSS to the card (a plain canvas that fills its box).
  const px = first ? 132 : 96;
  const box = first
    ? `${DENSITY.winnerBox[density]} @xl:h-[6.5rem] @xl:w-[6.5rem] @3xl:h-[8.25rem] @3xl:w-[8.25rem]`
    : `${DENSITY.runnerBox[density]} @xl:h-20 @xl:w-20 @3xl:h-24 @3xl:w-24`;
  const lines = first ? DENSITY.winnerName[density] : DENSITY.runnerName[density];
  return (
    <Link
      href={`/heroes/${fighter.publicId}`}
      data-testid="result-card"
      data-place={place}
      aria-label={`${first ? "Winner" : "Runner-up"}: ${fighter.name}`}
      style={{ ["--chamfer" as string]: "9px" }}
      className={`plate ${first ? "plate-clank" : ""} flex min-w-0 items-center gap-2.5 ${DENSITY.cardPad[density]} text-left transition-transform hover:-translate-y-0.5 @xl:flex-col @xl:gap-1 @xl:p-3 @xl:text-center ${first ? "" : "opacity-95"}`}
    >
      <RarityFrame rarity={fighter.appearance.rarity as Rarity} compact={!first} className={`grid shrink-0 place-items-center ${box}`}>
        <HeroPortrait look={lookFor(fighter.appearance, visual, disabled)} size={px} animate victory={first} label={fighter.name} className="relative !h-full !w-full" />
      </RarityFrame>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 @xl:w-full @xl:flex-none @xl:items-center">
        <span className={`flex items-center gap-1.5 font-display tracking-[0.18em] @xl:flex-col @xl:gap-1 @xl:tracking-[0.25em] ${first ? "text-[0.7rem] text-clank-300 @xl:text-sm" : "text-[0.62rem] text-steel-300 @xl:text-xs"}`}>
          {first && (
            <span aria-hidden className="trophy-float grid h-5 w-5 shrink-0 place-items-center rounded-full bg-clank-300 text-ink-950 shadow-[0_0_14px_rgba(202,148,249,.75)] @xl:h-8 @xl:w-8 @xl:shadow-[0_0_22px_rgba(202,148,249,.8)]">
              <TrophyIcon size={12} className="@xl:hidden" />
              <TrophyIcon size={18} className="hidden @xl:block" />
            </span>
          )}
          {first ? "#1 WINNER" : "#2 RUNNER-UP"}
        </span>
        <span
          className={`${lines} @xl:line-clamp-2 max-w-full font-display leading-tight text-paper [overflow-wrap:anywhere] ${first ? "text-[0.95rem] @sm:text-base @xl:text-lg @3xl:text-2xl" : "text-[0.8rem] @sm:text-sm @xl:text-base @3xl:text-lg"}`}
          title={fighter.name}
          data-testid="result-name"
        >
          {fighter.name}
        </span>
        {/* tightest tier: the class line and the figures share rows (they wrap onto a second row only if they must) */}
        <span className={density === 2 ? "flex flex-wrap items-baseline gap-x-2.5 gap-y-0 @xl:contents" : "contents"}>
          <span className="max-w-full truncate text-[0.72rem] text-steel-300 tnum @xl:text-xs">
            <b className="font-semibold" style={visual?.colors[0] ? { color: onDark(visual.colors[0]) } : undefined}>{visual?.name ?? "Hero"}</b>
            {power ? ` · ${power}` : ""}
            {fighter.title ? <span className="hidden @xl:inline"> · {fighter.title}</span> : null}
          </span>
          {stats.length > 0 && (
            <span className="flex flex-wrap gap-x-2.5 gap-y-0 text-[0.7rem] text-steel-300 tnum @xl:justify-center @xl:gap-x-3">
              {stats.map((s) => (
                <span key={s.key} title={s.title} className={s.key === "gold" ? "font-semibold text-gold" : undefined}>
                  <b className={s.key === "gold" ? "" : "text-paper"}>{s.value}</b> {s.label}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </Link>
  );
});

export interface PickLine {
  name: string;
  outcome: "CORRECT" | "INCORRECT" | "VOID" | "PENDING";
  /** Points awarded (only once settled). */
  points?: number;
}

export function NextBattleLine({ next }: { next: NextBattleLabel }) {
  return (
    <p className="flex items-center justify-center gap-1.5 text-[0.7rem] text-steel-300 @sm:text-xs" data-testid="results-next">
      {next.kind === "countdown" ? (
        <>
          <span className="label">Next battle in</span>
          <span className="font-display text-clank-300 tnum">{next.seconds}</span>
          <span className="label">sec</span>
        </>
      ) : next.kind === "starting" ? (
        <span className="label">Next battle starting…</span>
      ) : (
        <span className="label text-clank-300">Preparing next battle…</span>
      )}
    </p>
  );
}

export function PickResultLine({ pick }: { pick: PickLine }) {
  return (
    <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-[0.7rem] text-steel-300 @sm:text-xs" data-testid="pick-overlay">
      <span className="inline-flex min-w-0 max-w-full items-center gap-1">
        Your pick: <b className="min-w-0 max-w-[9rem] truncate text-paper @xl:max-w-[16rem]">{pick.name}</b>
      </span>
      {pick.outcome === "CORRECT" ? (
        <span className="chip border-teal/50 bg-teal/15 text-teal">
          <CheckIcon size={12} /> Correct pick
          {pick.points !== undefined ? ` +${pick.points} Points` : ""}
        </span>
      ) : pick.outcome === "INCORRECT" ? (
        <span className="chip">Not this time</span>
      ) : pick.outcome === "VOID" ? (
        <span className="chip">Battle cancelled</span>
      ) : (
        <span className="chip">Settling…</span>
      )}
    </p>
  );
}

/**
 * The overlay itself. It fills the stage (`absolute inset-0`) as a column: a title, the cards (centred in whatever height is left), and a footer
 * at least 3 rem tall that keeps 3 rem clear on BOTH sides — the sound button lives in the stage's bottom-right corner (44 px plus its margin), and
 * neither a card nor a line of text is ever drawn under it. `density` steps down by itself when the content would not fit (see the header).
 */
export function ResultsPanel({ entries, classes, disabled, pick, next, density: forced }: { entries: readonly ResultEntry[]; classes: ArenaStateDto["classes"]; disabled: string[] | undefined; pick: PickLine | null; next: NextBattleLabel | null; density?: Density }): ReactNode {
  const col = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState<Density>(0);
  const density = forced ?? auto;
  // What is shown decides the starting tier: other heroes or a pick line appearing start again from the roomiest layout.
  const signature = `${entries.map((e) => e.f.characterId).join(",")}|${pick ? `${pick.outcome}${pick.points ?? ""}` : "-"}`;
  const [seen, setSeen] = useState(signature);
  if (seen !== signature) {
    setSeen(signature);
    setAuto(0);
  }
  // The stage's size, as the panel last saw it: a change starts the fit again from the roomiest tier (a rotated phone, a resized window).
  const [stageSize, setStageSize] = useState("");
  // Before paint, whenever the tier, what is shown or the stage's size changed: if the content is taller than its box, take the next tier down. The
  // effect runs again for the new tier, so it keeps stepping until the content fits (or the tightest tier is reached) — all before the browser paints.
  useLayoutEffect(() => {
    const el = col.current;
    if (!el || forced !== undefined) return;
    if (el.scrollHeight > el.clientHeight + 1) setAuto((d) => (d < 2 ? ((d + 1) as Density) : d));
  }, [forced, density, signature, stageSize]);
  useEffect(() => {
    const el = col.current?.parentElement?.parentElement;
    if (!el || typeof ResizeObserver === "undefined") return;
    let w = el.clientWidth;
    let h = el.clientHeight;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - w) > 1 || Math.abs(el.clientHeight - h) > 1) {
        w = el.clientWidth;
        h = el.clientHeight;
        setAuto(0);
        setStageSize(`${w}x${h}`);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (entries.length === 0) return null;
  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden bg-ink-950/60 backdrop-blur-[2px]" data-testid="results-panel" data-density={density}>
      {/* the pulsing glow scales a little: it lives in its own clipped box, so nothing of it extends past the panel */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="winner-glow absolute inset-0" />
      </div>
      <div ref={col} className="slide-up relative flex min-h-0 flex-1 flex-col px-2 pt-2 @xl:px-5 @xl:pt-3">
        <p className={`shrink-0 text-center font-display text-[0.62rem] tracking-[0.3em] text-clank-300 uppercase @xl:not-sr-only @xl:text-xs ${DENSITY.title[density]}`}>Results</p>
        <div className={`mx-auto my-auto grid w-full min-w-0 max-w-3xl grid-cols-[minmax(0,1fr)] content-center gap-1.5 ${density === 0 ? "py-1.5" : "py-1"} @xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] @xl:items-end @xl:gap-4`} data-testid="results-cards">
          {entries.slice(0, 2).map(({ f, r }, i) => (
            <ResultCard key={f.characterId} fighter={f} place={(i + 1) as 1 | 2} visual={classes[f.classId]} disabled={disabled} row={r} density={density} />
          ))}
        </div>
        <div className="flex min-h-12 shrink-0 flex-col items-center justify-center gap-0.5 pr-12 pb-1 pl-12" data-testid="results-footer">
          {pick && <PickResultLine pick={pick} />}
          {next && <NextBattleLine next={next} />}
        </div>
      </div>
    </div>
  );
}
