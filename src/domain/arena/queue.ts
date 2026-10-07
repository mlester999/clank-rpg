import type { Rng } from "../util/rng";

export interface CyclePlan {
  /** Final queue order: carried-in heroes first, then the securely shuffled remainder. */
  order: string[];
  /** Full groups (each exactly `groupSize`) in the order they will fight. */
  groups: string[][];
  /** Heroes that do not fill a final group; they open the NEXT cycle. */
  carryOut: string[];
  carriedIn: string[];
}

/**
 * Pure queue/cycle planner.
 *
 * Fairness contract (each asserted in tests):
 *  1. Every eligible hero appears in the queue exactly once per cycle — never twice, never zero.
 *  2. Groups are full (`groupSize`) and contain no duplicate fighters.
 *  3. A final partial group is NEVER padded with duplicates or borrowed heroes. Its members
 *     are CARRIED FORWARD and placed at the very front of the next cycle's queue, so they fight
 *     in that cycle's first battle (they cannot be carried twice in a row).
 *  4. Everyone else is shuffled with the supplied RNG (a CSPRNG-derived seed in production,
 *     persisted with the cycle so the order is auditable and survives restarts).
 */
export function planCycle(
  eligibleIds: readonly string[],
  carriedIn: readonly string[],
  groupSize: number,
  rng: Rng,
): CyclePlan {
  if (groupSize < 2) throw new RangeError("groupSize must be >= 2");
  const eligible = new Set(eligibleIds);
  if (eligible.size !== eligibleIds.length) throw new Error("eligible hero ids must be unique");
  // Only carry heroes that are still eligible; keep their original relative order.
  const carried = carriedIn.filter((id, i) => eligible.has(id) && carriedIn.indexOf(id) === i);
  const carriedSet = new Set(carried);
  const pool = eligibleIds.filter((id) => !carriedSet.has(id));
  const shuffled = rng.shuffle(pool);
  const order = [...carried, ...shuffled];

  const fullGroups = Math.floor(order.length / groupSize);
  const groups: string[][] = [];
  for (let g = 0; g < fullGroups; g++) groups.push(order.slice(g * groupSize, (g + 1) * groupSize));
  const carryOut = order.slice(fullGroups * groupSize);
  return { order, groups, carryOut, carriedIn: carried };
}
