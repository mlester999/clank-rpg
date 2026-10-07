import { getAddress, isAddress } from "viem";

/**
 * A reward wallet is where earned tokens are SENT. A pasted address needs no signature (and never grants a holder tier — only a
 * wallet that signed the server's challenge does). It is validated on the server, normalised to lower-case, and refused when it is obviously a black hole.
 */
export type AddressCheck = { ok: true; address: string } | { ok: false; reason: "MALFORMED" | "ZERO_ADDRESS" | "BURN_ADDRESS" | "RESERVED_ADDRESS" };

const BURN_ADDRESSES = new Set([
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000000000000000000000000",
  "0xffffffffffffffffffffffffffffffffffffffff",
]);

export function checkRewardAddress(input: unknown): AddressCheck {
  if (typeof input !== "string") return { ok: false, reason: "MALFORMED" };
  const trimmed = input.trim();
  // `strict` validates the EIP-55 checksum of a mixed-case address (a typo in one is caught); all-lower / all-upper pass as plain hex.
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed) || !isAddress(trimmed, { strict: true })) return { ok: false, reason: "MALFORMED" };
  const lower = getAddress(trimmed.toLowerCase()).toLowerCase();
  if (/^0x0{40}$/.test(lower)) return { ok: false, reason: "ZERO_ADDRESS" };
  if (BURN_ADDRESSES.has(lower)) return { ok: false, reason: "BURN_ADDRESS" };
  // 0x00…00 – 0x00…ffff: precompiles / system addresses, never a person's wallet.
  if (/^0x0{36}[0-9a-f]{4}$/.test(lower)) return { ok: false, reason: "RESERVED_ADDRESS" };
  return { ok: true, address: lower };
}
