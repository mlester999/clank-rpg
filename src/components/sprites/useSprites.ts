"use client";

import { useEffect, useSyncExternalStore } from "react";

import { DEFAULT_SPRITE_SET, ensureSpriteSet, getIdleState, getLibraryState, subscribeLibrary, type LibraryState } from "./library";

/** Subscribes a component to a sprite set, kicking off loading on first use. */
export function useSpriteLibrary(setId: string = DEFAULT_SPRITE_SET): LibraryState {
  useEffect(() => {
    void ensureSpriteSet(setId);
  }, [setId]);
  return useSyncExternalStore(
    subscribeLibrary,
    () => getLibraryState(setId),
    () => getIdleState(setId), // the server (and hydration) always see "not loaded yet"
  );
}
