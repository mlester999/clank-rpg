import "server-only";

import { getEnv } from "../env";

import { createAvatarStore } from "./factory";
import type { AvatarStore } from "./avatarStore";

export type { AvatarStore } from "./avatarStore";
export { createAvatarStore } from "./factory";

const g = globalThis as unknown as { __clankAvatarStore?: AvatarStore | null };

/** The process-wide avatar store (created lazily; tests may replace it with `setAvatarStoreForTests`). */
export function getAvatarStore(): AvatarStore | null {
  if (g.__clankAvatarStore === undefined) g.__clankAvatarStore = createAvatarStore(getEnv());
  return g.__clankAvatarStore;
}

export function setAvatarStoreForTests(store: AvatarStore | null | undefined): void {
  g.__clankAvatarStore = store;
}
