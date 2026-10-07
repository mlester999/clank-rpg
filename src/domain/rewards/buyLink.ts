/**
 * The BUY $CLANKRPG call to action. ONE rule, ONE source of truth: the public site link is `https://clank.trade/`, and once the official
 * contract address (`CLANKRPG_TOKEN_ADDRESS`, a PUBLIC value) is configured on the server the very same button points at
 * `https://clank.trade/<address>`. The address is never hard-coded and there is no second variable that could disagree with it.
 */
export const CLANK_TRADE_URL = "https://clank.trade/";
export const BUY_LABEL = "BUY $CLANKRPG";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The exact configured address (trimmed) when it is a well-formed EVM address, otherwise the plain site link — a malformed value never reaches a URL. */
export function buyUrl(tokenAddress: string | null | undefined): string {
  const address = (tokenAddress ?? "").trim();
  return EVM_ADDRESS.test(address) ? `${CLANK_TRADE_URL}${address}` : CLANK_TRADE_URL;
}
