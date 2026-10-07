"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ApiErr, ApiOk } from "./api";

type Result<T> = ApiOk<T> | ApiErr;

/**
 * Fetch-on-mount/key-change with stale-while-revalidate semantics and an explicit reload().
 * State is only ever set from the async completion (never synchronously inside the effect),
 * and `loading` is DERIVED from "the settled key differs from the requested key".
 */
export function useRemote<T>(load: () => Promise<Result<T>>, key: string) {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<{ key: string; result: Result<T> } | null>(null);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  const requested = `${key}#${tick}`;

  useEffect(() => {
    let live = true;
    void loadRef.current().then((result) => {
      if (live) setSettled({ key: requested, result });
    });
    return () => {
      live = false;
    };
  }, [requested]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const last = settled?.result ?? null;
  return {
    loading: settled?.key !== requested,
    /** Last successfully loaded value (kept while a refresh is in flight). */
    data: last && last.ok ? last.data : null,
    error: last && !last.ok ? last : null,
    reload,
  };
}
