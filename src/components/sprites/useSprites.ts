"use client";

import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_SPRITE_SET, ensureSpriteSet, getIdleState, getLibraryState, retrySpriteSetNow, subscribeLibrary, type LibraryState } from "./library";

/** Subscribes a component to a sprite set, kicking off loading on first use — and retrying a failed set when the network / the tab comes back. */
export function useSpriteLibrary(setId: string = DEFAULT_SPRITE_SET): LibraryState {
  useEffect(() => {
    void ensureSpriteSet(setId);
    const retry = () => {
      if (document.visibilityState !== "hidden") retrySpriteSetNow(setId);
    };
    window.addEventListener("online", retry);
    window.addEventListener("pageshow", retry);
    document.addEventListener("visibilitychange", retry);
    return () => {
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
