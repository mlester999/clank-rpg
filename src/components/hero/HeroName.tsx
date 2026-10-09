import type { CSSProperties, ElementType } from "react";

import { nameFit } from "@/domain/character/nameFit";

/**
 * A HERO'S NAME, fitted to its box (css: `.hero-name`). The name is the dominant text on the hero page and the card, so it stays as large as it can:
 *
 *   · it sits on ONE line at the largest size (up to `max`) that fits the box — "MARKYYESTER" is never broken into "MARKYYEST / ER";
 *   · a name that cannot be one line at a good size wraps only BETWEEN words, balanced, at the size its widest word allows (never above `wrapCap`);
 *   · one very long word shrinks (down to `min`) instead of breaking; only past that does it wrap inside the word — a name is never cut off, never an ellipsis.
 *
 * The size is `clamp(min, max(box ÷ whole-name, min(box ÷ widest-word, wrapCap)), max)` where "box" is the wrapper's own width (container query units) and the two
 * widths come from `nameFit` (the face's real advances). Same HTML on the server and in the browser — no measuring script, no layout shift.
 */
export function HeroName({
  name,
  as: Tag = "h1",
  max = "1.875rem",
  min = "0.8rem",
  wrapCap = "1.6rem",
  align = "left",
  className = "",
  testId,
}: {
  name: string;
  as?: ElementType;
  /** The largest size, when the whole name fits on a line. */
  max?: string;
  /** The smallest size before a long word may wrap inside itself. */
  min?: string;
  /** The largest size for a name that has to wrap between words. */
  wrapCap?: string;
  align?: "left" | "center";
  className?: string;
  testId?: string;
}) {
  const fit = nameFit(name);
  const style = { ["--name-total-em" as string]: fit.totalEm, ["--name-word-em" as string]: fit.wordEm, ["--name-max" as string]: max, ["--name-min" as string]: min, ["--name-cap" as string]: wrapCap } as CSSProperties;
  return (
    <div className="hero-name-box" data-align={align}>
      <Tag className={`hero-name font-display text-paper ${className}`} style={style} title={name} data-testid={testId}>
        {name}
      </Tag>
    </div>
  );
}
