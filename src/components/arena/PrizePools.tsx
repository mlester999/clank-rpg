"use client";

import type { CSSProperties } from "react";

import { useServerCountdown } from "@/components/leaderboard/useServerCountdown";
import type { PicksRewardDto } from "@/domain/rewards/picksDto";

import { amountWidthEm, prizeFinePrint, prizePlaques, resetText, ROLLING_OVER, type PrizePlaque } from "./prizeView";

/**
 * ARENA PICKS — the two PRIZE PLAQUES: the Daily and the Weekly $CLANKRPG pool, each a small game-board of its own.
 *
 *   · the amounts, the Top-N, the minimums and the moment each board ends come from the server's reward DTO (`prizeView.ts`) — never from a constant here;
 *   · each amount is the TOTAL pool shared by the Top 10 (the wording says so) and the fine print gives the real minimums — no promise to any one player;
 *   · the countdown is the leaderboard's own server-anchored one (`useServerCountdown`), in a leaf component so only that one line re-renders each second;
 *   · size follows the plaque's own width (container query units), so a number can neither overflow nor shrink to nothing on any screen, and the two plaques are
 *     subgrids of one grid, so their amounts always sit on the same line;
 *   · motion is a slow reveal and one soft sheen per plaque every few seconds — switched off for `prefers-reduced-motion`; no sound.
 */

// ------------------------------------------------------------------------------------------------ pixel art
/** A little pixel picture drawn as crisp rectangles (no image file, no blur at any scale). Each letter is a colour of `PIXELS`; `.` is empty. */
const PIXELS: Record<string, string> = { o: "#1c1030", g: "#ffb020", G: "#ffe08a", d: "#b36b00", w: "#fff7da", v: "#9663da", V: "#ca94f9", u: "#4d2d87", r: "#ff5a6e" };

const MEDAL = [
  "..vV.....Vv..",
  "..vVv...vVv..",
  "...vVv.vVv...",
  "....vVuVv....",
  ".....vVv.....",
  "....ooooo....",
  "..ooGGGggoo..",
  ".oGGwwGgggdo.",
  ".oGwGGggggdo.",
  ".oGGGgwgggdo.",
  ".oGggwwwggdo.",
  ".oggggwgggdo.",
  "..oggggggdo..",
  "..ooddddddoo.",
  "....ooooo....",
] as const;

const CROWN = [
  ".w.....G.....G.",
  "GwG...GGG...GGG",
  "GwGo.oGgGo.oGgG",
  "GgGgoGgggGoGgGd",
  "oGgggGggggGgggo",
  "ogggggggggggddo",
  "ogGggggrggggdgo",
  "ogggggggggggddo",
  "odgggggggggdddo",
  "oddddddddddddoo",
  "oooooooooooooo.",
] as const;

export function PixelArt({ rows, size }: { rows: readonly string[]; size: number }) {
  const w = (rows[0] as string).length;
  const h = rows.length;
  const rects: Array<{ x: number; y: number; n: number; c: string }> = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x] as string;
      if (ch === ".") {
        x++;
        continue;
      }
      let n = 1;
      while (row[x + n] === ch) n++;
      rects.push({ x, y, n, c: PIXELS[ch] ?? "#ff00ff" });
      x += n;
    }
  });
  return (
    <svg width={size} height={Math.round((size * h) / w)} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden focusable="false" className="prize-art">
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.n} height={1} fill={r.c} />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ countdown
const never = (): void => undefined;

/** "Resets in 14:23:18" — the leaderboard's own server-anchored clock; this leaf is the only thing that re-renders every second. */
function PrizeCountdown({ plaque, serverNow }: { plaque: PrizePlaque; serverNow: number }) {
  // When it reaches zero the board has rolled over; the Arena's own state read brings the new window within seconds, so there is nothing to refetch here.
  const { remainingMs } = useServerCountdown({ serverNow, endsAt: plaque.endsAt, active: true, onElapsed: never, withDays: plaque.kind === "WEEKLY" });
  const text = resetText(plaque.kind, remainingMs);
  return (
    <p className="prize-reset" data-testid={`prize-${plaque.kind.toLowerCase()}-reset`}>
      <span>{text === ROLLING_OVER ? "" : "Resets in "}</span>
      <b className="tnum">{text}</b>
    </p>
  );
}

// ------------------------------------------------------------------------------------------------ one plaque
function Plaque({ plaque, serverNow }: { plaque: PrizePlaque; serverNow: number }) {
  const weekly = plaque.kind === "WEEKLY";
  const id = `prize-${plaque.kind.toLowerCase()}`;
  return (
    <article
      className={`prize-card plate ${weekly ? "plate-gold prize-weekly" : "plate-clank prize-daily"}`}
      aria-labelledby={`${id}-title`}
      data-testid={id}
      data-kind={plaque.kind}
      style={{ ["--chamfer" as string]: "10px" } as CSSProperties}
    >
      {/* one shared height for both pictures, so the two amounts below sit on the same line */}
      <div className="prize-art-box">{weekly ? <PixelArt rows={CROWN} size={34} /> : <PixelArt rows={MEDAL} size={28} />}</div>
      <h3 id={`${id}-title`} className="prize-title">
        <b>{plaque.title}</b> <span>{plaque.subtitle}</span>
      </h3>
      <p className="prize-amount" data-testid={`${id}-amount`} style={{ ["--amount-em" as string]: amountWidthEm(plaque.amount) } as CSSProperties}>
        {plaque.amount}
      </p>
      <p className="prize-symbol" data-testid={`${id}-symbol`}>
        {plaque.symbol}
      </p>
      <p className="prize-top" data-testid={`${id}-top`}>
        {plaque.topLabel}
      </p>
      <PrizeCountdown plaque={plaque} serverNow={serverNow} />
      <span className="prize-sheen" aria-hidden />
    </article>
  );
}

// ------------------------------------------------------------------------------------------------ the pair
export function PrizePools({ reward, serverNow }: { reward: PicksRewardDto | undefined; serverNow: number }) {
  const plaques = prizePlaques(reward);
  if (!plaques) return null;
  return (
    <section className="mt-2.5" aria-label="Arena Picks prize pools" data-testid="prize-pools">
      <div className="prize-grid">
        <Plaque plaque={plaques.daily} serverNow={serverNow} />
        <Plaque plaque={plaques.weekly} serverNow={serverNow} />
      </div>
      <p className="mt-2 text-[0.66rem] leading-snug text-steel-300" data-testid="prize-fineprint">
        {prizeFinePrint(plaques)}
      </p>
    </section>
  );
}
