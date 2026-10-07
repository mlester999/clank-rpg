import Link from "next/link";
import type { ReactNode } from "react";

import { RarityBadge, RarityFrame } from "@/components/hero/rarity";
import { GAME_RULES, compactNumber, formatWhole } from "@/domain/gameRules";
import { rarityVisual } from "@/domain/hero/rarityVisuals";
import { PwrValue } from "@/components/hero/rarity";

import { CopyAnchor } from "./CopyAnchor";

/**
 * The building blocks of a docs page (server-safe: no hooks). Pages are plain JSX made of these and ordinary <p>/<ul>/<ol>; the `.docs-prose` wrapper
 * (in the shell) styles the plain elements. Numbers always come from GAME_RULES.
 */

export function DocH2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="docs-h2 group scroll-mt-28">
      <span className="min-w-0">{children}</span>
      <a href={`#${id}`} className="docs-anchor docs-plain shrink-0" aria-label="Link to this section">#</a>
      <span className="ml-auto shrink-0 max-sm:hidden"><CopyAnchor id={id} /></span>
    </h2>
  );
}

export function DocH3({ id, children }: { id?: string; children: ReactNode }) {
  return <h3 id={id} className="docs-h3">{children}</h3>;
}

export function Callout({ tone = "note", title, children }: { tone?: "note" | "good" | "warn"; title?: string; children: ReactNode }) {
  return (
    <aside className="docs-callout" data-tone={tone}>
      {title && <span className="docs-callout-title">{title}</span>}
      {children}
    </aside>
  );
}

export function DocTable({ head, rows, caption }: { head: string[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="docs-table-wrap" role="region" aria-label={caption} tabIndex={0}>
      <table>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Internal docs link. */
export function DocLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link href={to}>{children}</Link>;
}

/** The rarity ladder as a table: tier · PWR range · odds · how it looks. One source: GAME_RULES.rarity. */
export function RarityTable() {
  return (
    <DocTable
      caption="Rarity tiers"
      head={["Rarity", "PWR range", "Odds", "Visual style"]}
      rows={GAME_RULES.rarity.ladder.map((r) => [
        <RarityBadge key="b" rarity={r.id} size="md" />,
        <span key="p" className="font-display tracking-wider tabular-nums text-paper">{r.band}</span>,
        <span key="o" className="tabular-nums">{r.oddsPercent}%</span>,
        <span key="v"><strong>{r.visual.frame}.</strong> {r.visual.effect}</span>,
      ])}
    />
  );
}

/** Four little framed PWR cards — the ladder at a glance. */
export function RarityLadderStrip() {
  return (
    <ol className="!m-0 !mb-6 grid list-none grid-cols-2 gap-3 !p-0 sm:grid-cols-4" aria-label="Rarity ladder">
      {GAME_RULES.rarity.ladder.map((r) => (
        <li key={r.id} className="!m-0 !p-0 before:!hidden">
          <RarityFrame rarity={r.id} className="flex flex-col items-center gap-2 px-2 py-4 text-center">
            <RarityBadge rarity={r.id} size="sm" />
            <PwrValue power={r.powerMin} rarity={r.id} size="md" />
            <span className="text-xs tabular-nums text-steel-300">{r.band}</span>
          </RarityFrame>
        </li>
      ))}
    </ol>
  );
}

/** Prize table for one board: position · share · amount. */
export function PrizeTable({ pool, label }: { pool: string; label: string }) {
  const ladder = GAME_RULES.picks.prizeLadderPercent;
  return (
    <DocTable
      caption={`${label} prize ladder`}
      head={["Position", "Share of the pool", `Prize (${GAME_RULES.token.symbol})`]}
      rows={ladder.map((percent, i) => [`#${i + 1}`, `${percent}%`, <span key="a" className="tabular-nums">{formatWhole(Math.floor((Number(pool) * percent) / 100))}</span>])}
    />
  );
}

export function HolderTierTable() {
  return (
    <DocTable
      caption="Holder bonus tiers"
      head={["Tier", "You hold", "Bonus on an earned prize"]}
      rows={GAME_RULES.holderBonus.tiers.map((t) => [t.label, t.minimum === 0 ? "—" : `${compactNumber(t.minimum)} ${GAME_RULES.token.symbol} or more`, t.bonusPercent === 0 ? "0%" : `+${t.bonusPercent}%`])}
    />
  );
}

/** A class summary card. */
export function ClassSummary({ id }: { id: string }) {
  const c = GAME_RULES.classes.find((x) => x.id === id);
  if (!c) return null;
  return (
    <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm sm:grid-cols-3" data-testid={`class-${id}`}>
      <div><dt className="label !text-[0.6rem]">Role</dt><dd className="text-paper">{c.role}</dd></div>
      <div><dt className="label !text-[0.6rem]">Reach</dt><dd className="text-paper">{c.reach}</dd></div>
      <div className="col-span-2 sm:col-span-1"><dt className="label !text-[0.6rem]">Strongest stats</dt><dd className="text-paper">{c.strongest.map((s) => s.label).join(" · ")}</dd></div>
    </dl>
  );
}

export const rarityLabel = (id: Parameters<typeof rarityVisual>[0]): string => rarityVisual(id).label;
