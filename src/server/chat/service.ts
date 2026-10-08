import { CHAT_MIN_GAP_MS, CHAT_PAGE, CHAT_PAGE_MAX, CHAT_PER_WINDOW, CHAT_WINDOW_MS } from "@/domain/chat/limits";
import { cleanChatName, repeatKey } from "@/domain/chat/text";
import type { ChatMessageDto, ChatMute, ChatYou } from "@/domain/chat/types";
import { avatarUrlOrNull } from "@/domain/media/avatarUrl";

import type { Db, Queryable } from "../db/types";
import { audit } from "../services/auditLog";

import type { ChatSigner } from "./signing";

/**
 * ARENA CHAT — the room, in SQL. Everything here takes the connection it is given and holds it only for a handful of short statements:
 *
 *   · READ  (history, catch-up): ONE indexed, bounded statement — newest first, keyset-paged on `id`, never more than CHAT_PAGE_MAX rows.
 *   · SEND  (one transaction): advisory lock → who is sending (name, photo, mute) → "already sent this request?" → the member's last minute →
 *           insert. The lock serialises writers, so the spam limits cannot be raced and ids are issued in COMMIT order (a reader that has seen id N
 *           has seen every smaller id — "after N" can never skip a message).
 *   · MODERATE: hide / restore a message, mute / unmute a member — each with its audit row in the same transaction.
 *
 * The sender of a message is always an argument the SERVER computed from the verified session; nothing in this module reads an identity from a request.
 */

/** Distinct from the lifecycle lock (7300101) and the worker lock (7300110). */
export const CHAT_LOCK_KEY = 7_300_102;
/** Shown when a member has neither a hero nor a Telegram display name. */
export const FALLBACK_NAME = "Telegram member";

// ------------------------------------------------------------------------------------------------ schema readiness
const g = globalThis as unknown as { __clankChat?: { ready: boolean; at: number; pages: Map<string, { at: number; promise: Promise<PageResult> }> } };
const state = (): NonNullable<typeof g.__clankChat> => (g.__clankChat ??= { ready: false, at: 0, pages: new Map() });

/** Test hook: forget the readiness answer and every cached page. */
export function resetChatCaches(): void {
  g.__clankChat = undefined;
}

/**
 * Whether the chat tables exist. A migration is applied by a person, later than the code that needs it ships: until then the chat is simply CLOSED
 * (a calm panel, not an error). A positive answer is final for the life of the process; a negative one is re-checked every few seconds, so the room
 * opens by itself shortly after the migration is applied.
 */
export async function chatSchemaReady(q: Queryable, now = Date.now()): Promise<boolean> {
  const s = state();
  if (s.ready) return true;
  if (s.at !== 0 && now - s.at < 10_000) return false;
  const [row] = await q.query<{ ready: boolean }>("select (to_regclass('public.arena_chat_messages') is not null and to_regclass('public.arena_chat_mutes') is not null) as ready");
  s.at = now;
  s.ready = Boolean(row?.ready);
  return s.ready;
}

// ------------------------------------------------------------------------------------------------ rows → messages
interface MessageRow {
  id: number;
  created_at: Date | string;
  body: string;
  rev: number;
  sender_member_id: number;
  tg_name: string | null;
  hero_name: string | null;
  character_id: string | null;
  avatar_version: string | null;
}

/** A message with its sender's public presentation, in one statement (no per-message lookups). The caller appends `where …`. */
const PRESENT = `select m.id, m.created_at, m.body, m.rev, m.sender_member_id, m.deleted_at,
         tu.display_name as tg_name, coalesce(c.name_override, c.name) as hero_name, c.id as character_id, hp.version as avatar_version
    from public.arena_chat_messages m
    join public.telegram_users tu on tu.telegram_user_id = m.sender_member_id
    left join public.characters c on c.telegram_user_id = m.sender_member_id and c.status = 'ACTIVE'
    left join public.hero_profile_photos hp on hp.character_id = c.id`;

export const isoOf = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** The public name: the hero's name when the member has an active hero, else their Telegram display name — cleaned, never empty. */
export function publicName(heroName: string | null, telegramName: string | null): string {
  return cleanChatName(heroName) || cleanChatName(telegramName) || FALLBACK_NAME;
}

export function toMessage(r: MessageRow, signer: ChatSigner): ChatMessageDto {
  return {
    id: Number(r.id),
    at: isoOf(r.created_at),
    name: publicName(r.hero_name, r.tg_name),
    avatarUrl: r.character_id ? avatarUrlOrNull(r.character_id, r.avatar_version) : null,
    senderKey: signer.senderKey(Number(r.sender_member_id)),
    body: r.body,
    rev: Number(r.rev),
  };
}

// ------------------------------------------------------------------------------------------------ reading
export interface PageResult {
  messages: ChatMessageDto[];
  /** `before` / first page: older messages exist beyond the first one returned. `after`: more than a page of NEWER messages exist (a gap). */
  hasMore: boolean;
}
export interface PageQuery {
  before?: number;
  after?: number;
  limit?: number;
}

const PAGE_TTL_MS = 1_000;

/**
 * One page of the room, ascending. `after` returns the NEWEST `limit` messages newer than the cursor (a client that was away longer than a page
 * gets `hasMore` and replaces its window rather than stitching). Identical requests within a second share ONE statement on this instance — a burst of
 * viewers opening the page, or of reconnecting browsers, costs the database a single read.
 */
export function readPage(db: Queryable, signer: ChatSigner, query: PageQuery = {}, now = Date.now()): Promise<PageResult> {
  const limit = Math.min(CHAT_PAGE_MAX, Math.max(1, Math.floor(query.limit ?? CHAT_PAGE)));
  const key = `${query.after !== undefined ? `a${query.after}` : query.before !== undefined ? `b${query.before}` : "latest"}:${limit}:${signer.publicKey.slice(0, 6)}`;
  const s = state();
  const hit = s.pages.get(key);
  if (hit && now - hit.at < PAGE_TTL_MS) return hit.promise;
  const promise = (async (): Promise<PageResult> => {
    const rows =
      query.after !== undefined
        ? await db.query<MessageRow>(`${PRESENT} where m.deleted_at is null and m.id > $1::bigint order by m.id desc limit $2`, [query.after, limit + 1])
        : await db.query<MessageRow>(`${PRESENT} where m.deleted_at is null and ($1::bigint is null or m.id < $1::bigint) order by m.id desc limit $2`, [query.before ?? null, limit + 1]);
    return { hasMore: rows.length > limit, messages: rows.slice(0, limit).reverse().map((r) => toMessage(r, signer)) };
  })();
  s.pages.set(key, { at: now, promise });
  if (s.pages.size > 24) for (const k of s.pages.keys()) { s.pages.delete(k); if (s.pages.size <= 16) break; }
  // a failed read is not remembered: the next request tries again
  promise.catch(() => {
    if (s.pages.get(key)?.promise === promise) s.pages.delete(key);
  });
  return promise;
}

/** Drop cached pages (this instance just changed the room). */
export function forgetPages(): void {
  state().pages.clear();
}

interface MuteRow {
  permanent: boolean;
  muted_until: Date | string | null;
}
const muteOf = (r: MuteRow | undefined): ChatMute | null => (!r ? null : r.permanent || r.muted_until === null ? { permanent: true } : { permanent: false, until: isoOf(r.muted_until) });

const ACTIVE_MUTE = "lifted_at is null and (permanent or muted_until > clock_timestamp())";

/** What the signed-in member may do in the room (their own opaque key, whether they can send, and any mute that applies). */
export async function youOf(q: Queryable, memberId: number, signer: ChatSigner): Promise<ChatYou> {
  const [mute] = await q.query<MuteRow>(`select permanent, muted_until from public.arena_chat_mutes where member_id = $1 and ${ACTIVE_MUTE}`, [memberId]);
  const muted = muteOf(mute);
  return { senderKey: signer.senderKey(memberId), canSend: muted === null, muted };
}

// ------------------------------------------------------------------------------------------------ sending
export type SendResult =
  | { ok: true; message: ChatMessageDto; duplicate: boolean }
  | { ok: false; error: "MUTED"; mute: ChatMute }
  | { ok: false; error: "TOO_FAST" | "RATE_LIMITED"; retryAfterMs: number }
  | { ok: false; error: "DUPLICATE_MESSAGE" | "NO_MEMBER" };

export interface SendLimits {
  minGapMs: number;
  perWindow: number;
  windowMs: number;
}
export const DEFAULT_SEND_LIMITS: SendLimits = { minGapMs: CHAT_MIN_GAP_MS, perWindow: CHAT_PER_WINDOW, windowMs: CHAT_WINDOW_MS };

/**
 * Stores a message for `memberId` (the VERIFIED session's Telegram id) — or says why not. `body` is already normalised by the caller. `nonce` makes the
 * request idempotent: sending the same (member, nonce) again returns the message already stored, whatever the limits say now.
 */
export async function sendMessage(db: Db, memberId: number, body: string, nonce: string, signer: ChatSigner, limits: SendLimits = DEFAULT_SEND_LIMITS): Promise<SendResult> {
  const result = await db.transaction(async (tx): Promise<SendResult> => {
    await tx.query("select pg_advisory_xact_lock($1::bigint)", [CHAT_LOCK_KEY]);

    const [who] = await tx.query<{ tg_name: string | null; hero_name: string | null; character_id: string | null; avatar_version: string | null; permanent: boolean | null; muted_until: Date | string | null; muted: boolean }>(
      `select tu.display_name as tg_name, coalesce(c.name_override, c.name) as hero_name, c.id as character_id, hp.version as avatar_version,
              mu.permanent, mu.muted_until, (mu.member_id is not null) as muted
         from public.telegram_users tu
         left join public.characters c on c.telegram_user_id = tu.telegram_user_id and c.status = 'ACTIVE'
         left join public.hero_profile_photos hp on hp.character_id = c.id
         left join public.arena_chat_mutes mu on mu.member_id = tu.telegram_user_id and mu.lifted_at is null and (mu.permanent or mu.muted_until > clock_timestamp())
        where tu.telegram_user_id = $1`,
      [memberId],
    );
    if (!who) return { ok: false, error: "NO_MEMBER" };
    const present = (row: { id: number; created_at: Date | string; body: string; rev: number }): ChatMessageDto =>
      toMessage({ ...row, sender_member_id: memberId, tg_name: who.tg_name, hero_name: who.hero_name, character_id: who.character_id, avatar_version: who.avatar_version }, signer);

    // a retried request is answered with the message it already produced (before any limit or mute is consulted)
    const [again] = await tx.query<{ id: number; created_at: Date | string; body: string; rev: number }>(
      "select id, created_at, body, rev from public.arena_chat_messages where sender_member_id = $1 and client_nonce = $2",
      [memberId, nonce],
    );
    if (again) return { ok: true, message: present(again), duplicate: true };

    if (who.muted) return { ok: false, error: "MUTED", mute: muteOf({ permanent: Boolean(who.permanent), muted_until: who.muted_until }) as ChatMute };

    // the member's last minute, newest first, with ages measured by the database's own clock
    const recent = await tx.query<{ age_ms: number; body: string }>(
      // statement_timestamp() (not clock_timestamp()): it is STABLE, so the cutoff can be an INDEX condition — and it is "now" to within the lock wait's milliseconds
      `select (extract(epoch from (statement_timestamp() - created_at)) * 1000)::int as age_ms, body
         from public.arena_chat_messages
        where sender_member_id = $1 and created_at > statement_timestamp() - make_interval(secs => $2::float8)
        order by created_at desc, id desc limit $3`, // (member, created_at, id) is an index: a quiet member's lookup never walks the table (ids are issued in time order, so this is the same order)
      [memberId, limits.windowMs / 1000, limits.perWindow],
    );
    const newest = recent[0];
    if (newest && newest.age_ms < limits.minGapMs) return { ok: false, error: "TOO_FAST", retryAfterMs: limits.minGapMs - newest.age_ms };
    const last = recent[limits.perWindow - 1];
    if (last) return { ok: false, error: "RATE_LIMITED", retryAfterMs: Math.max(1, limits.windowMs - last.age_ms) };
    const key = repeatKey(body);
    if (recent.some((r) => repeatKey(r.body) === key)) return { ok: false, error: "DUPLICATE_MESSAGE" };

    const [row] = await tx.query<{ id: number; created_at: Date | string; body: string; rev: number }>(
      "insert into public.arena_chat_messages (sender_member_id, body, client_nonce) values ($1, $2, $3) returning id, created_at, body, rev",
      [memberId, body, nonce],
    );
    return { ok: true, message: present(row as NonNullable<typeof row>), duplicate: false };
  });
  if (result.ok && !result.duplicate) forgetPages();
  return result;
}

// ------------------------------------------------------------------------------------------------ moderation
export type HideResult = { ok: true; id: number; rev: number; changed: boolean } | { ok: false; error: "NOT_FOUND" };
export type RestoreResult = { ok: true; message: ChatMessageDto; changed: boolean } | { ok: false; error: "NOT_FOUND" };

/** Hides a message from the room (soft delete). Idempotent: hiding a hidden message changes nothing and is not logged twice. */
export async function hideMessage(db: Db, id: number, actor: string, reason?: string | null): Promise<HideResult> {
  const result = await db.transaction(async (tx): Promise<HideResult> => {
    const [hid] = await tx.query<{ rev: number; sender_member_id: number }>(
      "update public.arena_chat_messages set deleted_at = now(), deleted_by = $2, rev = rev + 1 where id = $1 and deleted_at is null returning rev, sender_member_id",
      [id, actor],
    );
    if (hid) {
      await audit(tx, actor, "chat.hide", "chat_message", String(id), { memberId: Number(hid.sender_member_id), reason: reason ?? null });
      return { ok: true, id, rev: Number(hid.rev), changed: true };
    }
    const [row] = await tx.query<{ rev: number }>("select rev from public.arena_chat_messages where id = $1", [id]);
    return row ? { ok: true, id, rev: Number(row.rev), changed: false } : { ok: false, error: "NOT_FOUND" };
  });
  if (result.ok && result.changed) forgetPages();
  return result;
}

/** Puts a hidden message back. Returns the message (with its new revision) so it can be broadcast again. */
export async function restoreMessage(db: Db, id: number, actor: string, signer: ChatSigner): Promise<RestoreResult> {
  const result = await db.transaction(async (tx): Promise<RestoreResult> => {
    const [back] = await tx.query<{ sender_member_id: number }>(
      "update public.arena_chat_messages set deleted_at = null, deleted_by = null, rev = rev + 1 where id = $1 and deleted_at is not null returning sender_member_id",
      [id],
    );
    if (back) await audit(tx, actor, "chat.restore", "chat_message", String(id), { memberId: Number(back.sender_member_id) });
    const [row] = await tx.query<MessageRow>(`${PRESENT} where m.id = $1`, [id]);
    return row ? { ok: true, message: toMessage(row, signer), changed: Boolean(back) } : { ok: false, error: "NOT_FOUND" };
  });
  if (result.ok && result.changed) forgetPages();
  return result;
}

export interface MuteRequest {
  memberId: number;
  /** Timed mute, in minutes. Exactly one of `minutes` / `permanent`. */
  minutes?: number;
  permanent?: boolean;
  /** PRIVATE: kept for admins, never sent to a public endpoint. */
  reason?: string | null;
}
export type MuteResult = { ok: true; mute: ChatMute } | { ok: false; error: "NO_MEMBER" | "INVALID" };

/** Mutes a member (replacing any mute they already have). They can still read the room. */
export async function muteMember(db: Db, req: MuteRequest, actor: string): Promise<MuteResult> {
  const timed = req.minutes !== undefined;
  if (timed === Boolean(req.permanent)) return { ok: false, error: "INVALID" }; // exactly one of the two
  if (timed && (!Number.isInteger(req.minutes) || (req.minutes as number) < 1 || (req.minutes as number) > 60 * 24 * 365)) return { ok: false, error: "INVALID" };
  return db.transaction(async (tx): Promise<MuteResult> => {
    const [member] = await tx.query("select 1 as ok from public.telegram_users where telegram_user_id = $1", [req.memberId]);
    if (!member) return { ok: false, error: "NO_MEMBER" };
    await tx.query("update public.arena_chat_mutes set lifted_at = now(), lifted_by = 'superseded' where member_id = $1 and lifted_at is null", [req.memberId]);
    const [row] = await tx.query<MuteRow>(
      `insert into public.arena_chat_mutes (member_id, permanent, muted_until, reason, created_by)
       values ($1, $2::boolean, case when $2::boolean then null else now() + make_interval(mins => $3::int) end, $4, $5)
       returning permanent, muted_until`,
      [req.memberId, Boolean(req.permanent), timed ? req.minutes : 0, req.reason?.trim() ? req.reason.trim().slice(0, 300) : null, actor],
    );
    const mute = muteOf(row) as ChatMute;
    await audit(tx, actor, "chat.mute", "chat_member", String(req.memberId), { permanent: mute.permanent, until: mute.permanent ? null : mute.until, reason: req.reason ?? null });
    return { ok: true, mute };
  });
}

export async function unmuteMember(db: Db, memberId: number, actor: string): Promise<{ ok: true; changed: boolean }> {
  return db.transaction(async (tx) => {
    const lifted = await tx.query("update public.arena_chat_mutes set lifted_at = now(), lifted_by = $2 where member_id = $1 and lifted_at is null returning id", [memberId, actor]);
    if (lifted.length > 0) await audit(tx, actor, "chat.unmute", "chat_member", String(memberId), {});
    return { ok: true as const, changed: lifted.length > 0 };
  });
}

// ------------------------------------------------------------------------------------------------ the admin's view
export interface AdminChatMessage {
  id: number;
  at: string;
  body: string;
  hidden: boolean;
  rev: number;
  memberId: number;
  name: string;
  username: string | null;
  muted: boolean;
}

/** The newest messages INCLUDING hidden ones, with the real member id (admins only), keyset-paged on id. */
export async function adminMessages(q: Queryable, opts: { before?: number; limit?: number } = {}): Promise<{ messages: AdminChatMessage[]; hasMore: boolean }> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 50)));
  const rows = await q.query<MessageRow & { deleted_at: Date | string | null; username: string | null; is_muted: boolean }>(
    `select m.id, m.created_at, m.body, m.rev, m.sender_member_id, m.deleted_at, tu.display_name as tg_name, tu.username, coalesce(c.name_override, c.name) as hero_name,
            exists (select 1 from public.arena_chat_mutes mu where mu.member_id = m.sender_member_id and mu.lifted_at is null and (mu.permanent or mu.muted_until > clock_timestamp())) as is_muted
       from public.arena_chat_messages m
       join public.telegram_users tu on tu.telegram_user_id = m.sender_member_id
       left join public.characters c on c.telegram_user_id = m.sender_member_id
      where ($1::bigint is null or m.id < $1::bigint)
      order by m.id desc limit $2`,
    [opts.before ?? null, limit + 1],
  );
  return {
    hasMore: rows.length > limit,
    messages: rows.slice(0, limit).map((r) => ({
      id: Number(r.id),
      at: isoOf(r.created_at),
      body: r.body,
      hidden: r.deleted_at !== null,
      rev: Number(r.rev),
      memberId: Number(r.sender_member_id),
      name: publicName(r.hero_name, r.tg_name),
      username: r.username,
      muted: Boolean(r.is_muted),
    })),
  };
}

export interface AdminMute {
  id: number;
  memberId: number;
  name: string;
  permanent: boolean;
  until: string | null;
  reason: string | null;
  by: string;
  at: string;
}

/** Open mutes (timed ones that have run out are not listed). */
export async function activeMutes(q: Queryable): Promise<AdminMute[]> {
  const rows = await q.query<{ id: number; member_id: number; permanent: boolean; muted_until: Date | string | null; reason: string | null; created_by: string; created_at: Date | string; tg_name: string | null; hero_name: string | null }>(
    `select mu.id, mu.member_id, mu.permanent, mu.muted_until, mu.reason, mu.created_by, mu.created_at, tu.display_name as tg_name, coalesce(c.name_override, c.name) as hero_name
       from public.arena_chat_mutes mu
       join public.telegram_users tu on tu.telegram_user_id = mu.member_id
       left join public.characters c on c.telegram_user_id = mu.member_id
      where mu.lifted_at is null and (mu.permanent or mu.muted_until > clock_timestamp())
      order by mu.id desc limit 200`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    memberId: Number(r.member_id),
    name: publicName(r.hero_name, r.tg_name),
    permanent: r.permanent,
    until: r.muted_until === null ? null : isoOf(r.muted_until),
    reason: r.reason,
    by: r.created_by,
    at: isoOf(r.created_at),
  }));
}

/** The latest moderation actions, newest first (the audit log's `chat.*` rows). */
export async function moderationLog(q: Queryable, limit = 50): Promise<Array<{ at: string; actor: string; action: string; target: string | null; detail: unknown }>> {
  const rows = await q.query<{ created_at: Date | string; actor: string; action: string; entity_id: string | null; detail: unknown }>(
    "select created_at, actor, action, entity_id, detail from public.admin_audit_log where action like 'chat.%' order by id desc limit $1",
    [Math.min(200, Math.max(1, limit))],
  );
  return rows.map((r) => ({ at: isoOf(r.created_at), actor: r.actor, action: r.action, target: r.entity_id, detail: r.detail }));
}
