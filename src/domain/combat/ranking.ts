/**
 * THE central, authoritative ordering for a finished battle. Used by the engine to assign
 * placements and by tests that pin the tie-break rules. Ties are NEVER resolved randomly after
 * the fact: the final fallback is the fighter's starting slot, which was fixed by the battle
 * seed BEFORE the fight began.
 *
 * Order (first rule that differs decides; "better" listed first):
 *   1. Alive beats eliminated.
 *   2. Both alive → higher remaining HP percentage (exact integer cross-multiplication).
 *      Both eliminated → survived longer (later elimination tick).
 *   3. More eliminations.
 *   4. More damage dealt.
 *   5. Less damage taken.
 *   6. Lower starting slot (seed-assigned before combat).
 */
export interface Standing {
  slot: number;
  alive: boolean;
  hp: number;
  maxHp: number;
  eliminatedAtTick: number | null;
  eliminations: number;
  damageDealt: number;
  damageTaken: number;
}

export function compareStanding(a: Standing, b: Standing): number {
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  if (a.alive) {
    const left = a.hp * b.maxHp;
    const right = b.hp * a.maxHp;
    if (left !== right) return left > right ? -1 : 1;
  } else {
    const ta = a.eliminatedAtTick ?? 0;
    const tb = b.eliminatedAtTick ?? 0;
    if (ta !== tb) return ta > tb ? -1 : 1;
  }
  if (a.eliminations !== b.eliminations) return a.eliminations > b.eliminations ? -1 : 1;
  if (a.damageDealt !== b.damageDealt) return a.damageDealt > b.damageDealt ? -1 : 1;
  if (a.damageTaken !== b.damageTaken) return a.damageTaken < b.damageTaken ? -1 : 1;
  return a.slot - b.slot;
}

/** Slots ordered best → worst. */
export function rankStandings(standings: readonly Standing[]): number[] {
  return standings
    .slice()
    .sort(compareStanding)
    .map((s) => s.slot);
}
