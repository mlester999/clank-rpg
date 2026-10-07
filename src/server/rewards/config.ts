import { checkRewardAddress } from "@/domain/rewards/address";
import { buyUrl } from "@/domain/rewards/buyLink";

import { getEnv, type ServerEnv } from "../env";

/**
 * The $CLANKRPG token configuration — ONE authoritative address and the existing chain, resolved from the environment and FAILING
 * CLOSED: a missing or mistyped value makes holder verification and claims unavailable with an explicit reason (visible to admins
 * only) — it never guesses a token or a chain, and it never stops anyone from playing, picking, earning or finishing a leaderboard.
 *
 * There is NO decimals setting. Reward accounting is LOGICAL (a fixed scale, domain/rewards/tokens.ts) and independent of the
 * contract; the contract's real `decimals()` and `symbol()` are read from the contract itself (server/rewards/chain.ts) the moment
 * it exists. Until `CLANKRPG_TOKEN_ADDRESS` is set the token has NOT LAUNCHED: everyone is on the FREE tier (0 % bonus), prizes keep
 * accruing as claimable, and claims open once the token exists. The chain is the EXISTING Robinhood Chain configuration
 * (ROBINHOOD_RPC_URL / ROBINHOOD_CHAIN_ID) — there is no second copy. There is no private key anywhere: this app only READS the chain.
 */
export type TokenConfig =
  | {
      configured: true;
      adapter: "rpc" | "simulated";
      /** Lower-case, validated (the form used to compare against chain logs and stored rows). */
      tokenAddress: string;
      /** The exact configured text, trimmed (the form used in the public BUY link). */
      publicAddress: string;
      chainId: number;
      rpcUrl: string | null;
      /** Optional, read-only (reserve monitoring). Never a signer. */
      treasuryAddress: string | null;
      /** Optional explorer URL template with `{hash}`. */
      explorerTxUrl: string | null;
    }
  | {
      configured: false;
      /** No address is set at all: the token has not launched. (A set-but-invalid address is `launched: true` with reasons — a misconfiguration, not "not launched".) */
      launched: boolean;
      reasons: string[];
    };

/** Clearly-fake placeholders for the SIMULATED adapter only (development/tests). They are NOT a real contract or wallet. */
export const SIMULATED_TOKEN_ADDRESS = "0x000000000000000000000000000000000c1a4c1a";
export const SIMULATED_TREASURY_ADDRESS = "0x00000000000000000000000000000000007ea5e1";
export const SIMULATED_CHAIN_ID = 4663_001;

export const NOT_LAUNCHED_REASON = "$CLANKRPG has not launched yet (CLANKRPG_TOKEN_ADDRESS is not set)";

const isLocalHost = (host: string): boolean => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

export function simulatedAdapterRequested(env: ServerEnv): boolean {
  return (env.CLANKRPG_CHAIN_ADAPTER ?? "").trim().toLowerCase() === "simulated";
}

export function resolveTokenConfig(env: ServerEnv = getEnv()): TokenConfig {
  const reasons: string[] = [];
  const adapterRaw = (env.CLANKRPG_CHAIN_ADAPTER ?? "").trim();
  const simulated = simulatedAdapterRequested(env);
  if (adapterRaw !== "" && !simulated) reasons.push('CLANKRPG_CHAIN_ADAPTER must be "simulated" or unset');
  if (simulated && env.isProduction) reasons.push("the simulated chain adapter is refused in production");

  const addressText = (env.CLANKRPG_TOKEN_ADDRESS ?? "").trim();
  const tokenCheck = addressText ? checkRewardAddress(addressText) : null;
  const treasuryCheck = env.CLANKRPG_REWARD_TREASURY_ADDRESS ? checkRewardAddress(env.CLANKRPG_REWARD_TREASURY_ADDRESS) : null;
  if (env.CLANKRPG_REWARD_TREASURY_ADDRESS && !treasuryCheck?.ok) reasons.push("CLANKRPG_REWARD_TREASURY_ADDRESS is not a valid address");
  const explorer = env.CLANKRPG_EXPLORER_TX_URL?.trim() || null;
  const explorerTxUrl = explorer && /^https:\/\/[^\s]+\{hash\}[^\s]*$/.test(explorer) ? explorer : null;

  if (simulated && reasons.length === 0) {
    return {
      configured: true,
      adapter: "simulated",
      tokenAddress: tokenCheck?.ok ? tokenCheck.address : SIMULATED_TOKEN_ADDRESS,
      publicAddress: tokenCheck?.ok ? addressText : SIMULATED_TOKEN_ADDRESS,
      chainId: env.ROBINHOOD_CHAIN_ID === 4663 ? SIMULATED_CHAIN_ID : env.ROBINHOOD_CHAIN_ID,
      rpcUrl: null,
      treasuryAddress: treasuryCheck?.ok ? treasuryCheck.address : SIMULATED_TREASURY_ADDRESS,
      explorerTxUrl,
    };
  }

  // No address at all = the token has not launched. That is a normal state, not an error.
  if (!addressText) return { configured: false, launched: false, reasons: [NOT_LAUNCHED_REASON, ...reasons] };
  if (!tokenCheck?.ok) reasons.push("CLANKRPG_TOKEN_ADDRESS is not a valid address");

  let rpcUrl: string | null = null;
  try {
    const u = new URL(env.ROBINHOOD_RPC_URL);
    if (u.protocol === "https:" || (u.protocol === "http:" && isLocalHost(u.hostname))) rpcUrl = u.toString();
    else reasons.push("ROBINHOOD_RPC_URL must be https (http only for localhost)");
  } catch {
    reasons.push("ROBINHOOD_RPC_URL is not a valid URL");
  }
  if (tokenCheck?.ok && treasuryCheck?.ok && tokenCheck.address === treasuryCheck.address) reasons.push("the treasury cannot be the token contract");

  if (reasons.length > 0 || !tokenCheck?.ok || !rpcUrl) {
    return { configured: false, launched: true, reasons: reasons.length ? reasons : ["the token is not configured"] };
  }
  return { configured: true, adapter: "rpc", tokenAddress: tokenCheck.address, publicAddress: addressText, chainId: env.ROBINHOOD_CHAIN_ID, rpcUrl, treasuryAddress: treasuryCheck?.ok ? treasuryCheck.address : null, explorerTxUrl };
}

/** The BUY $CLANKRPG link for the current configuration: the plain site until a well-formed official address is configured, then that exact address. */
export function buyLinkFor(env: ServerEnv = getEnv()): string {
  return buyUrl(env.CLANKRPG_TOKEN_ADDRESS);
}

/**
 * Names of retired environment variables that must NOT be set: the app never uses a signing key, and it no longer takes manual token
 * decimals (the contract is authoritative). Presence only — never a value.
 */
export const RETIRED_ENV: ReadonlyArray<{ name: string; why: string }> = [
  { name: "CLANKRPG_REWARD_TREASURY_PRIVATE_KEY", why: "this app NEVER uses a signing key (payouts are manual) — remove it" },
  { name: "CLANKRPG_TOKEN_DECIMALS", why: "token decimals are read from the contract itself and are no longer configurable — remove it" },
];

export function retiredEnvPresent(source: NodeJS.ProcessEnv = process.env): Array<{ name: string; why: string }> {
  return RETIRED_ENV.filter((r) => (source[r.name] ?? "").trim() !== "");
}
