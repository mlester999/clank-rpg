import path from "node:path";

import type { ServerEnv } from "../env";

import { createLocalAvatarStore, createSupabaseAvatarStore, type AvatarStore } from "./avatarStore";

/**
 * Chooses where profile-photo bytes live — and refuses to guess:
 *   · Supabase URL + service-role key set  → Supabase Storage (production path)
 *   · no DATABASE_URL, not production      → files on disk beside the embedded database (local development)
 *   · anything else                        → null: uploads and photo caching are unavailable. In particular a laptop
 *     pointed at a real database never writes image files to its own disk (the rows would point at paths that
 *     exist nowhere else).
 */
export function createAvatarStore(env: ServerEnv, fetchImpl?: typeof fetch): AvatarStore | null {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return createSupabaseAvatarStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY, bucket: env.SUPABASE_AVATAR_BUCKET, ...(fetchImpl ? { fetchImpl } : {}) });
  }
  if (!env.DATABASE_URL && !env.isProduction) {
    const pglite = process.env.CLANK_PGLITE_DIR;
    const dir = env.CLANK_AVATAR_DIR ?? (pglite ? `${path.resolve(pglite)}-avatars` : path.join(process.cwd(), ".data", "avatars"));
    return createLocalAvatarStore(dir);
  }
  return null;
}

