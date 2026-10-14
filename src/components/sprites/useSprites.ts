"use client";

import { useEffect, useSyncExternalStore } from "react";

import {
  activeSpriteSet, DEFAULT_SPRITE_SET, ensureSpriteSet, getIdleState, getLibraryState, retrySpriteSetNow, subscribeActiveSpriteSet, subscribeLibrary, type LibraryState,
} from "./library";

/** The sprite set the server says is live (as last heard on this device); the server render and hydration see the default. */
export function useActiveSpriteSet(): string {
  return useSyncExternalStore(subscribeActiveSpriteSet, activeSpriteSet, () => DEFAULT_SPRITE_SET);
}

/** Subscribes a component to a sprite set, kicking off loading on first use — and retrying a failed set when the network / the tab comes back. */
export function useSpriteLibrary(setId: string = DEFAULT_SPRITE_SET): LibraryState {
  useEffect(() => {
    // one task later: a hydrated portrait first renders with the server's default set and re-renders at once with the live one — this way only
    // the set it ends up drawing with is loaded (a v2 manifest alone is several MB)
    const start = setTimeout(() => void ensureSpriteSet(setId), 0);
    const retry = () => {
      if (document.visibilityState !== "hidden") retrySpriteSetNow(setId);
    };
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
      clearTimeout(start);
      window.removeEventListener("online", retry);
      window.removeEventListener("pageshow", retry);
      document.removeEventListener("visibilitychange", retry);
    };
  }, [setId]);
  return useSyncExternalStore(
    subscribeLibrary,
    () => getLibraryState(setId),
    () => getIdleState(setId), // the server (and hydration) always see "not loaded yet"
  );
}
