import { createHash } from "node:crypto";

import { inspectImage } from "@/domain/media/image";

import type { Db } from "../db/types";
import type { AvatarStore } from "../storage/avatarStore";

/**
 * Telegram profile photos for heroes. Resolution is by the IMMUTABLE telegram_user_id, the bytes are cached in
 * avatar storage, and an unchanged picture (same `file_unique_id`) is never downloaded again.
 *
 * Honest status: written against the documented Bot API (`getUserProfilePhotos`, `getFile`, the file download
 * URL) and exercised with a faithful fake. It has NOT been run against real Telegram — that needs the bot to be
 * live in the official group. A member whose privacy settings hide their photo simply resolves to "NONE".
 */

export interface TelegramPhotoRef {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
}

export interface TelegramPhotoSource {
  /** The member's current profile photo (best size for an avatar), or null when they have none / hide it. */
  currentPhoto(telegramUserId: number): Promise<TelegramPhotoRef | null>;
  download(fileId: string): Promise<{ bytes: Uint8Array }>;
}

export class TelegramPhotoError extends Error {
  constructor(
    message: string,
    readonly kind: "RATE_LIMITED" | "API" | "NETWORK",
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "TelegramPhotoError";
  }
}

interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
}

/** Smallest size that is at least `want` px on its short side, else the largest available. */
export function pickPhotoSize(sizes: readonly PhotoSize[], want = 320): PhotoSize | null {
  if (sizes.length === 0) return null;
  const byArea = [...sizes].sort((a, b) => Math.min(a.width, a.height) - Math.min(b.width, b.height));
  return byArea.find((s) => Math.min(s.width, s.height) >= want) ?? (byArea[byArea.length - 1] as PhotoSize);
}

/** Real Bot API client. The bot token never appears in an error message, a log line or a URL we return. */
export function createBotApiPhotoSource({ token, fetchImpl = fetch, apiBase = "https://api.telegram.org" }: { token: string; fetchImpl?: typeof fetch; apiBase?: string }): TelegramPhotoSource {
  const scrub = (text: string): string => text.split(token).join("[token]");

  async function call<T>(method: string, params: Record<string, string | number>): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]))}`, { method: "GET" });
    } catch (error) {
      throw new TelegramPhotoError(scrub(`Telegram request failed: ${error instanceof Error ? error.message : String(error)}`), "NETWORK");
    }
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new TelegramPhotoError(`Telegram answered ${method} with HTTP ${res.status} and no JSON`, "API");
    }
    if (!body.ok || body.result === undefined) {
      if (res.status === 429 || body.error_code === 429) throw new TelegramPhotoError("Telegram rate limit", "RATE_LIMITED", body.parameters?.retry_after);
      throw new TelegramPhotoError(scrub(`Telegram ${method}: ${body.description ?? `HTTP ${res.status}`}`), "API");
    }
    return body.result;
  }

  return {
    async currentPhoto(telegramUserId) {
      const r = await call<{ total_count: number; photos: PhotoSize[][] }>("getUserProfilePhotos", { user_id: telegramUserId, limit: 1 });
      const newest = r.photos[0];
      const size = newest ? pickPhotoSize(newest) : null;
      return size ? { fileId: size.file_id, fileUniqueId: size.file_unique_id, width: size.width, height: size.height } : null;
    },
    async download(fileId) {
      const file = await call<{ file_path?: string }>("getFile", { file_id: fileId });
      if (!file.file_path) throw new TelegramPhotoError("Telegram returned no file path", "API");
      let res: Response;
      try {
        res = await fetchImpl(`${apiBase}/file/bot${token}/${file.file_path}`);
      } catch (error) {
        throw new TelegramPhotoError(scrub(`Telegram download failed: ${error instanceof Error ? error.message : String(error)}`), "NETWORK");
      }
      if (!res.ok) throw new TelegramPhotoError(`Telegram file download failed (HTTP ${res.status})`, "API");
      return { bytes: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}

// ---------------------------------------------------------------------------------------

export type PhotoSyncStatus = "UPDATED" | "UNCHANGED" | "NONE" | "SKIPPED_RECENT" | "REJECTED" | "ERROR" | "NOT_CONFIGURED";

export interface PhotoSyncResult {
  telegramUserId: number;
  status: PhotoSyncStatus;
  detail?: string;
}

const HOUR = 3_600_000;
/** How long a verdict (photo present / absent) is trusted before Telegram is asked again. */
export const RECHECK_AFTER_MS = 24 * HOUR;
/** After a failure: 1 h, 2 h, 4 h … capped at 24 h. */
export const errorBackoffMs = (errorCount: number): number => Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, errorCount - 1));

interface PhotoRow {
  status: "UNKNOWN" | "AVAILABLE" | "NONE" | "ERROR";
  file_unique_id: string | null;
  storage_path: string | null;
  checked_at: Date | null;
  error_count: number;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Brings ONE member's cached Telegram photo up to date. Safe to call repeatedly: it asks Telegram at most once per
 * `RECHECK_AFTER_MS` (longer after errors) unless `force`, and downloads only when the picture actually changed.
 */
export async function syncTelegramPhoto(
  db: Db,
  store: AvatarStore,
  source: TelegramPhotoSource,
  telegramUserId: number,
  opts: { now?: () => Date; force?: boolean } = {},
): Promise<PhotoSyncResult> {
  const now = (opts.now ?? (() => new Date()))();
  const [row] = await db.query<PhotoRow>("select status, file_unique_id, storage_path, checked_at, error_count from public.telegram_user_photos where telegram_user_id = $1", [telegramUserId]);

  if (row && !opts.force && row.checked_at) {
    const age = now.getTime() - new Date(row.checked_at).getTime();
    const window = row.status === "ERROR" ? errorBackoffMs(row.error_count) : RECHECK_AFTER_MS;
    if (row.status !== "UNKNOWN" && age < window) return { telegramUserId, status: "SKIPPED_RECENT" };
  }

  /** A failed attempt never blanks a working avatar: an AVAILABLE cache stays AVAILABLE, we only back off. */
  const noteFailure = (message: string) =>
    db
      .query(
        `insert into public.telegram_user_photos (telegram_user_id, status, checked_at, error_count, last_error)
         values ($1, 'ERROR', $2::timestamptz, $3, $4)
         on conflict (telegram_user_id) do update set checked_at = excluded.checked_at, error_count = excluded.error_count, last_error = excluded.last_error,
           status = case when public.telegram_user_photos.status = 'AVAILABLE' then 'AVAILABLE' else 'ERROR' end`,
        [telegramUserId, now.toISOString(), (row?.error_count ?? 0) + 1, message.slice(0, 300)],
      )
      .catch(() => undefined);

  try {
    const current = await source.currentPhoto(telegramUserId);
    if (!current) {
      // The member has no (visible) photo — or removed it. Forget the cached copy so it stops showing.
      await db.query(
        `insert into public.telegram_user_photos (telegram_user_id, status, checked_at, error_count, last_error)
         values ($1, 'NONE', $2::timestamptz, 0, null)
         on conflict (telegram_user_id) do update set status = 'NONE', checked_at = excluded.checked_at, error_count = 0, last_error = null,
           file_unique_id = null, file_id = null, storage_path = null, mime_type = null, byte_size = null, width = null, height = null, sha256 = null`,
        [telegramUserId, now.toISOString()],
      );
      if (row?.storage_path) await store.remove(row.storage_path).catch(() => undefined);
      return { telegramUserId, status: "NONE" };
    }

    // Same picture as the cached one → no download, just note that we looked.
    if (row?.status === "AVAILABLE" && row.file_unique_id === current.fileUniqueId && !opts.force) {
      await db.query("update public.telegram_user_photos set checked_at = $2::timestamptz, error_count = 0, last_error = null, file_id = $3 where telegram_user_id = $1", [telegramUserId, now.toISOString(), current.fileId]);
      return { telegramUserId, status: "UNCHANGED" };
    }

    const { bytes } = await source.download(current.fileId);
    const inspected = inspectImage(bytes);
    if (!inspected.ok) {
      await noteFailure(`rejected image: ${inspected.problem}`);
      return { telegramUserId, status: "REJECTED", detail: inspected.problem };
    }
    const sha = sha256Hex(bytes);
    const storagePath = `telegram/${telegramUserId}/${sha.slice(0, 16)}.${inspected.ext}`;
    await store.put(storagePath, bytes, inspected.mime);
    await db.query(
      `insert into public.telegram_user_photos (telegram_user_id, status, file_unique_id, file_id, storage_path, mime_type, byte_size, width, height, sha256, checked_at, fetched_at, error_count, last_error)
       values ($1, 'AVAILABLE', $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $10::timestamptz, 0, null)
       on conflict (telegram_user_id) do update set status = 'AVAILABLE', file_unique_id = excluded.file_unique_id, file_id = excluded.file_id,
         storage_path = excluded.storage_path, mime_type = excluded.mime_type, byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,
         sha256 = excluded.sha256, checked_at = excluded.checked_at, fetched_at = excluded.fetched_at, error_count = 0, last_error = null`,
      [telegramUserId, current.fileUniqueId, current.fileId, storagePath, inspected.mime, inspected.bytes, inspected.width, inspected.height, sha, now.toISOString()],
    );
    if (row?.storage_path && row.storage_path !== storagePath) await store.remove(row.storage_path).catch(() => undefined);
    return { telegramUserId, status: "UPDATED" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await noteFailure(message);
    return { telegramUserId, status: "ERROR", detail: message.slice(0, 300) };
  }
}

export interface PhotoBatchSummary {
  checked: number;
  byStatus: Partial<Record<PhotoSyncStatus, number>>;
  rateLimited: boolean;
}

/** Heroes whose Telegram photo is due a look: never checked first, then the stalest. Read-only. */
export async function findPhotoSyncCandidates(db: Db, now: Date, limit: number): Promise<number[]> {
  const due = await db.query<{ telegram_user_id: number }>(
    `select tu.telegram_user_id
       from public.telegram_users tu
       join public.characters c on c.telegram_user_id = tu.telegram_user_id and c.status = 'ACTIVE'
       left join public.telegram_user_photos p on p.telegram_user_id = tu.telegram_user_id
      where not tu.is_demo and tu.status <> 'BANNED'
        and (p.telegram_user_id is null or p.status = 'UNKNOWN' or p.checked_at is null
             or p.checked_at < $1::timestamptz - (case when p.status = 'ERROR' then least($3::float8, $2::float8 * power(2, greatest(p.error_count - 1, 0))) else $3::float8 end) * interval '1 millisecond')
      order by p.checked_at nulls first, tu.telegram_user_id
      limit $4`,
    [now.toISOString(), HOUR, RECHECK_AFTER_MS, Math.max(1, Math.min(limit, 500))],
  );
  return due.map((r) => Number(r.telegram_user_id));
}

/**
 * One bounded batch for a scheduler tick. Stops at the first rate-limit response instead of hammering Telegram.
 */
export async function syncTelegramPhotoBatch(db: Db, store: AvatarStore, source: TelegramPhotoSource, opts: { limit?: number; now?: () => Date } = {}): Promise<PhotoBatchSummary> {
  const now = (opts.now ?? (() => new Date()))();
  const summary: PhotoBatchSummary = { checked: 0, byStatus: {}, rateLimited: false };
  for (const telegramUserId of await findPhotoSyncCandidates(db, now, opts.limit ?? 25)) {
    const r = await syncTelegramPhoto(db, store, source, telegramUserId, { now: () => now });
    summary.checked++;
    summary.byStatus[r.status] = (summary.byStatus[r.status] ?? 0) + 1;
    if (r.status === "ERROR" && r.detail?.includes("rate limit")) {
      summary.rateLimited = true;
      break;
    }
  }
  return summary;
}
