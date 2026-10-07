import { createHash } from "node:crypto";

import { avatarUrl } from "@/domain/media/avatarUrl";
import { inspectImage, type AvatarMime } from "@/domain/media/image";

import type { Db, Queryable } from "../db/types";
import type { AvatarStore } from "../storage/avatarStore";

import { AdminError, audit } from "./admin";

/**
 * Hero PROFILE PHOTOS — the member's picture, separate from the arena sprite.
 *
 *   priority:  1 admin override → 2 Telegram profile photo → 3 nothing stored (the app draws the class portrait)
 *
 * Everything is keyed by immutable ids: the override by `characters.id`, the Telegram cache by `telegram_user_id`.
 * No name is ever involved, so renaming a hero (or a Telegram @username changing) cannot move or orphan a photo.
 */

export type PhotoSource = "ADMIN" | "TELEGRAM";

/** The public URL of a hero's current photo. `version` (a content-hash prefix) busts caches when the image changes. */
export { avatarUrl };

export interface ResolvedPhoto {
  source: PhotoSource;
  storagePath: string;
  mime: AvatarMime;
  version: string;
}

/** Applies the priority rule (it lives in the `hero_profile_photos` view) for one hero. */
export async function resolvePhoto(q: Queryable, characterId: string): Promise<ResolvedPhoto | null> {
  const [r] = await q.query<{ source: PhotoSource | null; storage_path: string | null; mime_type: AvatarMime | null; version: string | null }>(
    "select source, storage_path, mime_type, version from public.hero_profile_photos where character_id = $1",
    [characterId],
  );
  if (!r || !r.source || !r.storage_path || !r.mime_type || !r.version) return null;
  return { source: r.source, storagePath: r.storage_path, mime: r.mime_type, version: r.version };
}

/** Bytes for the avatar route. Null → the browser shows the generated default (never a broken image). */
export async function loadPhotoBytes(db: Db, store: AvatarStore, characterId: string): Promise<{ bytes: Uint8Array; mime: AvatarMime; version: string } | null> {
  const photo = await resolvePhoto(db, characterId);
  if (!photo) return null;
  const bytes = await store.get(photo.storagePath);
  return bytes ? { bytes, mime: photo.mime, version: photo.version } : null;
}

/** The cached Telegram photo's bytes regardless of which source is active (admin preview). */
export async function loadTelegramPhotoBytes(db: Db, store: AvatarStore, characterId: string): Promise<{ bytes: Uint8Array; mime: AvatarMime } | null> {
  const [t] = await db.query<{ storage_path: string | null; mime_type: AvatarMime | null }>(
    `select p.storage_path, p.mime_type from public.characters c join public.telegram_user_photos p on p.telegram_user_id = c.telegram_user_id
      where c.id = $1 and p.status = 'AVAILABLE'`,
    [characterId],
  );
  if (!t?.storage_path || !t.mime_type) return null;
  const bytes = await store.get(t.storage_path);
  return bytes ? { bytes, mime: t.mime_type } : null;
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface AdminPhotoResult {
  changed: boolean;
  source: PhotoSource;
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Admin upload / replace. The image is validated from its BYTES (type, structure, size, dimensions — the declared
 * content type is only a consistency check), stored under a server-generated path, and recorded.
 */
export async function setAdminPhoto(db: Db, store: AvatarStore, input: { characterId: string; bytes: Uint8Array; declaredMime: string | null; actor: string }): Promise<AdminPhotoResult> {
  const inspected = inspectImage(input.bytes, { declaredMime: input.declaredMime });
  if (!inspected.ok) throw new AdminError(`PHOTO_${inspected.problem}`, inspected.problem === "TOO_LARGE" ? 413 : 422, inspected.message);

  const [hero] = await db.query<{ id: string }>("select id from public.characters where id = $1", [input.characterId]);
  if (!hero) throw new AdminError("NOT_FOUND", 404);

  const sha = sha256Hex(input.bytes);
  const storagePath = `override/${input.characterId}/${sha.slice(0, 16)}.${inspected.ext}`;
  const [existing] = await db.query<{ storage_path: string; sha256: string }>("select storage_path, sha256 from public.hero_photo_overrides where character_id = $1", [input.characterId]);
  if (existing?.sha256 === sha) {
    return { changed: false, source: "ADMIN", url: avatarUrl(input.characterId, sha.slice(0, 12)), width: inspected.width, height: inspected.height, bytes: inspected.bytes };
  }

  // Object first, row second: a failure in between leaves an unreferenced object, never a row pointing at nothing.
  await store.put(storagePath, input.bytes, inspected.mime);
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into public.hero_photo_overrides (character_id, storage_path, mime_type, byte_size, width, height, sha256, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (character_id) do update set storage_path = excluded.storage_path, mime_type = excluded.mime_type, byte_size = excluded.byte_size,
         width = excluded.width, height = excluded.height, sha256 = excluded.sha256, updated_by = excluded.updated_by`,
      [input.characterId, storagePath, inspected.mime, inspected.bytes, inspected.width, inspected.height, sha, input.actor],
    );
    await audit(tx, input.actor, "hero.photo.set", "character", input.characterId, { sha256: sha, bytes: inspected.bytes, width: inspected.width, height: inspected.height, replaced: Boolean(existing) });
  });
  if (existing && existing.storage_path !== storagePath) await store.remove(existing.storage_path).catch(() => undefined);
  return { changed: true, source: "ADMIN", url: avatarUrl(input.characterId, sha.slice(0, 12)), width: inspected.width, height: inspected.height, bytes: inspected.bytes };
}

/** Removes the admin override; the hero falls back to its Telegram photo (if any), then to the generated default. */
export async function removeAdminPhoto(db: Db, store: AvatarStore, characterId: string, actor: string): Promise<{ removed: boolean }> {
  const [hero] = await db.query<{ id: string }>("select id from public.characters where id = $1", [characterId]);
  if (!hero) throw new AdminError("NOT_FOUND", 404);
  const removed = await db.transaction(async (tx) => {
    const rows = await tx.query<{ storage_path: string; sha256: string }>("delete from public.hero_photo_overrides where character_id = $1 returning storage_path, sha256", [characterId]);
    if (rows[0]) await audit(tx, actor, "hero.photo.remove", "character", characterId, { sha256: rows[0].sha256 });
    return rows[0] ?? null;
  });
  if (removed) await store.remove(removed.storage_path).catch(() => undefined);
  return { removed: Boolean(removed) };
}

// ---------------------------------------------------------------------------------------
// Admin read model
// ---------------------------------------------------------------------------------------

export interface HeroPhotoAdminView {
  /** Which source is on screen right now. DEFAULT = the generated class portrait. */
  active: PhotoSource | "DEFAULT";
  url: string | null;
  admin: { updatedAt: Date; updatedBy: string; width: number; height: number; bytes: number; mime: AvatarMime } | null;
  telegram: { status: "UNKNOWN" | "AVAILABLE" | "NONE" | "ERROR"; checkedAt: Date | null; fetchedAt: Date | null; width: number | null; height: number | null; lastError: string | null; url: string | null } | null;
}

export async function getHeroPhotoAdminView(q: Queryable, characterId: string): Promise<HeroPhotoAdminView> {
  const resolved = await resolvePhoto(q, characterId);
  const [o] = await q.query<{ updated_at: Date; updated_by: string; width: number; height: number; byte_size: number; mime_type: AvatarMime }>(
    "select updated_at, updated_by, width, height, byte_size, mime_type from public.hero_photo_overrides where character_id = $1",
    [characterId],
  );
  const [t] = await q.query<{ status: "UNKNOWN" | "AVAILABLE" | "NONE" | "ERROR"; checked_at: Date | null; fetched_at: Date | null; width: number | null; height: number | null; last_error: string | null; sha256: string | null }>(
    `select p.status, p.checked_at, p.fetched_at, p.width, p.height, p.last_error, p.sha256
       from public.characters c join public.telegram_user_photos p on p.telegram_user_id = c.telegram_user_id where c.id = $1`,
    [characterId],
  );
  return {
    active: resolved?.source ?? "DEFAULT",
    url: resolved ? avatarUrl(characterId, resolved.version) : null,
    admin: o ? { updatedAt: o.updated_at, updatedBy: o.updated_by, width: o.width, height: o.height, bytes: o.byte_size, mime: o.mime_type } : null,
    telegram: t
      ? {
          status: t.status,
          checkedAt: t.checked_at,
          fetchedAt: t.fetched_at,
          width: t.width,
          height: t.height,
          lastError: t.last_error,
          // Admin-only preview of the Telegram photo itself, even while an override is the one on screen.
          url: t.status === "AVAILABLE" && t.sha256 ? `/api/admin/heroes/${characterId}/photo/telegram?v=${t.sha256.slice(0, 12)}` : null,
        }
      : null,
  };
}
