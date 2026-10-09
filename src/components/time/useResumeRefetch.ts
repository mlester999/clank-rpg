"use client";

import { useEffect, useRef } from "react";

/**
 * Asks the server again when the page comes back: a tab that was in the background for a while, a page restored by the browser's Back button
 * (bfcache), or a connection that returned. A countdown keeps counting while a tab sleeps (or does not, when the machine sleeps) — either way it is only
 * a display, so on resume the SERVER is asked what is true now. `reload` should be cheap and idempotent (a status read).
 */
export function useResumeRefetch(reload: () => void, opts: { minHiddenMs?: number } = {}): void {
  const minHidden = opts.minHiddenMs ?? 15_000;
  const latest = useRef(reload);
  useEffect(() => {
    latest.current = reload;
  });
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") hiddenAt = Date.now();
      else if (hiddenAt !== null) {
        const away = Date.now() - hiddenAt;
        hiddenAt = null;
        if (away >= minHidden) latest.current();
      }
    };
    const onPageShow = (e: PageTransitionEvent): void => {
      if (e.persisted) latest.current();
    };
    const onOnline = (): void => latest.current();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, [minHidden]);
}
