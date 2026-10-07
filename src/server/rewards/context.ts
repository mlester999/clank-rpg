import { getEnv } from "../env";

import { resolveTokenConfig, retiredEnvPresent, SIMULATED_TREASURY_ADDRESS, type TokenConfig } from "./config";
import { createRpcChainReader, createSimulatedChainReader, type RewardChainReader, type TokenHealth } from "./chain";

/**
 * The process-wide READ-ONLY chain reader, built once from the token configuration. `null` = holder verification and manual
 * payout verification are unavailable (the token has not launched, or it is misconfigured): the app keeps working, everyone is simply
 * FREE and rewards keep accumulating. There is no signer anywhere in this file or this module tree.
 */
const h = globalThis as unknown as { __clankChainReader?: { key: string; reader: RewardChainReader | null }; __clankChainOverride?: RewardChainReader | null; __clankHealth?: { at: number; key: string; value: TokenHealth } };

/** Test seam: force a reader (or `null` = chain unavailable). `undefined` restores the environment-driven one. */
export function setChainReaderForTests(reader: RewardChainReader | null | undefined): void {
  h.__clankChainOverride = reader;
  h.__clankChainReader = undefined;
  h.__clankHealth = undefined;
}

export interface TokenStatus {
  /** An official contract address has been configured (the token has launched as far as this server knows). False = NOT LAUNCHED — a normal state, not an error. */
  launched: boolean;
  /** Holder verification and payout verification can run on this server (a reader exists; the contract itself is verified separately, see tokenMetadata.ts). */
  available: boolean;
  /** Why not — admins only; never a secret. */
  reasons: string[];
  adapter: "rpc" | "simulated" | null;
  /** The ONE official token (public), lower-case. */
  tokenAddress: string | null;
  /** The address exactly as configured (public) — what the BUY link and the admin copy button show. */
  publicAddress: string | null;
  chainId: number | null;
  treasuryAddress: string | null;
  explorerTxUrl: string | null;
}

const OFF = { adapter: null, tokenAddress: null, publicAddress: null, chainId: null, treasuryAddress: null, explorerTxUrl: null } as const;

export function getTokenStatus(config: TokenConfig = resolveTokenConfig(getEnv())): TokenStatus {
  const o = h.__clankChainOverride;
  if (o) return { launched: true, available: true, reasons: [], adapter: o.adapter, tokenAddress: o.tokenAddress, publicAddress: o.tokenAddress, chainId: o.chainId, treasuryAddress: null, explorerTxUrl: null };
  if (o === null) return { launched: true, available: false, reasons: ["the chain reader is switched off"], ...OFF };
  if (!config.configured) return { launched: config.launched, available: false, reasons: config.reasons, ...OFF };
  return { launched: true, available: true, reasons: [], adapter: config.adapter, tokenAddress: config.tokenAddress, publicAddress: config.publicAddress, chainId: config.chainId, treasuryAddress: config.treasuryAddress, explorerTxUrl: config.explorerTxUrl };
}

export async function getChainReader(): Promise<RewardChainReader | null> {
  if (h.__clankChainOverride !== undefined) return h.__clankChainOverride;
  const config = resolveTokenConfig(getEnv());
  const key = config.configured ? `${config.adapter}:${config.chainId}:${config.tokenAddress}:${config.rpcUrl ?? ""}` : "off";
  if (h.__clankChainReader?.key === key) return h.__clankChainReader.reader;
  let reader: RewardChainReader | null = null;
  if (config.configured) {
    reader = config.adapter === "simulated" ? createSimulatedChainReader({ tokenAddress: config.tokenAddress, chainId: config.chainId }) : createRpcChainReader({ tokenAddress: config.tokenAddress, chainId: config.chainId, rpcUrl: config.rpcUrl as string });
  }
  h.__clankChainReader = { key, reader };
  return reader;
}

/** Live token / RPC health for the Admin status panel, cached briefly (an admin can force a fresh check). */
export async function getTokenHealth(force = false, nowMs = Date.now()): Promise<TokenHealth | null> {
  const reader = await getChainReader();
  if (!reader) return null;
  const key = `${reader.adapter}:${reader.chainId}:${reader.tokenAddress}`;
  if (!force && h.__clankHealth && h.__clankHealth.key === key && nowMs - h.__clankHealth.at < 60_000) return h.__clankHealth.value;
  const value = await reader.checkHealth();
  h.__clankHealth = { at: nowMs, key, value };
  return value;
}

export { SIMULATED_TREASURY_ADDRESS, retiredEnvPresent };
