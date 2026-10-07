import type { Queryable } from "../db/types";

import type { RewardChainReader, TokenMetadata } from "./chain";
import { getChainReader, getTokenStatus, type TokenStatus } from "./context";

/**
 * The official token's METADATA, taken from the contract — never configured. `verifiedTokenMetadata` asks the reader (which checks the
 * chain id, that bytecode exists at the address, `decimals()` and `symbol()`; the reader caches an hour) and PERSISTS what it found so
 * that other processes, the Admin console and the profile can show it without a chain call. If the contract cannot be verified the
 * answer is `null` and every token-dependent feature (holder verification, payout verification, claims) stays CLOSED; the Arena, the
 * leaderboards, finalization and reward accounting never wait on this module.
 */
export interface TokenMetadataView {
  tokenAddress: string;
  chainId: number;
  symbol: string;
  decimals: number;
  verifiedAt: number;
}

const g = globalThis as unknown as { __clankMetaPersisted?: { key: string; at: number } };
/** Re-write the persisted row at most this often when nothing changed (it only carries `verified_at`). */
const PERSIST_EVERY_MS = 10 * 60_000;

const missingTable = (e: unknown): boolean => /does not exist/i.test(e instanceof Error ? e.message : String(e));

/** Verified metadata (or `null`), persisted when a database is given. Never throws. */
export async function verifiedTokenMetadata(q: Queryable | null, reader: RewardChainReader | null, nowMs: number = Date.now()): Promise<TokenMetadata | null> {
  if (!reader) return null;
  let meta: TokenMetadata;
  try {
    meta = await reader.metadata();
  } catch {
    return null;
  }
  if (q) {
    const key = `${reader.chainId}:${reader.tokenAddress}:${meta.decimals}:${meta.symbol}`;
    const last = g.__clankMetaPersisted;
    if (!last || last.key !== key || nowMs - last.at >= PERSIST_EVERY_MS) {
      try {
        await q.query(
          `insert into public.arena_reward_token (id, token_address, chain_id, symbol, decimals, verified_at) values (1, $1, $2, $3, $4, $5::timestamptz)
           on conflict (id) do update set token_address = excluded.token_address, chain_id = excluded.chain_id, symbol = excluded.symbol, decimals = excluded.decimals,
             verified_at = excluded.verified_at, updated_at = now()`,
          [reader.tokenAddress, reader.chainId, meta.symbol, meta.decimals, new Date(nowMs).toISOString()],
        );
        g.__clankMetaPersisted = { key, at: nowMs };
      } catch (e) {
        if (!missingTable(e)) throw e; // before the migration there is simply nowhere to persist it
      }
    }
  }
  return meta;
}

/** The persisted metadata of the CONFIGURED token (null when none, or when it belongs to a different address/chain than the one configured now). */
export async function cachedTokenMetadata(q: Queryable, status: Pick<TokenStatus, "tokenAddress" | "chainId">): Promise<TokenMetadataView | null> {
  if (!status.tokenAddress || status.chainId === null) return null;
  try {
    const [r] = await q.query<{ token_address: string; chain_id: number; symbol: string; decimals: number; verified_at: Date }>("select token_address, chain_id, symbol, decimals, verified_at from public.arena_reward_token where id = 1");
    if (!r || r.token_address !== status.tokenAddress || Number(r.chain_id) !== status.chainId) return null;
    return { tokenAddress: r.token_address, chainId: Number(r.chain_id), symbol: r.symbol, decimals: Number(r.decimals), verifiedAt: new Date(r.verified_at).getTime() };
  } catch (e) {
    if (missingTable(e)) return null;
    throw e;
  }
}

/** Forget what was persisted this process remembers (tests). */
export const resetTokenMetadataMemo = (): void => {
  g.__clankMetaPersisted = undefined;
};

/**
 * What a request handler needs to know about the token in one call: the configured status, and the contract's verified metadata —
 * from the persisted cache first (no chain call), and only if nothing is cached from one (in-memory-cached) live verification.
 * `meta` is null when the token has not launched or its contract cannot be verified: holder features and claims are then closed.
 */
export async function currentTokenMetadata(q: Queryable): Promise<{ status: TokenStatus; meta: TokenMetadata | null }> {
  const status = getTokenStatus();
  if (!status.available) return { status, meta: null };
  const cached = await cachedTokenMetadata(q, status);
  if (cached) return { status, meta: { decimals: cached.decimals, symbol: cached.symbol } };
  return { status, meta: await verifiedTokenMetadata(q, await getChainReader()) };
}

/** The token as request handlers present it: `token` feeds the holder card / reward summary, `available` says holder verification and claims can run. */
export async function tokenView(q: Queryable): Promise<{ status: TokenStatus; meta: TokenMetadata | null; token: { launched: boolean; decimals: number | null }; available: boolean }> {
  const { status, meta } = await currentTokenMetadata(q);
  return { status, meta, token: { launched: status.launched, decimals: meta?.decimals ?? null }, available: status.available && meta !== null };
}
