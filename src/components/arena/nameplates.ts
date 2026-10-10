import { graphemeLength, truncateDisplayName } from "@/domain/character/displayName";

/**
 * NAME PLATE LAYOUT — where each hero's name hangs on the stage. Pure geometry: no canvas, no clock of its own, no game state. It reads where
 * a hero is DRAWN (screen space, in stage layout units) and decides where its plate goes; nothing here moves a hero or changes a position the
 * server computed.
 *
 * What it guarantees (and tests/unit/arena-nameplates.test.ts pins):
 *   · every living hero keeps a name on screen for the whole fight — a plate squeezes through four modes (full → compact → tag → bar) only when
 *     it truly cannot fit, and "bar" (no name) is the last resort for a hero buried in a pile of others;
 *   · a plate sits above its own hero's head; in a crowd it steps SIDEWAYS (at most about one plate width) or UP (at most two rows) just far
 *     enough to clear the plates already placed — never further, never onto another plate;
 *   · every plate stays inside the stage and out of the measured "reserved" boxes (the Survivors plate, the sound button …);
 *   · decisions are sticky: a plate keeps the side it chose until that stops fitting, returns home only after the way has been clear for a
 *     moment, and drawn positions are eased — heroes brushing past each other never make a name flicker or jump.
 */

export type PlateMode = "full" | "compact" | "tag" | "bar";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

export type PlateSizes = Record<PlateMode, Size>;

/** Richest first: how much a mode shows (full: name + class + HP · compact: name + HP · tag: bare outlined name + HP line · bar: HP only). */
export const MODE_RANK: Record<PlateMode, number> = { full: 0, compact: 1, tag: 2, bar: 3 };
const MODES: readonly PlateMode[] = ["full", "compact", "tag"];

export interface PlateInput {
  slot: number;
  /** x of the hero's centre. */
  ax: number;
  /** y of the plate's natural bottom edge (just above the top of the hero's head). */
  ay: number;
  sizes: PlateSizes;
  /** The richest mode this moment asks for. */
  want: "full" | "compact";
  /** Placed in ascending order: the lowest keeps its natural place, the rest step aside for it. */
  priority: number;
}

export interface PlateEnv {
  /** The visible stage (already inset by a small margin): no plate leaves it. */
  bounds: Rect;
  /** Boxes plates must stay out of (the Survivors plate, the sound button …), in the same units. */
  reserved: readonly Rect[];
  /** Boxes plates stay out of when they can — a transient caption such as the kill feed. A plate that would otherwise be reduced to its HP bar takes the spot anyway: a name outranks a caption. */
  soft?: readonly Rect[];
  /** Air kept between two plates. */
  gap: number;
  /** Before the bell / after a reset: decide at once, with no hysteresis and no easing. */
  immediate?: boolean;
  /** Time since the previous frame (ms): how far a plate's step aside eases this frame. */
  dtMs?: number;
}

/** What the layout remembers per hero between frames (hysteresis). */
export interface PlateState {
  mode: PlateMode;
  /** Which displacement is in use: "home" (straight above the head), or pushes "L" "R" "U" and their combinations. */
  key: string;
  /** When the natural spot became free (ms), or -1 while it is not. */
  homeSince: number;
  /** When a richer mode became possible (ms), or -1. */
  upSince: number;
  /** Drawn (eased) displacement from the plate's natural spot, in layout units: a plate is glued to its hero; only a step aside is eased. */
  dx: number;
  dy: number;
  seeded: boolean;
  /** The step aside (relative to the natural spot) chosen last frame — held for a moment when the natural spot frees up. */
  tdx: number;
  tdy: number;
  /** When the plate last had to LAND on a new spot at once (it could not glide there past a neighbour): it fades in there instead of hopping. */
  landedAt: number;
}

export interface Placement {
  slot: number;
  mode: PlateMode;
  key: string;
  /** Where the plate is DRAWN this frame: glued to its hero, its step aside eased — and never across another drawn plate. */
  rect: Rect;
  /** Where the plate belongs (its eased step aside has not necessarily arrived yet). */
  target: Rect;
  /** True when the plate is not straight above its hero's head. */
  displaced: boolean;
  /** 0.35 → 1 over ~0.16 s after the plate had to land on a new spot at once (so a name never hops: it appears at the new place). */
  alpha: number;
}

export const newPlateState = (): PlateState => ({ mode: "full", key: "home", homeSince: -1, upSince: -1, dx: 0, dy: 0, tdx: 0, tdy: 0, seeded: false, landedAt: -1e9 });

/** How long the natural spot must stay free before a pushed-aside plate goes home, and a richer mode before it is taken back (ms). */
const HOME_DELAY_MS = 300;
const UPGRADE_DELAY_MS = 280;
/** A plate that had to land on a new spot at once fades in over this long. */
const LAND_FADE_MS = 160;
/** A plate may be pushed at most this far sideways (in plate widths) and this many rows up. */
const MAX_SHIFT = 1.2;
const MAX_ROWS = 2.2;

const overlaps = (a: Rect, b: Rect, gap: number): boolean => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
const inside = (r: Rect, b: Rect): boolean => r.x >= b.x - 0.01 && r.y >= b.y - 0.01 && r.x + r.w <= b.x + b.w + 0.01 && r.y + r.h <= b.y + b.h + 0.01;
const clamp = (v: number, lo: number, hi: number): number => (hi < lo ? lo : Math.min(hi, Math.max(lo, v)));

/** The natural spot of a plate of this size: centred over its hero, just above the head, kept inside the stage. */
function homeOf(item: PlateInput, size: Size, b: Rect): Rect {
  return { x: clamp(item.ax - size.w / 2, b.x, b.x + b.w - size.w), y: clamp(item.ay - size.h, b.y, b.y + b.h - size.h), w: size.w, h: size.h };
}

interface Candidate {
  key: string;
  rect: Rect;
  cost: number;
}

/** Every position this plate could take in `mode` that is free of `placed` and inside the stage, cheapest first. Stops early when home is free. */
function candidatesFor(item: PlateInput, mode: PlateMode, size: Size, placed: readonly Rect[], env: PlateEnv): Candidate[] {
  const { bounds: b, gap } = env;
  const home = homeOf(item, size, b);
  const maxDx = size.w * MAX_SHIFT;
  const maxDy = (size.h + gap) * MAX_ROWS;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const first = (r: Rect) => placed.find((q) => overlaps(r, q, gap));
  const queue: Array<{ key: string; rect: Rect; depth: number }> = [{ key: "home", rect: home, depth: 0 }];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i] as { key: string; rect: Rect; depth: number };
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const dx = c.rect.x - home.x;
    const dy = c.rect.y - home.y;
    if (Math.abs(dx) > maxDx + 0.01 || -dy > maxDy + 0.01 || dy > 0.01 || !inside(c.rect, b)) continue;
    const q = first(c.rect);
    if (!q) {
      out.push({ key: c.key, rect: c.rect, cost: Math.abs(dx) + Math.abs(dy) * 1.35 + c.depth * 2 });
      if (c.key === "home") return out; // the natural spot is free: nothing else is ever cheaper
      continue;
    }
    if (c.depth >= 2) continue;
    // push out of the plate in the way: to its right, to its left, or above it — exactly far enough
    queue.push({ key: c.key === "home" ? "R" : `${c.key}R`, rect: { ...c.rect, x: q.x + q.w + gap }, depth: c.depth + 1 });
    queue.push({ key: c.key === "home" ? "L" : `${c.key}L`, rect: { ...c.rect, x: q.x - gap - c.rect.w }, depth: c.depth + 1 });
    queue.push({ key: c.key === "home" ? "U" : `${c.key}U`, rect: { ...c.rect, y: q.y - gap - c.rect.h }, depth: c.depth + 1 });
  }
  return out.sort((a, b2) => a.cost - b2.cost);
}

/** Is `rect` (a step aside from `home`) inside the stage, within the allowed step, and clear of every plate and box in `placed`? */
function isFree(rect: Rect, home: Rect, placed: readonly Rect[], env: PlateEnv): boolean {
  const dx = rect.x - home.x;
  const dy = rect.y - home.y;
  if (Math.abs(dx) > rect.w * MAX_SHIFT + 0.01 || -dy > (rect.h + env.gap) * MAX_ROWS + 0.01 || dy > 0.01) return false;
  return inside(rect, env.bounds) && !placed.some((q) => overlaps(rect, q, env.gap));
}

interface Choice {
  c: Candidate;
  /** The natural spot is free in this mode (even when a sticky plate stays where it is). */
  homeFree: boolean;
}

function choose(item: PlateInput, mode: PlateMode, st: PlateState, placed: readonly Rect[], env: PlateEnv, now: number): Choice | null {
  const size = item.sizes[mode];
  const list = candidatesFor(item, mode, size, placed, env);
  if (list.length === 0) return null;
  const best = list[0] as Candidate;
  const homeFree = list.some((c) => c.key === "home");
  if (env.immediate || st.mode !== mode) return { c: best, homeFree };
  if (best.key === "home" && st.key !== "home" && (st.homeSince < 0 || now - st.homeSince < HOME_DELAY_MS)) {
    // the natural spot has only just come free: stay where the plate stepped to, if that is still clear, until the way has stayed clear for a moment
    // (two heroes brushing past each other must not make a name flick between its two places)
    const home = homeOf(item, size, env.bounds);
    const rect: Rect = { x: home.x + st.tdx, y: home.y + st.tdy, w: size.w, h: size.h };
    if (isFree(rect, home, placed, env)) return { c: { key: st.key, rect, cost: Math.abs(st.tdx) + Math.abs(st.tdy) * 1.35 }, homeFree: true };
  }
  const prev = list.find((c) => c.key === st.key);
  if (!prev || prev === best) return { c: best, homeFree };
  // sticky: keep the side already chosen unless the natural spot has been clear long enough, or the old side is clearly worse
  const calmHome = best.key === "home" && st.homeSince >= 0 && now - st.homeSince >= HOME_DELAY_MS;
  return { c: !calmHome && prev.cost <= best.cost + size.h * 0.6 ? prev : best, homeFree };
}

/**
 * Decides every plate's mode and position for this frame. `states` carries each hero's memory from frame to frame and is updated in place.
 * Items are placed front to back (ascending priority); each later plate steps around the earlier ones.
 */
export function layoutPlates(items: readonly PlateInput[], env: PlateEnv, states: Map<number, PlateState>, now: number): Placement[] {
  const soft = env.soft ?? [];
  const placed: Rect[] = [...env.reserved, ...soft];
  /** Everything a plate must stay clear of when it may overlap the soft boxes: the hard boxes and the plates drawn so far (they are `placed`, minus the soft ones). */
  const withoutSoft = (): Rect[] => (soft.length === 0 ? placed : placed.filter((q) => !soft.includes(q)));
  const out: Placement[] = [];
  const ordered = [...items].sort((a, b) => a.priority - b.priority || a.slot - b.slot);
  for (const item of ordered) {
    let st = states.get(item.slot);
    if (!st) {
      st = newPlateState();
      st.mode = item.want;
      states.set(item.slot, st);
    }
    const order = MODES.filter((m) => MODE_RANK[m] >= MODE_RANK[item.want]);
    let blockers: readonly Rect[] = placed;
    let pick: { mode: PlateMode; ch: Choice } | null = null;
    for (const mode of order) {
      const ch = choose(item, mode, st, blockers, env, now);
      if (ch) {
        pick = { mode, ch };
        break;
      }
    }
    if (!pick && soft.length > 0) {
      // no room anywhere without touching a caption: the name goes over the caption instead of being dropped to an HP bar
      blockers = withoutSoft();
      for (const mode of order) {
        const ch = choose(item, mode, st, blockers, env, now);
        if (ch) {
          pick = { mode, ch };
          break;
        }
      }
    }
    if (pick && !env.immediate && MODE_RANK[pick.mode] < MODE_RANK[st.mode]) {
      // a RICHER mode is possible again: take it back only once it has stayed possible for a moment (no flicker between modes)
      if (st.upSince < 0) st.upSince = now;
      if (now - st.upSince < UPGRADE_DELAY_MS) {
        const keep = st.mode === "bar" ? null : choose(item, st.mode, st, blockers, env, now);
        pick = keep ? { mode: st.mode, ch: keep } : null;
      }
    } else {
      st.upSince = -1;
    }
    let rect: Rect;
    let key: string;
    let mode: PlateMode;
    if (pick) {
      mode = pick.mode;
      rect = pick.ch.c.rect;
      key = pick.ch.c.key;
      if (pick.ch.homeFree) {
        if (st.homeSince < 0) st.homeSince = now;
      } else st.homeSince = -1;
    } else {
      // buried in a pile: its HP bar alone, at its natural place (a bar is tiny and may overlap without hiding anything)
      mode = "bar";
      key = "home";
      rect = homeOf(item, item.sizes.bar, env.bounds);
      st.homeSince = -1;
    }
    st.mode = mode;
    st.key = key;
    {
      const h0 = homeOf(item, item.sizes[mode], env.bounds);
      st.tdx = rect.x - h0.x;
      st.tdy = rect.y - h0.y;
    }
    const target = rect;
    // The DRAWN rect: glued to the natural spot over the hero (so a running hero takes its name with it, with no lag), plus the step aside, eased.
    // A plate never glides across a neighbour: if the eased position would touch one that is already drawn, it lands on its target at once
    // (the target was chosen clear of every plate drawn before it).
    const home = homeOf(item, item.sizes[mode], env.bounds);
    const tx = target.x - home.x;
    const ty = target.y - home.y;
    if (!st.seeded || env.immediate || mode === "bar") {
      st.dx = tx;
      st.dy = ty;
      st.seeded = true;
    } else {
      const k = 1 - Math.exp(-Math.max(0, env.dtMs ?? 16) / 100);
      st.dx += (tx - st.dx) * k;
      st.dy += (ty - st.dy) * k;
    }
    let drawn: Rect = { x: home.x + st.dx, y: home.y + st.dy, w: target.w, h: target.h };
    if (mode !== "bar" && blockers.some((q) => overlaps(drawn, q, 0))) {
      if (Math.hypot(tx - st.dx, ty - st.dy) > target.h * 0.5) st.landedAt = now;
      st.dx = tx;
      st.dy = ty;
      drawn = { ...target };
    }
    drawn.x = clamp(drawn.x, env.bounds.x, env.bounds.x + env.bounds.w - drawn.w);
    drawn.y = clamp(drawn.y, env.bounds.y, env.bounds.y + env.bounds.h - drawn.h);
    if (mode !== "bar") placed.push(drawn);
    const alpha = 0.35 + 0.65 * clamp((now - st.landedAt) / LAND_FADE_MS, 0, 1);
    out.push({ slot: item.slot, mode, key, rect: drawn, target, alpha, displaced: key !== "home" || Math.abs(drawn.x + drawn.w / 2 - item.ax) > drawn.w * 0.34 });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- sizing

export interface PlateMetrics {
  /** CSS pixels per layout unit (the stage's scale). */
  cpl: number;
  /** Name font size in layout units. */
  nameFs: number;
  /** Class line font size in layout units (full mode). */
  subFs: number;
  /** The longest name drawn, in user-perceived characters. */
  maxChars: number;
  /** The widest a name may be drawn, in layout units. */
  maxNameW: number;
  /** Convert css px → layout units. */
  u: (cssPx: number) => number;
}

/**
 * Plate dimensions for a stage `cssW` pixels wide whose layout is `layoutW` units wide. The name is never smaller than 10.5 css px — even on a
 * 320 px phone — so a plate stays legible; what gives way on a small stage is the NUMBER OF CHARACTERS (names are shortened, never shrunk).
 */
export function plateMetrics(cssW: number, layoutW: number): PlateMetrics {
  const cpl = Math.max(0.05, cssW / layoutW);
  const nameCss = clamp(cssW * 0.0115, 10.5, 13);
  const u = (px: number) => px / cpl;
  return {
    cpl,
    nameFs: u(nameCss),
    subFs: u(nameCss * 0.74),
    maxChars: cssW < 400 ? 10 : cssW < 560 ? 12 : 16,
    maxNameW: u(cssW < 560 ? Math.min(cssW * 0.3, 118) : Math.min(cssW * 0.22, 190)),
    u,
  };
}

/** Shortens a name to what a plate may show: at most `maxChars` characters AND at most `maxWidth` wide when drawn (measured by `measure`). */
export function fitPlateName(name: string, maxChars: number, maxWidth: number, measure: (text: string) => number): string {
  let limit = Math.min(maxChars, Math.max(3, graphemeLength(name)));
  let text = truncateDisplayName(name, limit);
  while (limit > 3 && measure(text) > maxWidth) {
    limit -= 1;
    text = truncateDisplayName(name, limit);
  }
  return text;
}

/**
 * The four plate sizes of one hero (layout units) from its drawn name and class label widths. compact: name + HP bar. full: + the class line.
 * tag: the bare name (outlined, no box) over a thin HP line. bar: the HP bar alone.
 */
export function plateSizes(m: PlateMetrics, nameW: number, classW: number): PlateSizes {
  const { u } = m;
  const padX = u(5);
  const markW = u(7);
  const compactW = Math.max(u(44), nameW + 2 * padX + markW);
  const compactH = m.nameFs * 1.1 + u(11);
  return {
    compact: { w: compactW, h: compactH },
    full: { w: Math.max(u(60), compactW, classW + 2 * padX + markW), h: compactH + m.subFs * 1.15 },
    tag: { w: nameW + u(4), h: m.nameFs * 1.05 + u(4) },
    bar: { w: u(34), h: u(5) },
  };
}
