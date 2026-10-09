import Link from "next/link";
import type { CSSProperties } from "react";

import type { PicksRewardDto } from "@/domain/rewards/picksDto";

import { amountWidthEm, PRIZE_RULES_LINK, prizeTiles, type PrizeTile } from "./prizeView";

/**
 * ARENA PICKS — the two PRIZE TILES: the Daily and the Weekly $CLANKRPG pool, as a compact summary under the panel title.
 *
 *   · only the pool and the token: no "Top 10" banner, no countdown, no fine print (the rules and the live countdowns are on the Leaderboards page);
 *   · the amounts come from the server's reward DTO (`prizeView.ts`) — never from a constant here — and are the TOTAL pools (the label says "pool");
 *   · size follows the tile's own width (container query units), so a number can neither overflow nor shrink to nothing on any screen;
 *   · restrained: a thin edge, a faint tint, a small pixel medal / crown. No glow, no looping motion, no sound.
 *
 * Server-renderable: there is no state and no timer here, so nothing on the Arena re-renders because of it.
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
  // one <path> per colour (runs of equal pixels become one rectangle each): crisp at any scale and a fraction of the markup of a <rect> per run
  const paths = new Map<string, string>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x] as string;
      if (ch === ".") {
        x++;
        continue;
      }
      let n = 1;
      while (row[x + n] === ch) n++;
      paths.set(ch, `${paths.get(ch) ?? ""}M${x} ${y}h${n}v1h-${n}z`);
      x += n;
    }
  });
  return (
    <svg width={size} height={Math.round((size * h) / w)} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden focusable="false" className="prize-art">
      {[...paths].map(([ch, d]) => (
        <path key={ch} d={d} fill={PIXELS[ch] ?? "#ff00ff"} />
      ))}
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ one tile
function Tile({ tile }: { tile: PrizeTile }) {
  const weekly = tile.kind === "WEEKLY";
  const id = `prize-${tile.kind.toLowerCase()}`;
  return (
    <article
      className={`prize-tile plate ${weekly ? "plate-gold prize-tile-weekly" : "plate-clank prize-tile-daily"}`}
      aria-label={`${tile.label}: ${tile.amount} ${tile.symbol}`}
      data-testid={id}
      data-kind={tile.kind}
      style={{ ["--chamfer" as string]: "8px" } as CSSProperties}
    >
      <div className="prize-tile-top">
        <span className="prize-tile-icon">{weekly ? <PixelArt rows={CROWN} size={15} /> : <PixelArt rows={MEDAL} size={13} />}</span>
        <p className="prize-tile-label" data-testid={`${id}-label`}>{tile.label}</p>
      </div>
      <p className="prize-tile-amount" data-testid={`${id}-amount`} style={{ ["--amount-em" as string]: amountWidthEm(tile.amount) } as CSSProperties}>
        {tile.amount}
      </p>
      <p className="prize-tile-symbol" data-testid={`${id}-symbol`}>{tile.symbol}</p>
    </article>
  );
}

// ------------------------------------------------------------------------------------------------ the pair
/** Just the two tiles (the Leaderboards page shows the same pair inside its reward details). */
export function PrizeTilePair({ daily, weekly }: { daily: PrizeTile; weekly: PrizeTile }) {
  return (
    <div className="prize-pair">
      <Tile tile={daily} />
      <Tile tile={weekly} />
    </div>
  );
}

export function PrizePools({ reward }: { reward: PicksRewardDto | undefined }) {
  const tiles = prizeTiles(reward);
  if (!tiles) return null;
  return (
    <section className="mt-2" aria-label="Arena Picks prize pools" data-testid="prize-pools">
      <PrizeTilePair daily={tiles.daily} weekly={tiles.weekly} />
      <p className="mt-1.5 text-[0.64rem] leading-snug text-steel-400" data-testid="prize-rules-link">
        <Link href={PRIZE_RULES_LINK.href} className="text-clank-300 underline-offset-2 hover:underline">{PRIZE_RULES_LINK.text} →</Link>
      </p>
    </section>
  );
}
