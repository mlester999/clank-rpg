import { useSyncExternalStore } from "react";

import type { RosterEntry } from "./ArenaRenderer";

/**
 * Live per-fighter status (HP, alive, kills, damage, status flags), written ~10×/s by the render
 * loop and read by just the components that show it. Keeping this out of React state means the
 * rest of the page does not re-render every time somebody takes damage.
 */
export class RosterStore {
  private value: readonly RosterEntry[] = [];
  private subs = new Set<() => void>();

  get = (): readonly RosterEntry[] => this.value;
  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };

  /** Publishes only when something visible changed. */
  update(next: readonly RosterEntry[]): boolean {
    const prev = this.value;
    const changed =
      next.length !== prev.length ||
      next.some((r, i) => {
        const p = prev[i];
        return !p || p.slot !== r.slot || Math.abs(p.hpFrac - r.hpFrac) > 0.01 || p.alive !== r.alive || p.kills !== r.kills || p.damage !== r.damage || p.flags !== r.flags;
      });
    if (!changed) return false;
    this.value = next;
    for (const s of this.subs) s();
    return true;
  }
}

const EMPTY: readonly RosterEntry[] = [];

export function useRoster(store: RosterStore): readonly RosterEntry[] {
  return useSyncExternalStore(store.subscribe, store.get, () => EMPTY);
}

/** "10110111" — one char per slot (1 = alive). A string snapshot only changes when someone dies, so rows that just dim on KO re-render rarely. */
export function useAliveMask(store: RosterStore): string {
  return useSyncExternalStore(
    store.subscribe,
    () => store.get().map((r) => (r.alive ? "1" : "0")).join(""),
    () => "",
  );
}
