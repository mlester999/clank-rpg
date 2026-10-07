import type { Queryable } from "../db/types";

import type { ClaimTarget } from "./claims";
import { getChainReader, getTokenStatus } from "./context";
import { verifiedTokenMetadata } from "./tokenMetadata";

/**
 * What the claim endpoint needs from the token: no secret, only public facts. Claims are possible ONLY once the official token exists
 * and its contract has been verified (chain, bytecode, `decimals()`, `symbol()`); before that `enabled` is false and `reason` says why
 * (NOT_LAUNCHED = no address configured yet; UNVERIFIED = configured but the contract cannot be verified right now).
 */
export async function getClaimTarget(q: Queryable | null = null): Promise<ClaimTarget> {
  const status = getTokenStatus();
  const reader = status.available ? await getChainReader() : null;
  const meta = reader ? await verifiedTokenMetadata(q, reader) : null;
  const enabled = Boolean(reader && meta && status.tokenAddress !== null && status.chainId !== null);
  return {
    enabled,
    reason: enabled ? null : status.launched ? "UNVERIFIED" : "NOT_LAUNCHED",
    tokenAddress: status.tokenAddress,
    chainId: status.chainId,
    tokenDecimals: meta?.decimals ?? null,
    forbiddenRecipients: [status.tokenAddress, status.treasuryAddress].filter((a): a is string => Boolean(a)),
  };
}

/** Addresses a payout (or a holder wallet) must never be: the token contract and the treasury itself. Configuration only — no chain call. */
export function forbiddenRecipients(): string[] {
  const status = getTokenStatus();
  return [status.tokenAddress, status.treasuryAddress].filter((a): a is string => Boolean(a));
}
