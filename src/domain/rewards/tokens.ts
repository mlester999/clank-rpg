/**
 * $CLANKRPG AMOUNTS. Every quantity here is an INTEGER (`bigint`) scaled by a `decimals` the CALLER names — no JavaScript number ever
 * holds a token amount. Two scales exist and must never be confused:
 *
 *  - LOGICAL accounting (`LOGICAL_DECIMALS`, 6): everything the game owes or has earned — prize pools, prizes, holder bonuses, ledger
 *    deltas, account balances, claims. It is a property of the GAME, not of any contract: "30,000 $CLANKRPG" is 30,000,000,000
 *    logical units whether or not the token exists yet and whatever its decimals turn out to be. Nothing is ever finalized in a
 *    guessed ERC-20 scale.
 *  - CHAIN amounts (the token's own `decimals()`): balances and transfer values read from the contract. The contract is the only
 *    authority for that scale; `logicalToRaw` is the single, exact bridge, used only when a payout is verified.
 *
 * Settings and the browser carry DECIMAL STRINGS of whole tokens ("10000", "0.5"); this module is the only place they become units.
 */

/** The fixed scale of reward accounting: 1 logical unit = 1/1,000,000 of a whole $CLANKRPG (a "micro-token"). */
export const LOGICAL_DECIMALS = 6;

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;

/** "10000" or "0.5" → integer units at `decimals`. Refuses anything that is not an exact amount at this precision (never rounds). */
export function parseTokenAmount(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  if (typeof value !== "string" || !DECIMAL.test(value)) throw new RangeError(`not a token amount: ${JSON.stringify(value)}`);
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) throw new RangeError(`${value} has more than ${decimals} decimal places`);
  return BigInt(whole as string) * 10n ** BigInt(decimals) + (fraction === "" ? 0n : BigInt(fraction.padEnd(decimals, "0")));
}

/** Integer units at `decimals` → a plain decimal string ("42500", "0.5"). Exact, no grouping. */
export function formatTokenPlain(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  if (raw < 0n) throw new RangeError("a token amount cannot be negative");
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Integer units at `decimals` → a display string ("42,500", "0.5"): thousands grouping, fraction trimmed to `maxFraction` digits (truncated, never rounded up). */
export function formatTokenAmount(raw: bigint, decimals: number, maxFraction = 4): string {
  const plain = formatTokenPlain(raw, decimals);
  const [whole = "0", fraction = ""] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = fraction.slice(0, Math.max(0, maxFraction)).replace(/0+$/, "");
  return frac ? `${grouped}.${frac}` : grouped;
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new RangeError("token decimals must be an integer from 0 to 36");
}

/** The most a uint256 can hold — the on-chain amount can never exceed it. */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * THE bridge from the game's logical amount to the token's on-chain raw amount, at the contract's own `decimals()`.
 * `payable` is the part of `units` the token can represent at all and `dust` the remainder (non-zero only for a token with FEWER than
 * 6 decimals, e.g. 2 decimals cannot express 1 micro-token); `raw = payable ÷ 10^(6 − decimals)`. For the usual 6+ decimals the
 * conversion is exact, `dust` is 0 and `raw = units × 10^(decimals − 6)`.
 */
export function logicalToRaw(units: bigint, contractDecimals: number): { raw: bigint; payable: bigint; dust: bigint } {
  assertDecimals(contractDecimals);
  if (units < 0n) throw new RangeError("a token amount cannot be negative");
  if (contractDecimals >= LOGICAL_DECIMALS) return { raw: units * 10n ** BigInt(contractDecimals - LOGICAL_DECIMALS), payable: units, dust: 0n };
  const step = 10n ** BigInt(LOGICAL_DECIMALS - contractDecimals);
  const dust = units % step;
  return { raw: (units - dust) / step, payable: units - dust, dust };
}
