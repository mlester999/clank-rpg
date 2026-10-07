"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { BoardRuleView } from "@/domain/rewards/leaderboardDto";

interface Pos {
  top: number;
  left: number;
  width: number;
}

const kindWord = (r: BoardRuleView): string => (r.kind === "DAILY" ? "Daily" : "Weekly");

/**
 * The (i) next to DAILY / WEEKLY ARENA PICKS: how the ranking and the prizes work, in plain words. Every number comes from the
 * server's rules for the period (never hard-coded here), and nothing about anti-fraud internals is said. Desktop: hover or click.
 * Phone: tap. Escape or a tap outside closes it.
 *
 * The popover is PORTALLED to the page body and positioned from the button's rectangle: the panels in this UI have a chamfered
 * clip-path that would otherwise cut an absolutely-positioned child at the panel's edge. It is clamped to the viewport, so it
 * never runs off either side — down to a 320 px phone.
 */
export function BoardInfo({ rules, officialToken }: { rules: BoardRuleView; officialToken?: { address: string | null } | null }) {
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = (pinned || hover) && pos !== null;
  const title = `How ${kindWord(rules)} Arena Picks works`;

  const place = () => {
    const b = button.current?.getBoundingClientRect();
    if (!b) return;
    const margin = 12;
    const width = Math.min(400, window.innerWidth - margin * 2);
    const left = Math.min(Math.max(b.left - 8, margin), window.innerWidth - width - margin);
    setPos({ top: b.bottom + 8, left, width });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setPinned(false);
      setHover(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!button.current?.contains(t) && !popover.current?.contains(t)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => {
          place();
          setPinned((v) => !v);
        }}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") {
            place();
            setHover(true);
          }
        }}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={title}
        data-testid="board-info"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-clank-400/50 bg-clank-500/10 font-display text-sm leading-none text-clank-200 transition hover:bg-clank-500/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clank-300"
      >
        <span aria-hidden>i</span>
      </button>
      {open && pos && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popover}
            id={id}
            role="dialog"
            aria-label={title}
            data-testid="board-info-popover"
            onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
            onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
            style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100vh - ${pos.top + 12}px)` }}
            className="z-[60] overflow-y-auto rounded-lg border border-clank-400/40 bg-ink-900 p-3.5 text-left shadow-xl shadow-black/60"
          >
            <BoardRulesList rules={rules} officialToken={officialToken ?? null} />
          </div>,
          document.body,
        )}
    </>
  );
}

/** The rules, in plain words. Every number comes from the server's rules for the period; nothing about anti-fraud internals is said. */
export function BoardRulesList({ rules, officialToken }: { rules: BoardRuleView; officialToken: { address: string | null } | null }) {
  const daily = rules.kind === "DAILY";
  const maxBonus = rules.holderBonuses.at(-1)?.bonus ?? null;
  return (
    <>
      <h3 className="font-display text-sm tracking-wider text-clank-200 uppercase" data-testid="board-info-title">How {daily ? "Daily" : "Weekly"} Arena Picks works</h3>
      <ul className="mt-2 space-y-1.5 text-[0.8rem] leading-snug text-steel-200" data-testid="board-info-rules">
        {daily ? (
          <>
            <li>Pick the winner of upcoming Arena fights.</li>
            <li>Every valid Pick counts.</li>
            <li>Correct Pick = <b className="text-paper">+{rules.pointsPerCorrectPick} Points</b>.</li>
            <li>The leaderboard is a race for the most correct Picks.</li>
            <li>Minimum <b className="text-paper">{rules.minimumPicks}</b> Picks required for Daily prize eligibility.</li>
            <li>Top <b className="text-paper">{rules.topRewarded}</b> receive <b className="text-paper">{rules.symbol}</b> — Daily prize pool <b className="text-paper">{rules.prizePool}</b>.</li>
            <li>Holder bonuses increase rewards, never your rank.{maxBonus && <> Qualified holders can receive up to <b className="text-paper">{maxBonus}</b>.</>}</li>
            <li>Buying tokens during the active leaderboard does not grant an instant bonus.</li>
          </>
        ) : (
          <>
            <li>Every valid Pick throughout the week counts.</li>
            <li>Correct Pick = <b className="text-paper">+{rules.pointsPerCorrectPick} Points</b>.</li>
            <li>Minimum <b className="text-paper">{rules.minimumPicks}</b> Picks required for Weekly prize eligibility.</li>
            <li>Top <b className="text-paper">{rules.topRewarded}</b> rewarded — Weekly prize pool <b className="text-paper">{rules.prizePool} {rules.symbol}</b>.</li>
            <li>Qualified holder bonus requires verified holding continuity before AND throughout the week.</li>
            <li>Holder tier never affects leaderboard score.</li>
            <li>Exact prize-boundary ties share affected prize positions fairly.</li>
          </>
        )}
      </ul>
      <p className="mt-2.5 border-t border-white/10 pt-2 text-[0.7rem] text-steel-300">
        Prizes: {rules.prizes.map((p) => `#${p.position} ${p.share}`).join(" · ")}. Resets {daily ? "every day at" : "every Monday at"} <b className="text-paper">00:00 UTC</b>.
      </p>
      {rules.holderBonuses.length > 0 && (
        <p className="mt-1.5 text-[0.7rem] text-steel-300" data-testid="board-info-bonuses">
          Holder prize bonus: {rules.holderBonuses.map((b) => `${b.label} ${b.bonus}`).join(" · ")} — added on top of a prize you earned.
        </p>
      )}
      {officialToken?.address && (
        <p className="mt-2.5 border-t border-white/10 pt-2 text-[0.7rem] text-steel-300">
          Official {rules.symbol} contract: <span className="font-mono break-all text-steel-100" data-testid="official-contract">{officialToken.address}</span>
        </p>
      )}
    </>
  );
}
