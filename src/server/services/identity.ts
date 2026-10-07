import { verifyTelegramLogin, type LoginVerification } from "../auth/telegramLogin";
import { buildWalletMessage, normalizeAddress, verifyWalletSignature } from "../auth/wallet";
import { secureToken } from "../crypto";
import { json, type Db, type Queryable } from "../db/types";

export type LoginResult =
  | { ok: true; telegramUserId: number; epoch: number; characterId: string | null; claimed: boolean; qualifying: number; threshold: number }
  | { ok: false; reason: Exclude<LoginVerification, { ok: true }>["reason"] | "REPLAYED" | "BANNED" | "DISABLED" };

/**
 * Telegram Login → proves control of an immutable Telegram user id. The payload hash is
 * single-use, so a captured login payload cannot be replayed. Logging in does NOT claim a
 * hero; it only establishes who you are.
 */
export async function loginWithTelegram(
  db: Db,
  payload: unknown,
  opts: { botToken: string; threshold: number; nowMs?: number; maxAgeSeconds?: number },
): Promise<LoginResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const v = verifyTelegramLogin(payload, opts.botToken, nowMs, opts.maxAgeSeconds);
  if (!v.ok) return { ok: false, reason: v.reason };
  return db.transaction(async (tx) => {
    const proof = await tx.query(
      "insert into public.telegram_login_proofs (hash, telegram_user_id, auth_date) values ($1, $2, to_timestamp($3)) on conflict do nothing returning hash",
      [v.user.hash, v.user.id, v.user.authDate],
    );
    if (proof.length === 0) return { ok: false, reason: "REPLAYED" } as LoginResult;
    const [user] = await tx.query<{ status: string; session_epoch: number; qualifying_message_count: number }>(
      `insert into public.telegram_users (telegram_user_id, username, display_name, last_seen_at)
       values ($1, $2, $3, now())
       on conflict (telegram_user_id) do update set username = coalesce(excluded.username, public.telegram_users.username),
         display_name = case when excluded.display_name <> '' then excluded.display_name else public.telegram_users.display_name end,
         last_seen_at = now()
       returning status, session_epoch, qualifying_message_count`,
      [v.user.id, v.user.username, v.user.displayName],
    );
    if (!user || user.status === "BANNED") return { ok: false, reason: "BANNED" } as LoginResult;
    const [hero] = await tx.query<{ id: string; claimed: boolean }>(
      `select c.id, (cl.character_id is not null) as claimed from public.characters c
         left join public.character_claims cl on cl.character_id = c.id where c.telegram_user_id = $1`,
      [v.user.id],
    );
    return {
      ok: true,
      telegramUserId: v.user.id,
      epoch: user.session_epoch,
      characterId: hero?.id ?? null,
      claimed: hero?.claimed ?? false,
      qualifying: user.qualifying_message_count,
      threshold: opts.threshold,
    } as LoginResult;
  });
}

export type ClaimResult =
  | { ok: true; characterId: string; alreadyClaimed: boolean }
  | { ok: false; reason: "NO_HERO" | "NOT_COMMUNITY_HERO" | "CLAIMED_BY_OTHER" | "SUSPENDED" };

/**
 * Claim = bind the hero to the SAME immutable Telegram id that authenticated this session.
 * The character is looked up BY that id, so a username (or any other claim) is never trusted.
 */
export async function claimCharacter(db: Db, telegramUserId: number, authDate: Date): Promise<ClaimResult> {
  return db.transaction(async (tx) => {
    const [hero] = await tx.query<{ id: string; kind: string; status: string }>(
      "select id, kind, status from public.characters where telegram_user_id = $1 for update",
      [telegramUserId],
    );
    if (!hero) return { ok: false, reason: "NO_HERO" } as ClaimResult;
    if (hero.kind !== "COMMUNITY") return { ok: false, reason: "NOT_COMMUNITY_HERO" } as ClaimResult;
    if (hero.status === "SUSPENDED") return { ok: false, reason: "SUSPENDED" } as ClaimResult;
    const existing = await tx.query<{ telegram_user_id: number }>("select telegram_user_id from public.character_claims where character_id = $1", [hero.id]);
    if (existing[0]) {
      return existing[0].telegram_user_id === telegramUserId
        ? ({ ok: true, characterId: hero.id, alreadyClaimed: true } as ClaimResult)
        : ({ ok: false, reason: "CLAIMED_BY_OTHER" } as ClaimResult);
    }
    await tx.query("insert into public.character_claims (character_id, telegram_user_id, auth_date) values ($1, $2, $3::timestamptz)", [hero.id, telegramUserId, authDate.toISOString()]);
    return { ok: true, characterId: hero.id, alreadyClaimed: false } as ClaimResult;
  });
}

/** Revoke every session for a Telegram id (logout everywhere / admin action). */
export async function bumpSessionEpoch(q: Queryable, telegramUserId: number): Promise<number> {
  const rows = await q.query<{ session_epoch: number }>(
    "update public.telegram_users set session_epoch = session_epoch + 1 where telegram_user_id = $1 returning session_epoch",
    [telegramUserId],
  );
  return rows[0]?.session_epoch ?? 0;
}

// ---------------------------------------------------------------------------------------
// Wallet linking
// ---------------------------------------------------------------------------------------

export type ChallengeResult = { ok: true; nonce: string; message: string; expiresAt: Date } | { ok: false; reason: "NOT_CLAIMED" | "BAD_ADDRESS" | "ADDRESS_IN_USE" };
export type WalletLinkResult =
  | { ok: true; address: string; replaced: string | null }
  | { ok: false; reason: "NOT_CLAIMED" | "NO_CHALLENGE" | "EXPIRED" | "BAD_SIGNATURE" | "ADDRESS_IN_USE" | "ALREADY_USED" };

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export async function createWalletChallenge(
  db: Db,
  characterId: string,
  addressInput: string,
  chainId: number,
  now = new Date(),
): Promise<ChallengeResult> {
  const address = normalizeAddress(addressInput);
  if (!address) return { ok: false, reason: "BAD_ADDRESS" };
  return db.transaction(async (tx) => {
    const [row] = await tx.query<{ name: string; claimed: boolean }>(
      `select coalesce(c.name_override, c.name) as name, (cl.character_id is not null) as claimed
         from public.characters c left join public.character_claims cl on cl.character_id = c.id where c.id = $1`,
      [characterId],
    );
    if (!row?.claimed) return { ok: false, reason: "NOT_CLAIMED" } as ChallengeResult;
    const taken = await tx.query("select 1 from public.wallet_links where address = $1 and unlinked_at is null and character_id <> $2", [address, characterId]);
    if (taken.length) return { ok: false, reason: "ADDRESS_IN_USE" } as ChallengeResult;
    const nonce = secureToken(18);
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    const message = buildWalletMessage({ heroName: row.name, address, chainId, nonce, issuedAt: now, expiresAt });
    await tx.query(
      "insert into public.wallet_challenges (nonce, character_id, address, chain_id, message, expires_at) values ($1, $2, $3, $4, $5, $6::timestamptz)",
      [nonce, characterId, address, chainId, message, expiresAt.toISOString()],
    );
    return { ok: true, nonce, message, expiresAt } as ChallengeResult;
  });
}

export async function verifyWalletLink(db: Db, characterId: string, nonce: string, signature: string, now = new Date()): Promise<WalletLinkResult> {
  const [challenge] = await db.query<{ address: string; chain_id: number; message: string; expires_at: Date; consumed_at: Date | null }>(
    "select address, chain_id, message, expires_at, consumed_at from public.wallet_challenges where nonce = $1 and character_id = $2",
    [nonce, characterId],
  );
  if (!challenge) return { ok: false, reason: "NO_CHALLENGE" };
  if (challenge.consumed_at) return { ok: false, reason: "ALREADY_USED" };
  if (new Date(challenge.expires_at).getTime() <= now.getTime()) return { ok: false, reason: "EXPIRED" };
  // Verify against the message WE stored — never against anything the browser sends.
  if (!(await verifyWalletSignature(challenge.message, signature, challenge.address))) return { ok: false, reason: "BAD_SIGNATURE" };

  return db.transaction(async (tx) => {
    const consumed = await tx.query("update public.wallet_challenges set consumed_at = $2::timestamptz where nonce = $1 and consumed_at is null returning nonce", [nonce, now.toISOString()]);
    if (consumed.length === 0) return { ok: false, reason: "ALREADY_USED" } as WalletLinkResult;
    const [claimed] = await tx.query("select 1 from public.character_claims where character_id = $1", [characterId]);
    if (!claimed) return { ok: false, reason: "NOT_CLAIMED" } as WalletLinkResult;
    const [previous] = await tx.query<{ address: string }>(
      "update public.wallet_links set unlinked_at = $2::timestamptz where character_id = $1 and unlinked_at is null returning address",
      [characterId, now.toISOString()],
    );
    try {
      await tx.query("insert into public.wallet_links (character_id, address, chain_id) values ($1, $2, $3)", [characterId, challenge.address, challenge.chain_id]);
    } catch (e) {
      if (/wallet_links_active_address|duplicate key/i.test(String((e as Error).message))) return { ok: false, reason: "ADDRESS_IN_USE" } as WalletLinkResult;
      throw e;
    }
    // A different wallet means previous holding streaks can no longer be vouched for.
    if (previous && previous.address !== challenge.address) {
      await tx.query("update public.holding_streaks set ended_at = $2::timestamptz, end_reason = 'WALLET_UNLINKED' where character_id = $1 and ended_at is null", [characterId, now.toISOString()]);
      await tx.query("delete from public.token_holdings where character_id = $1", [characterId]);
    }
    return { ok: true, address: challenge.address, replaced: previous?.address ?? null } as WalletLinkResult;
  });
}

export async function unlinkWallet(db: Db, characterId: string, now = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.query("update public.wallet_links set unlinked_at = $2::timestamptz where character_id = $1 and unlinked_at is null returning id", [characterId, now.toISOString()]);
    if (rows.length === 0) return false;
    await tx.query("update public.holding_streaks set ended_at = $2::timestamptz, end_reason = 'WALLET_UNLINKED' where character_id = $1 and ended_at is null", [characterId, now.toISOString()]);
    await tx.query("delete from public.token_holdings where character_id = $1", [characterId]);
    await tx.query(
      "update public.character_stats set holdings_bonus = '{}'::jsonb, loyalty_bonus = '{}'::jsonb, trading_bonus = '{}'::jsonb, holding_power = 0 where character_id = $1",
      [characterId],
    );
    return true;
  });
}

export { json };
