"use client";

import { api } from "@/lib/api";
import { useRemote } from "@/lib/useRemote";

export interface OfficialToken {
  /** An official contract address is configured on the server. FALSE = $CLANKRPG has not launched yet. */
  launched: boolean;
  configured: boolean;
  symbol: string;
  /** The ONE official contract address (public). Always served by the server — a client never hard-codes one. */
  address: string | null;
  chainId: number | null;
  /** Optional block-explorer URL template with `{hash}`. */
  explorerTxUrl: string | null;
  /** The BUY $CLANKRPG link, computed by the server: https://clank.trade/ until an address is configured, then https://clank.trade/<address>. */
  buyUrl: string;
}

/** The official $CLANKRPG token as configured on the server (`GET /api/rewards/token`). */
export function useTokenConfig(): OfficialToken | null {
  const { data } = useRemote<{ token: OfficialToken }>(() => api<{ token: OfficialToken }>("/api/rewards/token"), "official-token");
  return data?.token ?? null;
}

export const explorerTxLink = (token: OfficialToken | null, hash: string | null): string | null => (token?.explorerTxUrl && hash ? token.explorerTxUrl.replace("{hash}", hash) : null);
