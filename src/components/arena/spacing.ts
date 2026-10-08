/**
 * PRESENTATION SPACING — how far apart two heroes are DRAWN, never where they are.
 *
 * The server keeps fighters at least a body-separation apart (≈ 30 units), and a melee fighter strikes from just inside its reach (≈ 32–34
 * units) — but a hero sprite is ≈ 40 units wide, so two fighters in contact overlapped by half a body on screen and a brawl read as one figure.
 * Moving them apart in the simulation would break melee reach (a Rogue's 38-unit stab), so the renderer instead nudges two OVERLAPPING sprites a
 * few units apart horizontally — eased, bounded, symmetric — while every position, distance and outcome stays the server's.
 *
 *   · only between living fighters standing almost side by side (|dy| below `ROW`) and closer than `CLEAR` horizontally;
 *   · each nudge is at most `MAX` units, eased over ≈ ¼ s (no jitter, no pops);
 *   · none before the bell (the 3 · 2 · 1 shows the exact spawn positions).
 */
export const CLEAR = 38;
export const ROW = 30;
export const MAX = 8;
const EASE_MS = 140;

export interface SpacedUnit {
  slot: number;
  x: number;
  y: number;
  alive: boolean;
  /** Current drawn offset (world units, x only) — updated in place. */
  ox: number;
}

/** The offset each fighter should be drawn at (before easing). Pure. */
export function targetOffsets(units: readonly SpacedUnit[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const u of units) out.set(u.slot, 0);
  for (let a = 0; a < units.length; a++) {
    const ua = units[a] as SpacedUnit;
    if (!ua.alive) continue;
    for (let b = a + 1; b < units.length; b++) {
      const ub = units[b] as SpacedUnit;
      if (!ub.alive) continue;
      const dx = ub.x - ua.x;
      if (Math.abs(ub.y - ua.y) >= ROW || Math.abs(dx) >= CLEAR) continue;
      // b on the right of a (ties broken by slot, deterministically): a moves left, b right
      const dir = dx > 0.5 ? 1 : dx < -0.5 ? -1 : ua.slot < ub.slot ? 1 : -1;
      const push = Math.min(MAX, (CLEAR - Math.abs(dx)) / 2);
      out.set(ua.slot, (out.get(ua.slot) ?? 0) - dir * push);
      out.set(ub.slot, (out.get(ub.slot) ?? 0) + dir * push);
    }
  }
  for (const [k, v] of out) out.set(k, Math.max(-MAX, Math.min(MAX, v)));
  return out;
}

/** Eases every fighter's drawn offset toward its target. `active` false (before the bell, a reset) snaps everyone to 0. */
export function updateOffsets(units: SpacedUnit[], dtMs: number, active: boolean): void {
  if (!active) {
    for (const u of units) u.ox = 0;
    return;
  }
  const target = targetOffsets(units);
  const k = 1 - Math.exp(-Math.max(0, dtMs) / EASE_MS);
  for (const u of units) u.ox += ((target.get(u.slot) ?? 0) - u.ox) * k;
}
